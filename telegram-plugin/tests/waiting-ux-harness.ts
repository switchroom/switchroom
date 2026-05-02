/**
 * Waiting-UX E2E harness — Phase 1 of #545.
 *
 * Wires the production status-reaction controller, progress-card driver,
 * and a recording fake-bot under vitest fake timers. The goal is to make
 * the four observed waiting-UX failure modes catchable in CI by asserting
 * the wall-clock contract that varies by turn class:
 *   A — instant reply (no tools, <2s)
 *   B — short turn (1–3 tools, <15s)
 *   C — long / multi-agent (sub-agents, background workers)
 *
 * The harness simulates the slice of server.ts that determines the
 * user-perceived timing:
 *   inbound update      → setQueued() (👀)        + progressDriver.startTurn()
 *   session 'thinking'  → setThinking() (🤔)
 *   session 'tool_use'  → setTool(name) (🔥/✍/👨‍💻/⚡)
 *   stream_reply        → editMessageText / sendMessage on bot.api
 *   session 'turn_end'  → setDone() (👍)          + driver flush + onTurnComplete
 *
 * Anything not on that path (auth, history, ipc, foreman) is intentionally
 * out of scope — those don't influence the four failures.
 *
 * Time control is via `vi.useFakeTimers()`; tests advance time with
 * `clock.advance(ms)` which delegates to `vi.advanceTimersByTimeAsync`.
 * Every recorded outbound API call is timestamped with the simulated
 * `Date.now()` at the moment of the call.
 */

import { vi, type MockInstance } from 'vitest'
import { StatusReactionController } from '../status-reactions.js'
import { createProgressDriver, type ProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

// ─── Recorder ────────────────────────────────────────────────────────────

export type RecordedKind =
  | 'sendMessage'
  | 'editMessageText'
  | 'setMessageReaction'
  | 'sendChatAction'
  | 'deleteMessage'
  | 'pinChatMessage'

export interface RecordedCall {
  ts: number
  kind: RecordedKind
  chat_id: string
  message_id?: number
  payload?: string
  args: unknown[]
}

export interface Recorder {
  calls: RecordedCall[]
  reactionSequence(): string[]
  sentTexts(chat_id: string): string[]
  edits(chat_id: string): RecordedCall[]
  /**
   * Detects the progress card sendMessage by payload heuristic
   * (Working… / ⚙️ / ⏳ glyphs that the production card uses).
   */
  progressCardSendMs(chat_id: string): number | null
  firstReactionMs(chat_id: string): number | null
  lastReactionEmoji(chat_id: string): string | null
}

// ─── Clock ───────────────────────────────────────────────────────────────

export interface HarnessClock {
  now(): number
  advance(ms: number): Promise<void>
}

// ─── Fake bot.api with recording ─────────────────────────────────────────

type Method = (...args: unknown[]) => Promise<unknown>

export interface FakeBotApi {
  sendMessage: MockInstance<Method>
  editMessageText: MockInstance<Method>
  setMessageReaction: MockInstance<Method>
  sendChatAction: MockInstance<Method>
  deleteMessage: MockInstance<Method>
  pinChatMessage: MockInstance<Method>
  unpinChatMessage: MockInstance<Method>
  editMessageReplyMarkup: MockInstance<Method>
  getFile: MockInstance<Method>
}

export interface HarnessHandle {
  bot: { api: FakeBotApi }
  clock: HarnessClock
  recorder: Recorder
  controller: StatusReactionController
  driver: ProgressDriver
  inbound(opts: { chatId: string; messageId: number; text?: string }): void
  feedSessionEvent(ev: SessionEvent): void
  /** Convenience for class-A direct stream_reply path. */
  streamReply(opts: { chat_id: string; text: string; done?: boolean }): Promise<void>
  finalize(): void
}

function makeRecorderAndApi(): { recorder: Recorder; api: FakeBotApi } {
  let nextId = 5000
  const calls: RecordedCall[] = []

  const sendMessage = vi.fn(async (...args: unknown[]) => {
    const message_id = nextId++
    calls.push({
      ts: Date.now(),
      kind: 'sendMessage',
      chat_id: String(args[0]),
      message_id,
      payload: String(args[1] ?? ''),
      args,
    })
    return { message_id }
  }) as unknown as MockInstance<Method>

  const editMessageText = vi.fn(async (...args: unknown[]) => {
    calls.push({
      ts: Date.now(),
      kind: 'editMessageText',
      chat_id: String(args[0]),
      message_id: Number(args[1]),
      payload: String(args[2] ?? ''),
      args,
    })
    return true
  }) as unknown as MockInstance<Method>

  const setMessageReaction = vi.fn(async (...args: unknown[]) => {
    const reactions = args[2] as Array<{ emoji?: string }> | undefined
    const emoji = reactions?.[0]?.emoji
    calls.push({
      ts: Date.now(),
      kind: 'setMessageReaction',
      chat_id: String(args[0]),
      message_id: Number(args[1]),
      payload: emoji,
      args,
    })
    return true
  }) as unknown as MockInstance<Method>

  const sendChatAction = vi.fn(async (...args: unknown[]) => {
    calls.push({
      ts: Date.now(),
      kind: 'sendChatAction',
      chat_id: String(args[0]),
      payload: String(args[1] ?? ''),
      args,
    })
    return true
  }) as unknown as MockInstance<Method>

  const deleteMessage = vi.fn(async (...args: unknown[]) => {
    calls.push({
      ts: Date.now(),
      kind: 'deleteMessage',
      chat_id: String(args[0]),
      message_id: Number(args[1]),
      args,
    })
    return true
  }) as unknown as MockInstance<Method>

  const pinChatMessage = vi.fn(async (...args: unknown[]) => {
    calls.push({
      ts: Date.now(),
      kind: 'pinChatMessage',
      chat_id: String(args[0]),
      message_id: Number(args[1]),
      args,
    })
    return true
  }) as unknown as MockInstance<Method>

  const unpinChatMessage = vi.fn(async () => true) as unknown as MockInstance<Method>
  const editMessageReplyMarkup = vi.fn(async () => true) as unknown as MockInstance<Method>
  const getFile = vi.fn(async () => ({ file_path: 'x' })) as unknown as MockInstance<Method>

  const api: FakeBotApi = {
    sendMessage,
    editMessageText,
    setMessageReaction,
    sendChatAction,
    deleteMessage,
    pinChatMessage,
    unpinChatMessage,
    editMessageReplyMarkup,
    getFile,
  }

  const isCardPayload = (text: string | undefined): boolean =>
    text != null &&
    (text.includes('Working') ||
      text.includes('⚙') ||
      text.includes('⏳') ||
      text.includes('• '))

  const recorder: Recorder = {
    calls,
    reactionSequence: () =>
      calls.filter((c) => c.kind === 'setMessageReaction').map((c) => c.payload ?? ''),
    sentTexts: (chat_id) =>
      calls
        .filter((c) => c.kind === 'sendMessage' && c.chat_id === chat_id)
        .map((c) => c.payload ?? ''),
    edits: (chat_id) => calls.filter((c) => c.kind === 'editMessageText' && c.chat_id === chat_id),
    progressCardSendMs: (chat_id) => {
      const hit = calls.find(
        (c) => c.kind === 'sendMessage' && c.chat_id === chat_id && isCardPayload(c.payload),
      )
      return hit ? hit.ts : null
    },
    firstReactionMs: (chat_id) => {
      const hit = calls.find((c) => c.kind === 'setMessageReaction' && c.chat_id === chat_id)
      return hit ? hit.ts : null
    },
    lastReactionEmoji: (chat_id) => {
      const hits = calls.filter((c) => c.kind === 'setMessageReaction' && c.chat_id === chat_id)
      return hits.length === 0 ? null : (hits[hits.length - 1].payload ?? null)
    },
  }

  return { recorder, api }
}

// ─── Public factory ──────────────────────────────────────────────────────

export interface CreateHarnessOpts {
  allowedReactions?: Set<string> | null
  debounceMs?: number
  driverCoalesceMs?: number
  driverMinIntervalMs?: number
  /**
   * Progress-card initial-delay-ms. Production default is 30s (cards are
   * suppressed for fast turns). Tests for class B/C should set this small
   * (e.g. 0–500) so the deferred first emit can fire inside the test.
   */
  driverInitialDelayMs?: number
  /** Heartbeat ms; pass 0 to disable. */
  driverHeartbeatMs?: number
}

export function createWaitingUxHarness(opts: CreateHarnessOpts = {}): HarnessHandle {
  // vi.useFakeTimers() must be called by the test (so afterEach can reset).
  // The harness assumes fake timers are active.
  const { recorder, api } = makeRecorderAndApi()
  const bot = { api }

  let primaryChatId: string | null = null
  let primaryMessageId: number | null = null
  let currentChatId: string | null = null

  const controller = new StatusReactionController(
    async (emoji) => {
      if (primaryChatId == null || primaryMessageId == null) return
      await api.setMessageReaction(primaryChatId, primaryMessageId, [
        { type: 'emoji', emoji },
      ])
    },
    opts.allowedReactions ?? null,
    {
      debounceMs: opts.debounceMs ?? 700,
    },
  )

  const cardMessageIds = new Map<string, number>()

  async function renderCard(a: { chatId: string; html: string; done: boolean; isFirstEmit: boolean }): Promise<void> {
    const existing = cardMessageIds.get(a.chatId)
    if (existing == null) {
      const result = (await api.sendMessage(a.chatId, a.html, { parse_mode: 'HTML' })) as { message_id: number }
      cardMessageIds.set(a.chatId, result.message_id)
    } else {
      await api.editMessageText(a.chatId, existing, a.html, { parse_mode: 'HTML' })
    }
  }

  const driver = createProgressDriver({
    emit: (a) => {
      void renderCard(a)
    },
    coalesceMs: opts.driverCoalesceMs ?? 400,
    minIntervalMs: opts.driverMinIntervalMs ?? 500,
    initialDelayMs: opts.driverInitialDelayMs ?? 60000,
    heartbeatMs: opts.driverHeartbeatMs,
  })

  function feedSessionEvent(ev: SessionEvent): void {
    switch (ev.kind) {
      case 'enqueue':
        if (ev.chatId) currentChatId = ev.chatId
        break
      case 'thinking':
        controller.setThinking()
        break
      case 'tool_use':
        if (!isTelegramSurfaceTool(ev.toolName)) {
          controller.setTool(ev.toolName)
        }
        break
      case 'turn_end':
        controller.setDone()
        break
      default:
        break
    }
    driver.ingest(ev, currentChatId, undefined)
  }

  function inbound(args: { chatId: string; messageId: number; text?: string }): void {
    primaryChatId = args.chatId
    primaryMessageId = args.messageId
    // 👀 immediately — same line as server.ts:6118.
    controller.setQueued()
    // Prime the progress card synchronously, same as server.ts:6147.
    driver.startTurn({ chatId: args.chatId, userText: args.text ?? '' })
  }

  const streamMsgs = new Map<string, number>()

  async function streamReply(args: { chat_id: string; text: string; done?: boolean }): Promise<void> {
    const key = args.chat_id
    const existingId = streamMsgs.get(key)
    if (existingId == null) {
      const r = (await api.sendMessage(args.chat_id, args.text, { parse_mode: 'HTML' })) as { message_id: number }
      streamMsgs.set(key, r.message_id)
    } else {
      await api.editMessageText(args.chat_id, existingId, args.text, { parse_mode: 'HTML' })
    }
    if (args.done === true) {
      controller.setDone()
    }
  }

  function finalize(): void {
    try { driver.dispose?.() } catch { /* ignore */ }
  }

  const clock: HarnessClock = {
    now: () => Date.now(),
    advance: async (ms) => {
      // vi.advanceTimersByTimeAsync isn't implemented by Bun's vitest shim,
      // so fall back to the sync variant + microtask flush. Same semantics
      // for these tests; lets the harness run under both vitest and `bun test`.
      const viAny = vi as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
      if (typeof viAny.advanceTimersByTimeAsync === 'function') {
        await viAny.advanceTimersByTimeAsync(ms)
        return
      }
      vi.advanceTimersByTime(ms)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    },
  }

  return {
    bot,
    clock,
    recorder,
    controller,
    driver,
    inbound,
    feedSessionEvent,
    streamReply,
    finalize,
  }
}

function isTelegramSurfaceTool(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n.endsWith('__reply') ||
    n.endsWith('__stream_reply') ||
    n.endsWith('__edit_message') ||
    n === 'reply' ||
    n === 'stream_reply'
  )
}
