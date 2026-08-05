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
import type { PostSkillProposalMessage, PostEvalCaseProposalMessage } from './ipc-protocol.js'
import { renderSkillProposalCard, skillProposalKeyboard } from './skill-proposal-card.js'
import { renderEvalCaseProposalCard, evalCaseProposalKeyboard } from './eval-case-proposal-card.js'
import {
  enqueueProposal as enqueueSkillProposal,
  isSuppressed as isSkillProposalSuppressed,
} from '../../src/self-improve/skill-proposals.js'
import { enqueueEvalCaseProposal } from '../../src/self-improve/eval-case-proposals.js'

/** Collaborators the gateway injects into each handler. */
export interface ProposalWiringDeps {
  bot: Bot<Context>
  assertAllowedChat: (chatId: string) => void
  swallowingApiCall: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T | undefined>
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
  const { bot, assertAllowedChat, swallowingApiCall } = deps
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
