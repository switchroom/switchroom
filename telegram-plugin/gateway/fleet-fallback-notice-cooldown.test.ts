import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetFleetFallbackNoticeCooldowns,
  shouldSendAllBlockedNotice,
  shouldSendStrictPinnedNotice,
} from './fleet-fallback-notice-cooldown.js'

const COOLDOWN_MS = 30 * 60_000
// Realistic wall-clock base: the initial state is { lastSentAtMs: 0 }, so the
// first call only "sends" when `now` is at least COOLDOWN_MS past the epoch —
// always true for a real Date.now(), so anchor the fakes there too.
const BASE = 1_700_000_000_000

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  return { lines, restore: () => spy.mockRestore() }
}

afterEach(() => {
  // Reset the module-scope windows so each test starts from a clean gate.
  resetFleetFallbackNoticeCooldowns()
  vi.restoreAllMocks()
})

describe('fleet-fallback notice cooldown gates', () => {
  it('sends the first all-blocked card and suppresses a repeat inside the window', () => {
    const { lines, restore } = captureStderr()
    const t0 = BASE
    expect(shouldSendAllBlockedNotice('agentA', t0)).toBe(true)
    // Re-fire well inside the 30-min window: suppressed, with the exact log text.
    expect(shouldSendAllBlockedNotice('agentA', t0 + 60_000)).toBe(false)
    expect(lines).toEqual([
      'telegram gateway: [fleet-fallback] all-blocked card suppressed (cooldown) agent=agentA\n',
    ])
    // After the window elapses, it sends again.
    expect(shouldSendAllBlockedNotice('agentA', t0 + COOLDOWN_MS)).toBe(true)
    restore()
  })

  it('sends the first strict-pinned card and suppresses a repeat inside the window', () => {
    const { lines, restore } = captureStderr()
    const t0 = BASE + 100_000_000
    expect(shouldSendStrictPinnedNotice('agentB', t0)).toBe(true)
    expect(shouldSendStrictPinnedNotice('agentB', t0 + 60_000)).toBe(false)
    expect(lines).toEqual([
      'telegram gateway: [fleet-fallback] strict-pinned card suppressed (cooldown) agent=agentB\n',
    ])
    restore()
  })

  it('keeps the two windows independent — a strict card never suppresses an all-blocked', () => {
    const t0 = BASE + 200_000_000
    expect(shouldSendStrictPinnedNotice('agentC', t0)).toBe(true)
    // All-blocked has its own window and is unaffected by the strict send above.
    expect(shouldSendAllBlockedNotice('agentC', t0 + 1000)).toBe(true)
  })

  it('reset re-arms both windows so a post-recovery transition emits promptly', () => {
    const t0 = BASE + 300_000_000
    expect(shouldSendAllBlockedNotice('agentD', t0)).toBe(true)
    expect(shouldSendStrictPinnedNotice('agentD', t0)).toBe(true)
    // A successful swap resets both windows.
    resetFleetFallbackNoticeCooldowns()
    // Immediately after reset, both send again despite being inside the window.
    expect(shouldSendAllBlockedNotice('agentD', t0 + 1000)).toBe(true)
    expect(shouldSendStrictPinnedNotice('agentD', t0 + 1000)).toBe(true)
  })
})
