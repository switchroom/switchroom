/**
 * answer-route-overrides.ts — a bounded, in-memory record of the reply router's
 * EXPLICIT-THREAD OVERRIDES, so a later consumer can ask "was an answer the model
 * addressed to topic N actually delivered somewhere else?".
 *
 * WHY THIS EXISTS. `resolveAnswerThreadWithLog` already computes this fact and
 * logs it (`EXPLICIT_OVERRIDDEN(model→4,routed→635)`): the model named a topic
 * on its `reply`, and the framework's topic authority overrode that with the
 * origin/live turn's topic. The answer therefore lands under a DIFFERENT
 * `thread_id` than the one the model was answering — invisible to any
 * thread-keyed history query for the topic the model meant.
 *
 * The obligation-escalation staleness check is exactly such a query, and the
 * override is the ONLY per-turn evidence that ties an answer delivered in topic
 * B to a question asked in topic A. Recording it turns "an answer landed
 * somewhere in this chat" (an unfalsifiable chat-wide guess) into "an answer the
 * model addressed to THIS topic landed in that topic" — a specific, checkable
 * claim. See `escalation-staleness.ts` for the consumer and the field evidence.
 *
 * Bounded by construction: at most `maxKeys` (chat, intended-thread) keys and
 * `maxPerKey` recent routings each, evicted oldest-first. Losing an entry can
 * only ever cost one over-escalation (the safe direction — an extra advisory,
 * never a swallowed message).
 */

/** One observed override: the model meant `intendedThreadId`, it went here. */
export interface AnswerRouteOverride {
  /** Where the answer actually went. `null` = chat root / no topic (history
   *  stores `thread_id IS NULL` for these — `recordOutbound` does `?? null`). */
  routedThreadId: number | null
  /** Wall-clock ms at which the routing decision was made. */
  atMs: number
}

export interface NoteOverrideArgs {
  chatId: string
  /** `REPLY_TOPIC_AUTHORITY_ENABLED` — no authority, no override. */
  enabled: boolean
  /** The topic the model named on its reply, if any. */
  explicitThreadId: number | undefined
  /** Whether a framework anchor (origin or live turn) was present to override with. */
  anchored: boolean
  /** The thread the router actually resolved. `undefined` = chat root. */
  routedThreadId: number | undefined
  nowMs: number
}

export interface AnswerRouteOverrides {
  /**
   * Record the routing decision iff it WAS an explicit-thread override, and
   * return whether it was — so the caller can use the same boolean for its
   * telemetry instead of computing the predicate twice.
   */
  note(args: NoteOverrideArgs): boolean
  /**
   * Threads that an answer addressed to `intendedThreadId` was actually routed
   * to, at or after `sinceMs`. Empty when no override was observed — which is
   * the common case and means "no reason to look outside this topic".
   */
  routedThreadsSince(
    chatId: string,
    intendedThreadId: number | null | undefined,
    sinceMs: number,
  ): (number | null)[]
  /** Live key count. Test/diagnostic surface. */
  size(): number
}

function keyFor(chatId: string, threadId: number | null | undefined): string {
  return `${chatId}:${threadId ?? '_'}`
}

export function createAnswerRouteOverrides(maxKeys = 64, maxPerKey = 8): AnswerRouteOverrides {
  // Insertion-ordered Map; eviction is oldest-INSERTED-first (FIFO), not
  // least-recently-used — entries are not re-inserted on read.
  const byKey = new Map<string, AnswerRouteOverride[]>()
  return {
    note(args: NoteOverrideArgs): boolean {
      const overridden =
        args.enabled &&
        args.explicitThreadId != null &&
        args.anchored &&
        args.routedThreadId !== args.explicitThreadId
      if (!overridden) return false
      const key = keyFor(args.chatId, args.explicitThreadId)
      const list = byKey.get(key) ?? []
      list.push({ routedThreadId: args.routedThreadId ?? null, atMs: args.nowMs })
      while (list.length > maxPerKey) list.shift()
      byKey.set(key, list)
      while (byKey.size > maxKeys) {
        const oldest = byKey.keys().next().value
        if (oldest === undefined) break
        byKey.delete(oldest)
      }
      return true
    },
    routedThreadsSince(chatId, intendedThreadId, sinceMs): (number | null)[] {
      const list = byKey.get(keyFor(chatId, intendedThreadId))
      if (list == null) return []
      const out: (number | null)[] = []
      for (const e of list) {
        if (e.atMs < sinceMs) continue
        if (!out.includes(e.routedThreadId)) out.push(e.routedThreadId)
      }
      return out
    },
    size(): number {
      return byKey.size
    },
  }
}

/**
 * Process-wide registry. The gateway is a single process and the router is the
 * only writer; obligation-wiring is the only reader. Injected as a value into
 * the pure decision functions so tests never touch this instance.
 */
export const answerRouteOverrides = createAnswerRouteOverrides()
