/**
 * outbox-delivery.test.ts — the delivery half of guaranteed final-message
 * delivery. Exercises the pure sweep decision (`decideOutboxSweep`), routing
 * (`resolveOutboxChat`, H3), the shared-nonce parity between the .mjs hook and
 * the .ts gateway, and an end-to-end `sweepOutbox` run against injected IO deps
 * on a real temp state dir: exactly-once (H1), concurrent siblings → two
 * distinct deliveries, text-dedup skip, and delivered-journal suppression.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideOutboxSweep,
  deriveTurnNonce,
  resolveOutboxChat,
  writeOutboxRecordAtomic,
  readDeliveredNonces,
  listPendingRecords,
  writeLastInboundChat,
  sha256Hex,
  type OutboxRecord,
  OUTBOX_MAX_AGE_MS,
} from '../outbox.js'
import { deriveTurnNonce as deriveTurnNonceMjs } from '../hooks/silent-end-scan.mjs'
import { sweepOutbox } from '../gateway/outbox-sweep.js'

function rec(over: Partial<OutboxRecord>): OutboxRecord {
  const text = over.text ?? 'x'.repeat(300)
  return {
    turnNonce: over.turnNonce ?? 'n1',
    chatId: 'chatId' in over ? (over.chatId ?? null) : '111',
    threadId: over.threadId ?? null,
    text,
    textSha256: over.textSha256 ?? sha256Hex(text),
    createdAt: over.createdAt ?? 0,
    source: over.source ?? 'channel',
    anchorContent: over.anchorContent,
  }
}

describe('deriveTurnNonce — .mjs / .ts parity (shared namespace, H1)', () => {
  it('produces byte-identical nonces for the message_id shape', () => {
    const args = { chatId: '111', threadId: 7, messageId: '42', anchorTimestampMs: 5, anchorContent: 'c' }
    expect(deriveTurnNonceMjs(args)).toBe(deriveTurnNonce(args))
  })
  it('produces byte-identical nonces for the content-hash shape', () => {
    const args = { chatId: null, threadId: null, messageId: null, anchorTimestampMs: 5, anchorContent: 'c' }
    expect(deriveTurnNonceMjs(args)).toBe(deriveTurnNonce(args))
  })
})

describe('decideOutboxSweep', () => {
  const base = { deliveredNonces: new Set<string>(), textAlreadyDelivered: false, routable: true }
  it('sends a routable, un-journaled, past-quiet record', () => {
    expect(decideOutboxSweep({ record: rec({}), now: 10_000, ...base }).action).toBe('send')
  })
  it('skips a nonce already in the journal (exactly-once)', () => {
    expect(
      decideOutboxSweep({ record: rec({ turnNonce: 'd' }), now: 10_000, ...base, deliveredNonces: new Set(['d']) }).action,
    ).toBe('skip-journaled')
  })
  it('skips inside the quiet period', () => {
    expect(decideOutboxSweep({ record: rec({ createdAt: 9999 }), now: 10_000, ...base }).action).toBe('skip-quiet')
  })
  it('skips on text-dedup', () => {
    expect(decideOutboxSweep({ record: rec({}), now: 10_000, ...base, textAlreadyDelivered: true }).action).toBe(
      'skip-dedup',
    )
  })
  it('holds an unroutable record rather than dropping', () => {
    expect(decideOutboxSweep({ record: rec({}), now: 10_000, ...base, routable: false }).action).toBe('skip-unroutable')
  })
  it('delivers a beyond-max-age record with a (delayed) prefix, never drops', () => {
    const d = decideOutboxSweep({ record: rec({ text: 'answer' }), now: OUTBOX_MAX_AGE_MS + 10_000, ...base })
    expect(d.action).toBe('send-delayed')
    expect(d.text).toBe('(delayed) answer')
  })
})

describe('resolveOutboxChat (H3)', () => {
  it('routes via the anchor envelope when chatId is present', () => {
    const r = resolveOutboxChat(rec({ chatId: '111', threadId: 5 }), {})
    expect(r).toEqual({ chatId: '111', threadId: 5, via: 'anchor' })
  })
  it('routes an envelope-less record via the transitive registry chain', () => {
    const r = resolveOutboxChat(rec({ chatId: null, anchorContent: '<task-id>T1</task-id>' }) as any, {
      registryChainLookup: (c) => (c.includes('T1') ? { chatId: '222', threadId: 9 } : null),
      lastInboundChat: () => ({ chatId: 'WRONG', threadId: null }),
    })
    expect(r).toEqual({ chatId: '222', threadId: 9, via: 'registry' })
  })
  it('falls back to last-inbound when the chain does not resolve', () => {
    const r = resolveOutboxChat(rec({ chatId: null, anchorContent: 'no-task-id-here' }) as any, {
      registryChainLookup: () => null,
      lastInboundChat: () => ({ chatId: '333', threadId: null }),
    })
    expect(r).toEqual({ chatId: '333', threadId: null, via: 'last-inbound' })
  })
  it('returns null when nothing resolves', () => {
    expect(resolveOutboxChat(rec({ chatId: null }) as any, {})).toBeNull()
  })
})

describe('sweepOutbox — end to end (exactly-once, siblings, dedup)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function sink() {
    const sent: Array<{ chatId: string; threadId: number | null; text: string }> = []
    return {
      sent,
      send: async (chatId: string, threadId: number | null, text: string) => {
        sent.push({ chatId, threadId, text })
        return sent.length
      },
    }
  }

  it('delivers a record exactly once across repeated sweeps (H1)', async () => {
    writeOutboxRecordAtomic(rec({ turnNonce: 'n1', createdAt: 0 }), dir)
    const s = sink()
    const deps = { ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 }
    await sweepOutbox(deps)
    await sweepOutbox(deps) // journal now suppresses
    await sweepOutbox(deps)
    expect(s.sent).toHaveLength(1)
    expect(readDeliveredNonces(dir).has('n1')).toBe(true)
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('two concurrent sibling handbacks with distinct nonces both deliver, no clobber', async () => {
    // Same content, distinct enqueue timestamps → distinct nonces (H2).
    const n1 = deriveTurnNonce({ chatId: null, threadId: null, messageId: null, anchorTimestampMs: 1000, anchorContent: 'sib' })
    const n2 = deriveTurnNonce({ chatId: null, threadId: null, messageId: null, anchorTimestampMs: 2000, anchorContent: 'sib' })
    expect(n1).not.toBe(n2)
    writeOutboxRecordAtomic(rec({ turnNonce: n1, chatId: '111', text: 'answer one xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }), dir)
    writeOutboxRecordAtomic(rec({ turnNonce: n2, chatId: '111', text: 'answer two yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(2)
    expect(new Set(s.sent.map((x) => x.text)).size).toBe(2)
  })

  it('skips when the text was already delivered by the legacy flush (dedup)', async () => {
    writeOutboxRecordAtomic(rec({ turnNonce: 'n1', text: 'dup', createdAt: 0 }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => true, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(0)
  })

  it('routes an envelope-less record through last-inbound with a prefix', async () => {
    writeLastInboundChat({ chatId: '888', threadId: null }, dir)
    writeOutboxRecordAtomic(rec({ turnNonce: 'nx', chatId: null, text: 'z'.repeat(300), anchorContent: 'no-task' }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].chatId).toBe('888')
    expect(s.sent[0].text.startsWith('(from background task) ')).toBe(true)
  })

  it('holds (does not drop) an unroutable envelope-less record for a later tick', async () => {
    writeOutboxRecordAtomic(rec({ turnNonce: 'held', chatId: null, anchorContent: 'no-task' }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(0)
    expect(listPendingRecords(dir)).toContain('held.json')
  })
})
