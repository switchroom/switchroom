/**
 * Pure origin-recovery for a permission/approval card when the gateway's live
 * `currentTurn` has already been nulled.
 *
 * Why this exists (marko Rentals-budget incident, 2026-06-17). A
 * supergroup-owned agent that delivers its final answer as plain transcript
 * text — never calling the `reply` tool — has its turn force-closed by the
 * gateway's orphaned-reply backstop ~30s later, which nulls `currentTurn`. If
 * the single claude session is still running and then calls a permission-gated
 * tool (the real case: retrying `meta_ads_set_budget` after a first card had
 * auto-denied), the gate fires with `currentTurn == null`. The card emitter
 * then fell through to broadcasting the card to the operator-DM allowlist,
 * thread-stripped — so the card never reached the forum topic the operator was
 * working in. Unanswered there, it hit the 10-minute TTL and auto-denied, and
 * an explicitly-approved budget change silently never ran.
 *
 * A switchroom agent runs exactly ONE claude session, so a tool permission can
 * only belong to the turn that session most recently had open. We recover that
 * origin from the bounded recently-started turn registry: the most-recently-
 * started turn still within `maxAgeMs`. A turn force-closed by the backstop is,
 * by construction, seconds-to-minutes old, so the freshness ceiling costs
 * nothing for the incident class while keeping a long-idle agent's stale
 * registry entry from mis-routing a much later permission into an old topic —
 * beyond the ceiling we return null and the caller keeps the existing
 * operator-DM fan-out. This only ever ADDS topic recovery; it never changes the
 * idle/turn-less path.
 */

/** The subset of a turn this recovery needs — kept structural so the gateway's
 *  richer `CurrentTurn` satisfies it without a cast. */
export interface RecoverableTurn {
  sessionChatId: string
  sessionThreadId: number | undefined
  startedAt: number
}

export interface PermissionCardOrigin {
  chatId: string
  threadId: number | undefined
}

/**
 * Pick the most-recently-started turn within the freshness window as the
 * permission card's origin, or null when none qualifies (caller falls back to
 * the operator-DM fan-out). Order-independent — selects by `startedAt`, not by
 * the iteration order of the source registry, so it is robust to any
 * out-of-order insertion.
 */
export function pickRecoveredPermissionOrigin(
  recentTurns: Iterable<RecoverableTurn>,
  now: number,
  maxAgeMs: number,
): PermissionCardOrigin | null {
  let best: RecoverableTurn | null = null
  for (const t of recentTurns) {
    if (now - t.startedAt > maxAgeMs) continue
    if (best == null || t.startedAt >= best.startedAt) best = t
  }
  return best == null
    ? null
    : { chatId: best.sessionChatId, threadId: best.sessionThreadId }
}
