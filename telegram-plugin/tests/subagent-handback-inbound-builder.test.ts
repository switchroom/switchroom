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
    // #3268 — the fabricated ts rounds-trips through meta.message_id (the only
    // channel-rendered id) so enqueue's deriveTurnId matches the pre-turn seam's
    // adopt id. Must equal the top-level messageId as a string.
    expect(inbound.meta.message_id).toBe(String(FIXED_NOW))
    expect(inbound.meta.message_id).toBe(String(inbound.messageId))
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

  it('carries meta.subagent_jsonl_id when jsonlAgentId is provided (#1719 dedup key)', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '12345',
        taskDescription: 'x',
        resultText: 'y',
        outcome: 'completed',
        jsonlAgentId: 'jsonl-xyz',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.meta.subagent_jsonl_id).toBe('jsonl-xyz')
  })

  it('omits meta.subagent_jsonl_id when jsonlAgentId is not provided (back-compat)', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: { chatId: '12345', taskDescription: 'x', resultText: 'y', outcome: 'completed' },
      nowMs: FIXED_NOW,
    })
    expect(inbound.meta.subagent_jsonl_id).toBeUndefined()
  })

  it('falls back to a placeholder when the description is blank', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: { chatId: '99', taskDescription: '   ', resultText: 'x', outcome: 'completed' },
      nowMs: FIXED_NOW,
    })
    expect(inbound.text).toContain('(no description)')
  })

  // Supergroup topic routing (#status-channel-routing). The handback turn
  // and the model's in-voice reply must land in the topic the work was
  // dispatched from — not the chat's last-seen topic. The carriers are the
  // top-level threadId (→ turn.sessionThreadId, routes the activity feed)
  // and meta.message_thread_id (the model-visible channel attribute,
  // mirrors the real-inbound shape at gateway.ts:10557).
  it('carries top-level threadId AND meta.message_thread_id when ctx.threadId is set', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '-1001234567890',
        threadId: 42,
        taskDescription: 'Research competitors',
        resultText: 'Found 3 relevant comps.',
        outcome: 'completed',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.threadId).toBe(42)
    expect(inbound.meta.message_thread_id).toBe('42')
  })

  it('omits both thread carriers when ctx.threadId is absent (DM-shaped chat)', () => {
    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '12345',
        taskDescription: 'x',
        resultText: 'y',
        outcome: 'completed',
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.threadId).toBeUndefined()
    expect(inbound.meta.message_thread_id).toBeUndefined()
  })
})
