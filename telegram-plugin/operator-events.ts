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
    // Anthropic overloaded = quota exhausted / service rate-limiting
    return 'quota-exhausted'
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
  const agent = escHtml(ev.agent)
  const detail = escHtml(ev.detail)

  switch (ev.kind) {
    case 'credentials-expired':
      return {
        text: [
          `🔑 <b>Claude login expired</b> for <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
          `Tap <b>Reauth now</b> to refresh credentials.`,
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
          `🔑 <b>Invalid Claude credentials</b> for <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
          `Run <code>/auth reauth ${agent}</code> or tap below.`,
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
          `💳 <b>Credit balance too low</b> for <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
          `Swap to another account slot or add a new one.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔄 Swap slot', callback_data: `op:swap-slot:${encodeURIComponent(ev.agent)}` },
              { text: '➕ Add slot', callback_data: `op:add-slot:${encodeURIComponent(ev.agent)}` },
            ],
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
          `⚠️ <b>Quota exhausted</b> for <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
          `All account slots are at the usage limit. Switchroom will auto-fallback when another slot is available.`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔄 Swap slot', callback_data: `op:swap-slot:${encodeURIComponent(ev.agent)}` },
              { text: '➕ Add slot', callback_data: `op:add-slot:${encodeURIComponent(ev.agent)}` },
            ],
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(ev.agent)}` }],
          ],
        },
      }

    case 'rate-limited':
      return {
        text: [
          `🚦 <b>Rate limited</b> for <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
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
          `💥 <b>Agent crashed</b>: <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
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
          `🔄 <b>Agent restarted unexpectedly</b>: <b>${agent}</b>.`,
          detail ? `<i>${detail}</i>` : '',
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
          `⚠️ <b>API error (4xx)</b> for <b>${agent}</b>.`,
          detail ? `<code>${detail}</code>` : '',
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
          `🔥 <b>Server error (5xx)</b> for <b>${agent}</b>.`,
          detail ? `<code>${detail}</code>` : '',
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

// ─── HTML escape ─────────────────────────────────────────────────────────────

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
