/**
 * Nested (depth-2+) sub-agent keying — registry primitives.
 *
 * Pins the three mechanisms that fix the "nested worker card frozen on
 * starting…" class:
 *   1. `recordNestedSubagentDispatch` — the watcher records/repairs a nested
 *      dispatch row from the PARENT worker's JSONL (the authoritative
 *      dispatch record), because the PreToolUse hook cannot attribute it
 *      (turn-active.json is gone once the main turn ends) and can lose the
 *      write entirely under concurrent nested dispatch.
 *   2. `resolveSubagentOriginTurnKey` — transitive origin resolution via the
 *      `parent_agent_id` chain, so a nested worker's card + handback route to
 *      the originating chat/topic instead of the owner DM.
 *   3. `backfillJsonlAgentId` — inherits `parent_turn_key` from the nested-
 *      parent chain BEFORE falling back to the (never-correct-for-nested)
 *      turns time-window match.
 *
 * bun:sqlite — run under Bun:
 *   bun test telegram-plugin/tests/subagent-nested-dispatch.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openTurnsDbInMemory } from '../registry/turns-schema.js'
import {
  applySubagentsSchema,
  recordNestedSubagentDispatch,
  resolveSubagentOriginTurnKey,
  getSubagent,
} from '../registry/subagents-schema.js'
import { backfillJsonlAgentId } from '../subagent-watcher.js'

type Db = ReturnType<typeof openTurnsDbInMemory>

let tempDir: string
let db: Db

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sub-nested-'))
  db = openTurnsDbInMemory()
  applySubagentsSchema(db)
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function insertTurn(turnKey: string, chatId: string, startedAt: number, endedAt: number | null) {
  db.prepare(`
    INSERT INTO turns (turn_key, chat_id, thread_id, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
  `).run(turnKey, chatId, startedAt, endedAt, startedAt, startedAt)
}

function insertSub(args: {
  id: string
  parentTurnKey?: string | null
  jsonlAgentId?: string | null
  parentAgentId?: string | null
  background?: boolean
  description?: string | null
  startedAt?: number
}) {
  db.prepare(`
    INSERT INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, jsonl_agent_id, parent_agent_id)
    VALUES (?, 'sess-1', ?, 'worker', ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    args.id,
    args.parentTurnKey ?? null,
    args.description ?? null,
    args.background ? 1 : 0,
    args.startedAt ?? 1000,
    args.startedAt ?? 1000,
    args.jsonlAgentId ?? null,
    args.parentAgentId ?? null,
  )
}

describe('recordNestedSubagentDispatch', () => {
  it('creates the row when the hook lost the write (missing-row nested worker)', () => {
    // Depth-1 parent: background worker, attributed at main-turn dispatch.
    insertSub({ id: 'toolu_parent', parentTurnKey: '8248:_:1', jsonlAgentId: 'parent01', background: true })

    recordNestedSubagentDispatch(db, {
      toolUseId: 'toolu_child',
      parentJsonlAgentId: 'parent01',
      agentType: 'general-purpose',
      description: 'nested probe',
      background: false,
      now: 5000,
    })

    const child = getSubagent(db, 'toolu_child')
    expect(child).not.toBeNull()
    expect(child?.parent_agent_id).toBe('parent01')
    // Transitively inherited from the depth-1 row at record time.
    expect(child?.parent_turn_key).toBe('8248:_:1')
    expect(child?.description).toBe('nested probe')
    expect(child?.status).toBe('running')
  })

  it('repairs a hook-inserted row: stamps parent_agent_id + inherits NULL parent_turn_key', () => {
    insertSub({ id: 'toolu_parent', parentTurnKey: 'turn-A', jsonlAgentId: 'parent01', background: true })
    // The hook DID land the row, but with parent_turn_key NULL (marker gone)
    // — the exact live-incident shape (sibling a18c6003… had an empty key).
    insertSub({ id: 'toolu_child', parentTurnKey: null, description: 'hook desc' })

    recordNestedSubagentDispatch(db, {
      toolUseId: 'toolu_child',
      parentJsonlAgentId: 'parent01',
      description: 'watcher desc',
      background: true,
      now: 6000,
    })

    const child = getSubagent(db, 'toolu_child')
    expect(child?.parent_agent_id).toBe('parent01')
    expect(child?.parent_turn_key).toBe('turn-A')
    // INSERT OR IGNORE — the hook row's own fields are preserved.
    expect(child?.description).toBe('hook desc')
  })

  it('is idempotent and never overwrites an existing parent_turn_key', () => {
    insertSub({ id: 'toolu_parent', parentTurnKey: 'turn-A', jsonlAgentId: 'parent01', background: true })
    insertSub({ id: 'toolu_child', parentTurnKey: 'turn-REAL' })

    recordNestedSubagentDispatch(db, {
      toolUseId: 'toolu_child', parentJsonlAgentId: 'parent01', background: false, now: 1,
    })
    recordNestedSubagentDispatch(db, {
      toolUseId: 'toolu_child', parentJsonlAgentId: 'parent01', background: false, now: 2,
    })

    const child = getSubagent(db, 'toolu_child')
    expect(child?.parent_turn_key).toBe('turn-REAL')
    expect(child?.parent_agent_id).toBe('parent01')
  })
})

describe('resolveSubagentOriginTurnKey — transitive origin walk', () => {
  it('depth-1: returns the row own parent_turn_key', () => {
    insertSub({ id: 't1', parentTurnKey: 'turn-A', jsonlAgentId: 'a1' })
    expect(resolveSubagentOriginTurnKey(db, 'a1')).toBe('turn-A')
  })

  it('depth-2: NULL own key resolves via the parent chain', () => {
    insertSub({ id: 't1', parentTurnKey: 'turn-A', jsonlAgentId: 'a1' })
    insertSub({ id: 't2', parentTurnKey: null, jsonlAgentId: 'a2', parentAgentId: 'a1' })
    expect(resolveSubagentOriginTurnKey(db, 'a2')).toBe('turn-A')
  })

  it('depth-3: walks multiple hops', () => {
    insertSub({ id: 't1', parentTurnKey: 'turn-A', jsonlAgentId: 'a1' })
    insertSub({ id: 't2', parentTurnKey: null, jsonlAgentId: 'a2', parentAgentId: 'a1' })
    insertSub({ id: 't3', parentTurnKey: null, jsonlAgentId: 'a3', parentAgentId: 'a2' })
    expect(resolveSubagentOriginTurnKey(db, 'a3')).toBe('turn-A')
  })

  it('cycle-safe: a corrupt self/loop chain returns null instead of hanging', () => {
    insertSub({ id: 't1', parentTurnKey: null, jsonlAgentId: 'a1', parentAgentId: 'a2' })
    insertSub({ id: 't2', parentTurnKey: null, jsonlAgentId: 'a2', parentAgentId: 'a1' })
    expect(resolveSubagentOriginTurnKey(db, 'a1')).toBeNull()
  })

  it('missing row / unattributed chain returns null (caller keeps DM fallback)', () => {
    expect(resolveSubagentOriginTurnKey(db, 'nope')).toBeNull()
    insertSub({ id: 't1', parentTurnKey: null, jsonlAgentId: 'a1' })
    expect(resolveSubagentOriginTurnKey(db, 'a1')).toBeNull()
  })
})

describe('backfillJsonlAgentId — nested-parent inheritance beats the window match', () => {
  function writeMeta(stem: string, toolUseId: string): string {
    const jsonlPath = join(tempDir, `agent-${stem}.jsonl`)
    writeFileSync(join(tempDir, `agent-${stem}.meta.json`), JSON.stringify({
      agentType: 'general-purpose', description: 'nested probe', toolUseId,
    }))
    return jsonlPath
  }

  it('inherits the ancestor turn key when the dispatch happened AFTER the main turn ended', () => {
    // The originating turn ended at t=2000; an unrelated turn is open at
    // child-dispatch time (t=5000) — the window match would MIS-attribute.
    insertTurn('turn-ORIGIN', '8248', 1000, 2000)
    insertTurn('turn-OTHER', '9999', 4000, null)
    insertSub({ id: 'toolu_parent', parentTurnKey: 'turn-ORIGIN', jsonlAgentId: 'parent01', background: true })
    // Watcher-recorded nested row (parent_agent_id set, key inherited=NULL
    // here to force the backfill path to resolve it).
    db.prepare(`
      INSERT INTO subagents
        (id, parent_session_id, parent_turn_key, agent_type, description,
         background, started_at, last_activity_at, status, jsonl_agent_id, parent_agent_id)
      VALUES ('toolu_child', NULL, NULL, 'general-purpose', 'nested probe', 0, 5000, 5000, 'running', NULL, 'parent01')
    `).run()

    const jsonlPath = writeMeta('child01', 'toolu_child')
    backfillJsonlAgentId(db, jsonlPath, 'child01')

    const child = getSubagent(db, 'toolu_child')
    expect(child?.jsonl_agent_id).toBe('child01')
    // Inherited from the parent chain — NOT 'turn-OTHER' from the open window.
    expect(child?.parent_turn_key).toBe('turn-ORIGIN')
  })
})
