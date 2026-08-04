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

/**
 * #3282 — the durable per-chunk snapshot of a PARTIALLY delivered backstop
 * answer, attached to the obligation so the represent can resume the exact
 * captured answer's non-`landed-confirmed` tail (byte-identical) instead of
 * regenerating it (which re-posts chunks that already landed). Rides the
 * obligation ledger's atomic snapshot, so it survives a gateway/container
 * restart. See captured-answer-resume.ts for the resume mechanism.
 */
export interface CapturedDeliverySnapshot {
  /** The byte-identical captured answer, split into chunks (the SAME split the
   *  original backstop delivery used). Re-delivered verbatim on resume. */
  readonly chunks: string[]
  /** Per-LANDED-chunk state: the landed message id(s) + whether a read-back
   *  confirmed the message exists. A chunk absent here never landed → the resume
   *  treats it as `unsent` and re-sends it. */
  readonly chunkStates: Array<{
    readonly index: number
    readonly messageIds: number[]
    readonly confirmed: boolean
  }>
}

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
  /** How many times the operator-escalation send has been ATTEMPTED (0 until
   *  the represent ladder is exhausted). Bounds escalation so a permanently-
   *  undeliverable nudge (dead/renumbered topic → Telegram 400, blocked bot)
   *  can't loop forever — and, because it is part of the durable snapshot,
   *  can't become a boot-surviving poison record either. */
  escalateAttempts?: number
  /** Wall-clock ms the most recent turn handling THIS obligation ended (stamped
   *  at turn_end via noteTurnEnded). Drives the escalate-grace window: a slow /
   *  background-worker / multi-segment turn ends (the in-flight gate clears)
   *  before its trailing answer's reply lands, and the sweep would otherwise
   *  re-present/escalate in that gap — a false "I may have missed this" on a
   *  message that's actively being answered (fuzz-confirmed on v0.14.62). The
   *  decision waits `graceMs` after this stamp before acting, so the trailing
   *  answer's close has a beat to fire. Bounded: each re-present is itself a turn
   *  that re-stamps this once, and representCount is capped, so the ladder still
   *  terminates. Durable (part of the snapshot) so the grace survives restart. */
  lastTurnEndedAt?: number
  /** Wall-clock ms this obligation was most recently re-presented. Drives the
   *  per-represent grace: a freshly re-presented obligation is skipped until
   *  at least `representGraceMs` has elapsed, preventing immediate second
   *  re-present/escalate when the sweep fires < 5s later. Durable (part of the
   *  snapshot) so the grace window survives a restart. */
  lastRepresentedAt?: number
  /** #3282 — durable captured-answer snapshot for a PARTIALLY delivered backstop
   *  answer. Present ⇒ the represent branch drives a byte-identical captured-answer
   *  RESUME of the non-confirmed tail (never a regeneration); absent ⇒ the genuine
   *  "model wrote nothing" represent falls through to fresh generation. Dropped
   *  with the obligation on close/escalate (bounded lifetime, design A6). */
  capturedDelivery?: CapturedDeliverySnapshot
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

/** Side-effect hooks the gateway injects. Kept out of the pure decision logic
 *  so the ledger stays unit-testable (a capturing `onChange` in tests). */
export interface ObligationLedgerHooks {
  /** Called after EVERY state mutation (open/close/represent/escalate-attempt)
   *  with the full open snapshot, so the gateway can durably persist it. NOT
   *  called by hydrate() — that IS the restoration of persisted state. */
  onChange?: (snapshot: Obligation[]) => void
}

export class ObligationLedger {
  private readonly open = new Map<string, Obligation>()

  /**
   * @param maxRepresents max re-presentations before escalating to an
   *   operator-visible nudge instead of re-asking again. Default 2.
   * @param hooks optional side-effect hooks (durable persistence). Omitted in
   *   pure unit tests; the gateway wires `onChange` to the snapshot store.
   */
  constructor(
    private readonly maxRepresents = 2,
    private readonly hooks: ObligationLedgerHooks = {},
  ) {}

  /** Persist the current open set via the injected hook (no-op if unwired). */
  private persist(): void {
    this.hooks.onChange?.(this.list())
  }

  /**
   * Open an obligation if not already tracked. Idempotent on originTurnId — a
   * message that is buffered AND later enqueued opens once, keeping the first
   * (earliest openedAt + accumulated representCount). Returns true if newly
   * opened.
   */
  openIfAbsent(input: ObligationInput): boolean {
    if (this.open.has(input.originTurnId)) return false
    this.open.set(input.originTurnId, { ...input, representCount: 0 })
    this.persist()
    return true
  }

  /** Close by origin id. Returns true if an obligation was open and is now closed. */
  close(originTurnId: string | null | undefined): boolean {
    if (originTurnId == null) return false
    const closed = this.open.delete(originTurnId)
    if (closed) this.persist()
    return closed
  }

  /**
   * Re-populate from a persisted snapshot at boot — the restart-durability seam.
   * Open obligations (with their representCount + escalateAttempts intact)
   * survive a gateway/container restart, so the next idle sweep re-presents or
   * re-escalates them rather than silently losing a delivered-but-unanswered
   * message. Replaces current contents; does NOT fire onChange (this state is
   * already what's on disk). Tolerates a malformed snapshot (skips bad rows).
   */
  hydrate(snapshot: readonly Obligation[]): void {
    this.open.clear()
    for (const o of snapshot) {
      if (o != null && typeof o.originTurnId === 'string' && o.originTurnId.length > 0) {
        this.open.set(o.originTurnId, { ...o })
      }
    }
  }

  isOpen(originTurnId: string): boolean {
    return this.open.has(originTurnId)
  }

  /** The open obligation for `originTurnId`, or undefined if none is open. Read-
   *  only accessor for the delivery-time represent re-check (represent-delivery-
   *  guard.ts): a represent buffered while the obligation was open must be re-
   *  evaluated against the obligation's CURRENT cutoff at the moment it is handed
   *  to the CLI bridge, since a reply may have landed between decision and drain. */
  get(originTurnId: string): Obligation | undefined {
    return this.open.get(originTurnId)
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
   *  - 'none'      → no open obligation (or all open ones are within their
   *                  escalate-grace window); the agent may idle.
   *  - 'represent' → re-present `obligation` as a fresh must-answer turn.
   *  - 'escalate'  → it has already been re-presented maxRepresents times; send
   *                  ONE operator-visible "did I miss this?" and close it
   *                  (caller calls close) rather than loop forever.
   *
   * GRACE WINDOW (opts.graceMs > 0): an obligation whose handling turn ended less
   * than `graceMs` ago is SKIPPED — its trailing answer may still be in flight
   * (a worker / long-think / multi-segment turn ends the in-flight gate before
   * the reply lands). We pick the oldest obligation that is OUT of grace, so a
   * genuinely-stale one is still acted on while a freshly-ended one waits. Pure
   * (clock injected via opts.now, mirroring the builder convention). With no opts
   * (or graceMs<=0) this is the pre-grace behaviour exactly.
   *
   * BACKGROUND-WORK GRACE (opts.backgroundWorkActive): the 45s `graceMs` above is
   * far too short for extended-autonomous sub-agent work — an agent that
   * ack-firsts ("on it") then delegates to a background worker or an orphaned
   * foreground sub-agent ends its FOREGROUND turn in seconds, but the real answer
   * lands minutes later. The in-flight machine (turn already ended) does not see
   * that work, so the sweep would re-present/escalate a false "did I miss this?
   * re-send" while the agent is genuinely researching (the gymbro liven case,
   * 2026-06-10). When the gateway reports `backgroundWorkActive` (a running worker
   * or a freshly-touched turn-active marker), an obligation younger than
   * `backgroundGraceMs` (measured from openedAt) is SKIPPED. Bounded BY
   * CONSTRUCTION: `backgroundGraceMs` is a hard wall-clock ceiling, so even a
   * pathologically-stuck/leaked worker cannot suppress the escalation forever —
   * once openedAt+backgroundGraceMs passes, the obligation is acted on regardless
   * of work state, and the FSM still terminates.
   *
   * PER-REPRESENT GRACE (opts.representGraceMs > 0): an obligation that was just
   * re-presented is ineligible until at least `representGraceMs` ms have elapsed
   * since `lastRepresentedAt`. Without this, the 5s sweep can fire again before
   * the re-presented turn even reaches the agent, burning the represent budget
   * immediately and producing back-to-back escalations on the same message.
   * #3550: this window is retired early once a turn that started after the
   * re-present has ENDED — at that point the trailing-answer grace above is the
   * one covering the real risk, and holding the rest of the represent window is
   * pure latency. See `representGraceStillProtecting`.
   */
  decideAtIdle(opts?: {
    now: number
    graceMs: number
    backgroundWorkActive?: boolean
    backgroundGraceMs?: number
    representGraceMs?: number
  }): LedgerDecision {
    const useEligible =
      opts != null &&
      (opts.graceMs > 0 || opts.backgroundWorkActive === true || (opts.representGraceMs ?? 0) > 0)
    const o = useEligible
      ? this.oldestEligible(
          opts!.now,
          opts!.graceMs,
          opts!.backgroundWorkActive === true,
          opts!.backgroundGraceMs ?? 0,
          opts!.representGraceMs ?? 0,
        )
      : this.oldest()
    if (o === undefined) return { action: 'none' }
    if (o.representCount >= this.maxRepresents) return { action: 'escalate', obligation: o }
    return { action: 'represent', obligation: o }
  }

  /**
   * #3550 — is the per-represent grace still doing real work for this
   * obligation? Pure so the rule is testable in isolation.
   *
   * The per-represent grace exists for ONE reason, stated at its definition:
   * "the 5s sweep can fire again before the re-presented turn even reaches the
   * agent". It is a proxy for "the re-present has not landed yet". Once a turn
   * that started AFTER the re-present has ENDED, the proxy is spent — the
   * re-present demonstrably reached the agent, the agent ran a whole turn on
   * it, and that turn is over. Holding the remaining ~110s of a 120s window
   * open at that point delays the next rung of a ladder that is already
   * bounded by `maxRepresents`, for no protective benefit.
   *
   * The obligation is NOT released into the void when this returns false: the
   * trailing-answer grace (`trailingGraceMs` from `lastTurnEndedAt`, 45s by
   * default) is a separate, independently-evaluated window that covers exactly
   * the risk that matters here — a slow answer still landing after its turn
   * ended. So the early-out only applies when that grace is actually armed
   * (`trailingGraceMs > 0`); with it disabled, the represent grace stays the
   * full window rather than leaving the obligation ungated.
   *
   * A re-present with NO ended turn after it — the genuinely in-flight case
   * the grace was written for — is untouched and keeps the full window.
   *
   * FLOOR (`MIN_REPRESENT_INTERVAL_MS`). Retiring the represent window makes the
   * rung interval DERIVED — `trailingGraceMs + the represent-turn's duration`
   * — where it used to be floored by the flat 120s window regardless of how the
   * trailing grace was tuned. Without a floor,
   * `SWITCHROOM_OBLIGATION_ESCALATE_GRACE_MS=1000` (a plausible "make it
   * snappier" tune) collapses the whole ladder to ~1s+d per rung and escalates
   * to the operator within ~15-20s of the original message. That is a config
   * footgun the old code could not have, so it is closed by a MECHANISM, not a
   * doc warning: the early-out is withheld until at least
   * `min(representGraceMs, max(trailingGraceMs, MIN_REPRESENT_INTERVAL_MS))`
   * has elapsed since the re-present. At the defaults (45s trailing / 120s
   * represent) the floor is 45s and never binds — the trailing grace, measured
   * from the strictly-later turn end, always expires after it — so this changes
   * nothing in the shipped configuration.
   */
  static representGraceStillProtecting(
    o: Pick<Obligation, 'lastRepresentedAt' | 'lastTurnEndedAt'>,
    now: number,
    representGraceMs: number,
    trailingGraceMs: number,
  ): boolean {
    if (representGraceMs <= 0) return false
    if (o.lastRepresentedAt == null) return false
    const sinceRepresent = now - o.lastRepresentedAt
    if (sinceRepresent >= representGraceMs) return false
    // Inside the window. Is it still protecting anything?
    const representTurnEnded =
      o.lastTurnEndedAt != null && o.lastTurnEndedAt > o.lastRepresentedAt
    if (representTurnEnded && trailingGraceMs > 0) {
      // Spent — the trailing grace takes over, but never sooner than the floor
      // (and never longer than the represent window the operator configured).
      const floorMs = Math.min(
        representGraceMs,
        Math.max(trailingGraceMs, ObligationLedger.MIN_REPRESENT_INTERVAL_MS),
      )
      return sinceRepresent < floorMs
    }
    return true
  }

  /**
   * The hard floor on the interval between two rungs of the represent ladder,
   * used by `representGraceStillProtecting`. Independent of how the trailing
   * grace is tuned, an obligation is never acted on again within this long of
   * its own re-present. 30s comfortably exceeds the 5s sweep tick and the
   * round-trip for a re-presented turn to reach the agent and answer, which is
   * the only thing the represent window was ever debouncing.
   */
  static readonly MIN_REPRESENT_INTERVAL_MS = 30_000

  /** The oldest open obligation that is currently ELIGIBLE to act on — i.e. NOT
   *  within any grace window:
   *   - trailing-answer grace: its handling turn ended < `graceMs` ago (a queued
   *     obligation with no lastTurnEndedAt can't have a trailing answer, so it is
   *     always eligible on this axis);
   *   - background-work grace: when `backgroundWorkActive`, it was opened <
   *     `backgroundGraceMs` ago (genuine in-flight autonomous work — bounded by
   *     the ceiling so a stale/leaked worker can't suppress escalation forever);
   *   - per-represent grace: it was re-presented < `representGraceMs` ago AND that
   *     re-present has not yet produced a completed turn (prevents a 5s sweep tick
   *     from immediately firing again before the re-presented turn even reaches the
   *     agent — see `representGraceStillProtecting` for why a turn that has already
   *     ended retires this window early, #3550). */
  private oldestEligible(
    now: number,
    graceMs: number,
    backgroundWorkActive: boolean,
    backgroundGraceMs: number,
    representGraceMs: number,
  ): Obligation | undefined {
    let best: Obligation | undefined
    for (const o of this.open.values()) {
      if (o.lastTurnEndedAt != null && now - o.lastTurnEndedAt < graceMs) continue // trailing-answer grace
      if (backgroundWorkActive && backgroundGraceMs > 0 && now - o.openedAt < backgroundGraceMs)
        continue // in-flight autonomous work, bounded by the ceiling
      if (ObligationLedger.representGraceStillProtecting(o, now, representGraceMs, graceMs))
        continue // per-represent grace: sweep fired before re-presented turn landed
      if (best === undefined || o.openedAt < best.openedAt) best = o
    }
    return best
  }

  /** Stamp that the most recent turn handling `originTurnId` just ended (drives
   *  the escalate-grace window). No-op if the obligation isn't open. Persists. */
  noteTurnEnded(originTurnId: string, ts: number): void {
    const o = this.open.get(originTurnId)
    if (o === undefined) return
    o.lastTurnEndedAt = ts
    this.persist()
  }

  /**
   * Decide which obligation a substantive reply discharges — DETERMINISTICALLY,
   * holding for any model behavior:
   *
   *  1. `echoedTurnId` (model echoed origin_turn_id back) → authoritative; close
   *     exactly that (a no-op via close() if it isn't actually open).
   *  2. `routedOriginId` (gateway-resolved origin from quote/via=quoted or
   *     via=live routing) → treat as the definitive target when present; this
   *     makes answers to re-presented messages close their obligation even when
   *     no model echo was provided and even with >1 open obligation (the routed
   *     origin IS the answer's origin — this is deterministic, not a guess).
   *     The 713/715 invariant still holds: the gateway only passes a routedOriginId
   *     that it has positively resolved as the reply's origin (quote resolution,
   *     via=quoted); it never passes the LIVE turn id here when a different
   *     obligation is the resolved origin.
   *  3. else, close the live turn's own obligation when that turn itself is open —
   *     this is unambiguous (the reply happened IN that turn, so the turn's own
   *     obligation IS the right target). The 713/715 wrong-close protection is
   *     preserved by ordering: routed/echoed origin (steps 1/2) wins first;
   *     live-turn fallback (step 3) only fires when no routed origin resolved, AND
   *     only for the live turn's OWN obligation (not another open obligation). A
   *     reply answering message A landing while currentTurn=B must STILL not close B
   *     — only steps 1/2 can close A in that case. With multiple open obligations
   *     and no routed origin, the LIVE turn's own obligation is the safe default
   *     (relaxed from size==1 which wrongly blocked it when a second message arrived
   *     meanwhile). Returns the id to close, or null.
   */
  resolveCloseTarget(
    echoedTurnId: string | null | undefined,
    liveTurnId: string | null | undefined,
    routedOriginId?: string | null,
  ): string | null {
    if (echoedTurnId != null) return echoedTurnId
    if (routedOriginId != null) return routedOriginId
    if (liveTurnId != null && this.open.has(liveTurnId)) return liveTurnId
    return null
  }

  /**
   * #3282 — attach (or refresh) the durable captured-answer snapshot for a
   * PARTIALLY delivered backstop answer. No-op if the obligation isn't open (a
   * fully delivered turn closes its obligation, so there is nothing to resume).
   * Persists, so the snapshot survives a restart and the represent resumes the
   * missing tail instead of regenerating the whole answer.
   */
  noteCapturedDelivery(originTurnId: string, snapshot: CapturedDeliverySnapshot): void {
    const o = this.open.get(originTurnId)
    if (o === undefined || snapshot.chunks.length === 0) return
    o.capturedDelivery = snapshot
    this.persist()
  }

  /** Record that an obligation was just re-presented (bumps representCount, stamps
   *  lastRepresentedAt for the per-represent grace window). */
  markRepresented(originTurnId: string, now = Date.now()): number {
    const o = this.open.get(originTurnId)
    if (o === undefined) return 0
    o.representCount += 1
    o.lastRepresentedAt = now
    this.persist()
    return o.representCount
  }

  /**
   * Record an operator-escalation SEND attempt (bumps escalateAttempts).
   * Returns the new count. The gateway calls this immediately before each
   * escalation send and uses the count to bound retries: a transient send
   * failure leaves the obligation OPEN and is retried next sweep, but after
   * the bound the gateway closes best-effort so a permanently-undeliverable
   * nudge can neither loop forever nor (now that the count is durable) re-enter
   * the loop on every boot.
   */
  markEscalateAttempt(originTurnId: string): number {
    const o = this.open.get(originTurnId)
    if (o === undefined) return 0
    o.escalateAttempts = (o.escalateAttempts ?? 0) + 1
    this.persist()
    return o.escalateAttempts
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
      chat_id: o.chatId,
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
