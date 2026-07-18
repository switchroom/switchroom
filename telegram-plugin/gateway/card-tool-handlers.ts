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
import type { PendingVaultRequestSave } from './callback-query-handlers.js'
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
  /** Durable card-metadata store (restart survival). */
  pendingCardStore: PendingCardStore
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
    pendingCardStore,
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

  return { executeVaultRequestSave }
}

export type CardToolHandlers = ReturnType<typeof createCardToolHandlers>
