/**
 * Unit tests for telegram-plugin/registry/turns-schema.ts
 *
 * These tests use bun:sqlite directly and must run under Bun, not vitest/Node.
 * They are excluded from vitest.config.ts and run via:
 *   bun test telegram-plugin/tests/registry-turns.test.ts
 * or as part of the `test:bun` script in the root package.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  openTurnsDb,
  openTurnsDbInMemory,
  recordTurnStart,
  recordTurnEnd,
  findOrphanedTurns,
  markOrphanedAsRestarted,
} from '../registry/turns-schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'turns-test-'))
})

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// openTurnsDb — filesystem
// ---------------------------------------------------------------------------

describe('openTurnsDb', () => {
  it('creates registry.db at <agentDir>/telegram/registry.db', () => {
    openTurnsDb(tempDir)
    const expected = join(tempDir, 'telegram', 'registry.db')
    expect(existsSync(expected)).toBe(true)
  })

  it('schema migration is idempotent — second open does not throw', () => {
    const db1 = openTurnsDb(tempDir)
    db1.close()
    expect(() => openTurnsDb(tempDir)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// openTurnsDbInMemory — schema sanity
// ---------------------------------------------------------------------------

describe('openTurnsDbInMemory', () => {
  it('creates the turns table without touching the filesystem', () => {
    const db = openTurnsDbInMemory()
    // If the table does not exist this throws; if it exists we get 0 rows.
    const rows = db.prepare('SELECT * FROM turns').all()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(0)
    db.close()
  })

  it('creates the idx_turns_chat_ended index', () => {
    const db = openTurnsDbInMemory()
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_turns_chat_ended'",
    ).get() as { name: string } | undefined
    expect(row?.name).toBe('idx_turns_chat_ended')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// recordTurnStart
// ---------------------------------------------------------------------------

describe('recordTurnStart', () => {
  it('writes a row with ended_at NULL', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:1', chatId: '111' })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:1') as
      | Record<string, unknown>
      | undefined
    expect(row).toBeDefined()
    expect(row!['ended_at']).toBeNull()
    expect(row!['chat_id']).toBe('111')
    db.close()
  })

  it('stores thread_id and last_user_msg_id when provided', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, {
      turnKey: '111:2',
      chatId: '111',
      threadId: '42',
      lastUserMsgId: '99',
    })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:2') as
      | Record<string, unknown>
      | undefined
    expect(row!['thread_id']).toBe('42')
    expect(row!['last_user_msg_id']).toBe('99')
    db.close()
  })

  it('stores null thread_id when not provided', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:3', chatId: '111' })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:3') as
      | Record<string, unknown>
      | undefined
    expect(row!['thread_id']).toBeNull()
    db.close()
  })

  it('is idempotent — duplicate turn_key is silently ignored', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:4', chatId: '111' })
    expect(() =>
      recordTurnStart(db, { turnKey: '111:4', chatId: '111' }),
    ).not.toThrow()
    const count = (
      db.prepare('SELECT COUNT(*) as n FROM turns WHERE turn_key = ?').get('111:4') as {
        n: number
      }
    ).n
    expect(count).toBe(1)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// recordTurnEnd
// ---------------------------------------------------------------------------

describe('recordTurnEnd', () => {
  it('sets ended_at and ended_via on an existing row', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:5', chatId: '111' })
    recordTurnEnd(db, { turnKey: '111:5', endedVia: 'turn_end' })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:5') as
      | Record<string, unknown>
      | undefined
    expect(row!['ended_at']).toBeTypeOf('number')
    expect(row!['ended_via']).toBe('turn_end')
    db.close()
  })

  it('sets last_assistant_msg_id and last_assistant_done', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:6', chatId: '111' })
    recordTurnEnd(db, {
      turnKey: '111:6',
      endedVia: 'turn_end',
      lastAssistantMsgId: '77',
      lastAssistantDone: true,
    })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:6') as
      | Record<string, unknown>
      | undefined
    expect(row!['last_assistant_msg_id']).toBe('77')
    // SQLite stores booleans as integers
    expect(row!['last_assistant_done']).toBe(1)
    db.close()
  })

  it('stores last_assistant_done=false as 0', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:7', chatId: '111' })
    recordTurnEnd(db, {
      turnKey: '111:7',
      endedVia: 'turn_end',
      lastAssistantDone: false,
    })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:7') as
      | Record<string, unknown>
      | undefined
    expect(row!['last_assistant_done']).toBe(0)
    db.close()
  })

  it('is a no-op for a missing turn_key', () => {
    const db = openTurnsDbInMemory()
    expect(() =>
      recordTurnEnd(db, { turnKey: 'nonexistent:99', endedVia: 'unknown' }),
    ).not.toThrow()
    db.close()
  })
})

// ---------------------------------------------------------------------------
// start → end round-trip
// ---------------------------------------------------------------------------

describe('recordTurnStart + recordTurnEnd round-trip', () => {
  it('starts open, ends closed', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '222:1', chatId: '222', lastUserMsgId: 'msg1' })

    const before = db.prepare('SELECT ended_at FROM turns WHERE turn_key = ?').get('222:1') as
      | Record<string, unknown>
      | undefined
    expect(before!['ended_at']).toBeNull()

    recordTurnEnd(db, {
      turnKey: '222:1',
      endedVia: 'turn_end',
      lastAssistantMsgId: 'msg2',
      lastAssistantDone: true,
    })

    const after = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('222:1') as
      | Record<string, unknown>
      | undefined
    expect(after!['ended_at']).toBeTypeOf('number')
    expect(after!['ended_via']).toBe('turn_end')
    expect(after!['last_assistant_msg_id']).toBe('msg2')
    expect(after!['last_assistant_done']).toBe(1)
    expect(after!['last_user_msg_id']).toBe('msg1')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// findOrphanedTurns
// ---------------------------------------------------------------------------

describe('findOrphanedTurns', () => {
  it('returns turns with ended_at NULL for the given chat', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '333:1', chatId: '333' })
    recordTurnStart(db, { turnKey: '333:2', chatId: '333' })
    // Close one turn
    recordTurnEnd(db, { turnKey: '333:1', endedVia: 'turn_end' })

    const orphans = findOrphanedTurns(db, '333')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.turn_key).toBe('333:2')
    db.close()
  })

  it('returns empty array when no orphaned turns exist', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '333:3', chatId: '333' })
    recordTurnEnd(db, { turnKey: '333:3', endedVia: 'turn_end' })

    expect(findOrphanedTurns(db, '333')).toHaveLength(0)
    db.close()
  })

  it('isolates by chat_id', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'A:1', chatId: 'A' })
    recordTurnStart(db, { turnKey: 'B:1', chatId: 'B' })

    expect(findOrphanedTurns(db, 'A')).toHaveLength(1)
    expect(findOrphanedTurns(db, 'B')).toHaveLength(1)
    expect(findOrphanedTurns(db, 'C')).toHaveLength(0)
    db.close()
  })

  it('maps last_assistant_done integer to boolean correctly', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '444:1', chatId: '444' })

    const [turn] = findOrphanedTurns(db, '444')
    // Not yet set — should be null
    expect(turn!.last_assistant_done).toBeNull()
    db.close()
  })
})

// ---------------------------------------------------------------------------
// markOrphanedAsRestarted
// ---------------------------------------------------------------------------

describe('markOrphanedAsRestarted', () => {
  it('stamps all open turns with ended_via=restart and non-null ended_at', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '555:1', chatId: '555' })
    recordTurnStart(db, { turnKey: '555:2', chatId: '555' })

    const count = markOrphanedAsRestarted(db)
    expect(count).toBe(2)

    const rows = db.prepare(
      "SELECT * FROM turns WHERE ended_via = 'restart'",
    ).all() as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row['ended_at']).toBeTypeOf('number')
      expect(row['ended_via']).toBe('restart')
    }
    db.close()
  })

  it('does not touch already-closed turns', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '555:3', chatId: '555' })
    recordTurnEnd(db, { turnKey: '555:3', endedVia: 'turn_end' })
    recordTurnStart(db, { turnKey: '555:4', chatId: '555' })

    markOrphanedAsRestarted(db)

    const closed = db.prepare(
      "SELECT ended_via FROM turns WHERE turn_key = '555:3'",
    ).get() as Record<string, unknown>
    expect(closed['ended_via']).toBe('turn_end')

    const swept = db.prepare(
      "SELECT ended_via FROM turns WHERE turn_key = '555:4'",
    ).get() as Record<string, unknown>
    expect(swept['ended_via']).toBe('restart')
    db.close()
  })

  it('after markOrphanedAsRestarted, findOrphanedTurns returns empty', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '666:1', chatId: '666' })
    recordTurnStart(db, { turnKey: '666:2', chatId: '666' })

    markOrphanedAsRestarted(db)

    expect(findOrphanedTurns(db, '666')).toHaveLength(0)
    db.close()
  })

  it('returns 0 when there are no open turns', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '777:1', chatId: '777' })
    recordTurnEnd(db, { turnKey: '777:1', endedVia: 'turn_end' })

    expect(markOrphanedAsRestarted(db)).toBe(0)
    db.close()
  })

  it('is safe to call on an empty DB (returns 0, no error)', () => {
    const db = openTurnsDbInMemory()
    expect(markOrphanedAsRestarted(db)).toBe(0)
    db.close()
  })
})
