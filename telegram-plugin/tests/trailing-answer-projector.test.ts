import { describe, it, expect } from 'vitest'
import { projectTrailingAnswerFromTranscript } from '../session-tail.js'

/**
 * Pins the crash-survival redelivery transcript projector: recovering the
 * finished-but-never-sent trailing answer from a session JSONL after a
 * pre-flush crash, and refusing to redeliver a dangling mid-tool preamble.
 */

function assistantText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}
function assistantToolUse(name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id: 'toolu_x', input: {} }] },
  })
}
function enqueue(text: string): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: text })
}

describe('projectTrailingAnswerFromTranscript', () => {
  it('recovers the trailing answer text after the last tool_use', () => {
    const transcript = [
      enqueue('what is the deploy status?'),
      assistantText('Let me check.'),
      assistantToolUse('Bash'),
      assistantText('The deploy finished — all three services are green.'),
    ].join('\n')
    const r = projectTrailingAnswerFromTranscript(transcript)
    expect(r.trailingIsText).toBe(true)
    expect(r.text).toBe('The deploy finished — all three services are green.')
  })

  it('does NOT treat a dangling tool_use as a redeliverable answer', () => {
    const transcript = [
      enqueue('run the migration'),
      assistantText('On it — running the migration now.'),
      assistantToolUse('Bash'),
    ].join('\n')
    const r = projectTrailingAnswerFromTranscript(transcript)
    expect(r.trailingIsText).toBe(false)
    // the preamble was reset by the tool_use; nothing trailing to send
    expect(r.text).toBe('')
  })

  it('scopes to the LAST turn only (a prior turn answer is not resurfaced)', () => {
    const transcript = [
      enqueue('first question'),
      assistantText('First answer.'),
      enqueue('second question'),
      assistantText('Second answer.'),
    ].join('\n')
    const r = projectTrailingAnswerFromTranscript(transcript)
    expect(r.text).toBe('Second answer.')
  })

  it('suppresses an isApiErrorMessage synthetic line (never redeliver an error string)', () => {
    const transcript = [
      enqueue('do the thing'),
      JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: "You've hit your limit · resets 5pm" }] },
      }),
    ].join('\n')
    const r = projectTrailingAnswerFromTranscript(transcript)
    expect(r.text).toBe('')
    expect(r.trailingIsText).toBe(false)
  })

  it('concatenates multiple trailing text blocks of the final answer', () => {
    const transcript = [
      enqueue('q'),
      assistantToolUse('Read'),
      assistantText('Part one. '),
      assistantText('Part two.'),
    ].join('\n')
    const r = projectTrailingAnswerFromTranscript(transcript)
    expect(r.text).toBe('Part one. Part two.')
    expect(r.trailingIsText).toBe(true)
  })
})
