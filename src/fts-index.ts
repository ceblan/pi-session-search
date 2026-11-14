import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { ParsedSession } from "./parser";
import { discoverSessionFiles, parseSession, readSessionId } from "./parser";
import type { SearchResult, ListFilters } from "./session-index";
import { mkdirSync, statSync } from "node:fs";
import { truncate, buildSummary, openIndexDb, withTransaction } from "./utils";
import {
  OM_TABLE_DDL,
  OM_INSERT_SQL,
  OM_SELECT_COLS,
  omRowToParams,
  dbRowToOmMemory,
  buildOmFilterClause,
  scanFileForOm,
  type OmMemoryRow,
  type OmMemoryFilters,
  type OmMemoryHit,
  type OmSessionInfo,
  type OmIndexStats,
  type OmBackfillResult,
} from "./om";

/**
 * SQLite FTS5-backed session index. API-compatible with SessionIndex.
 * Requires no embedder — uses BM25 keyword search.
 */
export class FtsSessionIndex {
  private db!: DatabaseSync;
  private dbPath: string;
  private indexDir: string;
  private extraSessionDirs: string[];
  private extraArchiveDirs: string[];

  constructor(
    indexDir: string,
    extraSessionDirs: string[] = [],
    extraArchiveDirs: string[] = [],
  ) {
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    mkdirSync(indexDir, { recursive: true });
    this.dbPath = join(indexDir, "sessions-fts.db");
  }

  async load(): Promise<void> {
    this.db = openIndexDb(this.dbPath);

    // Migrate: add sizeBytes column if missing (FTS5 UNINDEXED columns)
    // FTS5 virtual tables don't support ALTER TABLE ADD COLUMN, so we check
    // if the table has the sizeBytes column by attempting a query.
    let hasSizeBytes = false;
    try {
      this.db.prepare("SELECT sizeBytes FROM sessions LIMIT 0").all();
      hasSizeBytes = true;
    } catch {
      // Column doesn't exist — need to recreate the table
    }
    if (!hasSizeBytes) {
      this.db.exec("DROP TABLE IF EXISTS sessions");
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
        id UNINDEXED,
        file UNINDEXED,
        archived UNINDEXED,
        startedAt UNINDEXED,
        projectSlug UNINDEXED,
        cwd UNINDEXED,
        mtimeMs UNINDEXED,
        sizeBytes UNINDEXED,
        json UNINDEXED,
        summary UNINDEXED,
        name,
        content,
        tokenize='porter unicode61'
      );
    `);

    // OM memories live in their own FTS5 table (FTS5 has no ADD COLUMN).
    // IF NOT EXISTS — no migration, the sessions schema stays untouched.
    this.db.exec(OM_TABLE_DDL);
  }

  save(): void { /* auto-persisted */ }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any;
    return Number(row?.n ?? 0);
  }

  async sync(
    onProgress?: (msg: string) => void,
  ): Promise<{ added: number; updated: number; removed: number; moved: number }> {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs);

    let added = 0, updated = 0, removed = 0, moved = 0;

    // Build idToFile map from disk (preferring newer mtime on dupes)
    const idToFile = new Map<string, { file: string; archived: boolean; mtimeMs: number; sizeBytes: number }>();
    for (const { file, archived } of discovered) {
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch { continue; }
      const id = readSessionId(file);
      if (!id) continue;
      const existing = idToFile.get(id);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(id, { file, archived, mtimeMs, sizeBytes });
      }
    }

    // Current index state
    const currentRows = this.db
      .prepare("SELECT id, file, mtimeMs, sizeBytes FROM sessions")
      .all() as any[];
    const currentIds = new Set(currentRows.map((r) => String(r.id)));
    const currentById = new Map<string, { file: string; mtimeMs: number; sizeBytes: number }>();
    for (const r of currentRows) {
      currentById.set(String(r.id), {
        file: String(r.file),
        mtimeMs: Number(r.mtimeMs),
        sizeBytes: Number(r.sizeBytes ?? 0),
      });
    }

    // Remove sessions no longer present
    const delStmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    const delOmStmt = this.db.prepare("DELETE FROM om_memories WHERE session_id = ?");
    withTransaction(this.db, () => {
      for (const id of currentIds) {
        if (!idToFile.has(id)) {
          delStmt.run(id);
          delOmStmt.run(id);
          removed++;
        }
      }
    });

    // Figure out what needs (re-)ingestion
    const toIngest: { id: string; file: string; archived: boolean; mtimeMs: number; sizeBytes: number }[] = [];
    const movedUpdates: { id: string; file: string; archived: boolean; mtimeMs: number; sizeBytes: number }[] = [];
    for (const [id, disc] of idToFile.entries()) {
      const cur = currentById.get(id);
      if (!cur) {
        toIngest.push({ id, ...disc });
      } else if (cur.sizeBytes !== disc.sizeBytes) {
        // File size changed — content was actually modified
        toIngest.push({ id, ...disc });
      } else if (cur.file !== disc.file) {
        movedUpdates.push({ id, ...disc });
      }
      // else: same size (and same file) — skip even if mtime differs
    }

    // Apply moves (metadata-only) without reparse
    const moveStmt = this.db.prepare(
      "UPDATE sessions SET file = ?, archived = ?, mtimeMs = ?, sizeBytes = ? WHERE id = ?",
    );
    for (const m of movedUpdates) {
      moveStmt.run(m.file, m.archived ? 1 : 0, m.mtimeMs, m.sizeBytes, m.id);
      moved++;
    }

    if (toIngest.length > 0) onProgress?.(`Indexing ${toIngest.length} sessions...`);

    const insertStmt = this.db.prepare(`
      INSERT INTO sessions (id, file, archived, startedAt, projectSlug, cwd, mtimeMs, sizeBytes, json, summary, name, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const replaceDel = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    const omDel = this.db.prepare("DELETE FROM om_memories WHERE session_id = ?");
    const omInsert = this.db.prepare(OM_INSERT_SQL);

    withTransaction(this.db, () => {
      let done = 0;
      for (const item of toIngest) {
        const session = parseSession(item.file, item.archived);
        if (!session || session.userMessageCount === 0) { done++; continue; }
        const content = buildContent(session);
        const summary = buildSummary(session);
        const isUpdate = currentIds.has(item.id);
        if (isUpdate) replaceDel.run(item.id);
        insertStmt.run(
          session.id,
          session.file,
          session.archived ? 1 : 0,
          session.startedAt,
          session.projectSlug,
          session.cwd,
          item.mtimeMs,
          item.sizeBytes,
          JSON.stringify(session),
          summary,
          session.name ?? "",
          content,
        );
        // OM rows: replace atomically with the session row (same transaction)
        omDel.run(session.id);
        for (const row of session.omMemories) omInsert.run(...omRowToParams(row));
        if (isUpdate) updated++; else added++;
        done++;
        if (done % 25 === 0) onProgress?.(`Indexed ${done}/${toIngest.length}...`);
      }
    });

    return { added, updated, removed, moved };
  }

  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.db.exec("DELETE FROM sessions");
    this.db.exec("DELETE FROM om_memories");
    await this.sync(onProgress);
  }

  async search(query: string, limit = 10, _signal?: AbortSignal): Promise<SearchResult[]> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        "SELECT json, summary, bm25(sessions) AS score FROM sessions WHERE sessions MATCH ? ORDER BY score LIMIT ?",
      )
      .all(fts, limit) as any[];
    return rows.map((r) => {
      const session = JSON.parse(String(r.json)) as ParsedSession;
      // Normalize BM25 (lower is better) into a 0..1-ish relevance score for display
      const raw = Number(r.score);
      const score = 1 / (1 + Math.abs(raw));
      return { session, summary: String(r.summary ?? ""), score };
    });
  }

  list(filters?: ListFilters): ParsedSession[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (filters?.project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${filters.project.toLowerCase()}%`;
      args.push(p, p);
    }
    if (filters?.after) { clauses.push("startedAt >= ?"); args.push(filters.after); }
    if (filters?.before) { clauses.push("startedAt <= ?"); args.push(filters.before); }
    if (filters?.archived !== undefined) {
      clauses.push("archived = ?");
      args.push(filters.archived ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters?.limit ?? 1000;
    const sql = `SELECT json FROM sessions ${where} ORDER BY startedAt DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as any[];
    return rows.map((r) => JSON.parse(String(r.json)) as ParsedSession);
  }

  get(fileOrId: string): { session: ParsedSession; summary: string } | undefined {
    const row = this.db
      .prepare("SELECT json, summary FROM sessions WHERE id = ? OR file = ? LIMIT 1")
      .get(fileOrId, fileOrId) as any;
    if (!row) return undefined;
    return {
      session: JSON.parse(String(row.json)) as ParsedSession,
      summary: String(row.summary ?? ""),
    };
  }

  getAll(): { session: ParsedSession; summary: string }[] {
    const rows = this.db.prepare("SELECT json, summary FROM sessions").all() as any[];
    return rows.map((r) => ({
      session: JSON.parse(String(r.json)) as ParsedSession,
      summary: String(r.summary ?? ""),
    }));
  }

  // ─── OM memories ─────────────────────────────────────────────────

  /**
   * BM25-only memory search. This mode has no embedder by construction, so
   * the cosine side is unavailable — documented FTS-only degradation; the
   * output contract is the same as the hybrid index.
   */
  // @lat: [[om#Observational Memory#Búsqueda híbrida RRF]]
  async searchMemories(
    query: string,
    filters: OmMemoryFilters = {},
    limit = 10,
    _signal?: AbortSignal,
  ): Promise<OmMemoryHit[]> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const { clauses, args } = buildOmFilterClause(filters);
    const extra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${OM_SELECT_COLS}, bm25(om_memories) AS score FROM om_memories WHERE om_memories MATCH ?${extra} ORDER BY score LIMIT ?`,
      )
      .all(fts, ...args, limit) as any[];
    return this.annotateMemoryHits(
      rows.map((r) => ({ row: dbRowToOmMemory(r), rawScore: Number(r.score) })),
    );
  }

  /** All rows of a memory id across every indexed session. */
  async resolveMemory(memoryId: string): Promise<OmMemoryHit[]> {
    const rows = this.db
      .prepare(`SELECT ${OM_SELECT_COLS} FROM om_memories WHERE memory_id = ?`)
      .all(memoryId) as any[];
    return this.annotateMemoryHits(rows.map((r) => ({ row: dbRowToOmMemory(r), rawScore: 0 })));
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

  /** Aggregate counts of the om_memories table (backfill verification). */
  omStats(): OmIndexStats {
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

  /**
   * Selective OM backfill: scan every session file for the OM marker,
   * reparse candidates, and upsert folded rows — even when sizeBytes has
   * not changed (unlike the incremental sync).
   */
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

    const omDel = this.db.prepare("DELETE FROM om_memories WHERE session_id = ?");
    const omInsert = this.db.prepare(OM_INSERT_SQL);
    let sessions = 0;
    let rows = 0;
    let done = 0;
    withTransaction(this.db, () => {
      for (const c of candidates) {
        const session = parseSession(c.file, c.archived);
        if (session && session.userMessageCount > 0) {
          omDel.run(session.id);
          for (const row of session.omMemories) omInsert.run(...omRowToParams(row));
          sessions++;
          rows += session.omMemories.length;
        }
        done++;
        if (done % 50 === 0) onProgress?.(`Reparsed ${done}/${candidates.length} OM files...`);
      }
    });
    return { scanned, candidates: candidates.length, sessions, rows, embedded: 0, skippedEmpty: 0 };
  }

  /** No embeddings in FTS-only mode — reconcile is a no-op by construction. */
  async reconcileOmEmbeddings(): Promise<{ embedded: number; skippedEmpty: number; alreadyFresh: number }> {
    return { embedded: 0, skippedEmpty: 0, alreadyFresh: 0 };
  }

  /** Shared hit annotation: recurrence + session info lookup. */
  private annotateMemoryHits(items: { row: OmMemoryRow; rawScore: number }[]): OmMemoryHit[] {
    const ids = [...new Set(items.map((i) => i.row.memoryId))];
    const recurrences = this.memoryRecurrences(ids);
    const sessionIds = [...new Set(items.map((i) => i.row.sessionId))];
    const sessions = this.sessionInfoByIds(sessionIds);
    return items.map(({ row, rawScore }) => ({
      row,
      recurrence: recurrences.get(row.memoryId) ?? 1,
      score: 1 / (1 + Math.abs(rawScore)),
      session: sessions.get(row.sessionId),
    }));
  }

  private sessionInfoByIds(ids: string[]): Map<string, OmSessionInfo> {
    const out = new Map<string, OmSessionInfo>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT id, json FROM sessions WHERE id IN (${placeholders})`)
        .all(...chunk) as any[];
      for (const r of rows) {
        try {
          const s = JSON.parse(String(r.json)) as ParsedSession;
          out.set(String(r.id), {
            id: String(r.id),
            name: s.name,
            firstUserMessage: s.firstUserMessage ?? "",
            startedAt: s.startedAt,
            projectSlug: s.projectSlug,
          });
        } catch {
          // malformed json row — skip session info, hit still renders
        }
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function buildContent(s: ParsedSession): string {
  const parts: string[] = [];
  if (s.name) parts.push(s.name);
  parts.push(s.userMessages.join("\n"));
  if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
  if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
  if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
  return parts.join("\n\n");
}

/**
 * Turn a user query into a safe FTS5 MATCH expression.
 * Strips FTS syntax characters, quotes each term, and joins with implicit AND.
 * AND is more precise than OR — BM25 ranks multi-term matches highest, and
 * sessions missing a term are excluded rather than diluting the result set.
 */
export function toFtsQuery(q: string): string {
  const terms = q
    .replace(/[\"^*():{}\[\]]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.join(" "); // implicit AND in FTS5
}
