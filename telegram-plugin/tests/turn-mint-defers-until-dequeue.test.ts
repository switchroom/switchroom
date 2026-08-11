/**
 * #3927 FIX A — a QUEUE event is not a TURN-START event.
 *
 * Pre-fix, `case 'enqueue'` in stream-render.ts unconditionally minted a fresh
 * `CurrentTurn` and swapped it into the per-topic slot, even with a turn
 * already live. The claude CLI writes `{"type":"queue-operation","operation":
 * "enqueue"}` at QUEUE time, so a message the operator sent mid-turn produced
 * a brand-new card (reset `startedAt` / `toolCallCount` / `mirrorLines`) that
 * then streamed the STILL-RUNNING previous turn's tool labels into it, while
 * the real turn's card froze on its last edit.
 *
 * Ground truth (60 real agent transcripts, 372 enqueues): every enqueue is
 * terminated by exactly one of
 *   • `dequeue` — queue drained into a NEW turn (199/200 dequeues are directly
 *     preceded by their enqueue; median gap 6 ms idle, 2–14 s when queued
 *     behind a running turn), or
 *   • `remove`  — folded into the ALREADY-RUNNING turn as a `queued_command`
 *     attachment, replaying the enqueue's `content` byte-for-byte.
 *
 * These drive the REAL `handleSessionEvent` (extracted-module golden-harness
 * oracle, same standard as `stream-render-golden.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleSessionEvent,
  __resetParkedTurnStartsForTest,
  __parkedTurnStartCountForTest,
} from '../gateway/stream-render.js'
import { projectTranscriptLine } from '../session-tail.js'
import { CHAT, enqueue, inbound, makeHarness } from './turn-mint-harness.js'

// Module-scope store + one-process `bun test` sweep: resetting on ENTRY alone
// leaves a mid-park case's entry behind for every later FILE, which makes the
// obligation sweep read the session as busy for the rest of the run (#4611).
beforeEach(() => {
  __resetParkedTurnStartsForTest()
})
afterEach(() => {
  __resetParkedTurnStartsForTest()
})

describe('#3927 FIX A — a mid-turn enqueue parks; the turn mints on dequeue', () => {
  it('a second enqueue while turn A is live opens NO card, does not steal the slot, ' +
    'and later tool labels still land on A — then dequeue mints B', () => {
    const h = makeHarness()

    // ── message A arrives on an idle session: mints immediately (unchanged) ──
    handleSessionEvent(h.deps, enqueue('501'))
    handleSessionEvent(h.deps, { kind: 'dequeue' }) // the CLI's ms-later pair
    const turnA = h.current()!
    expect(turnA).not.toBeNull()
    expect(turnA.sourceMessageId).toBe(501)
    expect(h.cardsOpened).toHaveLength(1)
    // The idle enqueue already minted, so the paired dequeue found nothing
    // parked and was a no-op — NOT a second turn.
    expect(h.cardsOpened[0]!.sourceMessageId).toBe(501)

    // ── A does tool work ────────────────────────────────────────────────────
    handleSessionEvent(h.deps, { kind: 'tool_label', toolName: 'Read', label: 'Reading config.ts' })
    expect(turnA.labeledToolCount).toBe(1)

    // ── the operator sends message B MID-TURN (no turn_end for A) ───────────
    handleSessionEvent(h.deps, enqueue('502', 'also check the vault'))

    // No second card. This is BUG 1: pre-fix a fresh card appeared here with
    // reset stats while A's froze.
    expect(h.cardsOpened).toHaveLength(1)
    // The topic slot still points at A — object identity, not just shape.
    expect(h.current()).toBe(turnA)
    // This is BUG 2: pre-fix the slot pointed at B, whose card quoted B's
    // message id while streaming A's still-running work.
    expect(h.current()!.sourceMessageId).toBe(501)
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // ── labels emitted AFTER B still belong to A's card ─────────────────────
    handleSessionEvent(h.deps, { kind: 'tool_label', toolName: 'Bash', label: 'Running tests' })
    expect(turnA.labeledToolCount).toBe(2)
    expect(turnA.mirrorLines.join('\n')).toContain('Running tests')
    expect(h.drains.every((d) => d.turnId === turnA.turnId)).toBe(true)

    // ── A ends, the CLI drains the queue → B's turn mints NOW ───────────────
    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    const turnB = h.current()!
    expect(turnB).not.toBe(turnA)
    expect(turnB.sourceMessageId).toBe(502)
    expect(h.cardsOpened).toHaveLength(2)
    expect(h.cardsOpened[1]!.sourceMessageId).toBe(502)
    // Fresh stats belong to B and only B.
    expect(turnB.labeledToolCount).toBe(0)
    expect(turnB.mirrorLines).toEqual([])
    expect(__parkedTurnStartCountForTest()).toBe(0)
  })

  it('a `remove` terminal discards the parked start, so a LATER dequeue cannot ' +
    'mint a spurious turn for an already-folded message', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('601'))
    const turnA = h.current()!

    // Queued mid-turn, then folded into A as a `queued_command` attachment.
    const queued = enqueue('602', 'while you are in there…')
    handleSessionEvent(h.deps, queued)
    expect(__parkedTurnStartCountForTest()).toBe(1)
    handleSessionEvent(h.deps, { kind: 'queue_remove', rawContent: queued.rawContent })
    expect(__parkedTurnStartCountForTest()).toBe(0)

    // A stray dequeue now must NOT resurrect 602 as its own turn.
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    expect(h.current()).toBe(turnA)
    expect(h.cardsOpened).toHaveLength(1)
  })

  it('dequeue pairs with the MOST RECENT parked start (evidence: max observed ' +
    'gap to the newest enqueue is 14.2 s; to the oldest, hours)', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('701'))
    const turnA = h.current()!

    handleSessionEvent(h.deps, enqueue('702'))
    handleSessionEvent(h.deps, enqueue('703'))
    expect(__parkedTurnStartCountForTest()).toBe(2)

    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    expect(h.current()!.sourceMessageId).toBe(703)
    expect(__parkedTurnStartCountForTest()).toBe(1)
  })

  it('a chat-less enqueue never parks (it can never mint a turn)', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, { kind: 'enqueue', chatId: null, messageId: null, threadId: null, rawContent: 'x' })
    expect(__parkedTurnStartCountForTest()).toBe(0)
    expect(h.current()).toBeNull()
    expect(h.cardsOpened).toHaveLength(0)
  })

  it('a parked start expires after its TTL, so a dequeue that never arrives can ' +
    'never mint a stale turn later', () => {
    // RUNNER-AGNOSTIC CLOCK. This file dual-runs (vitest + `bun test`), and
    // bun's vitest shim does NOT implement `vi.setSystemTime` — calling it
    // threw `TypeError: vi.setSystemTime is not a function` and made bun-test
    // deterministically red. The TTL is a pure elapsed-time comparison
    // (`now - parkedAt > PARKED_TURN_START_TTL_MS`), so the absolute wall
    // clock is irrelevant; only the 31-minute JUMP matters. `useFakeTimers()`
    // + `advanceTimersByTime()` moves `Date.now()` by exactly that delta on
    // BOTH runners (same insight as races.test.ts:275-281), so the assertion
    // below really executes under bun instead of being guarded away.
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      handleSessionEvent(h.deps, enqueue('1201'))
      const turnA = h.current()!
      handleSessionEvent(h.deps, enqueue('1202'))
      expect(__parkedTurnStartCountForTest()).toBe(1)

      // The CLI died mid-turn: neither `dequeue` nor `remove` ever arrives.
      vi.advanceTimersByTime(31 * 60_000) // TTL is 30 min
      turnA.endedAt = Date.now()
      handleSessionEvent(h.deps, { kind: 'dequeue' })

      // 1202 was pruned, not minted 31 minutes late.
      expect(__parkedTurnStartCountForTest()).toBe(0)
      expect(h.current()).toBe(turnA)
      expect(h.cardsOpened).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the parked store is bounded — the 17th mid-turn enqueue evicts the oldest, ' +
    'so a dequeue that never arrives cannot grow it without limit', () => {
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('801'))
    for (let i = 0; i < 40; i++) handleSessionEvent(h.deps, enqueue(String(900 + i)))
    expect(__parkedTurnStartCountForTest()).toBe(16)
    // The newest message — the one the user is actually waiting on — survived.
    h.current()!.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    expect(h.current()!.sourceMessageId).toBe(939)
  })
})

describe('#3927 — session-tail projects the `remove` queue operation', () => {
  it('projects op=remove as queue_remove carrying the enqueue content verbatim', () => {
    const content = inbound('901', 'queued while busy')
    const evs = projectTranscriptLine(
      JSON.stringify({ type: 'queue-operation', operation: 'remove', content }),
    )
    expect(evs).toEqual([{ kind: 'queue_remove', rawContent: content }])
  })

  it('still projects enqueue and dequeue unchanged', () => {
    const content = inbound('902', 'hello')
    expect(projectTranscriptLine(
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content }),
    )).toEqual([{ kind: 'enqueue', chatId: CHAT, messageId: '902', threadId: null, rawContent: content }])
    expect(projectTranscriptLine(
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }),
    )).toEqual([{ kind: 'dequeue' }])
  })
})
