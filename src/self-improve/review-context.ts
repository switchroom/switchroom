/**
 * Agent self-improvement — the REVIEW-CONTEXT marker (slice 2).
 *
 * Slice 1 injects a forked review turn (the Stop hook → `inject_inbound`);
 * slice 2 makes that turn's skill edits land SAFELY behind a deterministic
 * PreToolUse apply-guard. The guard runs out-of-process and cannot read the
 * injected inbound's `meta.source` (that arrives in the prompt text the
 * model sees, not in the hook's stdin). So the Stop hook drops a small
 * marker file at injection time recording "a self-improve review is now
 * pending"; the apply-guard reads it to decide whether to enforce the T1
 * gate.
 *
 *   <stateDir>/self-improve-review-context.json
 *
 * The marker is the seam between the two hooks. When ABSENT, the
 * apply-guard is a no-op (a normal turn's skill write is governed only by
 * the advisory linter, exactly as before). When PRESENT, the apply-guard
 * enforces: own-skill, diff-cap, evals pass, rate-cap — and on ANY failure
 * BLOCKS the write and downgrades the change to a T2/T3 pending suggestion.
 *
 * Keeping this a tiny pure module (write / read / clear) lets both hooks
 * agree on one shape, and lets the apply-guard tests construct a marker
 * without the gateway.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { LearningSignal } from "./types.js";

export const REVIEW_CONTEXT_FILE = "self-improve-review-context.json";

export interface ReviewContext {
  /** ISO timestamp the review was injected. */
  created_at: string;
  /** The session that triggered the review (audit only). */
  triggering_session: string;
  /** The chat the review nominally belongs to (context only). */
  chat_id: string;
  /** The gate's detected signals — carried so the apply-guard can record
   *  an accurate `triggered_by` on any downgraded proposal. */
  signals: LearningSignal[];
}

function contextPath(stateDir: string): string {
  return join(stateDir, REVIEW_CONTEXT_FILE);
}

/**
 * Write the marker. Called by the Stop hook at injection time, so the
 * apply-guard in the forked review turn can find it. Best-effort: a marker
 * write failure must not stop the review from being injected (the guard
 * then simply no-ops, which is fail-OPEN for the marker but the eval gate
 * inside the review prompt is still the model's instruction).
 */
export function writeReviewContext(stateDir: string, ctx: ReviewContext): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  }
  writeFileSync(contextPath(stateDir), JSON.stringify(ctx, null, 2), "utf-8");
}

/** Read the marker, or null if absent / unreadable / malformed. */
export function readReviewContext(stateDir: string): ReviewContext | null {
  const p = contextPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as ReviewContext;
    if (parsed && typeof parsed.created_at === "string") {
      if (!Array.isArray(parsed.signals)) parsed.signals = [];
      return parsed;
    }
  } catch {
    /* malformed — treat as absent */
  }
  return null;
}

/** True iff a review is currently pending (marker present + readable). */
export function reviewIsPending(stateDir: string): boolean {
  return readReviewContext(stateDir) !== null;
}

/**
 * Remove the marker. Called by the Stop hook at the END of a review turn
 * (so a single review can't keep enforcing across later normal turns), and
 * defensively by the apply-guard's tests. Best-effort.
 */
export function clearReviewContext(stateDir: string): void {
  try {
    rmSync(contextPath(stateDir), { force: true });
  } catch {
    /* nothing to do */
  }
}
