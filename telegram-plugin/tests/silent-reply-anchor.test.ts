/**
 * Unit suite for #1677 silent-reply auto-edit predicate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TELEGRAM_MSG_CAP,
  decideSilentReplyAnchor,
} from '../silent-reply-anchor.js'

describe('decideSilentReplyAnchor — silent replies edit a single growing anchor', () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT
  })
  afterEach(() => {
    delete process.env.SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT
  })

  it('first silent reply this turn becomes the anchor (fresh send + capture)', () => {
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: null,
      anchorText: '',
      newReplyText: 'on it — checking the calendar',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: true })
  })

  it('subsequent silent reply edits the anchor with paragraph-break merge', () => {
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: 'on it — checking the calendar',
      newReplyText: 'Step 1: hostname is example-host',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({
      kind: 'edit-anchor',
      messageId: 12345,
      mergedText:
        'on it — checking the calendar\n\nStep 1: hostname is example-host',
    })
  })

  it('third and beyond silent replies keep accumulating onto the same anchor', () => {
    // Simulate the multi-step pattern: ack → step1 → step2 → step3.
    // After two prior accumulations the anchor reads as three paragraphs.
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: 'on it\n\nStep 1: hostname\n\nStep 2: OS family',
      newReplyText: 'Step 3: CPU',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d.kind).toBe('edit-anchor')
    if (d.kind === 'edit-anchor') {
      expect(d.mergedText).toBe(
        'on it\n\nStep 1: hostname\n\nStep 2: OS family\n\nStep 3: CPU',
      )
    }
  })

  it('pinged (effectivelySilent=false) reply NEVER merges — fresh send', () => {
    const d = decideSilentReplyAnchor({
      effectivelySilent: false,
      anchorMessageId: 12345,
      anchorText: 'on it\n\nSteps done',
      newReplyText: 'Final answer here',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('files attached → fresh send (anchor cannot absorb media)', () => {
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: 'on it',
      newReplyText: 'here is the chart',
      hasFiles: true,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('button keyboard → fresh send (keyboard semantics across edits is a foot-gun)', () => {
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: 'on it',
      newReplyText: 'choose one:',
      hasFiles: false,
      hasButtons: true,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('empty reply body → fresh send + DO NOT become anchor', () => {
    // The caller has its own empty-text validation; we just avoid
    // leaving a dangling anchor pointer if the empty reply
    // accidentally goes through.
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: null,
      anchorText: '',
      newReplyText: '   ',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('overflow: merged text > TELEGRAM_MSG_CAP → fresh send + start new anchor', () => {
    const huge = 'x'.repeat(TELEGRAM_MSG_CAP - 10)
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: huge,
      newReplyText: 'short tail',
      hasFiles: false,
      hasButtons: false,
    })
    // Merged would be huge + "\n\n" + "short tail" → exceeds cap.
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: true })
  })

  it('kill switch — `SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT=1` short-circuits to fresh send for every reply', () => {
    process.env.SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT = '1'
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: 'on it',
      newReplyText: 'Step 1',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('kill switch accepts string "true" too', () => {
    process.env.SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT = 'true'
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: null,
      anchorText: '',
      newReplyText: 'on it',
      hasFiles: false,
      hasButtons: false,
    })
    expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
  })

  it('borderline merge — exactly at the cap is accepted (boundary inclusive)', () => {
    // Aim merged.length === TELEGRAM_MSG_CAP exactly.
    // separator is "\n\n" (2 chars). anchor + separator + new === cap.
    const newReplyText = 'tail'
    const anchorLen = TELEGRAM_MSG_CAP - newReplyText.length - 2
    const anchor = 'a'.repeat(anchorLen)
    const d = decideSilentReplyAnchor({
      effectivelySilent: true,
      anchorMessageId: 12345,
      anchorText: anchor,
      newReplyText,
      hasFiles: false,
      hasButtons: false,
    })
    expect(d.kind).toBe('edit-anchor')
    if (d.kind === 'edit-anchor') {
      expect(d.mergedText.length).toBe(TELEGRAM_MSG_CAP)
    }
  })

  // Follow-up to #1679 — when the over-ping safety net coerces a
  // model-intended ping to silent, the demoted reply must NOT be
  // merged into the existing silent anchor. The anchor has been
  // edited silently for the whole turn; the user has long since
  // disengaged. Merging the (semantically final) demoted reply
  // there would hide the answer entirely.
  describe('over-ping-suppressed messages bypass anchor merge', () => {
    it('demoted reply with an active anchor lands as a fresh silent (not edit, not next-anchor)', () => {
      const d = decideSilentReplyAnchor({
        effectivelySilent: true,
        anchorMessageId: 12345,
        anchorText: 'on it — gathering facts',
        newReplyText: 'Delivered all three steps with a wrap-up summary.',
        hasFiles: false,
        hasButtons: false,
        wasOverPingSuppressed: true,
      })
      expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
    })

    it('demoted reply with no anchor yet also fresh-sends without capturing the anchor', () => {
      // The model fired a stray ping before any silent ack; the
      // safety-net demoted that ping. A demoted message is never
      // anchor material — it's an answer, not preamble.
      const d = decideSilentReplyAnchor({
        effectivelySilent: true,
        anchorMessageId: null,
        anchorText: '',
        newReplyText: 'Delivered all three steps with a wrap-up summary.',
        hasFiles: false,
        hasButtons: false,
        wasOverPingSuppressed: true,
      })
      expect(d).toEqual({ kind: 'fresh', becomesAnchor: false })
    })

    it('genuinely silent reply (not over-ping-suppressed) still merges normally', () => {
      // Regression guard: the new bypass must not over-fire on
      // legitimate beat-3 silent ticks.
      const d = decideSilentReplyAnchor({
        effectivelySilent: true,
        anchorMessageId: 12345,
        anchorText: 'on it — gathering facts',
        newReplyText: 'Step 1: hostname is example-host',
        hasFiles: false,
        hasButtons: false,
        wasOverPingSuppressed: false,
      })
      expect(d).toEqual({
        kind: 'edit-anchor',
        messageId: 12345,
        mergedText:
          'on it — gathering facts\n\nStep 1: hostname is example-host',
      })
    })

    it('omitting wasOverPingSuppressed defaults to false (backward compat)', () => {
      const d = decideSilentReplyAnchor({
        effectivelySilent: true,
        anchorMessageId: 12345,
        anchorText: 'on it',
        newReplyText: 'next thought',
        hasFiles: false,
        hasButtons: false,
      })
      expect(d.kind).toBe('edit-anchor')
    })
  })
})
