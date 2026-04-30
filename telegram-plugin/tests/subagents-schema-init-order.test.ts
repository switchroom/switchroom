/**
 * Regression test for the subagents-schema init-order bug.
 *
 * The bug: SUBAGENTS_SCHEMA_SQL contained
 * `CREATE INDEX IF NOT EXISTS subagents_jsonl_id ON subagents(jsonl_agent_id)`
 * — but on a pre-existing `subagents` table that was created before the
 * `jsonl_agent_id` column was introduced, `CREATE TABLE IF NOT EXISTS` is a
 * no-op, so the column doesn't exist when the index is created → SQLite
 * throws "no such column: jsonl_agent_id" and the entire schema-apply
 * aborts before the ALTER TABLE migration block can add the column.
 *
 * Symptom in production: gateways with pre-#341 DBs logged
 * `turn-registry init failed (no such column: jsonl_agent_id) — turn
 * tracking disabled` on every restart, even though they were running
 * source that contained the migration.
 *
 * Fix: split the index creation OUT of SUBAGENTS_SCHEMA_SQL and into the
 * migration function, AFTER the ALTER TABLE.
 *
 * Uses `bun:sqlite` directly so it must run under Bun, not vitest/Node.
 * Excluded from vitest.config.ts; runs via `bun test` (CI :telegram: step).
 */
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applySubagentsSchema } from '../registry/subagents-schema.js'

describe('applySubagentsSchema init-order', () => {
  it('migrates a pre-existing subagents table missing jsonl_agent_id', () => {
    const db = new Database(':memory:')

    // Simulate a DB created before #341 — the table exists but no
    // jsonl_agent_id column. (Mirrors the live state of clerk/klanker/finn
    // on 2026-04-30 before this fix.)
    db.exec(`
      CREATE TABLE subagents (
        id                TEXT    PRIMARY KEY,
        parent_session_id TEXT,
        parent_turn_key   TEXT,
        agent_type        TEXT,
        description       TEXT,
        background        INTEGER NOT NULL,
        started_at        INTEGER NOT NULL,
        last_activity_at  INTEGER,
        ended_at          INTEGER,
        status            TEXT    NOT NULL,
        result_summary    TEXT
      );
    `)

    // Pre-fix: this throws "no such column: jsonl_agent_id".
    // Post-fix: schema apply runs to completion, ALTER adds the column,
    // and the index is created.
    expect(() => applySubagentsSchema(db)).not.toThrow()

    const cols = db
      .prepare("SELECT name FROM pragma_table_info('subagents')")
      .all() as { name: string }[]
    expect(cols.some((c) => c.name === 'jsonl_agent_id')).toBe(true)

    // Index landed too — confirm via sqlite_master so future regressions
    // (e.g. if the index is moved out of the migration path) are caught.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'subagents'")
      .all() as { name: string }[]
    expect(indexes.map((r) => r.name)).toContain('subagents_jsonl_id')
  })

  it('is idempotent on a fresh DB (column was never missing)', () => {
    const db = new Database(':memory:')
    applySubagentsSchema(db)
    // Second call must not throw — both ALTER (skipped) and CREATE INDEX
    // (IF NOT EXISTS) are no-ops here.
    expect(() => applySubagentsSchema(db)).not.toThrow()

    const cols = db
      .prepare("SELECT name FROM pragma_table_info('subagents')")
      .all() as { name: string }[]
    expect(cols.some((c) => c.name === 'jsonl_agent_id')).toBe(true)
  })

  it('is idempotent on a DB that already has the column (no-op migration)', () => {
    const db = new Database(':memory:')
    // Simulate a DB created AFTER #341 but BEFORE this fix — the table
    // exists with the column, but the (broken) old schema-apply may or
    // may not have created the index. Verify both paths converge.
    db.exec(`
      CREATE TABLE subagents (
        id                TEXT    PRIMARY KEY,
        parent_session_id TEXT,
        parent_turn_key   TEXT,
        agent_type        TEXT,
        description       TEXT,
        background        INTEGER NOT NULL,
        started_at        INTEGER NOT NULL,
        last_activity_at  INTEGER,
        ended_at          INTEGER,
        status            TEXT    NOT NULL,
        result_summary    TEXT,
        jsonl_agent_id    TEXT
      );
    `)
    expect(() => applySubagentsSchema(db)).not.toThrow()

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'subagents'")
      .all() as { name: string }[]
    expect(indexes.map((r) => r.name)).toContain('subagents_jsonl_id')
  })
})
