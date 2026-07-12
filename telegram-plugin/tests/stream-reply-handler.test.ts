/**
 * Integration tests for the `stream_reply` MCP tool handler.
 *
 * Post-#2669: there is one rendering path. The handler passes the raw GFM
 * markdown straight to the stream controller, which sends it via
 * `bot.api.sendRichMessage(chat, { markdown }, opts)` and edits via
 * `bot.api.editMessageText(chat, id, { markdown }, opts)`. The only fork is
 * `format:'text'` → the literal plain `sendMessage` path. There is no
 * markdownToHtml / escapeMarkdownV2 dep and no activeDraftParseModes state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  handleStreamReply,
  type StreamReplyDeps,
  type StreamReplyState,
} from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { RICH_MESSAGE_MAX_CHARS } from '../format.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'
import {
  handlePtyPartialPure,
  type PtyHandlerState,
} from '../pty-partial-handler.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
  }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot,
    repairEscapedWhitespace: (t) => t,
    assertAllowedChat: () => {},
    resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
    disableLinkPreview: true,
    // Anything other than the literal 'text' is the rich-markdown path.
    defaultFormat: 'markdown',
    logStreamingEvent: () => {},
    historyEnabled: false,
    recordOutbound: () => {},
    writeError: () => {},
    throttleMs: 600,
    ...overrides,
  }
}

/** The raw markdown body of the i-th rich send. */
function richSendMarkdown(bot: ReturnType<typeof createMockBot>, i = 0): string {
  return (bot.api.sendRichMessage.mock.calls[i][1] as { markdown: string }).markdown
}
/** The raw markdown body of the i-th rich edit. */
function richEditMarkdown(bot: ReturnType<typeof createMockBot>, i = 0): string {
  return (bot.api.editMessageText.mock.calls[i][2] as { markdown: string }).markdown
}

describe('handleStreamReply', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first call creates stream + sends raw markdown via sendRichMessage', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('updated')
    expect(result.messageId).toBe(500)
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
    expect(richSendMarkdown(bot)).toBe('hi')
    expect(state.activeDraftStreams.size).toBe(1)
  })

  it('a non-text format ships GFM markdown unescaped (no parse_mode)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: '**hi** _there_', format: 'gfm' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    // The default-on rich renderer (parse -> renderSafe) normalises the
    // italic marker (`_there_` -> `*there*`, same wire entity) but the
    // payload stays unescaped GFM markdown — no HTML, no MarkdownV2 escaping.
    expect(richSendMarkdown(bot)).toBe('**hi** *there*')
    // No parse_mode on rich opts.
    expect(bot.api.sendRichMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()
  })

  it('respects format=text — literal plain sendMessage, raw text', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'plain < text >', format: 'text' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('plain < text >')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()
  })

  it('applies addParagraphSpacers on the rich path (multi-paragraph gap spaced)', async () => {
    const state = makeState()
    // Spacer dep replaces every `\n\n` gap with a visible marker so we can
    // assert the rich path ran it (mirrors the real gateway wiring).
    const deps = makeDeps(bot, {
      addParagraphSpacers: (t) => t.replace(/\n\n/g, '\n\nSPACER\n\n'),
    })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Para one.\n\nPara two.', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(richSendMarkdown(bot)).toBe('Para one.\n\nSPACER\n\nPara two.')
  })

  it('does NOT apply addParagraphSpacers on the literal format=text path', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      addParagraphSpacers: (t) => t.replace(/\n\n/g, '\n\nSPACER\n\n'),
    })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Para one.\n\nPara two.', format: 'text', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    // Literal path is byte-exact — no spacer injected.
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('Para one.\n\nPara two.')
  })

  it('throws when text exceeds the rich-message cap (no silent id:pending)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)
    const tooLong = 'x'.repeat(RICH_MESSAGE_MAX_CHARS + 1)

    await expect(
      handleStreamReply({ chat_id: '1', text: tooLong, done: true }, state, deps),
    ).rejects.toThrow(new RegExp(`exceeds Telegram's ${RICH_MESSAGE_MAX_CHARS}-char`))

    expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('mid-stream over-limit throws without corrupting stream state', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: '1', text: 'short' }, state, deps)
    await microtaskFlush()
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)

    await expect(
      handleStreamReply(
        { chat_id: '1', text: 'y'.repeat(RICH_MESSAGE_MAX_CHARS + 1), done: true },
        state,
        deps,
      ),
    ).rejects.toThrow(new RegExp(`exceeds Telegram's ${RICH_MESSAGE_MAX_CHARS}-char`))

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
  })

  it('done=true finalizes the stream but does NOT touch the reaction (#1713)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'final', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(state.activeDraftStreams.size).toBe(0)
  })

  it('done=true routes the final text through finalize(text) — the answer edit is CRITICAL for the send gate, drafts cosmetic (#3110)', async () => {
    const state = makeState()
    // Spy retry: pins exactly what reaches robustApiCall (= the send gate).
    const seen: Array<Record<string, unknown> | undefined> = []
    const retry = (<T,>(fn: () => Promise<T>, opts?: unknown) => {
      seen.push(opts as Record<string, unknown> | undefined)
      return fn()
    }) as StreamReplyDeps['retry']
    const deps = makeDeps(bot, { retry })

    // Turn start → anchor send.
    let pending = handleStreamReply({ chat_id: '1', text: 'thinking…' }, state, deps)
    await microtaskFlush()
    await pending

    // Intermediate snapshot → a sheddable (cosmetic) draft edit.
    pending = handleStreamReply({ chat_id: '1', text: 'half the answer' }, state, deps)
    await microtaskFlush()
    vi.advanceTimersByTime(600) // release the local throttle
    await microtaskFlush()
    await pending

    // done=true → the completed answer flushes via finalize(text): the edit
    // runs with the stream already final and is tagged critical — never shed
    // as a draft under flood pressure.
    pending = handleStreamReply(
      { chat_id: '1', text: 'the full answer', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(richEditMarkdown(bot, 1)).toBe('the full answer')
    expect(seen[0]).toEqual({ threadId: undefined, chat_id: '1' }) // anchor send: untagged
    expect(seen[1]).toMatchObject({ messageId: 500, priorityClass: 'cosmetic' })
    expect(seen[2]).toMatchObject({
      messageId: 500,
      priorityClass: 'critical',
      editPayload: { markdown: 'the full answer' },
    })
  })

  it('done=true on a named lane does NOT fire terminal 👍', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'progress snapshot', done: true, lane: 'progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending
  })

  it('done=true does NOT fire 👍 if finalize never produced a messageId', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await expect(
      handleStreamReply(
        { chat_id: '1', text: 'x'.repeat(RICH_MESSAGE_MAX_CHARS + 1), done: true },
        state,
        deps,
      ),
    ).rejects.toThrow(new RegExp(`exceeds Telegram's ${RICH_MESSAGE_MAX_CHARS}-char`))
  })

  it('done=true with historyEnabled records the final message row', async () => {
    const state = makeState()
    const recordOutbound = vi.fn()
    const deps = makeDeps(bot, {
      historyEnabled: true,
      recordOutbound,
      resolveThreadId: () => 42,
    })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'final text', done: true, message_thread_id: '42' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(recordOutbound).toHaveBeenCalledWith({
      chat_id: '1',
      thread_id: 42,
      message_ids: [500],
      texts: ['final text'], // raw text
    })
  })

  it('historyEnabled=false skips recordOutbound', async () => {
    const state = makeState()
    const recordOutbound = vi.fn()
    const deps = makeDeps(bot, { historyEnabled: false, recordOutbound })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'f', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(recordOutbound).not.toHaveBeenCalled()
  })

  it('recordOutbound throws → error logged, handler still resolves finalized', async () => {
    const state = makeState()
    const writeError = vi.fn()
    const recordOutbound = vi.fn(() => {
      throw new Error('db locked')
    })
    const deps = makeDeps(bot, { historyEnabled: true, recordOutbound, writeError })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'f', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(writeError).toHaveBeenCalledTimes(1)
    expect(writeError.mock.calls[0][0]).toMatch(/db locked/)
  })

  it('rejects when assertAllowedChat throws', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      assertAllowedChat: () => { throw new Error('chat not allowed') },
    })

    await expect(
      handleStreamReply({ chat_id: 'evil', text: 'x' }, state, deps),
    ).rejects.toThrow('chat not allowed')

    expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('subsequent calls reuse the same stream + rich-edit in place', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply({ chat_id: '1', text: 'step 1' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)

    const p2 = handleStreamReply({ chat_id: '1', text: 'step 2' }, state, deps)
    await microtaskFlush()
    await p2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(500) // same id
    expect(richEditMarkdown(bot)).toBe('step 2')
  })

  it('passes repairEscapedWhitespace through before sending', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      repairEscapedWhitespace: (t) => t.replace(/\\n/g, '\n'),
    })

    const pending = handleStreamReply({ chat_id: '1', text: 'a\\nb' }, state, deps)
    await microtaskFlush()
    await pending

    // repair happens first; the repaired raw markdown is the wire payload.
    expect(richSendMarkdown(bot)).toBe('a\nb')
  })

  it('different lanes for same chat produce independent Telegram messages', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'thinking aloud', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    const r1 = await p1

    const p2 = handleStreamReply(
      { chat_id: '1', text: 'final answer' }, // no lane = answer
      state,
      deps,
    )
    await microtaskFlush()
    const r2 = await p2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(2)
    expect(r1.messageId).not.toBe(r2.messageId) // separate messages
    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
    expect(state.activeDraftStreams.has('1:_:thinking')).toBe(true)
  })

  it('same lane updates the same message (no duplicate send per lane)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'step 1', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    await p1

    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply(
      { chat_id: '1', text: 'step 1 — step 2', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    await p2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(richEditMarkdown(bot)).toBe('step 1 — step 2')
  })

  it('done=true on one lane does not affect other lanes', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pThink = handleStreamReply(
      { chat_id: '1', text: 'thinking', lane: 'thinking', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pThink

    const pAnswer = handleStreamReply(
      { chat_id: '1', text: 'answering' }, // still in progress
      state,
      deps,
    )
    await microtaskFlush()
    await pAnswer

    expect(state.activeDraftStreams.has('1:_:thinking')).toBe(false)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
  })

  // ─── Regression: concurrent turns on the same chat+thread+lane ───────
  it('concurrent turns with different turnKeys produce separate draft streams and messages', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // Turn A: progress lane, turnKey "1:_:1"
    const pA = handleStreamReply(
      { chat_id: '1', text: 'turn A step 1', lane: 'progress', turnKey: '1:_:1' },
      state,
      deps,
    )
    await microtaskFlush()
    const rA = await pA

    // Turn B: progress lane, same chat+thread+lane but DIFFERENT turnKey
    const pB = handleStreamReply(
      { chat_id: '1', text: 'turn B step 1', lane: 'progress', turnKey: '1:_:2' },
      state,
      deps,
    )
    await microtaskFlush()
    const rB = await pB

    // Two independent Telegram messages (not one edited twice).
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(2)
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(rA.messageId).not.toBe(rB.messageId)

    // Two independent draft streams in state, each keyed by turnKey.
    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(true)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:2')).toBe(true)

    // Each message carried its own turn's raw markdown.
    expect(richSendMarkdown(bot, 0)).toBe('turn A step 1')
    expect(richSendMarkdown(bot, 1)).toBe('turn B step 1')
  })

  it('subsequent updates with same turnKey reuse the stream (edit in place)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'A first', lane: 'progress', turnKey: '1:_:1' },
      state,
      deps,
    )
    await microtaskFlush()
    await p1

    vi.advanceTimersByTime(1000)

    const p2 = handleStreamReply(
      { chat_id: '1', text: 'A first + second', lane: 'progress', turnKey: '1:_:1' },
      state,
      deps,
    )
    await microtaskFlush()
    await p2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(500)
    expect(richEditMarkdown(bot)).toBe('A first + second')
    expect(state.activeDraftStreams.size).toBe(1)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(true)
  })

  it('interleaved concurrent turns each update their own message independently', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pa1 = handleStreamReply(
      { chat_id: '1', text: 'A step 1', lane: 'progress', turnKey: '1:_:1' },
      state, deps,
    )
    await microtaskFlush()
    await pa1

    const pb1 = handleStreamReply(
      { chat_id: '1', text: 'B step 1', lane: 'progress', turnKey: '1:_:2' },
      state, deps,
    )
    await microtaskFlush()
    await pb1

    vi.advanceTimersByTime(1000)

    const pa2 = handleStreamReply(
      { chat_id: '1', text: 'A step 1 + 2', lane: 'progress', turnKey: '1:_:1' },
      state, deps,
    )
    await microtaskFlush()
    await pa2

    vi.advanceTimersByTime(1000)

    const pb2 = handleStreamReply(
      { chat_id: '1', text: 'B step 1 + 2', lane: 'progress', turnKey: '1:_:2' },
      state, deps,
    )
    await microtaskFlush()
    await pb2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(2)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(2)

    const editTargets = bot.api.editMessageText.mock.calls.map((c) => c[1])
    expect(new Set(editTargets).size).toBe(2)

    const editTexts = bot.api.editMessageText.mock.calls.map(
      (c) => (c[2] as { markdown: string }).markdown,
    )
    expect(editTexts).toContain('A step 1 + 2')
    expect(editTexts).toContain('B step 1 + 2')
  })

  it('done=true on one turnKey does not close the other concurrent turn', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pA = handleStreamReply(
      { chat_id: '1', text: 'A', lane: 'progress', turnKey: '1:_:1' },
      state, deps,
    )
    await microtaskFlush()
    await pA

    const pB = handleStreamReply(
      { chat_id: '1', text: 'B', lane: 'progress', turnKey: '1:_:2' },
      state, deps,
    )
    await microtaskFlush()
    await pB

    expect(state.activeDraftStreams.size).toBe(2)

    vi.advanceTimersByTime(1000)

    const pAFinal = handleStreamReply(
      { chat_id: '1', text: 'A final', lane: 'progress', turnKey: '1:_:1', done: true },
      state, deps,
    )
    await microtaskFlush()
    await pAFinal

    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(false)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:2')).toBe(true)
    expect(state.activeDraftStreams.size).toBe(1)
  })

  it('turnKey omitted falls back to legacy chat+thread+lane key (no regression for non-progress callers)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply({ chat_id: '1', text: 'a1' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'a2' }, state, deps)
    await microtaskFlush()
    await p2

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(state.activeDraftStreams.size).toBe(1)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
  })

  it('single-mode reuse: a format switch on the same lane does NOT rotate the stream (#2669)', async () => {
    // Pre-#2669 a parseMode mismatch (text→html) finalized the old stream
    // and created a fresh one. There is now ONE mode: a non-text format on
    // an existing rich stream reuses it (edit in place). Only a literal
    // 'text' stream differs, and that distinction is fixed at creation.
    const state = makeState()
    const deps = makeDeps(bot, { defaultFormat: 'markdown' })

    // First call: rich markdown.
    const p1 = handleStreamReply(
      { chat_id: '1', text: 'plain start', format: 'markdown' },
      state, deps,
    )
    await microtaskFlush()
    await p1
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)

    // Second call on the same key with a different (still non-text) format:
    // the stream is reused and the markdown ships raw, unescaped.
    const p2 = handleStreamReply(
      { chat_id: '1', text: '**bold** and `code`', format: 'gfm' },
      state, deps,
    )
    await microtaskFlush()
    await p2

    // No new send — edited in place.
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    // Raw markdown passed through verbatim — NOT converted to HTML.
    expect(richEditMarkdown(bot)).toBe('**bold** and `code`')
  })

  // ─── Regression: PTY-tail duplicate message ──────────────────────────

  it('adds sKey (without lane) to suppressPtyPreview on first call', async () => {
    const state: StreamReplyState = {
      ...makeState(),
      suppressPtyPreview: new Set<string>(),
    }
    const deps = makeDeps(bot)

    const pending = handleStreamReply({ chat_id: '42', text: 'hi' }, state, deps)
    await microtaskFlush()
    await pending

    expect(state.suppressPtyPreview!.has('42:_')).toBe(true)
  })

  it('suppression key ignores lane — claims default PTY lane', async () => {
    const state: StreamReplyState = {
      ...makeState(),
      suppressPtyPreview: new Set<string>(),
    }
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '42', text: 'hi', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(state.activeDraftStreams.has('42:_:thinking')).toBe(true)
    expect(state.suppressPtyPreview!.has('42:_')).toBe(true)
    expect(state.suppressPtyPreview!.has('42:_:thinking')).toBe(false)
  })

  it('suppression survives done=true so late PTY partials are still dropped', async () => {
    const state: StreamReplyState = {
      ...makeState(),
      suppressPtyPreview: new Set<string>(),
    }
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '42', text: 'final', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(state.activeDraftStreams.has('42:_')).toBe(false)
    expect(state.suppressPtyPreview!.has('42:_')).toBe(true)
  })

  it('end-to-end: PTY partial after stream_reply finalize is suppressed (no dup message)', async () => {
    const activeDraftStreams = new Map<string, DraftStreamHandle>()
    const suppressPtyPreview = new Set<string>()
    const streamState: StreamReplyState = {
      activeDraftStreams,
      suppressPtyPreview,
    }
    const streamDeps = makeDeps(bot)

    // Step 1: stream_reply finalizes.
    const pending = handleStreamReply(
      { chat_id: '42', text: 'final answer', done: true },
      streamState,
      streamDeps,
    )
    await microtaskFlush()
    await pending
    const sendsAfterStream =
      bot.api.sendMessage.mock.calls.length + bot.api.sendRichMessage.mock.calls.length

    // Step 2: PTY partial fires into the SHARED state — same Sets/Maps.
    const ptyState: PtyHandlerState = {
      currentSessionChatId: '42',
      currentSessionThreadId: undefined,
      pendingPtyPartial: null,
      activeDraftStreams,
      suppressPtyPreview,
      lastPtyPreviewByChat: new Map(),
    }
    const action = handlePtyPartialPure(
      'TUI capture: final answer',
      ptyState,
      { bot, renderText: (t) => t },
    )
    await microtaskFlush()

    // Step 3: partial was dropped — no extra send call of any kind.
    expect(action).toBe('suppressed')
    expect(
      bot.api.sendMessage.mock.calls.length + bot.api.sendRichMessage.mock.calls.length,
    ).toBe(sendsAfterStream)
  })

  it('works without suppressPtyPreview (backwards compat)', async () => {
    const state = makeState() // no suppressPtyPreview
    const deps = makeDeps(bot)

    const pending = handleStreamReply({ chat_id: '42', text: 'hi' }, state, deps)
    await microtaskFlush()
    const result = await pending
    expect(result.messageId).toBe(500)
  })

  it('streamExisted flag in logStreamingEvent reflects map state', async () => {
    const state = makeState()
    const logStreamingEvent = vi.fn()
    const deps = makeDeps(bot, { logStreamingEvent })

    const p1 = handleStreamReply({ chat_id: '1', text: 'a' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'b' }, state, deps)
    await microtaskFlush()
    await p2

    const calledEvents = logStreamingEvent.mock.calls.map(c => c[0])
    const streamReplyCalledEvents = calledEvents.filter(
      (e: { kind: string }) => e.kind === 'stream_reply_called',
    )
    expect(streamReplyCalledEvents[0].streamExisted).toBe(false)
    expect(streamReplyCalledEvents[1].streamExisted).toBe(true)
  })

  describe('progressCardActive coexistence', () => {
    it('accepts default-lane done=false when progress card is active (streams into answer)', async () => {
      const state: StreamReplyState = {
        ...makeState(),
        suppressPtyPreview: new Set<string>(),
      }
      const deps = makeDeps(bot, { progressCardActive: true })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'working...' },
        state,
        deps,
      )
      await microtaskFlush()
      const result = await pending

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(richSendMarkdown(bot)).toBe('working...')
      expect(result.status).toBe('updated')
      expect(state.suppressPtyPreview?.has('1:_')).toBe(true)
    })

    it('still posts final done=true call when progress card is active', async () => {
      const state = makeState()
      const deps = makeDeps(bot, { progressCardActive: true })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'final answer', done: true },
        state,
        deps,
      )
      await microtaskFlush()
      const result = await pending

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(richSendMarkdown(bot)).toBe('final answer')
      expect(result.status).toBe('finalized')
      expect(result.messageId).toBe(500)
    })

    it('does NOT reject named-lane calls (internal progress-card driver uses lane=progress)', async () => {
      const state = makeState()
      const deps = makeDeps(bot, { progressCardActive: true })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'card snapshot', lane: 'progress' },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    })

    it('legacy behavior preserved when progressCardActive is false', async () => {
      const state = makeState()
      const deps = makeDeps(bot, { progressCardActive: false })

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('quote-reply default', () => {
    it('auto-quotes the latest inbound message when reply_to is omitted', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => 4242,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(lookup).toHaveBeenCalledWith('1', null)
      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toEqual({
        message_id: 4242,
      })
    })

    it('explicit reply_to overrides the auto-quote lookup', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => 4242,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'hi', reply_to: '777' },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(lookup).not.toHaveBeenCalled()
      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toEqual({
        message_id: 777,
      })
    })

    it('quote:false opts out — no reply_parameters sent', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => 4242,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'hi', quote: false },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(lookup).not.toHaveBeenCalled()
      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
    })

    it('no reply_parameters when history lookup returns null (empty history)', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => null,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(lookup).toHaveBeenCalledTimes(1)
      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
    })

    it('no auto-quote when getLatestInboundMessageId dep is omitted (legacy callers)', async () => {
      const state = makeState()
      const deps = makeDeps(bot) // no lookup dep

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
    })

    it('passes thread id to the lookup', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => 55,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'hi', message_thread_id: '7' },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(lookup).toHaveBeenCalledWith('1', 7)
    })

    it('edit-path does not include reply_parameters (only initial send)', async () => {
      const state = makeState()
      const lookup = vi.fn<(chatId: string, threadId: number | null) => number | null>(
        () => 4242,
      )
      const deps = makeDeps(bot, { getLatestInboundMessageId: lookup })

      await handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()

      vi.advanceTimersByTime(1000)
      await handleStreamReply({ chat_id: '1', text: 'hi there' }, state, deps)
      await microtaskFlush()

      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_parameters).toEqual({
        message_id: 4242,
      })
      expect(bot.api.editMessageText).toHaveBeenCalled()
      const editOpts = bot.api.editMessageText.mock.calls[0][3]
      expect((editOpts as { reply_parameters?: unknown })?.reply_parameters).toBeUndefined()
    })
  })

  describe('reply_markup persistence', () => {
    it('reply_markup in args is included in sendRichMessage opts on stream creation', async () => {
      const state = makeState()
      const deps = makeDeps(bot)
      const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }

      const pending = handleStreamReply(
        { chat_id: '1', text: 'hi', reply_markup: keyboard },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBe(keyboard)
    })

    it('reply_markup rides on both the rich send AND the rich edit', async () => {
      const state = makeState()
      const deps = makeDeps(bot)
      const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }

      const p1 = handleStreamReply(
        { chat_id: '1', text: 'step 1', reply_markup: keyboard },
        state,
        deps,
      )
      await microtaskFlush()
      await p1

      vi.advanceTimersByTime(1000)
      const p2 = handleStreamReply(
        { chat_id: '1', text: 'step 2', reply_markup: keyboard },
        state,
        deps,
      )
      await microtaskFlush()
      await p2

      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBe(keyboard)
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText.mock.calls[0][3]?.reply_markup).toBe(keyboard)
    })

    it('reply_markup persists through finalize flush on done=true', async () => {
      const state = makeState()
      const deps = makeDeps(bot)
      const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }

      const p1 = handleStreamReply(
        { chat_id: '1', text: 'draft', reply_markup: keyboard },
        state,
        deps,
      )
      await microtaskFlush()
      await p1

      vi.advanceTimersByTime(1000)
      const p2 = handleStreamReply(
        { chat_id: '1', text: 'final', done: true, reply_markup: keyboard },
        state,
        deps,
      )
      await microtaskFlush()
      await p2

      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText.mock.calls[0][3]?.reply_markup).toBe(keyboard)
    })

    it('omits reply_markup when not provided in args', async () => {
      const state = makeState()
      const deps = makeDeps(bot)

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBeUndefined()
    })
  })

  describe('lookupExistingMessageId hook (#626 — multiple status messages regression)', () => {
    it('reuses an externally-known messageId on stream creation — first emit edits, no send', async () => {
      const state = makeState()
      const deps = makeDeps(bot, {
        lookupExistingMessageId: ({ turnKey, lane }) => {
          if (turnKey === 'turn-A' && lane === 'progress') return 4242
          return null
        },
      })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'second emit', lane: 'progress', turnKey: 'turn-A' },
        state,
        deps,
      )
      await microtaskFlush()
      const result = await pending

      expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
      const [, id] = bot.api.editMessageText.mock.calls[0]
      expect(id).toBe(4242)
      expect(result.messageId).toBe(4242)
    })

    it('hook returns null → falls through to legacy send path', async () => {
      const state = makeState()
      const deps = makeDeps(bot, {
        lookupExistingMessageId: () => null,
      })

      const pending = handleStreamReply(
        { chat_id: '1', text: 'fresh send', lane: 'progress', turnKey: 'turn-X' },
        state,
        deps,
      )
      await microtaskFlush()
      await pending

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText).not.toHaveBeenCalled()
    })

    it('hook NOT consulted when an active draft stream already exists for the lane+turn', async () => {
      const state = makeState()
      let lookupCalls = 0
      const deps = makeDeps(bot, {
        lookupExistingMessageId: () => {
          lookupCalls++
          return 9999
        },
      })

      await handleStreamReply(
        { chat_id: '1', text: 'first', lane: 'progress', turnKey: 'turn-B' },
        state,
        deps,
      )
      await microtaskFlush()
      vi.advanceTimersByTime(1000)
      expect(lookupCalls).toBe(1)
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)

      await handleStreamReply(
        { chat_id: '1', text: 'second', lane: 'progress', turnKey: 'turn-B' },
        state,
        deps,
      )
      await microtaskFlush()
      expect(lookupCalls).toBe(1)
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(2)
    })

    it('hook throws → error logged, handler falls through to fresh send', async () => {
      const state = makeState()
      const writeError = vi.fn()
      const deps = makeDeps(bot, {
        writeError,
        lookupExistingMessageId: () => {
          throw new Error('lookup blew up')
        },
      })

      await handleStreamReply(
        { chat_id: '1', text: 'after-fault', lane: 'progress', turnKey: 'turn-C' },
        state,
        deps,
      )
      await microtaskFlush()

      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(writeError).toHaveBeenCalled()
      const errLine = (writeError.mock.calls[0]?.[0] as string) ?? ''
      expect(errLine).toContain('lookupExistingMessageId failed')
    })

    it('full #626 lifecycle scenario — done=true → cleared → next emit edits via hook (one anchor message total)', async () => {
      const state = makeState()
      const knownMessageId = { value: null as number | null }
      const deps = makeDeps(bot, {
        lookupExistingMessageId: () => knownMessageId.value,
      })

      // 1. First emit, no known messageId yet → fresh send
      await handleStreamReply(
        { chat_id: '1', text: 'tool 1...', lane: 'progress', turnKey: 'turn-A' },
        state,
        deps,
      )
      await microtaskFlush()
      knownMessageId.value = 500
      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText).not.toHaveBeenCalled()

      // 2. done=true → finalize + clear sKey
      vi.advanceTimersByTime(1000)
      await handleStreamReply(
        { chat_id: '1', text: 'tool 1, tool 2 ✓', lane: 'progress', turnKey: 'turn-A', done: true },
        state,
        deps,
      )
      await microtaskFlush()
      expect(state.activeDraftStreams.size).toBe(0)

      // 3. Subsequent sub-agent emit on the SAME turn-A.
      await handleStreamReply(
        { chat_id: '1', text: 'tool 1, tool 2 ✓, sub-agent...', lane: 'progress', turnKey: 'turn-A' },
        state,
        deps,
      )
      await microtaskFlush()

      // Invariant: total fresh rich sends on this chat = 1.
      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText.mock.calls.some((c) => c[1] === 500)).toBe(true)
    })
  })
})
