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
import type { InboundSpool } from './inbound-spool.js'

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
  /**
   * Durable spool. When set, every `push` is also recorded on the
   * persistent per-agent volume so a gateway/container restart cannot
   * silently lose the message (the finn/carrie incident class). The
   * in-memory queue stays the hot path + cap; the spool is the
   * crash-survivable record, acked only on confirmed delivery (by
   * `redeliverBufferedInbound`/`idleDrainTick`), boot-replayed by the
   * gateway, and escalated-then-dropped if undeliverable past its
   * bound. The in-memory cap eviction does NOT touch the spool — an
   * evicted-from-memory entry survives in the spool (strictly safer
   * than the old silent in-memory drop).
   */
  spool?: InboundSpool
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
  spool?: InboundSpool,
  // Called once per merged group on CONFIRMED delivery (after spool.ack).
  // The caller uses it to enrol the redelivered inbound in the
  // deliver-until-acked queue (`trackDelivery`) so it is re-sent until
  // claude's `enqueue` ack lands — closing the restart boot-race where a
  // socket-write "succeeds" into a not-ready session and the message is
  // silently dropped (clerk 2026-06-03). `send` returning true only means
  // the bytes reached the bridge, NOT that claude consumed them.
  onDelivered?: (merged: InboundMessage, originals: InboundMessage[]) => void,
): { drained: number; redelivered: number; rebuffered: number } {
  const pending = buffer.drain(agent)
  let redelivered = 0
  let rebuffered = 0
  // Collapse consecutive same-sender Telegram user messages into one turn
  // (see planBufferedRedelivery) so a forwarded burst that spanned a turn
  // boundary doesn't fan out into N sequential replies. System inbounds
  // (vault grants, approvals, cron, handbacks — anything with meta.source)
  // are never merged and are delivered individually exactly as before.
  for (const { merged, originals } of planBufferedRedelivery(pending)) {
    let delivered = false
    try {
      delivered = send(merged)
    } catch {
      delivered = false
    }
    if (delivered) {
      // Confirmed delivery to a live registered bridge → the durable
      // promise is kept; tombstone EVERY original's spool entry so none is
      // boot-replayed again. The merged message isn't itself spooled — the
      // originals are, so we ack by original identity.
      for (const o of originals) spool?.ack(o)
      redelivered += originals.length
      // Enrol in the deliver-until-acked queue (caller's hook). A bare
      // socket-write success is NOT proof claude consumed it; the queue's
      // sweep re-delivers until the `enqueue` ack lands.
      onDelivered?.(merged, originals)
    } else {
      // Re-buffer the originals (not the merged synthetic) so the spool
      // identity is preserved and the next drain re-merges them losslessly.
      for (const o of originals) buffer.push(agent, o)
      rebuffered += originals.length
    }
  }
  return { drained: pending.length, redelivered, rebuffered }
}

/** True when `msg` is an ordinary Telegram user message eligible to be
 *  merged with adjacent siblings. System inbounds (cron, vault grants,
 *  approvals, subagent handbacks, warmup, reaction triggers) all tag a
 *  `meta.source`; the user-message inbound built in gateway.ts sets none.
 *  Restricting to source-less inbounds keeps merge-on-drain away from the
 *  #1150 wake-up class entirely. */
function isMergeableUserInbound(msg: InboundMessage): boolean {
  return msg.type === 'inbound' && (msg.meta == null || msg.meta.source == null)
}

function inboundHasMedia(msg: InboundMessage): boolean {
  return msg.imagePath != null || msg.attachment != null
}

/**
 * Plan how a drained buffer is re-delivered. Walks `pending` in arrival
 * order and groups runs of consecutive messages that:
 *   - are both ordinary Telegram user messages (no meta.source), AND
 *   - share the same (chatId, threadId, userId), AND
 *   - would not put two attachments in one turn (A1 carries a single
 *     attachment; a second media starts a new run so nothing is dropped).
 *
 * Each run collapses to one merged InboundMessage (texts joined by '\n',
 * the run's single attachment carried, the LAST message's identity/meta
 * kept as the turn anchor). A run of one passes through unchanged. The
 * returned `originals` preserve spool identity for ack / re-buffer.
 *
 * Pure + deterministic so it can be exhaustively fuzzed.
 */
export function planBufferedRedelivery(
  pending: InboundMessage[],
): { merged: InboundMessage; originals: InboundMessage[] }[] {
  const out: { merged: InboundMessage; originals: InboundMessage[] }[] = []
  let run: InboundMessage[] = []
  let runHasMedia = false

  const sameTarget = (a: InboundMessage, b: InboundMessage): boolean =>
    a.chatId === b.chatId &&
    (a.threadId ?? null) === (b.threadId ?? null) &&
    a.userId === b.userId

  const flush = (): void => {
    if (run.length === 0) return
    out.push({ merged: run.length === 1 ? run[0]! : mergeRun(run), originals: run })
    run = []
    runHasMedia = false
  }

  for (const msg of pending) {
    const msgHasMedia = inboundHasMedia(msg)
    const canJoin =
      run.length > 0 &&
      isMergeableUserInbound(msg) &&
      isMergeableUserInbound(run[run.length - 1]!) &&
      sameTarget(run[run.length - 1]!, msg) &&
      !(runHasMedia && msgHasMedia)
    if (!canJoin) flush()
    run.push(msg)
    runHasMedia = runHasMedia || msgHasMedia
  }
  flush()
  return out
}

/** Meta keys that describe an attachment — the primary (image_path,
 *  attachment_*) plus the A2 numbered siblings (image_path_2,
 *  attachment_file_id_2, …) and attachment_count. */
const ATTACHMENT_META_RE = /^(image_path|attachment_)/

/** Collapse a >1 run into a single turn. The newest message anchors the
 *  turn (its messageId/ts/user/meta); texts join in arrival order; the
 *  attachment(s) (if any) ride along from whichever message carried them.
 *  Caller guarantees the run is mergeable + has at most one media-bearing
 *  entry. */
function mergeRun(run: InboundMessage[]): InboundMessage {
  const last = run[run.length - 1]!
  const mediaEntry = run.find(inboundHasMedia)
  const merged: InboundMessage = {
    ...last,
    text: run.map((m) => m.text).join('\n'),
  }
  // Re-seat the attachment/imagePath from the entry that owns it (which may
  // not be `last`), or strip them if the run is text-only.
  delete merged.imagePath
  delete merged.attachment
  if (mediaEntry != null && mediaEntry !== last) {
    // The media-bearing entry isn't the anchor, so `last.meta` lacks the
    // attachment fields the agent reads (image_path / attachment_* and the
    // A2 numbered siblings). Splice the owning entry's attachment meta keys
    // into the merged meta so the agent still sees every attachment.
    const splicedMeta: Record<string, string> = { ...merged.meta }
    for (const [k, v] of Object.entries(mediaEntry.meta)) {
      if (ATTACHMENT_META_RE.test(k)) splicedMeta[k] = v
    }
    merged.meta = splicedMeta
  }
  if (mediaEntry?.imagePath != null) merged.imagePath = mediaEntry.imagePath
  if (mediaEntry?.attachment != null) merged.attachment = mediaEntry.attachment
  return merged
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
 *     per-message miss).
 *
 * NOTE (#1556): a message delivered mid-turn is NOT safely queued by
 * the bridge — the prior "queued normally, same as a live arrival"
 * claim here was the false assumption behind the lawgpt composer
 * wedge. claude types a mid-turn channel notification into its TUI
 * composer and the auto-submit races turn-completion, stranding it.
 * The `idleDrainTick` caller therefore also gates on
 * `activeTurnStartedAt.size === 0`, so this function is never invoked
 * mid-turn. The Telegram `handleInbound` delivery path is turn-gated
 * (gateway.ts); the `inject_inbound` cron/synthetic path is a separate
 * delivery contract and deliberately not gated — see
 * `inbound-delivery-gate.ts`.
 *
 * Returns the redeliver counts only when it actually ran, else null
 * (so the caller logs only on a real flush).
 */
export function idleDrainTick(
  buffer: PendingInboundBuffer,
  agent: string,
  isBridgeAlive: () => boolean,
  send: (msg: InboundMessage) => boolean,
  spool?: InboundSpool,
  // Forwarded to redeliverBufferedInbound so the post-flap-settle drain also
  // enrols redelivered inbounds in the deliver-until-acked queue (parity with
  // the bridgeUp drain — clerk lost-message incident, 2026-06-03).
  onDelivered?: (merged: InboundMessage, originals: InboundMessage[]) => void,
): { drained: number; redelivered: number; rebuffered: number } | null {
  if (!agent) return null
  if (buffer.depth(agent) === 0) return null
  if (!isBridgeAlive()) return null
  return redeliverBufferedInbound(buffer, agent, send, spool, onDelivered)
}

export function createPendingInboundBuffer(
  opts: PendingInboundBufferOptions = {},
): PendingInboundBuffer {
  const cap = opts.capPerAgent ?? DEFAULT_PENDING_INBOUND_CAP
  const log = opts.log ?? ((line: string) => process.stderr.write(line))
  const spool = opts.spool
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
      // Durable record FIRST-class to the in-memory queue: spool BEFORE
      // returning, regardless of the cap eviction above — an entry the
      // in-memory cap drops still survives in the spool (boot-replayed /
      // escalated), which is the whole point. spool.put dedups by
      // spoolId so a boot-replay re-push is a no-op here.
      spool?.put(agent, msg)
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
