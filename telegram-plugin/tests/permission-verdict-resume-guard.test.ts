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

// How far below the dispatch the resume call is allowed to live. The
// widest real gap today is ~9 lines (the slash-command path); 15 gives
// refactor headroom without letting an unrelated resume "cover" a
// dispatch from a different block.
const RESUME_WINDOW = 15

describe('permission verdict → resume reaction wiring', () => {
  it('there is at least one verdict-dispatch path to guard', () => {
    expect(dispatchCallsites.length).toBeGreaterThan(0)
  })

  it('every dispatchPermissionVerdict() callsite flips the awaiting glyph back via resumeReactionAfterVerdict()', () => {
    const unpaired: number[] = []
    for (const idx of dispatchCallsites) {
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
})
