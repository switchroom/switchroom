import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  createHandbackOrphanRecovery,
  formatOrphanEscalation,
} from '../gateway/handback-orphan-recovery.js'
import type { HandbackOrphanEscalation, PreTurnCardRecord } from '../gateway/handback-preturn-signal.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

/**
 * Unit test for the gateway-side EFFECTS of deterministic handback-orphan
 * recovery, extracted out of gateway.ts (switchroom#2996 ratchet). The seam's
 * DECISION logic is covered by `handback-preturn-signal.test.ts`; this file
 * asserts the three effects behave as the seam's contract requires:
 *
 *   - a genuine orphan's card is DELETED (never edited to a user-facing string)
 *   - a delete failure is swallowed, so a reap is never wedged by a Telegram error
 *   - the handback is re-injected through the pending-inbound buffer verbatim
 *   - retry exhaustion emits greppable telemetry, NOT a chat message
 *
 * Uses injected spies + an injected `writeLog`, so it runs identically under
 * vitest and bun (no fake timers, no module mocks).
 */

const record: PreTurnCardRecord = {
  turnKey: 'preturn:chatA:_:1000',
  chatId: 'chatA',
  threadId: 7,
  activityMessageId: 4242,
  startedAt: 1000,
  pinned: false,
}

const escalation: HandbackOrphanEscalation = {
  statusKey: 'chatA:7',
  chatId: 'chatA',
  threadId: 7,
  adoptTurnId: 'turn-abc',
  reinjectCount: 2,
  ageMs: 90_000,
}

function inbound(): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'chatA',
    threadId: 7,
    messageId: 900,
    text: 'worker finished',
    meta: { source: 'subagent_handback', handbackReinjectCount: '1' },
  } as unknown as InboundMessage
}

describe('handback orphan recovery effects', () => {
  it('deletes the frozen pre-turn card with its chat/message/thread identity', async () => {
    const deleteMessage = vi.fn(async () => ({ ok: true }))
    const r = createHandbackOrphanRecovery({
      deleteMessage,
      pushInbound: vi.fn(),
      writeLog: vi.fn(),
    })

    await r.deleteCard(record)

    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage).toHaveBeenCalledWith('chatA', 4242, 7)
  })

  it('swallows a delete failure so the reap is never wedged by a Telegram error', async () => {
    const deleteMessage = vi.fn(async () => {
      throw new Error('message to delete not found')
    })
    const r = createHandbackOrphanRecovery({
      deleteMessage,
      pushInbound: vi.fn(),
      writeLog: vi.fn(),
    })

    await expect(r.deleteCard(record)).resolves.toBeUndefined()
  })

  it('re-injects the orphaned handback verbatim through the pending-inbound buffer', () => {
    const pushInbound = vi.fn()
    const r = createHandbackOrphanRecovery({
      deleteMessage: vi.fn(async () => ({})),
      pushInbound,
      writeLog: vi.fn(),
    })

    const msg = inbound()
    r.reinjectHandback(msg)

    expect(pushInbound).toHaveBeenCalledTimes(1)
    // Same object identity: the seam already stamped the retry counter on
    // `meta`, and this effect must not rebuild or strip the inbound.
    expect(pushInbound.mock.calls[0]?.[0]).toBe(msg)
  })

  it('escalates exhausted retries to telemetry with the fleet-health join keys, not to chat', () => {
    const writeLog = vi.fn()
    const pushInbound = vi.fn()
    const deleteMessage = vi.fn(async () => ({}))
    const r = createHandbackOrphanRecovery({ deleteMessage, pushInbound, writeLog })

    r.escalateOrphan(escalation)

    expect(writeLog).toHaveBeenCalledTimes(1)
    const line = writeLog.mock.calls[0]?.[0] as string
    expect(line).toContain('handback orphan escalation')
    expect(line).toContain('key=chatA:7')
    expect(line).toContain('turnId=turn-abc')
    expect(line).toContain('reinjects=2')
    expect(line).toContain('ageMs=90000')
    expect(line.endsWith('\n')).toBe(true)
    // Escalation is telemetry-only: it must not touch any chat transport.
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(pushInbound).not.toHaveBeenCalled()
  })

  it('formatOrphanEscalation is a single line (one log record, not a multi-line blob)', () => {
    const line = formatOrphanEscalation(escalation)
    expect(line.trimEnd().split('\n')).toHaveLength(1)
  })

  it('the operator-facing "needs a nudge" string is gone from the recovery module', () => {
    const src = readFileSync(new URL('../gateway/handback-orphan-recovery.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('it may need a nudge')
  })
})
