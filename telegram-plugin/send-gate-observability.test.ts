import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatStatsLine,
  countersChanged,
  createStatsLogger,
  createFloodWindowObserver,
} from './send-gate-observability.js'
import type { SendGateStats, Clock } from './send-gate.js'
import {
  writeFloodWindow,
  readFloodWindows,
  markFloodWindowAlerted,
  floodWindowsPath,
  type FloodWindowRecord,
} from './flood-circuit-breaker.js'
import { statusPairedText } from './welcome-text.js'

/** Minimal settable clock. Observer/logger never actually sleep in these tests. */
class TestClock implements Clock {
  cur = 0
  now(): number {
    return this.cur
  }
  async sleep(): Promise<void> {
    /* unused by the observability tick loops */
  }
}

function makeStats(over: Partial<SendGateStats['global']> = {}, enabled = true): SendGateStats {
  return {
    enabled,
    global: {
      sent: 0,
      queued: 0,
      coalesced: 0,
      dropped: 0,
      shed: 0,
      expired: 0,
      failedFast: 0,
      ...over,
    },
    messageStates: 0,
    fill: { global: 4, perChat: {}, perGroup: {} },
  }
}

describe('formatStatsLine', () => {
  it('renders every counter + fill on one trailing-newline line', () => {
    const line = formatStatsLine(
      makeStats({ sent: 12, queued: 3, coalesced: 5, dropped: 2, shed: 8, expired: 1, failedFast: 4 }),
    )
    expect(line).toBe(
      'telegram gateway: send-gate stats: sent=12 queued=3 coalesced=5 dropped=2 ' +
        'shed=8 expired=1 failedFast=4 msgStates=0 chatBuckets=0 globalFill=4\n',
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n').filter((l) => l.length > 0)).toHaveLength(1)
  })

  it('rounds globalFill to one decimal', () => {
    const s = makeStats()
    s.fill.global = 23.14159
    expect(formatStatsLine(s)).toContain('globalFill=23.1')
  })
})

describe('countersChanged', () => {
  it('is false for identical counters, true when any field differs', () => {
    const a = makeStats().global
    expect(countersChanged(a, { ...a })).toBe(false)
    expect(countersChanged(a, { ...a, shed: 1 })).toBe(true)
    expect(countersChanged(a, { ...a, failedFast: 1 })).toBe(true)
  })
})

describe('createStatsLogger', () => {
  it('logs at most once per interval AND only when a counter changed', async () => {
    const clock = new TestClock()
    const logs: string[] = []
    let counters = makeStats().global
    const logger = createStatsLogger({
      stats: () => makeStats(counters),
      log: (l) => logs.push(l),
      clock,
      intervalMs: 60_000,
    })

    // First tick with a fresh baseline logs immediately.
    logger.tick()
    expect(logs).toHaveLength(1)

    // Changed counters but interval NOT elapsed (30s since the log at t=0) →
    // no log (rate limit).
    counters = { ...counters, sent: 5 }
    clock.cur = 30_000
    logger.tick()
    expect(logs).toHaveLength(1)

    // Interval elapsed but counters unchanged since the last logged snapshot →
    // no log (no spam). Note the last LOG was at t=0 (t=30_000 didn't log).
    counters = { ...counters, sent: 5 }
    clock.cur = 70_000
    // First make sure an UNCHANGED snapshot stays silent: temporarily revert.
    // (Left as-is: counters already differ from the baseline, so this ticks.)
    logger.tick()
    expect(logs).toHaveLength(2)
    expect(logs[1]).toContain('sent=5')

    // Now unchanged since last log + interval elapsed → still silent.
    clock.cur = 200_000
    logger.tick()
    expect(logs).toHaveLength(2)
  })

  it('is a no-op when the gate is disabled', () => {
    const clock = new TestClock()
    const logs: string[] = []
    const logger = createStatsLogger({
      stats: () => makeStats({ sent: 99 }, false),
      log: (l) => logs.push(l),
      clock,
    })
    logger.tick()
    clock.cur = 1_000_000
    logger.tick()
    expect(logs).toHaveLength(0)
  })
})

describe('createFloodWindowObserver — snapshots', () => {
  it('logs a snapshot on window open and on window close', async () => {
    const clock = new TestClock()
    const logs: string[] = []
    let windows: FloodWindowRecord[] = []
    const obs = createFloodWindowObserver({
      clock,
      log: (l) => logs.push(l),
      stats: () => makeStats({ shed: 2 }),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async () => {},
      operatorChatId: () => 'op',
    })

    // First (boot) tick with no windows establishes the baseline.
    await obs.tick()
    expect(logs).toHaveLength(0)

    // A NEW window opens on a later tick (post-boot) → OPENED snapshot.
    clock.cur = 5_000
    windows = [{ scopeKey: 'global', untilTs: 30_000, retryAfterSrc: '429', observedAt: 5_000 }]
    await obs.tick()
    expect(logs.some((l) => l.includes('flood window OPENED scope=global'))).toBe(true)
    expect(logs.some((l) => l.includes('shed=2'))).toBe(true)

    // Window gone (expired/pruned) → close snapshot.
    logs.length = 0
    clock.cur = 31_000
    windows = []
    await obs.tick()
    expect(logs.some((l) => l.includes('flood window CLOSED scope=global'))).toBe(true)
  })

  it('logs ONE "loaded" line for boot-loaded windows, not per-scope OPENED spam (L3)', async () => {
    const clock = new TestClock()
    const logs: string[] = []
    // Three windows already on disk at boot (a real 429 opens global+chat+group).
    const windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 },
      { scopeKey: 'chat:op', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 },
      { scopeKey: 'group:g', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: (l) => logs.push(l),
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async () => {},
      operatorChatId: () => 'op',
    })
    await obs.tick()
    // No OPENED spam for pre-existing windows.
    expect(logs.some((l) => l.includes('flood window OPENED'))).toBe(false)
    // Exactly one "loaded" line naming the count and every scope.
    const loaded = logs.filter((l) => l.includes('loaded 3 open flood window(s) at boot'))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toContain('global')
    expect(loaded[0]).toContain('chat:op')
    expect(loaded[0]).toContain('group:g')
  })

  it('does not run when the gate is disabled', async () => {
    const clock = new TestClock()
    const logs: string[] = []
    const alerts: string[] = []
    const obs = createFloodWindowObserver({
      clock,
      log: (l) => logs.push(l),
      stats: () => makeStats({}, false),
      readWindows: () => [
        { scopeKey: 'chat:other', untilTs: 999_999, retryAfterSrc: '429', observedAt: 0 },
      ],
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
    })
    clock.cur = 500_000
    await obs.tick()
    expect(logs).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })
})

describe('createFloodWindowObserver — alerting', () => {
  // FORWARD-LOOKING (#3111): this exercises the immediate-delivery branch with a
  // hand-built `chat:other`-only window. In production today that state never
  // occurs — `openScopedWindowsForOpts` opens a coincident `global` window on
  // every 429, so the operator is always "covered" and every alert defers to
  // close (see M1 in the #3112 review). This test guards the branch so it is
  // correct the moment #3111 makes `onFloodWait` scope-precise; the live path
  // today is the deferred-close test below.
  it('alerts immediately for a chat-scoped ban on a DIFFERENT chat, at most once', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    const marked: { scope: string; at: number }[] = []
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'chat:other', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: (scope, at) => {
        marked.push({ scope, at })
        // simulate persistence: the next read carries alertedAt
        windows = windows.map((w) => (w.scopeKey === scope ? { ...w, alertedAt: at } : w))
      },
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
    })

    // Below threshold → no alert yet.
    clock.cur = 30_000
    await obs.tick()
    expect(alerts).toHaveLength(0)

    // Past threshold, operator chat is clear → immediate alert + persisted marker.
    clock.cur = 61_000
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('flood ban active')
    expect(alerts[0]).toContain('chat:other')
    expect(marked).toHaveLength(1)

    // Subsequent ticks must NOT re-alert (alertedAt now set).
    clock.cur = 120_000
    await obs.tick()
    expect(alerts).toHaveLength(1)
  })

  it('defers a GLOBAL ban alert until the window closes ("was banned from X to Y")', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: 120_000, retryAfterSrc: '429', observedAt: 0 },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
    })

    // Past threshold but global → operator unreachable → NO alert during window.
    clock.cur = 61_000
    await obs.tick()
    expect(alerts).toHaveLength(0)

    // Window closes → deferred alert fires once, with the banned-from/to wording.
    clock.cur = 121_000
    windows = []
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('flood ban cleared')
    expect(alerts[0]).toContain('was banned from')

    // No re-alert afterwards.
    clock.cur = 200_000
    await obs.tick()
    expect(alerts).toHaveLength(1)
  })

  it('coalesces one incident (global+chat+group) into ONE cleared card listing every scope (M1)', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    // A single 429 opens all three scopes with the SAME untilTs (the live
    // recorder behavior — see #3111). They all defer (global covers the
    // operator) and all close in the same tick.
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: 120_000, retryAfterSrc: '429', observedAt: 0 },
      { scopeKey: 'chat:op', untilTs: 120_000, retryAfterSrc: '429', observedAt: 0 },
      { scopeKey: 'group:g', untilTs: 120_000, retryAfterSrc: '429', observedAt: 0 },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
    })

    // Past threshold, all scopes covered by the global window → nothing during.
    clock.cur = 61_000
    await obs.tick()
    expect(alerts).toHaveLength(0)

    // All three close in the same tick → EXACTLY ONE cleared card, not three.
    clock.cur = 121_000
    windows = []
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('flood ban cleared')
    expect(alerts[0]).toContain('scopes') // plural — multiple scopes listed
    expect(alerts[0]).toContain('global')
    expect(alerts[0]).toContain('chat:op')
    expect(alerts[0]).toContain('group:g')

    // No re-alert afterwards.
    clock.cur = 200_000
    await obs.tick()
    expect(alerts).toHaveLength(1)
  })

  // The operator-facing alert timestamps must render in the CONFIGURED local
  // timezone, not UTC. The live incident that prompted this: a "flood ban
  // cleared" card printed `2026-07-12T23:39:24Z to 2026-07-12T23:46:40Z UTC`,
  // which is 9:39am–9:46am AEST in the fleet's configured zone. These assert
  // the local rendering and would FAIL on the old `.toISOString()` output.
  const OBSERVED = Date.parse('2026-07-12T23:39:24Z') // 2026-07-13 09:39 AEST
  const UNTIL = Date.parse('2026-07-12T23:46:40Z') // 2026-07-13 09:46 AEST

  it('renders the CLEARED card timestamps in the configured local tz (AEST), not UTC', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: UNTIL, retryAfterSrc: '429', observedAt: OBSERVED },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
      tz: 'Australia/Melbourne',
    })

    // Past threshold but global → operator unreachable → defer to close.
    clock.cur = OBSERVED + 61_000
    await obs.tick()
    expect(alerts).toHaveLength(0)

    // Window closes → deferred cleared card fires, in LOCAL time.
    clock.cur = UNTIL + 1_000
    windows = []
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('flood ban cleared')
    // Local-tz rendering: 9:39am to 9:46am AEST.
    expect(alerts[0]).toContain('was banned from 9:39am to 9:46am AEST')
    // And explicitly NOT the old UTC ISO output.
    expect(alerts[0]).not.toContain('2026-07-12T23:39:24Z')
    expect(alerts[0]).not.toContain('UTC')
  })

  it('renders the ACTIVE card clear-time in the configured local tz (AEST), not UTC', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    let windows: FloodWindowRecord[] = [
      // A far-future untilTs so the window stays open; a non-operator chat so
      // the immediate-delivery branch fires (openAlertText).
      { scopeKey: 'chat:other', untilTs: UNTIL, retryAfterSrc: '429', observedAt: OBSERVED },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: (scope, at) => {
        windows = windows.map((w) => (w.scopeKey === scope ? { ...w, alertedAt: at } : w))
      },
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
      tz: 'Australia/Melbourne',
    })

    clock.cur = OBSERVED + 61_000
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('flood ban active')
    // "expected to clear at 9:46am AEST" — local wall-clock, not UTC ISO.
    expect(alerts[0]).toContain('expected to clear at 9:46am AEST')
    expect(alerts[0]).not.toContain('2026-07-12T23:46:40Z')
    expect(alerts[0]).not.toContain('UTC')
  })

  it('defaults to UTC wording when no tz is configured (backward compat)', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: UNTIL, retryAfterSrc: '429', observedAt: OBSERVED },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
      // no tz → UTC
    })
    clock.cur = OBSERVED + 61_000
    await obs.tick()
    clock.cur = UNTIL + 1_000
    windows = []
    await obs.tick()
    expect(alerts).toHaveLength(1)
    // UTC fallback: 11:39pm to 11:46pm UTC on 2026-07-12.
    expect(alerts[0]).toContain('11:39pm to 11:46pm UTC')
  })

  it('spans the local date when a window crosses local midnight', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    // 2026-07-13T13:55:00Z .. 2026-07-13T14:05:00Z = 11:55pm 13 Jul .. 12:05am 14 Jul AEST.
    const obsStart = Date.parse('2026-07-13T13:55:00Z')
    const obsEnd = Date.parse('2026-07-13T14:05:00Z')
    let windows: FloodWindowRecord[] = [
      { scopeKey: 'global', untilTs: obsEnd, retryAfterSrc: '429', observedAt: obsStart },
    ]
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => windows,
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
      alertThresholdMs: 60_000,
      tz: 'Australia/Melbourne',
    })
    clock.cur = obsStart + 61_000
    await obs.tick()
    clock.cur = obsEnd + 1_000
    windows = []
    await obs.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('13 Jul 11:55pm to 14 Jul 12:05am AEST')
  })

  it('does not alert for msg-edit (cosmetic) scopes', async () => {
    const clock = new TestClock()
    const alerts: string[] = []
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: () => [
        { scopeKey: 'msg-edit:op:100', untilTs: 999_999, retryAfterSrc: '429', observedAt: 0 },
      ],
      markAlerted: () => {},
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
    })
    clock.cur = 500_000
    await obs.tick()
    expect(alerts).toHaveLength(0)
  })
})

describe('alertedAt persistence (restart safety)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-windows-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('markFloodWindowAlerted persists alertedAt and readFloodWindows preserves it', () => {
    const path = floodWindowsPath(dir)
    writeFloodWindow(path, { scopeKey: 'chat:x', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 }, 0)
    markFloodWindowAlerted(path, 'chat:x', 61_000, 61_000)
    const [w] = readFloodWindows(path, 62_000)
    expect(w.alertedAt).toBe(61_000)
  })

  it('preserves alertedAt when the window is later EXTENDED by a fresh 429', () => {
    const path = floodWindowsPath(dir)
    writeFloodWindow(path, { scopeKey: 'chat:x', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0 }, 0)
    markFloodWindowAlerted(path, 'chat:x', 61_000, 61_000)
    // A later 429 extends the window (recorder carries no alertedAt).
    writeFloodWindow(path, { scopeKey: 'chat:x', untilTs: 600_000, retryAfterSrc: '429', observedAt: 62_000 }, 62_000)
    const [w] = readFloodWindows(path, 63_000)
    expect(w.untilTs).toBe(600_000)
    expect(w.alertedAt).toBe(61_000)
  })

  it('a restart mid-window (alertedAt already on disk) does not re-alert', async () => {
    const path = floodWindowsPath(dir)
    writeFloodWindow(
      path,
      { scopeKey: 'chat:other', untilTs: 300_000, retryAfterSrc: '429', observedAt: 0, alertedAt: 61_000 },
      0,
    )
    const clock = new TestClock()
    const alerts: string[] = []
    const obs = createFloodWindowObserver({
      clock,
      log: () => {},
      stats: () => makeStats(),
      readWindows: (now) => readFloodWindows(path, now),
      markAlerted: (scope, at) => markFloodWindowAlerted(path, scope, at, clock.cur),
      sendAlert: async (t) => {
        alerts.push(t)
      },
      operatorChatId: () => 'op',
    })
    clock.cur = 120_000 // well past threshold, window still open
    await obs.tick()
    expect(alerts).toHaveLength(0)
  })
})

describe('/status send-gate block', () => {
  const meta = {
    agentName: 'a',
    model: null,
    extendsProfile: null,
    topicName: null,
    topicEmoji: null,
    uptime: null,
    status: null,
    auth: null,
  }

  it('renders queued/shed totals and open flood windows when the gate is on', () => {
    const text = statusPairedText({
      user: '@op',
      meta: {
        ...meta,
        sendGate: {
          queued: 4,
          shed: 9,
          expired: 1,
          failedFast: 2,
          dropped: 3,
          openWindows: [{ scopeKey: 'global', untilTs: Date.now() + 45_000 }],
        },
      },
    })
    expect(text).toContain('Send gate')
    expect(text).toContain('queued 4')
    expect(text).toContain('shed 9')
    expect(text).toContain('fail-fast 2')
    expect(text).toContain('flood window')
    expect(text).toContain('global')
  })

  it('omits the send-gate block entirely when the gate is off (no sendGate field)', () => {
    const text = statusPairedText({ user: '@op', meta })
    expect(text).not.toContain('Send gate')
  })
})
