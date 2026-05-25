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

const KEY = '12345:_'

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

  it('no stale carryover: turn 1 activates, clearPending fires, turn 2 (no async) does not re-activate', async () => {
    // Reproduces the reviewer's blocker #2 path: turn 1 with async
    // dispatch activates pending-progress; an arriving turn 2 (real
    // inbound OR synthesised wake) must clear state so a turn 2 that
    // does NOT itself dispatch async never inherits the prior turn's
    // `pending=true` and re-activates against turn 2's anchor.
    const cap = setup()
    // ── Turn 1: dispatch async, reply, end — activates.
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'worker dispatched' })
    cap.now = 1_000
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)?.activatedAt).toBe(1_000)

    // ── Inbound (or handback / cron / vault grant) for turn 2.
    // Gateway clears state — exactly what the inbound/enqueue hooks
    // wire up at handleInbound + handleSessionEvent.enqueue.
    cap.now = 90_000
    clearPending(KEY, 'inbound')
    expect(__getStateForTests(KEY)).toBeUndefined()

    // ── Turn 2: reply only, NO async dispatch this turn.
    noteOutbound(KEY, { messageId: 200, text: 'just answering' })
    cap.now = 91_000
    noteTurnEnd(KEY)

    // Turn 2 must NOT activate — no async was dispatched in this turn.
    // Pre-fix this assertion would fail because the prior turn's
    // `pending=true` was never reset and `noteTurnEnd` re-activated
    // against turn 2's fresh anchor.
    expect(__getStateForTests(KEY)).toBeUndefined()

    // Confirm: no edits fire over the next several poll intervals.
    cap.now = 91_000 + EDIT_INTERVAL_MS * 3
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(0)
  })

  // ─── #1698 regression — preserve parse_mode on the cross-turn edit ───
  it("preserves the anchor's parse_mode on every edit (#1698)", async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // Anchor was sent through the reply tool with format='html', so
    // the captured text is already rendered Telegram HTML.
    noteOutbound(KEY, {
      messageId: 100,
      text: '<b>Worker back.</b> Both blockers fixed.',
      parseMode: 'HTML',
    })
    cap.now = 0
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(1)
    expect(cap.edits[0].parseMode).toBe('HTML')
    expect(cap.edits[0].newText).toBe(
      '<b>Worker back.</b> Both blockers fixed.\n\n— still working (1m)',
    )
  })

  it('passes undefined parseMode through when the anchor was plain text', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // format: 'text' path — anchor was sent without parse_mode.
    noteOutbound(KEY, {
      messageId: 100,
      text: 'plain text reply',
      parseMode: undefined,
    })
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits[0].parseMode).toBeUndefined()
  })

  it('defaults parseMode to undefined when caller omits it (test ergonomics)', async () => {
    const cap = setup()
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    // Callsite that hasn't been updated for the new field — must not
    // typecheck-fail nor crash. The edit goes out parse_mode-less,
    // matching the pre-#1698 behaviour for legacy callers.
    noteOutbound(KEY, { messageId: 100, text: 'wd' })
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits[0].parseMode).toBeUndefined()
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

  // ─── #1760 regression tests ───────────────────────────────────────────
  //
  // The "— still working (Nm)" ticker can get stuck forever editing an
  // old outbound message if the gateway misses the SDK `turn_end` event.
  // Two layers of defence:
  //
  //   1. PRIMARY: the gateway tears down on every `reply: finalized`
  //      chokepoint via `clearPending(key, 'reply_finalize')` BEFORE
  //      `noteOutbound` on the next turn's first reply. Verified here by
  //      simulating a missed-turn_end scenario: the prior turn's ticker
  //      is activated, then the gateway processes a fresh reply on a NEW
  //      turn without ever calling `noteTurnEnd` for the prior one. The
  //      explicit `clearPending('reply_finalize')` call must wipe the
  //      stale ambient.
  //
  //   2. DEFENSE-IN-DEPTH: at tick time, if `isActiveTurnNewerThan`
  //      returns true (gateway reports a newer turn is active for this
  //      chat), the ticker self-terminates instead of editing. Bug
  //      becomes "at most one stale tick" rather than "stuck forever."

  it('#1760 primary: reply_finalize teardown wipes a stale activated ticker', async () => {
    const cap = setup()

    // Turn 1: dispatch async work, capture an anchor, end the turn.
    // Ticker activates and fires one edit at +60s.
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'kicking off worker' })
    noteTurnEnd(KEY)
    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(1)
    expect(cap.edits[0]?.messageId).toBe(100)

    // Turn 2 begins WITHOUT a prior `noteTurnEnd` clear (simulating the
    // #1760 missed-turn_end SDK-event-drop). The gateway's reply-
    // finalize chokepoint MUST call clearPending('reply_finalize')
    // BEFORE noteOutbound on the new anchor. After that, the prior
    // ticker is gone and further ticks (even before any new
    // noteTurnEnd) edit nothing.
    clearPending(KEY, 'reply_finalize')
    noteOutbound(KEY, { messageId: 200, text: 'turn 2 reply' })

    cap.now = EDIT_INTERVAL_MS * 5
    __tickForTests(cap.now)
    await flush()
    // No additional edits — the stale ticker is dead. Note that the new
    // turn's ticker has not been activated yet (noteTurnEnd not called),
    // so nothing should fire here either.
    expect(cap.edits).toHaveLength(1)

    // The 'reply_finalize' clear must surface as a metric so operators
    // can observe the backstop firing in production.
    const reasons = cap.metrics
      .filter((m): m is Extract<PendingProgressMetric, { kind: 'pending_progress_cleared' }> =>
        m.kind === 'pending_progress_cleared')
      .map((m) => m.reason)
    expect(reasons).toContain('reply_finalize')
  })

  it('#1760 defense-in-depth: ticker self-terminates when isActiveTurnNewerThan is true', async () => {
    const cap: Capture = { edits: [], metrics: [], now: 0 }
    __resetAllForTests()
    // The activatedAt epoch captured by the ticker:
    const TURN_1_ACTIVATED_AT = 1_000
    // A NEWER turn starts later, simulating turn-2 racing past the
    // missed teardown:
    const TURN_2_STARTED_AT = TURN_1_ACTIVATED_AT + 30_000

    __setDepsForTests({
      editMessage: async (ctx) => {
        cap.edits.push(ctx)
      },
      emitMetric: (e) => {
        cap.metrics.push(e)
      },
      nowMs: () => cap.now,
      // Reports a newer turn always-on for this test.
      isActiveTurnNewerThan: (_key, activatedAt) =>
        TURN_2_STARTED_AT > activatedAt,
    })

    // Bootstrap a "prior turn" ticker at TURN_1_ACTIVATED_AT.
    cap.now = TURN_1_ACTIVATED_AT
    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'kicking off worker' })
    noteTurnEnd(KEY)
    expect(__getStateForTests(KEY)?.activatedAt).toBe(TURN_1_ACTIVATED_AT)

    // Advance past EDIT_INTERVAL_MS so the tick would otherwise fire.
    cap.now = TURN_1_ACTIVATED_AT + EDIT_INTERVAL_MS + 1_000
    __tickForTests(cap.now)
    await flush()

    // No edit fired — the predicate detected a newer active turn and
    // dropped the ticker.
    expect(cap.edits).toHaveLength(0)
    expect(__getStateForTests(KEY)).toBeUndefined()

    const cleared = cap.metrics.find(
      (m): m is Extract<PendingProgressMetric, { kind: 'pending_progress_cleared' }> =>
        m.kind === 'pending_progress_cleared',
    )
    expect(cleared?.reason).toBe('stale_turn')
  })

  it('#1760 defense-in-depth: predicate returning false leaves ticker alone', async () => {
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
      // No newer turn — the legitimate cross-turn ambient case.
      isActiveTurnNewerThan: () => false,
    })

    startTurn(KEY)
    noteAsyncDispatch(KEY)
    noteOutbound(KEY, { messageId: 100, text: 'kicking off worker' })
    noteTurnEnd(KEY)

    cap.now = EDIT_INTERVAL_MS
    __tickForTests(cap.now)
    await flush()
    expect(cap.edits).toHaveLength(1)
  })
})
