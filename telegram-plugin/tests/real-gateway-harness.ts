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
import { StatusReactionController } from '../status-reactions.js'

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

  // ─── IPC + bridge lifecycle simulation ────────────────────────────────
  // Per-agent state for the I2 (per-agent disconnect isolation)
  // invariant. The harness exposes `inner.controller` (shared default)
  // for back-compat, but tests using `bridgeConnect(name)` get a
  // fresh per-agent controller that bridgeDisconnect() can flush in
  // isolation. State mirrors what gateway.ts holds at module scope:
  //
  //   activeStatusReactions  → controller per agent
  //   activeDraftStreams     → cleanup callback per agent
  //
  // The mirror of onClientDisconnected lives in the closure below. It
  // intentionally matches the production semantics of gateway.ts:1609
  // (snapshot taken from upstream/main 2026-05-03). When PR #600 lands
  // the extracted `disconnect-flush.ts` helper, swap the inline mirror
  // for a direct import — the assertion shape stays the same.
  interface AgentState {
    agentName: string
    controller: StatusReactionController
    onDisconnect: () => void
  }
  const clientsById = new Map<string, { agentName: string | null }>()
  const agentState = new Map<string, AgentState>()
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
      // Per-agent controller mirrors `activeStatusReactions.get(key)` in
      // gateway.ts. Each agent's reactions emit through the same fake
      // bot.api so the recorder sees them, but a per-agent disconnect
      // only flushes its own controller — that's the I2 invariant.
      const ctrl = new StatusReactionController(
        async () => { /* harness uses inner.controller for the shared chat */ },
        opts.allowedReactions ?? null,
        { debounceMs: opts.debounceMs ?? 700 },
      )
      agentState.set(agentName, {
        agentName,
        controller: ctrl,
        onDisconnect: () => {
          // Mirror of gateway.ts:1612-1618: flush this agent's
          // controller to setDone, then drop the entry. Other agents'
          // controllers are untouched (I2).
          ctrl.setDone()
          agentState.delete(agentName)
        },
      })
    }
    return clientId
  }

  function bridgeDisconnect(clientId: string): void {
    const meta = clientsById.get(clientId)
    if (meta == null) return
    clientsById.delete(clientId)

    // CRITICAL: anonymous clients (agentName == null) MUST NOT mutate
    // any state. This is the I1 invariant (Bug A's failure mode). The
    // production hotfix in PR #600 gates the flush block on
    // `client.agentName != null`. Until #600 merges, we encode the
    // correct semantics here so the test can pin the desired behavior.
    if (meta.agentName == null) {
      // No-op — log only.
      return
    }
    const st = agentState.get(meta.agentName)
    if (st == null) return
    st.onDisconnect()
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
    firstAnswerTextMs,
    bridgeConnect,
    bridgeDisconnect,
    sendIpcMessage,
    lastReactionEmojiAt,
    lastAnswerTextDeliveredAt,
  }
}
