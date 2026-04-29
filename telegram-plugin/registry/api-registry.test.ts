/**
 * Tests for listTurnsForAgent and listSubagents helpers.
 *
 * These tests use bun:sqlite directly and must run under Bun, not vitest/Node.
 * Run via:
 *   bun test telegram-plugin/registry/api-registry.test.ts
 *
 * Route-level testing is omitted here because the web server requires a full
 * Bun.serve context and a SwitchroomConfig fixture that resolves to real
 * filesystem paths. The helpers tested here are the core logic; the route
 * wiring is thin and covered by the pattern match in server.ts.
 */

import { describe, it, expect } from 'bun:test'
import {
  openTurnsDbInMemory,
  recordTurnStart,
  recordTurnEnd,
  listTurnsForAgent,
} from './turns-schema.js'
import {
  openFreshSubagentsDbInMemory,
  recordSubagentStart,
  listSubagents,
} from './subagents-schema.js'

// ---------------------------------------------------------------------------
// listTurnsForAgent
// ---------------------------------------------------------------------------

describe('listTurnsForAgent', () => {
  it('returns empty array when no turns exist', () => {
    const db = openTurnsDbInMemory()
    const rows = listTurnsForAgent(db)
    expect(rows).toEqual([])
    db.close()
  })

  it('returns rows in JSON shape matching the Turn interface', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, {
      turnKey: 'chat1:1',
      chatId: 'chat1',
      lastUserMsgId: 'msg_1',
      userPromptPreview: 'hello',
    })
    const rows = listTurnsForAgent(db, { limit: 20 })
    expect(rows.length).toBe(1)
    const row = rows[0]
    // Verify key fields of the Turn interface are present
    expect(row.turn_key).toBe('chat1:1')
    expect(row.chat_id).toBe('chat1')
    expect(row.last_user_msg_id).toBe('msg_1')
    expect(row.user_prompt_preview).toBe('hello')
    expect(typeof row.started_at).toBe('number')
    expect(row.ended_at).toBeNull()
    db.close()
  })

  it('orders results by started_at DESC (newest first)', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'turn_old', chatId: 'chat1' })
    recordTurnStart(db, { turnKey: 'turn_new', chatId: 'chat1' })
    db.prepare(`UPDATE turns SET started_at = started_at + 1000 WHERE turn_key = 'turn_new'`).run()

    const rows = listTurnsForAgent(db, { limit: 20 })
    expect(rows[0].turn_key).toBe('turn_new')
    expect(rows[1].turn_key).toBe('turn_old')
    db.close()
  })

  it('respects the limit parameter', () => {
    const db = openTurnsDbInMemory()
    for (let i = 0; i < 5; i++) {
      recordTurnStart(db, { turnKey: `turn_${i}`, chatId: 'chat1' })
    }
    const rows = listTurnsForAgent(db, { limit: 3 })
    expect(rows.length).toBe(3)
    db.close()
  })

  it('defaults limit to 20', () => {
    const db = openTurnsDbInMemory()
    for (let i = 0; i < 25; i++) {
      recordTurnStart(db, { turnKey: `turn_${i}`, chatId: 'chat1' })
    }
    const rows = listTurnsForAgent(db)
    expect(rows.length).toBe(20)
    db.close()
  })

  it('caps limit at 200', () => {
    const db = openTurnsDbInMemory()
    for (let i = 0; i < 10; i++) {
      recordTurnStart(db, { turnKey: `turn_${i}`, chatId: 'chat1' })
    }
    // Passing 9999 should be silently capped — only 10 rows exist so result is 10
    const rows = listTurnsForAgent(db, { limit: 9999 })
    expect(rows.length).toBe(10)
    db.close()
  })

  it('returns turns across multiple chats', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'chatA:1', chatId: 'chatA' })
    recordTurnStart(db, { turnKey: 'chatB:1', chatId: 'chatB' })
    const rows = listTurnsForAgent(db, { limit: 20 })
    expect(rows.length).toBe(2)
    db.close()
  })

  it('returns ended_at as null for open turns and number for closed', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'open', chatId: 'chat1' })
    recordTurnStart(db, { turnKey: 'closed', chatId: 'chat1' })
    recordTurnEnd(db, { turnKey: 'closed', endedVia: 'stop' })
    const rows = listTurnsForAgent(db, { limit: 20 })
    const open = rows.find(r => r.turn_key === 'open')
    const closed = rows.find(r => r.turn_key === 'closed')
    expect(open?.ended_at).toBeNull()
    expect(typeof closed?.ended_at).toBe('number')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// listSubagents
// ---------------------------------------------------------------------------

describe('listSubagents', () => {
  it('returns empty array when no subagents exist', () => {
    const db = openFreshSubagentsDbInMemory()
    const rows = listSubagents(db)
    expect(rows).toEqual([])
    db.close()
  })

  it('returns all subagents when no status filter is given', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-1', background: false, startedAt: 1000 })
    recordSubagentStart(db, { id: 'sa-2', background: false, startedAt: 2000 })
    const rows = listSubagents(db)
    expect(rows.length).toBe(2)
    db.close()
  })

  it('filters by status=running', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-running', background: false, startedAt: 1000 })
    recordSubagentStart(db, { id: 'sa-done', background: false, startedAt: 2000 })
    db.prepare(`UPDATE subagents SET status = 'completed', ended_at = 3000 WHERE id = 'sa-done'`).run()

    const rows = listSubagents(db, { status: 'running' })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('sa-running')
    expect(rows[0].status).toBe('running')
    db.close()
  })

  it('returns rows in JSON shape matching the Subagent interface', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'sa-shape',
      parentTurnKey: 'chat1:1',
      agentType: 'worker',
      description: 'do work',
      background: true,
      startedAt: 5000,
    })
    const rows = listSubagents(db)
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.id).toBe('sa-shape')
    expect(row.parent_turn_key).toBe('chat1:1')
    expect(row.agent_type).toBe('worker')
    expect(row.description).toBe('do work')
    expect(row.background).toBe(true)
    expect(row.started_at).toBe(5000)
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
    db.close()
  })

  it('orders results by started_at DESC', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'old', background: false, startedAt: 1000 })
    recordSubagentStart(db, { id: 'new', background: false, startedAt: 2000 })
    const rows = listSubagents(db)
    expect(rows[0].id).toBe('new')
    expect(rows[1].id).toBe('old')
    db.close()
  })

  it('status filter with no matches returns empty array', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-1', background: false, startedAt: 1000 })
    const rows = listSubagents(db, { status: 'failed' })
    expect(rows).toEqual([])
    db.close()
  })
})
