/**
 * The override RECORD is a side effect, and only the real gateway body performs
 * it. This file is the mechanism that proves it still does.
 *
 * WHY A SEPARATE FILE FROM THE DRIFT GUARD. `escalation-staleness.test.ts`
 * ("the recorded override and the EXPLICIT_OVERRIDDEN marker cannot drift
 * apart") re-spells `resolveAnswerThreadWithLog`'s body in the test and calls
 * `createAnswerRouteOverrides().note(...)` on its own instance. That proves the
 * two PREDICATES agree; it cannot prove the gateway CALLS either one. Delete
 * `answerRouteOverrides.note({...})` from `gateway.ts` and every one of those 64
 * cases stays green, the whole vitest suite stays green, and `tsc --noEmit`
 * exits 0 — while the escalation sweep silently loses the only evidence that
 * ties "topic A's answer landed in B" to "an answer was delivered at all", and
 * resumes nagging on top of answers the user already received.
 *
 * That is not hypothetical: the call site has conflicted twice already. On main,
 * #4680 extracted the surrounding block into the pure `formatReplyRouteLog` and
 * dropped the `note()` call in the process. The next person to resolve that
 * conflict in main's favour reverts this PR's entire premise with a green tree.
 * Round 3 caught it by hand — this file replaces that prompt discipline with a
 * deterministic red.
 *
 * HOW. It calls the REAL `resolveAnswerThreadWithLog` from `gateway.ts` (exported
 * as a test seam; no production caller) and asserts on the PROCESS-WIDE
 * `answerRouteOverrides` singleton that obligation escalation reads. Nothing here
 * re-derives the override predicate: the only thing asserted is that driving the
 * real router mutated the real registry.
 *
 * Note for future readers: gateway.ts IS importable from a test runner. Several
 * older comments in this directory claim otherwise ("the gateway IIFE is too
 * entangled to instantiate in-process"); that was true before the P0e import
 * cleanup and is stale now — the boot work is `isGatewayMain`-gated, so a plain
 * `import` is inert.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveAnswerThreadWithLog } from '../gateway/gateway.js'
import { answerRouteOverrides } from '../gateway/answer-route-overrides.js'
import type { CurrentTurn } from '../gateway/gateway.js'

const CHAT = '-100999'
/** The topic the model addressed its reply to (marko, 2026-08-10 06:36). */
const MODEL_TOPIC = 4
/** The topic the framework's authority actually routed it into. */
const ROUTED_TOPIC = 635

const turn = (chatId: string, threadId: number | undefined): CurrentTurn =>
  ({
    turnId: 't1',
    sessionChatId: chatId,
    sessionThreadId: threadId,
    replyCalled: false,
  }) as unknown as CurrentTurn

describe('the gateway router RECORDS the override it performs (side-effect pin)', () => {
  beforeEach(() => {
    // Module singleton — without this a neighbouring file's records leak in and
    // a deleted `note()` could still look satisfied.
    answerRouteOverrides.clear()
    // The router writes its `reply-route` line to stderr; keep the run quiet.
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  })

  it('a model-steered reply overridden by a same-chat anchor lands in the registry ' +
    'obligation escalation reads', () => {
    expect(answerRouteOverrides.routedOverridesSince(CHAT, MODEL_TOPIC, 0)).toEqual([])

    const routed = resolveAnswerThreadWithLog(
      CHAT,
      MODEL_TOPIC,
      turn(CHAT, ROUTED_TOPIC),
      'echo',
      null,
      'reply',
    )

    // Precondition: this really is the override shape, not an agreeing route.
    expect(routed).toBe(ROUTED_TOPIC)
    expect(routed).not.toBe(MODEL_TOPIC)

    // THE PIN. Empty here means `answerRouteOverrides.note(...)` no longer runs
    // in `resolveAnswerThreadWithLog` — the escalation sweep has lost its only
    // per-turn evidence and will nag on top of delivered answers.
    const recorded = answerRouteOverrides.routedOverridesSince(CHAT, MODEL_TOPIC, 0)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.routedThreadId).toBe(ROUTED_TOPIC)
    expect(recorded[0]!.atMs).toBeGreaterThan(0)
  })

  it('records under the topic the MODEL named, not the one it routed to — the ' +
    'consumer keys its lookup by the intended topic', () => {
    resolveAnswerThreadWithLog(CHAT, MODEL_TOPIC, turn(CHAT, ROUTED_TOPIC), 'echo', null, 'reply')
    expect(answerRouteOverrides.routedOverridesSince(CHAT, ROUTED_TOPIC, 0)).toEqual([])
    expect(answerRouteOverrides.routedOverridesSince(CHAT, MODEL_TOPIC, 0)).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: a route that overrode nothing records nothing (so the ' +
    'pin above cannot be satisfied by an unconditional write)', () => {
    // Anchor agrees with the model's topic — no override, nothing to record.
    const routed = resolveAnswerThreadWithLog(
      CHAT,
      MODEL_TOPIC,
      turn(CHAT, MODEL_TOPIC),
      'echo',
      null,
      'reply',
    )
    expect(routed).toBe(MODEL_TOPIC)
    expect(answerRouteOverrides.routedOverridesSince(CHAT, MODEL_TOPIC, 0)).toEqual([])
    expect(answerRouteOverrides.size()).toBe(0)
  })
})
