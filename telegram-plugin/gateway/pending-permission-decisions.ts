/**
 * Per-agent buffer for permission verdicts the gateway couldn't deliver
 * because no live IPC client was registered for the agent at send-time.
 *
 * Background (PR-3 of the callback→model-continuation series): a
 * tool/skill/MCP permission request suspends the claude turn *inside*
 * the MCP permission call until the gateway relays the operator's
 * Approve/Deny verdict back (`{type:'permission'}` → bridge
 * `onPermission` → Claude Code). The verdict sites previously used
 * `ipcServer.broadcast(...)`, which is fire-and-forget: if the bridge
 * was mid-reconnect at the exact moment the operator tapped (every
 * agent/gateway restart, claude session bounce), the verdict was
 * dropped and the model stayed wedged forever — the user's tap did
 * nothing and they were left silent.
 *
 * This is the permission-verdict analog of `pending-inbound-buffer.ts`:
 * the verdict sites now `sendToAgent` (registered-keyed, real delivered
 * bool) and on a miss `push()` here; `onClientRegistered` `drain()`s
 * and re-sends so a reconnecting bridge relays the missed verdict to
 * the still-suspended permission call.
 *
 * Contract mirrors pending-inbound-buffer:
 *   - `push(agent, ev)` best-effort, synchronous, bounded.
 *   - `drain(agent)` returns ALL pending verdicts in insertion order
 *     and clears them; called from `onClientRegistered`.
 *   - In-memory only; survives reconnect within one gateway lifetime,
 *     not a gateway restart. A late-redelivered verdict for a
 *     request_id claude no longer has is harmless — the bridge relays
 *     it and Claude Code ignores an unknown request_id. The TTL-sweep
 *     auto-deny is the independent backstop for "operator never tapped".
 *
 * Per-agent cap prevents a never-reconnecting bridge from leaking
 * memory; on overflow the OLDEST verdict is dropped (freshest is most
 * relevant) and logged.
 */

import type { PermissionEvent } from './ipc-protocol.js'

/** Default cap per agent — a reasonable backlog of permission cards
 *  stacked while the bridge is offline, no more. */
export const DEFAULT_PENDING_PERMISSION_CAP = 32

export interface PendingPermissionBuffer {
  /** Append `ev` to `agent`'s queue. Returns true if accepted without
   *  eviction, false if the cap forced dropping the oldest (the new
   *  entry is STILL accepted). */
  push: (agent: string, ev: PermissionEvent) => boolean
  /** Pop and return all pending verdicts for `agent` (insertion order).
   *  Empty array when none. Idempotent. */
  drain: (agent: string) => PermissionEvent[]
  /** Test-only: current depth for `agent`. */
  depth: (agent: string) => number
  /** Test-only: total depth across all agents. */
  totalDepth: () => number
}

export interface PendingPermissionBufferOptions {
  capPerAgent?: number
  log?: (line: string) => void
}

export function createPendingPermissionBuffer(
  opts: PendingPermissionBufferOptions = {},
): PendingPermissionBuffer {
  const cap = opts.capPerAgent ?? DEFAULT_PENDING_PERMISSION_CAP
  const log = opts.log ?? ((line: string) => process.stderr.write(line))
  const queues = new Map<string, PermissionEvent[]>()

  return {
    push(agent, ev) {
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
          `pending-permission-buffer: agent=${agent} cap=${cap} reached — ` +
          `dropped oldest verdict request=${dropped?.requestId ?? '-'} ` +
          `behavior=${dropped?.behavior ?? '-'}\n`,
        )
      }
      q.push(ev)
      log(
        `pending-permission-buffer: agent=${agent} buffered request=${ev.requestId} ` +
        `behavior=${ev.behavior} depth_after=${q.length} evicted=${evicted}\n`,
      )
      return !evicted
    },
    drain(agent) {
      const q = queues.get(agent)
      if (q == null || q.length === 0) return []
      queues.delete(agent)
      log(
        `pending-permission-buffer: drained agent=${agent} count=${q.length} ` +
        `requests=[${q.map((e) => e.requestId).join(',')}]\n`,
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
