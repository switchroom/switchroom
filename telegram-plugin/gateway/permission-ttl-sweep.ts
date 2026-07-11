/**
 * The permission TTL sweep — the code path that used to auto-deny approvals the
 * operator never saw.
 *
 * WHY THIS IS A MODULE AND NOT A LOOP INSIDE gateway.ts:
 *
 * gateway.ts has top-level side effects and is not importable from a test. The
 * first version of the outcome test worked around that by letting its harness
 * carry a PRIVATE re-implementation of this sweep. The result was a placebo:
 * deleting the real guard from gateway.ts left every behavioural assertion GREEN,
 * because the double silently compensated — only a source-text grep noticed.
 *
 * A test that cannot fail is not a test, and this is the sweep that implements the
 * `no-self-escalation` / `on-leash` invariant. So the DECISION lives here, in one
 * importable place, and both gateway.ts and the outcome test drive this exact
 * function. Delete the leash check inside `shouldExpirePermission` and the outcome
 * test goes red — because there is only one implementation to delete.
 *
 * @see reference/jobs/approve-what-my-agent-can-touch.md
 * @see reference/invariants.md § no-self-escalation, § on-leash
 */

import { shouldExpirePermission, type UndeliverableMark } from './approval-hold.js'

/** The fields of a pending permission this sweep actually reads. */
export interface TtlSweepEntry {
  tool_name: string
  startedAt: number
  undeliverable?: UndeliverableMark | null
}

export interface TtlSweepDeps<T extends TtlSweepEntry> {
  /** The live pending-permission map. */
  entries: Iterable<readonly [string, T]>
  now: number
  /** Per-tool TTL (hostd fleet-mutation verbs get a longer human-scale window). */
  ttlForTool: (toolName: string) => number
  /**
   * Expire this request: dispatch the deny verdict, strip the card's keyboard,
   * wake the parked turn, record the miss, and drop the entry. Everything the
   * gateway does on a timeout — the sweep decides WHETHER, the caller decides HOW.
   */
  onExpire: (requestId: string, pend: T, ttlMs: number) => void
}

/**
 * Expire every pending permission past its TTL — except the HELD ones, which
 * never expire.
 *
 * Returns the ids it expired (for logging/tests).
 */
export function sweepPermissionTtl<T extends TtlSweepEntry>(
  deps: TtlSweepDeps<T>,
): string[] {
  const expired: string[] = []
  for (const [requestId, pend] of deps.entries) {
    const ttlMs = deps.ttlForTool(pend.tool_name)
    // THE LEASH. `shouldExpirePermission` returns false for any entry marked
    // undeliverable — an ask the operator was never shown. Never auto-approve,
    // never auto-deny, not even on a deadline.
    if (!shouldExpirePermission(pend, deps.now, ttlMs)) continue
    deps.onExpire(requestId, pend, ttlMs)
    expired.push(requestId)
  }
  return expired
}
