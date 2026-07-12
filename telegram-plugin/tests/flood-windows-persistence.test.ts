import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
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
  FLOOD_STATE_MODE,
  FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS,
} from '../flood-circuit-breaker.js'
import { createSendGate, SEND_GATE_SHED, type Clock } from '../send-gate.js'

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

    // The window is on disk. #3111: a chat-bound 429 persists ONLY the chat
    // scope — no coincident `global` window that would suppress unrelated chats.
    const persisted = readFloodWindows(winPath, 0)
    expect(persisted.map((w) => w.scopeKey).sort()).toEqual(['chat:7'])

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
    expect(res).toBe(SEND_GATE_SHED) // shed sentinel (#3110 F1)
    expect(gate2.stats().global.shed).toBe(1)

    // And a critical into the still-long window fails fast — restart did not
    // reset the ban.
    await expect(
      gate2.gate(async () => 'nope', { chat_id: '7', priorityClass: 'critical' }),
    ).rejects.toThrow('FLOOD_WAIT_ACTIVE')
  })

  it('H2: writes flood-windows.json world-READABLE (0o644), not 0o600', () => {
    // A 0o600 marker is unreadable to a gateway running under a DIFFERENT uid
    // (root vs agent uid share the state dir), which silently defeats the
    // restart-proof windows — a restart under the other uid boots blind and
    // resends into the ban. Must match `flood-wait.json` (FLOOD_STATE_MODE).
    const path = floodWindowsPath(dir)
    const now = 2_000_000
    writeFloodWindow(path, { scopeKey: 'global', untilTs: now + 60_000, retryAfterSrc: '429', observedAt: now }, now)
    expect(statSync(path).mode & 0o777).toBe(FLOOD_STATE_MODE)
    expect(FLOOD_STATE_MODE).toBe(0o644)
  })

  it('M1: a CORRUPT flood-windows.json fails SAFE (conservative global window), not open', () => {
    const path = floodWindowsPath(dir)
    const now = 3_000_000
    writeFileSync(path, '{ this is not valid json ][', 'utf-8')
    const logs: string[] = []
    const windows = readFloodWindows(path, now, (l) => logs.push(l))
    // NOT [] (fail-open) — a bounded conservative global window instead.
    expect(windows).toHaveLength(1)
    expect(windows[0]!.scopeKey).toBe('global')
    expect(windows[0]!.untilTs).toBe(now + FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS)
    // Logged loudly.
    expect(logs.join('')).toMatch(/failing SAFE/)
  })

  it('M1: a non-array flood-windows.json fails SAFE', () => {
    const path = floodWindowsPath(dir)
    const now = 3_500_000
    writeFileSync(path, '{"scopeKey":"global"}', 'utf-8') // object, not array
    const windows = readFloodWindows(path, now, () => {})
    expect(windows).toEqual([
      {
        scopeKey: 'global',
        untilTs: now + FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS,
        retryAfterSrc: expect.stringContaining('failsafe'),
        observedAt: now,
      },
    ])
  })

  it('M1: an UNREADABLE flood-windows.json (read error, not ENOENT) fails SAFE', () => {
    // Root bypasses file-mode EACCES, so simulate a non-ENOENT read failure
    // deterministically by making the windows path a DIRECTORY — readFileSync
    // throws EISDIR, the same "file exists but I can't read it" class as EACCES.
    const path = floodWindowsPath(dir)
    const now = 4_000_000
    mkdirSync(path)
    const logs: string[] = []
    const windows = readFloodWindows(path, now, (l) => logs.push(l))
    expect(windows).toHaveLength(1)
    expect(windows[0]!.scopeKey).toBe('global')
    expect(windows[0]!.untilTs).toBe(now + FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS)
    expect(logs.join('')).toMatch(/unreadable/)
  })

  it('M1: a genuinely ABSENT file is still "no windows" (ENOENT ≠ corrupt)', () => {
    const path = floodWindowsPath(dir) // never written
    expect(readFloodWindows(path, 5_000_000, () => {})).toEqual([])
  })

  it('M3: flag-OFF gate opens NO window and writes NO flood-windows.json', () => {
    // The gateway wires onFloodWait → openFloodWindow('global', …)
    // unconditionally; with the flag OFF that must be a pure no-op — no in-memory
    // suppression, no fs side effect (a poison-perms file created before the
    // feature is ever enabled).
    const path = floodWindowsPath(dir)
    const recorder = makeFloodWindowRecorder(path, () => 0)
    const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() }
    const gate = createSendGate({
      enabled: false,
      clock,
      onWindowOpen: (scopeKey, untilTs) => recorder(scopeKey, untilTs),
    })
    gate.openFloodWindow('global', 600_000)
    expect(existsSync(path)).toBe(false)
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
