/**
 * Unit tests for #549's preamble-suppressor.
 *
 * The suppressor is the buffering policy that decides whether assistant
 * text emitted during a turn is "preamble" (consumed by the next tool's
 * progress-card narrative) or "answer text" (sent to chat). The bug
 * #549 was: every text event went to BOTH surfaces because there was no
 * gate to distinguish preamble from answer.
 *
 * Tests inject a synthetic timer so vi.useFakeTimers gives deterministic
 * windowed behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreambleSuppressor } from '../gateway/preamble-suppressor.js'

describe('PreambleSuppressor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ─── Core flush-after-window behavior ────────────────────────────────

  it('text with no tool: flushes as answer text after bufferMs', () => {
    // The agent emits text and ends the turn without any tool. That
    // text IS the answer; flush to chat after the buffer window.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Hello there!')
    expect(emits).toEqual([])
    vi.advanceTimersByTime(149)
    expect(emits).toEqual([])
    vi.advanceTimersByTime(2)
    expect(emits).toEqual(['Hello there!'])
  })

  it('text-then-non-reply-tool: drops without emitting (the #549 reproducer)', () => {
    // fails when: a regression makes onTool() flush preamble text to
    // chat instead of dropping it. Exact bug class #549 was reporting.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Looking it up.')
    // Tool arrives within the buffer window — this text was preamble.
    vi.advanceTimersByTime(50)
    sup.onTool({ isReplyTool: false })
    // Even after the would-be-flush time elapses, no emission.
    vi.advanceTimersByTime(200)
    expect(emits).toEqual([])
    expect(sup.hasPending()).toBe(false)
  })

  it('text-then-reply-tool: flushes (reply tool is the answer surface)', () => {
    // The reply / stream_reply tool's text payload IS the answer. If
    // the agent also emitted plain text just before, that text is
    // also part of the answer — flush it. (The reply-tool's own dedup
    // path handles overlap with the stream's payload.)
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Here is what I found:')
    sup.onTool({ isReplyTool: true })
    expect(emits).toEqual(['Here is what I found:'])
  })

  it('multiple text chunks before tool: all dropped together', () => {
    // The model streams text in chunks. If a tool follows, ALL chunks
    // were preamble — drop the whole accumulated buffer.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Looking ')
    sup.onText('it ')
    sup.onText('up...')
    vi.advanceTimersByTime(50)
    sup.onTool({ isReplyTool: false })
    vi.advanceTimersByTime(200)
    expect(emits).toEqual([])
  })

  it('multiple text chunks with no tool: flushes all together', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('The answer ')
    vi.advanceTimersByTime(50)
    sup.onText('is 42.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['The answer is 42.'])
  })

  // ─── Multi-segment turn (preamble → tool → answer) ──────────────────

  it('preamble, tool, then answer text: only the answer flushes', () => {
    // The realistic shape: agent thinks-out-loud ("Looking it up..."),
    // calls a tool, then emits the actual answer ("Found it: 42.").
    // Preamble drops; answer flushes.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Looking it up...')
    sup.onTool({ isReplyTool: false })
    sup.onText('Found it: 42.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Found it: 42.'])
  })

  it('cumulative answer text accumulates across multiple non-tool flushes', () => {
    // If the agent emits text, waits, emits more text (no tool in
    // between) — both flush as answer text and the cumulative payload
    // grows. The emit callback receives the cumulative text each time.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Part one. ')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Part one. '])
    sup.onText('Part two.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Part one. ', 'Part one. Part two.'])
  })

  // ─── flushNow / dropNow / reset ──────────────────────────────────────

  it('flushNow: forces immediate flush of pending text', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Pending text.')
    expect(emits).toEqual([])
    sup.flushNow()
    expect(emits).toEqual(['Pending text.'])
    // Idempotent — second flushNow is a no-op (nothing pending).
    sup.flushNow()
    expect(emits).toEqual(['Pending text.'])
  })

  it('dropNow: discards pending text without emitting', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Pending text.')
    sup.dropNow()
    vi.advanceTimersByTime(200)
    expect(emits).toEqual([])
    expect(sup.hasPending()).toBe(false)
  })

  it('reset: clears cumulative answer text + pending', () => {
    // Used at fresh-turn enqueue. After reset, the cumulative answer
    // text is empty — next flush starts the answer payload from scratch.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Turn 1 text.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Turn 1 text.'])
    expect(sup.currentAnswerText()).toBe('Turn 1 text.')

    sup.reset()
    expect(sup.currentAnswerText()).toBe('')

    sup.onText('Turn 2 text.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Turn 1 text.', 'Turn 2 text.'])
  })

  // ─── Edge cases ──────────────────────────────────────────────────────

  it('empty text chunk: no-op, timer not started', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual([])
    expect(sup.hasPending()).toBe(false)
  })

  it('flushNow with empty buffer: no emit', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.flushNow()
    expect(emits).toEqual([])
  })

  it('chunks arriving inside buffer window reset the timer (debounce-style)', () => {
    // A second text chunk before the timer fires should EXTEND the
    // window, not start a separate timer. Otherwise rapid streaming
    // chunks would flush prematurely as separate answer-text emissions.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('chunk 1 ')
    vi.advanceTimersByTime(100)
    sup.onText('chunk 2')
    vi.advanceTimersByTime(100) // 200ms total since first chunk, but only 100ms since last
    expect(emits).toEqual([]) // not flushed yet
    vi.advanceTimersByTime(60)
    expect(emits).toEqual(['chunk 1 chunk 2'])
  })

  it('tool then text then tool: middle text dropped (it was preamble for second tool)', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onTool({ isReplyTool: false })   // first tool — nothing pending
    sup.onText('between tools text')
    sup.onTool({ isReplyTool: false })   // second tool consumes the text as preamble
    vi.advanceTimersByTime(200)
    expect(emits).toEqual([])
  })

  // ─── Cross-turn isolation (regression: dropNow used to leak answerTextOnly) ───

  it('dropNow clears answerTextOnly so next turn does not inherit stale text', () => {
    // Turn-flush silent-marker / context-exhaust teardown calls dropNow().
    // If dropNow left `answerTextOnly` populated, the next turn's first
    // flush would prepend the previous turn's content.
    //
    // fails when: dropNow goes back to clearing only the pending buffer.
    const emits: string[] = []
    const sup = new PreambleSuppressor({
      emitAnswer: (t) => emits.push(t),
      bufferMs: 150,
    })
    sup.onText('Turn 1 answer.')
    vi.advanceTimersByTime(200)
    expect(emits).toEqual(['Turn 1 answer.'])
    expect(sup.currentAnswerText()).toBe('Turn 1 answer.')

    // Silent-marker teardown — drop without flushing.
    sup.dropNow()
    expect(sup.currentAnswerText()).toBe('')

    // Turn 2 begins. Without the clear, the next flush would emit
    // "Turn 1 answer.Turn 2 answer." — which is wrong.
    sup.onText('Turn 2 answer.')
    vi.advanceTimersByTime(200)
    expect(emits[emits.length - 1]).toBe('Turn 2 answer.')
  })

  it('default bufferMs (150) is used when not specified', () => {
    const emits: string[] = []
    const sup = new PreambleSuppressor({ emitAnswer: (t) => emits.push(t) })
    sup.onText('default-window text')
    vi.advanceTimersByTime(149)
    expect(emits).toEqual([])
    vi.advanceTimersByTime(2)
    expect(emits).toEqual(['default-window text'])
  })
})
