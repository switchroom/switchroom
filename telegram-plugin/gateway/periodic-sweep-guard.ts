/**
 * periodic-sweep-guard.ts — single-flight wrapper for an interval-driven sweep.
 *
 * Why this exists
 * ---------------
 * `runMidSessionCardReaper` (gateway.ts) is dispatched from a `setInterval` as
 * `void run()`, every 5 minutes by default. Its body awaits REAL Telegram calls:
 * `robustApiCall` finalize edits for orphaned activity cards, and
 * `reconcileStatusPin` unpins for stale `wk:` pins. Both retry with backoff and
 * both can park behind a flood-wait — this gateway took a 62-minute flood ban on
 * 2026-07-25.
 *
 * With no guard, every tick started ANOTHER concurrent pass. During a stall that
 * is unbounded fan-out: N passes reading the same `status-pins.json`, deciding
 * the same reaps, and firing duplicate unpins into the very rate limit that was
 * slowing them down. Concurrent passes also race each other in the store-orphan
 * branch, which unpins and drops the row OUTSIDE the per-key reconcile lock.
 *
 * The guard is deliberately SKIP, not queue: a tick arriving while a pass is
 * running is dropped. The reaper is a backstop with no deadline, and the next
 * tick is at most one interval away — queuing would just rebuild the same
 * pile-up with extra latency.
 *
 * It also absorbs a throw out of the pass. The gateway's `unhandledRejection`
 * handler crashes the process, and a fire-and-forget cosmetic sweep must never
 * be able to do that (the same rule `reconcileStatusPin` follows after a benign
 * pin-rights 400 took the whole gateway down, marko 2026-07-01).
 */

export interface PeriodicSweepGuard {
  /** Run the sweep unless a pass is already in flight. Never rejects. */
  tick(): Promise<void>
  /** True while a pass is in flight. Test/introspection seam. */
  isRunning(): boolean
  /** Passes skipped because one was already running. Test/introspection seam. */
  skipped(): number
}

/**
 * Wrap `run` so at most one pass is in flight at a time.
 *
 * `onSkip` / `onError` are optional observers (the gateway logs to stderr);
 * both are themselves absorbed, so a broken logger cannot take down the one
 * function whose job is to make the sweep un-crashable.
 */
export function createPeriodicSweepGuard(args: {
  run: () => Promise<void>
  onSkip?: () => void
  onError?: (err: unknown) => void
}): PeriodicSweepGuard {
  let running = false
  let skippedCount = 0

  const notify = (fn: (() => void) | undefined): void => {
    if (fn == null) return
    try {
      fn()
    } catch {
      /* an observer must never break the guard */
    }
  }

  return {
    async tick(): Promise<void> {
      if (running) {
        skippedCount += 1
        notify(args.onSkip)
        return
      }
      running = true
      try {
        await args.run()
      } catch (err) {
        notify(args.onError == null ? undefined : () => args.onError?.(err))
      } finally {
        running = false
      }
    },
    isRunning(): boolean {
      return running
    },
    skipped(): number {
      return skippedCount
    },
  }
}
