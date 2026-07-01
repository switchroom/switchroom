/**
 * Status-pin driver — executes a PinAction against a Telegram Bot API.
 *
 * The pure decision lives in `status-pin.ts` (decidePinAction). This
 * module is the side-effecting half: takes the previously-claimed state
 * and the desired state, computes ONE action, executes it, and returns
 * the next state. The state itself stays in the caller (the gateway holds
 * a `Map<pinKey, PinState>` and re-passes the entry on every call).
 *
 * Copied from `slot-banner-driver.ts`. The load-bearing contract (see
 * slot-banner-driver.ts:100-110):
 *
 *   - Pins are SILENT (`disable_notification: true`) — a status pin must
 *     never buzz the device.
 *   - We pin an EXISTING message (the already-rendered per-turn status /
 *     `🛠 Worker` message). We NEVER send a new message to pin. This is
 *     the boundary that keeps us inside the one sanctioned exception on
 *     `chat-is-the-single-source-of-truth`.
 *   - On UNPIN we DROP THE CLAIM (clear state) EVEN IF `unpinChatMessage`
 *     throws. This is the whole point: pin state must never get stuck.
 *     The message may have been unpinned out-of-band (operator, or a
 *     crash) — re-claiming it would be more confusing than surfacing it
 *     again later, and a stuck claim would leave a permanent pin.
 *   - API failures are reported via `onError` but never throw; the caller
 *     decides logging cadence.
 *
 * See `reference/invariants.md` § `chat-is-the-single-source-of-truth`
 * (the sanctioned silent-pin exception) and the `know-what-my-agent-is-doing`
 * job spec.
 */

import type { PinState, DesiredPin } from './status-pin.js'
import { decidePinAction } from './status-pin.js'

/** Minimal subset of grammy's `bot.api` the pin driver depends on.
 *  Lets tests swap in a fake without dragging in the full Bot type. */
export interface PinBotApi {
  pinChatMessage(
    chat_id: string | number,
    message_id: number,
    opts?: Record<string, unknown>,
  ): Promise<unknown>
  unpinChatMessage(
    chat_id: string | number,
    message_id: number,
  ): Promise<unknown>
}

export interface ReconcilePinArgs {
  api: PinBotApi
  chatId: string
  /** State the caller is holding from the last reconcile. `null` on first. */
  prevState: PinState | null
  /** What the caller wants pinned for this key right now. */
  desired: DesiredPin
  /** Optional API-failure observer. Default: silent. */
  onError?: (phase: 'pin' | 'unpin', err: unknown) => void
}

/**
 * Execute the next pin-state transition for one key. Returns the new
 * `PinState` (or `null` when unpinned / nothing pinned). Always resolves;
 * never throws — API errors route through `onError`.
 *
 *   - `pin`  : pins the existing message SILENTLY; on failure the claim is
 *              NOT taken (returns prevState) so the next reconcile retries
 *              rather than tracking a message it never pinned.
 *   - `unpin`: unpins best-effort and returns `null` — the claim is dropped
 *              EVEN IF the unpin throws (never leave state stuck pinned).
 *   - `noop` : returns prevState unchanged.
 */
export async function reconcilePin(
  args: ReconcilePinArgs,
): Promise<PinState | null> {
  const action = decidePinAction(args.prevState, args.desired)

  if (action.kind === 'noop') return args.prevState

  if (action.kind === 'unpin') {
    try {
      await args.api.unpinChatMessage(args.chatId, action.messageId)
    } catch (err) {
      args.onError?.('unpin', err)
    }
    // Drop the claim regardless of the unpin outcome. A stuck claim would
    // leave a permanent pin on a crash / out-of-band unpin — the exact
    // failure this driver exists to prevent (see slot-banner-driver.ts).
    return null
  }

  // action.kind === 'pin' — pin an EXISTING message, silently.
  try {
    await args.api.pinChatMessage(args.chatId, action.messageId, {
      disable_notification: true,
    })
  } catch (err) {
    args.onError?.('pin', err)
    // Don't claim a message we failed to pin — the next reconcile retries.
    return args.prevState
  }
  return { messageId: action.messageId }
}
