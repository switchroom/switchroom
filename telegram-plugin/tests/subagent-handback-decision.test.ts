/**
 * Regression coverage for `decideSubagentHandback` — the gate the
 * gateway's subagent-watcher `onFinish` callback runs to decide whether
 * a finished sub-agent gets a handback turn injected.
 *
 * This is the highest-risk surface of the handback feature (#1650): it
 * injects a fresh turn. Before this suite the decision lived inline in
 * the gateway's `onFinish` closure with no automated test — a refactor
 * that broke the `isBackground` gate would have fired handbacks for
 * foreground sub-agents (double messages) with nothing to catch it.
 * The decision is now a pure function; these cases pin every gate.
 */

import { describe, it, expect } from 'vitest'
import { decideSubagentHandback } from '../gateway/subagent-handback-inbound-builder.js'

const FIXED_NOW = 1_700_000_000_000

const base = {
  handbackEnvValue: undefined as string | undefined,
  outcome: 'completed' as 'completed' | 'failed' | 'orphan',
  isBackground: true,
  fleetChatId: '777',
  ownerChatId: '999',
  taskDescription: 'Do the thing',
  resultText: 'Done.',
  nowMs: FIXED_NOW,
}

describe('decideSubagentHandback', () => {
  it('delivers for a background completed sub-agent', () => {
    const d = decideSubagentHandback({ ...base })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('777')
      expect(d.inbound.meta.source).toBe('subagent_handback')
      expect(d.inbound.chatId).toBe('777')
    }
  })

  it('delivers for a background FAILED sub-agent', () => {
    const d = decideSubagentHandback({ ...base, outcome: 'failed' })
    expect(d.deliver).toBe(true)
    if (d.deliver) expect(d.inbound.meta.outcome).toBe('failed')
  })

  it('skips a foreground sub-agent (handed back natively in-turn)', () => {
    const d = decideSubagentHandback({ ...base, isBackground: false })
    expect(d).toEqual({ deliver: false, reason: 'foreground' })
  })

  it("skips an 'orphan' outcome (stale historical-at-boot row)", () => {
    const d = decideSubagentHandback({ ...base, outcome: 'orphan' })
    expect(d).toEqual({ deliver: false, reason: 'outcome-not-terminal' })
  })

  it('skips when the kill-switch is set (SWITCHROOM_SUBAGENT_HANDBACK=0)', () => {
    const d = decideSubagentHandback({ ...base, handbackEnvValue: '0' })
    expect(d).toEqual({ deliver: false, reason: 'env-disabled' })
  })

  it('treats any non-"0" env value (incl. undefined) as enabled', () => {
    expect(decideSubagentHandback({ ...base, handbackEnvValue: undefined }).deliver).toBe(true)
    expect(decideSubagentHandback({ ...base, handbackEnvValue: '1' }).deliver).toBe(true)
    expect(decideSubagentHandback({ ...base, handbackEnvValue: '' }).deliver).toBe(true)
  })

  it('falls back to the owner chat when the fleet entry is gone', () => {
    const d = decideSubagentHandback({ ...base, fleetChatId: '' })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('999')
      expect(d.inbound.chatId).toBe('999')
    }
  })

  it('prefers the fleet chat id over the owner chat when both are present', () => {
    const d = decideSubagentHandback({ ...base, fleetChatId: '777', ownerChatId: '999' })
    expect(d.deliver).toBe(true)
    if (d.deliver) expect(d.chatId).toBe('777')
  })

  it('skips when no chat resolves at all', () => {
    const d = decideSubagentHandback({ ...base, fleetChatId: '', ownerChatId: '' })
    expect(d).toEqual({ deliver: false, reason: 'no-chat' })
  })

  it('gate order: kill-switch wins over every other condition', () => {
    // env-disabled even though it is a deliverable background completion.
    const d = decideSubagentHandback({ ...base, handbackEnvValue: '0', isBackground: true })
    expect(d).toEqual({ deliver: false, reason: 'env-disabled' })
  })

  it('gate order: outcome filter applies before the foreground check', () => {
    // orphan + foreground — outcome filter is checked first.
    const d = decideSubagentHandback({ ...base, outcome: 'orphan', isBackground: false })
    expect(d).toEqual({ deliver: false, reason: 'outcome-not-terminal' })
  })

  it('carries the task description and result text into the inbound', () => {
    const d = decideSubagentHandback({
      ...base,
      taskDescription: 'Migrate the DB',
      resultText: 'Applied 3 migrations, 0 rows dropped.',
    })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.inbound.text).toContain('Migrate the DB')
      expect(d.inbound.text).toContain('Applied 3 migrations')
    }
  })

  // Supergroup topic routing (#status-channel-routing).
  it('threads the inbound to the origin topic when the origin (fleet) chat won', () => {
    const d = decideSubagentHandback({ ...base, fleetChatId: '-100777', originThreadId: 42 })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('-100777')
      expect(d.inbound.threadId).toBe(42)
      expect(d.inbound.meta.message_thread_id).toBe('42')
    }
  })

  it('does NOT thread when falling back to the owner DM (topic-less)', () => {
    // fleetChatId empty → owner DM wins; a stray originThreadId must not
    // be applied to a DM chat that has no topics.
    const d = decideSubagentHandback({ ...base, fleetChatId: '', originThreadId: 42 })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('999')
      expect(d.inbound.threadId).toBeUndefined()
      expect(d.inbound.meta.message_thread_id).toBeUndefined()
    }
  })

  it('omits thread carriers when no originThreadId is supplied (DM-shaped agent)', () => {
    const d = decideSubagentHandback({ ...base, fleetChatId: '777' })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.inbound.threadId).toBeUndefined()
      expect(d.inbound.meta.message_thread_id).toBeUndefined()
    }
  })
})
