/**
 * #3084 — the typing indicator must be structurally incapable of earning a
 * per-bot flood ban.
 *
 * On 2026-07-11 `overlord` emitted 8,729 sendChatAction calls (55% of ALL
 * outbound volume, bursting 200-300/min into ONE DM) to deliver 203 messages,
 * and Telegram banned the bot token for 4.6 hours (429 retry_after=16739s).
 * Root cause: both typing loops fire an action IMMEDIATELY on (re)start, and
 * the tool-use wrapper restarts the loop on every tool call — so the ping rate
 * equalled the agent's TOOL-CALL rate and the "4 s interval" was decorative.
 *
 * These tests assert the OUTCOME the fix owes: no matter how the loops are
 * driven, at most ~one chat action per chat key per refresh window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTypingEmitter,
  TYPING_FLOOR_MS,
  TYPING_REFRESH_MS,
} from '../typing-emitter.js'
import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'
import { createRetryApiCall } from '../retry-api-call.js'
import {
  floodStatePath,
  makeFloodWaitRecorder,
  suppressNonEssentialSendMs,
} from '../flood-circuit-breaker.js'
import { errors } from './fake-bot-api.js'

const chatKey = (chatId: string, threadId: number | null) =>
  `${chatId}:${threadId ?? '_'}`

/** Deterministic clock — no real timers anywhere in the emitter tests. */
function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

interface Sent {
  chatId: string
  threadId: number | null
  action: string
  at: number
}

function harness(opts: { suppressed?: () => boolean } = {}) {
  const clock = fakeClock()
  const sent: Sent[] = []
  const emitter = createTypingEmitter({
    chatKey,
    now: clock.now,
    isSuppressed: opts.suppressed ?? (() => false),
    send: (chatId, threadId, action) =>
      sent.push({ chatId, threadId, action, at: clock.now() }),
  })
  return { clock, sent, emitter }
}

/** The invariant the ban owes us: no two emissions on one key inside the floor. */
function assertFloorHeld(sent: Sent[], floorMs = TYPING_FLOOR_MS): void {
  const lastByKey = new Map<string, number>()
  for (const s of sent) {
    const k = chatKey(s.chatId, s.threadId)
    const prev = lastByKey.get(k)
    if (prev != null) {
      expect(s.at - prev).toBeGreaterThanOrEqual(floorMs)
    }
    lastByKey.set(k, s.at)
  }
}

describe('typing emitter — per-chat-key emission floor (#3084)', () => {
  it('50 loop restarts in 2 s emit exactly ONE chat action (the regression)', () => {
    const { clock, sent, emitter } = harness()

    // Mirrors the production driver: the tool-use typing wrapper restarts the
    // loop on every tool call, and each restart fired an immediate ping.
    for (let i = 0; i < 50; i++) {
      emitter.emit('chat-1', null, 'typing')
      clock.advance(40) // 50 restarts across 2 s — the observed burst shape
    }

    expect(sent).toHaveLength(1)
    expect(sent[0]?.at).toBe(1_000_000)
    assertFloorHeld(sent)
  })

  it('a cold start still pings IMMEDIATELY — the UX intent survives', () => {
    const { sent, emitter } = harness()
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('the floor releases after the window, so the indicator stays lit', () => {
    const { clock, sent, emitter } = harness()
    emitter.emit('chat-1')
    clock.advance(TYPING_FLOOR_MS - 1)
    expect(emitter.emit('chat-1')).toBe(false)
    clock.advance(1)
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('the floor is UNDER the refresh cadence, so an on-time refresh is never eaten', () => {
    const { clock, sent, emitter } = harness()
    // A loop refreshing on its own 4 s cadence must never be dropped, or the
    // chat goes dark (Telegram's typing action expires at ~5 s).
    for (let i = 0; i < 15; i++) {
      expect(emitter.emit('chat-1')).toBe(true)
      clock.advance(TYPING_REFRESH_MS)
    }
    expect(sent).toHaveLength(15)
    expect(TYPING_FLOOR_MS).toBeLessThan(TYPING_REFRESH_MS)
  })

  it('two chats (and two topics in one chat) are independent lanes', () => {
    const { sent, emitter } = harness()
    expect(emitter.emit('chat-1', null)).toBe(true)
    expect(emitter.emit('chat-2', null)).toBe(true)
    expect(emitter.emit('chat-1', 77)).toBe(true) // supergroup topic = own lane
    expect(emitter.emit('chat-1', null)).toBe(false) // same lane, inside floor
    expect(sent).toHaveLength(3)
  })

  it('emits NOTHING while a flood window is open (typing is non-essential)', () => {
    let floodOpen = true
    const { clock, sent, emitter } = harness({ suppressed: () => floodOpen })

    for (let i = 0; i < 40; i++) {
      expect(emitter.emit('chat-1')).toBe(false)
      clock.advance(1000)
    }
    expect(sent).toHaveLength(0)

    floodOpen = false
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('checks the flood state at most once per floor per chat (no read storm)', () => {
    const suppressed = vi.fn(() => false)
    const clock = fakeClock()
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      isSuppressed: suppressed,
      send: () => {},
    })
    for (let i = 0; i < 50; i++) {
      emitter.emit('chat-1')
      clock.advance(40)
    }
    // 2 s of restarts, floor 3.5 s → one window claimed → one flood check.
    expect(suppressed).toHaveBeenCalledTimes(1)
  })

  it('a backwards clock step does not wedge the indicator off', () => {
    const { clock, sent, emitter } = harness()
    emitter.emit('chat-1')
    clock.set(500) // NTP step backwards
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(2)
  })
})

describe('typing emitter — BOTH loops share one floor (#3084)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a tool-call storm alongside the turn loop cannot outrun the floor', () => {
    const sent: Sent[] = []
    const emitter = createTypingEmitter({
      chatKey,
      now: () => Date.now(),
      send: (chatId, threadId, action) =>
        sent.push({ chatId, threadId, action, at: Date.now() }),
    })

    // Loop A: the turn-level loop (real factory, real interval semantics).
    const turnLoop = createTurnTypingLoop({
      chatKey,
      sendChatAction: (chatId, threadId) => {
        emitter.emit(chatId, threadId, 'typing')
      },
      refreshMs: TYPING_REFRESH_MS,
    })

    // Loop B: the tool-use loop, reproduced exactly as gateway.ts drives it —
    // stop, restart, fire immediately, re-arm the interval.
    let toolInterval: ReturnType<typeof setInterval> | null = null
    const startToolLoop = (chatId: string) => {
      if (toolInterval) clearInterval(toolInterval)
      const send = () => emitter.emit(chatId, null, 'typing')
      send()
      toolInterval = setInterval(send, TYPING_REFRESH_MS)
    }
    const stopToolLoop = () => {
      if (toolInterval) clearInterval(toolInterval)
      toolInterval = null
    }

    turnLoop.start('chat-1', null)

    // 120 tool calls over 60 s — 3-4 parallel subagents hammering one DM, the
    // exact shape that produced 8,729 pings for 203 messages.
    for (let i = 0; i < 120; i++) {
      startToolLoop('chat-1')
      vi.advanceTimersByTime(250)
      stopToolLoop() // tool result — ref-count hits zero, loop stops
      vi.advanceTimersByTime(250)
    }
    turnLoop.stop('chat-1', null)
    stopToolLoop()

    // OUTCOME: 60 s elapsed. Before the fix this emitted 120+ actions
    // (one per tool call, ~2/s). The floor caps it at one per 3.5 s.
    const maxAllowed = Math.ceil(60_000 / TYPING_FLOOR_MS) + 1
    expect(sent.length).toBeLessThanOrEqual(maxAllowed)
    expect(sent.length).toBeGreaterThan(10) // …and the chat is still lit
    assertFloorHeld(sent)

    // The chat never goes dark: no gap exceeds Telegram's ~5 s action expiry.
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.at - sent[i - 1]!.at).toBeLessThan(5000)
    }
  })
})

describe('typing sends record 429s to the flood breaker (#3084 / #2923)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typing-flood-'))
    path = floodStatePath(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The gateway's `nonEssentialApiCall`: records the flood, never retries. */
  const nonEssentialApiCall = () =>
    createRetryApiCall({
      maxRetries: 1,
      sleep: async () => {},
      onFloodWait: makeFloodWaitRecorder(path),
    })

  it('a 429 on a typing ping is RECORDED, not swallowed', async () => {
    const call = nonEssentialApiCall()
    const fn = vi.fn().mockRejectedValue(errors.floodWait(16739))

    await expect(call(fn, { verb: 'sendChatAction' })).rejects.toThrow()

    // Recorded: the breaker now knows the bot is banned — before the fix the
    // typing path called bot.api raw with `.catch(() => {})`, so the breaker
    // was blind to 429s from the LARGEST emitter of them.
    expect(suppressNonEssentialSendMs(path, Date.now())).toBeGreaterThan(0)
  })

  it('a typing ping is NEVER retried (a retry is what feeds the ban)', async () => {
    const call = nonEssentialApiCall()
    const fn = vi.fn().mockRejectedValue(errors.floodWait(16739))
    await expect(call(fn)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('the recorded window then suppresses further typing end-to-end', async () => {
    const call = nonEssentialApiCall()
    const sent: Sent[] = []
    const clock = fakeClock()
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      isSuppressed: () => suppressNonEssentialSendMs(path, Date.now()) > 0,
      send: (chatId, threadId, action) =>
        sent.push({ chatId, threadId, action, at: clock.now() }),
    })

    expect(emitter.emit('chat-1')).toBe(true) // healthy: pings

    // The bot earns a flood ban on some other send.
    await expect(
      call(vi.fn().mockRejectedValue(errors.floodWait(600))),
    ).rejects.toThrow()

    clock.advance(TYPING_FLOOR_MS)
    expect(emitter.emit('chat-1')).toBe(false) // banned: silent
    clock.advance(TYPING_FLOOR_MS)
    expect(emitter.emit('chat-1')).toBe(false)
    expect(sent).toHaveLength(1)
  })
})
