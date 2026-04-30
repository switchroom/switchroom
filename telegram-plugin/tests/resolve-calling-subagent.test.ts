/**
 * Unit tests for resolveCallingSubagent (issue #305 Option A).
 *
 * The resolver picks which sub-agent's row body should host the
 * progress_update narrative when called from a sub-agent context.
 * Resolution priority:
 *   1. agentIdHint  → exact match on subagents.jsonl_agent_id
 *   2. toolUseIdHint → exact match on subagents.id
 *   3. Heuristic   → most-recently-started running sub-agent in the active turn
 *
 * Tests run against an in-memory bun:sqlite DB with the same schema that
 * production uses (turns + subagents tables). Run via:
 *   bun test telegram-plugin/tests/resolve-calling-subagent.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  openSubagentsDbInMemory,
  recordSubagentStart,
} from '../registry/subagents-schema.js'
import { resolveCallingSubagent } from '../gateway/resolve-calling-subagent.js'

type Db = ReturnType<typeof openSubagentsDbInMemory>

function insertOpenTurn(db: Db, turnKey: string, chatId: string, startedAt: number): void {
  db.prepare(`
    INSERT INTO turns
      (turn_key, chat_id, thread_id, started_at, last_user_msg_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(turnKey, chatId, null, startedAt, 'msg-1', startedAt, startedAt)
}

describe('resolveCallingSubagent', () => {
  let db: Db

  beforeEach(() => {
    db = openSubagentsDbInMemory()
  })

  afterEach(() => {
    db.close()
  })

  it('returns null when db is null', () => {
    const result = resolveCallingSubagent({
      db: null,
      chatId: 'c1',
      agentIdHint: 'jsonl-1',
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })

  it('matches by agentIdHint (jsonl_agent_id)', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_alpha',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-alpha',
      background: false,
      startedAt: 1100,
    })
    recordSubagentStart(db, {
      id: 'toolu_beta',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-beta',
      background: false,
      startedAt: 1200,
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: 'jsonl-alpha',
      toolUseIdHint: null,
    })
    expect(result).toEqual({ agentId: 'jsonl-alpha' })
  })

  it('agentIdHint miss on completed sub-agent does NOT match (only running rows)', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_done',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-done',
      background: false,
      startedAt: 1100,
    })
    // Mark as completed via direct SQL.
    db.prepare("UPDATE subagents SET status = 'completed', ended_at = 2000 WHERE id = ?")
      .run('toolu_done')

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: 'jsonl-done',
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })

  it('matches by toolUseIdHint (subagents.id) when agentIdHint absent', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_via_id',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-via-id',
      background: false,
      startedAt: 1100,
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: 'toolu_via_id',
    })
    expect(result).toEqual({ agentId: 'jsonl-via-id' })
  })

  it('heuristic fallback: returns most-recently-started running sub-agent in active turn', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_old',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-old',
      background: false,
      startedAt: 1100,
    })
    recordSubagentStart(db, {
      id: 'toolu_new',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-new',
      background: false,
      startedAt: 1500, // strictly newer
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: null,
    })
    expect(result).toEqual({ agentId: 'jsonl-new' })
  })

  it('heuristic skips sub-agents without jsonl_agent_id', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_nojson',
      parentTurnKey: 'c1:1',
      jsonlAgentId: null,
      background: false,
      startedAt: 1500,
    })
    recordSubagentStart(db, {
      id: 'toolu_withjson',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-resolved',
      background: false,
      startedAt: 1100,
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: null,
    })
    expect(result).toEqual({ agentId: 'jsonl-resolved' })
  })

  it('heuristic returns null when no active turn exists', () => {
    // Insert an ENDED turn.
    db.prepare(`
      INSERT INTO turns
        (turn_key, chat_id, thread_id, started_at, ended_at, last_user_msg_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('c1:1', 'c1', null, 1000, 2000, 'msg-1', 1000, 2000)
    recordSubagentStart(db, {
      id: 'toolu_orphan',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-orphan',
      background: false,
      startedAt: 1100,
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })

  it('heuristic returns null when no running sub-agents in active turn', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    // No sub-agents inserted.
    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })

  it('heuristic ignores sub-agents from a different chat', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    insertOpenTurn(db, 'c2:1', 'c2', 1000)
    recordSubagentStart(db, {
      id: 'toolu_other',
      parentTurnKey: 'c2:1',
      jsonlAgentId: 'jsonl-other-chat',
      background: false,
      startedAt: 1100,
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: null,
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })

  it('agentIdHint takes priority over toolUseIdHint and heuristic', () => {
    insertOpenTurn(db, 'c1:1', 'c1', 1000)
    recordSubagentStart(db, {
      id: 'toolu_priority',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-priority',
      background: false,
      startedAt: 1100,
    })
    recordSubagentStart(db, {
      id: 'toolu_other',
      parentTurnKey: 'c1:1',
      jsonlAgentId: 'jsonl-other',
      background: false,
      startedAt: 1500, // newer; would win heuristic
    })

    const result = resolveCallingSubagent({
      db,
      chatId: 'c1',
      agentIdHint: 'jsonl-priority',
      toolUseIdHint: 'toolu_other',
    })
    expect(result).toEqual({ agentId: 'jsonl-priority' })
  })

  it('returns null on SQL error (broken db.prepare)', () => {
    const brokenDb = {
      prepare: (): never => {
        throw new Error('boom')
      },
    }
    const result = resolveCallingSubagent({
      db: brokenDb as unknown as Parameters<typeof resolveCallingSubagent>[0]['db'],
      chatId: 'c1',
      agentIdHint: 'whatever',
      toolUseIdHint: null,
    })
    expect(result).toBeNull()
  })
})
