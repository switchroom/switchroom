/**
 * Deterministic delivery-obligation ledger (systems-analysis PR2).
 *
 * The framework today tracks whether an inbound was DELIVERED (read by claude),
 * never whether it was ANSWERED — so a message claude reads but never replies to
 * (the marko msg-715 verbal-deferral drop) is silently lost. This ledger adds
 * the one missing invariant, and it is model-INDEPENDENT by construction:
 *
 *   An inbound is an OBLIGATION keyed by its origin_turn_id. It is OPEN the
 *   moment the message is received, and CLOSED only by an observable framework
 *   event — a reply-tool call whose resolved target equals that origin_turn_id
 *   AND that carries a substantive answer (not a bare interim ack). The engine
 *   may go idle only when no obligation is OPEN; an OPEN obligation that
 *   survives a turn boundary is re-presented as a fresh must-answer turn until
 *   it closes, bounded so a mis-close degrades to ONE operator-visible nudge
 *   rather than an infinite re-ask loop.
 *
 * This file is PURE state + decisions — no Telegram, no claude, no timers. The
 * gateway owns OPEN/CLOSE/re-present I/O and calls in here. Pure ⇒ unit-testable
 * (see tests/obligation-ledger.test.ts), the seam the analysis demanded.
 *
 * The close event (substantive reply resolving to origin) is observed by the
 * framework, never the model's narration/promise — that is the whole point: the
 * 715 "I'll handle thread 3 as its own turn" does NOT close the obligation.
 */

import type { InboundMessage } from './ipc-protocol.js'

export interface Obligation {
  /** deriveTurnId(chat, thread, messageId) — the stable identity. */
  readonly originTurnId: string
  readonly chatId: string
  readonly threadId?: number
  readonly messageId: number
  /** Original inbound text (may be truncated by the caller for re-presentation). */
  readonly text: string
  /** Wall-clock ms the obligation was first opened. */
  readonly openedAt: number
  /** How many times it has been re-presented (0 on first open). */
  representCount: number
}

/** What the gateway should do for the oldest open obligation at an idle boundary. */
export type LedgerAction = 'none' | 'represent' | 'escalate'

export interface LedgerDecision {
  action: LedgerAction
  obligation?: Obligation
}

export interface ObligationInput {
  originTurnId: string
  chatId: string
  threadId?: number
  messageId: number
  text: string
  openedAt: number
}

export class ObligationLedger {
  private readonly open = new Map<string, Obligation>()

  /**
   * @param maxRepresents max re-presentations before escalating to an
   *   operator-visible nudge instead of re-asking again. Default 2.
   */
  constructor(private readonly maxRepresents = 2) {}

  /**
   * Open an obligation if not already tracked. Idempotent on originTurnId — a
   * message that is buffered AND later enqueued opens once, keeping the first
   * (earliest openedAt + accumulated representCount). Returns true if newly
   * opened.
   */
  openIfAbsent(input: ObligationInput): boolean {
    if (this.open.has(input.originTurnId)) return false
    this.open.set(input.originTurnId, { ...input, representCount: 0 })
    return true
  }

  /** Close by origin id. Returns true if an obligation was open and is now closed. */
  close(originTurnId: string | null | undefined): boolean {
    if (originTurnId == null) return false
    return this.open.delete(originTurnId)
  }

  isOpen(originTurnId: string): boolean {
    return this.open.has(originTurnId)
  }

  hasOpen(): boolean {
    return this.open.size > 0
  }

  size(): number {
    return this.open.size
  }

  /** Snapshot of open obligations, oldest first. For introspection/tests. */
  list(): Obligation[] {
    return [...this.open.values()].sort((a, b) => a.openedAt - b.openedAt)
  }

  /** The oldest open obligation, or undefined. */
  private oldest(): Obligation | undefined {
    let best: Obligation | undefined
    for (const o of this.open.values()) {
      if (best === undefined || o.openedAt < best.openedAt) best = o
    }
    return best
  }

  /**
   * Decide what to do at an idle boundary (caller guarantees: no turn in flight
   * AND the inbound buffer is empty — so the existing buffer-drain has already
   * had its turn and anything still OPEN is "delivered but unanswered"). PURE —
   * does not mutate. The caller performs the side effect then calls
   * markRepresented / close accordingly.
   *
   *  - 'none'      → no open obligation; the agent may idle.
   *  - 'represent' → re-present `obligation` as a fresh must-answer turn.
   *  - 'escalate'  → it has already been re-presented maxRepresents times; send
   *                  ONE operator-visible "did I miss this?" and close it
   *                  (caller calls close) rather than loop forever.
   */
  decideAtIdle(): LedgerDecision {
    const o = this.oldest()
    if (o === undefined) return { action: 'none' }
    if (o.representCount >= this.maxRepresents) return { action: 'escalate', obligation: o }
    return { action: 'represent', obligation: o }
  }

  /** Record that an obligation was just re-presented (bumps representCount). */
  markRepresented(originTurnId: string): number {
    const o = this.open.get(originTurnId)
    if (o === undefined) return 0
    o.representCount += 1
    return o.representCount
  }
}

/** Original message preview length for re-presentation (mirrors resume builder). */
const REPRESENT_PREVIEW_MAX = 200

/**
 * Build the synthetic inbound that RE-PRESENTS an open obligation as a fresh
 * must-answer turn. Carries the obligation's original message_id (so the
 * reply-quote and origin routing land in the right place) and origin_turn_id in
 * meta (so the model's reply resolves back to THIS obligation → the close event
 * matches). `source: obligation_represent` marks it synthetic, so it is NOT
 * delivery-tracked and does NOT open a fresh obligation (the original stays
 * open until a substantive reply closes it). Pure — the gateway injects it via
 * the existing buffer→drain path. Context restoration (inject vs pointer) is a
 * separate layer; here we point at get_recent_messages and quote the original.
 */
export function buildObligationRepresentInbound(o: Obligation, now: number): InboundMessage {
  const preview =
    o.text.length > REPRESENT_PREVIEW_MAX ? o.text.slice(0, REPRESENT_PREVIEW_MAX - 1) + '…' : o.text
  const topicClause = o.threadId != null ? ' in this topic' : ''
  return {
    type: 'inbound',
    chatId: o.chatId,
    ...(o.threadId != null ? { threadId: o.threadId } : {}),
    messageId: o.messageId,
    user: 'switchroom',
    userId: 0,
    ts: now,
    text:
      `You have an earlier message${topicClause} that you started but never actually ` +
      `answered (you may have set it aside mid-work): "${preview}". Answer it now via the ` +
      `reply tool — deliver the real answer, don't just acknowledge it. If you've lost the ` +
      `surrounding context, call get_recent_messages for this chat${topicClause} first. ` +
      `That quoted text may be only the first ~200 characters of the original.`,
    meta: {
      source: 'obligation_represent',
      origin_turn_id: o.originTurnId,
      represent_count: String(o.representCount + 1),
    },
  }
}

/**
 * Build the operator-visible escalation message text, used when an obligation
 * has been re-presented maxRepresents times without closing — rather than loop
 * forever (the new failure mode this trades silent-drop for), surface ONE
 * honest "did I miss this?" and close it.
 */
export function obligationEscalationText(o: Obligation): string {
  const preview =
    o.text.length > REPRESENT_PREVIEW_MAX ? o.text.slice(0, REPRESENT_PREVIEW_MAX - 1) + '…' : o.text
  return (
    `⚠️ I may have missed an earlier message and I'm not sure I answered it: ` +
    `"${preview}". If you still need it, please re-send.`
  )
}
