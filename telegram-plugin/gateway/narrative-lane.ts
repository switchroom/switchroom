// ─────────────────────────────────────────────────────────────────────────
// Narrative / activity lane — `composeTurnActivity`, the narrative gate
// (`makeNarrativeGate` + SHOW/RETRACT/stage/resolve effects,
// `flushPendingNarrativeAtTurnEnd`), and the activity-feed drain/liveness/
// heartbeat/clear cluster, relocated VERBATIM from gateway.ts
// (switchroom#2996 P4-B, plan Amendments 1/5/9/10).
//
// SHAPE
// -----
// One factory, `createNarrativeLane(deps)`, destructures the injected gateway
// deps ONCE and returns the 15 lane functions with their original signatures.
// Intra-lane calls (e.g. the gate's SHOW effect -> `showNarrativeStep` ->
// `drainActivitySummary`) resolve inside the factory scope, so every body is
// byte-identical to the pre-move gateway.ts inline body except the enumerated
// spelling below. gateway.ts holds thin hoisted wrappers that build the lane
// LAZILY on first call (post-boot, so the captured `bot` handle is the live
// one) and keep every existing call site — including the stream-render (P4-A)
// deps builder — unchanged.
//
// DI CONTRACT (read before editing)
// ---------------------------------
//   - Every injected dep except `getCurrentTurn` is a STABLE gateway const /
//     function-decl / singleton instance (verified at extraction: `bot` is
//     assigned exactly once inside the isGatewayMain boot, before any lane
//     call can occur — the lazy first-call capture is therefore live).
//     `earlyLivenessOpenTimers` and the config consts stay declared in
//     gateway.ts (they have non-lane readers: the disconnect teardown drains
//     the timer map).
//   - TURN HANDLE (Amendment 9 / #1664): the lane NEVER reads the
//     `currentTurn` module global — the single live re-read (the heartbeat's
//     chat-root fallback) routes through the injected `getCurrentTurn()`
//     accessor. Per-topic resolution injects the live `currentTurnMap`
//     instance. This is the ONLY body deviation from byte-identical.
//   - SHARED SINGLETONS (Amendment 1): this lane has ZERO
//     `outboundDedup` / `backstopDeliveryLedger` sites (verified: the
//     answer-stream dedup sites are P4-A's stream-render surface, already
//     extracted + golden-tested). The module constructs NO OutboundDedupCache
//     — pinned structurally by stream-render-golden alongside the P2/P4-A
//     modules.
//
// ORACLE (Amendment 10): extracted-module golden harness
// (tests/narrative-lane-golden.test.ts) drives these functions directly with
// a fake bot recorder + real leaf modules, per the outbound-send-path test
// precedent; the cross-surface stream-then-reply dedup proof spans the P2 +
// P4 modules in stream-render-golden.test.ts with the REAL lane flush wired
// into the stream deps.
// ─────────────────────────────────────────────────────────────────────────

import { runSilentTurnHeartbeatTick } from '../feed-heartbeat-climb.js'
import * as silencePoke from '../silence-poke.js'
import { NarrativeFlushController, PENDING_NARRATIVE_FLUSH_MS } from '../narrative-flush.js'
import { richMessage } from '../rich-send.js'
import { isSendGateShed } from '../send-gate.js'
import { appendShownBlock } from '../shown-ledger.js'
import {
  appendActivityLabel, clipNarrative, formatStepSuffix, renderActivityFeedWithNested,
} from '../tool-activity-summary.js'
import { evaluatePostAnswerLiveness } from '../turn-liveness-floor.js'
import { isHollowGhostCardOutcome, isSilentSentinelCardOutcome } from '../turn-flush-safety.js'
import { clearActivityCardRecord, writeActivityCardRecord } from './activity-card-store.js'
import { chatKeyWithSuffix } from './chat-key.js'
import {
  computeCrossTurnAnswerDelivered, mayOpenActivityCard, shouldEarlyOpenLiveness,
  type FeedOpenProducer,
} from './feed-open-gate.js'
import type { SessionActivityHeader } from '../tool-activity-summary.js'
import type { CurrentTurn, NarrativeLaneDeps } from './gateway.js'

/**
 * Build the narrative/activity lane over the injected gateway deps. Called
 * lazily by gateway.ts on first use (see the section comment for why the
 * one-shot capture is safe) and directly by the golden harness with fakes.
 */
export function createNarrativeLane(deps: NarrativeLaneDeps) {
  const {
    ACTIVITY_CARD_STORE_PATH, CLEAR_STATUS_ON_COMPLETION, FEED_HEARTBEAT_ENABLED,
    FEED_HEARTBEAT_MIN_STALE_MS, FEED_LIVENESS_OPEN_ENABLED, FEED_LIVENESS_OPEN_MS,
    PIN_STATUS_WHILE_WORKING, POST_ANSWER_LIVENESS_STALE_MS, STATIC,
    activeDraftStreams, activityCardPersistEnabled, activityCardStoreFs, bot,
    cardDrainGate, currentTurnMap, earlyLivenessOpenTimers, emissionAuthorityFor,
    feedOpenGateDeps, getCurrentTurn, reconcileStatusPin, robustApiCall, statusKey,
  } = deps

  function closeActivityLane(chatId: string, threadId: number | undefined): void {
    const key = chatKeyWithSuffix(chatId, threadId, 'activity')
    const stream = activeDraftStreams.get(key)
    if (stream == null) return
    activeDraftStreams.delete(key)
    void stream.finalize().catch(() => {})
  }

  function closeProgressLane(chatId: string, threadId: number | undefined): void {
    // Progress-card streams include a turnKey suffix in their key
    // (e.g. "chatId:_:progress:chatId:1"). Iterate and match by prefix
    // so the backstop actually finds the stream.
    const prefix = chatKeyWithSuffix(chatId, threadId, 'progress')
    for (const [key, stream] of activeDraftStreams) {
      if (key.startsWith(prefix)) {
        activeDraftStreams.delete(key)
        void stream.finalize().catch(() => {})
      }
    }
  }

  /**
   * Render this turn's activity feed, nesting any active foreground sub-agent's
   * narrative beneath the parent's own steps (Model A). With no active
   * foreground sub-agent this is exactly the flat feed. Multiple concurrent
   * foreground sub-agents (rare — parallel Task dispatch) flatten in insertion
   * order; the single-sub-agent common case nests precisely under its
   * Delegating line.
   *
   * The header (elapsed + tool count) is now threaded into the render so the
   * main-session card matches the worker card's two-line header style. This
   * fixes the missing header regression where the worker card showed elapsed/
   * tool-count metadata but the main-session card rendered step-lines only.
   */
  function composeTurnActivity(turn: CurrentTurn, final = false, liveSuffix = ''): string | null {
    const childLines: string[] = []
    for (const narrative of turn.foregroundSubAgents.values()) {
      childLines.push(...narrative)
    }
    // Pass labeledToolCount as stepCount only on the terminal (final) render so
    // the persisted feed record shows a `✓ N steps` total. The live in-progress
    // feed omits it (stepCount undefined) to stay clean and minimal.
    const stepCount = final ? turn.labeledToolCount : undefined
    // Build the session header so the main-session card renders the same two-line
    // elapsed/tool-count header as the worker card.
    const header: SessionActivityHeader = {
      label: 'Agent',
      elapsedMs: turn.startedAt > 0 ? Date.now() - turn.startedAt : 0,
      toolCount: turn.labeledToolCount,
      state: final ? 'done' : 'running',
      model: turn.currentModel,
      // The parent's OWN running token total → `· N tok` on the metrics line.
      // 0 → tokenSegment omits it (clean, same as the worker feed).
      totalTokens: turn.totalTokens,
      // Terminal `✅ <summary>` footer, rendered through the SAME
      // `deriveCardResult` the 🛠 worker card uses. The agent's analogue of the
      // worker's `latestSummary` is the answer it actually delivered this turn
      // (`lastReplyText`, stamped on the reply/stream_reply tool_use just
      // before the first-reply `clearActivitySummary` hand-off). Only supplied
      // on a FINAL render; empty (a turn that finalised before any reply — the
      // foreground handoff-clear path — or a genuinely silent turn) → the
      // shared derivation omits the block, exactly as the worker card does.
      resultText: final ? turn.lastReplyText : undefined,
    }
    return renderActivityFeedWithNested(turn.mirrorLines, childLines, final, liveSuffix, stepCount, header)
  }

  // PENDING_NARRATIVE_FLUSH_MS is now defined in and imported from
  // `narrative-flush.ts` (the kernel's home) so the main-agent gateway path and
  // the worker/sub-agent watcher share ONE source of truth for the time-box.
  // The main path paints a parked block via the SAME `showNarrativeStep` path a
  // lookahead would, and a timer-painted block that later proves to be the reply
  // is deterministically retracted (the RETRACT effect wired into the controller
  // below).

  /**
   * Retract a narration step the flush timer painted EARLY that turned out to draft
   * the outgoing reply — the effect half of the anti-double-print guarantee's timer
   * path. Splice the line out of `mirrorLines` and re-render, so neither the live
   * nor the finalized card surfaces the answer as a narration step. The splice runs
   * synchronously BEFORE the reply's `clearActivitySummary` finalize reads
   * `mirrorLines`, so the persisted card is clean regardless of the re-render.
   */
  function retractNarrativeLine(turn: CurrentTurn, text: string): void {
    const clipped = clipNarrative(text)
    const idx = turn.mirrorLines.lastIndexOf(clipped)
    if (idx === -1) return // rolled out of the window already — nothing to retract
    turn.mirrorLines.splice(idx, 1)
    // Live re-render without the retracted line (the finalize path reads the same
    // spliced array; this only matters for the interim-ack case where finalize
    // isn't called on this reply). Guarded on a non-null render so an emptied feed
    // doesn't blank the card.
    const rerender = composeTurnActivity(turn)
    if (rerender == null) return
    turn.activityPendingRender = rerender
    const ea = emissionAuthorityFor(turn)
    cardDrainGate(turn, ea, () => {
      if (ea.mayDrain(turn)) {
        ea.openOrEditCard('narrative', () => {
          turn.activityInFlight = drainActivitySummary(turn, 'narrative')
        })
      }
    })
  }

  /**
   * Build a per-turn narrative gate: the pure park/timer/retract state machine
   * (`narrative-flush.ts`) wired to THIS turn's SHOW effect (`showNarrativeStep`),
   * RETRACT effect (`retractNarrativeLine`), and a real `unref`'d `setTimeout`
   * scheduler. The scheduler captures the turn's own timer handle so a turn swap
   * can't mis-target it — mirrors the `noReplyDrainTimer` discipline.
   */
  function makeNarrativeGate(turn: CurrentTurn): NarrativeFlushController {
    let handle: ReturnType<typeof setTimeout> | null = null
    return new NarrativeFlushController(
      {
        show: (text) => showNarrativeStep(turn, text),
        retractShown: (text) => retractNarrativeLine(turn, text),
        // #3513 (correction 4): persist the ephemeral-shown mark keyed by the
        // per-turn nonce so the out-of-process backstops (E3/E4) refuse to
        // re-deliver this card-only narration. Envelope-bearing turns only —
        // `turnId` is null for handback/background/cron, where the structural
        // rule in the shared classifier is the sole guard (should-fix noted in
        // shown-ledger.ts). Skip when null.
        markDurableNarration: (text) => {
          if (turn.turnId == null) return
          appendShownBlock(turn.turnId, text)
        },
      },
      {
        arm: (fn, ms) => {
          if (handle != null) clearTimeout(handle)
          handle = setTimeout(fn, ms)
          handle.unref?.()
        },
        disarm: () => {
          if (handle != null) {
            clearTimeout(handle)
            handle = null
          }
        },
      },
      PENDING_NARRATIVE_FLUSH_MS,
    )
  }

  /**
   * Render a SHOWN narrative text block as a transient liveness step — the
   * same path a tool label takes (appendActivityLabel → renderStepFeed), so
   * the narrative line is rolling-window-clipped and replaced by the next
   * event exactly like a tool step. NOT a new message, NOT persisted as a
   * parallel mirror (invariant `chat-is-the-single-source-of-truth`,
   * reference/invariants.md). Clipped to a single 120-char line via
   * clipNarrative so it reads as a step, not a paragraph.
   */
  function showNarrativeStep(turn: CurrentTurn, text: string): void {
    const rendered = appendActivityLabel(turn.mirrorLines, clipNarrative(text))
    if (rendered == null) return
    turn.activityPendingRender = composeTurnActivity(turn) ?? rendered
    const ea = emissionAuthorityFor(turn)
    // PR-4d: route the deliver-before-drain decision through the centralized
    // card-drain gate (chatLock-serialized under the flag; verbatim block OFF).
    cardDrainGate(turn, ea, () => {
    if (ea.mayDrain(turn)) {
      // Producer A (narrative SHOW): pre-answer narrative may now OPEN a card,
      // not just EDIT one — lever 5 is INERT (see feed-open-gate.ts), and
      // Lever 2 / clearActivitySummary guarantees reply-is-last ordering instead.
      // Accumulation into mirrorLines still happens, so any narration staged
      // before the card opened renders on the first OPEN (whichever producer
      // wins the race — narrative here, or the enqueue/liveness timer).
      // PR-4a: routed through the emission-authority façade (no-op delegate).
      ea.openOrEditCard('narrative', () => {
        turn.activityInFlight = drainActivitySummary(turn, 'narrative')
      })
    }
    })
  }

  /**
   * Narrative-dedup gate, step 2 (reducer-side): a tool_use just arrived while
   * a narrative block was pending. Decide SHOW vs SUPPRESS and clear the
   * pending slot. SUPPRESS only when the tool is reply/stream_reply AND the
   * pending text is a draft-then-send of that reply's `input.text`. Everything
   * else (a working tool, or a reply whose text differs — post-action
   * narration) is SHOWN. See narrative-dedup.ts §2b.
   */
  function resolvePendingNarrativeOnTool(
    turn: CurrentTurn,
    toolName: string,
    input: Record<string, unknown> | undefined,
  ): void {
    // Delegate to the pure park/timer/retract kernel: it cancels the early-paint
    // timer, retracts a timer-painted block that THIS reply drafts (anti-double-
    // print), then SHOWs / SUPPRESSes the parked block. See narrative-flush.ts §2.
    turn.narrativeGate.resolveOnTool(toolName, input)
  }

  /**
   * Narrative-dedup gate, step 1 (reducer-side): a new narrative block
   * arrived. A previously-pending block had nothing reply-shaped immediately
   * after it (pure narration) → flush it as SHOWN, then stage the new one for
   * one lookahead step AND arm the time-boxed early paint. See narrative-flush.ts.
   */
  function stagePendingNarrative(turn: CurrentTurn, text: string): void {
    turn.narrativeGate.stage(text)
  }

  /**
   * Narrative-dedup gate, step 3 (reducer-side): the turn is ending with a
   * trailing narrative block and nothing after it. SUPPRESS only when the turn
   * already delivered its answer via reply/stream_reply and the trailing text
   * is a draft of that answer; otherwise SHOW (genuine trailing narration like
   * "Done — all green."). Also cancels the early-paint timer and retracts a
   * timer-painted draft of the delivered answer. See narrative-flush.ts §3.
   */
  function flushPendingNarrativeAtTurnEnd(turn: CurrentTurn, lastReplyText: string): void {
    turn.narrativeGate.flushAtTurnEnd(lastReplyText)
  }

  /**
   * Drain the tool-activity summary's pending render queue. Single-flight
   * by construction (caller assigns the returned promise to
   * `turn.activityInFlight`; while set, new tool_uses only update
   * `turn.activityPendingRender` and return).
   *
   * Transport: a single in-place edited message. The first render does
   * `sendMessage` (capturing `turn.activityMessageId`); subsequent renders
   * `editMessageText` that id, so the summary accumulates in place without
   * retyping the whole block. `clearActivitySummary` deletes the message
   * when the reply tool takes over. Works in DMs, groups, and forum topics
   * alike (forum topics pass message_thread_id).
   *
   * The drain holds a reference to `turn`, so a turn-swap mid-drain
   * doesn't corrupt the next turn's atom — late writes land on the
   * captured `turn` (already-completed turn, harmless).
   */
  async function drainActivitySummary(
    turn: CurrentTurn,
    // Which producer triggered this drain (design §9 levers 1 + 5). Gates the
    // OPEN (first sendMessage) branch via `mayOpenActivityCard`; EDITs of an
    // already-open card are never gated. Defaults to 'tool' — the historically
    // unconditional OPEN behaviour — so any caller that does not opt into the
    // gate is unaffected. Narrative-SHOW and liveness callers pass their producer
    // explicitly.
    producer: FeedOpenProducer = 'tool',
    // Optional flags forwarded to `mayOpenActivityCard`.
    openFlags?: { postAnswerSubagentActivity?: boolean },
  ): Promise<void> {
    try {
      while (turn.activityPendingRender !== turn.activityLastSentRender) {
        const target = turn.activityPendingRender
        if (target == null) break
        // OPEN gate (design §9 levers 1 + 5): when this drain would OPEN a fresh
        // card (activityMessageId == null), consult the pure gate. Refusing an
        // OPEN must NOT advance activityLastSentRender — the accumulated render
        // stays pending so a later OPEN-eligible producer (a tool label, or
        // liveness) renders it. An EDIT (activityMessageId != null) is never
        // gated. Enforced HERE so it covers BOTH the inline producers AND the
        // detached heartbeat setInterval drain (R7/concurrency). The gate guards
        // gate EVALUATION, not an in-flight send: it is not a hard mutex — a send
        // already PAST this check and suspended at its `await robustApiCall(
        // sendMessage)` when a substantive final lands still completes and opens a
        // card; that residual is reconciled by lever-2's `clearActivitySummary`
        // chaining its finalize onto `turn.activityInFlight` (the suspended drain)
        // and editing the card in place, not by this gate blocking it.
        // Lever 4 (cross-turn / race C/D): a synthetic represent/owed-reply turn
        // (and the liveness/heartbeat timer firing on it) starts with a CLEARED
        // per-turn `finalAnswerEverDelivered` latch even when a substantive answer
        // already reached the user in an EARLIER turn — so without this its first
        // drain opens a card BELOW that prior reply. Only such a turn carries
        // `crossTurnGate`; reuse the represent guard's delivered-since check
        // (`hasOutboundDeliveredSince`) with the obligation's `openedAt` cutoff and
        // the SUBSTANTIVE 200-char threshold (so an ack never trips it → #2141
        // stays green). Computed ONLY when about to OPEN (activityMessageId ==
        // null) AND only for a turn with a cross-turn gate — no history query on
        // the common foreground path. Scoped to the synthetic surface by the
        // presence of `crossTurnGate`, so it can never fire on a foreground turn.
        // PR-4b: the cross-turn predicate is now the PURE, shared helper extracted
        // into feed-open-gate.ts (body lifted verbatim) — the SAME function the
        // emission-authority façade calls in its enabled branch, so flag-ON and
        // flag-OFF compute an identical verdict. History deps injected (the module
        // stays sqlite-free). The pure-gate consult + the `break` below stay
        // LITERALLY in the drain (disabled-path byte-identity).
        const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered(
          turn,
          feedOpenGateDeps(),
        )
        if (
          turn.activityMessageId == null
          && !mayOpenActivityCard({
            producer,
            finalAnswerEverDelivered: turn.finalAnswerEverDelivered,
            labeledToolCount: turn.labeledToolCount,
            crossTurnAnswerDelivered,
            postAnswerSubagentActivity: openFlags?.postAnswerSubagentActivity,
            // Post-SUBSTANTIVE reopen: the tool_label handler latches this sticky
            // on `turn` when the long-turn reopen fires, so the drain lifts lever 1
            // and the fresh card opens BELOW the already-delivered substantive reply.
            postAnswerMainActivity: turn.postAnswerMainActivity,
          })
        ) {
          break
        }
        // `renderActivityFeed` already emitted ready Telegram HTML with per-line
        // markup (**→ current** / _✓ done_) and escaped each label's
        // <,>,& itself (#1942 class) — send verbatim, do NOT re-escape or
        // re-wrap (double-escaping would surface literal tags).
        const html = target
        const chat = turn.sessionChatId
        const thread = turn.sessionThreadId
        // Native reply-quote: anchor the feed message to the user's question so
        // it renders as a quoted header (reply_parameters renders on a real
        // message; edits preserve it). allow_sending_without_reply so a deleted
        // source can't drop the send.
        const replyAnchor = turn.sourceMessageId != null
          ? { reply_parameters: { message_id: turn.sourceMessageId, allow_sending_without_reply: true } }
          : {}
        try {
          if (turn.activityMessageId == null) {
            const sent = await robustApiCall(
              // allow-raw-bot-api: sendRichMessage routed through robustApiCall (not in the THREAD_NOT_FOUND blast pattern)
              () => bot.api.sendRichMessage(chat, richMessage(html), {
                ...(thread != null ? { message_thread_id: thread } : {}),
                disable_notification: true,
                ...replyAnchor,
              }),
              { chat_id: chat, ...(thread != null ? { threadId: thread } : {}), verb: 'activity-summary.send' },
            )
            turn.activityMessageId = sent.message_id
            turn.activityEverOpened = true
            // Known Gap 1 (deterministic-turn-liveness.md) — persist the
            // minimal card handle the moment it opens, so a gateway restart
            // mid-turn has something to finalize on next boot instead of
            // leaving this card frozen forever. Fire-and-forget/best-effort:
            // a failed persist degrades to the pre-fix (in-memory-only)
            // behaviour, never blocks the card opening (writeActivityCardRecord
            // → persistActivityCards swallows write errors — it never throws).
            //
            // F6 (persist-intent-first ordering): this write is the FIRST action
            // taken after the send resolves and BEFORE the status-pin reconcile
            // below — no `await` sits between the send and this persist, so the
            // crash window in which a sent card has no durable record (and is
            // thus unreapable by the boot reaper) is the minimum achievable. A
            // true pre-send provisional record is impossible: the reaper keys
            // its finalizing edit on `activityMessageId`, which only exists once
            // sendRichMessage returns. Keep this persist synchronous and ahead
            // of the pin; do not move it after an await.
            if (activityCardPersistEnabled) {
              writeActivityCardRecord(ACTIVITY_CARD_STORE_PATH, activityCardStoreFs, {
                turnKey: statusKey(chat, thread),
                chatId: chat,
                threadId: thread ?? null,
                activityMessageId: sent.message_id,
                startedAt: turn.startedAt,
                // F5 (persist-intent honesty): mirror the ACTUAL pin decision,
                // not an unconditional `true`. The OPEN below silently-pins the
                // fresh card only when `PIN_STATUS_WHILE_WORKING` is on
                // (`reconcileStatusPin` no-ops when it's off, and can also fail
                // on missing supergroup rights). Persisting `pinned: true`
                // regardless would make the boot reaper attempt an unpin on a
                // card that was never pinned. The persist is intentionally
                // written BEFORE the fire-and-forget pin resolves (intent, not
                // outcome); the reaper's unpin is idempotent defense-in-depth
                // (`statusPinBootCleanup` owns the primary unpin), so tracking
                // the DECISION honestly — pinned iff we will actually attempt a
                // pin — is what matters here, not the async pin's result.
                pinned: PIN_STATUS_WHILE_WORKING,
              })
            }
            // Status-pin: the per-turn status message just opened — it's the
            // in-flight "what it's doing" surface. Silently pin it so the turn
            // stays in view when the feed scrolls past. Keyed to the same
            // status-key the canonical turn-end (purgeReactionTracking) unpins.
            // Fire-and-forget; the single-owner reconcile keeps state consistent.
            // Pass `thread` as the 4th arg so the persisted row keeps the forum
            // topic (D4): without it a forum-topic foreground card orphaned by a
            // crash lands a threadId-less row, and the sweep cannot aim
            // `unpinAllForumTopicMessages` at the right topic. Mirrors the worker
            // feed's `reconcilePin` (gateway.ts). It does NOT change the pinKey —
            // `statusKey(chat, thread)` already folds the topic into the key; the
            // 4th arg only threads the topic into the claim + durable row.
            void reconcileStatusPin(
              `fg:${statusKey(chat, thread)}`,
              chat,
              { pinned: true, messageId: sent.message_id },
              thread,
            )
          } else {
            const id = turn.activityMessageId
            // #3620: the live activity card is THE highest-volume repeated
            // editMessageText on one message id in the whole gateway, and until
            // this fix it passed NO `messageId` / `editPayload` to the send
            // gate. `sendGate.gate` only routes to its edit path when BOTH are
            // present (send-gate.ts `gate()`), so every card edit fell through
            // to the plain-send path: no per-message edit floor, no
            // last-write-wins coalescing, no no-op payload skip, and — because
            // an untagged non-edit send defaults to `critical`
            // (UNTAGGED_SEND_CLASS) — never shed and never budget-capped. The
            // card was therefore free to edit one message at the per-chat
            // bucket rate (1/s = 60/min) for as long as a turn ran, which is
            // what earned the 2026-07-25 62-minute flood ban.
            //
            // Tagging it COSMETIC + keying it engages all four protections,
            // including the long-horizon per-message edit budget that is
            // scoped to cosmetic edits.
            const editRes = await robustApiCall(
              () => bot.api.editMessageText(chat, id, richMessage(html), {}),
              {
                chat_id: chat,
                ...(thread != null ? { threadId: thread } : {}),
                verb: 'activity-summary.edit',
                priorityClass: 'cosmetic',
                messageId: id,
                editPayload: html,
              },
            )
            // Shed honesty: a shed edit did NOT land (the gate resolves the
            // SEND_GATE_SHED sentinel, not `undefined`). Leaving
            // `activityLastSentRender` behind keeps the newest render PENDING so
            // the next drain (a fresh tool label, or the feed heartbeat)
            // repaints it, and `break`ing stops the drain hot-looping against a
            // closed gate. A no-op drop still resolves `undefined` — that
            // payload IS on screen, so it advances normally below.
            if (isSendGateShed(editRes)) break
          }
          // #4330 — a card render LANDED (fresh open above, or a non-shed
          // edit): the pinned "→ Working…" status card the user watches just
          // visibly moved. Stamp silence-poke's card-render clock so the 300s
          // terminal fallback is DEFERRED (bounded by the hard ceiling) while
          // the card keeps updating — a visibly-live card must not be torn
          // down as "silence". This is the single transport chokepoint for
          // every card producer (tool label, narrative SHOW, liveness open,
          // heartbeat climb), and it is a DEFER-stamp only — it never touches
          // `lastOutboundAt`, so the silence CLOCK still resets only at the
          // model-driven production sites (stream-render tool-label / draft,
          // foreground sub-agent render). That keeps the #1556 heartbeat-
          // safety guard intact: a hung turn's climbing card defers the
          // teardown at most to `fallbackHardCeiling`, never forever.
          silencePoke.noteCardRender(statusKey(chat, thread), Date.now())
          turn.activityLastSentRender = target
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const low = msg.toLowerCase()
          // Transport-class failures (429, message gone, "not modified") must
          // NOT inflate `activityDrainFailures` — that counter flags a turn as
          // DEGRADED on turn-end, and a transient rate-limit or an
          // already-deleted message is not a logic defect. Counting them would
          // false-flag a healthy turn. "not modified" is success; gone/429 are
          // retried or harmless. Only a genuine send/open failure counts.
          const isTransport =
            low.includes('not modified') ||
            low.includes('not found') ||
            low.includes("can't be edited") ||
            low.includes('cannot be edited') ||
            low.includes('not enough rights') ||
            low.includes('429') ||
            low.includes('retry after')
          if (!isTransport) {
            turn.activityDrainFailures += 1
            // Surface the failing anchor + topic: the resume-400 bug fed a
            // fabricated 13-digit message_id as the reply anchor here, so every
            // send 400'd and the feed never opened. Logging the anchor +
            // everOpened makes a feed-blanking send self-explanatory (and the
            // turn-end DEGRADED line aggregates it).
            process.stderr.write(
              `telegram gateway: activity-summary drain failed: ${msg} ` +
                `(chat=${chat} thread=${thread ?? '-'} ` +
                `replyAnchor=${turn.sourceMessageId ?? 'none'} ` +
                `everOpened=${turn.activityEverOpened} failures=${turn.activityDrainFailures})\n`,
            )
          }
          // Mark as sent so we don't infinite-loop on a stuck render.
          turn.activityLastSentRender = target
        }
      }
    } finally {
      turn.activityInFlight = null
    }
  }

  /**
   * OPEN the minimal "Working…" liveness card for a 0-label turn once it has been
   * alive >= FEED_LIVENESS_OPEN_MS. The ONE place the liveness card may OPEN — both
   * the enqueue-time early-open timer (`scheduleEarlyLivenessOpen`) and the 6 s
   * heartbeat call through here, so a card opened by one caller is a clean no-op
   * for the other. This function OPENS only; it does NOT climb an already-open card
   * (its WHEN-gate `shouldEarlyOpenLiveness` returns false once `activityMessageId`
   * is set). The 0-label CLIMB of an already-open card lives at the heartbeat call
   * site via `silentTurnClimbRender` (deterministic-turn-liveness.md Phase 1) — so
   * BOTH the labelled and the 0-label branches now keep the card visibly climbing.
   *   - `drainActivitySummary` OPENs when `activityMessageId == null` and EDITs
   *     once it is set, so a second call after an open just maintains the card;
   *   - the `mirrorLines.length === 0` guard at the heartbeat call site (and the
   *     drain's own gate) means once a real tool label lands this path is skipped
   *     and the labelled-feed heartbeat takes over;
   *   - the OPEN itself is still gated by `mayOpenActivityCard` (lever 1 / 4) via
   *     `ea.openOrEditCard('liveness', …)`, so a card never opens below a
   *     delivered answer or on a cross-turn synthetic surface.
   *
   * Renders the turn's accumulated narration when present (the §3 case: narration
   * staged before the first tool via `mirrorLines`) so the early open is not a
   * bare placeholder when there is real text to show; falls back to "Working…"
   * for a genuinely silent thinking turn.
   */
  function openLivenessFeedIfDue(turn: CurrentTurn): void {
    const age = Date.now() - turn.startedAt
    // The WHEN decision (pure, `feed-open-gate.ts`): feature on, target chat,
    // past threshold, no card already open. Returns false once a card is open
    // (the drain EDITs instead) so the two callers can never double-open.
    if (!shouldEarlyOpenLiveness({
      enabled: FEED_LIVENESS_OPEN_ENABLED,
      ageMs: age,
      thresholdMs: FEED_LIVENESS_OPEN_MS,
      mirrorLineCount: turn.mirrorLines.length,
      activityMessageId: turn.activityMessageId,
      sessionChatId: turn.sessionChatId,
    })) return
    const lines = turn.mirrorLines.length > 0 ? turn.mirrorLines : ['Working…']
    const livenessHeader: SessionActivityHeader = {
      label: 'Agent', elapsedMs: age, toolCount: turn.labeledToolCount, state: 'running',
      model: turn.currentModel,
    }
    // Liveness card is a single "step" whose start is the turn start, so `age`
    // IS the step's own elapsed. formatStepSuffix keeps the `→` line timer-free
    // until the step has run ≥ STEP_TIMER_MIN_MS (header total still shows).
    const rendered = renderActivityFeedWithNested(lines, [], false, formatStepSuffix(age), undefined, livenessHeader)
    if (rendered == null) return
    turn.activityPendingRender = rendered
    const ea = emissionAuthorityFor(turn)
    // PR-4d: route through the centralized chatLock-serialized card-drain gate.
    cardDrainGate(turn, ea, () => {
      if (ea.mayDrain(turn)) {
        // Producer C (liveness timer): the thinking-gap / early-open. Now that
        // Lever 5 is inert (narrative may open pre-answer — #2588), liveness
        // remains the natural open for 0-tool pre-answer turns that are silent.
        // The sticky-latch (lever 1) still gates it in the drain.
        // PR-4a: routed through the emission-authority façade (no-op delegate).
        ea.openOrEditCard('liveness', () => {
          turn.activityInFlight = drainActivitySummary(turn, 'liveness')
        })
      }
    })
  }

  /**
   * Schedule the enqueue-time early-open of the "Working…" liveness card. Called
   * once per fresh turn at the `enqueue` lifecycle event (the single chokepoint
   * every real turn atom passes through — inbound, cron, subagent-handback,
   * vault-resume, restart-marker; anonymous one-shot hook clients never emit
   * `enqueue`, so they are excluded by construction). Fires `openLivenessFeedIfDue`
   * once at `FEED_LIVENESS_OPEN_MS` after turn start so narration / thinking that
   * happens BEFORE the first tool surfaces a card within ~a second — no more dead
   * air until a tool label or the old 12 s threshold. A no-op if a tool/narrative
   * already opened the card (the helper's own guards). The 6 s heartbeat remains
   * the backstop + the climb.
   */
  function scheduleEarlyLivenessOpen(turn: CurrentTurn): void {
    if (STATIC || !FEED_HEARTBEAT_ENABLED || !FEED_LIVENESS_OPEN_ENABLED) return
    if (turn.sessionChatId == null) return
    const key = statusKey(turn.sessionChatId, turn.sessionThreadId)
    stopEarlyLivenessOpen(key)
    const t = setTimeout(() => {
      earlyLivenessOpenTimers.delete(key)
      // Re-resolve the live turn for this key: only open if THIS turn is still the
      // live one for its topic (a successor turn would carry its own timer). Under
      // flag OFF `get(key)` returns the singleton — same turn unless a successor
      // already replaced it, which the turnId match below also guards.
      const live = currentTurnMap.get(key)
      if (live == null || live.turnId !== turn.turnId) return
      openLivenessFeedIfDue(live)
    }, FEED_LIVENESS_OPEN_MS)
    t.unref?.()
    earlyLivenessOpenTimers.set(key, t)
  }

  /** Cancel the enqueue-time early-open timer for a status-key (turn-end teardown
   *  + re-arm guard). Idempotent. */
  function stopEarlyLivenessOpen(key: string): void {
    const t = earlyLivenessOpenTimers.get(key)
    if (t != null) { clearTimeout(t); earlyLivenessOpenTimers.delete(key) }
  }

  /**
   * Heartbeat tick (PR1): keep the live activity feed visibly advancing during a
   * long single step that emits no new tool_label. Re-renders the feed with a
   * climbing " · Ns" elapsed on the in-progress line through the SAME single-flight
   * drain path the tool_label handler uses (no separate transport, no race). Pure
   * no-op unless there is a live in-flight feed whose newest step has gone stale.
   * Skips once the final answer landed (the feed is handing off) and after the
   * turn ends (activityMessageId nulled by clearActivitySummary). Deterministic +
   * framework-owned — never depends on the model.
   */
  function feedHeartbeatTick(): void {
    const turn = getCurrentTurn()
    if (turn == null) return
    if (turn.finalAnswerDelivered) {
      // Fix 2: post-answer background-agent liveness. When the sub-agent/workflow
      // watcher has surfaced a new step AFTER the substantive final answer, drive
      // a liveness card so the operator can see "background agent still working".
      //
      // Gate: `turn.subagentActivityAt` must be set (watcher fired) AND it must
      // exceed `turn.finalAnswerDeliveredAt` (the watcher advanced AFTER the answer
      // was delivered — not just any pre-answer label). This is the key fix:
      // #2587 read `lastToolLabelAt`, which is frozen by the drop-guard after a
      // substantive answer and therefore never crosses the threshold. `subagentActivityAt`
      // is written by the watcher's onProgress callback INDEPENDENTLY of the
      // tool_label / drop-guard path, so it correctly advances post-answer.
      //
      // Idle-gap suppression + staleness cap (concern 3) — the single pure decision
      // `evaluatePostAnswerLiveness`:
      //   - 'idle'  → no watcher activity after the answer (`subagentActivityAt`
      //               undefined or ≤ finalAnswerDeliveredAt). Stay silent; the
      //               reply-is-last invariant is fully preserved for idle turns.
      //   - 'stale' → the worker's last advance is older than POST_ANSWER_LIVENESS_STALE_MS
      //               (its `onFinish` froze `subagentActivityAt` and no new step has
      //               arrived). STOP re-rendering so the card doesn't climb `running`
      //               forever — mirrors the pre-answer FEED_LIVENESS_OPEN_MS cap. The
      //               worker's own terminal card (workerActivityFeed.finish) is the
      //               durable record once it completes.
      //   - 'emit'  → genuine in-flight post-answer activity; render the card below.
      const subagentAt = turn.subagentActivityAt
      // Fix 3 (sub-agent-delegation freeze): a foreground `Task`/`Agent` still
      // tracked in `turn.foregroundSubAgents` is POSITIVE evidence the worker
      // has not reported finished — see the doc comment on
      // `PostAnswerLivenessInput.stillDispatched` in turn-liveness-floor.ts for
      // why this must bypass the staleness cap rather than let a single long
      // silent step freeze the card mid-delegation.
      const stillDispatched = turn.foregroundSubAgents.size > 0
      const livenessVerdict = evaluatePostAnswerLiveness({
        subagentActivityAt: subagentAt,
        finalAnswerDeliveredAt: turn.finalAnswerDeliveredAt,
        now: Date.now(),
        staleCapMs: POST_ANSWER_LIVENESS_STALE_MS,
        stillDispatched,
      })
      if (livenessVerdict !== 'emit' || subagentAt == null) return // idle gap or stale worker → stay silent (the `== null` also narrows subagentAt for the elapsed below)
      // A background worker is genuinely active after the answer. Open or maintain
      // a liveness card below the reply. Route through `mayOpenActivityCard` with
      // `postAnswerSubagentActivity:true` so Lever 1 is lifted for 'tool' producer
      // (Fix 2's Lever 1 exception in feed-open-gate.ts). The card renders the
      // turn's accumulated mirrorLines (which may be empty — in that case the drain
      // opens a "Working…" placeholder matching the pre-answer liveness path).
      if (turn.sessionChatId == null) return
      const age = Date.now() - turn.startedAt
      const livenessHeader: SessionActivityHeader = {
        label: 'Agent', elapsedMs: age, toolCount: turn.labeledToolCount, state: 'running',
        model: turn.currentModel,
      }
      const lines = turn.mirrorLines.length > 0 ? turn.mirrorLines : ['Working in background…']
      // `subagentAt` is the worker's last ADVANCE — the current step's start —
      // so this suffix is already per-step. formatStepSuffix adds the 10 s gate.
      const elapsed = Date.now() - subagentAt
      const rendered = renderActivityFeedWithNested(lines, [], false, formatStepSuffix(elapsed), undefined, livenessHeader)
      if (rendered == null) return
      turn.activityPendingRender = rendered
      const ea = emissionAuthorityFor(turn)
      cardDrainGate(turn, ea, () => {
      if (ea.mayDrain(turn)) {
        // Producer 'tool' with postAnswerSubagentActivity=true: the Lever 1
        // exception allows this OPEN. Lever 4 (cross-turn) and idle-liveness
        // blocks are still respected by the drain. The card surfaces BELOW the
        // reply showing the background agent's live activity.
        ea.openOrEditCard('tool', () => {
          turn.activityInFlight = drainActivitySummary(turn, 'tool', { postAnswerSubagentActivity: true })
        })
      }
      })
      return
    }

    // Liveness feed (open + maintain). `mirrorLines.length === 0` means no tool
    // has ever produced a label this turn — pure thinking, or only suppressed
    // tools. Open a minimal "Working…" feed once the turn passes the threshold,
    // and keep its elapsed climbing until a real label arrives. The first label
    // makes mirrorLines non-empty, so the labelled-feed heartbeat below takes
    // over and its edit cleanly replaces the placeholder. drainActivitySummary
    // sends (opens) when activityMessageId is null and edits (maintains) once set
    // — so this one branch handles both the open and the climb.
    //
    // The OPEN logic lives in ONE place (`openLivenessFeedIfDue`) so the
    // enqueue-time early-open timer (`scheduleEarlyLivenessOpen`) and this 6 s
    // heartbeat both reach the same drain — there is exactly one path that can
    // OPEN the liveness card, so the two callers can never double-open or race.
    //
    // Phase 1 climb (deterministic-turn-liveness.md): once the card IS open, the
    // OPEN path no-ops (its WHEN-gate `shouldEarlyOpenLiveness` returns false for
    // an already-open card) — which is exactly how the 0-label card used to FREEZE
    // during a long silent tool. So split the two cases: OPEN when no card exists,
    // and otherwise re-render the "Working…" card with a fresh wall-clock elapsed
    // through the SAME cardDrainGate / mayDrain / liveness EDIT path the labelled
    // branch below uses. Model-independent (reads only `now - startedAt`), so a
    // blocked tool call can't starve it; edit-only, so it never push-notifies.
    //
    // The tick BODY lives in feed-heartbeat-climb.ts (`runSilentTurnHeartbeatTick`)
    // so the shipped decision logic is directly under the outcome-based regression
    // test (tests/silent-turn-climb-transport.test.ts) — this gateway IIFE cannot
    // be imported in-process. This call site only wires the REAL deps; the wiring
    // shape is pinned structurally by tests/feed-heartbeat-liveness-open.test.ts.
    {
      const ea = emissionAuthorityFor(turn)
      const handled = runSilentTurnHeartbeatTick(
        {
          mirrorLineCount: turn.mirrorLines.length,
          activityMessageId: turn.activityMessageId,
          labeledToolCount: turn.labeledToolCount,
          ageMs: Date.now() - turn.startedAt,
          minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
        },
        {
          openLivenessFeedIfDue: () => openLivenessFeedIfDue(turn),
          setPendingRender: (rendered) => { turn.activityPendingRender = rendered },
          cardDrainGate: (run) => cardDrainGate(turn, ea, run),
          mayDrain: () => ea.mayDrain(turn),
          openOrEditCard: (apply) => ea.openOrEditCard('liveness', apply),
          drain: () => { turn.activityInFlight = drainActivitySummary(turn, 'liveness') },
        },
      )
      if (handled) return
    }

    // Labelled-feed heartbeat: keep a stale in-progress step visibly advancing.
    if (turn.activityMessageId == null) return // no live feed yet / already cleared
    if (turn.lastToolLabelAt == null) return // feed not driven by a labelled step
    const elapsed = Date.now() - turn.lastToolLabelAt
    if (elapsed < FEED_HEARTBEAT_MIN_STALE_MS) return // step is fresh; feed advancing normally
    // `lastToolLabelAt` resets on every new tool label, so `elapsed` is the
    // CURRENT step's own run time. formatStepSuffix holds the timer back until
    // the step passes STEP_TIMER_MIN_MS (10 s) — header total is unaffected.
    const rendered = composeTurnActivity(turn, false, formatStepSuffix(elapsed))
    if (rendered == null) return
    turn.activityPendingRender = rendered
    const ea = emissionAuthorityFor(turn)
    // PR-4d: route through the centralized chatLock-serialized card-drain gate.
    cardDrainGate(turn, ea, () => {
    if (ea.mayDrain(turn)) {
      // Maintains an already-open card (guarded above on activityMessageId !=
      // null) → only ever EDITs. 'liveness' is correct either way.
      // PR-4a: routed through the emission-authority façade (no-op delegate).
      ea.openOrEditCard('liveness', () => {
        turn.activityInFlight = drainActivitySummary(turn, 'liveness')
      })
    }
    })
  }

  /**
   * Reconcile the activity summary when the model's reply tool takes over as the
   * authoritative surface. Awaits any in-flight render so we don't race a stale
   * write, then EITHER:
   *   - FINALIZE (default, CLEAR_STATUS_ON_COMPLETION=false): edit the message to
   *     a terminal all-done render (no "→ in-progress" line) and stop tracking it
   *     — the status stays in the chat as a record beside the reply. No delete.
   *   - DELETE (CLEAR_STATUS_ON_COMPLETION=true, opt-in via
   *     channels.telegram.clear_status_on_completion): remove the message so only
   *     the reply remains (the pre-2026-06 behaviour).
   * Idempotent + best-effort — failures stderr-log but don't block.
   *
   * Called on the first reply (hand-off) and again at turn_end (no-reply safety
   * net); finalize edits are idempotent (a 'message is not modified' on the
   * second call is swallowed).
   *
   * `finalHtmlOverride` (finalize path only): a render captured by the caller
   * BEFORE it tore down turn state the finalize render depends on. The
   * foreground handoff-clear path passes this — it deletes the just-finished
   * sub-agent's narrative right after this call, so the async
   * `composeTurnActivity(turn, true)` below would see an emptied feed (and, on
   * ack-first turns, empty `mirrorLines`), render null, and skip the finalize —
   * freezing the last live "→ in-progress" line. The captured render keeps the
   * persisted record reading done (✓). Omitted → compute it here (the common
   * reply/turn_end callers, where state is stable).
   */
  function clearActivitySummary(turn: CurrentTurn, finalHtmlOverride?: string | null): void {
    const chat = turn.sessionChatId
    const thread = turn.sessionThreadId
    const inFlight = turn.activityInFlight ?? Promise.resolve()
    void inFlight.then(async () => {
      if (turn.activityMessageId == null) return
      const id = turn.activityMessageId
      turn.activityMessageId = null
      // Known Gap 1 (deterministic-turn-liveness.md) — the card is closing
      // normally (about to be deleted or finalized below), so drop its durable
      // handle too: a normal close must never leave a stale record for the
      // boot reaper to "finalize" a message that's already been handled.
      if (activityCardPersistEnabled) {
        clearActivityCardRecord(
          ACTIVITY_CARD_STORE_PATH,
          activityCardStoreFs,
          statusKey(chat, thread),
          // Scope to this card's exact id (reap-race guard): only drop the row
          // for the card THIS turn is closing, never a fresher card another
          // turn may have already upserted under the same topic key.
          id,
        )
      }
      // #3812 — release the status-pin claim BEFORE the message goes away,
      // symmetric with the durable card-record drop above. `turn-end.ts` also
      // unpins `fg:<statusKey>`, but that runs LATER: on the
      // CLEAR_STATUS_ON_COMPLETION path the message is DELETED here, so by turn
      // end the claim named a dead id and the unpin was a guaranteed-4xx API
      // call every single turn. Worse, the durable status-pins.json row pointed
      // at a deleted message for that whole window, so a crash there handed the
      // next boot's sweep a row it would also fail to unpin — burning an
      // attempt off the BOOT_UNPIN_MAX_ATTEMPTS forfeit ladder for nothing.
      //
      // AWAITED so the unpin (and its durable-row clear) is ordered strictly
      // before the delete. turn-end stays the idempotent backstop: it no-ops
      // once nothing is claimed for the key.
      await reconcileStatusPin(`fg:${statusKey(chat, thread)}`, chat, { pinned: false })
      // #4348 — silent-sentinel suppression. A turn whose entire user-facing
      // outcome is a bare NO_REPLY / HEARTBEAT_OK (the sentinel-reply-guard
      // dropped a sentinel-only reply, or the flush safety net classified the
      // captured text as silent) said nothing to the user, so its activity/
      // telemetry card is pure noise — most visibly on the forced-synthesis
      // handback turns a background sub-agent injects. DELETE the card rather
      // than finalizing a visible `done · … · ✓ NO_REPLY` record. Deterministic
      // (reuses the shared `turn-flush-safety` silent predicates, no model
      // behaviour) and normal-case-safe (`finalAnswerEverDelivered` keeps every
      // card for a turn that actually delivered a substantive answer). The
      // `finalHtmlOverride` finalize path is only taken by the foreground
      // handoff-clear, which fires on a delivered final answer — so this gate
      // never contends with it.
      const silentSentinelTurn = isSilentSentinelCardOutcome({
        replyCalled: turn.replyCalled,
        lastReplyText: turn.lastReplyText,
        capturedText: turn.capturedText,
        finalAnswerEverDelivered: turn.finalAnswerEverDelivered,
      })
      // #45 — hollow-ghost suppression. The sibling to the #4348 sentinel gate:
      // a turn that ended having done ZERO surfaced tool work, never called
      // reply, delivered no final answer, surfaced NO narration, and emitted no
      // captured/reply text adopted an activity card at turn start that never
      // got any content — the contentless `🤖 Agent · done · 0 tools · Ns`
      // record Ken reported (a card opened by the liveness timer that stayed
      // empty). The sentinel gate can't catch it (there is no NO_REPLY/
      // HEARTBEAT_OK text to match; the flush classifies it `empty-text`, not
      // `silent-marker`), so DELETE the empty card here instead of finalizing
      // it. Deterministic (pure predicate over already-tracked turn fields) and
      // normal-case-safe: any surfaced tool step, any rendered narrative line
      // (`mirrorLines` — content the user actually saw), any reply, any captured
      // text, or a delivered answer keeps the card. The `finalHtmlOverride`
      // finalize path is only taken by the foreground handoff-clear (which fires
      // on a delivered final answer), so this gate never contends with it.
      const hollowGhostTurn = isHollowGhostCardOutcome({
        replyCalled: turn.replyCalled,
        labeledToolCount: turn.labeledToolCount,
        mirrorLines: turn.mirrorLines,
        capturedText: turn.capturedText,
        lastReplyText: turn.lastReplyText,
        finalAnswerEverDelivered: turn.finalAnswerEverDelivered,
      })
      if (CLEAR_STATUS_ON_COMPLETION || silentSentinelTurn || hollowGhostTurn) {
        try {
          await robustApiCall(
            () => bot.api.deleteMessage(chat, id),
            { chat_id: chat, ...(thread != null ? { threadId: thread } : {}), verb: 'activity-summary.delete' },
          )
        } catch (err) {
          // Best-effort teardown of a status card. A transport-class failure
          // (message already deleted, chat gone, 429) is not a liveness-logic
          // error — "message to delete not found" is the desired end state
          // here, and a 429 on a teardown delete is retried by robustApiCall.
          // Stay silent on those; warn only on a genuinely unexpected error.
          const msg = err instanceof Error ? err.message : String(err)
          const low = msg.toLowerCase()
          if (
            low.includes('not modified') ||
            low.includes('not found') ||
            low.includes('not enough rights') ||
            low.includes('429') ||
            low.includes('retry after')
          ) {
            return
          }
          process.stderr.write(`telegram gateway: activity-summary delete failed: ${msg}\n`)
        }
        return
      }
      // Default: leave the status message as a record, edited to a terminal
      // all-done state so it doesn't freeze on a misleading "→ in-progress" line.
      let finalHtml =
        finalHtmlOverride !== undefined ? finalHtmlOverride : composeTurnActivity(turn, true)
      // Liveness-only feed: opened on the timer for a turn that never labelled a
      // tool (pure thinking / suppressed tools), so mirrorLines is empty and the
      // terminal render is null. Finalize to a done "✓ Working…" record instead
      // of leaving the message frozen on the live "→ Working…" line.
      if (finalHtml == null && turn.mirrorLines.length === 0 && turn.activityEverOpened) {
        const livenessElapsed = turn.startedAt > 0 ? Date.now() - turn.startedAt : 0
        const livenessHeader: SessionActivityHeader = {
          label: 'Agent', elapsedMs: livenessElapsed, toolCount: turn.labeledToolCount, state: 'done',
          model: turn.currentModel,
          // Same terminal `✅ <summary>` footer as the normal final render —
          // this liveness-only card is still a FINAL agent card.
          resultText: turn.lastReplyText,
        }
        finalHtml = renderActivityFeedWithNested(['Working…'], [], true, '', undefined, livenessHeader)
      }
      if (finalHtml == null) return
      try {
        await robustApiCall(
          () => bot.api.editMessageText(chat, id, richMessage(finalHtml), {}),
          {
            chat_id: chat,
            ...(thread != null ? { threadId: thread } : {}),
            verb: 'activity-summary.finalize',
            // Keyed for the same reason as the drain edit: this edits the SAME
            // message id the drain has been repainting, so it must share that
            // message's edit floor / coalescer / budget rather than slipping
            // past the gate as an untagged `critical` send. `useful` (not
            // `cosmetic`) because it paints the card's terminal state — it may
            // be deferred, but it should not be shed at the first sign of
            // pressure.
            priorityClass: 'useful',
            messageId: id,
            editPayload: finalHtml,
          },
        )
      } catch (err) {
        // Same transport-class discipline as the delete path: the card
        // finalize is a best-effort liveness edit. "not modified" = the card
        // already shows the finalized body (success); "not found" / "not
        // enough rights" = the message is gone (nothing to finalize); 429 is
        // retried by robustApiCall. None of those are liveness-logic errors
        // and none warrant a stderr warning. Warn only on the unexpected.
        const msg = err instanceof Error ? err.message : String(err)
        const low = msg.toLowerCase()
        if (
          low.includes('not modified') ||
          low.includes('not found') ||
          low.includes("can't be edited") ||
          low.includes('cannot be edited') ||
          low.includes('not enough rights') ||
          low.includes('429') ||
          low.includes('retry after')
        ) {
          return
        }
        process.stderr.write(`telegram gateway: activity-summary finalize failed: ${msg}\n`)
      }
    })
  }

  return {
    closeActivityLane, closeProgressLane, composeTurnActivity, retractNarrativeLine,
    makeNarrativeGate, showNarrativeStep, resolvePendingNarrativeOnTool,
    stagePendingNarrative, flushPendingNarrativeAtTurnEnd, drainActivitySummary,
    openLivenessFeedIfDue, scheduleEarlyLivenessOpen, stopEarlyLivenessOpen,
    feedHeartbeatTick, clearActivitySummary,
  }
}
