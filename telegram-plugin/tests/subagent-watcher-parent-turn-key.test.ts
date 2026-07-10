/**
 * Unit tests for the parent_turn_key backfill in subagent-watcher.ts
 * (backfillJsonlAgentId).
 *
 * The PreToolUse hook records a sub-agent row with parent_turn_key=NULL — it
 * only sees Claude Code's session id, never the Telegram turn_key
 * (chat_id:msg_id) the gateway keys turns on. The gateway backfills
 * parent_turn_key when it links the JSONL stem to the row, resolving it from
 * the turn whose [started_at, ended_at] window contained the sub-agent's
 * dispatch (its started_at). These tests pin that resolution — in particular
 * that it stays correct for a background worker that outlives its parent turn.
 *
 * bun:sqlite — run under Bun:
 *   bun test telegram-plugin/tests/subagent-watcher-parent-turn-key.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openTurnsDbInMemory } from '../registry/turns-schema.js'
import { applySubagentsSchema } from '../registry/subagents-schema.js'
import { backfillJsonlAgentId } from '../subagent-watcher.js'

type Db = ReturnType<typeof openTurnsDbInMemory>

let tempDir: string
let db: Db

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sub-parent-turn-'))
  db = openTurnsDbInMemory()
  applySubagentsSchema(db)
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function insertTurn(args: {
  turnKey: string
  chatId: string
  threadId?: string | null
  startedAt: number
  endedAt?: number | null
}) {
  db.prepare(`
    INSERT INTO turns (turn_key, chat_id, thread_id, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.turnKey,
    args.chatId,
    args.threadId ?? null,
    args.startedAt,
    args.endedAt ?? null,
    args.startedAt,
    args.startedAt,
  )
}

function insertSub(args: {
  id: string
  agentType: string
  description: string
  startedAt: number
  parentTurnKey?: string | null
}) {
  db.prepare(`
    INSERT INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, jsonl_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL)
  `).run(
    args.id,
    'sess-1',
    args.parentTurnKey ?? null,
    args.agentType,
    args.description,
    1,
    args.startedAt,
    args.startedAt,
  )
}

/** Write the meta.json the backfill reads to match a row by (agentType, description). */
function writeMeta(agentType: string, description: string): string {
  const jsonlPath = join(tempDir, 'worker.jsonl')
  writeFileSync(join(tempDir, 'worker.meta.json'), JSON.stringify({ agentType, description }))
  return jsonlPath
}

/**
 * Write meta.json with a `toolUseId` field (Bug 1 fix — direct PK lookup).
 * Modern Claude Code versions write this alongside `agentType` and `description`.
 */
function writeMetaWithToolUseId(toolUseId: string, agentType: string, description: string): string {
  const jsonlPath = join(tempDir, 'worker.jsonl')
  writeFileSync(join(tempDir, 'worker.meta.json'), JSON.stringify({ agentType, description, toolUseId }))
  return jsonlPath
}

function readSub(id: string) {
  return db.prepare('SELECT jsonl_agent_id, parent_turn_key FROM subagents WHERE id = ?').get(id) as
    | { jsonl_agent_id: string | null; parent_turn_key: string | null }
    | undefined
}

describe('backfillJsonlAgentId — parent_turn_key resolution', () => {
  it('resolves parent_turn_key from the turn whose window contains the sub-agent started_at', () => {
    insertTurn({ turnKey: '555:10', chatId: '555', threadId: '42', startedAt: 1000, endedAt: 2000 })
    insertSub({ id: 'toolu_a', agentType: 'worker', description: 'Go-live sync', startedAt: 1500 })

    const jsonlPath = writeMeta('worker', 'Go-live sync')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_a')

    const row = readSub('toolu_a')
    expect(row?.jsonl_agent_id).toBe('agentstem_a')
    expect(row?.parent_turn_key).toBe('555:10')
  })

  it('resolves to the parent turn even after it has ended (background worker outlives the turn)', () => {
    // Parent turn already ended at 1600; a later turn is active "now".
    insertTurn({ turnKey: '555:10', chatId: '555', startedAt: 1000, endedAt: 1600 })
    insertTurn({ turnKey: '555:20', chatId: '555', startedAt: 1700, endedAt: null })
    // The worker was dispatched at 1500 — inside the FIRST (now-ended) turn.
    insertSub({ id: 'toolu_b', agentType: 'worker', description: 'Long task', startedAt: 1500 })

    const jsonlPath = writeMeta('worker', 'Long task')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_b')

    // Must pick the containing (ended) turn, NOT the turn active at link time.
    expect(readSub('toolu_b')?.parent_turn_key).toBe('555:10')
  })

  it('does NOT overwrite an already-populated parent_turn_key', () => {
    insertTurn({ turnKey: '555:10', chatId: '555', startedAt: 1000, endedAt: 2000 })
    insertSub({
      id: 'toolu_c',
      agentType: 'worker',
      description: 'Preset',
      startedAt: 1500,
      parentTurnKey: '999:9',
    })

    const jsonlPath = writeMeta('worker', 'Preset')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_c')

    expect(readSub('toolu_c')?.parent_turn_key).toBe('999:9')
  })

  it('leaves parent_turn_key NULL when no turn window contains the dispatch', () => {
    insertTurn({ turnKey: '555:10', chatId: '555', startedAt: 1000, endedAt: 2000 })
    // Dispatched at 50 — before any turn started.
    insertSub({ id: 'toolu_d', agentType: 'worker', description: 'Orphan', startedAt: 50 })

    const jsonlPath = writeMeta('worker', 'Orphan')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_d')

    const row = readSub('toolu_d')
    // Still linked, but no turn to attribute it to.
    expect(row?.jsonl_agent_id).toBe('agentstem_d')
    expect(row?.parent_turn_key == null).toBe(true)
  })
})

// ─── #2501: direct toolUseId PK lookup (Bug 1 fix) ───────────────────────────
// Claude Code writes `toolUseId` to meta.json so backfillJsonlAgentId can
// match the row by its primary key instead of the fuzzy (agentType, description)
// match that fails when descriptions collide or are null.
describe('backfillJsonlAgentId — toolUseId direct PK lookup (#2501)', () => {
  it('uses toolUseId from meta.json to link the row directly by PK', () => {
    insertTurn({ turnKey: '555:10', chatId: '555', startedAt: 1000, endedAt: 2000 })
    insertSub({ id: 'toolu_direct', agentType: 'general-purpose', description: null as unknown as string, startedAt: 1500 })

    const jsonlPath = writeMetaWithToolUseId('toolu_direct', 'general-purpose', '')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_direct')

    const row = readSub('toolu_direct')
    expect(row?.jsonl_agent_id).toBe('agentstem_direct')
  })

  it('direct PK lookup succeeds even when description is null (fuzzy match would fail)', () => {
    // Two rows with the same agentType and NULL description — fuzzy match is ambiguous.
    insertSub({ id: 'toolu_null_desc_1', agentType: 'general-purpose', description: null as unknown as string, startedAt: 1000 })
    insertSub({ id: 'toolu_null_desc_2', agentType: 'general-purpose', description: null as unknown as string, startedAt: 2000 })

    // meta.json carries the exact toolUseId for the first row.
    const jsonlPath = writeMetaWithToolUseId('toolu_null_desc_1', 'general-purpose', '')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_null_desc')

    // Must link to the first row, not the more-recent second one.
    expect(readSub('toolu_null_desc_1')?.jsonl_agent_id).toBe('agentstem_null_desc')
    expect(readSub('toolu_null_desc_2')?.jsonl_agent_id).toBeNull()
  })

  it('falls back to fuzzy match when toolUseId in meta.json does not match any row', () => {
    insertSub({ id: 'toolu_fuzzy', agentType: 'researcher', description: 'Find stuff', startedAt: 1000 })

    // toolUseId points at a non-existent row; fuzzy match should still work.
    const jsonlPath = writeMetaWithToolUseId('toolu_NONEXISTENT', 'researcher', 'Find stuff')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_fuzzy_fallback')

    expect(readSub('toolu_fuzzy')?.jsonl_agent_id).toBe('agentstem_fuzzy_fallback')
  })

  it('meta.json with only toolUseId and no agentType/description still links the row', () => {
    insertSub({ id: 'toolu_id_only', agentType: null as unknown as string, description: null as unknown as string, startedAt: 1000 })

    const jsonlPath = join(tempDir, 'worker.jsonl')
    writeFileSync(join(tempDir, 'worker.meta.json'), JSON.stringify({ toolUseId: 'toolu_id_only' }))
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_id_only')

    expect(readSub('toolu_id_only')?.jsonl_agent_id).toBe('agentstem_id_only')
  })
})

// ─── #2081: overlapping windows + hook-stamped value precedence ───────────────
// The backfill is now only a FALLBACK — the PreToolUse hook stamps
// parent_turn_key from the live turn-active marker at dispatch
// (subagent-tracker-pretool.mjs readActiveTurnKey). These tests pin the two
// guarantees that make the hook fix correct end-to-end.
describe('backfillJsonlAgentId — overlapping windows / hook precedence (#2081)', () => {
  it('does NOT overwrite a hook-stamped parent_turn_key, even when overlapping windows would resolve differently', () => {
    // Supergroup: two forum topics under one chat with OVERLAPPING windows.
    // Topic A (thread 4) started first and is still open; topic B (thread 7)
    // started later. A sub-agent dispatched at 1500 falls inside BOTH windows.
    insertTurn({ turnKey: '-100:4:1000', chatId: '-100', threadId: '4', startedAt: 1000, endedAt: null })
    insertTurn({ turnKey: '-100:7:1400', chatId: '-100', threadId: '7', startedAt: 1400, endedAt: null })

    // The hook already stamped the CORRECT parent (topic A) from the marker.
    insertSub({
      id: 'toolu_overlap',
      agentType: 'worker',
      description: 'Topic-A worker',
      startedAt: 1500,
      parentTurnKey: '-100:4:1000',
    })

    const jsonlPath = writeMeta('worker', 'Topic-A worker')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_overlap')

    const row = readSub('toolu_overlap')
    expect(row?.jsonl_agent_id).toBe('agentstem_overlap')
    // The IS NULL guard means the hook's correct value survives — NOT the
    // window query's ORDER BY started_at DESC pick (which would be topic B).
    expect(row?.parent_turn_key).toBe('-100:4:1000')
  })

  it('fallback window-match (NULL parent) picks the latest-started overlapping turn — the documented fallback limitation', () => {
    // When the hook left parent_turn_key NULL (no active marker at dispatch),
    // the backfill falls back to the started_at window match. With overlapping
    // windows it resolves to the latest-started containing turn. This is a
    // best-effort fallback for the no-marker case — the hook path above is the
    // correct primary. Pinned here so the fallback behaviour is explicit.
    insertTurn({ turnKey: '-100:4:1000', chatId: '-100', threadId: '4', startedAt: 1000, endedAt: null })
    insertTurn({ turnKey: '-100:7:1400', chatId: '-100', threadId: '7', startedAt: 1400, endedAt: null })
    insertSub({ id: 'toolu_fallback', agentType: 'worker', description: 'No-marker worker', startedAt: 1500 })

    const jsonlPath = writeMeta('worker', 'No-marker worker')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_fallback')

    const row = readSub('toolu_fallback')
    expect(row?.parent_turn_key).toBe('-100:7:1400')
  })
})

// ─── Fix #3: ambiguous fuzzy backfill refuses to link ────────────────────────
// Legacy meta.json (no toolUseId) falls back to the fuzzy (agentType,
// description) match. With N unlinked rows sharing that key, a bare
// `ORDER BY started_at DESC LIMIT 1` assigned by start-order, not true
// correspondence — a genuine mislink for a cross-topic identical dispatch.
// The fix: link only when the candidate is UNAMBIGUOUS (exactly one match);
// otherwise leave jsonl_agent_id NULL and let the marker/window path
// attribute it.
describe('backfillJsonlAgentId — fix #3: ambiguous fuzzy match refused', () => {
  it('two unlinked rows sharing (agent_type, description) → fuzzy link refused, row stays NULL', () => {
    insertSub({ id: 'toolu_amb_1', agentType: 'general-purpose', description: 'Run the tests', startedAt: 1000 })
    insertSub({ id: 'toolu_amb_2', agentType: 'general-purpose', description: 'Run the tests', startedAt: 2000 })

    // Legacy meta.json — no toolUseId, forces the fuzzy fallback path.
    const jsonlPath = writeMeta('general-purpose', 'Run the tests')
    const logs: string[] = []
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_ambiguous', (m) => logs.push(m))

    // Neither candidate gets mis-assigned — both remain unlinked.
    expect(readSub('toolu_amb_1')?.jsonl_agent_id ?? null).toBeNull()
    expect(readSub('toolu_amb_2')?.jsonl_agent_id ?? null).toBeNull()
    expect(logs.some((l) => l.includes('ambiguous') && l.includes('agentstem_ambiguous'))).toBe(true)
  })

  it('a SINGLE unambiguous candidate still links normally (no regression)', () => {
    insertSub({ id: 'toolu_unamb', agentType: 'general-purpose', description: 'Unique task', startedAt: 1000 })

    const jsonlPath = writeMeta('general-purpose', 'Unique task')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_unambiguous')

    expect(readSub('toolu_unamb')?.jsonl_agent_id).toBe('agentstem_unambiguous')
  })

  it('three unlinked rows sharing the same key → still refused (not just a 2-row edge case)', () => {
    insertSub({ id: 'toolu_amb3_1', agentType: 'researcher', description: 'Investigate', startedAt: 1000 })
    insertSub({ id: 'toolu_amb3_2', agentType: 'researcher', description: 'Investigate', startedAt: 2000 })
    insertSub({ id: 'toolu_amb3_3', agentType: 'researcher', description: 'Investigate', startedAt: 3000 })

    const jsonlPath = writeMeta('researcher', 'Investigate')
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_amb3')

    expect(readSub('toolu_amb3_1')?.jsonl_agent_id ?? null).toBeNull()
    expect(readSub('toolu_amb3_2')?.jsonl_agent_id ?? null).toBeNull()
    expect(readSub('toolu_amb3_3')?.jsonl_agent_id ?? null).toBeNull()
  })
})

// ─── #2506: null meta.json guard ─────────────────────────────────────────────
// JSON.parse('null') succeeds and returns null. Before the fix, the enclosing
// try/catch only covered the read+parse, so execution fell through to
// `if (!meta.agentType …)` which threw TypeError: Cannot read properties of
// null. The fix guards with `if (!meta || …)` so a literal-null meta.json
// degrades to the same clean skip as any other "no usable fields" case.
describe('backfillJsonlAgentId — null meta.json guard (#2506)', () => {
  it('meta.json containing literal null → clean skip, no throw, row stays unlinked', () => {
    insertSub({ id: 'toolu_null_meta', agentType: 'worker', description: 'task', startedAt: 1000 })

    const jsonlPath = join(tempDir, 'null_meta_worker.jsonl')
    writeFileSync(join(tempDir, 'null_meta_worker.meta.json'), 'null')

    const logs: string[] = []
    // Must not throw — before the fix this crashed with TypeError: Cannot read
    // properties of null (reading 'agentType').
    expect(() => backfillJsonlAgentId(db, jsonlPath, 'agentstem_null_meta', (m) => logs.push(m))).not.toThrow()

    // Row must remain unlinked (the skip path, not the link path).
    const row = readSub('toolu_null_meta')
    expect(row?.jsonl_agent_id).toBeNull()

    // A skip log must have been emitted (not a misleading 'backfill error').
    expect(logs.some((l) => l.includes('backfill skip') && l.includes('agentstem_null_meta'))).toBe(true)
  })

  it('meta.json containing literal null → skip log does NOT contain "error"', () => {
    // The outer try/catch in registerAgent would have surfaced this as a
    // "backfill error" before the fix; now it should be a clean "backfill skip".
    const jsonlPath = join(tempDir, 'null_meta_worker2.jsonl')
    writeFileSync(join(tempDir, 'null_meta_worker2.meta.json'), 'null')

    const logs: string[] = []
    backfillJsonlAgentId(db, jsonlPath, 'agentstem_null_meta2', (m) => logs.push(m))

    // Should have a skip log, not an error log.
    expect(logs.some((l) => l.toLowerCase().includes('error'))).toBe(false)
    expect(logs.some((l) => l.includes('backfill skip'))).toBe(true)
  })
})
