/**
 * Gateway trace verbosity gate (#3025).
 *
 * The gateway emits two families of high-frequency stderr trace lines that
 * are pure per-poll noise on a healthy, idle agent:
 *
 *   - `tg-post method=getUpdates ... status=ok` / `method=getMe ... status=ok`
 *     — one line per long-poll tick (~every 30s) from the tg-post
 *     observability transformer in `bot-runtime.ts`.
 *   - `gw-trace shadow event=tick effects=[] global=bridge_alive_idle ...`
 *     — one line per delivery-machine TTL tick (~every 30s) from
 *     `inbound-delivery-machine-shadow.ts`.
 *
 * With no log rotation these ungated lines grew gateway-supervisor.log to
 * 555MB on clerk / 162MB on klanker and filled the host disk. They carry
 * zero signal when nothing happened: a successful empty long-poll and an
 * idle no-op tick.
 *
 * This module centralises the "should I emit a zero-signal trace line?"
 * decision behind a single debug env flag so operators can turn the full
 * firehose back on when actually debugging the delivery/poll path.
 *
 * Flag: set `SWITCHROOM_GW_TRACE=1` (or `true`/`yes`/`on`, any case) to
 * restore every trace line unconditionally. Unset / any other value → zero-signal polling
 * success + idle-tick lines are suppressed, while ALL error lines, all
 * non-poll methods (sendMessage, editMessageText, ...), and every tick or
 * event that produced a real effect or state change are still emitted.
 *
 * Read once at module init — the flag is a boot-time debug switch, not a
 * hot-reloadable knob, so a cached read keeps the per-line cost at a
 * single boolean check.
 */

/**
 * Pure env-flag parse — exported so tests can exercise the parsing
 * directly. Kept separate from the module-init read because the dual
 * vitest/bun runner boundary means module-cache tricks
 * (`vi.resetModules()` + re-import) don't work under bun's vitest shim;
 * flag variants must be testable via explicit arguments.
 */
export function computeGwTraceVerbose(flag: string | undefined): boolean {
  const v = (flag ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** True when the operator opted into the full gateway trace firehose. */
export const gwTraceVerbose: boolean = computeGwTraceVerbose(
  process.env.SWITCHROOM_GW_TRACE,
)

/**
 * Bot API methods whose successful long-poll ticks are zero-signal:
 * `getUpdates` is the long-poll itself and `getMe` is the periodic
 * identity refresh. A `status=ok` on either says only "polling is alive",
 * which the gateway already reports once at startup. Errors on these
 * methods are NOT suppressed (see `shouldEmitTgPost`).
 */
const ZERO_SIGNAL_POLL_METHODS = new Set(['getUpdates', 'getMe'])

/**
 * The status tiers a `tg-post` line can carry.
 *
 * `benign` (#3927) is a REJECTED call that is nonetheless a non-event —
 * the narrow set of 400s the retry policy already swallows ("message is
 * not modified", "message to edit/delete not found"), classified by
 * `classifyBenignTelegram400`. It exists so that promoting resolved
 * `ok:false` responses out of `status=ok` doesn't drown the newly-truthful
 * `status=err` signal in high-volume card-repaint no-ops: `grep status=err`
 * stays a list of real failures, and the benign lines are still there,
 * honestly labelled, for anyone who wants them.
 *
 * `retry` (#3931) is a REJECTED call that the enclosing retry policy is about
 * to attempt AGAIN — a 429 under the in-process sleep ceiling, or a transient
 * transport error with attempts left. It is not an outcome: the logical send
 * may still be delivered by the next attempt, and usually is. It exists
 * because `status=err` is consumed as a delivery FAILURE by fleet-health's
 * `reply-delivery-failure` detector (`src/fleet-health/detect.ts`), which
 * matches per LINE — so labelling a survivable attempt `err` escalated
 * successfully delivered replies. Post-#3931 a `status=err` line means the
 * logical send is over and it did not land.
 */
export type TgPostStatus = 'ok' | 'benign' | 'err' | 'retry'

/**
 * Decide whether a `tg-post` line should be written.
 *
 * Suppressed (unless `SWITCHROOM_GW_TRACE` is set):
 *   - `status=ok` for `getUpdates` / `getMe` — the per-poll heartbeat.
 *
 * Always emitted:
 *   - any `status=err` (real failures — the whole point of the log),
 *   - any `status=retry` (the survivable attempts behind a flood episode —
 *     suppressing them would hide the run-up to a ban, #3931),
 *   - every other method's `ok` line (sendMessage/editMessageText/... are
 *     genuine outbound observability, #656/#657),
 *   - `status=benign` on any non-poll method — same volume as the
 *     `status=ok` line it replaces, just no longer mislabelled as success.
 */
export function shouldEmitTgPost(
  method: string,
  status: TgPostStatus,
  verbose: boolean = gwTraceVerbose,
): boolean {
  if (verbose) return true
  if (status === 'err' || status === 'retry') return true
  return !ZERO_SIGNAL_POLL_METHODS.has(method)
}

/**
 * Decide whether a `gw-trace shadow` line should be written.
 *
 * Suppressed (unless `SWITCHROOM_GW_TRACE` is set):
 *   - `event=tick` that produced NO effects AND left the machine in an
 *     idle global state (`bridge_alive_idle` / `bridge_dead`) — the
 *     no-op TTL heartbeat.
 *
 * Always emitted:
 *   - any non-tick event (real inbound/turn/bridge activity),
 *   - any tick that produced effects (e.g. a TTL turn expiry) or that
 *     landed the machine in `bridge_alive_in_turn`.
 */
export function shouldEmitShadowTrace(
  eventKind: string,
  effectCount: number,
  globalKind: string,
  verbose: boolean = gwTraceVerbose,
): boolean {
  if (verbose) return true
  if (eventKind !== 'tick') return true
  if (effectCount > 0) return true
  const idle = globalKind === 'bridge_alive_idle' || globalKind === 'bridge_dead'
  return !idle
}
