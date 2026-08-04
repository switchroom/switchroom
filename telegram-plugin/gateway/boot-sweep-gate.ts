import type { SweepTarget } from './stale-pin-sweep.js'
import { sweepTargetKey } from './stale-pin-sweep-store.js'

/**
 * boot-sweep-gate.ts — control flow for the boot pin sweep (#3664): WHEN it may
 * start (`createBootSweepGate`, the two-condition arming gate) and HOW its steps
 * are sequenced once it does (`runBootPinSweepSteps`, per-step isolation).
 *
 * Why this exists
 * ---------------
 * The boot orphan sweep (`runBootPinCleanupAndStalePinSweep` → `statusPinBootCleanup`
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

/** Dependencies of {@link runBootPinSweepSteps}. All side effects are injected
 *  so the sequencing contract is provable without a gateway. */
export interface BootPinSweepSteps {
  /** Pure fs scan for the `(chat, thread)` targets with a prior-session pin
   *  record. MUST run BEFORE the reapers, which empty those same stores. */
  scanSweepTargets: () => SweepTarget[]
  statusPinCleanup: () => Promise<unknown>
  activityCardReaper: () => Promise<unknown>
  queuedCardReaper: () => Promise<unknown>
  /** Flips the flag authorising the stale-pin drain — for this sweep AND for
   *  later lazy first-inbound sweeps. */
  enableSweep: () => void
  /**
   * BOOT-SEED PRUNE (#3953 regression fix). Drops discharged (`done: true`)
   * cursor rows from the sweep ledger so a `(chat, thread)` that drained in a
   * PRIOR session is re-evaluated live this boot, instead of short-circuiting
   * forever on a stale `done`. Kind-agnostic — clears DM, forum-topic and
   * supergroup rows alike. Forfeited rows (`attempts >= SWEEP_MAX_ATTEMPTS`)
   * are RETAINED by the underlying `pruneSweepCursors`, so a chat the bot
   * cannot pin does not re-burn its attempt budget every boot.
   *
   * MUST stay BOOT-scoped. The lazy first-inbound sweep fires on EVERY message;
   * pruning there would re-arm a full re-drain per message = a Telegram flood.
   * Runs once here, before the `sweepTarget` loop, so the loop re-evaluates the
   * freshly-reseeded ledger.
   */
  seedPruneSweepCursors: () => void
  sweepTarget: (target: SweepTarget) => Promise<unknown>
  log?: (line: string) => void
}

/**
 * Run one sweep step, absorbing (and logging) a throw. See
 * {@link runBootPinSweepSteps} for why isolation is mandatory here.
 *
 * Absorbs unconditionally: a non-`Error` throw is stringified rather than
 * logged as `undefined`, and a `log` that itself throws (a closed stderr on a
 * dying process) is swallowed too — otherwise the one function whose whole job
 * is "never let a step take the sweep down" could take the sweep down.
 */
async function step(name: string, fn: () => Promise<unknown>, log: (line: string) => void) {
  try {
    await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      log(`telegram gateway: boot pin sweep step '${name}' failed: ${msg}\n`)
    } catch {
      /* stderr is gone — nothing useful left to do */
    }
  }
}

/**
 * Sequence the boot sweep's steps, each individually absorbed.
 *
 * Why isolation is mandatory (#3664 salvage S2). The steps used to run as a
 * bare sequential `await` chain. `runStatusPinBootCleanup` absorbs its own
 * per-row throws, but the two card reapers issue real Bot API calls and can
 * reject outright — and a rejection there did not merely skip the later
 * reapers, it skipped `enableSweep()`. That flag authorises the stale-pin
 * drain for the WHOLE SESSION (the boot sweep AND every later lazy
 * first-inbound sweep), so one throwing reaper silently disabled stale-pin
 * cleanup entirely.
 *
 * That was unreachable before #3664 only because the sweep never actually ran
 * — every step died on `undefined is not an object (evaluating
 * 'lockedBot.api')` before doing anything. Making the sweep work for the first
 * time is precisely what makes an earlier step's throw newly reachable, so the
 * isolation lands with the fix rather than after it.
 *
 * Never rejects: every step is best-effort and the caller fire-and-forgets it.
 */
export async function runBootPinSweepSteps(deps: BootPinSweepSteps): Promise<void> {
  const log = deps.log ?? ((l: string) => process.stderr.write(l))

  let targets: SweepTarget[] = []
  await step('sweep-target-scan', async () => {
    targets = deps.scanSweepTargets()
  }, log)

  await step('status-pin-cleanup', deps.statusPinCleanup, log)
  await step('activity-card-reaper', deps.activityCardReaper, log)
  await step('queued-card-reaper', deps.queuedCardReaper, log)

  // Boot-seed prune (#3953): reseed the cursor ledger so a chat that drained in
  // a prior session is re-evaluated live below, rather than short-circuiting on
  // a stale `done`. Boot-scoped ONLY — never on the per-inbound path. Runs
  // BEFORE enableSweep so eligibility (which also gates the lazy first-inbound
  // sweep) is granted only once the ledger is reseeded — no window where an
  // inbound observes a stale `done`. Isolated: a throw here must not strand the
  // drain, and enableSweep below still runs regardless.
  await step('seed-prune-sweep-cursors', async () => deps.seedPruneSweepCursors(), log)

  // Unconditional: reached even when every step above threw. See the docblock.
  await step('enable-sweep', async () => deps.enableSweep(), log)
  for (const t of targets) {
    await step(`stale-pin-sweep:${sweepTargetKey(t.chatId, t.threadId)}`, () => deps.sweepTarget(t), log)
  }
}
