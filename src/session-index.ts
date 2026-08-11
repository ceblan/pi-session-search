import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedSession } from "./parser";
import { discoverSessionFiles, parseSession, readSessionId } from "./parser";
import type { Embedder } from "./embedder";
import { buildContent, toFtsQuery } from "./fts-index";
import { truncate, slugToProject, buildSummary } from "./utils";
import {
  OM_TABLE_DDL,
  OM_INSERT_SQL,
  OM_SELECT_COLS,
  omRowToParams,
  dbRowToOmMemory,
  buildOmFilterClause,
  capOmMemories,
  scanFileForOm,
  type OmMemoryRow,
  type OmMemoryFilters,
  type OmMemoryHit,
  type OmSessionInfo,
  type OmIndexStats,
  type OmBackfillResult,
} from "./om";
import { OmEmbeddingStore, type EmbedderFingerprint } from "./om-embeddings";

// ─── FTS side-car (for hybrid search) ────────────────────────────────

class FtsSide {
  private db: DatabaseSync;
  constructor(indexDir: string) {
    this.db = new DatabaseSync(join(indexDir, "hybrid-fts.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(id UNINDEXED, name, content, tokenize='porter unicode61')",
    );
    // OM memories live in their own FTS5 table (FTS5 has no ADD COLUMN)
    this.db.exec(OM_TABLE_DDL);
  }
  upsert(id: string, name: string, content: string) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO s (id, name, content) VALUES (?, ?, ?)").run(id, name, content);
    this.db.exec("COMMIT");
  }
  delete(id: string) { this.db.prepare("DELETE FROM s WHERE id = ?").run(id); }
  clear() { this.db.exec("DELETE FROM s"); }
  close() { this.db.close(); }
  count(): number {
    return (this.db.prepare("SELECT count(*) as c FROM s").get() as any).c;
  }
  /** Returns id→rank map (rank starts at 1, best first). */
  searchRanks(q: string, limit: number): Map<string, number> {
    const fts = toFtsQuery(q);
    const out = new Map<string, number>();
    if (!fts) return out;
    const rows = this.db
      .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s) LIMIT ?")
      .all(fts, limit) as any[];
    rows.forEach((r, i) => out.set(String(r.id), i + 1));
    return out;
  }

  // ─── OM memories ───────────────────────────────────────────────

  /** Replace the OM rows of a session atomically. */
  upsertOm(sessionId: string, rows: OmMemoryRow[]) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM om_memories WHERE session_id = ?").run(sessionId);
    const insert = this.db.prepare(OM_INSERT_SQL);
    for (const row of rows) insert.run(...omRowToParams(row));
    this.db.exec("COMMIT");
  }
  deleteOm(sessionId: string) {
    this.db.prepare("DELETE FROM om_memories WHERE session_id = ?").run(sessionId);
  }
  clearOm() { this.db.exec("DELETE FROM om_memories"); }
  countOm(): number {
    return (this.db.prepare("SELECT count(*) as c FROM om_memories").get() as any).c;
  }
  /** FTS ranks over memory rows, keyed by `${session_id}:${memory_id}` (rank 1 = best). */
  searchOmRanks(q: string, filters: OmMemoryFilters, limit: number): Map<string, number> {
    const fts = toFtsQuery(q);
    const out = new Map<string, number>();
    if (!fts) return out;
    const { clauses, args } = buildOmFilterClause(filters);
    const extra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT session_id, memory_id FROM om_memories WHERE om_memories MATCH ?${extra} ORDER BY bm25(om_memories) LIMIT ?`,
      )
      .all(fts, ...args, limit) as any[];
    rows.forEach((r, i) => out.set(`${r.session_id}:${r.memory_id}`, i + 1));
    return out;
  }
  /** All rows of a memory id across sessions. */
  omRowsByMemoryId(memoryId: string): OmMemoryRow[] {
    const rows = this.db
      .prepare(`SELECT ${OM_SELECT_COLS} FROM om_memories WHERE memory_id = ?`)
      .all(memoryId) as any[];
    return rows.map(dbRowToOmMemory);
  }
  /** Structured candidates (scan-filter over UNINDEXED columns) for the cosine side. */
  omRowsMatching(filters: OmMemoryFilters): OmMemoryRow[] {
    const { clauses, args } = buildOmFilterClause(filters);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT ${OM_SELECT_COLS} FROM om_memories ${where}`)
      .all(...args) as any[];
    return rows.map(dbRowToOmMemory);
  }
  /** Recurrence = COUNT(DISTINCT session_id) per memory id. */
  memoryRecurrences(memoryIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < memoryIds.length; i += 500) {
      const chunk = memoryIds.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT memory_id, COUNT(DISTINCT session_id) AS n FROM om_memories WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
        )
        .all(...chunk) as any[];
      for (const r of rows) out.set(String(r.memory_id), Number(r.n));
    }
    return out;
  }
  /** Distinct memory ids, optionally only those with some non-empty content row. */
  distinctOmIds(nonEmptyOnly: boolean): Set<string> {
    const sql = nonEmptyOnly
      ? "SELECT DISTINCT memory_id FROM om_memories WHERE content != ''"
      : "SELECT DISTINCT memory_id FROM om_memories";
    const rows = this.db.prepare(sql).all() as any[];
    return new Set(rows.map((r) => String(r.memory_id)));
  }
  /** Longest non-empty content per memory id within the given id chunk. */
  omContentsByIds(ids: string[]): Map<string, string> {
    const best = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT memory_id, content FROM om_memories WHERE memory_id IN (${placeholders})`)
        .all(...chunk) as any[];
      for (const r of rows) {
        const id = String(r.memory_id);
        const content = String(r.content ?? "");
        const cur = best.get(id);
        if (content && (cur === undefined || content.length > cur.length)) best.set(id, content);
      }
    }
    return best;
  }
  /** Aggregate counts for backfill verification. */
  omStatsRows(): Omit<OmIndexStats, "vectors"> {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN kind = 'observation' THEN 1 ELSE 0 END) AS obs,
                SUM(CASE WHEN kind = 'reflection' THEN 1 ELSE 0 END) AS ref,
                SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) AS dropped,
                COUNT(DISTINCT memory_id) AS ids,
                COUNT(DISTINCT session_id) AS sessions
         FROM om_memories`,
      )
      .get() as any;
    const recurrent = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT memory_id FROM om_memories WHERE kind = 'observation'
           GROUP BY memory_id HAVING COUNT(DISTINCT session_id) >= 2
         )`,
      )
      .get() as any;
    const total = Number(agg?.total ?? 0);
    const dropped = Number(agg?.dropped ?? 0);
    return {
      total,
      observations: Number(agg?.obs ?? 0),
      reflections: Number(agg?.ref ?? 0),
      dropped,
      active: total - dropped,
      distinctIds: Number(agg?.ids ?? 0),
      recurrentObsIds: Number(recurrent?.n ?? 0),
      sessionsWithOm: Number(agg?.sessions ?? 0),
    };
  }
}

// ─── Types ───────────────────────────────────────────────────────────

interface IndexedSession {
  /** Parsed session metadata (heavy text fields stripped after embedding) */
  session: ParsedSession;
  /** Generated summary for display + search */
  summary: string;
  /** Embedding vector of the summary + key content (base64 Float32Array) */
  embedding: number[] | string;
  /** File mtime when last indexed */
  mtimeMs: number;
  /** File size in bytes when last indexed */
  sizeBytes?: number;
  /**
   * Set when any OM memory content was truncated/emptied by the persistence
   * caps. populateFtsFromIndex re-parses the source file for these entries
   * to restore verbatim FTS content (falls back to capped rows if gone).
   */
  omContentCapped?: boolean;
}

interface IndexData {
  version: number;
  /** Keyed by session UUID — stable across file moves */
  sessions: Record<string, IndexedSession>;
}

const INDEX_VERSION = 3;

// ─── Embedding serialization ─────────────────────────────────────────

/** Encode a float array as base64 Float32Array — ~3x smaller than JSON. */
export function encodeEmbedding(vec: number[]): string {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  return buf.toString("base64");
}

/** Decode a base64 Float32Array back to number[]. Also handles legacy JSON arrays. */
export function decodeEmbedding(stored: number[] | string): number[] {
  if (Array.isArray(stored)) return stored; // legacy format
  const buf = Buffer.from(stored, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

/**
 * Strip heavy text fields from ParsedSession before persisting.
 * These are only needed during embedding generation, not at search/list time.
 * Saves ~17MB across 2000 sessions.
 *
 * OM memories are preserved (with the double cap: 8K/memory + HARD 16K
 * aggregate per session, metadata always intact) so the FTS side-car can be
 * rebuilt from this JSON without silently losing them.
 */
function stripHeavyFields(session: ParsedSession): {
  stripped: ParsedSession;
  omContentCapped: boolean;
} {
  const { rows, capped } = capOmMemories(session.omMemories ?? []);
  return {
    stripped: {
      ...session,
      userMessages: [],
      assistantText: "",
      firstUserMessage: session.firstUserMessage.slice(0, 200),
      compactionSummaries: session.compactionSummaries.map((s) => s.slice(0, 300)),
      branchSummaries: session.branchSummaries.map((s) => s.slice(0, 200)),
      omMemories: rows,
    },
    omContentCapped: capped,
  };
}

// ─── Session Index ───────────────────────────────────────────────────

export class SessionIndex {
  private data: IndexData = { version: INDEX_VERSION, sessions: {} };
  private indexPath: string;
  private fts: FtsSide;
  private omEmbeddings: OmEmbeddingStore;
  private omFp: EmbedderFingerprint;
  /** Lazy cosine cache of OM vectors (active fingerprint only) — null = dirty */
  private omVectorCache: Map<string, Float32Array> | null = null;

  constructor(
    private embedder: Embedder,
    private indexDir: string,
    private extraSessionDirs: string[] = [],
    private extraArchiveDirs: string[] = [],
    omFingerprint?: EmbedderFingerprint,
  ) {
    mkdirSync(indexDir, { recursive: true });
    this.indexPath = join(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
    this.omEmbeddings = new OmEmbeddingStore(indexDir);
    this.omFp = omFingerprint ?? { model: "unknown", dims: 0 };
  }

  /** Load existing index from disk. */
  async load(): Promise<void> {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexData;
      if (parsed.version === INDEX_VERSION) {
        this.data = parsed;
      } else if (parsed.version === 2) {
        // Migrate v2 → v3: encode embeddings as base64, strip heavy fields
        for (const entry of Object.values(parsed.sessions)) {
          if (Array.isArray(entry.embedding)) {
            entry.embedding = encodeEmbedding(entry.embedding);
          }
          const { stripped, omContentCapped } = stripHeavyFields(entry.session);
          entry.session = stripped;
          if (omContentCapped) entry.omContentCapped = true;
        }
        parsed.version = INDEX_VERSION;
        this.data = parsed;
        this.save(); // persist the migration
      }
      // v1 index (keyed by file path) is incompatible — rebuild from scratch
    } catch {
      this.data = { version: INDEX_VERSION, sessions: {} };
    }

    // Populate FTS side-car if it's empty but the JSON index has sessions
    const sessionCount = Object.keys(this.data.sessions).length;
    if (sessionCount > 0 && this.fts.count() === 0) {
      this.populateFtsFromIndex();
    }
  }

  /**
   * Populate the FTS side-car from existing index data.
   * Used when the JSON index is loaded but the FTS DB is empty (e.g. first
   * run after upgrade, or if the .db file was deleted).
   *
   * OM rows are repopulated from the persisted (capped) omMemories; entries
   * flagged omContentCapped get a directed re-parse of their source file to
   * restore verbatim content (falling back to the capped rows — metadata
   * intact — when the file is gone).
   */
  // @lat: [[om#Observational Memory#Persistencia JSON con doble cap]]
  private populateFtsFromIndex(): void {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const s = entry.session;
      // Reconstruct FTS content from the stripped session metadata
      const parts: string[] = [];
      if (s.name) parts.push(s.name);
      if (s.firstUserMessage) parts.push(s.firstUserMessage);
      if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
      if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
      if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
      const content = parts.join("\n\n");
      this.fts.upsert(id, s.name ?? "", content);

      // OM rows — never leave them silently empty on rebuild
      let omRows = s.omMemories ?? [];
      if (entry.omContentCapped && existsSync(s.file)) {
        try {
          const reparsed = parseSession(s.file, s.archived);
          if (reparsed) omRows = reparsed.omMemories;
        } catch {
          // keep capped rows as fallback
        }
      }
      this.fts.upsertOm(id, omRows);
    }
  }

  /** Save index to disk. */
  save(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.data), "utf8");
  }

  /** Number of indexed sessions. */
  size(): number {
    return Object.keys(this.data.sessions).length;
  }

  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   */
  async sync(
    onProgress?: (msg: string) => void
  ): Promise<{ added: number; updated: number; removed: number; moved: number }> {
    const discovered = discoverSessionFiles(
      this.extraSessionDirs,
      this.extraArchiveDirs,
    );

    let added = 0;
    let updated = 0;
    let removed = 0;
    let moved = 0;

    // ── Phase 1: Build a map of discovered files → session ID ────────
    // We need session IDs to correlate with the index. For files already
    // in the index we can match by scanning existing entries. For unknown
    // files we do a quick header-only read.
    const fileToId = new Map<string, string>();
    const idToFile = new Map<string, { file: string; archived: boolean; mtimeMs: number; sizeBytes: number }>();

    // Build a reverse lookup: sessionId → current indexed file path
    const indexedIdToFile = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      indexedIdToFile.set(id, entry.session.file);
    }

    for (const { file, archived } of discovered) {
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue; // can't stat — skip
      }

      // Try to match by checking if any indexed entry already has this file
      let sessionId: string | null = null;
      for (const [id, entry] of Object.entries(this.data.sessions)) {
        if (entry.session.file === file) {
          sessionId = id;
          break;
        }
      }

      // Not found in index by path — quick-read the header for the UUID
      if (!sessionId) {
        sessionId = readSessionId(file);
      }

      if (!sessionId) continue; // unparseable file

      fileToId.set(file, sessionId);

      // If multiple files claim the same session ID, prefer the newer one
      const existing = idToFile.get(sessionId);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(sessionId, { file, archived, mtimeMs, sizeBytes });
      }
    }

    // ── Phase 2: Remove indexed sessions that no longer exist on disk ─
    const discoveredIds = new Set(idToFile.keys());
    for (const id of Object.keys(this.data.sessions)) {
      if (!discoveredIds.has(id)) {
        delete this.data.sessions[id];
        this.fts.delete(id);
        this.fts.deleteOm(id);
        removed++;
      }
    }

    // ── Phase 3: Detect moves, new, and changed sessions ─────────────
    const toEmbed: { id: string; file: string; archived: boolean; mtimeMs: number; sizeBytes: number }[] = [];

    for (const [id, disc] of idToFile.entries()) {
      const existing = this.data.sessions[id];

      if (existing) {
        // Session already indexed
        const pathChanged = existing.session.file !== disc.file;
        const sizeChanged = (existing.sizeBytes ?? 0) !== disc.sizeBytes;

        if (pathChanged && !sizeChanged) {
          // ── Moved (e.g. sessions/ → sessions-archive/) ──
          // Update file path + archived flag, keep embedding
          existing.session.file = disc.file;
          existing.session.archived = disc.archived;
          existing.mtimeMs = disc.mtimeMs;
          existing.sizeBytes = disc.sizeBytes;
          existing.summary = buildSummary(existing.session);
          moved++;
        } else if (sizeChanged) {
          // ── Content changed (file size differs) ──
          // Need full re-parse + re-embed
          toEmbed.push({ id, ...disc });
        }
        // else: unchanged (same size, same path) — skip
      } else {
        // ── Brand new session ──
        toEmbed.push({ id, ...disc });
      }
    }

    if (toEmbed.length === 0) {
      if (moved > 0 || removed > 0) this.save();
      if (removed > 0) this.gcOmEmbeddings();
      return { added, updated, removed, moved };
    }

    onProgress?.(`Indexing ${toEmbed.length} sessions...`);

    // ── Phase 4: Parse + embed in batches ────────────────────────────
    const BATCH_SIZE = 20;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const parsed: { item: (typeof toEmbed)[0]; session: ParsedSession }[] = [];

      for (const item of batch) {
        const session = parseSession(item.file, item.archived);
        if (session && session.userMessageCount > 0) {
          parsed.push({ item, session });
        }
      }

      if (parsed.length === 0) continue;

      const texts = parsed.map(({ session }) => buildEmbeddingText(session));

      try {
        const embeddings = await this.embedder.embedBatch(texts);

        for (let j = 0; j < parsed.length; j++) {
          const { item, session } = parsed[j];
          const embedding = embeddings[j];
          if (!embedding) continue; // failed to embed

          const isUpdate = !!this.data.sessions[item.id];
          const { stripped, omContentCapped } = stripHeavyFields(session);

          this.data.sessions[item.id] = {
            session: stripped,
            summary: buildSummary(session),
            embedding: encodeEmbedding(embedding),
            mtimeMs: item.mtimeMs,
            sizeBytes: item.sizeBytes,
            omContentCapped: omContentCapped || undefined,
          };
          this.fts.upsert(item.id, session.name ?? "", buildContent(session));
          // OM rows verbatim in FTS (the JSON copy is the capped one)
          this.fts.upsertOm(item.id, session.omMemories);

          if (isUpdate) updated++;
          else added++;
        }
      } catch (err: any) {
        onProgress?.(`Embedding batch failed: ${err.message}`);
      }

      // ── OM memory embeddings: incremental, per distinct memory_id ──
      // Ids already embedded with the active fingerprint are skipped for
      // free (content-hash dedup); failures retry on the next sync/reconcile.
      try {
        const omRows = parsed.flatMap(({ session }) => session.omMemories);
        if (omRows.length > 0) {
          const contentById = new Map<string, string>();
          for (const r of omRows) {
            const cur = contentById.get(r.memoryId);
            if (r.content && (cur === undefined || r.content.length > cur.length)) {
              contentById.set(r.memoryId, r.content);
            }
          }
          const missing = this.omEmbeddings.missingIds([...contentById.keys()], this.omFp);
          if (missing.length > 0) {
            const texts = missing.map((id) => contentById.get(id)!.slice(0, 8000));
            const vecs = await this.embedder.embedBatch(texts);
            for (let k = 0; k < missing.length; k++) {
              const v = vecs[k];
              if (v) this.omEmbeddings.put(missing[k], v, this.omFp);
            }
            this.omVectorCache = null; // invalidate the cosine cache
          }
        }
      } catch (err: any) {
        onProgress?.(`OM embedding batch failed: ${err.message}`);
      }

      onProgress?.(
        `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`
      );
    }

    this.save();
    if (removed > 0) this.gcOmEmbeddings();
    return { added, updated, removed, moved };
  }

  /** Best-effort GC of orphaned OM vectors after session removals. */
  private gcOmEmbeddings(): void {
    try {
      this.omEmbeddings.gc(this.fts.distinctOmIds(false));
      this.omVectorCache = null;
    } catch {
      // best-effort — next sync retries
    }
  }

  /** Full rebuild — clear and re-index everything. OM embedding vectors are
   *  deliberately kept (contents don't change; ids are reused). */
  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.data = { version: INDEX_VERSION, sessions: {} };
    this.fts.clear();
    this.fts.clearOm();
    await this.sync(onProgress);
  }

  /**
   * Reconcile OM embeddings with the active fingerprint.
   * Set-difference gate (never cardinality — equal counts could hide an
   * orphan vector plus a missing one): computes missing ids over distinct
   * non-empty ids in om_memories; when nothing is missing this is a real
   * no-op (one DISTINCT scan + IN chunks, no API calls). Otherwise
   * (re-)embeds stales/missing FROM THE STORED om_memories.content (longest
   * non-empty row per id) — no session re-parse, which matters after an
   * embedder change (incremental sync skips unchanged files). Ids whose
   * rows are all empty (capped fallback, file gone) are skipped/reported —
   * they stay resolvable via om_memory_resolve (metadata intact).
   */
  // @lat: [[om#Observational Memory#Backfill y reconcile]]
  async reconcileOmEmbeddings(
    onProgress?: (msg: string) => void,
  ): Promise<{ embedded: number; skippedEmpty: number; alreadyFresh: number }> {
    const nonEmptyIds = this.fts.distinctOmIds(true);
    const allIds = this.fts.distinctOmIds(false);
    const soloEmpty = allIds.size - nonEmptyIds.size;
    const missing = this.omEmbeddings.missingIds([...nonEmptyIds], this.omFp);
    const alreadyFresh = nonEmptyIds.size - missing.length;
    if (missing.length === 0) {
      return { embedded: 0, skippedEmpty: soloEmpty, alreadyFresh };
    }

    const contentById = this.fts.omContentsByIds(missing);
    const embeddable = missing.filter((id) => contentById.has(id));
    const skippedEmpty = soloEmpty + (missing.length - embeddable.length);
    if (skippedEmpty > 0) {
      onProgress?.(`OM reconcile: ${skippedEmpty} ids skipped (empty content only)`);
    }

    let embedded = 0;
    const CHUNK = 500;
    for (let i = 0; i < embeddable.length; i += CHUNK) {
      const chunk = embeddable.slice(i, i + CHUNK);
      const texts = chunk.map((id) => contentById.get(id)!.slice(0, 8000));
      const vecs = await this.embedder.embedBatch(texts);
      for (let k = 0; k < chunk.length; k++) {
        const v = vecs[k];
        if (v) {
          this.omEmbeddings.put(chunk[k], v, this.omFp);
          embedded++;
        }
      }
      onProgress?.(
        `OM embeddings: ${Math.min(i + CHUNK, embeddable.length)}/${embeddable.length}...`,
      );
    }
    if (embedded > 0) this.omVectorCache = null;
    return { embedded, skippedEmpty, alreadyFresh };
  }

  /**
   * Hybrid memory search: cosine over OM vectors + FTS5 BM25, fused per row
   * (rowKey = session_id:memory_id) via Reciprocal Rank Fusion (k=60).
   * Rows sharing a memory_id share its vector; recurrence is annotated after.
   */
  // @lat: [[om#Observational Memory#Búsqueda híbrida RRF]]
  async searchMemories(
    query: string,
    filters: OmMemoryFilters = {},
    limit = 10,
    signal?: AbortSignal,
  ): Promise<OmMemoryHit[]> {
    const candidates = this.fts.omRowsMatching(filters);
    if (candidates.length === 0) return [];

    const queryEmbedding = await this.embedder.embed(query);
    if (signal?.aborted) return [];

    // Lazy cosine cache — ACTIVE fingerprint only, never mixes vector
    // spaces. ~11.4K × 512 dims × 4B ≈ 23.5MB heap at current scale.
    if (!this.omVectorCache) {
      this.omVectorCache = this.omEmbeddings.loadAll(this.omFp);
    }

    const poolSize = Math.max(limit * 5, 100);
    const rowKey = (r: OmMemoryRow) => `${r.sessionId}:${r.memoryId}`;

    // Cosine ranks over candidate rows (vector shared per memory_id)
    const cosineRanks = new Map<string, number>();
    const scored = candidates
      .map((r) => {
        const vec = this.omVectorCache!.get(r.memoryId);
        return { r, score: vec ? cosineSimilarity(queryEmbedding, vec) : null };
      })
      .filter((s): s is { r: OmMemoryRow; score: number } => s.score !== null)
      .sort((a, b) => b.score - a.score);
    scored.slice(0, poolSize).forEach((s, i) => cosineRanks.set(rowKey(s.r), i + 1));

    const ftsRanks = this.fts.searchOmRanks(query, filters, poolSize);

    // RRF fusion: score = Σ 1 / (k + rank)
    const K = 60;
    const fused = new Map<string, number>();
    for (const [key, r] of cosineRanks) fused.set(key, (fused.get(key) ?? 0) + 1 / (K + r));
    for (const [key, r] of ftsRanks) fused.set(key, (fused.get(key) ?? 0) + 1 / (K + r));

    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const byKey = new Map(candidates.map((r) => [rowKey(r), r]));
    const ids = [...new Set(sorted.map(([key]) => byKey.get(key)!.memoryId))];
    const recurrences = this.fts.memoryRecurrences(ids);

    return sorted.map(([key, score]) => {
      const row = byKey.get(key)!;
      return {
        row,
        recurrence: recurrences.get(row.memoryId) ?? 1,
        score,
        session: this.sessionInfoFor(row.sessionId),
      };
    });
  }

  /** All rows of a memory id across every indexed session (om_memory_resolve). */
  async resolveMemory(memoryId: string): Promise<OmMemoryHit[]> {
    const rows = this.fts.omRowsByMemoryId(memoryId);
    const recurrences = this.fts.memoryRecurrences([memoryId]);
    return rows.map((row) => ({
      row,
      recurrence: recurrences.get(memoryId) ?? 1,
      score: 0,
      session: this.sessionInfoFor(row.sessionId),
    }));
  }

  /** Aggregate counts of the OM tables (backfill verification §6.4). */
  omStats(): OmIndexStats {
    return { ...this.fts.omStatsRows(), vectors: this.omEmbeddings.count(this.omFp) };
  }

  /**
   * Selective OM backfill: scan every session file, reparse OM candidates,
   * upsert folded rows into FTS (verbatim) AND into the JSON index (capped,
   * so a future sidecar rebuild cannot silently wipe them), then reconcile
   * embeddings. Resumable: already-embedded ids are skipped by missingIds.
   */
  // @lat: [[om#Observational Memory#Backfill y reconcile]]
  async syncOmBackfill(onProgress?: (msg: string) => void): Promise<OmBackfillResult> {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs);
    const candidates: { file: string; archived: boolean }[] = [];
    let scanned = 0;
    for (const d of discovered) {
      scanned++;
      if (scanFileForOm(d.file)) candidates.push(d);
      if (scanned % 500 === 0) onProgress?.(`Scanned ${scanned}/${discovered.length} session files...`);
    }
    if (candidates.length > 0) onProgress?.(`${candidates.length} files contain OM — reparsing...`);

    let sessions = 0;
    let rows = 0;
    let done = 0;
    for (const c of candidates) {
      const session = parseSession(c.file, c.archived);
      if (session && session.userMessageCount > 0) {
        this.fts.upsertOm(session.id, session.omMemories);
        const existing = this.data.sessions[session.id];
        if (existing) {
          const { rows: cappedRows, capped } = capOmMemories(session.omMemories);
          existing.session.omMemories = cappedRows;
          existing.omContentCapped = capped || undefined;
        }
        sessions++;
        rows += session.omMemories.length;
      }
      done++;
      if (done % 50 === 0) onProgress?.(`Reparsed ${done}/${candidates.length} OM files...`);
    }
    if (sessions > 0) this.save();

    const rec = await this.reconcileOmEmbeddings(onProgress);
    return {
      scanned,
      candidates: candidates.length,
      sessions,
      rows,
      embedded: rec.embedded,
      skippedEmpty: rec.skippedEmpty,
    };
  }

  private sessionInfoFor(sessionId: string): OmSessionInfo | undefined {
    const entry = this.data.sessions[sessionId];
    if (!entry) return undefined;
    const s = entry.session;
    return {
      id: sessionId,
      name: s.name,
      firstUserMessage: s.firstUserMessage ?? "",
      startedAt: s.startedAt,
      projectSlug: s.projectSlug,
    };
  }

  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   */
  async search(
    query: string,
    limit: number = 10,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const entries = Object.values(this.data.sessions);
    if (entries.length === 0) return [];

    const queryEmbedding = await this.embedder.embed(query);
    if (signal?.aborted) return [];

    // Rank by cosine similarity
    const cosineScored = entries
      .map((entry) => ({
        entry,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding)),
      }))
      .sort((a, b) => b.score - a.score);

    // Pull a larger candidate pool from each side so fusion has room to rank
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = new Map<string, number>();
    cosineScored.slice(0, poolSize).forEach((s, i) => {
      cosineRanks.set(s.entry.session.id, i + 1);
    });

    const ftsRanks = this.fts.searchRanks(query, poolSize);

    // RRF fusion: score = Σ 1 / (k + rank)
    const K = 60;
    const fused = new Map<string, number>();
    for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));

    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    return sorted
      .map(([id, score]) => {
        const entry = this.data.sessions[id];
        if (!entry) return null;
        return { session: entry.session, summary: entry.summary, score };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /**
   * List sessions with optional filters.
   */
  list(filters?: ListFilters): ParsedSession[] {
    let sessions = Object.values(this.data.sessions).map((e) => e.session);

    if (filters?.project) {
      const slug = filters.project.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.projectSlug.toLowerCase().includes(slug) ||
          s.cwd.toLowerCase().includes(slug)
      );
    }

    if (filters?.after) {
      sessions = sessions.filter((s) => s.startedAt >= filters.after!);
    }

    if (filters?.before) {
      sessions = sessions.filter((s) => s.startedAt <= filters.before!);
    }

    if (filters?.archived !== undefined) {
      sessions = sessions.filter((s) => s.archived === filters.archived);
    }

    // Sort by start time, newest first
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (filters?.limit) {
      sessions = sessions.slice(0, filters.limit);
    }

    return sessions;
  }

  /**
   * Get a specific session by file path or session ID.
   */
  get(fileOrId: string): IndexedSession | undefined {
    // Try direct session ID lookup
    if (this.data.sessions[fileOrId]) {
      return this.data.sessions[fileOrId];
    }
    // Try by file path
    return Object.values(this.data.sessions).find(
      (e) => e.session.file === fileOrId
    );
  }

  /** Get all indexed session objects. */
  getAll(): IndexedSession[] {
    return Object.values(this.data.sessions);
  }

  close(): void {
    this.fts.close();
    this.omEmbeddings.close();
  }
}

// ─── Search types ────────────────────────────────────────────────────

export interface SearchResult {
  session: ParsedSession;
  summary: string;
  score: number;
}

export interface ListFilters {
  project?: string;
  after?: string;
  before?: string;
  archived?: boolean;
  limit?: number;
}

// ─── Utilities ───────────────────────────────────────────────────────

function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Build text for embedding — combines key content for semantic search.
 */
function buildEmbeddingText(s: ParsedSession): string {
  const parts: string[] = [];

  if (s.name) parts.push(s.name);

  // User messages are the strongest signal
  const userText = s.userMessages.join("\n").slice(0, 6000);
  parts.push(userText);

  // Assistant text captures analysis, conclusions, and discoveries
  if (s.assistantText) {
    const assistantBudget = 3000;
    const truncatedAssistant = s.assistantText.slice(0, assistantBudget);
    parts.push(`Assistant:\n${truncatedAssistant}`);
  }

  // Compaction summaries are great condensed representations
  if (s.compactionSummaries.length > 0) {
    parts.push(s.compactionSummaries.join("\n").slice(0, 4000));
  }

  // Branch summaries
  if (s.branchSummaries.length > 0) {
    parts.push(s.branchSummaries.join("\n").slice(0, 2000));
  }

  // Project context
  parts.push(`Project: ${slugToProject(s.projectSlug)}`);
  parts.push(`CWD: ${s.cwd}`);

  // Files modified give strong project context
  if (s.filesModified.length > 0) {
    parts.push(`Files modified: ${s.filesModified.join(", ")}`);
  }

  // Limit total embedding text
  return parts.join("\n\n").slice(0, 16000);
}
