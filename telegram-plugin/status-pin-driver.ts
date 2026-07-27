/**
 * Status-pin driver — executes ONE already-decided `PinLegAction` against a
 * Telegram Bot API.
 *
 * The pure decision lives in `status-pin.ts` (`decidePinAction`) and is taken
 * exactly ONCE per leg, by the orchestrator (`gateway/status-pin-retarget.ts`).
 * This module is the side-effecting half only: it is HANDED a leg action,
 * executes it, and returns the next claim. The state itself stays in the caller
 * (the gateway holds a `Map<pinKey, StatusPinClaim>` and re-passes the entry on
 * every call).
 *
 * #3831 — why this takes an ACTION and not a `desired` state. It used to take
 * `(prevState, desired)` and re-run `decidePinAction` itself, which meant one
 * reconcile decided the same transition up to THREE times (orchestrator leg
 * split → persist-op mapping → driver) and, worse, gave the driver a `repin`
 * branch to implement. That branch expanded the retarget a SECOND time, with no
 * per-leg persistence, and was unreachable from the gateway — a dead fork that
 * a future caller wiring `reconcilePin` directly would have silently inherited.
 * The parameter type is now `PinLegAction`, which cannot express `repin`, so
 * the expansion exists in one place and cannot re-fork.
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
 *   - On UNPIN we DROP THE CLAIM (clear state) when the unpin succeeded OR
 *     failed TERMINALLY (`isUnpinTerminalError`: Telegram answered with a
 *     stable 4xx — rights revoked, message/chat gone). Pin state must never
 *     get stuck: the message may have been unpinned out-of-band (operator,
 *     or a crash), and re-claiming it would be more confusing than surfacing
 *     it again later.
 *   - #3664 Defect B: a NEVER-CONFIRMED failure (`FLOOD_WAIT_ACTIVE` — a
 *     local pre-call fail-fast — network, 5xx, retries exhausted) is the one
 *     case we do NOT drop: the message is provably still pinned, so the claim
 *     is RETAINED for retry. Dropping it erased both the in-memory claim and
 *     the durable store row, orphaning a live pin nothing could ever find
 *     again. Retention is bounded by the boot sweep's forfeit ladder.
 *   - API failures are reported via `onError` but never throw; the caller
 *     decides logging cadence.
 *
 * See `reference/invariants.md` § `chat-is-the-single-source-of-truth`
 * (the sanctioned silent-pin exception) and the `know-what-my-agent-is-doing`
 * job spec.
 */

import type { PinState, PinLegAction, PinRightsCache } from './status-pin.js'
import { isPinRightsError, isUnpinTerminalError } from './status-pin.js'

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

export interface ExecutePinLegArgs {
  api: PinBotApi
  chatId: string
  /** State the caller is holding from the last reconcile. `null` on first. */
  prevState: PinState | null
  /** The single transition to execute, decided by the orchestrator. */
  action: PinLegAction
  /** Optional API-failure observer. Default: silent. */
  onError?: (phase: 'pin' | 'unpin', err: unknown) => void
  /** Optional per-process rights-aware negative cache (issue #3024). When a
   *  pin attempt fails with the permanent "not enough rights" 400, the chat is
   *  recorded and all subsequent pin attempts in it are skipped (no API call,
   *  no log). Omit to disable the cache entirely (the pre-#3024 behaviour). */
  rightsCache?: PinRightsCache
  /** Called EXACTLY ONCE per chat, the first time that chat is recorded as
   *  pin-incapable. Lets the caller emit a single warn line instead of the
   *  per-attempt `status-pin pin failed` spam. Only fires when `rightsCache`
   *  is supplied. */
  onPinRightsDisabled?: (chatId: string) => void
}

/**
 * Execute ONE decided pin transition for a key. Returns the new `PinState`
 * (or `null` when unpinned / nothing pinned). Always resolves; never throws —
 * API errors route through `onError`.
 *
 *   - `pin`  : pins the existing message SILENTLY; on failure the claim is
 *              NOT taken (returns prevState) so the next reconcile retries
 *              rather than tracking a message it never pinned.
 *   - `unpin`: unpins best-effort and returns `null` — the claim is dropped on
 *              success and on a TERMINAL failure (never leave state stuck
 *              pinned). A never-confirmed failure returns prevState so the
 *              still-pinned message keeps a record to retry from (#3664).
 *   - `noop` : returns prevState unchanged.
 *
 * A RETARGET is NOT executable here by construction — `PinLegAction` has no
 * `repin` member. `runStatusPinReconcile` splits it into an unpin leg and a pin
 * leg, each persisted, and owns the abort rule (#3831).
 */
export async function executePinLeg(
  args: ExecutePinLegArgs,
): Promise<PinState | null> {
  const { action } = args

  if (action.kind === 'noop') return args.prevState

  if (action.kind === 'unpin') {
    // Skip the unpin API call in a chat the bot can't manage pins in — the
    // call would fail with the same rights 400 and spam the log. The claim is
    // dropped (a pin we can never unpin is not worth tracking), so skipping
    // is safe.
    if (args.rightsCache?.isBlocked(args.chatId)) return null
    try {
      await args.api.unpinChatMessage(args.chatId, action.messageId)
    } catch (err) {
      // Symmetric with the pin path below: a permanent rights 400 on UNPIN
      // (rights revoked mid-session after we pinned) also enters the
      // negative cache and logs once via onPinRightsDisabled — otherwise
      // every later unpin attempt would burn an API call and spam
      // `status-pin unpin failed` per attempt, the exact class this cache
      // exists to kill (#3073 review finding). That class is terminal, so the
      // claim is dropped below.
      if (args.rightsCache && isPinRightsError(err)) {
        const firstTime = args.rightsCache.block(args.chatId)
        if (firstTime) args.onPinRightsDisabled?.(args.chatId)
      } else {
        args.onError?.('unpin', err)
      }
      // #3664 Defect B: drop the claim ONLY on a TERMINAL failure — one where
      // Telegram answered and the answer can't change (4xx ≠ 429: rights
      // revoked, message/chat gone, bot kicked). On a NEVER-CONFIRMED failure
      // (`FLOOD_WAIT_ACTIVE`, which is a local pre-call fail-fast; network;
      // 5xx; retries exhausted) the message is still pinned, so we RETAIN the
      // claim: returning prevState makes the caller keep both the in-memory
      // claim and the durable status-pins.json row (see the non-null branch of
      // reconcileAndPersistStatusPin), so the next reconcile, the mid-session
      // reaper and the next-boot sweep can all retry. Dropping the last record
      // of a pin that is provably still up is strictly worse than a claim that
      // retries — and retention is bounded by the boot sweep's
      // BOOT_UNPIN_MAX_ATTEMPTS forfeit ladder.
      if (!isUnpinTerminalError(err)) return args.prevState
    }
    // Unpin confirmed (or terminally rejected) — drop the claim. A stuck claim
    // would leave a permanent pin on a crash / out-of-band unpin — the exact
    // failure this driver exists to prevent (see slot-banner-driver.ts).
    return null
  }

  // action.kind === 'pin' — pin an EXISTING message, silently.
  // Rights-aware negative cache (issue #3024): if a prior attempt in this chat
  // already failed with the permanent "not enough rights" 400, skip silently —
  // no API call, no log. Don't claim the message (the pin never happened), so a
  // later reconcile after a restart (cache cleared) can retry.
  if (args.rightsCache?.isBlocked(args.chatId)) {
    return args.prevState
  }
  try {
    await args.api.pinChatMessage(args.chatId, action.messageId, {
      disable_notification: true,
    })
  } catch (err) {
    // A permanent pin-rights failure enters the negative cache and logs ONCE
    // (via onPinRightsDisabled) — every subsequent attempt in this chat is then
    // skipped above. Transient failures (429 / 5xx / network) are NOT cached
    // and route through onError as before, preserving retry behaviour.
    if (args.rightsCache && isPinRightsError(err)) {
      const firstTime = args.rightsCache.block(args.chatId)
      if (firstTime) args.onPinRightsDisabled?.(args.chatId)
    } else {
      args.onError?.('pin', err)
    }
    // Don't claim a message we failed to pin — the next reconcile retries.
    return args.prevState
  }
  // Pin succeeded — if this chat was previously cached as pin-incapable, rights
  // were granted since; forget it so we resume normal behaviour immediately.
  args.rightsCache?.clear(args.chatId)
  return { messageId: action.messageId }
}
