import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logStreamingEvent, type StreamingEvent } from '../streaming-metrics.js'
import { parseLines, partitionTurns, summarize } from '../streaming-report.js'

/**
 * Capture process.stderr.write into a buffer for each test. Restored in
 * afterEach so one test's writes don't leak into another's expectations.
 */
let writes: string[] = []
let originalWrite: typeof process.stderr.write
let originalFlag: string | undefined

beforeEach(() => {
  writes = []
  originalWrite = process.stderr.write.bind(process.stderr)
  originalFlag = process.env.CLERK_STREAMING_METRICS
  // Cast to any to sidestep the overloaded signature — we only need the
  // first (string) form for our gate.
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stderr.write = originalWrite
  if (originalFlag === undefined) delete process.env.CLERK_STREAMING_METRICS
  else process.env.CLERK_STREAMING_METRICS = originalFlag
})

describe('logStreamingEvent — env gate', () => {
  it('is a no-op when CLERK_STREAMING_METRICS is unset', () => {
    delete process.env.CLERK_STREAMING_METRICS
    logStreamingEvent({
      kind: 'pty_partial_received',
      chatId: 'c1',
      suppressed: false,
      hasStream: false,
      charCount: 10,
      bufferedWithoutChatId: false,
    })
    expect(writes).toHaveLength(0)
  })

  it('is a no-op when CLERK_STREAMING_METRICS is "0"', () => {
    process.env.CLERK_STREAMING_METRICS = '0'
    logStreamingEvent({
      kind: 'turn_end',
      chatId: 'c1',
      durationMs: 100,
      suppressClearedCount: 1,
    })
    expect(writes).toHaveLength(0)
  })

  it('writes exactly one line to stderr when flag is "1"', () => {
    process.env.CLERK_STREAMING_METRICS = '1'
    logStreamingEvent({
      kind: 'stream_reply_called',
      chatId: 'c1',
      charCount: 42,
      done: false,
      streamExisted: true,
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/^\[streaming-metrics\] /)
    expect(writes[0].endsWith('\n')).toBe(true)
  })
})

describe('logStreamingEvent — output format', () => {
  beforeEach(() => {
    process.env.CLERK_STREAMING_METRICS = '1'
  })

  function emitAndParse(ev: StreamingEvent): Record<string, unknown> {
    logStreamingEvent(ev)
    expect(writes).toHaveLength(1)
    const line = writes[0]
    const jsonPart = line.replace(/^\[streaming-metrics\] /, '').trimEnd()
    return JSON.parse(jsonPart) as Record<string, unknown>
  }

  it('includes a numeric ts timestamp', () => {
    const obj = emitAndParse({
      kind: 'reply_called',
      chatId: 'c1',
      charCount: 10,
      replacedPreview: false,
      previewMessageId: null,
    })
    expect(typeof obj.ts).toBe('number')
    expect(obj.ts).toBeGreaterThan(0)
  })

  it('preserves every event field verbatim', () => {
    const obj = emitAndParse({
      kind: 'pty_partial_received',
      chatId: 'chat-9',
      suppressed: true,
      hasStream: true,
      charCount: 256,
      bufferedWithoutChatId: false,
    })
    expect(obj.kind).toBe('pty_partial_received')
    expect(obj.chatId).toBe('chat-9')
    expect(obj.suppressed).toBe(true)
    expect(obj.hasStream).toBe(true)
    expect(obj.charCount).toBe(256)
    expect(obj.bufferedWithoutChatId).toBe(false)
  })

  it('handles null chatId for buffered pty partials', () => {
    const obj = emitAndParse({
      kind: 'pty_partial_received',
      chatId: null,
      suppressed: false,
      hasStream: false,
      charCount: 1,
      bufferedWithoutChatId: true,
    })
    expect(obj.chatId).toBeNull()
    expect(obj.bufferedWithoutChatId).toBe(true)
  })

  it('emits monotonically non-decreasing timestamps across calls', () => {
    const captured: number[] = []
    for (let i = 0; i < 5; i++) {
      writes = []
      logStreamingEvent({
        kind: 'draft_edit',
        chatId: 'c1',
        messageId: 100,
        charCount: i,
        sameAsLast: false,
      })
      const obj = JSON.parse(writes[0].replace(/^\[streaming-metrics\] /, '').trimEnd())
      captured.push(obj.ts as number)
    }
    for (let i = 1; i < captured.length; i++) {
      expect(captured[i]).toBeGreaterThanOrEqual(captured[i - 1])
    }
  })
})

describe('streaming-report parser', () => {
  it('extracts valid events and skips malformed lines', () => {
    const raw = [
      '[streaming-metrics] {"ts":1,"kind":"reply_called","chatId":"c1","charCount":10,"replacedPreview":false,"previewMessageId":null}',
      'noise line',
      '{"ts":2,"kind":"turn_end","chatId":"c1","durationMs":100,"suppressClearedCount":0}',
      '[streaming-metrics] {not-json}',
    ].join('\n')
    const events = parseLines(raw)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('reply_called')
    expect(events[1].kind).toBe('turn_end')
  })

  it('partitions events into turns and computes H-evidence counts', () => {
    const events = parseLines(
      [
        '[streaming-metrics] {"ts":1,"kind":"pty_partial_received","chatId":null,"bufferedWithoutChatId":true,"suppressed":false,"hasStream":false,"charCount":5}',
        '[streaming-metrics] {"ts":2,"kind":"pty_partial_received","chatId":"c1","bufferedWithoutChatId":false,"suppressed":false,"hasStream":true,"charCount":10}',
        '[streaming-metrics] {"ts":3,"kind":"reply_called","chatId":"c1","charCount":50,"replacedPreview":true,"previewMessageId":999}',
        '[streaming-metrics] {"ts":4,"kind":"pty_partial_received","chatId":"c1","bufferedWithoutChatId":false,"suppressed":true,"hasStream":false,"charCount":15}',
        '[streaming-metrics] {"ts":5,"kind":"draft_edit","chatId":"c1","messageId":999,"charCount":50,"sameAsLast":false}',
        '[streaming-metrics] {"ts":6,"kind":"turn_end","chatId":"c1","durationMs":5000,"suppressClearedCount":1}',
      ].join('\n'),
    )
    const turns = partitionTurns(events)
    expect(turns).toHaveLength(1)
    const t = turns[0]
    expect(t.replyCalled).toBe(1)
    expect(t.streamReplyCalled).toBe(0)
    expect(t.ptyBufferedNoChatId).toBe(1)
    expect(t.ptySuppressedAfterReply).toBe(1)
    expect(t.draftEdits).toBe(1)
    const summary = summarize(turns)
    expect(summary).toContain('reply_called total:        1')
    expect(summary).toContain('H3 — pty_partial with bufferedWithoutChatId: 1')
    expect(summary).toContain('H4 — pty_partial suppressed after first reply in turn: 1')
  })
})
