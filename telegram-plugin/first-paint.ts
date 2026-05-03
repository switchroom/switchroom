/**
 * First-paint seam (Phase 1 of #545).
 *
 * Pure function extracted from gateway.ts `handleInbound` for the
 * status-reaction + progress-card-startTurn slice. Production behavior is
 * unchanged: gateway.ts calls this with its module-level singletons. The
 * seam exists so the waiting-UX harness can drive the real first-paint
 * code path with fakes and assert wall-clock call timing of
 *   - bot.api.setMessageReaction (the 👀 ack)
 *   - progressDriver.startTurn (the progress card)
 *
 * Scope is deliberately narrow:
 *   - status-reaction setup (cancel-prior + setQueued, or 🤝/👀 for
 *     steer/queued mid-turn)
 *   - progressDriver.startTurn for fresh turns
 * Out of scope (stays inline in gateway.ts):
 *   - draft pre-allocation, forum-topic placeholder, heartbeat scheduling
 *
 * The motivation for the narrow scope: pre-alloc/heartbeat code touches
 * 6 more module-scoped maps + functions and would balloon this seam
 * without making F2/F3 (no instant draft / late card) any more testable
 * — those are about the FIRST visible signal (👀 + card.startTurn).
 */

import type { ReactionTypeEmoji } from 'grammy/types'
import { StatusReactionController } from './status-reactions.js'
import type { DraftStreamHandle } from './draft-stream.js'

// ─── Types ────────────────────────────────────────────────────────────────

export interface FirstPaintBotApi {
  setMessageReaction(
    chatId: string | number,
    messageId: number,
    reactions: Array<{ type: 'emoji'; emoji: ReactionTypeEmoji['emoji'] }>,
  ): Promise<unknown>
}

export interface FirstPaintProgressDriver {
  startTurn(args: {
    chatId: string
    threadId?: string
    userText: string
    replyToMessageId?: number
  }): void
}

export interface FirstPaintAccess {
  /** When false, all status-reaction posting is suppressed. */
  statusReactions?: boolean
  /** Optional alternate ack emoji used when statusReactions is suppressed. */
  ackReaction?: string
}

export interface FirstPaintCtx {
  chatId: string
  messageId: number | undefined
  messageThreadId: number | undefined
  isSteerPrefix: boolean
  effectiveText: string
  /** ms epoch — used for the inbound_ack metric delta. */
  inboundReceivedAt: number
  access: FirstPaintAccess
}

export interface FirstPaintDeps {
  bot: { api: FirstPaintBotApi }
  progressDriver: FirstPaintProgressDriver | undefined
  activeStatusReactions: Map<string, StatusReactionController>
  activeReactionMsgIds: Map<string, { chatId: string; messageId: number }>
  activeTurnStartedAt: Map<string, number>
  progressUpdateTurnCount: Map<string, number>
  activeDraftStreams: Map<string, DraftStreamHandle>
  activeDraftParseModes: Map<string, 'HTML' | 'MarkdownV2' | undefined>
  suppressPtyPreview: Set<string>
  /** Compute the status/stream key. Production uses `${chatId}:${threadId ?? '_'}`. */
  statusKey: (chatId: string, threadId?: number) => string
  streamKey: (chatId: string, threadId?: number) => string
  /** Wipes activeReactionMsgIds + activeTurnStartedAt for the key. */
  purgeReactionTracking: (key: string) => void
  /** Records signal emission (issue #203 metrics). */
  signalTracker: {
    noteSignal: (key: string, ts: number) => void
    reset: (key: string, ts: number) => void
  }
  /** Side-channel for active-reactions disk persistence. */
  resolveAgentDirFromEnv: () => string | null | undefined
  addActiveReaction: (
    agentDir: string,
    entry: { chatId: string; messageId: number; threadId: number | null; reactedAt: number },
  ) => void
  /** Streaming-metrics emitter (#203). */
  logStreamingEvent: (ev: { kind: 'inbound_ack'; chatId: string; messageId: number; ackDelayMs: number }) => void
  /** Clock — defaults to Date.now in production; tests inject fake. */
  now?: () => number
  /**
   * Factory for the per-turn StatusReactionController. Defaults to constructing
   * a real `StatusReactionController(cb)`. Tests inject a recording stub so
   * the harness can decouple from the real controller's internal scheduling.
   */
  controllerFactory?: (cb: (emoji: string) => Promise<void>) => StatusReactionController
  /**
   * #542 fix: per-chat allowed-reactions filter sourced from getChat probe.
   * Optional — when omitted, the controller is constructed without a filter
   * (current behavior, possibly buggy if the chat restricts reactions).
   * The default `controllerFactory` consults this getter; custom factories
   * (e.g. test harnesses) may ignore it.
   */
  getAllowedReactions?: (chatId: string) => Set<string> | null
  /**
   * Sink for stderr-style error reporting from the seam. Defaults to writing
   * to `process.stderr`. Tests inject a recorder.
   */
  logError?: (msg: string) => void
}

export interface FirstPaintResult {
  isSteering: boolean
  priorTurnStartedAt: number | undefined
}

// ─── Seam ────────────────────────────────────────────────────────────────

/**
 * Run the first-paint slice for an inbound user message. Mirrors lines
 * 3973-4072 of gateway.ts as of `waiting-ux-harness` head. Returns the
 * `isSteering` and `priorTurnStartedAt` signals the caller needs to gate
 * downstream pre-alloc behavior.
 *
 * Behavior is identical to inline production:
 *   - missing msgId → nothing happens (no reaction, no card)
 *   - prior turn in flight + steer prefix → 🤝 on inbound, no new turn
 *   - prior turn in flight (queued mid-turn) → 👀 on inbound, no new turn
 *   - fresh turn → cancel any stale controller, start a new one, setQueued,
 *     reset signal tracker, persist active-reaction to disk, then
 *     progressDriver.startTurn
 *   - access.statusReactions === false + access.ackReaction → custom ack
 *     emoji on inbound; no controller; no startTurn
 */
export async function firstPaintTurn(
  deps: FirstPaintDeps,
  ctx: FirstPaintCtx,
): Promise<FirstPaintResult> {
  const now = deps.now ?? Date.now
  const { chatId, messageId: msgId, messageThreadId, isSteerPrefix, effectiveText, inboundReceivedAt, access } = ctx

  let isSteering = false
  let priorTurnStartedAt: number | undefined

  if (msgId != null) {
    const key = deps.statusKey(chatId, messageThreadId)
    const priorActive = deps.activeStatusReactions.get(key)
    const priorTurnInFlight = priorActive != null
    isSteering = priorTurnInFlight && isSteerPrefix
    if (priorTurnInFlight) priorTurnStartedAt = deps.activeTurnStartedAt.get(key)

    if (access.statusReactions !== false) {
      if (isSteering) {
        void deps.bot.api
          .setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '🤝' as ReactionTypeEmoji['emoji'] }])
          .catch(() => {})
      } else if (priorTurnInFlight) {
        void deps.bot.api
          .setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '👀' as ReactionTypeEmoji['emoji'] }])
          .catch(() => {})
        deps.logStreamingEvent({
          kind: 'inbound_ack',
          chatId,
          messageId: msgId,
          ackDelayMs: now() - inboundReceivedAt,
        })
      } else {
        // Fresh turn
        if (priorActive) {
          priorActive.cancel()
          deps.purgeReactionTracking(key)
        }
        const sKey = deps.streamKey(chatId, messageThreadId)
        const priorStream = deps.activeDraftStreams.get(sKey)
        if (priorStream && !priorStream.isFinal()) {
          deps.activeDraftStreams.delete(sKey)
          deps.activeDraftParseModes.delete(sKey)
          await priorStream.finalize().catch(() => {})
        }
        deps.suppressPtyPreview.delete(sKey)

        const allowed = deps.getAllowedReactions?.(chatId) ?? null
        const makeCtrl = deps.controllerFactory ?? ((cb) => new StatusReactionController(cb, allowed))
        const ctrl = makeCtrl(async (emoji) => {
          await deps.bot.api.setMessageReaction(chatId, msgId, [
            { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
          ])
          deps.signalTracker.noteSignal(key, now())
        })
        deps.activeStatusReactions.set(key, ctrl)
        deps.activeReactionMsgIds.set(key, { chatId, messageId: msgId })
        deps.activeTurnStartedAt.set(key, now())
        deps.progressUpdateTurnCount.set(key, 0)
        ctrl.setQueued()
        deps.logStreamingEvent({
          kind: 'inbound_ack',
          chatId,
          messageId: msgId,
          ackDelayMs: now() - inboundReceivedAt,
        })
        deps.signalTracker.reset(deps.statusKey(chatId, messageThreadId), now())
        const agentDir = deps.resolveAgentDirFromEnv()
        if (agentDir != null) {
          deps.addActiveReaction(agentDir, {
            chatId,
            messageId: msgId,
            threadId: messageThreadId ?? null,
            reactedAt: now(),
          })
        }
      }
    } else if (access.ackReaction) {
      void deps.bot.api
        .setMessageReaction(chatId, msgId, [
          { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
        ])
        .catch(() => {})
      deps.logStreamingEvent({
        kind: 'inbound_ack',
        chatId,
        messageId: msgId,
        ackDelayMs: now() - inboundReceivedAt,
      })
    }
  }

  // Start a new progress card only for fresh turns (no prior turn in flight).
  if (!isSteering && priorTurnStartedAt == null) {
    try {
      deps.progressDriver?.startTurn({
        chatId,
        threadId: messageThreadId != null ? String(messageThreadId) : undefined,
        userText: effectiveText,
        replyToMessageId: msgId != null ? msgId : undefined,
      })
    } catch (err) {
      const log = deps.logError ?? ((m: string) => process.stderr.write(m))
      log(`telegram gateway: progress-card startTurn failed: ${(err as Error).message}\n`)
    }
  }

  return { isSteering, priorTurnStartedAt }
}
