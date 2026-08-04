/**
 * #4348 — the Tier-1 cheap-cron bridge-register drain must route through the
 * shared `redeliverBufferedInbound` chokepoint so a delivered cron fire is
 * `spool.ack`'d exactly once and CANNOT re-fire after a restart.
 *
 * The bug: `onClientRegistered`'s `<agent>-cron` branch did a raw
 * `pendingInboundBuffer.drain()` + `client.send()` loop and returned early,
 * never reaching `spool.ack` (which lives only inside
 * `redeliverBufferedInbound`). A due cron tick spooled during the boot window
 * (before the cron bridge registered) stayed live in the durable spool, so
 * boot-replay re-pushed it on the next restart and the SAME fire was delivered
 * a second time — a duplicate cron delivery bounded only by the 15-min
 * escalation sweep.
 *
 * These tests assert the OUTCOME on the real drain seam
 * (`drainCronBridgeOnRegister`), against a REAL spool + buffer:
 *   1. the boot-window fire is delivered to the cron bridge, AND
 *   2. its durable spool entry is acked (liveCount → 0), AND
 *   3. a simulated restart's boot-replay finds nothing to re-push, so the fire
 *      does NOT re-fire.
 *
 * RED-before-GREEN: with the pre-#4348 raw-drain body the fire is delivered but
 * the spool entry stays live, so assertions (2)+(3) fail. With the fix routing
 * through `redeliverBufferedInbound` they pass.
 */

import { describe, it, expect } from 'vitest'
import {
  createInboundSpool,
  type InboundSpoolFsSeam,
  type InboundSpool,
} from '../gateway/inbound-spool.js'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer.js'
import { drainCronBridgeOnRegister, cronIdentity } from '../gateway/cron-session.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

const SPOOL_PATH = '/state/agent/telegram/inbound-spool.jsonl'

/** In-memory fake fs for the spool — models append + atomic-rename compaction.
 *  Shared across "restarts" so the durable JSONL survives, exactly like the
 *  persistent per-agent volume. */
function fakeFs(): InboundSpoolFsSeam {
  const files = new Map<string, string>()
  return {
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? '') + d),
    readFileSync: (p) => files.get(p) ?? '',
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (from, to) => {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    existsSync: (p) => files.has(p),
    statSizeSync: (p) => Buffer.byteLength(files.get(p) ?? ''),
    fsyncFileSync: () => {},
    fsyncDirSync: () => {},
  }
}

function cronFire(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'c1',
    messageId: 0, // synthetic — cron fires carry no Telegram messageId
    user: 'system',
    userId: 0,
    ts: 1000,
    text: 'Time for the daily digest',
    meta: { source: 'cron', session: 'cron' },
    ...over,
  } as InboundMessage
}

/** A capturing stand-in for the just-registered cron IPC client. */
function fakeClient(agentName: string): {
  agentName: string
  send: (msg: unknown) => void
  sent: unknown[]
} {
  const sent: unknown[] = []
  return { agentName, send: (m) => void sent.push(m), sent }
}

/** Simulate the gateway's boot-replay: re-push every live (un-acked) spool
 *  entry into a fresh in-memory buffer, exactly as gateway.ts does at boot. */
function bootReplayInto(spool: InboundSpool): ReturnType<typeof createPendingInboundBuffer> {
  const buffer = createPendingInboundBuffer({ log: () => {}, spool })
  for (const { agent, msg } of spool.liveEntries()) buffer.push(agent, msg)
  return buffer
}

describe('#4348 cron-bridge drain routes through the spool-ack chokepoint', () => {
  it('acks the boot-window cron fire and does not re-fire after restart', () => {
    const fs = fakeFs()
    const spool = createInboundSpool({ path: SPOOL_PATH, fs, log: () => {} })
    const cronAgent = cronIdentity('overlord') // "overlord-cron"

    // Boot window: a due cron tick arrives BEFORE the cron bridge registers.
    // It is buffered (in-memory) AND durably spooled by the same push.
    const buffer = createPendingInboundBuffer({ log: () => {}, spool })
    buffer.push(cronAgent, cronFire())
    expect(spool.liveCount()).toBe(1) // durably recorded, not yet delivered

    // The cron bridge registers → the drain seam under test runs.
    const client = fakeClient(cronAgent)
    const result = drainCronBridgeOnRegister(client, buffer, spool)

    // (1) The fire was delivered to the cron bridge.
    expect(result.drained).toBe(1)
    expect(result.redelivered).toBe(1)
    const deliveredFires = client.sent.filter(
      (m): m is InboundMessage => (m as InboundMessage).type === 'inbound',
    )
    expect(deliveredFires).toHaveLength(1)
    expect(deliveredFires[0]!.text).toBe('Time for the daily digest')

    // (2) The durable spool entry is tombstoned — the whole point of #4348.
    expect(spool.liveCount()).toBe(0)
    expect(spool.liveEntries()).toHaveLength(0)

    // (3) Simulated restart: boot-replay finds nothing to re-push, so the SAME
    //     fire does NOT re-fire. (Pre-fix this replayed the un-acked entry.)
    const afterRestart = bootReplayInto(spool)
    expect(afterRestart.drain(cronAgent)).toHaveLength(0)
  })

  it('a send failure re-buffers the fire and leaves the spool entry live (lossless)', () => {
    const fs = fakeFs()
    const spool = createInboundSpool({ path: SPOOL_PATH, fs, log: () => {} })
    const cronAgent = cronIdentity('overlord')

    const buffer = createPendingInboundBuffer({ log: () => {}, spool })
    buffer.push(cronAgent, cronFire())

    // Client whose send throws for inbound fires (bridge wedged mid-drain).
    const throwing = {
      agentName: cronAgent,
      send: (m: unknown) => {
        if ((m as InboundMessage).type === 'inbound') throw new Error('socket gone')
      },
    }
    const result = drainCronBridgeOnRegister(throwing, buffer, spool)

    // Not delivered → re-buffered, and the spool entry stays LIVE so the next
    // register (or boot-replay) retries it. Nothing is dropped, nothing acked.
    expect(result.redelivered).toBe(0)
    expect(result.rebuffered).toBe(1)
    expect(spool.liveCount()).toBe(1)
    expect(buffer.drain(cronAgent)).toHaveLength(1)
  })
})
