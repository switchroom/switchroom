// ─────────────────────────────────────────────────────────────────────────
// Stream / render dispatcher — the `handleSessionEvent` switch, relocated
// VERBATIM from gateway.ts (switchroom#2996 P4-A, plan Amendments 1/5/9/10).
//
// WHAT THIS IS
// -----------
// `handleSessionEvent` is the giant per-session-event switch that drives every
// live surface (progress card, answer stream, activity/liveness lanes, turn
// lifecycle, silent-end recovery). It was ~1,970 inline lines in gateway.ts;
// this module holds the body so the file drains toward its ratchet ceiling.
//
// DI CONTRACT (plan Amendment 1/5/9 — read before editing)
// ---------------------------------------------------------
//   - The body is BYTE-IDENTICAL to the pre-move gateway.ts inline body except
//     for the enumerated turn/mutable-state spellings below and the deps
//     destructure preamble. Do NOT "clean up" while moving — behavior-changing
//     work ships as SEPARATE PRs (plan §1).
//   - SHARED SINGLETONS (Amendment 1, BLOCKING): `outboundDedup` and
//     `backstopDeliveryLedger` are injected — THE one live instance each. The
//     answer-stream dedup sites in this module record into the SAME
//     `OutboundDedupCache` that P2's `sendReply` checks; a re-`new` here would
//     reinstate the cross-surface duplicate-reply class. This file NEVER
//     re-constructs the dedup cache or the delivery ledger — the golden
//     harness pins that (send-reply-golden + stream-render-golden).
//   - TURN HANDLE (Amendment 9 / #1664): the module NEVER reads the
//     `currentTurn` module global directly. Every live re-read is routed
//     through the injected `getCurrentTurn()` accessor, preserving each call
//     site's pin-vs-live choice VERBATIM (a `const turn = currentTurn` pin
//     becomes `const turn = getCurrentTurn()`; a late `currentTurn === turn`
//     liveness check stays live via `getCurrentTurn() === turn`). Writes to the
//     turn go through the injected `setCurrentTurn` closure, exactly as before.
//   - Two other reassigned module-globals are routed through get/set accessors
//     so the extracted body cannot fork gateway state: `pendingPtyPartial`
//     (`getPendingPtyPartial()`/`setPendingPtyPartial()`) and
//     `lastContextExhaustionWarningAt`
//     (`getLastContextExhaustionWarningAt()`/`setLastContextExhaustionWarningAt()`).
//     One PTY-partial guard is spelled "capture-once-then-guard" (a call
//     expression can't be narrowed like the pre-move variable was) — provably
//     equivalent (no await/mutation between the two reads), flagged inline.
//   - Pure / leaf-module helpers are IMPORTED (same modules gateway.ts imports
//     them from — ES modules are singletons, so the ambient trackers
//     `pendingProgress` / `signalTracker` / `silencePoke` are the SAME
//     instances). Everything gateway-scoped (state singletons, config values,
//     local closures, `bot`, `turnsDb`) is INJECTED via `StreamRenderDeps`.
//
// ORACLE (Amendment 10): gateway.ts cannot be driven in-place from a test
// runner (`handleSessionEvent` was unexported; `bot` is assigned only inside
// the isGatewayMain boot). Behavior preservation rests on (a) the verbatim
// relocation, (b) the deps type being `ReturnType<typeof gatewayStreamRenderDeps>`
// (exact-by-construction — the gateway wiring IS the type), and (c) the
// extracted-module golden harness (tests/stream-render-golden.test.ts) driving
// this function against a fake bot recorder + the REAL OutboundDedupCache,
// including the cross-surface stream-then-reply dedup proof spanning P2+P4.
// ─────────────────────────────────────────────────────────────────────────

import { createAnswerStream } from '../answer-stream.js'
import { LivenessTracker, isContextExhaustionText } from '../context-exhaustion.js'
import { normalizeOutboundBody } from './outbound-send-path.js'
import { resolveEnvTimezone } from '../shared/local-time.js'
import { hasOutboundDeliveredSince, recordOutbound } from '../history.js'
import { isReplyTool } from '../narrative-dedup.js'
import { isEphemeralTool } from '../hooks/narration-classify.mjs'
import { backstopAlreadyDelivered } from '../outbox.js'
import { journalExternalDelivery } from './outbox-sweep.js'
import { NarrativeFlushController } from '../narrative-flush.js'
import { recordTurnEnd, recordTurnStart } from '../registry/turns-schema.js'
import { stampSubagentDispatchTurn } from '../registry/subagents-schema.js'
import { retryWithThreadFallback } from '../retry-api-call.js'
import { richMessage } from '../rich-send.js'
import { emitRuntimeMetric } from '../runtime-metrics.js'
import { isShownBlock } from '../shown-ledger.js'
import { CAPTURED_PROSE_MIN_CHARS, clearSilentEndState, decideCapturedProseDelivery, recordUndeliveredTurnEnd, silentEndFallbackText, writeSilentEndState } from '../silent-end.js'
import { logStreamingEvent } from '../streaming-metrics.js'
import { appendActivityLabel } from '../tool-activity-summary.js'
import { isTelegramReplyTool, isTelegramSurfaceTool } from '../tool-names.js'
import { decideTurnFlush } from '../turn-flush-safety.js'
import { FlushCompletionTracker } from '../flushed-turn-supersede.js'
import { subagentReplyAuthority } from './subagent-reply-authority.js'
import { sessionConsumeSignal } from './session-consume-signal.js'
import { decideTerminalReason, deriveTurnRole } from '../turn-liveness-floor.js'
import { parseChannelOrigin, isBuzzTurnRoutingEnabled } from './channel-route.js'
import { chatKey, chatKeyWithSuffix } from './chat-key.js'
import { deriveTurnId } from './derive-turn-id.js'
import { EMISSION_AUTHORITY_ENABLED, EmissionAuthority } from './emission-authority.js'
import { decideFeedReopen } from './feed-reopen-gate.js'
import { ackDelivery } from './inbound-delivery-confirm.js'
import { shadowEmit } from './inbound-delivery-machine-shadow.js'
import { parseSourceMessageId } from './source-message-id.js'
import { formatTurnLifecycle } from './status-surface-log.js'
import { removeTurnActiveMarker, touchTurnActiveMarker, writeTurnActiveMarker } from './turn-active-marker.js'
import { withTurnEndGateBackstop } from './turn-end-gate-backstop.js'
import { decideTurnEndGate } from './turn-end-gate.js'
import { finalizeBackstopSendGated, computeTurnDurationMs } from './turn-record-status.js'
import type { SilentEndDeps } from '../silent-end.js'
import type { ChatKey as _ChatKey } from './inbound-delivery-machine.js'
import type { SessionEvent } from '../session-tail.js'
import type { CurrentTurn, StreamRenderDeps } from './gateway.js'
import * as pendingProgress from '../pending-work-progress.js'
import * as signalTracker from '../turn-signal-tracker.js'
import * as silencePoke from '../silence-poke.js'


// ─── #3927: parked turn starts (FIX A) ────────────────────────────────────
//
// An `enqueue` transcript record is a QUEUE event, NOT a turn-start event. The
// claude CLI writes it the moment a message lands on the queue, whether or not
// a turn is already running. Ground truth from real transcripts (60 agent
// sessions, 372 enqueues): every enqueue is terminated by exactly ONE of
//
//   • `dequeue` — the queue was drained into a NEW user turn. Always the
//     immediately-preceding enqueue's terminal (199/200 dequeues are directly
//     preceded by an enqueue); median gap 6 ms when the session was idle, but
//     2–14 s when the message sat behind a running turn. THIS is turn start.
//   • `remove`  — the queued item was folded into the ALREADY-RUNNING turn as a
//     `queued_command` attachment. No new turn exists, and none ever will for
//     that message. 161/372, and its `content` is byte-identical to its
//     enqueue's (13/13 exact matches in the carrie session, 160/161 fleet-wide).
//
// Treating `enqueue` as turn start therefore minted a brand-new `CurrentTurn`
// on top of a live one, which (a) froze the running turn's card and opened a
// fresh one with reset stats, and (b) quoted the just-queued message on a card
// that then streamed the STILL-RUNNING previous work into it.
//
// So: park the envelope while a turn is live and mint on the CLI's own
// turn-start signal instead. Ordering is LIFO by evidence, not FIFO —
// `dequeue` pairs with the MOST RECENT enqueue (max observed gap to the newest
// parked envelope: 14.2 s; the gap to the oldest ran to hours). Popping the
// oldest would mint a stale, long-since-folded message.
//
// BOUNDS (a parked envelope must never live forever — a `dequeue` that never
// arrives, e.g. because the CLI died mid-turn, must not wedge the lane):
//   • PARKED_TURN_START_MAX caps the store; the OLDEST is evicted on overflow
//     (the newest message is the one the user is waiting on). An evicted
//     envelope still reaches the model — the CLI owns the real queue — it just
//     loses its own progress card.
//   • PARKED_TURN_START_TTL_MS prunes on every touch, so a stale envelope can
//     never be minted as a spurious turn later.
const PARKED_TURN_START_MAX = 16
const PARKED_TURN_START_TTL_MS = 30 * 60_000

// ─── Queued-turn card (#3927 follow-up) ──────────────────────────────────────
// Since #3927 a genuinely-queued mid-turn message is parked with NO surface at
// all until it dequeues — the user gets silence between sending and the turn
// starting. We post an immediate, clearly-marked "queued" card at park time,
// reply-anchored to the parked message, and store its id on the envelope. On
// dequeue → `beginTurn` seeds it as the turn's `activityMessageId` (mirroring
// the handback-card adoption) so the SAME card is EDITED IN PLACE into the live
// progress card — one lifecycle, finalized by the normal turn end. A `remove`
// (folded into the running turn) or a TTL expiry finalizes it so it never
// freezes. Kill switch: SWITCHROOM_QUEUED_CARD=0.
const QUEUED_CARD_ENABLED = process.env.SWITCHROOM_QUEUED_CARD !== '0'
const QUEUED_CARD_HTML = '⏳ Queued — waiting for the current task to finish…'
const QUEUED_CARD_FOLDED_HTML = '✅ Folded into the current task.'
const QUEUED_CARD_EXPIRED_HTML = '⚠️ This queued message timed out before it could start.'

// Buzz co-channel — Phase 2a origin stamp gate (Finding 10). The per-turn
// `parseChannelOrigin` call is invoked ONLY when BOTH hold:
//   · BUZZ_ENABLED — the per-agent projection `src/agents/compose.ts` sets in
//     the container env ONLY when `channels.buzz.enabled === true`; absent for
//     every Telegram-only agent.
//   · SWITCHROOM_BUZZ_TURN_ROUTING !== '0' — the Phase 2a kill switch.
// When either is off, the ctor stamps a plain Telegram origin without ever
// calling the parser, so the Telegram-only hot path is byte-for-byte unchanged.
const BUZZ_ENABLED = process.env.BUZZ_ENABLED === '1' || process.env.BUZZ_ENABLED === 'true'
const BUZZ_ORIGIN_STAMP_ACTIVE = BUZZ_ENABLED && isBuzzTurnRoutingEnabled()

/** The `enqueue` envelope fields `beginTurn` needs — the SessionEvent minus its
 *  discriminant. A parked entry additionally carries `parkedAt` for the TTL. */
export interface TurnStartEnvelope {
  chatId: string | null
  messageId: string | null
  threadId: string | null
  rawContent: string
  /** Message id of the "queued" card posted at park time (Part B). Seeded as the
   *  turn's `activityMessageId` on dequeue so the card is edited in place into
   *  the live progress card. Absent on the idle-mint path (no parking, no card). */
  queuedCardMessageId?: number | null
}
interface ParkedTurnStart extends TurnStartEnvelope {
  parkedAt: number
}

/** Arrival-ordered (oldest first). Module-scope by design: it mirrors the ONE
 *  claude CLI session's ONE queue, exactly like the `currentTurn` mirror. */
const parkedTurnStarts: ParkedTurnStart[] = []

/** `onDrop` (Part B) fires for every removed entry so the caller can finalize a
 *  posted queued card. Best-effort — never throws into the prune loop. */
function pruneParkedTurnStarts(now: number, onDrop?: (entry: ParkedTurnStart) => void): void {
  for (let i = parkedTurnStarts.length - 1; i >= 0; i--) {
    if (now - parkedTurnStarts[i].parkedAt > PARKED_TURN_START_TTL_MS) {
      const [dropped] = parkedTurnStarts.splice(i, 1)
      process.stderr.write(
        `telegram gateway: parked-turn-start expired chat=${dropped.chatId ?? '-'} ` +
          `msg=${dropped.messageId ?? '-'} age_ms=${now - dropped.parkedAt}\n`,
      )
      try { onDrop?.(dropped) } catch { /* never let card cleanup break the prune */ }
    }
  }
}

/** Returns the freshly-parked entry so the caller can attach a queued-card id to
 *  it asynchronously. `onEvict` (Part B) fires for a cap-evicted entry. */
function parkTurnStart(
  env: TurnStartEnvelope,
  now: number,
  onEvict?: (entry: ParkedTurnStart) => void,
): ParkedTurnStart {
  const entry: ParkedTurnStart = { ...env, parkedAt: now }
  parkedTurnStarts.push(entry)
  while (parkedTurnStarts.length > PARKED_TURN_START_MAX) {
    const [dropped] = parkedTurnStarts.splice(0, 1)
    process.stderr.write(
      `telegram gateway: parked-turn-start evicted (cap ${PARKED_TURN_START_MAX}) ` +
        `chat=${dropped.chatId ?? '-'} msg=${dropped.messageId ?? '-'}\n`,
    )
    try { onEvict?.(dropped) } catch { /* never let card cleanup break parking */ }
  }
  return entry
}

/** Pop the MOST RECENTLY parked envelope — the one a `dequeue` pairs with. */
function takeParkedTurnStart(): ParkedTurnStart | null {
  return parkedTurnStarts.pop() ?? null
}

/** Drop the parked envelope a `remove` names (byte-identical `content`), newest
 *  match first. A `remove` means "folded into the running turn" — that message
 *  will never get a turn of its own, so leaving it parked would let a LATER
 *  `dequeue` mint a spurious turn for an already-answered message. */
function discardParkedTurnStart(rawContent: string): ParkedTurnStart | null {
  for (let i = parkedTurnStarts.length - 1; i >= 0; i--) {
    if (parkedTurnStarts[i].rawContent === rawContent) {
      const [dropped] = parkedTurnStarts.splice(i, 1)
      return dropped
    }
  }
  return null
}

/**
 * #4173 — the ONE turn-completion tracker for flush-ended turns (module-scope
 * like `parkedTurnStarts`: one CLI session per gateway process). The
 * quiescence flush ends a turn SYNTHETICALLY while the claude session is still
 * composing; this holds that turn's atom pending until the session's REAL
 * turn_end (or a proxy: a new turn minting, the bridge dying) is observed,
 * then stamps `realEndObservedAt` — the signal that flips the supersede
 * machinery from the unbounded OPEN phase to the ~60 s replay grace. See the
 * `flushed-turn-supersede.ts` module header for the full three-phase model.
 */
export const flushCompletionTracker = new FlushCompletionTracker()

/**
 * #4173 — a turn-completion signal was observed: close every open flush
 * window. Stamps the pending atoms (`flushCompletionTracker`) AND starts the
 * replay grace on the registry's records (`completeAll`) in one call, so the
 * two surfaces (latest-ended owner tier / supersede record) can never observe
 * different phases. Called from the real-turn_end path, the new-turn mint, and
 * the gateway's bridge-death sweep. Returns how many atom windows closed.
 */
export function closeFlushCompletionWindows(
  // Optional-shaped on purpose: several test harnesses drive `beginTurn` /
  // `handleSessionEvent` with a partial deps object that carries no supersede
  // registry. The production deps builder always injects the real one.
  registry: { completeAll?: (now: number) => void } | null | undefined,
  now: number,
): number {
  const closed = flushCompletionTracker.closeAll(now)
  registry?.completeAll?.(now)
  return closed
}

/** Test seam: the parked store is module-scope (one CLI session, one queue), so
 *  suites that drive `handleSessionEvent` need a deterministic reset. */
export function __resetParkedTurnStartsForTest(): void {
  parkedTurnStarts.length = 0
}
/** Test seam: parked-envelope count (bound / eviction assertions). */
export function __parkedTurnStartCountForTest(): number {
  return parkedTurnStarts.length
}
/**
 * Production accessor for the parked-turn-start count — the second half of the
 * stream-render "session busy" signal (the first being a live `currentTurn`
 * whose `endedAt == null`). A parked turn-start means the CLI has an enqueued
 * message it is about to turn on, so the session is NOT idle even when the
 * gateway's machine-turn gate (`turnInFlightForGate`) reads clear — the exact
 * disagreement a ~5-min silence poke opens (it clears the machine turn while the
 * CLI is still producing the answer). The obligation sweep and the idle-drain
 * consult this so they do not treat a poke-cleared-but-busy session as idle.
 */
export function parkedTurnStartCount(): number {
  return parkedTurnStarts.length
}

/**
 * Silence-fallback unwedge for the parked store (the two-state desync fix).
 *
 * The park gate in `case 'enqueue'` treats the session as busy while EITHER a
 * live `currentTurn` exists OR `parkedTurnStarts` is non-empty. The 300 s
 * framework-fallback (`liveness-wiring.ts` onFrameworkFallback) that recovers a
 * hung turn nulls `currentTurn` and redelivers `pendingInboundBuffer` — but
 * before this it NEVER touched `parkedTurnStarts`. When the claude REPL hangs
 * mid-turn the CLI's own `dequeue` / `remove` events (the only real drains of
 * this store) never arrive, so a leftover parked envelope latches the busy gate
 * permanently and every later inbound parks unseen until a manual container
 * restart (gymbro parked msgs 4502→4504 behind a dead lock until SIGTERM). The
 * `drained_buffered=0/0` fallback log was honest-but-misleading: it counted the
 * empty `pendingInboundBuffer`, not this store, where the real messages sat.
 *
 * This drains the parked envelopes for ONE chat/thread — scoped, never global,
 * so a fallback fired for chat A cannot release chat B's queued messages — and
 * hands each back into turn processing through the EXACT `beginTurn` path a real
 * `dequeue` uses. Envelopes are re-begun in arrival order (oldest first) so the
 * NEWEST, the message the user is actually waiting on, ends up the live turn and
 * the older ones are cleanly superseded (never silently dropped). The store is
 * kept module-encapsulated: callers get a function, not the array. Returns the
 * drained envelopes so the caller can log an honest count. Idempotent w.r.t. a
 * late CLI event: once drained, a subsequent `dequeue` finds an empty store and
 * `takeParkedTurnStart` returns null, so a message can never be double-started.
 */
export function drainParkedTurnStartsForChat(
  deps: StreamRenderDeps,
  chatId: string | null,
  threadId: string | null,
): TurnStartEnvelope[] {
  const wantThread = envThreadIdNum(threadId)
  const drained: ParkedTurnStart[] = []
  // Splice out the matching entries, preserving arrival order (oldest first).
  for (let i = 0; i < parkedTurnStarts.length; ) {
    const entry = parkedTurnStarts[i]!
    if (entry.chatId === chatId && envThreadIdNum(entry.threadId) === wantThread) {
      drained.push(entry)
      parkedTurnStarts.splice(i, 1)
    } else {
      i++
    }
  }
  for (const env of drained) {
    process.stderr.write(
      `telegram gateway: parked-turn-start drained on silence-fallback ` +
        `chat=${env.chatId ?? '-'} thread=${envThreadIdNum(env.threadId) ?? '-'} ` +
        `msg=${env.messageId ?? '-'}\n`,
    )
    // Reuse the dequeue turn-start path verbatim — beginTurn adopts the parked
    // envelope's queued card (Part B) so the frozen "⏳ Queued" surface becomes
    // the live progress card rather than lingering.
    beginTurn(deps, env)
  }
  return drained
}

// ─── Queued-turn card send / finalize (Part B) ───────────────────────────────
// These use the ALREADY-injected `bot` + `robustApiCall` deps, so the whole
// feature lives in stream-render.ts with zero new wiring in gateway.ts. No
// streaming is structurally possible before dequeue (no CurrentTurn exists),
// so this card is a single static line until the turn adopts + edits it.

/** Minimal deps the queued-card helpers need. */
type QueuedCardDeps = Pick<StreamRenderDeps, 'bot' | 'robustApiCall'>

/** Post the "queued" card, reply-anchored to the parked message. Resolves to the
 *  sent message id, or null when the send failed / was suppressed (best-effort —
 *  a null just means no card, so nothing to adopt or finalize). Forum topics use
 *  the envelope's OWN thread id. */
async function openQueuedCard(
  deps: QueuedCardDeps,
  chatId: string,
  threadId: number | null,
  replyToMessageId: number | null,
): Promise<number | null> {
  try {
    const sent = await deps.robustApiCall(
      // allow-raw-bot-api: sendRichMessage routed through robustApiCall (not in the THREAD_NOT_FOUND blast pattern)
      () =>
        deps.bot.api.sendRichMessage(chatId, richMessage(QUEUED_CARD_HTML), {
          ...(threadId != null ? { message_thread_id: threadId } : {}),
          ...(replyToMessageId != null
            ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
            : {}),
          // Status surface, not the user's answer — never ping the device.
          disable_notification: true,
        }),
      {
        chat_id: chatId,
        ...(threadId != null ? { threadId } : {}),
        verb: 'queued-card.send',
      },
    )
    return sent?.message_id ?? null
  } catch (err) {
    process.stderr.write(
      `telegram gateway: queued card send failed: ${(err as Error).message}\n`,
    )
    return null
  }
}

/** Finalize (single honest edit) a queued card that will NOT become a live turn:
 *  folded into the running turn (`remove`) or timed out (TTL). Best-effort. */
function finalizeQueuedCard(
  deps: QueuedCardDeps,
  chatId: string,
  threadId: number | null,
  messageId: number,
  html: string,
): void {
  void deps
    .robustApiCall(
      // allow-raw-bot-api: editMessageText routed through robustApiCall
      () => deps.bot.api.editMessageText(chatId, messageId, richMessage(html), {}),
      {
        chat_id: chatId,
        ...(threadId != null ? { threadId } : {}),
        verb: 'queued-card.finalize',
      },
    )
    .catch(() => undefined)
}

/** Delete a queued card that lost its race (the entry left the store before its
 *  card id was stored, so `beginTurn` couldn't adopt it — a fresh progress card
 *  will open instead). Best-effort. */
function deleteQueuedCard(
  deps: QueuedCardDeps,
  chatId: string,
  messageId: number,
): void {
  void deps
    .robustApiCall(
      // allow-raw-bot-api: deleteMessage routed through robustApiCall
      () => deps.bot.api.deleteMessage(chatId, messageId),
      { chat_id: chatId, verb: 'queued-card.delete-orphan' },
    )
    .catch(() => undefined)
}

/** Numeric thread id from an envelope's string thread id (null/invalid → null). */
function envThreadIdNum(threadId: string | null): number | null {
  if (threadId == null) return null
  const n = Number(threadId)
  return Number.isFinite(n) ? n : null
}

/** Finalize a queued card carried by a parked entry that is being dropped
 *  (folded via `remove`, cap-evicted, or TTL-expired). No-op when the entry
 *  never got a card. */
function finalizeParkedEntryCard(
  deps: QueuedCardDeps,
  entry: ParkedTurnStart,
  html: string,
): void {
  if (!QUEUED_CARD_ENABLED) return
  if (entry.queuedCardMessageId == null || entry.chatId == null) return
  finalizeQueuedCard(deps, entry.chatId, envThreadIdNum(entry.threadId), entry.queuedCardMessageId, html)
}

/**
 * Mint the turn atom and open its surfaces. This is the ENTIRE pre-#3927
 * `case 'enqueue'` body, relocated verbatim except for (a) the hoisted
 * `ackDelivery` call (which acks RECEIPT and therefore stayed on the enqueue
 * event) and (b) the FIX B supersession finalizer. Called from `enqueue` only
 * when the session is idle, and otherwise from `dequeue`.
 */
function beginTurn(deps: StreamRenderDeps, ev: TurnStartEnvelope): void {
  const {
    HANDBACK_PRETURN_ENABLED,
    STATE_DIR,
    clearActivitySummary,
    extractUserPromptPreview,
    getCurrentTurn,
    getPendingPtyPartial,
    handbackPreturnSignal,
    handlePtyPartial,
    isDmChatId,
    makeNarrativeGate,
    pendingCrossTurnGate,
    preambleSuppressor,
    promoteQueuedStatus,
    rememberRecentTurn,
    scheduleEarlyLivenessOpen,
    setCurrentTurn,
    setPendingPtyPartial,
    startTurnTypingLoop,
    statusKey,
    turnsDb,
    typingWrapper,
  } = deps
  // Drain any orphaned typing-wrap entries left over from a crashed
  // prior turn before resetting focus.
  typingWrapper.drainAll()
  if (ev.chatId) {
    // #1445 cross-turn pending-async ambient — backstop for the
    // `handleInbound` path's `clearPending('inbound')`. The
    // inbound path covers real user messages, but synthesised
    // wakes (subagent-handback channel turn, cron fires, vault
    // grant resumes, restart markers) push directly to
    // `pendingInboundBuffer` and bypass `handleInbound`. The
    // `enqueue` session-event fires for EVERY fresh turn atom
    // regardless of source — clearing here drops any prior turn's
    // ambient before the new turn's `noteOutbound` lands. The
    // call is idempotent so it's safe to fire in addition to the
    // inbound-path clear (for the real-inbound case, this is a
    // no-op because state was already deleted by then).
    const enqThreadId = ev.threadId != null ? Number(ev.threadId) : undefined
    pendingProgress.clearPending(
      statusKey(ev.chatId, enqThreadId),
      'handback',
    )
  }
  if (ev.chatId) {
    // Issue #195: if a previous turn left an answer-lane stream open
    // (rapid steer/queue), force it to a new generation so its in-flight
    // edits don't mutate the new turn's message. Materialize is best-effort
    // — we don't await here because turn_end on the prior turn should
    // have already done it; this is a defensive supersession guard.
    const prior = getCurrentTurn()
    if (prior?.answerStream != null) {
      prior.answerStream.forceNewMessage()
      prior.answerStream.stop()
      prior.answerStream = null
    }
    // Bounded-leak hardening (A5): clear the prior turn's orphaned-reply
    // fuse before it is superseded. The fire callback re-reads currentTurn
    // and no-ops on a stale turn, but proactively clearing the timer avoids
    // a bounded pile-up of dangling timers across rapid steer/queue turns.
    if (prior?.orphanedReplyTimeoutId != null) {
      clearTimeout(prior.orphanedReplyTimeoutId)
      prior.orphanedReplyTimeoutId = null
    }
    // Same bounded-leak class (early-paint 250ms setTimeout): the prior
    // turn may have armed its narrative gate's early-paint timer before
    // being superseded. Left untorn, ~250ms later it fires showNarrativeStep
    // on the dead turn and can paint a stale narration card below the new
    // turn's surface. Teardown is guard-safe and idempotent (no-op when never
    // armed / already fired / already disarmed by the prior turn's turn_end).
    prior?.narrativeGate?.teardown()
    // FIX B (#3927) — NEVER ORPHAN A SUPERSEDED CARD. Reaching here means a
    // fresh turn is being minted while `prior` is still the live turn atom.
    // After FIX A that is rare (a real inbound now parks instead of
    // preempting), but it is still reachable: a turn whose `turn_end` was
    // never observed (bridge death, transcript gap, an unclean restart)
    // leaves a live-looking atom in the slot, and the next genuine
    // dequeue-driven turn start must not inherit its surfaces. Pre-fix, the
    // teardown above dropped the answer stream, the orphaned-reply fuse and
    // the narrative gate but NEVER touched the activity card — so the card
    // froze on its last landed edit, kept the `fg:<statusKey>` status pin
    // forever, and left NO `turn-lifecycle clear` line to explain it (carrie
    // 2026-07-28, turn `-1004444444444:_#1078`). `clearActivitySummary`
    // finalizes/deletes the card AND releases the pin; it is idempotent and
    // no-ops when the turn never opened a card.
    // `endedAt == null` narrows this to a turn that never ended: a turn that
    // ended normally already ran its own `clearActivitySummary` + `clear`
    // log, and `endCurrentTurnAtomic` nulls the mirror, so this is a
    // belt-and-braces guard against double-finalizing / double-logging.
    if (prior != null && prior.endedAt == null) {
      clearActivitySummary(prior)
      // The missing breadcrumb: a clobber must never again be invisible.
      // Same field format as every other `turn-lifecycle clear`.
      process.stderr.write(
        `telegram gateway: ${formatTurnLifecycle('clear', 'superseded', prior, Date.now())}\n`,
      )
    }
    // #1067: swap the entire turn atom in one assignment. Every
    // handler captures `const turn = currentTurn` at entry, so a
    // captured-then-awaited read can't reattribute to the new turn.
    const startedAt = Date.now()
    // Component 3 — stable per-turn identity. For a real inbound this
    // matches the `origin_turn_id` stamped into the inbound meta at
    // build time (same chat/thread/messageId). Synthetic turns (cron /
    // handback — no messageId) get a unique startedAt-based fallback id
    // that no reply will ever echo, so they correctly fall through to
    // the live-turn routing in resolveAnswerThreadId.
    const enqThreadIdNum = ev.threadId != null ? Number(ev.threadId) : undefined
    const turnId =
      deriveTurnId(ev.chatId, enqThreadIdNum ?? null, ev.messageId)
      ?? `${chatKey(ev.chatId, enqThreadIdNum ?? null)}#synthetic-${startedAt}`
    // PR1 (cross-turn stale-card guard, §9 lever 4 / race C/D). Consume any
    // pending cross-turn gate `obligationSweep` armed for THIS exact turn
    // when it pushed an `obligation_represent` inbound. The gate is keyed on
    // the obligation's `originTurnId`, and the represent inbound reuses the
    // original chat/thread/messageId, so this turn's `turnId` (derived just
    // above) equals that key iff this turn IS the represent surface armed for.
    // An unrelated foreground turn on the same chat/thread derives a
    // different `turnId` → finds no entry → no gate → its card opens normally
    // (correct). Consume-once: delete on read so the matched gate can't leak
    // forward, and a never-matched stale gate can never suppress another turn.
    const xTurnGateKey = turnId
    const consumedCrossTurnGate = pendingCrossTurnGate.get(xTurnGateKey)
    if (consumedCrossTurnGate != null) pendingCrossTurnGate.delete(xTurnGateKey)
    const next: CurrentTurn = {
      sessionChatId: ev.chatId,
      sessionThreadId: enqThreadIdNum,
      // Accept the inbound id as a reply anchor only when it is a plausible
      // Telegram message id. Synthetic boot-resume inbounds fabricate a
      // 13-digit Date.now() message_id (for ack-tracking); if that reached
      // the activity-feed reply anchor it 400'd every feed send and darkened
      // the live feed for the whole resume turn (2026-06-05). The ack-queue
      // still keys on ev.messageId independently — only the anchor is gated.
      sourceMessageId: parseSourceMessageId(ev.messageId),
      startedAt,
      gatewayReceiveAt: startedAt,
      // #2527 — stamp the loop role once, from the enqueue envelope.
      role: deriveTurnRole(ev.rawContent),
      // Buzz co-channel — Phase 2a. Stamp the immutable origin provenance once,
      // from the same enqueue envelope. Gated (Finding 10): when Buzz is off for
      // this agent (or the kill switch is set) the parser is never called and
      // the turn defaults to a plain Telegram origin — no coords, hot path
      // untouched. When active, `parseChannelOrigin` reads the outer channel
      // tag's meta-hoisted `source="buzz"` + coords (see `channel-route.ts`).
      ...(BUZZ_ORIGIN_STAMP_ACTIVE
        ? parseChannelOrigin(ev.rawContent)
        : { originChannel: 'telegram' as const }),
      // PR1 (cross-turn stale-card guard, §9 lever 4 / race C/D). Only a
      // synthetic represent/owed-reply turn carries this; a foreground turn
      // leaves it undefined and the cross-turn card-OPEN gate is inert.
      ...(consumedCrossTurnGate != null ? { crossTurnGate: consumedCrossTurnGate } : {}),
      replyCalled: false,
      finalAnswerDelivered: false,
      finalAnswerSubstantive: false,
      // Post-substantive feed-reopen counter — reset each turn.
      postSubstantiveToolLabelCount: 0,
      // Post-substantive lever-1 lift latch — reset each turn.
      postAnswerMainActivity: false,
      // Sticky latch — reset ONLY here (turn start), never by reopen.
      finalAnswerEverDelivered: false,
      // 2026-07 double-reply-on-DM fix (Part 2) — answer-delivered race
      // latch, reset at turn start alongside the other answer flags.
      answerDelivered: false,
      // #3429 — flushed-answer text for the content-vs-flush latch
      // discrimination; stamped at flush arm, reset at turn start.
      flushedAnswerText: null,
      // 2026-07 double-reply-on-DM fix (F2) — stamped at turn end.
      endedAt: null,
      // #4173 — the turn-completion signal, stamped at turn end (or later, for
      // a flush-ended turn, when the real turn_end is observed).
      realEndObservedAt: null,
      firstPingAt: null,
      // Notification ownership (R8 / PR-2): no slot claimed yet, so the
      // "claimer was substantive" flag starts false. Set atomically with
      // firstPingAt at the over-ping decision site.
      firstPingWasSubstantive: false,
      silentAnchorMessageId: null,
      silentAnchorText: '',
      capturedText: [],
      capturedBlockMeta: [],
      orphanedReplyTimeoutId: null,
      answerReadyFlushTimeoutId: null,
      // Fresh liveness tracker: lastStreamEventAt seeded to the turn start
      // so a turn that never streams still trips the fuse after windowMs.
      liveness: new LivenessTracker(startedAt),
      turnId,
      registryKey: null,
      noReplyDrainTimer: null,
      lastAssistantMsgId: null,
      lastAssistantDone: false,
      toolCallCount: 0,
      labeledToolCount: 0,
      totalTokens: 0,
      seenUsageMessageIds: new Set<string>(),
      activityMessageId: null,
      activityInFlight: null,
      activityPendingRender: null,
      activityLastSentRender: null,
      activityEverOpened: false,
      activityDrainFailures: 0,
      mirrorLines: [],
      // Assigned immediately after this literal via makeNarrativeGate(next) —
      // the controller's SHOW/RETRACT effects close over the turn object, which
      // can't reference itself inside its own initializer.
      narrativeGate: undefined as unknown as NarrativeFlushController,
      lastReplyText: '',
      foregroundSubAgents: new Map(),
      answerStream: null,
      isDm: isDmChatId(ev.chatId),
      // PR-4a — construct ONE emission-authority façade per turn, passing
      // the chat/thread key in EXPLICITLY (the PR-4e seam; today equal to
      // the singleton-sourced key). Per-turn: born with this turn literal,
      // discarded with it — never persists across turns.
      emissionAuthority: new EmissionAuthority(
        statusKey(ev.chatId, enqThreadIdNum),
      ),
    }
    // Wire the per-turn narrative gate now that `next` exists (its SHOW/RETRACT
    // effects close over the turn). Born with this turn, torn down at turn end.
    next.narrativeGate = makeNarrativeGate(next)
    // Dead-air pre-turn signal — ADOPT by inbound identity (design lever 2).
    // If a subagent-handback pre-turn signal was emitted for THIS exact turn
    // (matched on `turnId`, not the bare topic key, so a racing user inbound
    // can't mis-adopt), consume it. A card-bearing adoption seeds
    // `activityMessageId` + `activityEverOpened` so `renderActivityFeed`
    // EDITS the existing card instead of opening a second one, and so the
    // turn's own end-of-turn `clearActivitySummary` finalizes it (lever 3).
    if (HANDBACK_PRETURN_ENABLED) {
      const handbackAdoption = handbackPreturnSignal.tryAdopt(turnId)
      if (handbackAdoption != null) {
        if (handbackAdoption.activityMessageId != null) {
          next.activityMessageId = handbackAdoption.activityMessageId
          next.activityEverOpened = true
        }
        // Observability (#3544): adoption is the rare, previously-silent
        // branch — one line per adopted handback turn, not per turn.
        process.stderr.write(
          `telegram gateway: handback pre-turn adopted turnId=${turnId} ` +
            `key=${handbackAdoption.statusKey} card=${handbackAdoption.activityMessageId ?? 'none'}\n`,
        )
      }
    }
    // Part B — ADOPT the queued card. A parked envelope reaching `beginTurn`
    // (via `dequeue`) carries the id of the "queued" card posted at park time.
    // Seed it exactly as the handback adoption does so `renderActivityFeed`
    // EDITS that same message into the live progress card instead of opening a
    // second one, and the turn's own end-of-turn `clearActivitySummary`
    // finalizes it — one continuous lifecycle. Guarded on `activityMessageId`
    // still being null so a card-bearing handback adoption (mutually exclusive
    // in practice) is never clobbered.
    if (QUEUED_CARD_ENABLED && ev.queuedCardMessageId != null && next.activityMessageId == null) {
      next.activityMessageId = ev.queuedCardMessageId
      next.activityEverOpened = true
      process.stderr.write(
        `telegram gateway: queued card adopted turnId=${turnId} card=${ev.queuedCardMessageId}\n`,
      )
    } else if (
      QUEUED_CARD_ENABLED &&
      ev.queuedCardMessageId != null &&
      ev.chatId != null &&
      next.activityMessageId != null &&
      next.activityMessageId !== ev.queuedCardMessageId
    ) {
      // Part B safety net — the handback adoption above WON the surface (its card
      // is now `activityMessageId`) yet this envelope ALSO carries a queued card:
      // the park raced ahead of `noteHandbackRelease`, so the park-time
      // suppression missed and a queued card got posted. It is now a pure
      // duplicate that would otherwise FREEZE on "⏳ Queued" beneath the adopted
      // handback card (the MAJOR). Delete it — the handback card is the one
      // surface; a delete (not a "folded" edit) is right because there is no
      // separate message to explain, just a stray duplicate to remove.
      deleteQueuedCard(deps, ev.chatId, ev.queuedCardMessageId)
      process.stderr.write(
        `telegram gateway: queued card superseded by handback adoption turnId=${turnId} ` +
          `queued=${ev.queuedCardMessageId} adopted=${next.activityMessageId}\n`,
      )
    }
    // #3544 — arm the turn-long `typing…` loop for EVERY minted turn,
    // unconditionally. It used to hang off the handback ADOPTION above,
    // which misses whenever the pre-turn entry was deduped (parallel
    // workers on one topic), had no derivable turn id, or was already
    // reaped — and the whole compose window went dark. Only the real-inbound
    // path (`turn-start-surfaces.ts`) armed a loop, so a synthetic turn
    // (handback / cron / wake) could have none at all. Unconditional is safe
    // and costs nothing extra on the wire:
    //   - `turnTypingLoop.start` is restart-safe (stops any prior loop on
    //     the key first, so a real inbound's loop is replaced, not doubled);
    //   - every send goes through the SHARED per-chat-key emitter floor
    //     (`typing-emitter.ts`, TYPING_FLOOR_MS) so N arms on one chat still
    //     cost at most one chat action per floor window — the 2026-07-11
    //     flood-ban guard is what makes arming more loops free;
    //   - `turn-end.ts` (`purgeReactionTracking → stopTurnTypingLoop`) is
    //     already the single stop-owner for ALL turns, and a start is
    //     self-healing anyway, so this cannot leak an interval.
    startTurnTypingLoop(ev.chatId, enqThreadIdNum ?? null)
    // #4173 — a new turn minting on the serial claude session is a completion
    // PROXY for any still-open flush window: the session has moved on, so a
    // prior flushed turn's own late reply can now only arrive as a bounded
    // replay (the grace). Closing here is the SAFE direction — a window closed
    // too early costs at most a visible duplicate, never an edit-over.
    closeFlushCompletionWindows(deps.flushedTurnSupersede, Date.now())
    // PR-4e — route the turn-SET through the keyed accessor: flag-OFF assigns
    // the singleton (byte-identical to `currentTurn = next`); flag-ON sets the
    // per-topic `byKey[statusKey]` entry AND the most-recent mirror. The key is
    // the SAME statusKey the ctor's façade was constructed with just above.
    setCurrentTurn(next, statusKey(ev.chatId, enqThreadIdNum))
    // (turn start already stamped the idle clock at the top of
    // handleSessionEvent, along with every other session event — see the
    // idle-clear block there.)
    // Early-open the "Working…" liveness card at turn start so narration /
    // thinking emitted BEFORE the first tool surfaces within ~a second
    // instead of after the old 12 s threshold (the dead-air gap). Fires the
    // SAME `openLivenessFeedIfDue` the 6 s heartbeat uses — a no-op if a
    // tool/narrative already opened the card, and gated by `mayOpenActivityCard`
    // (lever 1/4) so it never opens below a delivered answer. Scoped to real
    // turns by construction: only the `enqueue` lifecycle event reaches here,
    // and anonymous one-shot hook clients (recall.py) never emit it.
    scheduleEarlyLivenessOpen(next)
    // Status-surface observability: one line at every turn SET so a later
    // dark card is traceable to which turn/topic key it belonged to.
    process.stderr.write(
      `telegram gateway: ${formatTurnLifecycle('set', 'enqueue', next, startedAt)}\n`,
    )
    // Consumption proxy for the handback orphan reap (session-consume-signal):
    // claude holds ONE FIFO input queue, so this turn minting proves every
    // inbound delivered before its own entered the model's context.
    sessionConsumeSignal.noteTurnMint(startedAt)
    // Component 3 — retain in the bounded recently-ended registry so a
    // LATE reply (landing after currentTurn flips to a successor) can
    // still resolve THIS turn's origin thread by its turnId.
    rememberRecentTurn(next)
    // Component 5 (Hook B) — this turn's topic had a queued placeholder
    // from Hook A; promote it to "On it — replying now." (deleted later
    // when the answer lands). No-op when there's no placeholder / DM.
    promoteQueuedStatus(ev.chatId, enqThreadIdNum)
    // PR3b-cutover: feed the authoritative turn-start to the delivery
    // machine. `enqueue` fires for EVERY turn atom regardless of
    // source — inbound, cron, subagent-handback, vault-resume,
    // restart-marker — so it is the single chokepoint that captures
    // the non-inbound turns the machine's own `inbound` event never
    // sees (those bypass handleInbound). Without it the machine reads
    // idle during a cron/handback turn and the gate would mis-deliver
    // a concurrent inbound mid-turn (the #1556 composer wedge).
    // Idempotent when already in_turn (turnStart only sets perKey).
    shadowEmit({
      kind: 'turnStart',
      key: statusKey(ev.chatId, ev.threadId != null ? Number(ev.threadId) : undefined) as _ChatKey,
      at: startedAt,
    })
    // #549 fix — fresh turn, reset preamble-suppression state.
    preambleSuppressor.reset()
    // Reset the silent-end retry budget for this chat. The stored
    // turnKey is `chat:thread` shape (no per-instance suffix), so
    // without an explicit per-turn clear, `writeSilentEndState`
    // (silent-end.ts:114) inherits `retryCount` across turns
    // whenever a prior turn for the same chat hit retryCount=1.
    // The Stop hook then sees `retryCount >= MAX_RETRIES=1` on the
    // very first silent-end of every subsequent turn and bails
    // without re-prompting. finn hit this on 2026-05-25 with a
    // stuck retryCount=1 file. A new turn invalidates any prior
    // turn's retry budget by definition; clear it eagerly here.
    // ev.threadId is `string | null` (Telegram's wire shape);
    // statusKey wants `number | null` — same conversion as the
    // registry-key branch a few lines down.
    clearSilentEndState(statusKey(
      ev.chatId,
      ev.threadId != null ? Number(ev.threadId) : null,
    ))
    // Stage 3b: stamp turn-start in the registry. turn_key is
    // chat:thread:startTs — unique per turn, distinct from the
    // progress-card-driver's per-chat sequence number (these are two
    // independent identifier schemes and don't need to align).
    if (turnsDb != null) {
      // ev.threadId is `string | null` (Telegram emits as string); convert
      // to number for chatKeyWithSuffix. Number(null) = 0 which canonicalizes
      // to '_' — same as the explicit `null` branch below.
      const evThreadIdNum = ev.threadId != null ? Number(ev.threadId) : null
      const turnKey = chatKeyWithSuffix(ev.chatId, evThreadIdNum, String(startedAt))
      next.registryKey = turnKey
      // Phase 1 of #332: capture first ~200 chars of the user's message.
      const userPromptPreview = extractUserPromptPreview(ev.rawContent)
      // Closes #472 finding #11. Pre-fix: this write was scheduled
      // via setImmediate to "avoid stalling the turn handler" — but
      // SQLite local writes are sub-millisecond, and the deferral
      // opened a SIGTERM race window: a kill landing in the gap
      // between scheduling and firing left a turn with no start
      // row, invisible to the resume protocol (the user sent a
      // message, the gateway lost it, no SWITCHROOM_PENDING_TURN
      // env on next boot). Sibling writeTurnActiveMarker has always
      // been synchronous here; this matches it.
      try {
        recordTurnStart(turnsDb, {
          turnKey,
          chatId: String(ev.chatId),
          threadId: ev.threadId != null ? String(ev.threadId) : null,
          lastUserMsgId: ev.messageId != null ? String(ev.messageId) : null,
          userPromptPreview,
        })
      } catch (err) {
        process.stderr.write(`telegram gateway: recordTurnStart failed turnKey=${turnKey}: ${(err as Error).message}\n`)
      }
      // #412: turn-active marker for the bridge-watchdog. File exists
      // for the duration of the in-flight turn; mtime advances on
      // every tool_use; deleted on turn_complete. The watchdog
      // distinguishes wedged-mid-turn from healthy-idle by checking
      // for this file's presence + mtime staleness.
      writeTurnActiveMarker(STATE_DIR, {
        turnKey,
        chatId: String(ev.chatId),
        threadId: ev.threadId != null ? String(ev.threadId) : null,
        startedAt,
      })
    }
    // (accessor-narrowing spelling: the pre-move body guarded the
    // `pendingPtyPartial` variable then re-read it into `pending`; the
    // injected accessor is a call expression TS can't narrow across, so
    // capture once then guard the local — equivalent, no await between.)
    const pending = getPendingPtyPartial()
    if (pending != null) {
      setPendingPtyPartial(null)
      handlePtyPartial(pending)
    }
  }
}


export function handleSessionEvent(deps: StreamRenderDeps, ev: SessionEvent): void {
  const {
    ANSWER_LANE,
    CAPTURED_PROSE_DELIVERY_ENABLED,
    CONTEXT_EXHAUSTION_COOLDOWN_MS,
    DELIVERY_CONFIRM_ENABLED,
    FEED_REOPEN_AFTER_ACK_ENABLED,
    FEED_REOPEN_AFTER_SUBSTANTIVE_ENABLED,
    HANDBACK_PRETURN_ENABLED,
    HISTORY_ENABLED,
    LIVENESS_TERMINAL_HONESTY,
    OBLIGATION_LEDGER_ENABLED,
    ORPHANED_REPLY_STREAM_WINDOW_MS,
    SILENCE_LIVENESS_PRODUCTION,
    STATE_DIR,
    TURN_FLUSH_SAFETY_ENABLED,
    TURN_PREVIEW_MAX,
    activeDraftStreams,
    activeStatusReactions,
    activeTurnStartedAt,
    backstopDeliveryLedger,
    bot,
    cardDrainGate,
    clearActivitySummary,
    clearAnswerReadyFlushTimeout,
    closeActivityLane,
    closeProgressLane,
    completeProgressCardTurn,
    composeTurnActivity,
    confirmMemoryLegibility,
    deliverAnswer,
    deliverCapturedProse,
    deliveryQueue,
    drainActivitySummary,
    emissionAuthorityFor,
    emitTurnRecord,
    endCurrentTurnAtomic,
    extractUserPromptPreview,
    finalizeStatusReaction,
    flushPendingNarrativeAtTurnEnd,
    flushedTurnSupersede,
    getCurrentTurn,
    getLastContextExhaustionWarningAt,
    getPendingPtyPartial,
    getPinnedProgressCardMessageId,
    handbackPreturnSignal,
    handlePtyPartial,
    idleTracker,
    isDmChatId,
    isLegitimatelyWorking,
    lastPtyPreviewByChat,
    makeNarrativeGate,
    obligationLedger,
    outboundDedup,
    pendingCrossTurnGate,
    preambleSuppressor,
    progressDriver,
    promoteQueuedStatus,
    purgeReactionTracking,
    reactionTransitionCounts,
    redactOutboundText,
    rememberRecentTurn,
    resetAnswerReadyFlushTimeout,
    resetOrphanedReplyTimeout,
    resolvePendingNarrativeOnTool,
    robustApiCall,
    scheduleEarlyLivenessOpen,
    sessionModelSource,
    setCurrentTurn,
    setLastContextExhaustionWarningAt,
    setPendingPtyPartial,
    stagePendingNarrative,
    startTurnTypingLoop,
    statusKey,
    streamKey,
    suppressPtyPreview,
    surfaceMemoryLegibility,
    swallowingApiCall,
    toolFlightTracker,
    turnLiveForItsTopic,
    turnsDb,
    typingWrapper,
    unpinProgressCardForChat,
  } = deps

  // Per-turn liveness stamp (orphaned-reply thinking-pause fix). Stamp
  // lastStreamEventAt AND reset the rearm counter on ANY genuine stream event,
  // under ONE shared predicate: a live turn is present and this is not the
  // synthetic durationMs===-1 turn_end (the fire callback's own re-dispatch).
  // The counter reset MUST live here at the dispatcher — NOT inside
  // resetOrphanedReplyTimeout() (which is called from the fire callback one
  // line after the counter increments) and NOT tied to a single case (e.g.
  // tool_result does not call resetOrphanedReplyTimeout). onStreamEvent applies
  // the `!(turn_end && -1)` half of the predicate internally.
  {
    const liveTurn = getCurrentTurn()
    if (liveTurn != null) {
      const durationMs = ev.kind === 'turn_end' ? ev.durationMs : undefined
      liveTurn.liveness.onStreamEvent(ev.kind, durationMs, Date.now())
    }
  }
  // Idle-clear clocks (#3084 follow-up). EVERY genuine session event is
  // activity — an agent that is thinking, calling a tool, streaming text or
  // driving a sub-agent is NOT idle, whether or not the gateway currently has a
  // turn open. Stamping only at turn START (the old behaviour) is what let a
  // 3-hour working stretch be scored as zero activity and `/clear`ed the moment
  // the window elapsed. A turn ending stamps the turn-end clock too, so a turn
  // that outran the window is not wiped the instant `turnInFlight` goes false.
  // This runs for the whole event stream, including every `sub_agent_*` kind —
  // background workers keep the timer warm exactly as long as they are working.
  {
    const durationMs = ev.kind === 'turn_end' ? ev.durationMs : undefined
    idleTracker.noteEvent(ev.kind, Date.now(), durationMs)
  }
  // #4176 — sub-agent liveness, fed from the SAME whole-stream position as the
  // idle clock above and for the same reason: `sub_agent_*` events arrive with
  // or without a live gateway turn, and the reply send path must know whether a
  // background sub-agent could be the author of a decoupled reply (a sub-agent
  // calls `reply` over the parent's OWN bridge, so neither the caller-identity
  // gate nor the handback marker can see it). Deliberately BEFORE the switch:
  // the `sub_agent_tool_use` case below early-returns when `getCurrentTurn()` is
  // null, which is exactly the post-flush state this gate exists for. See
  // gateway/subagent-reply-authority.ts.
  subagentReplyAuthority.noteSessionEvent(ev as { kind: string; agentId?: string })
  switch (ev.kind) {
    case 'enqueue': {
      // #3927 FIX A — an `enqueue` is a QUEUE event, not a turn START event
      // (see the parked-turn-start block at the top of this module for the
      // transcript evidence). Mint ONLY when the session is genuinely idle;
      // otherwise park the envelope and let the CLI's own `dequeue` start the
      // turn, or its `remove` discard it (the message was folded into the
      // running turn and will never own a turn).
      const enqThreadIdNum = ev.threadId != null ? Number(ev.threadId) : undefined
      const now = Date.now()
      if (ev.chatId) {
        // Ack inbound delivery (the marko drop-wedge): the message reached
        // claude's queue, so its delivered inbound landed — stop tracking it
        // for re-delivery. `enqueue` carries the same chat/thread the inbound
        // was keyed on, so the key matches.
        //
        // #3927: this ack stays on the ENQUEUE event and did NOT move into
        // `beginTurn` with the rest of the old body. It asserts RECEIPT, not
        // turn start — and receipt is exactly what an enqueue proves. A parked
        // envelope whose terminal turns out to be `remove` (folded into the
        // running turn) never reaches `beginTurn` at all, so acking there would
        // leave that message tracked forever and the delivery machine would
        // re-deliver it: a duplicate inbound.
        if (DELIVERY_CONFIRM_ENABLED) {
          // Match on the source message id: `enqueue` fires for EVERY queued
          // message regardless of source (cron / subagent-handback /
          // vault-resume / restart-marker too), so a key-only ack would let a
          // synthetic turn clear a real user message still waiting under the
          // same key.
          ackDelivery(
            deliveryQueue,
            chatKey(ev.chatId, ev.threadId != null ? Number(ev.threadId) : null),
            ev.messageId,
            // #2786 — pass the raw enqueue envelope so the ack survives the
            // composer merging/reordering inbound wrappers (the single
            // re-parsed `ev.messageId` can then belong to a sibling, not our
            // tracked message). The tolerant match scans all ids in this
            // content; a synthetic-source turn still lacks the user id, so the
            // cross-source false-ack guard holds.
            ev.rawContent,
          )
        }
      }
      pruneParkedTurnStarts(now, (e) => finalizeParkedEntryCard(deps, e, QUEUED_CARD_EXPIRED_HTML))
      // `enqueue` with no chat can never mint a turn (the whole mint block is
      // `if (ev.chatId)`-gated); parking it would only pollute the store, so
      // run the pre-turn drain path verbatim and stop.
      if (!ev.chatId) {
        beginTurn(deps, ev)
        return
      }
      // The live-turn probe is the module's ONLY turn accessor: the
      // most-recently-set turn mirror. Under the sequential-CLI invariant that
      // IS the live turn, and `endedAt` (stamped in turn-end.ts) is the second
      // guard for a mirror that outlived its turn. A non-empty parked store is
      // equally disqualifying: the CLI's queue is not drained, so this message
      // is queued BEHIND those and minting now would reorder them.
      const live = getCurrentTurn()
      const sessionBusy = live != null && live.endedAt == null
      if (!sessionBusy && parkedTurnStarts.length === 0) {
        beginTurn(deps, ev)
        return
      }
      // PARKED. No `promoteQueuedStatus` ("On it — replying now" is a lie until
      // the turn actually starts) and no `typingWrapper.drainAll()` (that drains
      // the LIVE turn's wraps). Part B DOES post one honest, clearly-marked
      // "queued" card here: on the machine-authoritative path (the default) the
      // legacy Hook A placeholder never fires — it lives in the buffer-until-idle
      // branch that returns BEFORE the machine enqueues — so before Part B a
      // parked envelope had no surface at all until it dequeued.
      //
      // UNIFORM ACROSS SOURCES — synthetic enqueues (cron fire, subagent
      // handback, obligation-represent, vault-grant resume, wake inbound) park
      // exactly like a real inbound and do NOT preempt. That is not a policy
      // choice, it is what the CLI does: carrie's `obligation_represent`
      // enqueue at 2026-07-28T18:19:07.032Z was terminated by a `remove` at
      // 18:19:59.794Z (folded into the running turn as a `queued_command`
      // attachment), never by a `dequeue`. Minting for it invented a turn the
      // CLI never started. FIX B covers the residual case where a mint DOES
      // land on top of a live atom.
      const parkedEntry = parkTurnStart(
        {
          chatId: ev.chatId,
          messageId: ev.messageId,
          threadId: ev.threadId,
          rawContent: ev.rawContent,
        },
        now,
        // Cap-evicted (oldest lost its slot) → finalize its card as expired so
        // it never freezes on "⏳ Queued".
        (evicted) => finalizeParkedEntryCard(deps, evicted, QUEUED_CARD_EXPIRED_HTML),
      )
      process.stderr.write(
        `telegram gateway: turn-start parked (session busy) chat=${ev.chatId} ` +
          `thread=${enqThreadIdNum ?? '-'} msg=${ev.messageId ?? '-'} ` +
          `parked=${parkedTurnStarts.length}\n`,
      )
      // Post the queued card, reply-anchored to the parked message, and store its
      // id back on the envelope so `beginTurn` can adopt+edit it on dequeue. One
      // card per envelope (multiple queued messages each get their own).
      //
      // SUPPRESS when a handback pre-turn signal already owns this turn's surface
      // (the common worker-handoff-while-busy case): `noteHandbackRelease` fired
      // at buffer drain BEFORE this injected handback inbound reached park, so an
      // entry armed for THIS message's turnId is already live. That entry paints
      // (and the dequeued turn adopts) its OWN card, so a queued card here would
      // be a second card that then freezes on "⏳ Queued" (the MAJOR this fixes).
      // Turn-scoped, not key-scoped: an unrelated user message parked on the same
      // topic derives a different turnId and is NOT suppressed. beginTurn carries
      // a belt-and-suspenders cleanup for the residual race where the queued card
      // was already posted before the handback entry armed.
      const parkTurnId = deriveTurnId(ev.chatId, enqThreadIdNum ?? null, ev.messageId)
      const handbackOwnsSurface =
        HANDBACK_PRETURN_ENABLED &&
        parkTurnId != null &&
        handbackPreturnSignal.hasPendingForTurnId(parkTurnId)
      if (handbackOwnsSurface) {
        process.stderr.write(
          `telegram gateway: queued card suppressed (handback owns surface) ` +
            `turnId=${parkTurnId} msg=${ev.messageId ?? '-'}\n`,
        )
      }
      if (QUEUED_CARD_ENABLED && !handbackOwnsSurface) {
        const cardChatId = ev.chatId
        // Reply-anchor ONLY to a plausible real Telegram message id. Synthetic
        // enqueues (subagent handback, boot resume, cron) fabricate `messageId`
        // from `Date.now()` (~1.78e13) — finite, so a bare `Number.isFinite`
        // guard passes it, but `reply_parameters.message_id` hard-rejects
        // anything beyond signed int32 with 400 `field "message_id" must be a
        // valid Number` (`allow_sending_without_reply` does NOT bypass the
        // range check), killing the whole card send (overlord
        // gateway-supervisor.log 2026-08-04, e.g. msg=1785846295635). Same bug
        // class as the resume-dark-feed incident — reuse its guard, don't
        // re-derive a weaker one. An unanchored card is fine; no card is not.
        const replyTo = parseSourceMessageId(ev.messageId)
        void openQueuedCard(deps, cardChatId, enqThreadIdNum ?? null, replyTo).then((cardId) => {
          if (cardId == null) return
          // Still parked → adopt on the next dequeue. Otherwise the entry already
          // dequeued/removed/expired before the async send resolved (a sub-second
          // race), so `beginTurn` ran without the id — delete the orphan card so
          // no frozen duplicate lingers below the turn's own fresh card.
          if (parkedTurnStarts.includes(parkedEntry)) {
            parkedEntry.queuedCardMessageId = cardId
          } else {
            deleteQueuedCard(deps, cardChatId, cardId)
          }
        })
      }
      return
    }
    case 'dequeue': {
      // #3927 FIX A — the CLI's authoritative TURN-START signal: the queue was
      // drained into a new user turn. Carries no ids (session-tail.ts), so the
      // pairing is positional — and the evidence says it pairs with the MOST
      // RECENT enqueue, not the oldest. An empty store is the normal idle path
      // (the enqueue ms earlier already minted) and a dequeue with no parked
      // start at all is a no-op, exactly as before.
      pruneParkedTurnStarts(Date.now(), (e) => finalizeParkedEntryCard(deps, e, QUEUED_CARD_EXPIRED_HTML))
      const parked = takeParkedTurnStart()
      if (parked == null) return
      beginTurn(deps, parked)
      return
    }
    case 'queue_remove': {
      // #3927 FIX A — the queued message was folded into the ALREADY-RUNNING
      // turn (a `queued_command` attachment); it will never own a turn. Drop
      // its parked envelope so a later `dequeue` cannot mint a spurious turn
      // for it. Content-matched: `remove` replays its enqueue's `content`
      // byte-for-byte.
      pruneParkedTurnStarts(Date.now(), (e) => finalizeParkedEntryCard(deps, e, QUEUED_CARD_EXPIRED_HTML))
      // Part B — finalize the removed envelope's queued card as "folded into the
      // current task" so it never freezes on "⏳ Queued".
      const removed = discardParkedTurnStart(ev.rawContent)
      if (removed != null) finalizeParkedEntryCard(deps, removed, QUEUED_CARD_FOLDED_HTML)
      return
    }
    case 'model': {
      // Live model capture for the main turn. The session-tail projection
      // already filtered sentinels (`<synthetic>` compaction lines), so any
      // value reaching here is a real resolved model id. Record it on the turn
      // (update-on-change) so the activity/liveness card header and /status
      // render the model actually serving this turn's API calls — transcript-
      // sourced, never config. Also note it on the freshness-aware session-model
      // source so a /status query between turns still reflects the last model
      // (and a fresh assistant line reclaims the source from a /model override).
      const turn = getCurrentTurn()
      if (turn != null) {
        turn.currentModel = ev.model
      }
      // `replayed` (#3427 H2): a first-attach replay line carries the
      // PRE-restart session's model — record it for freshness (unchanged
      // behavior) but exclude it from divergence verification.
      sessionModelSource.noteTranscriptModel(ev.model, { replayed: ev.replayed === true })
      return
    }
    case 'usage': {
      // Fold the parent agent's OWN per-message token usage into the turn's
      // running total, deduped by message.id (one logical assistant message can
      // land as several JSONL lines sharing one id + usage block). Rendered on
      // the 🤖 turn-activity card's metrics line. Sub-agent tokens are NOT
      // folded here — they surface on their own worker-feed rows; summing them
      // would double-count. A null messageId is un-dedupable → always counted.
      const turn = getCurrentTurn()
      if (turn == null) return
      if (ev.messageId != null) {
        if (turn.seenUsageMessageIds.has(ev.messageId)) return
        turn.seenUsageMessageIds.add(ev.messageId)
      }
      turn.totalTokens += ev.totalTokens
      return
    }
    case 'thinking': {
      // #1067: snapshot the turn atom at handler entry. Even though this
      // handler is sync, the principle is uniform across all event arms
      // — read `turn` once, don't re-read currentTurn after any await.
      const turn = getCurrentTurn()
      if (turn == null) return
      // S2 fix (fable red-team 2026-07-17) — a thinking block means the model
      // is still working, not quiescent. Without this, "prose → >1s thinking
      // pause → trailing NO_REPLY" let the answer-ready quiescence timer fire
      // mid-pause and deliver a turn the model was about to mark silent
      // (#2053 in miniature). Re-arm (not just clear): `reset()` re-verifies
      // via `decideTurnFlush` and pushes the debounce out by a fresh window,
      // so the trailing sentinel gets to land before any fire; if no further
      // text arrives, the flush still fires one window after the LAST
      // thinking event — the fast path is deferred, never lost.
      resetAnswerReadyFlushTimeout()
      const ctrl = activeStatusReactions.get(statusKey(turn.sessionChatId, turn.sessionThreadId))
      if (ctrl) ctrl.setThinking()
      return
    }
    case 'tool_use': {
      const turn = getCurrentTurn()
      if (turn == null) return
      // #3513 follow-up (MF1 + MF4b) — a TURN-CONTINUING tool_use (any tool NOT
      // in the ephemeral surface set) is the deterministic signal that every text
      // block captured so far in this turn was intra-turn narration, not the
      // terminal answer. Retro-mark ALL existing captured blocks
      // (`capturedBlockMeta.fill(true)`) so the cross-message shape
      // ([text-only message] → [tool_use in the NEXT message]) is actually seen
      // by `selectBackstopDelivery` — the per-message `!ev.lastInMessage` push at
      // the `text` case under-detects it. The SAME ephemeral gate protects the
      // E2 answer-ready fast path: a trailing ephemeral tool (answer, then
      // react / pin / typing / edit / delete) must neither mark the answer
      // interim NOR disarm the quiescence flush.
      if (!isEphemeralTool(ev.toolName)) {
        turn.capturedBlockMeta.fill(true)
        clearAnswerReadyFlushTimeout(turn)
      }
      // Narrative-dedup gate step 2 (JSONL-text-narrative primitive): a
      // narrative block was pending; this tool_use is the lookahead event
      // that decides it. reply/stream_reply with near-identical text ⇒
      // draft-then-send ⇒ SUPPRESS (the reply prints the canonical answer);
      // anything else ⇒ SHOW as a transient liveness step. Runs BEFORE the
      // normal tool handling so a working preamble surfaces just ahead of
      // its tool step.
      resolvePendingNarrativeOnTool(turn, ev.toolName, ev.input)
      // Phase 1 of #332: count every tool_use in the current turn.
      turn.toolCallCount++
      // #412: bump turn-active marker mtime so the watchdog sees this
      // turn is making forward progress. Stop-hook deadlocks (the
      // failure mode #116 originally tracked) emit no more tool_use
      // events, so the marker mtime stops advancing → watchdog acts.
      touchTurnActiveMarker(STATE_DIR)
      // Dispatch-time parent_turn_key stamp from the GATEWAY's live turn
      // context (Telegram msg 6897 misroute, 2026-08-04). The pretool hook's
      // #2085 stamp reads the turn-active marker FILE, and the watcher's
      // backfill needs a turns row whose window contains the dispatch — both
      // can miss at once (marker swept, hook write lost to SQLITE_BUSY, a
      // turn whose surface registration failed). The gateway observing this
      // Agent/Task tool_use inside a live turn KNOWS the turn key directly:
      // stamp it marker-free. COALESCE inside the helper — a hook-stamped
      // value is never overwritten, so normal in-turn dispatch is unchanged.
      if (
        (ev.toolName === 'Agent' || ev.toolName === 'Task') &&
        ev.toolUseId != null && ev.toolUseId.length > 0 &&
        turn.registryKey != null && turnsDb != null
      ) {
        try {
          stampSubagentDispatchTurn(turnsDb, {
            toolUseId: ev.toolUseId,
            parentTurnKey: turn.registryKey,
            agentType: typeof ev.input?.subagent_type === 'string' ? ev.input.subagent_type : null,
            description: typeof ev.input?.description === 'string' ? ev.input.description : null,
            background: ev.input?.run_in_background === true,
            now: Date.now(),
          })
        } catch (err) {
          process.stderr.write(
            `telegram gateway: dispatch-time parent_turn_key stamp failed toolUseId=${ev.toolUseId}: ${(err as Error).message}\n`,
          )
        }
      }
      // #549 fix: a tool_use immediately following text events makes
      // those texts "preamble" — the progress card already captured
      // them as a narrative for this tool. Drop the pending answer-
      // stream buffer so the same text doesn't also land in chat as a
      // standalone message. Telegram-surface tools (reply / stream_reply)
      // are EXCEPTIONS: their text IS the answer, so we flush instead
      // of dropping. The answer-stream's own dedup handles overlap
      // with the reply tool's payload.
      preambleSuppressor.onTool({ isReplyTool: isTelegramSurfaceTool(ev.toolName) })
      // #2849 Phase 4 — sparse chat-legible memory. Surface ONE terse line in
      // the originating chat/topic when this tool call materially changes what
      // the agent remembers (create_directive / invalidate / demote). Fires
      // BEFORE the `if (!ctrl) return` status-reaction gate below so it works
      // on turns with no active status-reaction controller. Deterministic
      // tool-call observation — no model call, no polling; ordinary recall and
      // routine consolidation never reach here (they aren't material tools).
      surfaceMemoryLegibility(turn, ev.toolName, ev.toolUseId, ev.input)
      const ctrl = activeStatusReactions.get(statusKey(turn.sessionChatId, turn.sessionThreadId))
      const name = ev.toolName
      // Phase tracking removed in #553 PR 5 — phases only fed the
      // placeholder-heartbeat label, which has been retired.
      if (isTelegramReplyTool(name)) {
        turn.replyCalled = true
        // NIT 2 (reply-proxy precision): capture the ACTUAL delivered reply
        // text so flushPendingNarrativeAtTurnEnd compares a trailing
        // narrative block against the real answer surface, not
        // capturedText.join('') (which mis-suppresses when the model emits
        // the same short string twice in a turn). Reply tools ('reply',
        // 'stream_reply') carry the answer in input.text; only those count.
        // Prefix-aware: prod jsonl carries the mcp__…__stream_reply form.
        if (isReplyTool(name) && typeof ev.input?.text === 'string') {
          turn.lastReplyText = ev.input.text as string
        }
        if (turn.orphanedReplyTimeoutId != null) {
          clearTimeout(turn.orphanedReplyTimeoutId)
          turn.orphanedReplyTimeoutId = null
        }
        // Delete the activity feed only when the FINAL answer has landed —
        // NOT on an ack-first interim reply ("On it"). Gating on the first
        // reply deleted the feed on the ack, so the post-ack work
        // (sub-agents/tools) rendered into nothing — the "agent went silent
        // after On it" gap. `finalAnswerDelivered` is set by executeReply
        // (isFinalAnswerReply) before this tool_use event fires; turn_end
        // (below) clears unconditionally as the idempotent no-reply / race net.
        if (turn.finalAnswerDelivered) {
          clearActivitySummary(turn)
        }
      }
      // The live activity feed is driven by the real-time `tool_label`
      // event (PreToolUse sidecar) rather than this flush-gated tool_use
      // path — see `case 'tool_label'`. The sidecar fires at tool-call
      // time regardless of when claude flushes the transcript, which is
      // the determinism fix: on a fast/clustered-tool turn the JSONL
      // tool_use rows aren't on disk until ~turn-end, so sourcing the
      // feed here would lose them.
      if (!ctrl) return
      if (isTelegramSurfaceTool(name)) return
      ctrl.setTool(name)
      if (ev.toolUseId) {
        typingWrapper.onToolUse(ev.toolUseId, turn.sessionChatId, name, turn.sessionThreadId ?? null)
      }
      return
    }
    case 'tool_label': {
      // Real-time activity-feed driver. The PreToolUse hook wrote this
      // label synchronously at tool-call time; the sidecar surfaced it
      // here (~250ms) independent of the transcript flush. Accumulate it
      // into the live feed and edit the activity message in place — this
      // is what makes the feed deterministic on fast/clustered-tool turns
      // where the JSONL tool_use rows arrive too late.
      const turn = getCurrentTurn()
      if (turn == null) return
      // PR A — a tool_label (real-time, ~250 ms) means the model is producing
      // work right now: cancel any pending answer-ready quiescence flush (the
      // turn is not quiescent). Fires ahead of the JSONL tool_use, so it disarms
      // the timer at the earliest deterministic point. MF4b: an EPHEMERAL surface
      // tool (react / pin / typing / edit / delete fired after a terminal answer)
      // must NOT disarm the quiescence flush — gate on the same ephemeral check as
      // the tool_use reducer so answer-then-react keeps the E2 fast path.
      if (!isEphemeralTool(ev.toolName)) {
        clearAnswerReadyFlushTimeout(turn)
      }
      // SECONDARY FIX: an active tool_label means the model is producing work
      // right now — re-arm the orphaned-reply fuse so a multi-phase tool turn
      // (write → compile → test → fix) that regularly emits labels doesn't let
      // the 30 s timer run down between labels. Mirrors how `case 'text':` calls
      // resetOrphanedReplyTimeout() at ~line 10786.
      resetOrphanedReplyTimeout()
      // Surface tools (reply/stream_reply/react) are the conversation, not
      // activity — the hook labels them ("Replying"), so filter by name.
      if (isTelegramSurfaceTool(ev.toolName)) return
      // Stop feeding once the FINAL answer has landed — the hand-off where
      // `clearActivitySummary` deletes the feed so the answer is the
      // authoritative surface. Gating on `replyCalled` (any reply) killed the
      // feed on an ack-first interim "On it", so the post-ack work had no live
      // surface; gate on `finalAnswerDelivered` so the feed keeps narrating
      // between the ack and the real answer. Without this a tool called after
      // the FINAL answer would re-`sendMessage` a fresh feed below it (flicker).
      // Safe ordering: `tool_label` is real-time (PreToolUse, ~250ms) while
      // `finalAnswerDelivered` is set from executeReply on the final answer.
      //
      // Feed-reopen-after-ack: a tool label here means the model is STILL
      // working. If the turn was already marked finalAnswerDelivered, the
      // "final" reply MIGHT have been an interim ACK ("on it, checking
      // Brevo…" pings, classified final by isFinalAnswerReply), so the
      // post-ack work had no live feed — the gate above dropped every label.
      //
      // ACK-ONLY refinement: finalAnswerDelivered latches true for BOTH a
      // short pinging ack AND a substantive answer. Reopening unconditionally
      // is harmful after a GENUINE final answer — routine post-answer
      // housekeeping (memory write / TodoWrite / Bash; non-surface tools that
      // reach here) would reset finalAnswerDelivered=false and trip the
      // silent-end re-prompt (NOT zero-outbound gated) → duplicate answer. So
      // reopen ONLY when the prior final was a short ack
      // (finalAnswerSubstantive=false). When it was substantive, drop the
      // label (legacy gate) so the genuine final stays delivered.
      //
      // On reopen: reclassify the interim ack — the turn has NOT delivered its
      // final answer while still doing tool work. Reset the flag and clear
      // activityMessageId so a FRESH feed message opens below the ack, then
      // proceed normally. When the model's REAL final answer lands,
      // executeReply / stream_reply re-set finalAnswerDelivered=true (and
      // finalAnswerSubstantive) and the feed gates off again. The reset keeps
      // the #2137 serialize gate HOLDING the next topic mid-work (next-topic
      // liveness is the bounded no-reply timer's job) and lets the silent-end
      // re-prompt fire if the turn ends on only an ack.
      // Kill switch SWITCHROOM_FEED_REOPEN_AFTER_ACK=0 → legacy `return`.
      //
      // POST-SUBSTANTIVE reopen: a turn that delivered a real answer and then
      // kept doing tool work reopens the feed once >= SUBSTANTIVE_REOPEN_MIN_
      // LABELS post-answer labels arrive — WITHOUT clearing finalAnswerDelivered
      // (that would trip the turn-end re-prompt → duplicate answer). Instead the
      // decision returns liftLeverOne, and the drain below opens the fresh card
      // below the reply via `postAnswerMainActivity` (the foreground sibling of
      // the sub-agent post-answer liveness exemption). Kill switch
      // SWITCHROOM_FEED_REOPEN_AFTER_SUBSTANTIVE=0 → post-substantive labels stay
      // dropped (legacy).
      if (turn.finalAnswerDelivered) {
        // Count post-substantive-answer labels so the reopen fires only once the
        // turn is plainly still working (>=2), not on a stray housekeeping tool.
        if (turn.finalAnswerSubstantive) turn.postSubstantiveToolLabelCount++
        // decideFeedReopen returns dropLabel (legacy return), or — on the ACK
        // path — the reset deltas (finalAnswerDelivered→false, a FRESH feed
        // message, last-sent cleared), or — on the SUBSTANTIVE path — no reset
        // but liftLeverOne=true (keep finalAnswerDelivered true, open the card
        // below the reply).
        const reopen = decideFeedReopen({
          finalAnswerDelivered: turn.finalAnswerDelivered,
          finalAnswerSubstantive: turn.finalAnswerSubstantive,
          enabled: FEED_REOPEN_AFTER_ACK_ENABLED,
          reopenAfterSubstantiveEnabled: FEED_REOPEN_AFTER_SUBSTANTIVE_ENABLED,
          postSubstantiveToolLabelCount: turn.postSubstantiveToolLabelCount,
        })
        if (reopen.dropLabel) return
        // ACK reopen carries a reset; the substantive reopen deliberately does
        // not (finalAnswerDelivered stays true, activityMessageId is already
        // null from the answer's clearActivitySummary).
        if (reopen.reset != null) {
          turn.finalAnswerDelivered = reopen.reset.finalAnswerDelivered
          turn.activityMessageId = reopen.reset.activityMessageId
          turn.activityLastSentRender = reopen.reset.activityLastSentRender
        }
        // Post-substantive reopen: latch the lever-1 lift so the drain (which
        // reads this off `turn`) opens the fresh card below the delivered reply.
        // Sticky for the rest of the turn — the model stays "still working".
        if (reopen.liftLeverOne) turn.postAnswerMainActivity = true
      }
      const rendered = appendActivityLabel(turn.mirrorLines, ev.label)
      if (rendered != null) {
        // Count surfaced tool steps — the single source of truth for the `tools=`
        // lifecycle field and the `✓ N steps` total. Incremented HERE (not at the
        // top of the case) so the count stays consistent with what the feed
        // actually surfaces: an empty label (appendActivityLabel → null) or a
        // label dropped by the post-final-answer reopen guard never inflates it.
        // Surface tools (reply/react) returned earlier; send_typing/sync_retain
        // are suppressed at the hook (computeLabel → null) so they never arrive.
        turn.labeledToolCount++
        // A new tool label = a new live step → re-anchor the heartbeat clock so
        // the " · Ns" elapsed restarts from this step (and the feed itself just
        // advanced, so it isn't stale).
        turn.lastToolLabelAt = Date.now()
        // Production-liveness: a NEW model-driven activity label is genuine
        // liveness (the model emitted a new step), so reset the silence-poke
        // clock — this is the safe site, NOT drainActivitySummary, because the
        // framework feedHeartbeatTick also drains (climbing-elapsed re-renders)
        // and would falsely reset the clock forever on a hung-mid-tool turn,
        // reintroducing the #1556 dangling-turn wedge. Only the model emitting a
        // fresh label reaches here.
        // PR-4e — keyed liveness under the flag. Flag-OFF keeps the literal
        // `currentTurn === turn` (a late tool-label for topic A must reset A's
        // silence clock, not topic B's); flag-ON resolves A by ITS OWN key so a
        // flip to B doesn't falsify A's liveness here.
        if (
          SILENCE_LIVENESS_PRODUCTION &&
          (EMISSION_AUTHORITY_ENABLED ? turnLiveForItsTopic(turn) : getCurrentTurn() === turn)
        ) {
          silencePoke.noteProduction(statusKey(turn.sessionChatId, turn.sessionThreadId), Date.now())
        }
        // Recompose so any active foreground sub-agent's nested block (Model A)
        // is preserved when the parent appends its own step. composeTurnActivity
        // == the flat render when no foreground sub-agent is active.
        turn.activityPendingRender = composeTurnActivity(turn) ?? rendered
        const ea = emissionAuthorityFor(turn)
        // PR-4d: route through the centralized chatLock-serialized card-drain gate.
        cardDrainGate(turn, ea, () => {
        if (ea.mayDrain(turn)) {
          // Producer B (tool label): always OPEN-eligible (labeledToolCount was
          // incremented just above). A turn that started conversational and now
          // dispatches a tool opens here, rendering any narration accumulated
          // by the suppressed narrative-SHOW drains (design §9 lever 5 / R4).
          // PR-4a: routed through the emission-authority façade (no-op delegate).
          ea.openOrEditCard('tool', () => {
            turn.activityInFlight = drainActivitySummary(turn, 'tool')
          })
        }
        })
      }
      return
    }
    case 'text': {
      // #1067: snapshot at entry. The answer-stream creation closures
      // below also read `turn` instead of currentTurn so they pin to
      // this turn's chat for the stream's lifetime.
      //
      // #1664 ordering note: a `text` event can arrive AFTER turn_end has
      // nulled currentTurn (the issue observed `answer_lane_update
      // transport:"draft"` firing post-turn_end). Such a late event is
      // dropped here by the `turn != null` guard — it is NOT folded back
      // into the just-ended turn. That is deliberate and safe: by the
      // time this fires, the turn atom has been handed to
      // endCurrentTurnAtomic and turn_end has already run its flush /
      // silent-end decision; re-opening a closed turn (re-creating an
      // answer stream, re-evaluating decideTurnFlush) would be a large,
      // race-prone change. The #1664 safety net does not depend on
      // catching the late text: a turn whose real answer lost the race
      // ends with finalAnswerDelivered=false, so recordUndeliveredTurnEnd
      // engages the Stop-hook re-prompt and the model re-delivers the
      // answer through the reply tool. The dropped draft text is
      // recovered by re-prompt, not by post-hoc materialization.
      const turn = getCurrentTurn()
      if (turn != null) {
        turn.capturedText.push(ev.text)
        // #3237 — accumulate the block's structural provenance in LOCKSTEP with
        // the text (same push, same index). `ev.lastInMessage` is true when NO
        // tool_use follows this text block in its assistant message; its
        // negation is the draft-then-send narration signal the turn-flush strip
        // uses (`selectFlushDeliveryText`) to keep a real answer intact instead
        // of truncating a paragraph that merely opens with "Let me explain…".
        //
        // NOTE (naming/approximation, #3515 review nit): downstream this value is
        // consumed as `followedByToolUse`, but `!ev.lastInMessage` is a CONSERVATIVE
        // APPROXIMATION of that predicate, not an exact match. It is true when the
        // block is not the last block in its assistant message OR when a tool_use
        // follows it in the same turn — i.e. it can over-flag: a block that is
        // genuinely last-in-message may still be marked true. Over-approximation is
        // SAFE here by construction: a `true` flag only ever makes a block a
        // candidate for structural-narration suppression (selectFlushDeliveryText /
        // isStructuralNarration), so the worst case is suppressing MORE narration —
        // it can never promote an answer into the drop path. A real terminal answer
        // is protected independently (it is never followed by a tool and survives
        // the strip). Do not "tighten" this to the exact predicate expecting a
        // behavioural change: the runtime value is deliberately conservative.
        turn.capturedBlockMeta.push(!ev.lastInMessage)
        // Narrative-dedup gate step 1 (JSONL-text-narrative primitive):
        // stage this text block for one lookahead step. If a previous block
        // was pending with nothing reply-shaped after it, it flushes here as
        // a SHOWN transient liveness step. The eventual SHOW/SUPPRESS of THIS
        // block is decided by the next tool_use / turn_end. Invariant
        // `chat-is-the-single-source-of-truth` (reference/invariants.md): a
        // SHOWN line rides the same renderStepFeed path as a tool step —
        // transient + clipped, never a persisted parallel mirror. This is a
        // separate lane from the answer-stream wiring below (which owns the
        // canonical reply), so the two never fight over the same text.
        stagePendingNarrative(turn, ev.text)
        // Issue #195: feed the answer-lane stream. The stream itself
        // gates on minInitialChars and throttles edits — short replies
        // stay below the threshold and never spawn a message.
        if (turn.answerStream == null) {
          turn.answerStream = createAnswerStream({
            chatId: turn.sessionChatId,
            threadId: turn.sessionThreadId,
            // VISIBLE on (opt-in, SWITCHROOM_VISIBLE_ANSWER_STREAM=1) →
            //   minInitialChars:1 opens a user-visible edit-in-place preview on the
            //   first text chunk. At turn_end the preview is materialized as a pinged
            //   final answer (materialize()) when the model never called reply.
            // VISIBLE off (default) → minInitialChars:MAX so NO visible preview ever
            //   opens; the reply tool is the single canonical formatted message
            //   (no flash). The draft transport is permanently retired — both modes
            //   use sendMessage + editMessageText for any message that does open.
            minInitialChars: ANSWER_LANE.minInitialChars,
            // #2669: the answer-stream ships the RAW transcript markdown; the
            // sendMessage/editMessageText wrappers below send it via the
            // rich-message path (`sendRichMessage` / `editMessageText({ markdown })`),
            // matching every other outbound lane. No render step needed.
            // #1075: route through robustApiCall so flood-wait,
            // benign-400, and THREAD_NOT_FOUND are handled uniformly
            // instead of crashing the answer-stream loop on a deleted
            // forum topic. answer-stream's own try/catch already
            // tolerates undefined returns from editMessageText.
            //
            // disable_notification gating by purpose (2026-05-25):
            //
            // - purpose='stream' (the live edit-in-place preview): SILENT.
            //   Without disable_notification, the first text chunk that
            //   opens the visible message device-pings, and then when the
            //   model later calls the reply MCP tool, that reply pings
            //   AGAIN (the over-ping safety net at gateway.ts:~4452 only
            //   sees executeReply paths, not this direct sendMessage). Two
            //   device pings per multi-step turn — the original Bug A.
            //   Edits in place don't notify regardless (Telegram semantics).
            //
            // - purpose='materialize' (turn-end final-answer fresh send,
            //   only fires for text-only turns where the stream IS the
            //   answer): PING. The user reached for the agent and the
            //   model produced an answer; per beat 5 of
            //   `reference/rfcs/conversational-pacing.md` the final answer MUST
            //   ping the device exactly once. Without this carve-out, a
            //   short text-only turn ("on it" being the whole response)
            //   lands silently and the user has no notification to know
            //   the answer arrived — the original over-correction.
            //
            // - purpose unset (defensive default): SILENT. Treat as
            //   stream-purpose so we never accidentally fire a stray ping
            //   from an unrecognised sendMessage callsite.
            sendMessage: async (chatId, text, params) => {
              const tid = params?.message_thread_id
              const silent = params?.purpose !== 'materialize'
              const msg = await robustApiCall(
                () =>
                  // allow-raw-bot-api: sendRichMessage is not in the THREAD_NOT_FOUND blast pattern; answer-stream tolerates failures via its own try/catch
                  // sendRichMessage doesn't accept link_preview_options — omit it.
                  bot.api.sendRichMessage(chatId, richMessage(text), {
                    disable_notification: silent,
                    ...(tid != null ? { message_thread_id: tid } : {}),
                    ...(params?.reply_parameters != null
                      ? { reply_parameters: params.reply_parameters }
                      : {}),
                  }),
                {
                  chat_id: chatId,
                  verb: `answer-stream.sendMessage(${params?.purpose ?? 'stream'})`,
                  ...(tid != null ? { threadId: tid } : {}),
                },
              )
              return { message_id: msg.message_id }
            },
            editMessageText: (chatId, messageId, text, params) => {
              const tid = params?.message_thread_id
              return robustApiCall(
                () =>
                  bot.api.editMessageText(chatId, messageId, richMessage(text), {
                    ...(tid != null ? { message_thread_id: tid } : {}),
                    ...(params?.link_preview_options != null
                      ? { link_preview_options: params.link_preview_options }
                      : {}),
                  }),
                {
                  chat_id: chatId,
                  verb: 'answer-stream.editMessageText',
                  ...(tid != null ? { threadId: tid } : {}),
                  // #3084 PR 2 / L1: answer-stream edits are COSMETIC — a
                  // dropped stream tick costs nothing (the next carries full
                  // text). messageId/editPayload engage the per-message floor +
                  // coalescing + no-op skip so rapid stream edits don't storm
                  // the same message (the top ban trigger).
                  priorityClass: 'cosmetic',
                  messageId,
                  editPayload: richMessage(text),
                },
              )
            },
            deleteMessage: (chatId, messageId) =>
              robustApiCall(
                () => bot.api.deleteMessage(chatId, messageId),
                { chat_id: chatId, verb: 'answer-stream.deleteMessage' },
              ),
            log: (msg) => process.stderr.write(`telegram gateway: ${msg}\n`),
            warn: (msg) => process.stderr.write(`telegram gateway: ${msg}\n`),
            // Issue #203: route answer-lane events through the streaming
            // metrics sink. Each successful update/edit/draft and the final
            // materialize emit one event. Also tick the silent-gap tracker
            // so answer-lane activity doesn't count as silent.
            //
            // #1067: the closure captures `turn` so the signal tracker
            // ticks against THIS turn's chat key. If a new turn took over,
            // the captured `turn` no longer matches `currentTurn` and we
            // skip the tick (the new turn has its own answer stream).
            onMetric: (metricEv) => {
              logStreamingEvent(metricEv)
              // PR-4e — keyed liveness under the flag. Flag-OFF keeps the literal
              // `currentTurn === turn` (a draft-update metric for topic A's stream
              // must tick A's signal/silence clock); flag-ON resolves A by its own
              // key so a flip to B doesn't skip A's tick.
              if (EMISSION_AUTHORITY_ENABLED ? turnLiveForItsTopic(turn) : getCurrentTurn() === turn) {
                signalTracker.noteSignal(
                  statusKey(turn.sessionChatId, turn.sessionThreadId),
                  Date.now(),
                )
                // Production-liveness: a draft update is the agent visibly
                // composing — reset the silence-poke clock so a long
                // compose-only turn (no tools, no reply yet) isn't torn down.
                if (SILENCE_LIVENESS_PRODUCTION) {
                  silencePoke.noteProduction(
                    statusKey(turn.sessionChatId, turn.sessionThreadId),
                    Date.now(),
                  )
                }
              }
            },
            // #646 — wire the shared outboundDedup into the answer-stream
            // materialize path so it participates in the same dedup window
            // as turn-flush and reply/stream_reply. Closured chatId /
            // threadId come from the captured `turn` snapshot, stable for
            // the lifetime of the stream.
            checkDedup: (text: string) => {
              return outboundDedup.check(turn.sessionChatId, turn.sessionThreadId, text, Date.now(), turn.registryKey ?? null) != null
            },
            recordDedup: (text: string) => {
              outboundDedup.record(turn.sessionChatId, turn.sessionThreadId, text, Date.now(), turn.registryKey ?? null)
            },
            // #648 — write answer-stream materializations into the SQLite
            // history buffer so get_recent_messages can surface them. Guard
            // with HISTORY_ENABLED, matching the turn-flush pattern at ~3783.
            recordOutbound: ({ messageId, text }: { messageId: number; text: string }) => {
              if (!HISTORY_ENABLED) return
              try {
                recordOutbound({
                  chat_id: turn.sessionChatId,
                  thread_id: turn.sessionThreadId ?? null,
                  message_ids: [messageId],
                  texts: [text],
                })
              } catch {}
            },
          })
        }
        // #549 fix: route the chunk through the preamble suppressor
        // instead of immediately updating the answer stream. If a
        // tool_use arrives within the buffer window, the suppressor
        // drops the chunk (the card owns it). Otherwise it flushes as
        // answer text. `turn.capturedText` is unchanged — it remains
        // the safety-net source for turn-flush prose recovery.
        preambleSuppressor.onText(ev.text)
      }
      resetOrphanedReplyTimeout()
      // PR A — (re)arm the deterministic answer-ready quiescence flush. Each
      // text chunk debounces the timer; it fires only after ~1 s of no new
      // stream events, delivering a composed toolless answer without waiting on
      // the unreliable turn_duration signal or the ~150 s orphaned backstop.
      resetAnswerReadyFlushTimeout()

      if (isContextExhaustionText(ev.text) && turn != null) {
        const chatId = turn.sessionChatId
        const threadId = turn.sessionThreadId
        const now = Date.now()
        if (now - getLastContextExhaustionWarningAt() < CONTEXT_EXHAUSTION_COOLDOWN_MS) return
        setLastContextExhaustionWarningAt(now)
        process.stderr.write(`telegram gateway: context exhaustion detected — notifying user\n`)
        const warnOpts = {
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        }
        // #1075: thread-id-bearing, fire-and-forget — swallow on
        // THREAD_NOT_FOUND so a deleted topic doesn't crash the gateway.
        void swallowingApiCall(
          () =>
            // allow-raw-bot-api: wrapped in swallowingApiCall (retry policy)
            bot.api.sendRichMessage(
              chatId,
              richMessage('⚠️ **Context window full** — send \`/restart\` to start a fresh session.'),
              warnOpts,
            ),
          {
            chat_id: chatId,
            verb: 'context-exhaust-warning',
            ...(threadId != null ? { threadId } : {}),
          },
        )
        // #1713: context-exhaustion is a terminal failure path — paint 😱
        // and finalize the controller. `setError` alone is non-terminal
        // (recovery permitted); since this turn is genuinely ending, route
        // through `finalize('error')` so the emoji lands and the controller
        // stops accepting further transitions.
        finalizeStatusReaction(chatId, threadId, 'error')
        // Surfaced during CC-5 investigation (`docs/status-ask-cause-classes.md`):
        // the context-exhaust bail path teardown was missing
        // `silencePoke.endTurn(key)`. Without it, the silence-poke state for
        // this turn lingers in the Map. Once 300s of clock-time passes from
        // the turn's original start, the framework fallback fires and the
        // gateway sends a user-visible "still working… (no update from agent
        // in 5 min)" message — for a turn the gateway internally considers
        // dead and has already told the user is over (the ⚠️ Context window
        // full message above). Match the pattern used at the regular
        // turn-end path (line ~5039) and the wedged-turn path (~5290).
        const ceKey = statusKey(chatId, threadId)
        silencePoke.endTurn(ceKey)
        pendingProgress.noteTurnEnd(ceKey)
        // Issue #195: tear down the answer-lane stream on context-exhaustion
        // bail-out. The user is being told the session needs /restart, so any
        // partially-streamed answer would be misleading.
        if (turn.answerStream != null) {
          turn.answerStream.stop()
          turn.answerStream = null
        }
        // Null the atom — this turn is being abandoned.
        endCurrentTurnAtomic(turn)
        // #549 fix — context-exhaustion teardown also resets preamble state.
        preambleSuppressor.reset()
      }
      return
    }
    case 'tool_result': {
      if (ev.toolUseId) typingWrapper.onToolResult(ev.toolUseId)
      // Fix 1.3 (#2903): flush a staged 📌/✂️ memory-legibility line only on a
      // CONFIRMED-successful write; a failed write (ev.isError) drops it.
      confirmMemoryLegibility(ev.toolUseId, ev.isError)
      return
    }
    case 'sub_agent_tool_use': {
      const turn = getCurrentTurn()
      if (turn == null) return
      if (!ev.toolUseId) return
      typingWrapper.onToolUse(ev.toolUseId, turn.sessionChatId, ev.toolName, turn.sessionThreadId ?? null)
      return
    }
    case 'sub_agent_tool_result': {
      if (ev.toolUseId) typingWrapper.onToolResult(ev.toolUseId)
      return
    }
    case 'turn_end': {
      // DEFENSIVE FIX: belt-and-braces guard against the synthetic backstop
      // (`durationMs: -1`) racing live work. durationMs >= 0 is the
      // authoritative signal from system/turn_duration; -1 is ONLY ever set
      // by the orphaned-reply backstop. Reject the synthetic event here so that
      // even if the PRIMARY fix's re-arm logic is bypassed (e.g. a very fast
      // fire before isLegitimatelyWorking() is sampled) we still don't tear
      // down a live feed mid-work. Extended from the original isMidToolCall()
      // check to the full isLegitimatelyWorking predicate so detached background
      // work and human-wait tools (ask_user) are also protected.
      // INVARIANT: a REAL turn_end (durationMs >= 0) is NEVER suppressed.
      // PR A carve-out: the answer-ready quiescence flush also uses
      // `durationMs:-1`, but it is a POSITIVE "streaming has settled" signal
      // fired only after ~1 s of no stream events AND no in-flight tool — the
      // exact opposite of a hung turn. It must NOT be suppressed by
      // recentlyStreaming (the terminal answer text itself stamps that window,
      // which is the whole bug). Its own arm/fire predicate already re-verified
      // quiescence, so let it through to deliver.
      if (ev.durationMs === -1 && ev.reason !== 'answer-ready-quiescence') {
        const turn = getCurrentTurn()
        const key = turn != null ? statusKey(turn.sessionChatId, turn.sessionThreadId) : ''
        // Widened to also suppress while the turn is RECENTLY STREAMING — a
        // model reasoning pause emits no tool/text events (so
        // isLegitimatelyWorking is false) but a genuine stream landed within
        // the window, so the turn is alive and must not be torn down.
        // ACCEPTED TRADE-OFF (F3): the context-exhaustion recovery latency via
        // THIS backstop path grows from ~30 s to ~120-150 s, because the
        // "Prompt is too long" marker is itself a genuine `text` event that
        // stamps recentlyStreaming. This is acceptable — the primary
        // context-exhaustion teardown is the immediate `endCurrentTurnAtomic`
        // in `case 'text'` (isContextExhaustionText) above; this backstop only
        // matters if that path is missed, and it still COMPLETES once the
        // window lapses. Recovery is delayed, never suppressed forever.
        const recentlyStreaming =
          turn != null && turn.liveness.recentlyStreaming(Date.now(), ORPHANED_REPLY_STREAM_WINDOW_MS)
        if (isLegitimatelyWorking(key) || recentlyStreaming) {
          process.stderr.write(
            `telegram gateway: synthetic turn_end suppressed — legitimately working` +
            ` (in_flight=${toolFlightTracker.inFlightCount()},` +
            ` recently_streaming=${recentlyStreaming},` +
            ` bg_work=${turn != null ? pendingProgress.hasPendingAsyncDispatch(key) : false})\n`,
          )
          return
        }
      }
      // #4173 — every turn_end that PROCEEDS (a real turn_end always; a
      // synthetic one only past the suppression guard above) is a completion
      // signal for any flush window still open from an EARLIER turn: the
      // serial session has reached a stop, so that turn's own late reply can
      // now only arrive as a bounded replay. Close them BEFORE this event's
      // own processing — the quiescence-flush branch below may OPEN a new
      // window for THIS turn right after. The common case this serves: the
      // flush's synthetic turn_end tore the atom down, so when the REAL
      // turn_end for that same turn lands here it finds no live atom and
      // otherwise no-ops — this close is how that real turn_end is observed.
      closeFlushCompletionWindows(flushedTurnSupersede, Date.now())
      // #2094 finding 1 — turn_end gate-wedge backstop. Capture the turn
      // BEFORE the body runs (the body re-reads currentTurn as `turn`, then
      // nulls it via endCurrentTurnAtomic on every clean branch). The guarded
      // finally in withTurnEndGateBackstop forces the canonical purge iff a
      // throw in a pre-purge op (redactOutboundText, progressDriver?.
      // takeOverCard, narrative dedup, answer-stream finalize, …) skipped
      // endCurrentTurnAtomic → purgeReactionTracking, which would otherwise
      // leave activeTurnStartedAt populated (and the machine un-turnEnded)
      // and wedge the #1556 inbound gate closed until the TTL tick. No-op on
      // the happy path (key already gone).
      const turnEndBackstopTurn = getCurrentTurn()
      const turnEndBackstopKey =
        turnEndBackstopTurn != null
          ? statusKey(turnEndBackstopTurn.sessionChatId, turnEndBackstopTurn.sessionThreadId)
          : null
      withTurnEndGateBackstop(
        turnEndBackstopKey,
        turnEndBackstopTurn,
        () => {
      // Drain any still-pending tool dispatch typing entries — covers
      // transcript truncation or a Claude Code crash mid-tool.
      typingWrapper.drainAll()
      // Forum-topic placeholder cleanup removed in #553 PR 5 — the
      // forum-topic placeholder send is also gone, so there is
      // nothing to clear at turn_end.
      //
      // #1067: capture the turn atom at handler entry. The IIFE that
      // runs turn-flush below is async, so every read after the first
      // await would be subject to the reattribution race we're fixing.
      // All downstream code reads `turn.*` or its captured locals.
      const turn = getCurrentTurn()
      if (turn?.orphanedReplyTimeoutId != null) {
        clearTimeout(turn.orphanedReplyTimeoutId)
        turn.orphanedReplyTimeoutId = null
      }
      // Narrative-dedup gate step 3 (JSONL-text-narrative primitive): a
      // trailing narrative block with nothing after it. When the turn
      // delivered its answer via reply (replyCalled) the trailing text is
      // almost always a draft of that answer — compare against the ACTUAL
      // delivered reply text and SUPPRESS the duplicate; otherwise SHOW
      // genuine trailing narration ("Done — all green."). Must run BEFORE
      // clearActivitySummary so a SHOWN line lands in the feed's final
      // render. Always clears the gate's parked block (and disarms its
      // early-paint timer) so nothing can leak across turns.
      //
      // NIT 2 (reply-proxy precision): use `turn.lastReplyText` (the
      // most-recent reply/stream_reply input.text) rather than
      // `capturedText.join('')`. The old proxy concatenated every captured
      // text block, so a turn that emitted the same short string twice
      // (e.g. "Done." as working narration, then "Done." as the reply) would
      // compare the trailing narration against a doubled "DoneDone" — still
      // a high-prefix match — and wrongly suppress genuine trailing
      // narration. Comparing against the actual reply text is exact. When
      // the turn delivered WITHOUT a reply tool (turn-flush emits
      // capturedText as the answer), fall back to capturedText.join('') so
      // that path's trailing-draft suppression is preserved.
      if (turn != null) {
        const deliveredText = turn.lastReplyText.length > 0
          ? turn.lastReplyText
          : (turn.replyCalled ? turn.capturedText.join('') : '')
        flushPendingNarrativeAtTurnEnd(turn, deliveredText)
      }
      // Clear the activity feed at the real end of the turn. This is the
      // no-reply safety net — a turn that ends without ever calling reply
      // (the answer is delivered by turn-flush / silent-end) still has its
      // feed removed. On a normal turn the feed was already cleared at the
      // first reply (the hand-off); clearActivitySummary is idempotent, so
      // the second call is a no-op.
      if (turn != null) {
        clearActivitySummary(turn)
      }
      // #549 fix — flush any pending preamble BEFORE the answer stream is
      // nulled below. Text emitted immediately before turn_end (no tool
      // followed) is the answer; the suppressor's emitAnswer callback
      // would no-op against a nulled stream, silently dropping the text
      // (regression for short no-tool replies). Order matters here: this
      // call must come before the retract/null block.
      preambleSuppressor.flushNow()
      // #656: by default we ALWAYS retract the answer-lane stream at
      // turn_end. Turn-flush is the canonical emitter for no-reply
      // turns; materialising here would race it and post raw model
      // text (no HTML conv).
      //
      // #869-Phase1 override: when `ANSWER_STREAM_VISIBLE_ENABLED` is
      // on, the stream is rendering a USER-VISIBLE message in the
      // chat timeline. When the stream is the de-facto final answer
      // (model never called reply, captured text is substantive), we
      // need to:
      //   1. Send a FRESH pinged message via `stream.materialize()`
      //      so the user gets a device notification — beat 5 of the
      //      conversational-pacing contract requires exactly one
      //      ping per turn for the final answer. Without this,
      //      text-only short turns ("on it" being the whole reply)
      //      land silently and the user has no notification to know
      //      the answer arrived (the failure caught by the
      //      midturn-silent-dm UAT, 2026-05-25).
      //   2. Delete the silent streamed preview message so the user
      //      doesn't see a duplicate (the streamed message in place
      //      + the fresh materialized ping). materialize() handles
      //      the fresh send but leaves the old streamed message_id
      //      orphaned by design — we delete it explicitly here.
      //
      // The previous behavior (just `stream.stop()` to freeze the
      // streamed message in place) avoided the duplicate but also
      // skipped the ping. Materialize-and-delete trades a brief
      // visual "the streamed message is replaced by a fresh one"
      // (often imperceptible for short turns where the streaming
      // barely had time to register; mildly visible for longer
      // turns) in exchange for an always-correct turn-end ping.
      let streamFinalizedAsAnswer = false
      if (turn?.answerStream != null) {
        const stream = turn.answerStream
        const streamedMsgId = stream.messageId()
        const streamedFinalText = turn.capturedText.join('').trim()
        if (
          // Only when a VISIBLE preview actually opened (visible flag on): a
          // text-only no-reply turn that streamed a visible preview must
          // materialize a pinged final answer + delete the preview, NOT fall into
          // the else-branch retract() which would delete the user's only copy of
          // the answer (a lost-answer bug). Gated on the visible flag alone (the
          // flash-regression decoupling): with the visible stream OFF (default)
          // no preview opens (minInitialChars:MAX), so streamedMsgId is null and
          // this branch is unreachable — the no-reply answer is delivered by the
          // turn-flush backstop below instead, the pre-v0.14.68 path. The
          // reply-tool branch hits retract() on a non-opened lane (a no-op), so
          // there is no preliminary to flash.
          ANSWER_LANE.opensVisiblePreview
          && !turn.replyCalled
          && streamedMsgId != null
          && streamedFinalText.length > 0
        ) {
          turn.answerStream = null
          streamFinalizedAsAnswer = true
          turn.finalAnswerDelivered = true
          // Feed-reopen refinement: the stream is being finalized as the
          // turn's answer (the model's terminal text), i.e. done=true by
          // construction → substantive. Post-answer housekeeping must NOT
          // re-open the feed.
          turn.finalAnswerSubstantive = true
          // Capture the old streamed message_id BEFORE materialize so
          // we can delete it after the fresh ping send. materialize()
          // overwrites `streamMsgId` internally with the new send's id;
          // without capturing here we'd lose the reference.
          const oldStreamedMsgId = streamedMsgId
          // Fire-and-forget materialize-and-delete sequence.
          //
          // Bookkeeping (dedup + history): handled inside
          // `materialize()` itself — see `answer-stream.ts:~548-549`
          // which calls the injected `recordDedup` + `recordOutbound`
          // callbacks with the NEW (fresh-send) message_id only after a
          // successful send. We deliberately do NOT pre-record here —
          // doing so populates the same `outboundDedup` store that
          // materialize's internal `checkDedup` consults at
          // `answer-stream.ts:~510`, causing materialize to dedup-
          // suppress its own send (return undefined, no ping fires) —
          // the exact failure mode this PR exists to fix. Let
          // materialize own the bookkeeping; gateway only sequences the
          // operations.
          //
          // Delete gating: only run the cleanup `deleteMessage` if
          // materialize actually sent (returned a numeric sentId). If
          // it dedup-suppressed or threw, the streamed preview is the
          // user's only copy of the answer and MUST be preserved.
          void (async () => {
            let materializedId: number | undefined
            try {
              materializedId = await stream.materialize()
            } catch (err) {
              process.stderr.write(
                `telegram gateway: answer-stream materialize failed: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              )
              return
            }
            if (typeof materializedId !== 'number' || !Number.isFinite(materializedId)) {
              // materialize() returned undefined — either pendingText
              // was empty, the body was a silent marker (NO_REPLY /
              // HEARTBEAT_OK), or `checkDedup` suppressed it. In every
              // such case the streamed preview is the user's only copy
              // of the content; don't delete it.
              process.stderr.write(
                `telegram gateway: answer-stream materialize returned no msgId ` +
                `chat=${turn.sessionChatId} oldMsg=${oldStreamedMsgId} — ` +
                `preserving silent preview as the user's only copy\n`,
              )
              return
            }
            // Materialize sent a fresh pinged message at materializedId.
            // Delete the silent streamed preview so the chat shows one
            // canonical message (the fresh pinged one) and not two with
            // duplicate content. Best-effort; failures (already gone,
            // permission denied) leave a brief visible duplicate which
            // we accept rather than retry-storming.
            try {
              // allow-raw-bot-api: cleanup delete of silent streamed preview
              await bot.api.deleteMessage(turn.sessionChatId, oldStreamedMsgId)
            } catch (delErr) {
              process.stderr.write(
                `telegram gateway: answer-stream materialize-cleanup ` +
                `delete failed for msgId=${oldStreamedMsgId}: ${
                  delErr instanceof Error ? delErr.message : String(delErr)
                }\n`,
              )
            }
            process.stderr.write(
              `telegram gateway: answer-stream materialized as answer ` +
              `chat=${turn.sessionChatId} oldMsg=${oldStreamedMsgId} ` +
              `newMsg=${materializedId} chars=${streamedFinalText.length}\n`,
            )
          })()
        } else {
          turn.answerStream = null
          void stream.retract().catch((err) => {
            process.stderr.write(
              `telegram gateway: answer-stream retract failed: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          })
        }
      }
      if (turn == null) return
      const chatId = turn.sessionChatId
      const threadId = turn.sessionThreadId
      const ctrl = activeStatusReactions.get(statusKey(chatId, threadId))

      // #1122 PR3: #51 prose-as-step recovery removed with the
      // progress card. Without the card there's no narrative-steps
      // surface to recover from. The decideTurnFlush 'empty-text'
      // path now relies on capturedText alone.

      // #869-Phase1: when the answer-stream finalised as the answer
      // above, skip the turn-flush IIFE entirely — its job (deliver
      // captured text) is already done by the visible stream, and
      // running it would race a duplicate fresh-sendMessage against
      // the user-visible edited message.
      const flushDecision = streamFinalizedAsAnswer
        ? ({ kind: 'skip', reason: 'reply-called' } as ReturnType<typeof decideTurnFlush>)
        : decideTurnFlush({
            chatId: turn.sessionChatId,
            replyCalled: turn.replyCalled,
            capturedText: turn.capturedText,
            capturedBlockMeta: turn.capturedBlockMeta,
            flushEnabled: TURN_FLUSH_SAFETY_ENABLED,
          })
      // #1667 — resolve the turn_end answer-delivery gate once, here, via the
      // pure decision core. The three dispositions below (silent-marker,
      // turn-flush, #1664 re-prompt) delegate to this so the gateway runs the
      // exact code the regression test exercises. `finalAnswerDelivered` is read
      // at its tail value: the answer-stream materialize branch above has
      // already run (and may have set it true); the flush branch, which also
      // sets it, is not yet entered and does not affect the gate's own outcome.
      const turnEndDecision = decideTurnEndGate({
        flushDecision,
        finalAnswerDelivered: turn.finalAnswerDelivered,
      })
      if (flushDecision.kind === 'skip' && flushDecision.reason !== 'reply-called') {
        process.stderr.write(
          `telegram gateway: turn-flush skipped — reason=${flushDecision.reason}\n`,
        )
        // Ghost-reply detection (#45): the model ended a Telegram-inbound turn
        // without calling reply/stream_reply AND without emitting any assistant
        // text that the turn-flush could forward. The user will see only the
        // progress card disappear — no visible output. Log a prominent warning
        // so this silent-drop pattern is immediately visible in the logs.
        if (
          flushDecision.reason === 'empty-text' &&
          !turn.replyCalled
        ) {
          process.stderr.write(
            `telegram gateway: WARN ghost-reply detected — turn ended with zero outbound messages` +
            ` chat=${chatId} turnStartedAt=${turn.startedAt} replyCalled=false capturedText=empty` +
            ` — the progress card steps were the only thing the user saw (#45)\n`,
          )
          // #2527: emit structured WARN so the reaction-only failure mode is
          // machine-readable in the streaming-metrics channel.
          const tKey = statusKey(chatId, threadId)
          logStreamingEvent({
            kind: 'turn_no_reply_warn',
            chatId,
            threadId,
            turnId: turn.turnId,
            turnDurationMs: computeTurnDurationMs(turn.startedAt, Date.now()),
            reactionCount: reactionTransitionCounts.get(tKey) ?? 0,
          })
        }
      }

      // ── Sentinel suppression (NO_REPLY / HEARTBEAT_OK) ──────────────────
      // When the model's only output is a silent-turn sentinel we must:
      //  1. NOT finalise the progress card (that would push a "Done" edit).
      //  2. NOT send any reply message to the user.
      //  3. Unpin the progress card so no orphaned ⚙️ Working… lingers.
      //  4. Log at debug level and fall through to normal state cleanup.
      if (turnEndDecision === 'silent_end') {
        // Don't try to distinguish NO_REPLY vs HEARTBEAT_OK in the log line:
        // `isSilentFlushMarker` accepts trailing punctuation (e.g. "NO_REPLY.")
        // and case variants, so a strict equality check would print the wrong
        // reason. The flushDecision.reason is the source of truth.
        process.stderr.write(
          `telegram gateway: silent-turn-suppression: chat=${chatId} turnKey=${turn.startedAt} reason=silent-marker\n`,
        )
        // Drop progress-card streams without finalising — the normal
        // closeProgressLane call below would call stream.finalize() which
        // sends a final "Done" edit to Telegram. Skip that for silent turns.
        const suppressPrefix = chatKeyWithSuffix(chatId, threadId, 'progress')
        for (const [key] of activeDraftStreams) {
          if (key.startsWith(suppressPrefix)) {
            activeDraftStreams.delete(key)
          }
        }
        // Unpin without editing the message so no orphaned card lingers.
        unpinProgressCardForChat?.(chatId, threadId)
        // Fall through to normal state cleanup (finalize, purge, etc.)
        // but skip the regular closeProgressLane so we don't re-finalize.
        // #1713: silent-marker turns still finalize to 👍 — turn_end is
        // the terminal trigger regardless of whether a reply landed.
        finalizeStatusReaction(chatId, threadId, 'done')
        // Match the normal turn_end path's telemetry so silent-marker turns
        // still appear in turn-duration graphs.
        {
          const sKey = streamKey(chatId, threadId)
          const turnDurationMs = computeTurnDurationMs(turn.startedAt, Date.now())
          logStreamingEvent({
            kind: 'turn_end',
            chatId,
            durationMs: turnDurationMs,
            suppressClearedCount: suppressPtyPreview.has(sKey) ? 1 : 0,
          })
          // #203: compute trailing gap (last signal → turn_end) then emit.
          const tKey = statusKey(chatId, threadId)
          signalTracker.noteSignal(tKey, Date.now())
          logStreamingEvent({ kind: 'turn_signal_gap', chatId, longestGapMs: signalTracker.getLongestGap(tKey), turnDurationMs })
          // #1122 KPI: emit turn_ended (silent-marker path) with TTFO +
          // outbound-gap metrics for the conversational-pacing dashboard.
          const outboundMetrics = signalTracker.getOutboundMetrics(tKey)
          emitRuntimeMetric({
            kind: 'turn_ended',
            chat_id: chatId,
            thread_id: threadId ?? null,
            duration_ms: turnDurationMs,
            ttfo_ms: outboundMetrics.ttfoMs,
            outbound_count: outboundMetrics.outboundCount,
            longest_silent_gap_ms: outboundMetrics.longestOutboundGapMs,
            ended_via: 'silent',
          })
          // #1122 PR4 fix: deterministic silent-end detection for the
          // Stop hook. PR3 deleted the writer with the progress card;
          // this restores it. If the user-message turn ended without
          // any outbound, write the state file so silent-end-interrupt
          // -stop.mjs blocks the stop and re-prompts the agent.
          if (outboundMetrics.outboundCount === 0) {
            writeSilentEndState({
              chatId,
              threadId: threadId ?? null,
              turnKey: tKey,
            })
          }
          // #1122 PR4 fix: PR3 removed the progressDriver.onTurnComplete
          // callback that cleared the turn-active marker on silent-marker
          // turns. The main turn-end path at ~line 5180 has its own
          // cleanup (#550 defence-in-depth) but the silent-marker path
          // relied solely on the driver callback. Without this the
          // bridge-watchdog (#412) reads a stale marker and could
          // false-positive wedge-detection across silent turns.
          try { removeTurnActiveMarker(STATE_DIR) } catch { /* best-effort */ }
          signalTracker.clear(tKey)
          silencePoke.endTurn(tKey)
          pendingProgress.noteTurnEnd(tKey)
        }
        lastPtyPreviewByChat.delete(statusKey(chatId, threadId))
        setPendingPtyPartial(null)
        closeActivityLane(chatId, threadId)
        // NOTE: closeProgressLane intentionally skipped — streams already dropped above.
        // #1067: null the atom so any late-arriving event for THIS turn
        // returns early at handler entry. A new `enqueue` swaps in a
        // fresh atom; the silent-turn teardown doesn't need to preserve
        // any of the prior turn's state.
        endCurrentTurnAtomic(turn)
        // #549 fix — silent-marker teardown drops any pending preamble.
        preambleSuppressor.dropNow()
        return
      }

      if (turnEndDecision === 'flush' && flushDecision.kind === 'flush') {
        // Component 3 — origin-thread backstop. `chatId`/`threadId` are
        // captured from the turn atom (turn.sessionChatId/sessionThreadId)
        // at the top of this turn_end handler, NOT from the live
        // currentTurn and NEVER from chatThreadMap. So the turn-flush
        // answer always lands in the thread the turn originated from, even
        // if currentTurn has flipped — the same guarantee the reply path
        // gets via origin_turn_id.
        const backstopChatId = chatId
        const backstopThreadId = threadId
        const backstopCtrl = ctrl

        // #3501: route through the single shared outbound seam. Turn-flush
        // delivers the model's terminal prose when it skipped reply/stream_reply
        // and used to hand-mirror the reply pipeline inline (repair → paragraph-
        // break → redact → punctuation/bold → voice scrub). `normalizeOutboundBody`
        // IS that pipeline with the same load-bearing order — the metric side
        // effect (voice_scrub_applied on a non-zero replacement) is emitted here
        // by the caller, exactly as the reply/edit sites do.
        const _flushNorm = normalizeOutboundBody(
          flushDecision.text,
          'turn_flush',
          redactOutboundText,
          // #3501 temporal pass — a cron/mail-watcher notification that skipped
          // reply is delivered here, so this is where "closed tomorrow (Thu 23
          // Jul)" gets corrected against the agent's local date.
          { tz: resolveEnvTimezone(), nowMs: Date.now() },
        )
        let capturedText = _flushNorm.text
        if (_flushNorm.voiceReplaced > 0) {
          emitRuntimeMetric({
            kind: 'voice_scrub_applied',
            chatKey: statusKey(backstopChatId, backstopThreadId),
            replaced: _flushNorm.voiceReplaced,
            site: 'turn_flush',
          })
        }

        // #1664 — turn-flush only fires when !replyCalled (decideTurnFlush
        // returns 'reply-called' otherwise). It legitimately delivers the
        // model's terminal text as the answer, so the turn IS answered.
        // Mark it now so the early-return below skips the silent-end
        // re-prompt for a turn whose answer is genuinely on its way out.
        // (The IIFE that actually sends runs after this branch's `return`;
        // since the silent-end block is on the sibling reply-called path
        // that this branch never reaches, this set is belt-and-braces —
        // it keeps the captured `turn` atom internally consistent for any
        // future reader.)
        // PR B (Fix 4 — intentional record/ledger inconsistency, out of scope).
        // We keep setting finalAnswerDelivered=true HERE (before the async send)
        // so endCurrentTurnAtomic's obligation CLOSE (decideObligationTurnEnd,
        // ~4818) fires unchanged at turn end. PR B only makes the turns.jsonl
        // *record* honest (status send_failed when the send later throws) — it
        // deliberately does NOT change obligation behavior. Consequence: a
        // send_failed turn still CLOSES its obligation, so a flood-dropped
        // answer is NOT re-presented — an honest record without honest recovery.
        // Re-delivery on send_failed (drive obligation close from real send
        // success, leave it open on failure) is a separate change — see the
        // PR-B handback FOLLOW-UP note; do NOT touch the ledger in this PR.
        turn.finalAnswerDelivered = true
        // Feed-reopen refinement: turn-flush delivers the model's terminal
        // transcript text as the genuine answer (not an ack). Default to
        // substantive so a late tool label does NOT re-open the feed / trip
        // the silent-end re-prompt. (Belt-and-braces, like the set above —
        // this branch returns before any further tool_label can arrive.)
        turn.finalAnswerSubstantive = true
        // 2026-07 double-reply-on-DM fix (Part 2) — arm the answer-delivered
        // race latch NOW, synchronously, BEFORE the ~500 ms async send below and
        // BEFORE `flushedTurnSupersede.record`. A late reply that lands in the
        // post-fire pre-record window resolves this turn (via the unified owner
        // resolver, reading the atom preserved in `recentTurnsById`) and
        // suppresses itself against this latch — closing the residual race Part
        // 1's supersede cannot reach. `capturedText` here is the selected,
        // normalized flush delivery text.
        //
        // #3276 guard 2/5 — the arm is now UNCONDITIONAL (dropped the former
        // ≥`FLUSH_SUBSTANTIVE_MIN_CHARS` gate). A short terminal answer ("yes,
        // done") is a genuine answer this backstop is about to deliver, so a
        // late reply carrying the same short answer MUST supersede/suppress
        // rather than post a duplicate — the real-id supersede recorded below
        // corrects it in place.
        //
        // TWO distinct arbiters set synchronously here, before any `await`:
        //   (a) `turn.answerDelivered = 'flush'` — the backstop-vs-LATE-REPLY
        //       signal the reply path already reads
        //       (`decideAnswerLatchSuppression` + `flushedTurnSupersede`).
        //       Source-tagged 'flush' (#3426): the late-reply suppression is
        //       scoped to flush-armed latches, so a later async handback
        //       attributed to a reply-delivered ended turn is never dropped.
        //   (b) `backstopDeliveryLedger.claim` — the backstop-vs-BACKSTOP
        //       double-fire latch: `claim` returning false means this turn
        //       already fired a backstop (answer-ready quiescence, then the
        //       turn-end backstop), so this fire is a no-op. It does NOT
        //       arbitrate the late reply (that is (a)); it is redundant-but-
        //       cheap with the `currentTurn == null` bail below.
        turn.answerDelivered = 'flush'
        // #3429 — stamp WHAT the flush is delivering alongside the arm, so the
        // late-reply suppression can discriminate by content: a late reply
        // carrying this same answer is the flush race (suppress/supersede); a
        // late reply carrying DIFFERENT content is a genuinely new async
        // handback attributed to this ended turn and must send fresh.
        turn.flushedAnswerText = capturedText
        const backstopLatchClaimed = backstopDeliveryLedger.claim(turn.turnId)

        // #654 deterministic double-message fix. Hand off the pinned
        // progress card BEFORE state reset so the driver doesn't keep
        // editing it while turn-flush is rewriting it with the answer.
        // `wasEmitted` tells us whether the card has already been
        // published; `turnKey` lets us look up the pinned messageId
        // via pinMgr below. Idempotent — calling later in the IIFE
        // would be no-op against the same chatState.
        const cardTakeover = progressDriver?.takeOverCard({
          chatId: backstopChatId,
          threadId: backstopThreadId != null ? String(backstopThreadId) : undefined,
        }) ?? { wasEmitted: false, turnKey: null }
        const backstopCardMessageId =
          cardTakeover.wasEmitted && cardTakeover.turnKey != null
            ? (getPinnedProgressCardMessageId?.(cardTakeover.turnKey) ?? null)
            : null
        const backstopCardTurnKey = cardTakeover.turnKey

        // #1067: null the atom BEFORE the async IIFE starts. Any event
        // that arrives during the 500ms-suppression window or the
        // sendMessage await for this turn will see currentTurn == null
        // and bail; a new enqueue will swap in a fresh atom. The
        // `backstop*` locals above hold everything the IIFE needs.
        //
        // PR B — defer the turns.jsonl record write to the send IIFE below so
        // the recorded `status` reflects the REAL send outcome, not the
        // speculative `finalAnswerDelivered=true` set just above. Everything
        // else in endCurrentTurnAtomic (atom null, gate release, obligation
        // bookkeeping, purge) still runs synchronously here for the #1067 /
        // #1556 wedge-safety reasons. `backstopTurnEndedAt` is null iff the
        // atom was already torn down elsewhere (no record to emit).
        const backstopTurnEndedAt = endCurrentTurnAtomic(turn, { deferRecord: true, deferObligationClose: true })
        // #4173 — the ANSWER-READY QUIESCENCE variant of this branch ends the
        // turn SYNTHETICALLY (durationMs === -1): the claude session is still
        // composing and its REAL turn_end arrives later. Re-open the atom's
        // completion window (endCurrentTurnAtomic just stamped
        // `realEndObservedAt` with the default "ended = really ended" rule) and
        // hold it pending, so the supersede window for this flush stays
        // claimable until the real turn_end — or a proxy — is observed. This is
        // what makes a same-session reply landing after a 20-minute /compact
        // still collapse onto the flushed message (#4166), without holding the
        // window open for even a second once the session actually stops.
        // The TURN-END BACKSTOP variant (durationMs >= 0) fires ON the real
        // turn_end: the session already stopped, so its window is born
        // completed (grace-bounded) — it must NOT be re-opened.
        if (ev.durationMs === -1) {
          flushCompletionTracker.open(turn)
        }
        // #549 fix — turn-flush takes ownership of the captured-text
        // backup; reset the preamble buffer (its content is already in
        // the captured `capturedText`, which turn-flush is about to send).
        preambleSuppressor.dropNow()
        // #1289 fix — drain silence-poke + signal-tracker state for this
        // turn. The three sibling turn_end exit branches (context-exhaust
        // at ~5098, silent-marker at ~5097-5098, default reply-called tail
        // at ~5348-5349) all call signalTracker.clear + silencePoke.endTurn.
        // The flush-backstop branch was retrofitted in #1067 to null
        // currentTurn early but never had this cleanup added — leaving the
        // silence-poke state in the Map, so 300s after the original turn
        // start the framework fallback fires and the user sees
        // "still working… (no update from agent in 5 min)" on a turn the
        // gateway already considers over.
        {
          const tKey = statusKey(chatId, threadId)
          signalTracker.clear(tKey)
          silencePoke.endTurn(tKey)
          pendingProgress.noteTurnEnd(tKey)
        }

        void (async () => {
          await new Promise<void>(resolve => setTimeout(resolve, 500))
          if (HISTORY_ENABLED) {
            try {
              // S1 fix (fable red-team 2026-07-17) — the old predicate here,
              // `getRecentOutboundCount(chatId, 2) > 0`, counted ANY assistant
              // row in the WHOLE chat: a worker `progress_update`, a command
              // ack / restart notice, or a reply in a DIFFERENT forum topic all
              // suppressed the flush and (worse) CLOSED the obligation below —
              // silently dropping the user's real answer. The scoped predicate
              // (same thread, length ≥ min(answerLength, 200)) lives in
              // `turn-flush-suppression.ts`; `hasOutboundDeliveredSince` is the
              // durable oracle whose thread/length semantics history tests pin.
              const { hasOutboundDeliveredSince } = await import('../history.js')
              const { shouldSuppressTurnFlush } = await import('./turn-flush-suppression.js')
              const suppress = shouldSuppressTurnFlush(
                { hasSubstantiveOutbound: hasOutboundDeliveredSince },
                {
                  chatId: backstopChatId,
                  threadId: backstopThreadId ?? null,
                  answerLength: capturedText.length,
                  nowMs: Date.now(),
                },
              )
              if (suppress) {
                process.stderr.write(`telegram gateway: turn-flush suppressed — a substantive same-thread outbound landed within 2s\n`)
                // Do NOT finalize the status reaction here. As of #1713
                // the reaction is only finalized by the `turn_end` IPC
                // handler — mid-turn delivery proofs (local history,
                // stream finalize callbacks, executeReply post-send) no
                // longer transition the emoji. This branch just returns.
                // #2094 cosmetic: the per-turn reaction tracking was ALREADY
                // purged synchronously by endCurrentTurnAtomic (before this
                // async IIFE ran). The old redundant purgeReactionTracking
                // here re-fired on an already-cleared key WITHOUT `endingTurn`,
                // emitting an inconsistent shadow trace. Removed.
                //
                // PR B — a substantive same-thread outbound just delivered this
                // turn's answer, so the flush was legitimately suppressed. Emit
                // the deferred record as 'suppressed'. Not a failure.
                if (backstopTurnEndedAt != null) {
                  turn.deliveryOutcome = 'suppressed'
                  // S1 fix — do NOT close the obligation here. When the recent
                  // outbound is genuinely this turn's answer (a raced reply /
                  // stream materialization), the reply path closes its own
                  // obligation idempotently; when the suppression is a false
                  // positive (a long same-thread non-answer inside the 2s
                  // window — the residual the scoped predicate can't
                  // discriminate), closing here made the drop PERMANENT.
                  // Leaving it open lets the obligation sweep arbitrate: it
                  // stands down silently if a substantive outbound answered
                  // the user, and re-presents otherwise. `noteTurnEnded` arms
                  // the liveness floor exactly as the send-failed path does.
                  if (OBLIGATION_LEDGER_ENABLED) obligationLedger.noteTurnEnded(turn.turnId, Date.now())
                  emitTurnRecord(turn, backstopTurnEndedAt)
                }
                return
              }
            } catch {}
          }

          // #3513 follow-up (MF2) — DURABLE exactly-once-among-backstops read.
          // The in-memory `backstopDeliveryLedger` (guard 5, below) only sees
          // fires within THIS process; it cannot see a prior backstop delivery
          // that landed in an earlier process (e.g. the Stop-hook captured-prose
          // bridge E3, or the outbox sweep E4, delivered this turn's answer, then
          // the gateway restarted and re-ran turn-flush). `backstopAlreadyDelivered`
          // scans the durable delivered-keys journal counting ONLY prior BACKSTOP
          // deliveries (sweep / flush / non-E0 reply-tool) for this nonce — it does
          // NOT count an explicit E0 reply (#3510 recap), so a legitimate later
          // explicit reply is never blocked by this guard. If a backstop already
          // delivered, this fire is a durable no-op.
          if (backstopAlreadyDelivered(turn.turnId, STATE_DIR)) {
            process.stderr.write(
              `telegram gateway: turn-flush skipped — turn ${turn.turnId} already delivered by a prior backstop (durable journal)\n`,
            )
            return
          }

          // #3276 guard 5 — double-fire guard. If this turn already claimed the
          // delivery latch (a prior backstop fire — e.g. answer-ready quiescence
          // followed by the turn-end backstop for the same turn), do NOT deliver
          // again. The first fire owns delivery; this fire is a cosmetic no-op.
          if (!backstopLatchClaimed) {
            process.stderr.write(
              `telegram gateway: turn-flush skipped — turn ${turn.turnId} already claimed the delivery latch\n`,
            )
            return
          }

          process.stderr.write(
            `telegram gateway: turn-flush firing — ${capturedText.length} chars without reply tool ` +
            `(chat=${backstopChatId} cardMsgId=${backstopCardMessageId ?? 'none'})\n`,
          )
          // PR B (Fix 1) — send accounting declared OUTSIDE the try so the
          // single-record `finally` below reads it on EVERY in-process exit.
          // `delivered` is the RECEIPT-gated truth (>=1 fresh non-card id AND
          // all chunks landed), computed by the retry orchestrator — NOT a
          // blanket outer-catch flag, so a throw in the post-delivery
          // bookkeeping below (dedup / supersede record) can never demote a
          // genuinely delivered turn to `send_failed` (finding 4).
          let sentIds: number[] = []
          let chunkCount = 0
          let delivered = false
          // Set by the send-ack claim callback below once the durable
          // delivered-keys journal has been written at ACK time — so the finally
          // block does not journal the same nonce a second time.
          let earlyJournaled = false
          try {
            // #3276 — the ONE delivery primitive. deliverAnswer routes through
            // `sendReplyChunks` (the same send core executeReply uses) and posts
            // a FRESH chat message; it NEVER edits the progress card, so a
            // "delivery" can never be a card mutation the marker-sweep GC's
            // ~60-90s later. It returns the REAL fresh chat message ids and
            // retries mid-chunk (bounded) before giving up — the per-chunk
            // ledger resumes at the first unsent chunk, never re-sending chunk 0
            // (guard 6).
            const delivery = await deliverAnswer({
              chatId: backstopChatId,
              threadId: backstopThreadId,
              text: capturedText,
              turnId: turn.turnId,
              cardMessageId: backstopCardMessageId,
              // S4 — anchor the flushed answer to the inbound it answers
              // (null for synthesized turns, which send bare as before).
              replyToMessageId: turn.sourceMessageId,
              // Duplicate-message race fix — write the DURABLE delivered-keys
              // journal at SEND-ACK, BEFORE deliverAnswer's read-back probe (which
              // the cosmetic-edit flood-fuse can defer ~30s). Without this the
              // journal write happened only in the finally below, AFTER `await
              // deliverAnswer` returned, so the outbox sweep — which waits just
              // OUTBOX_QUIET_MS (5s) before checking `deliveredNonces` — saw no
              // entry and sent a SECOND copy of this answer. Journaling under the
              // SAME nonce (turn.turnId == the Stop-hook record's turnNonce) makes
              // the sweep skip-journaled and clears any captured record.
              onAckClaim: (ackIds) => {
                try {
                  journalExternalDelivery(
                    {
                      turnNonce: turn.turnId,
                      text: capturedText,
                      tgMessageId: ackIds.length > 0 ? ackIds[0] : undefined,
                      deliverySource: 'flush',
                    },
                    STATE_DIR,
                  )
                  earlyJournaled = true
                } catch (err) {
                  process.stderr.write(
                    `telegram gateway: turn-flush send-ack journal write failed (non-fatal): ${(err as Error).message}\n`,
                  )
                }
              },
            })
            sentIds = delivery.sentIds
            chunkCount = delivery.chunkCount
            delivered = delivery.delivered
            // #3702 — how many landed ids the read-back never corroborated.
            // Stamped on the turn so `emitTurnRecord` writes `landed_unconfirmed`
            // (omitted when 0): the fleet-visible counter for deliveries we call
            // `complete` on the Bot API's ack alone, because the probe is
            // inconclusive. Observational only — it never changes the status.
            turn.landedUnconfirmed = delivery.landedUnconfirmed

            // #546 dedup: record what turn-flush just sent so a late-arriving
            // reply / stream_reply with the same content gets suppressed.
            outboundDedup.record(
              backstopChatId,
              backstopThreadId,
              capturedText,
              Date.now(),
              getCurrentTurn()?.registryKey ?? null,
            )
            // #3276 guard 3 — feed the REAL fresh chat ids into the supersede
            // record so a late `reply` for the same turn corrects them in place
            // (edit / delete+resend) instead of shipping a second bubble. These
            // are genuine chat message ids now, never a card-edit id.
            if (sentIds.length > 0) {
              flushedTurnSupersede.record(
                backstopChatId,
                backstopThreadId,
                // #4173 — inherit the atom's completion state: the async send
                // above can outlast the real turn_end (a close that ran while
                // we awaited stamped `realEndObservedAt`), and a window closed
                // before its record existed must be born completed
                // (grace-bounded), never resurrected as open.
                {
                  turnId: turn.turnId,
                  messageIds: sentIds,
                  text: capturedText,
                  completedAt: turn.realEndObservedAt,
                },
                Date.now(),
              )
            }
            // #3276 guard 4 — collapse the taken-over card to a NON-answer
            // state. The answer flowed ONLY through deliverAnswer (a fresh
            // bubble); here we just unpin/complete the card so no orphaned
            // ⚙️ Working… lingers. The card carries NO answer text, so a
            // card-collapse failure and a fresh-send failure can never leave
            // BOTH an answer-card AND an answer-bubble visible.
            if (!delivered) {
              // Retries exhausted with nothing durable delivered — finalize the
              // reaction as error and reset the latch so a genuine late reply is
              // NOT suppressed.
              if (backstopCtrl) backstopCtrl.finalize('error')
              backstopDeliveryLedger.release(turn.turnId)
              turn.answerDelivered = false
              turn.flushedAnswerText = null // #3429 — cleared with the latch
            } else if (backstopCtrl) {
              backstopCtrl.finalize('done')
            }
            // Unpin the card either way (cosmetic). completeTurn cleans up
            // pinMgr's per-turn state and unpins; fall back to the legacy
            // unpinForChat sweep when we didn't take over a turn.
            if (backstopCardTurnKey != null) {
              completeProgressCardTurn?.({
                chatId: backstopChatId,
                threadId: backstopThreadId,
                turnKey: backstopCardTurnKey,
              })
            } else {
              unpinProgressCardForChat?.(backstopChatId, backstopThreadId)
            }
          } catch (err) {
            // Only reachable via a throw in the post-delivery bookkeeping (the
            // delivery itself is retry-wrapped inside deliverAnswer and never
            // throws out). `delivered` already reflects the receipt-gated truth;
            // do NOT flip it here (finding 4). If nothing landed, reset the
            // latch so a genuine late reply is not suppressed.
            process.stderr.write(`telegram gateway: turn-flush post-delivery bookkeeping failed: ${(err as Error).message}\n`)
            if (!delivered) {
              turn.answerDelivered = false
              turn.flushedAnswerText = null // #3429 — cleared with the latch
              backstopDeliveryLedger.release(turn.turnId)
              if (backstopCtrl) backstopCtrl.finalize('error')
            }
          } finally {
            // #3276 guard 7 + finding 1 — honest record AND honest recovery.
            // Status is derived from the RECEIPT gate: `complete` IFF a fresh
            // non-card id landed for every chunk; otherwise `send_failed`.
            //
            // The delivery-obligation close was DEFERRED out of
            // endCurrentTurnAtomic (deferObligationClose) so it reflects the
            // REAL send outcome here, not the speculative fire-time flag:
            //   delivered  → close the obligation (answered).
            //   NOT deliv. → leave it OPEN + noteTurnEnded, so the ~150s
            //                liveness floor re-presents the answer instead of
            //                the old silent `send_failed` drop.
            if (backstopTurnEndedAt != null) {
              finalizeBackstopSendGated(turn, {
                threw: !delivered,
                sentIds,
                chunkCount,
                cardMessageId: backstopCardMessageId,
              })
              // #3513 follow-up (MF2) — DURABLE exactly-once-among-backstops
              // WRITE. Journal this backstop delivery to the delivered-keys
              // journal with `deliverySource:'flush'` so a later backstop in a
              // DIFFERENT process (the Stop-hook bridge E3 or the outbox sweep E4,
              // which read `backstopAlreadyDelivered`) recognises this turn's
              // answer as already delivered and skips a duplicate durably — not
              // only via the in-memory ledger, which does not survive a crash
              // between this send and the next process's backstop. Journal ONLY on
              // a receipt-gated `delivered` success. Best-effort: a journal-write
              // failure must never demote the successful delivery.
              //
              // Duplicate-message race fix: skip when the send-ack claim
              // (`onAckClaim`) already journaled this nonce at ACK time. That
              // path is the primary writer now (it runs before the read-back
              // probe); this finally write only covers the case where the claim
              // never fired — e.g. a card-only delivery where every chunk landed
              // but no fresh receipt gated the claim, yet `delivered` still held.
              if (delivered && !earlyJournaled) {
                try {
                  journalExternalDelivery(
                    {
                      turnNonce: turn.turnId,
                      text: capturedText,
                      tgMessageId: sentIds.length > 0 ? sentIds[0] : undefined,
                      deliverySource: 'flush',
                    },
                    STATE_DIR,
                  )
                } catch (err) {
                  process.stderr.write(
                    `telegram gateway: turn-flush delivered but journal write failed (non-fatal): ${(err as Error).message}\n`,
                  )
                }
              }
              if (OBLIGATION_LEDGER_ENABLED) {
                if (delivered) {
                  obligationLedger.close(turn.turnId)
                } else {
                  // Terminal fail — do NOT mark the obligation satisfied.
                  turn.finalAnswerDelivered = false
                  obligationLedger.noteTurnEnded(turn.turnId, Date.now())
                }
              }
              emitTurnRecord(turn, backstopTurnEndedAt)
            }
            // GC the IN-MEMORY ledger now; on a partial, deliverAnswer already
            // persisted the snapshot to the durable obligation (#3282) to resume.
            backstopDeliveryLedger.clear(turn.turnId)
          }
          // #2094 cosmetic: the trailing `finally { purgeReactionTracking() }`
          // was removed. endCurrentTurnAtomic already ran the canonical purge
          // (with the authoritative `endingTurn`) synchronously before this
          // async IIFE started, so re-purging here only re-fired on an
          // already-cleared key without `endingTurn` — an inconsistent shadow
          // trace. The #2094 finding-1 backstop covers any pre-purge throw.
        })()
        return
      }

      // #1713: turn_end is THE terminal trigger. Finalize via the
      // single terminal path. Any prior intermediate states pending in
      // the debounce window are flushed by `finalize()` before the
      // terminal emoji emits.
      //
      // #2527 — role-aware terminal honesty: a USER turn that ends without
      // a delivered answer must NOT paint 👍 (the operator's "thumbs up so
      // it feels like you're done" report). It finalizes to the gentle
      // 'undelivered' terminal (😐) instead; the silent-end fallback below
      // carries the apology text. system/cron turns and NO_REPLY/HEARTBEAT_OK
      // turns (which return earlier) keep 👍 — their silence is legitimate.
      let terminalReason = decideTerminalReason({
        enabled: LIVENESS_TERMINAL_HONESTY,
        role: turn.role,
        finalAnswerDelivered: turn.finalAnswerDelivered,
      })
      // #2527 review note 1 — worker-hold carve-out: if the turn is STILL
      // legitimately working at turn_end (a background sub-agent the parent
      // dispatched is running on), don't prematurely paint 😐. Fall back to
      // 'done' so the existing deferred-done path holds ✍️ until the worker
      // completes (then 👍) — the worker-activity feed carries the progress.
      // Only a turn that genuinely ended undelivered AND is not still working
      // gets the honest 😐.
      if (terminalReason === 'undelivered' && isLegitimatelyWorking(statusKey(chatId, threadId))) {
        terminalReason = 'done'
      }
      if (terminalReason === 'undelivered') {
        process.stderr.write(
          `telegram gateway: WARN turn_no_reply — user turn ended with an ` +
          `ambient ack but no delivered answer; painting 😐 not 👍 ` +
          `chat=${chatId} thread=${threadId ?? '-'} turnId=${turn.turnId} (#2527)\n`,
        )
      }
      finalizeStatusReaction(chatId, threadId, terminalReason)
      {
        const sKey = streamKey(chatId, threadId)
        const turnDurationMs = computeTurnDurationMs(turn.startedAt, Date.now())
        logStreamingEvent({
          kind: 'turn_end',
          chatId,
          durationMs: turnDurationMs,
          suppressClearedCount: suppressPtyPreview.has(sKey) ? 1 : 0,
        })
        // #203: compute trailing gap (last signal → turn_end) then emit.
        const tKey = statusKey(chatId, threadId)
        signalTracker.noteSignal(tKey, Date.now())
        logStreamingEvent({ kind: 'turn_signal_gap', chatId, longestGapMs: signalTracker.getLongestGap(tKey), turnDurationMs })
        // #1122 KPI: emit turn_ended with TTFO + outbound-gap metrics so
        // the dashboard can compute outbound silence p95 and TTFO p95
        // without per-event reconstruction.
        const outboundMetrics = signalTracker.getOutboundMetrics(tKey)
        emitRuntimeMetric({
          kind: 'turn_ended',
          chat_id: chatId,
          thread_id: threadId ?? null,
          duration_ms: turnDurationMs,
          ttfo_ms: outboundMetrics.ttfoMs,
          outbound_count: outboundMetrics.outboundCount,
          longest_silent_gap_ms: outboundMetrics.longestOutboundGapMs,
          ended_via: outboundMetrics.outboundCount > 0 ? 'reply' : 'silent',
        })
        // #1122 PR4 / #1161 / #1664: deterministic undelivered-turn
        // handling (see the silent-marker path above for the rationale).
        //   - first undelivered turn-end → recordSilentTurnEnd writes the
        //     state file so the Stop hook (silent-end-interrupt-stop.mjs)
        //     blocks the session-end and re-prompts the agent to deliver.
        //   - the Stop-hook re-prompt is already spent and the agent is
        //     STILL undelivered → recordSilentTurnEnd returns
        //     exhausted:true; deliver a user-facing fallback so the turn
        //     never just vanishes (the user otherwise only sees the card
        //     disappear).
        //
        // #1664 — the trigger is "no final answer delivered", not "zero
        // outbound". `outboundCount === 0` is now just the special case
        // where nothing landed at all. The added case: the model sent an
        // interim ack via reply/stream_reply (outboundCount > 0,
        // replyCalled = true) but ended the turn with its real answer as
        // plain transcript text — rendered into an ephemeral answer-lane
        // draft and retracted at turn_end, never finalized. finalAnswer-
        // Delivered stays false there, so the re-prompt engages and the
        // model re-delivers the answer through the reply tool. NO_REPLY /
        // HEARTBEAT_OK silent-marker turns return earlier and never reach
        // this path. The turn-flush 'flush' branch also returns earlier
        // (and sets finalAnswerDelivered=true defensively).
        // #1667 — this is the reply-called tail; `turnEndDecision === 'reprompt'`
        // is exactly `turn.finalAnswerDelivered === false` here (silent-marker
        // and flush both returned earlier), delegated to the pure gate core.
        if (turnEndDecision === 'reprompt') {
          // Option A transcript-prose bridge (#3227). Before falling through to
          // the re-prompt / represent safety nets, check whether the Stop hook
          // already isolated this turn's real answer from the transcript and
          // persisted it in silent-end-pending.json (`pendingText`). That file
          // lands BEFORE this turn_end handler runs (the hook fires upstream of
          // the gateway's own state write — see silent-end-interrupt-stop.mjs).
          // If a substantive answer is waiting, deliver it directly via the
          // normal send path NOW, instead of leaning on the (unreliable)
          // Stop-hook re-prompt or waiting ~2-5 min for the obligation
          // represent. The delivery closes the obligation + records dedup, so
          // the represent and a late reply-tool retry are both suppressed —
          // captured-prose delivery and represent are mutually exclusive.
          // Capture-divergence corner (duplicate-message fix): when this is a
          // ZERO-reply silent-end AND the gateway's OWN capture came up empty
          // (so `decideTurnFlush` had nothing to flush — its 'empty-text'
          // skip), the captured-prose bridge is the ONLY delivery machine
          // left. The Stop hook scanned the transcript and DID find the
          // model's short trailing answer, persisting it as `pendingText`. In
          // that corner the 200-char substance floor would wrongly drop a
          // legitimately-short answer that no other machine can deliver, so
          // lower the floor to 1. This is scoped tightly: only when the model
          // never called reply (`replyCalled === false`) AND the gateway
          // captured nothing — the interim-ack case (replyCalled) keeps the
          // full 200 floor (a short closer after a real reply is not a dropped
          // answer, and the hook already refuses to persist <200 there).
          const gatewayCapturedEmpty =
            turn.capturedText.join('\n\n').trim().length === 0
          const proseMinChars =
            !turn.replyCalled && gatewayCapturedEmpty ? 1 : CAPTURED_PROSE_MIN_CHARS
          const proseDecision = CAPTURED_PROSE_DELIVERY_ENABLED
            ? decideCapturedProseDelivery(
                {
                  turnKey: tKey,
                  // Per-turn nonce (#3228 Finding 3) — the persisted record must
                  // belong to THIS turn, not a stale carryover from a prior turn
                  // on the same chat/thread (tKey is not per-turn unique).
                  turnId: turn.turnId,
                  minChars: proseMinChars,
                },
                {
                  // #3513 (correction 1): refuse to bridge a block already
                  // surfaced on the ephemeral card for this turn (shown-ledger).
                  isBlockShown: (nonce, text) => isShownBlock(nonce ?? null, text),
                  // #3513 follow-up (MF2): refuse to bridge a turn a prior
                  // backstop (turn-flush E1/E2 flush, or the outbox sweep E4)
                  // already delivered — durable exactly-once-among-backstops,
                  // scoped to backstop deliveries only (never an explicit E0
                  // reply, so a genuine later reply is unaffected).
                  backstopDeliveredNonceHit: (nonce) =>
                    backstopAlreadyDelivered(nonce ?? '', STATE_DIR),
                },
              )
            : { deliver: false as const, reason: 'no-state' as const }
          if (proseDecision.deliver && proseDecision.text != null) {
            // Deliver the recovered answer directly. This runs async and owns
            // its own bookkeeping — on success it closes the obligation +
            // records dedup + clears the silent-end state; on send FAILURE it
            // arms the recovery net itself (see below) instead of leaving the
            // answer lost.
            //
            // We DELIBERATELY skip recordUndeliveredTurnEnd on the HAPPY path
            // here: re-arming the Stop-hook re-prompt for an answer that just
            // went out is exactly what this bridge exists to avoid.
            //
            // #3228 Finding 1 — the send-failure net can NOT rely on the shared
            // turn-end teardown "leaving the obligation open". That teardown
            // (endCurrentTurnAtomic → decideObligationTurnEnd) closes the
            // obligation whenever `replyCalled === true`, which is EXACTLY the
            // interim-ack case that reaches this branch. So a thrown send would
            // otherwise leave the answer permanently lost (obligation already
            // closed by teardown, recordUndeliveredTurnEnd skipped). The real
            // net lives INSIDE deliverCapturedProse's catch: it calls
            // recordUndeliveredTurnEnd, arming the deterministic Stop-hook
            // re-prompt (parity with the non-captured path below).
            process.stderr.write(
              `telegram gateway: captured-prose delivery engaged on first silent-end ` +
                `chat=${chatId} turnKey=${tKey} (#3227)\n`,
            )
            void deliverCapturedProse({
              chatId,
              threadId,
              statusKeyStr: tKey,
              registryKey: turn.registryKey ?? null,
              originTurnId: turn.turnId,
              text: proseDecision.text,
              // #4141 — the Stop hook saw this turn's reply tool throw, so the
              // prose is what the model wrote AFTER its delivery attempt failed,
              // not what it chose to send. Pass the raw signal through so the
              // send states that provenance. It never gates delivery.
              replyToolThrewThisTurn: proseDecision.replyToolThrewThisTurn === true,
              // #4490 — same pass-through for the review-origin signal, so the
              // send path can apply the SAME card-gate / title-framing rules the
              // outbox sweep applies to a review turn's prose.
              reviewOriginated: proseDecision.reviewOriginated === true,
              // For the honest "(waited Ns)" clause if the exhaustion-boundary
              // apology fallback fires (#3228).
              turnDurationMs,
            })
          } else {
          // PR #2892 (deterministic-turn-liveness RFC Phase 2) hardening:
          // wire the represent-guard-style staleness
          // check (`recordSilentTurnEnd`'s `hasOutboundDeliveredSince` dep) so
          // an exhausted-looking record left over from a PRIOR, already-
          // answered turn on this same chat/thread (statusKey is not a
          // per-turn nonce) can never be misread as this turn's spent
          // re-prompt budget. Falls back to the pre-existing turnKey/
          // retryCount-only check when history is unavailable.
          const silentEndDeps: SilentEndDeps | undefined = HISTORY_ENABLED
            ? {
                hasOutboundDeliveredSince: (cid, sinceMs, tid) =>
                  hasOutboundDeliveredSince(cid, sinceMs, tid, 1),
              }
            : undefined
          const silentEnd = recordUndeliveredTurnEnd(
            {
              chatId,
              threadId: threadId ?? null,
              turnKey: tKey,
            },
            silentEndDeps,
          )
          if (silentEnd.exhausted) {
            process.stderr.write(
              `telegram gateway: WARN silent-end fallback — agent stayed ` +
              `silent after the Stop-hook re-prompt; delivering fallback ` +
              `message chat=${chatId} turnKey=${tKey} (#1161)\n`,
            )
            void retryWithThreadFallback(
              robustApiCall,
              (tid) =>
                bot.api.sendMessage(
                  chatId,
                  silentEndFallbackText(turnDurationMs),
                  tid != null ? { message_thread_id: tid } : {},
                ),
              { threadId, chat_id: chatId, verb: 'silent-end-fallback.sendMessage' },
            ).catch((err) => {
              process.stderr.write(
                `telegram gateway: silent-end fallback send failed: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              )
            })
          }
          } // end else (no captured-prose to deliver)
        }
        signalTracker.clear(tKey)
        silencePoke.endTurn(tKey)
        pendingProgress.noteTurnEnd(tKey)
      }
      lastPtyPreviewByChat.delete(statusKey(chatId, threadId))
      setPendingPtyPartial(null)
      closeActivityLane(chatId, threadId)
      closeProgressLane(chatId, threadId)
      // Pre-allocated draft orphan-cleanup removed in #553 PR 5 — the
      // gateway no longer pre-allocates drafts on inbound, so there
      // is nothing to clean up at turn_end.
      // Stage 3b: stamp turn-end in the registry as endedVia='stop' (clean
      // turn_end emit). The kill paths (schedule_restart / SIGTERM) handle
      // the 'restart' / 'sigterm' cases separately in 3c.
      if (turnsDb != null && turn.registryKey != null) {
        // Phase 1 of #332: capture first ~200 chars of the assistant's reply.
        const capturedJoined = turn.capturedText.join('')
        const assistantReplyPreview = capturedJoined
          ? capturedJoined.slice(0, TURN_PREVIEW_MAX)
          : null
        // Closes #472 finding #11 — same SIGTERM race as recordTurnStart
        // above. Sub-ms SQLite write; the setImmediate deferral wasn't
        // saving anything observable but was opening a window where a
        // SIGTERM between turn_end and the microtask losing the end row
        // (turn appears in DB as still-running, then 3c relabels it as
        // 'sigterm' on shutdown — false negative for clean completion).
        const _turnKey = turn.registryKey
        try {
          recordTurnEnd(turnsDb, {
            turnKey: _turnKey,
            endedVia: 'stop' as const,
            lastAssistantMsgId: turn.lastAssistantMsgId,
            lastAssistantDone: turn.lastAssistantDone,
            assistantReplyPreview,
            toolCallCount: turn.toolCallCount,
          })
        } catch (err) {
          process.stderr.write(`telegram gateway: recordTurnEnd(stop) failed turnKey=${_turnKey}: ${(err as Error).message}\n`)
        }
      }
      // #550: symmetric cleanup with the writeTurnActiveMarker call at
      // the enqueue arm (line ~2810). Pre-fix, removal was single-pathed
      // through the (now-retired, #1122/#1126) progressDriver.onTurnComplete
      // callback, which silently no-op'd when forceCompleteTurn found no
      // active card — leaking the marker across restarts and triggering
      // watchdog false-positive restarts. That driver callback no longer
      // exists (progressDriver is permanently null); this explicit
      // removeTurnActiveMarker is now the sole cleanup path (idempotent —
      // unlinkSync swallows ENOENT).
      removeTurnActiveMarker(STATE_DIR)
      // #1067: null the atom in one assignment, replacing the seven
      // field clears the pre-refactor version did. Any late-arriving
      // event for this turn will see currentTurn == null and bail.
      endCurrentTurnAtomic(turn)
      // #549 fix — preamble flush already happened at the TOP of this
      // turn_end handler (before turn.answerStream is nulled). See
      // comment near line 3431.
      return
        }, // end withTurnEndGateBackstop body (#2094 finding 1)
        {
          hasActiveTurn: (k) => activeTurnStartedAt.has(k),
          purge: (k, endingTurn) => purgeReactionTracking(k, endingTurn),
          log: (m) => process.stderr.write(m + '\n'),
        },
      )
      return
    }
  }
}
