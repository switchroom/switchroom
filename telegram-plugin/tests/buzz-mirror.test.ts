import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initBuzzMirror,
  getBuzzMirror,
  maybeBootBuzzMirror,
  resolveCorrelationJournalPath,
  __resetBuzzMirrorForTests,
  CORRECTION_DEBOUNCE_MS,
} from '../gateway/buzz-mirror.js'
import type { OutboundToBuzzMessage } from '../gateway/ipc-protocol.js'
import { buildThreadTags } from '../../src/buzz-gateway/transform.js'

// Hub-side mirror behaviour (Phase 2b). The mirror is DOWNSTREAM of a delivered
// Telegram copy; a publish is emitted via the attached peer sender. These tests
// spy the sender to assert WHETHER and WITH WHAT a publish is issued.

function mirrorWith(sender: (m: OutboundToBuzzMessage) => boolean, opts?: { defaultChannelId?: string }) {
  const m = initBuzzMirror({
    mode: 'both',
    agentName: 'klanker',
    defaultChannelId: opts?.defaultChannelId ?? 'default-chan',
  })
  m.attachSender(sender)
  return m
}

const BUZZ_COORDS = { channelId: 'chan-A', eventId: 'evt-1', threadRoot: 'root-1' }

// Cross-FILE isolation. `getBuzzMirror()` is a module-level singleton and the
// last describe here boots one (`maybeBootBuzzMirror`) with no trailing reset —
// every `beforeEach` in this file resets on the way IN, nothing resets on the
// way OUT. `bun test` runs every file in ONE process with no guaranteed file
// order, so a booted mirror leaks into whichever suite runs next: sendReply's
// Buzz hook (outbound-send-path.ts:2658) then fires in suites that never wired
// its deps and dies on `findLatestTurnForChat is not a function` (observed:
// 43 failures in send-reply-golden.test.ts, purely from readdir order).
// Unconditional teardown here is the only ordering-proof fix.
afterAll(() => __resetBuzzMirrorForTests())

describe('BuzzMirror.mirrorReplyDelivered — routing + S1 owner guard', () => {
  beforeEach(() => __resetBuzzMirrorForTests())

  it('T-6b (hub): a live buzz owner + un-echoed reply + a recent different-origin turn ⇒ NO publish', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: false, // the reply did NOT echo this buzz turn's id
      hasRecentDifferentOriginTurn: true, // a prior Telegram DM turn is live/recent
      telegramMessageKeys: ['555:1001'],
    })
    // The S1 guard must refuse the ambiguous threaded publish — Telegram-only.
    expect(sender).not.toHaveBeenCalled()
  })

  it('publishes a THREADED reply when the buzz owner id was echoed', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: true,
      hasRecentDifferentOriginTurn: true, // irrelevant once echoed
      telegramMessageKeys: ['555:1001'],
    })
    expect(sender).toHaveBeenCalledTimes(1)
    const msg = sender.mock.calls[0][0]
    expect(msg.type).toBe('outbound_to_buzz')
    expect(msg.channelId).toBe(BUZZ_COORDS.channelId)
    expect(msg.replyToEventId).toBe(BUZZ_COORDS.eventId)
    expect(msg.threadRootId).toBe(BUZZ_COORDS.threadRoot)
    expect(msg.payload).toEqual({ kind: 'message', text: 'answer' })
    expect(msg.agentName).toBe('klanker')
  })

  it('publishes a buzz-origin threaded reply when un-echoed but NO different-origin turn exists', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:1001'],
    })
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('mirrors a TELEGRAM-origin answer as a fresh top-level post to defaultChannelId', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender, { defaultChannelId: 'grp-top' })
    m.mirrorReplyDelivered({
      scrubbedText: 'tele answer',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:2002'],
    })
    expect(sender).toHaveBeenCalledTimes(1)
    const msg = sender.mock.calls[0][0]
    expect(msg.channelId).toBe('grp-top')
    expect(msg.replyToEventId).toBeUndefined() // top-level, not a thread reply
    expect(msg.threadRootId).toBeUndefined()
  })

  it('drops a telegram-origin mirror when no default channel is configured', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender, { defaultChannelId: '' })
    m.mirrorReplyDelivered({
      scrubbedText: 'x',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:3003'],
    })
    expect(sender).not.toHaveBeenCalled()
  })

  it('never throws even if the sender throws (the Telegram copy is already delivered)', () => {
    const sender = vi.fn(() => { throw new Error('peer exploded') })
    const m = mirrorWith(sender)
    expect(() =>
      m.mirrorReplyDelivered({
        scrubbedText: 'x',
        ownerOriginChannel: 'telegram',
        ownerEchoed: false,
        hasRecentDifferentOriginTurn: false,
        telegramMessageKeys: ['555:4004'],
      }),
    ).not.toThrow()
  })
})

describe('BuzzMirror.mirrorReplyDelivered — NIP-10 OUTBOUND thread continuity', () => {
  beforeEach(() => __resetBuzzMirrorForTests())

  // Helper: mirror a telegram-origin answer, complete its publish so the
  // correlation store learns its event id, and return the published event id.
  function mirrorTelegramAndComplete(
    m: ReturnType<typeof mirrorWith>,
    sender: ReturnType<typeof vi.fn>,
    opts: { telegramKey: string; antecedentKey?: string; eventId: string },
  ): OutboundToBuzzMessage {
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: [opts.telegramKey],
      antecedentTelegramMessageKey: opts.antecedentKey,
    })
    const call = sender.mock.calls[sender.mock.calls.length - 1][0] as OutboundToBuzzMessage
    m.onPublishResult({ correlationId: call.correlationId, ok: true, eventId: opts.eventId })
    return call
  }

  it('threads a telegram-origin reply UNDER its antecedent`s mirrored event (root === parent for a top-level antecedent)', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender, { defaultChannelId: 'grp' })

    // A1: a top-level telegram-origin answer, published as evt-A.
    mirrorTelegramAndComplete(m, sender, { telegramKey: '555:100', eventId: 'evt-A' })
    // A2: a telegram-origin answer that REPLIES to A1's Telegram message.
    m.mirrorReplyDelivered({
      scrubbedText: 'follow-up',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:200'],
      antecedentTelegramMessageKey: '555:100',
    })

    const msg = sender.mock.calls[sender.mock.calls.length - 1][0] as OutboundToBuzzMessage
    // The immediate parent is A1's event; A1 was top-level so IT is the root.
    expect(msg.replyToEventId).toBe('evt-A')
    expect(msg.threadRootId).toBe('evt-A')
    // NIP-10: root === parent collapses to a single reply-to-root e-tag.
    expect(buildThreadTags({ threadRootId: msg.threadRootId, replyToEventId: msg.replyToEventId })).toEqual([
      ['e', 'evt-A', '', 'root'],
    ])
  })

  it('emits DISTINCT root + reply markers for a reply into a DEEPER thread', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender, { defaultChannelId: 'grp' })

    // A0 top-level → evt-root.
    mirrorTelegramAndComplete(m, sender, { telegramKey: '555:100', eventId: 'evt-root' })
    // A1 replies to A0 → threads under evt-root; published as evt-mid. Its
    // recorded threadRoot must stay evt-root (NOT evt-mid).
    mirrorTelegramAndComplete(m, sender, {
      telegramKey: '555:200',
      antecedentKey: '555:100',
      eventId: 'evt-mid',
    })
    // A2 replies to A1 → parent is evt-mid, but the thread root is still evt-root.
    m.mirrorReplyDelivered({
      scrubbedText: 'deep',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:300'],
      antecedentTelegramMessageKey: '555:200',
    })

    const msg = sender.mock.calls[sender.mock.calls.length - 1][0] as OutboundToBuzzMessage
    expect(msg.replyToEventId).toBe('evt-mid') // immediate parent
    expect(msg.threadRootId).toBe('evt-root') // thread root, NOT the parent
    expect(buildThreadTags({ threadRootId: msg.threadRootId, replyToEventId: msg.replyToEventId })).toEqual([
      ['e', 'evt-root', '', 'root'],
      ['e', 'evt-mid', '', 'reply'],
    ])
  })

  it('a reply whose antecedent is a correlation-store MISS mirrors FLAT (no wrong/guessed tag)', () => {
    const logs: string[] = []
    __resetBuzzMirrorForTests()
    const sender = vi.fn(() => true)
    const m = initBuzzMirror({ mode: 'both', agentName: 'klanker', defaultChannelId: 'grp', log: (l) => logs.push(l) })
    m.attachSender(sender)

    // The antecedent key was NEVER mirrored (e.g. it is the user's own inbound
    // message) — the lookup misses. The mirror must NOT invent a thread tag.
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:200'],
      antecedentTelegramMessageKey: '555:100', // not in the store
    })

    expect(sender).toHaveBeenCalledTimes(1)
    const msg = sender.mock.calls[0][0] as OutboundToBuzzMessage
    expect(msg.replyToEventId).toBeUndefined()
    expect(msg.threadRootId).toBeUndefined()
    // The flat fallback still PUBLISHES (top-level), just with no thread tags.
    expect(buildThreadTags({ threadRootId: msg.threadRootId, replyToEventId: msg.replyToEventId })).toEqual([])
    expect(logs.some((l) => /outbound thread MISS/.test(l))).toBe(true)
  })

  it('#4299: a FOREIGN-CHANNEL antecedent mirrors FLAT (no cross-group e-tag)', () => {
    const logs: string[] = []
    __resetBuzzMirrorForTests()
    const sender = vi.fn(() => true)
    // Telegram-origin mirrors post into 'grp'; the antecedent below was mirrored
    // into a DIFFERENT (buzz-origin) channel 'chan-A'.
    const m = initBuzzMirror({ mode: 'both', agentName: 'klanker', defaultChannelId: 'grp', log: (l) => logs.push(l) })
    m.attachSender(sender)

    // Record '555:100' → an event published into buzz channel 'chan-A' (its
    // channelId comes from ownerBuzzCoords, NOT defaultChannelId). This is the
    // exact shape #4299 warns about: a parent recorded via a buzz-origin
    // threaded reply whose channelId came from the inbound event's own h-tag.
    m.mirrorReplyDelivered({
      scrubbedText: 'buzz answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: { channelId: 'chan-A', eventId: 'evt-buzz', threadRoot: 'root-buzz' },
      ownerEchoed: true,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:100'],
    })
    const buzzCall = sender.mock.calls[sender.mock.calls.length - 1][0] as OutboundToBuzzMessage
    expect(buzzCall.channelId).toBe('chan-A')
    m.onPublishResult({ correlationId: buzzCall.correlationId, ok: true, eventId: 'evt-buzz' })

    // A later TELEGRAM-origin answer replies to '555:100'. Its target channel is
    // 'grp' ≠ 'chan-A' — threading under evt-buzz would carry e-tags into the
    // foreign 'chan-A' group. It MUST mirror flat instead.
    m.mirrorReplyDelivered({
      scrubbedText: 'tele follow-up',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:200'],
      antecedentTelegramMessageKey: '555:100',
    })

    const msg = sender.mock.calls[sender.mock.calls.length - 1][0] as OutboundToBuzzMessage
    expect(msg.channelId).toBe('grp')
    // FLAT: no thread tags at all — crucially NOT evt-buzz / root-buzz.
    expect(msg.replyToEventId).toBeUndefined()
    expect(msg.threadRootId).toBeUndefined()
    expect(buildThreadTags({ threadRootId: msg.threadRootId, replyToEventId: msg.replyToEventId })).toEqual([])
    // Logged distinctly as a cross-channel guard, NOT as an eviction MISS.
    expect(logs.some((l) => /outbound thread CROSS-CHANNEL/.test(l))).toBe(true)
    expect(logs.some((l) => /outbound thread MISS/.test(l))).toBe(false)
  })

  it('#4301: a quote-opt-in DEFAULT antecedent miss is NOT logged as an eviction MISS', () => {
    const logs: string[] = []
    __resetBuzzMirrorForTests()
    const sender = vi.fn(() => true)
    const m = initBuzzMirror({ mode: 'both', agentName: 'klanker', defaultChannelId: 'grp', log: (l) => logs.push(l) })
    m.attachSender(sender)

    // The antecedent is the latest INBOUND user message (quote-opt-in default),
    // which is never in the correlation store — an EXPECTED miss, not eviction.
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:200'],
      antecedentTelegramMessageKey: '555:100', // latest inbound, never mirrored
      antecedentIsQuoteOptInDefault: true,
    })

    expect(sender).toHaveBeenCalledTimes(1)
    const msg = sender.mock.calls[0][0] as OutboundToBuzzMessage
    // Still a flat top-level post.
    expect(msg.replyToEventId).toBeUndefined()
    expect(msg.threadRootId).toBeUndefined()
    // The expected default-quote miss must NOT masquerade as an eviction MISS,
    // so a genuine eviction miss stays distinguishable in the logs.
    expect(logs.some((l) => /outbound thread MISS/.test(l))).toBe(false)
    expect(logs.some((l) => /default-quote/.test(l))).toBe(true)
  })
})

describe('BuzzMirror.mirrorCorrection — debounced, only for mirrored messages', () => {
  beforeEach(() => {
    __resetBuzzMirrorForTests()
    vi.useFakeTimers()
  })
  // restore real timers after each via afterEach-less pattern
  it('no-ops for a Telegram message that was never mirrored to Buzz', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    m.mirrorCorrection({ telegramMessageKey: '555:9999', scrubbedText: 'fixed' })
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS + 1000)
    expect(sender).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('publishes a debounced correction for a message recorded via onPublishResult', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    // First: a delivered buzz publish, then its OK result records the mapping.
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: true,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:1001'],
    })
    const correlationId = sender.mock.calls[0][0].correlationId
    m.onPublishResult({ correlationId, ok: true, eventId: 'published-evt' })
    sender.mockClear()

    m.mirrorCorrection({ telegramMessageKey: '555:1001', scrubbedText: 'corrected' })
    // Debounced: nothing before the window elapses.
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS - 10)
    expect(sender).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(sender).toHaveBeenCalledTimes(1)
    const corr = sender.mock.calls[0][0]
    expect(corr.payload).toEqual({ kind: 'correction', text: 'corrected', targetEventId: 'published-evt' })
    vi.useRealTimers()
  })

  it('S4/F6: two rapid edits COALESCE to a SINGLE published correction (last-write-wins)', () => {
    const sender = vi.fn(() => true)
    const m = mirrorWith(sender)
    // Record a mirrored message so there is a Buzz event to correct.
    m.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: true,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:1001'],
    })
    const correlationId = sender.mock.calls[0][0].correlationId
    m.onPublishResult({ correlationId, ok: true, eventId: 'published-evt' })
    sender.mockClear()

    // Edit #1 at t=0 arms a timer for t=DEBOUNCE. Edit #2 arrives INSIDE the
    // window and must CLEAR edit #1's timer (buzz-mirror.ts:192-193) so only the
    // latest text is ever published, and only once.
    m.mirrorCorrection({ telegramMessageKey: '555:1001', scrubbedText: 'first edit' })
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS - 5_000) // still inside the window
    m.mirrorCorrection({ telegramMessageKey: '555:1001', scrubbedText: 'second edit' })

    // Step PAST edit #1's original deadline. If coalescing were broken, edit #1's
    // timer would fire here — it must NOT (it was cleared).
    vi.advanceTimersByTime(6_000)
    expect(sender).not.toHaveBeenCalled()

    // Reach edit #2's deadline: EXACTLY ONE correction, carrying the LATEST text.
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sender.mock.calls[0][0].payload).toEqual({
      kind: 'correction',
      text: 'second edit',
      targetEventId: 'published-evt',
    })
    vi.useRealTimers()
  })
})

describe('BuzzMirror correction correlation SURVIVES a gateway restart (#4222)', () => {
  let dir: string
  let journalPath: string

  beforeEach(() => {
    __resetBuzzMirrorForTests()
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'buzz-mirror-corr-'))
    journalPath = join(dir, 'buzz', 'mirror-correlation.jsonl')
  })
  afterEach(() => {
    __resetBuzzMirrorForTests()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function bootMirror(sender: (m: OutboundToBuzzMessage) => boolean) {
    const m = initBuzzMirror({
      mode: 'both',
      agentName: 'klanker',
      defaultChannelId: 'default-chan',
      correlationJournalPath: journalPath,
    })
    m.attachSender(sender)
    return m
  }

  it('an edit_message on a pre-restart-mirrored answer STILL emits the superseding correction', () => {
    // --- Session 1: mirror an answer and record its published Buzz event. ---
    const sender1 = vi.fn(() => true)
    const m1 = bootMirror(sender1)
    m1.mirrorReplyDelivered({
      scrubbedText: 'answer',
      ownerOriginChannel: 'buzz',
      ownerBuzzCoords: BUZZ_COORDS,
      ownerEchoed: true,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:1001'],
    })
    const correlationId = sender1.mock.calls[0][0].correlationId
    m1.onPublishResult({ correlationId, ok: true, eventId: 'published-evt' })

    // --- Restart: a NEW BuzzMirror over the SAME journal (map reloads from disk).
    __resetBuzzMirrorForTests() // closes m1's journal fd
    const sender2 = vi.fn(() => true)
    const m2 = bootMirror(sender2)

    // An edit lands AFTER the restart on a message mirrored BEFORE it. On today's
    // in-memory-only code the reloaded map is empty and this is silently skipped;
    // with the durable journal the correction still fires.
    m2.mirrorCorrection({ telegramMessageKey: '555:1001', scrubbedText: 'corrected' })
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS + 1000)

    expect(sender2).toHaveBeenCalledTimes(1)
    const corr = sender2.mock.calls[0][0]
    expect(corr.payload).toEqual({
      kind: 'correction',
      text: 'corrected',
      targetEventId: 'published-evt',
    })
    expect(m2.getCorrectionMisses()).toBe(0)
  })

  it('a correction on a truly-unknown key logs a LOUD miss (never silent) and never publishes', () => {
    const logs: string[] = []
    __resetBuzzMirrorForTests()
    const sender = vi.fn(() => true)
    const m = initBuzzMirror({
      mode: 'both',
      agentName: 'klanker',
      defaultChannelId: 'default-chan',
      correlationJournalPath: journalPath,
      log: (msg) => logs.push(msg),
    })
    m.attachSender(sender)

    m.mirrorCorrection({ telegramMessageKey: '555:404', scrubbedText: 'fixed' })
    vi.advanceTimersByTime(CORRECTION_DEBOUNCE_MS + 1000)

    expect(sender).not.toHaveBeenCalled()
    expect(m.getCorrectionMisses()).toBe(1)
    expect(logs.some((l) => /CORRECTION MISS/.test(l))).toBe(true)
  })
})

describe('resolveCorrelationJournalPath — distinct from the sidecar dedup journal', () => {
  it('derives mirror-correlation.jsonl under $TELEGRAM_STATE_DIR/buzz (NOT journal.jsonl)', () => {
    const p = resolveCorrelationJournalPath({ TELEGRAM_STATE_DIR: '/state/agent/telegram' })
    expect(p).toBe('/state/agent/telegram/buzz/mirror-correlation.jsonl')
    // Must not collide with the sidecar's journal.jsonl on the shared buzz dir.
    expect(p).not.toContain('journal.jsonl')
  })

  it('honours the BUZZ_MIRROR_CORRELATION_PATH override', () => {
    expect(
      resolveCorrelationJournalPath({ BUZZ_MIRROR_CORRELATION_PATH: '/custom/corr.jsonl' }),
    ).toBe('/custom/corr.jsonl')
  })

  it('returns undefined (in-memory only) when TELEGRAM_STATE_DIR is unset', () => {
    expect(resolveCorrelationJournalPath({})).toBeUndefined()
  })
})

describe('maybeBootBuzzMirror — dark by default (S2)', () => {
  beforeEach(() => __resetBuzzMirrorForTests())

  it('stays dark (returns null, getBuzzMirror null) when BUZZ_ENABLED is unset', () => {
    const booted = maybeBootBuzzMirror(() => true, {})
    expect(booted).toBeNull()
    expect(getBuzzMirror()).toBeNull()
  })

  it('stays dark when enabled but mode is off/origin (S2 degrade)', () => {
    expect(maybeBootBuzzMirror(() => true, { BUZZ_ENABLED: '1', BUZZ_MIRROR: 'off' })).toBeNull()
    expect(maybeBootBuzzMirror(() => true, { BUZZ_ENABLED: '1', BUZZ_MIRROR: 'origin' })).toBeNull()
    expect(getBuzzMirror()).toBeNull()
  })

  it('boots when enabled AND mode both, wiring the sender', () => {
    const sender = vi.fn(() => true)
    const booted = maybeBootBuzzMirror(sender, {
      BUZZ_ENABLED: '1',
      BUZZ_MIRROR: 'both',
      SWITCHROOM_AGENT_NAME: 'klanker',
      BUZZ_CHANNEL_IDS: 'grp-top',
    })
    expect(booted).not.toBeNull()
    expect(getBuzzMirror()).toBe(booted)
    // Sender is wired: a telegram-origin mirror flows to it.
    booted!.mirrorReplyDelivered({
      scrubbedText: 'x',
      ownerOriginChannel: 'telegram',
      ownerEchoed: false,
      hasRecentDifferentOriginTurn: false,
      telegramMessageKeys: ['555:1'],
    })
    expect(sender).toHaveBeenCalledTimes(1)
  })
})
