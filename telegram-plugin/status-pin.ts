/**
 * Status-pin — pure decision logic.
 *
 * Keeps an already-rendered status message pinned while its work is
 * in-flight, and unpins it the moment the work completes. This is the
 * ONE sanctioned pin under the `chat-is-the-single-source-of-truth`
 * invariant (see `reference/invariants.md` §
 * `chat-is-the-single-source-of-truth` and the
 * `know-what-my-agent-is-doing` job spec): it re-surfaces a message the
 * conversation ALREADY owns — the per-turn activity/status message and
 * the `🛠 Worker` background-worker message — and never renders a new
 * parallel surface.
 *
 * Why a pin at all: fast answers, more background workers, and much
 * longer turns mean the conversation moves on quickly in the feed and
 * the user loses sight of in-flight work — work now routinely outlives
 * the visible window. Pinning the message the feed already holds keeps
 * it in view; it carries no new content.
 *
 * This module is dependency-free so it's provable in isolation; the
 * gateway (via `status-pin-driver.ts`) translates a `PinAction` into
 * actual Telegram API calls. The design mirrors `slot-banner.ts` +
 * `slot-banner-driver.ts` — one pure decision, one side-effecting
 * reconcile, the claim dropped on unpin unless the unpin never reached
 * Telegram at all (`isUnpinTerminalError`, #3664).
 */

/** The message the framework is currently claiming as pinned for a key. */
export type PinState = {
  /** Telegram message_id we pinned. */
  messageId: number
}

/** What the caller wants pinned for a key right now. */
export type DesiredPin =
  /** Work is in-flight; this already-rendered message should be pinned. */
  | { pinned: true; messageId: number }
  /** Work is done (or never opened a message); nothing should be pinned. */
  | { pinned: false }

/**
 * A SINGLE, directly-executable pin transition — the only shape the driver
 * (`status-pin-driver.ts`) can execute.
 *
 * The type is deliberately narrower than `PinAction`: it structurally EXCLUDES
 * `repin`. That exclusion is the mechanism (#3831) that keeps the retarget
 * expansion — "a repin is an unpin leg then a pin leg, and a never-confirmed
 * unpin aborts the pin leg" — defined in exactly ONE place
 * (`gateway/status-pin-retarget.ts`). It used to be written twice, once in the
 * driver with no per-leg persistence and once in the orchestrator with it; the
 * driver copy was unreachable in production and silently carried the weaker
 * semantics. A driver that cannot NAME a repin cannot re-grow a second copy of
 * it — the compiler enforces what a comment could not.
 */
export type PinLegAction =
  | { kind: 'noop'; reason: string }
  /** Pin an EXISTING message. Caller pins, then records the message_id
   *  back into PinState. No new message is sent — this pins a message the
   *  chat already rendered. */
  | { kind: 'pin'; messageId: number }
  /** Unpin + forget. Caller unpins (best-effort) and clears state on success
   *  or a TERMINAL failure; a never-confirmed failure keeps the claim so the
   *  still-pinned message can be retried (`isUnpinTerminalError`, #3664). */
  | { kind: 'unpin'; messageId: number }

export type PinAction =
  | PinLegAction
  /**
   * RETARGET — the caller still wants something pinned for this key, but a
   * DIFFERENT message than the one we claim (the surface was re-posted: an
   * ack-first activity-card reopen, a worker-feed group-message rotation).
   *
   * This is ONE action, not two reconciles. It used to be reported as a plain
   * `unpin`, on the assumption that "a subsequent desired-pin re-pins the new
   * one on the next reconcile". That assumption holds only for callers that
   * RE-DRIVE the reconcile (the worker feed's `syncPin`, called on every
   * steady-state edit). The foreground activity card does not: it reconciles
   * exactly once, when a card OPENs (`narrative-lane.ts` — the `else` branch
   * only EDITs and never touches the pin). So a mid-turn card reopen (the
   * ack-first path in `feed-reopen-gate.ts`, which nulls `activityMessageId`
   * so a fresh card opens) unpinned the old card and left the NEW one
   * unpinned for the rest of the turn — the pin vanished exactly when the
   * turn still needed it.
   *
   * Executors MUST complete both legs: unpin `unpinMessageId`, then pin
   * `pinMessageId`. `reconcilePin` owns the failure semantics (a
   * never-confirmed unpin retains the OLD claim and skips the pin, so the last
   * record of a provably-still-pinned message is never lost).
   */
  | { kind: 'repin'; unpinMessageId: number; pinMessageId: number }

/**
 * Decide the single pin action for a key given the previously-claimed
 * state and what the caller now wants.
 *
 * Exactly one action per (prev, desired) — the whole point is that pin
 * state can never get stuck: an in-flight → done transition always yields
 * an `unpin`, and the driver drops the claim once the unpin is confirmed
 * or terminally rejected (see `isUnpinTerminalError`).
 */
export function decidePinAction(
  prev: PinState | null,
  desired: DesiredPin,
): PinAction {
  if (!desired.pinned) {
    if (prev) return { kind: 'unpin', messageId: prev.messageId }
    return { kind: 'noop', reason: 'nothing pinned, nothing wanted' }
  }
  // desired.pinned === true
  if (prev == null) return { kind: 'pin', messageId: desired.messageId }
  if (prev.messageId === desired.messageId) {
    return { kind: 'noop', reason: 'already pinned this message' }
  }
  // The message we want pinned changed (the surface was re-posted). Report a
  // RETARGET, not a bare unpin: the executor must drop the stale claim AND pin
  // the new message in the same reconcile. Relying on "the next reconcile" to
  // pin left every single-shot caller (the foreground activity card) with
  // nothing pinned — see the `repin` docblock above.
  return {
    kind: 'repin',
    unpinMessageId: prev.messageId,
    pinMessageId: desired.messageId,
  }
}

/** Extract a lowercased human description from any thrown value, preferring
 *  grammy's structured `.description` (the wire text Telegram returned) and
 *  falling back to `.message` / String(). Kept dependency-free — matches on
 *  the wire text, never on a grammy class import. */
function errorDescription(err: unknown): string {
  if (err != null && typeof err === 'object') {
    const o = err as { description?: unknown; message?: unknown }
    if (typeof o.description === 'string' && o.description.length > 0) {
      return o.description.toLowerCase()
    }
    if (typeof o.message === 'string' && o.message.length > 0) {
      return o.message.toLowerCase()
    }
  }
  return String(err).toLowerCase()
}

/**
 * True when a pin/unpin failure is the PERMANENT "the bot lacks pin rights in
 * this chat" class — Telegram returns this as a 400 (not a 403):
 * "not enough rights to manage pinned messages in the chat". This is the one
 * error class that will NOT self-heal on retry: the bot is simply not an admin
 * (or lacks the "Pin messages" right) in that supergroup, and every subsequent
 * pin attempt in the same chat fails identically until an admin grants the
 * right (which only takes effect after a gateway restart re-reads chat perms).
 *
 * Transient classes (429 flood-wait, 5xx, network HttpError) are deliberately
 * EXCLUDED — they must keep the existing retry behaviour, never enter the
 * negative cache. Only this permanent-rights class is cacheable.
 *
 * The single source of truth for the pin-rights concept: the gateway's
 * `unhandled-rejection-policy.ts` and the various edit-error classifiers each
 * fold `not enough rights` into a broader boolean for their own purpose; this
 * is the one helper dedicated to the pin negative-cache decision.
 */
export function isPinRightsError(err: unknown): boolean {
  return errorDescription(err).includes('not enough rights')
}

/**
 * True when an UNPIN failure is TERMINAL — Telegram received the request and
 * answered definitively, so the answer will not change on retry and the claim
 * is safe to drop (#3664 Defect B).
 *
 * The distinction that matters: a 4xx (other than 429) means the call REACHED
 * Telegram and was rejected for a reason that is stable — the bot lacks pin
 * rights, the message/chat is gone, the bot was kicked. Re-issuing the same
 * unpin forever cannot help, and holding the claim would leave the driver
 * stuck (the failure mode the drop-on-unpin contract exists to prevent).
 *
 * Everything else is NOT confirmed and MUST retain the claim:
 *
 *   - `FLOOD_WAIT_ACTIVE` (retry-api-call.ts) — a purely LOCAL fail-fast: the
 *     send gate refused to make the call, so no request ever left the process
 *     and the message is provably still pinned. It carries Telegram's 429
 *     duck-type shape, which is why 429 is excluded here.
 *   - `retryApiCall: max retries exceeded`, network HttpError, 5xx — the
 *     unpin may never have landed.
 *
 * Dropping the claim on those erased the in-memory claim AND (via
 * `reconcileAndPersistStatusPin`, which deletes the durable row on a null
 * return) the persisted record — leaving a message pinned in Telegram that no
 * reaper and no boot sweep could ever see again. Retaining is bounded: the
 * boot sweep retries a retained row and forfeits it after
 * `BOOT_UNPIN_MAX_ATTEMPTS`, so a retained claim can't be permanent either.
 */
export function isUnpinTerminalError(err: unknown): boolean {
  if (isPinRightsError(err)) return true
  if (err != null && typeof err === 'object') {
    const code = (err as { error_code?: unknown }).error_code
    if (typeof code === 'number') return code >= 400 && code < 500 && code !== 429
  }
  return false
}

/**
 * Per-process, per-chat negative cache for chats the bot cannot pin in.
 *
 * When an auto status-pin attempt fails with the permanent pin-rights 400
 * (`isPinRightsError`), the chat is recorded here as pin-incapable so the
 * driver skips every subsequent auto-pin attempt in that chat — no wasted API
 * call, no repeated `status-pin pin failed` log line (issue #3024: marko logged
 * 41 identical pin-rights rejections in 48h, one per attempt).
 *
 * Deliberately IN-MEMORY / per-boot only: pin rights may be granted later, and
 * Telegram surfaces the new permission to the bot only on a fresh chat-member
 * fetch — a gateway restart. Clearing the cache on restart is therefore the
 * correct re-enable trigger.
 *
 * Scope: the AUTO status-pin path only (`pin_status_while_working`).
 */
export class PinRightsCache {
  private readonly blocked = new Set<string>()

  /** True when auto-pin should be skipped for this chat (already known bad). */
  isBlocked(chatId: string): boolean {
    return this.blocked.has(chatId)
  }

  /** Record a chat as pin-incapable. Returns `true` only the FIRST time a chat
   *  is added, so the caller can log the warn line exactly once per chat. */
  block(chatId: string): boolean {
    if (this.blocked.has(chatId)) return false
    this.blocked.add(chatId)
    return true
  }

  /** Forget a chat (rights re-granted, e.g. an explicit pin later succeeded).
   *  Returns `true` if an entry was actually removed. */
  clear(chatId: string): boolean {
    return this.blocked.delete(chatId)
  }
}
