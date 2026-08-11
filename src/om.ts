/**
 * Observational Memory (OM) extraction — types, guards, and fold logic.
 *
 * OM memories are written by pi-blackhole (upstream pi-observational-memory)
 * as `custom` entries (`om.observations.recorded`, `om.reflections.recorded`,
 * `om.observations.dropped`) and as compaction snapshots (`om.folded` inside
 * `entry.details`) directly into the session JSONL files. This module reads
 * them back at index time — pure composition, zero changes required upstream.
 *
 * Types and guards are vendored from pi-blackhole `src/om/ledger/types.ts`
 * (marked "Unmodified" upstream) and `unwrapMemoryDetails` from
 * `src/om/ledger/projection.ts`. Guards stay strict on purpose: unknown or
 * invalid entries are ignored (degrade to invisible, never crash), mirroring
 * `src/om/ledger/fold.ts` semantics.
 *
 * Known accepted divergence vs pi-blackhole: the fold runs over the whole
 * file (including abandoned branches), not over the current branch.
 */

import { openSync, readSync, closeSync } from "node:fs";
import type { SessionEntry } from "./parser";

// ─── Vendored constants (pi-blackhole src/om/ledger/types.ts) ───────

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/i;

// ─── Vendored types ──────────────────────────────────────────────────

export interface Observation {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
}

export interface Reflection {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}

export interface MemoryDetails {
  type: typeof OM_FOLDED;
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}

interface ObservationsRecordedEntryData {
  observations: Observation[];
  coversUpToId: string;
}

interface ReflectionsRecordedEntryData {
  reflections: Reflection[];
  coversUpToId: string;
}

interface ObservationsDroppedEntryData {
  observationIds: string[];
  coversUpToId: string;
}

// ─── Vendored guards (strict — invalid entries are ignored) ─────────

function isRelevance(value: unknown): value is Relevance {
  return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    isNonEmptyString(value.timestamp) &&
    isRelevance(value.relevance) &&
    isNonEmptyStringArray(value.sourceEntryIds) &&
    isTokenCount(value.tokenCount)
  );
}

export function isReflection(value: unknown): value is Reflection {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    !/\r|\n/.test(value.content) &&
    isNonEmptyStringArray(value.supportingObservationIds) &&
    isTokenCount(value.tokenCount)
  );
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.observations) &&
    value.observations.length > 0 &&
    value.observations.every(isObservation) &&
    isNonEmptyString(value.coversUpToId)
  );
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.reflections) &&
    value.reflections.length > 0 &&
    value.reflections.every(isReflection) &&
    isNonEmptyString(value.coversUpToId)
  );
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
  if (!isPlainRecord(value)) return false;
  return (
    value.type === OM_FOLDED &&
    value.version === 1 &&
    typeof value.fullFold === "boolean" &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    Array.isArray(value.reflections) &&
    value.reflections.every(isReflection)
  );
}

/**
 * Vendored from pi-blackhole `src/om/ledger/projection.ts` (`unwrapMemoryDetails`).
 * Accepts `entry.details` being the MemoryDetails directly OR an object with
 * an `"om.folded"` key (the shape produced by pi's compactor, which adds its
 * own metadata keys alongside the OM snapshot).
 */
export function unwrapMemoryDetails(entry: SessionEntry): MemoryDetails | undefined {
  if (isMemoryDetails(entry.details)) return entry.details;
  if (entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)) {
    const nested = (entry.details as Record<string, unknown>)[OM_FOLDED];
    if (isMemoryDetails(nested)) return nested;
  }
  return undefined;
}

// ─── Output row type ─────────────────────────────────────────────────

/**
 * One folded OM memory as persisted in the `om_memories` FTS table.
 * Tombstones are session-local: the same memory id can be `dropped` in one
 * session and `active` in another.
 */
export interface OmMemoryRow {
  /** Memory id — 12-char hex content hash (stable across sessions) */
  memoryId: string;
  /** Session UUID (logical FK to the sessions index) */
  sessionId: string;
  kind: "observation" | "reflection";
  /** null on reflections (OM model: only observations carry relevance) */
  relevance: Relevance | null;
  status: "active" | "dropped";
  /** null on reflections (OM model: only observations carry a timestamp) */
  timestamp: string | null;
  tokenCount: number;
  /** obs: sourceEntryIds · ref: supportingObservationIds */
  sourceEntryIds: string[];
  content: string;
}

// ─── Extraction + fold ───────────────────────────────────────────────

/**
 * Fold all OM entries of a parsed session into one deduplicated row set.
 *
 * Runs as a separate whole-file pass, in file order, merging two sources
 * with a single dedup (first-valid-wins by content-hash id):
 *   1. `custom` entries (om.observations.recorded / om.reflections.recorded)
 *   2. compaction snapshots (`om.folded` details)
 * Because ids are stable content hashes, a snapshot collapses over already
 * recorded memories — duplication is impossible. `om.observations.dropped`
 * entries are session-local tombstones and are never un-added.
 */
// @lat: [[om#Observational Memory#Extracción y fold]]
export function extractOmMemories(entries: SessionEntry[], sessionId: string): OmMemoryRow[] {
  const obsById = new Map<string, Observation>();
  const refById = new Map<string, Reflection>();
  const droppedIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "custom") {
      if (entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data)) {
        for (const obs of entry.data.observations) {
          if (!obsById.has(obs.id)) obsById.set(obs.id, obs); // first-valid-wins
        }
      } else if (entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data)) {
        for (const ref of entry.data.reflections) {
          if (!refById.has(ref.id)) refById.set(ref.id, ref);
        }
      } else if (entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data)) {
        for (const id of entry.data.observationIds) droppedIds.add(id); // tombstone
      }
      continue;
    }

    if (entry.type === "compaction") {
      const details = unwrapMemoryDetails(entry);
      if (!details) continue;
      for (const obs of details.observations) {
        if (!obsById.has(obs.id)) obsById.set(obs.id, obs);
      }
      for (const ref of details.reflections) {
        if (!refById.has(ref.id)) refById.set(ref.id, ref);
      }
    }
  }

  const rows: OmMemoryRow[] = [];
  for (const obs of obsById.values()) {
    rows.push({
      memoryId: obs.id,
      sessionId,
      kind: "observation",
      relevance: obs.relevance,
      status: droppedIds.has(obs.id) ? "dropped" : "active",
      timestamp: obs.timestamp,
      tokenCount: obs.tokenCount,
      sourceEntryIds: obs.sourceEntryIds,
      content: obs.content,
    });
  }
  for (const ref of refById.values()) {
    rows.push({
      memoryId: ref.id,
      sessionId,
      kind: "reflection",
      relevance: null,
      status: "active",
      timestamp: null,
      tokenCount: ref.tokenCount,
      sourceEntryIds: ref.supportingObservationIds,
      content: ref.content,
    });
  }
  return rows;
}

// ─── Cheap file scan (for backfill candidate detection) ──────────────

const OM_SCAN_NEEDLE = "om.";
const OM_SCAN_CHUNK = 64 * 1024;

/**
 * Cheap OM presence probe for backfill: chunked read (64 KB) with early exit
 * on the first `"om."` substring. False positives (e.g. chat text containing
 * "om.foo") are harmless (`extractOmMemories` returns 0 rows); false negatives
 * are impossible (every OM entry contains `om.` in customType or details key).
 */
// @lat: [[om#Observational Memory#Backfill y reconcile]]
export function scanFileForOm(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(OM_SCAN_CHUNK);
    let tail = "";
    let offset = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, OM_SCAN_CHUNK, offset);
      if (n <= 0) return false;
      offset += n;
      const text = tail + buf.toString("utf8", 0, n);
      if (text.includes(OM_SCAN_NEEDLE)) return true;
      // Carry the last needle-1 chars so a match spanning the chunk
      // boundary is not missed (needle is pure ASCII, so this is safe).
      tail = text.slice(-(OM_SCAN_NEEDLE.length - 1));
    }
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// ─── Persistence caps (stripHeavyFields support) ─────────────────────

/** Per-memory content cap — safety valve (max observed: 1.960 chars). */
export const OM_MEMORY_CONTENT_CAP = 8000;
/** Per-memory sourceEntryIds cap. */
export const OM_MEMORY_SOURCE_IDS_CAP = 50;
/**
 * Hard per-session aggregate budget of OM content chars persisted in
 * session-index.json — non-negotiable, bounds JSON growth no matter what.
 */
export const OM_SESSION_CONTENT_BUDGET = 16000;

/**
 * Cap OM memories for JSON persistence with a double cap:
 *   1. per memory: content ≤ 8K chars, sourceEntryIds ≤ 50
 *   2. per session: HARD 16K-char aggregate budget, filled by priority —
 *      reflections first (rare, distilled), then observations by relevance
 *      tier (critical → high → medium → low) with recency tiebreak.
 * Priority decides WHAT survives; nothing is exempt: once the budget runs
 * out, even reflections/high observations are truncated at the frontier or
 * emptied (`content: ""`). All metadata is always preserved intact.
 * Returns `capped: true` whenever any content was truncated or emptied.
 */
// @lat: [[om#Observational Memory#Persistencia JSON con doble cap]]
export function capOmMemories(memories: OmMemoryRow[]): { rows: OmMemoryRow[]; capped: boolean } {
  let capped = false;

  // 1) Per-memory caps
  const rows = memories.map((m) => {
    let content = m.content;
    let sourceEntryIds = m.sourceEntryIds;
    if (content.length > OM_MEMORY_CONTENT_CAP) {
      content = content.slice(0, OM_MEMORY_CONTENT_CAP);
      capped = true;
    }
    if (sourceEntryIds.length > OM_MEMORY_SOURCE_IDS_CAP) {
      sourceEntryIds = sourceEntryIds.slice(0, OM_MEMORY_SOURCE_IDS_CAP);
      capped = true;
    }
    return content === m.content && sourceEntryIds === m.sourceEntryIds
      ? m
      : { ...m, content, sourceEntryIds };
  });

  // 2) Session aggregate hard budget
  const total = rows.reduce((n, r) => n + r.content.length, 0);
  if (total <= OM_SESSION_CONTENT_BUDGET) return { rows, capped };
  capped = true;

  const priority = (r: OmMemoryRow): number => {
    if (r.kind === "reflection") return 0;
    switch (r.relevance) {
      case "critical":
        return 1;
      case "high":
        return 2;
      case "medium":
        return 3;
      default:
        return 4; // low
    }
  };
  // Fill order by priority; output keeps original file order.
  const order = rows
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = priority(rows[a]);
      const pb = priority(rows[b]);
      if (pa !== pb) return pa - pb;
      const ta = rows[a].timestamp ?? "";
      const tb = rows[b].timestamp ?? "";
      if (ta !== tb) return tb.localeCompare(ta); // newer first
      return a - b;
    });

  const kept = new Array<string>(rows.length).fill("");
  let budget = OM_SESSION_CONTENT_BUDGET;
  for (const i of order) {
    if (budget <= 0) break;
    const c = rows[i].content;
    if (c.length <= budget) {
      kept[i] = c;
      budget -= c.length;
    } else {
      kept[i] = c.slice(0, budget); // truncated at the frontier
      budget = 0;
    }
  }

  const outRows = rows.map((r, i) => (kept[i] === r.content ? r : { ...r, content: kept[i] }));
  return { rows: outRows, capped };
}

// ─── SQL mapping (shared by both index implementations) ──────────────

/**
 * FTS5 table for OM memories. Separate from `sessions` (FTS5 has no
 * ADD COLUMN); only `content` is FTS-indexed, the rest are UNINDEXED
 * scan-filter columns. Reflections persist relevance/timestamp as ''.
 */
export const OM_TABLE_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS om_memories USING fts5(
    memory_id UNINDEXED,
    session_id UNINDEXED,
    kind UNINDEXED,
    relevance UNINDEXED,
    status UNINDEXED,
    timestamp UNINDEXED,
    token_count UNINDEXED,
    source_entry_ids UNINDEXED,
    content,
    tokenize='porter unicode61'
  )
`;

export const OM_INSERT_SQL = `
  INSERT INTO om_memories
    (memory_id, session_id, kind, relevance, status, timestamp, token_count, source_entry_ids, content)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const OM_SELECT_COLS =
  "memory_id, session_id, kind, relevance, status, timestamp, token_count, source_entry_ids, content";

/** Serialize a row for OM_INSERT_SQL. relevance/timestamp null → ''. */
export function omRowToParams(row: OmMemoryRow): (string | number)[] {
  return [
    row.memoryId,
    row.sessionId,
    row.kind,
    row.relevance ?? "",
    row.status,
    row.timestamp ?? "",
    row.tokenCount,
    JSON.stringify(row.sourceEntryIds),
    row.content,
  ];
}

/** Hydrate a DB row back into an OmMemoryRow ('' → null for relevance/timestamp). */
export function dbRowToOmMemory(r: any): OmMemoryRow {
  return {
    memoryId: String(r.memory_id),
    sessionId: String(r.session_id),
    kind: r.kind === "reflection" ? "reflection" : "observation",
    relevance: r.relevance ? (String(r.relevance) as Relevance) : null,
    status: r.status === "dropped" ? "dropped" : "active",
    timestamp: r.timestamp ? String(r.timestamp) : null,
    tokenCount: Number(r.token_count ?? 0),
    sourceEntryIds: JSON.parse(String(r.source_entry_ids ?? "[]")) as string[],
    content: String(r.content ?? ""),
  };
}

// ─── Filters ─────────────────────────────────────────────────────────

export interface OmMemoryFilters {
  /** default "all" */
  kind?: "observation" | "reflection" | "all";
  /** only observations carry relevance */
  relevance?: Relevance;
  /** default "active" */
  status?: "active" | "dropped" | "all";
  /** restrict to one session UUID */
  session?: string;
}

/**
 * Build SQL scan-filter clauses (AND-joined) from structured filters.
 * UNINDEXED columns filter fine at ~14K rows. Default status is "active".
 */
export function buildOmFilterClause(filters: OmMemoryFilters = {}): {
  clauses: string[];
  args: (string | number)[];
} {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  const status = filters.status ?? "active";
  if (status !== "all") {
    clauses.push("status = ?");
    args.push(status);
  }
  if (filters.kind && filters.kind !== "all") {
    clauses.push("kind = ?");
    args.push(filters.kind);
  }
  if (filters.relevance) {
    clauses.push("relevance = ?");
    args.push(filters.relevance);
  }
  if (filters.session) {
    clauses.push("session_id = ?");
    args.push(filters.session);
  }
  return { clauses, args };
}

// ─── Search/resolve result types ─────────────────────────────────────

/** Session metadata used to render memory hits. */
export interface OmSessionInfo {
  id: string;
  name?: string;
  firstUserMessage: string;
  startedAt: string;
  projectSlug: string;
}

/** One memory row annotated for display. */
export interface OmMemoryHit {
  row: OmMemoryRow;
  /** COUNT(DISTINCT session_id) for this memory id — always shown, N=1 included */
  recurrence: number;
  score: number;
  session?: OmSessionInfo;
}

/** Aggregate counts for the om_memories table (backfill verification). */
export interface OmIndexStats {
  total: number;
  observations: number;
  reflections: number;
  dropped: number;
  active: number;
  distinctIds: number;
  /** observation ids present in ≥ 2 distinct sessions */
  recurrentObsIds: number;
  sessionsWithOm: number;
  /** vectors stored with the active fingerprint (hybrid mode only) */
  vectors?: number;
}

/** Result of a selective OM backfill run. */
export interface OmBackfillResult {
  /** files scanned with scanFileForOm */
  scanned: number;
  /** files containing the "om." substring */
  candidates: number;
  /** sessions reparsed and upserted */
  sessions: number;
  /** memory rows inserted */
  rows: number;
  /** vectors embedded (hybrid mode; 0 in FTS-only mode) */
  embedded: number;
  /** distinct ids skipped because every stored row had empty content */
  skippedEmpty: number;
}
