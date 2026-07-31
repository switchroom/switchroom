/**
 * The outbox sweep must not hammer a flood ban it can already see (#3853).
 *
 * ── The bug these tests guard ────────────────────────────────────────────
 * `startOutboxSweep` built its retry policy as `createRetryApiCall({ log })` —
 * the ONE wiring in the tree with neither `floodWaitRemainingMs` (read the
 * persisted breaker) nor `onFloodWait` (write to it). Combined with a fixed
 * 5s tick and a catch that released the claim with no backoff, the sweep
 * re-issued a single undeliverable `sendMessage` every 5 seconds for the whole
 * of overlord's 15908s (4.4h) ban on 2026-07-27: 228 requests into a window
 * the breaker had recorded and could have answered in one read.
 *
 * The gateway log is the proof and the shape of the outcome assertion:
 *   grep -c 'flood window still open' gateway-supervisor.log  → 0
 *   grep -c 'flood ban of'            gateway-supervisor.log  → 230
 *   grep -c 'outbox-sweep: send failed'                       → 228
 *
 * Every test below asserts an OUTCOME — whether the wire was touched and
 * whether the record survived — not that a code path executed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeOutboxRecordAtomic,
  listPendingRecords,
  sha256Hex,
  type OutboxRecord,
} from '../outbox.js'
import {
  sweepOutbox,
  createSweepBackoff,
  OUTBOX_SWEEP_INTERVAL_MS,
  OUTBOX_SWEEP_BACKOFF_MAX_MS,
} from '../gateway/outbox-sweep.js'

function rec(over: Partial<OutboxRecord> = {}): OutboxRecord {
  const text = over.text ?? 'the answer the operator is waiting for'
  return {
    turnNonce: over.turnNonce ?? 'nonce-1',
    chatId: over.chatId ?? '111',
    threadId: over.threadId ?? null,
    text,
    textSha256: sha256Hex(text),
    createdAt: over.createdAt ?? 0,
    source: over.source ?? 'channel',
  }
}

describe('outbox sweep vs an open flood window', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-flood-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not hit the wire while a flood window is open, and keeps the record', async () => {
    writeOutboxRecordAtomic(rec(), dir)
    const send = vi.fn(async () => ({ messageId: 1, chunks: [{ messageId: 1, text: rec().text }] }))
    const log = vi.fn()

    const summary = await sweepOutbox({
      stateDir: dir,
      log,
      send,
      textAlreadyDelivered: () => false,
      // 12247s remaining — the exact shape of the window the 2026-07-27 sweep
      // ignored 228 times.
      floodWaitRemainingMs: () => 12_247_000,
      now: () => 10 * 60_000,
    })

    // THE outcome: nothing reached Telegram.
    expect(send).not.toHaveBeenCalled()
    expect(summary.floodDeferred).toBe(true)
    expect(summary.floodRemainingMs).toBe(12_247_000)
    expect(summary.delivered).toBe(0)
    // And nothing was lost — the record is still pending for the next sweep.
    expect(listPendingRecords(dir)).toHaveLength(1)
    // The deferral is NOT logged per-tick — a 4.4h ban is ~3181 ticks, and one
    // line each would relocate the flood from the wire to the disk. The tick
    // loop reports it at most once per OUTBOX_SWEEP_DEFER_LOG_INTERVAL_MS.
    expect(log).not.toHaveBeenCalled()
  })

  it('delivers the SAME record once the window closes', async () => {
    writeOutboxRecordAtomic(rec(), dir)
    const send = vi.fn(async () => ({ messageId: 42, chunks: [{ messageId: 42, text: rec().text }] }))
    let remaining = 12_247_000

    const deferred = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: () => remaining,
      now: () => 10 * 60_000,
    })
    expect(deferred.floodDeferred).toBe(true)
    expect(send).not.toHaveBeenCalled()

    remaining = 0
    const after = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: () => remaining,
      now: () => 20 * 60_000,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[2]).toContain('the answer the operator is waiting for')
    expect(after.delivered).toBe(1)
    expect(listPendingRecords(dir)).toHaveLength(0)
  })

  it('sweeps normally when no window is open', async () => {
    writeOutboxRecordAtomic(rec(), dir)
    const send = vi.fn(async () => ({ messageId: 7, chunks: [{ messageId: 7, text: rec().text }] }))
    const summary = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: () => 0,
      now: () => 10 * 60_000,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(summary.delivered).toBe(1)
    expect(summary.floodDeferred).toBeUndefined()
  })

  it('FAILS OPEN: a throwing probe must never strand the outbox', async () => {
    writeOutboxRecordAtomic(rec(), dir)
    const send = vi.fn(async () => ({ messageId: 7, chunks: [{ messageId: 7, text: rec().text }] }))
    const summary = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: () => {
        throw new Error('EACCES: flood-wait.json owned by another uid')
      },
      now: () => 10 * 60_000,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(summary.delivered).toBe(1)
  })

  it('reports send failures so the tick can back off', async () => {
    writeOutboxRecordAtomic(rec(), dir)
    const send = vi.fn(async () => {
      throw new Error('FLOOD_WAIT_ACTIVE')
    })
    const summary = await sweepOutbox({
      stateDir: dir,
      send,
      textAlreadyDelivered: () => false,
      floodWaitRemainingMs: () => 0,
      now: () => 10 * 60_000,
    })
    expect(summary.sendFailures).toBe(1)
    expect(summary.delivered).toBe(0)
    // Claim released — the record is still pending, never lost.
    expect(listPendingRecords(dir)).toHaveLength(1)
  })
})

describe('createSweepBackoff — the fixed-5s-forever regression', () => {
  it('rides the normal tick on the FIRST failure, then doubles', () => {
    const b = createSweepBackoff()
    expect(b.ready(0)).toBe(true)

    expect(b.noteFailure(0)).toBe(OUTBOX_SWEEP_INTERVAL_MS) // 5s
    expect(b.ready(4_999)).toBe(false)
    expect(b.ready(5_000)).toBe(true)

    expect(b.noteFailure(5_000)).toBe(10_000)
    expect(b.noteFailure(15_000)).toBe(20_000)
    expect(b.noteFailure(35_000)).toBe(40_000)
  })

  it('caps the delay so the sweep never stops entirely', () => {
    const b = createSweepBackoff()
    let last = 0
    for (let i = 0; i < 40; i++) last = b.noteFailure(i * 1_000_000)
    expect(last).toBe(OUTBOX_SWEEP_BACKOFF_MAX_MS)
  })

  it('the 4.4h-ban scenario: ≤ 60 sweeps, not 228', () => {
    // Replay the incident's shape — a persistently failing send across a
    // 15908s window — and count how many sweeps the pacer would permit.
    const b = createSweepBackoff()
    const banMs = 15_908_000
    let now = 0
    let sweeps = 0
    while (now < banMs) {
      if (b.ready(now)) {
        sweeps++
        b.noteFailure(now)
      }
      now += OUTBOX_SWEEP_INTERVAL_MS
    }
    // Fixed 5s ticking would be 3181 attempts; the real sweep issued 228
    // before the operator intervened. Exponential + cap keeps it under 60.
    expect(sweeps).toBeLessThan(60)
    expect(sweeps).toBeGreaterThan(0)
  })

  it('a successful sweep clears the backoff', () => {
    const b = createSweepBackoff()
    b.noteFailure(0)
    b.noteFailure(5_000)
    expect(b.ready(6_000)).toBe(false)
    b.noteSuccess()
    expect(b.ready(6_000)).toBe(true)
    expect(b.failures()).toBe(0)
  })
})
