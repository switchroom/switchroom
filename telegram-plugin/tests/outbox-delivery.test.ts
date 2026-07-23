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
import { readFileSync } from 'node:fs'
import {
  decideOutboxSweep,
  deriveTurnNonce,
  resolveOutboxChat,
  writeOutboxRecordAtomic,
  readDeliveredNonces,
  listPendingRecords,
  appendDelivered,
  resolveOutboxDir,
  JOURNAL_ROTATE_AT,
  JOURNAL_KEEP,
  sha256Hex,
  type OutboxRecord,
  OUTBOX_MAX_AGE_MS,
} from '../outbox.js'
import { deriveTurnNonce as deriveTurnNonceMjs } from '../hooks/silent-end-scan.mjs'
import { sweepOutbox, journalExternalDelivery } from '../gateway/outbox-sweep.js'
import { shouldJournalReplySiteDelivery } from '../final-answer-detect.js'

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

describe('resolveOutboxChat (H3/F2)', () => {
  it('routes via the anchor envelope when chatId is present', () => {
    const r = resolveOutboxChat(rec({ chatId: '111', threadId: 5 }), {})
    expect(r).toEqual({ chatId: '111', threadId: 5, via: 'anchor' })
  })
  it('routes an envelope-less record via the transitive registry chain (preferred over origin)', () => {
    const r = resolveOutboxChat({ chatId: null, threadId: null, anchorContent: '<task-id>T1</task-id>', originChatId: 'WRONG', originThreadId: null }, {
      registryChainLookup: (c) => (c.includes('T1') ? { chatId: '222', threadId: 9 } : null),
    })
    expect(r).toEqual({ chatId: '222', threadId: 9, via: 'registry' })
  })
  it('falls back to the record OWN per-session origin when the chain does not resolve', () => {
    const r = resolveOutboxChat({ chatId: null, threadId: null, anchorContent: 'no-task-id-here', originChatId: '333', originThreadId: 4 }, {
      registryChainLookup: () => null,
    })
    expect(r).toEqual({ chatId: '333', threadId: 4, via: 'origin' })
  })
  it('FAILS CLOSED (null) when neither the chain nor a stamped origin resolves — never a global fallback', () => {
    expect(resolveOutboxChat({ chatId: null, threadId: null, anchorContent: 'no-task', originChatId: null, originThreadId: null }, { registryChainLookup: () => null })).toBeNull()
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

  it('F1: on a text-dedup hit, journals the nonce AND deletes the record so it cannot re-fire', async () => {
    // The legacy flush delivered this turn's text; the in-memory dedup reports a
    // hit on the first eligible sweep. The record must be journaled + removed —
    // NOT left pending (the pre-fix bug), which re-sent once the 60s TTL evicted.
    writeOutboxRecordAtomic(rec({ turnNonce: 'n1', text: 'dup', createdAt: 0 }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => true, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(0)
    expect(readDeliveredNonces(dir).has('n1')).toBe(true)
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('F1: NO second send after the in-memory dedup TTL evicts and the gateway restarts', async () => {
    // Simulate the exact review failure: flush delivers (+0.5s), sweep at +5s
    // hits the dedup and settles the record. Then the process "restarts" (fresh
    // deps, in-memory dedup CLEARED → reports false) and the sweep runs again at
    // +65s. With the pre-fix code the record was still pending and re-sent here.
    writeOutboxRecordAtomic(rec({ turnNonce: 'n1', text: 'dup', createdAt: 0 }), dir)
    const s1 = sink()
    await sweepOutbox({ ...s1, textAlreadyDelivered: () => true, stateDir: dir, now: () => 5_000 })
    expect(s1.sent).toHaveLength(0)
    // Restart: brand-new sink + a dedup that no longer remembers the text.
    const s2 = sink()
    await sweepOutbox({ ...s2, textAlreadyDelivered: () => false, stateDir: dir, now: () => 65_000 })
    expect(s2.sent).toHaveLength(0) // journal (durable) suppresses — no double-post
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('F3: a PINGING interim ack does NOT poison the turn nonce — the real answer is still delivered exactly once', async () => {
    // The exact F3 loss scenario, end-to-end through the production reply-site
    // journal gate (`shouldJournalReplySiteDelivery`) + the sweep:
    //   1. DM inbound → turn nonce N.
    //   2. Model calls reply("On it — digging in") WITHOUT disable_notification
    //      (a PINGING interim ack — the tool's default; models routinely omit
    //      the flag). `isFinalAnswerReply` would classify this "final" (ping
    //      clause), so the pre-fix reply site journaled N here.
    //   3. Model ends the turn with gateway-invisible trailing prose (the real
    //      answer) → the Stop hook captures it as a pending outbox record under
    //      the SAME nonce N.
    //   4. The sweep must DELIVER the real answer.
    // Pre-fix (gate === isFinalAnswerReply) the ack journaled N → the sweep hits
    // skip-journaled → clearOutboxRecord → 0 sent → the real answer is silently
    // destroyed (RED). Post-fix (gate === isSubstantiveFinalReply) the pinging
    // ack does NOT journal → the sweep delivers the real answer exactly once.
    const nonce = deriveTurnNonce({ chatId: '8', threadId: null, messageId: '5', anchorTimestampMs: 1, anchorContent: 'c' })
    const pingingAck = { text: 'On it — digging in', disableNotification: false }
    // Model the reply site EXACTLY: journal via journalExternalDelivery iff the
    // production gate says to (same call shape as outbound-send-path.ts sendReply).
    if (shouldJournalReplySiteDelivery(pingingAck)) {
      journalExternalDelivery({ turnNonce: nonce, text: pingingAck.text }, dir)
    }
    // The Stop hook captured the real (undelivered) answer under the same nonce.
    const realAnswer = 'The root cause is a race in the flush path — here is the full write-up. '.repeat(4)
    writeOutboxRecordAtomic(rec({ turnNonce: nonce, chatId: '8', text: realAnswer, createdAt: 0 }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].text).toBe(realAnswer)
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('F3: a SUBSTANTIVE final reply STILL journals so the sweep does not double-post the same answer', async () => {
    // The counterpart guard — the fix must not reopen F1. A genuine substantive
    // answer delivered at the reply site journals the nonce, so a captured
    // record for the same turn is suppressed (no duplicate).
    const nonce = deriveTurnNonce({ chatId: '8', threadId: null, messageId: '6', anchorTimestampMs: 1, anchorContent: 'c' })
    const realReply = { text: 'x'.repeat(300), disableNotification: false }
    expect(shouldJournalReplySiteDelivery(realReply)).toBe(true)
    if (shouldJournalReplySiteDelivery(realReply)) {
      journalExternalDelivery({ turnNonce: nonce, text: realReply.text }, dir)
    }
    writeOutboxRecordAtomic(rec({ turnNonce: nonce, chatId: '8', text: realReply.text, createdAt: 0 }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(0) // journaled → sweep suppresses → no double-post
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('routes an envelope-less record through its OWN per-session origin with a prefix', async () => {
    writeOutboxRecordAtomic({ ...rec({ turnNonce: 'nx', chatId: null, text: 'z'.repeat(300), anchorContent: 'no-task' }), originChatId: '888', originThreadId: null }, dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].chatId).toBe('888')
    expect(s.sent[0].text.startsWith('(from background task) ')).toBe(true)
  })

  it('F2: a DM-origin handback whose registry chain fails does NOT deliver to a different (group) chat', async () => {
    // Record stamped with the DM origin (777). A group chat (999) is the most
    // recent gateway inbound — but the sweep has NO global last-inbound fallback,
    // so it must route to the DM origin, never the group.
    writeOutboxRecordAtomic({ ...rec({ turnNonce: 'dm', chatId: null, text: 'private answer '.repeat(20), anchorContent: '<task-id>MISS</task-id>' }), originChatId: '777', originThreadId: null }, dir)
    const s = sink()
    await sweepOutbox({
      ...s,
      textAlreadyDelivered: () => false,
      registryChainLookup: () => null, // chain fails
      stateDir: dir,
      now: () => 10_000,
    })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].chatId).toBe('777') // DM origin, NOT any group
  })

  it('F2: an envelope-less handback with NO stamped origin and a failed chain FAILS CLOSED (held, not misrouted)', async () => {
    writeOutboxRecordAtomic(rec({ turnNonce: 'held', chatId: null, anchorContent: 'no-task' }), dir)
    const s = sink()
    await sweepOutbox({ ...s, textAlreadyDelivered: () => false, registryChainLookup: () => null, stateDir: dir, now: () => 10_000 })
    expect(s.sent).toHaveLength(0)
    expect(listPendingRecords(dir)).toContain('held.json')
  })

  it('S5: the delivered-keys journal is compacted once it exceeds the rotate threshold (bounded growth)', () => {
    for (let i = 0; i < JOURNAL_ROTATE_AT + 5; i++) {
      appendDelivered({ turnNonce: `k${i}`, textSha256: 'h', ts: i }, dir)
    }
    const lines = readFileSync(join(resolveOutboxDir(dir), 'delivered.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    // Bounded: compaction keeps the file under the rotate threshold rather than
    // growing without limit (it drops to ~JOURNAL_KEEP each time it trips).
    expect(lines.length).toBeLessThanOrEqual(JOURNAL_ROTATE_AT)
    expect(lines.length).toBeLessThan(JOURNAL_KEEP + 100)
    // The most-recent nonces survive compaction (still suppress a re-send).
    expect(readDeliveredNonces(dir).has(`k${JOURNAL_ROTATE_AT + 4}`)).toBe(true)
  })
})
