/**
 * Inbound intercept gauntlet (switchroom#2996 P7).
 *
 * The side-effecting early-return checks that sit at the head of
 * `handleInbound`, extracted one-per-PR out of gateway.ts into pure,
 * unit-testable functions that take (a) the per-message routing facts captured
 * in `handleInbound` before the gauntlet and (b) an `InboundInterceptorDeps`
 * object holding LIVE references to the gateway's collaborators (functions,
 * Maps, the bound `bot.api` surface) — never value snapshots. Each returns an
 * `InterceptOutcome`; when `handled` is true the caller must return immediately
 * (the intercept has fully serviced the message and it is never forwarded).
 *
 * Ordering is load-bearing and preserved by the caller: the functions here fire
 * in the same sequence they did inline. The characterization harness
 * (tests/inbound-router-characterization.test.ts) is the parity oracle.
 */

import type { ReactionTypeEmoji } from 'grammy/types'
import { parseStopKeyword, buildStopReply } from './stop-command.js'
import type { RetryCallOpts } from '../retry-api-call.js'
import type { AttachmentMeta } from './gateway.js'

/**
 * Result of an intercept. `handled: true` means the intercept fully serviced
 * the message and the caller must `return` (never forward to the agent).
 */
export interface InterceptOutcome {
  handled: boolean
}

/**
 * Live collaborators injected from gateway.ts module scope. Grows as each P7
 * stage moves an intercept across this boundary. Every field is a live
 * reference (function / Map / object) — never a captured value snapshot.
 *
 * `botApi` is a LAZY accessor for the gateway's bound `bot.api` surface — the
 * grammY `bot` is assigned late (only on the prod boot path), so the deref is
 * deferred to call time. Injecting it as `deps.botApi().sendMessage(...)` also
 * keeps the raw Telegram send a false-positive-free non-`bot.api.` literal that
 * still rides the same `swallowingApiCall` retry wrapper it did inline.
 */
export interface InboundInterceptorDeps {
  pendingSessionCommand: { list: () => Array<{ kind: string; targetLabel: string }> }
  turnInFlightForGate: () => boolean
  sendReaction: (
    chatId: string,
    messageId: number,
    emoji: ReactionTypeEmoji['emoji'],
  ) => Promise<unknown>
  executeHaltNow: (origin: string) => Promise<void>
  swallowingApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T | undefined>
  botApi: () => {
    sendMessage: (
      chatId: string,
      text: string,
      other?: { message_thread_id?: number },
    ) => Promise<unknown>
  }
  log: (line: string) => void
}

/**
 * Per-message routing facts captured in `handleInbound` before the gauntlet.
 * `extraAttachments` is only length-inspected here, so it is typed structurally
 * to avoid pulling gateway-local attachment types across the boundary.
 */
export interface StopKeywordParams {
  text: string
  chat_id: string
  msgId: number | undefined
  messageThreadId: number | undefined
  downloadImage: (() => Promise<string | undefined>) | undefined
  attachment: AttachmentMeta | undefined
  extraAttachments: readonly unknown[] | undefined
}

/**
 * #3020 — bare operator "stop": the kill switch without the `!` marker.
 * Exact-word only (`parseStopKeyword`): "stop the build" flows to the agent as
 * a normal turn. Intercepted here (never forwarded) so it fires mid-turn
 * instead of queueing behind the very turn it's trying to cancel. Pure text
 * only (7b): a photo/attachment captioned "stop" is content for the agent, not
 * a halt request — it flows through as a normal turn.
 *
 * Authorization: the same allowFrom gate as any inbound (the caller's `gate()`
 * runs before this) — unauthorized senders never reach here.
 */
export async function interceptStopKeyword(
  p: StopKeywordParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  if (
    !(
      parseStopKeyword(p.text) &&
      p.downloadImage == null &&
      p.attachment == null &&
      (p.extraAttachments == null || p.extraAttachments.length === 0)
    )
  ) {
    return { handled: false }
  }

  const queuedLabels = deps.pendingSessionCommand.list().map(c => `/${c.kind} ${c.targetLabel}`)
  const inFlight = deps.turnInFlightForGate()
  deps.log(
    `telegram gateway: stop-keyword received chat_id=${p.chat_id} in_flight_turn=${inFlight} ` +
      `queued_cmds=${queuedLabels.length}\n`,
  )
  if (inFlight) {
    if (p.msgId != null) {
      void deps.sendReaction(p.chat_id, p.msgId, '⚡' as ReactionTypeEmoji['emoji']).catch(() => {})
    }
    await deps.executeHaltNow('stop-keyword')
  }
  const stopReply = buildStopReply(inFlight, queuedLabels)
  // #1075: thread-id-bearing — swallow so a deleted topic can't crash us.
  await deps.swallowingApiCall(
    () =>
      deps.botApi().sendMessage(
        p.chat_id,
        stopReply.text,
        p.messageThreadId != null ? { message_thread_id: p.messageThreadId } : {},
      ),
    {
      chat_id: p.chat_id,
      verb: 'stop-keyword-reply',
      ...(p.messageThreadId != null ? { threadId: p.messageThreadId } : {}),
    },
  )
  return { handled: true }
}
