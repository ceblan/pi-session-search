---
name: session-history
description: Search, browse, and read past pi coding sessions. Use when the user asks about previous work, past decisions, what was done before, or wants to find a specific session. Covers both active and archived sessions. Also searches Observational Memory (OM) facts recorded by pi-blackhole across sessions.
---

# Session History

Search, browse, and introspect on past pi coding sessions — including archived ones.

## Available Tools

This skill provides five tools:

### session_search
Semantic search across all indexed sessions. Use for finding sessions by topic, technology, or intent.

```
session_search(query="refactoring the auth module")
session_search(query="Lambda timeout debugging", limit=5)
session_search(query="setting up CI pipeline for Nessie")
```

### session_list
Browse sessions with filters. Good for time-based queries or project-specific browsing.

```
session_list(project="Rosie")                    # Sessions in the Rosie project
session_list(after="2026-03-01", limit=10)       # Recent sessions
session_list(archived=true, limit=20)            # Archived sessions only
session_list(project="pi-slack-bot", after="2026-03-10")
```

### session_read
Read the full conversation from a specific session. Use the file path or UUID from search/list results.

```
session_read(session="~/.pi/agent/sessions/--workplace-samfp-Rosie--/2026-03-10T21-36-44.jsonl")
session_read(session="124c2fe2-820c-4d63-8899-eb8d48007d39")
session_read(session="...", offset=50, limit=50)           # Pagination for long sessions
session_read(session="...", include_tools=true)             # Include tool call results
```

### om_memory_search
Search OM memories — timestamped **observations** and distilled **reflections** recorded by pi-blackhole inside session files — across ALL past sessions. Best for specific facts, decisions, root causes, and fixes. Complements `session_search`: memories rank individual facts, sessions rank whole conversations.

```
om_memory_search(query="vaultwarden resync fix")
om_memory_search(query="waybar groupbar disabled", kind="observation")
om_memory_search(query="deployment constraints", kind="reflection")
om_memory_search(query="auth decisions", kind="observation", relevance="high")  # relevance exists only on observations
om_memory_search(query="auth refactor", status="all")        # include tombstoned memories
```

Hits are labeled by provenance (OM index), show cross-session recurrence (`Aparece en N sesiones`), and carry the bracketed 12-hex memory id. Default filter is `status="active"` — dropped memories are kept for history but hidden unless requested.

### om_memory_resolve
Resolve one memory id to every session containing that fact: per-session status, observation timestamps, source entry ids, and total recurrence. Lightweight — follow up with `session_read` for conversational context.

```
om_memory_resolve(memory_id="a1b2c3d4e5f6")
```

## Workflow

1. **Find**: `om_memory_search` for specific facts (OM), `session_search` for topical sessions, `session_list` for browsing
2. **Locate**: `om_memory_resolve(memoryId)` lists all sessions where a fact appears
3. **Read details**: `session_read` with the file path or UUID to see the full conversation
4. **Extract context**: Use information from past sessions to inform current work

## Setup

If not yet configured, run `/session-embeddings-setup` to choose an embedding provider (OpenAI, Bedrock, or Ollama).

To force a full re-index, run `/session-reindex`.

OM memories are extracted at index time from pi-blackhole recordings (`om.*` custom entries and `om.folded` compaction snapshots in the session JSONL). If `om_memory_search` returns nothing but you expect results, run `/session-om-backfill` once to scan all existing session files.

## What Gets Indexed

- All active sessions from `~/.pi/agent/sessions/`
- All archived sessions from `~/.pi/agent/sessions-archive/`
- User messages, assistant responses, tool usage patterns
- Compaction summaries (condensed session context)
- Files read/modified, models used, project directories
- OM observations/reflections recorded by pi-blackhole (folded, deduplicated by content-hash id, with session-local tombstones)

## Tips

- Session search is best for "when did we...", "how did we handle...", "what approach did we use for..." queries
- Memory search is best for "what was the fix for...", "what did we decide about...", "root cause of..." queries — individual facts rather than whole sessions
- Session list is best for "show me recent sessions", "what did we work on in project X" queries
- For very long sessions, use `session_read` with pagination (`offset`/`limit`)
- Set `include_tools=true` on `session_read` when you need to see the actual tool outputs (verbose)
- `session_read` does not render OM entries inline — use `om_memory_search` / `om_memory_resolve` for OM content
