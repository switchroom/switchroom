/**
 * operator-events.ts — taxonomy + classifier + renderer for runtime errors
 * bubbled to the operator via Telegram.
 *
 * Design goals:
 *  - Pure module: zero grammy/gateway deps (types are inlined or imported
 *    from grammy's type-only surface).
 *  - classifyClaudeError MUST NOT throw on unfamiliar shapes — always falls
 *    through to unknown-4xx / unknown-5xx rather than swallowing silently.
 *  - Per-agent per-kind cooldown (default 5 min) deduplicates storms.
 *  - renderOperatorEvent owns ALL user-facing HTML for each kind,
 *    including the quota-exhausted strings migrated from auto-fallback.ts.
 */

import { escapeMarkdown } from './format.js'
import { stripRawErrorBytes } from './raw-error-scrub.js'
import { isLitellmProxyAuthMisconfig } from './model-unavailable.js'
import {
  attributeProvider,
  describeProviderCreditRemedy,
  detectProviderCreditExhaustion,
} from './provider-credit.js'

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type OperatorEventKind =
  | 'credentials-expired'
  | 'credentials-invalid'
  | 'proxy-misconfig'
  | 'credit-exhausted'
  /**
   * A THIRD-PARTY model provider (OpenRouter / OpenAI / Perplexity) reports no
   * credit remaining — HTTP 402 `payment_required`, "insufficient credits",
   * OpenAI's `insufficient_quota`, etc. Distinct from `credit-exhausted`,
   * which is the ANTHROPIC balance and whose remedy is `/auth use <slot>`:
   * rotating an Anthropic account slot buys zero OpenRouter tokens, so the two
   * must not share a card. Operator-actionable (top up in the vendor console),
   * never user-actionable — see {@link OPERATOR_ACTIONABLE_KINDS}.
   */
  | 'provider-credit-exhausted'
  /**
   * A paid MCP dependency (Perplexity, Eraser, Brevo, Postiz, Meta/Google Ads,
   * Cloudflare …) is refusing work because its KEY is the problem — out of
   * credit, rejected, or past a hard usage wall. Raised from the tool_result
   * seam, not the LLM-error seam, because these providers never touch LiteLLM.
   *
   * Deliberately NOT raised for an ordinary tool failure (bad query, 404,
   * timeout, transient 429) — see `classifyMcpFailure` in
   * `mcp-credential-failure.ts`. Operator-actionable: only the operator can top
   * up or re-issue a key.
   */
  | 'mcp-dependency-blocked'
  | 'quota-exhausted'
  | 'rate-limited'
  | 'agent-crashed'
  | 'agent-restarted-unexpectedly'
  | 'unknown-4xx'
  | 'unknown-5xx'
  | 'config-warning'
  | 'always-allow-persist-failed'
  | 'mental-model-persist-failed'

export interface OperatorEvent {
  kind: OperatorEventKind
  agent: string
  detail: string
  suggestedActions: string[]
  firstSeenAt: Date
}

// ─── Inline keyboard type (mirrors grammy's InlineKeyboardMarkup) ─────────────

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify an error value from any source (Anthropic SDK throw, JSONL error
 * field, etc.) into an OperatorEventKind.
 *
 * CONTRACT: never throws. Unfamiliar shapes fall through to unknown-4xx or
 * unknown-5xx based on HTTP status, defaulting to unknown-4xx.
 */
export function classifyClaudeError(raw: unknown): OperatorEventKind {
  try {
    return classifyInner(raw)
  } catch {
    return 'unknown-4xx'
  }
}

function classifyInner(raw: unknown): OperatorEventKind {
  if (raw == null) return 'unknown-4xx'

  // Extract common fields defensively — never throw on bad shapes.
  const obj = typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const errorType = extractString(obj, 'error_type') ??
    extractString(obj, 'type') ??
    extractString(getNestedObj(obj, 'error'), 'type') ??
    ''
  const errorCode = extractString(obj, 'code') ??
    extractString(getNestedObj(obj, 'error'), 'code') ??
    ''
  const message = extractString(obj, 'message') ??
    extractString(getNestedObj(obj, 'error'), 'message') ??
    (typeof raw === 'string' ? raw : '') ??
    ''
  const status = extractNumber(obj, 'status') ??
    extractNumber(obj, 'statusCode') ??
    extractNumber(obj, 'status_code') ??
    null

  // Anthropic SDK: error_code field (newer SDK shape)
  const sdkCode = extractString(obj, 'error_code') ?? ''

  // LiteLLM-proxy AUTH misconfig — checked BEFORE the generic
  // authentication_error branch. The proxy's internal fallback chain
  // re-dispatches without the client's OAuth Authorization header onto a
  // keyless deployment, so Anthropic returns a 401 authentication_error
  // ("x-api-key header is required"). That is a HOST-side infra misconfig for
  // the operator to fix — NOT an end-user login wall. Mapping it to
  // credentials-invalid mis-fired a "🔑 re-authenticate" card at non-operator
  // users who cannot re-auth anything (incident 2026-07-16). Route it to the
  // operator-only infra kind instead. Scanned across type/code/message so the
  // marker is caught wherever the proxy stamps it.
  if (isLitellmProxyAuthMisconfig(`${errorType}\n${errorCode}\n${sdkCode}\n${message}`)) {
    return 'proxy-misconfig'
  }

  // Map known Anthropic error types/codes first.
  // Source: https://docs.anthropic.com/en/api/errors
  if (
    errorType === 'authentication_error' ||
    errorCode === 'authentication_error' ||
    sdkCode === 'authentication_error' ||
    message.toLowerCase().includes('authentication_error')
  ) {
    // Distinguish expired vs invalid by message hints.
    const msg = message.toLowerCase()
    if (msg.includes('expired') || msg.includes('refresh')) {
      return 'credentials-expired'
    }
    return 'credentials-invalid'
  }

  if (
    errorType === 'invalid_api_key' ||
    errorCode === 'invalid_api_key' ||
    sdkCode === 'invalid_api_key' ||
    message.toLowerCase().includes('invalid_api_key') ||
    message.toLowerCase().includes('invalid api key')
  ) {
    return 'credentials-invalid'
  }

  // The full scan surface for the provider-credit decision — same
  // type/code/message union isLitellmProxyAuthMisconfig uses, because LiteLLM
  // stamps the upstream vendor's wording in whichever field it has room for.
  const creditScanText = `${errorType}\n${errorCode}\n${sdkCode}\n${message}`

  // ANTHROPIC credit wall. Guarded with `attributeProvider(...) == null` so an
  // OpenRouter/OpenAI/Perplexity error that happens to say "credit balance"
  // does NOT get the Anthropic card, whose remedy (`/auth use <slot>`) is
  // useless against a third-party balance. Unattributed credit-balance wording
  // keeps its historical Anthropic reading — that is where it has always come
  // from, and the alternative (guessing a vendor) sends the operator to the
  // wrong console.
  if (
    (errorType === 'credit_balance_too_low' ||
      errorCode === 'credit_balance_too_low' ||
      sdkCode === 'credit_balance_too_low' ||
      message.toLowerCase().includes('credit_balance_too_low') ||
      message.toLowerCase().includes('credit balance')) &&
    attributeProvider(creditScanText) == null
  ) {
    return 'credit-exhausted'
  }

  // THIRD-PARTY provider credit wall — the OpenRouter 402 leak (#external-credit).
  // Runs BEFORE the rate-limit branch on purpose: OpenAI signals an exhausted
  // balance as HTTP *429* `insufficient_quota`, so a rate-limit-first ordering
  // would classify a billing wall as a transient throttle and tell the operator
  // to wait for a reset that will never come.
  if (detectProviderCreditExhaustion(creditScanText, status) != null) {
    return 'provider-credit-exhausted'
  }

  if (
    errorType === 'rate_limit_error' ||
    errorCode === 'rate_limit_error' ||
    sdkCode === 'rate_limit_error' ||
    message.toLowerCase().includes('rate_limit_error') ||
    message.toLowerCase().includes('rate limit')
  ) {
    return 'rate-limited'
  }

  if (
    errorType === 'overloaded_error' ||
    errorCode === 'overloaded_error' ||
    sdkCode === 'overloaded_error' ||
    message.toLowerCase().includes('overloaded_error') ||
    message.toLowerCase().includes('overloaded')
  ) {
    // Anthropic "overloaded" (HTTP 529) is transient SERVER-side
    // capacity pressure — orthogonal to account quota. It is retryable
    // (`x-should-retry: true`) and Claude Code retries it internally.
    // Classifying it `quota-exhausted` fired a false "Model
    // unavailable — quota exhausted" card AND a self-cancelling fleet
    // auto-fallback on every 529 (the active account always probes
    // healthy — nothing is actually exhausted — so the fallback no-ops
    // with "probed healthy / Stale event?"). It is a rate-limit-family
    // transient; failing over to another account does nothing because
    // every account is equally affected.
    return 'rate-limited'
  }

  // Synthetic kinds (non-Anthropic — set by session-tail or IPC bridge)
  if (errorType === 'agent-crashed' || errorCode === 'agent-crashed') {
    return 'agent-crashed'
  }
  if (
    errorType === 'agent-restarted-unexpectedly' ||
    errorCode === 'agent-restarted-unexpectedly'
  ) {
    return 'agent-restarted-unexpectedly'
  }

  // Fallback: HTTP status-based.
  if (status != null) {
    if (status >= 400 && status < 500) return 'unknown-4xx'
    if (status >= 500 && status < 600) return 'unknown-5xx'
  }

  return 'unknown-4xx'
}

function extractString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function extractNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  return typeof v === 'number' ? v : null
}

function getNestedObj(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key]
  return typeof v === 'object' && v != null ? (v as Record<string, unknown>) : {}
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export interface RenderResult {
  text: string
  keyboard: InlineKeyboardMarkup
}

/**
 * Render an OperatorEvent into Telegram HTML + inline keyboard.
 *
 * For quota-exhausted: this is the canonical source of the user-facing
 * message text, superseding the strings that were previously in
 * auto-fallback.ts. The decision logic (slot switching, mark-exhausted)
 * stays in auto-fallback.ts; only the rendered text lives here.
 *
 * callback_data encoding: agent names are URL-encoded in all callback_data
 * strings (e.g. `op:reauth:<encoded-agent>`). The Phase 4b callback_query
 * handler MUST decodeURIComponent() the third segment when parsing. This is
 * defense-in-depth alongside the slug validation in createAgent — together
 * they ensure neither side can fail independently even if names ever contain
 * `:` or other delimiter characters.
 */
export function renderOperatorEvent(ev: OperatorEvent): RenderResult {
  const agent = escapeMarkdown(ev.agent)
  // #llm-error-surfacing: NEVER let a raw API-error byte-blob (`· b'{…}'`,
  // trailing `{"type":"error"…}` JSON, `API Error:` prefix) reach a user. A
  // clean human detail passes through unchanged; only smuggled raw bytes are
  // stripped. This is the belt-and-braces scrub for every card kind — the
  // rate-limited card in particular used to relay the raw synthetic-error text.
  const detail = escapeMarkdown(stripRawErrorBytes(ev.detail))

  switch (ev.kind) {
    case 'credentials-expired':
      return {
        text: [
          `🔑 **Claude login expired** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `Tap **Reauth now** to refresh credentials.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔐 Reauth now', callback_data: `op:reauth:${encodeURIComponent(ev.agent)}` },
              { text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` },
            ],
          ],
        },
      }

    case 'credentials-invalid':
      return {
        text: [
          `🔑 **Invalid Claude credentials** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `Run \`/auth reauth ${agent}\` or tap below.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔐 Reauth now', callback_data: `op:reauth:${encodeURIComponent(ev.agent)}` },
              { text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` },
            ],
          ],
        },
      }

    // Operator-only infra fault. Deliberately NO "Reauth" button and NO
    // login language: the OAuth credential is fine — the local LiteLLM proxy
    // re-dispatched an internal fallback without forwarding the OAuth header
    // onto a keyless deployment, so Anthropic 401'd it. The fix is in the
    // proxy fallback config (host-side), not a re-auth. Dismiss-only.
    case 'proxy-misconfig':
      return {
        text: [
          `🛠️ **Model-gateway auth misconfig** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `The local LiteLLM proxy re-dispatched a fallback without forwarding the OAuth header (keyless deployment → Anthropic 401). Fix the proxy fallback config — this is NOT a login problem.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    case 'credit-exhausted':
      return {
        text: [
          `💳 **Credit balance too low** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `Use \`/auth use <label>\` to switch account slot or \`/auth add\` to add one.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    // A third-party provider's balance, NOT Anthropic's. Deliberately carries
    // NO `/auth use` / `/auth add` language (those rotate Anthropic account
    // slots and buy zero OpenRouter tokens) and NO "🔐 Reauth" button (the key
    // is valid; it is out of money). The remedy names the provider, the VAULT
    // KEY NAME — never a value — and the console to act in. Dismiss-only.
    case 'provider-credit-exhausted': {
      const provider = attributeProvider(ev.detail)
      const who = provider != null ? escapeMarkdown(provider.label) : 'An upstream model provider'
      return {
        text: [
          `💳 **${provider != null ? `${who} credit exhausted` : 'Upstream provider credit exhausted'}** — hit by **${agent}**.`,
          detail ? `_${detail}_` : '',
          describeProviderCreditRemedy(provider),
          `Anthropic account slots are unaffected — \`/auth use\` will NOT fix this.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }
    }

    // A paid MCP dependency's KEY is blocked. `ev.detail` for this kind is
    // built by `renderMcpFailureDetail` from registry constants, counts and
    // sanitised agent slugs ONLY — no provider text and no user text ever
    // reaches it — so it is rendered as Markdown VERBATIM (escaping it would
    // mangle the `vault key` code span and the console URL). It names the
    // provider, the vault key NAME (never a value), the affected agents and
    // the action. Dismiss-only: `/auth` cannot fix a third-party MCP key.
    case 'mcp-dependency-blocked':
      return {
        text: [
          `🔌 **Paid dependency blocked**`,
          stripRawErrorBytes(ev.detail),
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    case 'quota-exhausted':
      // Canonical quota-exhausted text (migrated from auto-fallback.ts).
      // auto-fallback.ts's buildSwitchedMessage / buildAllExhaustedMessage
      // are the historical source; this is now the single owner.
      return {
        text: [
          `⚠️ **Quota exhausted** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `All account slots are at the usage limit. Switchroom will auto-fallback when another slot is available. Use \`/auth use <label>\` to switch manually.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    case 'rate-limited':
      return {
        text: [
          `🚦 **Rate limited** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `Claude is temporarily rate-limiting requests. Will retry automatically.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    case 'agent-crashed':
      return {
        text: [
          `💥 **Agent crashed**: **${agent}**.`,
          detail ? `_${detail}_` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔄 Restart', callback_data: `op:restart:${encodeURIComponent(ev.agent)}` },
              { text: '📋 Show logs', callback_data: `op:logs:${encodeURIComponent(ev.agent)}` },
            ],
          ],
        },
      }

    case 'agent-restarted-unexpectedly':
      return {
        text: [
          `🔄 **Agent restarted unexpectedly**: **${agent}**.`,
          detail ? `_${detail}_` : '',
          `This may indicate a crash-loop. Check logs if it happens again.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '📋 Show logs', callback_data: `op:logs:${encodeURIComponent(ev.agent)}` },
              { text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` },
            ],
          ],
        },
      }

    case 'unknown-4xx':
      return {
        text: [
          `⚠️ **API error (4xx)** for **${agent}**.`,
          detail ? `\`${detail}\`` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔐 Reauth', callback_data: `op:reauth:${encodeURIComponent(ev.agent)}` },
              { text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` },
            ],
          ],
        },
      }

    case 'unknown-5xx':
      return {
        text: [
          `🔥 **Server error (5xx)** for **${agent}**.`,
          detail ? `\`${detail}\`` : '',
          `Anthropic may be experiencing issues. Will retry automatically.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    // Deliberately low-severity framing (ℹ️, Dismiss-only — no Restart /
    // Reauth / Show-logs actions): config-warning is for boot-time config
    // problems (e.g. a dropped `person_id` entry) that must be visible to
    // the operator but MUST NOT read like a real outage or page anyone.
    case 'config-warning':
      return {
        text: [
          `ℹ️ **Config warning** for **${agent}**.`,
          detail ? `_${detail}_` : '',
          `Non-urgent — config will keep working with today's fallback behavior.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    // #2973 pt.3 — a durable "Always allow" persist exhausted its retry
    // budget (always-allow-persist-queue.ts) or hit a non-retryable error
    // (e.g. E_CONFIG_EDIT_DISABLED). MUST be a NEW message, not a card
    // edit — the original permission card was already edited to the
    // interim "saving durably in background…" state and card edits don't
    // ping the operator, so a silent edit here would leave the failure
    // unnoticed indefinitely.
    case 'always-allow-persist-failed':
      return {
        text: [
          `⚠️ Your "Always allow" for **${agent}** didn't stick.`,
          detail ? `_${detail}_` : '',
          `It will ask again.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    // #2975 Stage 1 — an operator-APPROVED mental-model persist hit the
    // config_propose_edit rate limit, and the ONE scheduled retry at the
    // window-open time ALSO failed. MUST be a NEW message (not a card edit):
    // the proposal card was already edited to the "applying at HH:MM" state
    // and card edits don't ping, so a silent edit here would leave the lost
    // approval unnoticed. Ask the operator to re-propose so it isn't dropped.
    case 'mental-model-persist-failed':
      return {
        text: [
          `⚠️ **${agent}**'s approved mental model didn't save.`,
          detail ? `_${detail}_` : '',
          `The retry after the rate window also failed — ask the agent to re-propose it.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }
  }
}

// ─── Per-agent per-kind cooldown ─────────────────────────────────────────────

export const DEFAULT_OPERATOR_EVENT_COOLDOWN_MS = 5 * 60_000 // 5 minutes

/**
 * In-memory cooldown tracker. Keyed by `${agent}:${kind}`.
 * Prevents repeated notifications for the same transient error storm.
 */
const cooldownMap = new Map<string, number>()

export function shouldEmitOperatorEvent(
  agent: string,
  kind: OperatorEventKind,
  now: number = Date.now(),
  cooldownMs: number = DEFAULT_OPERATOR_EVENT_COOLDOWN_MS,
): boolean {
  const key = `${agent}:${kind}`
  const last = cooldownMap.get(key)
  if (last != null && now - last < cooldownMs) {
    return false
  }
  cooldownMap.set(key, now)
  return true
}

/** Clear cooldown for a specific agent+kind (e.g. after reauth succeeds). */
export function clearOperatorEventCooldown(agent: string, kind: OperatorEventKind): void {
  cooldownMap.delete(`${agent}:${kind}`)
}

/** Reset ALL cooldowns (for testing). */
export function resetAllCooldowns(): void {
  cooldownMap.clear()
}

// ─── Audience routing (Ken's deterministic error-surfacing policy) ────────────

/**
 * Kinds that are OPERATOR-ACTIONABLE and NOT user-actionable: a credential /
 * infra fault whose remedy (re-auth, switch account slot, fix the proxy
 * fallback config) only the operator can perform. Per Ken's standing policy
 * (2026-07): raw or misleading auth/infra errors must not reach non-operator
 * end users — they cannot act on them and the diagnosis is often wrong for
 * them (e.g. a proxy misconfig rendered as "your login expired"). These route
 * to the operator surface ONLY; a non-operator user gets at most a brief
 * plain-language "couldn't complete, it's on our side" notice.
 *
 * NOTE: `quota-exhausted` / `rate-limited` are deliberately EXCLUDED — they
 * carry their own auto-fallback UX + card-collapse machinery and are handled
 * upstream; this set is scoped to the credential/infra fault classes.
 */
export const OPERATOR_ACTIONABLE_KINDS: ReadonlySet<OperatorEventKind> = new Set<OperatorEventKind>([
  'credentials-expired',
  'credentials-invalid',
  'credit-exhausted',
  // The OpenRouter/OpenAI/Perplexity 402 class. Only the operator can top up a
  // vendor balance; an end user shown "insufficient credits" can do nothing but
  // lose confidence. This membership is what routes it to the operator card and
  // hands the user the brief plain-language notice instead.
  'provider-credit-exhausted',
  // A paid MCP dependency's key is blocked (Perplexity out of credit, a revoked
  // Eraser key, …). Only the operator holds the vendor console and the vault —
  // an end user shown "401 invalid api key" can do nothing with it.
  'mcp-dependency-blocked',
  'proxy-misconfig',
])

export function isOperatorActionableKind(kind: OperatorEventKind): boolean {
  return OPERATOR_ACTIONABLE_KINDS.has(kind)
}

export interface OperatorEventAudience {
  /** Chats that receive the full operator card (with any action buttons). */
  operatorChats: string[]
  /** Non-operator chats that receive only the plain-language failure notice. */
  userNoticeChats: string[]
}

/**
 * Split an operator-event's allowlist audience per Ken's routing policy.
 *
 * - Non-operator-actionable kinds (transient rate-limit, 5xx, crash, config
 *   warning, …) keep their existing broadcast: every allowlist chat is an
 *   `operatorChat`. Behavior unchanged.
 * - Operator-actionable kinds (see {@link OPERATOR_ACTIONABLE_KINDS}) go to the
 *   OPERATOR chat only. `operatorChatId` is the operator (in switchroom the
 *   allowlist HEAD — `allowFrom[0]`); it stays an `operatorChat` even in a DM
 *   agent where the operator is their own user (so the operator NEVER has an
 *   error hidden from their own DM). Every other allowlist chat becomes a
 *   `userNoticeChat`.
 *
 * Pure — no IPC, no bot. `allowFrom` order is preserved.
 */
export function decideOperatorEventAudience(
  kind: OperatorEventKind,
  allowFrom: readonly string[],
  operatorChatId: string | undefined,
): OperatorEventAudience {
  if (!isOperatorActionableKind(kind)) {
    return { operatorChats: [...allowFrom], userNoticeChats: [] }
  }
  const operator =
    operatorChatId != null && allowFrom.includes(operatorChatId)
      ? operatorChatId
      : allowFrom[0]
  const operatorChats = operator != null ? [operator] : []
  const userNoticeChats = allowFrom.filter((c) => c !== operator)
  return { operatorChats, userNoticeChats }
}

/**
 * The ONE brief, plain-language failure notice a non-operator user gets when a
 * turn genuinely can't be served because of an operator-actionable fault.
 * Deliberately carries NO diagnosis, NO agent internals, NO re-auth / config
 * instructions, and NO raw error text — just an honest "it's on our side".
 */
export function renderUserFacingFailureNotice(): string {
  return "⚠️ Sorry — I couldn't complete that just now. It's a problem on our side, not anything you did. Please try again shortly."
}

// ─── Markdown escape (#2669) ──────────────────────────────────────────────────
