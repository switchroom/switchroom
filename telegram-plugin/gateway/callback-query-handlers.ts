// Callback-query handlers — the vault / skill / mental-model / operator-event /
// auth-dashboard callback families, extracted verbatim from gateway.ts
// (#2996 Phase 5, remaining item 2).
//
// This module owns the handler LOGIC for the `bot.on('callback_query:data')`
// families that were previously ~2,200 lines of free functions inside
// gateway.ts:
//
//   - vrd:*  — /vault audit one-tap "Always allow" (recent denials)
//   - vra:*  — vault_request_access approve/deny (+ performVaultAccessApproval,
//              shared with the passphrase-capture resume flow)
//   - vrs:*  — vault_request_save save/discard/rename
//   - vd:*   — deferred-secret unlock/cancel (+ executeDeferredSecretSave,
//              shared with the passphrase text-intercept)
//   - vg:*   — vault grant management + the /vault grant wizard (all steps)
//   - mmp:*  — mental-model proposal approve/deny
//   - sp:*   — skill-improvement proposal approve/dismiss
//   - op:*   — operator-event card actions (dismiss/restart/reauth/logs)
//   - auth:* — auth dashboard (fleet account swap, snapshot refresh)
//
// Deliberately NOT moved (they stay in gateway.ts): the dispatcher itself
// (`bot.on('callback_query:data', …)` — it also routes agent:*, mdl:*, eff:*,
// cn:*, cfg:*, and permission-card callbacks whose state is entangled with
// the durability layer), the card RENDER/stage paths (vault_request_* MCP
// tool handlers), and the pending-store constructions (TTL sweeps + expiry
// thunks live with the reaper).
//
// Style: factory over a deps object, following outbound-send-path.ts /
// register-bot-commands.ts / pending-state-stores.ts (PRs #3007-#3011).
// Everything gateway-LOCAL (module state, stores, config-derived mutable
// flags, wrapped API callers) is injected; everything gateway itself imports
// from other modules is imported here directly. Function bodies are
// byte-identical to the pre-extraction gateway.ts text except for four
// mechanical reads of formerly-mutable module `let`s, which became injected
// getters (`getVaultApprovalAuthMode()`, `getAdminOnlyKeys()`) so config
// reloads keep being observed live.

import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { InlineKeyboard, type Context } from 'grammy'
import { richMessage } from '../rich-send.js'
import { finalizeCallback } from '../inline-keyboard-callbacks.js'
import { retryWithThreadFallback, type RetryCallOpts } from '../retry-api-call.js'
import {
  mintGrantViaBroker as realMintGrantViaBroker,
  listViaBroker as realListViaBroker,
  listGrantsViaBroker as realListGrantsViaBroker,
  vaultTokenFilePath as realVaultTokenFilePath,
  revokeGrantViaBroker,
} from '../../src/vault/broker/client.js'
import {
  buildVaultGrantApprovedInbound,
  buildVaultGrantApprovedCardText,
  normalizeGrantReason,
  buildVaultGrantDeniedInbound,
  buildVaultSaveCompletedInbound,
  buildVaultSaveFailedInbound,
  buildVaultSaveDiscardedInbound,
} from './vault-grant-inbound-builders.js'
import {
  resolveMentalModelProposal,
  type MentalModelPendingProposal,
} from './mental-model-propose-resolve.js'
import {
  parseSkillProposalCallback,
  buildSkillProposalApplyInbound,
} from './skill-proposal-card.js'
import {
  getProposal as getSkillProposal,
  setProposalStatus as setSkillProposalStatus,
} from '../../src/self-improve/skill-proposals.js'
import { parseEvalCaseProposalCallback } from './eval-case-proposal-card.js'
import {
  getEvalCaseProposal,
  setEvalCaseProposalStatus,
} from '../../src/self-improve/eval-case-proposals.js'
import {
  buildEvalCaseAppliedInbound,
  buildEvalCaseRejectedInbound,
  buildEvalCaseApplyFailedInbound,
} from './eval-case-proposal-inbound-builders.js'
import { maskToken } from '../secret-detect/mask.js'
import {
  defaultVaultWrite,
  defaultVaultList,
  defaultVaultWritePosture,
} from '../secret-detect/vault-write.js'
import { parseVaultCliError, renderVaultCliError } from '../secret-detect/vault-error.js'
import type { StagingMap } from '../secret-detect/staging.js'
import { zipProbeResults } from '../auth-snapshot-format.js'
import { matchesAdminOnlyKey } from '../../src/vault/admin-only-keys.js'
import { getAuthBrokerClient } from './auth-broker-client.js'
import { chatKey } from './chat-key.js'
import { tryHostdDispatch, hostdRequestId } from './hostd-dispatch.js'
import type { HostdRequest } from '../../src/host-control/protocol.js'
import type { OperatorEvent } from '../operator-events.js'
import type { InboundMessage } from './ipc-protocol.js'
import type { SweepableCardStore } from './approval-card-stores.js'
import type { SweepableStore } from './pending-state-stores.js'

// ─── Pending-state entry types (moved with the handlers; the stores that
//     hold them are still constructed in gateway.ts, which imports these
//     types back) ─────────────────────────────────────────────────────────

export type PendingVaultOp =
  | { kind: 'passphrase'; op: 'list' | 'get' | 'delete' | 'set'; key?: string; startedAt: number }
  | { kind: 'value'; op: 'set'; key: string; passphrase: string; startedAt: number }
  // Issue #44: passphrase entry triggered by tapping "🔓 Unlock vault & save"
  // on a deferred-secret card. After the passphrase is cached we look up the
  // held secret by deferKey and write it directly — no re-paste required.
  | {
      kind: 'passphrase-for-deferred'
      deferKey: string
      cardChatId: string
      cardMessageId: number
      startedAt: number
    }
  // Issue #158: passphrase collected for /vault unlock — sent directly to the
  // broker unlock socket, never logged or cached beyond the op itself.
  | { kind: 'unlock'; startedAt: number }
  // Issue #227: inline-keyboard wizard for /vault grant
  | {
      kind: 'grant-wizard'
      step: 'agent' | 'keys' | 'duration' | 'confirm'
      wizardMsgId?: number      // message to edit for each step
      agent?: string
      selectedKeys?: string[]   // keys toggled on in step 2
      availableKeys?: string[]  // list fetched from broker
      ttlSeconds?: number | null // null = never expires
      expiresLabel?: string     // human-readable label for confirmation
      description?: string
      awaitingCustomDuration?: boolean  // true while waiting for text reply
      /**
       * Approval-kernel request_id minted at the wizard confirm step
       * (MIGRATION.md §2, Phase 1 dual-dispatch — audit-only, advisory).
       * When set, `vg:generate` ALSO consumes + records an `allow_once`
       * decision on the kernel; `vg:cancel` records a `deny`. Cards in
       * flight from before this PR landed have it `undefined` and the
       * legacy `mintGrantViaBroker` runs alone — no kernel write. After
       * 1-2 releases the legacy-only branch can be removed (#833 Phase 2
       * is the enforcing flip).
       */
      kernel_request_id?: string
      startedAt: number
    }
  // Issue #228: waiting for confirmation before revoking a grant.
  | { kind: 'revoke_confirm'; grantId: string; agent: string; keys: string[]; startedAt: number }
  // Issue #969 P1a: user tapped "Rename" on a vault_request_save card;
  // the next message becomes the new key name for the staged save.
  | { kind: 'rename-vault-save'; stageId: string; startedAt: number }
  // Issue #1012 Phase 2 follow-up: operator tapped Approve on a
  // vault_request_access card without first unlocking the vault. The
  // next message becomes the passphrase — we cache it, delete the
  // passphrase message, and auto-resume the approval mint flow without
  // making the operator tap Approve a second time. Mirrors the
  // `passphrase-for-deferred` flow from #44.
  //
  // #1051: `items` is a queue so concurrent Approve taps (operator
  // taps card 2 before typing passphrase for card 1) don't strand
  // earlier stages. On passphrase reply we process all queued items
  // sequentially. Each item carries its own stageId + card refs;
  // they're all in the same chat by construction (pendingVaultOps
  // map is keyed by chat_id).
  //
  // #3627: `attempts` counts WRONG passphrase entries so far for this
  // queue. It lives on the pending-op (per passphrase ENTRY), not on the
  // individual staged cards, because one entry drains the whole batch —
  // a per-card counter would show confusing "2 attempts remaining" per
  // card for what the operator experienced as a single typo.
  | {
      kind: 'passphrase-for-access-approve'
      items: Array<{
        stageId: string
        cardChatId: string
        cardMessageId: number
        senderId: string
        /** Forum topic the card lives in, so a retry prompt lands beside it. */
        threadId?: number
      }>
      /** Wrong-passphrase entries so far (0 on the first prompt). */
      attempts?: number
      startedAt: number
    }

export interface DeferredSecret {
  chat_id: string
  original_message_id: number
  text: string
  staged_at: number
  /**
   * Slug suggested by the detector at the time we deferred the secret.
   * Captured up-front so the post-unlock auto-write doesn't have to re-run
   * detection (which would have to handle the no-detection-fired case for
   * Channel B context-rule defers — issue #44). Falls back to a generic
   * slug if detection didn't fire.
   */
  suggested_slug: string
  /**
   * Approval-kernel request_id minted alongside the bespoke deferred-secret
   * card (MIGRATION.md §1, Phase 1 dual-dispatch). When set, the
   * `vd:unlock` / `vd:cancel` callback handler ALSO records the user's
   * decision on the kernel side via `approvalConsume` + `approvalRecord`,
   * so the audit log captures the unlock event.
   *
   * `undefined` on cards built before this PR landed (in-flight at deploy
   * time) — the legacy handler runs alone, no kernel record. After ~1-2
   * releases the legacy-only branch can be removed (separate cleanup PR).
   */
  kernel_request_id?: string
}

/**
 * Agent-initiated save staging (issue #969 P1a). When an agent calls the
 * `vault_request_save` MCP tool, we stage the value here, render an
 * approval card to the user, and write to vault only on tap. The value
 * is held in gateway memory ONLY — never echoed back to the agent and
 * never logged.
 */
export interface PendingVaultRequestSave {
  /** Agent that requested the save (process.env.SWITCHROOM_AGENT_NAME). */
  agent: string
  /** Chat to edit when the user taps. */
  chat_id: string
  /** Card message id (filled in after we send the card). */
  card_message_id?: number
  /** Supergroup forum topic the agent was working in when it requested the
   *  save — carried into the save-outcome inbound so the resumed reply lands
   *  back in that topic, not General. */
  threadId?: number
  /** Currently-suggested slug; may be renamed by the user. */
  key: string
  /** Storage shape — 'string' (default) or 'binary'. */
  kind: 'string' | 'binary'
  /** The secret value, held in memory until the user approves/discards. */
  value: string
  /** Optional rationale shown on the card. */
  why?: string
  /** Unix-ms timestamp; entries are reaped after VAULT_REQUEST_SAVE_TTL_MS. */
  staged_at: number
  /** Set on entries RESTORED from disk after a gateway restart. The staged
   *  secret `value` is held in memory only (never persisted — secrets
   *  hygiene), so a restored entry has an empty value and cannot complete the
   *  write. A Save tap on such a card degrades gracefully: it tells the agent
   *  the value was lost to a restart instead of writing an empty secret. */
  restoredWithoutValue?: boolean
}

/**
 * #2045 `request_secret` — agent asks the operator to PROVIDE a secret it does
 * NOT have. No `value` is staged (unlike PendingVaultRequestSave): the value
 * arrives via secure capture (the operator's next message after they tap
 * [Provide securely]). Only request metadata lives here — nothing sensitive.
 */
export interface PendingSecretRequest {
  agent: string
  chat_id: string
  key: string
  reason?: string
  staged_at: number
  card_message_id?: number
  /** Supergroup forum topic the agent was working in — carried into the
   *  provide/decline/fail outcome inbounds so the resumed reply lands back
   *  in that topic, not General. */
  threadId?: number
}

/**
 * The armed capture for a `request_secret` card: after [Provide securely] is
 * tapped, the operator's NEXT message in `chat_id` is the value for `key`.
 * Transient post-tap window (never persisted).
 */
export interface ArmedSecretCapture {
  key: string
  agent: string
  stageId: string
  armed_at: number
  threadId?: number
}

/**
 * Issue #1012 — agent-initiated vault ACL request. The agent calls
 * `vault_request_access` when it hits VAULT-BROKER-DENIED (or
 * preemptively, when it knows it'll need a key it doesn't yet have).
 * The card carries [Approve] / [Deny] inline buttons; only the
 * operator can mint the grant (same authorization gate as the
 * existing /vault audit one-tap allow flow). The agent never sees
 * the grant token directly — `mintGrantViaBroker` writes it to the
 * agent's `.vault-token` file, which the agent's CLI reads on the
 * next vault request.
 *
 * Mirrors PendingVaultRequestSave above (#969 P1a). No secret
 * material is staged here — only the request metadata.
 */
export interface PendingVaultRequestAccess {
  /** Agent that initiated the request (process.env.SWITCHROOM_AGENT_NAME). */
  agent: string
  /** Chat the card was rendered into; edited on tap. */
  chat_id: string
  /** Card message id (filled in after we send the card). */
  card_message_id?: number
  /** Supergroup forum topic the agent was working in when it requested (the
   *  card's originating thread). Carried into the grant-outcome inbound so the
   *  resumed reply lands back in that topic, not General. */
  threadId?: number
  /** Vault key the agent wants to read. */
  key: string
  /** 'read' (default) or 'write'. */
  scope: 'read' | 'write'
  /** Optional rationale the agent supplied; rendered on the card. */
  reason?: string
  /** Grant TTL in seconds (max 90 days; null = never, refused). */
  ttl_seconds: number
  /** Unix-ms timestamp; entries are reaped after VAULT_REQUEST_ACCESS_TTL_MS. */
  staged_at: number
}

/**
 * Staged agent-initiated MENTAL MODEL proposal (hindsight Phase 5). The agent
 * calls `mental_model_propose`; the operator taps Approve/Deny on the card.
 * Mirrors PendingVaultRequestAccess — no memory content is staged here, only
 * the proposed DECLARATION (name + source_query + optional knobs). On Approve
 * the model becomes a first-class declared model in memory.mental_models[] via
 * the operator-approved config-edit path; on Deny nothing is written.
 */
export interface PendingMentalModelPropose {
  agent: string
  chat_id: string
  card_message_id?: number
  threadId?: number
  /** Proposed declaration, snake_case (matches memory.mental_models[] schema). */
  spec: {
    name: string
    source_query: string
    refresh_after_consolidation?: boolean
    max_tokens?: number
  }
  reason?: string
  staged_at: number
}

// ─── Deps ────────────────────────────────────────────────────────────────

/** Minimal bot shape the handlers touch (grammy Bot / chat-locked wrapper). */
export interface CallbackBotApi {
  api: {
    editMessageText: (
      chat_id: number | string,
      message_id: number,
      text: unknown,
      other?: Record<string, unknown>,
    ) => Promise<unknown>
    sendRichMessage: (
      chat_id: number | string,
      rich_message: unknown,
      other?: Record<string, unknown>,
    ) => Promise<{ message_id: number }>
  }
}

/**
 * Everything the handlers read from gateway module scope. Stores are the
 * consolidated #3008/#3011 store surfaces — never raw Maps. Mutable config
 * `let`s (`VAULT_APPROVAL_AUTH_MODE`, `ADMIN_ONLY_KEYS`) are injected as
 * getters so late config assignment stays observable.
 */
export interface CallbackQueryHandlersDeps {
  /** The gateway's grammy bot singleton (raw sends on fallback paths). */
  bot: unknown
  /** The chat-lock-wrapped bot (serialized sends; passphrase prompt path). */
  lockedBot: unknown
  /** Read the live access file (allowFrom gate on every mutating family). */
  loadAccess: () => { allowFrom: string[] }
  escapeHtmlForTg: (text: string) => string
  switchroomReply: (
    ctx: Context,
    text: string,
    options?: {
      html?: boolean
      reply_markup?:
        | InlineKeyboard
        | { force_reply: true; input_field_placeholder?: string; selective?: boolean }
      classification?: 'query' | 'mutation' | 'heavy'
    },
  ) => Promise<unknown>
  resolveThreadId: (chat_id: string, explicit?: string | number | null) => number | undefined
  deliverResumeSyntheticOrBuffer: (agent: string, inbound: InboundMessage) => boolean
  expireMentalModelProposeCard: (stageId: string, v: PendingMentalModelPropose, now: number) => void
  readLiveSwitchroomConfigText: () => string
  mentalModelCorrelationKey: (agentName: string, unifiedDiff: string) => string
  getMyAgentName: () => string
  triggerSelfRestart: (targetAgent: string, reason: string, delayMs?: number) => boolean
  runSwitchroomAuthCommand: (ctx: Context, args: string[], label: string) => Promise<void>
  switchroomExecJson: <T = unknown>(args: string[]) => T | null
  assertSafeAgentName: (name: string) => void
  buildDeferredSecretKeyboard: (deferKey: string) => InlineKeyboard
  recordDeferredSecretKernelDecision: (
    request_id: string | undefined,
    decision: 'allow_once' | 'deny',
    granted_by_user_id: number,
    approverSet: string[],
  ) => Promise<void>
  mintGrantWizardKernelRequest: (
    agentSlug: string,
    approverSet: string[],
    selectedKeys: string[],
    ttlSeconds: number | null,
  ) => Promise<string | null>
  recordGrantWizardKernelDecision: (
    request_id: string | undefined,
    decision: 'allow_once' | 'deny',
    granted_by_user_id: number,
    approverSet: string[],
  ) => Promise<void>
  /** Flood-wait-aware retry wrapper (gateway's `robustApiCall`). */
  robustApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T>
  /** Fire-and-forget retry wrapper (gateway's `swallowingApiCall`, #1075). */
  swallowingApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T | undefined>
  // Pending-state stores (consolidated surfaces from #3008/#3011).
  pendingVaultRequestAccesses: SweepableCardStore<PendingVaultRequestAccess>
  pendingVaultRequestSaves: SweepableCardStore<PendingVaultRequestSave>
  /** Agent-initiated `request_secret` cards awaiting an operator tap (`vsp:`). */
  pendingSecretRequests: SweepableCardStore<PendingSecretRequest>
  /** Post-[Provide securely] armed captures, keyed by chat_id. */
  armedSecretCaptures: SweepableStore<ArmedSecretCapture>
  pendingMentalModelProposes: SweepableCardStore<PendingMentalModelPropose>
  pendingCardStore: { remove(stageId: string): void }
  pendingMentalModelCorrelations: SweepableStore<{
    agentName: string
    unifiedDiff: string
    createdAt: number
  }>
  pendingVaultOps: SweepableStore<PendingVaultOp>
  vaultPassphraseCache: SweepableStore<{ passphrase: string; expiresAt: number }>
  deferredSecrets: SweepableStore<DeferredSecret>
  pendingReauthFlows: SweepableStore<{ agent: string; startedAt: number }>
  secretStaging: StagingMap
  /** Refresh throttle timestamps for the /auth dashboard ↻ button (the
   *  60s reaper for this map stays in gateway.ts). */
  lastAuthRefreshAtMs: Map<string, number>
  /** Live read of the mutable `VAULT_APPROVAL_AUTH_MODE` module let. */
  getVaultApprovalAuthMode: () => 'passphrase' | 'telegram-id'
  /** Live read of the mutable `ADMIN_ONLY_KEYS` module let. */
  getAdminOnlyKeys: () => string[]
  /** Gateway-side vault-key shape gate (VAULT_KEY_REGEX; UX gate, not a
   *  security boundary). */
  vaultKeyRegex: RegExp
  /** MENTAL_MODEL_PROPOSE_TTL_MS (config-driven approval-card lifetime). */
  mentalModelProposeTtlMs: number
  /**
   * Emit an operator-visible event through the gateway's single funnel
   * (`emitGatewayOperatorEvent`: cooldown + record + broadcast). Used by the
   * #2975 Stage-1 backstop to loudly surface an approved mental-model persist
   * whose rate-window retry also failed.
   */
  emitOperatorEvent: (event: OperatorEvent) => void

  /**
   * Broker seams, injectable for tests (#3627). Production leaves these unset
   * and gets the real `src/vault/broker/client.js` functions.
   *
   * Why DI and not a module mock: CI sweeps this whole test directory with
   * `bun test`, whose `mock.module` is PROCESS-GLOBAL and irreversible — a
   * broker-client mock registered by one file leaks into every file that runs
   * after it. Injection keeps the seam per-suite, matching the house pattern
   * (telegram-plugin/tests/vault-write-posture.test.ts).
   */
  brokerMintGrant?: typeof realMintGrantViaBroker
  brokerList?: typeof realListViaBroker
  brokerListGrants?: typeof realListGrantsViaBroker
  brokerVaultTokenFilePath?: typeof realVaultTokenFilePath

  /**
   * Run the DETERMINISTIC eval-case applier for an approved proposal. Returns
   * `ok` plus the applier's combined output tail (both go on the card footer
   * and into the outcome inbound the agent is woken with).
   *
   * Injectable for the same reason as the broker seams above: production leaves
   * it unset and gets the real `switchroom self-improve apply-eval-case`
   * `execFileSync`, but a unit test cannot shell out to a real CLI, so the
   * approve path's two branches (applied / apply-failed) were untestable while
   * this was a bare static import.
   */
  runEvalCaseApply?: (id: string) => { ok: boolean; out: string }
}

// Freshness throttle for the /auth dashboard ↻ refresh button — one live
// probe fan-out per (chat, message) per window. Moved with the handler.
const AUTH_REFRESH_THROTTLE_MS = 5_000

/**
 * #3627 — how many passphrase entries the operator gets on a
 * `vault_request_access` approval before the staged cards fail terminally.
 * Counted per PASSPHRASE ENTRY (the `passphrase-for-access-approve` pending
 * op), not per card: one entry drains the whole queued batch.
 */
export const MAX_VAULT_PASSPHRASE_ATTEMPTS = 3

/**
 * Result of one `performVaultAccessApproval` run. `passphrase-mismatch` is the
 * ONLY retryable outcome (#3627): the stage is deliberately left alive and the
 * card left in its "waiting for passphrase" state so the caller can re-prompt.
 * Every other broker failure stays terminal and has already surfaced its own
 * card edit / operator reply by the time it returns.
 */
export type VaultAccessApprovalOutcome =
  | { kind: 'ok' }
  | { kind: 'passphrase-mismatch'; msg: string }
  | { kind: 'failed'; msg: string }

/**
 * True when a broker `mint_grant` error is the wrong-passphrase denial
 * (`denied:passphrase-mismatch`, src/vault/broker/server.ts:2166) rather than
 * an ACL / bad-request / internal failure. The broker's wire error drops the
 * audit result code and carries only the human message ("supplied passphrase
 * does not match the broker's unlocked passphrase"), so this matches on the
 * message shape — deliberately narrow: an unrelated DENIED must NOT be
 * retryable, or a genuinely refused mint would re-prompt three times.
 */
export function isPassphraseMismatchBrokerError(msg: string): boolean {
  const m = msg.toLowerCase()
  if (!m.includes('passphrase')) return false
  return m.includes('does not match') || m.includes('mismatch')
}

/**
 * The `ACTION NEEDED: passphrase required` prompt body (#3627).
 *
 * Shared by the first prompt (after an Approve tap on a locked vault) and the
 * wrong-passphrase re-prompt, so the header, the delete-on-read promise, and
 * the 🚨 urgency icon can never drift apart between the two. 🚨 (not ⚠️):
 * this message BLOCKS an approval the operator already tapped, so it outranks
 * the generic-warning glyph the gateway uses everywhere else.
 *
 * A discriminated union, not one bag of optionals: the retry prompt has no
 * agent/key to render (a batch spans several), and the first prompt has no
 * attempt count — modelling them as one optional-heavy shape invites a caller
 * to pass `''` for fields the other branch needs.
 */
export type AccessPassphrasePromptSpec =
  | {
      kind: 'retry'
      /** Attempts left AFTER the failure being reported. */
      retryRemaining: number
      itemCount: number
    }
  | {
      kind: 'first'
      /** `batch` = one entry covers several cards; `admin-only` = admin key. */
      variant: 'batch' | 'admin-only' | 'locked'
      itemCount: number
      agentEscaped: string
      key: string
    }
export function buildAccessPassphrasePromptText(opts: AccessPassphrasePromptSpec): string {
  const header = `**🚨🔐 ACTION NEEDED: passphrase required**`
  if (opts.kind === 'retry') {
    const plural = opts.retryRemaining === 1 ? 'attempt' : 'attempts'
    return (
      `${header}\n\n` +
      `Wrong passphrase. ${opts.retryRemaining} ${plural} remaining.\n` +
      `Type your vault passphrase again as your **next message**.\n` +
      (opts.itemCount > 1
        ? `One entry covers **${opts.itemCount}** pending approvals in this chat.\n`
        : ``) +
      `\n_We delete the passphrase message the moment we read it._`
    )
  }
  if (opts.variant === 'batch') {
    return (
      `${header}\n\n` +
      `Type your vault passphrase as your **next message**.\n` +
      `One entry covers **${opts.itemCount}** pending approvals in this chat, no re-type per card.\n\n` +
      `_We delete the passphrase message the moment we read it._`
    )
  }
  if (opts.variant === 'admin-only') {
    return (
      `${header}\n\n` +
      `\`${opts.key}\` is an **admin-only credential**.\n` +
      `Type your vault passphrase as your **next message** to mint the grant for **${opts.agentEscaped}**.\n\n` +
      `_The passphrase is what proves it's you. An agent can never mint this key on its own. We delete the passphrase message the moment we read it._`
    )
  }
  return (
    `${header}\n\n` +
    `Your vault is locked.\n` +
    `Reply with your passphrase as your **next message** to unlock and mint the grant for **${opts.agentEscaped}**.\n\n` +
    `_Mint authority stays operator-only: the broker only accepts the grant when the passphrase matches. We delete the passphrase message the moment we read it._`
  )
}

/**
 * Build the callback-query handler families over the injected gateway deps.
 * Bodies are verbatim from gateway.ts — behavior-preserving (#2996).
 */
export function createCallbackQueryHandlers(deps: CallbackQueryHandlersDeps) {
  const {
    loadAccess,
    escapeHtmlForTg,
    switchroomReply,
    resolveThreadId,
    deliverResumeSyntheticOrBuffer,
    expireMentalModelProposeCard,
    readLiveSwitchroomConfigText,
    mentalModelCorrelationKey,
    getMyAgentName,
    triggerSelfRestart,
    runSwitchroomAuthCommand,
    switchroomExecJson,
    assertSafeAgentName,
    buildDeferredSecretKeyboard,
    recordDeferredSecretKernelDecision,
    mintGrantWizardKernelRequest,
    recordGrantWizardKernelDecision,
    robustApiCall,
    swallowingApiCall,
    pendingVaultRequestAccesses,
    pendingVaultRequestSaves,
    pendingSecretRequests,
    armedSecretCaptures,
    pendingMentalModelProposes,
    pendingCardStore,
    pendingMentalModelCorrelations,
    pendingVaultOps,
    vaultPassphraseCache,
    deferredSecrets,
    pendingReauthFlows,
    secretStaging,
    lastAuthRefreshAtMs,
    getVaultApprovalAuthMode,
    getAdminOnlyKeys,
    vaultKeyRegex: VAULT_KEY_REGEX,
    mentalModelProposeTtlMs: MENTAL_MODEL_PROPOSE_TTL_MS,
    emitOperatorEvent,
  } = deps
  const bot = deps.bot as CallbackBotApi
  const lockedBot = deps.lockedBot as CallbackBotApi
  // #3627: broker seams — the real client unless a test injects a fake. Bound
  // to the ORIGINAL names so every call site below reads as a direct broker
  // call (and the structural pins that anchor on those names keep holding).
  const mintGrantViaBroker = deps.brokerMintGrant ?? realMintGrantViaBroker
  const listViaBroker = deps.brokerList ?? realListViaBroker
  const listGrantsViaBroker = deps.brokerListGrants ?? realListGrantsViaBroker
  const vaultTokenFilePath = deps.brokerVaultTokenFilePath ?? realVaultTokenFilePath
  // Eval-case applier seam. The default body is verbatim the execFileSync that
  // used to sit inline in handleEvalCaseProposalCallback.
  const runEvalCaseApply =
    deps.runEvalCaseApply ??
    ((id: string): { ok: boolean; out: string } => {
      const cli = process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
      try {
        const out = execFileSync(
          cli,
          ['self-improve', 'apply-eval-case', '--id', id],
          { encoding: 'utf8', timeout: 15000, env: process.env },
        ).trim()
        return { ok: true, out }
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string }
        return {
          ok: false,
          out: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim(),
        }
      }
    })

/**
 * Handle a callback_query from an auth dashboard button. Parses the
 * callback_data, runs the matching action, acknowledges the tap with a
 * toast, and refreshes the dashboard in-place via editMessageText.
 */
/**
 * Handle op:<action>:<encoded-agent> callbacks from operator-events.ts
 * renderOperatorEvent(). Phase 4b — closes the "buttons do nothing" gap.
 *
 * Actions:
 *   dismiss   — clear keyboard + toast
 *   restart   — systemctl --user restart switchroom-<agent>
 *   reauth    — delegate to runSwitchroomAuthCommand (same flow as /auth reauth)
 *   logs      — post last 30 lines of journalctl for the agent
 *   slot management buttons — removed (E5); use /auth use or /auth add instead.
 */
/**
 * Issue #44: handle taps on the deferred-secret card's inline buttons.
 *
 *   `vd:unlock:<deferKey>` — register a `passphrase-for-deferred` pending
 *      vault op and edit the card to ask the user for their passphrase.
 *      The text-handler picks the passphrase up via the existing
 *      pendingVaultOps intercept and calls `executeDeferredSecretSave`
 *      to write the held secret directly. No re-paste required.
 *
 *   `vd:cancel:<deferKey>` — drop the deferred secret and clear the card.
 *      The held bytes are evicted from the in-memory `deferredSecrets`
 *      map (they were never written to disk) so the secret vanishes.
 *
 * Authorization mirrors the operator-event callback: only senders on the
 * configured allowlist get to act on the buttons.
 */
/**
 * Issue #969 P1a — handle the agent-initiated vault-save approval card
 * (`vault_request_save` MCP tool).
 *
 * Callbacks:
 *   vrs:save:<stageId>     — confirm save; write to vault using broker put
 *                            with operator-passphrase attestation (#969 P1a)
 *                            so even new keys go through in one tap.
 *   vrs:discard:<stageId>  — drop the staged secret; never touches disk.
 *   vrs:rename:<stageId>   — set up a pending-op intercept so the user's
 *                            next message is taken as a new key name.
 */
/**
 * Issue #969 P2b — handle a tap on the "🔓 Allow <key>" button posted by
 * `/vault audit <agent>`'s Recent denials section. Mints a 30-day
 * read-grant for the agent + key via the broker.
 *
 * The grant also unioning into the agent's existing token if one is
 * already present is out of scope for this PR — the operator can
 * re-mint with a wider key list if they want consolidation.
 */
async function handleVaultRecentDenialCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  // vrd:<agent>:<key>  — parse, validate both halves against the strict
  // slug regex before doing anything else.
  const parts = data.split(':')
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const [, agentName, keyName] = parts
  if (!/^[a-z][a-z0-9-]{0,62}$/i.test(agentName)) {
    await ctx.answerCallbackQuery({ text: 'Invalid agent name' }).catch(() => {})
    return
  }
  // #1047: same canonical key shape as vault_request_save /
  // vault_request_access — namespaced keys like `fatsecret/client_id`
  // must round-trip through the /vault audit one-tap Allow flow too,
  // not just the agent-initiated approval cards.
  if (!VAULT_KEY_REGEX.test(keyName)) {
    await ctx.answerCallbackQuery({ text: 'Invalid key name' }).catch(() => {})
    return
  }
  await ctx.answerCallbackQuery({ text: '⏳ Minting 30-day read grant…' }).catch(() => {})

  const result = await mintGrantViaBroker({
    agent: agentName,
    keys: [keyName],
    ttl_seconds: 30 * 24 * 60 * 60,
    description: `auto-mint via /vault audit one-tap (#969 P2b)`,
  })

  if (result.kind === 'unreachable') {
    await switchroomReply(ctx, `🔴 Broker unreachable: ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  if (result.kind === 'error') {
    await switchroomReply(ctx, `**mint_grant failed:** ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  // Write the token to the agent's .vault-token file — same flow as the
  // vault grant wizard. The agent restarts in the background pick up
  // the new token via SWITCHROOM_AGENT_NAME on next CLI invocation.
  const { token, id } = result
  // #3627: the path formula lives in the broker client (the module that
  // MINTS the token and later reads it back), so the gateway can't drift from
  // it — the inline `homedir()` copy this replaces silently ignored
  // SWITCHROOM_AGENTS_DIR, writing tokens where the reader wouldn't look.
  const tokenPath = vaultTokenFilePath(agentName)
  try {
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, token, { mode: 0o600 })
  } catch (err) {
    await switchroomReply(
      ctx,
      `**Grant created (${escapeHtmlForTg(id)}) but token write failed:** ` +
      `${escapeHtmlForTg(String(err))}\n` +
      `_Recover with: \`switchroom vault grant ${escapeHtmlForTg(agentName)} ` +
      `--keys ${escapeHtmlForTg(keyName)} --duration 30d\` on the host._`,
      { html: true },
    )
    return
  }
  // #1150 audit: P0 fix — pre-fix the audit-listing message kept its
  // tappable [Always allow ...] buttons after a successful mint, so
  // the operator could re-tap the same denial and re-mint the grant
  // (broker idempotency saves us from a duplicate write but the
  // operator experience was "did anything happen? let me tap again").
  // Strip the entire audit-listing keyboard on first tap + append a
  // status line so the action is visible. Operator re-runs `/vault
  // audit` to act on remaining denials — that's the documented flow.
  // HTML-escape the source text before concatenation. `ctx.callbackQuery.
  // message.text` returns the body with entities STRIPPED (Telegram
  // decodes the original HTML), so any raw `<`, `>`, `&` in agent/key
  // names that survived the original audit-listing's escape pass would
  // now break the HTML re-parse — and finalizeCallback's catch swallows
  // the failure, leaving the keyboard tappable. Caught in PR #1158 review
  // for the operator-event card; the same fix applies here.
  const sourceMsg = ctx.callbackQuery?.message
  const baseText = sourceMsg && 'text' in sourceMsg && sourceMsg.text
    ? escapeHtmlForTg(sourceMsg.text)
    : ''
  const statusLine =
    `\n\n✅ **${escapeHtmlForTg(agentName)}** granted read access to ` +
    `\`${keyName}\` for 30 days ` +
    `(grant \`${id}\`). ` +
    `Re-run /vault audit to act on remaining denials.`
  await finalizeCallback(ctx, {
    apiCall: robustApiCall,
    ackText: '✅ Grant minted',
    newText: baseText ? `${baseText}${statusLine}` : statusLine,
    // No synthInbound — operator-only flow. The granted agent picks
    // up the token via .vault-token file on next CLI invocation; no
    // turn-wake needed.
  })
}

/**
 * Issue #1012 — handle a tap on the vault_request_access approval card.
 *   vra:approve:<stageId> — mint a scoped grant token via the broker,
 *                           write the token to the agent's
 *                           `.vault-token` file, edit card to success.
 *   vra:deny:<stageId>    — drop the staged request, edit card to denied.
 *
 * Same authorization gate as the recent-denials one-tap handler:
 * sender must be on the gateway's allowFrom list.
 */
/**
 * Mint the scoped grant + write the token file for an approved
 * `vault_request_access` request. Factored out so both the direct
 * approve-tap (passphrase already cached) and the
 * `passphrase-for-access-approve` resume flow (passphrase captured
 * via text-message intercept after tap-on-locked) drive identical
 * minting behaviour. #1012 Phase 2 + follow-up.
 */
/**
 * #1115 follow-up: caller-supplied attestation. Either a real operator
 * passphrase (when the operator typed it in chat) or a posture flag
 * that tells the broker to use its own retained passphrase under
 * `vault.broker.approvalAuth: telegram-id`. The passphrase variant
 * never crosses into telegram-id callsites; the posture variant
 * never crosses into passphrase-mode callsites.
 */
type AccessApprovalAttestation =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'posture' }

/**
 * #3627 item 2 — edit a `vault_request_access` card to its RESOLVED state
 * (granted / failed / already-covered), with a guaranteed operator-visible
 * outcome.
 *
 * Every resolution edit used to be `.catch(() => {})`: when the edit itself
 * failed (message deleted, flood wait, topic gone) the card stayed frozen on
 * "waiting for your vault passphrase" and the operator had NO signal that the
 * request had in fact resolved. Now the failure is logged and the same
 * resolved text is re-sent as a fresh message, so the outcome is never
 * silently swallowed.
 *
 * Never throws: both the edit and the fallback send are contained, because
 * every caller runs it after the grant has already been minted/refused and
 * must not have its own control flow broken by a Telegram-side failure.
 */
async function editResolvedCard(
  ctx: Context,
  target: { chat_id: string; threadId?: number },
  messageId: number,
  markdown: string,
  label: string,
): Promise<void> {
  // messageId <= 0 means "no card to edit" (a stage whose card id was never
  // recorded) — go straight to the fresh-message path so the outcome still
  // reaches the operator.
  if (messageId > 0) {
    try {
      // Through robustApiCall (not raw): a flood-wait must be RETRIED, not
      // treated as an edit failure — falling back to a fresh message on a
      // 429 would double-post the resolution.
      await robustApiCall(
        () =>
          ctx.api.editMessageText(target.chat_id, messageId, richMessage(markdown), {
            reply_markup: { inline_keyboard: [] },
          }),
        { chat_id: target.chat_id, verb: `vault_request_access.${label}_edit` },
      )
      return
    } catch (err) {
      process.stderr.write(
        `telegram gateway: vault card resolution edit FAILED (${label}) ` +
        `chat=${target.chat_id} msg=${messageId}: ${String(err)} — sending fallback message\n`,
      )
    }
  }
  try {
    await retryWithThreadFallback<{ message_id: number }>(
      robustApiCall,
      (tid) =>
        lockedBot.api.sendRichMessage(target.chat_id, richMessage(markdown), {
          ...(tid != null && Number.isFinite(tid) ? { message_thread_id: tid } : {}),
        }),
      {
        threadId: target.threadId,
        chat_id: target.chat_id,
        verb: `vault_request_access.${label}_fallback`,
      },
    )
  } catch (err) {
    process.stderr.write(
      `telegram gateway: vault card resolution FALLBACK SEND failed (${label}) ` +
      `chat=${target.chat_id}: ${String(err)}\n`,
    )
  }
}

/**
 * #3627 item 1/3 — send the `ACTION NEEDED: passphrase required` prompt as a
 * fresh message (never an in-place edit: see the long rationale at the first
 * prompt call site). Shared by the initial prompt and the wrong-passphrase
 * re-prompt so both land at the bottom of the chat WITH a notification.
 */
async function sendAccessPassphrasePrompt(
  target: { chat_id: string; threadId?: number },
  spec: AccessPassphrasePromptSpec,
): Promise<void> {
  const promptText = buildAccessPassphrasePromptText(spec)
  // #1075: deleted-topic safe — fall back to the main chat. Wrapped
  // through robustApiCall for flood-wait retries, mirroring the card send.
  await retryWithThreadFallback<{ message_id: number }>(
    robustApiCall,
    (tid) =>
      lockedBot.api.sendRichMessage(target.chat_id, richMessage(promptText), {
        ...(tid != null && Number.isFinite(tid) ? { message_thread_id: tid } : {}),
      }),
    {
      threadId: target.threadId,
      chat_id: target.chat_id,
      verb: 'vault_request_access.passphrase_prompt',
    },
  ).catch((err: unknown) => {
    // #3627: never silent. A prompt that failed to send leaves the operator
    // staring at a card that says "waiting for your vault passphrase" with
    // nothing to reply to — the same silent-failure class item 2 closes on
    // the resolution edits.
    process.stderr.write(
      `telegram gateway: vault passphrase prompt send FAILED chat=${target.chat_id} ` +
      `kind=${spec.kind}: ${String(err)}\n`,
    )
  })
}

/**
 * #3627 item 3 — decide what happens after a passphrase entry that the broker
 * refused as a mismatch for one or more staged cards.
 *
 * Attempts are counted on the PASSPHRASE ENTRY (`attempts` on the pending op),
 * not per card: one entry drains the whole queued batch, so a per-card counter
 * would report "2 attempts remaining" N times for a single typo.
 *
 *  - Under the cap → re-arm the pending op with ONLY the still-unresolved
 *    stages and re-prompt with the remaining count. The stages and their cards
 *    stay alive, so the next entry resumes exactly where this one failed.
 *  - At the cap → today's terminal behaviour: drop each stage, strip its card
 *    and say plainly that the agent must re-issue.
 *
 * The (wrong) passphrase is dropped from the chat cache either way, so a
 * later Approve tap can never silently re-use it.
 */
async function resolveAccessApprovalPassphraseMismatch(
  ctx: Context,
  args: {
    chat_id: string
    failed: Array<{
      stageId: string
      cardChatId: string
      cardMessageId: number
      senderId: string
      threadId?: number
    }>
    priorAttempts: number
    brokerMsg: string
  },
): Promise<void> {
  const { chat_id, failed, priorAttempts, brokerMsg } = args
  if (failed.length === 0) return
  vaultPassphraseCache.delete(chat_id)
  const attempts = priorAttempts + 1
  const remaining = MAX_VAULT_PASSPHRASE_ATTEMPTS - attempts
  const threadId = failed.find((it) => it.threadId != null)?.threadId
  process.stderr.write(
    `telegram gateway: vault_request_access passphrase mismatch chat=${chat_id} ` +
    `stages=${failed.map((f) => f.stageId).join(',')} attempts=${attempts}/${MAX_VAULT_PASSPHRASE_ATTEMPTS}\n`,
  )
  if (remaining > 0) {
    // Union with any queue still open for this chat instead of overwriting it.
    // The batch drain deletes the op before it runs, so this is normally just
    // `failed`; but the cached-passphrase tap path can hit a mismatch while
    // OTHER cards sit queued for the same chat, and clobbering that queue
    // would strand them (staged, card still saying "waiting", no pending op
    // to route the next passphrase entry back to them).
    const open = pendingVaultOps.get(chat_id)
    const carried =
      open?.kind === 'passphrase-for-access-approve'
        ? open.items.filter((it) => !failed.some((f) => f.stageId === it.stageId))
        : []
    const requeued = [...failed, ...carried]
    pendingVaultOps.set(chat_id, {
      kind: 'passphrase-for-access-approve',
      items: requeued,
      attempts,
      // Restart the input TTL: the operator is being asked again NOW, so the
      // clock for their reply starts now too.
      startedAt: Date.now(),
    })
    await sendAccessPassphrasePrompt(
      { chat_id, ...(threadId != null ? { threadId } : {}) },
      { kind: 'retry', retryRemaining: remaining, itemCount: requeued.length },
    )
    return
  }
  // Cap reached — terminal, as before #3627.
  for (const item of failed) {
    pendingVaultRequestAccesses.delete(item.stageId)
    pendingCardStore.remove(item.stageId)
    await editResolvedCard(
      ctx,
      { chat_id: item.cardChatId, ...(item.threadId != null ? { threadId: item.threadId } : {}) },
      item.cardMessageId,
      `❌ **Too many wrong passphrase attempts** (${MAX_VAULT_PASSPHRASE_ATTEMPTS}). ` +
      `This request was cancelled — ask the agent to re-issue it.\n` +
      `_Broker: ${escapeHtmlForTg(brokerMsg)}_`,
      'passphrase_lockout',
    )
  }
}

async function performVaultAccessApproval(
  ctx: Context,
  pending: PendingVaultRequestAccess,
  stageId: string,
  senderId: string,
  attestation: AccessApprovalAttestation,
): Promise<VaultAccessApprovalOutcome> {
  const brokerAuthOpts =
    attestation.kind === 'passphrase'
      ? { passphrase: attestation.passphrase }
      : { attest_via_posture: true as const }

  // Fix B (#1487 follow-up), operator-tap guard. Defense-in-depth for a
  // card staged before the key became standing-ACL-covered (config edit
  // / #1487 deploy / drift): if the agent's standing ACL ALREADY covers
  // this read key, do NOT mint — minting writes a `.vault-token` that
  // shadows the standing ACL and is redundant. Authoritative broker
  // probe AS THIS AGENT (no-token list over the per-agent socket — same
  // rationale as executeVaultRequestAccess; never a gateway-side config
  // read). Read scope only. Fail-open on probe error (mint as before).
  if (pending.scope === 'read') {
    try {
      const visible = await listViaBroker()
      if (visible !== null && visible.includes(pending.key)) {
        pendingVaultRequestAccesses.delete(stageId)
        pendingCardStore.remove(stageId)
        if (pending.card_message_id != null) {
          // #3627 drive-by: this text used to be a raw string CONCATENATED
          // with a `richMessage()` object, which renders as
          // `…already has access[object Object]` with literal `**` markers
          // (the edit ran with parse_mode unset). Whole body now goes
          // through the one rich path, like every sibling resolution edit.
          await editResolvedCard(
            ctx,
            pending,
            pending.card_message_id,
            `ℹ️ **${escapeHtmlForTg(pending.agent)}** already has standing-ACL access to ` +
            `\`${pending.key}\` (schedule.secrets[]). ` +
            `**No grant minted** — a token would shadow the standing ACL. ` +
            `The agent can read it directly.`,
            'standing_acl',
          )
        }
        return { kind: 'ok' }
      }
    } catch {
      // Probe failed: fall through and mint as before (fail-open).
    }
  }

  // #1051: union the new key with the agent's existing active grant
  // before minting. Without this, each fresh Approve OVERWRITES the
  // agent's `.vault-token` file with a single-key grant — the
  // previous approval's grant is still in the broker DB but the
  // agent can no longer authenticate against it (the CLI reads the
  // file's current token, the broker validates it, sees the new key
  // isn't in the OLD grant's key_allow, and denies).
  //
  // Solution: list the agent's existing non-expired grants
  // (passphrase-attested per #1051's broker-side gate widening),
  // find the active read-grant (most recent non-revoked,
  // non-expired), and pass its keys ∪ new_key as `keys` to the
  // mint call. Old grant ages out via TTL — no explicit revoke
  // needed.
  let existingReadKeys: string[] = [];
  let existingWriteKeys: string[] = [];
  if (pending.scope === 'read' || pending.scope === 'write') {
    const list = await listGrantsViaBroker(pending.agent, brokerAuthOpts);
    if (list.kind === 'ok') {
      const now = Math.floor(Date.now() / 1000);
      // Prefer the MOST RECENT non-revoked, non-expired grant. The
      // broker's listGrants returns ALL non-revoked, but we still
      // filter expires_at locally as defence-in-depth + sort by
      // created_at desc for stability.
      const active = list.grants
        .filter((g) => g.expires_at === null || g.expires_at > now)
        // Reviewer-flagged on #1058 (Q4): `created_at` is
        // seconds-granularity, so two grants minted in the same
        // wall-clock second tie. Secondary sort by `id` (vg_<6hex>)
        // makes the ordering stable so item 2's drain reliably picks
        // up item 1's just-minted grant rather than an unrelated
        // same-second grant.
        .sort((a, b) => {
          const dt = (b.created_at ?? 0) - (a.created_at ?? 0);
          if (dt !== 0) return dt;
          return b.id.localeCompare(a.id);
        });
      if (active.length > 0) {
        existingReadKeys = active[0]!.key_allow ?? [];
        existingWriteKeys = active[0]!.write_allow ?? [];
      }
    }
    // If list fails (broker unreachable / error), proceed without
    // union — better to mint a single-key grant than fail closed
    // entirely. The agent loses the prior coverage in that edge
    // case, same as today, but the new key is granted.
  }

  // Compute the unioned key sets. Use Set to dedupe.
  const readKeys = new Set<string>(existingReadKeys);
  const writeKeys = new Set<string>(existingWriteKeys);
  if (pending.scope === 'read') readKeys.add(pending.key);
  if (pending.scope === 'write') writeKeys.add(pending.key);

  const mintArgs: Parameters<typeof mintGrantViaBroker>[0] = {
    agent: pending.agent,
    keys: Array.from(readKeys),
    ttl_seconds: pending.ttl_seconds,
    description:
      `auto-mint via vault_request_access (#1012, scope=${pending.scope}, by op ${senderId}` +
      (existingReadKeys.length + existingWriteKeys.length > 0
        ? `, unioned with prior grant`
        : ``) +
      `)`,
    ...(writeKeys.size > 0 ? { write_keys: Array.from(writeKeys) } : {}),
    ...brokerAuthOpts,
  }
  const result = await mintGrantViaBroker(mintArgs)
  if (result.kind === 'unreachable') {
    await switchroomReply(ctx, `🔴 Broker unreachable: ${escapeHtmlForTg(result.msg)}`, { html: true })
    return { kind: 'failed', msg: result.msg }
  }
  if (result.kind === 'error') {
    // #3627 item 3: a WRONG PASSPHRASE is retryable. Leave the stage and
    // the card exactly as they are ("waiting for your vault passphrase")
    // and hand the decision to the caller, which owns the per-entry
    // attempt counter and re-prompts or locks out. Any other mint refusal
    // (ACL, bad request, broker internals) stays terminal below — a
    // re-prompt would just burn the operator's attempts on an error no
    // passphrase can fix.
    // Gated on the passphrase attestation: under `approvalAuth: telegram-id`
    // the gateway never sends a passphrase, so there is nothing for the
    // operator to retype — a mismatch-shaped message there must stay
    // terminal rather than leaving the stage alive with no re-prompt.
    if (attestation.kind === 'passphrase' && isPassphraseMismatchBrokerError(result.msg)) {
      return { kind: 'passphrase-mismatch', msg: result.msg }
    }
    // Mint refused for a non-passphrase reason. Drop the staged
    // request so a re-attempt starts cleanly. The operator can ask
    // the agent to re-issue, or the broker error message will tell
    // them the next step.
    pendingVaultRequestAccesses.delete(stageId)
    pendingCardStore.remove(stageId)
    if (pending.card_message_id != null) {
      await editResolvedCard(
        ctx,
        pending,
        pending.card_message_id,
        `**mint_grant failed:** ${escapeHtmlForTg(result.msg)}`,
        'mint_failed',
      )
    }
    return { kind: 'failed', msg: result.msg }
  }

  const { token, id } = result
  // #3627: single source of truth for the token path (see the note on the
  // deferred-secret write above) — honours SWITCHROOM_AGENTS_DIR.
  const tokenPath = vaultTokenFilePath(pending.agent)
  try {
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, token, { mode: 0o600 })
  } catch (err) {
    await switchroomReply(
      ctx,
      `**Grant created (${escapeHtmlForTg(id)}) but token write failed:** ` +
      `${escapeHtmlForTg(String(err))}\n` +
      `_Recover with: \`switchroom vault grant ${escapeHtmlForTg(pending.agent)} ` +
      `--keys ${escapeHtmlForTg(pending.key)} --duration ${Math.round(pending.ttl_seconds / 86400)}d\` on the host._`,
      { html: true },
    )
    return { kind: 'failed', msg: String(err) }
  }

  pendingVaultRequestAccesses.delete(stageId)
  pendingCardStore.remove(stageId)
  if (pending.card_message_id != null) {
    const days = Math.round(pending.ttl_seconds / 86400)
    // Normalize + cap the agent-supplied reason to a single line BEFORE
    // escaping, so the value passed into the card builder is already
    // safe to render inside the `_Reason: …_` italic clause.
    const reasonNormalized = normalizeGrantReason(pending.reason)
    const footer =
      getVaultApprovalAuthMode() === 'telegram-id'
        ? `\n_Approver verified by Telegram identity — broker auto-unlocked at startup._`
        : ''
    await editResolvedCard(
      ctx,
      pending,
      pending.card_message_id,
      buildVaultGrantApprovedCardText({
        agentEscaped: escapeHtmlForTg(pending.agent),
        scope: pending.scope,
        key: pending.key,
        days,
        grantId: id,
        reasonEscaped:
          reasonNormalized.length > 0 ? escapeHtmlForTg(reasonNormalized) : undefined,
        footer,
      }),
      'grant_approved',
    )
  }

  // #1052: deliver a synthetic inbound message back to the agent so
  // the task that fired vault_request_access auto-resumes — without
  // this, the agent's turn ended after the tool call ("waiting for
  // approval") and the operator has to send a fresh message to kick
  // it back into action.
  //
  // Uses the existing inject_inbound primitive (cron's pattern from
  // dispatch.ts:180-206). The bridge sees a normal channel event,
  // renders it as `<channel source="vault_grant_approved">`, and the
  // agent starts a new turn with the context that the operator just
  // approved.
  //
  // The synthetic message text is concise + actionable so the agent
  // knows (a) which key was approved, (b) at what scope, (c) what to
  // do next. Meta carries the structured fields for forensics + for
  // future filters that want to suppress these in the chat tail.
  const synthetic = buildVaultGrantApprovedInbound({
    ctx: {
      agent: pending.agent,
      key: pending.key,
      scope: pending.scope,
      chat_id: pending.chat_id,
      ttl_seconds: pending.ttl_seconds,
      ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
    },
    grantId: id,
    stageId,
    operatorId: senderId,
  })
  // Turn-gated via deliverResumeSyntheticOrBuffer: mid-turn → buffer
  // (flushed at turn-end) so the resume never strands in claude's
  // composer (#1556); idle → deliver; bridge-down → buffer (#1150).
  const delivered = deliverResumeSyntheticOrBuffer(pending.agent, synthetic)
  process.stderr.write(
    `telegram gateway: vault_grant_approved injection agent=${pending.agent} ` +
    `key=${pending.key} stage=${stageId} delivered=${delivered}\n`,
  )
  return { kind: 'ok' }
}

/**
 * #2670 — handle an Approve / Dismiss tap on a one-tap skill-improvement
 * proposal card.
 *
 *   Approve → mark the proposal approved + inject a synthetic
 *             `skill_proposal_apply` turn instructing the live agent to
 *             write the stored draft through `skill_*_personal` (so the
 *             secret-scan pipeline runs; agent never self-applies).
 *   Dismiss → mark rejected + write a rejection fingerprint so the weekly
 *             synthesis cron doesn't re-propose it.
 */
async function handleSkillProposalCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const parsed = parseSkillProposalCallback(data)
  if (parsed == null) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const stateDir = process.env.TELEGRAM_STATE_DIR
  const agent = process.env.SWITCHROOM_AGENT_NAME ?? ''
  if (stateDir == null || stateDir.length === 0) {
    await ctx.answerCallbackQuery({ text: 'State dir unset — cannot apply.' }).catch(() => {})
    return
  }
  const proposal = getSkillProposal(stateDir, parsed.id)
  if (proposal == null) {
    await ctx.answerCallbackQuery({ text: 'Proposal expired or already actioned.' }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    }
    return
  }
  if (proposal.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: `Already ${proposal.status}.` }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    }
    return
  }

  const cbChatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
  const cbThreadId = resolveThreadId(cbChatId, ctx.callbackQuery?.message?.message_thread_id)

  if (parsed.action === 'deny') {
    setSkillProposalStatus(stateDir, parsed.id, 'rejected')
    await ctx.answerCallbackQuery({ text: '🚫 Dismissed — won’t be proposed again.' }).catch(() => {})
    if (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message) {
      await ctx
        .editMessageText(
          `${escapeHtmlForTg(ctx.callbackQuery.message.text ?? '')}\n\n🚫 <i>Dismissed.</i>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  // Approve.
  setSkillProposalStatus(stateDir, parsed.id, 'approved')
  const synthetic = buildSkillProposalApplyInbound({
    ctx: {
      agent,
      chat_id: cbChatId,
      ...(cbThreadId != null ? { threadId: cbThreadId } : {}),
    },
    proposalId: proposal.id,
    skillSlug: proposal.skill_slug,
    isNew: proposal.is_new,
    operatorId: senderId,
  })
  const delivered = deliverResumeSyntheticOrBuffer(agent, synthetic)
  await ctx.answerCallbackQuery({ text: '✅ Applying the skill…' }).catch(() => {})
  if (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message) {
    await ctx
      .editMessageText(
        `${escapeHtmlForTg(ctx.callbackQuery.message.text ?? '')}\n\n✅ <i>Approved — applying.</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
  }
  process.stderr.write(
    `telegram gateway: skill_proposal_apply injection agent=${agent} ` +
    `proposal=${proposal.id} slug=${proposal.skill_slug} delivered=${delivered}\n`,
  )
}

/**
 * Eval-case proposal callback (RFC amendment §"corrections as eval cases").
 *
 * On Approve this runs the DETERMINISTIC `apply-eval-case` applier via
 * execFileSync — NOT a model turn — so the case lands byte-exact as approved
 * (precedent: the `switchroom vault set` on-tap execFileSync in this file).
 * The operator's tap IS the authorization; the gateway sets the proposal
 * `approved` BEFORE invoking the applier (whose own status check is
 * defense-in-depth, MJ2, since the store is agent-writable).
 */
async function handleEvalCaseProposalCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const parsed = parseEvalCaseProposalCallback(data)
  if (parsed == null) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const stateDir = process.env.TELEGRAM_STATE_DIR
  const agent = process.env.SWITCHROOM_AGENT_NAME ?? ''
  if (stateDir == null || stateDir.length === 0) {
    await ctx.answerCallbackQuery({ text: 'State dir unset — cannot apply.' }).catch(() => {})
    return
  }
  const proposal = getEvalCaseProposal(stateDir, parsed.id)
  if (proposal == null) {
    await ctx.answerCallbackQuery({ text: 'Proposal expired or already actioned.' }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    }
    return
  }
  if (proposal.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: `Already ${proposal.status}.` }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    }
    return
  }

  // Same idiom as the skill handler above: the card's own chat/topic is where
  // the proposing agent was working, so the outcome inbound resumes it there.
  const cbChatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
  const cbThreadId = resolveThreadId(cbChatId, ctx.callbackQuery?.message?.message_thread_id)
  const inboundCtx = {
    agent,
    chat_id: cbChatId,
    ...(cbThreadId != null ? { threadId: cbThreadId } : {}),
  }

  if (parsed.action === 'deny') {
    setEvalCaseProposalStatus(stateDir, parsed.id, 'rejected')
    // The agent is TOLD it was dismissed. The skill handler stays silent here;
    // silence is the defect — a dismissed proposal left the agent waiting on a
    // wake-up that never came.
    const denied = deliverResumeSyntheticOrBuffer(
      agent,
      buildEvalCaseRejectedInbound({
        ctx: inboundCtx,
        proposalId: proposal.id,
        skillSlug: proposal.skill_slug,
        heldOut: proposal.held_out,
        operatorId: senderId,
      }),
    )
    await ctx.answerCallbackQuery({ text: '🚫 Dismissed.' }).catch(() => {})
    if (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message) {
      await ctx
        .editMessageText(
          `${escapeHtmlForTg(ctx.callbackQuery.message.text ?? '')}\n\n🚫 <i>Dismissed.</i>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    process.stderr.write(
      `telegram gateway: eval_case_rejected agent=${agent} proposal=${proposal.id} ` +
      `slug=${proposal.skill_slug} delivered=${denied}\n`,
    )
    return
  }

  // Approve — authorize, then run the deterministic applier.
  setEvalCaseProposalStatus(stateDir, parsed.id, 'approved')
  await ctx.answerCallbackQuery({ text: '✅ Adding the eval case…' }).catch(() => {})

  const { ok: applyOk, out: applyOut } = runEvalCaseApply(parsed.id)

  const footer = applyOk
    ? '✅ <i>Added as a regression test.</i>'
    : `⚠️ <i>Apply failed:</i> ${escapeHtmlForTg(applyOut.slice(0, 200))}`
  if (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message) {
    await ctx
      .editMessageText(
        `${escapeHtmlForTg(ctx.callbackQuery.message.text ?? '')}\n\n${footer}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
  }
  // Tell the agent the OUTCOME, not just that a tap happened — applied and
  // apply-failed are different instructions (resume vs. don't assume it exists).
  const outcomeInbound = applyOk
    ? buildEvalCaseAppliedInbound({
        ctx: inboundCtx,
        proposalId: proposal.id,
        skillSlug: proposal.skill_slug,
        heldOut: proposal.held_out,
        operatorId: senderId,
      })
    : buildEvalCaseApplyFailedInbound({
        ctx: inboundCtx,
        proposalId: proposal.id,
        skillSlug: proposal.skill_slug,
        heldOut: proposal.held_out,
        operatorId: senderId,
        applyOut,
      })
  const delivered = deliverResumeSyntheticOrBuffer(agent, outcomeInbound)
  process.stderr.write(
    `telegram gateway: eval_case_apply agent=${agent} proposal=${proposal.id} ` +
    `slug=${proposal.skill_slug} ok=${applyOk} delivered=${delivered}\n`,
  )
}

/**
 * hindsight Phase 5 — handle a tap on the mental-model PROPOSAL card.
 *   mmp:approve:<stageId> — declare the model: append it to the agent's
 *                           memory.mental_models[] via the operator-approved
 *                           config-edit path (reused config_propose_edit
 *                           apply+reconcile; reconcile ensures it), then wake
 *                           the agent with an "applied" inbound.
 *   mmp:deny:<stageId>    — drop the proposal; NOTHING is written; wake the
 *                           agent with a "denied" inbound.
 *
 * Authorization: the tapper MUST be on the gateway's allowFrom list — an agent
 * can PROPOSE but can never self-approve (identical gate to the vault flow).
 */
async function handleMentalModelProposeCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    // Self-approve is impossible: only an allow-listed operator can resolve
    // the card. A tap from anyone else (incl. a compromised agent identity) is
    // refused here.
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const parts = data.split(':')
  if (parts.length < 3) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const action = parts[1]
  const stageId = parts.slice(2).join(':')
  const pending = pendingMentalModelProposes.get(stageId)
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Card expired — ask the agent to re-propose.' }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.api
        .editMessageText(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          richMessage('⌛ _This mental-model proposal card expired before you tapped. Ask the agent to re-propose if it still stands._'),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }
  if (action !== 'approve' && action !== 'deny') {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  // Enforce the TTL at TAP time, not just on the next propose's sweep. Without
  // this, a card left untapped past its TTL is still resolvable if no fresh
  // proposal has run the sweep — an operator could approve a stale proposal.
  if (Date.now() - pending.staged_at > MENTAL_MODEL_PROPOSE_TTL_MS) {
    // Expired between post and tap: route through the shared expiry path so the
    // parked agent is WOKEN (timeout synthetic + missed-approvals re-offer) and
    // the durable store entry is cleared — not just a silent map delete.
    expireMentalModelProposeCard(stageId, pending, Date.now())
    await ctx.answerCallbackQuery({ text: 'Card expired — the agent was notified.' }).catch(() => {})
    return
  }
  // Single-shot: remove the pending entry immediately so a double-tap can't
  // resolve twice.
  pendingMentalModelProposes.delete(stageId)
  pendingCardStore.remove(stageId)

  const proposal: MentalModelPendingProposal = {
    agent: pending.agent,
    chat_id: pending.chat_id,
    ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
    spec: pending.spec,
    ...(pending.reason ? { reason: pending.reason } : {}),
  }

  const resolveDeps = {
    readConfigText: () => readLiveSwitchroomConfigText(),
    registerPreApproval: (agent: string, diff: string) => {
      pendingMentalModelCorrelations.set(mentalModelCorrelationKey(agent, diff), {
        agentName: agent,
        unifiedDiff: diff,
        createdAt: Date.now(),
      })
    },
    clearPreApproval: (agent: string, diff: string) => {
      pendingMentalModelCorrelations.delete(mentalModelCorrelationKey(agent, diff))
    },
    dispatchConfigEdit: async (a: { agent: string; diff: string; reason: string }) => {
      const req: HostdRequest = {
        v: 1,
        op: 'config_propose_edit',
        request_id: hostdRequestId('gw-mental-model'),
        args: {
          unified_diff: a.diff,
          reason: a.reason,
          target_path: '/state/config/switchroom.yaml',
        },
      }
      // config_propose_edit blocks on validate→approve→apply→reconcile
      // (5-10 min on a busy host) — allow 12 min. The operator already
      // approved on the proposal card, so hostd's config-approval callback
      // auto-resolves via the pre-registered correlation (no second card).
      const resp = await tryHostdDispatch(a.agent, req, 720_000)
      if (resp === 'not-configured') {
        return { state: 'error' as const, reason: 'hostd config-edit is not configured (host_control disabled or socket absent)' }
      }
      if (resp.result === 'completed') return { state: 'applied' as const }
      if (resp.result === 'denied') {
        // #2975 Stage 1 — a rate-limit denial carries a structured
        // `fix.retry_after` (hostd server.ts ~2270-2280). Surface it as a
        // distinct `rate_limited` state so the resolver schedules ONE retry
        // at the window-open time instead of dropping the approved change.
        const env = resp.error_envelope
        if (env?.code === 'E_RATE_LIMITED' && env.fix?.kind === 'retry_after') {
          const retryAtMs = Date.parse(env.fix.retry_at)
          if (!Number.isNaN(retryAtMs)) {
            return { state: 'rate_limited' as const, reason: resp.error ?? 'config_propose_edit rate limit exceeded', retryAtMs }
          }
        }
        return { state: 'denied' as const, reason: resp.error ?? 'operator/host denied the edit' }
      }
      return { state: 'error' as const, reason: resp.error ?? `hostd returned '${resp.result}'` }
    },
    // Ensure is delegated to reconcile: config_propose_edit's apply triggers a
    // reconcile which runs ensureDeclaredMentalModels (#2874) for the newly
    // declared model — the authoritative, correctly-scoped ensure. We
    // deliberately do NOT add a redundant gateway-side ensure (it would need
    // the agent's bank id + a reachable Hindsight endpoint from the gateway).
    injectInbound: (inbound: InboundMessage) => {
      deliverResumeSyntheticOrBuffer(pending.agent, inbound)
    },
    // #2975 Stage 1 — schedule EXACTLY ONE re-dispatch of a rate-limited but
    // operator-approved persist. A bare setTimeout (bounded, single-shot; the
    // resolver never re-schedules). Stage-1 caveat: this timer lives only in
    // gateway memory, so a gateway restart before it fires LOSES the retry —
    // acceptable for Stage 1 (Stage 2's hostd checkPreApproved bypass removes
    // the collision). Clamp the delay to a signed-32-bit setTimeout ceiling so
    // a far-future window doesn't overflow into an immediate fire.
    scheduleRetry: (delayMs: number, fn: () => void | Promise<void>) => {
      const clamped = Math.min(Math.max(0, delayMs), 2_147_483_647)
      setTimeout(() => {
        void (async () => {
          try {
            await fn()
          } catch (err) {
            process.stderr.write(
              `telegram gateway: mental_model_propose retry threw: ${(err as Error).message}\n`,
            )
          }
        })()
      }, clamped)
    },
    editProposalCardRateWindow: (retryAtMs: number) => {
      if (pending.card_message_id == null) return
      const at = new Date(retryAtMs)
      const hh = String(at.getHours()).padStart(2, '0')
      const mm = String(at.getMinutes()).padStart(2, '0')
      void ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(
            `⏳ _Approved — applying **${escapeHtmlForTg(pending.agent)}**'s mental model \`${pending.spec.name}\` at ${hh}:${mm} (config-edit rate window). It isn't lost; it'll persist automatically when the window opens._`,
          ),
          { reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } },
        )
        .catch(() => {})
    },
    notifyPersistFailed: (reason: string) => {
      emitOperatorEvent({
        kind: 'mental-model-persist-failed',
        agent: pending.agent,
        detail: `Mental model "${pending.spec.name}" — ${reason}`,
        suggestedActions: [],
        firstSeenAt: new Date(),
      })
    },
    log: (m: string) => process.stderr.write(`telegram gateway: ${m}\n`),
  }

  if (action === 'deny') {
    await ctx.answerCallbackQuery({ text: '🚫 Denied' }).catch(() => {})
    await resolveMentalModelProposal('deny', proposal, stageId, senderId, resolveDeps)
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`🚫 _Denied. **${escapeHtmlForTg(pending.agent)}**'s mental model \`${pending.spec.name}\` was not declared._`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  // Approve. Ack immediately + show an interim state, then persist in the
  // background (config_propose_edit can take minutes), then edit the card with
  // the real outcome. The turn resumes via the synthetic inbound injected by
  // resolveMentalModelProposal — not by this card edit.
  await ctx.answerCallbackQuery({ text: '✅ Declaring the model…' }).catch(() => {})
  if (pending.card_message_id != null) {
    await ctx.api
      .editMessageText(
        pending.chat_id,
        pending.card_message_id,
        richMessage(`⏳ _Declaring **${escapeHtmlForTg(pending.agent)}**'s mental model \`${pending.spec.name}\` — appending to config + ensuring…_`),
        { reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
  }
  void (async () => {
    let result
    try {
      result = await resolveMentalModelProposal('approve', proposal, stageId, senderId, resolveDeps)
    } catch (err) {
      process.stderr.write(`telegram gateway: mental_model_propose approve threw: ${(err as Error).message}\n`)
      result = { outcome: 'failed' as const, reason: (err as Error).message }
    }
    // #2975 Stage 1 — a rate-limited persist already edited the card to the
    // "applying at HH:MM (rate window)" state and scheduled its own retry,
    // which will resolve the turn via its own inbound. Leave that card intact;
    // do NOT overwrite it with a success/failure label here.
    if (result.outcome === 'scheduled_retry') {
      return
    }
    if (pending.card_message_id != null) {
      const label =
        result.outcome === 'applied'
          ? `✅ **Declared** ${escapeHtmlForTg(pending.agent)}'s mental model \`${pending.spec.name}\` — appended to \`memory.mental_models[]\` and ensured. Restart the agent to load it if it isn't picked up automatically.`
          : `⚠️ **Did NOT declare** \`${pending.spec.name}\`${'reason' in result && result.reason ? ` — ${escapeHtmlForTg(result.reason)}` : ''}. Nothing was written.`
      await ctx.api
        .editMessageText(pending.chat_id, pending.card_message_id, richMessage(label), {
          reply_markup: { inline_keyboard: [] },
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {})
    }
  })()
}

async function handleVaultRequestAccessCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const parts = data.split(':')
  if (parts.length < 3) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const action = parts[1]
  const stageId = parts.slice(2).join(':')
  const pending = pendingVaultRequestAccesses.get(stageId)
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Card expired — ask the agent to re-request.' }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.api
        .editMessageText(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          richMessage('⌛ _This access-request card expired before you tapped. Ask the agent to re-issue if the need still stands._'),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  if (action === 'deny') {
    pendingVaultRequestAccesses.delete(stageId)
    pendingCardStore.remove(stageId)
    await ctx.answerCallbackQuery({ text: '🚫 Denied' }).catch(() => {})
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`🚫 _Denied. **${escapeHtmlForTg(pending.agent)}** will not get access to \`${pending.key}\`._`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    // #1150 sibling: invariant-3 was missing on the deny path too. The
    // agent originally ended its turn after `vault_request_access` and
    // waits for the gateway to wake it. On approve we already inject
    // `vault_grant_approved` (#1052); now we mirror that for deny so
    // the agent can pick the fallback path (apologise to the user,
    // try a different approach, skip the feature) instead of staying
    // wedged forever. Buffer-on-failure so a mid-reconnect bridge
    // still receives this on its next register.
    const denyInbound = buildVaultGrantDeniedInbound({
      ctx: {
        agent: pending.agent,
        key: pending.key,
        scope: pending.scope,
        chat_id: pending.chat_id,
        ttl_seconds: pending.ttl_seconds,
        ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      },
      stageId,
      operatorId: senderId,
    })
    const denyDelivered = deliverResumeSyntheticOrBuffer(pending.agent, denyInbound)
    process.stderr.write(
      `telegram gateway: vault_grant_denied injection agent=${pending.agent} ` +
      `key=${pending.key} stage=${stageId} delivered=${denyDelivered}\n`,
    )
    return
  }

  if (action === 'approve') {
    // Admin-only credentials (`vault.broker.adminOnlyKeys`) are held to a
    // higher bar: ONLY the admin operator (allowFrom[0]) may approve, and
    // the grant must be minted with the operator passphrase — never
    // posture, even under telegram-id mode (the broker enforces the same
    // rule, so a posture mint would just be rejected). So for an
    // admin-only key we (a) reject taps from any non-admin allowFrom
    // member, and (b) skip the telegram-id posture branch below, falling
    // through to the passphrase-prompt path. The card + buttons stay
    // intact on a non-admin tap so the admin can still approve.
    const isAdminOnly = matchesAdminOnlyKey(pending.key, getAdminOnlyKeys())
    if (isAdminOnly && senderId !== access.allowFrom[0]) {
      await ctx
        .answerCallbackQuery({
          text: '🔒 Admin-only credential — only the owner can approve this.',
        })
        .catch(() => {})
      return
    }

    // Posture: telegram-id (opt-in single-factor). The broker is
    // auto-unlocked and we silently hold the passphrase in memory; skip
    // the passphrase-cache lookup + prompt entirely and mint directly.
    // Allowlist check above already attested the operator's Telegram ID.
    // Admin-only keys are excluded — they take the passphrase path below.
    if (!isAdminOnly && getVaultApprovalAuthMode() === 'telegram-id') {
      const username = ctx.from?.username ?? ctx.from?.first_name ?? `id=${senderId}`
      if (pending.card_message_id != null) {
        await ctx.api
          .editMessageText(
            pending.chat_id,
            pending.card_message_id,
            richMessage(`✅ Approved by @${escapeHtmlForTg(username)} — minting…`),
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => {})
      }
      await ctx.answerCallbackQuery({ text: '⏳ Minting grant…' }).catch(() => {})
      await performVaultAccessApproval(ctx, pending, stageId, senderId, { kind: 'posture' })
      return
    }

    // Tap-to-unlock-and-approve: if the operator hasn't unlocked the
    // vault in this chat yet, capture the passphrase via a pending op
    // intercept and resume the approve flow automatically once it
    // arrives — no second tap, no separate /vault unlock detour.
    // Mirrors the `passphrase-for-deferred` flow from #44.
    const cached = vaultPassphraseCache.get(pending.chat_id)
    if (!cached || cached.expiresAt <= Date.now()) {
      if (pending.card_message_id == null) {
        await ctx
          .answerCallbackQuery({ text: 'Card missing — ask the agent to re-issue.' })
          .catch(() => {})
        return
      }
      // #1051: if there's ALREADY a passphrase-for-access-approve
      // pending op for this chat (operator tapped Approve on a
      // sibling card before typing the passphrase), APPEND this
      // stage to the existing queue instead of overwriting. When
      // the passphrase reply lands the text-handler drains every
      // queued stage — both cards get their grant minted off one
      // passphrase entry. Without this, the second Approve tap
      // orphans the first stage.
      const existing = pendingVaultOps.get(pending.chat_id)
      const newItem = {
        stageId,
        cardChatId: pending.chat_id,
        cardMessageId: pending.card_message_id,
        senderId,
        // #3627: carried so a wrong-passphrase RE-prompt lands in the same
        // forum topic as the card it belongs to.
        ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      }
      const items =
        existing?.kind === 'passphrase-for-access-approve'
          ? [...existing.items.filter((it) => it.stageId !== stageId), newItem]
          : [newItem]
      pendingVaultOps.set(pending.chat_id, {
        kind: 'passphrase-for-access-approve',
        items,
        // #3627: a card joining a queue that already burned attempts inherits
        // the count — the cap belongs to the passphrase ENTRY sequence, and
        // resetting it here would hand out unlimited retries by tapping a
        // second card between attempts.
        ...(existing?.kind === 'passphrase-for-access-approve' && existing.attempts
          ? { attempts: existing.attempts }
          : {}),
        startedAt: existing?.kind === 'passphrase-for-access-approve' ? existing.startedAt : Date.now(),
      })
      // Card text differs slightly when joining an existing batch so
      // the operator isn't confused by two "Reply with passphrase"
      // cards open at once.
      const joiningBatch = items.length > 1
      await ctx.answerCallbackQuery({ text: joiningBatch ? `🔐 Queued — one passphrase covers ${items.length} cards` : '🔐 Send your passphrase…' }).catch(() => {})

      // Strip the buttons on the ORIGINAL card and mark it "waiting" so it
      // can't be re-tapped, but do NOT overload it as the passphrase prompt.
      // An in-place edit fires no notification and stays pinned to the card's
      // old position in the chat, so a busy topic buries it and the operator
      // never sees the passphrase ask — the exact admin-key miss this fixes
      // (v0.16.45: the prompt scrolled off, the passphrase never arrived, the
      // grant was never minted). The prompt goes out as a fresh message below.
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`🔐 _Approved — waiting for your vault passphrase. See the prompt below._`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})

      // The passphrase prompt as a NEW rich message. Three fixes vs. the old
      // in-place edit, all of which the reported bug needed:
      //   1. Real bold/italic — rendered through the sanctioned `richMessage`
      //      GFM path (`sendRichMessage`), never a raw string. The old admin
      //      and joining-batch branches passed raw markdown to editMessageText
      //      (parse_mode=none), so `**`/`_` rendered as literal characters;
      //      the "locked" branch even concatenated a string with a
      //      `richMessage()` object (→ `[object Object]`). All three are gone.
      //   2. It lands at the BOTTOM of the chat, not stapled to an old card
      //      that later messages bury.
      //   3. It fires a notification — `disable_notification` is deliberately
      //      NOT set — so the operator is actually pinged to act.
      //   4. #3627: the header leads with 🚨, not ⚠️ — this prompt BLOCKS an
      //      approval the operator already tapped, so it has to out-shout the
      //      generic warnings the gateway posts everywhere else. Body text
      //      lives in `buildAccessPassphrasePromptText` so the retry prompt
      //      below can never drift from this one.
      // Attention-grabbing header, short lines, key in code formatting.
      await sendAccessPassphrasePrompt(
        {
          chat_id: pending.chat_id,
          ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
        },
        {
          kind: 'first',
          variant: joiningBatch ? 'batch' : isAdminOnly ? 'admin-only' : 'locked',
          itemCount: items.length,
          agentEscaped: escapeHtmlForTg(pending.agent),
          key: pending.key,
        },
      )
      return
    }

    await ctx.answerCallbackQuery({ text: '⏳ Minting grant…' }).catch(() => {})
    const outcome = await performVaultAccessApproval(ctx, pending, stageId, senderId, {
      kind: 'passphrase',
      passphrase: cached.passphrase,
    })
    // #3627: the CACHED passphrase was wrong (stale cache, or it was cached
    // by a flow that never validated it). Same contract as the typed-entry
    // path — the stage survives, the cache is dropped, and the operator gets
    // a re-prompt with the remaining attempts instead of a dead card.
    if (outcome.kind === 'passphrase-mismatch') {
      const openOp = pendingVaultOps.get(pending.chat_id)
      await resolveAccessApprovalPassphraseMismatch(ctx, {
        chat_id: pending.chat_id,
        failed: [
          {
            stageId,
            cardChatId: pending.chat_id,
            cardMessageId: pending.card_message_id ?? 0,
            senderId,
            ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
          },
        ],
        priorAttempts:
          openOp?.kind === 'passphrase-for-access-approve' ? (openOp.attempts ?? 0) : 0,
        brokerMsg: outcome.msg,
      })
    }
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' }).catch(() => {})
}

async function handleVaultRequestSaveCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  const parts = data.split(':')
  if (parts.length < 3) {
    await ctx.answerCallbackQuery({ text: 'Bad request' }).catch(() => {})
    return
  }
  const action = parts[1]
  const stageId = parts.slice(2).join(':')
  const pending = pendingVaultRequestSaves.get(stageId)
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Card expired — ask the agent to re-send.' }).catch(() => {})
    if (ctx.callbackQuery?.message) {
      await ctx.api
        .editMessageText(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          richMessage('⌛ _This vault-save card expired before you tapped. Ask the agent to re-issue if you still want to save._'),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  if (action === 'discard') {
    pendingVaultRequestSaves.delete(stageId)
    pendingCardStore.remove(stageId)
    await ctx.answerCallbackQuery({ text: '🚫 Discarded' }).catch(() => {})
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`🚫 _Discarded. The secret was not written to the vault._`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    // Wake the agent that called vault_request_save — symmetric with
    // the vra: approve/deny path (#1052/#1150/#1156). Without this the
    // tool returned "waiting for operator", the turn ended, and a
    // Discard left the agent silently idle forever.
    const discardInbound = buildVaultSaveDiscardedInbound({
      ctx: {
        agent: pending.agent,
        key: pending.key,
        chat_id: pending.chat_id,
        ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      },
      stageId,
      operatorId: senderId,
    })
    const dDelivered = deliverResumeSyntheticOrBuffer(pending.agent, discardInbound)
    process.stderr.write(
      `telegram gateway: vault_save_discarded injection agent=${pending.agent} ` +
      `key=${pending.key} stage=${stageId} delivered=${dDelivered}\n`,
    )
    return
  }

  if (action === 'rename') {
    // Set up a pending-op intercept so the user's next message is read
    // as the new key name. Same shape as the existing /vault set value
    // capture (gateway.ts uses pendingVaultOps for this).
    pendingVaultOps.set(pending.chat_id, {
      kind: 'rename-vault-save',
      stageId,
      startedAt: Date.now(),
    } as PendingVaultOp)
    // #1150 audit P0: pre-fix the [Save once][Discard][Rename] keyboard
    // stayed live after the rename tap so the operator could re-tap
    // Save with the old key name mid-rename — a Save tap fires the
    // write immediately, racing the rename intercept. Strip the
    // keyboard atomically with a status line that names the rename
    // mode + the proposed new-key prompt. No synthInbound — the
    // agent's `vault_request_save` tool already returned "waiting
    // for operator," and the eventual save success/failure flows
    // its own wake-up below.
    const sourceMsg = ctx.callbackQuery?.message
    const baseText = sourceMsg && 'text' in sourceMsg && sourceMsg.text
      ? escapeHtmlForTg(sourceMsg.text)
      : ''
    const statusLine =
      `\n\n✏️ **Rename mode** — send the new key name as your next message. ` +
      `The current proposed key is \`${pending.key}\`.`
    await finalizeCallback(ctx, {
      apiCall: robustApiCall,
      ackText: 'Send the new key name as your next message.',
      newText: baseText ? `${baseText}${statusLine}` : statusLine,
    })
    return
  }

  if (action === 'save') {
    // Acknowledge the tap immediately so Telegram doesn't show a
    // stale "spinning" state on the button while we run the write.
    await ctx.answerCallbackQuery({ text: '⏳ Saving…' }).catch(() => {})

    // Restored-after-restart guard: the staged secret VALUE is held in gateway
    // memory only and is never persisted (secrets hygiene). If this card was
    // restored from disk after a gateway restart, the value is gone — we CANNOT
    // complete the write. Degrade gracefully: strip the card, wake the agent
    // with a save-failed (value-lost) synthetic so it re-requests, and stop.
    if (pending.restoredWithoutValue || pending.value.length === 0) {
      pendingVaultRequestSaves.delete(stageId)
      pendingCardStore.remove(stageId)
      if (pending.card_message_id != null) {
        await ctx.api
          .editMessageText(
            pending.chat_id,
            pending.card_message_id,
            richMessage(`⚠️ _The staged value for \`${escapeHtmlForTg(pending.key)}\` was lost to a gateway restart — nothing was saved. Ask **${escapeHtmlForTg(pending.agent)}** to re-issue \`vault_request_save\` if you still want to store it._`),
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => {})
      }
      const lostInbound = buildVaultSaveFailedInbound({
        ctx: {
          agent: pending.agent,
          key: pending.key,
          chat_id: pending.chat_id,
          ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
        },
        stageId,
        operatorId: senderId,
        reason: 'staged value lost to a gateway restart — re-request the save',
      })
      const lDelivered = deliverResumeSyntheticOrBuffer(pending.agent, lostInbound)
      process.stderr.write(
        `telegram gateway: vault_request_save value lost to restart — wake agent=${pending.agent} ` +
        `key=${pending.key} stage=${stageId} delivered=${lDelivered}\n`,
      )
      return
    }

    // #1115 follow-up: the save-approve flow now mirrors the access-
    // approve flow under telegram-id mode — broker `put` accepts
    // `attest_via_posture: true` (server.ts:1448-1500), so the
    // gateway can attest the write without a cached passphrase.
    // Closes the UX gap where tapping Save surfaced a misleading
    // "🔒 Vault is locked" message even when the broker had been
    // auto-unlocked at boot.
    //
    // Branch: under telegram-id mode use the posture-attested put;
    // under passphrase mode keep the existing cached-passphrase +
    // shell-to-CLI path (operator must `/vault unlock` once per
    // chat session to populate `vaultPassphraseCache`).
    let write: { ok: boolean; output: string }
    if (getVaultApprovalAuthMode() === 'telegram-id') {
      // Posture-attested broker put. No passphrase needed. The broker
      // verifies (a) telegram-id mode, (b) per-agent peer, (c) broker
      // unlocked — see server.ts:1448-1500.
      write = await defaultVaultWritePosture(pending.key, pending.value)
    } else {
      // Passphrase mode — fetch the cached passphrase for this chat.
      // If the gateway hasn't seen the user unlock the vault yet, we
      // can't attest the write — surface the unlock prompt.
      const cached = vaultPassphraseCache.get(pending.chat_id)
      if (!cached || cached.expiresAt <= Date.now()) {
        if (pending.card_message_id != null) {
          await ctx.api
            .editMessageText(
              pending.chat_id,
              pending.card_message_id,
              richMessage(`🔒 **Passphrase not cached for this chat.** Run \`/vault unlock\` (or any /vault command) to cache it, then tap Save again on the next card.`),
              { reply_markup: { inline_keyboard: [] } },
            )
            .catch(() => {})
        }
        pendingVaultRequestSaves.delete(stageId)
        pendingCardStore.remove(stageId)
        return
      }
      // defaultVaultWrite spawns `switchroom vault set <key>` with the
      // passphrase env set; the CLI forwards the passphrase to the
      // broker put as operator-attestation (#969 P1a), which authorizes
      // new-key creation.
      write = defaultVaultWrite(pending.key, pending.value, cached.passphrase)
    }

    if (!write.ok) {
      // Route through the structured-error renderer from #969 P0b so
      // failures show the actionable host hint instead of a raw blob.
      const parsed = parseVaultCliError(write.output)
      const rendered = renderVaultCliError(parsed, { verb: 'save', key: pending.key })
      const body = rendered.suppressRaw
        ? rendered.html
        : `⚠️ vault write failed:\n\`\`\`\n${write.output}\n\`\`\``
      if (pending.card_message_id != null) {
        await ctx.api
          .editMessageText(
            pending.chat_id,
            pending.card_message_id,
            richMessage(`${body}\n\n_Tap a fresh card after fixing the underlying issue._`),
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => {})
      }
      // Leave the staged secret in memory until TTL — operator might
      // retry by re-invoking the same MCP tool, but the value will be
      // re-staged with a new ID. Drop the current stage.
      pendingVaultRequestSaves.delete(stageId)
      pendingCardStore.remove(stageId)
      // Wake the waiting agent with the failure (symmetric with the
      // success/discard paths) so it doesn't assume vault:<key> exists.
      const failReason =
        (write.output || 'vault write error').split('\n')[0]!.slice(0, 200)
      const failInbound = buildVaultSaveFailedInbound({
        ctx: {
          agent: pending.agent,
          key: pending.key,
          chat_id: pending.chat_id,
          ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
        },
        stageId,
        operatorId: senderId,
        reason: failReason,
      })
      const fDelivered = deliverResumeSyntheticOrBuffer(pending.agent, failInbound)
      process.stderr.write(
        `telegram gateway: vault_save_failed injection agent=${pending.agent} ` +
        `key=${pending.key} stage=${stageId} delivered=${fDelivered}\n`,
      )
      return
    }

    // Success — mask the value in the card for visual confirmation.
    pendingVaultRequestSaves.delete(stageId)
    pendingCardStore.remove(stageId)
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`✅ saved as \`vault:${escapeHtmlForTg(pending.key)}\` (masked: \`${escapeHtmlForTg(maskToken(pending.value))}\`)\n_The agent can now reference this as \`vault:${escapeHtmlForTg(pending.key)}\`._`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    // Wake the agent that called vault_request_save so it resumes the
    // task that was blocked on this credential (symmetric with the
    // vra: approve path; buffered if the bridge is mid-reconnect).
    const okInbound = buildVaultSaveCompletedInbound({
      ctx: {
        agent: pending.agent,
        key: pending.key,
        chat_id: pending.chat_id,
        ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      },
      stageId,
      operatorId: senderId,
    })
    const okDelivered = deliverResumeSyntheticOrBuffer(pending.agent, okInbound)
    process.stderr.write(
      `telegram gateway: vault_save_completed injection agent=${pending.agent} ` +
      `key=${pending.key} stage=${stageId} delivered=${okDelivered}\n`,
    )
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' }).catch(() => {})
}

/**
 * `vsp:` callbacks — agent-requested-secret card (#2045).
 *   vsp:provide:<stageId>  — arm capture: operator's next message is the value
 *   vsp:decline:<stageId>  — drop the request; tell the agent it was declined
 *
 * Extracted verbatim from gateway.ts (#2996 P5) — behavior-preserving. The
 * `pendingSecretRequests` / `armedSecretCaptures` stores are the SAME singleton
 * instances gateway.ts constructs (injected via deps, never re-`new`ed here).
 */
async function handleSecretRequestCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const parts = data.split(':')
  const action = parts[1]
  const stageId = parts[2] ?? ''
  const pending = pendingSecretRequests.get(stageId)
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'This request expired.' }).catch(() => {})
    return
  }

  if (action === 'provide') {
    armedSecretCaptures.set(pending.chat_id, {
      key: pending.key,
      agent: pending.agent,
      stageId,
      armed_at: Date.now(),
      ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
    })
    await ctx.answerCallbackQuery({ text: 'Send the value now — it auto-deletes.' }).catch(() => {})
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(
          pending.chat_id,
          pending.card_message_id,
          richMessage(`🔐 Send the value for \`${pending.key}\` as your next message — a single message, exactly as-is (don't add other text). I’ll delete it instantly and store it in the vault.`),
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  if (action === 'decline') {
    pendingSecretRequests.delete(stageId)
    pendingCardStore.remove(stageId)
    armedSecretCaptures.delete(pending.chat_id)
    await ctx.answerCallbackQuery({ text: 'Declined.' }).catch(() => {})
    if (pending.card_message_id != null) {
      await ctx.api
        .editMessageText(pending.chat_id, pending.card_message_id, richMessage(`🚫 Declined — \`${pending.key}\` not provided.`), {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {})
    }
    // Tell the agent so it stops waiting.
    const ts = Date.now()
    const synthetic: InboundMessage = {
      type: 'inbound',
      chatId: pending.chat_id,
      ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      messageId: ts,
      user: 'vault-broker',
      userId: 0,
      ts,
      text: `🚫 Operator declined your request for \`vault:${pending.key}\`. Proceed without it or ask how they'd like to handle the task.`,
      meta: {
        source: 'secret_declined',
        agent: pending.agent,
        ...(pending.threadId != null ? { message_thread_id: String(pending.threadId) } : {}),
        key: pending.key,
        stage_id: stageId,
      },
    }
    deliverResumeSyntheticOrBuffer(pending.agent, synthetic)
    return
  }

  await ctx.answerCallbackQuery().catch(() => {})
}

async function handleVaultDeferCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  // vd:<action>:<deferKey>. deferKey itself contains a colon (chat:msgId)
  // so we slice rather than split — only the first two segments are
  // structural; the rest is the deferKey verbatim.
  const rest = data.slice('vd:'.length)
  const colon = rest.indexOf(':')
  if (colon < 0) {
    await ctx.answerCallbackQuery({ text: 'Malformed callback.' }).catch(() => {})
    return
  }
  const action = rest.slice(0, colon)
  const deferKey = rest.slice(colon + 1)
  const deferred = deferredSecrets.get(deferKey)
  if (!deferred) {
    await ctx.answerCallbackQuery({ text: 'This card expired. Re-send the secret.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return
  }

  const cardChatId = String(ctx.chat?.id ?? '')
  const cardMessageId = ctx.callbackQuery?.message?.message_id

  if (action === 'cancel') {
    // Kernel-side dual-dispatch (MIGRATION.md §1): record the deny decision
    // BEFORE the legacy handler clears state, so the audit log captures it
    // even if the editMessageText below races with another tap. Best-effort
    // — broker unreachable falls back to legacy-only.
    await recordDeferredSecretKernelDecision(
      deferred.kernel_request_id,
      'deny',
      ctx.from?.id ?? 0,
      access.allowFrom,
    )
    deferredSecrets.delete(deferKey)
    await ctx.answerCallbackQuery({ text: 'Discarded.' }).catch(() => {})
    if (cardMessageId != null) {
      await ctx
        .editMessageText('🗑 Discarded — secret was not saved.', {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {})
    }
    return
  }

  if (action === 'unlock') {
    // Kernel-side dual-dispatch (MIGRATION.md §1): record the allow_once
    // decision when the user taps unlock. The actual passphrase capture +
    // vault write still happens via the legacy path below — the kernel
    // decision is for audit/state, not secret material (per RFC B). We
    // record at tap-time rather than after passphrase entry so a kernel
    // record exists even if the user abandons the passphrase prompt.
    await recordDeferredSecretKernelDecision(
      deferred.kernel_request_id,
      'allow_once',
      ctx.from?.id ?? 0,
      access.allowFrom,
    )
    // #1115 follow-up: telegram-id mode silent-defer-save was withdrawn
    // (same reason as the save-callback above — the in-memory
    // passphrase short-circuit became a bypass surface). The
    // deferred-secret save falls through to the cached-passphrase
    // path under all postures. Routing executeDeferredSecretSave
    // through broker-IPC attest_via_posture is a tracked follow-up.

    // If a passphrase is already cached we can skip straight to the write.
    // Covers the case where the user had unlocked separately between
    // detection and tap.
    const cached = vaultPassphraseCache.get(cardChatId)
    if (cached && cached.expiresAt > Date.now()) {
      await ctx.answerCallbackQuery({ text: 'Saving…' }).catch(() => {})
      await executeDeferredSecretSave(ctx, deferKey, cached.passphrase, cardMessageId)
      return
    }

    if (cardMessageId == null) {
      await ctx.answerCallbackQuery({ text: 'Missing card context.' }).catch(() => {})
      return
    }
    pendingVaultOps.set(cardChatId, {
      kind: 'passphrase-for-deferred',
      deferKey,
      cardChatId,
      cardMessageId,
      startedAt: Date.now(),
    })
    await ctx.answerCallbackQuery({ text: 'Send your passphrase…' }).catch(() => {})
    await ctx
      .editMessageText(
        richMessage('🔐 Send your vault passphrase as your next message — we\'ll save the held secret automatically and delete the passphrase message.'),
        { reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action.' }).catch(() => {})
}

// ─── Grant wizard helpers (Issue #227) ──────────────────────────────────────
// TODO: these helpers duplicate server.ts — extract to a shared module in a
// future refactor once the two entrypoints are proven stable in production.

/** Parse a duration string like "30d", "7h", "365d" into seconds. */
function parseGrantDuration(s: string): number | null {
  const m = /^(\d+)([dh])$/i.exec(s.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  if (n <= 0) return null
  return m[2]!.toLowerCase() === 'd' ? n * 86400 : n * 3600
}

/** Format seconds as a human-readable expiry label. */
function formatGrantExpiry(ttlSeconds: number | null, now: Date = new Date()): string {
  if (ttlSeconds === null) return 'Never'
  const exp = new Date(now.getTime() + ttlSeconds * 1000)
  return exp.toISOString().slice(0, 10)
}

/** Build the Step 1 keyboard: agent selection. */
function buildGrantAgentKeyboard(agents: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  // Max 3 per row to keep buttons readable on mobile
  for (let i = 0; i < agents.length; i++) {
    if (i > 0 && i % 3 === 0) kb.row()
    kb.text(agents[i]!, `vg:agent:${agents[i]!}`)
  }
  kb.row().text('Cancel', 'vg:cancel')
  return kb
}

/** Build the Step 2 keyboard: key multi-select toggle. */
function buildGrantKeysKeyboard(keys: string[], selected: Set<string>): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const k of keys) {
    const check = selected.has(k) ? '☑' : '☐'
    kb.row().text(`${check} ${k}`, `vg:key:${k}`)
  }
  kb.row()
    .text('Continue', 'vg:keys-continue')
    .text('Cancel', 'vg:cancel')
  return kb
}

/** Build the Step 3 keyboard: duration selection. */
function buildGrantDurationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('30 days', 'vg:dur:30d')
    .text('90 days', 'vg:dur:90d')
    .text('1 year', 'vg:dur:1y')
    .row()
    .text('Custom…', 'vg:dur:custom')
    .text('No expiry', 'vg:dur:never')
    .row()
    .text('Back', 'vg:back:duration')
    .text('Cancel', 'vg:cancel')
}

/** Build the Confirm keyboard. */
function buildGrantConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Generate', 'vg:generate')
    .text('Cancel', 'vg:cancel')
}

/** Start the grant wizard (step 1: pick agent). */
async function startGrantWizardStep1(ctx: Context, chatId: string): Promise<void> {
  type AgentListResp = { agents: Array<{ name: string }> }
  const data = switchroomExecJson<AgentListResp>(['agent', 'list'])
  const agents = data?.agents?.map(a => a.name).filter(Boolean) ?? []
  if (agents.length === 0) {
    await switchroomReply(ctx, '⚠️ No agents found in switchroom.yaml.', { html: true })
    return
  }
  const kb = buildGrantAgentKeyboard(agents)
  const sent = await switchroomReply(ctx, '**Grant capability token — Step 1/3**\n\nWhich agent?', { html: true, reply_markup: kb })
  const wizardMsgId = (sent as unknown as { message_id?: number })?.message_id
  pendingVaultOps.set(chatId, {
    kind: 'grant-wizard',
    step: 'agent',
    wizardMsgId,
    startedAt: Date.now(),
  })
}

/** Advance grant wizard to step 2 (pick keys). */
async function grantWizardStep2(ctx: Context, chatId: string, agent: string, wizardMsgId: number | undefined): Promise<void> {
  const keys = await listViaBroker()
  if (!keys) {
    await switchroomReply(ctx, '🔴 Broker is not running (or unreachable). Cannot list vault keys.', { html: true })
    pendingVaultOps.delete(chatId)
    return
  }
  if (keys.length === 0) {
    await switchroomReply(ctx, '⚠️ No vault keys found. Add secrets first with \`/vault set\`.', { html: true })
    pendingVaultOps.delete(chatId)
    return
  }
  const selected = new Set<string>()
  const kb = buildGrantKeysKeyboard(keys, selected)
  const text = `**Grant capability token — Step 2/3**\n\nWhich keys for \`${agent}\`?\n_Tap to toggle; tap Continue when done._`
  if (wizardMsgId != null) {
    // allow-raw-bot-api: vault grant wizard step 2/3; already .catch-swallows, tap-driven UI re-renders on retry
    await ctx.api.editMessageText(chatId, wizardMsgId, richMessage(text), { reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    wizardMsgId = (sent as unknown as { message_id?: number })?.message_id
  }
  pendingVaultOps.set(chatId, {
    kind: 'grant-wizard',
    step: 'keys',
    agent,
    selectedKeys: [],
    availableKeys: keys,
    wizardMsgId,
    startedAt: Date.now(),
  })
}

/** Advance grant wizard to step 3 (pick duration). */
async function grantWizardStep3(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  const kb = buildGrantDurationKeyboard()
  const keyList = state.selectedKeys!.map(k => `• \`${k}\``).join('\n')
  const text = `**Grant capability token — Step 3/3**\n\nKeys for \`${state.agent!}\`:\n${keyList}\n\nHow long should this grant be valid?`
  const msgId = state.wizardMsgId
  if (msgId != null) {
    // allow-raw-bot-api: vault grant wizard step 3/3 (TTL select); already .catch-swallows, tap-driven UI re-renders on retry
    await ctx.api.editMessageText(chatId, msgId, richMessage(text), { reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    state.wizardMsgId = (sent as unknown as { message_id?: number })?.message_id
  }
  pendingVaultOps.set(chatId, { ...state, step: 'duration' })
}

/** Advance grant wizard to confirmation step. */
async function grantWizardConfirm(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  const kb = buildGrantConfirmKeyboard()
  const expiresLabel = formatGrantExpiry(state.ttlSeconds!)
  const keyList = state.selectedKeys!.map(k => `• \`${k}\``).join('\n')
  const text = [
    '**Confirm grant**',
    '',
    `Agent: \`${state.agent!}\``,
    `Keys:\n${keyList}`,
    `Expires: **${escapeHtmlForTg(expiresLabel)}**`,
    '',
    'Tap **Generate** to mint the token.',
  ].join('\n')
  const msgId = state.wizardMsgId
  if (msgId != null) {
    // allow-raw-bot-api: vault grant wizard confirm step; already .catch-swallows, tap-driven UI re-renders on retry
    await ctx.api.editMessageText(chatId, msgId, richMessage(text), { reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    state.wizardMsgId = (sent as unknown as { message_id?: number })?.message_id
  }
  // Mint kernel decision row at the confirm step (MIGRATION.md §2,
  // audit-only Phase 1). We do it here rather than at executeGrantWizard
  // so a kernel row exists even if the user taps Cancel from the confirm
  // card — the deny verdict on cancel is then recorded against the same
  // request_id. If the kernel/broker is unreachable, request_id stays
  // undefined and the wizard runs legacy-only (no behaviour change).
  const kernelRequestId = await mintGrantWizardKernelRequest(
    state.agent!,
    loadAccess().allowFrom,
    state.selectedKeys!,
    state.ttlSeconds ?? null,
  )
  pendingVaultOps.set(chatId, {
    ...state,
    step: 'confirm',
    expiresLabel,
    kernel_request_id: kernelRequestId ?? state.kernel_request_id,
  })
}

/** Execute the grant: call broker mint_grant, write token, reply. */
async function executeGrantWizard(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  pendingVaultOps.delete(chatId)
  // Kernel-side dual-dispatch (MIGRATION.md §2, audit-only Phase 1):
  // record the allow_once decision when the user taps Generate. The
  // legacy `mintGrantViaBroker` below still drives the actual grant
  // mint + token write — the kernel row is informational, not
  // enforcing, in Phase 1 (issue #833 will flip to enforcing).
  // We record at tap-time rather than after mint_grant succeeds so a
  // kernel row exists even if the legacy mint fails (audit captures
  // intent regardless of downstream outcome).
  await recordGrantWizardKernelDecision(
    state.kernel_request_id,
    'allow_once',
    ctx.from?.id ?? 0,
    loadAccess().allowFrom,
  )
  // Defence-in-depth: state.agent flows from callback_data into a path
  // join below. A crafted vg:agent:../../etc payload would produce a
  // path traversal. Validate against the same regex the rest of the
  // file uses; on failure, drop silently — the wizard message has
  // already been finalized.
  try { assertSafeAgentName(state.agent!) } catch { return }
  const result = await mintGrantViaBroker({
    agent: state.agent!,
    keys: state.selectedKeys!,
    ttl_seconds: state.ttlSeconds ?? null,
    description: state.description,
  })
  if (result.kind === 'unreachable') {
    await switchroomReply(ctx, `🔴 Broker unreachable: ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  if (result.kind === 'error') {
    await switchroomReply(ctx, `**mint_grant failed:** ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  // Write token to the agent's .vault-token file
  const { token, id } = result
  // #3627: same single source of truth as the other two token writes.
  const tokenPath = vaultTokenFilePath(state.agent!)
  try {
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, token, { mode: 0o600 })
  } catch (err) {
    await switchroomReply(ctx, `**Grant created but token write failed:** ${escapeHtmlForTg(String(err))}`, { html: true })
    return
  }
  // Collapse wizard message to just the outcome.
  // #1150 audit: P0 fix — pre-fix this `editMessageText` call omitted
  // `reply_markup: { inline_keyboard: [] }` so the wizard's [Generate]
  // / [Cancel] buttons stayed tappable on the success card. Operator
  // could re-tap [Generate] and mint a second redundant grant.
  // Strip the keyboard atomically with the success text via the
  // finalizeCallback helper.
  const msgId = state.wizardMsgId
  const successText = `✅ Grant \`${id}\` created. Written to \`~/.switchroom/agents/${escapeHtmlForTg(state.agent!)}/.vault-token\``
  if (msgId != null) {
    await finalizeCallback(ctx, {
      apiCall: robustApiCall,
      ackText: '✅ Grant created',
      newText: successText,
      // No synthInbound — operator-only flow.
    })
  } else {
    // Fallback when wizard message id was lost (rare; e.g. operator
    // deleted the card). Send a fresh reply with the success text;
    // no keyboard to strip in this branch.
    await switchroomReply(ctx, successText, { html: true })
  }
}

/**
 * Issue #228: handle vault grant management callbacks.
 *
 *   `vg:revoke:<grantId>`  — fetch grant details and show confirmation card.
 *   `vg:confirm:<grantId>` — call broker revoke_grant, reply with success.
 *   `vg:cancel:<grantId>`  — dismiss (clear keyboard, no broker call).
 *
 * Issue #227: also handles /vault grant wizard callbacks.
 *
 *   `vg:cancel`            — cancel wizard at any step.
 *   `vg:agent:<name>`      — step 1: select agent.
 *   `vg:key:<name>`        — step 2: toggle key selection.
 *   `vg:keys-continue`     — step 2 → 3.
 *   `vg:dur:<value>`       — step 3: duration selection.
 *   `vg:back:duration`     — step 3 → back to step 2.
 *   `vg:generate`          — confirm and mint token.
 */
async function handleVaultGrantCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  const revokeMatch = /^vg:revoke:(.+)$/.exec(data)
  if (revokeMatch) {
    const grantId = revokeMatch[1]!
    const result = await listGrantsViaBroker(undefined)
    if (result.kind !== 'ok') {
      await ctx.answerCallbackQuery({ text: 'Broker unreachable.' }).catch(() => {})
      return
    }
    const grant = result.grants.find(g => g.id === grantId)
    if (!grant) {
      await ctx.answerCallbackQuery({ text: 'Grant not found (already revoked?).' }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
      return
    }
    const cardText =
      `🗑 Revoke \`${grantId}\`?\n` +
      `Agent: **${escapeHtmlForTg(grant.agent_slug)}**\n` +
      `Keys: \`${escapeHtmlForTg(grant.key_allow.join(', '))}\``
    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Confirm Revoke', `vg:confirm:${grantId}`)
      .text('❌ Cancel', `vg:cancel:${grantId}`)
    await ctx.answerCallbackQuery().catch(() => {})
    await ctx.editMessageText(richMessage(cardText), {
      reply_markup: confirmKeyboard,
    }).catch(async () => {
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
      const threadId = ctx.callbackQuery?.message?.message_thread_id
      if (chatId) {
        // #1075: thread-id-bearing — swallow on THREAD_NOT_FOUND.
        await swallowingApiCall(
          () =>
            bot.api.sendRichMessage(chatId, richMessage(cardText), {
              reply_markup: confirmKeyboard,
              ...(threadId != null ? { message_thread_id: threadId } : {}),
            }),
          {
            chat_id: chatId,
            verb: 'vault-revoke-confirm-fallback',
            ...(threadId != null ? { threadId } : {}),
          },
        )
      }
    })
    return
  }

  const confirmMatch = /^vg:confirm:(.+)$/.exec(data)
  if (confirmMatch) {
    const grantId = confirmMatch[1]!
    const revokeResult = await revokeGrantViaBroker(grantId)
    if (revokeResult.kind === 'unreachable') {
      await ctx.answerCallbackQuery({ text: 'Broker unreachable.' }).catch(() => {})
      return
    }
    if (revokeResult.kind === 'error') {
      await ctx.answerCallbackQuery({ text: `Revoke failed: ${revokeResult.msg}` }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: '✅ Revoked' }).catch(() => {})
    await ctx.editMessageText(
      richMessage(`✅ Grant \`${grantId}\` revoked. Token file removed.`),
      { reply_markup: { inline_keyboard: [] } },
    ).catch(() => {})
    return
  }

  const cancelMatch = /^vg:cancel:(.+)$/.exec(data)
  if (cancelMatch) {
    await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return
  }

  // #227 grant wizard callbacks (vg:cancel bare, vg:agent:*, vg:key:*, vg:keys-continue,
  // vg:dur:*, vg:back:*, vg:generate). These come after the management callbacks above
  // because management uses vg:cancel:<id> (with trailing id) while the wizard uses
  // bare vg:cancel — the cancelMatch above only matches the id-suffixed form.
  //
  // Note: pre-#265 fix this function did `await ctx.answerCallbackQuery().catch(() => {})`
  // unconditionally up front. That meant the `vg:keys-continue` branch's
  // toast call (`Select at least one key.`) hit a Telegram error
  // ("query is too old or query ID is invalid") because the query was
  // already answered, and the toast never reached the user. Each branch
  // now owns its own ack.
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
  const ackSilently = () => ctx.answerCallbackQuery().catch(() => {})

  // Cancel at any wizard step
  if (data === 'vg:cancel') {
    // Kernel-side dual-dispatch (MIGRATION.md §2, audit-only Phase 1):
    // if the user got as far as the confirm step, a kernel request_id
    // will be on the wizard state — record the deny decision so the
    // audit log captures the abandonment. No-op if the user cancelled
    // before the confirm step (or if the kernel was unreachable).
    const cancelState = pendingVaultOps.get(chatId)
    if (cancelState && cancelState.kind === 'grant-wizard') {
      await recordGrantWizardKernelDecision(
        cancelState.kernel_request_id,
        'deny',
        ctx.from?.id ?? 0,
        loadAccess().allowFrom,
      )
    }
    pendingVaultOps.delete(chatId)
    const msg = ctx.callbackQuery?.message
    if (msg && 'text' in msg) {
      await ctx.editMessageText('❌ Grant wizard cancelled.').catch(() => {})
    }
    await ackSilently()
    return
  }

  const state = pendingVaultOps.get(chatId)
  if (!state || state.kind !== 'grant-wizard') {
    await ctx.editMessageText('⚠️ Wizard session expired. Run /vault grant to start again.').catch(() => {})
    await ackSilently()
    return
  }

  // vg:agent:<name> — step 1 selection
  if (data.startsWith('vg:agent:')) {
    const agent = data.slice('vg:agent:'.length)
    const msgId = (ctx.callbackQuery?.message as { message_id?: number })?.message_id ?? state.wizardMsgId
    await grantWizardStep2(ctx, chatId, agent, msgId)
    await ackSilently()
    return
  }

  // vg:key:<name> — step 2 toggle
  if (data.startsWith('vg:key:')) {
    const key = data.slice('vg:key:'.length)
    if (state.step !== 'keys') { await ackSilently(); return }
    const selectedSet = new Set(state.selectedKeys ?? [])
    if (selectedSet.has(key)) {
      selectedSet.delete(key)
    } else {
      selectedSet.add(key)
    }
    const updatedState = { ...state, selectedKeys: [...selectedSet] }
    pendingVaultOps.set(chatId, updatedState)
    const kb = buildGrantKeysKeyboard(state.availableKeys ?? [], selectedSet)
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {})
    await ackSilently()
    return
  }

  // vg:keys-continue — step 2 → 3
  if (data === 'vg:keys-continue') {
    if (state.step !== 'keys') { await ackSilently(); return }
    if (!state.selectedKeys || state.selectedKeys.length === 0) {
      // Toast-only ack: this is the branch the unconditional pre-ack
      // used to silently swallow. See #265.
      await ctx.answerCallbackQuery({ text: 'Select at least one key.' }).catch(() => {})
      return
    }
    await grantWizardStep3(ctx, chatId, state)
    await ackSilently()
    return
  }

  // vg:dur:<value> — step 3 duration selection
  if (data.startsWith('vg:dur:')) {
    if (state.step !== 'duration') { await ackSilently(); return }
    const dur = data.slice('vg:dur:'.length)
    if (dur === 'custom') {
      // Ask for text reply with n d|h format
      pendingVaultOps.set(chatId, { ...state, awaitingCustomDuration: true })
      const msg = ctx.callbackQuery?.message
      if (msg && 'text' in msg && msg.text) {
        // Escape source text before re-rendering with HTML parse mode.
        // `msg.text` returns entities-stripped plain UTF-8; a raw
        // `<`/`>`/`&` in the wizard's prior-step body (e.g. a future
        // key or label) would crash the HTML re-parse and the bare
        // `.catch(() => {})` would swallow the failure silently — same
        // hazard PR #1158 caught on the operator-event card.
        await ctx.editMessageText(
          richMessage(escapeHtmlForTg(msg.text) + '\n\n_Send a duration like \`30d\` or \`12h\`:_'),
          { reply_markup: buildGrantDurationKeyboard() },
        ).catch(() => {})
      }
      await ackSilently()
      return
    }
    let ttlSeconds: number | null
    if (dur === 'never') {
      ttlSeconds = null
    } else if (dur === '1y') {
      ttlSeconds = 365 * 86400
    } else {
      ttlSeconds = parseGrantDuration(dur)
      if (ttlSeconds === null) { await ackSilently(); return }
    }
    const newState = { ...state, ttlSeconds, awaitingCustomDuration: false }
    await grantWizardConfirm(ctx, chatId, newState)
    await ackSilently()
    return
  }

  // vg:back:duration — go back to step 2 (keys selection) from step 3
  if (data === 'vg:back:duration') {
    if (state.step !== 'duration') { await ackSilently(); return }
    const msgId = state.wizardMsgId
    await grantWizardStep2(ctx, chatId, state.agent!, msgId)
    await ackSilently()
    return
  }

  // vg:generate — final step
  if (data === 'vg:generate') {
    if (state.step !== 'confirm') { await ackSilently(); return }
    await executeGrantWizard(ctx, chatId, state)
    await ackSilently()
    return
  }

  // Unrecognised vg: sub-action
  await ackSilently()
}

/**
 * Issue #44: write a deferred secret to the vault using the now-cached
 * passphrase. Confirms with a masked ref + slug; matches the "captured
 * N secret" UX of the cached-passphrase happy path so the user
 * experience is identical regardless of which path they came in on.
 *
 * Called from two places:
 *   - The `passphrase-for-deferred` branch of the text-handler
 *     pendingVaultOps intercept, after the passphrase is verified.
 *   - The `vd:unlock` callback handler when a passphrase happens to
 *     already be cached (rare but possible).
 *
 * If write fails, the deferred entry is preserved so the user can retry.
 */
async function executeDeferredSecretSave(
  ctx: Context,
  deferKey: string,
  passphrase: string,
  cardMessageId: number | undefined,
): Promise<void> {
  const deferred = deferredSecrets.get(deferKey)
  if (!deferred) {
    if (cardMessageId != null) {
      await ctx.api
        .editMessageText(
          deferKey.split(':')[0]!,
          cardMessageId,
          '⚠️ This card expired before unlock — please re-send the secret.',
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  // De-duplicate suggested_slug against existing vault keys by appending
  // _2 / _3 / … if needed. Same logic as the cached-passphrase happy
  // path uses (gateway.ts ~L2402 stash command).
  const slugBase = deferred.suggested_slug || 'secret'
  const listed = defaultVaultList(passphrase)
  const existing = new Set(listed.ok ? listed.keys : [])
  let slug = slugBase
  let n = 2
  while (existing.has(slug)) slug = `${slugBase}_${n++}`

  const write = defaultVaultWrite(slug, deferred.text, passphrase)
  if (!write.ok) {
    // Classify the failure via the structured stderr markers emitted by
    // `switchroom vault` (issue #969 P0a). If it's a recognised marker,
    // render a clean actionable message instead of dumping the raw
    // "Vault file not found …" / "VAULT-NEEDS-APPROVAL …" blob the CLI
    // emits — that was the misleading-error half of #968.
    //
    // Keep the deferred entry so the user can retry by tapping again
    // once the underlying condition is fixed (broker started, host
    // approval granted, etc.).
    const parsed = parseVaultCliError(write.output)
    const rendered = renderVaultCliError(parsed, { verb: "save", key: slug })
    const body = rendered.suppressRaw
      ? rendered.html
      : `⚠️ vault write failed:\n\`\`\`\n${write.output}\n\`\`\``
    if (cardMessageId != null) {
      await ctx.api
        .editMessageText(
          deferred.chat_id,
          cardMessageId,
          richMessage(`${body}\n\nRe-tap to retry.`),
          {
            reply_markup: buildDeferredSecretKeyboard(deferKey).inline_keyboard.length > 0
              ? buildDeferredSecretKeyboard(deferKey)
              : undefined,
          },
        )
        .catch(() => {})
    }
    return
  }

  deferredSecrets.delete(deferKey)
  const masked = maskToken(deferred.text)
  if (cardMessageId != null) {
    await ctx.api
      .editMessageText(
        deferred.chat_id,
        cardMessageId,
        richMessage(`✅ stored as \`vault:${slug}\` (masked: \`${masked}\`)\n\nReply \`rename NEW_NAME\` to relabel.`),
        { reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
  }
  // Stage for follow-up rename, mirroring the cached-passphrase path.
  secretStaging.set({
    chat_id: deferred.chat_id,
    message_id: deferred.original_message_id,
    detection: {
      rule_id: 'deferred',
      matched_text: deferred.text,
      start: 0,
      end: deferred.text.length,
      confidence: 'high' as const,
      suppressed: false,
      suggested_slug: slug,
    },
    staged_at: Date.now(),
  })
}

async function handleOperatorEventCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  // Parse op:<action>:<encoded-agent>
  const parts = data.slice(3).split(':', 2)  // drop "op:", then split action:agent
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: 'Malformed operator-event callback.' }).catch(() => {})
    return
  }
  const [action, encodedAgent] = parts
  let agent: string
  try {
    agent = decodeURIComponent(encodedAgent)
  } catch {
    await ctx.answerCallbackQuery({ text: 'Bad agent name encoding.' }).catch(() => {})
    return
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,50}$/.test(agent)) {
    await ctx.answerCallbackQuery({ text: 'Invalid agent name.' }).catch(() => {})
    return
  }

  // #1150 audit P1: extract the source card text once so every branch
  // below can append a status line via finalizeCallback. Pre-fix `dismiss`
  // and `restart` stripped the keyboard but kept the original card body
  // verbatim — operator scrolling back couldn't see what they'd decided.
  // `reauth` didn't strip the keyboard at all → re-tappable mid-flow.
  //
  // HTML-escape the extracted text before concatenation. Telegram returns
  // `msg.text` as plain UTF-8 with entities stripped — any raw `<`, `>`,
  // or `&` characters in the original `detail` (operator-events.ts
  // `unknown-4xx`/`unknown-5xx` cards routinely carry API error bodies
  // with `<`/`>` in them) would be re-parsed as HTML tags when the
  // finalizeCallback edit fires with `parseMode: 'HTML'`. Telegram
  // rejects the edit, finalizeCallback's catch swallows it, the
  // keyboard never strips, and the operator re-taps → exact bug this
  // PR is meant to fix re-introduced. Escape once here so every branch
  // gets a safe-to-reparse value. We lose the original bold/italic
  // styling on the source body — acceptable, that styling was already
  // gone the moment `msg.text` was read instead of `msg.entities`.
  // (PR #1158 round 2 — review item F.)
  const sourceMsgText = (() => {
    const msg = ctx.callbackQuery?.message
    if (!msg || !('text' in msg) || !msg.text) return ''
    return escapeHtmlForTg(msg.text)
  })()

  switch (action) {
    case 'dismiss': {
      // #1150 audit P1: was strip-only. Now appends a status line so
      // scrollback shows the dismissal.
      const status = `\n\n✗ _Dismissed by operator._`
      await finalizeCallback(ctx, {
        apiCall: robustApiCall,
        ackText: 'Dismissed',
        newText: sourceMsgText ? `${sourceMsgText}${status}` : status,
        // No synthInbound — dismiss is operator-only, no model in loop.
      })
      return
    }
    case 'restart': {
      const ok = triggerSelfRestart(agent, 'inline-button-restart')
      if (ok) {
        // #1150 audit P1: was reply + editMessageReplyMarkup (two
        // separate edits). Atomic via finalizeCallback now — the
        // status line is the announcement, no separate reply needed.
        const status = `\n\n🔄 _**${escapeHtmlForTg(agent)}** restart requested by operator._`
        await finalizeCallback(ctx, {
          apiCall: robustApiCall,
          ackText: `Restarting ${agent}…`,
          newText: sourceMsgText ? `${sourceMsgText}${status}` : status,
        })
      } else {
        // Failure-path: leave the keyboard tappable so the operator
        // can retry once they've followed the manual instructions
        // below. ack toast still fires.
        await ctx.answerCallbackQuery({ text: `Restart failed for ${agent}` }).catch(() => {})
        const isDocker = process.env.SWITCHROOM_RUNTIME === 'docker'
        const detail = isDocker
          ? `cross-agent restart is not supported under docker. ` +
            `Restart from the host: \`docker compose -p switchroom restart agent-${agent}\`.`
          : 'restart trigger failed'
        await ctx.replyWithRichMessage(richMessage(`**Restart failed for ${agent}:** ${detail}`))
      }
      return
    }
    case 'reauth': {
      // #1150 audit P1: pre-fix the operator-event card's [Reauth] button
      // stayed tappable after the reauth flow started → operator could
      // re-tap and spawn a second concurrent flow that fights the first
      // for the login URL state. Strip the keyboard and append a status
      // line; the new reauth-flow's own messages appear below the
      // collapsed card.
      const status = `\n\n🔐 _Reauth started for **${escapeHtmlForTg(agent)}** — follow the login URL below._`
      await finalizeCallback(ctx, {
        apiCall: robustApiCall,
        ackText: `Starting reauth for ${agent}…`,
        newText: sourceMsgText ? `${sourceMsgText}${status}` : status,
        synthInbound: async () => {
          await runSwitchroomAuthCommand(ctx, ['auth', 'reauth', agent], `auth reauth ${agent}`)
          // PR3 supergroup-mode: key by (chat, thread) so an OAuth code
          // pasted into a different topic isn't mistakenly intercepted
          // as this flow's reauth code.
          const reauthThreadId = ctx.callbackQuery?.message?.message_thread_id
          pendingReauthFlows.set(
            chatKey(String(ctx.chat!.id), reauthThreadId ?? null) as string,
            { agent, startedAt: Date.now() },
          )
        },
      })
      return
    }
    case 'logs': {
      await ctx.answerCallbackQuery({ text: 'Fetching logs…' }).catch(() => {})
      // Pick the right log source for the runtime. Under docker, the
      // gateway is INSIDE the agent container — calling `docker logs`
      // requires the host's docker socket which is deliberately not
      // mounted into agent containers. Under systemd, journalctl
      // works as before. v0.7.2 fixed `case 'restart'` but left this
      // path systemd-only.
      const isDocker = process.env.SWITCHROOM_RUNTIME === 'docker'
      if (isDocker) {
        await ctx.replyWithRichMessage(richMessage(
          `_Inline log fetch is not available under docker mode (no docker.sock in agent containers). ` +
            `Run from the host: \`docker logs --since 30m --tail 30 switchroom-${agent}\`_`,
        ))
        return
      }
      try {
        const out = execFileSync(
          'journalctl',
          ['--user', '-u', `switchroom-${agent}`, '-n', '30', '--no-pager', '--output=short-monotonic'],
          { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
        ) as string
        const trimmed = out.trim().slice(-3500)
        await ctx.replyWithRichMessage(richMessage(
          trimmed
            ? `\`\`\`\n${trimmed.replace(/```/g, '`​``')}\n\`\`\``
            : `_No logs for ${agent}._`,
        ))
      } catch (err) {
        await ctx.replyWithRichMessage(richMessage(
          `**logs failed:** ${escapeHtmlForTg((err as Error).message)}`,
        ))
      }
      return
    }
    default: {
      await ctx.answerCallbackQuery({ text: `Unknown action: ${action}` }).catch(() => {})
      return
    }
  }
}

// RFC H §7.3: the dashboard callback dispatcher is gone — there are
// no auth: callback buttons in the new chat surface. We keep a no-op
// stub so any stale pinned message that fires an `auth:*` tap is
// silently dismissed instead of crashing the gateway.
async function handleAuthDashboardCallback(ctx: Context): Promise<void> {
  // Strict allowFrom gate, identical to every other mutating handler in
  // this file (handleOperatorEventCallback, the vra:/vrs:/vd:/vg: families).
  // Its absence was a security hole: `auth:use:<label>` drives
  // `client.setActive(label)` — a fleet-wide OAuth account swap — so an
  // ungated handler let any tapper (e.g. a member of an admin forum/
  // supergroup with an empty group allowFrom) swap the active account.
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const data = ctx.callbackQuery?.data ?? ''
  const currentAgent = getMyAgentName()

  // auth:use:<label> — fleet-wide swap via broker.setActive (same path
  // /auth use takes from chat). Admin-gated via the broker's own
  // per-agent admin flag.
  if (data.startsWith('auth:use:')) {
    const label = data.slice('auth:use:'.length)
    if (!label) {
      try { await ctx.answerCallbackQuery({ text: 'Missing account label.', show_alert: false }) } catch { /* */ }
      return
    }
    try {
      const client = await getAuthBrokerClient(currentAgent)
      if (!client) {
        try { await ctx.answerCallbackQuery({ text: 'Broker unreachable.', show_alert: true }) } catch { /* */ }
        return
      }
      const result = await client.setActive(label)
      try {
        await ctx.answerCallbackQuery({
          text: `Switched fleet → ${result.active} (${result.fanned.length} agents)`,
          show_alert: false,
        })
      } catch { /* toast may fail on stale tap */ }
      // Edit the source message to reflect the new active. Leaving
      // the old keyboard intact would tempt a double-tap; we replace
      // the text + drop the keyboard so the user has to /auth again
      // to see fresh state.
      const msg = ctx.callbackQuery?.message
      if (msg) {
        // Wrap in swallowingApiCall per #1075 — stale callback-source
        // messages (deleted topic, expired) shouldn't crash the swap.
        await swallowingApiCall(
          () =>
            bot.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              richMessage(
                `**Active account →** \`${result.active}\`\n` +
                `_Re-mirrored credentials for ${result.fanned.length} agent${result.fanned.length === 1 ? '' : 's'}._\n\n` +
                `_Tap /auth to see updated quota for the new active account._`,
              ),
              {},
            ),
          { chat_id: String(msg.chat.id), verb: 'auth:use:edit' },
        )
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      try {
        await ctx.answerCallbackQuery({
          text: `Switch failed: ${msg.slice(0, 180)}`,
          show_alert: true,
        })
      } catch { /* */ }
    }
    return
  }

  // auth:refresh — re-render the /auth snapshot in-place with a fresh
  // live probe. Replaces the message body; keyboard stays. The `:demo`
  // variant re-renders with email masking intact (a ↻ tap on an
  // `/auth demo` / `/usage demo` card must not unmask mid-recording).
  if (data === 'auth:refresh' || data === 'auth:refresh:demo') {
    const refreshDemo = data === 'auth:refresh:demo'
    // Freshness throttle: each refresh fan-fires N live api.anthropic.com
    // probes (one per account — forceLive bypasses the broker's 45s
    // probe-on-open TTL, because an explicit ↻ tap is the user asking
    // for live-now data). Without this, a user double-tapping the ↻
    // button burns through their account's RPM budget on duplicate
    // work. Cap at one per AUTH_REFRESH_THROTTLE_MS per (chat, message)
    // pair.
    const refreshMsg = ctx.callbackQuery?.message
    if (refreshMsg) {
      const key = `${refreshMsg.chat.id}:${refreshMsg.message_id}`
      const lastAtMs = lastAuthRefreshAtMs.get(key) ?? 0
      const sinceLastMs = Date.now() - lastAtMs
      if (sinceLastMs < AUTH_REFRESH_THROTTLE_MS) {
        const waitS = Math.ceil((AUTH_REFRESH_THROTTLE_MS - sinceLastMs) / 1000)
        try {
          await ctx.answerCallbackQuery({
            text: `Just refreshed — try again in ${waitS}s`,
            show_alert: false,
          })
        } catch { /* */ }
        return
      }
      lastAuthRefreshAtMs.set(key, Date.now())
    }
    try {
      const client = await getAuthBrokerClient(currentAgent)
      if (!client) {
        try { await ctx.answerCallbackQuery({ text: 'Broker unreachable.', show_alert: true }) } catch { /* */ }
        return
      }
      const state = await client.listState()
      // Broker-routed probe (#1336) — see gateway.ts:8910 for diagnosis.
      // forceLive=true: an explicit ↻ tap must bypass the broker's
      // probe-on-open TTL — pre-fix, a tap inside the TTL window served
      // the cached snapshot while stamping "Live · refreshed 0s ago".
      const probeResp = state.accounts.length > 0
        ? await client.probeQuota(state.accounts.map((a) => a.label), undefined, true).catch(() => ({ results: [] }))
        : { results: [] }
      // #2495 Change 2 — even under forceLive a failed upstream probe falls
      // back to the broker cache (served:"cache"); stamp "⚠ cached Nm ago"
      // instead of a false live stamp, same as the /auth and /usage paths.
      const { quotas, staleCachedAtMs } = zipProbeResults(
        state.accounts.map((a) => a.label),
        probeResp.results,
      )
      const tz = process.env.SWITCHROOM_TIMEZONE ?? process.env.TZ ?? 'UTC'
      const { renderAuthSnapshotFormat2, buildSnapshotsFromState, buildSnapshotKeyboard } = await import(
        '../auth-snapshot-format.js'
      )
      const snapshots = buildSnapshotsFromState(state, quotas)
      // Single clock for card body + keyboard so health classification
      // can't disagree between the two (#2495 folded nit A).
      const renderNow = new Date()
      const text = renderAuthSnapshotFormat2(snapshots, {
        tz,
        now: renderNow,
        demo: refreshDemo,
        // Honesty backstop (same as /usage): a TOTAL probe failure (zero
        // result rows, nothing served from cache) renders an explicit
        // "probe failed" marker instead of a false "Live" footer next to
        // no-data rows.
        ...(staleCachedAtMs != null
          ? { staleCachedAtMs }
          : probeResp.results.length > 0
            ? { liveProbedAtMs: renderNow.getTime() }
            : { probeFailed: true }),
      })
      const kbRows = buildSnapshotKeyboard(snapshots, { now: renderNow, demo: refreshDemo })
      const inline_keyboard = kbRows.map((row) =>
        row.map((b) => {
          if (b.callbackData) return { text: b.text, callback_data: b.callbackData }
          if (b.insertText) return { text: b.text, switch_inline_query_current_chat: b.insertText }
          return { text: b.text, callback_data: 'auth:noop' }
        }),
      )
      const msg = ctx.callbackQuery?.message
      if (msg) {
        await swallowingApiCall(
          () =>
            bot.api.editMessageText(msg.chat.id, msg.message_id, richMessage(text), {
              reply_markup: { inline_keyboard },
            }),
          { chat_id: String(msg.chat.id), verb: 'auth:refresh:edit' },
        )
      }
      try { await ctx.answerCallbackQuery({ text: 'Refreshed.', show_alert: false }) } catch { /* */ }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      try {
        await ctx.answerCallbackQuery({
          text: `Refresh failed: ${msg.slice(0, 180)}`,
          show_alert: true,
        })
      } catch { /* */ }
    }
    return
  }

  // Unknown auth:* — likely from a too-old message. Dismiss with a
  // hint pointing at the canonical re-render verb.
  try {
    await ctx.answerCallbackQuery({
      text: 'Unknown auth button. Send /auth for current state.',
      show_alert: false,
    })
  } catch { /* */ }
}

  return {
    handleVaultRecentDenialCallback,
    performVaultAccessApproval,
    resolveAccessApprovalPassphraseMismatch,
    handleSkillProposalCallback,
    handleEvalCaseProposalCallback,
    handleMentalModelProposeCallback,
    handleVaultRequestAccessCallback,
    handleVaultRequestSaveCallback,
    handleSecretRequestCallback,
    handleVaultDeferCallback,
    parseGrantDuration,
    formatGrantExpiry,
    buildGrantAgentKeyboard,
    buildGrantKeysKeyboard,
    buildGrantDurationKeyboard,
    buildGrantConfirmKeyboard,
    startGrantWizardStep1,
    grantWizardStep2,
    grantWizardStep3,
    grantWizardConfirm,
    executeGrantWizard,
    handleVaultGrantCallback,
    executeDeferredSecretSave,
    handleOperatorEventCallback,
    handleAuthDashboardCallback,
  }
}
