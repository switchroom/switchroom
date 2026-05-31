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
  markOrphanedWithTimeoutClassification,
  findLatestTurnIfInterrupted,
} from '../registry/turns-schema.js'

// Convenience: the boot reaper with no live hang marker — every open turn
// is a clean 'restart' interrupt. Mirrors the gateway's between-turns boot.
function reapAsRestart(db: Parameters<typeof findOrphanedTurns>[0]) {
  return markOrphanedWithTimeoutClassification(db, {
    markerTurnKey: null,
    markerAgeMs: null,
    hangThresholdMs: 300_000,
  })
}

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
    recordTurnEnd(db, { turnKey: '111:5', endedVia: 'stop' })
    const row = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('111:5') as
      | Record<string, unknown>
      | undefined
    expect(row!['ended_at']).toBeTypeOf('number')
    expect(row!['ended_via']).toBe('stop')
    db.close()
  })

  it('sets last_assistant_msg_id and last_assistant_done', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '111:6', chatId: '111' })
    recordTurnEnd(db, {
      turnKey: '111:6',
      endedVia: 'stop',
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
      endedVia: 'stop',
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
      endedVia: 'stop',
      lastAssistantMsgId: 'msg2',
      lastAssistantDone: true,
    })

    const after = db.prepare('SELECT * FROM turns WHERE turn_key = ?').get('222:1') as
      | Record<string, unknown>
      | undefined
    expect(after!['ended_at']).toBeTypeOf('number')
    expect(after!['ended_via']).toBe('stop')
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
    recordTurnEnd(db, { turnKey: '333:1', endedVia: 'stop' })

    const orphans = findOrphanedTurns(db, '333')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.turn_key).toBe('333:2')
    db.close()
  })

  it('returns empty array when no orphaned turns exist', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '333:3', chatId: '333' })
    recordTurnEnd(db, { turnKey: '333:3', endedVia: 'stop' })

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
// markOrphanedWithTimeoutClassification — no-hang-marker (clean restart) path
// ---------------------------------------------------------------------------

describe('markOrphanedWithTimeoutClassification (restart path)', () => {
  it('stamps all open turns with ended_via=restart and non-null ended_at', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '555:1', chatId: '555' })
    recordTurnStart(db, { turnKey: '555:2', chatId: '555' })

    const res = reapAsRestart(db)
    expect(res.reaped).toBe(2)
    expect(res.timeoutTurnKey).toBeNull()

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
    recordTurnEnd(db, { turnKey: '555:3', endedVia: 'stop' })
    recordTurnStart(db, { turnKey: '555:4', chatId: '555' })

    reapAsRestart(db)

    const closed = db.prepare(
      "SELECT ended_via FROM turns WHERE turn_key = '555:3'",
    ).get() as Record<string, unknown>
    expect(closed['ended_via']).toBe('stop')

    const swept = db.prepare(
      "SELECT ended_via FROM turns WHERE turn_key = '555:4'",
    ).get() as Record<string, unknown>
    expect(swept['ended_via']).toBe('restart')
    db.close()
  })

  it('after reaping, findOrphanedTurns returns empty', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '666:1', chatId: '666' })
    recordTurnStart(db, { turnKey: '666:2', chatId: '666' })

    reapAsRestart(db)

    expect(findOrphanedTurns(db, '666')).toHaveLength(0)
    db.close()
  })

  it('reaps 0 when there are no open turns', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '777:1', chatId: '777' })
    recordTurnEnd(db, { turnKey: '777:1', endedVia: 'stop' })

    expect(reapAsRestart(db).reaped).toBe(0)
    db.close()
  })

  it('is safe to call on an empty DB (reaps 0, no error)', () => {
    const db = openTurnsDbInMemory()
    expect(reapAsRestart(db).reaped).toBe(0)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// markOrphanedWithTimeoutClassification — hang-marker (timeout) path
// ---------------------------------------------------------------------------

describe('markOrphanedWithTimeoutClassification (timeout path)', () => {
  it('stamps the marker turn timeout when its marker is older than the threshold', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'hang:1', chatId: 'h' })
    recordTurnStart(db, { turnKey: 'live:2', chatId: 'h' })

    const res = markOrphanedWithTimeoutClassification(db, {
      markerTurnKey: 'hang:1',
      markerAgeMs: 600_000, // 10 min > 5 min threshold
      hangThresholdMs: 300_000,
      reasonSnapshot: JSON.stringify({ idleMs: 600_000 }),
    })

    expect(res.timeoutTurnKey).toBe('hang:1')
    expect(res.reaped).toBe(2)

    const hang = db.prepare("SELECT * FROM turns WHERE turn_key = 'hang:1'").get() as Record<string, unknown>
    expect(hang['ended_via']).toBe('timeout')
    expect(hang['interrupt_reason']).toBe(JSON.stringify({ idleMs: 600_000 }))
    // The other open turn is a clean restart.
    const live = db.prepare("SELECT * FROM turns WHERE turn_key = 'live:2'").get() as Record<string, unknown>
    expect(live['ended_via']).toBe('restart')
    db.close()
  })

  it('classifies the marker turn as restart when its marker is younger than the threshold', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'fresh:1', chatId: 'h' })

    const res = markOrphanedWithTimeoutClassification(db, {
      markerTurnKey: 'fresh:1',
      markerAgeMs: 5_000, // 5s — was making progress
      hangThresholdMs: 300_000,
    })

    expect(res.timeoutTurnKey).toBeNull()
    const row = db.prepare("SELECT ended_via FROM turns WHERE turn_key = 'fresh:1'").get() as Record<string, unknown>
    expect(row['ended_via']).toBe('restart')
    db.close()
  })

  it('does not classify timeout when no marker turn key is present (between-turns boot)', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'x:1', chatId: 'h' })
    const res = markOrphanedWithTimeoutClassification(db, {
      markerTurnKey: null,
      markerAgeMs: 999_999,
      hangThresholdMs: 300_000,
    })
    expect(res.timeoutTurnKey).toBeNull()
    db.close()
  })
})

// ---------------------------------------------------------------------------
// findLatestTurnIfInterrupted — keys on the LATEST turn only
// ---------------------------------------------------------------------------

describe('findLatestTurnIfInterrupted', () => {
  it('returns null when no turns exist', () => {
    const db = openTurnsDbInMemory()
    expect(findLatestTurnIfInterrupted(db)).toBeNull()
    db.close()
  })

  it('returns null when the only turn ended cleanly via stop', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '888:1', chatId: '888' })
    recordTurnEnd(db, { turnKey: '888:1', endedVia: 'stop' })
    expect(findLatestTurnIfInterrupted(db)).toBeNull()
    db.close()
  })

  it('returns an open turn (ended_at IS NULL) as interrupted', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: '999:1', chatId: '999', lastUserMsgId: 'msg-1' })
    const t = findLatestTurnIfInterrupted(db)
    expect(t).not.toBeNull()
    expect(t!.turn_key).toBe('999:1')
    expect(t!.last_user_msg_id).toBe('msg-1')
    db.close()
  })

  it('returns a sigterm-stamped turn as interrupted', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'aaa:1', chatId: 'aaa' })
    recordTurnEnd(db, { turnKey: 'aaa:1', endedVia: 'sigterm' })
    const t = findLatestTurnIfInterrupted(db)
    expect(t).not.toBeNull()
    expect(t!.ended_via).toBe('sigterm')
    db.close()
  })

  it('returns a restart-stamped turn as interrupted', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'bbb:1', chatId: 'bbb' })
    recordTurnEnd(db, { turnKey: 'bbb:1', endedVia: 'restart' })
    const t = findLatestTurnIfInterrupted(db)
    expect(t).not.toBeNull()
    expect(t!.ended_via).toBe('restart')
    db.close()
  })

  it('returns a timeout-stamped turn as interrupted', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'tmo:1', chatId: 'tmo' })
    recordTurnEnd(db, { turnKey: 'tmo:1', endedVia: 'timeout' })
    const t = findLatestTurnIfInterrupted(db)
    expect(t).not.toBeNull()
    expect(t!.ended_via).toBe('timeout')
    db.close()
  })

  it('picks the most-recently-started turn (latest), not an older interrupted one', () => {
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'ccc:1', chatId: 'ccc' })
    db.exec(`UPDATE turns SET started_at = 1000 WHERE turn_key = 'ccc:1'`)
    recordTurnStart(db, { turnKey: 'ccc:2', chatId: 'ccc' })
    db.exec(`UPDATE turns SET started_at = 2000 WHERE turn_key = 'ccc:2'`)
    recordTurnEnd(db, { turnKey: 'ccc:1', endedVia: 'restart' })
    recordTurnEnd(db, { turnKey: 'ccc:2', endedVia: 'sigterm' })
    const t = findLatestTurnIfInterrupted(db)
    expect(t).not.toBeNull()
    expect(t!.turn_key).toBe('ccc:2')
    db.close()
  })

  it('a clean latest turn SHADOWS an older interrupted one (returns null)', () => {
    // This is the inverse of the old findMostRecentInterruptedTurn bug: a
    // completed resume (latest turn 'stop') must not resurface the stale
    // interrupted turn on the next restart.
    const db = openTurnsDbInMemory()
    recordTurnStart(db, { turnKey: 'ddd:1', chatId: 'ddd' })
    db.exec(`UPDATE turns SET started_at = 1000 WHERE turn_key = 'ddd:1'`)
    recordTurnStart(db, { turnKey: 'ddd:2', chatId: 'ddd' })
    db.exec(`UPDATE turns SET started_at = 2000 WHERE turn_key = 'ddd:2'`)
    recordTurnEnd(db, { turnKey: 'ddd:1', endedVia: 'sigterm' })
    recordTurnEnd(db, { turnKey: 'ddd:2', endedVia: 'stop' })
    expect(findLatestTurnIfInterrupted(db)).toBeNull()
    db.close()
  })
})
