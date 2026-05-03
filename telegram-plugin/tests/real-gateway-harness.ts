/**
 * Real-gateway harness — Phase 3 of #545 / first PR of #553.
 *
 * Wraps the Phase 1 `waiting-ux-harness` with the real production
 * `InboundCoalescer` so the F1–F4 user-perceived UX deadlines are
 * asserted against the same coalescing timing the live gateway uses,
 * not a parallel reimplementation.
 *
 * The Phase 1 harness called `controller.setQueued()` (👀) synchronously
 * in `inbound()` — that's why F2 ("👀 within 800ms") passed trivially
 * there. Production code routes inbound through `handleInboundCoalesced`
 * first, which buffers messages for `gapMs` (default 1500ms) and only
 * THEN calls the first-paint flow that fires the reaction. This harness
 * exposes that gap to tests so the F2 deadline becomes catchable.
 *
 * Composition (top-down):
 *   inbound(chatId, msgId, text)
 *     → inboundCoalescer.enqueue(key, payload)
 *     → after gapMs, onFlush() runs:
 *        → controller.setQueued()    (👀)
 *        → driver.startTurn()
 *   feedSessionEvent(ev)
 *     → controller.setThinking() / setTool() / setDone()
 *     → driver.ingest()
 *
 * `gapMs` defaults to 1500 (production value). Tests can pass `gapMs: 0`
 * to disable coalescing and verify the upper-bound on first-paint
 * latency without the coalesce wait, or `gapMs: 500` to mimic an
 * operator who tuned it down.
 *
 * F1–F4 deadlines this harness lets us assert:
 *   - F1 ladder collapse: reaction sequence over a multi-tool turn
 *   - F2 no instant draft: firstReactionMs - inboundAt
 *   - F3 late progress card: progressCardSendMs - firstToolUseMs
 *   - F4 static interim text: edits per session-event step transition
 */

import {
  createWaitingUxHarness,
  type CreateHarnessOpts,
  type HarnessHandle,
  type RecordedCall,
} from './waiting-ux-harness.js'
import type { SessionEvent } from '../session-tail.js'
import {
  createInboundCoalescer,
  inboundCoalesceKey,
  type InboundCoalescer,
} from '../gateway/inbound-coalesce.js'
import { validateClientMessage } from '../gateway/ipc-server.js'
import { flushOnAgentDisconnect } from '../gateway/disconnect-flush.js'
import { StatusReactionController } from '../status-reactions.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'

/**
 * Literal placeholder strings the v2 spec contract forbids. Listed
 * centrally so the harness helpers and PR-5 removal sweep stay in
 * sync. Must match the exact emoji + text used by production today —
 * see `pre-alloc-decision.ts`, `placeholder-phase.ts`,
 * `forum-topic-placeholder.ts`.
 */
export const PLACEHOLDER_STRINGS = [
  '🔵 thinking',
  '📚 recalling memories',
  '💭 thinking',
] as const

function isPlaceholderPayload(payload: string | undefined): boolean {
  if (payload == null) return false
  for (const s of PLACEHOLDER_STRINGS) {
    if (payload === s || payload === `${s}…` || payload.startsWith(`${s} `)) {
      return true
    }
  }
  return false
}

/**
 * Mirror of the recorder's progress-card heuristic from
 * `waiting-ux-harness.ts`. Kept in sync by hand — change both if the
 * card text glyphs shift.
 */
function isCardPayload(text: string | undefined): boolean {
  return (
    text != null &&
    (text.includes('Working') ||
      text.includes('⚙') ||
      text.includes('⏳') ||
      text.includes('• '))
  )
}

export interface RealGatewayHarnessOpts extends CreateHarnessOpts {
  /**
   * Inbound coalesce window in ms. Production reads this per-call from
   * the access file (default 1500). Tests can pass 0 to disable
   * coalescing entirely.
   */
  gapMs?: number

  /**
   * Wire the production `OutboundDedupCache` into the harness's
   * `streamReply` path. When enabled, repeated streamReply calls with
   * the same normalized content within the TTL are suppressed —
   * mimicking the #546 fix in production. Default false (preserves
   * back-compat with F1–F4 tests that don't care about dedup).
   *
   * When true, tests can introspect the cache via `harness.dedup`.
   */
  withDedup?: boolean

  /**
   * TTL for the wired-in dedup cache. Only used when `withDedup` is
   * true. Default matches production (`DEFAULT_DEDUP_TTL_MS = 60_000`).
   */
  dedupTtlMs?: number
}

interface CoalescePayload {
  chatId: string
  messageId: number
  text: string
  userId: string
}

export interface RealGatewayHarnessHandle extends HarnessHandle {
  /**
   * Total inbound messages currently buffered by the coalescer (across
   * all keys). For tests asserting that flush actually fired.
   */
  coalesceBufferSize(): number
  /** Underlying coalescer — exposed for tests that need direct introspection. */
  coalescer: InboundCoalescer<CoalescePayload>
  /**
   * Effective gapMs the harness was configured with. Pinned for tests
   * that compute deadlines relative to the coalesce window.
   */
  gapMs: number

  // ─── v2 spec helpers (PR 1 of #553 series) ──────────────────────────
  // The waiting-UX v2 contract forbids placeholder-text edits ("🔵
  // thinking", "📚 recalling memories", "💭 thinking"), suppresses the
  // progress card for Class A/B turns, and pins a first-answer-text
  // deadline. These three helpers expose those checks in a form that
  // reads cleanly inside `expect(...)` assertions.

  /**
   * Returns recorded `sendMessage` and `editMessageText` calls for
   * `chat_id` whose payload matches one of the literal placeholder
   * strings the v2 spec bans. Class A and B tests assert
   * `expect(h.recorder.expectNoPlaceholderEdits(CHAT)).toEqual([])`.
   *
   * NOTE: this name is a slight misnomer — it returns hits to
   * inspect, not throws. A non-empty array IS the failure signal.
   */
  expectNoPlaceholderEdits(chatId: string): RecordedCall[]

  /**
   * Returns the timestamp of the first progress-card render for
   * `chat_id`, or null if none. Thin wrapper around
   * `recorder.progressCardSendMs` so spec tests can write
   * `expect(h.recorder.expectNoCardSent(CHAT)).toBeNull()` for the
   * Class A/B "no card" invariant without poking at the underlying
   * recorder helper directly.
   */
  expectNoCardSent(chatId: string): number | null

  /**
   * Returns the timestamp of the first `sendMessage` or
   * `editMessageText` for `chat_id` whose payload is plausibly
   * answer text — i.e. NOT a progress-card payload (per
   * `isCardPayload` heuristic) and NOT a placeholder string.
   * Returns null if no such call has been recorded.
   *
   * Used to pin the v2 first-answer-text deadline (Class A: <800ms
   * for 👀 and answer text bounded TBD by PR 3; Class B/C: TBD).
   */
  firstAnswerTextMs(chatId: string): number | null

  /**
   * Issue #626 invariant — exactly one anchor `sendMessage` per
   * (chatId, threadId, turnKey?). Returns the count of fresh
   * `sendMessage` calls (NOT edits) for the chat. The anchor is the
   * single message that subsequent edits target. Multiple anchors for
   * the same logical turn = the duplicate-status-message bug.
   *
   * Usage: `expect(h.anchorMessageCount(CHAT)).toBe(1)` after a
   * complete turn. Pass `threadId` to disambiguate forum topics.
   *
   * Returns -1 if the recorder isn't tracking calls (defensive — the
   * harness shouldn't reach this state, but a -1 is more actionable
   * than a silent 0 if it does).
   */
  anchorMessageCount(chatId: string, threadId?: number): number

  // ─── IPC + bridge lifecycle helpers (ships with PR for I1–I5) ───────
  // The IPC lifecycle (clients connecting, registering, sending typed
  // messages, disconnecting) is invisible to the existing waiting-UX
  // helpers above. Production bugs in this layer (Bug A premature 👍 on
  // anonymous disconnect, Bug B `update_placeholder` lethality, Bug D
  // 👍-before-delivery) all share a root cause: the harness had no way
  // to express "a client just connected/sent/disconnected." These
  // helpers route through PRODUCTION code paths where possible —
  // `validateClientMessage` is the real validator from
  // `gateway/ipc-server.ts`; the disconnect handler is mirrored from
  // `gateway.ts`'s `onClientDisconnected` (extracted helper landing in
  // PR #600 — until that merges, the harness mirror keeps the same
  // semantics so the invariants are testable now).

  /**
   * Simulate a client opening an IPC connection. If `agentName` is
   * provided, the harness immediately routes a `register` message
   * through the production validator so subsequent
   * `bridgeDisconnect()` cleans up the right per-agent state. If
   * `agentName == null`, the connection stays anonymous (recall.py-
   * style one-shot caller). Returns the synthetic `clientId`.
   */
  bridgeConnect(agentName: string | null): string

  /**
   * Simulate a client closing its IPC connection. Routes through the
   * harness's mirror of `onClientDisconnected` — flushes per-agent
   * status reactions to setDone() and disposes that agent's draft
   * streams. **Crucially: anonymous clients (agentName=null) flow
   * through the same handler but MUST NOT mutate any active state.**
   * That's invariant I1 (Bug A's failure mode).
   */
  bridgeDisconnect(clientId: string): void

  /**
   * Simulate a client sending an IPC message. The payload is run
   * through the production `validateClientMessage` validator — if it
   * fails validation (e.g. legacy `update_placeholder` type), the
   * harness logs and discards, mirroring `processBuffer`'s loop. The
   * connection stays open; no state is mutated. That's invariant I4.
   */
  sendIpcMessage(clientId: string, message: object): void

  /**
   * Timestamp of the last `setMessageReaction` for `chatId`, or null.
   * Used by I3 to compare reaction-fired-at against
   * answer-text-delivered-at.
   */
  lastReactionEmojiAt(chatId: string): number | null

  /**
   * Timestamp of the LAST `sendMessage` / `editMessageText` whose
   * payload looks like real model text (not card, not placeholder).
   * Used by I3 to assert 👍 fires AFTER delivery, not before.
   */
  lastAnswerTextDeliveredAt(chatId: string): number | null

  /**
   * Test introspection of the side-effect callbacks fired by the real
   * `flushOnAgentDisconnect` helper since the harness was created. Tests
   * that want to assert "no flush ran" check `clearActiveReactionsCalls`
   * and `disposeProgressDriverCalls` are still 0 after a sequence of
   * anonymous bridge cycles. `activeAgentCount` is the live size of the
   * harness's mirror of `activeStatusReactions` — non-zero means at
   * least one registered agent is still active.
   */
  flushSideEffects(): {
    clearActiveReactionsCalls: number
    disposeProgressDriverCalls: number
    flushLog: ReadonlyArray<string>
    activeAgentCount: number
  }

  // ─── #546 dedup integration ─────────────────────────────────────────
  /**
   * Real `OutboundDedupCache` wired into the harness's `streamReply`
   * path when `opts.withDedup === true`. Null otherwise. Tests assert
   * on `harness.dedup.size(now)` to confirm a record landed; or invoke
   * `harness.dedup.check(...)` directly to verify a hit before the
   * second send is attempted.
   */
  dedup: OutboundDedupCache | null

  /**
   * Count of dedup-suppressed sends since harness creation. When the
   * cache catches a retry, the harness records this so I6 / replay
   * tests can assert "yes, dedup actually fired" without poking at
   * counters in the cache.
   */
  dedupSuppressedCount(): number

  /**
   * Convenience scenario: simulate the #546 turn-flush + replay
   * sequence end-to-end:
   *   1. First send(text) — lands as a fresh sendMessage and records
   *      into the dedup cache.
   *   2. Bridge disconnects + a fresh agent reconnects. Disconnect is
   *      REGISTERED (not anonymous) so `flushOnAgentDisconnect` actually
   *      runs — proving dedup survives the production cleanup path.
   *      Anonymous disconnects are a no-op (I1) and would let this
   *      scenario pass even if dedup were broken in flush.
   *   3. Second send(text) — claude-code's preserved tool_call replay.
   *      Should be suppressed by dedup (no second outbound landed).
   *
   * Returns `{ firstMessageId, suppressedSecond, flushRan }`. Tests
   * assert `suppressedSecond === true` AND `flushRan === true` so the
   * full path is exercised, not a tautology.
   */
  simulateRetryDup(args: {
    chat_id: string
    text: string
  }): Promise<{
    firstMessageId: number | null
    suppressedSecond: boolean
    flushRan: boolean
  }>

  /**
   * "Fresh send" — always issues a new `sendMessage` for `chat_id`,
   * does NOT update the harness's stream-edit cache. Routes through
   * the dedup cache when wired. Mirrors production's turn-flush
   * backstop and the wake-audit greeting path: every fire is a
   * fresh user-visible message, not a streaming edit. Use this in
   * dedup tests where "the same content emitted twice" means two
   * NEW messages, not a streaming edit-in-place.
   *
   * Returns the new `message_id`, or null if dedup suppressed the send.
   */
  send(args: { chat_id: string; text: string; parse_mode?: string }): Promise<number | null>
}

const DEFAULT_GAP_MS = 1500

export function createRealGatewayHarness(
  opts: RealGatewayHarnessOpts = {},
): RealGatewayHarnessHandle {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS

  // Phase 1 harness: controller + driver + recorder + clock.
  const inner = createWaitingUxHarness(opts)

  // Track which (chatId) keys have an active turn — mirrors gateway.ts's
  // `activeTurnStartedAt` for the F2 early-ack mid-turn check. Set on
  // flush (when inner.inbound runs); cleared by the `turn_end` session
  // event so subsequent fresh inbounds get the early-ack again.
  const activeTurns = new Set<string>()

  // Wrap inner.inbound() with the real coalescer so the test surface
  // matches what production sees end-to-end.
  const coalescer = createInboundCoalescer<CoalescePayload>({
    gapMs,
    merge: (entries) => {
      const last = entries[entries.length - 1]
      return {
        chatId: last.chatId,
        messageId: last.messageId,
        userId: last.userId,
        text: entries.map((e) => e.text).join('\n'),
      }
    },
    onFlush: (_key, merged) => {
      // The flush is the moment first-paint runs in production —
      // controller.setQueued() (👀) and driver.startTurn(). Delegate
      // to the inner harness's inbound() which already wires both.
      activeTurns.add(merged.chatId)
      inner.inbound({ chatId: merged.chatId, messageId: merged.messageId, text: merged.text })
    },
  })

  function inbound(args: { chatId: string; messageId: number; text?: string; userId?: string }): void {
    const userId = args.userId ?? '777' // matches update-factory's default sender

    // F2 fix mirror: fire 👀 directly via bot.api on raw arrival, BEFORE
    // the coalescer's gap window. Production runs `maybeEarlyAckReaction`
    // here for paired DM users on a fresh turn. The harness skips the
    // access/chatType checks (the harness has no access file) and gates
    // only on "no active turn" so the mid-turn-flash case stays catchable.
    const turnKey = args.chatId
    if (!activeTurns.has(turnKey)) {
      void inner.bot.api.setMessageReaction(args.chatId, args.messageId, [
        { type: 'emoji', emoji: '👀' },
      ])
    }

    const payload: CoalescePayload = {
      chatId: args.chatId,
      messageId: args.messageId,
      text: args.text ?? '',
      userId,
    }
    const key = inboundCoalesceKey(args.chatId, userId)
    const result = coalescer.enqueue(key, payload)
    if (result.bypass) {
      // gapMs <= 0 — production calls handleInbound directly; mirror
      // by calling the inner harness's first-paint immediately.
      activeTurns.add(turnKey)
      inner.inbound({ chatId: args.chatId, messageId: args.messageId, text: args.text })
    }
  }

  function feedSessionEvent(ev: SessionEvent): void {
    if (ev.kind === 'turn_end') {
      // Turn complete — clear the active-turn marker so the next inbound
      // gets the early-ack again. Mirrors gateway.ts clearing
      // activeTurnStartedAt on turn-end (production tracks it per
      // statusKey but the harness collapses to per-chat).
      activeTurns.clear()
    }
    inner.feedSessionEvent(ev)
  }

  function finalize(): void {
    coalescer.reset()
    inner.finalize()
  }

  function expectNoPlaceholderEdits(chatId: string): RecordedCall[] {
    return inner.recorder.calls.filter(
      (c) =>
        (c.kind === 'sendMessage' || c.kind === 'editMessageText') &&
        c.chat_id === chatId &&
        isPlaceholderPayload(c.payload),
    )
  }

  function expectNoCardSent(chatId: string): number | null {
    return inner.recorder.progressCardSendMs(chatId)
  }

  function firstAnswerTextMs(chatId: string): number | null {
    const hit = inner.recorder.calls.find(
      (c) =>
        (c.kind === 'sendMessage' || c.kind === 'editMessageText') &&
        c.chat_id === chatId &&
        !isCardPayload(c.payload) &&
        !isPlaceholderPayload(c.payload),
    )
    return hit ? hit.ts : null
  }

  function anchorMessageCount(chatId: string, threadId?: number): number {
    if (!Array.isArray(inner.recorder.calls)) return -1
    return inner.recorder.calls.filter((c) => {
      if (c.kind !== 'sendMessage') return false
      if (c.chat_id !== chatId) return false
      if (threadId == null) return true
      // RecordedCall payload may carry message_thread_id when the
      // production code passed one — match if requested.
      const opts = (c as { opts?: { message_thread_id?: number } }).opts
      return opts?.message_thread_id === threadId
    }).length
  }

  function lastReactionEmojiAt(chatId: string): number | null {
    const hits = inner.recorder.calls.filter(
      (c) => c.kind === 'setMessageReaction' && c.chat_id === chatId,
    )
    return hits.length === 0 ? null : hits[hits.length - 1].ts
  }

  function lastAnswerTextDeliveredAt(chatId: string): number | null {
    const hits = inner.recorder.calls.filter(
      (c) =>
        (c.kind === 'sendMessage' || c.kind === 'editMessageText') &&
        c.chat_id === chatId &&
        !isCardPayload(c.payload) &&
        !isPlaceholderPayload(c.payload),
    )
    return hits.length === 0 ? null : hits[hits.length - 1].ts
  }

  // ─── #546 dedup wiring (opt-in) ───────────────────────────────────────
  // When `withDedup` is set, wrap the inner harness's `streamReply` so
  // the same content sent twice within the TTL only lands once. Mirrors
  // the production fix at `gateway.ts:2233` (`executeStreamReply`) and
  // `gateway.ts:1893` (`executeReply`): both check the cache, return
  // early on hit (NOT calling setDone — the original send already
  // finalized), and record after a successful send. F1–F4 tests don't
  // care about dedup so it stays opt-in.
  //
  // INVARIANT MIRROR: production's dedup-hit branch returns
  //   { content: [{ type: 'text', text: 'sent (deduped — ...)' }] }
  // without firing setDone. The harness wrap matches this — the
  // controller is left untouched on suppression. If production
  // changes (e.g. fires setDone on suppression for some reason),
  // update both sites together.
  const dedup = opts.withDedup === true ? new OutboundDedupCache({ ttlMs: opts.dedupTtlMs }) : null
  let dedupSuppressed = 0
  const innerStreamReply = inner.streamReply
  const streamReply = dedup == null
    ? innerStreamReply
    : async (args: { chat_id: string; text: string; done?: boolean }): Promise<void> => {
        const now = Date.now()
        const hit = dedup.check(args.chat_id, undefined, args.text, now)
        if (hit != null) {
          dedupSuppressed++
          return
        }
        await innerStreamReply(args)
        dedup.record(args.chat_id, undefined, args.text, Date.now())
      }

  /**
   * Fresh-send wrapper. Routes through the dedup cache (if wired) and
   * always calls `bot.api.sendMessage` directly — bypasses the inner
   * harness's stream-edit cache. Returns the new message_id, or null
   * if dedup suppressed the send.
   */
  async function send(args: {
    chat_id: string
    text: string
    parse_mode?: string
  }): Promise<number | null> {
    const now = Date.now()
    if (dedup != null) {
      const hit = dedup.check(args.chat_id, undefined, args.text, now)
      if (hit != null) {
        dedupSuppressed++
        return null
      }
    }
    const result = (await inner.bot.api.sendMessage(args.chat_id, args.text, {
      parse_mode: args.parse_mode ?? 'HTML',
    })) as { message_id: number }
    if (dedup != null) {
      dedup.record(args.chat_id, undefined, args.text, Date.now())
    }
    return result.message_id
  }

  async function simulateRetryDup(args: {
    chat_id: string
    text: string
  }): Promise<{
    firstMessageId: number | null
    suppressedSecond: boolean
    flushRan: boolean
  }> {
    if (dedup == null) {
      throw new Error(
        'simulateRetryDup requires withDedup: true on createRealGatewayHarness',
      )
    }
    const firstMessageId = await send(args)

    // Bridge cycle with a REGISTERED agent so flushOnAgentDisconnect
    // actually runs. Anonymous disconnects no-op (I1) — using one
    // there would make the scenario a tautology (the bridge cycle
    // wouldn't touch state at all). Production's #546 reproducer
    // involves the claude-code bridge (registered) crashing, so the
    // registered path is the one we need to prove dedup survives.
    const flushBefore = disposeProgressDriverCalls
    const cid = bridgeConnect('agent-claude')
    bridgeDisconnect(cid)
    const flushRan = disposeProgressDriverCalls > flushBefore

    const suppressedBefore = dedupSuppressed
    const secondMessageId = await send(args)
    const suppressedSecond = dedupSuppressed > suppressedBefore && secondMessageId == null

    return { firstMessageId, suppressedSecond, flushRan }
  }

  // ─── IPC + bridge lifecycle simulation ────────────────────────────────
  // The harness wires `bridgeDisconnect` through the REAL production
  // helper `flushOnAgentDisconnect` from `gateway/disconnect-flush.ts`
  // (extracted in PR #600). Tests against this harness exercise actual
  // production code, not a parallel reimplementation — so the I1/I2
  // invariants would catch a regression if someone reverted the
  // `if (agentName == null) return false` gate in the helper.
  //
  // Per-agent state mirrors what `gateway.ts` holds at module scope:
  // `activeStatusReactions` keyed by agent name. Each registered agent
  // gets a fresh per-agent controller; the production helper mutates
  // the Map in place when an agent disconnects.
  //
  // The shared `inner.controller` (from waiting-ux-harness) stays as
  // the default for back-compat with tests that don't go through the
  // bridge surface — `bridgeConnect(null)` doesn't touch it either.
  const clientsById = new Map<string, { agentName: string | null }>()
  // Production-shaped Maps for the helper. Keyed by agent name (one
  // entry per registered agent in the harness; production keys by
  // chat:thread:msgId but the helper's behavior is per-entry-iteration
  // either way, so the key shape doesn't change semantics).
  const activeStatusReactions = new Map<string, StatusReactionController>()
  const activeReactionMsgIds = new Map<string, { chatId: string; messageId: number }>()
  const activeTurnStartedAt = new Map<string, number>()
  const activeDraftStreams = new Map<string, { isFinal: () => boolean; finalize: () => Promise<void> }>()
  const activeDraftParseModes = new Map<string, 'HTML' | 'MarkdownV2' | undefined>()
  let clearActiveReactionsCalls = 0
  let disposeProgressDriverCalls = 0
  const flushLog: string[] = []
  const ipcLog: Array<{ kind: 'invalid' | 'unknown' | 'accepted'; raw: unknown }> = []

  function bridgeConnect(agentName: string | null): string {
    const clientId = `client-${Math.random().toString(36).slice(2, 10)}`
    clientsById.set(clientId, { agentName })
    if (agentName != null) {
      // Validate the synthetic register message through the real validator.
      const reg = { type: 'register', agentName }
      if (!validateClientMessage(reg)) {
        // Should never happen with a sane agentName — surface loudly.
        throw new Error(`harness bug: register validation failed for ${agentName}`)
      }
      // Per-agent controller mirrors what gateway.ts puts in
      // `activeStatusReactions.set(key, ctrl)`. The production helper
      // iterates the Map and calls setDone on each entry; per-agent
      // isolation comes from the helper's `agentName == null` gate
      // (anonymous = skip everything) — NOT from selective deletion.
      const ctrl = new StatusReactionController(
        async () => { /* harness uses inner.controller for the shared chat */ },
        opts.allowedReactions ?? null,
        { debounceMs: opts.debounceMs ?? 700 },
      )
      activeStatusReactions.set(agentName, ctrl)
    }
    return clientId
  }

  function bridgeDisconnect(clientId: string): void {
    const meta = clientsById.get(clientId)
    if (meta == null) return
    clientsById.delete(clientId)

    // I1 + I2 contract: route through the REAL production helper.
    // `agentName == null` ⇒ helper's anonymous-skip gate fires and the
    // Map is untouched. `agentName != null` ⇒ helper iterates the Map
    // and flushes setDone on every entry. The Map keys mean: in the
    // I1 test, ANY remaining controller would prove the gate was
    // bypassed; in the I2 test, the Map will have entries for OTHER
    // agents that get incorrectly cleared if the helper is buggy.
    flushOnAgentDisconnect({
      agentName: meta.agentName,
      activeStatusReactions,
      activeReactionMsgIds,
      activeTurnStartedAt,
      activeDraftStreams,
      activeDraftParseModes,
      clearActiveReactions: () => { clearActiveReactionsCalls++ },
      disposeProgressDriver: () => { disposeProgressDriverCalls++ },
      log: (msg) => { flushLog.push(msg) },
    })
  }

  /** Test introspection — counts of side-effect callbacks fired by the helper. */
  function flushSideEffects(): {
    clearActiveReactionsCalls: number
    disposeProgressDriverCalls: number
    flushLog: ReadonlyArray<string>
    activeAgentCount: number
  } {
    return {
      clearActiveReactionsCalls,
      disposeProgressDriverCalls,
      flushLog,
      activeAgentCount: activeStatusReactions.size,
    }
  }

  function sendIpcMessage(clientId: string, message: object): void {
    if (!clientsById.has(clientId)) {
      throw new Error(`harness: unknown clientId ${clientId} (was bridgeConnect called?)`)
    }
    // I4: legacy IPC types must be tolerated — the validator returns
    // false, processBuffer logs+continues, the connection stays open.
    // The harness records the outcome so tests can assert "logged and
    // discarded, not thrown."
    if (!validateClientMessage(message)) {
      ipcLog.push({ kind: 'invalid', raw: message })
      return
    }
    // Validated messages would normally route to the gateway's
    // per-type handler. The harness doesn't replay every dispatch —
    // tests that exercise the full session-event path use
    // `feedSessionEvent` directly. This helper exists to exercise the
    // VALIDATOR boundary, which is where the lethality lives.
    ipcLog.push({ kind: 'accepted', raw: message })
  }

  return {
    ...inner,
    inbound,
    feedSessionEvent,
    finalize,
    coalescer,
    coalesceBufferSize: () => coalescer.size(),
    gapMs,
    expectNoPlaceholderEdits,
    expectNoCardSent,
    anchorMessageCount,
    firstAnswerTextMs,
    bridgeConnect,
    bridgeDisconnect,
    sendIpcMessage,
    lastReactionEmojiAt,
    lastAnswerTextDeliveredAt,
    flushSideEffects,
    streamReply,
    dedup,
    dedupSuppressedCount: () => dedupSuppressed,
    simulateRetryDup,
    send,
  }
}
