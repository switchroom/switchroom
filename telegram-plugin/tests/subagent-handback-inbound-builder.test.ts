/**
 * Pin the InboundMessage shape the gateway synthesizes when a
 * *background* sub-agent finishes (conversational-pacing beat 4 — the
 * handback). The `meta.source` string is load-bearing: the MCP channel
 * notification wraps it as `<channel source="subagent_handback">`, and
 * the agent prompt's beat 4 keys on exactly that tag. A regression that
 * changes the source string silently breaks the wake-up — the model
 * wouldn't recognise the turn as a handback cue.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSubagentHandbackInbound,
  HANDBACK_RESULT_MAX,
  HANDBACK_DESC_MAX,
} from '../gateway/subagent-handback-inbound-builder.js'

const FIXED_NOW = 1_700_000_000_000

describe('buildSubagentHandbackInbound', () => {
  it('builds a completed-worker handback with the load-bearing meta.source', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '12345',
        taskDescription: 'Refactor the auth module',
        resultText: 'Done — refactored, 4 tests added, all green.',
        outcome: 'completed',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.type).toBe('inbound')
    expect(inbound.chatId).toBe('12345')
    expect(inbound.userId).toBe(0)
    expect(inbound.user).toBe('subagent-watcher')
    expect(inbound.ts).toBe(FIXED_NOW)
    expect(inbound.messageId).toBe(FIXED_NOW)
    // The wake-up contract: bridge renders <channel source="subagent_handback">.
    expect(inbound.meta.source).toBe('subagent_handback')
    expect(inbound.meta.outcome).toBe('completed')
    // Text carries the task, the result, and the beat-4 steer.
    expect(inbound.text).toContain('Refactor the auth module')
    expect(inbound.text).toContain('4 tests added, all green')
    expect(inbound.text).toContain('beat 4')
    expect(inbound.text).toMatch(/synthesise|synthesize/i)
  })

  it('builds a failed-worker handback that steers an honest report', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '99',
        taskDescription: 'Migrate the DB',
        resultText: 'Hit a lock timeout on step 3.',
        outcome: 'failed',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.meta.source).toBe('subagent_handback')
    expect(inbound.meta.outcome).toBe('failed')
    expect(inbound.text).toContain('FAILED')
    expect(inbound.text).toContain('lock timeout on step 3')
    expect(inbound.text).toMatch(/did not complete|did not/i)
  })

  it('tolerates an empty result text (worker emitted no narrative)', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '99',
        taskDescription: 'Quiet task',
        resultText: '',
        outcome: 'completed',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.meta.source).toBe('subagent_handback')
    expect(inbound.text).toContain('left no summary')
    // Still steers a handback even with no result text.
    expect(inbound.text).toContain('beat 4')
  })

  it('caps an over-long result text and description', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '99',
        taskDescription: 'D'.repeat(HANDBACK_DESC_MAX + 500),
        resultText: 'R'.repeat(HANDBACK_RESULT_MAX + 5000),
        outcome: 'completed',
      },
      nowMs: FIXED_NOW,
    })
    // Body stays bounded — cap + the surrounding steer prose, well under
    // Claude Code's hook/context limits.
    expect(inbound.text.length).toBeLessThan(
      HANDBACK_RESULT_MAX + HANDBACK_DESC_MAX + 800,
    )
    expect(inbound.text).toContain('…')
  })

  it('falls back to a placeholder when the description is blank', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: { chatId: '99', taskDescription: '   ', resultText: 'x', outcome: 'completed' },
      nowMs: FIXED_NOW,
    })
    expect(inbound.text).toContain('(no description)')
  })
})
