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

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** How long an abort suppresses the rest of a batch. */
export const BATCH_COOLDOWN_MS = 90 * 1000;
/** Entries older than this are pruned on every read/write. */
export const BATCH_LEDGER_RETENTION_MS = 10 * 60 * 1000;
/**
 * Max gap between two consecutive ops for them to count as the SAME batch.
 * A batch is a run of writes issued close together (the incident's four
 * `update-calendar-event` calls were seconds apart). Applied writes separated
 * by more than this — e.g. an unrelated edit minutes earlier — are a DIFFERENT
 * batch and must not inflate the current batch's applied count (Finding 1).
 */
export const BATCH_WINDOW_MS = 2 * 60 * 1000;

export type BatchOutcome = "applied" | "aborted";

export interface BatchEntry {
  /** Unix-ms when the outcome was recorded. */
  ts: number;
  /** Full tool name (`mcp__ms-365__…`). */
  tool: string;
  /** Item/event id the op targeted. */
  itemId: string;
  outcome: BatchOutcome;
  /**
   * For `aborted` entries only: how many writes had already applied in THIS
   * batch at abort time. Captured at write time (batch-scoped, see
   * `countCurrentBatchApplied`) so admission doesn't have to recount against a
   * window that may include unrelated writes.
   */
  appliedInBatch?: number;
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
      ? (parsed.entries as BatchEntry[])
          .filter(
            (e): e is BatchEntry =>
              !!e &&
              typeof e === "object" &&
              typeof (e as BatchEntry).ts === "number" &&
              ((e as BatchEntry).outcome === "applied" ||
                (e as BatchEntry).outcome === "aborted"),
          )
          .map((e) => {
            // Keep only the fields we trust; preserve the batch-scoped count on
            // aborts so admission can reflect "N of THIS batch" verbatim.
            const out: BatchEntry = {
              ts: e.ts,
              tool: typeof e.tool === "string" ? e.tool : "",
              itemId: typeof e.itemId === "string" ? e.itemId : "",
              outcome: e.outcome,
            };
            if (
              e.outcome === "aborted" &&
              typeof e.appliedInBatch === "number"
            ) {
              out.appliedInBatch = e.appliedInBatch;
            }
            return out;
          })
      : [];
    return { entries: pruneLedger(entries, now) };
  } catch {
    return { entries: [] };
  }
}

/**
 * Count the writes that have applied in the CURRENT batch as of `asOf`. Pure.
 *
 * A batch is the maximal run of `applied` entries ending at the most recent
 * applied entry, where consecutive entries are ≤ `batchWindowMs` apart AND the
 * most recent applied entry is itself ≤ `batchWindowMs` before `asOf`. Applied
 * writes that fall outside that window (an unrelated edit minutes earlier)
 * belong to a DIFFERENT, already-cold batch and are NOT counted — so a lone
 * later timeout does not inherit their count (Finding 1).
 *
 * Returns 0 when there is no active batch (empty, or the last applied write is
 * already colder than the window) — i.e. "nothing applied in THIS batch".
 */
export function countCurrentBatchApplied(
  entries: BatchEntry[],
  asOf: number,
  batchWindowMs = BATCH_WINDOW_MS,
): number {
  const applied = entries
    .filter((e) => e.outcome === "applied")
    .sort((a, b) => a.ts - b.ts);
  if (applied.length === 0) return 0;
  const last = applied[applied.length - 1];
  if (asOf - last.ts > batchWindowMs) return 0; // batch already cold
  let count = 1;
  for (let i = applied.length - 1; i > 0; i--) {
    if (applied[i].ts - applied[i - 1].ts <= batchWindowMs) count++;
    else break;
  }
  return count;
}

/**
 * Append an outcome and persist ATOMICALLY. Fail-soft: a write failure is
 * swallowed (the ledger is an advisory safety net, not a correctness gate for
 * the single op). Returns the in-memory ledger regardless.
 *
 * Concurrency (Finding 3): the per-op hook processes can race, so the write is
 * temp-file + atomic `rename` — a concurrent reader sees either the old or the
 * new complete file, never a torn half-write, and the fail-soft empty-ledger
 * recovery on `readLedger` still covers any residual corruption.
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
    const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(ledger), "utf8");
    renameSync(tmp, p);
  } catch {
    /* advisory — never block on a ledger write failure */
  }
  return ledger;
}

export interface BatchAdmission {
  /** Whether this op may proceed to post a card / apply. */
  admit: boolean;
  /** Count of writes already applied in the current (aborted) batch. */
  appliedInBatch: number;
  /** Unix-ms of the abort that is suppressing this op, when admit=false. */
  abortedAt?: number;
}

/**
 * Decide whether a new op may start, given the current ledger. Pure.
 *
 * Refuse UP FRONT when the batch was aborted within `cooldownMs`: the grant
 * lapsed for an earlier op, so the remaining identical ops must not keep
 * half-applying. `appliedInBatch` is read from the abort entry itself (the
 * batch-scoped count captured at abort time), so it reflects "N of THIS batch
 * already landed" — never an unrelated earlier write (Finding 1).
 */
export function evaluateBatchAdmission(args: {
  entries: BatchEntry[];
  now: number;
  cooldownMs?: number;
}): BatchAdmission {
  const { entries, now } = args;
  const cooldownMs = args.cooldownMs ?? BATCH_COOLDOWN_MS;

  let lastAbort: BatchEntry | undefined;
  for (const e of entries) {
    if (e.outcome === "aborted" && (lastAbort === undefined || e.ts > lastAbort.ts)) {
      lastAbort = e;
    }
  }
  if (lastAbort === undefined || now - lastAbort.ts > cooldownMs) {
    return { admit: true, appliedInBatch: 0 };
  }
  // Prefer the count captured at abort time; fall back to a batch-scoped
  // recount anchored at the abort instant for older/hand-written entries.
  const appliedInBatch =
    typeof lastAbort.appliedInBatch === "number"
      ? lastAbort.appliedInBatch
      : countCurrentBatchApplied(entries, lastAbort.ts);
  return { admit: false, appliedInBatch, abortedAt: lastAbort.ts };
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
