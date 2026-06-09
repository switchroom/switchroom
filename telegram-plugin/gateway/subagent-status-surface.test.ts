import { describe, it, expect } from 'vitest'
import {
  resolveSubagentStatusSurface,
  isOrphanSubagentStatusEnabled,
  type SubagentStatusSurface,
  type SubagentStatusSurfaceInput,
} from './subagent-status-surface.js'

// ── Human-readable map ──────────────────────────────────────────────────────
describe('resolveSubagentStatusSurface', () => {
  const base: SubagentStatusSurfaceInput = {
    isBackground: false,
    liveTurnPresent: true,
    workerFeedEnabled: true,
    orphanStatusEnabled: true,
  }
  it('foreground + live turn → nest (unchanged default)', () => {
    expect(resolveSubagentStatusSurface(base)).toBe('nest')
  })
  it('THE fix: orphaned foreground (no live turn) → worker-feed', () => {
    expect(resolveSubagentStatusSurface({ ...base, liveTurnPresent: false })).toBe('worker-feed')
  })
  it('kill switch: orphaned foreground with orphanStatus OFF → skip (pre-fix invisible)', () => {
    expect(
      resolveSubagentStatusSurface({ ...base, liveTurnPresent: false, orphanStatusEnabled: false }),
    ).toBe('skip')
  })
  it('orphaned foreground but feed OFF → skip (nothing to surface through)', () => {
    expect(
      resolveSubagentStatusSurface({ ...base, liveTurnPresent: false, workerFeedEnabled: false }),
    ).toBe('skip')
  })
  it('background + feed on → worker-feed', () => {
    expect(resolveSubagentStatusSurface({ ...base, isBackground: true, liveTurnPresent: false })).toBe('worker-feed')
  })
  it('background + feed off → legacy-relay', () => {
    expect(
      resolveSubagentStatusSurface({ ...base, isBackground: true, workerFeedEnabled: false }),
    ).toBe('legacy-relay')
  })
})

describe('isOrphanSubagentStatusEnabled — default ON, =0 kill switch', () => {
  it('undefined / "1" / "" → on; "0" → off', () => {
    expect(isOrphanSubagentStatusEnabled(undefined)).toBe(true)
    expect(isOrphanSubagentStatusEnabled('1')).toBe(true)
    expect(isOrphanSubagentStatusEnabled('')).toBe(true)
    expect(isOrphanSubagentStatusEnabled('0')).toBe(false)
  })
})

// ── TOTAL-ENUMERATION DETERMINISM PROOF ─────────────────────────────────────
// 4 booleans = 16 reachable inputs. Enumerate all, assert totality, determinism,
// the documented table (independent spec), and the load-bearing invariants.
// (operator standard feedback_prove_finite_fsm_not_sample.)
function allInputs(): SubagentStatusSurfaceInput[] {
  const rows: SubagentStatusSurfaceInput[] = []
  for (const isBackground of [false, true])
    for (const liveTurnPresent of [false, true])
      for (const workerFeedEnabled of [false, true])
        for (const orphanStatusEnabled of [false, true])
          rows.push({ isBackground, liveTurnPresent, workerFeedEnabled, orphanStatusEnabled })
  return rows
}

// Independent spec encoding (kept separate from the impl).
function spec(i: SubagentStatusSurfaceInput): SubagentStatusSurface {
  if (i.isBackground) return i.workerFeedEnabled ? 'worker-feed' : 'legacy-relay'
  if (i.liveTurnPresent) return 'nest'
  if (!i.orphanStatusEnabled) return 'skip'
  return i.workerFeedEnabled ? 'worker-feed' : 'skip'
}

describe('resolveSubagentStatusSurface — total enumeration (16 inputs)', () => {
  const ROWS = allInputs()

  it('exactly 16 reachable inputs (2^4)', () => {
    expect(ROWS.length).toBe(16)
  })
  it('TOTAL + DETERMINISTIC: every input returns one of the four surfaces, idempotently', () => {
    const surfaces = new Set<SubagentStatusSurface>(['nest', 'worker-feed', 'legacy-relay', 'skip'])
    for (const i of ROWS) {
      const a = resolveSubagentStatusSurface(i)
      expect(surfaces.has(a)).toBe(true)
      expect(resolveSubagentStatusSurface({ ...i })).toBe(a)
    }
  })
  it('PRECEDENCE: matches the documented spec on all 16 inputs', () => {
    for (const i of ROWS) expect(resolveSubagentStatusSurface(i)).toBe(spec(i))
  })

  it('INV-ORPHAN-VISIBLE: an orphaned foreground sub-agent is NEVER skip when orphanStatus + feed are on', () => {
    for (const i of ROWS) {
      if (!i.isBackground && !i.liveTurnPresent && i.orphanStatusEnabled && i.workerFeedEnabled) {
        expect(resolveSubagentStatusSurface(i)).toBe('worker-feed')
      }
    }
  })
  it('INV-KILL-SWITCH: orphanStatus OFF ⇒ an orphaned foreground sub-agent is exactly the pre-fix behaviour (skip)', () => {
    for (const i of ROWS) {
      if (!i.isBackground && !i.liveTurnPresent && !i.orphanStatusEnabled) {
        expect(resolveSubagentStatusSurface(i)).toBe('skip')
      }
    }
  })
  it('INV-NEST-UNCHANGED: a foreground sub-agent with a live turn is ALWAYS nest, independent of the other flags', () => {
    for (const i of ROWS) {
      if (!i.isBackground && i.liveTurnPresent) expect(resolveSubagentStatusSurface(i)).toBe('nest')
    }
  })
  it('INV-BACKGROUND-UNCHANGED: background routing depends ONLY on the feed flag, never on liveTurn/orphanStatus', () => {
    for (const i of ROWS) {
      if (i.isBackground) {
        expect(resolveSubagentStatusSurface(i)).toBe(i.workerFeedEnabled ? 'worker-feed' : 'legacy-relay')
      }
    }
  })
})
