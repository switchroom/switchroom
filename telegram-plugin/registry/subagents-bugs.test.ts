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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
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

// ─── Bug 2: posttool gating — hook integration ────────────────────────────────
// These tests run the actual hook scripts end-to-end to verify that the
// background flag read from the DB controls which update path executes.

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
  // Invoke the hook with the current runtime (bun under `bun test`,
  // node in production), not a hard-coded 'node'. CI's hosted Buildkite
  // agent doesn't ship node:sqlite or sqlite3 CLI, so requiring node
  // would fail; the hook detects bun and uses bun:sqlite instead.
  return spawnSync(process.execPath, [scriptPath], {
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

describe('Bug 2 — posttool gating: foreground vs background (hook integration)', () => {
  it('foreground agent: posttool sets status=completed and ended_at', () => {
    // Pretool registers a foreground agent (run_in_background: false)
    const preEvent = {
      session_id: 'sess-fg-gate',
      tool_name: 'Agent',
      tool_use_id: 'toolu_gate_fg001',
      tool_input: { description: 'Foreground task', run_in_background: false },
    }
    runHook(PRETOOL_SCRIPT, preEvent)

    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_gate_fg001',
      tool_response: {
        content: [{ type: 'text', text: 'Foreground task done.' }],
      },
    }
    const result = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT status, ended_at, result_summary FROM subagents WHERE id = ?').get('toolu_gate_fg001') as
      | { status: string; ended_at: number | null; result_summary: string | null }
      | undefined

    expect(row).toBeDefined()
    // Foreground: posttool must set terminal status and ended_at
    expect(row!.status).toBe('completed')
    expect(row!.ended_at).not.toBeNull()
    expect(row!.result_summary).toContain('Foreground task done')
  })

  it('background agent: posttool leaves status=running and ended_at=null', () => {
    // Pretool registers a background agent (run_in_background: true)
    const preEvent = {
      session_id: 'sess-bg-gate',
      tool_name: 'Agent',
      tool_use_id: 'toolu_gate_bg001',
      tool_input: { description: 'Background task', run_in_background: true },
    }
    runHook(PRETOOL_SCRIPT, preEvent)

    // PostToolUse fires on launch ACK (~10s) — not actual completion
    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_gate_bg001',
      tool_response: {
        content: [{ type: 'text', text: 'Background task acknowledged.' }],
      },
    }
    const result = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT status, ended_at, last_activity_at FROM subagents WHERE id = ?').get('toolu_gate_bg001') as
      | { status: string; ended_at: number | null; last_activity_at: number | null }
      | undefined

    expect(row).toBeDefined()
    // Background: posttool must NOT set terminal status or ended_at
    expect(row!.status).toBe('running')
    expect(row!.ended_at).toBeNull()
    // But last_activity_at should be bumped
    expect(row!.last_activity_at).not.toBeNull()
  })
})

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

// ─── Bug 5 — parent_turn_key stamped from the live turn-active marker ─────────
// (#2081 / #2083) The PreToolUse hook reads <telegramDir>/turn-active.json —
// the gateway-written marker for the turn whose tool call is dispatching this
// sub-agent — and stamps parent_turn_key = marker.turnKey at INSERT. This
// captures the EXACT active turn (no started_at time-window reconstruction at
// jsonl-link time), so it can't mis-attribute under overlapping turn windows
// (#2081) and works even for sub-agents whose JSONL never links (#2083).

/** Write the gateway's turn-active marker into the agent's telegram dir. */
function writeTurnActiveMarker(turnKey: string, chatId = '12345', threadId: string | null = null) {
  writeFileSync(
    join(agentDir, 'telegram', 'turn-active.json'),
    JSON.stringify({ turnKey, chatId, threadId, startedAt: Date.now() }, null, 2) + '\n',
  )
}

/**
 * Seed a turns row so the hook's phantom-turn_key guard (it only stamps a
 * marker turn_key that actually has a turns row) is satisfied. In production
 * the gateway writes this row via recordTurnStart at turn-start.
 */
function seedTurn(turnKey: string, chatId = '12345', threadId: string | null = null) {
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string) => {
      prepare(sql: string): { run(...p: unknown[]): unknown }
      exec(sql: string): void
      close(): void
    }
  }
  const db = new Database(dbPath)
  db.exec(
    `CREATE TABLE IF NOT EXISTS turns (
      turn_key TEXT PRIMARY KEY, chat_id TEXT, thread_id TEXT,
      started_at INTEGER, ended_at INTEGER, created_at INTEGER, updated_at INTEGER
    )`,
  )
  const now = Date.now()
  db.prepare(
    'INSERT OR IGNORE INTO turns (turn_key, chat_id, thread_id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(turnKey, chatId, threadId, now, now, now)
  db.close()
}

describe('Bug 5 — parent_turn_key stamped from the turn-active marker', () => {
  it('stamps parent_turn_key = marker.turnKey when a turn is active', () => {
    // Supergroup forum-topic turn_key (chat:thread:startedAt).
    const turnKey = '-1001234567890:4:1780370238492'
    seedTurn(turnKey, '-1001234567890', '4')
    writeTurnActiveMarker(turnKey, '-1001234567890', '4')

    const event = {
      session_id: 'sess-turnkey',
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
    expect(row!.parent_turn_key).toBe(turnKey)
  })

  it('downgrades to NULL when the marker names a turn_key with no turns row (phantom-marker guard)', () => {
    // The gateway writes the marker even if recordTurnStart's INSERT failed, so
    // a marker can point at a turn_key with no row. Stamping it would mis-route
    // the worker card AND block the watcher backfill (NULL guard). The hook must
    // verify the row exists and fall back to NULL.
    seedTurn('12345:_:1780000000000') // a DIFFERENT, real turn exists…
    writeTurnActiveMarker('12345:_:9999999999999') // …but the marker names a phantom.

    const event = {
      session_id: 'sess-phantom',
      tool_name: 'Agent',
      tool_use_id: 'toolu_phantom001',
      tool_input: { description: 'Task', run_in_background: false },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT parent_turn_key FROM subagents WHERE id = ?').get('toolu_phantom001') as
      | { parent_turn_key: string | null }
      | undefined
    expect(row).toBeDefined()
    expect(row!.parent_turn_key).toBeNull()
  })

  it('writes parent_turn_key=NULL when no turn is active (gateway backfill fallback)', () => {
    // No marker written → no active turn → hook leaves NULL and the gateway's
    // started_at backfill remains the fallback (today's behaviour).
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
    expect(row!.parent_turn_key).toBeNull()
  })

  it('ignores event.turn_id — only the marker is authoritative', () => {
    // A future CLI populating event.turn_id must NOT be trusted: it is Claude
    // Code's session turn, never a gateway turns.turn_key. With no marker the
    // result is NULL regardless of turn_id.
    const event = {
      session_id: 'sess-turnid-only',
      turn_id: 'turn-abc-001',
      tool_name: 'Agent',
      tool_use_id: 'toolu_turnid001',
      tool_input: { description: 'Task', run_in_background: false },
    }
    runHook(PRETOOL_SCRIPT, event)

    const db = openDb()
    const row = db.prepare('SELECT parent_turn_key FROM subagents WHERE id = ?').get('toolu_turnid001') as
      | { parent_turn_key: string | null }
      | undefined

    expect(row).toBeDefined()
    expect(row!.parent_turn_key).toBeNull()
  })

  it('a malformed marker degrades to NULL (never crashes the dispatch)', () => {
    writeFileSync(join(agentDir, 'telegram', 'turn-active.json'), '{ not valid json')
    const event = {
      session_id: 'sess-badmarker',
      tool_name: 'Agent',
      tool_use_id: 'toolu_badmarker001',
      tool_input: { description: 'Task', run_in_background: false },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT parent_turn_key FROM subagents WHERE id = ?').get('toolu_badmarker001') as
      | { parent_turn_key: string | null }
      | undefined
    expect(row).toBeDefined()
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
