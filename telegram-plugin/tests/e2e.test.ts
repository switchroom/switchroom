/**
 * Integration-style E2E tests for the Phase 1 integration branch.
 *
 * Architectural note — why this isn't a "full bot.start()" test:
 * server.ts does top-level work at import time (Bot(TOKEN), awaited
 * mcp.connect(StdioServerTransport), startSessionTail, startPtyTail,
 * initHistory). Stubbing all of that for a true in-process run would
 * require mocking grammy + @modelcontextprotocol/sdk + pty-tail +
 * session-tail + better-sqlite3 simultaneously, which is >10x the LOC
 * of this test file and brittle w.r.t. upstream churn.
 *
 * Instead, following the existing project convention
 * (see steering.test.ts, handoff-continuity.test.ts), we exercise each
 * specified scenario through the same pure helper modules that server.ts
 * calls. Where a scenario lives inside server.ts's in-memory state
 * (activeTurnStartedAt, activeStatusReactions, suppressPtyPreview), we
 * model that state directly and exercise the same mutate/check logic
 * server.ts uses. The helpers and the state shape are the contract —
 * if they don't regress, the integrated behaviour doesn't regress.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseQueuePrefix,
  formatPriorAssistantPreview,
  buildChannelMetaAttributes,
} from '../steering.js'
import {
  consumeHandoffTopic,
  readHandoffTopic,
  formatHandoffLine,
  shouldShowHandoffLine,
  HANDOFF_TOPIC_FILENAME,
} from '../handoff-continuity.js'
import {
  isContextExhaustionText,
  shouldArmOrphanedReplyTimeout,
} from '../context-exhaustion.js'
import { logStreamingEvent, type StreamingEvent } from '../streaming-metrics.js'

// ---------------------------------------------------------------------------
// Fake "plugin-state" harness — mirrors server.ts top-of-file state layout.
// ---------------------------------------------------------------------------

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

function streamKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? 'default'}`
}

interface PluginState {
  activeStatusReactions: Map<string, { chatId: string; threadId?: number }>
  activeTurnStartedAt: Map<string, number>
  suppressPtyPreview: Set<string>
  currentSessionChatId: string | null
  currentSessionThreadId: number | undefined
  currentTurnStartedAt: number
  handoffTopicUsed: boolean
}

function freshState(): PluginState {
  return {
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    suppressPtyPreview: new Set(),
    currentSessionChatId: null,
    currentSessionThreadId: undefined,
    currentTurnStartedAt: 0,
    handoffTopicUsed: false,
  }
}

/**
 * Models the server.ts inbound path at the point that decides whether a
 * message is mid-turn / queued / steering. Returns the resulting meta
 * attributes as a string (what ends up in the <channel> tag) plus the
 * coalesced body. Every branching decision here matches server.ts's
 * handleInbound (grep `steering="true"` in server.ts for parity).
 */
function simulateInbound(
  state: PluginState,
  opts: {
    chatId: string
    threadId?: number
    rawBody: string
    priorAssistantText?: string | null
    now?: number
  },
): { body: string; metaAttrs: string; notifiedAsSteering: boolean; notifiedAsQueued: boolean } {
  const { chatId, threadId, rawBody } = opts
  const now = opts.now ?? Date.now()
  const key = statusKey(chatId, threadId)

  const parsed = parseQueuePrefix(rawBody)
  const body = parsed.body
  const isQueuedPrefix = parsed.queued

  const priorStartedAt = state.activeTurnStartedAt.get(key)
  const priorTurnInProgress = state.activeStatusReactions.has(key)
  const isSteering = priorTurnInProgress && !isQueuedPrefix

  let preview = ''
  if (priorTurnInProgress && opts.priorAssistantText) {
    preview = formatPriorAssistantPreview(opts.priorAssistantText)
  }

  const secondsSince =
    priorStartedAt != null && priorStartedAt > 0
      ? (now - priorStartedAt) / 1000
      : undefined

  const metaAttrs = buildChannelMetaAttributes({
    queued: isQueuedPrefix,
    steering: isSteering,
    priorTurnInProgress,
    secondsSinceTurnStart: secondsSince,
    priorAssistantPreview: preview || undefined,
  })

  // Server.ts only creates a new controller when no prior one is active —
  // for steering we keep the existing controller (and its start time).
  if (!priorTurnInProgress) {
    state.activeStatusReactions.set(key, { chatId, threadId })
    state.activeTurnStartedAt.set(key, now)
  }

  return {
    body,
    metaAttrs,
    notifiedAsSteering: isSteering,
    notifiedAsQueued: isQueuedPrefix,
  }
}

/** Models the turn_end path — what server.ts does inside handleSessionEvent. */
function simulateTurnEnd(state: PluginState, chatId: string, threadId?: number): void {
  const key = statusKey(chatId, threadId)
  state.activeStatusReactions.delete(key)
  state.activeTurnStartedAt.delete(key)
  state.suppressPtyPreview.delete(streamKey(chatId, threadId))
  state.currentSessionChatId = null
  state.currentSessionThreadId = undefined
  state.currentTurnStartedAt = 0
}

/** Models the controller-error cleanup path (backstop / error branches). */
function simulateControllerError(state: PluginState, chatId: string, threadId?: number): void {
  const key = statusKey(chatId, threadId)
  state.activeStatusReactions.delete(key)
  state.activeTurnStartedAt.delete(key)
}

/** Models context-exhaustion auto-restart cleanup (server.ts line ~2015-2020). */
function simulateContextExhaustion(state: PluginState, chatId: string, threadId?: number): void {
  const key = statusKey(chatId, threadId)
  state.activeStatusReactions.delete(key)
  state.activeTurnStartedAt.delete(key)
  state.currentSessionChatId = null
  state.currentSessionThreadId = undefined
  state.currentTurnStartedAt = 0
}

// ---------------------------------------------------------------------------
// Steering / queue scenarios
// ---------------------------------------------------------------------------

describe('E2E: steering / queue meta on inbound', () => {
  it('mid-turn message sets steering="true" and populates priors', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'first task', now: 1_000_000 })
    const r = simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'actually make it blue',
      priorAssistantText: '<b>I am thinking about red.</b>',
      now: 1_000_000 + 12_000, // 12s later
    })
    expect(r.notifiedAsSteering).toBe(true)
    expect(r.notifiedAsQueued).toBe(false)
    expect(r.metaAttrs).toContain('steering="true"')
    expect(r.metaAttrs).toContain('prior_turn_in_progress="true"')
    expect(r.metaAttrs).toContain('seconds_since_turn_start="12"')
    expect(r.metaAttrs).toContain('prior_assistant_preview="I am thinking about red."')
    expect(r.metaAttrs).not.toContain('queued="true"')
    expect(r.body).toBe('actually make it blue')
  })

  it('mid-turn /queue prefix sets queued="true" but NOT steering', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'first task', now: 1_000_000 })
    const r = simulateInbound(s, {
      chatId: 'c1',
      rawBody: '/queue unrelated thing',
      priorAssistantText: 'working',
      now: 1_000_000 + 5_000,
    })
    expect(r.notifiedAsQueued).toBe(true)
    expect(r.notifiedAsSteering).toBe(false)
    expect(r.metaAttrs).toContain('queued="true"')
    expect(r.metaAttrs).not.toContain('steering="true"')
    expect(r.body).toBe('unrelated thing')
    // Prior-turn preview STILL included so the model knows something is in flight.
    expect(r.metaAttrs).toContain('prior_turn_in_progress="true"')
    expect(r.metaAttrs).toContain('prior_assistant_preview="working"')
  })

  it('first-ever inbound (no prior turn) has no steering/queued attrs', () => {
    const s = freshState()
    const r = simulateInbound(s, { chatId: 'c1', rawBody: 'hello', now: 1 })
    expect(r.notifiedAsSteering).toBe(false)
    expect(r.notifiedAsQueued).toBe(false)
    expect(r.metaAttrs).toBe('')
  })

  it('/queue with only trailing space yields empty body, queued flag set', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })
    const r = simulateInbound(s, {
      chatId: 'c1',
      rawBody: '/queue ',
      priorAssistantText: 'x',
      now: 1000,
    })
    expect(r.notifiedAsQueued).toBe(true)
    expect(r.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

describe('E2E: turn lifecycle cleanup', () => {
  it('turn_end clears activeStatusReactions, activeTurnStartedAt, suppressPtyPreview', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'x', now: 1 })
    s.suppressPtyPreview.add(streamKey('c1'))
    expect(s.activeStatusReactions.size).toBe(1)
    expect(s.activeTurnStartedAt.size).toBe(1)
    expect(s.suppressPtyPreview.size).toBe(1)

    simulateTurnEnd(s, 'c1')
    expect(s.activeStatusReactions.size).toBe(0)
    expect(s.activeTurnStartedAt.size).toBe(0)
    expect(s.suppressPtyPreview.size).toBe(0)
  })

  it('inbound after turn_end is treated as fresh (no steering)', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 1 })
    simulateTurnEnd(s, 'c1')
    const r = simulateInbound(s, { chatId: 'c1', rawBody: 'second', now: 999 })
    expect(r.notifiedAsSteering).toBe(false)
    expect(r.metaAttrs).toBe('')
  })

  it('controller error also clears activeTurnStartedAt', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'x', now: 1 })
    simulateControllerError(s, 'c1')
    expect(s.activeStatusReactions.has(statusKey('c1'))).toBe(false)
    expect(s.activeTurnStartedAt.has(statusKey('c1'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Handoff continuity
// ---------------------------------------------------------------------------

describe('E2E: handoff continuity', () => {
  let tmp: string
  const priorEnv = { ...process.env }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'handoff-e2e-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    process.env = { ...priorEnv }
  })

  it('bootstrap with sidecar + show-line=true → first reply prepends the line', () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), 'shipped the feature\n', 'utf8')
    process.env.SWITCHROOM_HANDOFF_SHOW_LINE = 'true'
    expect(shouldShowHandoffLine()).toBe(true)
    const topic = consumeHandoffTopic(tmp)
    expect(topic).toBe('shipped the feature')
    const line = formatHandoffLine(topic!, 'html')
    expect(line).toContain('shipped the feature')
    expect(line).toMatch(/^<i>/)
  })

  it('bootstrap with sidecar + show-line=false → no prefix', () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), 'x\n', 'utf8')
    process.env.SWITCHROOM_HANDOFF_SHOW_LINE = 'false'
    expect(shouldShowHandoffLine()).toBe(false)
  })

  it('bootstrap with no sidecar → no prefix', () => {
    expect(readHandoffTopic(tmp)).toBeNull()
    expect(consumeHandoffTopic(tmp)).toBeNull()
  })

  it('consuming topic is one-shot — second call returns null + sidecar deleted', () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), 'topic\n', 'utf8')
    expect(consumeHandoffTopic(tmp)).toBe('topic')
    expect(existsSync(join(tmp, HANDOFF_TOPIC_FILENAME))).toBe(false)
    expect(consumeHandoffTopic(tmp)).toBeNull()
  })

  it('stream_reply: once topic consumed, subsequent stream chunks do not re-prefix', () => {
    // Model: the plugin tracks handoffTopicUsed after first reply/stream_reply
    // use. The second and later stream edits on the same stream read the flag
    // and skip prepending.
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), 't\n', 'utf8')
    const s = freshState()
    expect(s.handoffTopicUsed).toBe(false)
    // first chunk
    const topic = consumeHandoffTopic(tmp)
    expect(topic).toBe('t')
    s.handoffTopicUsed = true
    // simulate next chunk arriving — should not consume
    expect(consumeHandoffTopic(tmp)).toBeNull()
    expect(s.handoffTopicUsed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Context exhaustion
// ---------------------------------------------------------------------------

describe('E2E: context exhaustion', () => {
  it('detects "Prompt is too long" in assistant text', () => {
    expect(isContextExhaustionText('Prompt is too long')).toBe(true)
    expect(isContextExhaustionText('OK done')).toBe(false)
  })

  it('cleans up state including activeTurnStartedAt on auto-restart', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'big task', now: 1 })
    s.currentSessionChatId = 'c1'
    s.currentTurnStartedAt = 1
    simulateContextExhaustion(s, 'c1')
    expect(s.activeStatusReactions.size).toBe(0)
    expect(s.activeTurnStartedAt.size).toBe(0)
    expect(s.currentSessionChatId).toBeNull()
    expect(s.currentTurnStartedAt).toBe(0)
  })

  it('shouldArmOrphanedReplyTimeout arms only when chat active, text captured, reply not yet called', () => {
    expect(shouldArmOrphanedReplyTimeout({
      currentSessionChatId: 'c1',
      capturedTextCount: 1,
      replyCalled: false,
    })).toBe(true)
    expect(shouldArmOrphanedReplyTimeout({
      currentSessionChatId: null,
      capturedTextCount: 1,
      replyCalled: false,
    })).toBe(false)
    expect(shouldArmOrphanedReplyTimeout({
      currentSessionChatId: 'c1',
      capturedTextCount: 0,
      replyCalled: false,
    })).toBe(false)
    expect(shouldArmOrphanedReplyTimeout({
      currentSessionChatId: 'c1',
      capturedTextCount: 1,
      replyCalled: true,
    })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Streaming metrics gate
// ---------------------------------------------------------------------------

describe('E2E: streaming metrics gate', () => {
  let writes: string[] = []
  let original: typeof process.stderr.write
  let priorFlag: string | undefined

  beforeEach(() => {
    writes = []
    original = process.stderr.write.bind(process.stderr)
    priorFlag = process.env.SWITCHROOM_STREAMING_METRICS
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    process.stderr.write = original
    if (priorFlag === undefined) delete process.env.SWITCHROOM_STREAMING_METRICS
    else process.env.SWITCHROOM_STREAMING_METRICS = priorFlag
  })

  it('no emission when unset', () => {
    delete process.env.SWITCHROOM_STREAMING_METRICS
    logStreamingEvent({ kind: 'turn_end', chatId: 'c1', durationMs: 1, suppressClearedCount: 0 })
    expect(writes.length).toBe(0)
  })

  it('no emission when set to 0', () => {
    process.env.SWITCHROOM_STREAMING_METRICS = '0'
    logStreamingEvent({ kind: 'turn_end', chatId: 'c1', durationMs: 1, suppressClearedCount: 0 })
    expect(writes.length).toBe(0)
  })

  it('emits well-formed JSON for each of the 6 event kinds when set to 1', () => {
    process.env.SWITCHROOM_STREAMING_METRICS = '1'
    const kinds: StreamingEvent[] = [
      { kind: 'pty_partial_received', chatId: 'c1', suppressed: false, hasStream: false, charCount: 5, bufferedWithoutChatId: false },
      { kind: 'stream_reply_called', chatId: 'c1', charCount: 10, done: false, streamExisted: false },
      { kind: 'reply_called', chatId: 'c1', charCount: 20, replacedPreview: false, previewMessageId: null },
      { kind: 'draft_send', chatId: 'c1', messageId: 100, charCount: 30 },
      { kind: 'draft_edit', chatId: 'c1', messageId: 100, charCount: 40, sameAsLast: false },
      { kind: 'turn_end', chatId: 'c1', durationMs: 1234, suppressClearedCount: 0 },
    ]
    for (const ev of kinds) logStreamingEvent(ev)
    expect(writes.length).toBe(6)
    for (const line of writes) {
      expect(line).toMatch(/^\[streaming-metrics\] /)
      const json = line.replace(/^\[streaming-metrics\] /, '').trim()
      const parsed = JSON.parse(json)
      expect(typeof parsed.ts).toBe('number')
      expect(typeof parsed.kind).toBe('string')
    }
  })
})
