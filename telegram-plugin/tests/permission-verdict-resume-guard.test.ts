/**
 * Structural pin for the permission-card resume beat.
 *
 * What broke (and the bug this guards against): when the operator
 * answers a permission card, the suspended `claude` turn un-parks and
 * resumes the SAME turn — the gateway must flip the awaiting glyph
 * (🙏) back to a working glyph so the operator sees progress instead
 * of a stuck card. That flip is `resumeReactionAfterVerdict()`.
 *
 * The verdict can arrive down several independent paths (button tap,
 * always-allow, `/allow`·`/deny`, TTL auto-deny, free-text `y <id>`/
 * `no <id>` reply, …). Every one of them calls
 * `dispatchPermissionVerdict(...)` to un-park the turn — but the resume
 * glyph flip is a *separate* call right next to it. The free-text-reply
 * path shipped the dispatch WITHOUT the resume (fixed in v0.14.19), so
 * answering via a text reply left the card frozen on 🙏 even though the
 * turn was running. The controller-level behaviour is covered by
 * `status-reactions.test.ts` ("setAwaiting" + watchdog re-arm); mtcute
 * UAT cannot observe reactions at all, so this static pin is the only
 * thing that catches a verdict path forgetting the resume.
 *
 * This guard fails loudly if any `dispatchPermissionVerdict(...)`
 * callsite is not paired with a `resumeReactionAfterVerdict()` within a
 * few lines — i.e. a new (or refactored) verdict path drops the resume.
 *
 * Same pin applies to `postPermissionResumeMessage(...)`: the distinct
 * agent-voiced "got it, continuing: <work>" message is the legible signal
 * the operator actually sees (the reaction lands on a far-up message; the
 * card edit is a one-liner). It rides the exact same 5-paths-drift hazard,
 * so every verdict path must post it too.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf8',
)

const LINES = GATEWAY_SRC.split('\n')

// A `dispatchPermissionVerdict(` occurrence is a CALLSITE unless it's the
// function definition itself.
const isDefinition = (line: string) =>
  /\bfunction\s+dispatchPermissionVerdict\b/.test(line)

const dispatchCallsites = LINES.flatMap((line, i) =>
  /\bdispatchPermissionVerdict\s*\(/.test(line) && !isDefinition(line)
    ? [i]
    : [],
)

// A SILENT auto-allow path (the "⏱ 30 min" scoped-approval short-circuit in
// onPermissionRequest) posts NO card: the turn was never parked on 🙏, so it
// must NOT call resumeReactionAfterVerdict() / postPermissionResumeMessage()
// — doing so on every auto-allowed call is the exact noise that tier removes.
// Such callsites carry the `no-card-verdict` sentinel within the 3 lines above
// the dispatch and are exempt from the resume/post pairing. The invariant the
// guard protects (a verdict that un-parks a CARD must visibly resume it) still
// holds for every card-bearing path.
const isSilentNoCardVerdict = (idx: number): boolean =>
  LINES.slice(Math.max(0, idx - 3), idx + 1).some((l) => /no-card-verdict/.test(l))

// A CARD-FOLDED-RESUME path (the "Allow once" tap, card-ux fix 3) does NOT
// post a separate `postPermissionResumeMessage()` — the agent-voiced "got it,
// continuing: <work>" line is folded INTO the same card edit (below the ✅
// label) via `finalizeCallback`, collapsing the old split second message. The
// turn still resumes (`dispatchPermissionVerdict` + `resumeReactionAfterVerdict`
// both fire) and the operator still sees the continuation — it just rides the
// tapped card instead of fanning out to every card target. Such callsites carry
// the `card-folded-resume` sentinel within the RESUME_WINDOW below the dispatch
// and are exempt ONLY from the post-message pairing (still required to flip the
// glyph). The invariant the guard protects (a verdict that un-parks a card must
// visibly resume it) still holds — the resume is in the card body.
const isCardFoldedResume = (idx: number): boolean =>
  LINES.slice(idx, idx + POST_WINDOW + 1).some((l) => /card-folded-resume/.test(l))

// How far below the dispatch the resume call is allowed to live. The
// widest real gap today is ~9 lines (the slash-command path); 15 gives
// refactor headroom without letting an unrelated resume "cover" a
// dispatch from a different block.
const RESUME_WINDOW = 15

// postPermissionResumeMessage rides ~1–2 lines after resumeReactionAfterVerdict
// on every path, so it can sit a touch further from the dispatch than the
// resume call — give it a little more headroom.
const POST_WINDOW = 20

describe('permission verdict → resume reaction wiring', () => {
  it('there is at least one verdict-dispatch path to guard', () => {
    expect(dispatchCallsites.length).toBeGreaterThan(0)
  })

  it('every dispatchPermissionVerdict() callsite flips the awaiting glyph back via resumeReactionAfterVerdict()', () => {
    const unpaired: number[] = []
    for (const idx of dispatchCallsites) {
      if (isSilentNoCardVerdict(idx)) continue
      const window = LINES.slice(idx, idx + RESUME_WINDOW + 1).join('\n')
      if (!/\bresumeReactionAfterVerdict\s*\(\s*\)/.test(window)) {
        // 1-based line number for a human-readable failure.
        unpaired.push(idx + 1)
      }
    }
    expect(
      unpaired,
      `dispatchPermissionVerdict() at gateway.ts line(s) ` +
        `${unpaired.join(', ')} has no resumeReactionAfterVerdict() within ` +
        `${RESUME_WINDOW} lines — that verdict path leaves the permission ` +
        `card stuck on 🙏 after the operator answers. Add the resume call ` +
        `(see the sibling paths and v0.14.19 / the free-text-reply fix).`,
    ).toEqual([])
  })

  it('the resume helper still exists (the pairing is meaningless if it was deleted)', () => {
    expect(/function\s+resumeReactionAfterVerdict\s*\(/.test(GATEWAY_SRC)).toBe(
      true,
    )
  })

  it('every dispatchPermissionVerdict() callsite posts the agent-voiced resume message via postPermissionResumeMessage() or folds it into the card', () => {
    const unpaired: number[] = []
    for (const idx of dispatchCallsites) {
      if (isSilentNoCardVerdict(idx)) continue
      // Exempt: card-ux fix 3 folds the resume line into the card edit
      // instead of a separate message (still visibly resumes the operator).
      if (isCardFoldedResume(idx)) continue
      const window = LINES.slice(idx, idx + POST_WINDOW + 1).join('\n')
      if (!/\bpostPermissionResumeMessage\s*\(/.test(window)) {
        unpaired.push(idx + 1)
      }
    }
    expect(
      unpaired,
      `dispatchPermissionVerdict() at gateway.ts line(s) ` +
        `${unpaired.join(', ')} has no postPermissionResumeMessage() within ` +
        `${POST_WINDOW} lines — that verdict path resumes the turn silently, ` +
        `so the operator never gets the "got it, continuing: <work>" message. ` +
        `Add the post call next to resumeReactionAfterVerdict() (see sibling paths).`,
    ).toEqual([])
  })

  it('the resume-message helper still exists', () => {
    expect(
      /function\s+postPermissionResumeMessage\s*\(/.test(GATEWAY_SRC),
    ).toBe(true)
  })
})
