import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readFloodWindows,
  writeFloodWindow,
  makeFloodWindowRecorder,
  loadInitialFloodWindows,
  floodWindowsPath,
  floodStatePath,
  writeFloodState,
  computeFloodWait,
} from '../flood-circuit-breaker.js'
import { createSendGate, type Clock } from '../send-gate.js'

/**
 * #3084 PR 2 — restart-proof SCOPED flood windows (part3-design §7). Verifies
 * the write-through/round-trip contract on real temp files (isolated per the
 * repo's vault/shared-state test discipline) and that a gate reconstructed from
 * disk is STILL blocked — the whole point of §7 (a boot mid-ban must not resend
 * into the open window).
 */
describe('#3084 scoped flood-window persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-win-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips a scoped window and prunes expired entries', () => {
    const path = floodWindowsPath(dir)
    const now = 1_000_000
    writeFloodWindow(path, { scopeKey: 'chat:5', untilTs: now + 60_000, retryAfterSrc: '429', observedAt: now }, now)
    writeFloodWindow(path, { scopeKey: 'global', untilTs: now + 10_000, retryAfterSrc: '429', observedAt: now }, now)

    // Before either expires: both present.
    const live = readFloodWindows(path, now + 5_000)
    expect(live.map((w) => w.scopeKey).sort()).toEqual(['chat:5', 'global'])

    // After the global one expires: only chat:5 survives (prune-on-read).
    const later = readFloodWindows(path, now + 20_000)
    expect(later.map((w) => w.scopeKey)).toEqual(['chat:5'])
  })

  it('EXTENDS never shortens a window on a later, shorter re-record (boot-never-shortens)', () => {
    const path = floodWindowsPath(dir)
    const now = 1_000_000
    // A long ban is recorded.
    writeFloodWindow(path, { scopeKey: 'global', untilTs: now + 600_000, retryAfterSrc: '429', observedAt: now }, now)
    // A later, SHORTER 429 (or a restart re-observing a smaller retry_after)
    // must not pull the expiry earlier.
    writeFloodWindow(
      path,
      { scopeKey: 'global', untilTs: now + 1_000 + 5_000, retryAfterSrc: '429', observedAt: now + 1_000 },
      now + 1_000,
    )
    const w = readFloodWindows(path, now + 2_000).find((x) => x.scopeKey === 'global')
    expect(w?.untilTs).toBe(now + 600_000)
  })

  it('loadInitialFloodWindows combines the global flood-wait.json window with scoped windows', () => {
    const now = 1_000_000
    const statePath = floodStatePath(dir)
    const winPath = floodWindowsPath(dir)
    writeFloodState(statePath, computeFloodWait(null, 300, now)) // global, +300s
    writeFloodWindow(winPath, { scopeKey: 'chat:9', untilTs: now + 120_000, retryAfterSrc: '429', observedAt: now }, now)

    const initial = loadInitialFloodWindows(statePath, winPath, now)
    const scopes = initial.map((w) => w.scopeKey).sort()
    expect(scopes).toEqual(['chat:9', 'global'])
    expect(initial.find((w) => w.scopeKey === 'global')?.untilTs).toBe(now + 300_000)
  })

  it('gate opens a window on a 429 → persists → a NEW gate built from disk is still blocked', async () => {
    const winPath = floodWindowsPath(dir)
    const statePath = floodStatePath(dir)
    const recorder = makeFloodWindowRecorder(winPath, () => 0)

    // Gate 1: a critical send hits a 429 (FLOOD_WAIT_ACTIVE) which opens +
    // persists scope windows via onWindowOpen.
    const clock1: Clock = { now: () => 0, sleep: () => Promise.resolve() }
    const gate1 = createSendGate({
      enabled: true,
      clock: clock1,
      onWindowOpen: (scopeKey, untilTs) => recorder(scopeKey, untilTs),
    })
    const floodErr = Object.assign(new Error('FLOOD_WAIT_ACTIVE'), {
      retryAfterSec: 600,
      untilTs: 600_000,
      error_code: 429 as const,
      parameters: { retry_after: 600 },
      original: null,
    })
    await expect(
      gate1.gate(
        async () => {
          throw floodErr
        },
        { chat_id: '7', priorityClass: 'critical' },
      ),
    ).rejects.toBe(floodErr)

    // The window is on disk.
    const persisted = readFloodWindows(winPath, 0)
    expect(persisted.map((w) => w.scopeKey).sort()).toEqual(['chat:7', 'global'])

    // Gate 2 (simulated restart): built BEFORE any outbound call from the
    // persisted windows. A cosmetic send on chat:7 must still shed.
    const clock2: Clock = { now: () => 0, sleep: () => Promise.resolve() }
    const gate2 = createSendGate({
      enabled: true,
      clock: clock2,
      initialWindows: loadInitialFloodWindows(statePath, winPath, 0),
    })
    const res = await gate2.gate(async () => 'should-not-run', {
      chat_id: '7',
      priorityClass: 'cosmetic',
    })
    expect(res).toBeUndefined()
    expect(gate2.stats().global.shed).toBe(1)

    // And a critical into the still-long window fails fast — restart did not
    // reset the ban.
    await expect(
      gate2.gate(async () => 'nope', { chat_id: '7', priorityClass: 'critical' }),
    ).rejects.toThrow('FLOOD_WAIT_ACTIVE')
  })

  it('a boot loading initial windows never shortens an on-disk window', async () => {
    const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() }
    // Boot with a long window applied at construction.
    const gate = createSendGate({
      enabled: true,
      clock,
      initialWindows: [{ scopeKey: 'global', untilTs: 600_000 }],
    })
    // Re-opening the SAME scope with a shorter untilTs must not shorten it.
    gate.openFloodWindow('global', 10_000)
    // A critical still fails fast against the ORIGINAL long window.
    const e = await gate.gate(async () => 'x', { priorityClass: 'critical' }).catch((err) => err)
    expect((e as { untilTs: number }).untilTs).toBe(600_000)
  })
})
