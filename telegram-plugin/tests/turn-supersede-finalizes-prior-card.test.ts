/**
 * #3927 FIX B — a superseded turn must never be left holding an orphaned card.
 *
 * The turn-supersession teardown in `stream-render.ts` tore down the prior
 * turn's `answerStream`, its orphaned-reply fuse and its `narrativeGate`, but
 * NEVER called `clearActivitySummary(prior)`. So a clobbered turn's activity
 * card was never finalized, never unpinned (`fg:<statusKey>` stayed claimed
 * forever), froze on its last landed edit, and left NO `turn-lifecycle clear`
 * line to explain it. Proof from the field: carrie's turn
 * `-1004223464247:_#1078` has a `turn-lifecycle set reason=enqueue` at
 * 2026-07-28T18:13:37.554Z and no `clear` anywhere in the log; its stale pinned
 * card was still on screen in the operator's screenshot.
 *
 * ── Which path still supersedes, after FIX A ──────────────────────────────
 * FIX A parks EVERY mid-turn enqueue, synthetic ones included — that is not a
 * policy choice, it is what the claude CLI does (carrie's `obligation_represent`
 * enqueue at 18:19:07.032Z was terminated by a `remove` at 18:19:59.794Z, i.e.
 * folded into the running turn as a `queued_command` attachment, never by a
 * `dequeue`). So an enqueue no longer preempts, and the case below asserts that
 * explicitly.
 *
 * Supersession is still REACHABLE, though: a turn whose `turn_end` the gateway
 * never observed (bridge death, transcript gap, unclean restart) leaves a
 * live-looking atom in the slot, and the next genuine dequeue-driven turn start
 * mints straight on top of it. That is the exact orphan carrie hit, and it is
 * what FIX B finalizes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  handleSessionEvent,
  __resetParkedTurnStartsForTest,
  __parkedTurnStartCountForTest,
} from '../gateway/stream-render.js'
import { enqueue, makeHarness } from './turn-mint-harness.js'

/** A cron / handback / wake enqueue: no `message_id`, so `deriveTurnId` falls
 *  back to `…#synthetic-<startedAt>`. */
function syntheticEnqueue(chatId: string, text: string) {
  return {
    kind: 'enqueue' as const,
    chatId,
    messageId: null,
    threadId: null,
    rawContent: `<channel source="switchroom-telegram" source="cron">${text}</channel>`,
  }
}

// Module-scope store + one-process `bun test` sweep: resetting on ENTRY alone
// leaves a mid-park case's entry behind for every later FILE, which makes the
// obligation sweep read the session as busy for the rest of the run (#4611).
beforeEach(() => {
  __resetParkedTurnStartsForTest()
})
afterEach(() => {
  __resetParkedTurnStartsForTest()
})

describe('#3927 FIX B — superseding a live turn finalizes its card', () => {
  it('a dequeue-driven mint on top of a never-ended turn calls clearActivitySummary ' +
    'for the PRIOR turn, and does so BEFORE the successor opens its card', () => {
    const h = makeHarness()

    // Turn A starts and opens a card with real work on it.
    handleSessionEvent(h.deps, enqueue('1078'))
    const turnA = h.current()!
    handleSessionEvent(h.deps, { kind: 'tool_label', toolName: 'Read', label: 'Reading the log' })
    expect(turnA.labeledToolCount).toBe(1)
    expect(h.finalized).toHaveLength(0)

    // A's `turn_end` is NEVER observed — `endedAt` stays null and the atom
    // stays in the slot (exactly carrie's `#1078`).
    expect(turnA.endedAt).toBeNull()

    // A later message is queued and the CLI drains it into a new turn.
    handleSessionEvent(h.deps, enqueue('1086'))
    expect(__parkedTurnStartCountForTest()).toBe(1)
    handleSessionEvent(h.deps, { kind: 'dequeue' })

    const turnB = h.current()!
    expect(turnB).not.toBe(turnA)

    // FIX B: the orphan was finalized — pre-fix there was NO call at all.
    expect(h.finalized).toHaveLength(1)
    expect(h.finalized[0]).toBe(turnA)

    // …and it happened BEFORE the successor's card opened, so the old card is
    // finalized/unpinned rather than left frozen above a fresh one.
    expect(h.seq).toEqual([
      `open:${turnA.turnId}`,
      `finalize:${turnA.turnId}`,
      `open:${turnB.turnId}`,
    ])
  })

  it('a turn that ENDED normally is not re-finalized when its successor mints', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('1090'))
    const turnA = h.current()!
    // turn-end.ts stamps `endedAt` and runs its own clearActivitySummary.
    turnA.endedAt = Date.now()

    handleSessionEvent(h.deps, enqueue('1091'))
    // Idle by `endedAt`, so this mints straight away — and must NOT double-
    // finalize A's already-closed card.
    expect(h.current()).not.toBe(turnA)
    expect(h.finalized).toHaveLength(0)
  })

  it('FIX A is uniform across sources: a SYNTHETIC (cron/handback) enqueue parks ' +
    'behind a live turn instead of preempting it', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('1100'))
    const turnA = h.current()!

    handleSessionEvent(h.deps, syntheticEnqueue('1001', 'time for the daily digest'))

    // No preemption: no new card, no slot steal, no orphaned finalize.
    expect(h.current()).toBe(turnA)
    expect(h.cardsOpened).toHaveLength(1)
    expect(h.finalized).toHaveLength(0)
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // It mints on the CLI's own turn-start signal, like every other source.
    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    expect(h.current()).not.toBe(turnA)
    expect(h.current()!.turnId).toContain('#synthetic-')
    expect(h.cardsOpened).toHaveLength(2)
  })
})
