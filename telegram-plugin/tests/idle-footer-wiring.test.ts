/**
 * Integration test for the idle-footer wiring layer.
 *
 * Tests the composed pipeline:
 *   findRecentTurnsForChat → TurnRow mapping → formatIdleFooter
 *
 * These must run under Bun (bun:sqlite). Run via:
 *   bun test telegram-plugin/tests/idle-footer-wiring.test.ts
 */

import { describe, it, expect } from 'bun:test'
import {
  openTurnsDbInMemory,
  recordTurnStart,
  recordTurnEnd,
  findRecentTurnsForChat,
} from '../registry/turns-schema.js'
import { formatIdleFooter, type TurnRow } from '../idle-footer.js'

/** Map Turn rows (from findRecentTurnsForChat) into the TurnRow shape that formatIdleFooter expects. */
function toFooterRows(rows: ReturnType<typeof findRecentTurnsForChat>): TurnRow[] {
  return rows.map(r => ({
    turnKey: r.turn_key,
    chatId: r.chat_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }))
}

describe('idle-footer wiring pipeline', () => {
  it('renders "quiet · no turns yet" when the DB has no turns for the chat', () => {
    const db = openTurnsDbInMemory()
    const rows = findRecentTurnsForChat(db, 'chat_empty')
    const footer = formatIdleFooter(toFooterRows(rows), Date.now())
    expect(footer).toBe('🟡 quiet · no turns yet')
    db.close()
  })

  it('renders "working since" when the most recent turn is still running', () => {
    const db = openTurnsDbInMemory()
    const startedAt = Date.now() - 3 * 60_000 // 3 minutes ago
    recordTurnStart(db, { turnKey: 'turn_live', chatId: 'chat_1' })
    // Backdate started_at so the "ago" formatting is predictable.
    db.prepare(`UPDATE turns SET started_at = ? WHERE turn_key = 'turn_live'`).run(startedAt)

    const rows = findRecentTurnsForChat(db, 'chat_1', 1)
    const footer = formatIdleFooter(toFooterRows(rows), Date.now())
    expect(footer).toContain('⚙️ working since')
    expect(footer).toContain('3m ago')
    db.close()
  })

  it('renders "idle · last reply" when the most recent turn has ended', () => {
    const db = openTurnsDbInMemory()
    const endedAt = Date.now() - 12 * 60_000 // 12 minutes ago
    recordTurnStart(db, { turnKey: 'turn_past', chatId: 'chat_2' })
    recordTurnEnd(db, { turnKey: 'turn_past', endedVia: 'stop' })
    // Backdate ended_at so the "ago" formatting is predictable.
    db.prepare(`UPDATE turns SET ended_at = ? WHERE turn_key = 'turn_past'`).run(endedAt)

    const rows = findRecentTurnsForChat(db, 'chat_2', 1)
    const footer = formatIdleFooter(toFooterRows(rows), Date.now())
    expect(footer).toContain('🟢 idle · last reply')
    expect(footer).toContain('12m ago')
    db.close()
  })

  it('uses the most recently STARTED turn (not most recently ended)', () => {
    const db = openTurnsDbInMemory()
    const now = Date.now()

    // turn_a: started earlier, ended later
    recordTurnStart(db, { turnKey: 'turn_a', chatId: 'chat_3' })
    db.prepare(`UPDATE turns SET started_at = ? WHERE turn_key = 'turn_a'`).run(now - 20 * 60_000)
    recordTurnEnd(db, { turnKey: 'turn_a', endedVia: 'stop' })
    db.prepare(`UPDATE turns SET ended_at = ? WHERE turn_key = 'turn_a'`).run(now - 1 * 60_000)

    // turn_b: started more recently, still running
    recordTurnStart(db, { turnKey: 'turn_b', chatId: 'chat_3' })
    db.prepare(`UPDATE turns SET started_at = ? WHERE turn_key = 'turn_b'`).run(now - 5 * 60_000)

    const rows = findRecentTurnsForChat(db, 'chat_3', 2)
    const footer = formatIdleFooter(toFooterRows(rows), now)
    // turn_b has the larger started_at; its ended_at is null → "working since"
    expect(footer).toContain('⚙️ working since')
    db.close()
  })
})
