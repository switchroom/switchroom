/**
 * Regression tests for two bugs reported 2026-04-13 / 2026-04-14:
 *
 *   Bug 1 (TG-DONE): the progress-card message stays stuck on
 *     "⚙️ Working…" after a turn completes. Root cause: session-tail
 *     onEvent ran `handleSessionEvent` (which calls `closeProgressLane`
 *     and deletes + finalizes the progress-lane stream) BEFORE
 *     `progressDriver.ingest` (which synchronously emits the final
 *     "Done" render via handleStreamReply). By the time the driver
 *     tried to edit the existing stream, it was already gone.
 *
 *   Bug 2 (TG-IDLE-LEAK): bare text emitted by the model after
 *     `stream_reply(done=true)` (e.g. "Idle; awaiting next instruction.")
 *     leaks as a separate Telegram message. Root cause: server.ts
 *     identified its own MCP tools by exact-prefix match against
 *     `mcp__switchroom-telegram__…`, but Claude Code prefixes tool
 *     names with whatever registration key the host .mcp.json used.
 *     Existing agents still register as `clerk-telegram`, so no
 *     `reply`-family tool call ever set `currentTurnReplyCalled` and
 *     the orphaned-reply backstop fired on every post-reply idle text.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'
import { isTelegramReplyTool, isTelegramSurfaceTool } from '../tool-names.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Bug 1 integration harness ────────────────────────────────────────────
//
// Simulates the server.ts wiring: one session-tail event callback that
// fans out to (a) progressDriver.ingest and (b) a lightweight stand-in
// for handleSessionEvent's closeProgressLane. The real bug showed up as
// an ordering race between these two consumers, so the harness exercises
// both orders and asserts which one delivers the Done render.

interface FakeStream {
  updates: string[]
  finalized: boolean
  finalize(): void
  update(text: string): void
}

function makeStream(): FakeStream {
  const s: FakeStream = {
    updates: [],
    finalized: false,
    finalize() {
      this.finalized = true
    },
    update(text: string) {
      if (this.finalized) return
      this.updates.push(text)
    },
  }
  return s
}

function wireServer(order: 'driver-first' | 'handler-first') {
  const streams = new Map<string, FakeStream>()
  const allStreams: FakeStream[] = [] // never forgets — includes deleted ones
  const events: SessionEvent[] = []

  // Stand-in for handleStreamReply's progress-lane emit: if a stream for
  // this key already exists, push the update into it; otherwise create
  // one. Creating a fresh stream here simulates "posted a NEW message
  // instead of updating the original card" — the user-visible bug 1
  // symptom.
  const emit = (args: { chatId: string; threadId?: string; html: string; done: boolean }): void => {
    const key = `${args.chatId}:${args.threadId ?? '_'}:progress`
    let s = streams.get(key)
    if (!s) {
      s = makeStream()
      streams.set(key, s)
      allStreams.push(s)
    }
    s.update(args.html)
    if (args.done) s.finalize()
  }

  const driver = createProgressDriver({ emit, minIntervalMs: 0, coalesceMs: 0, initialDelayMs: 0 })

  // Emulate server.ts closeProgressLane: delete + finalize.
  function closeProgressLane(chatId: string, threadId?: string): void {
    const key = `${chatId}:${threadId ?? '_'}:progress`
    const s = streams.get(key)
    if (!s) return
    streams.delete(key)
    s.finalize()
  }

  function handleSessionEvent(ev: SessionEvent): void {
    if (ev.kind === 'turn_end') {
      // This is the line that caused bug 1: closeProgressLane deletes +
      // finalizes before the driver has emitted its Done render.
      closeProgressLane('c1')
    }
  }

  // The fix is to run progressDriver.ingest FIRST on turn_end so the
  // driver's synchronous flush reaches the existing stream before the
  // handler tears it down. Expose both orders so the test can compare.
  const onEvent = (ev: SessionEvent): void => {
    events.push(ev)
    if (order === 'driver-first') {
      driver.ingest(ev, null)
      handleSessionEvent(ev)
    } else {
      handleSessionEvent(ev)
      driver.ingest(ev, null)
    }
  }

  return { onEvent, streams, allStreams, events }
}

describe('bug 1 — server.ts wiring uses driver-first order', () => {
  // Pin the production wiring so a careless refactor can't silently
  // re-introduce the Done-transition race. If the assertion below fails
  // because the lines moved, update the regex — but first confirm that
  // `progressDriver?.ingest(ev, null)` still runs BEFORE
  // `handleSessionEvent(ev)` in the sessionTail `onEvent` callback.
  it('progressDriver.ingest runs before handleSessionEvent in onEvent', () => {
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
    // Find the onEvent callback used by startSessionTail.
    const onEventBlock = serverSrc.match(
      /onEvent:\s*\(ev\)\s*=>\s*\{([\s\S]*?)\n\s*\},/,
    )
    expect(onEventBlock).not.toBeNull()
    const body = onEventBlock![1]
    const driverIdx = body.indexOf('progressDriver?.ingest')
    const handlerIdx = body.indexOf('handleSessionEvent(ev)')
    expect(driverIdx).toBeGreaterThanOrEqual(0)
    expect(handlerIdx).toBeGreaterThanOrEqual(0)
    expect(driverIdx).toBeLessThan(handlerIdx)
  })
})

describe('bug 1 — Done transition reaches the original progress card', () => {
  it('driver-first order: Done render lands in the ORIGINAL stream', () => {
    const { onEvent, allStreams } = wireServer('driver-first')

    // Minimal turn: enqueue → one tool_use+result → turn_end
    onEvent({
      kind: 'enqueue',
      chatId: 'c1',
      messageId: '1',
      threadId: null,
      rawContent: '<channel chat_id="c1">hi</channel>',
    })
    onEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/x' } })
    onEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })
    onEvent({ kind: 'turn_end', durationMs: 500 })

    // With driver-first, only ONE stream is ever created — the original
    // card. The handler's closeProgressLane runs AFTER the driver has
    // already pushed the Done render into it, so no duplicate message
    // is needed.
    expect(allStreams).toHaveLength(1)
    const [stream] = allStreams
    expect(stream.finalized).toBe(true)
    const lastUpdate = stream.updates.at(-1) ?? ''
    expect(lastUpdate).toContain('✅ <b>Done</b>')
    expect(lastUpdate).not.toContain('⚙️ <b>Working…</b>')
  })

  it('handler-first order reproduces bug 1: Done lands on a NEW stream', () => {
    // This is the PRE-FIX behaviour — kept as a negative control so the
    // fix's value is visible. The handler tears down the stream
    // synchronously on turn_end; the driver's subsequent emit can't find
    // the original stream, so the emit callback has to create a new
    // stream (new Telegram message) — leaving the original progress
    // card stuck on "⚙️ Working…".
    const { onEvent, allStreams } = wireServer('handler-first')

    onEvent({
      kind: 'enqueue',
      chatId: 'c1',
      messageId: '1',
      threadId: null,
      rawContent: '<channel chat_id="c1">hi</channel>',
    })
    onEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/x' } })
    onEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })
    const originalSnapshotUpdates = [...(allStreams[0]?.updates ?? [])]

    onEvent({ kind: 'turn_end', durationMs: 500 })

    // Bug surface: the ORIGINAL stream got NO further updates past the
    // pre-turn_end render, so its last frame still says Working.
    const original = allStreams[0]
    expect(original).toBeDefined()
    const originalLast = original.updates.at(-1) ?? ''
    expect(originalLast).toContain('⚙️ <b>Working…</b>')
    expect(originalLast).not.toContain('✅ <b>Done</b>')
    // And a SECOND stream had to be created for the Done render —
    // visible to the user as a duplicate/new card.
    expect(allStreams.length).toBeGreaterThanOrEqual(2)
    expect(originalSnapshotUpdates.length).toBe(original.updates.length)
  })
})

// ─── Bug 2 unit tests for isTelegramReplyTool ─────────────────────────────

describe('bug 2 — server.ts uses the suffix-robust helpers (not hardcoded prefix)', () => {
  it('server.ts imports isTelegramReplyTool from tool-names.ts', () => {
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
    expect(serverSrc).toContain("from './tool-names.js'")
    expect(serverSrc).toContain('isTelegramReplyTool')
    // And the dead hardcoded `mcp__switchroom-telegram__reply` branch
    // must be gone. (It was the entire source of bug 2.)
    expect(serverSrc).not.toMatch(
      /name\s*===\s*'mcp__switchroom-telegram__reply'/,
    )
  })
})

describe('bug 2 — telegram tool-name classification is robust to MCP registration key', () => {
  it('matches the historical `clerk-telegram` registration', () => {
    expect(isTelegramReplyTool('mcp__clerk-telegram__reply')).toBe(true)
    expect(isTelegramReplyTool('mcp__clerk-telegram__stream_reply')).toBe(true)
    expect(isTelegramSurfaceTool('mcp__clerk-telegram__edit_message')).toBe(true)
    expect(isTelegramSurfaceTool('mcp__clerk-telegram__react')).toBe(true)
  })

  it('matches the current `switchroom-telegram` registration', () => {
    expect(isTelegramReplyTool('mcp__switchroom-telegram__reply')).toBe(true)
    expect(isTelegramReplyTool('mcp__switchroom-telegram__stream_reply')).toBe(true)
  })

  it('matches fork-style registration keys that still contain `telegram`', () => {
    expect(isTelegramReplyTool('mcp__my-fork-telegram__stream_reply')).toBe(true)
  })

  it('does NOT match unrelated MCP tool names', () => {
    expect(isTelegramReplyTool('mcp__hindsight__recall')).toBe(false)
    expect(isTelegramReplyTool('Read')).toBe(false)
    expect(isTelegramReplyTool('mcp__switchroom-telegram__download_attachment')).toBe(false)
    expect(isTelegramSurfaceTool('mcp__hindsight__retain')).toBe(false)
  })

  it("does NOT match the plugin's own non-reply tools (bugs past and future)", () => {
    // `get_recent_messages`, `send_typing`, `pin_message`, `forward_message`,
    // `delete_message`, `download_attachment` — none of these own the
    // answer surface, so they must NOT set currentTurnReplyCalled, or the
    // backstop would fail to fire for a turn that only called one of
    // them and then emitted text.
    expect(isTelegramReplyTool('mcp__clerk-telegram__get_recent_messages')).toBe(false)
    expect(isTelegramReplyTool('mcp__clerk-telegram__send_typing')).toBe(false)
    expect(isTelegramReplyTool('mcp__clerk-telegram__pin_message')).toBe(false)
    expect(isTelegramReplyTool('mcp__clerk-telegram__forward_message')).toBe(false)
    expect(isTelegramReplyTool('mcp__clerk-telegram__delete_message')).toBe(false)
  })
})

// ─── Bug 2 end-to-end simulation of the turn-end backstop decision ────────
//
// The real server-side code path we need to guard: after a
// `stream_reply(done=true)` tool_use event arrives in the session-tail,
// the tool_use handler must set `currentTurnReplyCalled = true`. If it
// doesn't, a subsequent `text` event (e.g. "Idle; awaiting next
// instruction.") gets captured, and at turn_end the backstop fires and
// forwards it as a separate Telegram message.
//
// We simulate just the flag transition here — it's the cleanest way to
// pin down the exact bug without importing server.ts (which has
// top-level side-effects that require env vars).

describe('bug 2 — stream_reply tool call sets reply-called flag regardless of MCP key', () => {
  // Mirror of the real session-tail tool_use event shape
  type ToolUseEv = { kind: 'tool_use'; toolName: string }

  function simulateTurn(events: Array<ToolUseEv | { kind: 'text'; text: string } | { kind: 'turn_end' }>): {
    replyCalled: boolean
    capturedText: string[]
    wouldFireBackstop: boolean
  } {
    let replyCalled = false
    const captured: string[] = []
    for (const ev of events) {
      if (ev.kind === 'tool_use' && isTelegramReplyTool(ev.toolName)) {
        replyCalled = true
      } else if (ev.kind === 'text') {
        captured.push(ev.text)
      }
    }
    return {
      replyCalled,
      capturedText: captured,
      // This mirrors the exact server.ts turn_end guard.
      wouldFireBackstop: !replyCalled && captured.length > 0,
    }
  }

  it('with `clerk-telegram` key: stream_reply followed by idle text does NOT fire the backstop', () => {
    const result = simulateTurn([
      { kind: 'tool_use', toolName: 'mcp__clerk-telegram__stream_reply' },
      { kind: 'text', text: 'Idle; awaiting next instruction.' },
      { kind: 'turn_end' },
    ])
    expect(result.replyCalled).toBe(true)
    // Post-fix: backstop does NOT fire, so no duplicate message leaks.
    expect(result.wouldFireBackstop).toBe(false)
  })

  it('with `switchroom-telegram` key: unchanged — reply-called recognized', () => {
    const result = simulateTurn([
      { kind: 'tool_use', toolName: 'mcp__switchroom-telegram__stream_reply' },
      { kind: 'text', text: 'idle' },
      { kind: 'turn_end' },
    ])
    expect(result.replyCalled).toBe(true)
    expect(result.wouldFireBackstop).toBe(false)
  })

  it('genuine orphan (NO reply tool call, only text) still fires the backstop', () => {
    const result = simulateTurn([
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'text', text: "here's the answer" },
      { kind: 'turn_end' },
    ])
    expect(result.replyCalled).toBe(false)
    expect(result.wouldFireBackstop).toBe(true)
  })
})

// ─── Bug 3 — orphan progress card (TG-ORPHAN-CARD) ───────────────────────
//
// Progress cards stayed pinned in "Working…" when turn_end was delayed,
// missed, or arrived after the model already sent its final reply.
//
// Fix: unpin fires on the FIRST of (turn_end, stream_reply(done=true), reply())
// via a shared `unpinProgressCard` helper guarded by `unpinnedTurnKeys`.
//
// These tests simulate the pin/unpin lifecycle that server.ts manages.
// They exercise the guard logic directly rather than importing server.ts
// (which has top-level side-effects requiring env vars).

describe('bug 3 — progress-card unpin fires on first of turn_end / reply / stream_reply(done)', () => {
  /**
   * Miniature simulation of the pin/unpin lifecycle from server.ts.
   * Models the progressPinnedMsgIds map, unpinnedTurnKeys set, and the
   * unpinProgressCard + unpinProgressCardForChat helpers.
   */
  function makeUnpinHarness() {
    const progressPinnedMsgIds = new Map<string, number>()
    const unpinnedTurnKeys = new Set<string>()
    const unpinCalls: Array<{ turnKey: string; pinnedId: number }> = []

    function unpinProgressCard(turnKey: string, _chatId: string, pinnedId: number): void {
      if (unpinnedTurnKeys.has(turnKey)) return
      unpinnedTurnKeys.add(turnKey)
      progressPinnedMsgIds.delete(turnKey)
      unpinCalls.push({ turnKey, pinnedId })
    }

    function unpinProgressCardForChat(chatId: string, threadId: number | undefined): void {
      const base = threadId != null ? `${chatId}:${threadId}` : chatId
      for (const [turnKey, pinnedId] of progressPinnedMsgIds) {
        if (turnKey.startsWith(`${base}:`)) {
          unpinProgressCard(turnKey, chatId, pinnedId)
        }
      }
    }

    function pinCard(turnKey: string, chatId: string, messageId: number): void {
      progressPinnedMsgIds.set(turnKey, messageId)
    }

    function onTurnComplete(turnKey: string, chatId: string): void {
      const pinnedId = progressPinnedMsgIds.get(turnKey)
      if (pinnedId != null) {
        unpinProgressCard(turnKey, chatId, pinnedId)
      }
      unpinnedTurnKeys.delete(turnKey)
    }

    return {
      pinCard,
      unpinProgressCardForChat,
      onTurnComplete,
      unpinCalls,
      unpinnedTurnKeys,
    }
  }

  it('reply() triggers unpin before turn_end arrives', () => {
    const h = makeUnpinHarness()
    // Card pinned at turn start
    h.pinCard('100:1', '100', 42)

    // model calls reply() → early unpin
    h.unpinProgressCardForChat('100', undefined)

    expect(h.unpinCalls).toHaveLength(1)
    expect(h.unpinCalls[0]).toMatchObject({ turnKey: '100:1', pinnedId: 42 })
  })

  it('stream_reply(done=true) triggers unpin before turn_end arrives', () => {
    const h = makeUnpinHarness()
    h.pinCard('200:1', '200', 55)

    // model calls stream_reply(done=true) → early unpin via chat lookup
    h.unpinProgressCardForChat('200', undefined)

    expect(h.unpinCalls).toHaveLength(1)
    expect(h.unpinCalls[0]).toMatchObject({ turnKey: '200:1', pinnedId: 55 })
  })

  it('turn_end after reply-triggered unpin is a no-op (double-unpin guard)', () => {
    const h = makeUnpinHarness()
    h.pinCard('300:1', '300', 77)

    // reply() fires first
    h.unpinProgressCardForChat('300', undefined)
    expect(h.unpinCalls).toHaveLength(1)

    // turn_end fires later — onTurnComplete guard should make it a no-op
    h.onTurnComplete('300:1', '300')

    // Still only one unpin call
    expect(h.unpinCalls).toHaveLength(1)
    // Guard entry cleaned up by onTurnComplete
    expect(h.unpinnedTurnKeys.has('300:1')).toBe(false)
  })

  it('turn_end fires first (normal path) — guard prevents double-unpin on late reply()', () => {
    const h = makeUnpinHarness()
    h.pinCard('400:1', '400', 88)

    // turn_end fires first (normal path)
    h.onTurnComplete('400:1', '400')
    expect(h.unpinCalls).toHaveLength(1)
    // Guard cleaned up by onTurnComplete
    expect(h.unpinnedTurnKeys.has('400:1')).toBe(false)

    // Late reply() fires (e.g. async handler after turn_end)
    // unpinProgressCardForChat checks progressPinnedMsgIds which is already empty
    h.unpinProgressCardForChat('400', undefined)
    // No second unpin
    expect(h.unpinCalls).toHaveLength(1)
  })

  it('concurrent turns on same chat each get their own unpin', () => {
    const h = makeUnpinHarness()
    // Two concurrent turns on chat 500 (e.g. two parallel sub-agents)
    h.pinCard('500:1', '500', 10)
    h.pinCard('500:2', '500', 11)

    // reply() for the chat — unpins all matching cards
    h.unpinProgressCardForChat('500', undefined)

    expect(h.unpinCalls).toHaveLength(2)
    const turnKeys = h.unpinCalls.map((c) => c.turnKey)
    expect(turnKeys).toContain('500:1')
    expect(turnKeys).toContain('500:2')
  })

  it('unpinProgressCardForChat only unpins cards for the matching chat+thread', () => {
    const h = makeUnpinHarness()
    h.pinCard('600:1', '600', 20)   // chat 600, no thread
    h.pinCard('601:1', '601', 21)   // chat 601, no thread (different chat)

    // Unpin for chat 600 only
    h.unpinProgressCardForChat('600', undefined)

    expect(h.unpinCalls).toHaveLength(1)
    expect(h.unpinCalls[0]!.turnKey).toBe('600:1')
  })

  it('unpinProgressCardForChat scopes to thread when threadId is set', () => {
    const h = makeUnpinHarness()
    h.pinCard('700:99:1', '700', 30)  // chat 700, thread 99
    h.pinCard('700:88:1', '700', 31)  // chat 700, thread 88

    // Unpin for thread 99 only
    h.unpinProgressCardForChat('700', 99)

    expect(h.unpinCalls).toHaveLength(1)
    expect(h.unpinCalls[0]!.turnKey).toBe('700:99:1')
  })

  it('maxIdleMs default in server.ts is reduced to 5 minutes', () => {
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
    // The createProgressDriver call should pass maxIdleMs: 5 * 60_000.
    expect(serverSrc).toContain('maxIdleMs: 5 * 60_000')
    // The old 30-minute default must not be the value passed.
    expect(serverSrc).not.toMatch(/maxIdleMs:\s*30\s*\*\s*60_000/)
  })

  it('server.ts wires early-unpin in the reply() handler', () => {
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
    // Find the reply case block and confirm unpinProgressCardForChat is called.
    // Use a broad search so minor whitespace changes don't break this.
    expect(serverSrc).toContain('unpinProgressCardForChat?.(chat_id, threadId)')
  })

  it('server.ts wires early-unpin in the stream_reply handler', () => {
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
    // The stream_reply case should call unpinProgressCardForChat after finalization.
    expect(serverSrc).toContain("if (result.status === 'finalized')")
    expect(serverSrc).toContain('unpinProgressCardForChat?.(srChatId, srThreadId)')
  })
})
