/**
 * MS-365 write batch ledger — fix for issue #3267 (Problem 2).
 *
 * The `ms-365-write-pretool` hook runs as a FRESH PROCESS per tool call, so a
 * run of identical writes (e.g. four `update-calendar-event` calls) is really
 * four independent approvals. Previously, when a grant/TTL lapsed between the
 * 2nd and 3rd op, ops 1–2 had already mutated Graph and op 3 hard-blocked with
 * a bare `operator expired` — leaving the calendar half-applied with no
 * coherent "the batch is aborted, stop" signal to the agent.
 *
 * True cross-process rollback of external Graph writes is impossible from a
 * pretool hook. What IS deterministic and achievable is a small on-disk ledger
 * shared across the per-op processes:
 *
 *   1. Every APPLIED write appends an `applied` entry.
 *   2. A GRANT LAPSE (expired / approver drift) that occurs when earlier ops
 *      have already applied appends an `aborted` entry. An explicit Deny, and a
 *      lone lapse with nothing applied, do NOT — those must not suppress later
 *      unrelated writes.
 *   3. Before starting a new op, the hook consults the ledger: if the batch
 *      was aborted within a short cooldown window, the remaining ops are
 *      REFUSED UP FRONT (no card, no mutation) with a distinct
 *      "grant lapsed, N of the batch already applied — STOP and reconcile"
 *      signal, instead of dribbling further partial application + re-prompts.
 *
 * This turns the failure mode from "silently keep half-applying and re-prompt"
 * into "abort the rest of the batch up front and tell the agent exactly how
 * many ops already landed" — the coherent stop signal the issue asks for.
 *
 * All I/O here is BEST-EFFORT and fail-soft: a missing/corrupt ledger must
 * never crash the hook or wrongly block a legitimate first write.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long an abort suppresses the rest of a batch. */
export const BATCH_COOLDOWN_MS = 90 * 1000;
/** Entries older than this are pruned on every read/write. */
export const BATCH_LEDGER_RETENTION_MS = 10 * 60 * 1000;

export type BatchOutcome = "applied" | "aborted";

export interface BatchEntry {
  /** Unix-ms when the outcome was recorded. */
  ts: number;
  /** Full tool name (`mcp__ms-365__…`). */
  tool: string;
  /** Item/event id the op targeted. */
  itemId: string;
  outcome: BatchOutcome;
}

export interface BatchLedger {
  entries: BatchEntry[];
}

/**
 * Resolve the ledger path inside the agent container. Mirrors the pretool's
 * own state-dir resolution (`TELEGRAM_STATE_DIR`, homedir fallback for
 * host-side tests).
 */
export function batchLedgerPath(stateDir?: string): string {
  const dir =
    stateDir ??
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram");
  return join(dir, "ms365-write-batch.json");
}

/** Drop entries older than the retention window. Pure. */
export function pruneLedger(
  entries: BatchEntry[],
  now: number,
  retentionMs = BATCH_LEDGER_RETENTION_MS,
): BatchEntry[] {
  return entries.filter(
    (e) =>
      e &&
      typeof e.ts === "number" &&
      now - e.ts <= retentionMs &&
      now - e.ts >= 0,
  );
}

/** Read + prune the ledger. Fail-soft: returns empty on any error. */
export function readLedger(now: number, path?: string): BatchLedger {
  const p = path ?? batchLedgerPath();
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries)
      ? (parsed.entries as BatchEntry[]).filter(
          (e): e is BatchEntry =>
            !!e &&
            typeof e === "object" &&
            typeof (e as BatchEntry).ts === "number" &&
            ((e as BatchEntry).outcome === "applied" ||
              (e as BatchEntry).outcome === "aborted"),
        )
      : [];
    return { entries: pruneLedger(entries, now) };
  } catch {
    return { entries: [] };
  }
}

/**
 * Append an outcome and persist. Fail-soft: a write failure is swallowed (the
 * ledger is an advisory safety net, not a correctness gate for the single op).
 * Returns the in-memory ledger regardless so callers can reason about it.
 */
export function recordOutcome(
  now: number,
  entry: Omit<BatchEntry, "ts">,
  path?: string,
): BatchLedger {
  const p = path ?? batchLedgerPath();
  const ledger = readLedger(now, p);
  ledger.entries.push({ ...entry, ts: now });
  try {
    writeFileSync(p, JSON.stringify(ledger), "utf8");
  } catch {
    /* advisory — never block on a ledger write failure */
  }
  return ledger;
}

export interface BatchAdmission {
  /** Whether this op may proceed to post a card / apply. */
  admit: boolean;
  /** Count of writes already applied in the current (aborted) batch window. */
  appliedInBatch: number;
  /** Unix-ms of the abort that is suppressing this op, when admit=false. */
  abortedAt?: number;
}

/**
 * Decide whether a new op may start, given the current ledger. Pure.
 *
 * Refuse UP FRONT when the batch was aborted within `cooldownMs`: the grant
 * lapsed (or was denied) for an earlier op, so the remaining identical ops
 * must not keep half-applying. `appliedInBatch` counts the `applied` entries
 * that precede the most recent abort within the retention window — i.e. "N of
 * the batch already landed".
 */
export function evaluateBatchAdmission(args: {
  entries: BatchEntry[];
  now: number;
  cooldownMs?: number;
}): BatchAdmission {
  const { entries, now } = args;
  const cooldownMs = args.cooldownMs ?? BATCH_COOLDOWN_MS;

  let lastAbortTs: number | undefined;
  for (const e of entries) {
    if (e.outcome === "aborted" && (lastAbortTs === undefined || e.ts > lastAbortTs)) {
      lastAbortTs = e.ts;
    }
  }
  if (lastAbortTs === undefined || now - lastAbortTs > cooldownMs) {
    return { admit: true, appliedInBatch: 0 };
  }
  const appliedInBatch = entries.filter(
    (e) => e.outcome === "applied" && e.ts <= lastAbortTs!,
  ).length;
  return { admit: false, appliedInBatch, abortedAt: lastAbortTs };
}

/**
 * Build the distinct agent-facing block reason for a lapsed/aborted batch.
 * Deliberately NOT the bare `operator expired` string — it tells the agent the
 * batch is partially applied and must be reconciled, not blindly retried.
 */
export function buildBatchAbortReason(appliedInBatch: number): string {
  const n = appliedInBatch;
  return (
    `grant lapsed mid-batch — ${n} MS-365 write${n === 1 ? "" : "s"} already ` +
    `applied in this batch; remaining ops aborted. STOP: do not retry blindly — ` +
    `reconcile what landed before re-issuing.`
  );
}
