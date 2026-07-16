/**
 * Tests for the MS-365 write batch ledger — issue #3267 (Problem 2).
 *
 * The load-bearing outcome: once a batch has aborted (grant lapsed/denied for
 * one op), the REMAINING identical ops are refused UP FRONT rather than
 * continuing to half-apply — and the agent gets an accurate "N of the batch
 * already applied" count. These tests fail against the pre-fix code, which had
 * no ledger and would keep posting cards for every op regardless.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateBatchAdmission,
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
    recordOutcome(t0 + 2000, { tool: "u", itemId: "c", outcome: "aborted" }, path);

    expect(existsSync(path)).toBe(true);
    const now = t0 + 2500;
    const ledger = readLedger(now, path);
    const admission = evaluateBatchAdmission({ entries: ledger.entries, now });
    expect(admission.admit).toBe(false);
    expect(admission.appliedInBatch).toBe(2);
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
