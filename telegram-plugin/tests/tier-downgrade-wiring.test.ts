/**
 * Integration test for the tier-downgrade GLUE (`runTierDowngrade`,
 * tier-downgrade-wiring.ts) — the gateway orchestration the pure
 * `decideTierDowngrade` / `renderTierDowngradeNotice` tests do NOT cover.
 *
 * This is the test the @overlord review asked for (the MEDIUM "reverts to
 * fable" misinform slipped through precisely because the glue that emits the
 * BROADCAST notice text had no test — only the pure renderer did). It drives
 * the real runner with injected seams and PINS the broadcast notice:
 *   - asserts the resume-on-DEFAULT wording + the manual re-issue instruction;
 *   - FAILS on any revert-to-premium phrasing (the exact regression).
 * It also covers the resume-gate suppression path and the carrier-before-arm
 * ordering invariant.
 */

import { describe, it, expect } from 'vitest'
import {
  runTierDowngrade,
  type TierDowngradeRunnerDeps,
  type TierDowngradeOutcome,
} from '../gateway/tier-downgrade-wiring.js'

interface Recorder {
  carrier: Array<{ dir: string; toModel: string; cfg: string }>
  arms: number
  markers: Array<{ dir: string; premiumModel: string }>
  notices: string[]
  restarts: string[]
  logs: string[]
}

function makeDeps(
  over: Partial<TierDowngradeRunnerDeps> & {
    sessionOverride?: string | null
    configuredDefault?: string | null
    gateVerdict?: 'resume' | 'skip-inflight' | 'skip-stale'
    carrierThrows?: boolean
    markerThrows?: boolean
    agentDir?: string | null
  } = {},
): { deps: TierDowngradeRunnerDeps; rec: Recorder } {
  const rec: Recorder = { carrier: [], arms: 0, markers: [], notices: [], restarts: [], logs: [] }
  // A near-identity resolver like the real resolveMainModel: the unset/`default`
  // sentinel maps to the switchroom default, everything else is itself.
  const resolve = (t: string): string => (t === '' || t === 'default' ? 'claude-opus-4-8' : t)
  const deps: TierDowngradeRunnerDeps = {
    getAgentDir: () => (over.agentDir === undefined ? '/tmp/agent' : over.agentDir),
    getConfiguredDefault: () => (over.configuredDefault === undefined ? 'opus' : over.configuredDefault),
    getSessionOverride: () => (over.sessionOverride === undefined ? 'fable' : over.sessionOverride),
    resolve,
    peekResumeGate: () => over.gateVerdict ?? 'resume',
    writeCarrier: (dir, toModel, cfg) => {
      if (over.carrierThrows) throw new Error('disk full')
      rec.carrier.push({ dir, toModel, cfg })
    },
    armResumeGate: () => {
      rec.arms += 1
    },
    writeRecoveryMarker: (dir, premiumModel) => {
      if (over.markerThrows) throw new Error('marker write failed')
      rec.markers.push({ dir, premiumModel })
    },
    broadcastNotice: (md) => rec.notices.push(md),
    selfRestart: (agent) => rec.restarts.push(agent),
    selfAgent: (t) => `self-${t}`,
    log: (msg) => rec.logs.push(msg),
    ...over,
  }
  return { deps, rec }
}

describe('runTierDowngrade — broadcast notice honesty (the pinned regression)', () => {
  it('downgrade path broadcasts EXACTLY ONE notice with resume-on-default wording', () => {
    const { deps, rec } = makeDeps({ sessionOverride: 'fable', configuredDefault: 'opus' })
    const outcome: TierDowngradeOutcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('downgraded')
    expect(rec.notices).toHaveLength(1)
    const notice = rec.notices[0]
    // Resume-on-DEFAULT + the manual re-issue instruction.
    expect(notice).toContain('`opus`')
    expect(notice).toContain('/model fable')
    expect(notice.toLowerCase()).toContain("won't switch back on its own")
  })

  it('the notice NEVER promises a revert to the premium model (the MEDIUM regression)', () => {
    const { deps, rec } = makeDeps({ sessionOverride: 'fable', configuredDefault: 'opus' })
    runTierDowngrade('klanker', deps)
    const notice = rec.notices[0].toLowerCase()
    // The exact false phrasing from the pre-5d9bbf44 revision, and its kin.
    expect(notice).not.toContain('reverts to `fable`')
    expect(notice).not.toContain('revert to `fable`')
    expect(notice).not.toMatch(/reverts? to fable/)
    expect(notice).not.toMatch(/switch(es)? back.*on (the )?next restart/)
    expect(notice).not.toMatch(/automatically.*(fable|premium)/)
  })
})

describe('runTierDowngrade — side-effect ordering + outcomes', () => {
  it('downgrade: carrier written BEFORE the arm, marker + notice + restart all fire', () => {
    const { deps, rec } = makeDeps({ sessionOverride: 'fable', configuredDefault: 'opus' })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('downgraded')
    expect(rec.carrier).toEqual([{ dir: '/tmp/agent', toModel: 'opus', cfg: 'opus' }])
    expect(rec.arms).toBe(1)
    expect(rec.markers).toEqual([{ dir: '/tmp/agent', premiumModel: 'fable' }])
    expect(rec.restarts).toEqual(['self-klanker'])
  })

  it('carrier write THROWS → abort: NO arm, NO marker, NO notice, NO restart (skip)', () => {
    const { deps, rec } = makeDeps({ carrierThrows: true })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('skip')
    expect(rec.arms).toBe(0)
    expect(rec.markers).toHaveLength(0)
    expect(rec.notices).toHaveLength(0)
    expect(rec.restarts).toHaveLength(0)
  })

  it('marker write THROWS → downgrade still completes (marker is best-effort)', () => {
    const { deps, rec } = makeDeps({ markerThrows: true })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('downgraded')
    expect(rec.arms).toBe(1)
    expect(rec.notices).toHaveLength(1)
    expect(rec.restarts).toEqual(['self-klanker'])
    expect(rec.markers).toHaveLength(0)
  })

  it('resume-gate skip-inflight → restart-pending, NO notice, NO restart, NO carrier', () => {
    const { deps, rec } = makeDeps({ gateVerdict: 'skip-inflight' })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('restart-pending')
    expect(rec.carrier).toHaveLength(0)
    expect(rec.arms).toBe(0)
    expect(rec.notices).toHaveLength(0)
    expect(rec.restarts).toHaveLength(0)
  })

  it('resume-gate skip-stale → skip (give up), NO notice/restart', () => {
    const { deps, rec } = makeDeps({ gateVerdict: 'skip-stale' })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('skip')
    expect(rec.notices).toHaveLength(0)
    expect(rec.restarts).toHaveLength(0)
  })

  it('session on the configured default (override null) → skip, no downgrade', () => {
    const { deps, rec } = makeDeps({ sessionOverride: null })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('skip')
    expect(rec.notices).toHaveLength(0)
  })

  it('unresolved configured default → skip (never downgrade blind)', () => {
    const { deps, rec } = makeDeps({ configuredDefault: '' })
    const outcome = runTierDowngrade('klanker', deps)
    expect(outcome).toBe('skip')
    expect(rec.carrier).toHaveLength(0)
  })

  it('no agent dir → skip immediately', () => {
    const { deps } = makeDeps({ agentDir: null })
    expect(runTierDowngrade('klanker', deps)).toBe('skip')
  })
})
