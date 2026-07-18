// Card-tool handlers — the agent-facing MCP tool INVOCATION side of the
// approval-card families, extracted verbatim from gateway.ts (#2996 P5-tail).
//
// This module owns the `execute*` handlers that STAGE an approval card in
// response to an agent tool call. The operator-tap RESOLUTION side (the
// `callback_query:data` handlers) already lives in callback-query-handlers.ts
// (#3013 / #3329); this is its sibling — the propose/stage half:
//
//   - executeVaultRequestSave    — agent HAS a value, asks to persist it (vrs:)
//   - executeVaultRequestAccess  — agent needs read/write ACL on a key (vra:)
//   - executeRequestSecret       — agent needs a value it does NOT have (vsp:)
//   - executeMentalModelPropose  — agent proposes a standing mental model (mmp:)
//
// Deliberately NOT moved (they stay in gateway.ts and are INJECTED here as the
// ONE shared singleton — Amendment 1): the pending-state stores
// (pendingVaultRequestSaves / -Accesses / pendingSecretRequests /
// pendingMentalModelProposes / pendingCardStore), the secret WRITE path
// (writeRequestedSecret / captureProvidedSecret — shared with handleInbound),
// the sweepSecretRequests reaper hook, the per-agent propose rate limiter
// (checkMentalModelProposeRate + mentalModelProposeTimes[]),
// readLiveSwitchroomConfigText, and the gateway wrappers (robustApiCall,
// lockedBot, assertAllowedChat). Config constants are injected under their
// exact source names so bodies stay byte-identical.
//
// Style: factory over a deps object, following callback-query-handlers.ts /
// outbound-send-path.ts. Function bodies are byte-identical to the
// pre-extraction gateway.ts text (behavior-preserving #2996). None of these
// handlers reads the `currentTurn` global (Amendment 9 satisfied trivially —
// they take only `args`).

import { randomBytes } from 'crypto'
import { richMessage } from '../rich-send.js'
import { retryWithThreadFallback, type RetryCallOpts } from '../retry-api-call.js'
import {
  renderVaultRequestSaveCard,
  buildVaultRequestSaveKeyboard,
} from './vault-request-save-card.js'
import {
  renderVaultRequestAccessCard,
  buildVaultRequestAccessKeyboard,
} from './vault-request-access-card.js'
import type {
  PendingVaultRequestSave,
  PendingVaultRequestAccess,
} from './callback-query-handlers.js'
import type { SweepableCardStore } from './approval-card-stores.js'
import type { PendingCardStore } from './pending-card-store.js'

// ─── Bot shape the handlers touch (grammy Bot / chat-locked wrapper) ────────

/** Minimal bot surface the card senders touch. */
export interface CardToolBotApi {
  api: {
    sendRichMessage: (
      chat_id: number | string,
      rich_message: unknown,
      other?: Record<string, unknown>,
    ) => Promise<{ message_id: number }>
  }
}

// ─── Deps ────────────────────────────────────────────────────────────────

/**
 * Everything the card-tool handlers read from gateway module scope. Stores are
 * the consolidated #3008/#3011 surfaces (never raw Maps) and are the ONE shared
 * singleton — never re-`new`'d here (Amendment 1). Config constants are injected
 * under their exact source-name so handler bodies stay byte-identical.
 */
export interface CardToolHandlersDeps {
  /** The chat-lock-wrapped bot (serialized sends). */
  lockedBot: unknown
  /** Flood-wait-aware retry wrapper (gateway's `robustApiCall`). */
  robustApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T>
  /** Gateway allowFrom gate — throws if chat_id is not permitted. */
  assertAllowedChat: (chat_id: string | number) => void
  /** Gateway-side vault-key shape gate (UX gate, not a security boundary). */
  VAULT_KEY_REGEX: RegExp
  VAULT_KEY_REGEX_LABEL: string
  // Pending-state stores (consolidated surfaces; the ONE shared instance).
  pendingVaultRequestSaves: SweepableCardStore<PendingVaultRequestSave>
  pendingVaultRequestAccesses: SweepableCardStore<PendingVaultRequestAccess>
  /** Durable card-metadata store (restart survival). */
  pendingCardStore: PendingCardStore
  /**
   * Broker no-token `list` probe AS THIS AGENT (path-as-identity) — the
   * authoritative standing-ACL coverage check in executeVaultRequestAccess
   * (Fix B, #1487 follow-up). Injected (rather than imported) so the
   * fail-open probe path and the ALREADY-covered short-circuit are
   * deterministic under test; gateway wires the real
   * src/vault/broker/client.js listViaBroker.
   */
  listViaBroker: () => Promise<string[] | null>
  /** VAULT_REQUEST_ACCESS_TTL_MS (config-driven approval-card lifetime). */
  VAULT_REQUEST_ACCESS_TTL_MS: number
}

/**
 * Build the card-tool handler family over the injected gateway deps. Bodies are
 * verbatim from gateway.ts — behavior-preserving (#2996 P5-tail).
 */
export function createCardToolHandlers(deps: CardToolHandlersDeps) {
  const lockedBot = deps.lockedBot as CardToolBotApi
  const {
    robustApiCall,
    assertAllowedChat,
    VAULT_KEY_REGEX,
    VAULT_KEY_REGEX_LABEL,
    pendingVaultRequestSaves,
    pendingVaultRequestAccesses,
    pendingCardStore,
    listViaBroker,
    VAULT_REQUEST_ACCESS_TTL_MS,
  } = deps

  async function executeVaultRequestSave(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const chat_id = String(args.chat_id ?? '')
    if (!chat_id) throw new Error('vault_request_save: chat_id is required')
    const key = args.key as string
    if (!key || typeof key !== 'string') throw new Error('vault_request_save: key is required')
    const value = args.value as string
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('vault_request_save: value is required and must be a non-empty string')
    }
    const why = typeof args.why === 'string' ? args.why : undefined
    const kindRaw = typeof args.kind === 'string' ? args.kind : 'string'
    if (kindRaw !== 'string' && kindRaw !== 'binary') {
      throw new Error('vault_request_save: kind must be "string" or "binary"')
    }
    assertAllowedChat(chat_id)

    // Validate slug shape — vault keys must match a tight charset so the
    // host CLI hints render cleanly and reference resolution stays
    // predictable. Includes `/` so the canonical namespaced shape
    // (`fatsecret/client_id`, `mff/agent-private-key`, ...) is
    // accepted — issue #1047. The broker itself has no key regex
    // (just `z.string().min(1)` in protocol.ts); this gateway-side
    // gate is a UX guard, not a security boundary.
    if (!VAULT_KEY_REGEX.test(key)) {
      throw new Error(`vault_request_save: key must match ${VAULT_KEY_REGEX_LABEL}`)
    }

    const agentSlug = process.env.SWITCHROOM_AGENT_NAME || 'agent'

    // Stage the request server-side. The value never leaves gateway memory
    // until the user approves.
    const stageId = randomBytes(4).toString('hex')
    const pending: PendingVaultRequestSave = {
      agent: agentSlug,
      chat_id,
      key,
      kind: kindRaw,
      value,
      why,
      staged_at: Date.now(),
    }
    pendingVaultRequestSaves.set(stageId, pending)
    pendingVaultRequestSaves.sweep(Date.now())

    // Send the approval card. #1075: route through retryWithThreadFallback
    // so a deleted topic still lands the card on the main chat instead of
    // crashing the tool call.
    const text = renderVaultRequestSaveCard(pending, agentSlug)
    const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    // Remember the agent's working topic so the save-outcome inbound resumes in it.
    if (threadId != null) pending.threadId = threadId
    const sent = await retryWithThreadFallback<{ message_id: number }>(
      robustApiCall,
      (tid) =>
        lockedBot.api.sendRichMessage(chat_id, richMessage(text), {
          reply_markup: buildVaultRequestSaveKeyboard(stageId),
          ...(tid != null && Number.isFinite(tid) ? { message_thread_id: tid } : {}),
        }),
      { threadId, chat_id, verb: 'vault_request_save.card' },
    )
    pending.card_message_id = sent.message_id
    // Persist card METADATA (never the staged `value` — secrets hygiene) so a
    // gateway restart doesn't strand the parked agent. A restored Save tap can't
    // complete (value is gone) and degrades to a "value lost to restart" wake-up.
    pendingCardStore.add({
      family: 'vault_request_save',
      stageId,
      agent: pending.agent,
      chatId: pending.chat_id,
      ...(pending.card_message_id != null ? { cardMessageId: pending.card_message_id } : {}),
      ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      key: pending.key,
      kind: pending.kind,
      ...(pending.why != null ? { why: pending.why } : {}),
      stagedAt: pending.staged_at,
    })

    return {
      content: [
        {
          type: 'text',
          text: `vault_request_save: card sent (stage_id=${stageId}, key=${key}). The user must tap a button before the secret is persisted; do not assume success until you see the user's next message confirming the outcome.`,
        },
      ],
    }
  }

  /**
   * `vault_request_access` tool — agent surfaces an approval card asking
   * the operator to grant a vault ACL it doesn't yet have. See #1012.
   * Auth boundary: only operators on the gateway allowFrom list can tap;
   * the agent itself can only REQUEST.
   */
  async function executeVaultRequestAccess(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const chat_id = String(args.chat_id ?? '')
    if (!chat_id) throw new Error('vault_request_access: chat_id is required')
    const key = args.key as string
    if (!key || typeof key !== 'string') throw new Error('vault_request_access: key is required')
    if (!VAULT_KEY_REGEX.test(key)) {
      throw new Error(`vault_request_access: key must match ${VAULT_KEY_REGEX_LABEL}`)
    }
    const scopeRaw = typeof args.scope === 'string' ? args.scope : 'read'
    if (scopeRaw !== 'read' && scopeRaw !== 'write') {
      throw new Error('vault_request_access: scope must be "read" or "write"')
    }
    // Accept `why` as an alias for `reason`: the sibling tool
    // vault_request_save uses `why`, and agents cross-contaminate the two
    // schemas — without the alias the rationale silently drops off the
    // approval card and the operator sees "why: not provided".
    const reason =
      typeof args.reason === 'string' ? args.reason : typeof args.why === 'string' ? args.why : undefined
    // Duration: accept a "30d" / "12h" string from the agent OR default
    // to 30 days. Cap at 90 days — beyond that the operator should use
    // the host CLI and pick the lifetime explicitly. Refuse "never"
    // requests outright; agent-initiated grants must have a sunset.
    let ttl_seconds = 30 * 24 * 60 * 60
    const durRaw = args.duration
    if (typeof durRaw === 'string' && durRaw.length > 0) {
      const m = durRaw.match(/^(\d+)([dh])$/)
      if (!m) {
        throw new Error('vault_request_access: duration must look like "30d" or "12h"')
      }
      const n = Number(m[1])
      const unit = m[2]
      const parsed = unit === 'd' ? n * 86400 : n * 3600
      const NINETY_DAYS = 90 * 86400
      if (parsed <= 0 || parsed > NINETY_DAYS) {
        throw new Error('vault_request_access: duration must be > 0 and <= 90d')
      }
      ttl_seconds = parsed
    }
    assertAllowedChat(chat_id)

    const agentSlug = process.env.SWITCHROOM_AGENT_NAME || 'agent'

    // Fix B (#1487 follow-up): if this agent's STANDING ACL already
    // covers the key, do NOT render a card or mint a grant. Minting
    // writes a `.vault-token` that — pre-#1487 — *shadowed* the standing
    // ACL (the exact gymbro trap) and is simply redundant post-#1487.
    // Determine coverage AUTHORITATIVELY by probing the broker AS THIS
    // AGENT (no-token list over the per-agent socket — path-as-identity;
    // the gateway runs in the agent's container so the broker attributes
    // it to this agent). NOT a gateway-side config read: the gateway can
    // see newer config than the broker has loaded, so a config-derived
    // "covered" could be wrong where the broker still denies. `list`
    // returns only ACL-visible key NAMES — never secret values. Read
    // scope only: schedule.secrets[] confers read, not write.
    if (scopeRaw === 'read') {
      try {
        const visible = await listViaBroker()
        if (visible !== null && visible.includes(key)) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `vault_request_access: '${key}' is ALREADY covered by ${agentSlug}'s ` +
                  `standing ACL (schedule.secrets[]). No approval card or grant is needed — ` +
                  `read it directly: \`switchroom vault get ${key}\`. Do NOT request a grant ` +
                  `for this key (a minted token would shadow the standing ACL). If a read ` +
                  `still returns VAULT-BROKER-DENIED, the broker likely needs a restart to ` +
                  `pick up a recent config change — tell the operator; don't re-request.`,
              },
            ],
          }
        }
      } catch {
        // Probe failed (broker unreachable / transient): fall through to
        // the normal card flow. Fail-open is correct here — a redundant
        // card is harmless; suppressing a needed card is not.
      }
    }

    const stageId = randomBytes(4).toString('hex')
    const pending: PendingVaultRequestAccess = {
      agent: agentSlug,
      chat_id,
      key,
      scope: scopeRaw,
      reason,
      ttl_seconds,
      staged_at: Date.now(),
    }
    pendingVaultRequestAccesses.set(stageId, pending)
    pendingVaultRequestAccesses.sweep(Date.now())

    // renderVaultRequestAccessCard self-hardens its field line breaks (this card
    // is sent direct, bypassing the switchroomReply chokepoint).
    const text = renderVaultRequestAccessCard(pending)
    const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    // Remember the agent's working topic so the grant-outcome inbound resumes in it.
    if (threadId != null) pending.threadId = threadId
    // #1075: deleted-topic safe — fall back to main chat.
    const sent = await retryWithThreadFallback<{ message_id: number }>(
      robustApiCall,
      (tid) =>
        lockedBot.api.sendRichMessage(chat_id, richMessage(text), {
          reply_markup: buildVaultRequestAccessKeyboard(stageId),
          ...(tid != null && Number.isFinite(tid) ? { message_thread_id: tid } : {}),
        }),
      { threadId, chat_id, verb: 'vault_request_access.card' },
    )
    pending.card_message_id = sent.message_id
    // Persist card metadata (no secret material — this flow stages only the ACL
    // request) so a gateway restart doesn't strand the parked agent.
    pendingCardStore.add({
      family: 'vault_request_access',
      stageId,
      agent: pending.agent,
      chatId: pending.chat_id,
      ...(pending.card_message_id != null ? { cardMessageId: pending.card_message_id } : {}),
      ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
      key: pending.key,
      scope: pending.scope,
      ...(pending.reason != null ? { reason: pending.reason } : {}),
      ttlSeconds: pending.ttl_seconds,
      stagedAt: pending.staged_at,
    })

    return {
      content: [
        {
          type: 'text',
          text: `vault_request_access: card sent (stage_id=${stageId}, key=${key}, scope=${scopeRaw}). Wait for the operator to tap Approve or Deny — do not retry the vault read until you see a confirmation message. If the card times out (${Math.round(VAULT_REQUEST_ACCESS_TTL_MS / 60000)} min) you can re-request.`,
        },
      ],
    }
  }

  return { executeVaultRequestSave, executeVaultRequestAccess }
}

export type CardToolHandlers = ReturnType<typeof createCardToolHandlers>
