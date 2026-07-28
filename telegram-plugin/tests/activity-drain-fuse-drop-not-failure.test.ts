/**
 * The edit-flood fuse's DELIBERATE drops must not be reported as failures.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `edit-flood-fuse.ts` is installed as a grammY **transformer**
 * (`bot.api.config.use`, `installEditFloodFuse`). A transformer's return
 * contract is the raw `ApiResponse` ENVELOPE, and grammY's `Api.callApi`
 * unwraps it:
 *
 * ```js
 * const data = await this.call(method, payload, signal)
 * if (data.ok) return data.result
 * else throw toGrammyError(data, method, payload)
 * ```
 * (grammy `out/core/client.js`)
 *
 * The fuse resolved a dropped call with the bare `true` — the *result*, with no
 * envelope. `(true).ok` is `undefined`, so EVERY intentional fuse drop took the
 * `else` branch and was raised as
 * `GrammyError: Call to 'editMessageText' failed! (undefined: undefined)`.
 *
 * Downstream, `narrative-lane.ts`'s activity-summary drain caught that, found
 * nothing in its `isTransport` allowlist matching, incremented
 * `turn.activityDrainFailures` and wrote a `activity-summary drain failed:` line
 * to stderr. `activityDrainFailures` is what flags a turn DEGRADED at turn-end,
 * so a healthy turn whose progress card was correctly rate-limited was reported
 * as broken — observed reaching `failures=8` on a single turn.
 *
 * ── Why the fix is the envelope, not an `isTransport` entry ───────────────
 * Classifying the string in `isTransport` would paper over a real contract
 * violation that ALSO corrupts every other caller of a fused API method (each
 * one sees a synthetic transport error for a benign no-op). Restoring the
 * envelope is the durable fix; `isTransport` then needs no new entry at all,
 * because nothing is thrown.
 *
 * ── R1 on the per-MESSAGE tier ───────────────────────────────────────────
 * The second describe covers the other half: a card must never freeze mid-step
 * because a frame was shed. `awaitRoom`'s `dropGuard` (R1: "only drop while
 * something NEWER for this message is still in flight to repaint it") was wired
 * into the two per-chat tiers but NOT the per-message tier, which passed
 * `dropGuard: undefined` — read as "drop unconditionally at the deadline". A
 * lone terminal `finalize`, which by definition has nothing newer coming, was
 * therefore droppable there regardless of its priority class, freezing the card
 * on "→ in-progress".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { GrammyError } from 'grammy'

import { createEditFloodFuse, type EditFloodFuseConfig } from '../edit-flood-fuse.js'
import { withOutboundClass, type OutboundClass } from '../outbound-class.js'
import { createNarrativeLane } from '../gateway/narrative-lane.js'
import type { CurrentTurn, NarrativeLaneDeps } from '../gateway/gateway.js'

const CHAT = '1001'

/**
 * grammY's `Api.callApi`, verbatim in behaviour: run the transformer chain,
 * unwrap `ok:true`, throw `GrammyError` otherwise. This is the seam the defect
 * lived in, so the harness must model it rather than assume the fuse's return
 * value reaches the caller untouched (which is what the pre-existing fuse tests
 * assumed — they hand `next` a bare `true` and never unwrap, which is exactly
 * why the bug survived them).
 */
function makeFusedApi(config: EditFloodFuseConfig) {
  const fuse = createEditFloodFuse(config)
  const landed: Array<{ method: string; message_id?: number; text: string | null }> = []
  let nextId = 3000

  const callApi = async (method: string, payload: Record<string, unknown>, run: () => unknown) => {
    const data = (await fuse.apply(method, payload, async () => ({ ok: true, result: run() }))) as {
      ok?: boolean
      result?: unknown
    }
    if (data.ok === true) return data.result
    throw new GrammyError(`Call to '${method}' failed!`, data as never, method, payload as never)
  }

  const api = {
    sendRichMessage: (c: string, b: { markdown: string }) => {
      const id = ++nextId
      return callApi('sendRichMessage', { chat_id: c }, () => {
        landed.push({ method: 'sendRichMessage', message_id: id, text: b.markdown })
        return { message_id: id }
      }) as Promise<{ message_id: number }>
    },
    editMessageText: (c: string, m: number, b: { markdown: string }) =>
      callApi('editMessageText', { chat_id: c, message_id: m }, () => {
        landed.push({ method: 'editMessageText', message_id: m, text: b.markdown })
        return true
      }),
    deleteMessage: (c: string, m: number) =>
      callApi('deleteMessage', { chat_id: c, message_id: m }, () => {
        landed.push({ method: 'deleteMessage', message_id: m, text: null })
        return true
      }),
  }
  return { api, landed, fuse }
}

/**
 * The real `createNarrativeLane`, wired to a bot whose API traverses the real
 * fuse. `robustApiCall` stands in for the production chain
 * `robustApiCall → sendGate.gate → withOutboundClass → fn`: the only part of it
 * the fuse can observe is the published outbound class, so the stub publishes it
 * for real via `withOutboundClass` and calls straight through.
 */
function makeFusedLane(config: EditFloodFuseConfig) {
  const { api, landed, fuse } = makeFusedApi(config)
  const submitted: Array<{ verb?: string; priorityClass?: OutboundClass }> = []
  const noop = () => {}
  const fakeEA = {
    mayDrain: () => true,
    openOrEditCard: (_p: string, fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
  }
  const deps = {
    ACTIVITY_CARD_STORE_PATH: `${tmpdir()}/lane-fuse-drop-activity-cards.json`,
    CLEAR_STATUS_ON_COMPLETION: false,
    FEED_HEARTBEAT_ENABLED: false,
    FEED_HEARTBEAT_MIN_STALE_MS: 6000,
    FEED_LIVENESS_OPEN_ENABLED: false,
    FEED_LIVENESS_OPEN_MS: 5000,
    PIN_STATUS_WHILE_WORKING: false,
    POST_ANSWER_LIVENESS_STALE_MS: 90000,
    STATIC: false,
    activeDraftStreams: new Map(),
    activityCardPersistEnabled: false,
    activityCardStoreFs: {
      readFileSync: () => '',
      writeFileSync: noop,
      mkdirSync: noop,
      renameSync: noop,
      unlinkSync: noop,
    },
    bot: { api },
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    currentTurnMap: { get: () => null, byKey: new Map() },
    earlyLivenessOpenTimers: new Map(),
    emissionAuthorityFor: () => fakeEA,
    feedOpenGateDeps: () => ({
      hasOutboundDeliveredSince: () => false,
      historyEnabled: false,
      finalAnswerMinChars: 200,
    }),
    getCurrentTurn: () => null,
    reconcileStatusPin: noop,
    robustApiCall: (fn: () => Promise<unknown>, opts?: { verb?: string; priorityClass?: OutboundClass }) => {
      submitted.push({ verb: opts?.verb, priorityClass: opts?.priorityClass })
      return withOutboundClass(opts?.priorityClass ?? 'critical', fn)
    },
    statusKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
  } as unknown as NarrativeLaneDeps
  const lane = createNarrativeLane(deps)
  return { lane, landed, fuse, submitted }
}

function makeLaneTurn(lane: ReturnType<typeof createNarrativeLane>): CurrentTurn {
  const turn = {
    turnId: 'turn-fuse-drop-1',
    sessionChatId: CHAT,
    sessionThreadId: undefined,
    sourceMessageId: null,
    registryKey: null,
    startedAt: Date.now() - 3000,
    currentModel: null,
    totalTokens: 0,
    labeledToolCount: 0,
    mirrorLines: [] as string[],
    foregroundSubAgents: new Map<string, string[]>(),
    activityPendingRender: null as string | null,
    activityLastSentRender: null as string | null,
    activityMessageId: null as number | null,
    activityInFlight: null as Promise<void> | null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    finalAnswerEverDelivered: false,
    finalAnswerDelivered: false,
    replyCalled: false,
    capturedText: [] as string[],
    lastReplyText: '',
    answerStream: null,
    liveness: { recentlyStreaming: () => false, onStreamEvent: () => {}, note: () => {} },
  } as unknown as CurrentTurn
  ;(turn as { narrativeGate?: unknown }).narrativeGate = lane.makeNarrativeGate(turn)
  return turn
}

const settle = () => new Promise((r) => setTimeout(r, 20))

/**
 * A fuse tuned so a cosmetic repaint is genuinely DROPPED:
 *   - one cosmetic edit per message per window, so frame 2+ is over budget;
 *   - a short defer deadline so the wait ends inside the test;
 *   - `lateReleaseMaxPerWindow: 0`, i.e. the bounded R1 overshoot budget is
 *     already spent, which is the state in which a lone cosmetic frame is
 *     dropped rather than late-released. Without this the fix in the second
 *     describe would late-release the frame and no drop would occur at all.
 */
const DROPPING_FUSE: EditFloodFuseConfig = {
  perMessageMaxPerWindow: 1,
  cosmeticPerMessageMaxPerWindow: 1,
  perMessageWindowMs: 60_000,
  maxDeferMs: 20,
  lateReleaseMaxPerWindow: 0,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('edit-flood fuse — a deliberate drop is not a failure', () => {
  it('a dropped cosmetic edit RESOLVES through grammY instead of throwing "(undefined: undefined)"', async () => {
    const { api, fuse } = makeFusedApi(DROPPING_FUSE)
    const results: unknown[] = []
    const errors: string[] = []
    for (let i = 0; i < 3; i++) {
      await withOutboundClass('cosmetic', () => api.editMessageText(CHAT, 42, { markdown: `frame ${i}` }))
        .then((r) => results.push(r))
        .catch((e: unknown) => errors.push((e as Error).message))
    }
    // Pre-fix: two of the three surface as
    // `Call to 'editMessageText' failed! (undefined: undefined)`.
    expect(errors).toEqual([])
    // The drop is real — this asserts the fuse actually shed, so the test cannot
    // pass by simply never exercising the drop path.
    expect(fuse.stats().dropped).toBeGreaterThan(0)
    // grammY unwraps `{ok:true, result:true}` to the `true` an edit resolves to.
    expect(results).toEqual([true, true, true])
  })

  it('the activity-summary drain records ZERO failures and logs no "drain failed" line', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { lane, fuse } = makeFusedLane(DROPPING_FUSE)
    const turn = makeLaneTurn(lane)

    // Open the card, then repaint it past the cosmetic ceiling so the fuse drops.
    lane.showNarrativeStep(turn, 'Step one of the work')
    await turn.activityInFlight
    for (let i = 2; i <= 6; i++) {
      lane.showNarrativeStep(turn, `Step ${i} of the work`)
      await turn.activityInFlight
      await settle()
    }

    expect(fuse.stats().dropped + fuse.stats().superseded).toBeGreaterThan(0)
    // The counter that flags the turn DEGRADED at turn-end. Pre-fix this reached
    // the number of dropped repaints (observed: 8 on a real turn).
    expect(turn.activityDrainFailures).toBe(0)
    const lines = stderr.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('drain failed'))).toEqual([])
  })
})

describe('edit-flood fuse — a terminal card render is never shed', () => {
  it('the lane submits the finalize above `cosmetic`, at a class the fuse will not shed', async () => {
    // REGRESSION PIN. `useful` and `critical` are the only classes above
    // `cosmetic` (`outbound-class.ts` / `retry-api-call.ts` `priorityClass`);
    // the finalize takes `useful` — it may be DEFERRED, but the fuse's
    // cosmetic-only per-message/per-chat ceilings and the R1 drop path do not
    // apply to it. Live repaints staying `cosmetic` is correct and unchanged.
    const { lane, submitted } = makeFusedLane({ enabled: false })
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Doing the work now')
    await turn.activityInFlight
    lane.clearActivitySummary(turn)
    await settle()

    const drain = submitted.filter((s) => s.verb === 'activity-summary.edit')
    const finalize = submitted.filter((s) => s.verb === 'activity-summary.finalize')
    expect(finalize.length).toBeGreaterThanOrEqual(1)
    for (const f of finalize) expect(f.priorityClass).toBe('useful')
    // The live repaints are deliberately still sheddable.
    for (const d of drain) expect(d.priorityClass).toBe('cosmetic')
  })

  it('the fuse LATE-RELEASES a lone terminal frame at the deadline instead of freezing the card', async () => {
    // R1 on the per-MESSAGE tier. One `useful` edit fills the per-message
    // window; the terminal frame that follows is over budget, is the ONLY frame
    // in flight for its message (nothing newer will ever repaint it), and must
    // therefore be released late rather than dropped.
    const { api, landed, fuse } = makeFusedApi({
      perMessageMaxPerWindow: 1,
      perMessageWindowMs: 60_000,
      maxDeferMs: 20,
    })
    await withOutboundClass('useful', () => api.editMessageText(CHAT, 77, { markdown: 'live frame' }))
    // Nothing else is in flight for message 77 — this is the card's last frame.
    const res = await withOutboundClass('useful', () =>
      api.editMessageText(CHAT, 77, { markdown: 'TERMINAL ✅ done' }),
    )

    // Pre-fix this frame was dropped at the deadline (`dropGuard: undefined` on
    // the per-message tier), so it never reached the API and the card stayed on
    // "live frame" forever — and, via the envelope defect, the caller saw a
    // synthetic transport error on top.
    expect(landed.map((l) => l.text)).toEqual(['live frame', 'TERMINAL ✅ done'])
    expect(res).toBe(true)
    expect(fuse.stats().dropped).toBe(0)
  })

  it('a superseded frame is still dropped — R1 does not disable last-write-wins', async () => {
    // The guard is a DEADLINE guard only. A genuinely newer frame for the same
    // message must still kill the older waiter, or the fix would turn the
    // per-message tier into an unbounded queue.
    const { api, landed, fuse } = makeFusedApi({
      perMessageMaxPerWindow: 1,
      perMessageWindowMs: 60_000,
      maxDeferMs: 5_000,
    })
    await withOutboundClass('cosmetic', () => api.editMessageText(CHAT, 88, { markdown: 'v1' }))
    const stale = withOutboundClass('cosmetic', () => api.editMessageText(CHAT, 88, { markdown: 'v2' }))
    await settle()
    const newest = withOutboundClass('cosmetic', () => api.editMessageText(CHAT, 88, { markdown: 'v3' }))
    // Both settle without throwing; the stale one simply never painted.
    await expect(stale).resolves.toBe(true)
    await settle()
    expect(fuse.stats().superseded).toBeGreaterThan(0)
    expect(landed.map((l) => l.text)).toEqual(['v1'])
    // Release the still-waiting newest frame so the test does not leak a timer.
    void newest.catch(() => {})
  })
})
