import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDraftStream } from '../draft-stream.js'
import { __resetDraftIdForTests } from '../draft-transport.js'

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

  // ─── Regex-tightening regression (2026-04-13) ─────────────────────────
  //
  // The recoverable-edit-error regex previously used /not found/i and
  // /not modified/i, which would also match Telegram errors like
  // "chat not found" or "thread not found" — misclassifying them as
  // "preview was deleted" and re-sending into a dead chat. These tests
  // pin the tightened behavior: ONLY the two real Telegram strings
  // ("message is not modified" / "message to edit not found") trigger
  // the recovery path.

  it('does NOT recover on "chat not found" — treated as generic failure', async () => {
    const m = makeMock()
    m.edit = async () => { throw new Error('Bad Request: chat not found') }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    expect(m.sendCalls.length).toBe(1)

    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    await microtaskFlush()

    // No re-send, messageId stays captured — this is the generic
    // "don't retry forever" path.
    expect(m.sendCalls.length).toBe(1)
    expect(stream.getMessageId()).toBe(100)
  })

  it('does NOT recover on "thread not found" — treated as generic failure', async () => {
    const m = makeMock()
    m.edit = async () => { throw new Error('Bad Request: message thread not found') }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    await microtaskFlush()

    expect(m.sendCalls.length).toBe(1)
    expect(stream.getMessageId()).toBe(100)
  })

  it('does NOT treat "user not modified" or similar as success', async () => {
    const m = makeMock()
    m.edit = async () => {
      throw new Error('Bad Request: user not modified since last check')
    }
    const stream = createDraftStream(m.send, m.edit, { throttleMs: 1000 })

    void stream.update('first')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()
    await microtaskFlush()

    // Generic error path: messageId stays, no re-send.
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

// ─── Draft transport (sendMessageDraft) ───────────────────────────────────

describe('createDraftStream — draft transport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetDraftIdForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('DM happy path: sendMessageDraft called per update, sendMessage NOT called during stream', async () => {
    const m = makeMock()
    const draftCalls: Array<{ chatId: string; draftId: number; text: string }> = []
    const sendMessageDraft = vi.fn(async (chatId: string, draftId: number, text: string) => {
      draftCalls.push({ chatId, draftId, text })
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'auto',
      isPrivateChat: true,
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('First update')
    await microtaskFlush()

    // Draft called, not sendMessage
    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    expect(draftCalls[0].text).toBe('First update')
    expect(m.sendCalls.length).toBe(0)
    expect(m.editCalls.length).toBe(0)

    // Second update after throttle
    vi.advanceTimersByTime(1000)
    void stream.update('Second update')
    await microtaskFlush()

    expect(sendMessageDraft).toHaveBeenCalledTimes(2)
    expect(draftCalls[1].text).toBe('Second update')
    expect(m.sendCalls.length).toBe(0)
  })

  it('materialize on finalize: sends real sendMessage for push notification + clears draft', async () => {
    const m = makeMock()
    const draftClearCalls: string[] = []
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, text: string) => {
      if (text === '') draftClearCalls.push(text)
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      isPrivateChat: true,
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Final answer')
    await microtaskFlush()
    expect(sendMessageDraft).toHaveBeenCalledTimes(1)

    await stream.finalize()

    // sendMessage should have been called to materialize
    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('Final answer')
    expect(stream.getMessageId()).toBe(100)

    // Draft should have been cleared (empty string call)
    expect(draftClearCalls.length).toBe(1)
    expect(stream.isFinal()).toBe(true)
  })

  it('init-time fallback when sendMessageDraft is undefined → uses sendMessage/editMessageText', async () => {
    const m = makeMock()

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      isPrivateChat: true,
      // No sendMessageDraft provided
      chatId: 'chat1',
    })

    void stream.update('Hello')
    await microtaskFlush()

    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('Hello')
  })

  it('runtime fallback on rejection matching DRAFT_METHOD_UNAVAILABLE_RE', async () => {
    const m = makeMock()
    let draftCallCount = 0
    const sendMessageDraft = vi.fn(async () => {
      draftCallCount++
      throw new Error('sendMessageDraft: unknown method')
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Hello')
    await microtaskFlush()

    // Draft tried once, then fell back to sendMessage
    expect(draftCallCount).toBe(1)
    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('Hello')

    // Subsequent updates should use editMessageText, not draft
    vi.advanceTimersByTime(1000)
    void stream.update('Follow-up')
    await microtaskFlush()

    expect(draftCallCount).toBe(1) // no more draft calls
    expect(m.editCalls.length).toBe(1)
  })

  it('runtime fallback on rejection matching DRAFT_CHAT_UNSUPPORTED_RE', async () => {
    const m = makeMock()
    const sendMessageDraft = vi.fn(async () => {
      throw new Error("sendMessageDraft can't be used in this type of chat")
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Hello')
    await microtaskFlush()

    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    expect(m.sendCalls.length).toBe(1)
  })

  it('non-matching rejection bubbles up — does not silently swap to message transport', async () => {
    const m = makeMock()
    const sendMessageDraft = vi.fn(async () => {
      throw new Error('sendMessageDraft: internal server error 500')
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      sendMessageDraft,
      chatId: 'chat1',
    })

    // The error should NOT trigger fallback — it should propagate (draft-stream
    // logs it but doesn't swap; subsequent update can retry).
    void stream.update('Hello')
    await microtaskFlush()

    // Did not fall through to sendMessage
    expect(m.sendCalls.length).toBe(0)
    // Draft was called
    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
  })

  it('group chat (isPrivateChat=false with auto transport) → never tries draft', async () => {
    const m = makeMock()
    const sendMessageDraft = vi.fn(async () => {})

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'auto',
      isPrivateChat: false,
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Hello group')
    await microtaskFlush()

    expect(sendMessageDraft).not.toHaveBeenCalled()
    expect(m.sendCalls.length).toBe(1)
  })

  it('forum topic (message transport) → never tries draft', async () => {
    const m = makeMock()
    const sendMessageDraft = vi.fn(async () => {})

    // Caller forces message transport for forum topics
    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'message',
      isPrivateChat: true, // even if DM, message transport wins
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Hello forum')
    await microtaskFlush()

    expect(sendMessageDraft).not.toHaveBeenCalled()
    expect(m.sendCalls.length).toBe(1)
  })

  it('initialMessageId — first update edits in place instead of sendMessage (#626)', async () => {
    // Closes the duplicate-status-message regression: when a previous
    // done=true finalized + deleted activeDraftStreams[sKey], the next
    // emit creates a fresh stream. With initialMessageId, that fresh
    // stream is initialized as if a previous send had landed with the
    // given id, so the very first update fires editMessageText
    // instead of sendMessage. No new "anchor message" lands.
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 200,
      initialMessageId: 999,
    })
    void stream.update('Edit-only payload')
    await stream.finalize()
    expect(m.sendCalls.length).toBe(0)
    expect(m.editCalls.length).toBe(1)
    expect(m.editCalls[0].id).toBe(999)
    expect(m.editCalls[0].text).toBe('Edit-only payload')
  })

  it('initialMessageId — stale id falls back to sendMessage on not-found error', async () => {
    // Defense in depth: if the externally-supplied id no longer exists
    // (message deleted, chat moved, race), the edit returns
    // "message to edit not found" and the draft stream re-sends. The
    // user sees one fresh anchor — degraded but never silent failure.
    const m = makeMock()
    let editAttempts = 0
    m.edit = async (_id: number, _text: string) => {
      editAttempts++
      throw new Error('Bad Request: message to edit not found')
    }
    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 200,
      initialMessageId: 99999,
    })
    void stream.update('Recovery text')
    await stream.finalize()
    expect(editAttempts).toBeGreaterThanOrEqual(1)
    expect(m.sendCalls.length).toBe(1)
    expect(m.sendCalls[0].text).toBe('Recovery text')
  })

  it('initialMessageId — null/undefined behaves identically to omitted (back-compat)', async () => {
    // The hook is opt-in. A caller that doesn't supply it (or supplies
    // null) must observe identical behavior to the legacy path:
    // first update sends, subsequent updates edit.
    const m = makeMock()
    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 200,
      initialMessageId: null,
    })
    void stream.update('First call')
    await stream.finalize()
    expect(m.sendCalls.length).toBe(1)
    expect(m.editCalls.length).toBe(0)
  })

  it('draft-clear failure is swallowed (best-effort)', async () => {
    const m = makeMock()
    let callCount = 0
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, text: string) => {
      callCount++
      if (text === '') throw new Error('Draft clear failed')
      // Normal update — succeeds
    })

    const stream = createDraftStream(m.send, m.edit, {
      throttleMs: 1000,
      previewTransport: 'draft',
      sendMessageDraft,
      chatId: 'chat1',
    })

    void stream.update('Content')
    await microtaskFlush()

    // finalize should not throw even if draft-clear fails
    await expect(stream.finalize()).resolves.toBeUndefined()
    expect(m.sendCalls.length).toBe(1) // materialized
    expect(callCount).toBeGreaterThan(1) // draft update + failed clear attempt
  })

})
