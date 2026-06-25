/**
 * Emission-authority façade — structural (source-read) assertions for PR-4a of
 * the message-emission-determinism refactor.
 *
 * PR-4a introduces a kill-switched, behaviourally-IDENTICAL no-op seam: a
 * per-foreground-turn emission-authority façade (`emission-authority.ts`) that
 * the foreground-lane card/ping emission call sites route through. In PR-4a
 * EVERY façade method is a thin delegate — no decision logic moves in (that is
 * PR-4b-4e). These tests pin that the seam is wired AND that it is still a
 * no-op:
 *
 *   1. The 6 drain sites + 2 finalize blocks + the over-ping block now reference
 *      the façade methods, with the per-site producer args preserved verbatim.
 *   2. The façade's disabled and enabled branches are behaviourally identical in
 *      PR-4a (no decision token like `mayOpenActivityCard` has moved into the
 *      façade yet — that is PR-4b).
 *   3. `SWITCHROOM_EMISSION_AUTHORITY` parses default-OFF (`=== '1'`).
 *   4. The seam delegates to the existing
 *      `drainActivitySummary`/`clearActivitySummary`/`decideOverPing` — the
 *      load-bearing literals stay AT THE CALL SITE.
 *
 * Pure source-reads (the gateway IIFE can't be instantiated in-process; the
 * pattern mirrors emission-determinism-wiring.test.ts). NO sqlite import, so
 * this runs cleanly under vitest (the bun/vitest split gotcha).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const facadeSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'emission-authority.ts'),
  'utf-8',
)
/**
 * The façade source with comment lines stripped, so "no executable reference to
 * X" assertions don't trip on a legitimate prose mention of a primitive name in
 * a doc-comment (the seam is heavily documented). Drops `//`/`*`/`/**`-style
 * comment lines; keeps real code.
 */
const facadeCode = facadeSrc
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
  })
  .join('\n')
const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

/** Source of a named gateway function up to the next top-level definition. */
function fnSrc(name: string): string {
  const after = gatewaySrc.split(`function ${name}(`)[1] ?? ''
  return after.split('\nasync function ')[0]?.split('\nfunction ')[0] ?? after
}

describe('SWITCHROOM_EMISSION_AUTHORITY kill-switch (default OFF)', () => {
  it('parses with `=== "1"` semantic so an unset env var is OFF (default off)', () => {
    expect(facadeSrc).toMatch(
      /EMISSION_AUTHORITY_ENABLED\s*=\s*process\.env\.SWITCHROOM_EMISSION_AUTHORITY\s*===\s*'1'/,
    )
  })

  it('is read ONCE at module top, not per-call (a single module-level const)', () => {
    const reads = [...facadeSrc.matchAll(/process\.env\.SWITCHROOM_EMISSION_AUTHORITY/g)]
    expect(reads).toHaveLength(1)
    // The const initialiser sits at module scope (no leading indentation),
    // mirroring the gateway flag region convention.
    expect(facadeSrc).toMatch(/\nexport const EMISSION_AUTHORITY_ENABLED =/)
  })
})

describe('façade is a no-op in PR-4a — both kill-switch branches delegate identically', () => {
  /** Body of a façade method up to the next method/`}` at method indentation. */
  function methodBody(name: string): string {
    const after = facadeSrc.split(`${name}(`)[1] ?? ''
    // Stop at the next method declaration (two-space indent + identifier + `(`)
    // or the class close.
    return after.split(/\n  [A-Za-z]+[(<]/)[0] ?? after
  }

  // PR-4b: `openOrEditCard` is DELIBERATELY dropped from this no-op loop — its
  // enabled branch now GATES `apply()` behind the OPEN verdict (no longer an
  // identical no-op). It gets a dedicated shape test below. The other three
  // façade methods remain identical no-ops in both branches.
  for (const m of [
    'finalizeCard',
    'markSubstantiveFinalDelivered',
    'claimOrDowngradePing',
  ]) {
    it(`${m} runs the SAME delegate in the enabled and disabled branch (identical no-op)`, () => {
      const body = methodBody(m)
      // The enabled branch is gated on the flag and, in PR-4a, just runs apply()
      // exactly like the disabled fall-through. Assert BOTH an
      // `if (EMISSION_AUTHORITY_ENABLED)` branch and a bare `apply()` exist, and
      // that NO decision token has leaked into these façade methods.
      expect(body).toMatch(/if\s*\(EMISSION_AUTHORITY_ENABLED\)/)
      const applyCalls = [...body.matchAll(/apply\(\)/g)]
      // One in the enabled branch, one in the disabled fall-through.
      expect(applyCalls.length).toBeGreaterThanOrEqual(2)
    })
  }

  it('no decision token leaked into the no-op façade methods (only openOrEditCard gates in PR-4b)', () => {
    // The three remaining no-op methods (finalize / markSubstantive / overping)
    // move NO decision logic in. Only `openOrEditCard` consults a verdict — and
    // it does so ONLY inside its EMISSION_AUTHORITY_ENABLED branch (asserted in
    // the dedicated describe below). `decideOverPing` must NOT be CALLED/IMPORTED
    // in the façade (a prose mention in a doc-comment is fine).
    expect(facadeSrc).not.toMatch(/import .*decideOverPing/)
    expect(facadeCode).not.toMatch(/decideOverPing\(/)
  })

  it('mayDrain is a PURE READ — returns activityInFlight == null, acquires no lock', () => {
    const after = facadeSrc.split('mayDrain(')[1] ?? ''
    const body = after.split('\n}')[0] ?? after
    expect(body).toMatch(/activityInFlight == null/)
    // PR-4d invariant: mayDrain must not acquire chatLock. No lock token in body.
    expect(body).not.toMatch(/chatLock|acquire|lock\(/i)
  })

  it('the PR-4d deadlock invariant is documented verbatim-ish in the module header', () => {
    expect(facadeSrc).toMatch(/mayDrain` is a (pure|PURE) read/i)
    expect(facadeSrc).toMatch(/must NOT acquire `chatLock`/)
  })
})

describe('openOrEditCard — PR-4b OPEN-gate moves into the façade (inverts the 4a no-op proof for this method)', () => {
  /** Body of `openOrEditCard` up to the next method declaration / class close. */
  function openOrEditBody(): string {
    const after = facadeSrc.split('openOrEditCard(')[1] ?? ''
    return after.split(/\n  [A-Za-z]+[(<]/)[0] ?? after
  }

  it('the façade NOW imports + consults the open verdict (computeFeedOpenVerdict) — inverted from PR-4a', () => {
    // PR-4a asserted NO decision token had moved in. PR-4b INVERTS that for the
    // OPEN gate: the verdict helper is imported and CALLED in the façade.
    expect(facadeSrc).toMatch(/import\s*\{[^}]*computeFeedOpenVerdict[^}]*\}\s*from\s*'\.\/feed-open-gate\.js'/)
    expect(facadeCode).toMatch(/computeFeedOpenVerdict\(/)
  })

  it('the verdict is consulted ONLY inside the EMISSION_AUTHORITY_ENABLED branch (disabled branch stays a pure pass-through)', () => {
    const body = openOrEditBody()
    const flagIdx = body.indexOf('if (EMISSION_AUTHORITY_ENABLED)')
    const verdictIdx = body.indexOf('computeFeedOpenVerdict(')
    expect(flagIdx).toBeGreaterThan(-1)
    expect(verdictIdx).toBeGreaterThan(-1)
    // The verdict call sits AFTER the enabled-branch guard opens.
    expect(verdictIdx).toBeGreaterThan(flagIdx)
    // The DISABLED fall-through (after the enabled branch returns) is a bare
    // apply() with no verdict: the LAST statement of the method is `apply()` and
    // there is no second computeFeedOpenVerdict call outside the enabled branch.
    const verdictCalls = [...body.matchAll(/computeFeedOpenVerdict\(/g)]
    expect(verdictCalls).toHaveLength(1)
  })

  it('enabled branch GUARDS apply() behind the verdict; disabled branch calls apply() UNCONDITIONALLY', () => {
    const body = openOrEditBody()
    // Enabled branch: a refusal returns BEFORE apply() when the OPEN is refused
    // (the relocated `break`). The guard keys on the verdict's isOpen/mayOpen.
    expect(body).toMatch(/if\s*\(!isOpen\s*&&\s*!mayOpen\)\s*return/)
    // Both isOpen and mayOpen come from the destructured verdict.
    expect(body).toMatch(/const\s*\{\s*isOpen,\s*mayOpen\s*\}\s*=\s*computeFeedOpenVerdict\(/)
    // Disabled branch: after the enabled branch returns, the method falls
    // through to an unconditional `apply()` then the method `}` — 4a behaviour
    // preserved when the flag is OFF (no verdict consulted on this path).
    expect(body).toMatch(/return\s*\n\s*\}\s*\n\s*apply\(\)\s*\n\s*\}/)
  })
})

describe('façade delegates to the existing emission primitives (call-site literals preserved)', () => {
  it('openOrEditCard / mayDrain wrap drainActivitySummary at the call sites (not CALLED inside the façade)', () => {
    // The façade does NOT IMPORT or CALL drainActivitySummary — the delegate
    // thunk at the call site does, so the existing wiring oracle still sees it.
    // (A prose mention in a doc-comment is fine.)
    expect(facadeSrc).not.toMatch(/import .*drainActivitySummary/)
    expect(facadeCode).not.toMatch(/drainActivitySummary\(/)
    // The drain call literal is preserved inside an openOrEditCard delegate
    // thunk: `openOrEditCard('<producer>', () => { turn.activityInFlight =
    // drainActivitySummary(...) })`.
    expect(gatewaySrc).toMatch(
      /openOrEditCard\('[a-z]+', \(\) => \{\s*\n\s*turn\.activityInFlight = drainActivitySummary/,
    )
  })

  it('finalizeCard wraps clearActivitySummary at the call sites (not CALLED inside the façade)', () => {
    expect(facadeSrc).not.toMatch(/import .*clearActivitySummary/)
    expect(facadeCode).not.toMatch(/clearActivitySummary\(/)
    expect(gatewaySrc).toMatch(/finalizeCard\(\(\) => \{\s*\n\s*clearActivitySummary\(/)
  })

  it('claimOrDowngradePing wraps the decideOverPing block at the call site (not CALLED inside the façade)', () => {
    expect(facadeSrc).not.toMatch(/import .*decideOverPing/)
    expect(facadeCode).not.toMatch(/decideOverPing\(/)
    // The decideOverPing call now lives inside a claimOrDowngradePing delegate.
    const pingIdx = gatewaySrc.indexOf('claimOrDowngradePing(')
    expect(pingIdx).toBeGreaterThan(-1)
    const window = gatewaySrc.slice(pingIdx, pingIdx + 1200)
    expect(window).toMatch(/decideOverPing\(/)
  })
})

describe('the 6 drain sites route through the façade with producers preserved verbatim', () => {
  it('the narrative SHOW site routes via openOrEditCard("narrative") + the producer-"narrative" drain', () => {
    const body = fnSrc('showNarrativeStep')
    expect(body).toMatch(/openOrEditCard\('narrative'/)
    // The drain literal (producer arg verbatim) is preserved in the delegate.
    expect(body).toMatch(/drainActivitySummary\(turn,\s*'narrative'\)/)
    // The single-flight read is routed through the pure mayDrain.
    expect(body).toMatch(/ea\.mayDrain\(turn\)/)
  })

  it('both liveness sites in feedHeartbeatTick route via openOrEditCard("liveness") + producer-"liveness" drains', () => {
    const body = fnSrc('feedHeartbeatTick')
    const opens = [...body.matchAll(/openOrEditCard\('liveness'/g)]
    expect(opens).toHaveLength(2)
    const drains = [...body.matchAll(/drainActivitySummary\(turn,\s*'liveness'\)/g)]
    expect(drains).toHaveLength(2)
    // The literal the feed-heartbeat oracle greps must still be present.
    expect(body).toMatch(/turn\.activityInFlight = drainActivitySummary/)
  })

  it('the tool_label site routes via openOrEditCard("tool") + the producer-"tool" drain', () => {
    expect(gatewaySrc).toMatch(/openOrEditCard\('tool',\s*\(\) => \{\s*\n\s*turn\.activityInFlight = drainActivitySummary\(turn,\s*'tool'\)/)
  })

  it('both foreground sub-agent drains route via openOrEditCard("tool") with producer made EXPLICIT', () => {
    // Previously these called drainActivitySummary(turn) with the implicit
    // 'tool' default; PR-4a makes 'tool' explicit at both, per the plan.
    const opens = [...gatewaySrc.matchAll(/ea\.openOrEditCard\('tool', \(\) => \{\s*\n\s*turn\.activityInFlight = drainActivitySummary\(turn, 'tool'\)/g)]
    // tool_label site (1) + the two sub-agent drains (2) = 3 'tool' openers.
    expect(opens.length).toBeGreaterThanOrEqual(3)
    // No foreground drain still uses the bare implicit-producer form.
    expect(gatewaySrc).not.toMatch(/turn\.activityInFlight = drainActivitySummary\(turn\)\n/)
  })

  it('every routed drain site guards the single-flight via ea.mayDrain(turn), not a bare activityInFlight read', () => {
    const mayDrainGuards = [...gatewaySrc.matchAll(/if \(ea\.mayDrain\(turn\)\)/g)]
    // narrative + 2 liveness + tool + 2 sub-agent = 6 routed single-flight gates.
    expect(mayDrainGuards).toHaveLength(6)
  })
})

describe('the 2 lever-2 finalize blocks route through the façade', () => {
  it('executeReply finalize routes via markSubstantiveFinalDelivered + finalizeCard (latch + clear preserved)', () => {
    const after = gatewaySrc.split('async function executeReply(')[1] ?? ''
    const body = after.split('async function executeStreamReply(')[0] ?? after
    expect(body).toMatch(/markSubstantiveFinalDelivered\(\(\) => \{\s*\n\s*finalizeTurn\.finalAnswerEverDelivered = true/)
    expect(body).toMatch(/finalizeCard\(\(\) => \{\s*\n\s*clearActivitySummary\(finalizeTurn\)/)
  })

  it('executeStreamReply finalize routes via markSubstantiveFinalDelivered + finalizeCard (latch + clear preserved)', () => {
    const after = gatewaySrc.split('async function executeStreamReply(')[1] ?? ''
    const body = after.split('\nasync function ')[0]?.split('\nfunction ')[0] ?? after
    expect(body).toMatch(/markSubstantiveFinalDelivered\(\(\) => \{\s*\n\s*turn\.finalAnswerEverDelivered = true/)
    expect(body).toMatch(/finalizeCard\(\(\) => \{\s*\n\s*clearActivitySummary\(turn\)/)
  })
})

describe('per-turn construction — one façade per turn, explicit chat/thread key (PR-4e seam)', () => {
  it('the turn ctor constructs a fresh EmissionAuthority with the explicit statusKey', () => {
    // Per-turn: born in the CurrentTurn object literal so it is discarded with
    // the turn and never persists across turns.
    expect(gatewaySrc).toMatch(/emissionAuthority: new EmissionAuthority\(\s*\n\s*statusKey\(/)
  })

  it('the façade constructor takes the chat/thread key EXPLICITLY (the PR-4e map seam)', () => {
    expect(facadeSrc).toMatch(/constructor\(private readonly chatKey: string\)/)
  })

  it('the accessor lazily backfills a per-turn façade keyed on the turn\'s statusKey', () => {
    const body = fnSrc('emissionAuthorityFor')
    expect(body).toMatch(/new EmissionAuthority\(\s*\n\s*statusKey\(turn\.sessionChatId, turn\.sessionThreadId\)/)
  })
})
