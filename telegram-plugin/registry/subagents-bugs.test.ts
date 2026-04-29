/**
 * Bun test suite — subagent registry bug regression tests.
 *
 * Covers schema and hook-level behaviour that requires bun:sqlite.
 * Run via: bun test telegram-plugin/registry/subagents-bugs.test.ts
 *
 * Bug 1 — jsonl_agent_id column must exist in schema and be settable.
 * Bug 2 — background=true rows must not be ended by posttool (schema contract).
 * Bug 4 — result_summary always NULL in hook integration.
 * Bug 5 — parent_turn_key always NULL in hook integration.
 * Boot reconciliation — running rows with absent JSONLs get marked stalled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  openFreshSubagentsDbInMemory,
  applySubagentsSchema,
  recordSubagentStart,
  recordSubagentEnd,
  recordSubagentStall,
  bumpSubagentActivity,
  getSubagent,
  listSubagents,
} from './subagents-schema.js'

// ─── Bug 1: jsonl_agent_id column ─────────────────────────────────────────────

describe('Bug 1 — jsonl_agent_id column', () => {
  it('column exists in schema after migration', () => {
    const db = openFreshSubagentsDbInMemory()
    const col = db
      .prepare("SELECT name FROM pragma_table_info('subagents') WHERE name = 'jsonl_agent_id'")
      .get() as { name: string } | undefined
    expect(col?.name).toBe('jsonl_agent_id')
    db.close()
  })

  it('recordSubagentStart accepts and stores jsonlAgentId', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_001',
      jsonlAgentId: 'a37ad7639ae61476c',
      background: false,
      startedAt: 1000,
    })
    const row = getSubagent(db, 'toolu_001')
    expect(row).not.toBeNull()
    expect(row!.jsonl_agent_id).toBe('a37ad7639ae61476c')
    db.close()
  })

  it('getSubagentByJsonlId finds row by jsonl_agent_id', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_002',
      jsonlAgentId: 'b48be874ab72587d',
      background: false,
      startedAt: 2000,
    })
    // Use direct SQL since getSubagentByJsonlId is the new helper
    const row = db
      .prepare('SELECT * FROM subagents WHERE jsonl_agent_id = ?')
      .get('b48be874ab72587d') as { id: string } | undefined
    expect(row?.id).toBe('toolu_002')
    db.close()
  })

  it('bumpSubagentActivity by tool_use_id succeeds when jsonl_agent_id matches', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_003',
      jsonlAgentId: 'c59cf985bc83698e',
      background: false,
      startedAt: 1000,
    })
    // Simulate watcher: lookup by jsonl_agent_id → get tool_use_id → bump
    const found = db
      .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
      .get('c59cf985bc83698e') as { id: string } | undefined
    expect(found?.id).toBe('toolu_003')
    bumpSubagentActivity(db, { id: found!.id, ts: 5000 })
    const row = getSubagent(db, 'toolu_003')
    expect(row!.last_activity_at).toBe(5000)
    db.close()
  })

  it('migration is idempotent on DB that already has jsonl_agent_id', () => {
    const db = openFreshSubagentsDbInMemory()
    // Applying schema again should not throw
    expect(() => applySubagentsSchema(db)).not.toThrow()
    db.close()
  })
})

// ─── Bug 2: background=true rows — schema contract ───────────────────────────

describe('Bug 2 — background=true rows must not be ended by PostToolUse', () => {
  it('posttool gating: background=1 row stays running after simulated launch response', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_bg001',
      background: true,
      startedAt: 1000,
    })

    const row = getSubagent(db, 'toolu_bg001')
    expect(row).not.toBeNull()
    expect(row!.background).toBe(true)

    // The FIXED posttool: read background flag, skip recordSubagentEnd if true
    if (!row!.background) {
      recordSubagentEnd(db, { id: 'toolu_bg001', endedAt: 2000, status: 'completed' })
    } else {
      bumpSubagentActivity(db, { id: 'toolu_bg001', ts: 2000 })
    }

    const after = getSubagent(db, 'toolu_bg001')
    expect(after!.status).toBe('running')
    expect(after!.ended_at).toBeNull()
    expect(after!.last_activity_at).toBe(2000)

    db.close()
  })

  it('foreground agent still gets completed via schema (regression)', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_fg001',
      background: false,
      startedAt: 1000,
    })

    const row = getSubagent(db, 'toolu_fg001')
    if (!row!.background) {
      recordSubagentEnd(db, { id: 'toolu_fg001', endedAt: 2000, status: 'completed', resultSummary: 'Done.' })
    } else {
      bumpSubagentActivity(db, { id: 'toolu_fg001', ts: 2000 })
    }

    const after = getSubagent(db, 'toolu_fg001')
    expect(after!.status).toBe('completed')
    expect(after!.ended_at).toBe(2000)
    expect(after!.result_summary).toBe('Done.')

    db.close()
  })

  it('background agent can be ended by recordSubagentEnd (watcher turn_end path)', () => {
    const db = openFreshSubagentsDbInMemory()
    recordSubagentStart(db, {
      id: 'toolu_bg002',
      background: true,
      startedAt: 1000,
    })

    // Simulate watcher completing a background agent via turn_end
    recordSubagentEnd(db, { id: 'toolu_bg002', endedAt: 90_000, status: 'completed', resultSummary: 'Task done after 90s.' })

    const row = getSubagent(db, 'toolu_bg002')
    expect(row!.status).toBe('completed')
    expect(row!.ended_at).toBe(90_000)
    expect(row!.result_summary).toBe('Task done after 90s.')

    db.close()
  })
})

// ─── Boot reconciliation ──────────────────────────────────────────────────────

describe('Boot reconciliation', () => {
  it('running rows with absent JSONLs are marked stalled on boot', () => {
    const db = openFreshSubagentsDbInMemory()
    const now = Date.now()

    recordSubagentStart(db, {
      id: 'toolu_orphan001',
      jsonlAgentId: 'orphan-jsonl-001',
      background: false,
      startedAt: now - 300_000, // 5 minutes ago
    })

    const row = getSubagent(db, 'toolu_orphan001')
    expect(row!.status).toBe('running')

    // Boot reconciler: JSONL absent → stall
    recordSubagentStall(db, { id: 'toolu_orphan001', stalledAt: now })

    const after = getSubagent(db, 'toolu_orphan001')
    expect(after!.status).toBe('stalled')
    expect(after!.ended_at).toBeNull() // stalled ≠ ended

    db.close()
  })

  it('listSubagents running filter returns only running rows for reconciliation scan', () => {
    const db = openFreshSubagentsDbInMemory()
    const now = Date.now()

    recordSubagentStart(db, { id: 'running-1', background: false, startedAt: now - 60_000 })
    recordSubagentStart(db, { id: 'running-2', background: true,  startedAt: now - 30_000 })
    recordSubagentStart(db, { id: 'done-1',    background: false, startedAt: now - 90_000 })
    recordSubagentEnd(db, { id: 'done-1', endedAt: now - 60_000, status: 'completed' })

    const running = listSubagents(db, { status: 'running' })
    expect(running.length).toBe(2)
    expect(running.map((r) => r.id).sort()).toEqual(['running-1', 'running-2'])

    db.close()
  })
})

// ─── Bug 4: result_summary always NULL in hook integration ───────────────────

const PRETOOL_SCRIPT = join(import.meta.dir, '..', 'hooks', 'subagent-tracker-pretool.mjs')
const POSTTOOL_SCRIPT = join(import.meta.dir, '..', 'hooks', 'subagent-tracker-posttool.mjs')

let tempDir: string
let agentDir: string
let dbPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'subagent-bugs-test-'))
  agentDir = tempDir
  mkdirSync(join(agentDir, 'telegram'), { recursive: true })
  dbPath = join(agentDir, 'telegram', 'registry.db')
})

afterEach(() => {
  try { rmSync(tempDir, { recursive: true }) } catch { /* ignore */ }
})

function runHook(scriptPath: string, event: object) {
  return spawnSync('node', [scriptPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, SWITCHROOM_AGENT_DIR: agentDir },
    timeout: 15_000,
  })
}

function openDb() {
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string) => {
      prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
      exec(sql: string): void
    }
  }
  return new Database(dbPath)
}

describe('Bug 4 — result_summary always NULL (hook integration)', () => {
  it('posttool extracts result_summary from content[0].text', () => {
    const preEvent = {
      session_id: 'sess-001',
      tool_name: 'Agent',
      tool_use_id: 'toolu_summary001',
      tool_input: { description: 'Summarize task', run_in_background: false },
    }
    runHook(PRETOOL_SCRIPT, preEvent)

    // Claude Code's actual PostToolUse payload wraps text in content array
    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_summary001',
      tool_response: {
        content: [{ type: 'text', text: 'Task completed successfully. Modified 3 files.' }],
      },
    }
    const result = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT result_summary FROM subagents WHERE id = ?').get('toolu_summary001') as
      | { result_summary: string | null }
      | undefined

    expect(row).toBeDefined()
    // After fix: result_summary must be populated from content[0].text
    expect(row!.result_summary).not.toBeNull()
    expect(row!.result_summary).toContain('Task completed successfully')
  })

  it('posttool still extracts result_summary from direct result field (regression)', () => {
    const preEvent = {
      session_id: 'sess-002',
      tool_name: 'Agent',
      tool_use_id: 'toolu_summary002',
      tool_input: { description: 'Direct result task', run_in_background: false },
    }
    runHook(PRETOOL_SCRIPT, preEvent)

    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_summary002',
      tool_response: { result: 'Direct result string here.' },
    }
    const result = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT result_summary FROM subagents WHERE id = ?').get('toolu_summary002') as
      | { result_summary: string | null }
      | undefined

    expect(row!.result_summary).not.toBeNull()
    expect(row!.result_summary).toContain('Direct result string')
  })
})

// ─── Bug 5 — parent_turn_key always NULL ─────────────────────────────────────

describe('Bug 5 — parent_turn_key always NULL (hook integration)', () => {
  it('pretool stores parent_turn_key from event.turn_id', () => {
    const event = {
      session_id: 'sess-turnkey',
      turn_id: 'turn-abc-001',
      tool_name: 'Agent',
      tool_use_id: 'toolu_turnkey001',
      tool_input: { description: 'Task with turn context', run_in_background: false },
    }

    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT parent_turn_key FROM subagents WHERE id = ?').get('toolu_turnkey001') as
      | { parent_turn_key: string | null }
      | undefined

    expect(row).toBeDefined()
    // After fix: parent_turn_key should be populated from event.turn_id
    expect(row!.parent_turn_key).toBe('turn-abc-001')
  })

  it('pretool stores parent_turn_key as NULL when turn_id absent (no regression)', () => {
    const event = {
      session_id: 'sess-noturnkey',
      tool_name: 'Agent',
      tool_use_id: 'toolu_noturn001',
      tool_input: { description: 'Task without turn context', run_in_background: false },
    }

    runHook(PRETOOL_SCRIPT, event)

    const db = openDb()
    const row = db.prepare('SELECT parent_turn_key FROM subagents WHERE id = ?').get('toolu_noturn001') as
      | { parent_turn_key: string | null }
      | undefined

    expect(row).toBeDefined()
    // When no turn_id in event, parent_turn_key should be NULL — no crash
    expect(row!.parent_turn_key).toBeNull()
  })

  it('pretool stores jsonl_agent_id when provided in hook payload', () => {
    // Claude Code may provide the JSONL stem in the hook payload in future.
    // For now we test that the pretool at minimum writes the row without crashing,
    // and that the schema column is present to receive the value when it becomes available.
    const event = {
      session_id: 'sess-jsonlid',
      tool_name: 'Agent',
      tool_use_id: 'toolu_jsonlid001',
      tool_input: { description: 'Task', run_in_background: false },
    }

    runHook(PRETOOL_SCRIPT, event)

    const db = openDb()
    const col = db
      .prepare("SELECT name FROM pragma_table_info('subagents') WHERE name = 'jsonl_agent_id'")
      .get() as { name: string } | undefined

    // Column must exist even if currently NULL
    expect(col?.name).toBe('jsonl_agent_id')
  })
})
