/**
 * Unit tests for telegram-plugin/registry/turns-schema.ts
 *
 * These tests use bun:sqlite directly and must run under Bun, not vitest/Node.
 * They are excluded from vitest.config.ts and run via:
 *   bun test telegram-plugin/registry/turns-schema.test.ts
 * or as part of the `test:bun` script in the root package.json.
 *
 * Test plan:
 *   1. findRecentTurnsForChat — empty DB returns empty array.
 *   2. findRecentTurnsForChat — returns only rows for the requested chatId.
 *   3. findRecentTurnsForChat — orders by started_at DESC.
 *   4. findRecentTurnsForChat — limit param is respected.
 *   5. findRecentTurnsForChat — ended_at is preserved correctly (null vs number).
 */

import { describe, it, expect } from 'bun:test'
import {
  openTurnsDbInMemory,
  recordTurnStart,
  recordTurnEnd,
  findRecentTurnsForChat,
} from './turns-schema.js'

// ---------------------------------------------------------------------------
// Test 1 — empty DB
// ---------------------------------------------------------------------------

describe('findRecentTurnsForChat', () => {
  it('returns empty array when no turns exist for chat', () => {
    const db = openTurnsDbInMemory()
    const rows = findRecentTurnsForChat(db, 'chat_999')
    expect(rows).toEqual([])
    db.close()
  })

  // -------------------------------------------------------------------------
  // Test 2 — cross-chat isolation
  // -------------------------------------------------------------------------

  it('returns only rows for the requested chatId', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'turn_a', chatId: 'chat_1' })
    recordTurnStart(db, { turnKey: 'turn_b', chatId: 'chat_2' })
    const rows = findRecentTurnsForChat(db, 'chat_1')
    expect(rows.length).toBe(1)
    expect(rows[0].turn_key).toBe('turn_a')
    db.close()
  })

  // -------------------------------------------------------------------------
  // Test 3 — DESC ordering
  // -------------------------------------------------------------------------

  it('orders rows by started_at DESC so newest is first', () => {
    const db = openTurnsDbInMemory()
    // Insert two turns; recordTurnStart uses Date.now() so they get distinct
    // started_at values in insertion order. We insert turn_old first.
    recordTurnStart(db, { turnKey: 'turn_old', chatId: 'chat_1' })
    // Force a slightly later timestamp by patching the row directly.
    recordTurnStart(db, { turnKey: 'turn_new', chatId: 'chat_1' })
    db.prepare(`UPDATE turns SET started_at = started_at + 1000 WHERE turn_key = 'turn_new'`).run()

    const rows = findRecentTurnsForChat(db, 'chat_1', 2)
    expect(rows[0].turn_key).toBe('turn_new')
    expect(rows[1].turn_key).toBe('turn_old')
    db.close()
  })

  // -------------------------------------------------------------------------
  // Test 4 — limit is respected
  // -------------------------------------------------------------------------

  it('respects the limit parameter', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'turn_1', chatId: 'chat_x' })
    recordTurnStart(db, { turnKey: 'turn_2', chatId: 'chat_x' })
    recordTurnStart(db, { turnKey: 'turn_3', chatId: 'chat_x' })
    const rows = findRecentTurnsForChat(db, 'chat_x', 2)
    expect(rows.length).toBe(2)
    db.close()
  })

  // -------------------------------------------------------------------------
  // Test 5 — ended_at preservation
  // -------------------------------------------------------------------------

  it('returns ended_at as null for running turns and a number for completed turns', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'turn_running', chatId: 'chat_1' })
    recordTurnStart(db, { turnKey: 'turn_done', chatId: 'chat_1' })
    recordTurnEnd(db, { turnKey: 'turn_done', endedVia: 'stop' })

    const rows = findRecentTurnsForChat(db, 'chat_1', 2)
    const running = rows.find(r => r.turn_key === 'turn_running')
    const done = rows.find(r => r.turn_key === 'turn_done')
    expect(running?.ended_at).toBeNull()
    expect(typeof done?.ended_at).toBe('number')
    db.close()
  })
})
