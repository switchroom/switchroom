/**
 * M0 metric-corruption regression — the framework_fallback `turn_ended` emitter
 * must never write an absolute Unix-epoch value as `duration_ms`.
 *
 * ROOT CAUSE (fixed by this change): the 300 s framework-fallback unwedge in
 * `liveness-wiring.ts` read the turn's start from `activeTurnStartedAt.get(key)`
 * and, guarded only by a `!= null` presence check, computed
 * `Date.now() - turnStartedAt` inline. When the map held `0` (a bogus / not-yet
 * stamped start — reproduced here exactly as the parked-turn fixture does with
 * `activeTurnStartedAt.set(KEY, 0)`), it emitted `duration_ms = Date.now() - 0`,
 * i.e. the current epoch-ms — a ~56,000-year "duration". The analysed dataset
 * carried 110 such rows (`duration_ms === ts`, `ended_via: "framework_fallback"`),
 * making every latency aggregate unusable.
 *
 * The two `stream-render.ts` turn_ended paths already guarded with
 * `startedAt > 0 ? … : 0`; this path had drifted. The fix routes all emitters
 * through the shared `computeTurnDurationMs`, which returns 0 for a non-positive
 * start.
 *
 * This test drives the REAL `onFrameworkFallback` (via `buildSilencePokeOptions`,
 * same standard as the other liveness-wiring tests) with a 0 start and asserts on
 * the ACTUAL emitted `turn_ended` row (captured through the real runtime-metrics
 * JSONL sink, pinned to a temp file). It asserts the OUTCOME — the emitted
 * `duration_ms` — not a code path.
 *
 * Pre-fix: `duration_ms` ≈ `Date.now()` (~1.78e12). Post-fix: `duration_ms === 0`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSilencePokeOptions } from '../gateway/liveness-wiring.js'
import {
  __setRuntimeMetricsPathForTests,
} from '../runtime-metrics.js'
import { makeLivenessFixture, makeTurn, statusKeyForTests } from './helpers/liveness-wiring-fixture.js'

const CHAT = '-100999'

function readTurnEndedRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind === 'turn_ended')
}

describe('framework_fallback turn_ended never emits an epoch value as duration_ms', () => {
  let metricsPath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'fallback-duration-'))
    metricsPath = join(dir, 'runtime-metrics.jsonl')
    __setRuntimeMetricsPathForTests(metricsPath)
  })

  afterEach(() => {
    __setRuntimeMetricsPathForTests(null)
  })

  it('emits duration_ms === 0 for a zero/bogus start instead of Date.now()', async () => {
    const KEY = statusKeyForTests(CHAT, null)
    const fx = makeLivenessFixture()

    // The wedged turn's start is 0 — the exact corruption trigger. Before the
    // fix this made the fallback emit `Date.now() - 0`.
    fx.activeTurnStartedAt.set(KEY, 0)
    fx.setCurrentTurn(
      makeTurn({ sessionChatId: CHAT, sessionThreadId: undefined, turnId: `${KEY}#42` }),
    )

    const opts = buildSilencePokeOptions(fx.deps)
    await opts.onFrameworkFallback({
      key: KEY,
      chatId: CHAT,
      threadId: null,
      fallbackKind: 'working',
      silenceMs: 302_000,
      inFlightTools: [],
    })

    const rows = readTurnEndedRows(metricsPath)
    const fallbackRow = rows.find((r) => r.ended_via === 'framework_fallback')
    expect(fallbackRow, 'framework_fallback turn_ended row was emitted').toBeDefined()

    const duration = fallbackRow!.duration_ms as number
    // The falsifying assertion: pre-fix this is ~Date.now() (an epoch-ms value,
    // ~1.78e12), and in particular equals the row's own `ts`. Post-fix it is 0.
    expect(duration).toBe(0)
    // Belt-and-braces: a duration can never be an absolute epoch stamp, and can
    // never equal the emission timestamp.
    expect(duration).not.toBe(fallbackRow!.ts as number)
    expect(duration).toBeLessThan(365 * 24 * 60 * 60 * 1000) // < 1 year, sane bound
  })

  it('emits a real elapsed duration for a valid positive start', async () => {
    const KEY = statusKeyForTests(CHAT, null)
    const fx = makeLivenessFixture()

    const startedAt = Date.now() - 302_000 // ~5 min ago
    fx.activeTurnStartedAt.set(KEY, startedAt)
    fx.setCurrentTurn(
      makeTurn({ sessionChatId: CHAT, sessionThreadId: undefined, turnId: `${KEY}#43` }),
    )

    const opts = buildSilencePokeOptions(fx.deps)
    await opts.onFrameworkFallback({
      key: KEY,
      chatId: CHAT,
      threadId: null,
      fallbackKind: 'working',
      silenceMs: 302_000,
      inFlightTools: [],
    })

    const fallbackRow = readTurnEndedRows(metricsPath).find(
      (r) => r.ended_via === 'framework_fallback',
    )
    const duration = fallbackRow!.duration_ms as number
    // Around 302 s, with generous slack for test-runtime jitter.
    expect(duration).toBeGreaterThanOrEqual(302_000)
    expect(duration).toBeLessThan(360_000)
  })
})
