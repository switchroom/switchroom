/**
 * Integration tests for the `stream_reply` MCP tool handler.
 *
 * Exercises the extracted `handleStreamReply` against the mock bot harness
 * with realistic deps (format rendering, access check, thread resolution,
 * handoff prefix, history record).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  handleStreamReply,
  type StreamReplyDeps,
  type StreamReplyState,
} from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { markdownToHtml as realMarkdownToHtml } from '../format.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'
import {
  handlePtyPartialPure,
  type PtyHandlerState,
} from '../pty-partial-handler.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map<string, 'HTML' | 'MarkdownV2' | undefined>(),
  }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot,
    markdownToHtml: (t) => `<html>${t}</html>`,
    escapeMarkdownV2: (t) => `\\${t}\\`,
    repairEscapedWhitespace: (t) => t,
    takeHandoffPrefix: () => '',
    assertAllowedChat: () => {},
    resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
    disableLinkPreview: true,
    defaultFormat: 'html',
    logStreamingEvent: () => {},
    endStatusReaction: () => {},
    historyEnabled: false,
    recordOutbound: () => {},
    writeError: () => {},
    throttleMs: 600,
    ...overrides,
  }
}

describe('handleStreamReply', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first call creates stream + sends with rendered HTML text', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('updated')
    expect(result.messageId).toBe(500)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>hi</html>')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBe('HTML')
    expect(state.activeDraftStreams.size).toBe(1)
  })

  it('respects format=markdownv2 — uses MDv2 escaper and parse_mode', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'hi', format: 'markdownv2' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('\\hi\\')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBe('MarkdownV2')
  })

  it('respects format=text — no parse_mode, raw text', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'plain', format: 'text' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('plain')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()
  })

  it('prepends handoff prefix on first chunk only', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      takeHandoffPrefix: vi.fn<(fmt: string) => string>(() => '↩️ '),
    })

    // First call: prefix applied
    const p1 = handleStreamReply({ chat_id: '1', text: 'first' }, state, deps)
    await microtaskFlush()
    await p1
    // Prefix is prepended AFTER format rendering (it's already format-safe
    // because takeHandoffPrefix takes the format tag).
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('↩️ <html>first</html>')

    // Second call: handoff not consumed again
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'second' }, state, deps)
    await microtaskFlush()
    await p2
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>second</html>')
    expect(deps.takeHandoffPrefix).toHaveBeenCalledTimes(1)
  })

  it('throws when text exceeds 4096 (no silent id:pending)', async () => {
    // Pins the bug found in prod: a >4096-char text would hit draft-
    // stream's length guard, silently stop, and the handler would return
    // status:finalized, messageId:null — the MCP response read
    // "finalized (id: pending)" looking like success. Fixed upstream by
    // an over-limit pre-check that throws BEFORE touching stream state,
    // so both first-send-over-limit AND mid-stream-over-limit fail loudly
    // instead of corrupting the stream. done=true not required.
    const state = makeState()
    const deps = makeDeps(bot)
    const tooLong = 'x'.repeat(5000)

    await expect(
      handleStreamReply({ chat_id: '1', text: tooLong, done: true }, state, deps),
    ).rejects.toThrow(/exceeds Telegram's 4096-char limit/)

    // Mock bot should NOT have received any sendMessage call.
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('mid-stream over-limit throws without corrupting stream state', async () => {
    // A stream that starts small but a later update() goes over 4096.
    // Before the upfront length check, the draft-stream would set its
    // internal stopped=true flag and silently drop all further text —
    // including the done=true final answer. The pre-check now throws
    // on the over-limit call, leaving the stream intact so the caller
    // can fall back to `reply`. The previously-sent short text stays
    // visible in Telegram; the throw is the signal to the caller.
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply(
      { chat_id: '1', text: 'short' },
      state,
      deps,
    )
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    // Second call: now over limit.
    await expect(
      handleStreamReply(
        { chat_id: '1', text: 'y'.repeat(5000), done: true },
        state,
        deps,
      ),
    ).rejects.toThrow(/exceeds Telegram's 4096-char limit/)

    // No additional API calls from the rejected update.
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('done=true finalizes and deletes from map (does NOT fire terminal reaction)', async () => {
    // Pins the intentional non-behavior: stream_reply(done=true) must NOT
    // fire the 👍 terminal reaction. That is now the exclusive job of
    // server.ts's turn_end handler, because a turn can call
    // stream_reply(done=true) mid-flight and then continue working.
    const state = makeState()
    const endStatusReaction = vi.fn()
    const deps = makeDeps(bot, { endStatusReaction })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'final', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(state.activeDraftStreams.size).toBe(0)
    expect(endStatusReaction).not.toHaveBeenCalled()
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
      texts: ['final text'], // raw text, NOT HTML-rendered
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

    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('subsequent calls reuse the same stream + edit in place', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply({ chat_id: '1', text: 'step 1' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)

    const p2 = handleStreamReply({ chat_id: '1', text: 'step 2' }, state, deps)
    await microtaskFlush()
    await p2

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(500) // same id
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>step 2</html>')
  })

  it('passes repairEscapedWhitespace through before rendering', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      repairEscapedWhitespace: (t) => t.replace(/\\n/g, '\n'),
    })

    const pending = handleStreamReply({ chat_id: '1', text: 'a\\nb' }, state, deps)
    await microtaskFlush()
    await pending

    // repair happens first; then markdownToHtml wraps the repaired text
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>a\nb</html>')
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

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
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

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>step 1 — step 2</html>')
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
  // Before the fix, two simultaneously active turns emitting on
  // lane:'progress' (the progress-card driver's lane) computed the same
  // streamKey and collapsed into one draft stream. Telegram saw a single
  // message flapping between the two turns' narratives instead of two
  // separate pinned cards. The fix threads a per-turn `turnKey` through
  // `StreamReplyArgs` → `streamKey()` so each active turn gets its own
  // slot in `activeDraftStreams` (and therefore its own Telegram message
  // and its own pin via `progressPinnedMsgIds`).
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
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(rA.messageId).not.toBe(rB.messageId)

    // Two independent draft streams in state, each keyed by turnKey.
    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(true)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:2')).toBe(true)

    // Each message carried its own turn's text.
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>turn A step 1</html>')
    expect(bot.api.sendMessage.mock.calls[1][1]).toBe('<html>turn B step 1</html>')
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

    // One send (first call) + one edit (second call) on the same message.
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(500)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>A first + second</html>')
    expect(state.activeDraftStreams.size).toBe(1)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(true)
  })

  it('interleaved concurrent turns each update their own message independently', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // Turn A opens
    const pa1 = handleStreamReply(
      { chat_id: '1', text: 'A step 1', lane: 'progress', turnKey: '1:_:1' },
      state, deps,
    )
    await microtaskFlush()
    await pa1

    // Turn B opens
    const pb1 = handleStreamReply(
      { chat_id: '1', text: 'B step 1', lane: 'progress', turnKey: '1:_:2' },
      state, deps,
    )
    await microtaskFlush()
    await pb1

    vi.advanceTimersByTime(1000)

    // Turn A updates
    const pa2 = handleStreamReply(
      { chat_id: '1', text: 'A step 1 + 2', lane: 'progress', turnKey: '1:_:1' },
      state, deps,
    )
    await microtaskFlush()
    await pa2

    vi.advanceTimersByTime(1000)

    // Turn B updates
    const pb2 = handleStreamReply(
      { chat_id: '1', text: 'B step 1 + 2', lane: 'progress', turnKey: '1:_:2' },
      state, deps,
    )
    await microtaskFlush()
    await pb2

    // Two sends (one per turn), two edits (one per turn's update).
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(2)

    // The edits must target distinct message ids — one per turn's
    // original message — not both collapse onto the same id.
    const editTargets = bot.api.editMessageText.mock.calls.map((c) => c[1])
    expect(new Set(editTargets).size).toBe(2)

    // And each edit carries its own turn's text — no cross-contamination.
    const editTexts = bot.api.editMessageText.mock.calls.map((c) => c[2])
    expect(editTexts).toContain('<html>A step 1 + 2</html>')
    expect(editTexts).toContain('<html>B step 1 + 2</html>')
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

    // Advance past the throttle window so the finalize edit can flush
    // instead of sitting on the debounce timer (fake timers).
    vi.advanceTimersByTime(1000)

    // Finalize turn A
    const pAFinal = handleStreamReply(
      { chat_id: '1', text: 'A final', lane: 'progress', turnKey: '1:_:1', done: true },
      state, deps,
    )
    await microtaskFlush()
    await pAFinal

    // Turn A's slot is gone; turn B's is still live.
    expect(state.activeDraftStreams.has('1:_:progress:1:_:1')).toBe(false)
    expect(state.activeDraftStreams.has('1:_:progress:1:_:2')).toBe(true)
    expect(state.activeDraftStreams.size).toBe(1)
  })

  it('turnKey omitted falls back to legacy chat+thread+lane key (no regression for non-progress callers)', async () => {
    // Other lanes (default, thinking, activity) don't pass turnKey. They
    // must still multiplex the legacy way: one stream per chat+thread+lane.
    // This pins the backwards-compatible behavior of streamKey() when
    // turnKey is undefined — a non-progress caller shouldn't suddenly
    // create a new stream on every call.
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply({ chat_id: '1', text: 'a1' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'a2' }, state, deps)
    await microtaskFlush()
    await p2

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(state.activeDraftStreams.size).toBe(1)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
  })

  it('bug 1: parseMode mismatch with existing stream rotates to fresh stream with new parseMode + rendered text', async () => {
    // Reproduces the reported bug: PTY-tail auto-stream seeds a stream
    // with format:'text' (parseMode undefined). A later explicit
    // stream_reply on the same key with format:'html' + markdown text
    // must NOT inherit the stale parseMode — it must finalize the old
    // stream and create a fresh one with parse_mode=HTML so the markdown
    // converts to HTML tags instead of sending literal asterisks.
    const state = makeState()
    const deps = makeDeps(bot, {
      markdownToHtml: realMarkdownToHtml,
      defaultFormat: 'text',
    })

    // First call: PTY-tail-style, format:'text'
    const p1 = handleStreamReply(
      { chat_id: '1', text: 'Running Bash: ls', format: 'text' },
      state, deps,
    )
    await microtaskFlush()
    await p1
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()

    vi.advanceTimersByTime(1000)

    // Second call on the same stream key: model explicitly uses html +
    // markdown. Must produce a new send (stream rotated), parse_mode HTML,
    // and literal markdown converted to Telegram HTML tags.
    const p2 = handleStreamReply(
      { chat_id: '1', text: '**bold** and `code`', format: 'html' },
      state, deps,
    )
    await microtaskFlush()
    await p2

    // A fresh stream means a second sendMessage, not an edit of the old
    // one (the old stream was finalized + discarded).
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    const secondSend = bot.api.sendMessage.mock.calls[1]
    expect(secondSend[2]?.parse_mode).toBe('HTML')
    // markdownToHtml renders `**bold**` → `<b>bold</b>` and
    // `` `code` `` → `<code>code</code>`.
    expect(secondSend[1]).toContain('<b>bold</b>')
    expect(secondSend[1]).toContain('<code>code</code>')
    expect(secondSend[1]).not.toContain('**')
    expect(secondSend[1]).not.toMatch(/`code`/)
  })

  // ─── Regression: PTY-tail duplicate message. Before the fix,
  // stream_reply did not add itself to suppressPtyPreview, so a PTY
  // partial firing after a finalized stream (TUI capture of the same
  // assistant text) created a duplicate message with the raw TUI text
  // and visibly escaped HTML tags. See log sequence: msg 559 finalized,
  // then msg 560 draft_send path=pty_preview with the same content.
  // Now stream_reply claims the suppress slot on the first call.

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

    // The stream itself is keyed with the lane...
    expect(state.activeDraftStreams.has('42:_:thinking')).toBe(true)
    // ...but the PTY-suppression key is lane-less so the PTY handler
    // (which has no concept of lanes) actually sees it as suppressed.
    expect(state.suppressPtyPreview!.has('42:_')).toBe(true)
    expect(state.suppressPtyPreview!.has('42:_:thinking')).toBe(false)
  })

  it('suppression survives done=true so late PTY partials are still dropped', async () => {
    // This covers the exact production sequence from telegram-plugin.log:
    // stream_reply done=true → draft_edit final → PTY partial arrives
    // 500ms later with the TUI capture → must NOT create a new message.
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

    // After done=true the stream is gone from activeDraftStreams...
    expect(state.activeDraftStreams.has('42:_')).toBe(false)
    // ...but the suppress slot must remain so a PTY partial landing
    // AFTER finalize is dropped. server.ts clears this on turn_end.
    expect(state.suppressPtyPreview!.has('42:_')).toBe(true)
  })

  it('end-to-end: PTY partial after stream_reply finalize is suppressed (no dup message)', async () => {
    // Reproduces the production sequence:
    //   1. stream_reply done=true for chat 42
    //   2. PTY-tail fires with the TUI capture of the same assistant text
    //   3. PTY handler sees suppress flag and drops the partial
    // Before the fix, step 2 created a duplicate Telegram message with
    // raw TUI text and visibly-escaped HTML tags (see log msg 559 → 560).
    const activeDraftStreams = new Map<string, DraftStreamHandle>()
    const suppressPtyPreview = new Set<string>()
    const streamState: StreamReplyState = {
      activeDraftStreams,
      activeDraftParseModes: new Map(),
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
    const sendsAfterStream = bot.api.sendMessage.mock.calls.length

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
      'TUI capture: <b>final answer</b>',
      ptyState,
      { bot, renderText: (t) => t },
    )
    await microtaskFlush()

    // Step 3: partial was dropped — no extra sendMessage call.
    expect(action).toBe('suppressed')
    expect(bot.api.sendMessage.mock.calls.length).toBe(sendsAfterStream)
  })

  it('works without suppressPtyPreview (backwards compat)', async () => {
    // Callers that don't thread the set through must still function.
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

  describe('progressCardActive enforcement', () => {
    // In checklist mode the progress-card driver owns the mid-turn
    // surface. A default-lane stream_reply(done=false) is rejected with
    // an error so the caller (the model) learns in-context to only call
    // stream_reply with done=true. Previously this was silently
    // suppressed — the loud error makes the contract deterministic.
    it('rejects default-lane done=false with a clear error when progress card is active', async () => {
      const state: StreamReplyState = {
        ...makeState(),
        suppressPtyPreview: new Set<string>(),
      }
      const deps = makeDeps(bot, { progressCardActive: true })

      await expect(
        handleStreamReply({ chat_id: '1', text: 'working...' }, state, deps),
      ).rejects.toThrow(/stream_reply\(done=false\) is not supported in checklist mode/)

      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(state.activeDraftStreams.size).toBe(0)
      // PTY-preview slot still claimed so a late PTY partial doesn't
      // leak a raw-TUI draft_send after the rejection.
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

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>final answer</html>')
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

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('legacy behavior preserved when progressCardActive is false', async () => {
      const state = makeState()
      const deps = makeDeps(bot, { progressCardActive: false })

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
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
      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toEqual({
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

      // Lookup is skipped entirely when reply_to is explicit.
      expect(lookup).not.toHaveBeenCalled()
      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toEqual({
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
      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
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
      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
    })

    it('no auto-quote when getLatestInboundMessageId dep is omitted (legacy callers)', async () => {
      const state = makeState()
      const deps = makeDeps(bot) // no lookup dep

      const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()
      await pending

      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toBeUndefined()
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

      // First call → send with reply_parameters.
      await handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
      await microtaskFlush()

      // Second call on the same stream → edit. editMessageText must NOT
      // receive reply_parameters (Telegram rejects it on edit).
      vi.advanceTimersByTime(1000)
      await handleStreamReply({ chat_id: '1', text: 'hi there' }, state, deps)
      await microtaskFlush()

      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_parameters).toEqual({
        message_id: 4242,
      })
      expect(bot.api.editMessageText).toHaveBeenCalled()
      const editOpts = bot.api.editMessageText.mock.calls[0][3]
      expect((editOpts as { reply_parameters?: unknown })?.reply_parameters).toBeUndefined()
    })
  })

  describe('reply_markup persistence', () => {
    it('reply_markup in args is included in sendMessage opts on stream creation', async () => {
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

      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_markup).toBe(keyboard)
    })

    it('reply_markup persists through editMessageText on subsequent updates', async () => {
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

      expect(bot.api.sendMessage.mock.calls[0][2]?.reply_markup).toBeUndefined()
    })
  })
})
