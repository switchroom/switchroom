import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enqueuePending,
  readPending,
  outstandingCount,
} from "../src/self-improve/pending-queue.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "self-improve-pending-"));
});
afterEach(() => {
  if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

const base = {
  tier: "T2" as const,
  lesson: "exclude drafts",
  proposed_change: "add a draft filter",
  tier_reason: "no own-skill target",
  triggered_by: ["operator-correction"],
};

describe("pending-suggestions queue", () => {
  it("starts empty", () => {
    expect(readPending(stateDir)).toEqual([]);
    expect(outstandingCount(stateDir)).toBe(0);
  });

  it("appends a suggestion with id + timestamp", () => {
    const r = enqueuePending(stateDir, base, { now: () => 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.suggestion.id).toMatch(/[0-9a-f-]{36}/);
      expect(r.suggestion.created_at).toBe(new Date(1_700_000_000_000).toISOString());
      expect(r.suggestion.tier).toBe("T2");
    }
    const all = readPending(stateDir);
    expect(all.length).toBe(1);
    expect(outstandingCount(stateDir)).toBe(1);
  });

  it("persists multiple suggestions as JSON lines", () => {
    enqueuePending(stateDir, base);
    enqueuePending(stateDir, { ...base, tier: "T3", lesson: "new cron asked" });
    const all = readPending(stateDir);
    expect(all.length).toBe(2);
    expect(all.map((s) => s.tier).sort()).toEqual(["T2", "T3"]);
  });

  it("enforces the outstanding cap (default 5) and refuses gracefully", () => {
    for (let i = 0; i < 5; i++) {
      const r = enqueuePending(stateDir, { ...base, lesson: `lesson ${i}` }, { cap: 5 });
      expect(r.ok).toBe(true);
    }
    const refused = enqueuePending(stateDir, { ...base, lesson: "one too many" }, { cap: 5 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("cap-reached");
      expect(refused.outstanding).toBe(5);
      expect(refused.cap).toBe(5);
    }
    // Nothing extra was written.
    expect(readPending(stateDir).length).toBe(5);
  });

  it("tolerates a malformed line without losing valid entries", () => {
    const r = enqueuePending(stateDir, base);
    expect(r.ok).toBe(true);
    // Hand-corrupt by appending junk.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(join(stateDir, "self-improve-pending.jsonl"), "{not json\n");
    expect(readPending(stateDir).length).toBe(1);
  });
});
