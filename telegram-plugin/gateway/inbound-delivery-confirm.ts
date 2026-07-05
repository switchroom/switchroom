/**
 * Reliable inbound delivery: deliver-until-acked (the marko drop-wedge).
 *
 * Delivering an inbound to claude is fire-and-forget: the gateway calls
 * `sendToAgent`, the bridge turns it into an MCP channel notification, and
 * the unmodified CLI appends the text into its composer and auto-submits
 * ONLY when the composer is empty + idle. If the message lands while claude
 * is still finalizing the prior turn, the auto-submit races turn-completion
 * and the text strands unsubmitted — claude never starts the turn, so the
 * gateway eventually drops the message at the 300s silence-poke. Observed
 * recurring on `marko` (supergroup topic + DMs alike).
 *
 * This is the queue that makes delivery reliable. The contract is the whole
 * idea, and it is deliberately small:
 *
 *   1. A delivered inbound is ACKED only when claude actually starts the
 *      turn — the `enqueue` session-event (the one signal that claude truly
 *      picked the message up). NOT when `sendToAgent` returns true.
 *   2. Until acked, the message stays tracked. If it hasn't been acked
 *      within `timeoutMs`, it stranded: re-deliver it (the gateway re-clears
 *      the composer and re-sends).
 *   3. Re-deliver as many times as it takes. We never drop the message and
 *      never give up — a reliable queue keeps the message until it lands.
 *
 * Keyed per `chatKey(chatId, threadId)`, so DMs and supergroup forum topics
 * are handled identically (the key is opaque here). The #1556 gate
 * serialises delivery per key, so at most one delivery per key is in flight.
 *
 * Pure bookkeeping only — the gateway does the actual composer-clear and
 * re-send for whatever `sweep` returns. Unit-tested in isolation.
 */

export interface PendingDelivery<M> {
  /** chatKey(chatId, threadId) — opaque to this module. */
  readonly key: string
  /** The exact inbound to re-send until claude acks it. */
  readonly inbound: M
  /**
   * Source message id of the tracked inbound (stringified Telegram
   * `message_id`), or null if unknown. The `enqueue` ack matches on THIS so a
   * synthetic-source turn (cron / resume / vault / reaction) that shares the
   * chatKey can't false-ack — and silently drop — a real user message still
   * waiting to land. See ackDelivery.
   */
  readonly messageId: string | null
  /** When the latest delivery attempt was made (unix-ms). */
  lastAttemptAt: number
}

export interface DeliveryQueue<M> {
  readonly pending: Map<string, PendingDelivery<M>>
}

export function createDeliveryQueue<M>(): DeliveryQueue<M> {
  return { pending: new Map() }
}

/**
 * Track a freshly-delivered inbound, awaiting claude's `enqueue` ack.
 * Overwrites any prior pending for the key — the #1556 gate serialises per
 * key, so a later inbound supersedes an earlier un-acked one for that key.
 * `messageId` (stringified Telegram message_id) lets the ack match only the
 * enqueue that belongs to THIS message; pass null when unknown.
 */
export function trackDelivery<M>(
  q: DeliveryQueue<M>,
  key: string,
  inbound: M,
  now: number,
  messageId: string | null = null,
): void {
  q.pending.set(key, { key, inbound, messageId, lastAttemptAt: now })
}

/**
 * Extract every `message_id="…"` value carried in a rendered enqueue envelope.
 *
 * The `enqueue` session-event's message id (`enqueueMessageId`) is a SINGLE
 * value re-parsed from the transcript by `parseChannelMeta`, which grabs the
 * FIRST `message_id` it finds. When claude's composer MERGES several inbound
 * envelopes into one turn (or reformats the wrapper), that first-parsed id can
 * be a sibling's — not the tracked message's — even though the tracked
 * message's envelope is right there in the same content. Strict equality then
 * mis-concludes "never delivered" and the sweep re-delivers a turn that is
 * already running (#2786). Scanning ALL ids in the raw content makes the ack
 * tolerant of that reorder/merge: the tracked id is present iff its envelope
 * was delivered, regardless of parse order.
 *
 * The regex is LEFT-ANCHORED on an attribute boundary (start-of-string or a
 * whitespace/quote before the name) so it matches ONLY the real `message_id`
 * attribute — never a same-suffix sibling like `target_message_id`,
 * `reply_to_message_id`, `original_message_id`, or `card_message_id`. This is
 * what makes the tolerant-path match safe on a never-drop code path: a
 * substring collision on some other `*_message_id` attribute cannot false-ack
 * (and thus silently drop) a real user message still waiting to land.
 */
export function extractEnqueueMessageIds(content: string): string[] {
  const ids: string[] = []
  const re = /(?:^|[\s"'])message_id="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) != null) ids.push(m[1]!)
  return ids
}

/**
 * Ack a delivery — call from the `enqueue` session-event (claude started a
 * turn). `enqueue` fires for EVERY turn start regardless of source (user
 * inbound, cron, subagent-handback, vault-resume, restart-marker), so acking
 * purely by chatKey would let a synthetic-source turn clear — and thus
 * silently drop — a real user message still waiting under the same key. So
 * ack ONLY when the enqueue's source message id matches the tracked one.
 *
 * Matching rule (composer-tolerant, #2786): if we recorded a messageId for the
 * pending entry, ack when EITHER
 *   - the single re-parsed `enqueueMessageId` equals it (the fast path), OR
 *   - the tracked id appears among the message ids carried in `enqueueContent`
 *     (the tolerant path — survives the composer merging/reordering envelopes
 *     so the first-parsed id belongs to a sibling, not the tracked message).
 * Matching on the exact `message_id="…"` token — not a loose substring —
 * preserves the cross-source false-ack guard: a synthetic-source turn (cron /
 * resume / vault) never carries the real user message's id, so it still can't
 * clear a user message that is genuinely still waiting to land. If we never
 * recorded a messageId (legacy / defensive null), fall back to key-only ack.
 * Returns true if an entry was cleared.
 */
export function ackDelivery<M>(
  q: DeliveryQueue<M>,
  key: string,
  enqueueMessageId: string | null = null,
  enqueueContent: string | null = null,
): boolean {
  const entry = q.pending.get(key)
  if (!entry) return false
  if (entry.messageId != null) {
    const matches =
      entry.messageId === enqueueMessageId ||
      (enqueueContent != null &&
        extractEnqueueMessageIds(enqueueContent).includes(entry.messageId))
    // A different message started this turn — don't ack ours (it may still be
    // waiting to land; the sweep will re-deliver it if it stranded).
    if (!matches) return false
  }
  q.pending.delete(key)
  return true
}

/**
 * Return the inbounds that stranded (no ack within `timeoutMs`) and should be
 * re-delivered now. Resets each returned entry's clock so the next sweep
 * waits another full `timeoutMs` — the gateway re-sends them. Entries still
 * within the window are left untouched (claude may yet be picking them up).
 */
export function sweep<M>(
  q: DeliveryQueue<M>,
  now: number,
  timeoutMs: number,
): PendingDelivery<M>[] {
  const redeliver: PendingDelivery<M>[] = []
  for (const entry of q.pending.values()) {
    if (now - entry.lastAttemptAt < timeoutMs) continue
    entry.lastAttemptAt = now
    redeliver.push(entry)
  }
  return redeliver
}

/**
 * #2787 — the set of chats/topics that currently hold a live permission or
 * `ask_user` card, against which a swept entry is tested before re-delivery.
 *
 *   - `keys`  — full `chatKey(chatId, threadId)` values (topic known). A card
 *               routed to a specific forum topic suspends re-delivery ONLY for
 *               that topic; sibling topics in the same supergroup keep flowing.
 *   - `chats` — bare chatIds (topic unknown — e.g. a permission card fanned to
 *               the operator DMs records only the chatId). The conservative
 *               fallback is to suspend the whole chat; that chat is almost never
 *               a busy multi-topic supergroup, so the global stall is still gone.
 */
export interface SuspendedTargets {
  readonly keys: ReadonlySet<string>
  readonly chats: ReadonlySet<string>
}

/**
 * #2787 Mechanism A — should re-delivery of a stranded inbound on `key` be
 * suspended because a live permission / `ask_user` card is open for ITS OWN
 * chat/topic?
 *
 * A pending card is a live interaction for its target: re-clearing the composer
 * and re-sending there would clobber it. But the OLD gateway guard suspended the
 * ENTIRE confirm sweep whenever ANY card was pending anywhere — so one card
 * parked in a single topic (or the operator DM, a different chatId) froze
 * re-delivery of every stranded inbound across EVERY topic until it resolved
 * (the #1922 all-topics stall). Scoping the check to the card's own target keeps
 * unrelated topics being re-delivered while the card sits open.
 */
export function isRedeliverySuspended(key: string, suspended: SuspendedTargets): boolean {
  if (suspended.keys.has(key)) return true
  const idx = key.indexOf(':')
  const chatId = idx < 0 ? key : key.slice(0, idx)
  return suspended.chats.has(chatId)
}

/** Forget a key without acking (e.g. the bridge went offline and the message
 *  was handed back to the offline buffer, which owns it now). */
export function forgetDelivery<M>(q: DeliveryQueue<M>, key: string): void {
  q.pending.delete(key)
}

/**
 * Should this delivered inbound be tracked for ack/re-delivery?
 *
 * Track a delivery iff it is a fresh user turn that will produce exactly one
 * `enqueue` to ack against. Everything that does NOT enqueue must be excluded,
 * or the sweep re-delivers it forever (re-clearing the composer every cycle):
 *
 *   - `isSteering` / `isInterrupt` — the #1556 gate's carve-outs: delivered
 *     mid-turn to AMEND the running turn, so they never start a fresh turn and
 *     never emit `enqueue`.
 *   - `hasSource` — synthetic inbounds (cron / vault-resume / subagent-handback
 *     / reaction) carry a `meta.source`; they enqueue under their own semantics
 *     and must never be tracked as if they were a queued user turn.
 *   - empty `effectiveText` — an empty body (e.g. `/queue` with no text) is
 *     silently dropped by claude's auto-submit and never enqueues, so tracking
 *     it is a pure re-delivery loop (a self-inflicted DoS on the queue).
 *
 * Mirror the gate's carve-outs here so tracking is exactly the set of messages
 * that produce an `enqueue`.
 */
export function shouldTrackDelivery(input: {
  isSteering: boolean
  isInterrupt: boolean
  hasSource?: boolean
  effectiveText?: string
}): boolean {
  if (input.isSteering || input.isInterrupt) return false
  if (input.hasSource) return false
  // Gate on empty text only when the caller actually provided it (undefined =
  // "not supplied", left untracked-gated so existing callers keep their behaviour).
  if (input.effectiveText !== undefined && input.effectiveText.trim().length === 0) return false
  return true
}

/**
 * The ONE synthetic-source inbound that IS safe to enrol in the
 * deliver-until-acked queue: the boot-resume synthetic
 * (`meta.source === 'resume_interrupted'`). A restart can drop it into a
 * not-ready (slow MCP boot) session exactly like a user inbound, leaving the
 * interrupted work silently un-resumed — so it needs the same re-delivery
 * backstop. It is safe to track ONLY when it carries BOTH:
 *   - `meta.chat_id` — so the gateway's enqueue handler (gated on `ev.chatId`)
 *     builds a currentTurn AND fires `ackDelivery` for it; and
 *   - `meta.message_id` — so the enqueue's id round-trips and `ackDelivery`
 *     matches THIS synthetic, stopping the sweep (no re-deliver-forever storm).
 * Every other synthetic (cron / vault / handback / the watchdog `report`) omits
 * `meta.message_id` and stays excluded by `shouldTrackDelivery`'s `hasSource`
 * gate. We require message_id here (chat_id is implied by the ack mechanics);
 * without a round-trippable id, tracking would storm.
 */
export function isTrackableResumeSynthetic(
  meta: Record<string, string> | undefined,
): boolean {
  return (
    meta?.source === 'resume_interrupted' &&
    meta.message_id != null &&
    meta.message_id !== ''
  )
}
