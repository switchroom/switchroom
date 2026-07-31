/**
 * outbox-flush-ack-claim-race.test.ts — outcome regression for the turn-flush
 * vs outbox-sweep DUPLICATE-MESSAGE race.
 *
 * The race (root-caused via journal forensics):
 *   1. A gateway-visible turn ends with unsent trailing prose → the turn-flush
 *      backstop delivers it through `runBackstopDelivery` (the flush core). The
 *      chunks land (Telegram acks) immediately.
 *   2. The flush's DURABLE exactly-once claim (`journalExternalDelivery`,
 *      `deliverySource:'flush'`) used to run only in the caller's
 *      post-`await deliverAnswer` bookkeeping — i.e. AFTER `runBackstopDelivery`
 *      returned. But `runBackstopDelivery` does not return until its read-back
 *      probe resolves, and that probe is issued at COSMETIC priority: when the
 *      edit-flood-fuse is deferring cosmetic edits it blocks ~30s.
 *   3. The out-of-band outbox sweep waits only `OUTBOX_QUIET_MS` (5s) before
 *      checking the delivered-keys journal. In the 5–30s gap it saw no journal
 *      entry (deferred behind the probe) and — because the Stop-hook-captured
 *      record's text differs in length/hash from the flush text, so the in-memory
 *      text dedup also misses — it sent a SECOND copy of the same answer.
 *
 * The fix claims the nonce at SEND-ACK time (`onAckClaim`), BEFORE the read-back
 * probe. This test drives the REAL `runBackstopDelivery` with a read-back probe
 * held open PAST the sweep's quiet window, plus a pending outbox record for the
 * SAME nonce with DIFFERENT text, and asserts the REAL `sweepOutbox` delivers
 * NOTHING. It is RED on pre-fix main (no ack-time claim → the journal is empty
 * when the sweep ticks → the sweep sends the duplicate).
 *
 * The oracle is what the user observably received (sweep `send` invocations) and
 * the durable journal — no assertion names an internal decision function.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BackstopDeliveryLedger,
  runBackstopDelivery,
  type ReadBackResult,
} from '../gateway/backstop-delivery.js'
import { sweepOutbox, journalExternalDelivery } from '../gateway/outbox-sweep.js'
import {
  OUTBOX_QUIET_MS,
  readDeliveredNonces,
  sha256Hex,
  writeOutboxRecordAtomic,
  type OutboxRecord,
} from '../outbox.js'

const CHAT = '111'
/** Gateway `deriveTurnId` shape — byte-identical to the Stop-hook record nonce. */
const NONCE = `${CHAT}:_#42`
/** The flush's answer (RICH). */
const FLUSH_TEXT = 'The deploy is green across all three checks. '.padEnd(320, 'a')
/** The Stop-hook-captured record for the SAME turn — a paraphrase, so its length
 *  and sha differ from the flush text and the in-memory text dedup CANNOT match. */
const RECORD_TEXT =
  'Summary of the above in different words so byte-exact dedup can never catch it. '.padEnd(
    420,
    'b',
  )

/** A pending outbox record, aged PAST the sweep quiet window so it is eligible. */
function writeAgedRecord(dir: string, createdAt: number): void {
  const record: OutboxRecord = {
    turnNonce: NONCE,
    chatId: CHAT,
    threadId: null,
    text: RECORD_TEXT,
    textSha256: sha256Hex(RECORD_TEXT),
    createdAt,
    source: 'channel',
    replyAlreadyDeliveredThisTurn: false,
  }
  const ok = writeOutboxRecordAtomic(record, dir)
  expect(ok).toBe(true)
}

describe('turn-flush vs outbox-sweep — the flush claims its nonce at SEND-ACK, before a slow read-back', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flush-ack-race-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a read-back slower than OUTBOX_QUIET_MS + a same-nonce/different-text record ⇒ the sweep sends NOTHING (exactly-once)', async () => {
    const now = 10_000_000
    // The captured record was written well before the quiet window elapsed.
    writeAgedRecord(dir, now - (OUTBOX_QUIET_MS + 5_000))

    // Read-back gate — held OPEN so runBackstopDelivery cannot return until we
    // release it, simulating the cosmetic-edit flood-fuse deferring the probe
    // ~30s (far longer than the sweep's 5s quiet window).
    let releaseReadBack!: () => void
    const readBackGate = new Promise<void>((resolve) => {
      releaseReadBack = resolve
    })

    const ledger = new BackstopDeliveryLedger()
    ledger.claim(NONCE)

    const sentChunks: string[] = []
    const flushPromise = runBackstopDelivery(
      ledger,
      NONCE,
      [FLUSH_TEXT],
      null,
      {
        sendChunk: async (_i, text) => {
          sentChunks.push(text)
          return [777] // Telegram acked — a fresh non-card chat id.
        },
        // Mirrors the real deliverAnswer read-back: paced cosmetic, deferrable.
        readBack: async (): Promise<ReadBackResult> => {
          await readBackGate
          return 'exists'
        },
        // The fix: journal the nonce at ack, BEFORE the read-back above resolves.
        onAckClaim: (ackIds) => {
          journalExternalDelivery(
            {
              turnNonce: NONCE,
              text: FLUSH_TEXT,
              tgMessageId: ackIds[0],
              deliverySource: 'flush',
            },
            dir,
          )
        },
      },
      3,
    )

    // Let the send loop run its send + (with the fix) the ack claim, then park
    // on the still-open read-back probe. Bounded macrotask flushes — no timers,
    // no dependence on the fix, so a missing claim surfaces as a clean assertion
    // failure below rather than a hang.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    expect(sentChunks).toEqual([FLUSH_TEXT])
    // Durable claim landed at ack-time — WHILE the read-back is still open.
    expect(readDeliveredNonces(dir).has(NONCE)).toBe(true)

    // Now the sweep ticks, past the quiet window, with the text dedup MISSING
    // (record text ≠ flush text). Its only exactly-once guard is the journal.
    const swept: string[] = []
    const summary = await sweepOutbox({
      stateDir: dir,
      now: () => now,
      send: async (_chatId, _threadId, text) => {
        swept.push(text)
        return { messageId: 500, chunks: [{ messageId: 500, text }] }
      },
      // The exact-text in-memory dedup cannot help — the texts differ.
      textAlreadyDelivered: () => false,
    })

    // THE user outcome: the sweep sent nothing — the flush already owns this turn.
    expect(swept).toEqual([])
    expect(summary.delivered).toBe(0)

    // Release the (slow) read-back and let the flush finish cleanly.
    releaseReadBack()
    const result = await flushPromise
    expect(result.delivered).toBe(true)
  })

  it('no-loss guard: a flush whose send never acks does NOT claim, so the sweep still delivers the captured answer once', async () => {
    const now = 20_000_000
    writeAgedRecord(dir, now - (OUTBOX_QUIET_MS + 5_000))

    const ledger = new BackstopDeliveryLedger()
    ledger.claim(NONCE)

    let ackClaimCount = 0
    const result = await runBackstopDelivery(
      ledger,
      NONCE,
      [FLUSH_TEXT],
      null,
      {
        // Every attempt throws — the answer never lands, so the claim predicate
        // (all chunks landed + fresh receipt) is never met.
        sendChunk: async () => {
          throw new Error('telegram send rejected')
        },
        readBack: async (): Promise<ReadBackResult> => 'exists',
        onAckClaim: () => {
          ackClaimCount++
        },
      },
      3,
    )
    // The flush genuinely failed and never claimed the nonce.
    expect(result.delivered).toBe(false)
    expect(ackClaimCount).toBe(0)
    expect(readDeliveredNonces(dir).has(NONCE)).toBe(false)

    // The safety net now delivers the captured answer — exactly once, no loss.
    const swept: string[] = []
    const summary = await sweepOutbox({
      stateDir: dir,
      now: () => now,
      send: async (_chatId, _threadId, text) => {
        swept.push(text)
        return { messageId: 501, chunks: [{ messageId: 501, text }] }
      },
      textAlreadyDelivered: () => false,
    })
    expect(swept).toEqual([RECORD_TEXT])
    expect(summary.delivered).toBe(1)
  })
})
