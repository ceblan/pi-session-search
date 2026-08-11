# pi-session-search

Index, summarize, and search past [pi](https://github.com/badlogic/pi-mono) coding sessions. Works out of the box with zero configuration — FTS5 keyword search is always on, with optional semantic embeddings for hybrid search.

## Features

- **Zero-config search** — FTS5 keyword search works immediately, no API keys or embedder needed
- **Hybrid search** — When an embedder is configured, combines cosine similarity + BM25 via Reciprocal Rank Fusion for best-of-both-worlds retrieval
- **Browse & filter** — List sessions by project, date range, archive status (`session_list`)
- **Read conversations** — View the full conversation from any past session (`session_read`)
- **Observational Memory search** — Indexes OM memories (observations/reflections) recorded by the pi-blackhole extension into session files, searchable cross-session via `om_memory_search` / `om_memory_resolve`
- **Auto-indexing** — Parses JSONL session files on startup, tracks changes incrementally
- **Archive support** — Indexes both `~/.pi/agent/sessions/` and `~/.pi/agent/sessions-archive/`
- **Multiple embedders** — OpenAI, Mistral, AWS Bedrock, local Ollama, or any OpenAI-compatible API

## Install

**Recommended:** Install [pi-total-recall](https://github.com/samfoy/pi-total-recall) to get the complete context stack — persistent memory, session history search, and local knowledge search in one package:

```bash
pi install pi-total-recall
```

Or install pi-session-search standalone:

```bash
pi install pi-session-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-session-search"]
}
```

Requires **Node 22.5+** (`node:sqlite` is used for FTS5). Node 24+ is recommended — `node:sqlite` is stable there. On Node 22 you'll see an `ExperimentalWarning` which is harmless.

## Setup

**No setup required for keyword search.** FTS5-backed search works immediately after install.

To enable hybrid search (keyword + semantic), run `/session-embeddings-setup` in pi to configure an embedding provider:

- **OpenAI** — Uses `text-embedding-3-small` (needs `OPENAI_API_KEY`)
- **Mistral** — Uses `mistral-embed` (needs `MISTRAL_API_KEY`)
- **Bedrock** — Uses Titan Embeddings v2 (needs AWS credentials)
- **Ollama** — Uses `nomic-embed-text` (needs local Ollama running)
- **OpenAI-compatible** — Any provider with a `/v1/embeddings` endpoint (Together, Fireworks, vLLM, LiteLLM, etc.)

Config is stored at `~/.pi/session-search/config.json`. The `embedder` field is optional — omit it for FTS5-only mode.

### OpenAI-compatible providers

Many embedding providers expose an OpenAI-compatible `/v1/embeddings` endpoint. Use `"type": "openai-compatible"` with a `baseUrl`:

```json
{
  "embedder": {
    "type": "openai-compatible",
    "baseUrl": "https://api.together.xyz",
    "apiKey": "your-key",
    "model": "togethercomputer/m2-bert-80M-8k-retrieval",
    "dimensions": 768
  }
}
```

This works with Together, Fireworks, vLLM, LiteLLM, Anyscale, and any other provider that implements the OpenAI embeddings format.

## Usage

### Search
```
session_search(query="how did we debug the Lambda timeout")
session_search(query="CI pipeline configuration", limit=5)
```

### Browse sessions
```
session_list(project="Rosie", after="2026-03-01")
session_list(archived=true, limit=20)
```

### Read a session
```
session_read(session="<file-path-or-uuid>")
session_read(session="<id>", offset=50, limit=50)
```

### Search OM memories (requires pi-blackhole recordings)
```
om_memory_search(query="vaultwarden resync fix")
om_memory_search(query="waybar config", kind="reflection", status="active")
om_memory_resolve(memory_id="a1b2c3d4e5f6")
```

## Observational Memory search

If you run the pi-blackhole extension (observational memory), it persists timestamped **observations** and distilled **reflections** as `om.*` custom entries and `om.folded` compaction snapshots inside the session JSONL files. pi-session-search extracts them at index time — **no changes or runtime push from pi-blackhole needed** — into a dedicated FTS5 table `om_memories`, with per-memory embeddings in a separate `om-embeddings.db` file when an embedder is configured.

- **Two tools**: `om_memory_search` (hybrid RRF over memories; filters `kind`, `relevance`, `status`, `session`; `status:"active"` by default so tombstoned memories stay out of the way) and `om_memory_resolve` (one id → every session containing that fact, with per-session status and recurrence).
- **Provenance-labeled output** — hits are tagged as OM memory hits (pi-session-search index) and always show cross-session recurrence (`Aparece en N sesiones`), with follow-ups to `om_memory_resolve(id)` / `session_read(sessionId)`.
- **Fold semantics mirror pi-blackhole**: first-valid-record-wins dedup by content-hash id (custom entries and compaction snapshots merge without duplicating), session-local tombstones (`dropped` in one session, possibly `active` in another).
- **Backfill**: existing sessions are indexed on demand — run `/session-om-backfill` once to scan all session files and populate `om_memories` (+ embeddings) without re-embedding whole sessions.
- **Storage layout**: `om_memories` lives inside `sessions-fts.db` (FTS mode) or `hybrid-fts.db` (hybrid mode); `om_embeddings` lives in its own `om-embeddings.db` so it survives sidecar rebuilds. Each embedding row records the embedder fingerprint (`model`+`dims`) — after changing the embedder config, stale vectors are re-embedded automatically from stored content (`reconcileOmEmbeddings`, runs after startup sync).
- **Privacy**: embedding OM content sends it to your embedding provider — same as session content in hybrid mode today. FTS-only mode keeps everything local.

Note: `session_read` does not render OM entries inline (planned); use `om_memory_resolve` / `om_memory_search` for OM content.

## Commands

| Command | Description |
|---------|-------------|
| `/session-embeddings-setup` | Configure embedding provider for hybrid search |
| `/session-sync` | Force an immediate incremental re-sync |
| `/session-reindex` | Force full re-index of all sessions |
| `/session-om-backfill` | Scan all session files for OM memories and backfill `om_memories` + embeddings |

## How It Works

### FTS5-only mode (default)

1. On startup, discovers all `.jsonl` session files
2. Parses each session to extract: user messages, tool calls, files modified, compaction summaries
3. Indexes content into an FTS5 virtual table with Porter stemming
4. Queries use BM25 ranking with implicit AND across search terms

### Hybrid mode (with embedder configured)

1. Everything above, plus generates an embedding vector for each session
2. At query time, runs both cosine similarity and FTS5 BM25
3. Fuses the two ranked lists via **Reciprocal Rank Fusion** (k=60)
4. Sessions that both signals agree on rank highest; single-signal matches still surface

RRF is parameter-free and robust — it discards raw scores (which are incomparable across rankers) and uses only rank positions. Agreement between signals becomes the strongest relevance indicator.

### Why hybrid?

FTS misses semantic matches ("dagger injection" won't find sessions about "dependency injection refactoring" if the exact words aren't there). Cosine misses precise tokens (CR numbers, error codes, file paths all hash to nearby embedding regions). The two failure modes are disjoint — combining them recovers what each misses alone.

Tested against a 2,159-session corpus: hybrid surfaces **75% more relevant documents** than FTS alone, with the top results dominated by sessions both signals independently found.

### Indexing

- Index stored at `~/.pi/session-search/index/`
- Incremental sync on startup + every 5 minutes
- Two separate SQLite DBs: `sessions-fts.db` (pure-FTS mode) and `hybrid-fts.db` (side-car for embedder mode)
- OM memories in an `om_memories` FTS5 table inside those DBs; OM embedding vectors in a third DB, `om-embeddings.db` (fingerprinted by embedder model+dims)
- Switching modes doesn't corrupt state

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI embedder |
| `MISTRAL_API_KEY` | Required for Mistral embedder |

## License

MIT
