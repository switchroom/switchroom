/**
 * Per-agent buffer for synthetic inbounds the gateway couldn't deliver
 * because no live IPC client was registered for the agent at send-time.
 *
 * Background: `ipcServer.sendToAgent(agent, msg)` returns `false` when
 * the agent's bridge isn't connected. Before this buffer existed, the
 * gateway logged the failure and dropped the message — root cause of
 * issue #1150 (operator taps Approve on a vault_request_access card,
 * grant lands, but the `vault_grant_approved` inbound that wakes the
 * agent never arrives if the bridge happens to be reconnecting in
 * that exact 100ms window).
 *
 * Contract:
 *   - `push(agent, msg)` is best-effort and synchronous. Bounded:
 *     a slow / dead bridge can't fill memory.
 *   - `drain(agent)` returns ALL pending messages for `agent` in
 *     insertion order and removes them from the buffer. Called from
 *     `onClientRegistered` so a fresh bridge picks up the missed
 *     wake-ups before doing anything else.
 *   - In-memory only. Survives across IPC disconnect/reconnect within
 *     a single gateway-process lifetime, but NOT a gateway restart.
 *     A gateway crash mid-buffer means lost wake-ups; the silence-
 *     poke ladder catches this downstream so the worst-case is a
 *     5-minute delay, not a permanent stall.
 *
 * Per-agent cap prevents a never-reconnecting bridge from leaking
 * unbounded memory. When the cap is hit, the OLDEST entry is dropped
 * — the assumption is the freshest wake-up is the most relevant. A
 * dropped entry is logged via the provided logger.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Default cap per agent. Tuned for `should fit a reasonable backlog of
 *  approval cards stacked while bridge is offline` but no more. */
export const DEFAULT_PENDING_INBOUND_CAP = 32

export interface PendingInboundBuffer {
  /** Append `msg` to `agent`'s queue. Returns true if accepted, false if
   *  the cap forced an eviction (the message is STILL accepted; `false`
   *  signals "tail dropped to make room"). */
  push: (agent: string, msg: InboundMessage) => boolean
  /** Pop and return all pending messages for `agent`. Empty array when
   *  none. Idempotent. */
  drain: (agent: string) => InboundMessage[]
  /** Test-only: current depth for `agent`. */
  depth: (agent: string) => number
  /** Test-only: total depth across all agents. */
  totalDepth: () => number
}

export interface PendingInboundBufferOptions {
  capPerAgent?: number
  log?: (line: string) => void
}

/**
 * Drain `agent`'s buffered inbound and re-deliver each via `send`. A
 * `send` returning false (or throwing) means "not delivered" — the
 * message is re-buffered so nothing is lost when the bridge is still
 * offline. Returns counts for observability.
 *
 * This exists because `drain` is otherwise only called on bridge
 * re-register (`onClientRegistered`). After a network storm that
 * settles with the bridge STILL connected, messages buffered during
 * the flap never drain — they sit until a manual restart forces a
 * re-register. The silence-poke framework fallback calls this on
 * wedge-clear so the agent self-heals (fleet-update thundering-herd
 * incident, 2026-05-19).
 */
export function redeliverBufferedInbound(
  buffer: PendingInboundBuffer,
  agent: string,
  send: (msg: InboundMessage) => boolean,
): { drained: number; redelivered: number; rebuffered: number } {
  const pending = buffer.drain(agent)
  let redelivered = 0
  let rebuffered = 0
  for (const msg of pending) {
    let delivered = false
    try {
      delivered = send(msg)
    } catch {
      delivered = false
    }
    if (delivered) {
      redelivered++
    } else {
      buffer.push(agent, msg)
      rebuffered++
    }
  }
  return { drained: pending.length, redelivered, rebuffered }
}

/**
 * One opportunistic idle-drain tick. The third drain trigger, beside
 * `onClientRegistered` (bridge re-register) and the silence-poke
 * wedge-clear (#1546). Closes the orphan gap those two miss: a message
 * buffered during a bridge-IPC flap that settles with no subsequent
 * clean re-register while claude is idle (no turn → no silence-poke)
 * — it would otherwise sit until a manual restart (finn, 2026-05-19).
 *
 * Gated to be zero-cost / zero-churn so it can run on a short timer:
 *   - empty buffer → return null (one Map.get, NO drain, NO log)
 *   - bridge not alive → return null (never drain into a dead bridge,
 *     which would re-buffer+log-spin every tick; onClientRegistered
 *     will drain on the eventual reconnect instead)
 *   - otherwise → `redeliverBufferedInbound` (lossless: re-buffers any
 *     per-message miss). A message delivered mid-turn is queued
 *     normally by the bridge, same as a live arrival — not lost.
 *
 * Returns the redeliver counts only when it actually ran, else null
 * (so the caller logs only on a real flush).
 */
export function idleDrainTick(
  buffer: PendingInboundBuffer,
  agent: string,
  isBridgeAlive: () => boolean,
  send: (msg: InboundMessage) => boolean,
): { drained: number; redelivered: number; rebuffered: number } | null {
  if (!agent) return null
  if (buffer.depth(agent) === 0) return null
  if (!isBridgeAlive()) return null
  return redeliverBufferedInbound(buffer, agent, send)
}

export function createPendingInboundBuffer(
  opts: PendingInboundBufferOptions = {},
): PendingInboundBuffer {
  const cap = opts.capPerAgent ?? DEFAULT_PENDING_INBOUND_CAP
  const log = opts.log ?? ((line: string) => process.stderr.write(line))
  const queues = new Map<string, InboundMessage[]>()

  return {
    push(agent, msg) {
      let q = queues.get(agent)
      if (q == null) {
        q = []
        queues.set(agent, q)
      }
      let evicted = false
      if (q.length >= cap) {
        const dropped = q.shift()
        evicted = true
        log(
          `pending-inbound-buffer: agent=${agent} cap=${cap} reached — ` +
          `dropped oldest entry source=${dropped?.meta?.source ?? '-'} ts=${dropped?.ts ?? '-'}\n`,
        )
      }
      q.push(msg)
      log(
        `pending-inbound-buffer: agent=${agent} buffered source=${msg.meta?.source ?? '-'} ` +
        `depth_after=${q.length} evicted=${evicted}\n`,
      )
      return !evicted
    },
    drain(agent) {
      const q = queues.get(agent)
      if (q == null || q.length === 0) return []
      queues.delete(agent)
      log(
        `pending-inbound-buffer: drained agent=${agent} count=${q.length} ` +
        `sources=[${q.map((m) => m.meta?.source ?? '-').join(',')}]\n`,
      )
      return q
    },
    depth(agent) {
      return queues.get(agent)?.length ?? 0
    },
    totalDepth() {
      let n = 0
      for (const q of queues.values()) n += q.length
      return n
    },
  }
}
