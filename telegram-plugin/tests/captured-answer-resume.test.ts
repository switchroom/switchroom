import { describe, expect, it, beforeEach } from 'vitest'

import {
  BackstopDeliveryLedger,
  runBackstopDelivery,
  type ReadBackResult,
} from '../gateway/backstop-delivery.js'
import { ObligationLedger, type Obligation } from '../gateway/obligation-ledger.js'
import {
  buildCapturedDeliverySnapshot,
  hydrateResumeLedger,
  createCapturedResumeDispatcher,
  type CapturedResumeArgs,
} from '../gateway/captured-answer-resume.js'

/**
 * #3282 — a partial turn-flush backstop that left an obligation OPEN used to be
 * re-presented as a FRESH model generation, re-posting chunks that already
 * landed (the user saw the head of the answer twice). These assert the
 * deterministic OUTCOME of the fix — the represent is now a byte-identical
 * captured-answer RESUME of ONLY the non-`landed-confirmed` tail:
 *   (a) 3-chunk answer, tail fails ⇒ resume sends EXACTLY the unlanded tail,
 *       chunk 0 is NEVER re-sent, and the chat ends with each chunk once;
 *   (b) a restart between landing and confirmation does NOT re-send a chunk the
 *       durable oracle proves landed;
 *   (c) a fully-landed answer's represent sends NOTHING.
 * A test that would still pass if the resume re-sent a confirmed chunk is not a
 * test — every scenario asserts the exact `sendChunk` index set.
 *
 * The dispatcher's resume closure reaches for the durable outbound-text oracle
 * (history.hasOutboundWithText) to reconcile crash-idempotency. `mockOracle`
 * below is injected per-scenario via `createCapturedResumeDispatcher`'s
 * `hasOutboundWithText` port (see `gateway/captured-answer-resume.ts`) — NOT
 * via `vi.mock('../history.js', ...)`. That used to module-mock `history.js`,
 * which looks file-scoped under vitest but under bun's vitest-compat layer
 * `vi.mock` maps onto the process-global `mock.module`: `bun test` runs the
 * whole `telegram-plugin/` surface in one process
 * (`telegram-plugin/scripts/bun-test-ci.sh`), so the mock retroactively
 * rebound `hasOutboundWithText` for every OTHER file in the same sweep —
 * including `tests/history.test.ts`'s calls to the REAL implementation. That
 * was the actual root cause of #4488/#4491: a row `history.test.ts` had
 * genuinely just written to its own real bun:sqlite DB was reported "not
 * found" because its `hasOutboundWithText` import had been silently rebound
 * to this file's `() => false` default. See check-bun-module-mock-scope.mjs.
 */
let mockOracle: (chatId: string, text: string, threadId: number | null, since: number) => boolean = () => false

beforeEach(() => {
  mockOracle = () => false
})

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    originTurnId: '#t1',
    chatId: '900',
    threadId: undefined,
    messageId: 42,
    text: 'the question',
    openedAt: 1000,
    representCount: 0,
    ...over,
  }
}

/** Simulate the ORIGINAL partial backstop delivery into `ledger`, then snapshot
 *  it — the exact input the represent resume consumes. `landPlan(i)` returns the
 *  per-chunk behavior: 'ok' (lands + confirms), 'throw' (send fails → unsent),
 *  or 'unconfirmed' (lands but read-back ambiguous → landed-unconfirmed). */
async function seedPartial(
  ledger: BackstopDeliveryLedger,
  turnId: string,
  chunks: string[],
  landPlan: (i: number) => 'ok' | 'throw' | 'unconfirmed',
): Promise<void> {
  await runBackstopDelivery(
    ledger,
    turnId,
    chunks,
    null,
    {
      sendChunk: async (i: number) => {
        if (landPlan(i) === 'throw') throw new Error('FLOOD_WAIT_ACTIVE')
        return [5000 + i]
      },
      readBack: async (i: number): Promise<ReadBackResult> =>
        landPlan(i) === 'unconfirmed' ? 'ambiguous' : 'exists',
    },
    1, // a single attempt → a genuine partial (no in-fire retry masking it)
  )
}

/** A fake `deliverAnswer` that faithfully replicates the gateway's RESUME path:
 *  run the injected `hydrate`, then `runBackstopDelivery` over the captured
 *  chunks with a `sendChunk` that records which indices are (re-)sent. */
function makeResumeDeliverAnswer(ledger: BackstopDeliveryLedger, sentIdx: number[]) {
  return async (a: CapturedResumeArgs): Promise<{ delivered: boolean; sentIds: number[] }> => {
    a.resume.hydrate(ledger, a.turnId)
    const res = await runBackstopDelivery(
      ledger,
      a.turnId,
      a.resume.snapshot.chunks,
      a.cardMessageId,
      {
        sendChunk: async (i: number) => {
          sentIdx.push(i)
          return [7000 + i]
        },
        readBack: async (): Promise<ReadBackResult> => 'exists',
      },
      3,
    )
    return { delivered: res.delivered, sentIds: res.sentIds }
  }
}

async function flush(dispatcher: { inFlight: () => string[] }): Promise<void> {
  for (let i = 0; i < 50 && dispatcher.inFlight().length > 0; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('#3282 buildCapturedDeliverySnapshot — captures per-chunk landed state', () => {
  it('captures landed chunks (ids + confirmed flag); an unsent chunk is absent', async () => {
    const ledger = new BackstopDeliveryLedger()
    const chunks = ['c0', 'c1', 'c2']
    // chunk 0 confirmed, chunk 1 landed-unconfirmed, chunk 2 never sent.
    await seedPartial(ledger, '#s', chunks, (i) => (i === 0 ? 'ok' : i === 1 ? 'unconfirmed' : 'throw'))
    const snap = buildCapturedDeliverySnapshot(ledger, '#s', chunks)
    expect(snap.chunks).toEqual(chunks)
    const byIndex = Object.fromEntries(snap.chunkStates.map((s) => [s.index, s]))
    expect(byIndex[0]).toMatchObject({ index: 0, confirmed: true })
    expect(byIndex[0].messageIds.length).toBeGreaterThan(0)
    expect(byIndex[1]).toMatchObject({ index: 1, confirmed: false })
    expect(byIndex[2]).toBeUndefined() // never landed → not in the snapshot
  })
})

describe('#3282 hydrateResumeLedger — rebuilds ledger + oracle reconcile', () => {
  it('confirmed chunk ⇒ excluded from the resume send set; unsent chunk ⇒ included', () => {
    const l = new BackstopDeliveryLedger()
    const snap = {
      chunks: ['c0', 'c1', 'c2'],
      chunkStates: [{ index: 0, messageIds: [10], confirmed: true }],
    }
    hydrateResumeLedger(l, '#h', snap, () => false)
    expect(l.hasConfirmedChunk('#h', 0)).toBe(true)
    // chunk 0 confirmed → not resent; chunks 1,2 unsent → the resume tail.
    expect(l.unsentIndices('#h', 3)).toEqual([1, 2])
  })

  it('landed-unconfirmed chunk ⇒ re-PROBED (landedUnconfirmed), not re-sent', () => {
    const l = new BackstopDeliveryLedger()
    const snap = {
      chunks: ['c0', 'c1'],
      chunkStates: [{ index: 0, messageIds: [10], confirmed: false }],
    }
    hydrateResumeLedger(l, '#h', snap, () => false)
    expect(l.landedUnconfirmedIndices('#h', 2)).toEqual([0]) // will be re-probed
    expect(l.unsentIndices('#h', 2)).toEqual([1]) // only chunk 1 is unsent
  })

  it('oracle proves a landed-unconfirmed chunk landed ⇒ CONFIRMED (crash-idempotency A5)', () => {
    const l = new BackstopDeliveryLedger()
    const snap = {
      chunks: ['c0', 'c1'],
      chunkStates: [{ index: 0, messageIds: [10], confirmed: false }],
    }
    // The durable outbound row for c0 exists → confirm without re-probe/re-send.
    hydrateResumeLedger(l, '#h', snap, (txt) => txt === 'c0')
    expect(l.hasConfirmedChunk('#h', 0)).toBe(true)
    expect(l.landedUnconfirmedIndices('#h', 2)).toEqual([])
    expect(l.unsentIndices('#h', 2)).toEqual([1])
  })

  it('a chunkState with no message ids is left unsent (never fabricates a landing)', () => {
    const l = new BackstopDeliveryLedger()
    const snap = { chunks: ['c0'], chunkStates: [{ index: 0, messageIds: [], confirmed: false }] }
    hydrateResumeLedger(l, '#h', snap, () => false)
    expect(l.unsentIndices('#h', 1)).toEqual([0])
  })
})

describe('#3282 createCapturedResumeDispatcher — the represent RESUME outcome', () => {
  it('(a) partial [0 confirmed, 1+2 unsent] ⇒ resume sends EXACTLY [1,2]; chunk 0 never re-sent; each chunk once', async () => {
    const chunks = ['c0', 'c1', 'c2']
    // Original delivery: chunk 0 lands+confirms, chunks 1,2 fail (unsent).
    const orig = new BackstopDeliveryLedger()
    await seedPartial(orig, '#t1', chunks, (i) => (i === 0 ? 'ok' : 'throw'))
    const snapshot = buildCapturedDeliverySnapshot(orig, '#t1', chunks)
    orig.clear('#t1') // the turn-flush GCs the in-memory ledger (state is durable)

    // The represent runs on a FRESH ledger (as after a sweep / restart).
    const resumeLedger = new BackstopDeliveryLedger()
    const sentIdx: number[] = []
    const oblLedger = new ObligationLedger(2)
    const supersedes: Array<{ ids: number[] }> = []
    const o = obligation({ capturedDelivery: snapshot })
    oblLedger.openIfAbsent(o)
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: makeResumeDeliverAnswer(resumeLedger, sentIdx),
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: (_c, _t, rec) => supersedes.push({ ids: rec.messageIds }) },
      historyEnabled: false,
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    // The core anti-regression assertion: ONLY the unlanded tail is (re-)sent.
    expect(sentIdx.sort()).toEqual([1, 2])
    expect(sentIdx).not.toContain(0) // chunk 0 (already landed) NEVER re-posted
    expect(oblLedger.isOpen('#t1')).toBe(false) // fully delivered ⇒ closed
    // §4 — the supersede record covers the WHOLE delivered set (original landed
    // chunk 0's id 5000 + the resumed tail's ids), keyed by turn so a late reply
    // corrects the complete answer in place.
    expect(supersedes.at(-1)?.ids).toEqual([5000, 7001, 7002])
  })

  it('(b) restart between landing and confirmation ⇒ oracle-confirmed chunk NOT re-sent', async () => {
    const chunks = ['c0', 'c1']
    // Snapshot has chunk 0 landed-unconfirmed (crashed before read-back), chunk 1 unsent.
    const snapshot = {
      chunks,
      chunkStates: [{ index: 0, messageIds: [5000], confirmed: false }],
    }
    const resumeLedger = new BackstopDeliveryLedger()
    const sentIdx: number[] = []
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    // The durable oracle proves chunk 0's text landed → confirm, don't re-send.
    mockOracle = (_c, txt) => txt === 'c0'

    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: makeResumeDeliverAnswer(resumeLedger, sentIdx),
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: true,
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    expect(sentIdx).toEqual([1]) // chunk 0 reconciled-confirmed, only chunk 1 sent
    expect(sentIdx).not.toContain(0)
    expect(oblLedger.isOpen('#t1')).toBe(false)
  })

  it('(c) fully-landed answer ⇒ resume sends NOTHING and closes the obligation', async () => {
    const chunks = ['c0', 'c1']
    const snapshot = {
      chunks,
      chunkStates: [
        { index: 0, messageIds: [5000], confirmed: true },
        { index: 1, messageIds: [5001], confirmed: true },
      ],
    }
    const resumeLedger = new BackstopDeliveryLedger()
    const sentIdx: number[] = []
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: makeResumeDeliverAnswer(resumeLedger, sentIdx),
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    expect(sentIdx).toEqual([]) // nothing re-posted
    expect(oblLedger.isOpen('#t1')).toBe(false)
  })

  // #3702 L3 — the close condition is LANDED, not confirmed. A snapshot whose
  // chunks all landed but were NEVER corroborated (the read-back is 100% shed in
  // production, #3703) is resolved on HYDRATION alone: the resume re-probes,
  // resolves nothing again, sends zero messages, and closes.
  //
  // This is the case the durable outbound-text oracle CANNOT reach — history
  // disabled here, so `hasOutboundWithText` never fires and the old
  // confirmation-gated verdict would have kept the obligation OPEN, re-running
  // the same shed probe on every sweep with no send available to it, until the
  // represent cap escalated a false "never answered you" to the operator.
  it('fully-landed-but-UNCONFIRMED snapshot, no oracle ⇒ ZERO sends and the obligation CLOSES', async () => {
    const chunks = ['c0', 'c1']
    const snapshot = {
      chunks,
      chunkStates: [
        { index: 0, messageIds: [5000], confirmed: false },
        { index: 1, messageIds: [5001], confirmed: false },
      ],
    }
    const resumeLedger = new BackstopDeliveryLedger()
    const sentIdx: number[] = []
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    // No durable corroboration is available from EITHER source: the snapshot
    // flags are false, history is off, and the re-probe sheds (ambiguous).
    mockOracle = () => false

    const lines: string[] = []
    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: async (a) => {
        a.resume.hydrate(resumeLedger, a.turnId)
        const res = await runBackstopDelivery(
          resumeLedger, a.turnId, a.resume.snapshot.chunks, a.cardMessageId,
          {
            sendChunk: async (i: number) => { sentIdx.push(i); return [7000 + i] },
            readBack: async (): Promise<ReadBackResult> => 'ambiguous',
          },
          3,
        )
        expect(res.confirmed).toBe(false) // nothing corroborated it, at any point
        expect(res.landedUnconfirmedIds).toEqual([5000, 5001]) // ...and it is counted
        return { delivered: res.delivered, sentIds: res.sentIds }
      },
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
      stderr: (s) => lines.push(s),
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    expect(sentIdx).toEqual([]) // nothing re-posted — the user never sees a duplicate
    expect(oblLedger.isOpen('#t1')).toBe(false) // closed on the landed-id evidence
    // ...and the log must say what actually happened. These ids are LANDED, not
    // confirmed: calling them "confirmed" is the overstatement #3702 removed from
    // the verdict, and a log that reintroduces it re-lies to the next debugger.
    const closed = lines.find((l) => l.includes('resume delivered'))
    expect(closed).toBeDefined()
    expect(closed).toContain('2 message id(s) landed')
    expect(closed).not.toContain('confirmed')
  })

  // The other half of that decision: a positive ABSENCE still re-opens the send
  // path, so "landed" is not a rubber stamp. (Inert in production until #3703
  // wakes the probe, but the mechanism must remain correct.)
  it('a landed chunk the re-probe finds ABSENT is demoted and RE-SENT, not closed on the stale id', async () => {
    const chunks = ['c0']
    const snapshot = { chunks, chunkStates: [{ index: 0, messageIds: [5000], confirmed: false }] }
    const resumeLedger = new BackstopDeliveryLedger()
    const sentIdx: number[] = []
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)
    mockOracle = () => false

    let probes = 0
    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: async (a) => {
        a.resume.hydrate(resumeLedger, a.turnId)
        const res = await runBackstopDelivery(
          resumeLedger, a.turnId, a.resume.snapshot.chunks, a.cardMessageId,
          {
            sendChunk: async (i: number) => { sentIdx.push(i); return [7000 + i] },
            readBack: async (): Promise<ReadBackResult> => (++probes === 1 ? 'absent' : 'exists'),
          },
          3,
        )
        return { delivered: res.delivered, sentIds: res.sentIds }
      },
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    expect(sentIdx).toEqual([0]) // the silently-dropped chunk IS re-sent
    expect(oblLedger.isOpen('#t1')).toBe(false)
  })

  it('a partial RESUME (tail still fails) leaves the obligation OPEN + consumes represent budget', async () => {
    const chunks = ['c0', 'c1']
    const snapshot = {
      chunks,
      chunkStates: [{ index: 0, messageIds: [5000], confirmed: true }],
    }
    const resumeLedger = new BackstopDeliveryLedger()
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    // A resume whose tail send keeps throwing ⇒ not delivered ⇒ obligation stays OPEN.
    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: async (a) => {
        a.resume.hydrate(resumeLedger, a.turnId)
        const res = await runBackstopDelivery(
          resumeLedger, a.turnId, a.resume.snapshot.chunks, a.cardMessageId,
          { sendChunk: async () => { throw new Error('FLOOD_WAIT_ACTIVE') }, readBack: async () => 'exists' as ReadBackResult },
          2,
        )
        return { delivered: res.delivered, sentIds: res.sentIds }
      },
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
    })
    dispatcher.dispatch(oblLedger.list()[0])
    await flush(dispatcher)

    expect(oblLedger.isOpen('#t1')).toBe(true) // left OPEN for the next paced sweep
    expect(oblLedger.list()[0].representCount).toBe(1) // budget consumed → bounded ladder
  })

  it('de-dupes concurrent dispatches for the same origin (only one resume runs)', async () => {
    const chunks = ['c0', 'c1']
    const orig = new BackstopDeliveryLedger()
    await seedPartial(orig, '#t1', chunks, (i) => (i === 0 ? 'ok' : 'throw'))
    const snapshot = buildCapturedDeliverySnapshot(orig, '#t1', chunks)
    orig.clear('#t1')

    const resumeLedger = new BackstopDeliveryLedger()
    let deliverCalls = 0
    const oblLedger = new ObligationLedger(2)
    oblLedger.openIfAbsent(obligation({ capturedDelivery: snapshot }))
    oblLedger.noteCapturedDelivery('#t1', snapshot)

    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: async (a) => {
        deliverCalls++
        a.resume.hydrate(resumeLedger, a.turnId)
        const res = await runBackstopDelivery(
          resumeLedger, a.turnId, a.resume.snapshot.chunks, a.cardMessageId,
          { sendChunk: async (i: number) => [7000 + i], readBack: async () => 'exists' as ReadBackResult },
          3,
        )
        return { delivered: res.delivered, sentIds: res.sentIds }
      },
      obligationLedger: oblLedger,
      backstopDeliveryLedger: resumeLedger,
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
    })
    const o = oblLedger.list()[0]
    dispatcher.dispatch(o)
    dispatcher.dispatch(o) // second, concurrent — must be a no-op
    await flush(dispatcher)
    expect(deliverCalls).toBe(1)
  })

  it('no captured snapshot ⇒ dispatch is a no-op (caller falls through to fresh generation)', async () => {
    let delivered = false
    const dispatcher = createCapturedResumeDispatcher({
      hasOutboundWithText: mockOracle,
      deliverAnswer: async () => { delivered = true; return { delivered: true, sentIds: [] } },
      obligationLedger: new ObligationLedger(2),
      backstopDeliveryLedger: new BackstopDeliveryLedger(),
      flushedTurnSupersede: { record: () => {} },
      historyEnabled: false,
    })
    dispatcher.dispatch(obligation()) // no capturedDelivery
    dispatcher.dispatch(obligation({ capturedDelivery: { chunks: [], chunkStates: [] } })) // empty
    await flush(dispatcher)
    expect(delivered).toBe(false)
  })
})
