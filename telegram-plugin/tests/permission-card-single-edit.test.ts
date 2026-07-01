/**
 * Structural pin for card-ux fix 3 — the "Allow once" tap updates the SAME
 * card instead of spawning a separate "▶️ … got it, continuing" message.
 *
 * What broke before: tapping Allow edited the card to "✅ Allowed once" AND
 * posted a separate resume message (to EVERY resolvePermissionCardTargets()
 * surface). Ken wants no split — the continuation folds into the tapped card.
 *
 * The turn-resume trigger (dispatchPermissionVerdict) and the glyph flip
 * (resumeReactionAfterVerdict) MUST still fire; only the user-visible second
 * message collapses. mtcute UAT can observe the card edit and a separate
 * sendMessage, but wiring a full Grammy ctx here is heavy, so this is a
 * source-structure pin over the exact callback block (mirrors
 * permission-verdict-resume-guard.test.ts).
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

// Isolate the single "Allow once / Deny" verdict-tap block: from the
// `labelWithResume` construction to the end of its finalizeCallback call.
function allowOnceBlock(): string {
  const start = GATEWAY_SRC.indexOf('const resumeLine = process.env.SWITCHROOM_RESUME_MSG')
  expect(start).toBeGreaterThan(-1)
  // Cut a generous slice covering resumeLine + finalizeCallback + synthInbound.
  return GATEWAY_SRC.slice(start, start + 2000)
}

describe('permission "Allow once" tap → single in-place card edit (card-ux fix 3)', () => {
  it('folds the resume line into the card edit via formatPermissionResumeMessage', () => {
    const block = allowOnceBlock()
    expect(block).toContain('formatPermissionResumeMessage(')
    // The card newText carries BOTH the verdict label and the resume line.
    expect(block).toContain('const labelWithResume = resumeLine')
    expect(block).toMatch(/newText:\s*baseText\s*\?\s*`\$\{baseText\}\\n\\n\$\{labelWithResume\}`/)
  })

  it('does NOT post a separate resume message on this path', () => {
    const block = allowOnceBlock()
    expect(block).not.toContain('postPermissionResumeMessage(')
  })

  it('still fires the turn-resume trigger and glyph flip', () => {
    const block = allowOnceBlock()
    expect(block).toContain('dispatchPermissionVerdict(')
    expect(block).toContain('resumeReactionAfterVerdict()')
  })

  it('honours the SWITCHROOM_RESUME_MSG=0 kill-switch for the folded line', () => {
    const block = allowOnceBlock()
    expect(block).toContain("process.env.SWITCHROOM_RESUME_MSG === '0'")
  })

  it('carries the card-folded-resume sentinel the resume guard keys off', () => {
    const block = allowOnceBlock()
    expect(block).toContain('card-folded-resume')
  })
})
