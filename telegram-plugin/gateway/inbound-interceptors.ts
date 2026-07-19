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

import type { Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { parseStopKeyword, buildStopReply } from './stop-command.js'
import { decideInterruptTiming, resolveSafeBoundaryEnabled } from './interrupt-defer.js'
import { naturalAction } from '../permission-title.js'
import type { PendingAuthAddFlow } from './auth-add-flow.js'
import {
  pendingLoopbackFlows,
  submitLoopbackRedirect,
  cancelLoopbackFlow,
  shouldConsumeLoopbackPaste,
} from './auth-loopback-relay.js'
import type { AddAccountCredentials } from '../../src/auth/broker/client.js'
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
  // --- auth-add paste-back (P7 PR-5) collaborators ---
  pendingAuthAddFlows: {
    get: (key: string) => PendingAuthAddFlow | undefined
    delete: (key: string) => boolean
  }
  looksLikeAuthCode: (text: string) => boolean
  /** REAUTH_INTERCEPT_TTL_MS — a fixed constant, safe to cross as a value. */
  reauthInterceptTtlMs: number
  submitAccountAuthCode: (flow: PendingAuthAddFlow, code: string) => Promise<AddAccountCredentials>
  addAccountViaBroker: (
    label: string,
    credentials: AddAccountCredentials,
    opts: { replace?: boolean },
  ) => Promise<unknown>
  cleanAuthAddScratchDir: (scratchDir: string) => void
  cancelAccountAuthSession: (flow: PendingAuthAddFlow) => void
  switchroomReply: (ctx: Context, text: string, options?: { html?: boolean }) => Promise<unknown>
  escapeHtmlForTg: (text: string) => string
  /** Closure over redactAuthCodeMessage + the gateway's redactAuthCodeApi (#488). */
  redactAuthCode: (chatId: string, msgId: number | null) => void
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

/** Per-message facts for the auth-add paste-back intercept (P7 PR-5). */
export interface AuthAddParams {
  ctx: Context
  text: string
  chat_id: string
  msgId: number | undefined
  /** chatKey(chat, thread) — computed once in handleInbound and shared by the
   * auth-add / loopback / reauth / vault intercepts (cross-topic isolation). */
  interceptKey: string
}

/**
 * `/auth add` paste-back intercept — sibling to pendingReauthFlows. Both
 * intercepts are deliberate so the LLM never sees the OAuth code (it doesn't
 * need to + plaintext OAuth in chat history is bad hygiene). The add-flow
 * intercept comes first because /auth add creates fresh credentials at the
 * broker layer, vs /reauth which mutates an existing agent's slot — different
 * success paths.
 *
 * PR3 supergroup-mode: keyed by chatKey(chat, thread) so an OAuth code pasted
 * into topic A isn't intercepted when topic B has a separate /auth add flow
 * pending (security: prevents cross-topic credential mis-attribution).
 *
 * A stale (TTL-expired) pending entry is dropped but the message falls through
 * to the later intercepts (`handled: false`), exactly as inline.
 */
export async function interceptAuthAdd(
  p: AuthAddParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  const pendingAdd = deps.pendingAuthAddFlows.get(p.interceptKey)
  if (!(pendingAdd && deps.looksLikeAuthCode(p.text))) return { handled: false }
  const elapsed = Date.now() - pendingAdd.startedAt
  if (elapsed < deps.reauthInterceptTtlMs) {
    deps.pendingAuthAddFlows.delete(p.interceptKey)
    try {
      const credentials = await deps.submitAccountAuthCode(pendingAdd, p.text.trim())
      try {
        await deps.addAccountViaBroker(pendingAdd.label, credentials, { replace: false })
        // success — wipe scratch dir now that the broker owns the creds
        deps.cleanAuthAddScratchDir(pendingAdd.scratchDir)
        await deps.switchroomReply(
          p.ctx,
          `✓ Account \`${pendingAdd.label}\` added.\n` +
            `The fleet's active account hasn't changed. Send ` +
            `\`/auth use ${deps.escapeHtmlForTg(pendingAdd.label)}\` to switch to it.`,
          { html: true },
        )
      } catch (brokerErr) {
        // Broker rejected (e.g. label already exists). Wipe scratch
        // either way — the credentials are useless without broker
        // bookkeeping.
        deps.cleanAuthAddScratchDir(pendingAdd.scratchDir)
        await deps.switchroomReply(
          p.ctx,
          `**/auth add failed at broker:** ${deps.escapeHtmlForTg((brokerErr as Error)?.message ?? String(brokerErr))}`,
          { html: true },
        )
      }
    } catch (err) {
      // submitAccountAuthCode wiped the scratch dir on its own
      // failure paths (timeout, child exit, stdin broken).
      await deps.switchroomReply(
        p.ctx,
        `**/auth add code failed:** ${deps.escapeHtmlForTg((err as Error)?.message ?? String(err))}`,
        { html: true },
      )
    }
    // Redact the OAuth code paste from chat history (#488).
    deps.redactAuthCode(p.chat_id, p.msgId ?? null)
    return { handled: true }
  }
  // Stale — drop the pending entry but let the message fall through
  // to other intercepts (defensively wipe scratch).
  deps.cancelAccountAuthSession(pendingAdd)
  deps.pendingAuthAddFlows.delete(p.interceptKey)
  return { handled: false }
}

/**
 * Loopback OAuth relay paste-back intercept (issue #2582) — sibling to the
 * /auth add intercept above. When a Google/Microsoft loopback relay is pending
 * for this chat and the operator pastes their `127.0.0.1:<port>` redirect URL,
 * validate `state` and hand the code to the waiting CLI listener. The LLM
 * never sees the code (same hygiene rationale as auth-add). Consume-gate is
 * deliberately narrow (PR #3100 review finding 1): only a message that
 * actually parses as a loopback redirect — carrying a code, or a provider
 * `error` param — is consumed and deleted; unrelated chatter that merely
 * mentions localhost/127.0.0.1 flows through untouched.
 *
 * Includes the fail-safe redaction tail (security audit #3084, F2/F3): a
 * loopback-looking paste with no live flow (stale TTL, malformed, no flow at
 * all) is redacted and dropped — it must NEVER reach the (prompt-injectable)
 * agent session while carrying a possibly-live credential.
 *
 * The loopback state/functions are imported directly from
 * auth-loopback-relay.ts (they already own their state module — same live Map
 * instance the gateway uses).
 */
export async function interceptLoopbackRelay(
  p: AuthAddParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  const pendingLoop = pendingLoopbackFlows.get(p.interceptKey)
  if (pendingLoop && shouldConsumeLoopbackPaste(p.text)) {
    const elapsed = Date.now() - pendingLoop.startedAt
    if (elapsed < deps.reauthInterceptTtlMs) {
      if (pendingLoop.submitting) {
        // A submit is already in flight (double-paste race). Don't call
        // submitLoopbackRedirect — it would answer a non-retryable "already
        // completed" and we'd delete the entry out from under the first
        // submit. Benign ack; still redact (the paste carries a live code).
        await deps.switchroomReply(
          p.ctx,
          '_Still finishing the previous paste — one moment._',
          { html: true },
        )
        deps.redactAuthCode(p.chat_id, p.msgId ?? null)
        return { handled: true }
      }
      const result = await submitLoopbackRedirect(pendingLoop, p.text.trim())
      if (result.ok) {
        pendingLoopbackFlows.delete(p.interceptKey)
        await deps.switchroomReply(
          p.ctx,
          `✓ ${pendingLoop.provider === 'google' ? 'Google' : 'Microsoft'} account ` +
            `\`${deps.escapeHtmlForTg(pendingLoop.email)}\` registered with the auth-broker.`,
          { html: true },
        )
        // Redact the pasted redirect (carries the OAuth code) from history.
        deps.redactAuthCode(p.chat_id, p.msgId ?? null)
        return { handled: true }
      }
      if (result.retryable) {
        // Keep the flow pending so the operator can paste again.
        await deps.switchroomReply(
          p.ctx,
          `**Paste not accepted:** ${deps.escapeHtmlForTg(result.reason)}\n` +
            `Re-open the consent URL, approve, and paste the full ` +
            `\`127.0.0.1\` URL from your address bar. \`/auth ${pendingLoop.provider} cancel\` to abort.`,
          { html: true },
        )
        // Redact even a rejected paste — it may still carry a live code.
        deps.redactAuthCode(p.chat_id, p.msgId ?? null)
        return { handled: true }
      }
      // Non-retryable — the flow is spent. Kill the CLI child before
      // dropping the entry (re-review finding, PR #3100): on the attempts-
      // exhausted path the child is still alive with a bound 127.0.0.1
      // listener and nothing else would ever reap it. cancelLoopbackFlow is
      // idempotent — safe on the already-exited / timed-out paths too.
      cancelLoopbackFlow(pendingLoop)
      pendingLoopbackFlows.delete(p.interceptKey)
      await deps.switchroomReply(
        p.ctx,
        `**/auth ${pendingLoop.provider} add failed:** ${deps.escapeHtmlForTg(result.reason)}`,
        { html: true },
      )
      deps.redactAuthCode(p.chat_id, p.msgId ?? null)
      return { handled: true }
    }
    // Stale — the intercept window has closed. Kill the child and drop the
    // entry, then fall through to the fail-safe below. We deliberately do NOT
    // let the paste reach the agent: the pasted `code` may still be live
    // (security audit #3084, F3), so the fail-safe redacts it.
    cancelLoopbackFlow(pendingLoop)
    pendingLoopbackFlows.delete(p.interceptKey)
  }

  // Fail-safe redaction (security audit #3084, F2/F3). A message that looks
  // like a loopback OAuth redirect/code — even one too malformed to parse
  // cleanly, or one that arrived just after the intercept TTL closed, or one
  // with no active flow at all — must NEVER reach the (prompt-injectable)
  // agent session or linger unredacted in chat while carrying a possibly-live
  // credential. shouldConsumeLoopbackPaste is narrow (requires a loopback host
  // reference AND a code/error param), so ordinary chatter mentioning
  // localhost flows through untouched. Redact and drop rather than forward.
  if (shouldConsumeLoopbackPaste(p.text)) {
    deps.redactAuthCode(p.chat_id, p.msgId ?? null)
    await deps.switchroomReply(
      p.ctx,
      '_That looked like an OAuth redirect/code, so I removed it from chat and did not forward it. ' +
        'If a Google/Microsoft account add is in progress, re-run the add command and paste the fresh ' +
        '`127.0.0.1` URL — the previous code may have expired._',
      { html: true },
    )
    return { handled: true }
  }
  return { handled: false }
}
