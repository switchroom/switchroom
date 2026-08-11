/**
 * Two-state desync wedge — the silence-fallback must drain `parkedTurnStarts`.
 *
 * The gateway carries TWO independent "turn in flight" states. The park gate in
 * `stream-render.ts` (`case 'enqueue'`) treats the session as busy if EITHER a
 * live `currentTurn` exists OR `parkedTurnStarts` is non-empty. The 300 s
 * framework-fallback (`liveness-wiring.ts` onFrameworkFallback) that recovers a
 * hung turn nulls `currentTurn` and redelivers `pendingInboundBuffer` — but
 * before the fix it NEVER touched `parkedTurnStarts`. That store's only real
 * drains are the CLI's own `dequeue` / `remove` stream events, so when the
 * claude REPL hangs mid-turn those never arrive, a leftover parked envelope
 * latches the busy gate permanently, and every later inbound parks unseen until
 * a manual container restart (gymbro parked msgs 4502→4504 behind a dead lock
 * until SIGTERM). #3927 introduced the parked store but never wired it into
 * fallback recovery.
 *
 * This drives the REAL `handleSessionEvent` (the extracted-module golden
 * harness, same standard as `turn-mint-defers-until-dequeue.test.ts`) and the
 * REAL `onFrameworkFallback` (via `buildSilencePokeOptions`, same standard as
 * `silence-poke-teardown-notice.test.ts`), sharing ONE world: the fallback's
 * `drainParkedTurnStarts` dep routes to the real store + `beginTurn` over the
 * harness deps. It asserts the OUTCOME, not a code path: after the fallback the
 * parked store is emptied AND the parked message was handed back into turn
 * processing (its turn begun, its card opened) rather than silently dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  handleSessionEvent,
  drainParkedTurnStartsForChat,
  __resetParkedTurnStartsForTest,
  __parkedTurnStartCountForTest,
} from '../gateway/stream-render.js'
import { buildSilencePokeOptions } from '../gateway/liveness-wiring.js'
import { makeLivenessFixture, makeTurn, statusKeyForTests } from './helpers/liveness-wiring-fixture.js'
import { CHAT, enqueue, makeHarness } from './turn-mint-harness.js'

// Module-scope store + one-process `bun test` sweep: resetting on ENTRY alone
// leaves a mid-park case's entry behind for every later FILE, which makes the
// obligation sweep read the session as busy for the rest of the run (#4611).
beforeEach(() => {
  __resetParkedTurnStartsForTest()
})
afterEach(() => {
  __resetParkedTurnStartsForTest()
})

describe('silence-fallback drains parkedTurnStarts so a hung REPL cannot wedge the park gate', () => {
  it('empties the parked store AND redelivers the parked message into turn processing', async () => {
    const h = makeHarness()

    // ── turn A mints on the idle enqueue and its ms-later dequeue ─────────────
    handleSessionEvent(h.deps, enqueue('501'))
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    const turnA = h.current()!
    expect(turnA.sourceMessageId).toBe(501)

    // ── the operator sends B mid-turn; the CLI queues it (enqueue) but the
    //    REPL hangs, so the paired `dequeue` never comes and B stays parked ──
    handleSessionEvent(h.deps, enqueue('502', 'still there?'))
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // ── the REAL 300 s framework-fallback fires, wired to the REAL parked
    //    drain over the harness deps so both states share one world ──────────
    const KEY = statusKeyForTests(CHAT, null)
    const fx = makeLivenessFixture({
      drainParkedTurnStarts: (chatId: string, threadId: number | null) =>
        drainParkedTurnStartsForChat(
          h.deps,
          chatId,
          threadId != null ? String(threadId) : null,
        ).length,
    })
    // The wedged turn the fallback tears down — same chat/thread as parked B.
    fx.activeTurnStartedAt.set(KEY, 0)
    fx.setCurrentTurn(makeTurn({ sessionChatId: CHAT, sessionThreadId: undefined, turnId: `${KEY}#42` }))

    const opts = buildSilencePokeOptions(fx.deps)
    await opts.onFrameworkFallback({
      key: KEY,
      chatId: CHAT,
      threadId: null,
      fallbackKind: 'working',
      silenceMs: 302_000,
      inFlightTools: [],
    })

    // The fallback nulled the wedged turn (its one load-bearing job).
    expect(fx.endedKeys).toContain(KEY)

    // OUTCOME 1 — the parked store is emptied, so the busy park gate unlatches
    // and the NEXT inbound can mint its own turn instead of parking unseen.
    expect(__parkedTurnStartCountForTest()).toBe(0)

    // OUTCOME 2 — B was actually dispatched back into turn processing, not
    // dropped: its turn was begun (it is now the live turn) and its progress
    // card was opened. Pre-fix, B stayed parked and this never happened.
    expect(h.current()!.sourceMessageId).toBe(502)
    expect(h.cardsOpened.some((c) => c.sourceMessageId === 502)).toBe(true)
  })

  it('is scoped to the wedged chat — a fallback for chat A leaves chat B parked', () => {
    const h = makeHarness()

    // A live turn on CHAT, plus a parked entry on CHAT.
    handleSessionEvent(h.deps, enqueue('601'))
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    handleSessionEvent(h.deps, enqueue('602'))
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // A fallback for a DIFFERENT chat must not touch CHAT's parked entry.
    const drainedOther = drainParkedTurnStartsForChat(h.deps, '9999', null)
    expect(drainedOther).toHaveLength(0)
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // The correctly-scoped drain releases it.
    const drainedHere = drainParkedTurnStartsForChat(h.deps, CHAT, null)
    expect(drainedHere).toHaveLength(1)
    expect(drainedHere[0]!.messageId).toBe('602')
    expect(__parkedTurnStartCountForTest()).toBe(0)
  })

  it('is idempotent w.r.t. a late CLI dequeue — no double-start', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('701'))
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    handleSessionEvent(h.deps, enqueue('702'))
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // Fallback drains + begins 702.
    expect(drainParkedTurnStartsForChat(h.deps, CHAT, null)).toHaveLength(1)
    expect(h.current()!.sourceMessageId).toBe(702)
    const cardsAfterDrain = h.cardsOpened.length

    // The REPL finally un-hangs and emits its late `dequeue`. The store is empty
    // so `takeParkedTurnStart` returns null and no second turn/card is minted.
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    expect(h.cardsOpened).toHaveLength(cardsAfterDrain)
    expect(h.current()!.sourceMessageId).toBe(702)
  })
})
