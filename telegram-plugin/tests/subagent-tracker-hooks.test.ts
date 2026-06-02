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

  it('emits a foreground handback nudge for a foreground sub-agent', () => {
    // conversational-pacing beat 4: a FOREGROUND sub-agent's PostToolUse
    // fires at real completion, mid-parent-turn — emit an
    // additionalContext nudge steering the parent to synthesise a
    // handback.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-fg',
      tool_name: 'Agent',
      tool_use_id: 'toolu_fg001',
      tool_input: { description: 'A foreground task', run_in_background: false },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_fg001',
      tool_response: { result: 'Foreground work complete.', is_error: false },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')
    expect(postResult.stdout).toContain('handback')
    expect(postResult.stdout).toContain('PostToolUse')
  })

  it('does NOT emit a handback nudge for a background sub-agent', () => {
    // A background sub-agent's PostToolUse fires on the launch ACK, not
    // on completion — nudging "synthesise the handback" there is wrong.
    // The gateway's subagent-watcher onFinish path owns background.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-bg',
      tool_name: 'Agent',
      tool_use_id: 'toolu_bg001',
      tool_input: { description: 'A background task', run_in_background: true },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_bg001',
      tool_response: { result: 'launched', is_error: false },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).not.toContain('additionalContext')
  })

  it('does NOT emit a handback nudge when SWITCHROOM_SUBAGENT_HANDBACK=0', () => {
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-off',
      tool_name: 'Agent',
      tool_use_id: 'toolu_off001',
      tool_input: { description: 'A foreground task', run_in_background: false },
    })
    const postResult = runHook(
      POSTTOOL_SCRIPT,
      {
        tool_name: 'Agent',
        tool_use_id: 'toolu_off001',
        tool_response: { result: 'done', is_error: false },
      },
      { SWITCHROOM_SUBAGENT_HANDBACK: '0' },
    )
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).not.toContain('additionalContext')
  })

  // The async-launch ACK is Claude Code's verbatim immediate return for a
  // run_in_background Agent/Task dispatch. The posttool trusts it over the
  // pretool's input-derived background flag, which is missing whenever the
  // runtime omits run_in_background from the tool_input the pretool saw
  // (observed on claude-code 2.1.159 — the clerk worker that never surfaced).
  const ASYNC_LAUNCH_ACK =
    'Async agent launched successfully.\n'
    + 'agentId: go-live-sync-a176dc93\n'
    + 'The agent is working in the background. You will be notified '
    + 'automatically when it completes.'

  it('promotes a mis-recorded foreground row to background from the launch ACK', () => {
    // Pretool sees NO run_in_background key (the production bug) → records
    // background=0, status=running.
    const preResult = runHook(PRETOOL_SCRIPT, {
      session_id: 's-promote',
      tool_name: 'Agent',
      tool_use_id: 'toolu_promote1',
      tool_input: { subagent_type: 'worker', description: 'Go-live sync' },
    })
    expect(preResult.status).toBe(0)

    const db = openDb()
    const before = db.prepare('SELECT background, status FROM subagents WHERE id = ?').get('toolu_promote1') as
      | { background: number; status: string }
      | undefined
    expect(before?.background).toBe(0)
    expect(before?.status).toBe('running')

    // Posttool receives the async-launch ACK → promote to background, do NOT
    // terminalize, and do NOT emit a foreground handback nudge.
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_promote1',
      tool_response: { content: [{ type: 'text', text: ASYNC_LAUNCH_ACK }] },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).not.toContain('additionalContext')

    const after = db.prepare('SELECT background, status, ended_at FROM subagents WHERE id = ?').get('toolu_promote1') as
      | { background: number; status: string; ended_at: number | null }
      | undefined
    expect(after?.background).toBe(1)
    expect(after?.status).toBe('running')
    expect(after?.ended_at == null).toBe(true)
  })

  it('still terminalizes a genuine foreground completion (no false promote)', () => {
    // A real foreground sub-agent whose final report happens to mention
    // "background" must NOT be mistaken for a launch ACK — the promote path
    // only fires on the specific async-launch phrasing.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-noflip',
      tool_name: 'Agent',
      tool_use_id: 'toolu_noflip1',
      tool_input: { subagent_type: 'worker', description: 'Real foreground task', run_in_background: false },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_noflip1',
      tool_response: { result: 'Done. The feature now runs as a background job.', is_error: false },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')

    const db = openDb()
    const row = db.prepare('SELECT background, status FROM subagents WHERE id = ?').get('toolu_noflip1') as
      | { background: number; status: string }
      | undefined
    expect(row?.background).toBe(0)
    expect(row?.status).toBe('completed')
  })
})

describe('agent-dir resolution (RFC §Bug 2)', () => {
  // The hooks used to look only at SWITCHROOM_AGENT_DIR and then cwd.
  // In production neither matched the path the gateway + watcher used,
  // so rows were written to a registry.db nobody read. The fix adds
  // TELEGRAM_STATE_DIR (the env var start.sh exports for every agent)
  // as a middle lookup. These tests pin the precedence + the legacy
  // fallback so a future refactor can't silently revert.

  function runWith(scriptPath: string, event: object, env: Record<string, string | undefined>) {
    const finalEnv: Record<string, string> = { ...process.env } as Record<string, string>
    // Clear the inherited overrides; we want a clean baseline.
    delete finalEnv.SWITCHROOM_AGENT_DIR
    delete finalEnv.TELEGRAM_STATE_DIR
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete finalEnv[k]
      else finalEnv[k] = v
    }
    return spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: finalEnv,
      timeout: 15_000,
    })
  }

  const baseEvent = {
    session_id: 's',
    tool_name: 'Agent',
    tool_use_id: 'toolu_envtest1',
    tool_input: { subagent_type: 'w', description: 'd', run_in_background: true },
  }

  it('pretool prefers SWITCHROOM_AGENT_DIR over TELEGRAM_STATE_DIR', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'agent-dir-explicit-'))
    const stateDirParent = mkdtempSync(join(tmpdir(), 'state-dir-parent-'))
    mkdirSync(join(explicit, 'telegram'), { recursive: true })
    mkdirSync(join(stateDirParent, 'telegram'), { recursive: true })
    try {
      const result = runWith(PRETOOL_SCRIPT, baseEvent, {
        SWITCHROOM_AGENT_DIR: explicit,
        TELEGRAM_STATE_DIR: join(stateDirParent, 'telegram'),
      })
      expect(result.status).toBe(0)
      // Row landed in the EXPLICIT location, not the state-dir-derived one.
      const explicitDb = join(explicit, 'telegram', 'registry.db')
      const stateDirDb = join(stateDirParent, 'telegram', 'registry.db')
      expect(Bun.file(explicitDb).size).toBeGreaterThan(0)
      expect(Bun.file(stateDirDb).size).toBe(0)
    } finally {
      try { rmSync(explicit, { recursive: true }) } catch { /* */ }
      try { rmSync(stateDirParent, { recursive: true }) } catch { /* */ }
    }
  })

  it('pretool derives agentDir from TELEGRAM_STATE_DIR when SWITCHROOM_AGENT_DIR is unset (the production path)', () => {
    const stateDirParent = mkdtempSync(join(tmpdir(), 'state-dir-only-'))
    mkdirSync(join(stateDirParent, 'telegram'), { recursive: true })
    try {
      const result = runWith(PRETOOL_SCRIPT, baseEvent, {
        TELEGRAM_STATE_DIR: join(stateDirParent, 'telegram'),
      })
      expect(result.status).toBe(0)
      const dbPath = join(stateDirParent, 'telegram', 'registry.db')
      expect(Bun.file(dbPath).size).toBeGreaterThan(0)
      // Row landed in the state-dir-derived location.
      const { Database } = require('bun:sqlite') as { Database: new (p: string) => {
        prepare(sql: string): { get(...params: unknown[]): unknown }
      } }
      const db = new Database(dbPath)
      const row = db.prepare('SELECT id FROM subagents WHERE id = ?').get('toolu_envtest1') as
        | { id: string } | undefined
      expect(row?.id).toBe('toolu_envtest1')
    } finally {
      try { rmSync(stateDirParent, { recursive: true }) } catch { /* */ }
    }
  })

  it('pretool ignores TELEGRAM_STATE_DIR that does NOT end in /telegram (defensive)', () => {
    // If TELEGRAM_STATE_DIR ever drifts to a non-canonical shape, the
    // hook should NOT silently use it — falling through to cwd is the
    // safer behaviour (you'll notice the wrong location quickly).
    const weirdDir = mkdtempSync(join(tmpdir(), 'state-dir-weird-'))
    const cwdDir = mkdtempSync(join(tmpdir(), 'cwd-dir-'))
    mkdirSync(join(cwdDir, 'telegram'), { recursive: true })
    try {
      const result = spawnSync(process.execPath, [PRETOOL_SCRIPT], {
        input: JSON.stringify(baseEvent),
        encoding: 'utf8',
        cwd: cwdDir,
        env: {
          ...process.env,
          SWITCHROOM_AGENT_DIR: undefined as unknown as string,
          TELEGRAM_STATE_DIR: weirdDir, // does NOT end in /telegram
        } as Record<string, string>,
        timeout: 15_000,
      })
      expect(result.status).toBe(0)
      // Fell through to cwd, NOT the weird TELEGRAM_STATE_DIR.
      const cwdDb = join(cwdDir, 'telegram', 'registry.db')
      expect(Bun.file(cwdDb).size).toBeGreaterThan(0)
    } finally {
      try { rmSync(weirdDir, { recursive: true }) } catch { /* */ }
      try { rmSync(cwdDir, { recursive: true }) } catch { /* */ }
    }
  })
})
