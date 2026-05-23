/**
 * Unit tests for cross-turn pending-async progress (#1445).
 *
 * Pins the deterministic state machine + edit cadence in isolation
 * from the gateway. The integration with gateway hooks is exercised
 * by the UAT scenario `silence-poke-debug-dm.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EDIT_INTERVAL_MS,
  MAX_LIFETIME_MS,
  TELEGRAM_MSG_CAP,
  __getStateForTests,
  __resetAllForTests,
  __setDepsForTests,
  __tickForTests,
  clearPending,
  noteAsyncDispatch,
  noteOutbound,
  noteTurnEnd,
  startTurn,
  type PendingProgressEditCtx,
  type PendingProgressMetric,
} from '../pending-work-progress.js'

const KEY = '8248703757:_'

interface Capture {
  edits: PendingProgressEditCtx[]
  metrics: PendingProgressMetric[]
  now: number
}

function setup(): Capture {
  const cap: Capture = { edits: [], metrics: [], now: 0 }
  __resetAllForTests()
  __setDepsForTests({
    editMessage: async (ctx) => {
      cap.edits.push(ctx)
    },
    emitMetric: (e) => {
      cap.metrics.push(e)
    },
    nowMs: () => cap.now,
  })
  return cap
}

async function flush(): Promise<void> {
  // Allow the fire-and-forget promise chain in tick() to settle.
  await Promise.resolve()
  await Promise.resolve()
}

describe('pending-work-progress', () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_PENDING_PROGRESS
  })
  afterEach(() => {
    __resetAllForTests()
  })

  it('does nothing on turns without an async dispatch', () => {
    const cap = setup()
    startTurn(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'simple reply' })
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)).toBeUndefined()
    cap.now = 60_000
    __tickForTests(cap.now)
    expect(cap.edits).toHaveLength(0)
    expect(cap.metrics).toHaveLength(0)
  })

  it('activates when turn ends with async dispatch + anchor', () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'worker dispatched' })
    cap.now = 1_000
    noteTurnEnd(KEY)
    const s = __getStateForTests(KEY)
    expect(s).toBeDefined()
    expect(s?.activatedAt).toBe(1_000)
    expect(s?.anchorMessageId).toBe(100)
    expect(s?.anchorOriginalText).toBe('worker dispatched')
    expect(cap.metrics).toContainEqual({
      kind: 'pending_progress_started',
      chatKey: KEY,
    })
  })

  it('does not activate when async dispatch happened but no anchor was captured', () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // no noteOutbound — model never sent a reply (silent end)
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)).toBeUndefined()
    cap.now = 60_000
    __tickForTests(cap.now)
    expect(cap.edits).toHaveLength(0)
  })

  it('does not activate when an anchor exists but no async dispatch happened', () => {
    const cap = setup()
    startTurn(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'just chatting' })
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)).toBeUndefined()
    cap.now = 60_000
    __tickForTests(cap.now)
    expect(cap.edits).toHaveLength(0)
  })

  it('edits anchor with elapsed-time suffix at EDIT_INTERVAL_MS cadence', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, {
      messageId: 100,
      text: 'Background sleep running; awaiting completion.',
    })
    cap.now = 0
    noteTurnEnd(KEY)

    // Tick at half-interval — no edit yet.
    cap.now = EDIT_INTERVAL_MS / 2
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(0)

    // Tick at full interval — first edit fires, "1m" suffix.
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(1)
    expect(cap.edits[0].messageId).toBe(100)
    expect(cap.edits[0].newText).toBe(
      'Background sleep running; awaiting completion.\n\n— still working (1m)',
    )

    // Tick at 3 intervals total — second edit, "3m".
    cap.now = EDIT_INTERVAL_MS * 3
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(2)
    expect(cap.edits[1].newText).toBe(
      'Background sleep running; awaiting completion.\n\n— still working (3m)',
    )
  })

  it('strips prior suffix before re-appending so anchor never accumulates', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // Simulate a noteOutbound for text that already carries a stale
    // suffix from an earlier round (defence in depth).
    noteOutbound(KEY, {
      messageId: 100,
      text: 'worker dispatched\n\n— still working (12m)',
    })
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    // The new edit should be based on 'worker dispatched' alone.
    expect(cap.edits[0].newText).toBe(
      'worker dispatched\n\n— still working (1m)',
    )
  })

  it("clears on 'inbound' reason — user re-engaged", () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'wd' })
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS * 2
    clearPending(KEY, 'inbound')
    expect(__getStateForTests(KEY)).toBeUndefined()
    expect(cap.metrics).toContainEqual({
      kind: 'pending_progress_cleared',
      chatKey: KEY,
      elapsedMs: EDIT_INTERVAL_MS * 2,
      reason: 'inbound',
    })
    // No further edits after clear.
    cap.now = EDIT_INTERVAL_MS * 3
    __tickForTests(cap.now)
    expect(cap.edits).toHaveLength(0)
  })

  it("clears on 'handback' reason — model is about to re-engage", () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'wd' })
    noteTurnEnd(KEY)
    clearPending(KEY, 'handback')
    expect(__getStateForTests(KEY)).toBeUndefined()
    expect(cap.metrics.some((m) => m.kind === 'pending_progress_cleared' && m.reason === 'handback')).toBe(true)
  })

  it('times out at MAX_LIFETIME_MS', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'wd' })
    cap.now = 0
    noteTurnEnd(KEY)
    // Halfway — still active.
    cap.now = MAX_LIFETIME_MS / 2
    __tickForTests(cap.now)
    await flush()
    expect(__getStateForTests(KEY)).toBeDefined()
    // Past the budget — auto-cleared.
    cap.now = MAX_LIFETIME_MS + 1
    __tickForTests(cap.now)
    await flush()
    expect(__getStateForTests(KEY)).toBeUndefined()
    expect(cap.metrics.some((m) => m.kind === 'pending_progress_cleared' && m.reason === 'timeout')).toBe(true)
  })

  it('skips edit (but advances cadence) if total would exceed Telegram message cap', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // Anchor text long enough that even the smallest suffix overflows.
    const bigText = 'x'.repeat(TELEGRAM_MSG_CAP - 5)
    noteOutbound(KEY, { messageId: 100, text: bigText })
    cap.now = 0
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(0)
    // lastEditAt still advanced — we won't spin retrying every tick.
    const s = __getStateForTests(KEY)
    expect(s?.lastEditAt).toBe(EDIT_INTERVAL_MS)
  })

  it('honors the kill switch — no state, no edits, no metrics', async () => {
    const cap = setup()
    process.env.SWITCHROOM_DISABLE_PENDING_PROGRESS = '1'
    try {
      startTurn(KEY)
      noteAsyncDispatch(KEY)
      noteOutbound(KEY, { messageId: 100, text: 'wd' })
      noteTurnEnd(KEY)
      expect(__getStateForTests(KEY)).toBeUndefined()
      cap.now = EDIT_INTERVAL_MS * 3
      __tickForTests(cap.now)
      await flush()
      expect(cap.edits).toHaveLength(0)
      expect(cap.metrics).toHaveLength(0)
    } finally {
      delete process.env.SWITCHROOM_DISABLE_PENDING_PROGRESS
    }
  })

  it('startTurn resets per-turn fields but NOT cross-turn activation', () => {
    const cap = setup()
    // Turn 1: dispatches async, ends, pending-progress active.
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'wd' })
    cap.now = 1_000
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)?.activatedAt).toBe(1_000)
    // Turn 2 starts (e.g. via the gateway's inbound path that already
    // called clearPending). startTurn resets per-turn fields but the
    // map entry has been deleted by clearPending, so this should
    // simply do nothing dangerous if called against an absent key.
    clearPending(KEY, 'inbound')
    startTurn(KEY)
    expect(__getStateForTests(KEY)).toBeUndefined()
  })

  it('multiple chats — independent state', async () => {
    const cap = setup()
    const KEY_A = 'A:_'
    const KEY_B = 'B:42'
    startTurn(KEY_A)
    noteAsyncDispatch(KEY_A)
    noteOutbound(KEY_A, { messageId: 10, text: 'wd-A' })
    cap.now = 0
    noteTurnEnd(KEY_A)

    startTurn(KEY_B)
    noteAsyncDispatch(KEY_B)
    noteOutbound(KEY_B, { messageId: 20, text: 'wd-B' })
    noteTurnEnd(KEY_B)

    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(2)
    const byMsg = new Map(cap.edits.map((e) => [e.messageId, e]))
    expect(byMsg.get(10)?.chatId).toBe('A')
    expect(byMsg.get(10)?.threadId).toBe(null)
    expect(byMsg.get(20)?.chatId).toBe('B')
    expect(byMsg.get(20)?.threadId).toBe(42)

    // Clear A only; B should keep ticking.
    clearPending(KEY_A, 'inbound')
    cap.now = EDIT_INTERVAL_MS * 2
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits.filter((e) => e.messageId === 10)).toHaveLength(1)
    expect(cap.edits.filter((e) => e.messageId === 20)).toHaveLength(2)
  })
})
