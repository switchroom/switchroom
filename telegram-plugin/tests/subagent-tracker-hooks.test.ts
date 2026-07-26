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
import { recordSubagentEnd } from '../registry/subagents-schema.js'

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

  it('persists tool_input.model as the first-paint model on the row', () => {
    const event = {
      session_id: 'sess-model',
      tool_name: 'Agent',
      tool_use_id: 'toolu_model001',
      tool_input: {
        subagent_type: 'worker',
        description: 'Build with a pinned model',
        run_in_background: true,
        model: 'claude-opus-4-8',
      },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT model FROM subagents WHERE id = ?').get('toolu_model001') as
      | { model: string | null }
      | undefined
    expect(row?.model).toBe('claude-opus-4-8')
  })

  it('leaves model null when the Agent dispatch carries no model', () => {
    const event = {
      session_id: 'sess-nomodel',
      tool_name: 'Agent',
      tool_use_id: 'toolu_nomodel001',
      tool_input: { subagent_type: 'worker', description: 'no model', run_in_background: false },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT model FROM subagents WHERE id = ?').get('toolu_nomodel001') as
      | { model: string | null }
      | undefined
    expect(row?.model ?? null).toBeNull()
  })

  // F3 (progress-card fork model): a fork dispatch inherits the parent's model
  // and IGNORES tool_input.model, so seeding the row's first-paint model from
  // that ignored override made the worker card show a WRONG model (e.g. "sonnet"
  // while the fork runs Opus) until the transcript overwrote it. The seed must
  // be suppressed for forks — model stays NULL and the card omits it until the
  // watcher records the real model from the fork's own transcript.
  it('leaves model null for a FORK dispatch even when tool_input.model is set (F3)', () => {
    const event = {
      session_id: 'sess-fork',
      tool_name: 'Agent',
      tool_use_id: 'toolu_fork001',
      tool_input: {
        subagent_type: 'fork',
        description: 'Fork the session',
        run_in_background: true,
        model: 'sonnet', // override a fork ignores — must NOT be persisted
      },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT model FROM subagents WHERE id = ?').get('toolu_fork001') as
      | { model: string | null }
      | undefined
    expect(row?.model ?? null).toBeNull()
  })

  it('still persists tool_input.model for a NON-fork dispatch (fork suppression is scoped)', () => {
    const event = {
      session_id: 'sess-nonfork',
      tool_name: 'Agent',
      tool_use_id: 'toolu_nonfork001',
      tool_input: {
        subagent_type: 'researcher',
        description: 'Research with a pinned model',
        run_in_background: true,
        model: 'claude-opus-4-8',
      },
    }
    const result = runHook(PRETOOL_SCRIPT, event)
    expect(result.status).toBe(0)

    const db = openDb()
    const row = db.prepare('SELECT model FROM subagents WHERE id = ?').get('toolu_nonfork001') as
      | { model: string | null }
      | undefined
    expect(row?.model).toBe('claude-opus-4-8')
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

  // ─── async-launch ACK contract — drift tolerance (#2084) ────────────────────
  // Tier 3 of isAsyncLaunchAck keys on the functional `agentId: <stem>` token
  // (the most wording-stable part of the ACK) so promotion survives a
  // claude-code bump that rewords BOTH the launch verb AND the "working in the
  // background" phrase. The context-word requirement keeps it from tripping on
  // a foreground report that merely mentions an agentId.
  it('promotes on reworded ACK prose when the agentId token + a context word survive', () => {
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-drift',
      tool_name: 'Agent',
      tool_use_id: 'toolu_drift1',
      tool_input: { subagent_type: 'worker', description: 'Drifted ACK' },
    })
    // Neither "async agent launched" nor "working in the background" — a
    // hypothetical reworded ACK — but the agentId token + "background" remain.
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_drift1',
      tool_response: {
        content: [{ type: 'text', text: 'Background worker started.\nagentId: drift-7f3a91\nYou will be notified when it finishes.' }],
      },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).not.toContain('additionalContext')

    const db = openDb()
    const row = db.prepare('SELECT background, status, ended_at FROM subagents WHERE id = ?').get('toolu_drift1') as
      | { background: number; status: string; ended_at: number | null }
      | undefined
    expect(row?.background).toBe(1)
    expect(row?.status).toBe('running')
    expect(row?.ended_at == null).toBe(true)
  })

  it('does NOT promote when an agentId token appears without any launch/background context word', () => {
    // A genuine foreground report mentioning an agentId in passing — no
    // launch/background/async/dispatch word — must terminalize, not promote.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-falsepos',
      tool_name: 'Agent',
      tool_use_id: 'toolu_falsepos1',
      tool_input: { subagent_type: 'worker', description: 'Foreground lookup', run_in_background: false },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_falsepos1',
      tool_response: { result: 'Done. Verified the record; agentId: svc-42 is valid and active.', is_error: false },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')

    const db = openDb()
    const row = db.prepare('SELECT background, status FROM subagents WHERE id = ?').get('toolu_falsepos1') as
      | { background: number; status: string }
      | undefined
    expect(row?.background).toBe(0)
    expect(row?.status).toBe('completed')
  })

  it('does NOT promote a foreground orchestrator narrative that embeds an agentId mid-sentence', () => {
    // The #2085-review false-positive: a coordinator agent reporting on other
    // agents. The agentId is mid-sentence (not on its own line), so tier 3's
    // own-line anchor rejects it even though "background"/"dispatching" appear.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-orch',
      tool_name: 'Agent',
      tool_use_id: 'toolu_orch1',
      tool_input: { subagent_type: 'worker', description: 'Coordinator', run_in_background: false },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_orch1',
      tool_response: { result: 'agentId: coord-x is managing background work and dispatching checks.', is_error: false },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')

    const db = openDb()
    const row = db.prepare('SELECT background, status FROM subagents WHERE id = ?').get('toolu_orch1') as
      | { background: number; status: string }
      | undefined
    expect(row?.background).toBe(0)
    expect(row?.status).toBe('completed')
  })

  it('does NOT promote an own-line agentId with no launch/background context word (boundary)', () => {
    // Documents the accepted tier-3 boundary: an own-line bare agentId alone
    // (no background/launch/dispatch/async/notify word) is not enough to
    // promote — guards a foreground report that prints an id on its own line.
    runHook(PRETOOL_SCRIPT, {
      session_id: 's-bound',
      tool_name: 'Agent',
      tool_use_id: 'toolu_bound1',
      tool_input: { subagent_type: 'worker', description: 'Infra', run_in_background: false },
    })
    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_bound1',
      tool_response: { content: [{ type: 'text', text: 'Created the worker.\nagentId: svc-99\nIt is ready.' }] },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')

    const db = openDb()
    const row = db.prepare('SELECT background, status FROM subagents WHERE id = ?').get('toolu_bound1') as
      | { background: number; status: string }
      | undefined
    expect(row?.background).toBe(0)
    expect(row?.status).toBe('completed')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// #3667 — the PRODUCTION async-launch payload
// ───────────────────────────────────────────────────────────────────────────
//
// Every posttool test above feeds a hand-written `{ content: [...] }` or
// `{ result: '...' }` shape. Claude Code's Agent tool has never returned
// either of those for a dispatch: it returns a STRUCTURED object with no text
// anywhere on it. Because the prose ACK tiers read '' from that object, the
// hook classified 314/318 real dispatches as foreground completions and
// stamped `status='completed', ended_at≈started_at` ~0.2s after launch, while
// `last_activity_at` kept climbing for the worker's real lifetime.
//
// So these tests pin the REAL payload, captured verbatim from a live parent
// transcript (`toolUseResult`, claude-code 2.1.219). Update it only against a
// freshly captured transcript, never by hand.
const PROD_ASYNC_LAUNCH_RESPONSE = {
  isAsync: true,
  status: 'async_launched',
  agentId: 'aec3ddbae614f85f5',
  description: 'Fix subagent rows terminalizing early',
  resolvedModel: 'claude-opus-5',
  prompt: 'Work in /share/code/switchroom. Read the repo conventions first...',
  outputFile: '/tmp/claude-x/tasks/aec3ddbae614f85f5.output',
  canReadOutputFile: true,
}

describe('subagent-tracker-posttool — async launch is not a completion (#3667)', () => {
  it('leaves a still-running worker non-terminal on the production async-launch payload', () => {
    // Pretool sees the production tool_input: NO run_in_background key (the
    // runtime auto-backgrounds and does not echo the flag) → background=0.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667a',
      tool_input: { subagent_type: 'worker', description: 'Fix subagent rows terminalizing early' },
    }).status).toBe(0)

    const db = openDb()
    const before = db
      .prepare('SELECT background, status, started_at FROM subagents WHERE id = ?')
      .get('toolu_3667a') as { background: number; status: string; started_at: number }
    expect(before.background).toBe(0)
    expect(before.status).toBe('running')

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667a',
      tool_response: PROD_ASYNC_LAUNCH_RESPONSE,
    })
    expect(postResult.status).toBe(0)

    const after = db
      .prepare('SELECT background, status, ended_at, last_activity_at, result_summary FROM subagents WHERE id = ?')
      .get('toolu_3667a') as {
        background: number
        status: string
        ended_at: number | null
        last_activity_at: number
        result_summary: string | null
      }

    // THE failure shape: a launched-but-still-running worker must not read as
    // terminal, and must carry no end timestamp at all.
    expect(after.status).toBe('running')
    expect(after.ended_at).toBeNull()
    // Promoted off the mis-recorded foreground flag, so the watcher/card path
    // treats it as the background worker it actually is.
    expect(after.background).toBe(1)
    // Liveness still recorded.
    expect(after.last_activity_at).toBeGreaterThanOrEqual(before.started_at)
    // The launch payload embeds the whole dispatch prompt — it must never be
    // mistaken for the worker's result.
    expect(after.result_summary).toBeNull()

    // No handback nudge: nothing has been handed back yet.
    expect(postResult.stdout).not.toContain('additionalContext')
  })

  it('records a truthful duration when the worker actually finishes later', () => {
    // The other half of the failure shape: `ended_at` must reflect REAL
    // completion, not the launch ACK. After the ACK the watcher's
    // JSONL-driven turn_end write is what terminalizes the row.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667b',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667b',
      tool_input: { subagent_type: 'worker', description: 'Long job' },
    }).status).toBe(0)

    expect(runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667b',
      tool_response: PROD_ASYNC_LAUNCH_RESPONSE,
    }).status).toBe(0)

    const db = openDb()
    const row = db
      .prepare('SELECT started_at, ended_at FROM subagents WHERE id = ?')
      .get('toolu_3667b') as { started_at: number; ended_at: number | null }
    expect(row.ended_at).toBeNull()

    // Watcher's terminal write, 5 minutes after dispatch. Uses the REAL
    // recordSubagentEnd the watcher's turn_end path calls, so this test can't
    // pass against a hand-copied approximation of it.
    const realEnd = row.started_at + 300_000
    recordSubagentEnd(db as unknown as Parameters<typeof recordSubagentEnd>[0], {
      id: 'toolu_3667b',
      endedAt: realEnd,
      status: 'completed',
    })

    const done = db
      .prepare('SELECT status, ended_at, started_at FROM subagents WHERE id = ?')
      .get('toolu_3667b') as { status: string; ended_at: number; started_at: number }
    expect(done.status).toBe('completed')
    // The regression signature was ended_at - started_at < ~1s on a job that
    // ran for minutes. Assert the recorded duration is the real one.
    expect(done.ended_at - done.started_at).toBe(300_000)
  })

  it('does NOT terminalize on an unrecognised tool_response shape', () => {
    // Drift guard: if claude-code changes the payload again, the hook must
    // decline to guess rather than declare a live worker finished. It warns on
    // stderr instead, and the watcher stays in charge of the terminal write.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667c',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667c',
      tool_input: { subagent_type: 'worker', description: 'Drifted payload' },
    }).status).toBe(0)

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667c',
      tool_response: { someFutureField: 42, launchToken: 'abc' },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).not.toContain('additionalContext')
    expect(postResult.stderr).toContain('unrecognised Agent tool_response shape')
    // Shape only — never values (the payload can embed the dispatch prompt).
    expect(postResult.stderr).not.toContain('abc')

    const db = openDb()
    const row = db
      .prepare('SELECT status, ended_at, background FROM subagents WHERE id = ?')
      .get('toolu_3667c') as { status: string; ended_at: number | null; background: number }
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
    // Unknown ≠ background: we decline to guess in both directions.
    expect(row.background).toBe(0)
  })

  it('does not read an explicitly terminal async envelope as a fresh launch', () => {
    // Boundary: `isAsync: true` means "this dispatch is asynchronous", not
    // "still running". If a future claude-code reuses the envelope to report an
    // OUTCOME, promoting it to a running background row would be wrong — the
    // hook must fall through to the drift alarm instead of claiming a launch.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667g',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667g',
      tool_input: { subagent_type: 'worker', description: 'Terminal envelope' },
    }).status).toBe(0)

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667g',
      tool_response: { isAsync: true, status: 'completed', agentId: 'zz1' },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stderr).toContain('unrecognised Agent tool_response shape')

    const db = openDb()
    const row = db
      .prepare('SELECT status, background, ended_at FROM subagents WHERE id = ?')
      .get('toolu_3667g') as { status: string; background: number; ended_at: number | null }
    expect(row.background).toBe(0)
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
  })

  it('does NOT terminalize when tool_response is absent', () => {
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667d',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667d',
      tool_input: { subagent_type: 'worker', description: 'No response' },
    }).status).toBe(0)

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667d',
    })
    expect(postResult.status).toBe(0)

    const db = openDb()
    const row = db
      .prepare('SELECT status, ended_at FROM subagents WHERE id = ?')
      .get('toolu_3667d') as { status: string; ended_at: number | null }
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
  })

  it('terminalizes a bare-string dispatch error as failed', () => {
    // Also observed in production: the Agent tool returns a bare string when
    // the dispatch itself fails, so there is no `is_error` flag to read. No
    // worker exists, so the watcher will never terminalize this row — the hook
    // must, and it must not call the failure a success.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667e',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667e',
      tool_input: { subagent_type: 'worker', description: 'Doomed dispatch' },
    }).status).toBe(0)

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667e',
      tool_response:
        'Error: Cannot create agent worktree: not in a git repository and no '
        + 'WorktreeCreate hooks are configured.',
    })
    expect(postResult.status).toBe(0)
    // A failed dispatch is not a handback.
    expect(postResult.stdout).not.toContain('additionalContext')

    const db = openDb()
    const row = db
      .prepare('SELECT status, ended_at, result_summary FROM subagents WHERE id = ?')
      .get('toolu_3667e') as { status: string; ended_at: number | null; result_summary: string | null }
    expect(row.status).toBe('failed')
    expect(row.ended_at).not.toBeNull()
    expect(row.result_summary).toContain('Cannot create agent worktree')
  })

  it('still terminalizes a genuine foreground completion (control)', () => {
    // The fix must not swing the other way: a real sync completion still ends
    // the row, with its result summary and a handback nudge.
    expect(runHook(PRETOOL_SCRIPT, {
      session_id: 's-3667f',
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667f',
      tool_input: { subagent_type: 'worker', description: 'Sync task', run_in_background: false },
    }).status).toBe(0)

    const postResult = runHook(POSTTOOL_SCRIPT, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_3667f',
      tool_response: { content: [{ type: 'text', text: 'All done: 3 files changed.' }] },
    })
    expect(postResult.status).toBe(0)
    expect(postResult.stdout).toContain('additionalContext')

    const db = openDb()
    const row = db
      .prepare('SELECT status, ended_at, background, result_summary FROM subagents WHERE id = ?')
      .get('toolu_3667f') as {
        status: string
        ended_at: number | null
        background: number
        result_summary: string | null
      }
    expect(row.status).toBe('completed')
    expect(row.ended_at).not.toBeNull()
    expect(row.background).toBe(0)
    expect(row.result_summary).toContain('3 files changed')
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

// ---------------------------------------------------------------------------
// Concurrent nested dispatch — row-creation reliability (unified cards)
// ---------------------------------------------------------------------------

describe('pretool — concurrent dispatch reliability', () => {
  it('N hook processes writing the same registry.db concurrently all land their rows', async () => {
    // The live-incident failure mode: several sub-agents dispatch at once
    // (a depth-1 worker fanning out nested workers), the hook processes
    // contend on registry.db, and a loser's INSERT vanished with
    // SQLITE_BUSY → 0 rows → the worker's card froze on "starting…".
    // The busy_timeout arming + this pin keep that from regressing.
    const N = 8
    const { spawn } = require('child_process') as typeof import('child_process')
    const runs = Array.from({ length: N }, (_, i) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [PRETOOL_SCRIPT], {
        env: { ...process.env, SWITCHROOM_AGENT_DIR: agentDir },
        stdio: ['pipe', 'ignore', 'inherit'],
      })
      child.on('close', (code: number | null) => resolve(code ?? -1))
      child.stdin!.end(JSON.stringify({
        session_id: 'sess-conc',
        tool_name: 'Task',
        tool_use_id: `toolu_conc_${i}`,
        tool_input: { description: `concurrent worker ${i}`, run_in_background: true },
      }))
    }))
    const codes = await Promise.all(runs)
    expect(codes.every((c) => c === 0)).toBe(true)

    const db = openDb()
    const rows = db.prepare(
      "SELECT id FROM subagents WHERE id LIKE 'toolu_conc_%' ORDER BY id",
    ).all() as Array<{ id: string }>
    expect(rows.length).toBe(N)
  }, 30_000)
})
