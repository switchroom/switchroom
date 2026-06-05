import { describe, it, expect } from 'vitest'
import { resolveAnswerThreadId, type AnswerThreadInput } from './answer-thread-resolve.js'

describe('resolveAnswerThreadId — precedence', () => {
  it('(1) explicit model thread wins over everything', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: 7,
        originResolved: true,
        originThreadId: 3,
        liveThreadId: 4,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 9,
      }),
    ).toBe(7)
  })

  it('(2) origin turn thread wins over the live turn (the Brevo→Meta fix)', () => {
    expect(
      resolveAnswerThreadId({ originResolved: true, originThreadId: 3, liveThreadId: 4 }),
    ).toBe(3)
  })

  it('(2) a DM origin (resolved, thread undefined) pins to undefined, not the live thread', () => {
    expect(
      resolveAnswerThreadId({ originResolved: true, originThreadId: undefined, liveThreadId: 4 }),
    ).toBeUndefined()
  })

  it('(3) no origin → falls back to the live turn thread (legacy #1664)', () => {
    expect(
      resolveAnswerThreadId({ originResolved: false, liveThreadId: 4 }),
    ).toBe(4)
  })

  // ── tier (4): late-reply topic recovery (2026-06-05) ──────────────────────
  it('(4) no explicit, no origin, NO live turn → recovers the most-recent ended turn thread', () => {
    // The marko bug: a reply that fired after the orphaned-reply backstop ended
    // its turn. Pre-fix this returned undefined (General); now it recovers topic 3.
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 3,
      }),
    ).toBe(3)
  })

  it('(4) a recovered DM turn (ended, thread undefined) stays threadless', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: undefined,
      }),
    ).toBeUndefined()
  })

  it('(4) recovery does NOT override a live turn — live thread still wins at tier 3', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: 4,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 3,
      }),
    ).toBe(4)
  })

  it('(4) no recovery candidate → legacy result (undefined), unchanged', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: false,
      }),
    ).toBeUndefined()
  })

  it('pure DM (every tier undefined) → undefined', () => {
    expect(resolveAnswerThreadId({ originResolved: false })).toBeUndefined()
  })
})

// ── TOTAL-ENUMERATION DETERMINISM PROOF ─────────────────────────────────────
//
// The operator standard (memory feedback_prove_finite_fsm_not_sample): a
// passing sample is not a proof. `resolveAnswerThreadId` is a PURE decision
// function over a FINITE input space — so we can prove its determinism by
// CONSTRUCTION: enumerate every reachable input and assert totality,
// determinism, no-fabrication, and the precedence the doc-comment promises.
// Any future edit that perturbs the decision table on ANY of the 64 inputs
// fails here — this block is the regression guard, the 9 examples above are
// the human-readable map.
//
// Distinct symbolic thread ids so an output's provenance is unambiguous (no
// two tiers share a value): explicit=70, origin=50, live=30, lastEnded=90.
const T = 70 // explicit (tier 1)
const O = 50 // origin   (tier 2)
const L = 30 // live     (tier 3)
const E = 90 // lastEnded(tier 4)

function allInputs(): AnswerThreadInput[] {
  const rows: AnswerThreadInput[] = []
  for (const explicitThreadId of [undefined, T])
    for (const originResolved of [false, true])
      for (const originThreadId of [undefined, O])
        for (const liveThreadId of [undefined, L])
          for (const lastEndedResolvedForChat of [false, true])
            for (const lastEndedThreadIdForChat of [undefined, E])
              rows.push({
                explicitThreadId,
                originResolved,
                originThreadId,
                lastEndedResolvedForChat,
                lastEndedThreadIdForChat,
                liveThreadId,
              })
  return rows
}

// Independent reference encoding the documented precedence (the SPEC), kept
// deliberately separate from the implementation so a regression in either
// surfaces as a divergence rather than a silently-shared bug.
function specExpected(i: AnswerThreadInput): number | undefined {
  if (i.explicitThreadId != null) return i.explicitThreadId // tier 1
  if (i.originResolved) return i.originThreadId // tier 2 (may be undefined: DM origin)
  if (i.liveThreadId != null) return i.liveThreadId // tier 3
  if (i.lastEndedResolvedForChat) return i.lastEndedThreadIdForChat // tier 4
  return i.liveThreadId // catch-all (undefined here)
}

describe('resolveAnswerThreadId — total-enumeration determinism proof (all 64 inputs)', () => {
  const ROWS = allInputs()

  it('the input space is exactly 64 rows (2^6)', () => {
    expect(ROWS.length).toBe(64)
  })

  it('TOTAL: every input returns without throwing', () => {
    for (const i of ROWS) {
      expect(() => resolveAnswerThreadId(i)).not.toThrow()
    }
  })

  it('DETERMINISTIC: each input maps to exactly one output (idempotent across repeated calls)', () => {
    for (const i of ROWS) {
      const a = resolveAnswerThreadId(i)
      const b = resolveAnswerThreadId({ ...i })
      expect(b).toBe(a)
    }
  })

  it('NO FABRICATION: every output is undefined or one of the four input thread fields', () => {
    for (const i of ROWS) {
      const out = resolveAnswerThreadId(i)
      const provenance = new Set([
        undefined,
        i.explicitThreadId,
        i.originThreadId,
        i.liveThreadId,
        i.lastEndedThreadIdForChat,
      ])
      expect(provenance.has(out)).toBe(true)
    }
  })

  it('PRECEDENCE: matches the documented spec on all 64 inputs', () => {
    for (const i of ROWS) {
      expect(resolveAnswerThreadId(i)).toBe(specExpected(i))
    }
  })

  // ── By-construction invariants: the output depends ONLY on the highest
  //    RESOLVED tier, so no lower-tier input (notably a flipped live turn)
  //    can perturb a higher tier's decision. These are the routing guarantees
  //    the resolver exists to provide. ─────────────────────────────────────

  it('INV-1 explicit DOMINANCE: explicit set ⇒ output === explicit, independent of all other fields', () => {
    for (const i of ROWS) {
      if (i.explicitThreadId != null) expect(resolveAnswerThreadId(i)).toBe(i.explicitThreadId)
    }
  })

  it('INV-2 origin FLIP-IMMUNITY: no explicit + originResolved ⇒ output === originThreadId, for EVERY liveThreadId/lastEnded combo (the Brevo→Meta fix: a currentTurn flip cannot steal a resolved origin)', () => {
    for (const i of ROWS) {
      if (i.explicitThreadId == null && i.originResolved) {
        expect(resolveAnswerThreadId(i)).toBe(i.originThreadId)
      }
    }
  })

  it('INV-3 recovery REACHABILITY: tier-4 (lastEnded) result occurs ONLY when no explicit, no origin, no live turn', () => {
    for (const i of ROWS) {
      const out = resolveAnswerThreadId(i)
      // If the result came from the lastEnded field (and that field is the
      // only one carrying that distinct value E), the three higher tiers must
      // all be absent.
      if (out === E) {
        expect(i.explicitThreadId).toBeUndefined()
        expect(i.originResolved).toBe(false)
        expect(i.liveThreadId).toBeUndefined()
        expect(i.lastEndedResolvedForChat).toBe(true)
      }
    }
  })

  it('INV-4 live-tier REACHABILITY: tier-3 (live) result occurs ONLY when no explicit and no resolved origin', () => {
    for (const i of ROWS) {
      const out = resolveAnswerThreadId(i)
      if (out === L) {
        expect(i.explicitThreadId).toBeUndefined()
        expect(i.originResolved).toBe(false)
      }
    }
  })
})
