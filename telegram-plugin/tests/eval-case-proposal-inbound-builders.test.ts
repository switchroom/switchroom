/**
 * Fixture pins for the eval-case outcome inbounds.
 *
 * `meta.source` is what the bridge keys on to render the `<channel source=…>`
 * block that wakes the proposing agent, and the `meta.*` fields are the
 * forensic anchor back to the proposal + the deciding operator. A silent change
 * to either would put the agent back where this fix found it — steered to end
 * its turn and wait for a wake-up nothing recognises. Mirrors
 * `skill-proposal-card.test.ts`'s `buildSkillProposalApplyInbound` block.
 */

import { describe, it, expect } from 'vitest'
import {
  buildEvalCaseAppliedInbound,
  buildEvalCaseRejectedInbound,
  buildEvalCaseApplyFailedInbound,
} from '../gateway/eval-case-proposal-inbound-builders.js'

const CTX = { agent: 'klanker', chat_id: '12345' }

describe('buildEvalCaseAppliedInbound', () => {
  it('pins source and meta for an applied case', () => {
    const inb = buildEvalCaseAppliedInbound({
      ctx: CTX,
      proposalId: 'p1',
      skillSlug: 'deploy-checklist',
      heldOut: false,
      operatorId: '999',
      nowMs: 1000,
    })
    expect(inb.meta.source).toBe('eval_case_applied')
    expect(inb.meta.agent).toBe('klanker')
    expect(inb.meta.proposal_id).toBe('p1')
    expect(inb.meta.skill_slug).toBe('deploy-checklist')
    expect(inb.meta.held_out).toBe('false')
    expect(inb.meta.operator_id).toBe('999')
    expect(inb.chatId).toBe('12345')
    expect(inb.user).toBe('self-improve')
    expect(inb.messageId).toBe(1000)
    expect(inb.ts).toBe(1000)
    // The agent must NOT re-write a case the gateway already applied.
    expect(inb.text).toContain('do NOT write it yourself')
    expect(inb.text).toContain('evals.json')
  })

  it('names the held-out sink instead of evals.json when held_out', () => {
    const inb = buildEvalCaseAppliedInbound({
      ctx: CTX,
      proposalId: 'p1',
      skillSlug: 'deploy-checklist',
      heldOut: true,
      operatorId: '999',
    })
    expect(inb.meta.held_out).toBe('true')
    expect(inb.text).toContain('held-out sink')
    expect(inb.text).not.toContain('evals.json')
  })

  it('carries the forum topic through to threadId and meta', () => {
    const inb = buildEvalCaseAppliedInbound({
      ctx: { ...CTX, threadId: 7 },
      proposalId: 'p1',
      skillSlug: 's',
      heldOut: false,
      operatorId: '999',
    })
    expect(inb.threadId).toBe(7)
    expect(inb.meta.message_thread_id).toBe('7')
  })

  it('omits threadId/message_thread_id entirely for a DM proposal', () => {
    const inb = buildEvalCaseAppliedInbound({
      ctx: CTX,
      proposalId: 'p1',
      skillSlug: 's',
      heldOut: false,
      operatorId: '999',
    })
    expect('threadId' in inb).toBe(false)
    expect('message_thread_id' in inb.meta).toBe(false)
  })
})

describe('buildEvalCaseRejectedInbound', () => {
  it('pins source and tells the agent nothing was written', () => {
    const inb = buildEvalCaseRejectedInbound({
      ctx: CTX,
      proposalId: 'p2',
      skillSlug: 'deploy-checklist',
      heldOut: false,
      operatorId: '999',
      nowMs: 2000,
    })
    expect(inb.meta.source).toBe('eval_case_rejected')
    expect(inb.meta.proposal_id).toBe('p2')
    expect(inb.user).toBe('self-improve')
    expect(inb.text).toContain('NOTHING was written')
    expect(inb.text).toContain('Do NOT re-propose')
  })
})

describe('buildEvalCaseApplyFailedInbound', () => {
  it('pins source and refuses to let the agent assume the case landed', () => {
    const inb = buildEvalCaseApplyFailedInbound({
      ctx: CTX,
      proposalId: 'p3',
      skillSlug: 'deploy-checklist',
      heldOut: false,
      operatorId: '999',
      applyOut: 'ENOENT: skill dir missing',
      nowMs: 3000,
    })
    expect(inb.meta.source).toBe('eval_case_apply_failed')
    expect(inb.meta.proposal_id).toBe('p3')
    expect(inb.text).toContain('was NOT')
    expect(inb.text).toContain('do NOT assume')
    expect(inb.text).toContain('ENOENT: skill dir missing')
  })

  it('truncates a runaway applier dump so it cannot dominate the woken turn', () => {
    const inb = buildEvalCaseApplyFailedInbound({
      ctx: CTX,
      proposalId: 'p3',
      skillSlug: 's',
      heldOut: false,
      operatorId: '999',
      applyOut: 'x'.repeat(5000),
    })
    expect(inb.text).toContain('x'.repeat(500))
    expect(inb.text).not.toContain('x'.repeat(501))
  })

  it('says "(no output)" rather than emitting an empty line', () => {
    const inb = buildEvalCaseApplyFailedInbound({
      ctx: CTX,
      proposalId: 'p3',
      skillSlug: 's',
      heldOut: false,
      operatorId: '999',
      applyOut: '   \n  ',
    })
    expect(inb.text).toContain('(no output)')
  })
})
