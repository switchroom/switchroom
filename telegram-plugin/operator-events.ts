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

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type OperatorEventKind =
  | 'credentials-expired'
  | 'credentials-invalid'
  | 'credit-exhausted'
  | 'quota-exhausted'
  | 'rate-limited'
  | 'agent-crashed'
  | 'agent-restarted-unexpectedly'
  | 'unknown-4xx'
  | 'unknown-5xx'
  | 'config-warning'
  | 'always-allow-persist-failed'

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

  if (
    errorType === 'credit_balance_too_low' ||
    errorCode === 'credit_balance_too_low' ||
    sdkCode === 'credit_balance_too_low' ||
    message.toLowerCase().includes('credit_balance_too_low') ||
    message.toLowerCase().includes('credit balance')
  ) {
    return 'credit-exhausted'
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
  const detail = escapeMarkdown(ev.detail)

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

// ─── Markdown escape (#2669) ──────────────────────────────────────────────────
