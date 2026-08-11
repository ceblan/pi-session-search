// MUST stay the first import: isolates default session dirs from production
import "./test-home-setup";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Imports under test ──────────────────────────────────────────────

import {
  extractOmMemories,
  scanFileForOm,
  capOmMemories,
  unwrapMemoryDetails,
  OM_MEMORY_CONTENT_CAP,
  OM_SESSION_CONTENT_BUDGET,
  type Observation,
  type Reflection,
  type Relevance,
  type OmMemoryRow,
} from "../om";
import type { SessionEntry } from "../parser";
import { parseSession } from "../parser";
import { FtsSessionIndex } from "../fts-index";
import { SessionIndex } from "../session-index";
import { OmEmbeddingStore, type EmbedderFingerprint } from "../om-embeddings";
import type { Embedder } from "../embedder";

// ─── Fixture helpers ─────────────────────────────────────────────────

function hexId(n: number): string {
  return n.toString(16).padStart(12, "0");
}

function makeObs(
  n: number,
  content = `observation ${n}`,
  relevance: Relevance = "medium",
  timestamp = "2026-08-01 10:00"
): Observation {
  return {
    id: hexId(n),
    content,
    timestamp,
    relevance,
    sourceEntryIds: ["src1"],
    tokenCount: 10,
  };
}

function makeRef(n: number, content = `reflection ${n}`): Reflection {
  return {
    id: hexId(n),
    content,
    supportingObservationIds: ["src2", "src3"],
    tokenCount: 12,
  };
}

function obsRecordedEntry(observations: Observation[], id = "e-obs"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-01T10:00:00Z",
    customType: "om.observations.recorded",
    data: { observations, coversUpToId: "cover1" },
  };
}

function refRecordedEntry(reflections: Reflection[], id = "e-ref"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-01T10:00:00Z",
    customType: "om.reflections.recorded",
    data: { reflections, coversUpToId: "cover1" },
  };
}

function droppedEntry(observationIds: string[], id = "e-drop"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-01T10:00:00Z",
    customType: "om.observations.dropped",
    data: { observationIds, coversUpToId: "cover1" },
  };
}

function compactionEntry(
  observations: Observation[],
  reflections: Reflection[],
  opts: { nested?: boolean; id?: string } = {}
): SessionEntry {
  const details = {
    type: "om.folded",
    version: 1,
    fullFold: false,
    observations,
    reflections,
  };
  return {
    type: "compaction",
    id: opts.id ?? "e-compact",
    parentId: null,
    timestamp: "2026-08-01T11:00:00Z",
    summary: "compaction summary",
    firstKeptEntryId: "e-keep",
    details: opts.nested === false ? details : { compactor: "auto", version: 2, "om.folded": details },
  };
}

// ─── 1. Fold first-valid-wins ────────────────────────────────────────

describe("extractOmMemories — fold first-valid-wins", () => {
  it("keeps the first valid record when the same id is recorded twice", () => {
    const entries = [
      obsRecordedEntry([makeObs(1, "first content", "high")], "e1"),
      obsRecordedEntry([makeObs(1, "second content", "low")], "e2"),
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memoryId, hexId(1));
    assert.equal(rows[0].content, "first content");
    assert.equal(rows[0].relevance, "high");
  });

  it("identical duplicate records collapse to a single row", () => {
    const entries = [
      obsRecordedEntry([makeObs(1)], "e1"),
      obsRecordedEntry([makeObs(1)], "e2"),
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 1);
  });
});

// ─── 2. Tombstones ───────────────────────────────────────────────────

describe("extractOmMemories — tombstones", () => {
  it("marks a recorded-then-dropped observation as dropped", () => {
    const entries = [
      obsRecordedEntry([makeObs(1)], "e1"),
      droppedEntry([hexId(1)], "e2"),
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "dropped");
  });

  it("tombstone of an unknown id creates no row and does not throw", () => {
    const entries = [droppedEntry([hexId(99)], "e1")];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 0);
  });

  it("dropping does not affect reflections", () => {
    const entries = [
      obsRecordedEntry([makeObs(1)], "e1"),
      refRecordedEntry([makeRef(2)], "e2"),
      droppedEntry([hexId(1)], "e3"),
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 2);
    const ref = rows.find((r) => r.kind === "reflection")!;
    assert.equal(ref.status, "active");
  });
});

// ─── 3. Two sources, one dedup ───────────────────────────────────────

describe("extractOmMemories — custom entries + om.folded snapshots", () => {
  it("merges both sources with a single dedup (nested details)", () => {
    const entries = [
      obsRecordedEntry([makeObs(1, "from custom entry", "critical")], "e1"),
      compactionEntry(
        [makeObs(1, "duplicate in snapshot", "low"), makeObs(2, "only in snapshot")],
        [makeRef(3)],
        { nested: true }
      ),
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 3);
    const obs1 = rows.find((r) => r.memoryId === hexId(1))!;
    assert.equal(obs1.content, "from custom entry"); // first-valid-wins across sources
    assert.equal(obs1.relevance, "critical");
    assert.ok(rows.some((r) => r.memoryId === hexId(2) && r.content === "only in snapshot"));
    assert.ok(rows.some((r) => r.memoryId === hexId(3) && r.kind === "reflection"));
  });

  it("accepts MemoryDetails directly in entry.details (non-nested form)", () => {
    const entries = [compactionEntry([makeObs(5, "direct details")], [], { nested: false })];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "direct details");
  });

  it("session with only a snapshot surviving still yields rows", () => {
    const entries = [compactionEntry([makeObs(5), makeObs(6)], [makeRef(7)], { nested: true })];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 3);
  });
});

// ─── 4. Invalid data ─────────────────────────────────────────────────

describe("extractOmMemories — invalid data is ignored, never throws", () => {
  it("ignores entries with invalid relevance / non-hex ids / empty arrays", () => {
    const badObs = { ...makeObs(1), relevance: "urgent" };
    const badId = { ...makeObs(1), id: "not-hex-id" };
    const entries: SessionEntry[] = [
      { type: "custom", id: "b1", parentId: null, timestamp: "t", customType: "om.observations.recorded", data: { observations: [badObs], coversUpToId: "c" } },
      { type: "custom", id: "b2", parentId: null, timestamp: "t", customType: "om.observations.recorded", data: { observations: [badId], coversUpToId: "c" } },
      { type: "custom", id: "b3", parentId: null, timestamp: "t", customType: "om.observations.recorded", data: { observations: [], coversUpToId: "c" } },
      { type: "custom", id: "b4", parentId: null, timestamp: "t", customType: "om.observations.dropped", data: { observationIds: [], coversUpToId: "c" } },
      { type: "custom", id: "b5", parentId: null, timestamp: "t", customType: "om.reflections.recorded", data: { reflections: [{ ...makeRef(2), content: "multi\nline" }], coversUpToId: "c" } },
      { type: "custom", id: "b6", parentId: null, timestamp: "t", customType: "om.observations.recorded", data: { observations: [makeObs(3)] } }, // missing coversUpToId
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 0);
  });

  it("a single invalid observation invalidates its whole entry (strict vendored guard)", () => {
    const entries = [obsRecordedEntry([makeObs(1), { ...makeObs(2), relevance: "bogus" as any }])];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 0);
  });

  it("ignores unknown custom types and malformed compaction details", () => {
    const entries: SessionEntry[] = [
      { type: "custom", id: "u1", parentId: null, timestamp: "t", customType: "om.future.thing", data: { observations: [makeObs(1)], coversUpToId: "c" } },
      { type: "compaction", id: "u2", parentId: null, timestamp: "t", details: { "om.folded": { type: "om.folded", version: 99 } } },
      { type: "compaction", id: "u3", parentId: null, timestamp: "t", details: "garbage" },
    ];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 0);
  });
});

// ─── 5. Reflections ──────────────────────────────────────────────────

describe("extractOmMemories — reflections", () => {
  it("produces rows without timestamp/relevance, always active", () => {
    const entries = [refRecordedEntry([makeRef(10)])];
    const rows = extractOmMemories(entries, "sess-1");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.kind, "reflection");
    assert.equal(r.relevance, null);
    assert.equal(r.timestamp, null);
    assert.equal(r.status, "active");
    assert.deepEqual(r.sourceEntryIds, ["src2", "src3"]); // from supportingObservationIds
    assert.equal(r.tokenCount, 12);
  });
});

// ─── scanFileForOm ───────────────────────────────────────────────────

describe("scanFileForOm", () => {
  const tmpDir = join(tmpdir(), `om-scan-test-${process.pid}`);

  it("detects the om. substring, misses clean files, survives chunk boundaries", () => {
    mkdirSync(tmpDir, { recursive: true });
    try {
      const withOm = join(tmpDir, "with.jsonl");
      writeFileSync(withOm, '{"type":"custom","customType":"om.observations.recorded"}', "utf8");
      assert.equal(scanFileForOm(withOm), true);

      const without = join(tmpDir, "without.jsonl");
      writeFileSync(without, '{"type":"message","text":"nothing here"}', "utf8");
      assert.equal(scanFileForOm(without), false);

      // Needle split across the 64KB chunk boundary: "o" | "m."
      const boundary = join(tmpDir, "boundary.jsonl");
      writeFileSync(boundary, "x".repeat(64 * 1024 - 1) + "om.", "utf8");
      assert.equal(scanFileForOm(boundary), true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns false for missing files", () => {
    assert.equal(scanFileForOm("/nonexistent/file.jsonl"), false);
  });
});

// ─── unwrapMemoryDetails ─────────────────────────────────────────────

describe("unwrapMemoryDetails", () => {
  it("unwraps both direct and nested details", () => {
    const direct = compactionEntry([makeObs(1)], [], { nested: false });
    const nested = compactionEntry([makeObs(1)], [], { nested: true });
    assert.ok(unwrapMemoryDetails(direct));
    assert.ok(unwrapMemoryDetails(nested));
    const none: SessionEntry = { type: "compaction", id: "x", parentId: null, timestamp: "t", details: { other: 1 } };
    assert.equal(unwrapMemoryDetails(none), undefined);
  });
});

// ─── capOmMemories (persistence double cap) ──────────────────────────

function omRow(n: number, kind: "observation" | "reflection", content: string, relevance: Relevance | null = "medium", timestamp: string | null = "2026-08-01 10:00"): OmMemoryRow {
  return {
    memoryId: hexId(n),
    sessionId: "sess-1",
    kind,
    relevance,
    status: "active",
    timestamp,
    tokenCount: 10,
    sourceEntryIds: ["s1"],
    content,
  };
}

describe("capOmMemories", () => {
  it("leaves small sets untouched (capped=false)", () => {
    const rows = [omRow(1, "observation", "short"), omRow(2, "reflection", "also short", null, null)];
    const { rows: out, capped } = capOmMemories(rows);
    assert.equal(capped, false);
    assert.deepEqual(out, rows);
  });

  it("applies the 8K per-memory cap and sets the flag", () => {
    const big = "x".repeat(OM_MEMORY_CONTENT_CAP + 500);
    const { rows, capped } = capOmMemories([omRow(1, "observation", big)]);
    assert.equal(capped, true);
    assert.equal(rows[0].content.length, OM_MEMORY_CONTENT_CAP);
    assert.equal(rows[0].memoryId, hexId(1)); // metadata intact
  });

  it("aggregate budget: reflections and high/critical survive, low is emptied first", () => {
    // reflections: 2×2000 = 4000 · critical: 2×3000 = 6000 · medium: 2×3000 = 6000
    // low: 4×3000 = 12000 → total 28000 > 16000. Kept: refs(4000)+crit(6000)+med(6000)=16000 exactly,
    // so all low observations end up with content "".
    const rows = [
      omRow(1, "observation", "l".repeat(3000), "low", "2026-08-01 10:04"),
      omRow(2, "reflection", "r".repeat(2000), null, null),
      omRow(3, "observation", "c".repeat(3000), "critical", "2026-08-01 10:01"),
      omRow(4, "observation", "l".repeat(3000), "low", "2026-08-01 10:05"),
      omRow(5, "reflection", "r".repeat(2000), null, null),
      omRow(6, "observation", "m".repeat(3000), "medium", "2026-08-01 10:02"),
      omRow(7, "observation", "c".repeat(3000), "critical", "2026-08-01 10:03"),
      omRow(8, "observation", "m".repeat(3000), "medium", "2026-08-01 10:06"),
      omRow(9, "observation", "l".repeat(3000), "low", "2026-08-01 10:07"),
      omRow(10, "observation", "l".repeat(3000), "low", "2026-08-01 10:08"),
    ];
    const { rows: out, capped } = capOmMemories(rows);
    assert.equal(capped, true);
    assert.equal(out.length, rows.length); // all rows survive (metadata intact)
    const keptTotal = out.reduce((n, r) => n + r.content.length, 0);
    assert.ok(keptTotal <= OM_SESSION_CONTENT_BUDGET, `kept ${keptTotal} ≤ budget`);
    // reflections and critical/medium fully kept
    for (const id of [2, 3, 5, 6, 7, 8]) {
      const r = out.find((x) => x.memoryId === hexId(id))!;
      assert.ok(r.content.length > 0, `id ${id} kept`);
    }
    // all low observations emptied
    for (const id of [1, 4, 9, 10]) {
      const r = out.find((x) => x.memoryId === hexId(id))!;
      assert.equal(r.content, "", `low id ${id} emptied`);
      assert.equal(r.relevance, "low"); // metadata intact
    }
    // original file order preserved
    assert.deepEqual(out.map((r) => r.memoryId), rows.map((r) => r.memoryId));
  });

  it("hard cap: nobody is exempt when reflections+high alone exceed the budget", () => {
    // 10 reflections × 2000 = 20000 > 16000 → frontier truncation + emptying, even reflections.
    const rows = Array.from({ length: 10 }, (_, i) => omRow(i + 1, "reflection", "r".repeat(2000), null, null));
    rows.push(omRow(11, "observation", "h".repeat(3000), "high"));
    const { rows: out, capped } = capOmMemories(rows);
    assert.equal(capped, true);
    const keptTotal = out.reduce((n, r) => n + r.content.length, 0);
    assert.ok(keptTotal <= OM_SESSION_CONTENT_BUDGET, `kept ${keptTotal} ≤ budget`);
    assert.ok(keptTotal > 0);
    // some reflection must have been truncated or emptied (priority does not exempt)
    const truncatedOrEmpty = out.filter((r) => r.content.length < 2000 && r.kind === "reflection");
    assert.ok(truncatedOrEmpty.length > 0, "frontier truncation/emptying reaches reflections");
    // the high observation (lowest priority here) is emptied
    assert.equal(out[out.length - 1].content, "");
    // every row still has full metadata
    for (const r of out) {
      assert.ok(r.memoryId && r.sessionId && r.kind && r.status);
    }
  });

  it("frontier memory is partially truncated to exactly the remaining budget", () => {
    // budget 16000 (contents under the 8K per-memory cap): 8000 + 7000 fit,
    // the third reflection is truncated to the remaining 1000 (partial frontier)
    const rows = [
      omRow(1, "reflection", "a".repeat(8000), null, null),
      omRow(2, "reflection", "b".repeat(7000), null, null),
      omRow(3, "reflection", "c".repeat(5000), null, null),
    ];
    const { rows: out, capped } = capOmMemories(rows);
    assert.equal(capped, true);
    assert.equal(out[0].content.length, 8000);
    assert.equal(out[1].content.length, 7000);
    assert.equal(out[2].content.length, 1000); // partial at the frontier
  });
});

// ─── JSONL session fixture helpers ───────────────────────────────────

function tmpRoot(tag: string): string {
  return join(tmpdir(), `om-test-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
}

function sessionHeader(id: string) {
  return {
    type: "session",
    version: 1,
    id,
    timestamp: "2026-08-01T09:00:00Z",
    cwd: "/home/user/proj",
  };
}

function userMsg(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-01T09:01:00Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

/** Write a session JSONL under `<sessionsDir>/--proj--/<name>.jsonl`. */
function writeSession(sessionsDir: string, name: string, entries: any[], id: string): string {
  const dir = join(sessionsDir, "--proj--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  const lines = [sessionHeader(id), ...entries];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

// ─── 6. Parser integration ───────────────────────────────────────────

describe("parseSession — OM integration", () => {
  it("extracts folded omMemories from the three customTypes + a snapshot", () => {
    const root = tmpRoot("parse");
    try {
      const file = writeSession(
        root,
        "s1",
        [
          userMsg("m1", "hello"),
          obsRecordedEntry([makeObs(1, "from custom", "high")], "e1"),
          droppedEntry([hexId(1)], "e2"),
          refRecordedEntry([makeRef(2)], "e3"),
          compactionEntry([makeObs(3, "only in snapshot")], [], { nested: true, id: "e4" }),
        ],
        "sess-uuid-1"
      );
      const parsed = parseSession(file, false);
      assert.ok(parsed);
      assert.equal(parsed.omMemories.length, 3);
      const dropped = parsed.omMemories.find((r) => r.memoryId === hexId(1))!;
      assert.equal(dropped.status, "dropped");
      assert.equal(dropped.sessionId, "sess-uuid-1");
      const ref = parsed.omMemories.find((r) => r.memoryId === hexId(2))!;
      assert.equal(ref.kind, "reflection");
      const snap = parsed.omMemories.find((r) => r.memoryId === hexId(3))!;
      assert.equal(snap.content, "only in snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sessions without the OM marker get an empty array (cheap guard holds)", () => {
    const root = tmpRoot("parse-clean");
    try {
      const file = writeSession(root, "clean", [userMsg("m1", "just chat")], "sess-uuid-2");
      const parsed = parseSession(file, false);
      assert.ok(parsed);
      assert.deepEqual(parsed.omMemories, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("chat text mentioning om.foo does not crash extraction (false positive is harmless)", () => {
    const root = tmpRoot("parse-fp");
    try {
      const file = writeSession(root, "fp", [userMsg("m1", "what does om.foo mean?")], "sess-uuid-3");
      const parsed = parseSession(file, false);
      assert.ok(parsed);
      assert.deepEqual(parsed.omMemories, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Mock embedder ───────────────────────────────────────────────────

interface MockEmbedder extends Embedder {
  calls: string[];
}

function mockEmbedder(dims = 4, vecFor?: (text: string) => number[]): MockEmbedder {
  const calls: string[] = [];
  const vf =
    vecFor ??
    ((text: string) => {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return Array.from({ length: dims }, (_, i) => ((h >> (i % 24)) & 0xff) / 255);
    });
  return {
    calls,
    async embed(text: string) {
      calls.push(text);
      return vf(text);
    },
    async embedBatch(texts: string[]) {
      calls.push(...texts);
      return texts.map(vf);
    },
  };
}

const MOCK_FP: EmbedderFingerprint = { model: "mock:model", dims: 4 };

// ─── 7. Recurrence (COUNT DISTINCT session_id) ───────────────────────

describe("om_memories — recurrence", () => {
  it("counts distinct sessions per memory id", async () => {
    const root = tmpRoot("recurrence");
    try {
      const sessionsDir = join(root, "sessions");
      const shared = makeObs(1, "shared fact alfa");
      writeSession(sessionsDir, "a", [userMsg("m1", "hi alfa"), obsRecordedEntry([shared, makeObs(2, "only in a alfa")], "e1")], "uuid-a");
      writeSession(sessionsDir, "b", [userMsg("m1", "hi alfa"), obsRecordedEntry([shared], "e1")], "uuid-b");
      writeSession(sessionsDir, "c", [userMsg("m1", "hi alfa"), obsRecordedEntry([makeObs(3, "only in c alfa")], "e1")], "uuid-c");

      const indexDir = join(root, "index");
      const idx = new FtsSessionIndex(indexDir, [sessionsDir], []);
      await idx.load();
      await idx.sync();
      try {
        const rec = idx.memoryRecurrences([hexId(1), hexId(2), hexId(3)]);
        assert.equal(rec.get(hexId(1)), 2); // shared across a+b
        assert.equal(rec.get(hexId(2)), 1);
        assert.equal(rec.get(hexId(3)), 1);
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 8. Filters ──────────────────────────────────────────────────────

describe("om_memories — filters", () => {
  it("status default is active; kind/relevance/session restrict; all includes dropped", async () => {
    const root = tmpRoot("filters");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(
        sessionsDir,
        "a",
        [
          userMsg("m1", "hi"),
          obsRecordedEntry(
            [makeObs(1, "alfa active high", "high"), makeObs(2, "alfa active low", "low"), makeObs(3, "alfa dropped high", "high")],
            "e1"
          ),
          droppedEntry([hexId(3)], "e2"),
          refRecordedEntry([makeRef(4, "alfa reflection")], "e3"),
        ],
        "uuid-a"
      );
      writeSession(sessionsDir, "b", [userMsg("m1", "hi"), obsRecordedEntry([makeObs(5, "alfa other session", "medium")], "e1")], "uuid-b");

      const idx = new FtsSessionIndex(join(root, "index"), [sessionsDir], []);
      await idx.load();
      await idx.sync();
      try {
        // default status=active excludes the dropped one
        const active = await idx.searchMemories("alfa", {}, 25);
        const activeIds = active.map((h) => h.row.memoryId);
        assert.ok(activeIds.includes(hexId(1)));
        assert.ok(!activeIds.includes(hexId(3)), "dropped excluded by default");

        // status:"all" includes dropped
        const all = await idx.searchMemories("alfa", { status: "all" }, 25);
        assert.ok(all.map((h) => h.row.memoryId).includes(hexId(3)), "dropped visible with status all");

        // status:"dropped" returns only dropped
        const droppedOnly = await idx.searchMemories("alfa", { status: "dropped" }, 25);
        assert.deepEqual(droppedOnly.map((h) => h.row.memoryId), [hexId(3)]);

        // kind filter
        const refs = await idx.searchMemories("alfa", { kind: "reflection" }, 25);
        assert.deepEqual(refs.map((h) => h.row.memoryId), [hexId(4)]);
        const obs = await idx.searchMemories("alfa", { kind: "observation", status: "all" }, 25);
        assert.ok(obs.every((h) => h.row.kind === "observation"));

        // relevance filter
        const low = await idx.searchMemories("alfa", { relevance: "low" }, 25);
        assert.deepEqual(low.map((h) => h.row.memoryId), [hexId(2)]);

        // session filter
        const sessB = await idx.searchMemories("alfa", { session: "uuid-b", status: "all" }, 25);
        assert.deepEqual(sessB.map((h) => h.row.memoryId), [hexId(5)]);
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 9. Hybrid RRF + FTS-only degradation ────────────────────────────

describe("searchMemories — hybrid RRF k=60", () => {
  it("RRF surfaces both a FTS-only hit and a cosine-only hit", async () => {
    const root = tmpRoot("rrf");
    try {
      const sessionsDir = join(root, "sessions");
      const FTS_CONTENT = "alfa keyword hit only";
      const COS_CONTENT = "semantic twin with no shared terms";
      writeSession(
        sessionsDir,
        "a",
        [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, FTS_CONTENT, "high"), makeObs(2, COS_CONTENT, "high")], "e1")],
        "uuid-a"
      );

      const Q = "alfa";
      const vecMap = new Map<string, number[]>([
        [Q, [1, 0, 0, 0]],
        [FTS_CONTENT, [0, 1, 0, 0]], // orthogonal to query → FTS-only
        [COS_CONTENT, [0.98, 0.02, 0, 0]], // ≈ query vector → cosine-only
      ]);
      const emb = mockEmbedder(4, (t) => vecMap.get(t) ?? [0, 0, 1, 0]);

      const idx = new SessionIndex(emb, join(root, "index"), [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();
      try {
        const hits = await idx.searchMemories(Q, {}, 10);
        const ids = hits.map((h) => h.row.memoryId);
        assert.ok(ids.includes(hexId(1)), "FTS-only hit surfaced by RRF");
        assert.ok(ids.includes(hexId(2)), "cosine-only hit surfaced by RRF");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FTS-only mode degrades to BM25 (no cosine side without embedder)", async () => {
    const root = tmpRoot("fts-only");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(
        sessionsDir,
        "a",
        [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, "alfa keyword hit", "high"), makeObs(2, "unrelated semantic content", "high")], "e1")],
        "uuid-a"
      );
      const idx = new FtsSessionIndex(join(root, "index"), [sessionsDir], []);
      await idx.load();
      await idx.sync();
      try {
        const hits = await idx.searchMemories("alfa", {}, 10);
        const ids = hits.map((h) => h.row.memoryId);
        assert.ok(ids.includes(hexId(1)), "keyword hit found");
        assert.ok(!ids.includes(hexId(2)), "no cosine side to surface the semantic twin");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 10. Sidecar rebuild (decisión 9) ────────────────────────────────

describe("populateFtsFromIndex — OM rows survive sidecar rebuild", () => {
  function bigOmEntries(): any[] {
    // >16K OM content: 3 reflections ×2000 + critical 2×3000 + medium 2×3000 + low 4×3000 = 28K
    return [
      userMsg("m1", "big om session"),
      refRecordedEntry([makeRef(20, "r".repeat(2000)), makeRef(21, "r".repeat(2000)), makeRef(22, "r".repeat(2000))], "e1"),
      obsRecordedEntry(
        [
          makeObs(23, "c".repeat(3000), "critical", "2026-08-01 10:01"),
          makeObs(24, "c".repeat(3000), "critical", "2026-08-01 10:02"),
          makeObs(25, "m".repeat(3000), "medium", "2026-08-01 10:03"),
          makeObs(26, "m".repeat(3000), "medium", "2026-08-01 10:04"),
          makeObs(27, "l".repeat(3000), "low", "2026-08-01 10:05"),
          makeObs(28, "l".repeat(3000), "low", "2026-08-01 10:06"),
          makeObs(29, "l".repeat(3000), "low", "2026-08-01 10:07"),
          makeObs(30, "l".repeat(3000), "low", "2026-08-01 10:08"),
        ],
        "e2"
      ),
    ];
  }

  it("repopulates om_memories from the stripped JSON when hybrid-fts.db is deleted", async () => {
    const root = tmpRoot("rebuild");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(sessionsDir, "plain", [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, "alfa plain")], "e1")], "uuid-plain");
      const indexDir = join(root, "index");

      const emb = mockEmbedder();
      let idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();
      const statsBefore = idx.omStats();
      assert.ok(statsBefore.total > 0);
      idx.close();

      // Delete the sidecar DB → next load() must repopulate from the JSON index
      rmSync(join(indexDir, "hybrid-fts.db"), { force: true });
      idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      try {
        const statsAfter = idx.omStats();
        assert.equal(statsAfter.total, statsBefore.total);
        assert.equal(statsAfter.distinctIds, statsBefore.distinctIds);
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aggregate cap: metadata intact in JSON, verbatim restored by directed reparse on rebuild", async () => {
    const root = tmpRoot("rebuild-capped");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(sessionsDir, "big", bigOmEntries(), "uuid-big");
      const indexDir = join(root, "index");

      const emb = mockEmbedder();
      let idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();

      // Persisted JSON entry: all 11 memories, metadata intact, capped flag set,
      // low observations emptied, reflections/critical kept
      const entry = (idx as any).data.sessions["uuid-big"];
      assert.ok(entry, "session indexed");
      assert.equal(entry.omContentCapped, true);
      assert.equal(entry.session.omMemories.length, 11);
      const keptTotal = entry.session.omMemories.reduce((n: number, r: OmMemoryRow) => n + r.content.length, 0);
      assert.ok(keptTotal <= OM_SESSION_CONTENT_BUDGET, `kept ${keptTotal} ≤ budget`);
      for (const r of entry.session.omMemories) {
        assert.ok(r.memoryId && r.kind && r.status, "metadata intact");
      }
      const lowRows = entry.session.omMemories.filter((r: OmMemoryRow) => r.relevance === "low");
      assert.ok(lowRows.every((r: OmMemoryRow) => r.content === ""), "low emptied first");
      const refRows = entry.session.omMemories.filter((r: OmMemoryRow) => r.kind === "reflection");
      assert.ok(refRows.every((r: OmMemoryRow) => r.content.length === 2000), "reflections kept whole");

      // FTS holds the verbatim content (28K), not the capped one
      const ftsRows = (idx as any).fts.omRowsMatching({ status: "all" }) as OmMemoryRow[];
      const ftsTotal = ftsRows.reduce((n, r) => n + r.content.length, 0);
      assert.ok(ftsTotal > OM_SESSION_CONTENT_BUDGET, `verbatim FTS content (${ftsTotal})`);
      idx.close();

      // Delete sidecar → rebuild must re-parse the flagged file and restore verbatim content
      rmSync(join(indexDir, "hybrid-fts.db"), { force: true });
      idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      try {
        const rebuilt = (idx as any).fts.omRowsMatching({ status: "all" }) as OmMemoryRow[];
        assert.equal(rebuilt.length, 11);
        const rebuiltTotal = rebuilt.reduce((n, r) => n + r.content.length, 0);
        assert.ok(rebuiltTotal > OM_SESSION_CONTENT_BUDGET, `verbatim restored via reparse (${rebuiltTotal})`);
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fallback: with the source file gone, rebuild uses capped rows (metadata intact)", async () => {
    const root = tmpRoot("rebuild-gone");
    try {
      const sessionsDir = join(root, "sessions");
      const file = writeSession(sessionsDir, "big", bigOmEntries(), "uuid-big");
      const indexDir = join(root, "index");

      const emb = mockEmbedder();
      let idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();
      idx.close();

      // Source file vanishes + sidecar deleted → populate falls back to capped rows
      rmSync(file, { force: true });
      rmSync(join(indexDir, "hybrid-fts.db"), { force: true });
      idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      try {
        const rows = (idx as any).fts.omRowsMatching({ status: "all" }) as OmMemoryRow[];
        assert.equal(rows.length, 11, "rows still resolvable (metadata intact)");
        const total = rows.reduce((n, r) => n + r.content.length, 0);
        assert.ok(total <= OM_SESSION_CONTENT_BUDGET, `capped fallback (${total})`);
        assert.ok(rows.some((r) => r.content === ""), "emptied rows present");
        assert.ok(rows.every((r) => r.memoryId && r.kind && r.status), "metadata intact");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard cap in persistence: even reflections are truncated/emptied past the budget", async () => {
    const root = tmpRoot("hardcap");
    try {
      const sessionsDir = join(root, "sessions");
      const manyRefs = Array.from({ length: 10 }, (_, i) => makeRef(40 + i, "r".repeat(2000)));
      writeSession(sessionsDir, "extreme", [userMsg("m1", "x"), refRecordedEntry(manyRefs, "e1")], "uuid-extreme");
      const idx = new SessionIndex(mockEmbedder(), join(root, "index"), [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();
      try {
        const entry = (idx as any).data.sessions["uuid-extreme"];
        assert.equal(entry.omContentCapped, true);
        assert.equal(entry.session.omMemories.length, 10);
        const kept = entry.session.omMemories.reduce((n: number, r: OmMemoryRow) => n + r.content.length, 0);
        assert.ok(kept <= OM_SESSION_CONTENT_BUDGET, `kept ${kept} ≤ budget`);
        const notWhole = entry.session.omMemories.filter((r: OmMemoryRow) => r.content.length < 2000);
        assert.ok(notWhole.length > 0, "nobody exempt — reflections truncated/emptied too");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 11. Embedding store, fingerprint, reconcile ─────────────────────

describe("OmEmbeddingStore", () => {
  it("put/has/missingIds/loadAll/gc roundtrip with fingerprint semantics", () => {
    const root = tmpRoot("embstore");
    mkdirSync(root, { recursive: true });
    const store = new OmEmbeddingStore(root);
    try {
      const fpA: EmbedderFingerprint = { model: "mA", dims: 2 };
      const fpB: EmbedderFingerprint = { model: "mB", dims: 2 };
      const fpC: EmbedderFingerprint = { model: "mA", dims: 4 };

      store.put(hexId(1), [1, 0], fpA);
      store.put(hexId(2), [0, 1], fpA);

      assert.equal(store.has(hexId(1), fpA), true);
      assert.equal(store.has(hexId(3), fpA), false);

      // stale by model or by dims → treated as missing
      assert.deepEqual(store.missingIds([hexId(1), hexId(2)], fpA), []);
      assert.deepEqual(store.missingIds([hexId(1), hexId(2)], fpB), [hexId(1), hexId(2)]);
      assert.deepEqual(store.missingIds([hexId(1), hexId(2)], fpC), [hexId(1), hexId(2)]);
      assert.deepEqual(store.missingIds([hexId(1), hexId(9)], fpA), [hexId(9)]);

      // put upserts (overwrite with a new fingerprint)
      store.put(hexId(1), [0.5, 0.5], fpB);
      assert.equal(store.has(hexId(1), fpB), true);
      assert.equal(store.has(hexId(1), fpA), false);

      // loadAll only returns the active fingerprint's vectors — never mixes spaces
      const allB = store.loadAll(fpB);
      assert.deepEqual([...allB.keys()], [hexId(1)]);
      const allA = store.loadAll(fpA);
      assert.deepEqual([...allA.keys()], [hexId(2)]);
      assert.equal(allA.get(hexId(2))!.length, 2);
      assert.ok(Math.abs(allA.get(hexId(2))![1] - 1) < 1e-6);

      // count with/without fingerprint
      assert.equal(store.count(), 2);
      assert.equal(store.count(fpA), 1);
      assert.equal(store.count(fpB), 1);

      // gc deletes only orphans
      const removed = store.gc(new Set([hexId(1)]));
      assert.equal(removed, 1);
      assert.equal(store.count(), 1);
      assert.equal(store.has(hexId(1), fpB), true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reconcileOmEmbeddings", () => {
  it("re-embeds stale rows from stored om_memories.content after a fingerprint change (no re-parse)", async () => {
    const root = tmpRoot("reconcile");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(
        sessionsDir,
        "a",
        [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, "fact one alfa"), makeObs(2, "fact two beta")], "e1")],
        "uuid-a"
      );
      const indexDir = join(root, "index");
      const fp1: EmbedderFingerprint = { model: "mock:v1", dims: 4 };
      const fp2: EmbedderFingerprint = { model: "mock:v2", dims: 4 };

      // Index with fp1 → vectors exist for fp1
      const emb1 = mockEmbedder();
      let idx = new SessionIndex(emb1, indexDir, [sessionsDir], [], fp1);
      await idx.load();
      await idx.sync();
      assert.equal(idx.omStats().vectors, 2);
      idx.close();

      // New embedder config (fp2) over the same index dir. load() reuses the
      // JSON index; sync() would skip unchanged files, so reconcile must draw
      // content from om_memories — NOT from a re-parse.
      const emb2 = mockEmbedder();
      idx = new SessionIndex(emb2, indexDir, [sessionsDir], [], fp2);
      await idx.load();
      try {
        assert.equal(idx.omStats().vectors, 0, "no fp2 vectors yet");
        const res = await idx.reconcileOmEmbeddings();
        assert.equal(res.embedded, 2);
        assert.equal(res.alreadyFresh, 0);
        // contents came from the stored rows
        assert.ok(emb2.calls.includes("fact one alfa"));
        assert.ok(emb2.calls.includes("fact two beta"));
        assert.equal(idx.omStats().vectors, 2);

        // second run is a real no-op (set-gate closed)
        const callsBefore = emb2.calls.length;
        const res2 = await idx.reconcileOmEmbeddings();
        assert.equal(res2.embedded, 0);
        assert.equal(res2.alreadyFresh, 2);
        assert.equal(emb2.calls.length, callsBefore, "no API calls when nothing is missing");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mixed rows embed from the longest content; solo-empty ids are skipped and reported", async () => {
    const root = tmpRoot("reconcile-mixed");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(sessionsDir, "a", [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, "seed")], "e1")], "uuid-a");
      const indexDir = join(root, "index");
      const emb = mockEmbedder();
      const idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();

      // White-box setup: mixed rows for one id + a solo-empty id
      const mixed = omRow(10, "observation", "full content for mixed id");
      mixed.sessionId = "uuid-a";
      const emptyRow = { ...mixed, sessionId: "uuid-b", content: "" };
      (idx as any).fts.upsertOm("uuid-a", [mixed]);
      (idx as any).fts.upsertOm("uuid-b", [emptyRow]);
      const soloEmpty = omRow(11, "observation", "");
      soloEmpty.sessionId = "uuid-c";
      (idx as any).fts.upsertOm("uuid-c", [soloEmpty]);

      try {
        const res = await idx.reconcileOmEmbeddings();
        assert.ok(emb.calls.includes("full content for mixed id"), "longest content chosen");
        assert.ok(!emb.calls.includes(""), "never embeds empty text");
        assert.equal(res.skippedEmpty, 1, "solo-empty id reported");
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate is set-based: an orphan vector plus a missing one cannot cancel out", async () => {
    const root = tmpRoot("reconcile-gate");
    try {
      const sessionsDir = join(root, "sessions");
      writeSession(sessionsDir, "a", [userMsg("m1", "hi"), obsRecordedEntry([makeObs(1, "needed content alfa")], "e1")], "uuid-a");
      const indexDir = join(root, "index");
      const emb = mockEmbedder();
      const idx = new SessionIndex(emb, indexDir, [sessionsDir], [], MOCK_FP);
      await idx.load();
      await idx.sync();
      assert.equal(idx.omStats().vectors, 1);

      // White-box: wipe the needed vector, add an ORPHAN vector (id not in om_memories).
      // Cardinalities now match (1 needed ↔ 1 stored) — a count-based gate would
      // wrongly no-op; the set-based gate must still embed the missing id.
      (idx as any).omEmbeddings.gc(new Set());
      (idx as any).omEmbeddings.put(hexId(99), [0.1, 0.2, 0.3, 0.4], MOCK_FP);
      assert.equal(idx.omStats().vectors, 1, "counts equal (orphan present)");

      try {
        const res = await idx.reconcileOmEmbeddings();
        assert.equal(res.embedded, 1, "missing id embedded despite equal counts");
        assert.ok(emb.calls.includes("needed content alfa"));
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Output formatting contracts (plan §2.7 / §5) ────────────────────

describe("om-format — rendering rules", () => {
  it("observation hit shows relevance/timestamp/status; reflection omits them", async () => {
    const { formatMemoryHit } = await import("../om-format");
    const session = { id: "uuid-a", name: "Test session", firstUserMessage: "hi", startedAt: "2026-08-01T09:00:00Z", projectSlug: "--proj--" };
    const obsRow = omRow(1, "observation", "some content", "critical", "2026-08-01 10:00");
    obsRow.sessionId = "uuid-a";
    const obsHit = {
      row: obsRow,
      recurrence: 3,
      score: 0.5,
      session,
    };
    const out = formatMemoryHit(obsHit, 1);
    assert.ok(out.includes(`### 1. [${hexId(1)}] observation [critical] [active] — 2026-08-01 10:00`));
    assert.ok(out.includes("Aparece en 3 sesiones"));
    assert.ok(out.includes(`om_memory_resolve("${hexId(1)}")`));
    assert.ok(out.includes(`session_read("uuid-a")`));
    assert.ok(!out.includes("undefined") && !out.includes("null"));

    const refHit = {
      row: omRow(2, "reflection", "ref content", null, null),
      recurrence: 1,
      score: 0.5,
      session,
    };
    const rout = formatMemoryHit(refHit, 2);
    assert.ok(rout.includes(`### 2. [${hexId(2)}] reflection [active]`));
    assert.ok(!rout.includes("null"), "no 'null' rendered for reflection relevance/timestamp");
    assert.ok(rout.includes("Aparece en 1 sesión"), "singular form for N=1");
  });

  it("resolve output: header, single content, presence list, follow-ups", async () => {
    const { formatMemoryResolve } = await import("../om-format");
    const s1 = { id: "uuid-a", name: "S1", firstUserMessage: "", startedAt: "2026-08-01T09:00:00Z", projectSlug: "--p1--" };
    const s2 = { id: "uuid-b", name: "S2", firstUserMessage: "", startedAt: "2026-08-02T09:00:00Z", projectSlug: "--p2--" };
    const r1 = omRow(5, "observation", "the fact", "high", "2026-08-01 10:00");
    r1.sessionId = "uuid-a";
    const r2 = { ...omRow(5, "observation", "the fact", "high", "2026-08-01 10:00"), sessionId: "uuid-b", status: "dropped" as const };
    const out = formatMemoryResolve(hexId(5), [
      { row: r1, recurrence: 2, score: 0, session: s1 },
      { row: r2, recurrence: 2, score: 0, session: s2 },
    ]);
    assert.ok(out.includes(`Memory ${hexId(5)} — observation [high] — aparece en 2 sesiones:`));
    assert.ok(out.includes('"the fact"'));
    assert.ok(out.includes("[active]"));
    assert.ok(out.includes("[dropped en esta sesión]"));
    assert.ok(out.includes("observada 2026-08-01 10:00"));
    assert.ok(out.includes(`recall("${hexId(5)}")`));
  });

  it("search output carries the provenance tag and footer", async () => {
    const { formatMemorySearchOutput, OM_SEARCH_FOOTER } = await import("../om-format");
    const session = { id: "uuid-a", name: "S", firstUserMessage: "", startedAt: "2026-08-01T09:00:00Z", projectSlug: "--p--" };
    const hit = { row: omRow(1, "observation", "c"), recurrence: 1, score: 0.1, session };
    const stats = { total: 2, observations: 2, reflections: 0, dropped: 0, active: 2, distinctIds: 2, recurrentObsIds: 0, sessionsWithOm: 1 };
    const hybrid = formatMemorySearchOutput([hit], "q", { hybrid: true, stats });
    assert.ok(hybrid.startsWith("OM memory hits (índice FTS+embeddings de pi-session-search)"));
    assert.ok(hybrid.includes(OM_SEARCH_FOOTER));
    const ftsOnly = formatMemorySearchOutput([hit], "q", { hybrid: false, stats });
    assert.ok(ftsOnly.startsWith("OM memory hits (índice FTS de pi-session-search)"));
  });
});
