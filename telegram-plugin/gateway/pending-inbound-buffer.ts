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
 * unbounded memory. When the cap is hit exactly one entry is dropped and
 * logged via the provided logger. The victim is NOT simply the oldest —
 * see `selectEvictionVictim`. "Oldest wins" was wrong precisely because
 * the oldest entry is the one most likely to be a synthetic approval
 * outcome that has been waiting through an entire turn, and an approval
 * outcome is the one inbound class the operator cannot resend.
 */

import type { InboundMessage } from './ipc-protocol.js'
import type { InboundSpool } from './inbound-spool.js'
import { stampsHandbackMarker } from './subagent-handback-marker.js'
import { createApprovalOutcomeDropNotifier, isApprovalOutcome } from './approval-outcome-sources.js'

/** Default cap per agent. Tuned for `should fit a reasonable backlog of
 *  approval cards stacked while bridge is offline` but no more. */
export const DEFAULT_PENDING_INBOUND_CAP = 32

/**
 * How long an approval outcome keeps its eviction protection.
 *
 * Matched to the inbound spool's default `escalateAfterMs`
 * (`inbound-spool.ts:286`, 15 min). Past that the spool has already escalated
 * the entry and tombstoned it, so holding a buffer slot for it buys nothing —
 * and holding it FOREVER is a live pin: a buffer that refuses to evict
 * outcomes can otherwise be parked at cap by one outcome that is never
 * drained (a bridge that never re-registers), starving every later message.
 * The age bound is what makes the protection self-releasing rather than a leak.
 */
export const APPROVAL_OUTCOME_PROTECTION_MS = 15 * 60 * 1000

/** Why `selectEvictionVictim` picked the entry it picked. */
export type EvictionReason = 'non-outcome' | 'stale-outcome' | 'all-outcomes'

/**
 * Choose which buffered entry to evict when the cap is hit. Pure, so the
 * tiering can be pinned exhaustively.
 *
 * Three tiers, in order:
 *   1. The oldest entry that is NOT an approval outcome. An ordinary chat
 *      message is resendable and its loss is already surfaced by the
 *      coalesced `onEvict` notice; an approval outcome is not resendable at
 *      all (see approval-outcome-sources.ts). In every realistic overflow —
 *      a burst of user messages while a turn is in flight — this tier hits,
 *      so an outcome can no longer be evicted out from under an agent that
 *      is blocked on it.
 *   2. The oldest outcome past `protectMaxAgeMs`. Bounds the pin (above).
 *   3. Pathological: every entry is a fresh outcome. The oldest goes and the
 *      caller is told via `onEvictCritical` — a dropped outcome the agent is
 *      never informed of is a permanent block, which is strictly worse than
 *      a dropped outcome it knows about.
 *
 * Insertion order of the SURVIVORS is unchanged in every tier (a splice of
 * one element preserves relative order), so the FIFO contract `drain` and
 * `planBufferedRedelivery` rely on still holds.
 *
 * Returns index 0 on an empty queue; the caller's `splice` then yields
 * `undefined` and is guarded, matching the previous `q.shift()` behaviour.
 */
export function selectEvictionVictim(
  q: readonly InboundMessage[],
  nowMs: number,
  protectMaxAgeMs: number = APPROVAL_OUTCOME_PROTECTION_MS,
): { index: number; reason: EvictionReason } {
  for (let i = 0; i < q.length; i++) {
    if (!isApprovalOutcome(q[i]!)) return { index: i, reason: 'non-outcome' }
  }
  for (let i = 0; i < q.length; i++) {
    const ts = q[i]!.ts
    if (typeof ts === 'number' && Number.isFinite(ts) && nowMs - ts >= protectMaxAgeMs) {
      return { index: i, reason: 'stale-outcome' }
    }
  }
  return { index: 0, reason: 'all-outcomes' }
}

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
  /**
   * Delivery-time gate consulted by `redeliverBufferedInbound` for EVERY message
   * it is about to hand to the bridge. Returns TRUE to proceed, FALSE to RETRACT
   * (drop) the message (the spool entry is acked so it is not boot-replayed, and
   * it is NOT re-buffered). The gateway wires this to the represent delivery
   * re-check (represent-delivery-guard.ts): a represent buffered while its
   * obligation was open must be re-evaluated at drain time, since a reply may have
   * landed between the sweep's decision and this drain. Undefined ⇒ never retract.
   */
  beforeRedeliver?: (msg: InboundMessage) => boolean
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
  /**
   * Called when the in-memory cap forces an eviction of the OLDEST
   * entry (#2789 defect A). The evicted message is NOT lost — `push`
   * still records it durably in the spool (boot-replayed / escalated) —
   * but within a live session it will not be re-delivered until boot or
   * escalation, so the eviction must not be SILENT the way it was
   * before. The caller wires this to a coalesced "N messages deferred"
   * user-facing notice tied to the spool, turning a silent in-session
   * drop into a visible deferral (chat-is-the-single-source-of-truth:
   * surface the loss window, don't hide it). Best-effort: a throw here
   * never breaks the push hot path.
   *
   * Fires ONLY for a non-outcome eviction. When the victim is an approval
   * outcome, `onEvictCritical` fires INSTEAD — the two notices would
   * contradict each other otherwise. `onEvict`'s copy promises the message is
   * "saved and will be handled … I'll ask you to resend it", which is exactly
   * the promise that cannot be kept for a dropped approval outcome (the
   * operator's tap already happened; there is nothing to resend).
   */
  onEvict?: (agent: string, evicted: InboundMessage) => void
  /**
   * DEFAULTS ON — leave it unset and `createPendingInboundBuffer` wires
   * `createApprovalOutcomeDropNotifier` against its own `push`. Set it to
   * override the notice, or to an explicit no-op to opt out.
   *
   * Called instead of `onEvict` when the evicted entry is an APPROVAL OUTCOME
   * — either a stale one past `approvalOutcomeProtectionMs`, or the
   * pathological case where every buffered entry is a fresh outcome so there
   * is nothing else to drop.
   *
   * This is the one eviction the spool cannot make good on: `sweepEscalations`
   * (`inbound-spool.ts:564-600`) tombstones and posts "couldn't deliver, please
   * resend", which is meaningless for a `vault_grant_approved`. The gateway
   * wires this to a distinct greppable log plus a synthetic notice inbound so
   * the agent learns the outcome is gone rather than blocking on it forever.
   *
   * RE-ENTRANCY: the handler MUST NOT push into this buffer inside the call
   * frame — it is invoked from the middle of `push`, on a queue that is at cap.
   * Defer with `queueMicrotask`. The `try/catch` around this call protects the
   * hot path from a throw; it does nothing against recursion.
   *
   * Best-effort: a throw here never breaks the push hot path.
   */
  onEvictCritical?: (agent: string, evicted: InboundMessage) => void
  /**
   * How long an approval outcome resists eviction. Defaults to
   * `APPROVAL_OUTCOME_PROTECTION_MS` (the spool's escalation window).
   */
  approvalOutcomeProtectionMs?: number
  /** Clock seam for the age bound. Defaults to `Date.now`. */
  now?: () => number
  /**
   * fix/backstop-duplicate-reply MUST-FIX 2 — called on every push of a
   * `subagent_handback` envelope (live synthesis AND boot-replay re-push),
   * carrying the envelope's `chatId`, its `threadId` (the originating forum
   * topic, or undefined for a DM), and its own `ts` (ms). The gateway wires this
   * to the per-chat/thread subagent-handback marker so the supersede path can
   * tell a flushed turn's own late reply from a background handback attributed to
   * it — INCLUDING after a restart, where the only handback push is the replay.
   * The `threadId` is passed so the marker keys on the SAME `chatId|threadId`
   * lane the supersede registry uses (dup-audit F2): a handback in one topic must
   * not hold the content gate open in another. Best-effort: a throw here never
   * breaks the push hot path.
   */
  onHandbackEnqueue?: (chatId: string, threadId: number | undefined, ts: number) => void
  /**
   * Delivery-time retract gate — see `PendingInboundBuffer.beforeRedeliver`. The
   * gateway supplies the represent delivery re-check here so EVERY drain path
   * (idle-drain, bridge re-register, silence-poke fallback, turn-end) inherits it
   * by construction rather than by per-call-site discipline.
   */
  beforeRedeliver?: (msg: InboundMessage) => boolean
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
): { drained: number; redelivered: number; rebuffered: number; retracted: number } {
  const pending = buffer.drain(agent)
  let redelivered = 0
  let rebuffered = 0
  let retracted = 0
  // Collapse consecutive same-sender Telegram user messages into one turn
  // (see planBufferedRedelivery) so a forwarded burst that spanned a turn
  // boundary doesn't fan out into N sequential replies. System inbounds
  // (vault grants, approvals, cron, handbacks — anything with meta.source)
  // are never merged and are delivered individually exactly as before.
  for (const { merged, originals } of planBufferedRedelivery(pending)) {
    // Delivery-time retract (F1): a buffered `obligation_represent` whose reply
    // has landed since the sweep decided it is stale — drop it rather than hand
    // a duplicate to the CLI queue. Ack the spool so it is not boot-replayed and
    // do NOT re-buffer. The gateway closure closes the ledger + logs the retract.
    // FAIL-OPEN: a throwing predicate must never silence or lose a real message,
    // nor abort the drain loop (which would strand every following message and
    // crash the setInterval tick). On throw we treat it as "deliver".
    let proceed = true
    if (buffer.beforeRedeliver != null) {
      try {
        proceed = buffer.beforeRedeliver(merged)
      } catch (e) {
        proceed = true
        process.stderr.write(`redeliver beforeRedeliver threw — failing open (deliver): ${String(e)}\n`)
      }
    }
    if (!proceed) {
      for (const o of originals) spool?.ack(o)
      retracted += originals.length
      continue
    }
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
  return { drained: pending.length, redelivered, rebuffered, retracted }
}

/** True when `msg` is an ordinary Telegram user message eligible to be
 *  merged with adjacent siblings. System inbounds (cron, vault grants,
 *  approvals, subagent handbacks, warmup, reaction triggers) all tag a
 *  `meta.source`; the user-message inbound built in gateway.ts sets none.
 *  Restricting to source-less inbounds keeps merge-on-drain away from the
 *  #1150 wake-up class entirely.
 *
 *  Button taps (#271, `meta.button_callback`) are ALSO excluded even though
 *  they carry no `meta.source`: `mergeRun` keeps only the anchor (last)
 *  message's meta, so a tap merged with an adjacent buffered user text would
 *  silently drop its `button_callback_data`/`button_text` whenever the text
 *  is last — the agent would see the `[user tapped button: …]` line without
 *  the machine-readable payload. Taps deliver individually. */
function isMergeableUserInbound(msg: InboundMessage): boolean {
  return (
    msg.type === 'inbound' &&
    (msg.meta == null || (msg.meta.source == null && msg.meta.button_callback == null))
  )
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
): { drained: number; redelivered: number; rebuffered: number; retracted: number } | null {
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
  const now = opts.now ?? (() => Date.now())
  const protectionMs = opts.approvalOutcomeProtectionMs ?? APPROVAL_OUTCOME_PROTECTION_MS
  const queues = new Map<string, InboundMessage[]>()

  const buffer: PendingInboundBuffer = {
    push(agent, msg) {
      let q = queues.get(agent)
      if (q == null) {
        q = []
        queues.set(agent, q)
      }
      let evicted = false
      if (q.length >= cap) {
        // Victim selection is TIERED, not `q.shift()`. The oldest entry is
        // exactly the one most likely to be an approval outcome that has been
        // waiting through an entire turn — and an approval outcome is the one
        // inbound class the operator cannot resend. See selectEvictionVictim.
        const { index, reason } = selectEvictionVictim(q, now(), protectionMs)
        const dropped = q.splice(index, 1)[0]
        evicted = true
        log(
          `pending-inbound-buffer: agent=${agent} cap=${cap} reached — ` +
          `dropped entry idx=${index} reason=${reason} ` +
          `source=${dropped?.meta?.source ?? '-'} ts=${dropped?.ts ?? '-'}\n`,
        )
        // #2789 A: the cap eviction is no longer a SILENT in-session
        // drop. `dropped` still lives in the durable spool (it was
        // spool.put on its own push), so it survives to boot-replay /
        // escalation — but it won't be re-delivered THIS session. Hand
        // it to the caller so a coalesced "N messages deferred" notice
        // can be surfaced. Best-effort: never let the notice break push.
        //
        // An APPROVAL OUTCOME victim routes to `onEvictCritical` instead: the
        // "saved, I'll ask you to resend" copy behind `onEvict` is a promise
        // that cannot be kept for a verdict the operator already tapped.
        if (dropped != null) {
          const critical = reason !== 'non-outcome'
          const cb = critical ? onEvictCritical : opts.onEvict
          if (cb != null) {
            try {
              cb(agent, dropped)
            } catch {
              /* user-facing notice is best-effort; never break the hot path */
            }
          }
        }
      }
      q.push(msg)
      // fix/backstop-duplicate-reply MUST-FIX 2 — stamp the subagent-handback
      // marker at THIS chokepoint, not at the live onFinish enqueue site alone.
      // Every handback enqueue funnels through here — the live synthesis push
      // AND the boot-replay re-push of un-acked spooled inbounds — so stamping
      // here (rather than only at the live site) means a handback replayed after
      // a restart still populates the marker. Otherwise the Map is empty
      // post-boot and a replayed handback's late reply bypasses the #3429
      // content gate → silent edit-over-answer. Uses the envelope's own `ts`
      // (ms, `Date.now()`-derived at synthesis) so the marker reflects when the
      // handback actually happened, not the replay moment. Best-effort.
      // F1 (dup-audit) — the ONE chokepoint that decides which sources stamp the
      // decoupled-completion marker, delegated to the single `stampsHandbackMarker`
      // predicate (its membership is the invariant's only extension point). Every
      // inbound — live synthesis AND boot-replay — funnels through this push(), so
      // routing the decision here makes "a decoupled late-reply source stamps the
      // marker" true BY CONSTRUCTION rather than by per-feature discipline.
      if (stampsHandbackMarker(msg.meta?.source) && opts.onHandbackEnqueue != null) {
        try {
          // F2 (dup-audit): pass the envelope's originating topic so the marker
          // keys on the same `chatId|threadId` lane as the supersede registry.
          opts.onHandbackEnqueue(msg.chatId, msg.threadId, msg.ts)
        } catch {
          /* marker stamp is best-effort; never break the push hot path */
        }
      }
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
    beforeRedeliver: opts.beforeRedeliver,
  }

  // The critical-eviction notifier DEFAULTS ON, wired to this buffer's own
  // `push`. Same reasoning as `beforeRedeliver` and the handback-marker stamp
  // above: the guarantee we want is "a dropped approval outcome is never
  // silent", and a guarantee that depends on each construction site
  // remembering to pass a callback is discipline, not a mechanism. Defaulting
  // it here makes it true by construction at every site, including future ones.
  //
  // A caller may still override to route the notice elsewhere. Passing an
  // explicit no-op is the (deliberately explicit) way to opt out.
  //
  // The buffer can self-wire because it owns `push` — no caller plumbing, and
  // notably no new inline code in gateway.ts, which is under a hard line
  // ratchet (`scripts/check-gateway-line-ratchet.mjs`) with 2 lines of grace.
  const onEvictCritical =
    opts.onEvictCritical ??
    createApprovalOutcomeDropNotifier({
      push: (a, m) => {
        buffer.push(a, m)
      },
      log,
    })

  return buffer
}
