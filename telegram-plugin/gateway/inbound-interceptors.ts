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
import { decideInterruptTiming, resolveSafeBoundaryEnabled } from './interrupt-defer.js'
import { naturalAction } from '../permission-title.js'
import type { parseInterruptMarker } from '../interrupt-marker.js'
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
  // --- interrupt-marker (P7 PR-3) collaborators ---
  loadAccess: () => { interruptSafeBoundary?: boolean }
  toolFlightTracker: { isMidToolCall: () => boolean; inFlightCount: () => number }
  cancelInterruptedObligation: () => void
  // --- permission-reply (P7 PR-4) collaborators ---
  dispatchPermissionVerdict: (ev: {
    type: 'permission'
    requestId: string
    behavior: 'allow' | 'deny'
  }) => void
  resumeReactionAfterVerdict: () => void
  pendingPermissions: {
    get: (requestId: string) => { tool_name: string; input_preview: string } | undefined
  }
  postPermissionResumeMessage: (opts: { behavior: 'allow' | 'deny'; action: string }) => void
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

/** Per-message facts for the interrupt-marker intercept (P7 PR-3). */
export interface InterruptMarkerParams {
  /** The parse result — the caller keeps `parseInterruptMarker(text)` inline
   * because `interrupt.isInterrupt` also feeds the downstream envelope/delivery
   * path; the same value object crosses here so parse happens exactly once. */
  interrupt: ReturnType<typeof parseInterruptMarker>
  chat_id: string
  msgId: number | undefined
  messageThreadId: number | undefined
}

/**
 * Outcome of the interrupt-marker intercept. `handled: true` — empty `!` fully
 * serviced (halt fired + follow-up sent), caller returns. Otherwise the caller
 * continues the pipeline with `replacedText` (the `!` body for an interrupt,
 * the original text untouched for a non-interrupt) and `deferInterrupt` — an
 * AT-RECEIPT captured VALUE the delivery site consumes (Problem B: when true,
 * the synchronous SIGINT was skipped and the built inbound is stashed at the
 * delivery site to fire at a safe boundary).
 */
export type InterruptMarkerOutcome =
  | { handled: true }
  | { handled: false; deferInterrupt: boolean; replacedText: string | null }

/**
 * `!`-prefix interrupt (#575): SIGINT the in-flight turn and replace the
 * inbound with the marker body. Empty `!` is a pure halt (#3020) — same shared
 * `executeHaltNow` sequence as /stop. Safe-boundary deferral (Problem B): a
 * non-empty `!` mid-tool-call defers the SIGINT to the delivery site instead
 * of firing synchronously.
 *
 * The tmux SIGINT keeps its dynamic `import('../../src/agents/tmux.js')`
 * exactly as inline — the gateway runs INSIDE the agent container in docker
 * mode, so `sendAgentInterrupt` (tmux send-keys, local socket) is used instead
 * of the docker-inspect PID probe (UAT 2026-05-13 discovery).
 */
export async function interceptInterruptMarker(
  p: InterruptMarkerParams,
  deps: InboundInterceptorDeps,
): Promise<InterruptMarkerOutcome> {
  const { interrupt } = p
  if (!interrupt.isInterrupt) {
    return { handled: false, deferInterrupt: false, replacedText: null }
  }

  const agentName = process.env.SWITCHROOM_AGENT_NAME
  const access = deps.loadAccess()
  const deferInterrupt =
    !interrupt.emptyBody &&
    decideInterruptTiming({
      safeBoundaryEnabled: resolveSafeBoundaryEnabled(access.interruptSafeBoundary),
      midToolCall: deps.toolFlightTracker.isMidToolCall(),
    }) === 'defer'
  deps.log(
    `telegram gateway: interrupt-marker received chat_id=${p.chat_id} agent=${agentName ?? '-'} ` +
      `body_len=${interrupt.body.length} empty=${interrupt.emptyBody} defer=${deferInterrupt} ` +
      `in_flight=${deps.toolFlightTracker.inFlightCount()}\n`,
  )
  if (p.msgId != null) {
    void deps.sendReaction(p.chat_id, p.msgId, '⚡' as ReactionTypeEmoji['emoji']).catch(() => {})
  }
  if (interrupt.emptyBody) {
    // #3020: empty `!` is a pure halt (no replacement body) — same shared
    // sequence as /stop: safe-boundary deferral, tmux C-c, obligation
    // cancel, deterministic busy release.
    await deps.executeHaltNow('bang-empty')
    // #1075: thread-id-bearing — route through swallowingApiCall so
    // a deleted topic doesn't crash the gateway; the reaction
    // already acked the user so a missing follow-up is tolerable.
    await deps.swallowingApiCall(
      () =>
        deps.botApi().sendMessage(
          p.chat_id,
          '⚡ Interrupted. Send your replacement instruction now.',
          p.messageThreadId != null ? { message_thread_id: p.messageThreadId } : {},
        ),
      {
        chat_id: p.chat_id,
        verb: 'interrupt-empty-body',
        ...(p.messageThreadId != null ? { threadId: p.messageThreadId } : {}),
      },
    )
    return { handled: true }
  }
  if (agentName && !deferInterrupt) {
    try {
      // The gateway runs INSIDE the agent container in docker mode,
      // so calling `interruptAgent` (which probes `docker inspect`
      // for the PID) always returns "no running PID" — the host's
      // docker socket isn't visible to us. Skip the PID round-trip
      // entirely and use tmux send-keys directly: the tmux socket
      // is local to our container. Discovered during UAT overnight
      // 2026-05-13 — pre-fix every `!` interrupt produced an
      // "Agent has no running PID" stderr line and the user got
      // ghosted because the SIGINT never fired.
      const { sendAgentInterrupt } = await import('../../src/agents/tmux.js')
      const r = sendAgentInterrupt({ agentName })
      if ('ok' in r) {
        deps.log(
          `telegram gateway: interrupt-marker SIGINT delivered via tmux send-keys agent=${agentName}\n`,
        )
      } else {
        deps.log(
          `telegram gateway: interrupt-marker SIGINT via tmux failed agent=${agentName}: ${r.error}\n`,
        )
      }
    } catch (err) {
      deps.log(`telegram gateway: interrupt-marker SIGINT failed: ${(err as Error).message}\n`)
    }
    // The SIGINT just killed the in-flight turn — cancel its obligation so the
    // interrupted (user-redirected) question isn't re-presented/escalated later.
    deps.cancelInterruptedObligation()
  }
  // Replace the inbound text with the body and continue normal
  // processing. The agent receives a fresh turn with no `!` prefix.
  return { handled: false, deferInterrupt, replacedText: interrupt.body }
}

/**
 * `y <id>` / `n <id>` permission verdict reply. The 5-char request id
 * deliberately excludes `l` (ambiguity with `1`/`I` on phone keyboards).
 * Moved verbatim from gateway.ts (P7 PR-4).
 */
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** Per-message facts for the permission-reply intercept (P7 PR-4). */
export interface PermissionReplyParams {
  text: string
  chat_id: string
  msgId: number | undefined
}

/**
 * Text-reply permission verdict (`y ab3de` / `no ab3de`): forward the verdict
 * to the connected bridge, un-park the status reaction, post the
 * "continuing…" resume line, and ack with ✅/❌. Fully intercepts — the
 * verdict text is never forwarded to the agent as a turn.
 */
export function interceptPermissionReply(
  p: PermissionReplyParams,
  deps: InboundInterceptorDeps,
): InterceptOutcome {
  const permMatch = PERMISSION_REPLY_RE.exec(p.text)
  if (!permMatch) return { handled: false }
  // Forward permission reply to connected bridge
  const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
  const request_id = permMatch[2]!.toLowerCase()
  deps.dispatchPermissionVerdict({
    type: 'permission',
    requestId: request_id,
    behavior,
  })
  deps.resumeReactionAfterVerdict()
  const ftDetails = deps.pendingPermissions.get(request_id)
  deps.postPermissionResumeMessage({
    behavior,
    action: ftDetails ? naturalAction(ftDetails.tool_name, ftDetails.input_preview) : '',
  })
  if (p.msgId != null) {
    const emoji = behavior === 'allow' ? '✅' : '❌'
    void deps.sendReaction(p.chat_id, p.msgId, emoji as ReactionTypeEmoji['emoji']).catch(() => {})
  }
  return { handled: true }
}
