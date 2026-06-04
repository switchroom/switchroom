/**
 * withDeadline — bound a promise so the chain off it ALWAYS settles within `ms`.
 *
 * Why this exists (the obligation-ledger determinism hole): the escalation send
 * in `obligationSweep` is fire-and-forget and clears its in-flight guard
 * (`obligationEscalateInFlight`) only in a `.finally` — which runs only if the
 * awaited promise SETTLES. grammy's `bot.api` has no request timeout
 * (`new Bot(TOKEN)`, no `client.timeoutSeconds`) and `retryApiCall`'s `await
 * fn()` does not bound a hang (its retry cap applies to rejections, not to a
 * promise that never resolves). So a stalled send (half-open TCP, unresponsive
 * Telegram) would never settle → `.finally` never fires → the in-flight id is
 * leaked forever → every later sweep early-returns at the guard → the
 * obligation is stuck OPEN: never re-presented, never escalated, never closed.
 * That is a silent loss of the "every inbound is answered-or-escalated"
 * guarantee — the one liveness hole a total state-machine proof surfaced (a
 * sampling test cannot, because its model never includes "send never settles").
 *
 * Racing the send against a deadline makes the wait bounded BY CONSTRUCTION:
 * the returned promise settles in ≤ `ms`, so the caller's `.then/.catch/.finally`
 * always run and the in-flight flag always clears. A hang becomes a bounded
 * rejection that feeds the already-bounded escalate ladder
 * (`escalateAttempts → OBLIGATION_ESCALATE_MAX`) to a terminal. The losing
 * (still-pending) promise is given a no-op `.catch` so its eventual rejection
 * is not an unhandled rejection, and the timer is cleared + unref'd so it
 * neither leaks nor keeps the event loop alive.
 *
 * Pure (no gateway/Telegram coupling) ⇒ unit-testable; see
 * tests/with-deadline.test.ts.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  // Swallow a late rejection from the loser after the race has already settled,
  // so a hung-then-eventually-rejected send is never an unhandled rejection.
  p.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms)
    // Don't keep the process alive solely for this timer.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}
