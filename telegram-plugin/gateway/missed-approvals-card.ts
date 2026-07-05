/**
 * Missed-approvals re-offer digest card (#2862).
 *
 * Pure builders — card text, inline keyboard, callback shape, and the
 * synthetic inbound the gateway injects on Retry — kept out of gateway.ts so
 * they're pinned by tests independent of the bot plumbing (mirrors
 * `skill-proposal-card.ts`).
 *
 * The digest lists the approvals that TTL-expired while the operator was away
 * and offers two taps:
 *   • Ask agent to retry → inject a synthetic inbound asking the live agent to
 *     re-attempt the actions. This rides the SAME `inject_inbound` /
 *     synthesized-inbound path cron uses (claude-native): the agent starts a
 *     fresh turn and naturally re-raises a new approval card. It is a QUESTION
 *     to the agent — never a re-execution, never a synthesized verdict
 *     (no-self-escalation intact).
 *   • Dismiss → clear the list and edit the card closed.
 *
 * callback_data shape (fits Telegram's 64-byte limit):
 *   missre:retry:<digestId>
 *   missre:dismiss:<digestId>
 */

import type { InboundMessage } from './ipc-protocol.js'
import type { MissedApproval } from './missed-approvals-store.js'

export const MISSED_APPROVAL_CALLBACK_PREFIX = 'missre:'
/** How many entries to list in the card before collapsing to "…and N more". */
export const MISSED_APPROVAL_RENDER_CAP = 10

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Compact HH:MM (UTC) stamp for a miss. */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * Render the digest card text (HTML parse mode). Lists up to
 * `cap` entries, then a "…and N more" overflow line.
 */
export function renderMissedApprovalsDigest(
  entries: MissedApproval[],
  opts?: { cap?: number; agentName?: string | null },
): string {
  const cap = opts?.cap ?? MISSED_APPROVAL_RENDER_CAP
  const who = opts?.agentName ? escapeHtml(opts.agentName) : 'the agent'
  const shown = entries.slice(0, cap)
  const overflow = entries.length - shown.length

  const lines: string[] = []
  lines.push('⏳ <b>Missed approvals while you were away</b>')
  lines.push('')
  lines.push('These approval requests timed out before you could respond:')
  for (const e of shown) {
    lines.push(`• ${escapeHtml(e.action)} <i>(${fmtTime(e.timedOutAt)} UTC)</i>`)
  }
  if (overflow > 0) {
    lines.push(`…and ${overflow} more`)
  }
  lines.push('')
  lines.push(
    `<i>Tap “Ask agent to retry” to have ${who} re-attempt them — you’ll be ` +
      'asked to approve again as normal. Dismiss to clear.</i>',
  )
  return lines.join('\n')
}

/** Inline keyboard for the digest card. */
export function missedApprovalsKeyboard(digestId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  return {
    inline_keyboard: [
      [
        {
          text: '🔁 Ask agent to retry',
          callback_data: `${MISSED_APPROVAL_CALLBACK_PREFIX}retry:${digestId}`,
        },
        {
          text: '🚫 Dismiss',
          callback_data: `${MISSED_APPROVAL_CALLBACK_PREFIX}dismiss:${digestId}`,
        },
      ],
    ],
  }
}

/** Parse a `missre:` callback into { action, digestId }, or null if not ours. */
export function parseMissedApprovalCallback(
  data: string,
): { action: 'retry' | 'dismiss'; digestId: string } | null {
  if (!data.startsWith(MISSED_APPROVAL_CALLBACK_PREFIX)) return null
  const rest = data.slice(MISSED_APPROVAL_CALLBACK_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx < 0) return null
  const action = rest.slice(0, idx)
  const digestId = rest.slice(idx + 1)
  if ((action !== 'retry' && action !== 'dismiss') || digestId.length === 0) return null
  return { action, digestId }
}

export interface MissedApprovalInboundContext {
  agent: string
  chat_id: string
  threadId?: number
}

/**
 * Build the synthetic inbound injected when the operator taps "Ask agent to
 * retry". It ASKS the agent to re-attempt the listed actions — it never
 * re-executes them and never carries a verdict (no-self-escalation). The
 * agent starts a fresh turn and naturally re-raises approval cards.
 *
 * `meta.source = "missed_approval_retry"` so the bridge renders it as
 * `<channel source="missed_approval_retry">`.
 */
export function buildMissedApprovalRetryInbound(opts: {
  ctx: MissedApprovalInboundContext
  actions: string[]
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const list =
    opts.actions.length === 1
      ? opts.actions[0]
      : opts.actions.map(a => `\n• ${a}`).join('')
  const body =
    opts.actions.length === 1
      ? `Please re-attempt it now: ${list}.`
      : `Please re-attempt them now:${list}`
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'missed-approvals',
    userId: 0,
    ts,
    text:
      `🔁 Operator asked you to retry ${opts.actions.length === 1 ? 'an action' : 'some actions'} ` +
      `that timed out earlier while they were away. ${body} You'll be asked to ` +
      `approve again as normal — do not assume the earlier timeout was a denial.`,
    meta: {
      source: 'missed_approval_retry',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      operator_id: opts.operatorId,
      action_count: String(opts.actions.length),
    },
  }
}
