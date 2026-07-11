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

    // Open a global window.
    windows = [{ scopeKey: 'global', untilTs: 30_000, retryAfterSrc: '429', observedAt: 0 }]
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
