/**
 * Single-tap correlation auto-resolve for the durable "🔁 Always allow"
 * flow (#1977, security-critical).
 *
 * When the gateway dispatches a `config_propose_edit` to hostd in
 * response to an operator tap, hostd calls back asking for operator
 * approval. The `tryAutoResolve` hook lets the gateway auto-approve
 * THAT (already-operator-tapped) edit WITHOUT posting a second card,
 * while any uncorrelated (e.g. agent-forged) config edit still posts a
 * real operator approval card.
 *
 * These tests pin the handler contract:
 *   - tryAutoResolve → 'approve': sends config_approval_resolved
 *     (verdict: approve), does NOT post a card, creates NO pending
 *     entry, arms NO timer.
 *   - tryAutoResolve → null (forge / normal path): posts the card AND
 *     creates a pending entry (the real human-in-the-loop control).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleRequestConfigApproval,
  _resetPendingConfigApprovalsForTest,
  _peekPendingConfigApprovalForTest,
  type ConfigApprovalHandlerDeps,
} from '../gateway/config-approval-handler.js'
import type { RequestConfigApprovalMessage } from '../gateway/ipc-protocol.js'

function makeMsg(overrides: Partial<RequestConfigApprovalMessage> = {}): RequestConfigApprovalMessage {
  return {
    type: 'request_config_approval',
    requestId: 'req-abc123',
    agentName: 'clerk',
    reason: "Operator 'always allow' for Bash",
    unifiedDiff: [
      '--- a/switchroom.yaml',
      '+++ b/switchroom.yaml',
      '@@ -1,3 +1,4 @@',
      ' agents:',
      '   clerk:',
      '     tools:',
      '+      - Bash',
    ].join('\n'),
    timeoutMs: 600_000,
    ...overrides,
  }
}

interface SentMsg {
  type: string
  requestId?: string
  verdict?: string
  [k: string]: unknown
}

describe('always-allow correlation — auto-resolve path', () => {
  beforeEach(() => {
    _resetPendingConfigApprovalsForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    _resetPendingConfigApprovalsForTest()
  })

  it("tryAutoResolve → 'approve': sends approve verdict, NO card, NO pending entry, NO timer", async () => {
    const sent: SentMsg[] = []
    const postCard = vi.fn(async () => ({ messageId: 42 }))
    const client = { send: (m: SentMsg) => sent.push(m) }
    const msg = makeMsg()
    const deps: ConfigApprovalHandlerDeps = {
      agentName: 'clerk',
      loadTargetChat: () => ({ chatId: 1001 }),
      postCard,
      buildKeyboard: () => ({ inline_keyboard: [] }),
      editCard: async () => {},
      log: () => {},
      tryAutoResolve: () => 'approve',
    }

    await handleRequestConfigApproval(client, msg, deps)

    // Verdict sent — approve.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'config_approval_resolved',
      requestId: 'req-abc123',
      verdict: 'approve',
    })
    // No card posted.
    expect(postCard).not.toHaveBeenCalled()
    // No pending entry created.
    expect(_peekPendingConfigApprovalForTest('req-abc123')).toBeUndefined()
    // No timer armed — advancing past the timeout fires nothing extra.
    vi.advanceTimersByTime(700_000)
    expect(sent).toHaveLength(1)
  })

  it('tryAutoResolve → null (forge / normal path): posts card AND creates a pending entry', async () => {
    const sent: SentMsg[] = []
    const postCard = vi.fn(async () => ({ messageId: 77 }))
    const client = { send: (m: SentMsg) => sent.push(m) }
    const msg = makeMsg({ requestId: 'req-forge99' })
    const deps: ConfigApprovalHandlerDeps = {
      agentName: 'clerk',
      loadTargetChat: () => ({ chatId: 1001 }),
      postCard,
      buildKeyboard: () => ({ inline_keyboard: [] }),
      editCard: async () => {},
      log: () => {},
      tryAutoResolve: () => null,
    }

    await handleRequestConfigApproval(client, msg, deps)

    // Card WAS posted.
    expect(postCard).toHaveBeenCalledTimes(1)
    // A pending entry exists, awaiting the operator tap.
    const entry = _peekPendingConfigApprovalForTest('req-forge99')
    expect(entry).toBeDefined()
    expect(entry?.messageId).toBe(77)
    expect(entry?.resolved).toBe(false)
    // No verdict sent yet — the operator hasn't tapped.
    expect(sent).toHaveLength(0)
  })

  it('no tryAutoResolve dep at all: behaves as the normal card path', async () => {
    const sent: SentMsg[] = []
    const postCard = vi.fn(async () => ({ messageId: 88 }))
    const client = { send: (m: SentMsg) => sent.push(m) }
    const msg = makeMsg({ requestId: 'req-nohook' })
    const deps: ConfigApprovalHandlerDeps = {
      agentName: 'clerk',
      loadTargetChat: () => ({ chatId: 1001 }),
      postCard,
      buildKeyboard: () => ({ inline_keyboard: [] }),
      editCard: async () => {},
      log: () => {},
    }

    await handleRequestConfigApproval(client, msg, deps)

    expect(postCard).toHaveBeenCalledTimes(1)
    expect(_peekPendingConfigApprovalForTest('req-nohook')).toBeDefined()
  })
})
