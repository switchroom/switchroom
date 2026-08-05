/**
 * One-tap eval-case proposal card (RFC amendment §"corrections as eval
 * cases").
 *
 * `switchroom self-improve add-eval-case` sends a `post_eval_case_proposal`
 * IPC; the gateway persists it (eval-case-proposals store) and renders THIS
 * card. Unlike the skill-proposal card, tapping Approve does NOT inject a
 * model turn — the gateway callback runs the DETERMINISTIC `apply-eval-case`
 * applier via execFileSync, so the case lands byte-exact as approved.
 *
 * Pure builders, kept out of gateway.ts so the card text + callback shape are
 * pinned by tests independent of the bot plumbing.
 *
 * callback_data shape (must fit Telegram's 64-byte limit):
 *   evcase:approve:<id>
 *   evcase:deny:<id>
 */

export const EVAL_CASE_PROPOSAL_CALLBACK_PREFIX = 'evcase:'

/** Narrow view of a stored eval-case proposal the card needs. */
export interface EvalCaseProposalView {
  id: string
  skill_slug: string
  held_out: boolean
  case: { prompt: string; expectations?: string[] }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Truncate a single-line preview of the prompt for the card. */
function previewPrompt(prompt: string, max = 240): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

/** Render the eval-case proposal card text (HTML parse mode). */
export function renderEvalCaseProposalCard(p: EvalCaseProposalView): string {
  const lines: string[] = []
  lines.push(`🧪 <b>Eval case proposed</b>`)
  lines.push('')
  lines.push(`<b>Skill:</b> <code>${escapeHtml(p.skill_slug)}</code>`)
  if (p.held_out) lines.push(`<i>held-out (won't be added to evals.json)</i>`)
  lines.push(`<b>Test prompt:</b> ${escapeHtml(previewPrompt(p.case.prompt))}`)
  const exps = p.case.expectations ?? []
  if (exps.length > 0) {
    lines.push('<b>Checks:</b>')
    for (const e of exps.slice(0, 5)) lines.push(`• ${escapeHtml(e.slice(0, 120))}`)
  }
  lines.push('')
  lines.push(
    '<i>Tap Add to append it as a regression test (re-scanned for ' +
      'secrets/PII, written byte-exact — no model turn). Tap Dismiss to drop it.</i>',
  )
  return lines.join('\n')
}

/** Inline keyboard for the card. */
export function evalCaseProposalKeyboard(id: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Add case', callback_data: `${EVAL_CASE_PROPOSAL_CALLBACK_PREFIX}approve:${id}` },
        { text: '🚫 Dismiss', callback_data: `${EVAL_CASE_PROPOSAL_CALLBACK_PREFIX}deny:${id}` },
      ],
    ],
  }
}

/** Parse an `evcase:` callback into { action, id }, or null if not ours. */
export function parseEvalCaseProposalCallback(
  data: string,
): { action: 'approve' | 'deny'; id: string } | null {
  if (!data.startsWith(EVAL_CASE_PROPOSAL_CALLBACK_PREFIX)) return null
  const rest = data.slice(EVAL_CASE_PROPOSAL_CALLBACK_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx < 0) return null
  const action = rest.slice(0, idx)
  const id = rest.slice(idx + 1)
  if ((action !== 'approve' && action !== 'deny') || id.length === 0) return null
  return { action, id }
}
