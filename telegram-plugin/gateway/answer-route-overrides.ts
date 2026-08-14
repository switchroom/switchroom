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
   * Overrides recorded for `intendedThreadId` at or after `notBeforeMs`, one per
   * distinct routed thread (the EARLIEST in-window record for that thread wins,
   * so a consumer using `atMs` as a cutoff gets the widest correct one). Empty
   * when no override was observed — which is the common case and means "no
   * reason to look outside this topic".
   *
   * The caller MUST use each entry's `atMs` as the lower bound of whatever it
   * looks up next, and MUST pass a `notBeforeMs` that bounds how old an override
   * may be. An override only licenses a query for the answer THAT routing
   * produced; it is not a standing licence to accept anything ever delivered in
   * that thread. See `escalation-staleness.ts` for the incident that proves it.
   */
  routedOverridesSince(
    chatId: string,
    intendedThreadId: number | null | undefined,
    notBeforeMs: number,
  ): AnswerRouteOverride[]
  /**
   * The MOST RECENT override recorded for `intendedThreadId` at or after
   * `notBeforeMs`, or `undefined` if there is none.
   *
   * Diagnostic-only, and deliberately separate from `routedOverridesSince`:
   * that one returns the EARLIEST in-window record per routed thread because a
   * consumer uses `atMs` as a history cutoff and wants the widest correct one.
   * A consumer asking "did a record exist that my freshness bound rejected, and
   * by how much?" wants the other end — the near-miss. Kept as its own method so
   * answering that can never perturb the accept path's cutoff.
   */
  newestOverrideSince(
    chatId: string,
    intendedThreadId: number | null | undefined,
    notBeforeMs: number,
  ): AnswerRouteOverride | undefined
  /** Live key count. Test/diagnostic surface. */
  size(): number
  /**
   * Drop every recorded override. Test surface: the process-wide registry below
   * is a module singleton, so without a reset one test's records leak into the
   * next and a scenario silently depends on its neighbours' timestamps. Not
   * called in production — the bounded eviction owns lifetime there.
   */
  clear(): void
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
    routedOverridesSince(chatId, intendedThreadId, notBeforeMs): AnswerRouteOverride[] {
      const list = byKey.get(keyFor(chatId, intendedThreadId))
      if (list == null) return []
      const out: AnswerRouteOverride[] = []
      for (const e of list) {
        if (e.atMs < notBeforeMs) continue
        if (out.some((seen) => seen.routedThreadId === e.routedThreadId)) continue
        out.push({ ...e })
      }
      return out
    },
    newestOverrideSince(chatId, intendedThreadId, notBeforeMs): AnswerRouteOverride | undefined {
      const list = byKey.get(keyFor(chatId, intendedThreadId))
      if (list == null) return undefined
      let newest: AnswerRouteOverride | undefined
      for (const e of list) {
        if (e.atMs < notBeforeMs) continue
        if (newest == null || e.atMs > newest.atMs) newest = e
      }
      return newest == null ? undefined : { ...newest }
    },
    size(): number {
      return byKey.size
    },
    clear(): void {
      byKey.clear()
    },
  }
}

/**
 * Process-wide registry. The gateway is a single process and the router is the
 * only writer; obligation-wiring is the only reader. Injected as a value into
 * the pure decision functions so tests never touch this instance.
 */
export const answerRouteOverrides = createAnswerRouteOverrides()
