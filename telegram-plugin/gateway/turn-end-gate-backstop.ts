/**
 * turn-end gate-wedge backstop (#2094 finding 1).
 *
 * The `turn_end` session-event handler in `gateway.ts` runs a long
 * synchronous prelude (narrative dedup, answer-stream finalize,
 * `redactOutboundText`, `progressDriver?.takeOverCard`, …) before it reaches
 * the branch that calls `endCurrentTurnAtomic` → `purgeReactionTracking` —
 * the canonical op that deletes this turn's `activeTurnStartedAt` entry and
 * re-opens the #1556 inbound buffer gate.
 *
 * If ANY of those pre-purge ops throws, the handler exits before the canonical
 * purge runs, leaving `activeTurnStartedAt` (and the mirrored `claudeBusyKeys`
 * that `purgeReactionTracking` drains) populated. The #1556 inbound gate then
 * wedges CLOSED: every subsequent inbound buffers, and only the 300 s
 * silence-poke fallback eventually recovers it (degraded, not permanent).
 *
 * `withTurnEndGateBackstop` wraps the handler body in a guarded `try/finally`.
 * The `finally` acts ONLY when a throw skipped the canonical purge — detected
 * by the turn's key still being present in `activeTurnStartedAt`. On the happy
 * path the canonical purge already deleted the key, so the backstop is a
 * no-op. The original error is NOT swallowed: `finally` re-raises it after the
 * backstop purge, so upstream error handling / unhandled-rejection policy is
 * unchanged.
 */
export interface TurnEndGateBackstopDeps<T> {
  /** True while `key`'s `activeTurnStartedAt` entry is still populated. */
  hasActiveTurn: (key: string) => boolean
  /** The canonical purge (production wires this to `purgeReactionTracking`). */
  purge: (key: string, endingTurn: T | undefined) => void
  /** Optional structured log emitted only when the backstop actually fires. */
  log?: (msg: string) => void
}

/**
 * Run `body` (the synchronous turn_end handler body) under a guarded finally.
 *
 * @param key         the turn's status key, or null when there was no live
 *                    turn to end (then the backstop can never fire).
 * @param endingTurn  the captured turn atom, forwarded to `purge` so the
 *                    shadow trace sees the authoritative `replyCalled` flag.
 */
export function withTurnEndGateBackstop<T>(
  key: string | null,
  endingTurn: T | null,
  body: () => void,
  deps: TurnEndGateBackstopDeps<T>,
): void {
  try {
    body()
  } finally {
    if (key != null && deps.hasActiveTurn(key)) {
      deps.log?.(
        `telegram gateway: turn_end backstop-purge — a pre-purge throw left ` +
          `the #1556 inbound gate wedged (key=${key}); forcing purge (#2094)`,
      )
      deps.purge(key, endingTurn ?? undefined)
    }
  }
}
