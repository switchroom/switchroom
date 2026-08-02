import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initBuzzMirror,
  getBuzzMirror,
  maybeBootBuzzMirror,
  __resetBuzzMirrorForTests,
  CORRECTION_DEBOUNCE_MS,
} from '../gateway/buzz-mirror.js'
import type { OutboundToBuzzMessage } from '../gateway/ipc-protocol.js'

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
