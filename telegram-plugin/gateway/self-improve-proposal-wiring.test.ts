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
  InboundMessage,
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

function makeDeps(): {
  deps: ProposalWiringDeps
  sent: string[]
  woken: Array<{ agent: string; inbound: InboundMessage }>
} {
  const sent: string[] = []
  const woken: Array<{ agent: string; inbound: InboundMessage }> = []
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
    deliverResumeSyntheticOrBuffer: (agent, inbound) => {
      woken.push({ agent, inbound })
      return true
    },
  }
  return { deps, sent, woken }
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

  // ── the suppressed exit must not be SILENT (cross-PR #4662 + #4664) ──
  //
  // #4662 makes the agent's contract "propose, end your turn, wait for the
  // outcome inbound". This branch posts no card, so without a wake-up the agent
  // waits forever — the exact silent block #4662 exists to eliminate. Remove the
  // `deliverResumeSyntheticOrBuffer` call in the suppressed branch and this test
  // fails with `woken` empty: the agent is left with no outcome.

  it('a suppressed eval case still WAKES the agent — the silent exit is the bug', () => {
    const p = enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: evalCase,
      fingerprint: 'aaaa1111',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, p.id, 'rejected')

    const { deps, sent, woken } = makeDeps()
    handlePostEvalCaseProposal(evalMsg({ threadId: 7 }), deps)

    // No card — that part is unchanged.
    expect(sent).toEqual([])
    // But the agent is TOLD, exactly once, and routed back to its own topic.
    expect(woken).toHaveLength(1)
    expect(woken[0]!.agent).toBe('carrie')
    expect(woken[0]!.inbound.meta.source).toBe('eval_case_suppressed')
    expect(woken[0]!.inbound.meta.skill_slug).toBe('deploy-checklist')
    expect(woken[0]!.inbound.meta.fingerprint).toBe('aaaa1111')
    expect(woken[0]!.inbound.threadId).toBe(7)
    expect(woken[0]!.inbound.meta.message_thread_id).toBe('7')
    // The instruction that keeps the agent from waiting or retrying.
    expect(woken[0]!.inbound.text).toContain('do NOT wait')
    expect(woken[0]!.inbound.text).toContain('Do NOT re-propose')
    // Suppression is the system working, not a failure — an agent told only
    // "no card" would reasonably retry, which is the loop this PR removes.
    expect(woken[0]!.inbound.text).toContain('EXPECTED')
  })

  it('a NORMAL (unsuppressed) proposal posts a card and does NOT wake the agent', () => {
    const { deps, sent, woken } = makeDeps()
    handlePostEvalCaseProposal(evalMsg(), deps)

    // Proves the wake above is specific to the suppressed branch, not something
    // this handler does on every call.
    expect(sent).toHaveLength(1)
    expect(woken).toEqual([])
  })

  it('never suppresses on an empty fingerprint — it carries no identity', () => {
    // A stored rejection with an empty fingerprint must not swallow a later
    // proposal that also lacks one: two different cases, no shared identity.
    const p = enqueueEvalCaseProposal(dir, {
      skill_slug: 'deploy-checklist',
      skill_dir: '/skills/deploy-checklist',
      case: evalCase,
      fingerprint: '',
      held_out: false,
    })
    setEvalCaseProposalStatus(dir, p.id, 'rejected')

    expect(
      isEvalCaseProposalSuppressed(dir, {
        skillSlug: 'deploy-checklist',
        fingerprint: '',
      }),
    ).toBe(false)

    // …and the handler still posts the card rather than silently dropping it.
    const { deps, sent } = makeDeps()
    handlePostEvalCaseProposal(evalMsg({ fingerprint: '' }), deps)
    expect(sent).toHaveLength(1)
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
