/**
 * P8 PR-A — Turn-lifecycle CHARACTERIZATION HARNESS (#2996 P8).
 *
 * The functional net for the turn-END funnel + the two idle-only sweeps, and
 * the PARITY ORACLE for the eventual PR-E cutover (`endTurn(reason)` behind
 * SWITCHROOM_TURN_END_FUNNEL_V2). Every P8 extraction PR (PR-B..PR-E) must keep
 * this file green — a moved funnel edge that changes the shadow-event sequence,
 * a dropped map purge, an un-closed obligation, a skipped buffer drain, or the
 * lost pending-restart drain all fail here BEFORE they ship.
 *
 * HOW IT WORKS — the real funnel bodies execute (`endCurrentTurnAtomic`,
 * `purgeReactionTracking`, `releaseTurnBufferGate`, `armNoReplyDrainTimer`) and
 * we spy ONLY at the Deps boundary — the exact collaborators a later
 * `TurnEndDeps` injects:
 *   - inbound-delivery-machine-shadow.js → `shadowEmit` (L1, folded): the spy
 *     records the `turnEnd` shadow-event SEQUENCE (kind/key/outboundEmitted) per
 *     case. This IS the PR-E parity oracle — an assertion, not an aspiration.
 *     `isMachineInTurn` stays the REAL (idle) machine; the turn-in-flight gate is
 *     driven deterministically via the `pendingPermissions` leg instead.
 *   - node:child_process → `spawn` (case 8 / M2): observes the queued
 *     self-restart actually firing at turn-complete (legacy systemctl path).
 *   - a fake `ipcServer` (seam-injected) whose `sendToAgent` records buffer
 *     drains — the deliver-vs-hold oracle for the serialize gate.
 *
 * The turn atom is registered through the SANCTIONED keyed writer
 * (`setCurrentTurn`), never a raw `currentTurn =` — so the funnel's
 * keyed-liveness guard (`turnLiveForItsTopic`) sees the live turn and the PR-4e
 * accessor guard is respected.
 *
 * F2 (P7, binds here) — `_ENABLED` / drain-window flags are module-level consts
 * captured at import, so env is set BEFORE the dynamic import below. This file
 * pins the default-ON behaviour (obligation ledger on, serialize-until-replied
 * on); PR-E drives the funnel flag in a separate worker with its env pre-set.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Fixtures / identity ────────────────────────────────────────────────
const SELF_AGENT = 'chartestagent'
const DM_CHAT = '222'

// ─── Env BEFORE import (F2: flags are const-captured at module load) ─────
const stateDir = mkdtempSync(join(tmpdir(), 'turn-lifecycle-char-'))
process.env.TELEGRAM_STATE_DIR = stateDir
process.env.SWITCHROOM_AGENT_STATE_DIR = stateDir
process.env.SWITCHROOM_AGENT_NAME = SELF_AGENT
// Keep the bounded no-reply drain small so case 2 can advance fake timers to it
// without a multi-second real wait. (Set here so the const capture picks it up.)
process.env.SWITCHROOM_SERIALIZE_NOREPLY_DRAIN_MS = '2500'
// NOT docker → triggerSelfRestart takes the legacy `spawn(systemctl …)` path,
// which the child_process mock intercepts (case 8). A docker path would
// `process.kill(1, 'SIGTERM')` — never do that in a test runner.
delete process.env.SWITCHROOM_RUNTIME
// This harness pins the LEGACY turn-END funnel arm. Now that
// SWITCHROOM_TURN_END_FUNNEL_V2 defaults ON (`!== '0'`), pin it to '0' here so
// a standalone run exercises the legacy path. Use `??=` so the PR-E v2 wrapper
// (turn-lifecycle-characterization-v2.test.ts sets `='1'` then re-imports THIS
// file) is NOT clobbered — only a standalone run defaults to '0'.
process.env.SWITCHROOM_TURN_END_FUNNEL_V2 ??= '0'

// ─── Deps-boundary spies ────────────────────────────────────────────────
// The turnEnd shadow-event SEQUENCE oracle (L1). Each entry mirrors the exact
// `shadowEmit({kind:'turnEnd', …})` payload the funnel emits.
type ShadowEvent = { kind: string; key?: string; outboundEmitted?: boolean }
const shadowEvents: ShadowEvent[] = []
const turnEnds = () => shadowEvents.filter((e) => e.kind === 'turnEnd')

vi.mock('../telegram-plugin/gateway/inbound-delivery-machine-shadow.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telegram-plugin/gateway/inbound-delivery-machine-shadow.js')>()
  return {
    ...actual,
    // Spy the emit at the boundary; the REAL machine (isMachineInTurn) is left
    // untouched and idle — the in-flight gate is driven via pendingPermissions.
    shadowEmit: (ev: ShadowEvent) => {
      shadowEvents.push(ev)
      return []
    },
  }
})

// spawn spy — the queued-self-restart observability point (M2 / case 8).
const spawnSpy = vi.fn(() => ({ unref: () => {} }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnSpy }
})

// Fake ipcServer sendToAgent — the buffer-drain observability point.
const ipcSends: unknown[] = []

beforeAll(() => {
  // Neutralize the fire-and-forget presentation egress the funnel tail attempts
  // (status-pin reconcile, typing-loop stop). Swallowed in the gateway; the
  // harness asserts WIRING, not presentation.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"result":{}}', { status: 200 })))
})

let gw: typeof import('../telegram-plugin/gateway/gateway.js')
let seam: any

beforeAll(async () => {
  gw = await import('../telegram-plugin/gateway/gateway.js')
  seam = gw.__inboundRouterTestSeam
  seam.setIpcServer({
    sendToAgent: (_agent: string, m: unknown) => {
      ipcSends.push(m)
      return true
    },
    broadcast: () => {},
  } as any)
})

beforeEach(() => {
  shadowEvents.length = 0
  ipcSends.length = 0
  spawnSpy.mockClear()
  seam.clearAllCurrentTurns()
  seam.activeStatusReactions.clear()
  seam.activeTurnStartedAt.clear()
  seam.activeReactionMsgIds.clear()
  seam.pendingPermissions.clear?.()
  seam.pendingRestarts.clear()
  seam.deliveryQueue.pending.clear()
  // Drain any buffered inbound a prior test left behind.
  for (const m of seam.pendingInboundBuffer.drain(SELF_AGENT)) void m
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Turn factory ───────────────────────────────────────────────────────
// A cast CurrentTurn carrying exactly the fields the turn-end funnel reads
// (status-surface log, emitTurnRecord, obligation close, timer clears, purge).
// narrativeGate is optional-chained in the funnel, so it can stay undefined.
let turnSeq = 0
function makeTurn(over: Partial<any> = {}): any {
  turnSeq += 1
  return {
    sessionChatId: DM_CHAT,
    sessionThreadId: undefined,
    sourceMessageId: null,
    startedAt: Date.now() - 1000,
    gatewayReceiveAt: Date.now() - 1000,
    turnId: `t-${turnSeq}`,
    replyCalled: false,
    finalAnswerDelivered: false,
    finalAnswerSubstantive: false,
    finalAnswerEverDelivered: false,
    answerDelivered: false,
    endedAt: null,
    firstPingAt: null,
    firstPingWasSubstantive: false,
    silentAnchorMessageId: null,
    silentAnchorText: '',
    capturedText: [],
    capturedBlockMeta: [],
    orphanedReplyTimeoutId: null,
    answerReadyFlushTimeoutId: null,
    noReplyDrainTimer: null,
    registryKey: null,
    lastAssistantMsgId: null,
    lastAssistantDone: false,
    toolCallCount: 0,
    labeledToolCount: 0,
    totalTokens: 0,
    activityMessageId: null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    deliveryOutcome: undefined,
    narrativeGate: undefined,
    ...over,
  }
}

function bufferedInbound(messageId: number): any {
  return {
    type: 'inbound',
    chatId: DM_CHAT,
    messageId,
    user: 'T',
    userId: 111,
    ts: Date.now(),
    text: `buffered ${messageId}`,
    meta: {},
  }
}

/** Register `turn` as the live turn for its topic (sanctioned keyed writer). */
function goLive(turn: any): string {
  const key = seam.statusKey(turn.sessionChatId, turn.sessionThreadId)
  seam.setCurrentTurn(turn, key)
  seam.activeStatusReactions.set(key, {})
  seam.activeTurnStartedAt.set(key, Date.now())
  return key
}

// ══════════════════════════════════════════════════════════════════════
describe('turn-lifecycle characterization — funnel (endCurrentTurnAtomic)', () => {
  it('case 1 — replied turn end: maps purged, obligation closed, buffer drained (turn-complete)', () => {
    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    const key = goLive(turn)
    seam.obligationLedger.openIfAbsent({
      originTurnId: turn.turnId, chatId: DM_CHAT, messageId: 1, text: 'q', openedAt: Date.now(),
    })
    seam.pendingInboundBuffer.push(SELF_AGENT, bufferedInbound(2))

    seam.endCurrentTurnAtomic(turn)

    // Maps purged.
    expect(seam.activeStatusReactions.has(key)).toBe(false)
    expect(seam.activeTurnStartedAt.has(key)).toBe(false)
    // Obligation closed (delivered a final answer).
    expect(seam.obligationLedger.isOpen(turn.turnId)).toBe(false)
    // Buffer drained (final answer delivered → serialize gate opens).
    expect(ipcSends.length).toBe(1)
    // Shadow-event oracle: exactly one turnEnd, outboundEmitted from replyCalled.
    expect(turnEnds()).toEqual([{ kind: 'turnEnd', key, at: expect.any(Number), outboundEmitted: true }])
  })

  it('case 2 — no-reply turn end: obligation stays open + grace; bounded drain timer arms and FIRES', () => {
    vi.useFakeTimers()
    const turn = makeTurn({ replyCalled: false, finalAnswerDelivered: false })
    goLive(turn)
    seam.obligationLedger.openIfAbsent({
      originTurnId: turn.turnId, chatId: DM_CHAT, messageId: 1, text: 'q', openedAt: Date.now(),
    })
    seam.pendingInboundBuffer.push(SELF_AGENT, bufferedInbound(2))

    seam.endCurrentTurnAtomic(turn)

    // Obligation NOT closed — a reply-less turn stays open for re-present (grace
    // clock stamped via noteTurnEnded).
    expect(seam.obligationLedger.isOpen(turn.turnId)).toBe(true)
    // Serialize gate held the drain (no final answer): nothing sent yet.
    expect(ipcSends.length).toBe(0)
    // The bounded no-reply escape hatch armed on the turn object.
    expect(turn.noReplyDrainTimer).not.toBeNull()

    // Advance to the bounded drain — the liveness guarantee fires.
    vi.advanceTimersByTime(2500)
    expect(ipcSends.length).toBe(1)
  })

  it('case 3 — wrong-turn end guard no-ops: a stale turn handle neither purges nor emits', () => {
    // The halt path's wrong-turn guard: endCurrentTurnAtomic on a turn that is
    // NOT the live turn for its topic returns null and touches nothing (the
    // keyed-liveness guard, funnel-scoped manifestation of the halt no-op).
    const live = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    const key = goLive(live)
    const stale = makeTurn({ turnId: 'stale', sessionChatId: DM_CHAT }) // same key, different object

    const ret = seam.endCurrentTurnAtomic(stale)

    expect(ret).toBeNull()
    expect(turnEnds()).toEqual([]) // no shadow turnEnd for a non-live turn
    expect(seam.activeStatusReactions.has(key)).toBe(true) // live turn's maps untouched
    expect(seam.activeTurnStartedAt.has(key)).toBe(true)
  })

  it('case 8 (M2) — a queued self-restart FIRES at turn-complete via the purge tail', () => {
    seam.pendingRestarts.set(SELF_AGENT, Date.now())
    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    goLive(turn)

    seam.endCurrentTurnAtomic(turn)

    // Drained at idle: the entry is consumed and the restart spawned.
    expect(seam.pendingRestarts.size).toBe(0)
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(String(spawnSpy.mock.calls[0]?.[1])).toContain('systemctl')
  })

  it('case 8 (M2) — the queued restart DEFERS while a turn is in flight (gate busy)', () => {
    // pendingPermissions makes turnInFlightForGate() true → the idle-only
    // restart tail is skipped; the entry survives for the next idle boundary.
    seam.pendingPermissions.set('k', { at: Date.now() } as any)
    seam.pendingRestarts.set(SELF_AGENT, Date.now())
    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    goLive(turn)

    seam.endCurrentTurnAtomic(turn)

    expect(seam.pendingRestarts.size).toBe(1) // deferred, not drained
    expect(spawnSpy).not.toHaveBeenCalled()
    seam.pendingPermissions.clear?.()
  })
})

describe('turn-lifecycle characterization — releaseTurnBufferGate (first reply)', () => {
  it('case 7 — first-reply gate release deletes activeTurnStartedAt and drains', () => {
    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    const key = goLive(turn)
    seam.pendingInboundBuffer.push(SELF_AGENT, bufferedInbound(2))

    seam.releaseTurnBufferGate(key, turn)

    expect(seam.activeTurnStartedAt.has(key)).toBe(false)
    // Reaction controller stays (only the buffer gate flips — #1718 contract).
    expect(seam.activeStatusReactions.has(key)).toBe(true)
    expect(ipcSends.length).toBe(1)
    expect(turnEnds()).toEqual([{ kind: 'turnEnd', key, at: expect.any(Number), outboundEmitted: true }])
  })
})

describe('turn-lifecycle characterization — fallback purge (silence-poke framework fallback)', () => {
  it('case 6 — fallback purge (no ending turn) clears the maps and emits a turnEnd', () => {
    const key = seam.statusKey(DM_CHAT, undefined)
    seam.activeStatusReactions.set(key, {})
    seam.activeTurnStartedAt.set(key, Date.now())

    // The silence-poke framework fallback calls purgeReactionTracking(fbKey)
    // WITHOUT an ending-turn handle — the abnormal turn-end shape.
    seam.purgeReactionTracking(key)

    expect(seam.activeStatusReactions.has(key)).toBe(false)
    expect(seam.activeTurnStartedAt.has(key)).toBe(false)
    // outboundEmitted falls back to currentTurn?.replyCalled (null → false).
    expect(turnEnds()).toEqual([{ kind: 'turnEnd', key, at: expect.any(Number), outboundEmitted: false }])
  })
})

describe('turn-lifecycle characterization — PR-E ghost-clears (M1: atom-clear ONLY)', () => {
  for (const reason of ['phantom-ttl-clear', 'bridge-died-clear'] as const) {
    it(`case 9 — '${reason}' clears the turn atom and does NOTHING else (no shadow turnEnd, no obligation close, no drain)`, () => {
      const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
      const key = goLive(turn)
      seam.obligationLedger.openIfAbsent({
        originTurnId: turn.turnId, chatId: DM_CHAT, messageId: 1, text: 'q', openedAt: Date.now(),
      })
      seam.pendingInboundBuffer.push(SELF_AGENT, bufferedInbound(2))

      seam.endTurn(reason)

      // The atom is cleared…
      expect(seam.getCurrentTurn()).toBeNull()
      // …and NOTHING else happened: the ghost-clear must not run the funnel.
      expect(turnEnds()).toEqual([])                                // no shadow turnEnd
      expect(seam.obligationLedger.isOpen(turn.turnId)).toBe(true)  // no obligation close
      expect(ipcSends.length).toBe(0)                               // no drain
      expect(seam.activeStatusReactions.has(key)).toBe(true)        // no map purge
      expect(seam.activeTurnStartedAt.has(key)).toBe(true)
      // Clean up for the next case.
      seam.pendingInboundBuffer.drain(SELF_AGENT)
      seam.obligationLedger.close(turn.turnId)
    })
  }
})

describe('turn-lifecycle characterization — idle-only sweeps (P0c gate: tick body only)', () => {
  it('case 4 — delivery-confirm sweep: a stranded entry is HELD mid-turn, redelivered at idle', async () => {
    // LOAD-BEARING both ways (P8 M-1): the queue holds a genuinely stranded
    // entry (lastAttemptAt=0 → past any confirm timeout), so the mid-turn leg
    // proves the idle gate SUPPRESSED a redelivery that was otherwise due —
    // deleting `if (!getCurrentTurnNull()) return` in delivery-confirm-wiring
    // reds this test (mutation-verified). The idle leg then proves the same
    // entry IS redelivered once the turn atom clears.
    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    goLive(turn) // currentTurn != null → the idle gate must suppress redelivery
    const strandedKey = seam.statusKey(DM_CHAT, undefined)
    const stranded = bufferedInbound(55)
    seam.deliveryQueue.pending.set(strandedKey, {
      key: strandedKey,
      inbound: stranded,
      messageId: '55',
      lastAttemptAt: 0, // stranded long past DELIVERY_CONFIRM_TIMEOUT_MS
    })

    seam.runDeliveryConfirmSweep()

    // Mid-turn: NOT redelivered (the documented mid-turn wedge guard) and the
    // entry's attempt clock untouched — the gate returned BEFORE the queue sweep.
    expect(ipcSends.length).toBe(0)
    expect(seam.deliveryQueue.pending.get(strandedKey)?.lastAttemptAt).toBe(0)

    // Clear the live turn → idle → the SAME stranded entry is redelivered.
    seam.clearAllCurrentTurns()
    seam.runDeliveryConfirmSweep()
    // redeliverStrandedInbound awaits a dynamic import before sendToAgent.
    await vi.waitFor(() => expect(ipcSends.length).toBe(1), { timeout: 5000 })
    expect((ipcSends[0] as any).messageId).toBe(55)
    seam.deliveryQueue.pending.delete(strandedKey)
  })

  it('case 5 — obligation sweep: an over-grace obligation is SUPPRESSED mid-turn, re-presented at idle', () => {
    // LOAD-BEARING both ways (P8 M-1): the ledger holds an open obligation past
    // every grace window (opened 30 min ago > the 20 min background-work
    // ceiling, handling turn ended 10 min ago > the 45s escalate grace, never
    // re-presented), so the mid-turn leg proves the idle gate SUPPRESSED a
    // represent that was otherwise due — deleting `if (turnInFlightForGate())
    // return` in obligation-wiring reds this test (mutation-verified). The
    // idle leg then proves the sweep DOES re-present it (a represent inbound
    // pushed into the offline buffer).
    const now = Date.now()
    const originTurnId = 'oblig-sweep-case5'
    seam.obligationLedger.openIfAbsent({
      originTurnId, chatId: DM_CHAT, messageId: 9, text: 'unanswered q', openedAt: now - 30 * 60_000,
    })
    seam.obligationLedger.noteTurnEnded(originTurnId, now - 10 * 60_000)

    // Turn in flight (driven via the pendingPermissions leg of
    // turnInFlightForGate, same as case 8): the sweep must do nothing.
    seam.pendingPermissions.set('k5', { at: now, cards: [] } as any)
    seam.obligationSweep()
    expect(seam.pendingInboundBuffer.depth(SELF_AGENT)).toBe(0)
    expect(seam.obligationLedger.isOpen(originTurnId)).toBe(true)

    // Idle → the sweep re-presents: the represent inbound lands in the buffer
    // and the obligation stays open awaiting the real answer.
    seam.pendingPermissions.clear?.()
    seam.obligationSweep()
    const drained = seam.pendingInboundBuffer.drain(SELF_AGENT)
    expect(drained.length).toBe(1)
    expect(drained[0].meta?.source).toBe('obligation_represent')
    expect(drained[0].meta?.origin_turn_id).toBe(originTurnId)
    expect(seam.obligationLedger.isOpen(originTurnId)).toBe(true)
    // Clean up for later cases.
    seam.obligationLedger.close(originTurnId)
  })
})

describe('turn-lifecycle characterization — the turn record lands in THIS test\'s state dir', () => {
  // The leak this pins: `emitTurnRecord` hard-coded `/state/agent/turns.jsonl`,
  // so THIS harness — which drives the real turn-end funnel with
  // SWITCHROOM_AGENT_NAME=chartestagent — appended its synthetic rows into the
  // production turn record of whichever agent container it ran in, even though
  // it had isolated SWITCHROOM_AGENT_STATE_DIR into a tmpdir. The fleet-health
  // L0 sensor then scored those rows as that agent's real production turns
  // (356 foreign rows on disk, 267 of 377 live silent-no-op candidates).
  //
  // Self-driving (does not lean on the cases above), so it fails on the bug
  // whatever order or filter it runs under.
  it('emitTurnRecord writes turns.jsonl under SWITCHROOM_AGENT_STATE_DIR, stamped with this agent', () => {
    const turnsPath = join(stateDir, 'turns.jsonl')
    const before = existsSync(turnsPath) ? readFileSync(turnsPath, 'utf-8') : ''

    const turn = makeTurn({ replyCalled: true, finalAnswerDelivered: true })
    goLive(turn)
    seam.endCurrentTurnAtomic(turn)

    expect(
      existsSync(turnsPath),
      `no turns.jsonl in the isolated state dir (${stateDir}) — the writer ignored ` +
        'SWITCHROOM_AGENT_STATE_DIR and wrote to a live agent state dir instead',
    ).toBe(true)
    const added = readFileSync(turnsPath, 'utf-8').slice(before.length).trim().split('\n')
    expect(added.length).toBeGreaterThanOrEqual(1)
    const rec = JSON.parse(added[added.length - 1])
    expect(rec.agent).toBe(SELF_AGENT)
    expect(rec.turn_id).toBe(turn.turnId)
  })
})
