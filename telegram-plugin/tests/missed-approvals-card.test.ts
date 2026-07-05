/**
 * Unit tests for telegram-plugin/gateway/missed-approvals-card.ts (#2862).
 *
 * Pure builders — no gateway. Contract under test:
 *   - parseMissedApprovalCallback round-trips the keyboard's callback_data;
 *   - renderMissedApprovalsDigest lists entries, escapes HTML, and collapses
 *     past the cap to "…and N more";
 *   - buildMissedApprovalRetryInbound pins source='missed_approval_retry',
 *     frames the retry as a QUESTION (never a verdict), and carries the
 *     actions in the text.
 */

import { describe, it, expect } from 'vitest'
import {
  MISSED_APPROVAL_CALLBACK_PREFIX,
  MISSED_APPROVAL_RENDER_CAP,
  renderMissedApprovalsDigest,
  missedApprovalsKeyboard,
  parseMissedApprovalCallback,
  buildMissedApprovalRetryInbound,
} from '../gateway/missed-approvals-card.js'
import type { MissedApproval } from '../gateway/missed-approvals-store.js'

function miss(over: Partial<MissedApproval> = {}): MissedApproval {
  return {
    requestId: 'r',
    toolName: 'mcp__brevo__post',
    action: 'post to Brevo',
    chatId: '-100123',
    threadId: 7,
    timedOutAt: Date.UTC(2026, 6, 4, 23, 2, 0),
    ...over,
  }
}

describe('missed-approvals callback shape', () => {
  it('keyboard emits retry + dismiss callbacks that parse back', () => {
    const kb = missedApprovalsKeyboard('abc123')
    const [[retry, dismiss]] = kb.inline_keyboard
    expect(retry.callback_data).toBe(`${MISSED_APPROVAL_CALLBACK_PREFIX}retry:abc123`)
    expect(dismiss.callback_data).toBe(`${MISSED_APPROVAL_CALLBACK_PREFIX}dismiss:abc123`)
    expect(parseMissedApprovalCallback(retry.callback_data)).toEqual({ action: 'retry', digestId: 'abc123' })
    expect(parseMissedApprovalCallback(dismiss.callback_data)).toEqual({ action: 'dismiss', digestId: 'abc123' })
  })

  it('callback_data stays within Telegram 64-byte limit', () => {
    const kb = missedApprovalsKeyboard('deadbeef')
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })

  it('rejects foreign / malformed callbacks', () => {
    expect(parseMissedApprovalCallback('skprop:approve:x')).toBeNull()
    expect(parseMissedApprovalCallback('missre:bogus:x')).toBeNull()
    expect(parseMissedApprovalCallback('missre:retry:')).toBeNull()
    expect(parseMissedApprovalCallback('missre:retry')).toBeNull()
  })
})

describe('renderMissedApprovalsDigest', () => {
  it('lists each entry with its natural action', () => {
    const text = renderMissedApprovalsDigest([
      miss({ action: 'post to Brevo' }),
      miss({ action: 'send an email' }),
    ])
    expect(text).toContain('Missed approvals while you were away')
    expect(text).toContain('post to Brevo')
    expect(text).toContain('send an email')
    expect(text).not.toContain('…and')
  })

  it('collapses past the cap to "…and N more"', () => {
    const entries = Array.from({ length: MISSED_APPROVAL_RENDER_CAP + 3 }, (_, i) =>
      miss({ requestId: `r${i}`, action: `action ${i}` }),
    )
    const text = renderMissedApprovalsDigest(entries)
    expect(text).toContain('action 0')
    expect(text).toContain(`action ${MISSED_APPROVAL_RENDER_CAP - 1}`)
    // Entry at index == cap must NOT be listed individually.
    expect(text).not.toContain(`action ${MISSED_APPROVAL_RENDER_CAP}`)
    expect(text).toContain('…and 3 more')
  })

  it('escapes HTML in the action text', () => {
    const text = renderMissedApprovalsDigest([miss({ action: 'run: rm <a> & <b>' })])
    expect(text).toContain('rm &lt;a&gt; &amp; &lt;b&gt;')
    expect(text).not.toContain('<a>')
  })

  it('names the agent when provided', () => {
    const text = renderMissedApprovalsDigest([miss()], { agentName: 'marko' })
    expect(text).toContain('marko')
  })
})

describe('buildMissedApprovalRetryInbound', () => {
  it('pins source + origin surface + operator id (single action)', () => {
    const inbound = buildMissedApprovalRetryInbound({
      ctx: { agent: 'marko', chat_id: '-100123', threadId: 7 },
      actions: ['post to Brevo'],
      operatorId: '8201250670',
      nowMs: 123,
    })
    expect(inbound.type).toBe('inbound')
    expect(inbound.chatId).toBe('-100123')
    expect(inbound.threadId).toBe(7)
    expect(inbound.meta.source).toBe('missed_approval_retry')
    expect(inbound.meta.agent).toBe('marko')
    expect(inbound.meta.operator_id).toBe('8201250670')
    expect(inbound.meta.action_count).toBe('1')
    expect(inbound.meta.message_thread_id).toBe('7')
    expect(inbound.text).toContain('post to Brevo')
  })

  it('frames the retry as a QUESTION, never a verdict (no-self-escalation)', () => {
    const inbound = buildMissedApprovalRetryInbound({
      ctx: { agent: 'marko', chat_id: '-100123' },
      actions: ['post to Brevo'],
      operatorId: 'x',
    })
    // It asks the agent to re-attempt; it must NOT approve/deny on the
    // operator's behalf.
    expect(inbound.text.toLowerCase()).toContain('re-attempt')
    expect(inbound.text.toLowerCase()).toContain('approve again')
    expect(inbound.text.toLowerCase()).not.toMatch(/\b(approved|allow(ed)? this|permission granted)\b/)
    // No thread → no thread fields.
    expect(inbound.threadId).toBeUndefined()
    expect(inbound.meta.message_thread_id).toBeUndefined()
  })

  it('lists every action for a multi-miss retry', () => {
    const inbound = buildMissedApprovalRetryInbound({
      ctx: { agent: 'marko', chat_id: '-100123' },
      actions: ['post to Brevo', 'send an email', 'update the CRM'],
      operatorId: 'x',
    })
    expect(inbound.meta.action_count).toBe('3')
    expect(inbound.text).toContain('post to Brevo')
    expect(inbound.text).toContain('send an email')
    expect(inbound.text).toContain('update the CRM')
  })
})
