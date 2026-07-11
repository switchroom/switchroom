import { describe, it, expect } from 'vitest'
import {
  redactAskUserFields,
  redactChecklistFields,
} from '../outbound-field-redact.js'
import { redact } from '../secret-detect/redact.js'

/**
 * OUTCOME tests for the #2044 structured-payload outbound scrub (F1/F2).
 *
 * These exercise the exact helpers the gateway calls (redactAskUserFields
 * for ask_user, redactChecklistFields for send_checklist / update_checklist),
 * injecting the SAME real `redact()` the gateway's redactOutboundText wraps.
 * The assertion is on the SENT PAYLOAD the helper returns — a secret echoed
 * into a question, an option/button label, a checklist title, or a task's
 * text must be masked (marker present, raw token absent) — not merely that a
 * redactor was invoked.
 *
 * Secrets are assembled at runtime (per CLAUDE.md "Secrets in tests") so the
 * source file never contains a contiguous token that trips push-protection.
 */

// A realistic GitHub classic PAT shape (ghp_ + 36 chars) — high-confidence,
// masked by redact() to a [REDACTED:github_pat_classic] marker.
const SECRET = 'ghp' + '_' + 'AbCdEfGhIj0123456789KlMnOpQrStUvWxYz'

describe('redactAskUserFields — ask_user outbound scrub (F1)', () => {
  it('masks a secret echoed into the QUESTION text', () => {
    const out = redactAskUserFields(
      `Deploy with token ${SECRET}?`,
      ['Yes', 'No'],
      redact,
    )
    expect(out.question).not.toContain(SECRET)
    expect(out.question).toContain('[REDACTED')
    // Non-secret prose is preserved.
    expect(out.question).toContain('Deploy with token')
  })

  it('masks a secret echoed into an OPTION / button label', () => {
    const out = redactAskUserFields(
      'Which key?',
      ['Cancel', `Use ${SECRET}`],
      redact,
    )
    expect(out.options[0]).toBe('Cancel')
    expect(out.options[1]).not.toContain(SECRET)
    expect(out.options[1]).toContain('[REDACTED')
  })

  it('leaves clean question + options untouched', () => {
    const out = redactAskUserFields('Proceed?', ['Yes', 'No'], redact)
    expect(out.question).toBe('Proceed?')
    expect(out.options).toEqual(['Yes', 'No'])
  })

  it('does not mutate the caller-supplied options array', () => {
    const options = ['Cancel', `Use ${SECRET}`]
    redactAskUserFields('q', options, redact)
    expect(options[1]).toBe(`Use ${SECRET}`) // original array untouched
  })
})

describe('redactChecklistFields — checklist outbound scrub (F2)', () => {
  it('masks a secret in the checklist TITLE', () => {
    const out = redactChecklistFields(
      `Rotate ${SECRET}`,
      [{ text: 'step one' }],
      redact,
    )
    expect(out.title).not.toContain(SECRET)
    expect(out.title).toContain('[REDACTED')
  })

  it('masks a secret in a TASK text and preserves other task fields', () => {
    const out = redactChecklistFields(
      'Onboarding',
      [
        { text: 'read the docs', done: true },
        { text: `save ${SECRET} to vault`, id: '7' },
      ],
      redact,
    )
    expect(out.tasks![0]).toEqual({ text: 'read the docs', done: true })
    expect(out.tasks![1]!.text).not.toContain(SECRET)
    expect(out.tasks![1]!.text).toContain('[REDACTED')
    // Sibling fields on the redacted task are carried through untouched.
    expect(out.tasks![1]!.id).toBe('7')
  })

  it('passes undefined title / tasks through (update_checklist partial patch)', () => {
    const out = redactChecklistFields(undefined, undefined, redact)
    expect(out.title).toBeUndefined()
    expect(out.tasks).toBeUndefined()
  })

  it('leaves an id-only task (no text) untouched', () => {
    const out = redactChecklistFields(undefined, [{ id: '3', done: true }], redact)
    expect(out.tasks![0]).toEqual({ id: '3', done: true })
  })

  it('does not mutate the caller-supplied task objects', () => {
    const tasks = [{ text: `save ${SECRET}` }]
    redactChecklistFields('t', tasks, redact)
    expect(tasks[0]!.text).toBe(`save ${SECRET}`) // original untouched
  })
})
