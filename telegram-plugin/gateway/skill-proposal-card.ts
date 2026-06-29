/**
 * One-tap skill-improvement proposal card (#2670, "one-tap
 * self-improvement").
 *
 * The weekly skill-synthesis cron drafts a proposed personal skill and
 * persists it (full draft bundle) in the self-improve proposal store
 * (`src/self-improve/skill-proposals.ts`). This module renders that
 * proposal as a Telegram Approve / Dismiss card and builds the synthetic
 * inbound the gateway injects when the operator taps Approve — instructing
 * the live agent to APPLY the stored draft through the existing
 * `skill_init_personal` / `skill_edit_personal` write pipeline (so the
 * merged `scanBundleForSecrets` gate runs; the agent never self-applies —
 * the operator tap is the authorization, satisfying `no-self-escalation`).
 *
 * Pure builders, kept out of gateway.ts so the card text + callback shape
 * + inbound shape are pinned by tests independent of the bot plumbing.
 *
 * callback_data shape (must fit Telegram's 64-byte limit):
 *   skprop:approve:<id>
 *   skprop:deny:<id>
 * where <id> is the proposal's UUID from the store.
 */

import type { InboundMessage } from './ipc-protocol.js'

export const SKILL_PROPOSAL_CALLBACK_PREFIX = 'skprop:'

/** Narrow shape of a stored proposal the card/inbound builders need.
 *  Mirrors SkillProposal in src/self-improve/skill-proposals.ts without
 *  importing across the tsconfig boundary. */
export interface SkillProposalView {
  id: string
  skill_slug: string
  is_new: boolean
  lesson: string
  evidence: string
  /** SKILL.md body, for the optional "show full draft" / step preview. */
  skill_md?: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** A short bullet preview of the drafted procedure (first few non-empty,
 *  non-frontmatter lines of SKILL.md), capped for the card. */
export function previewSteps(skillMd: string | undefined, maxLines = 5): string[] {
  if (!skillMd) return []
  // Drop YAML frontmatter block if present.
  let body = skillMd
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1)
  }
  const out: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    out.push(line.replace(/^[-*\d.)\s]+/, '').slice(0, 120))
    if (out.length >= maxLines) break
  }
  return out
}

/** Render the proposal card text (HTML parse mode). */
export function renderSkillProposalCard(p: SkillProposalView): string {
  const verb = p.is_new ? 'New personal skill' : 'Update to personal skill'
  const lines: string[] = []
  lines.push(`🧩 <b>Skill improvement proposed</b>`)
  lines.push('')
  lines.push(`<b>${escapeHtml(verb)}:</b> <code>${escapeHtml(p.skill_slug)}</code>`)
  lines.push(`<b>Lesson:</b> ${escapeHtml(p.lesson)}`)
  if (p.evidence) lines.push(`<i>${escapeHtml(p.evidence)}</i>`)
  const steps = previewSteps(p.skill_md)
  if (steps.length > 0) {
    lines.push('')
    lines.push('<b>Draft procedure:</b>')
    for (const s of steps) lines.push(`• ${escapeHtml(s)}`)
  }
  lines.push('')
  lines.push(
    '<i>Tap Add to apply it (runs through the secret-scan write pipeline). ' +
      'Tap Dismiss and it won’t be proposed again.</i>',
  )
  return lines.join('\n')
}

/** Inline keyboard for the proposal card. */
export function skillProposalKeyboard(id: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Add skill', callback_data: `${SKILL_PROPOSAL_CALLBACK_PREFIX}approve:${id}` },
        { text: '🚫 Dismiss', callback_data: `${SKILL_PROPOSAL_CALLBACK_PREFIX}deny:${id}` },
      ],
    ],
  }
}

/** Parse a `skprop:` callback into { action, id }, or null if not ours. */
export function parseSkillProposalCallback(
  data: string,
): { action: 'approve' | 'deny'; id: string } | null {
  if (!data.startsWith(SKILL_PROPOSAL_CALLBACK_PREFIX)) return null
  const rest = data.slice(SKILL_PROPOSAL_CALLBACK_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx < 0) return null
  const action = rest.slice(0, idx)
  const id = rest.slice(idx + 1)
  if ((action !== 'approve' && action !== 'deny') || id.length === 0) return null
  return { action, id }
}

export interface SkillProposalInboundContext {
  agent: string
  chat_id: string
  threadId?: number
}

/**
 * Build the synthetic inbound injected when the operator taps Approve.
 * It instructs the live agent to apply the stored draft via the personal-
 * skill write pipeline — the agent never self-applies; this tap is the
 * authorization. `meta.source = "skill_proposal_apply"` so the bridge
 * renders it as `<channel source="skill_proposal_apply">`.
 */
export function buildSkillProposalApplyInbound(opts: {
  ctx: SkillProposalInboundContext
  proposalId: string
  skillSlug: string
  isNew: boolean
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const tool = opts.isNew ? 'skill_init_personal' : 'skill_edit_personal'
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'skill-synthesis',
    userId: 0,
    ts,
    text:
      `✅ Operator approved your proposed skill \`${opts.skillSlug}\` ` +
      `(proposal ${opts.proposalId}). Apply it now: read the stored draft ` +
      `from the self-improve proposal store and call \`${tool}\` with that ` +
      `exact draft bundle. Do NOT re-draft or add anything from this ` +
      `conversation — write the stored bundle verbatim so the secret-scan ` +
      `write pipeline validates it. Confirm to the operator when it lands.`,
    meta: {
      source: 'skill_proposal_apply',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      proposal_id: opts.proposalId,
      skill_slug: opts.skillSlug,
      is_new: String(opts.isNew),
      operator_id: opts.operatorId,
    },
  }
}
