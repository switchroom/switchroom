/**
 * Self-improvement proposal IPC handlers, lifted out of gateway.ts.
 *
 * Both `post_skill_proposal` (#2670 one-tap self-improvement) and
 * `post_eval_case_proposal` (RFC amendment §"corrections as eval cases")
 * arrive over the per-agent gateway socket, are chat-fenced via
 * `assertAllowedChat`, persisted to their respective store, and rendered as
 * an Approve/Dismiss card. The store transition + apply on Approve are owned
 * by the callback handlers (so a gateway restart between post and tap still
 * resolves), NOT here.
 *
 * These live in a module (not inline in gateway.ts) so the gateway anti-
 * inflation line ratchet stays flat and the handler bodies are unit-testable
 * against a stubbed `bot` / `swallowingApiCall`. gateway.ts keeps only a thin
 * delegate per handler.
 *
 * The `bot.api.sendMessage` calls are wrapped in the injected
 * `swallowingApiCall` exactly as they were in gateway.ts — the bot-api-wrapping
 * lint recognises the wrapper by name in the surrounding context.
 */

import type { Bot, Context } from 'grammy'
import type { RetryCallOpts } from '../retry-api-call.js'
import type { PostSkillProposalMessage, PostEvalCaseProposalMessage, InboundMessage } from './ipc-protocol.js'
import { renderSkillProposalCard, skillProposalKeyboard } from './skill-proposal-card.js'
import { renderEvalCaseProposalCard, evalCaseProposalKeyboard } from './eval-case-proposal-card.js'
import {
  enqueueProposal as enqueueSkillProposal,
  isSuppressed as isSkillProposalSuppressed,
  REJECTION_TTL_MS,
} from '../../src/self-improve/skill-proposals.js'
import {
  enqueueEvalCaseProposal,
  readEvalCaseProposals,
} from '../../src/self-improve/eval-case-proposals.js'

/** Collaborators the gateway injects into each handler. */
export interface ProposalWiringDeps {
  bot: Bot<Context>
  assertAllowedChat: (chatId: string) => void
  swallowingApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T | undefined>
  /**
   * Wake the proposing agent with a synthetic inbound (gateway.ts's
   * `deliverResumeSyntheticOrBuffer`). REQUIRED, not optional: the suppressed
   * branch below is a silent exit, and a call site that forgot to wire this
   * would reinstate exactly the wait-forever bug it exists to prevent — so the
   * type system forces every caller to supply it.
   */
  deliverResumeSyntheticOrBuffer: (agent: string, inbound: InboundMessage) => boolean
}

/**
 * Build the synthetic inbound that tells a proposing agent its eval case was
 * SUPPRESSED as a duplicate of one the operator already dismissed.
 *
 * WHY THIS EXISTS (cross-PR, #4662 + #4664). #4662 makes the agent's contract
 * "fire `add-eval-case`, end your turn, wait for the outcome inbound". #4664
 * adds a branch that posts NO card. The propose CLI is fire-and-forget — it
 * prints `ok:true` for the IPC SEND, never for a card being posted
 * (src/cli/self-improve-eval-case.ts) — so without this the agent would end its
 * turn and wait for a tap that can never come: the exact silent block #4662
 * exists to eliminate, re-entering through a new door.
 *
 * The tone is deliberate. Suppression is the system working as designed, not a
 * failure, so the text says so plainly — an agent told only "no card" would
 * reasonably retry, which is the nagging loop #4664 is removing.
 *
 * Co-located here rather than in #4662's `eval-case-proposal-inbound-builders.ts`
 * because that module does not exist on this branch; consolidating the four
 * builders once both PRs land is a tracked follow-up.
 */
export function buildEvalCaseSuppressedInbound(opts: {
  agent: string
  chatId: string
  threadId?: number
  skillSlug: string
  fingerprint: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.chatId,
    ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'self-improve',
    userId: 0,
    ts,
    text:
      `ℹ️ Your proposed eval case for \`${opts.skillSlug}\` was NOT posted as a ` +
      `card: the operator already dismissed this exact case, and the dismissal ` +
      `is still in effect. This is EXPECTED and is not an error or a failure on ` +
      `your part — nothing was written and no card is pending, so do NOT wait ` +
      `for an approval tap. Do NOT re-propose this case. Carry on with the ` +
      `original task without it.`,
    meta: {
      source: 'eval_case_suppressed',
      agent: opts.agent,
      ...(opts.threadId != null ? { message_thread_id: String(opts.threadId) } : {}),
      skill_slug: opts.skillSlug,
      fingerprint: opts.fingerprint,
    },
  }
}

/**
 * #2670 one-tap self-improvement — persist a skill-improvement proposal and
 * post its Approve/Dismiss card. Dedups against still-live rejection
 * fingerprints so a dismissed proposal never re-surfaces.
 */
export function handlePostSkillProposal(
  msg: PostSkillProposalMessage,
  deps: ProposalWiringDeps,
): void {
  const { bot, assertAllowedChat, swallowingApiCall } = deps
  const self = process.env.SWITCHROOM_AGENT_NAME
  if (self && msg.agentName !== self) {
    process.stderr.write(
      `telegram gateway: post_skill_proposal rejected — agent mismatch (${msg.agentName} != ${self})\n`,
    )
    return
  }
  try {
    assertAllowedChat(msg.chatId)
  } catch (err) {
    process.stderr.write(
      `telegram gateway: post_skill_proposal rejected — ${(err as Error).message}\n`,
    )
    return
  }
  const stateDir = process.env.TELEGRAM_STATE_DIR
  if (stateDir == null || stateDir.length === 0) {
    process.stderr.write(`telegram gateway: post_skill_proposal: TELEGRAM_STATE_DIR unset, skipping\n`)
    return
  }
  // Dedup against still-live rejection fingerprints — never re-surface a
  // proposal the operator already dismissed.
  if (isSkillProposalSuppressed(stateDir, {
    lesson: msg.lesson,
    draft: msg.draft,
    skill_slug: msg.skillSlug,
  })) {
    process.stderr.write(
      `telegram gateway: post_skill_proposal suppressed (rejected before) slug=${msg.skillSlug}\n`,
    )
    return
  }
  const proposal = enqueueSkillProposal(stateDir, {
    skill_slug: msg.skillSlug,
    is_new: msg.isNew,
    lesson: msg.lesson,
    draft: msg.draft,
    evidence: msg.evidence,
    chat_id: Number(msg.chatId),
    // Provenance — absent ⇒ the store's back-compat default (skill-synthesis).
    ...(msg.origin != null ? { origin: msg.origin } : {}),
  })
  const cardText = renderSkillProposalCard({
    id: proposal.id,
    skill_slug: proposal.skill_slug,
    is_new: proposal.is_new,
    lesson: proposal.lesson,
    evidence: proposal.evidence,
    skill_md: proposal.draft['SKILL.md'],
  })
  const threadId = msg.threadId
  void swallowingApiCall(
    () =>
      bot.api.sendMessage(msg.chatId, cardText, {
        parse_mode: 'HTML',
        reply_markup: skillProposalKeyboard(proposal.id),
        ...(threadId != null && threadId !== 1 ? { message_thread_id: threadId } : {}),
      }),
    { chat_id: msg.chatId, verb: 'skill-proposal-card', ...(threadId != null ? { threadId } : {}) },
  )
  process.stderr.write(
    `telegram gateway: post_skill_proposal agent=${msg.agentName} chat=${msg.chatId} ` +
    `proposal=${proposal.id} slug=${proposal.skill_slug} new=${proposal.is_new}\n`,
  )
}

/**
 * True iff the operator already DISMISSED this exact eval case within the
 * rejection TTL — the eval-case twin of `isSuppressed` in skill-proposals.ts.
 *
 * Matching is deliberately TIGHTER than the skill path's. A skill proposal is
 * free prose, so that check has to fuzzy-match (jaccard over content words,
 * with the slug only relaxing the threshold). An eval case carries a
 * precomputed `fingerprint` — `caseFingerprint(prompt)`, a hash of the
 * normalized prompt — and the CLI's own dedup against a skill's applied
 * evals.json compares those fingerprints EXACTLY
 * (src/cli/self-improve-eval-case.ts). So this requires exact fingerprint
 * equality AND same-slug, matching the CLI's per-skill dedup scope: no fuzzy
 * bar to tune, and a different PROMPT can never be swallowed.
 *
 * KNOWN CONSEQUENCE — identity is the PROMPT, not the whole case.
 * `caseFingerprint` hashes the normalized prompt ONLY; an `EvalCase` also
 * carries `expected_output` and `expectations` (src/self-improve/eval-cases.ts),
 * and neither is in the hash. So re-proposing the SAME prompt with a CORRECTED
 * expected_output/expectations fingerprints identically to the dismissed one and
 * stays suppressed for the full TTL. This is deliberate, not an oversight: it is
 * the same identity the CLI's own evals.json dedup uses, so a looser rule here
 * would disagree with the applier and re-admit cases the CLI would then reject.
 * To land a revised assertion for an already-dismissed prompt, reword the prompt
 * (a genuinely different input) or wait out REJECTION_TTL_MS.
 *
 * The TTL semantics ARE mirrored (a dismissal shouldn't suppress forever), on
 * the same REJECTION_TTL_MS window. The eval-case store records no
 * `rejected_at`, so age is measured from `created_at`, which is always <= the
 * rejection time — the window therefore expires no LATER than a true
 * rejected_at basis would, erring towards re-surfacing rather than
 * over-suppressing. A record with an unparseable timestamp is treated as
 * expired, same as the skill path.
 */
export function isEvalCaseProposalSuppressed(
  stateDir: string,
  candidate: { skillSlug: string; fingerprint: string },
  opts: { now?: () => number; ttlMs?: number } = {},
): boolean {
  // A missing/empty fingerprint carries no identity — never suppress on it.
  if (typeof candidate.fingerprint !== 'string' || candidate.fingerprint.length === 0) {
    return false
  }
  const now = (opts.now ?? Date.now)()
  const ttl = opts.ttlMs ?? REJECTION_TTL_MS
  for (const p of readEvalCaseProposals(stateDir)) {
    if (p.status !== 'rejected') continue
    if (p.skill_slug !== candidate.skillSlug) continue
    if (p.fingerprint !== candidate.fingerprint) continue
    const age = now - new Date(p.created_at).getTime()
    if (!Number.isFinite(age) || age > ttl) continue // expired
    return true
  }
  return false
}

/**
 * RFC amendment §"corrections as eval cases" — persist an eval-case proposal
 * and post its Approve/Dismiss card. On Approve the callback runs the
 * DETERMINISTIC applier (handleEvalCaseProposalCallback), NOT a model turn, so
 * the case lands byte-exact. Same per-agent-socket / chat-fenced trust model
 * as handlePostSkillProposal.
 */
export function handlePostEvalCaseProposal(
  msg: PostEvalCaseProposalMessage,
  deps: ProposalWiringDeps,
): void {
  const { bot, assertAllowedChat, swallowingApiCall, deliverResumeSyntheticOrBuffer } = deps
  const self = process.env.SWITCHROOM_AGENT_NAME
  if (self && msg.agentName !== self) {
    process.stderr.write(
      `telegram gateway: post_eval_case_proposal rejected — agent mismatch (${msg.agentName} != ${self})\n`,
    )
    return
  }
  try {
    assertAllowedChat(msg.chatId)
  } catch (err) {
    process.stderr.write(
      `telegram gateway: post_eval_case_proposal rejected — ${(err as Error).message}\n`,
    )
    return
  }
  const stateDir = process.env.TELEGRAM_STATE_DIR
  if (stateDir == null || stateDir.length === 0) {
    process.stderr.write(`telegram gateway: post_eval_case_proposal: TELEGRAM_STATE_DIR unset, skipping\n`)
    return
  }
  // Dedup against still-live dismissals — never re-surface an eval case the
  // operator already tapped Dismiss on (the skill path's guard, which the
  // eval-case path was missing: a dismissed case re-posted the same card on
  // every subsequent correction, since the CLI only dedups against evals.json
  // entries that were already APPLIED).
  if (isEvalCaseProposalSuppressed(stateDir, {
    skillSlug: msg.skillSlug,
    fingerprint: msg.fingerprint,
  })) {
    // Tell the agent, or this becomes a silent exit it waits on forever (see
    // buildEvalCaseSuppressedInbound). No card is posted and nothing is written
    // — the operator's dismissal already decided this case.
    const delivered = deliverResumeSyntheticOrBuffer(
      msg.agentName,
      buildEvalCaseSuppressedInbound({
        agent: msg.agentName,
        chatId: msg.chatId,
        ...(msg.threadId != null ? { threadId: msg.threadId } : {}),
        skillSlug: msg.skillSlug,
        fingerprint: msg.fingerprint,
      }),
    )
    process.stderr.write(
      `telegram gateway: post_eval_case_proposal suppressed (dismissed before) ` +
      `slug=${msg.skillSlug} fp=${msg.fingerprint} delivered=${delivered}\n`,
    )
    return
  }
  const proposal = enqueueEvalCaseProposal(stateDir, {
    skill_slug: msg.skillSlug,
    skill_dir: msg.skillDir,
    case: msg.case,
    fingerprint: msg.fingerprint,
    held_out: msg.heldOut === true,
    chat_id: Number(msg.chatId),
  })
  const cardText = renderEvalCaseProposalCard({
    id: proposal.id,
    skill_slug: proposal.skill_slug,
    held_out: proposal.held_out,
    case: proposal.case,
  })
  const threadId = msg.threadId
  void swallowingApiCall(
    () =>
      bot.api.sendMessage(msg.chatId, cardText, {
        parse_mode: 'HTML',
        reply_markup: evalCaseProposalKeyboard(proposal.id),
        ...(threadId != null && threadId !== 1 ? { message_thread_id: threadId } : {}),
      }),
    { chat_id: msg.chatId, verb: 'eval-case-proposal-card', ...(threadId != null ? { threadId } : {}) },
  )
  process.stderr.write(
    `telegram gateway: post_eval_case_proposal agent=${msg.agentName} chat=${msg.chatId} ` +
    `proposal=${proposal.id} slug=${proposal.skill_slug} held_out=${proposal.held_out}\n`,
  )
}
