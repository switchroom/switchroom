/**
 * Render-safety pin for the agent-initiated vault-access approval card.
 *
 * Bug (card-ux fix 2): the vault key was interpolated into a `code span`
 * WITHOUT defusing backtick / without leaking backslashes. A key with a
 * backtick would prematurely close the span; the following `_why_` and
 * `_footer_` markdown then paired against stray delimiters and the card
 * rendered on top of itself. Keys with `_` (e.g. `openai/OPENAI_API_KEY`)
 * must render literally inside the span (no visible `\_`).
 */

import { describe, it, expect } from 'bun:test'
import { renderVaultRequestAccessCard } from '../gateway/vault-request-access-card.js'

// Zero-width space codeSpanSafe inserts after a backtick to defuse it.
const ZWSP = '​'

/** Count top-level (outside code spans) markdown emphasis delimiters. */
function unbalancedOutsideCodeSpans(text: string): {
  underscores: number
  asterisks: number
} {
  let inSpan = false
  let underscores = 0
  let asterisks = 0
  for (const ch of text) {
    if (ch === '`') {
      inSpan = !inSpan
      continue
    }
    if (inSpan) continue
    if (ch === '_') underscores += 1
    if (ch === '*') asterisks += 1
  }
  return { underscores, asterisks }
}

describe('renderVaultRequestAccessCard', () => {
  it('renders an underscore-laden key literally inside the code span (no backslash leak)', () => {
    const text = renderVaultRequestAccessCard({
      agent: 'overlord',
      key: 'openai/OPENAI_API_KEY',
      scope: 'read',
      reason: 'call the completions endpoint',
      ttl_seconds: 7 * 86400,
    })
    // The key rides in a code span verbatim — underscores present, NOT escaped.
    expect(text).toContain('`openai/OPENAI_API_KEY`')
    // No visible backslash-escaping leaked into the span.
    expect(text).not.toContain('OPENAI\\_API\\_KEY')
  })

  it('does not leave unbalanced markdown delimiters outside code spans', () => {
    const text = renderVaultRequestAccessCard({
      agent: 'overlord',
      key: 'openai/OPENAI_API_KEY',
      scope: 'write',
      reason: 'rotate the key',
      ttl_seconds: 3600,
    })
    const { underscores, asterisks } = unbalancedOutsideCodeSpans(text)
    // The `_why_` + `_footer_` italic pairs and `**agent**` bold pair must
    // each be even outside the spans — an underscore-key leaking out (the bug)
    // makes this odd.
    expect(underscores % 2).toBe(0)
    expect(asterisks % 2).toBe(0)
  })

  it('defuses a backtick in the key so it cannot close the span early', () => {
    const text = renderVaultRequestAccessCard({
      agent: 'overlord',
      key: 'svc/we`ird',
      scope: 'read',
      ttl_seconds: 86400,
    })
    // A raw backtick would have closed the span; codeSpanSafe splits it with a
    // zero-width space so the parser sees `` `we` `` (empty-ish) then literal
    // text, never an unterminated span breaking the following lines.
    expect(text).toContain(`we\`${ZWSP}ird`)
    // Every intentional code-span backtick is immediately followed by
    // non-backtick content or a ZWSP — no bare `\`\`` that would swallow text.
    expect(text).not.toContain('``')
  })

  it('renders "not provided" when reason omitted', () => {
    const text = renderVaultRequestAccessCard({
      agent: 'overlord',
      key: 'svc/key',
      scope: 'read',
      ttl_seconds: 86400,
    })
    expect(text).toContain('why: _not provided_')
  })
})
