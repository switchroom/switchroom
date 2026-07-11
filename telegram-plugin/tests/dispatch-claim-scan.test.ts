/**
 * Tests for the #396 dispatch-claim Stop-hook scan logic — the pure
 * `dispatch-claim-scan.mjs` helpers (mirrors the silent-end-scan test
 * style: synthetic JSONL fixtures against a pure function rather than
 * spawning the .mjs subprocess).
 *
 * The defect: a reply that TELLS the user work was dispatched
 * ("Dispatching a worker now") while the turn contains no Agent/Task call
 * and no backgrounded Bash. These assert OUTCOMES (block vs allow), not
 * code paths.
 */

import { describe, it, expect } from 'vitest'
import {
  scanTurnForDispatchClaim,
  replyClaimsDispatch,
  applyRetryBudget,
  turnSignature,
} from '../hooks/dispatch-claim-scan.mjs'

// ── Fixture builders ────────────────────────────────────────────────

const REPLY = 'mcp__switchroom-telegram__reply'

const ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="switchroom-telegram" chat_id="111" message_id="42">fix the bug</channel>',
})

function assistantToolUse(
  name: string,
  input: Record<string, unknown>,
  opts: { isSidechain?: boolean } = {},
) {
  const base: Record<string, unknown> = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  }
  if (opts.isSidechain) base.isSidechain = true
  return JSON.stringify(base)
}

function reply(text: string, opts: { isSidechain?: boolean } = {}) {
  return assistantToolUse(REPLY, { text, chat_id: '111' }, opts)
}

function jsonl(...lines: string[]) {
  return lines.join('\n')
}

// ── (a) claim + no dispatch tool_use → block ────────────────────────

describe('scanTurnForDispatchClaim — narrate-without-execute', () => {
  it('(a) blocks a dispatch claim with no Agent/Task call in the turn', () => {
    const t = jsonl(ENQUEUE, reply('Dispatching a worker now to fix this bug.'))
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('block')
    expect(d.reason).toBe('claim-without-dispatch')
    expect(d.turnSig).toBeTruthy()
  })

  // ── (b) claim + Agent tool_use in turn → allow ────────────────────
  it('(b) allows when the turn actually dispatched an Agent', () => {
    const t = jsonl(
      ENQUEUE,
      reply('Dispatching a worker now to fix this bug.'),
      assistantToolUse('Agent', { subagent_type: 'worker', description: 'fix bug' }),
    )
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('dispatched')
  })

  it('(b2) allows when the dispatch tool is the newer Task name', () => {
    const t = jsonl(
      ENQUEUE,
      reply('Spinning up a researcher to dig into this.'),
      assistantToolUse('Task', { subagent_type: 'researcher' }),
    )
    expect(scanTurnForDispatchClaim(t).decided).toBe('allow')
  })

  // ── (c) claim + backgrounded Bash → allow ─────────────────────────
  it('(c) allows when the turn launched a backgrounded Bash', () => {
    const t = jsonl(
      ENQUEUE,
      reply('Kicking off the build agent in the background.'),
      assistantToolUse('Bash', { command: 'npm run build', run_in_background: true }),
    )
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('dispatched')
  })

  it('(c2) a FOREGROUND Bash does not count as a dispatch', () => {
    const t = jsonl(
      ENQUEUE,
      reply('Dispatching a worker to handle this.'),
      assistantToolUse('Bash', { command: 'ls', run_in_background: false }),
    )
    expect(scanTurnForDispatchClaim(t).decided).toBe('block')
  })

  // ── (d) conditional offer → allow ─────────────────────────────────
  it('(d) allows a conditional offer to dispatch (question)', () => {
    const t = jsonl(ENQUEUE, reply('Want me to dispatch a worker to fix this?'))
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('no-claim')
  })

  it('(d2) allows a conditional "I could spin up a reviewer if you like"', () => {
    const t = jsonl(ENQUEUE, reply('I could spin up a reviewer if you want me to.'))
    expect(scanTurnForDispatchClaim(t).decided).toBe('allow')
  })

  // ── (e) non-dispatch reply → allow ────────────────────────────────
  it('(e) allows an ordinary non-dispatch reply', () => {
    const t = jsonl(ENQUEUE, reply('Here is the answer: the bug is a null deref on line 12.'))
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('no-claim')
  })

  // ── (f) NO_REPLY-only turn → allow ────────────────────────────────
  it('(f) allows a NO_REPLY-only turn', () => {
    const t = jsonl(ENQUEUE, reply('NO_REPLY'))
    expect(scanTurnForDispatchClaim(t).decided).toBe('allow')
  })

  // ── (g) sidechain lines ───────────────────────────────────────────
  it('(g) sidechain Agent lines do NOT count as the parent dispatching', () => {
    // A sub-agent's own Agent tool_use leaks in with isSidechain — it must
    // not satisfy the PARENT's dispatch obligation. Parent reply claims a
    // dispatch, parent itself dispatched nothing → block.
    const t = jsonl(
      ENQUEUE,
      reply('Dispatching a worker now.'),
      assistantToolUse('Agent', { subagent_type: 'worker' }, { isSidechain: true }),
    )
    expect(scanTurnForDispatchClaim(t).decided).toBe('block')
  })

  it('(g2) sidechain replies do NOT count as the parent making a claim', () => {
    // A sub-agent's own reply narrating a dispatch leaks in with
    // isSidechain; the parent made no claim → allow.
    const t = jsonl(
      ENQUEUE,
      reply('Working on the fix directly.'),
      reply('Dispatching a worker to handle the subtask.', { isSidechain: true }),
    )
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('no-claim')
  })

  // ── (i) malformed / missing transcript → allow (fail-open) ────────
  it('(i) fails open on an empty transcript', () => {
    expect(scanTurnForDispatchClaim('').decided).toBe('unknown')
  })

  it('(i2) fails open when no turn-start anchor is present', () => {
    const t = jsonl(reply('Dispatching a worker now.'))
    expect(scanTurnForDispatchClaim(t).decided).toBe('unknown')
  })

  it('(i3) tolerates malformed JSONL lines mixed in', () => {
    const t = jsonl(ENQUEUE, '{ not valid json', reply('Dispatching a worker now.'))
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('block')
  })

  // ── past-tense reference (registry-check substitute) ──────────────
  it('does NOT block a bare past-tense reference to an earlier dispatch', () => {
    const t = jsonl(
      ENQUEUE,
      reply('The worker I dispatched earlier finished; here are its results.'),
    )
    const d = scanTurnForDispatchClaim(t)
    expect(d.decided).toBe('allow')
    expect(d.reason).toBe('no-claim')
  })
})

// ── replyClaimsDispatch unit coverage ───────────────────────────────

describe('replyClaimsDispatch', () => {
  it('matches present/progressive commitments', () => {
    expect(replyClaimsDispatch('Dispatching a worker now.')).toBe(true)
    expect(replyClaimsDispatch("I'll dispatch a reviewer to check this.")).toBe(true)
    expect(replyClaimsDispatch('Spinning up a sub-agent for the research.')).toBe(true)
    expect(replyClaimsDispatch('Kicking off a worker on that task.')).toBe(true)
    expect(replyClaimsDispatch('Delegating this to a researcher.')).toBe(true)
  })

  it('excludes interrogative / conditional sentences', () => {
    expect(replyClaimsDispatch('Want me to dispatch a worker?')).toBe(false)
    expect(replyClaimsDispatch('I could dispatch a reviewer if you like.')).toBe(false)
    expect(replyClaimsDispatch('Should I spin up a worker for this?')).toBe(false)
  })

  it('excludes pure past-tense references', () => {
    expect(replyClaimsDispatch('The worker I dispatched earlier is done.')).toBe(false)
    expect(replyClaimsDispatch('I launched a reviewer last turn.')).toBe(false)
  })

  it('ignores unrelated prose and bare silent markers', () => {
    expect(replyClaimsDispatch('The fix is a null-deref guard on line 12.')).toBe(false)
    expect(replyClaimsDispatch('NO_REPLY')).toBe(false)
    expect(replyClaimsDispatch('')).toBe(false)
  })

  it('scopes conditional exclusion to the sentence carrying the verb', () => {
    // First sentence is a real commitment; a later unrelated question must
    // not amnesty it.
    expect(
      replyClaimsDispatch('Dispatching a worker now. Anything else you need?'),
    ).toBe(true)
  })
})

// ── (h) retry budget: exactly one re-prompt per turn ────────────────

describe('applyRetryBudget — exactly one re-prompt per turn', () => {
  const sig = turnSignature(ENQUEUE)

  it('(h) blocks on the first Stop, then fails open on the second same-turn Stop', () => {
    const first = applyRetryBudget({}, sig, 1)
    expect(first.block).toBe(true)
    expect(first.nextState?.retryCount).toBe(1)
    expect(first.nextState?.turnSig).toBe(sig)

    // Second Stop fire on the SAME turn reads back the persisted state.
    const second = applyRetryBudget(first.nextState, sig, 1)
    expect(second.block).toBe(false)
  })

  it('resets the budget for a genuinely new turn (different signature)', () => {
    const spent = { turnSig: sig, retryCount: 1 }
    const newTurn = applyRetryBudget(spent, turnSignature('a different inbound'), 1)
    expect(newTurn.block).toBe(true)
    expect(newTurn.nextState?.retryCount).toBe(1)
  })

  it('tolerates a null / corrupt prior state', () => {
    expect(applyRetryBudget(null, sig, 1).block).toBe(true)
    expect(applyRetryBudget(undefined, sig, 1).block).toBe(true)
  })
})
