/**
 * #2094 finding 4 — bridge-side messageId dedup.
 *
 * Outcome contract: a genuine user message re-delivered by the stranded-
 * message sweep within one turn is forwarded to claude exactly ONCE; after
 * the turn-complete clear (a successful reply for that chat) forwarding
 * resumes. Synthetic / button / structured-event inbounds are never deduped,
 * and per-chat memory is capped.
 */
import { describe, it, expect } from 'vitest'
import {
  InboundDedup,
  shouldDedupInbound,
  dedupChatKey,
  INBOUND_DEDUP_MAX_PER_CHAT,
  type DedupInboundLike,
} from '../bridge/inbound-dedup.js'

function userMsg(messageId: number, extra: Record<string, string> = {}): DedupInboundLike {
  return { messageId, meta: { chat_id: '12345', message_id: String(messageId), ...extra } }
}

describe('shouldDedupInbound gate', () => {
  it('dedups a plain user message', () => {
    expect(shouldDedupInbound(userMsg(500))).toBe(true)
  })
  it('never dedups synthetic (meta.source), button, structured, or reaction inbounds', () => {
    expect(shouldDedupInbound(userMsg(500, { source: 'cron' }))).toBe(false)
    expect(shouldDedupInbound(userMsg(500, { button_callback: 'true' }))).toBe(false)
    expect(shouldDedupInbound(userMsg(500, { kind: 'checklist_task_changed' }))).toBe(false)
    expect(shouldDedupInbound(userMsg(500, { event: 'reaction' }))).toBe(false)
  })
  it('never dedups a non-positive messageId (no real Telegram id)', () => {
    expect(shouldDedupInbound(userMsg(0))).toBe(false)
    expect(shouldDedupInbound({ messageId: -1, meta: {} })).toBe(false)
  })
})

describe('InboundDedup checkAndRecord + clearChat', () => {
  it('processes a duplicate messageId within one turn exactly once', () => {
    const d = new InboundDedup()
    const key = dedupChatKey('12345')
    expect(d.checkAndRecord(key, 500)).toBe('fresh')
    // Sweep re-delivers the SAME messageId before the turn completes.
    expect(d.checkAndRecord(key, 500)).toBe('duplicate')
    expect(d.checkAndRecord(key, 500)).toBe('duplicate')
    // A different message in the same turn is still forwarded.
    expect(d.checkAndRecord(key, 501)).toBe('fresh')
  })

  it('resumes processing the same messageId after the turn-complete clear', () => {
    const d = new InboundDedup()
    const key = dedupChatKey('12345')
    expect(d.checkAndRecord(key, 500)).toBe('fresh')
    expect(d.checkAndRecord(key, 500)).toBe('duplicate')
    // reply fired for the chat → turn-complete reset.
    d.clearChat('12345')
    expect(d.size(key)).toBe(0)
    // A genuinely new turn may re-see the id (fresh again).
    expect(d.checkAndRecord(key, 500)).toBe('fresh')
  })

  it('clearChat is thread-agnostic — clears every thread key for the chat', () => {
    const d = new InboundDedup()
    const dm = dedupChatKey('12345')
    const topic = dedupChatKey('12345', 42)
    d.checkAndRecord(dm, 500)
    d.checkAndRecord(topic, 700)
    d.checkAndRecord(dedupChatKey('999', 1), 800) // unrelated chat, untouched
    d.clearChat('12345')
    expect(d.size(dm)).toBe(0)
    expect(d.size(topic)).toBe(0)
    expect(d.size(dedupChatKey('999', 1))).toBe(1)
  })

  it('caps per-chat memory (FIFO-evicts the oldest id)', () => {
    const d = new InboundDedup(3)
    const key = dedupChatKey('12345')
    d.checkAndRecord(key, 1)
    d.checkAndRecord(key, 2)
    d.checkAndRecord(key, 3)
    d.checkAndRecord(key, 4) // evicts id 1
    expect(d.size(key)).toBe(3)
    // id 1 was evicted → treated as fresh again (bounded memory, accepted).
    expect(d.checkAndRecord(key, 1)).toBe('fresh')
    // ids still tracked are duplicates.
    expect(d.checkAndRecord(key, 4)).toBe('duplicate')
  })

  it('default cap is a sane bound', () => {
    expect(INBOUND_DEDUP_MAX_PER_CHAT).toBeGreaterThanOrEqual(128)
  })
})
