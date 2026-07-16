/**
 * Tests for the MS-365 write batch ledger — issue #3267 (Problem 2).
 *
 * The load-bearing outcome: once a batch has aborted (grant lapsed/denied for
 * one op), the REMAINING identical ops are refused UP FRONT rather than
 * continuing to half-apply — and the agent gets an accurate "N of the batch
 * already applied" count. These tests fail against the pre-fix code, which had
 * no ledger and would keep posting cards for every op regardless.
 */

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateBatchAdmission,
  countCurrentBatchApplied,
  recordOutcome,
  readLedger,
  pruneLedger,
  buildBatchAbortReason,
  batchLedgerPath,
  BATCH_COOLDOWN_MS,
  type BatchEntry,
} from "./batch-ledger.js";

describe("evaluateBatchAdmission (pure)", () => {
  const now = 1_000_000;

  it("admits when the ledger is empty (a first write is never blocked)", () => {
    const r = evaluateBatchAdmission({ entries: [], now });
    expect(r.admit).toBe(true);
    expect(r.appliedInBatch).toBe(0);
  });

  it("admits when only applied entries exist (no abort yet)", () => {
    const entries: BatchEntry[] = [
      { ts: now - 1000, tool: "t", itemId: "a", outcome: "applied" },
      { ts: now - 500, tool: "t", itemId: "b", outcome: "applied" },
    ];
    expect(evaluateBatchAdmission({ entries, now }).admit).toBe(true);
  });

  it("REFUSES up front after an abort within the cooldown, counting prior applied ops", () => {
    // Batch: op1 applied, op2 applied, op3 aborted (grant lapsed). op4 now asks.
    const entries: BatchEntry[] = [
      { ts: now - 3000, tool: "t", itemId: "a", outcome: "applied" },
      { ts: now - 2000, tool: "t", itemId: "b", outcome: "applied" },
      { ts: now - 1000, tool: "t", itemId: "c", outcome: "aborted" },
    ];
    const r = evaluateBatchAdmission({ entries, now });
    expect(r.admit).toBe(false);
    expect(r.appliedInBatch).toBe(2);
    expect(r.abortedAt).toBe(now - 1000);
  });

  it("re-admits once the abort is older than the cooldown window", () => {
    const entries: BatchEntry[] = [
      { ts: now - (BATCH_COOLDOWN_MS + 5000), tool: "t", itemId: "c", outcome: "aborted" },
    ];
    expect(evaluateBatchAdmission({ entries, now }).admit).toBe(true);
  });
});

describe("countCurrentBatchApplied — batch identity (Finding 1)", () => {
  const now = 10_000_000;

  it("counts a contiguous run of close-together applied writes", () => {
    const entries: BatchEntry[] = [
      { ts: now - 20_000, tool: "t", itemId: "a", outcome: "applied" },
      { ts: now - 15_000, tool: "t", itemId: "b", outcome: "applied" },
      { ts: now - 10_000, tool: "t", itemId: "c", outcome: "applied" },
    ];
    expect(countCurrentBatchApplied(entries, now)).toBe(3);
  });

  it("does NOT count an unrelated earlier applied write once the batch is cold", () => {
    // Single applied at T-4min; the batch window is 2min, so at `now` it's cold.
    const entries: BatchEntry[] = [
      { ts: now - 4 * 60_000, tool: "t", itemId: "solo", outcome: "applied" },
    ];
    expect(countCurrentBatchApplied(entries, now)).toBe(0);
  });

  it("excludes applied writes separated from the current run by a gap > window", () => {
    const entries: BatchEntry[] = [
      { ts: now - 5 * 60_000, tool: "t", itemId: "old", outcome: "applied" }, // different batch
      { ts: now - 20_000, tool: "t", itemId: "a", outcome: "applied" },
      { ts: now - 10_000, tool: "t", itemId: "b", outcome: "applied" },
    ];
    expect(countCurrentBatchApplied(entries, now)).toBe(2);
  });
});

// ── Finding 1 regression: prior UNRELATED applied write + later lone timeout ──
// must NOT be treated as a mid-batch abort, and must NOT trigger a cooldown
// block on subsequent writes.
describe("Finding 1 — a stale applied entry never false-blocks a later lone timeout", () => {
  it("lone timeout minutes after an unrelated single write → no abort, no block", () => {
    const t0 = 20_000_000;
    // 10:00 — one unrelated calendar edit applied.
    const afterFirstEdit: BatchEntry[] = [
      { ts: t0, tool: "u", itemId: "edit-1", outcome: "applied" },
    ];

    // 10:04 — a DIFFERENT single edit hits a timeout. The hook computes the
    // current-batch applied count as of the lapse; the 10:00 entry is cold.
    const lapseAt = t0 + 4 * 60_000;
    const appliedInThisBatch = countCurrentBatchApplied(afterFirstEdit, lapseAt);
    expect(appliedInThisBatch).toBe(0); // → hook does NOT record an abort

    // Because no abort was recorded, admission for the next write is clean.
    const nextWriteAt = lapseAt + 5_000;
    const admission = evaluateBatchAdmission({
      entries: afterFirstEdit, // still just the lone applied entry
      now: nextWriteAt,
    });
    expect(admission.admit).toBe(true);
    expect(admission.appliedInBatch).toBe(0);
  });

  it("a genuine mid-batch lapse still blocks, and reports THIS batch's count only", () => {
    const t0 = 21_000_000;
    // Unrelated old write far in the past (same retention window, different batch).
    const entries: BatchEntry[] = [
      { ts: t0, tool: "u", itemId: "unrelated", outcome: "applied" },
      // Real batch, seconds apart, starting ~5min later:
      { ts: t0 + 5 * 60_000, tool: "u", itemId: "b1", outcome: "applied" },
      { ts: t0 + 5 * 60_000 + 8_000, tool: "u", itemId: "b2", outcome: "applied" },
    ];
    const lapseAt = t0 + 5 * 60_000 + 20_000;
    const applied = countCurrentBatchApplied(entries, lapseAt);
    expect(applied).toBe(2); // NOT 3 — the unrelated write is excluded

    // Simulate the hook recording the abort with the batch-scoped count.
    entries.push({
      ts: lapseAt,
      tool: "u",
      itemId: "b3",
      outcome: "aborted",
      appliedInBatch: applied,
    });
    const admission = evaluateBatchAdmission({ entries, now: lapseAt + 2_000 });
    expect(admission.admit).toBe(false);
    expect(admission.appliedInBatch).toBe(2);
  });
});

describe("buildBatchAbortReason", () => {
  it("is a distinct, actionable signal (not a bare 'operator expired')", () => {
    const reason = buildBatchAbortReason(2);
    expect(reason).toContain("2 MS-365 writes already applied");
    expect(reason).toContain("STOP");
    expect(reason).not.toBe("operator expired");
  });
  it("singularises for one applied write", () => {
    expect(buildBatchAbortReason(1)).toContain("1 MS-365 write already applied");
  });
});

describe("pruneLedger", () => {
  it("drops entries older than retention and future-dated entries", () => {
    const now = 1_000_000;
    const entries: BatchEntry[] = [
      { ts: now - 1000, tool: "t", itemId: "a", outcome: "applied" }, // keep
      { ts: now - 60 * 60 * 1000, tool: "t", itemId: "b", outcome: "applied" }, // too old
      { ts: now + 5000, tool: "t", itemId: "c", outcome: "applied" }, // future
    ];
    const kept = pruneLedger(entries, now);
    expect(kept.map((e) => e.itemId)).toEqual(["a"]);
  });
});

describe("ledger persistence (fail-soft I/O)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ms365-ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips applied/aborted outcomes and drives an up-front refusal", () => {
    const path = join(dir, "batch.json");
    const t0 = 2_000_000;
    recordOutcome(t0, { tool: "u", itemId: "a", outcome: "applied" }, path);
    recordOutcome(t0 + 1000, { tool: "u", itemId: "b", outcome: "applied" }, path);
    recordOutcome(
      t0 + 2000,
      { tool: "u", itemId: "c", outcome: "aborted", appliedInBatch: 2 },
      path,
    );

    expect(existsSync(path)).toBe(true);
    const now = t0 + 2500;
    const ledger = readLedger(now, path);
    // appliedInBatch survives the round-trip on aborted entries.
    const aborted = ledger.entries.find((e) => e.outcome === "aborted");
    expect(aborted?.appliedInBatch).toBe(2);
    const admission = evaluateBatchAdmission({ entries: ledger.entries, now });
    expect(admission.admit).toBe(false);
    expect(admission.appliedInBatch).toBe(2);
  });

  it("leaves no leftover .tmp files after atomic writes (Finding 3)", () => {
    const path = join(dir, "batch.json");
    const t0 = 3_000_000;
    recordOutcome(t0, { tool: "u", itemId: "a", outcome: "applied" }, path);
    recordOutcome(t0 + 100, { tool: "u", itemId: "b", outcome: "applied" }, path);
    const stray = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(stray).toEqual([]);
  });

  it("returns an empty ledger for a missing/corrupt file (never throws)", () => {
    expect(readLedger(1, join(dir, "nope.json")).entries).toEqual([]);
  });

  it("resolves a default path under TELEGRAM_STATE_DIR", () => {
    const saved = process.env.TELEGRAM_STATE_DIR;
    process.env.TELEGRAM_STATE_DIR = dir;
    try {
      expect(batchLedgerPath()).toBe(join(dir, "ms365-write-batch.json"));
    } finally {
      if (saved === undefined) delete process.env.TELEGRAM_STATE_DIR;
      else process.env.TELEGRAM_STATE_DIR = saved;
    }
  });
});
