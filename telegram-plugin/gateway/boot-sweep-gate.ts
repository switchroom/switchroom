/**
 * boot-sweep-gate.ts — two-condition arming gate for the boot pin sweep (#3664).
 *
 * Why this exists
 * ---------------
 * The boot orphan sweep (`runBootPinCleanupAndDmSweep` → `statusPinBootCleanup`
 * → `unpinChatMessage`) has TWO independent preconditions, and they are
 * satisfied at two different points of the gateway's boot:
 *
 *   1. **Ownership** — this process won the startup mutex, so it is the sole
 *      live owner of the shared per-agent pin state. Established during module
 *      evaluation (`acquireStartupLock`, plus the non-atomic fallback path).
 *      A LOSING double-boot must never unpin the live holder's pins.
 *   2. **A Telegram handle** — `lockedBot` is assigned, so an unpin can
 *      actually reach Telegram. Established much later, inside
 *      `initGatewayBot()` at boot.
 *
 * Before this gate the sweep was kicked off fire-and-forget the moment (1) was
 * satisfied, i.e. at module-eval time — thousands of lines before (2). Every
 * boot-cleanup unpin therefore threw `undefined is not an object (evaluating
 * 'lockedBot.api')` before touching the network, the row was retained with an
 * incremented attempt counter, and after `BOOT_UNPIN_MAX_ATTEMPTS` the only
 * record of a still-pinned message was forfeited. That was a regression from
 * `caa4d7568` (#3310), which moved the Bot construction — and with it the
 * `lockedBot` assignment — out of module scope into `initGatewayBot()` while
 * leaving the sweep's kick-off where it was.
 *
 * The gate makes the ordering DETERMINISTIC rather than a race: the sweep runs
 * exactly once, when BOTH signals have arrived, in whichever order they arrive.
 * It cannot regress by code motion — moving either signal site around cannot
 * make the sweep fire before the other signal.
 *
 * Deliberately dependency-free and side-effect-free so it is provable in
 * isolation (`telegram-plugin/tests/boot-sweep-gate.test.ts`); the gateway owns
 * the wiring.
 */

export interface BootSweepGate {
  /** Signal (1): this gateway owns the shared per-agent pin state. */
  arm(): void
  /** Signal (2): the Telegram bot handle exists — API calls can be made. */
  botReady(): void
  /** True once the sweep has been dispatched. Test/introspection seam. */
  hasRun(): boolean
}

/**
 * Build a gate that dispatches `run` exactly once, after BOTH `arm()` and
 * `botReady()` have been called. Both signals are idempotent and
 * order-independent. `run` is dispatched fire-and-forget; a rejection is routed
 * to `onError` so it can never surface as an unhandled rejection (the sweep is
 * best-effort and must never take the gateway down).
 */
export function createBootSweepGate(args: {
  run: () => Promise<void>
  onError?: (err: unknown) => void
}): BootSweepGate {
  let armed = false
  let ready = false
  let started = false

  const maybeRun = (): void => {
    if (started || !armed || !ready) return
    started = true
    void (async () => {
      try {
        await args.run()
      } catch (err) {
        args.onError?.(err)
      }
    })()
  }

  return {
    arm(): void {
      armed = true
      maybeRun()
    },
    botReady(): void {
      ready = true
      maybeRun()
    },
    hasRun(): boolean {
      return started
    },
  }
}
