/**
 * A user-facing reply refused by an open Telegram flood window must be
 * DURABLY QUEUED and delivered when the window closes — never discarded
 * (#3857).
 *
 * ── The bug these tests guard ────────────────────────────────────────────
 * Reproduced live on 2026-07-28 during overlord's flood ban. The reply tool
 * returned:
 *
 *     reply failed after 0 of 1 chunk(s) sent: FLOOD_WAIT_ACTIVE
 *
 * and `/host-home/.switchroom/agents/overlord/telegram/outbox/` contained NO
 * record for it. `FLOOD_WAIT_ACTIVE` is a purely LOCAL pre-call fail-fast
 * (`retry-api-call.ts:198`, `:252`) that propagated to the caller as an error;
 * nothing enqueued the composed answer, so it was lost. The durable-outbox
 * work-loss guarantee held for the outbox-delivered paths and was FALSE for
 * the interactive reply path — during a 4.4h ban that means every answer the
 * agent wrote for the operator.
 *
 * The bar these tests meet (set by the audit, verbatim): "a test that opens a
 * flood window, issues a user-facing send, and asserts the content is durably
 * queued and delivered after the window closes — not merely that an error was
 * returned." `end-to-end` below does exactly that, driving the REAL
 * `sweepOutbox` with the REAL persisted breaker probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  queueFloodBlockedReply,
  isFloodRejection,
  floodRetryAfterSec,
  floodQueueNonce,
  FLOOD_QUEUED_SOURCE,
} from '../gateway/flood-reply-queue.js'
import { sweepOutbox } from '../gateway/outbox-sweep.js'
import { listPendingRecords, resolveOutboxDir, type OutboxRecord } from '../outbox.js'
import {
  floodStatePath,
  makeFloodWaitProbe,
  writeFloodState,
} from '../flood-circuit-breaker.js'
import { GrammyError } from 'grammy'

/** The exact error `retryApiCall` throws for an over-ceiling flood window. */
function floodWaitActiveError(retryAfterSec: number): Error {
  return Object.assign(new Error('FLOOD_WAIT_ACTIVE'), {
    retryAfterSec,
    untilTs: Date.now() + retryAfterSec * 1000,
    error_code: 429 as const,
    parameters: { retry_after: retryAfterSec },
  })
}

/** The reply path's own partial-failure wrapper around the marker. */
function wrappedReplyFailure(): Error {
  return new Error('reply failed after 0 of 1 chunk(s) sent: FLOOD_WAIT_ACTIVE')
}

function readRecords(dir: string): OutboxRecord[] {
  const outbox = resolveOutboxDir(dir)
  return readdirSync(outbox)
    .filter((f) => f.endsWith('.json') && f !== 'delivered.jsonl' && !f.startsWith('.'))
    .map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')) as OutboxRecord)
}

describe('isFloodRejection', () => {
  it('recognises every shape the flood rejection actually arrives in', () => {
    // The marker itself, as thrown by retryApiCall.
    expect(isFloodRejection(floodWaitActiveError(15908))).toBe(true)
    // The reply path's partial-failure wrapper — a plain Error whose message
    // merely CONTAINS the marker. This is the shape that reached the operator.
    expect(isFloodRejection(wrappedReplyFailure())).toBe(true)
    // A raw Telegram 429 that was never wrapped.
    expect(
      isFloodRejection(
        new GrammyError(
          'Call to sendMessage failed!',
          { ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } },
          'sendMessage',
          {},
        ),
      ),
    ).toBe(true)
    // A duck-typed 429 with no message at all.
    expect(isFloodRejection({ error_code: 429 })).toBe(true)
  })

  it('does NOT swallow non-flood failures — those must still throw', () => {
    expect(isFloodRejection(new Error('THREAD_NOT_FOUND'))).toBe(false)
    expect(isFloodRejection(new Error('message is not modified'))).toBe(false)
    expect(isFloodRejection(new Error('retryApiCall: max retries exceeded'))).toBe(false)
    expect(isFloodRejection(new Error('ENOSPC: no space left on device'))).toBe(false)
    expect(isFloodRejection(null)).toBe(false)
    expect(isFloodRejection(undefined)).toBe(false)
  })
})

describe('floodRetryAfterSec', () => {
  it('reads the magnitude off the marker and off a raw 429 description', () => {
    expect(floodRetryAfterSec(floodWaitActiveError(15908))).toBe(15908)
    expect(floodRetryAfterSec(new Error('Too Many Requests: retry after 3'))).toBe(3)
    expect(floodRetryAfterSec(new Error('THREAD_NOT_FOUND'))).toBeNull()
  })
})

describe('queueFloodBlockedReply', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-reply-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the undelivered answer to the durable outbox', () => {
    const text = 'the answer the operator is waiting for'
    const res = queueFloodBlockedReply({
      err: floodWaitActiveError(15908),
      chatId: '12345',
      threadId: null,
      text,
      priorityClass: 'critical',
      stateDir: dir,
    })

    expect(res).not.toBeNull()
    const records = readRecords(dir)
    expect(records).toHaveLength(1)
    // THE outcome: the content is on disk, verbatim.
    expect(records[0]!.text).toBe(text)
    expect(records[0]!.chatId).toBe('12345')
    expect(records[0]!.source).toBe(FLOOD_QUEUED_SOURCE)
    // And the caller is told it is queued, not delivered, and told not to resend.
    expect(res!.notice).toMatch(/QUEUED/)
    expect(res!.notice).toMatch(/not yet visible/i)
    expect(res!.notice).toMatch(/Do NOT resend/i)
    expect(res!.retryAfterSec).toBe(15908)
  })

  it('queues the wrapped `reply failed after 0 of 1 chunk(s) sent` error too', () => {
    const res = queueFloodBlockedReply({
      err: wrappedReplyFailure(),
      chatId: '111',
      threadId: null,
      text: 'answer',
      priorityClass: 'critical',
      stateDir: dir,
    })
    expect(res).not.toBeNull()
    expect(readRecords(dir)).toHaveLength(1)
  })

  it('does NOT queue a cosmetic frame — a stale card edit must not land hours later', () => {
    const res = queueFloodBlockedReply({
      err: floodWaitActiveError(15908),
      chatId: '111',
      threadId: null,
      text: '⏳ working… 42s',
      priorityClass: 'cosmetic',
      stateDir: dir,
    })
    expect(res).toBeNull()
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('queues `useful` and untagged sends (only cosmetic is droppable)', () => {
    expect(
      queueFloodBlockedReply({
        err: floodWaitActiveError(60),
        chatId: '111',
        threadId: null,
        text: 'a worker handback',
        priorityClass: 'useful',
        stateDir: dir,
      }),
    ).not.toBeNull()
    expect(
      queueFloodBlockedReply({
        err: floodWaitActiveError(60),
        chatId: '111',
        threadId: null,
        text: 'an untagged send',
        stateDir: dir,
      }),
    ).not.toBeNull()
    expect(readRecords(dir)).toHaveLength(2)
  })

  it('returns null for a non-flood failure so the caller still throws', () => {
    const res = queueFloodBlockedReply({
      err: new Error('THREAD_NOT_FOUND'),
      chatId: '111',
      threadId: null,
      text: 'answer',
      priorityClass: 'critical',
      stateDir: dir,
    })
    expect(res).toBeNull()
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('returns null (caller throws) when the disk write fails — never a false "queued"', () => {
    const res = queueFloodBlockedReply({
      err: floodWaitActiveError(60),
      chatId: '111',
      threadId: null,
      text: 'answer',
      priorityClass: 'critical',
      stateDir: dir,
      write: () => false,
    })
    expect(res).toBeNull()
  })

  it('is idempotent under caller retry — same content queues exactly one record', () => {
    const args = {
      err: floodWaitActiveError(15908),
      chatId: '111',
      threadId: null,
      text: 'the same answer, recomposed',
      priorityClass: 'critical' as const,
      stateDir: dir,
    }
    const a = queueFloodBlockedReply(args)
    const b = queueFloodBlockedReply(args)
    expect(a!.turnNonce).toBe(b!.turnNonce)
    expect(readRecords(dir)).toHaveLength(1)
  })

  it('derives a nonce from CONTENT, not the turn — a second answer in the same turn queues separately', () => {
    // Why this matters: keying on `turn.turnId` would make a flood-blocked
    // answer `skip-journaled` (silently dropped) whenever an earlier reply in
    // the same turn had already journaled that nonce as delivered.
    expect(floodQueueNonce('111', null, 'a')).not.toBe(floodQueueNonce('111', null, 'b'))
    expect(floodQueueNonce('111', null, 'a')).not.toBe(floodQueueNonce('222', null, 'a'))
    expect(floodQueueNonce('111', 7, 'a')).not.toBe(floodQueueNonce('111', null, 'a'))
    expect(floodQueueNonce('111', null, 'a')).toBe(floodQueueNonce('111', null, 'a'))
  })
})

describe('end-to-end: queued during the window, delivered after it closes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-e2e-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives an open window and lands verbatim once the window closes', async () => {
    const answer = 'Yes — the deploy is green; here is the full breakdown the operator asked for.'
    const t0 = 1_000_000

    // 1. OPEN a real flood window in the real persisted breaker state.
    writeFloodState(
      floodStatePath(dir),
      { untilTs: t0 + 15_908_000, retryAfterSec: 15908, recordedTs: t0 },
      () => {},
    )
    const probe = makeFloodWaitProbe(floodStatePath(dir), () => t0)

    // 2. The user-facing send is refused by that window.
    const queued = queueFloodBlockedReply({
      err: floodWaitActiveError(15908),
      chatId: '12345',
      threadId: null,
      text: answer,
      priorityClass: 'critical',
      stateDir: dir,
      createdAt: t0,
    })
    expect(queued).not.toBeNull()

    // 3. It is DURABLY queued (this is what was missing on 2026-07-28).
    expect(readRecords(dir).map((r) => r.text)).toEqual([answer])

    // 4. Sweeping WHILE the window is open must not touch the wire, and must
    //    not lose the record.
    const send = vi.fn(async () => 4242)
    const during = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: probe,
      now: () => t0 + 60_000,
    })
    expect(during.floodDeferred).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(listPendingRecords(dir)).toHaveLength(1)

    // 5. The window CLOSES.
    const after = t0 + 15_909_000
    const openProbe = makeFloodWaitProbe(floodStatePath(dir), () => after)
    expect(openProbe()).toBe(0)

    const closed = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: openProbe,
      now: () => after,
    })

    // 6. THE outcome: the operator receives the answer. (Prefixed "(delayed)"
    //    because it is older than OUTBOX_MAX_AGE_MS — delayed, never dropped.)
    expect(closed.delivered).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    const [chatId, threadId, delivered] = send.mock.calls[0]! as unknown as [string, number | null, string]
    expect(chatId).toBe('12345')
    expect(threadId).toBeNull()
    expect(delivered).toContain(answer)

    // 7. And nothing is left behind to re-send on the next tick.
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('does not double-deliver when the caller retries after the window closed', async () => {
    const answer = 'the one answer'
    const t0 = 1_000_000
    queueFloodBlockedReply({
      err: floodWaitActiveError(30),
      chatId: '111',
      threadId: null,
      text: answer,
      priorityClass: 'critical',
      stateDir: dir,
      createdAt: t0,
    })

    const send = vi.fn(async () => 1)
    await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      now: () => t0 + 10_000,
    })
    expect(send).toHaveBeenCalledTimes(1)

    // The model retries the same reply; it is re-queued under the same
    // content nonce, which the delivered-keys journal already holds.
    queueFloodBlockedReply({
      err: floodWaitActiveError(30),
      chatId: '111',
      threadId: null,
      text: answer,
      priorityClass: 'critical',
      stateDir: dir,
      createdAt: t0 + 20_000,
    })
    await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      now: () => t0 + 40_000,
    })

    // THE outcome: still exactly one delivery, and the duplicate record is gone.
    expect(send).toHaveBeenCalledTimes(1)
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('delivers a backlog in CAPTURE order, not filesystem order', async () => {
    const t0 = 1_000_000
    // Contents chosen so their content-hash nonces do NOT sort in capture
    // order — readdir order on a hashed filesystem is effectively nonce order,
    // which is what the pre-fix sweep followed.
    const parts = ['first thing I said', 'second thing I said', 'third thing I said']
    parts.forEach((text, i) => {
      queueFloodBlockedReply({
        err: floodWaitActiveError(300),
        chatId: '111',
        threadId: null,
        text,
        priorityClass: 'critical',
        stateDir: dir,
        createdAt: t0 + i * 1000,
      })
    })

    const send = vi.fn(async () => 1)
    await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      now: () => t0 + 60_000,
    })

    expect(send.mock.calls.map((c) => c[2])).toEqual(parts)
  })
})

describe('the reply path is actually wired to the queue', () => {
  it("sendReply's chunk-loop catch queues before it throws", async () => {
    // A source-level guard, deliberately: `sendReply` takes ~50 injected
    // gateway deps and is not constructible in a unit test, so without this
    // the wiring — the one line that makes all of the above reach production —
    // would be unguarded. #3849 shipped exactly that failure mode: a complete
    // choke point claimed while one call site sat unwired.
    const src = readFileSync(
      new URL('../gateway/outbound-send-path.ts', import.meta.url),
      'utf8',
    )
    const catchIdx = src.indexOf('reply failed after ${sentIds.length} of ${chunks.length}')
    expect(catchIdx).toBeGreaterThan(0)
    const block = src.slice(Math.max(0, catchIdx - 2500), catchIdx)
    expect(block).toContain('queueFloodBlockedReply({')
    // ...and the queued branch returns instead of falling through to the throw.
    expect(block).toMatch(/if \(queued != null\) \{/)
    expect(block).toContain('queued.notice')
    // ...and discharges the obligation, so the tracker stops re-prompting for
    // a reply that is already durably queued.
    expect(block).toContain('closeObligationOnSubstantiveReply(')
  })
})
