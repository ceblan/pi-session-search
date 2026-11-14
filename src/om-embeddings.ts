/**
 * OM memory embedding store — one vector per distinct memory id (content
 * hash), in its own SQLite file `om-embeddings.db` so it survives deletion
 * or regeneration of `hybrid-fts.db` / `sessions-fts.db`. Single writer:
 * pi-session-search.
 *
 * Every row carries an embedder fingerprint (model + dims). A row is stale
 * when its fingerprint does not match the active config, and is treated as
 * missing (re-embedded with INSERT OR REPLACE). Without this, changing the
 * embedding model or dimensions would silently mix incompatible vector
 * spaces under the same memory_id.
 */

import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { EmbedderConfig } from "./embedder";
import { openIndexDb, withTransaction } from "./utils";

export interface EmbedderFingerprint {
  model: string;
  dims: number;
}

/**
 * Mirror of the provider defaults in embedder.ts (kept separate so
 * embedder.ts stays untouched). Used to derive a stable fingerprint from
 * the active EmbedderConfig — identity only, stability is what matters.
 */
const FP_DEFAULTS: Record<string, { model: string; dims: number }> = {
  openai: { model: "text-embedding-3-small", dims: 512 },
  bedrock: { model: "amazon.titan-embed-text-v2:0", dims: 512 },
  ollama: { model: "nomic-embed-text", dims: 0 },
  mistral: { model: "mistral-embed", dims: 1024 },
  "openai-compatible": { model: "text-embedding-3-small", dims: 512 },
};

/** Fingerprint of the active embedder config ("type:model" + dims). */
// @lat: [[om#Observational Memory#Embeddings de memorias y fingerprint]]
export function omEmbedderFingerprint(config: EmbedderConfig): EmbedderFingerprint {
  const d = FP_DEFAULTS[config.type] ?? { model: "", dims: 0 };
  return {
    model: `${config.type}:${config.model ?? d.model}`,
    dims: config.dimensions ?? d.dims,
  };
}

const IN_CHUNK = 500; // SQLite host-variable limit safety

// @lat: [[om#Observational Memory#Embeddings de memorias y fingerprint]]
export class OmEmbeddingStore {
  private db: DatabaseSync;

  constructor(indexDir: string) {
    this.db = openIndexDb(join(indexDir, "om-embeddings.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS om_embeddings (
        memory_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  /** True only when a row exists AND was embedded with the active fingerprint. */
  has(memoryId: string, fp: EmbedderFingerprint): boolean {
    const row = this.db
      .prepare("SELECT model, dims FROM om_embeddings WHERE memory_id = ?")
      .get(memoryId) as any;
    return !!row && String(row.model) === fp.model && Number(row.dims) === fp.dims;
  }

  /**
   * Ids that need (re-)embedding: absent from the store OR stale
   * (fingerprint mismatch). IN-lists are chunked at 500 ids.
   */
  missingIds(ids: string[], fp: EmbedderFingerprint): string[] {
    const missing: string[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT memory_id, model, dims FROM om_embeddings WHERE memory_id IN (${placeholders})`)
        .all(...chunk) as any[];
      const fresh = new Set<string>();
      for (const r of rows) {
        if (String(r.model) === fp.model && Number(r.dims) === fp.dims) {
          fresh.add(String(r.memory_id));
        }
      }
      for (const id of chunk) {
        if (!fresh.has(id)) missing.push(id);
      }
    }
    return missing;
  }

  /** Upsert a vector with the active fingerprint. */
  put(memoryId: string, vec: number[], fp: EmbedderFingerprint): void {
    const blob = Buffer.from(new Float32Array(vec).buffer);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO om_embeddings (memory_id, embedding, model, dims, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(memoryId, blob, fp.model, fp.dims, new Date().toISOString());
  }

  /**
   * Load every vector of the ACTIVE fingerprint — the cosine cache must
   * never mix vector spaces.
   */
  loadAll(fp: EmbedderFingerprint): Map<string, Float32Array> {
    const rows = this.db
      .prepare("SELECT memory_id, embedding FROM om_embeddings WHERE model = ? AND dims = ?")
      .all(fp.model, fp.dims) as any[];
    const out = new Map<string, Float32Array>();
    for (const r of rows) {
      const blob = r.embedding as Uint8Array;
      out.set(
        String(r.memory_id),
        new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
      );
    }
    return out;
  }

  /**
   * Best-effort garbage collection: delete vectors whose memory id no
   * longer exists in om_memories (e.g. after session deletion). Never
   * deletes by fingerprint — stale rows are re-embedded via reconcile.
   */
  gc(keepIds: Set<string>): number {
    const rows = this.db.prepare("SELECT memory_id FROM om_embeddings").all() as any[];
    const orphans = rows.map((r) => String(r.memory_id)).filter((id) => !keepIds.has(id));
    if (orphans.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM om_embeddings WHERE memory_id = ?");
    withTransaction(this.db, () => {
      for (const id of orphans) del.run(id);
    });
    return orphans.length;
  }

  /** Total vectors, or only those of the active fingerprint when given. */
  count(fp?: EmbedderFingerprint): number {
    if (fp) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM om_embeddings WHERE model = ? AND dims = ?")
        .get(fp.model, fp.dims) as any;
      return Number(row?.n ?? 0);
    }
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM om_embeddings").get() as any;
    return Number(row?.n ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
