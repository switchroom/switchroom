/**
 * Pure builders for the synthetic inbounds the gateway injects after the
 * operator taps Approve / Dismiss on a self-improve EVAL-CASE proposal card
 * (RFC amendment §"corrections as eval cases"). Mirrors
 * `mental-model-propose-inbound-builders.ts`.
 *
 * WHY THIS MODULE EXISTS AT ALL: `handleEvalCaseProposalCallback` was a copy of
 * `handleSkillProposalCallback` that dropped the
 * `deliverResumeSyntheticOrBuffer` line. Both of its exits — dismiss and
 * approve — edited the card and returned, so the PROPOSING AGENT was never
 * told the outcome. It had been steered to end its turn cleanly and wait for a
 * wake-up that no code path ever sent: every candidate second delivery path is
 * empty (the self-improve Stop hook reads eval integrity baselines, not
 * proposal status; `switchroom self-improve eval-case propose` is
 * fire-and-forget and returns `ok:true` for POSTING THE CARD, never for the
 * outcome). These three builders are the inbound half of that fix.
 *
 * The shape is load-bearing — `meta.source` is what the bridge keys on to
 * render `<channel source="eval_case_applied">` / `eval_case_rejected` /
 * `eval_case_apply_failed` blocks, and the
 * `meta.{agent,proposal_id,skill_slug,held_out,operator_id}` fields are the
 * forensic anchor tying the woken turn back to the exact proposal and the
 * operator who decided it.
 *
 * A regression that drops a meta field or changes the source string would
 * silently break the agent's wake-up: the bridge would route it as a generic
 * channel event, the model wouldn't know its proposal resolved, and the
 * conversation would drift back to the silent-block this module fixes. Pinning
 * these against fixture tests is cheaper than catching that downstream.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Subset of the stored proposal the builders need. Kept narrow so callers
 *  don't have to pass the full `EvalCaseProposal` record. */
export interface EvalCaseProposalInboundContext {
  agent: string
  /** Telegram chat id where the approval card lived. Used as the inbound's
   *  chatId so the synthesized turn stays associated with the originating
   *  conversation. */
  chat_id: string
  /** Supergroup forum topic (message_thread_id) the agent was working in when
   *  it proposed — so the resumed turn's reply lands back in that topic, not
   *  General. Undefined for DM / non-topic proposals. */
  threadId?: number
}

/** The meta every eval-case outcome inbound carries, minus `source`. */
function commonMeta(opts: {
  ctx: EvalCaseProposalInboundContext
  proposalId: string
  skillSlug: string
  heldOut: boolean
  operatorId: string
}): Record<string, string> {
  return {
    agent: opts.ctx.agent,
    ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
    proposal_id: opts.proposalId,
    skill_slug: opts.skillSlug,
    held_out: String(opts.heldOut),
    operator_id: opts.operatorId,
  }
}

/**
 * Build the synthetic InboundMessage for an approval whose DETERMINISTIC
 * applier succeeded — the case is now on disk (in the skill's `evals.json`, or
 * the held-out sink when `heldOut`). Nothing is left for the agent to write.
 */
export function buildEvalCaseAppliedInbound(opts: {
  ctx: EvalCaseProposalInboundContext
  proposalId: string
  skillSlug: string
  heldOut: boolean
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const sink = opts.heldOut ? 'the held-out sink' : `\`${opts.skillSlug}\`'s \`evals.json\``
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'self-improve',
    userId: 0,
    ts,
    text:
      `✅ Operator approved your proposed eval case for \`${opts.skillSlug}\` ` +
      `(proposal ${opts.proposalId}). The case was applied DETERMINISTICALLY by ` +
      `the gateway and is already written to ${sink} — do NOT write it yourself ` +
      `and do NOT re-propose it. Resume whatever you were doing.`,
    meta: {
      source: 'eval_case_applied',
      ...commonMeta({
        ctx: opts.ctx,
        proposalId: opts.proposalId,
        skillSlug: opts.skillSlug,
        heldOut: opts.heldOut,
        operatorId: opts.operatorId,
      }),
    },
  }
}

/**
 * Build the synthetic InboundMessage for an operator dismissal. NOTHING was
 * written. Steers the agent onward rather than into a re-propose loop.
 *
 * This has no sibling in the skill-proposal handler (which stays silent on
 * dismiss). Silence is the defect being fixed: a dismissed proposal left the
 * agent waiting on a wake-up that never came.
 */
export function buildEvalCaseRejectedInbound(opts: {
  ctx: EvalCaseProposalInboundContext
  proposalId: string
  skillSlug: string
  heldOut: boolean
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'self-improve',
    userId: 0,
    ts,
    text:
      `🚫 Operator dismissed your proposed eval case for \`${opts.skillSlug}\` ` +
      `(proposal ${opts.proposalId}). NOTHING was written — no eval case was ` +
      `added. Carry on with the original task without it. Do NOT re-propose the ` +
      `same case without first asking the user.`,
    meta: {
      source: 'eval_case_rejected',
      ...commonMeta({
        ctx: opts.ctx,
        proposalId: opts.proposalId,
        skillSlug: opts.skillSlug,
        heldOut: opts.heldOut,
        operatorId: opts.operatorId,
      }),
    },
  }
}

/**
 * Build the synthetic InboundMessage for an approval whose applier FAILED
 * (`switchroom self-improve apply-eval-case` non-zero, timeout, missing skill
 * dir, a stale/rejected proposal the applier's own status check refused).
 * The operator tapped Approve but the case did NOT land — be honest so the
 * agent doesn't assume the regression test exists.
 *
 * `applyOut` is the applier's combined stdout/stderr tail, truncated so a
 * runaway stack trace can't dominate the woken turn's context.
 */
export function buildEvalCaseApplyFailedInbound(opts: {
  ctx: EvalCaseProposalInboundContext
  proposalId: string
  skillSlug: string
  heldOut: boolean
  operatorId: string
  applyOut: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const tail = opts.applyOut.trim().slice(0, 500)
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'self-improve',
    userId: 0,
    ts,
    text:
      `⚠️ The operator approved your proposed eval case for \`${opts.skillSlug}\` ` +
      `(proposal ${opts.proposalId}) but the applier FAILED. The case was NOT ` +
      `written — do NOT assume the regression test exists. Applier output:\n` +
      `${tail.length > 0 ? tail : '(no output)'}\n` +
      `Carry on with the original task; report the failure to the operator if it ` +
      `still matters.`,
    meta: {
      source: 'eval_case_apply_failed',
      ...commonMeta({
        ctx: opts.ctx,
        proposalId: opts.proposalId,
        skillSlug: opts.skillSlug,
        heldOut: opts.heldOut,
        operatorId: opts.operatorId,
      }),
    },
  }
}
