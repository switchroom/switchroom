/**
 * #3106 — a permissions error must not silently blind the flood breaker.
 *
 * The bug: `readFloodState` swallowed EVERY error and returned `null`, so an
 * unreadable marker (EACCES) was indistinguishable from "no marker" — the
 * probe reported "no flood window" forever and every flood protection we ship
 * (#2923 boot-card suppression, #3084/#3094 pre-call short-circuit, #3097
 * typing suppression) failed open SILENTLY. A restart would then post a boot
 * card straight into an open ban.
 *
 * Two behaviours pull in OPPOSITE directions and both are pinned here:
 *
 *   - ABSENT / CORRUPT marker → still fails OPEN everywhere. A junk state file
 *     must never become a silent gag (#3094's deliberate posture).
 *   - UNREADABLE marker → the breaker is BLIND. Essential sends still proceed
 *     (fail-open, so a chmod accident can never mute the agent), but it says so
 *     LOUDLY, and non-essential sends (boot card, typing) are held back rather
 *     than fired into a ban we cannot rule out.
 *
 * All paths are under `mkdtempSync(join(tmpdir(), …))` — no production state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  mkdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeFloodWait,
  writeFloodState,
  readFloodStateResult,
  makeFloodWaitProbe,
  makeFloodWaitRecorder,
  suppressNonEssentialSendMs,
  nonEssentialSendSuppression,
  resetFloodBlindLogThrottle,
  floodStatePath,
  FLOOD_STATE_MODE,
} from '../flood-circuit-breaker.js'

const NOW = 1_800_000_000_000
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/**
 * Make `path` genuinely unreadable to THIS process and prove it. Returns false
 * when the process is root (root bypasses DAC — EACCES is unreachable), so the
 * caller can skip rather than assert a lie.
 */
function makeUnreadable(path: string): boolean {
  writeFileSync(path, JSON.stringify({ untilTs: NOW + 60_000, retryAfterSec: 60, recordedTs: NOW }))
  chmodSync(path, 0o000)
  if (isRoot) return false
  try {
    readFileSync(path, 'utf-8')
    return false // somehow still readable — don't pretend we tested EACCES
  } catch {
    return true
  }
}

describe('#3106 flood breaker — blind is not clear', () => {
  let dir: string
  let path: string
  let logs: string[]
  const log = (l: string) => {
    logs.push(l)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-blind-'))
    path = floodStatePath(dir)
    logs = []
    resetFloodBlindLogThrottle()
  })
  afterEach(() => {
    try {
      chmodSync(path, 0o644)
    } catch {
      /* may not exist */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------- classify

  it('classifies absent / corrupt / unreadable as DIFFERENT things', () => {
    expect(readFloodStateResult(path).status).toBe('absent')

    writeFileSync(path, 'not json at all{{{')
    expect(readFloodStateResult(path).status).toBe('corrupt')

    writeFileSync(path, JSON.stringify({ untilTs: 'soon' }))
    expect(readFloodStateResult(path).status).toBe('corrupt')

    // A directory where the marker should be: readable-check fails with EISDIR,
    // not ENOENT. uid-independent (works even under root) — "cannot read".
    const d = join(dir, 'as-a-dir.json')
    mkdirSync(d)
    expect(readFloodStateResult(d).status).toBe('unreadable')
  })

  // ------------------------------------------------- UNREADABLE → not silent

  it.skipIf(isRoot)(
    'REGRESSION: an unreadable marker does NOT silently report "no flood window"',
    () => {
      expect(makeUnreadable(path)).toBe(true)

      const res = readFloodStateResult(path)
      // The bug was: status indistinguishable from absent, state null, nobody told.
      expect(res.status).toBe('unreadable')
      expect(res.error).toMatch(/EACCES/)

      // The probe still FAILS OPEN (0 = proceed) — an essential reply to the
      // user must never be gagged by a permissions error...
      const probe = makeFloodWaitProbe(path, () => NOW, log)
      expect(probe()).toBe(0)

      // ...but it is no longer SILENT. That is the whole fix.
      expect(logs.join('')).toMatch(/BLIND/)
      expect(logs.join('')).toContain(path)
    },
  )

  it.skipIf(isRoot)('an unreadable marker SUPPRESSES non-essential sends (boot card, typing)', () => {
    expect(makeUnreadable(path)).toBe(true)

    // The #2923/#3097 surfaces: we cannot rule out an open ban, so we do not
    // post a restart card / typing ping into one.
    expect(suppressNonEssentialSendMs(path, NOW, log)).toBeGreaterThan(0)
    expect(logs.join('')).toMatch(/BLIND/)

    const s = nonEssentialSendSuppression(path, NOW)
    expect(s.suppress).toBe(true)
    expect(s.suppress && s.reason).toBe('blind')
  })

  it.skipIf(isRoot)('the BLIND warning is throttled — a per-call probe cannot spam the log', () => {
    expect(makeUnreadable(path)).toBe(true)
    let t = NOW
    const probe = makeFloodWaitProbe(path, () => t, log)
    for (let i = 0; i < 50; i++) probe()
    expect(logs.length).toBe(1)
    t = NOW + 61_000
    probe()
    expect(logs.length).toBe(2)
  })

  // --------------------------------------------- ABSENT / CORRUPT → fail OPEN

  it('an ABSENT marker fails OPEN and stays silent (no ban, nothing to say)', () => {
    const probe = makeFloodWaitProbe(path, () => NOW, log)
    expect(probe()).toBe(0)
    expect(suppressNonEssentialSendMs(path, NOW, log)).toBe(0)
    expect(nonEssentialSendSuppression(path, NOW).suppress).toBe(false)
    expect(logs.join('')).not.toMatch(/BLIND/)
  })

  it('a CORRUPT marker still fails OPEN — a junk file must never gag the bot', () => {
    for (const junk of ['', 'null', '{}', 'not json{{', JSON.stringify({ untilTs: 'x' })]) {
      writeFileSync(path, junk)
      const probe = makeFloodWaitProbe(path, () => NOW, log)
      expect(probe()).toBe(0)
      // Non-essential sends proceed too: corrupt is a CONTENT problem, and we
      // deliberately do NOT let it suppress. (Contrast: unreadable, above.)
      expect(suppressNonEssentialSendMs(path, NOW, log)).toBe(0)
      expect(nonEssentialSendSuppression(path, NOW).suppress).toBe(false)
    }
  })

  it('a REAL open window still suppresses (the #2923 behaviour is intact)', () => {
    writeFloodState(path, computeFloodWait(null, 68 * 60, NOW), log)
    const probe = makeFloodWaitProbe(path, () => NOW, log)
    expect(probe()).toBe(68 * 60 * 1000)
    const s = nonEssentialSendSuppression(path, NOW)
    expect(s.suppress && s.reason).toBe('flood_wait')
    // ...and lifts on its own.
    expect(makeFloodWaitProbe(path, () => NOW + 68 * 60_000 + 1, log)()).toBe(0)
  })

  // ------------------------------------------------------- root cause: 0600

  it('ROOT CAUSE: the marker is written 0644, readable by a sibling uid', () => {
    writeFloodState(path, computeFloodWait(null, 60, NOW), log)
    expect(statSync(path).mode & 0o777).toBe(FLOOD_STATE_MODE)
    // Group/other read bits set — the whole point. At 0600 a marker created by
    // a root gateway (`compose.ts:1967`, `root: true` agents) is unreadable to
    // the same agent's non-root gateway forever.
    expect(statSync(path).mode & 0o044).toBe(0o044)
  })

  it('SELF-HEAL: a pre-existing 0600 marker is chmodded back to 0644 on write', () => {
    // Simulate the live overlord marker: created 0600 by an earlier build.
    writeFileSync(path, JSON.stringify({ untilTs: NOW, retryAfterSec: 1, recordedTs: NOW }), {
      mode: 0o600,
    })
    chmodSync(path, 0o600)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    // The next observed 429 rewrites it — and heals the mode. (writeFileSync's
    // `mode` option is ignored for an EXISTING file, so the explicit chmod is
    // load-bearing.)
    makeFloodWaitRecorder(path, () => NOW, log)(120)
    expect(statSync(path).mode & 0o777).toBe(FLOOD_STATE_MODE)
    expect(readFloodStateResult(path).status).toBe('ok')
  })
})
