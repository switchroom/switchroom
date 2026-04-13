import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDraftStream } from '../draft-stream.js'

interface MockTelegram {
  send: (text: string) => Promise<number>
  edit: (id: number, text: string) => Promise<void>
  sendCalls: Array<{ text: string; t: number }>
  editCalls: Array<{ id: number; text: string; t: number }>
  nextId: number
  failNext: 'never' | 'send' | 'edit' | 'notModified'
  startTime: number
}

function makeMock(): MockTelegram {
  const m: MockTelegram = {
    send: async () => 0,
    edit: async () => {},
    sendCalls: [],
    editCalls: [],
    nextId: 100,
    failNext: 'never',
    startTime: Date.now(),
  }
  m.send = async (text: string) => {
    if (m.failNext === 'send') {
      m.failNext = 'never'
      throw new Error('send failed')
    }
    const id = m.nextId++
    m.sendCalls.push({ text, t: Date.now() - m.startTime })
    return id
  }
  m.edit = async (id: number, text: string) => {
    if (m.failNext === 'notModified') {
      m.failNext = 'never'
      throw new Error('Bad Request: message is not modified')
    }
    if (m.failNext === 'edit') {
      m.failNext = 'never'
      throw new Error('edit failed')
    }
    m.editCalls.push({ id, text, t: Date.now() - m.startTime })
  }
  return m
}

async function microtaskFlush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

describe('createDraftStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('first update calls send, captures the message id', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('Hello world')
    await microtaskFlush()

    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('Hello world')
    expect(m.editCalls.length).toBe(0)
    expect(stream.getMessageId()).toBe(100)
  })

  it('subsequent updates call edit on the same message id', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('Step 1')
    await microtaskFlush()

    // Need to wait for throttle window
    vi.advanceTimersByTime(1000)
    void stream.update('Step 1 → Step 2')
    await microtaskFlush()

    expect(m.sendCalls.length).toBe(1)
    expect(m.editCalls.length).toBe(1)
    expect(m.editCalls[0].id).toBe(100)
    expect(m.editCalls[0].text).toBe('Step 1 → Step 2')
  })

  it('rapid updates within throttle window collapse to the latest', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('initial')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    // Three rapid updates within ~100ms
    void stream.update('a')
    void stream.update('b')
    void stream.update('c')
    await microtaskFlush()

    // Throttle window not yet open
    expect(m.editCalls.length).toBe(0)

    // Open the window
    vi.advanceTimersByTime(1000)
    await microtaskFlush()

    // Only the latest text lands
    expect(m.editCalls.length).toBe(1)
    expect(m.editCalls[0].text).toBe('c')
  })

  it('finalize flushes pending text immediately', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('initial')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    // Update during throttle window — would normally wait
    void stream.update('final answer')
    await microtaskFlush()
    expect(m.editCalls.length).toBe(0)

    // finalize() should bypass the wait and edit immediately
    await stream.finalize()

    expect(m.editCalls.length).toBe(1)
    expect(m.editCalls[0].text).toBe('final answer')
    expect(stream.isFinal()).toBe(true)
  })

  it('updates after finalize are silently dropped', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('initial')
    await microtaskFlush()
    await stream.finalize()

    void stream.update('too late')
    vi.advanceTimersByTime(5000)
    await microtaskFlush()

    expect(m.editCalls.length).toBe(0)
  })

  it('treats "message is not modified" as success', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    // Force the next edit to throw "not modified"
    m.failNext = 'notModified'
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()

    // The edit attempt happened (and threw, then we caught it)
    // No exception bubbled out
    expect(stream.isFinal()).toBe(false)
  })

  it('skips edit when text is unchanged from last sent', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('hello')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    vi.advanceTimersByTime(1000)
    void stream.update('hello') // same text
    await microtaskFlush()

    expect(m.editCalls.length).toBe(0)
  })

  it('hard-stops when text exceeds maxChars', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      maxChars: 100,
    })

    void stream.update('short')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    vi.advanceTimersByTime(1000)
    void stream.update('x'.repeat(200))
    await microtaskFlush()

    // The over-limit edit was suppressed
    expect(m.editCalls.length).toBe(0)
  })

  it('throttle window opens at lastSent + throttleMs', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('a')
    await microtaskFlush()
    const sendT = m.sendCalls[0].t

    void stream.update('b')
    await microtaskFlush()
    expect(m.editCalls.length).toBe(0)

    // Wait until just before the throttle window opens
    vi.advanceTimersByTime(999)
    await microtaskFlush()
    expect(m.editCalls.length).toBe(0)

    // Cross the boundary
    vi.advanceTimersByTime(1)
    await microtaskFlush()
    expect(m.editCalls.length).toBe(1)
    expect(m.editCalls[0].text).toBe('b')
    // Edit should land at roughly sendT + throttleMs
    expect(m.editCalls[0].t).toBeGreaterThanOrEqual(sendT + 1000)
  })

  it('recovers from "message to edit not found" by re-sending', async () => {
    const m = makeMock()
    m.edit = async (_id: number, _text: string) => {
      throw new Error('Bad Request: message to edit not found')
    }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)
    expect(stream.getMessageId()).toBe(100)

    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    // Edit fails → stream requeues for a fresh send on next iteration
    await microtaskFlush()

    // After recovery, the stream should have a NEW message id from the re-send
    expect(m.sendCalls.length).toBe(2)
    expect(m.sendCalls[1].text).toBe('second')
    expect(stream.getMessageId()).toBe(101)
  })

  it('also recognizes MESSAGE_ID_INVALID as a not-found signal', async () => {
    const m = makeMock()
    m.edit = async () => { throw new Error('MESSAGE_ID_INVALID') }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    await microtaskFlush()

    expect(m.sendCalls.length).toBe(2)
    expect(stream.getMessageId()).toBe(101)
  })

  it('non-recoverable edit errors do NOT requeue (no infinite retry loop)', async () => {
    const m = makeMock()
    m.edit = async () => { throw new Error('Forbidden: bot was blocked by user') }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()

    // The generic error path doesn't re-send; messageId stays captured,
    // and the next update can retry edit normally.
    expect(m.sendCalls.length).toBe(1)
    expect(stream.getMessageId()).toBe(100)
  })

  // ─── Pre-send idle coalesce (idleMs) ──────────────────────────────────

  it('idleMs=0 preserves legacy behavior (first update fires immediately)', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000, idleMs: 0 })
    void stream.update('hi')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)
  })

  it('idleMs defers the first send, collapsing a burst into one API call', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000, idleMs: 200 })

    // Rapid burst — none should fire yet
    void stream.update('a')
    void stream.update('ab')
    void stream.update('abc')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(0)

    // Advance past the idle window
    vi.advanceTimersByTime(200)
    await microtaskFlush()

    // Exactly one send with the LATEST text
    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('abc')
  })

  it('idleMs timer is reset on each subsequent update within the window', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000, idleMs: 200 })

    void stream.update('a')
    vi.advanceTimersByTime(150)
    void stream.update('ab') // resets the 200ms clock
    vi.advanceTimersByTime(150)
    void stream.update('abc') // resets again
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(0)

    // Now let the clock run out
    vi.advanceTimersByTime(200)
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('abc')
  })

  it('idleMs only applies to the FIRST send; subsequent edits use throttleMs', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000, idleMs: 200 })

    void stream.update('first')
    vi.advanceTimersByTime(200)
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)
    expect(m.editCalls.length).toBe(0)

    // A subsequent update should NOT wait for idleMs — it waits for
    // throttleMs - (time since last send) instead.
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    expect(m.editCalls.length).toBe(1)
  })

  it('finalize() during idle wait flushes the pending text immediately', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000, idleMs: 500 })

    void stream.update('x')
    // Don't advance past idleMs — finalize while still waiting
    await stream.finalize()

    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('x')
    expect(stream.isFinal()).toBe(true)
  })

  it('floors throttleMs at 250ms', async () => {
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 50 })

    void stream.update('a')
    await microtaskFlush()
    void stream.update('b')
    await microtaskFlush()
    expect(m.editCalls.length).toBe(0)

    // 50ms is below the floor; the real wait should be 250ms
    vi.advanceTimersByTime(50)
    await microtaskFlush()
    expect(m.editCalls.length).toBe(0)

    vi.advanceTimersByTime(200)
    await microtaskFlush()
    expect(m.editCalls.length).toBe(1)
  })
})
