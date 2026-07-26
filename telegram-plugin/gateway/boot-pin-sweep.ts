/**
 * Boot pin sweep — ordering contract for the orphan-pin cleanup that runs
 * once this gateway wins the startup mutex.
 *
 * WHY THIS MODULE EXISTS (#3634). The sweep used to be an inline
 * `void runBootPinCleanupAndDmSweep()` fired from the startup-mutex block in
 * gateway.ts. That block runs at MODULE-EVALUATION time, ~13k lines and one
 * `await initGatewayBot()` before `lockedBot` is assigned — so every unpin the
 * sweep issued went through `statusPinApi()`, dereferenced an unset
 * `lockedBot`, and threw:
 *
 *     status-pin-store: boot cleanup unpin failed
 *       (chat=… msg=… attempt=1): undefined is not an object
 *       (evaluating 'lockedBot.api')
 *
 * `let lockedBot!: Bot<Context>` carries a definite-assignment assertion, so
 * tsc never saw it. The sweep therefore NEVER unpinned anything on any agent:
 * boot cleanup retained each row with `attempts+1`, and after
 * BOOT_UNPIN_MAX_ATTEMPTS boots the row was forfeited — leaving a finished
 * activity card pinned in the chat forever. That is the whole "the progress
 * card stays pinned after the turn completes" defect.
 *
 * THE CONTRACT this module enforces, deterministically and in one testable
 * place: **no sweep step may issue a Bot API call before the bot is ready.**
 * The caller passes a `botReady` promise (resolved right after `lockedBot` is
 * assigned in `initGatewayBot()`); `runBootPinSweep` awaits it before the
 * first API-issuing step. Ordering after that is unchanged from the inline
 * version: status pins → activity cards → queued cards → enable + run the DM
 * stale-pin sweep.
 *
 * The store scan is deliberately BEFORE the gate: it is pure fs, needs no bot,
 * and doing it early means a bot that never becomes ready still leaves the
 * stores untouched rather than half-swept.
 *
 * Every step is best-effort: a throwing step is logged and the sweep
 * continues, because a permanently-stuck step must not strand the later ones
 * (the pre-existing failure mode where a dead status-pin cleanup also killed
 * the DM sweep behind it).
 */

export interface BootPinSweepDeps {
  /** Resolves once `lockedBot` is assigned and the Bot API is usable.
   *  MUST be awaited before any unpin is issued — see the module docblock. */
  botReady: Promise<void>
  /** Pure fs scan of the persisted stores for DM chat ids. Never issues API
   *  calls, so it runs before the ready gate. */
  scanDmChatIds: () => string[]
  statusPinCleanup: () => Promise<unknown>
  activityCardReaper: () => Promise<unknown>
  queuedCardReaper: () => Promise<unknown>
  /** Flips the "this gateway owns the shared pin state" flag that authorises
   *  the DM unpin-all path (both this sweep and later lazy first-inbound
   *  sweeps). */
  enableDmSweep: () => void
  sweepDm: (chatId: string) => Promise<unknown>
  log?: (line: string) => void
}

async function step(
  name: string,
  fn: () => Promise<unknown>,
  log: (line: string) => void,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`telegram gateway: boot pin sweep step '${name}' failed: ${msg}\n`)
  }
}

/**
 * Run the boot orphan-pin sweep. Resolves when every step has settled; never
 * rejects (each step is individually absorbed). Callers fire-and-forget it —
 * cleanup is best-effort and must not block boot.
 */
export async function runBootPinSweep(deps: BootPinSweepDeps): Promise<void> {
  const log = deps.log ?? ((l: string) => process.stderr.write(l))

  let dmChatIds: string[] = []
  try {
    dmChatIds = deps.scanDmChatIds()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`telegram gateway: dm-pin-sweep: store scan failed: ${msg}\n`)
  }

  // THE GATE. Everything below issues Bot API calls; none of it may run
  // against an unset `lockedBot`. See the module docblock (#3634).
  await deps.botReady

  await step('status-pin-cleanup', deps.statusPinCleanup, log)
  await step('activity-card-reaper', deps.activityCardReaper, log)
  await step('queued-card-reaper', deps.queuedCardReaper, log)

  // This gateway now owns the shared per-agent pin state — enable the DM
  // unpin-all path.
  deps.enableDmSweep()
  for (const id of dmChatIds) {
    await step(`dm-sweep:${id}`, () => deps.sweepDm(id), log)
  }
}

/**
 * A one-shot readiness latch. `ready` resolves the first time `markReady()` is
 * called and stays resolved; `isReady()` reports the current state (used by
 * the defensive guard in `statusPinApi()` so a future caller that skips the
 * gate fails with a NAMED error instead of a bare TypeError).
 */
export interface BotReadyGate {
  ready: Promise<void>
  markReady: () => void
  isReady: () => boolean
}

export function createBotReadyGate(): BotReadyGate {
  let resolved = false
  let resolve!: () => void
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  return {
    ready,
    markReady: () => {
      if (resolved) return
      resolved = true
      resolve()
    },
    isReady: () => resolved,
  }
}
