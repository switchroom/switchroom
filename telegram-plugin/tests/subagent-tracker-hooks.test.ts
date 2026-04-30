/**
 * Integration tests for the subagent-tracker pretool and posttool hooks.
 *
 * Each test spawns the hook script as a subprocess (mirroring how Claude Code
 * executes hooks), feeds a JSON event on stdin, then reads back the DB to
 * verify the correct row was written / updated.
 *
 * These tests use bun:test + bun:sqlite and must run under Bun:
 *   bun test telegram-plugin/tests/subagent-tracker-hooks.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRETOOL_SCRIPT = join(import.meta.dir, '..', 'hooks', 'subagent-tracker-pretool.mjs')
const POSTTOOL_SCRIPT = join(import.meta.dir, '..', 'hooks', 'subagent-tracker-posttool.mjs')

let tempDir: string
let agentDir: string
let dbPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'subagent-tracker-test-'))
  agentDir = tempDir
  mkdirSync(join(agentDir, 'telegram'), { recursive: true })
  dbPath = join(agentDir, 'telegram', 'registry.db')
})

afterEach(() => {
  try { rmSync(tempDir, { recursive: true }) } catch { /* ignore */ }
})

function runHook(scriptPath: string, event: object, extraEnv: Record<string, string> = {}) {
  // Invoke the hook with the current runtime (bun under `bun test`, node
  // in production), not a hard-coded 'node'. The hook script detects bun
  // and uses bun:sqlite, so it works on CI agents that lack node:sqlite
  // and the sqlite3 CLI.
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: {
      ...process.env,
      SWITCHROOM_AGENT_DIR: agentDir,
      ...extraEnv,
    },
    timeout: 15_000,
  })
  return result
}

function openDb() {
  // bun:sqlite is available at runtime in Bun
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Database } = require('bun:sqlite') as { Database: new (path: string) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
    exec(sql: string): void
  } }
  return new Database(dbPath)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-tracker-pretool', () => {
  it('inserts a running row when tool_name is Agent', () => {
    const event = {
      session_id: 'sess-abc123',
      tool_name: 'Agent',
      tool_use_id: 'toolu_test001',
      tool_input: {
        subagent_type: 'worker',
        description: 'Build the feature',
        run_in_background: false,
      },
    }

    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT * FROM subagents WHERE id = ?').get('toolu_test001') as {
      id: string
      parent_session_id: string
      agent_type: string
      description: string
      background: number
      status: string
      started_at: number
      last_activity_at: number
    } | undefined

    expect(row).toBeDefined()
    expect(row!.id).toBe('toolu_test001')
    expect(row!.parent_session_id).toBe('sess-abc123')
    expect(row!.agent_type).toBe('worker')
    expect(row!.description).toBe('Build the feature')
    expect(row!.background).toBe(0)
    expect(row!.status).toBe('running')
    expect(row!.started_at).toBeGreaterThan(0)
    expect(row!.last_activity_at).toBe(row!.started_at)
  })

  it('does not write a row when tool_name is not Agent', () => {
    const event = {
      session_id: 'sess-abc123',
      tool_name: 'Bash',
      tool_use_id: 'toolu_bash001',
      tool_input: { command: 'ls' },
    }

    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    // DB should not exist (or have no subagents table / rows)
    const dbExists = Bun.file(dbPath).size > 0
    if (dbExists) {
      const db = openDb()
      const rows = db.prepare('SELECT * FROM subagents').all()
      expect(rows.length).toBe(0)
    }
    // If DB doesn't exist that's also fine — no row was written
  })
})

describe('subagent-tracker-posttool', () => {
  it('updates the row to completed with result_summary after pretool + posttool', () => {
    // First run the pretool to create the row.
    //
    // Foreground (run_in_background: false) is intentional here:
    // PostToolUse fires on actual completion for foreground agents, so
    // it owns the status transition. For background agents, PostToolUse
    // fires on the launch ACK and the watcher (driven by JSONL
    // turn_end) is the authoritative end signal — see the
    // background-only assertion further below.
    const preEvent = {
      session_id: 'sess-xyz789',
      tool_name: 'Agent',
      tool_use_id: 'toolu_test002',
      tool_input: {
        subagent_type: 'researcher',
        description: 'Research the topic',
        run_in_background: false,
      },
    }
    const preResult = runHook(PRETOOL_SCRIPT, preEvent)
    expect(preResult.status).toBe(0)

    // Verify row exists with status=running
    const db = openDb()
    const beforeRow = db.prepare('SELECT status FROM subagents WHERE id = ?').get('toolu_test002') as
      | { status: string }
      | undefined
    expect(beforeRow?.status).toBe('running')

    // Now run the posttool
    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test002',
      tool_response: {
        result: 'The research is complete. Found 3 relevant papers.',
        is_error: false,
      },
    }
    const postResult = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(postResult.status).toBe(0)

    const afterRow = db.prepare('SELECT * FROM subagents WHERE id = ?').get('toolu_test002') as {
      status: string
      ended_at: number
      result_summary: string
    } | undefined
    expect(afterRow).toBeDefined()
    expect(afterRow!.status).toBe('completed')
    expect(afterRow!.ended_at).toBeGreaterThan(0)
    expect(afterRow!.result_summary).toContain('research is complete')
  })

  it('marks row as failed when is_error is true', () => {
    // Create the row first
    const preEvent = {
      session_id: 'sess-err',
      tool_name: 'Agent',
      tool_use_id: 'toolu_fail001',
      tool_input: { description: 'Failing task' },
    }
    runHook(PRETOOL_SCRIPT, preEvent)

    const postEvent = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_fail001',
      tool_response: {
        is_error: true,
        result: 'Something went wrong',
      },
    }
    const postResult = runHook(POSTTOOL_SCRIPT, postEvent)
    expect(postResult.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT status FROM subagents WHERE id = ?').get('toolu_fail001') as
      | { status: string }
      | undefined
    expect(row?.status).toBe('failed')
  })
})
