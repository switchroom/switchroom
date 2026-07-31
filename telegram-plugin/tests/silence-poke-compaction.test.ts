/**
 * #4058 — mid-turn auto-compaction must not trip the 300s silence fallback.
 *
 * The bug: during compaction the model emits zero output and runs zero tools,
 * so the gateway saw pure silence and fired the framework fallback ("⚠️ no
 * output for 5 min — the framework ended that stalled turn") on a healthy
 * turn that completed correctly right after compaction. Observed live:
 * ~1m50s of tools + ~3m25s compacting = 304s silence → false fire.
 *
 * The fix: the PreCompact hook writes a compaction marker; silence-poke gets
 * an `isCompactionInFlight` dep consulted in the SAME `underCeiling` defer
 * branch as the #1292/#3519 in-flight-tool defers; the transcript's
 * `compact_boundary` record (compaction END) clears the marker and counts as
 * production. These tests drive the REAL tick loop and assert outcomes:
 *   - a compaction gap past 300s but under the hard ceiling → NO fire;
 *   - a genuinely-wedged turn (no compaction) → STILL fires at 300s;
 *   - a compaction stuck past the hard ceiling → STILL fires (bounded defer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { projectTranscriptLine } from '../session-tail.js'
import { applySilencePokeSessionEvent } from '../gateway/silence-poke-session-event.js'
import {
  COMPACTION_MARKER_FILE,
  readCompactionMarkerAgeMs,
  removeCompactionMarker,
} from '../gateway/compaction-marker.js'
import * as silencePoke from '../silence-poke.js'
import * as pendingProgress from '../pending-work-progress.js'
import {
  startTurn,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
} from '../silence-poke.js'

const HARD_CEILING = 900_000 // SILENCE_FALLBACK_HARD_MS default

interface TestFixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
}

function setupDeps(opts?: {
  isCompactionInFlight?: (key: string) => boolean
  isLegitimatelyWorking?: (key: string) => boolean
}): TestFixtures {
  const fixtures: TestFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: { ...DEFAULT_THRESHOLDS, fallbackHardCeiling: HARD_CEILING },
    // Mirror production wiring: the callback path is active (liveness-wiring
    // always wires isLegitimatelyWorking), returning false = "no tool work".
    isLegitimatelyWorking: opts?.isLegitimatelyWorking ?? (() => false),
    ...(opts?.isCompactionInFlight != null
      ? { isCompactionInFlight: opts.isCompactionInFlight }
      : {}),
  })
  return fixtures
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

afterEach(() => {
  __resetAllForTests()
})

describe('silence-poke — #4058 compaction defer (outcome)', () => {
  it('a compaction gap longer than 300s but under the hard ceiling does NOT fire the fallback', () => {
    // Real observed shape: tools until t=110s, compaction t=110s..415s (305s
    // of pure silence — past the 300s window), turn completes after.
    let compacting = false
    const fx = setupDeps({ isCompactionInFlight: () => compacting })
    startTurn('chat:1', 0)
    // Tools produced feed renders until 110s → production reset at 110s.
    silencePoke.noteProduction('chat:1', 110_000)
    compacting = true // PreCompact hook fired
    __tickForTests(300_000) // 190s silent — under threshold anyway
    __tickForTests(415_000) // 305s silent — WOULD fire without the fix
    __tickForTests(500_000) // 390s silent — still compacting
    expect(fx.fallbacks).toHaveLength(0)
    expect(fx.emitted).toHaveLength(0)
    // Compaction ends: the compact_boundary handler clears the marker AND
    // counts the boundary as production (fresh window for the resumed turn).
    compacting = false
    silencePoke.noteProduction('chat:1', 505_000)
    __tickForTests(510_000)
    expect(fx.fallbacks).toHaveLength(0) // healthy turn: never fired
  })

  it('a genuinely-wedged turn with no compaction STILL fires at 300s', () => {
    const fx = setupDeps({ isCompactionInFlight: () => false })
    startTurn('chat:2', 0)
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.emitted.at(-1)).toMatchObject({ kind: 'silence_fallback_sent' })
  })

  it('a turn that goes silent AFTER compaction ends still fires one window later', () => {
    let compacting = true
    const fx = setupDeps({ isCompactionInFlight: () => compacting })
    startTurn('chat:3', 0)
    __tickForTests(310_000)
    expect(fx.fallbacks).toHaveLength(0) // deferred while compacting
    compacting = false
    silencePoke.noteProduction('chat:3', 320_000) // compact_boundary landed
    __tickForTests(325_000)
    expect(fx.fallbacks).toHaveLength(0)
    // …but the model never resumes → real wedge → fires 300s after boundary.
    __tickForTests(620_000)
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('a compaction stuck past the hard ceiling STILL fires (bounded defer)', () => {
    const fx = setupDeps({ isCompactionInFlight: () => true })
    startTurn('chat:4', 0)
    __tickForTests(899_000)
    expect(fx.fallbacks).toHaveLength(0) // deferred under the ceiling
    __tickForTests(900_000) // silence ≥ fallbackHardCeiling → defer expires
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('absent dep (legacy fixtures) leaves behaviour unchanged — fires at 300s', () => {
    const fx = setupDeps()
    startTurn('chat:5', 0)
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(1)
  })
})

describe('session-tail — compact_boundary projection', () => {
  it('projects a real transcript compact_boundary line', () => {
    // Verbatim shape from a live agent transcript (trimmed to the fields the
    // projection reads).
    const line = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: { trigger: 'auto', preTokens: 283797, postTokens: 224551, durationMs: 111959 },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'compact_boundary', trigger: 'auto', compactDurationMs: 111959 },
    ])
  })

  it('tolerates missing compactMetadata', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'compact_boundary', trigger: null, compactDurationMs: null },
    ])
  })
})

describe('compaction-marker + session-event wiring', () => {
  let dir: string
  const envBefore = process.env.TELEGRAM_STATE_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-compact-'))
    process.env.TELEGRAM_STATE_DIR = dir
  })

  afterEach(() => {
    if (envBefore != null) process.env.TELEGRAM_STATE_DIR = envBefore
    else delete process.env.TELEGRAM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('readCompactionMarkerAgeMs: absent → null; present → mtime age', () => {
    expect(readCompactionMarkerAgeMs(dir, 1_000)).toBeNull()
    const p = join(dir, COMPACTION_MARKER_FILE)
    writeFileSync(p, '{"ts":1}\n')
    const at = new Date(Date.now() - 10_000)
    utimesSync(p, at, at)
    const age = readCompactionMarkerAgeMs(dir)
    expect(age).not.toBeNull()
    expect(age!).toBeGreaterThanOrEqual(9_000)
    expect(age!).toBeLessThan(60_000)
    removeCompactionMarker(dir)
    expect(readCompactionMarkerAgeMs(dir)).toBeNull()
    removeCompactionMarker(dir) // idempotent
  })

  it('compact_boundary session event clears the marker and resets the silence clock', () => {
    writeFileSync(join(dir, COMPACTION_MARKER_FILE), '{"ts":1}\n')
    startTurn('c:9', 0)
    setupDeps()
    applySilencePokeSessionEvent(silencePoke, pendingProgress, 'c:9', {
      kind: 'compact_boundary',
      trigger: 'auto',
      compactDurationMs: 111_959,
    })
    expect(existsSync(join(dir, COMPACTION_MARKER_FILE))).toBe(false)
    // Clock reset: lastOutboundAt stamped by noteProduction.
    expect(__getStateForTests('c:9')?.lastOutboundAt).not.toBeNull()
  })

  it('PreCompact hook writes the marker from its stdin payload', () => {
    const hook = join(__dirname, '..', 'hooks', 'compaction-marker-precompact.mjs')
    execFileSync('node', [hook], {
      env: { ...process.env, TELEGRAM_STATE_DIR: dir },
      input: JSON.stringify({ session_id: 's-1', trigger: 'auto', hook_event_name: 'PreCompact' }),
    })
    const age = readCompactionMarkerAgeMs(dir)
    expect(age).not.toBeNull()
    expect(age!).toBeLessThan(30_000)
  })
})
