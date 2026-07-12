/**
 * Unit tests for telegram-plugin/gateway/bridge-dead-watchdog.ts (#3038).
 *
 * The contract under test (vitest — pure module, injected timers/fs/clock):
 *
 *   - bridge re-registers inside the grace window → timer cancelled, no
 *     escalation;
 *   - no re-register + live claude session → exactly ONE escalation with
 *     reason 'bridge-dead-resume', marker written, crash-log tail quoted
 *     in the audit line;
 *   - a second miss in the same gateway boot (disconnect after the fuse
 *     blew) → no second escalation;
 *   - mid-shutdown → skip, no escalation;
 *   - claude session not alive → retry (re-arm), no escalation;
 *   - cross-boot damper: marker carries a consecutive count; at the cap
 *     the watchdog stands down (no restart loop for a deterministically
 *     failing bridge); a registration this boot breaks the streak; the
 *     retry boot gets a doubled grace window;
 *   - cron / anonymous identities neither satisfy nor re-arm the watchdog
 *     (gating INSIDE noteBridge*, refactor-proof);
 *   - readFreshCrashLogTail freshness filtering;
 *   - consumeBridgeDeadEscalationMarker fresh/stale/always-clears + count
 *     round-trip;
 *   - resume-inbound builders surface restartCause honestly (text note +
 *     meta.restart_cause) without changing meta.source;
 *   - idle notice inbound (no turn in flight) carries the honest cause.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBridgeDeadWatchdog,
  decideBridgeDeadEscalation,
  readFreshCrashLogTail,
  writeBridgeDeadEscalationMarker,
  consumeBridgeDeadEscalationMarker,
  buildBridgeDeadIdleNoticeInbound,
  BRIDGE_DEAD_RESTART_REASON,
  MAX_CONSECUTIVE_ESCALATIONS,
  type BridgeDeadWatchdogOpts,
  type BridgeDeadEscalationMarker,
} from '../gateway/bridge-dead-watchdog.js'
import {
  buildResumeInterruptedInbound,
  buildResumeWatchdogReportInbound,
  buildResumeDeferredReportInbound,
} from '../gateway/resume-inbound-builder.js'
import type { Turn } from '../registry/turns-schema.js'

const AGENT = 'clerk'

// ─── Manual timer harness ────────────────────────────────────────────────────

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
}

function makeTimerHarness() {
  const timers: FakeTimer[] = []
  return {
    timers,
    setTimer: (fn: () => void, ms: number): unknown => {
      const t: FakeTimer = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h: unknown): void => {
      ;(h as FakeTimer).cleared = true
    },
    /** Fire the most recent un-cleared timer (the armed grace window). */
    fireLatest(): void {
      const live = timers.filter((t) => !t.cleared)
      const t = live[live.length - 1]
      if (!t) throw new Error('no live timer to fire')
      t.cleared = true
      t.fn()
    },
    liveCount(): number {
      return timers.filter((t) => !t.cleared).length
    },
    latestMs(): number {
      const live = timers.filter((t) => !t.cleared)
      const t = live[live.length - 1]
      if (!t) throw new Error('no live timer')
      return t.ms
    },
  }
}

function makeWatchdog(overrides: Partial<BridgeDeadWatchdogOpts> = {}) {
  const harness = makeTimerHarness()
  const escalations: string[] = []
  const logs: string[] = []
  const markers: Array<{ path: string; marker: BridgeDeadEscalationMarker }> = []
  const state = { sessionAlive: true, shuttingDown: false, escalateResult: true }
  const wd = createBridgeDeadWatchdog({
    graceMs: 90_000,
    // The gateway serves AGENT — only AGENT's own bridge drives the
    // watchdog (#3086). Overridable per-test.
    selfAgentName: AGENT,
    isSessionAlive: () => state.sessionAlive,
    isShuttingDown: () => state.shuttingDown,
    escalate: (reason) => {
      escalations.push(reason)
      return state.escalateResult
    },
    crashLogPath: '/nonexistent/bridge-crash.log',
    markerPath: '/nonexistent/bridge-dead-escalation.json',
    log: (l) => logs.push(l),
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
    nowMs: () => 1_000_000,
    writeMarker: (path, marker) => markers.push({ path, marker }),
    readCrashTail: () => null,
    ...overrides,
  })
  return { wd, harness, escalations, logs, markers, state }
}

// ─── Pure decision table ─────────────────────────────────────────────────────

describe('decideBridgeDeadEscalation', () => {
  const base = {
    bridgeRegistered: false,
    bridgeEverRegistered: false,
    sessionAlive: true,
    shuttingDown: false,
    alreadyEscalated: false,
    priorStreak: 0,
    maxConsecutive: MAX_CONSECUTIVE_ESCALATIONS,
  }
  it('escalates when bridge missing, session alive, not shutting down, first time', () => {
    expect(decideBridgeDeadEscalation(base)).toEqual({ action: 'escalate' })
  })
  it('a registered bridge always wins', () => {
    expect(decideBridgeDeadEscalation({ ...base, bridgeRegistered: true })).toEqual({
      action: 'skip',
      why: 'bridge-registered',
    })
  })
  it('mid-shutdown skips even with a dead bridge', () => {
    expect(decideBridgeDeadEscalation({ ...base, shuttingDown: true })).toEqual({
      action: 'skip',
      why: 'shutting-down',
    })
  })
  it('once-per-boot fuse skips a second fire', () => {
    expect(decideBridgeDeadEscalation({ ...base, alreadyEscalated: true })).toEqual({
      action: 'skip',
      why: 'already-escalated',
    })
  })
  it('claude not alive → retry, never escalate', () => {
    expect(decideBridgeDeadEscalation({ ...base, sessionAlive: false })).toEqual({
      action: 'retry',
      why: 'session-not-alive',
    })
  })
  it('cross-boot streak at the cap → streak-capped skip', () => {
    expect(
      decideBridgeDeadEscalation({ ...base, priorStreak: MAX_CONSECUTIVE_ESCALATIONS }),
    ).toEqual({ action: 'skip', why: 'streak-capped' })
  })
  it('streak below the cap still escalates', () => {
    expect(decideBridgeDeadEscalation({ ...base, priorStreak: 1 })).toEqual({
      action: 'escalate',
    })
  })
  it('a registration THIS boot breaks the streak (new incident)', () => {
    expect(
      decideBridgeDeadEscalation({
        ...base,
        bridgeEverRegistered: true,
        priorStreak: MAX_CONSECUTIVE_ESCALATIONS + 3,
      }),
    ).toEqual({ action: 'escalate' })
  })
})

// ─── Watchdog controller ─────────────────────────────────────────────────────

describe('createBridgeDeadWatchdog', () => {
  it('bridge re-registers in time → timer cancelled, no escalation', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    expect(harness.liveCount()).toBe(1)
    wd.noteBridgeRegistered(AGENT)
    expect(harness.liveCount()).toBe(0) // grace timer cancelled
    expect(escalations).toEqual([])
    expect(wd.hasEscalated()).toBe(false)
  })

  it('registered bridge at expiry → skip (defensive: timer fired anyway)', () => {
    const { wd, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(AGENT)
    // Even if check() runs somehow, the registered flag wins.
    expect(wd.check()).toEqual({ action: 'skip', why: 'bridge-registered' })
    expect(escalations).toEqual([])
  })

  it('no re-register + live session → exactly one escalation with the distinct reason', () => {
    const { wd, harness, escalations, logs, markers } = makeWatchdog()
    wd.arm()
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
    expect(wd.hasEscalated()).toBe(true)
    // Marker persisted for the honest resume + streak damper at next boot.
    expect(markers).toHaveLength(1)
    expect(markers[0].marker.reason).toBe(BRIDGE_DEAD_RESTART_REASON)
    expect(markers[0].marker.ts).toBe(1_000_000)
    expect(markers[0].marker.count).toBe(1) // first fire of a streak
    // Audit line is loud and names the reason.
    const audit = logs.find((l) => l.includes('ESCALATING'))
    expect(audit).toBeTruthy()
    expect(audit).toContain(`reason=${BRIDGE_DEAD_RESTART_REASON}`)
    expect(audit).toContain('no fresh bridge-crash.log entries')
  })

  it('includes the fresh crash-log tail in the audit line and the marker', () => {
    const { wd, harness, logs, markers } = makeWatchdog({
      readCrashTail: () => '2026-07-11T01:41:11.000Z uncaughtException pid=42 boom',
    })
    wd.arm()
    harness.fireLatest()
    const audit = logs.find((l) => l.includes('ESCALATING'))
    expect(audit).toContain('bridge-crash.log tail: 2026-07-11T01:41:11.000Z uncaughtException pid=42 boom')
    expect(markers[0].marker.crashTail).toContain('uncaughtException pid=42 boom')
  })

  it('second miss in the same boot → no second escalation (fuse)', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    harness.fireLatest()
    expect(escalations).toHaveLength(1)
    // The bridge briefly reconnects then dies again — disconnect re-arm is
    // a no-op after the fuse blew, and a direct check() skips.
    wd.noteBridgeDisconnected(AGENT)
    expect(harness.liveCount()).toBe(0) // fuse prevents re-arm
    expect(wd.check()).toEqual({ action: 'skip', why: 'already-escalated' })
    expect(escalations).toHaveLength(1)
  })

  it('mid-shutdown → skip, no escalation, no marker', () => {
    const { wd, harness, escalations, markers, state } = makeWatchdog()
    wd.arm()
    state.shuttingDown = true
    harness.fireLatest()
    expect(escalations).toEqual([])
    expect(markers).toEqual([])
    expect(wd.hasEscalated()).toBe(false)
  })

  it('claude session not alive → retry: re-arms, never escalates', () => {
    const { wd, harness, escalations, state } = makeWatchdog()
    state.sessionAlive = false
    wd.arm()
    harness.fireLatest()
    expect(escalations).toEqual([])
    expect(harness.liveCount()).toBe(1) // re-armed for another grace window
    // claude comes up but the bridge never registers → NOW it escalates.
    state.sessionAlive = true
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
  })

  it('bridge disconnect mid-life re-arms; a prompt reconnect stands it down', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(AGENT)
    expect(harness.liveCount()).toBe(0)
    wd.noteBridgeDisconnected(AGENT)
    expect(harness.liveCount()).toBe(1)
    wd.noteBridgeRegistered(AGENT)
    expect(harness.liveCount()).toBe(0)
    expect(escalations).toEqual([])
  })

  it('bridge disconnect mid-life with no reconnect → one escalation', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(AGENT)
    wd.noteBridgeDisconnected(AGENT)
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
  })

  it('a throwing marker writer does not block the escalation itself', () => {
    const { wd, harness, escalations, logs } = makeWatchdog({
      writeMarker: () => {
        throw new Error('disk full')
      },
    })
    wd.arm()
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
    expect(logs.some((l) => l.includes('escalation marker write failed'))).toBe(true)
  })

  it('stop() cancels the pending timer', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.stop()
    expect(harness.liveCount()).toBe(0)
    expect(escalations).toEqual([])
  })
})

// ─── Cross-boot restart-loop damper (#3038 review finding 1) ─────────────────

describe('cross-boot escalation streak damper', () => {
  it('priorStreak below the cap: escalates with an incremented count and doubled grace', () => {
    const { wd, harness, escalations, markers } = makeWatchdog({ priorStreak: 1 })
    wd.arm()
    expect(harness.latestMs()).toBe(180_000) // doubled window on the retry boot
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
    expect(markers[0].marker.count).toBe(2) // streak extended
  })

  it('priorStreak at the cap: arm() stands down loudly, no timer, no escalation', () => {
    const { wd, harness, escalations, logs } = makeWatchdog({
      priorStreak: MAX_CONSECUTIVE_ESCALATIONS,
    })
    wd.arm()
    expect(harness.liveCount()).toBe(0) // never armed — no restart loop
    expect(escalations).toEqual([])
    const standDown = logs.find((l) => l.includes('STANDING DOWN'))
    expect(standDown).toBeTruthy()
    expect(standDown).toContain('SWITCHROOM_BRIDGE_DEAD_ESCALATION=0') // kill-switch reminder
    // Even a direct check() cannot fire past the cap.
    expect(wd.check()).toEqual({ action: 'skip', why: 'streak-capped' })
    expect(escalations).toEqual([])
  })

  it('a successful registration this boot breaks the streak: escalation restarts at count=1', () => {
    const { wd, harness, escalations, markers } = makeWatchdog({
      priorStreak: MAX_CONSECUTIVE_ESCALATIONS,
    })
    // Bridge DID come back this boot — the old streak is over.
    wd.noteBridgeRegistered(AGENT)
    // …then it dies mid-life: this is a NEW incident and may escalate.
    wd.noteBridgeDisconnected(AGENT)
    expect(harness.liveCount()).toBe(1)
    expect(harness.latestMs()).toBe(90_000) // normal grace — streak broken
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
    expect(markers[0].marker.count).toBe(1)
  })
})

// ─── Identity gating inside the watchdog (#3038 review finding 5) ────────────

describe('cron / anonymous identity gating', () => {
  it('a cron-session bridge registering does NOT satisfy the watchdog', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(`${AGENT}-cron`)
    expect(harness.liveCount()).toBe(1) // still armed — cron is not the real bridge
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON]) // real bridge still dead
  })

  it('a cron-session bridge disconnecting does NOT re-arm (no bounce-after-cron-fire)', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(AGENT) // real bridge healthy
    expect(harness.liveCount()).toBe(0)
    wd.noteBridgeDisconnected(`${AGENT}-cron`) // cron teardown — irrelevant
    expect(harness.liveCount()).toBe(0)
    expect(escalations).toEqual([])
  })

  it('anonymous clients (agentName null/empty) are ignored on both paths', () => {
    const { wd, harness } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(null)
    wd.noteBridgeRegistered(undefined)
    wd.noteBridgeRegistered('')
    expect(harness.liveCount()).toBe(1) // none satisfied it
    wd.noteBridgeRegistered(AGENT)
    expect(harness.liveCount()).toBe(0)
    wd.noteBridgeDisconnected(null) // recall.py one-shot closing
    expect(harness.liveCount()).toBe(0) // did not re-arm
  })
})

// ─── #3086: secondary/relay identity gating ──────────────────────────────────
//
// Repro of the klanker incident: a short-lived `overlord-relay` IPC client
// registers and disconnects against klanker's gateway socket while klanker's
// OWN bridge is registered and actively replying. Pre-fix, isRealBridgeIdentity
// treated the relay (named, non-cron) as the real bridge, so its disconnect
// flipped bridgeRegistered=false, re-armed the grace window, and 90s later the
// watchdog SIGTERM'd a healthy container — killing the in-flight claude session.
describe('#3086 secondary/relay identity gating', () => {
  const RELAY = 'overlord-relay' // a DIFFERENT agent name than AGENT

  it('a relay disconnecting while the primary bridge is alive does NOT re-arm or escalate', () => {
    const { wd, harness, escalations } = makeWatchdog() // selfAgentName === AGENT
    wd.arm()
    wd.noteBridgeRegistered(AGENT) // klanker's own bridge — healthy
    expect(harness.liveCount()).toBe(0) // grace timer stood down
    // The relay connects then disconnects (flood-ban workaround churn).
    wd.noteBridgeRegistered(RELAY)
    wd.noteBridgeDisconnected(RELAY)
    // Must NOT re-arm: the primary bridge never went away.
    expect(harness.liveCount()).toBe(0)
    expect(escalations).toEqual([])
    expect(wd.hasEscalated()).toBe(false)
  })

  it('a relay register does NOT satisfy the watchdog (only the primary bridge does)', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(RELAY) // relay is not THIS gateway's bridge
    expect(harness.liveCount()).toBe(1) // still armed — primary still missing
    harness.fireLatest()
    // Primary bridge genuinely absent → the real failure still escalates.
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
  })

  it('a genuine PRIMARY bridge death still escalates (fix does not over-suppress)', () => {
    const { wd, harness, escalations } = makeWatchdog()
    wd.arm()
    wd.noteBridgeRegistered(AGENT) // primary registers
    expect(harness.liveCount()).toBe(0)
    wd.noteBridgeDisconnected(AGENT) // primary dies for good, never reconnects
    expect(harness.liveCount()).toBe(1) // re-armed
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
  })

  it('fallback: with no selfAgentName, any named non-cron client still counts (pre-#3086)', () => {
    const { wd, harness, escalations } = makeWatchdog({ selfAgentName: '' })
    wd.arm()
    wd.noteBridgeRegistered(RELAY) // no identity to match against → treated as real
    expect(harness.liveCount()).toBe(0) // satisfied the watchdog
    wd.noteBridgeDisconnected(RELAY)
    expect(harness.liveCount()).toBe(1) // re-armed
    harness.fireLatest()
    expect(escalations).toEqual([BRIDGE_DEAD_RESTART_REASON])
  })
})

// ─── Crash-log tail ──────────────────────────────────────────────────────────

describe('readFreshCrashLogTail', () => {
  const now = Date.parse('2026-07-11T02:00:00.000Z')
  it('returns only fresh entries, last N, joined', () => {
    const raw = [
      '2026-07-11T00:00:00.000Z uncaughtException pid=1 old entry',
      '2026-07-11T01:55:00.000Z uncaughtException pid=2 fresh one',
      '2026-07-11T01:59:00.000Z unhandledRejection pid=2 fresh two',
      'garbage line without timestamp',
      '',
    ].join('\n')
    const tail = readFreshCrashLogTail('/x', { nowMs: now, readFile: () => raw })
    expect(tail).toBe(
      '2026-07-11T01:55:00.000Z uncaughtException pid=2 fresh one || ' +
        '2026-07-11T01:59:00.000Z unhandledRejection pid=2 fresh two',
    )
  })
  it('null when file missing', () => {
    expect(
      readFreshCrashLogTail('/x', {
        nowMs: now,
        readFile: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
  })
  it('null when all entries are stale', () => {
    const raw = '2026-07-10T00:00:00.000Z uncaughtException pid=1 ancient\n'
    expect(readFreshCrashLogTail('/x', { nowMs: now, readFile: () => raw })).toBeNull()
  })
  it('caps to maxLines (most recent)', () => {
    const raw = [1, 2, 3, 4, 5]
      .map((i) => `2026-07-11T01:59:0${i}.000Z uncaughtException pid=${i} e${i}`)
      .join('\n')
    const tail = readFreshCrashLogTail('/x', {
      nowMs: now,
      readFile: () => raw,
      maxLines: 2,
    })
    expect(tail).toContain('e4')
    expect(tail).toContain('e5')
    expect(tail).not.toContain('e3')
  })
})

// ─── Escalation marker round-trip ────────────────────────────────────────────

describe('bridge-dead escalation marker', () => {
  it('fresh marker round-trips (incl. count) and is consumed (file removed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-dead-marker-'))
    const p = join(dir, 'bridge-dead-escalation.json')
    writeBridgeDeadEscalationMarker(p, {
      ts: 5_000,
      reason: BRIDGE_DEAD_RESTART_REASON,
      count: 2,
      crashTail: 'tail here',
    })
    const m = consumeBridgeDeadEscalationMarker(p, 6_000)
    expect(m).toEqual({
      ts: 5_000,
      reason: BRIDGE_DEAD_RESTART_REASON,
      count: 2,
      crashTail: 'tail here',
    })
    expect(existsSync(p)).toBe(false)
  })
  it('legacy marker without count is read as count=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-dead-marker-'))
    const p = join(dir, 'bridge-dead-escalation.json')
    writeFileSync(p, JSON.stringify({ ts: 5_000, reason: BRIDGE_DEAD_RESTART_REASON }), 'utf8')
    const m = consumeBridgeDeadEscalationMarker(p, 6_000)
    expect(m?.count).toBe(1)
  })
  it('stale marker is cleared and NOT surfaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-dead-marker-'))
    const p = join(dir, 'bridge-dead-escalation.json')
    writeBridgeDeadEscalationMarker(p, { ts: 0, reason: BRIDGE_DEAD_RESTART_REASON })
    const m = consumeBridgeDeadEscalationMarker(p, 60 * 60_000)
    expect(m).toBeNull()
    expect(existsSync(p)).toBe(false)
  })
  it('malformed marker is cleared without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-dead-marker-'))
    const p = join(dir, 'bridge-dead-escalation.json')
    writeFileSync(p, 'not json', 'utf8')
    expect(consumeBridgeDeadEscalationMarker(p, 1)).toBeNull()
    expect(existsSync(p)).toBe(false)
  })
  it('missing marker → null, no throw', () => {
    expect(consumeBridgeDeadEscalationMarker('/nonexistent/marker.json', 1)).toBeNull()
  })
  it('marker write is atomic-shaped (valid JSON on disk)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-dead-marker-'))
    const p = join(dir, 'm.json')
    writeBridgeDeadEscalationMarker(p, { ts: 1, reason: 'r', count: 1 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ts: 1, reason: 'r', count: 1 })
  })
})

// ─── Honest resume surfacing ─────────────────────────────────────────────────

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    turn_key: '100001:11',
    chat_id: '100001',
    thread_id: null,
    started_at: 1_000_000,
    ended_at: null,
    ended_via: 'restart',
    last_assistant_msg_id: null,
    last_assistant_done: null,
    last_user_msg_id: 11,
    user_prompt_preview: 'do the thing',
    tool_call_count: 2,
    interrupt_reason: null,
    resumed_at: null,
    ...overrides,
  } as Turn
}

describe('resume inbound restartCause surfacing (#3038)', () => {
  const cause = {
    reason: BRIDGE_DEAD_RESTART_REASON,
    note: 'The framework itself triggered this restart: your Telegram MCP bridge process had died.',
  }

  it('resume_interrupted carries meta.restart_cause + the honest note, source unchanged', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn(), nowMs: 2_000_000, restartCause: cause })
    expect(msg.meta?.source).toBe('resume_interrupted') // never masquerades as watchdog
    expect(msg.meta?.restart_cause).toBe(BRIDGE_DEAD_RESTART_REASON)
    expect(msg.text).toContain('Why this restart happened:')
    expect(msg.text).toContain('Telegram MCP bridge process had died')
  })

  it('watchdog report also carries the cause when one was recorded', () => {
    const msg = buildResumeWatchdogReportInbound({
      turn: makeTurn({ ended_via: 'timeout' }),
      idleMs: 300_000,
      nowMs: 2_000_000,
      restartCause: cause,
    })
    expect(msg.meta?.source).toBe('resume_watchdog_timeout')
    expect(msg.meta?.restart_cause).toBe(BRIDGE_DEAD_RESTART_REASON)
    expect(msg.text).toContain('Why this restart happened:')
  })

  it('deferred report also carries the cause', () => {
    const msg = buildResumeDeferredReportInbound({
      turn: makeTurn(),
      reason: 'loop-guard',
      nowMs: 2_000_000,
      restartCause: cause,
    })
    expect(msg.meta?.source).toBe('resume_deferred')
    expect(msg.meta?.restart_cause).toBe(BRIDGE_DEAD_RESTART_REASON)
    expect(msg.text).toContain('Why this restart happened:')
  })

  it('no restartCause → inbound unchanged (no meta key, no note)', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn(), nowMs: 2_000_000 })
    expect(msg.meta?.restart_cause).toBeUndefined()
    expect(msg.text).not.toContain('Why this restart happened:')
  })
})

// ─── Idle notice (#3038 review finding 2) ────────────────────────────────────

describe('buildBridgeDeadIdleNoticeInbound', () => {
  it('carries the honest cause to the default chat when no turn was in flight', () => {
    const msg = buildBridgeDeadIdleNoticeInbound({
      chatId: '100001',
      marker: { ts: 5_000, reason: BRIDGE_DEAD_RESTART_REASON, count: 1 },
      nowMs: 2_000_000,
    })
    expect(msg.type).toBe('inbound')
    expect(msg.chatId).toBe('100001')
    expect(msg.meta?.source).toBe('bridge_dead_restart')
    expect(msg.meta?.restart_cause).toBe(BRIDGE_DEAD_RESTART_REASON)
    expect(msg.meta?.chat_id).toBe('100001')
    expect(msg.text).toContain('MCP bridge process had died')
    expect(msg.text).toContain('No work was in flight')
    // Honesty rails: names what it was NOT.
    expect(msg.text).toContain('NOT an operator-initiated restart')
    expect(msg.text).toContain('NOT a hang-watchdog kill')
  })
})
