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
import { formatGrantedScopesReply } from './auth-command.js'
import { decideInterruptTiming, resolveSafeBoundaryEnabled } from './interrupt-defer.js'
import { naturalAction } from '../permission-title.js'
import { richMessage } from '../rich-send.js'
import { renderVaultRequestSaveCard, buildVaultRequestSaveKeyboard } from './vault-request-save-card.js'
import { runPipeline } from '../secret-detect/pipeline.js'
import { maskToken } from '../secret-detect/mask.js'
import { defaultVaultWrite, defaultVaultList } from '../secret-detect/vault-write.js'
import { parseVaultCliError, renderVaultCliError } from '../secret-detect/vault-error.js'
import { detectSecrets } from '../secret-detect/index.js'
import type { StagingMap } from '../secret-detect/staging.js'
import type { PendingAuthAddFlow } from './auth-add-flow.js'
import type {
  createCallbackQueryHandlers,
  PendingVaultOp,
  PendingVaultRequestSave,
  PendingVaultRequestAccess,
  DeferredSecret,
} from './callback-query-handlers.js'
import type { InlineKeyboard } from 'grammy'
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
    deleteMessage: (chatId: string, messageId: number) => Promise<unknown>
  }
  log: (line: string) => void
  // --- interrupt-marker (P7 PR-3) collaborators ---
  loadAccess: () => { interruptSafeBoundary?: boolean; allowFrom: string[] }
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
  switchroomReply: (
    ctx: Context,
    text: string,
    options?: { html?: boolean; reply_markup?: InlineKeyboard },
  ) => Promise<unknown>
  escapeHtmlForTg: (text: string) => string
  /** Closure over redactAuthCodeMessage + the gateway's redactAuthCodeApi (#488). */
  redactAuthCode: (chatId: string, msgId: number | null) => void
  // --- reauth paste-back (P7 PR-7) collaborators ---
  pendingReauthFlows: {
    get: (key: string) => { agent: string; startedAt: number } | undefined
    delete: (key: string) => boolean
  }
  execAuthCode: (
    agent: string,
    code: string,
  ) =>
    | { result: { outcome: unknown; instructions: string[] }; errorText: null }
    | { result: null; errorText: string }
  renderAuthCodeOutcome: (outcome: unknown) => string | null
  preBlock: (text: string) => string
  formatSwitchroomOutput: (output: string) => string
  formatAuthOutputForTelegram: (output: string) => { text: string; url: string | null }
  // --- vault intercept (P7 PR-8) collaborators ---
  pendingVaultOps: {
    get: (chatId: string) => PendingVaultOp | undefined
    delete: (chatId: string) => boolean
    set: (chatId: string, v: PendingVaultOp) => void
  }
  /** VAULT_INPUT_TTL_MS / VAULT_PASSPHRASE_TTL_MS — fixed constants. */
  vaultInputTtlMs: number
  vaultPassphraseTtlMs: number
  vaultPassphraseCache: {
    get: (chatId: string) => { passphrase: string; expiresAt: number } | undefined
    set: (chatId: string, v: { passphrase: string; expiresAt: number }) => void
  }
  deleteSensitiveMessage: (chatId: string, msgId: number, reason: string) => Promise<void>
  executeVaultOp: (
    ctx: Context,
    chatId: string,
    op: 'list' | 'get' | 'set' | 'delete',
    key: string | undefined,
    passphrase: string,
    setValue: string | undefined,
  ) => Promise<void>
  unlockViaBroker: (passphrase: string) => Promise<{ ok: boolean; msg?: string }>
  /** LAZY accessor — callbackQueryHandlers is a boot-assigned `let` in gateway.ts. */
  callbackQueryHandlers: () => Pick<
    ReturnType<typeof createCallbackQueryHandlers>,
    | 'executeDeferredSecretSave'
    | 'performVaultAccessApproval'
    // #3627: owns the per-passphrase-entry attempt counter + re-prompt /
    // lockout decision after the broker refuses a mint as a mismatch.
    | 'resolveAccessApprovalPassphraseMismatch'
    | 'parseGrantDuration'
    | 'grantWizardConfirm'
  >
  pendingVaultRequestAccesses: {
    get: (stageId: string) => PendingVaultRequestAccess | undefined
  }
  pendingVaultRequestSaves: {
    get: (stageId: string) => PendingVaultRequestSave | undefined
  }
  vaultKeyRegex: RegExp
  vaultKeyRegexLabel: string
  // --- secret-detect (P7 PR-9) collaborators ---
  secretStaging: StagingMap
  awaitingAuthCodeAt: { get: (chatId: string) => number | undefined; delete: (chatId: string) => boolean }
  /** AUTH_CODE_CONTEXT_TTL_MS — fixed constant. */
  authCodeContextTtlMs: number
  deferredSecrets: { set: (key: string, v: DeferredSecret) => void }
  deferredKey: (chatId: string, messageId: number) => string
  mintDeferredSecretKernelRequest: (slug: string, approverSet: string[]) => Promise<string | null>
  buildDeferredSecretKeyboard: (deferKey: string) => InlineKeyboard
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
      const replace = pendingAdd.replace === true
      try {
        await deps.addAccountViaBroker(pendingAdd.label, credentials, { replace })
        // success — wipe scratch dir now that the broker owns the creds
        deps.cleanAuthAddScratchDir(pendingAdd.scratchDir)
        // Read the minted scopes STRUCTURALLY (never scraped) and surface
        // them so a scope regression (missing user:profile) is caught at add
        // time, not at /usage time.
        const scopeReply = formatGrantedScopesReply(
          (credentials as { claudeAiOauth?: { scopes?: string[] } }).claudeAiOauth?.scopes,
        )
        const verb = replace ? 're-authenticated' : 'added'
        await deps.switchroomReply(
          p.ctx,
          `✓ Account \`${pendingAdd.label}\` ${verb}.\n` +
            `The fleet's active account hasn't changed. Send ` +
            `\`/auth use ${deps.escapeHtmlForTg(pendingAdd.label)}\` to switch to it.` +
            scopeReply.text,
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

/**
 * /reauth OAuth-code paste-back intercept — the elder sibling of auth-add
 * (mutates an existing agent's slot via `switchroom auth code`, vs /auth add
 * which creates fresh credentials at the broker). Runs AFTER auth-add /
 * loopback (load-bearing order). Same chatKey-scoped isolation + TTL window;
 * the code paste is redacted from history either way (#488). A stale entry is
 * dropped and the message falls through (`handled: false`).
 */
export async function interceptReauth(
  p: AuthAddParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  const pendingReauth = deps.pendingReauthFlows.get(p.interceptKey)
  if (!(pendingReauth && deps.looksLikeAuthCode(p.text))) return { handled: false }
  const elapsed = Date.now() - pendingReauth.startedAt
  if (elapsed < deps.reauthInterceptTtlMs) {
    deps.pendingReauthFlows.delete(p.interceptKey)
    const { result, errorText } = deps.execAuthCode(pendingReauth.agent, p.text.trim())
    if (errorText) {
      await deps.switchroomReply(
        p.ctx,
        `**auth code failed:**\n${deps.preBlock(deps.formatSwitchroomOutput(errorText))}`,
        { html: true },
      )
    } else if (result) {
      const outcomeMsg = deps.renderAuthCodeOutcome(result.outcome)
      if (outcomeMsg) {
        await deps.switchroomReply(p.ctx, outcomeMsg, { html: true })
      } else {
        // success or no structured outcome — fall back to formatted text
        const output = result.instructions.join('\n')
        const formatted = deps.formatAuthOutputForTelegram(output)
        await deps.switchroomReply(p.ctx, formatted.text, { html: true })
      }
    }
    // Redact the OAuth code paste from chat history (#488).
    // Single-use code so a third party can't replay it after exchange,
    // but plaintext OAuth tokens in chat history are still poor
    // hygiene. The helper handles delete + 🔑 reaction silently.
    deps.redactAuthCode(p.chat_id, p.msgId ?? null)
    return { handled: true }
  }
  deps.pendingReauthFlows.delete(p.interceptKey)
  return { handled: false }
}


/** Per-message facts for the vault intercept (P7 PR-8). Keyed by chat_id
 * (a vault op is chat-scoped, not topic-scoped — unlike the auth intercepts). */
export interface VaultInterceptParams {
  ctx: Context
  text: string
  chat_id: string
  msgId: number | undefined
}

/**
 * Vault pending-op intercept: the text reply that completes a /vault flow
 * (passphrase, broker unlock, deferred-secret save, access-approve passphrase
 * drain, grant-wizard duration, secret value, rename-vault-save). Fully
 * intercepts any fresh pending entry (`handled: true` — the reply text is a
 * passphrase or secret, never forwarded to the agent); a TTL-stale entry is
 * dropped and the message falls through.
 *
 * Moved VERBATIM from gateway.ts (#2996 P7 PR-8). The two raw
 * `p.ctx.api\n.editMessageText` calls keep their inline line-split shape and
 * `.catch(() => {})` best-effort semantics exactly as before.
 */
export async function interceptVault(
  p: VaultInterceptParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  const pendingVault = deps.pendingVaultOps.get(p.chat_id)
  if (pendingVault) {
    const elapsed = Date.now() - pendingVault.startedAt
    if (elapsed > deps.vaultInputTtlMs) {
      deps.pendingVaultOps.delete(p.chat_id)
    } else {
      deps.pendingVaultOps.delete(p.chat_id)
      if (pendingVault.kind === 'passphrase') {
        const passphrase = p.text.trim()
        if (!passphrase) {
          await deps.switchroomReply(p.ctx, 'Passphrase cannot be empty. Try /vault again.', { html: true })
          return { handled: true }
        }
        deps.vaultPassphraseCache.set(p.chat_id, { passphrase, expiresAt: Date.now() + deps.vaultPassphraseTtlMs })
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault passphrase')
        await deps.executeVaultOp(p.ctx, p.chat_id, pendingVault.op, pendingVault.key, passphrase, undefined)
      } else if (pendingVault.kind === 'unlock') {
        // Issue #158: passphrase for /vault unlock — sent directly to the
        // broker unlock socket, never cached or logged.
        const passphrase = p.text.trim()
        if (!passphrase) {
          await deps.switchroomReply(p.ctx, 'Passphrase cannot be empty. Try /vault unlock again.', { html: true })
          return { handled: true }
        }
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault unlock passphrase')
        const result = await deps.unlockViaBroker(passphrase)
        if (result.ok) {
          await deps.switchroomReply(p.ctx, '🔓 Vault broker unlocked.', { html: true })
        } else {
          await deps.switchroomReply(p.ctx, `**vault unlock failed:** ${deps.escapeHtmlForTg(result.msg ?? 'unknown error')}`, { html: true })
        }
      } else if (pendingVault.kind === 'passphrase-for-deferred') {
        // Issue #44: passphrase entered after tapping "🔓 Unlock vault &
        // save" on the deferred-secret card. Cache the passphrase then
        // auto-write the held secret directly — no re-paste required.
        // The passphrase message itself is deleted so it doesn't linger
        // in chat history (same protection as the original secret got).
        const passphrase = p.text.trim()
        if (!passphrase) {
          await deps.switchroomReply(p.ctx, 'Passphrase cannot be empty. Tap the unlock button again.', { html: true })
          return { handled: true }
        }
        deps.vaultPassphraseCache.set(p.chat_id, { passphrase, expiresAt: Date.now() + deps.vaultPassphraseTtlMs })
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault passphrase')
        await deps.callbackQueryHandlers().executeDeferredSecretSave(p.ctx, pendingVault.deferKey, passphrase, pendingVault.cardMessageId)
      } else if (pendingVault.kind === 'passphrase-for-access-approve') {
        // #1012 Phase 2 follow-up + #1051: operator tapped Approve on
        // one or more vault_request_access cards without first
        // unlocking. We captured the next message as the passphrase,
        // cache it, delete the chat copy, and resume the approve
        // flow for EVERY queued stage (#1051 — without the queue, a
        // concurrent second tap orphaned the first stage). A wrong
        // passphrase surfaces via the broker's
        // DENIED:passphrase-mismatch path; #3627 keeps those stages
        // ALIVE and re-prompts with the attempts remaining (counted per
        // passphrase ENTRY, since this one entry drains the whole batch)
        // until MAX_VAULT_PASSPHRASE_ATTEMPTS, then falls back to the
        // terminal card edit.
        const passphrase = p.text.trim()
        if (!passphrase) {
          await deps.switchroomReply(p.ctx, 'Passphrase cannot be empty. Ask the agent to re-issue the request card.', { html: true })
          return { handled: true }
        }
        deps.vaultPassphraseCache.set(p.chat_id, { passphrase, expiresAt: Date.now() + deps.vaultPassphraseTtlMs })
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault passphrase')
        // Drain the queued items SEQUENTIALLY. The grant-union step
        // inside performVaultAccessApproval lists existing grants
        // before minting; sequential processing means the union
        // grows monotonically (item 1 mints grant for [keyA]; item 2
        // lists, finds [keyA], unions with keyB → mints [keyA, keyB]).
        // Parallel processing would race on the list-and-merge.
        // #3627: stages the broker refused as a passphrase MISMATCH. They
        // are still staged and their cards still say "waiting" — collected
        // here so one re-prompt covers the whole batch.
        const mismatched: typeof pendingVault.items = []
        let mismatchMsg = ''
        for (const item of pendingVault.items) {
          const stagedAccess = deps.pendingVaultRequestAccesses.get(item.stageId)
          if (!stagedAccess) {
            // Stage expired or denied between tap and passphrase reply.
            // Edit its card to a clean explanation; don't break the
            // loop (sibling cards may still be valid).
            await p.ctx.api
              .editMessageText(
                item.cardChatId,
                item.cardMessageId,
                richMessage(`⌛ _Vault unlocked, but this access-request card expired or was denied before you replied. Ask the agent to re-issue if still needed._`),
                { reply_markup: { inline_keyboard: [] } },
              )
              .catch(() => {})
            continue
          }
          const outcome = await deps.callbackQueryHandlers().performVaultAccessApproval(p.ctx, stagedAccess, item.stageId, item.senderId, { kind: 'passphrase', passphrase })
          if (outcome?.kind === 'passphrase-mismatch') {
            mismatched.push(item)
            mismatchMsg = outcome.msg
          }
        }
        if (mismatched.length > 0) {
          await deps.callbackQueryHandlers().resolveAccessApprovalPassphraseMismatch(p.ctx, {
            chat_id: p.chat_id,
            failed: mismatched,
            priorAttempts: pendingVault.attempts ?? 0,
            brokerMsg: mismatchMsg,
          })
        }
      } else if (pendingVault.kind === 'grant-wizard' && pendingVault.awaitingCustomDuration) {
        // Issue #227: custom duration text reply for grant wizard
        const input = p.text.trim()
        const ttlSeconds = deps.callbackQueryHandlers().parseGrantDuration(input)
        if (ttlSeconds === null) {
          // Re-set state so user can try again
          deps.pendingVaultOps.set(p.chat_id, { ...pendingVault, startedAt: Date.now() })
          await deps.switchroomReply(p.ctx, '⚠️ Invalid duration. Use \`Nd\` (days) or \`Nh\` (hours), e.g. \`30d\` or \`12h\`.', { html: true })
          return { handled: true }
        }
        const newState = { ...pendingVault, ttlSeconds, awaitingCustomDuration: false }
        await deps.callbackQueryHandlers().grantWizardConfirm(p.ctx, p.chat_id, newState)
      } else if (pendingVault.kind === 'grant-wizard') {
        // Text received mid-wizard but not awaiting custom duration — ignore and re-set
        deps.pendingVaultOps.set(p.chat_id, { ...pendingVault, startedAt: Date.now() })
      } else if (pendingVault.kind === 'value') {
        let value = p.text
        const codeBlockMatch = /^```[\w]*\n?([\s\S]*?)```$/m.exec(p.text)
        if (codeBlockMatch) value = codeBlockMatch[1]!
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault secret value')
        await deps.executeVaultOp(p.ctx, p.chat_id, 'set', pendingVault.key, pendingVault.passphrase, value.trim())
      } else if (pendingVault.kind === 'rename-vault-save') {
        // Issue #969 P1a: user tapped Rename on a vault_request_save
        // card and is now telling us the new key name. Validate the
        // slug, update the staged entry, refresh the card.
        const newKey = p.text.trim()
        const staged = deps.pendingVaultRequestSaves.get(pendingVault.stageId)
        if (!staged) {
          await deps.switchroomReply(p.ctx, '⌛ That save card expired before you renamed. Ask the agent to re-issue.', { html: true })
          return { handled: true }
        }
        if (!deps.vaultKeyRegex.test(newKey)) {
          // Re-arm the pending state so the user can try again.
          deps.pendingVaultOps.set(p.chat_id, { ...pendingVault, startedAt: Date.now() })
          await deps.switchroomReply(p.ctx, `⚠️ Key must match \`${deps.vaultKeyRegexLabel}\`. Send a different name.`, { html: true })
          return { handled: true }
        }
        staged.key = newKey
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'vault rename input')
        // Edit the card in place with the new suggested key + same buttons.
        if (staged.card_message_id != null) {
          await p.ctx.api
            .editMessageText(
              staged.chat_id,
              staged.card_message_id,
              richMessage(renderVaultRequestSaveCard(staged, staged.agent)),
              { reply_markup: buildVaultRequestSaveKeyboard(pendingVault.stageId) },
            )
            .catch(() => {})
        }
      }
      return { handled: true }
    }
  }
  return { handled: false }
}


/** Per-message facts for the secret-detect intercepts (P7 PR-9). */
export interface SecretStagingCommandParams {
  ctx: Context
  text: string
  chat_id: string
  msgId: number | undefined
}

/**
 * Secret-detect follow-up command intercept: `stash NAME` / `ignore` /
 * `rename X` / `forget` on a pending ambiguous detection. The user is replying
 * to our "looks like a high-entropy string — reply `stash NAME` or `ignore`"
 * prompt; we look up the most recent staged detection for this chat and act on
 * it. With no staged entry the message falls through to normal handling.
 * Moved verbatim from gateway.ts (#2996 P7 PR-9).
 */
export async function interceptSecretStagingCommand(
  p: SecretStagingCommandParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  // --- Secret-detect follow-up command intercept ---
  // `stash NAME` / `ignore` / `rename X` / `forget` on a pending ambiguous
  // detection. The user is replying to our "looks like a high-entropy
  // string — reply `stash NAME` or `ignore`" prompt. We look up the most
  // recent staged detection for this chat and act on it.
  const stagedMatch = /^\s*(stash|ignore|rename|forget)\b\s*(\S+)?/i.exec(p.text)
  if (stagedMatch) {
    const staged = deps.secretStaging.latestForChat(p.chat_id)
    if (staged != null) {
      const verb = stagedMatch[1]!.toLowerCase()
      const arg = stagedMatch[2]?.trim()
      if (verb === 'ignore' || verb === 'forget') {
        deps.secretStaging.delete(staged.chat_id, staged.message_id)
        await deps.switchroomReply(p.ctx, 'ok — ignored. nothing stored.', { html: true })
        // #1075: operates on a message in a (possibly-deleted) thread.
        if (p.msgId != null) {
          const delMsgId = p.msgId
          void deps.swallowingApiCall(
            () => deps.botApi().deleteMessage(p.chat_id, delMsgId),
            { chat_id: p.chat_id, verb: 'staged-secret.delete-ignored' },
          )
        }
        return { handled: true }
      }
      if (verb === 'stash' || verb === 'rename') {
        const cached = deps.vaultPassphraseCache.get(p.chat_id)
        if (!cached || cached.expiresAt <= Date.now()) {
          await deps.switchroomReply(p.ctx, 'No vault passphrase cached. Run \`/vault list\` first (or any /vault command) to unlock, then re-send \`stash NAME\`.', { html: true })
          return { handled: true }
        }
        const slugBase = arg && arg.length > 0 ? arg : staged.detection.suggested_slug
        const listed = defaultVaultList(cached.passphrase)
        const existing = new Set(listed.ok ? listed.keys : [])
        let slug = slugBase
        let n = 2
        while (existing.has(slug)) slug = `${slugBase}_${n++}`
        const write = defaultVaultWrite(slug, staged.detection.matched_text, cached.passphrase)
        if (!write.ok) {
          // Route P0a markers (#969) through the structured renderer so
          // a "new key, needs operator approval" failure surfaces a
          // host-CLI hint instead of a raw stderr blob.
          const parsed = parseVaultCliError(write.output)
          const rendered = renderVaultCliError(parsed, { verb: 'save', key: slug })
          const body = rendered.suppressRaw
            ? rendered.html
            : `**vault write failed:**\n${deps.preBlock(write.output)}`
          await deps.switchroomReply(p.ctx, body, { html: true })
          return { handled: true }
        }
        deps.secretStaging.delete(staged.chat_id, staged.message_id)
        if (p.msgId != null) await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'stash command')
        await deps.deleteSensitiveMessage(p.chat_id, staged.message_id, 'detected secret')
        await deps.switchroomReply(p.ctx, `✅ stored as \`vault:${slug}\` (masked: \`${maskToken(staged.detection.matched_text)}\`)`, { html: true })
        return { handled: true }
      }
    }
    // No staged entry to act on — fall through to normal handling.
  }
  return { handled: false }
}

/** Params for the secret-detect pipeline intercept (P7 PR-9). `effectiveText`
 * is the steer/queue-prefix-stripped text captured in handleInbound; the
 * scrub may REWRITE it, so it crosses back in the outcome as a value. */
export interface SecretDetectPipelineParams {
  ctx: Context
  chat_id: string
  msgId: number | undefined
  effectiveText: string
}

/** Outcome of the pipeline intercept: `handled: true` drops/consumes the
 * message; otherwise the caller MUST adopt `effectiveText` (possibly rewritten
 * with vault refs) for everything downstream — history, envelope, IPC. */
export type SecretDetectPipelineOutcome =
  | { handled: true }
  | { handled: false; effectiveText: string }

/**
 * Secret detection + vault-scrub (moved verbatim, #2996 P7 PR-9). If the user
 * pasted a secret, intercept BEFORE recording to history or broadcasting to
 * the agent: write to vault, delete the Telegram message, rewrite the prompt
 * so the downstream session .jsonl, Hindsight memory, and IPC payload never
 * see the raw bytes. No cached passphrase → high-confidence hits are deferred
 * behind the one-tap unlock+save card (#44).
 *
 * FAIL-CLOSED: if the pipeline throws, drop the message and warn the user —
 * never fall through to recordInbound/broadcast with raw bytes. See
 * gateway-secret-detect.test.ts and secret-detect-fail-closed.test.ts.
 */
export async function interceptSecretDetectPipeline(
  p: SecretDetectPipelineParams,
  deps: InboundInterceptorDeps,
): Promise<SecretDetectPipelineOutcome> {
  let effectiveText = p.effectiveText
  // --- Secret detection + vault-scrub ---
  // If the user pasted a secret, intercept BEFORE we record to history or
  // broadcast to the agent: write to vault, delete the Telegram message,
  // rewrite the prompt so the downstream session .jsonl, Hindsight memory,
  // and IPC payload never see the raw bytes. If there's no cached vault
  // passphrase, high-confidence hits are deferred and the user is asked to
  // unlock first.
  //
  // FAIL-CLOSED: if the pipeline throws, drop the message and warn the user
  // — never fall through to recordInbound/broadcast with raw bytes. See
  // gateway-secret-detect.test.ts and secret-detect-fail-closed.test.ts.
  try {
    // Channel B context rule: if we emitted "Paste the browser code here"
    // recently in this chat, treat the inbound as auth-flow-sensitive —
    // high-confidence secret detection regardless of pattern match. This
    // survives Anthropic changing their token format because it tracks the
    // gateway's own prompt, not the token shape.
    const authCodeSentAt = deps.awaitingAuthCodeAt.get(p.chat_id)
    const isAuthFlowContext =
      authCodeSentAt !== undefined && Date.now() - authCodeSentAt < deps.authCodeContextTtlMs
    if (isAuthFlowContext) {
      process.stderr.write(`[secret-detect] auth-flow context rule active for chat ${p.chat_id}\n`)
    }

    const cachedPp = deps.vaultPassphraseCache.get(p.chat_id)
    const passphrase = cachedPp && cachedPp.expiresAt > Date.now() ? cachedPp.passphrase : null
    if (passphrase) {
      const pipeRes = runPipeline({
        chat_id: p.chat_id,
        message_id: p.msgId ?? null,
        text: effectiveText,
        passphrase,
        vaultWrite: defaultVaultWrite,
        vaultList: defaultVaultList,
      })
      if (pipeRes.stored.length > 0) {
        effectiveText = pipeRes.rewritten_text
        if (isAuthFlowContext) {
          deps.awaitingAuthCodeAt.delete(p.chat_id) // consume: one message per prompt
        }
        // 2026-05-12: route through deps.deleteSensitiveMessage so a
        // failed delete posts an in-chat warning naming the leaked
        // message id, instead of only logging to stderr (invisible
        // on mobile). Previously the operator saw "we deleted it
        // from chat" while the raw secret stayed visible. See
        // tests/secret-detect-delete-must-surface-failures.test.ts.
        if (p.msgId != null) {
          await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'detected secret')
        }
        const lines = pipeRes.stored.map((s) =>
          `• \`${s.masked}\` → \`vault:${s.actual_slug}\``,
        )
        await deps.switchroomReply(
          p.ctx,
          [`🔒 captured ${pipeRes.stored.length} secret${pipeRes.stored.length === 1 ? '' : 's'}:`, ...lines, '', 'reply \`rename X\` or \`forget\`.'].join('\n'),
          { html: true },
        )
        for (const s of pipeRes.stored) {
          deps.secretStaging.set({
            chat_id: p.chat_id,
            message_id: p.msgId ?? 0,
            detection: { ...s.detection, suggested_slug: s.actual_slug },
            staged_at: Date.now(),
          })
        }
      } else if (isAuthFlowContext && pipeRes.stored.length === 0) {
        // Channel B fallback: pattern didn't fire (Anthropic may have changed
        // the token format) but we know this is an auth code paste because we
        // prompted for it. Delete + stage + warn so no raw bytes leak.
        deps.awaitingAuthCodeAt.delete(p.chat_id) // consume: one message per prompt
        // 2026-05-12: route through deps.deleteSensitiveMessage. See
        // tests/secret-detect-delete-must-surface-failures.test.ts.
        if (p.msgId != null) {
          await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'auth-flow secret')
        }
        // Issue #44: even with passphrase cached we hit this branch when the
        // pattern didn't fire — but at this point a vault write would still
        // need the user's intent. Stash with a one-tap unlock+save card so
        // the post-context flow stays seamless.
        const dKey = deps.deferredKey(p.chat_id, p.msgId ?? 0)
        const cachedBranchDetection = detectSecrets(effectiveText).find((d) => d.confidence === 'high' && !d.suppressed)
        const cachedBranchSlug = cachedBranchDetection?.suggested_slug ?? (isAuthFlowContext ? 'anthropic_oauth_code' : 'secret')
        const cachedBranchKernelId = await deps.mintDeferredSecretKernelRequest(
          cachedBranchSlug,
          deps.loadAccess().allowFrom,
        )
        deps.deferredSecrets.set(dKey, {
          chat_id: p.chat_id,
          original_message_id: p.msgId ?? 0,
          text: effectiveText,
          staged_at: Date.now(),
          suggested_slug: cachedBranchSlug,
          kernel_request_id: cachedBranchKernelId ?? undefined,
        })
        await deps.switchroomReply(
          p.ctx,
          '🔒 auth-flow secret detected. we deleted it from chat. tap below to save it to the vault — no re-paste needed.',
          { html: true, reply_markup: deps.buildDeferredSecretKeyboard(dKey) },
        )
        return { handled: true }
      } else if (pipeRes.ambiguous.length > 0) {
        for (const d of pipeRes.ambiguous) {
          deps.secretStaging.set({ chat_id: p.chat_id, message_id: p.msgId ?? 0, detection: d, staged_at: Date.now() })
        }
        const top = pipeRes.ambiguous[0]!
        await deps.switchroomReply(
          p.ctx,
          `👀 looks like a high-entropy string (rule: \`${top.rule_id}\`). reply \`stash NAME\` to store in vault, or \`ignore\`.`,
          { html: true },
        )
        // For ambiguous, we do NOT delete the message or rewrite — let the
        // user confirm first.
      }
    } else {
      // No passphrase cached — detect, but defer. Issue #44 turned this
      // into a one-tap unlock-and-save flow: previously the user had to
      // run `/vault list`, type their passphrase, then re-paste the
      // original secret (six steps for a non-technical user). Now they
      // tap a button and re-enter the passphrase exactly once.
      const detections = detectSecrets(effectiveText)
      const highConfDetection = detections.find((d) => d.confidence === 'high' && !d.suppressed)
      const hasHigh = highConfDetection !== undefined || isAuthFlowContext
      if (hasHigh) {
        if (isAuthFlowContext) {
          deps.awaitingAuthCodeAt.delete(p.chat_id) // consume: one message per prompt
        }
        // Capture the slug at defer-time so the post-unlock auto-write
        // doesn't have to re-detect (which has a degenerate case for
        // Channel-B context defers where no pattern fired).
        const suggestedSlug =
          highConfDetection?.suggested_slug
          ?? (isAuthFlowContext ? 'anthropic_oauth_code' : 'secret')
        const dKey = deps.deferredKey(p.chat_id, p.msgId ?? 0)
        const noPassKernelId = await deps.mintDeferredSecretKernelRequest(
          suggestedSlug,
          deps.loadAccess().allowFrom,
        )
        deps.deferredSecrets.set(dKey, {
          chat_id: p.chat_id,
          original_message_id: p.msgId ?? 0,
          text: effectiveText,
          staged_at: Date.now(),
          suggested_slug: suggestedSlug,
          kernel_request_id: noPassKernelId ?? undefined,
        })
        // 2026-05-12: route through deps.deleteSensitiveMessage. See
        // tests/secret-detect-delete-must-surface-failures.test.ts.
        if (p.msgId != null) {
          await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'detected secret')
        }
        await deps.switchroomReply(
          p.ctx,
          '🔒 caught a secret. we deleted it from chat. tap below to unlock the vault and save it — no re-paste needed.',
          { html: true, reply_markup: deps.buildDeferredSecretKeyboard(dKey) },
        )
        return { handled: true }
      }
    }
  } catch (err) {
    // FAIL-CLOSED: if the detector throws, we must NOT fall through to
    // recordInbound() / ipcServer.broadcast() with the raw text — that
    // would stamp the secret into SQLite and emit it to the agent
    // unscrubbed. Drop the message on the floor and warn the user.
    process.stderr.write(`[secret-detect] pipeline error: ${(err as Error).message}\n`)
    try {
      await deps.switchroomReply(
        p.ctx,
        '⚠️ secret-detect pipeline crashed; this message was dropped for safety. please try again or check the agent log.',
        { html: true },
      )
    } catch {}
    // 2026-05-12: route through deps.deleteSensitiveMessage. The
    // pipeline-error fail-closed path is the LAST line of defence —
    // if delete fails here, the operator must know so they can
    // delete manually. See
    // tests/secret-detect-delete-must-surface-failures.test.ts.
    if (p.msgId != null) {
      await deps.deleteSensitiveMessage(p.chat_id, p.msgId, 'secret-detect pipeline-error fallback')
    }
    return { handled: true }
  }
  return { handled: false, effectiveText }
}
