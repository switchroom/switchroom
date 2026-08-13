/**
 * Unit tests for the self-improvement proposal IPC handlers.
 *
 * The handlers are factored out of gateway.ts so they can be exercised
 * without booting grammy — `bot`, `assertAllowedChat` and
 * `swallowingApiCall` all come in through the ProposalWiringDeps seam, and
 * the proposal stores are real files under a fresh tmpdir.
 *
 * The assertions here are OBSERVABLE: a suppressed proposal writes NO new
 * record to the store and posts NO card (`swallowingApiCall` never fires).
 * "The suppression branch ran" is not a test.
 *
 * Run with: npx vitest run telegram-plugin/gateway/self-improve-proposal-wiring.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot, Context } from 'grammy'

import {
  handlePostSkillProposal,
  handlePostEvalCaseProposal,
  isEvalCaseProposalSuppressed,
  type ProposalWiringDeps,
} from './self-improve-proposal-wiring.js'
import type {
  PostSkillProposalMessage,
  PostEvalCaseProposalMessage,
} from './ipc-protocol.js'
import {
  enqueueProposal as enqueueSkillProposal,
  setProposalStatus as setSkillProposalStatus,
  REJECTION_TTL_MS,
} from '../../src/self-improve/skill-proposals.js'
import {
  enqueueEvalCaseProposal,
  readEvalCaseProposals,
  setEvalCaseProposalStatus,
} from '../../src/self-improve/eval-case-proposals.js'

const CHAT = '424242'

function makeDeps(): { deps: ProposalWiringDeps; sent: string[] } {
  const sent: string[] = []
  const bot = {
    api: {
      sendMessage: vi.fn(async (_chat: string, text: string) => {
        sent.push(text)
        return { message_id: 1 }
      }),
    },
  } as unknown as Bot<Context>
  const deps: ProposalWiringDeps = {
    bot,
    assertAllowedChat: () => {},
    swallowingApiCall: async <T>(fn: () => Promise<T>) => await fn(),
  }
  return { deps, sent }
}

const evalCase = {
  prompt: 'When the operator says "ship it", run the smoke suite first.',
  expectations: ['runs the smoke suite before deploying'],
  source: 'correction 2026-08-13',
}

function evalMsg(
  over: Partial<PostEvalCaseProposalMessage> = {},
): PostEvalCaseProposalMessage {
  return {
    type: 'post_eval_case_proposal',
    agentName: 'carrie',
    chatId: CHAT,
    skillSlug: 'deploy-checklist',
    skillDir: '/skills/deploy-checklist',
    case: evalCase,
    fingerprint: 'aaaa1111',
    heldOut: false,
    ...over,
  }
}

const skillDraft = {
  'SKILL.md':
    '---\nname: deploy-checklist\ndescription: deploy steps\n---\n\n' +
    '1. run smoke suite\n2. check dashboards\n3. promote\n',
}

function skillMsg(
  over: Partial<PostSkillProposalMessage> = {},
): PostSkillProposalMessage {
  return {
    type: 'post_skill_proposal',
    agentName: 'carrie',
    chatId: CHAT,
    skillSlug: 'deploy-checklist',
    isNew: true,
    lesson: 'Always run the smoke suite before promoting a deploy',
    draft: skillDraft,
    evidence: 'seen across 3 sessions',
    ...over,
  } as PostSkillProposalMessage
}

describe('self-improve proposal wiring — rejection suppression', () => {
  let dir: string
  const savedStateDir = process.env.TELEGRAM_STATE_DIR
  const savedAgent = process.env.SWITCHROOM_AGENT_NAME

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proposal-wiring-'))
    process.env.TELEGRAM_STATE_DIR = dir
    delete process.env.SWITCHROOM_AGENT_NAME
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedStateDir == null) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = savedStateDir
    if (savedAgent == null) delete process.env.SWITCHROOM_AGENT_NAME
    else process.env.SWITCHROOM_AGENT_NAME = savedAgent
  })

  // ── the sibling skill path (the shape the eval path must mirror) ──

  it('does not re-post a skill proposal the operator already dismissed', () => {
    const p = enqueueSkillProposal(dir, {
      skill_slug: 'deploy-checklist',
      is_new: true,
      lesson: skillMsg().lesson,
      draft: skillDraft,
      evidence: 'x',
    })
    setSkillProposalStatus(dir, p.id, 'rejected')

    const { deps, sent } = makeDeps()
    handlePostSkillProposal(skillMsg(), deps)

    expect(sent).toEqual([])
  })

  // ── eval-case path: the defect this PR fixes ──

  it('does not enqueue or post an eval case whose fingerprint was dismissed', () => {
    const p = enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: evalCase,
      fingerprint: 'aaaa1111',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, p.id, 'rejected')
    const before = readEvalCaseProposals(dir).length

    const { deps, sent } = makeDeps()
    handlePostEvalCaseProposal(evalMsg(), deps)

    // Observable 1: no card posted.
    expect(sent).toEqual([])
    // Observable 2: no new record written to the store.
    expect(readEvalCaseProposals(dir)).toHaveLength(before)
  })

  it('still enqueues and posts an eval case with a different fingerprint', () => {
    const p = enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: { prompt: 'something else entirely' },
      fingerprint: 'bbbb2222',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, p.id, 'rejected')

    const { deps, sent } = makeDeps()
    handlePostEvalCaseProposal(evalMsg({ fingerprint: 'aaaa1111' }), deps)

    expect(sent).toHaveLength(1)
    expect(
      readEvalCaseProposals(dir).some(
        (r) => r.fingerprint === 'aaaa1111' && r.status === 'pending',
      ),
    ).toBe(true)
  })

  it('still enqueues the same fingerprint for a DIFFERENT skill slug', () => {
    const p = enqueueEvalCaseProposal(dir, {
      skill_slug: 'other-skill',
      skill_dir: '/skills/other-skill',
      case: evalCase,
      fingerprint: 'aaaa1111',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, p.id, 'rejected')

    const { deps, sent } = makeDeps()
    handlePostEvalCaseProposal(evalMsg(), deps)

    expect(sent).toHaveLength(1)
  })

  it('a PENDING or APPROVED proposal does not suppress a re-proposal', () => {
    enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: evalCase,
      fingerprint: 'aaaa1111',
      held_out: false,
    })
    const approved = enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: evalCase,
      fingerprint: 'cccc3333',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, approved.id, 'approved')

    expect(isEvalCaseProposalSuppressed(dir, evalMsg())).toBe(false)
    expect(
      isEvalCaseProposalSuppressed(dir, evalMsg({ fingerprint: 'cccc3333' })),
    ).toBe(false)
  })

  it('suppression expires after the rejection TTL', () => {
    const t0 = Date.UTC(2026, 0, 1)
    const p = enqueueEvalCaseProposal(
      dir,
      {
        skill_slug: 'deploy-checklist',
        skill_dir: '/skills/deploy-checklist',
        case: evalCase,
        fingerprint: 'aaaa1111',
        held_out: false,
      },
      { now: () => t0 },
    )
    setEvalCaseProposalStatus(dir, p.id, 'rejected')

    expect(
      isEvalCaseProposalSuppressed(dir, evalMsg(), { now: () => t0 + 1000 }),
    ).toBe(true)
    expect(
      isEvalCaseProposalSuppressed(dir, evalMsg(), {
        now: () => t0 + REJECTION_TTL_MS + 1,
      }),
    ).toBe(false)
  })
})
