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

import type { PinState, DesiredPin, PinRightsCache } from './status-pin.js'
import { decidePinAction, isPinRightsError, isUnpinTerminalError } from './status-pin.js'

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
 * Execute the next pin-state transition for one key. Returns the new
 * `PinState` (or `null` when unpinned / nothing pinned). Always resolves;
 * never throws — API errors route through `onError`.
 *
 *   - `pin`  : pins the existing message SILENTLY; on failure the claim is
 *              NOT taken (returns prevState) so the next reconcile retries
 *              rather than tracking a message it never pinned.
 *   - `unpin`: unpins best-effort and returns `null` — the claim is dropped on
 *              success and on a TERMINAL failure (never leave state stuck
 *              pinned). A never-confirmed failure returns prevState so the
 *              still-pinned message keeps a record to retry from (#3664).
 *   - `repin`: the wanted message CHANGED — unpins the stale claim then pins
 *              the new message, both in this one call, returning the new
 *              claim. A never-confirmed unpin aborts the pin leg and retains
 *              the old claim (the old message is still up and must keep a
 *              record). Single-shot callers depend on this: they never
 *              reconcile the key a second time.
 *   - `noop` : returns prevState unchanged.
 */
export async function reconcilePin(
  args: ReconcilePinArgs,
): Promise<PinState | null> {
  const action = decidePinAction(args.prevState, args.desired)

  if (action.kind === 'noop') return args.prevState

  if (action.kind === 'repin') {
    // RETARGET: unpin the stale claim, then pin the new message — BOTH legs in
    // this one call. Callers that reconcile a key exactly once (the foreground
    // activity card) have no "next reconcile" to finish the job, so splitting
    // it left nothing pinned. See the `repin` docblock in status-pin.ts.
    const afterUnpin = await reconcilePin({
      ...args,
      desired: { pinned: false },
    })
    // A non-null result here means the unpin was NEVER CONFIRMED (#3664
    // Defect B): the old message is provably still pinned and the claim was
    // deliberately retained. Pinning the new one now would leave two pins with
    // a record of only one. Keep the retained claim and let the next reconcile
    // / the mid-session reaper / the boot sweep retry.
    if (afterUnpin != null) return afterUnpin
    return reconcilePin({
      ...args,
      prevState: null,
      desired: { pinned: true, messageId: action.pinMessageId },
    })
  }

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
