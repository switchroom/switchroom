/**
 * auto-classify-mid-turn.ts — deterministic, model-free classification of a
 * mid-turn inbound into STEER (amend the in-flight turn) vs QUEUE (new task),
 * using TOPIC-vs-active-turn + reply-RECENCY as proxies for intent. No model
 * inference: the gateway must decide at inbound time while the single CLI is
 * busy.
 *
 * Today a no-prefix mid-turn message always QUEUES (the default flipped
 * 2026-04-17 away from the blunt "everything steers" — see
 * reference/jobs/steer-or-queue-mid-flight.md). This module is the basis for a
 * smarter default. It ships first in SHADOW mode (the gateway logs what it WOULD
 * decide but still queues), to gather real-world data — how often mid-turn
 * messages are same-topic continuations vs cross-topic new tasks, and the
 * recency distribution — before any behaviour flips on.
 *
 * Signal strength (be honest):
 *  - TOPIC (supergroup): STRONG + structural. A message in a DIFFERENT forum
 *    topic than the active turn is, by the supergroup-mode invariant, a separate
 *    conversation → queue. This needs no timing guess.
 *  - RECENCY: weaker. Within the same topic it cannot tell "also do X" (steer)
 *    from "new question, same topic" (queue) — only a tight window + the
 *    visible/correctable UX (the JTBD doc) makes auto-steer acceptable, and
 *    that is gated separately. The recency clock is the agent's LAST OUTPUT
 *    (msSinceLastAgentOutput), NOT turn age: a long actively-narrating worker
 *    turn must not read "stale".
 *  - DM: no topic at all → timing-only (the pre-2026-04-17 regime that
 *    over-steered). DM auto-steer is OFF by default (window 0).
 *
 * Pure (no gateway imports) ⇒ unit-testable.
 */

export type MidTurnClass = 'steer' | 'queue'

export type MidTurnReason =
  | 'steer_prefix'
  | 'queue_prefix'
  | 'not_mid_turn'
  | 'cross_topic'
  | 'same_topic_recent'
  | 'same_topic_stale'
  | 'dm_recent'
  | 'dm_disabled'
  | 'topic_disabled'

export interface AutoClassifyInput {
  /** Explicit `/steer`|`/s` prefix present — the user's stated intent, authoritative. */
  isSteerPrefix: boolean
  /** Explicit `/queue`|`/q` prefix present. */
  isQueuePrefix: boolean
  /** Is a turn in flight for this chat/thread? (no → not our decision). */
  priorTurnInFlight: boolean
  /** DM (no forum topics) → timing-only. */
  isDm: boolean
  /** Incoming message's thread id (undefined/null in a DM). */
  incomingThreadId: number | null | undefined
  /** The in-flight turn's thread id (currentTurn.sessionThreadId). */
  activeTurnThreadId: number | null | undefined
  /** ms since the agent's LAST visible output in this chat/thread; null when no
   *  output has been recorded (cold topic) → treated as not-recent. */
  msSinceLastAgentOutput: number | null
  /** Auto-steer recency window in a DM. 0 (default) = DM auto-steer OFF. */
  dmSteerWindowMs: number
  /** Auto-steer recency window in a supergroup topic. 0 = topic auto-steer OFF. */
  topicSteerWindowMs: number
}

export interface AutoClassifyResult {
  decision: MidTurnClass
  reason: MidTurnReason
  /** Whether the incoming message is in the SAME thread as the active turn
   *  (canonicalized). Undefined when not applicable (no prefix-free mid-turn). */
  sameTopic?: boolean
}

/** Canonical thread compare, matching chatKey's collapse (null/undefined/0 → same
 *  "no-thread" bucket) — never raw === on raw ids (the silence-poke key-mismatch
 *  bug class). */
function sameThread(a: number | null | undefined, b: number | null | undefined): boolean {
  const norm = (t: number | null | undefined): number | null => (t == null || t === 0 ? null : t)
  return norm(a) === norm(b)
}

/**
 * Classify a mid-turn inbound. Precedence: explicit prefix → not-mid-turn →
 * DM(timing) / supergroup(topic then timing). Defaults bias to QUEUE (the safe,
 * reversible, current behaviour); STEER only on a strong/recent signal AND its
 * window enabled.
 */
export function autoClassifyMidTurnInbound(i: AutoClassifyInput): AutoClassifyResult {
  // Explicit prefixes always win — the user's stated intent is authoritative.
  if (i.isSteerPrefix) return { decision: 'steer', reason: 'steer_prefix' }
  if (i.isQueuePrefix) return { decision: 'queue', reason: 'queue_prefix' }
  // No turn in flight → caller starts a fresh turn (not a steer/queue decision).
  if (!i.priorTurnInFlight) return { decision: 'queue', reason: 'not_mid_turn' }

  const recent =
    i.msSinceLastAgentOutput != null && i.msSinceLastAgentOutput >= 0

  if (i.isDm) {
    // DM: no topic → timing-only. Default OFF (dmSteerWindowMs 0).
    if (i.dmSteerWindowMs <= 0) return { decision: 'queue', reason: 'dm_disabled' }
    return recent && i.msSinceLastAgentOutput! <= i.dmSteerWindowMs
      ? { decision: 'steer', reason: 'dm_recent' }
      : { decision: 'queue', reason: 'dm_disabled' }
  }

  // Supergroup: topic identity is the PRIMARY signal.
  const topicMatch = sameThread(i.incomingThreadId, i.activeTurnThreadId)
  if (i.topicSteerWindowMs <= 0) {
    return { decision: 'queue', reason: 'topic_disabled', sameTopic: topicMatch }
  }
  // Different topic than the in-flight turn → ALWAYS queue (a separate
  // conversation; never steer it into the wrong topic's turn).
  if (!topicMatch) return { decision: 'queue', reason: 'cross_topic', sameTopic: false }
  // Same topic: steer only if recent enough; else a new question → queue.
  return recent && i.msSinceLastAgentOutput! <= i.topicSteerWindowMs
    ? { decision: 'steer', reason: 'same_topic_recent', sameTopic: true }
    : { decision: 'queue', reason: 'same_topic_stale', sameTopic: true }
}
