/**
 * Unit tests for telegram-plugin/registry/subagents-schema.ts
 *
 * These tests use bun:sqlite directly and must run under Bun, not vitest/Node.
 * They are excluded from vitest.config.ts and run via:
 *   bun test telegram-plugin/registry/subagents.test.ts
 * or as part of the `test:bun` script in the root package.json.
 *
 * Test plan:
 *   1. Migration on fresh DB — subagents table + indexes exist after schema apply.
 *   2. Migration on #325-shaped DB — subagents added without breaking turns data.
 *   3. start → end happy path — running → completed, ended_at set, result_summary stored.
 *   4. start → stall → end — running → stalled → completed; terminal beats stalled.
 *   5. Duplicate start is a no-op — second recordSubagentStart doesn't overwrite startedAt.
 *   6. End on already-ended row is a no-op — second recordSubagentEnd doesn't change result_summary.
 *   7. Index existence — query plan uses subagents_turn for filter on parent_turn_key.
 */

import { describe, it, expect } from 'bun:test'
import {
  openSubagentsDbInMemory,
  openFreshSubagentsDbInMemory,
  applySubagentsSchema,
  recordSubagentStart,
  recordSubagentEnd,
  recordSubagentStall,
  bumpSubagentActivity,
  getSubagent,
} from './subagents-schema.js'

// ---------------------------------------------------------------------------
// Test 1 — Migration on fresh DB
// ---------------------------------------------------------------------------

describe('migration on fresh DB', () => {
  it('creates the subagents table', () => {
    const db = openFreshSubagentsDbInMemory()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagents'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('subagents')
    db.close()
  })

  it('creates the subagents_turn index', () => {
    const db = openFreshSubagentsDbInMemory()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='subagents_turn'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('subagents_turn')
    db.close()
  })

  it('creates the subagents_status index', () => {
    const db = openFreshSubagentsDbInMemory()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='subagents_status'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('subagents_status')
    db.close()
  })

  it('schema is idempotent — applying twice does not throw', () => {
    const db = openFreshSubagentsDbInMemory()
    expect(() => applySubagentsSchema(db)).not.toThrow()
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 2 — Migration on #325-shaped DB (has turns table, no subagents)
// ---------------------------------------------------------------------------

describe('migration on #325-shaped DB', () => {
  it('adds subagents table without disturbing existing turns data', () => {
    // openSubagentsDbInMemory sets up turns table first (like a #325 DB),
    // then applies subagents schema on top.
    const db = openSubagentsDbInMemory()

    // Verify both tables are present
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('turns')
    expect(names).toContain('subagents')
    db.close()
  })

  it('existing turns rows survive the subagents migration', () => {
    const db = openSubagentsDbInMemory()
    const now = Date.now()

    // Insert a turns row manually (same shape as recordTurnStart)
    db.prepare(`
      INSERT INTO turns
        (turn_key, chat_id, thread_id, started_at, last_user_msg_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('chat1:1', 'chat1', null, now, 'msg1', now, now)

    // Re-apply subagents schema (migration step)
    applySubagentsSchema(db)

    // Turns row must still be intact
    const row = db
      .prepare('SELECT * FROM turns WHERE turn_key = ?')
      .get('chat1:1') as Record<string, unknown> | undefined
    expect(row).toBeDefined()
    expect(row!['chat_id']).toBe('chat1')
    expect(row!['last_user_msg_id']).toBe('msg1')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 3 — start → end happy path
// ---------------------------------------------------------------------------

describe('recordSubagentStart + recordSubagentEnd happy path', () => {
  it('inserts a row with status=running', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'sa-001',
      parentSessionId: 'sess-A',
      parentTurnKey: 'chat1:1',
      agentType: 'worker',
      description: 'do the thing',
      background: false,
      startedAt: 1000,
    })
    const row = getSubagent(db, 'sa-001')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('running')
    expect(row!.ended_at).toBeNull()
    expect(row!.result_summary).toBeNull()
    expect(row!.background).toBe(false)
    expect(row!.started_at).toBe(1000)
    expect(row!.last_activity_at).toBe(1000)
    db.close()
  })

  it('transitions to completed with non-null ended_at and result_summary', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-002', background: false, startedAt: 1000 })
    recordSubagentEnd(db, {
      id: 'sa-002',
      endedAt: 2000,
      status: 'completed',
      resultSummary: 'All done.',
    })
    const row = getSubagent(db, 'sa-002')
    expect(row!.status).toBe('completed')
    expect(row!.ended_at).toBe(2000)
    expect(row!.result_summary).toBe('All done.')
    db.close()
  })

  it('transitions to failed', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-003', background: false, startedAt: 1000 })
    recordSubagentEnd(db, {
      id: 'sa-003',
      endedAt: 2000,
      status: 'failed',
      resultSummary: 'Exploded.',
    })
    const row = getSubagent(db, 'sa-003')
    expect(row!.status).toBe('failed')
    expect(row!.ended_at).toBe(2000)
    expect(row!.result_summary).toBe('Exploded.')
    db.close()
  })

  it('sets background=1 in DB when background is true', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-bg', background: true, startedAt: 5000 })
    const row = getSubagent(db, 'sa-bg')
    expect(row!.background).toBe(true)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 4 — start → stall → end
// ---------------------------------------------------------------------------

describe('start → stall → end', () => {
  it('goes running → stalled without ended_at', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-004', background: false, startedAt: 1000 })
    recordSubagentStall(db, { id: 'sa-004', stalledAt: 1500 })
    const row = getSubagent(db, 'sa-004')
    expect(row!.status).toBe('stalled')
    expect(row!.ended_at).toBeNull()
    db.close()
  })

  it('completes from stalled — final status is completed', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-005', background: false, startedAt: 1000 })
    recordSubagentStall(db, { id: 'sa-005', stalledAt: 1500 })
    recordSubagentEnd(db, { id: 'sa-005', endedAt: 3000, status: 'completed', resultSummary: 'Resumed and finished.' })
    const row = getSubagent(db, 'sa-005')
    expect(row!.status).toBe('completed')
    expect(row!.ended_at).toBe(3000)
    expect(row!.result_summary).toBe('Resumed and finished.')
    db.close()
  })

  it('stall is a no-op on already-completed row', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-006', background: false, startedAt: 1000 })
    recordSubagentEnd(db, { id: 'sa-006', endedAt: 2000, status: 'completed' })
    recordSubagentStall(db, { id: 'sa-006', stalledAt: 9999 })
    const row = getSubagent(db, 'sa-006')
    expect(row!.status).toBe('completed')
    expect(row!.ended_at).toBe(2000)
    db.close()
  })

  it('stall is a no-op on already-failed row', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-007', background: false, startedAt: 1000 })
    recordSubagentEnd(db, { id: 'sa-007', endedAt: 2000, status: 'failed' })
    recordSubagentStall(db, { id: 'sa-007', stalledAt: 9999 })
    const row = getSubagent(db, 'sa-007')
    expect(row!.status).toBe('failed')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 5 — Duplicate start is a no-op
// ---------------------------------------------------------------------------

describe('duplicate recordSubagentStart', () => {
  it('second call with same id does not throw', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-dup', background: false, startedAt: 1000 })
    expect(() =>
      recordSubagentStart(db, { id: 'sa-dup', background: true, startedAt: 9999 }),
    ).not.toThrow()
    db.close()
  })

  it('second call does not overwrite startedAt', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-dup2', background: false, startedAt: 1000 })
    recordSubagentStart(db, { id: 'sa-dup2', background: false, startedAt: 9999 })
    const row = getSubagent(db, 'sa-dup2')
    expect(row!.started_at).toBe(1000)
    db.close()
  })

  it('exactly one row exists after two starts', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-dup3', background: false, startedAt: 1000 })
    recordSubagentStart(db, { id: 'sa-dup3', background: false, startedAt: 9999 })
    const count = (
      db
        .prepare('SELECT COUNT(*) as n FROM subagents WHERE id = ?')
        .get('sa-dup3') as { n: number }
    ).n
    expect(count).toBe(1)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 6 — End on already-ended row is a no-op
// ---------------------------------------------------------------------------

describe('recordSubagentEnd idempotency', () => {
  it('second end call does not change result_summary', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-end2', background: false, startedAt: 1000 })
    recordSubagentEnd(db, { id: 'sa-end2', endedAt: 2000, status: 'completed', resultSummary: 'First result.' })
    recordSubagentEnd(db, { id: 'sa-end2', endedAt: 3000, status: 'completed', resultSummary: 'Overwrite attempt.' })
    const row = getSubagent(db, 'sa-end2')
    expect(row!.result_summary).toBe('First result.')
    expect(row!.ended_at).toBe(2000)
    db.close()
  })

  it('failed row cannot be re-ended as completed', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-end3', background: false, startedAt: 1000 })
    recordSubagentEnd(db, { id: 'sa-end3', endedAt: 2000, status: 'failed', resultSummary: 'Error.' })
    recordSubagentEnd(db, { id: 'sa-end3', endedAt: 3000, status: 'completed', resultSummary: 'Overwrite attempt.' })
    const row = getSubagent(db, 'sa-end3')
    expect(row!.status).toBe('failed')
    db.close()
  })

  it('end on unknown id does not throw', () => {
    const db = openFreshSubagentsDbInMemory()
    expect(() =>
      recordSubagentEnd(db, { id: 'nonexistent', endedAt: 1000, status: 'completed' }),
    ).not.toThrow()
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Test 7 — Index existence (query plan uses subagents_turn)
// ---------------------------------------------------------------------------

describe('index existence', () => {
  it('subagents_turn index is used for parent_turn_key filter', () => {
    const db = openFreshSubagentsDbInMemory()

    // Insert a few rows so the planner has something to consider
    for (let i = 0; i < 5; i++) {
      recordSubagentStart(db, {
        id: `sa-idx-${i}`,
        parentTurnKey: i < 3 ? 'turn-A' : 'turn-B',
        background: false,
        startedAt: 1000 + i,
      })
    }

    // EXPLAIN QUERY PLAN returns rows with a 'detail' column describing
    // the chosen access path. We assert the index name appears.
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM subagents WHERE parent_turn_key = ?')
      .all('turn-A') as { detail: string }[]

    const usesIndex = plan.some((p) =>
      typeof p.detail === 'string' && p.detail.toLowerCase().includes('subagents_turn'),
    )
    expect(usesIndex).toBe(true)
    db.close()
  })

  it('subagents_status index exists in sqlite_master', () => {
    const db = openFreshSubagentsDbInMemory()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='subagents_status'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('subagents_status')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// bumpSubagentActivity
// ---------------------------------------------------------------------------

describe('bumpSubagentActivity', () => {
  it('updates last_activity_at', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-bump', background: false, startedAt: 1000 })
    bumpSubagentActivity(db, { id: 'sa-bump', ts: 5000 })
    const row = getSubagent(db, 'sa-bump')
    expect(row!.last_activity_at).toBe(5000)
    db.close()
  })

  it('is safe to call on unknown id (no-op, no throw)', () => {
    const db = openFreshSubagentsDbInMemory()
    expect(() => bumpSubagentActivity(db, { id: 'ghost', ts: 1000 })).not.toThrow()
    db.close()
  })

  it('can be called multiple times monotonically', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, { id: 'sa-mono', background: false, startedAt: 1000 })
    bumpSubagentActivity(db, { id: 'sa-mono', ts: 2000 })
    bumpSubagentActivity(db, { id: 'sa-mono', ts: 3000 })
    bumpSubagentActivity(db, { id: 'sa-mono', ts: 4000 })
    const row = getSubagent(db, 'sa-mono')
    expect(row!.last_activity_at).toBe(4000)
    db.close()
  })
})
