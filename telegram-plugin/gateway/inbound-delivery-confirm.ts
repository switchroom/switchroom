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
 */
export function trackDelivery<M>(
  q: DeliveryQueue<M>,
  key: string,
  inbound: M,
  now: number,
): void {
  q.pending.set(key, { key, inbound, lastAttemptAt: now })
}

/**
 * Ack a delivery — call from the `enqueue` session-event (claude started the
 * turn, so the message landed). Returns true if a pending entry was cleared.
 */
export function ackDelivery<M>(q: DeliveryQueue<M>, key: string): boolean {
  return q.pending.delete(key)
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

/** Forget a key without acking (e.g. the bridge went offline and the message
 *  was handed back to the offline buffer, which owns it now). */
export function forgetDelivery<M>(q: DeliveryQueue<M>, key: string): void {
  q.pending.delete(key)
}

/**
 * Should this delivered inbound be tracked for ack/re-delivery?
 *
 * ONLY fresh-turn messages — the ones the #1556 buffer-gate holds until claude
 * is idle, then delivers — produce a fresh `enqueue` session-event, which is
 * the ack that clears tracking. Steering (`/steer`) and `!` interrupt inbounds
 * are the gate's *carve-outs*: they're delivered mid-turn to AMEND the running
 * turn, so they do NOT start a fresh turn and never emit `enqueue`. Tracking
 * them would leave an entry that is never acked → the sweep re-delivers it
 * indefinitely (duplicate turns). So mirror the gate's carve-outs here: track a
 * delivery iff it is neither steering nor interrupt — i.e. exactly the messages
 * that produce an `enqueue` to ack against.
 */
export function shouldTrackDelivery(input: {
  isSteering: boolean
  isInterrupt: boolean
}): boolean {
  return !input.isSteering && !input.isInterrupt
}
