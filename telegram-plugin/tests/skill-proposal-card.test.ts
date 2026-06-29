/**
 * Unit tests for telegram-plugin/gateway/skill-proposal-card.ts (#2670).
 *
 * Pure builders — no SQLite, no gateway. Contract under test:
 *   - parseSkillProposalCallback round-trips the keyboard's callback_data.
 *   - renderSkillProposalCard escapes HTML and shows lesson + steps.
 *   - buildSkillProposalApplyInbound pins source='skill_proposal_apply' +
 *     meta fields the bridge keys on.
 */

import { describe, it, expect } from 'bun:test'
import {
  parseSkillProposalCallback,
  skillProposalKeyboard,
  renderSkillProposalCard,
  buildSkillProposalApplyInbound,
  previewSteps,
  SKILL_PROPOSAL_CALLBACK_PREFIX,
} from '../gateway/skill-proposal-card.js'

describe('skill-proposal callback round-trip', () => {
  it('keyboard callback_data parses back to action + id', () => {
    const kb = skillProposalKeyboard('abc-123')
    const [approve, deny] = kb.inline_keyboard[0]!
    expect(parseSkillProposalCallback(approve!.callback_data)).toEqual({
      action: 'approve',
      id: 'abc-123',
    })
    expect(parseSkillProposalCallback(deny!.callback_data)).toEqual({
      action: 'deny',
      id: 'abc-123',
    })
  })

  it('rejects foreign / malformed callback_data', () => {
    expect(parseSkillProposalCallback('vra:approve:x')).toBeNull()
    expect(parseSkillProposalCallback(`${SKILL_PROPOSAL_CALLBACK_PREFIX}bogus:x`)).toBeNull()
    expect(parseSkillProposalCallback(`${SKILL_PROPOSAL_CALLBACK_PREFIX}approve:`)).toBeNull()
  })

  it('callback_data fits Telegram 64-byte limit for a UUID id', () => {
    const kb = skillProposalKeyboard('00000000-0000-0000-0000-000000000000')
    for (const row of kb.inline_keyboard) {
      for (const b of row) {
        expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })
})

describe('renderSkillProposalCard', () => {
  it('shows lesson, evidence, and escapes HTML', () => {
    const text = renderSkillProposalCard({
      id: 'x',
      skill_slug: 'deploy-checklist',
      is_new: true,
      lesson: 'Always run <smoke> first',
      evidence: 'seen across 3 sessions',
      skill_md: '---\nname: deploy-checklist\ndescription: d\n---\n\n1. step one\n2. step two',
    })
    expect(text).toContain('New personal skill')
    expect(text).toContain('deploy-checklist')
    expect(text).toContain('&lt;smoke&gt;') // escaped
    expect(text).toContain('seen across 3 sessions')
    expect(text).toContain('step one')
  })

  it('previewSteps drops frontmatter + headings', () => {
    const steps = previewSteps('---\nname: x\n---\n\n# Title\n1. alpha\n- beta\n')
    expect(steps).toEqual(['alpha', 'beta'])
  })
})

describe('buildSkillProposalApplyInbound', () => {
  it('pins source and meta for a new skill', () => {
    const inb = buildSkillProposalApplyInbound({
      ctx: { agent: 'klanker', chat_id: '12345' },
      proposalId: 'p1',
      skillSlug: 'deploy-checklist',
      isNew: true,
      operatorId: '999',
      nowMs: 1000,
    })
    expect(inb.meta.source).toBe('skill_proposal_apply')
    expect(inb.meta.proposal_id).toBe('p1')
    expect(inb.meta.skill_slug).toBe('deploy-checklist')
    expect(inb.meta.is_new).toBe('true')
    expect(inb.chatId).toBe('12345')
    expect(inb.text).toContain('skill_init_personal')
  })

  it('points at the edit tool when isNew=false', () => {
    const inb = buildSkillProposalApplyInbound({
      ctx: { agent: 'klanker', chat_id: '12345' },
      proposalId: 'p2',
      skillSlug: 'deploy-checklist',
      isNew: false,
      operatorId: '999',
    })
    expect(inb.text).toContain('skill_edit_personal')
    expect(inb.meta.is_new).toBe('false')
  })
})
