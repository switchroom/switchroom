/**
 * Regression: the gap-dispatch worker misroute (Telegram msg 6897,
 * 2026-08-04).
 *
 * A depth-1 background worker was dispatched ~6.6 min AFTER the last topic
 * turn's row had ended, with NO `turns` row open at its `started_at` (the
 * dispatching turn was a synthesized handback turn that never registered a
 * turn surface). Consequences on the pre-fix code:
 *
 *   - the pretool hook's #2085 dispatch-time stamp had no `turn-active.json`
 *     to read → `parent_turn_key` NULL at insert;
 *   - the watcher's started_at window backfill
 *     (`SELECT turn_key FROM turns WHERE started_at <= ? AND (ended_at IS
 *     NULL OR ended_at >= ?)`) matched nothing → NULL stays;
 *   - `resolveSubagentOriginChat` → null → BOTH the worker card
 *     (`resolveWorkerFeedChat`) and the handback decision
 *     (`decideSubagentHandback`) fell through `fleetChatId || allowFrom[0]`
 *     to the OWNER DM with the forum thread stripped.
 *
 * These tests pin the two closures:
 *   1. `stampSubagentDispatchTurn` — the gateway-side dispatch-time stamp
 *      (marker-free, window-free) that attributes the row from the live
 *      turn key the gateway holds when it observes the Agent/Task tool_use.
 *   2. `resolveWorkerSurfaceChat` — the safe-degradation floor: when the
 *      stamp still missed, resolution falls to the MOST-RECENT turn's
 *      chat+topic (the #3458 mechanism, DB-backed) BEFORE the owner DM —
 *      asserted end-to-end into `decideSubagentHandback`'s built inbound.
 *
 * bun:sqlite — run under Bun:
 *   bun test telegram-plugin/tests/worker-origin-gap-dispatch.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { openTurnsDbInMemory } from '../registry/turns-schema.js'
import {
  applySubagentsSchema,
  stampSubagentDispatchTurn,
  resolveSubagentOriginTurnKey,
  getSubagent,
} from '../registry/subagents-schema.js'
import {
  resolveWorkerSurfaceChat,
  resolveSubagentOriginChatDb,
  resolveRecentTurnFallbackChat,
} from '../gateway/subagent-origin-surface.js'
import { decideSubagentHandback } from '../gateway/subagent-handback-inbound-builder.js'

type Db = ReturnType<typeof openTurnsDbInMemory>

const TOPIC_CHAT = '-1004444444444'
const TOPIC_THREAD = '77'
const OWNER_DM = '555'

let db: Db

beforeEach(() => {
  db = openTurnsDbInMemory()
  applySubagentsSchema(db)
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
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

/** A hook-inserted depth-1 row: parent_turn_key NULL (no marker at dispatch),
 *  jsonl already linked (the backfill linked the stem but had no containing
 *  turn window to attribute from — the exact msg-6897 row shape). */
function insertGapDispatchedWorker(args: { id: string; jsonlAgentId: string; startedAt: number }) {
  db.prepare(`
    INSERT INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, jsonl_agent_id)
    VALUES (?, 'sess-1', NULL, 'worker', 'Gap-dispatched task', 1, ?, ?, 'running', ?)
  `).run(args.id, args.startedAt, args.startedAt, args.jsonlAgentId)
}

describe('gap dispatch — safe-degradation floor (msg-6897)', () => {
  /** The incident fixture: topic turn [1_000_000, 1_600_000] (ended), worker
   *  dispatched ~6.6 min after end — no turns row open at started_at. */
  function seedIncident() {
    insertTurn({
      turnKey: `${TOPIC_CHAT}:${TOPIC_THREAD}:1000000`,
      chatId: TOPIC_CHAT,
      threadId: TOPIC_THREAD,
      startedAt: 1_000_000,
      endedAt: 1_600_000,
    })
    const dispatchAt = 1_600_000 + Math.round(6.6 * 60_000)
    insertGapDispatchedWorker({ id: 'toolu_gap', jsonlAgentId: 'wkr_gap', startedAt: dispatchAt })
  }

  it('pre-condition: origin resolution genuinely misses for the gap-dispatched row', () => {
    seedIncident()
    // The row is linked but unattributed — the DB-confirmed incident state.
    expect(getSubagent(db, 'toolu_gap')?.parent_turn_key).toBeNull()
    expect(resolveSubagentOriginTurnKey(db, 'wkr_gap')).toBeNull()
    expect(resolveSubagentOriginChatDb(db, 'wkr_gap')).toBeNull()
  })

  it('worker card surface resolves to the origin topic, NOT the owner DM with thread stripped', () => {
    seedIncident()
    const dest = resolveWorkerSurfaceChat(db, 'wkr_gap', { fleetChatId: '', ownerDm: OWNER_DM })
    // THE outcome assertion: {chat_id, thread_id} — the topic, not the DM.
    expect(dest.chatId).toBe(TOPIC_CHAT)
    expect(dest.threadId).toBe(Number(TOPIC_THREAD))
    expect(dest.via).toBe('recent-turn')
  })

  it('handback inbound routes to the origin topic, NOT the owner DM with thread stripped', () => {
    seedIncident()
    // The gateway's onFinish ladder post-fix: origin (null here) → recent-turn
    // floor, fed into the SAME pure decision the gateway runs.
    const surface = resolveWorkerSurfaceChat(db, 'wkr_gap', { fleetChatId: '', ownerDm: OWNER_DM })
    const decision = decideSubagentHandback({
      handbackEnvValue: undefined,
      outcome: 'completed',
      isBackground: true,
      fleetChatId: surface.via === 'owner-dm' ? '' : surface.chatId,
      ...(surface.threadId != null ? { originThreadId: surface.threadId } : {}),
      ownerChatId: OWNER_DM,
      taskDescription: 'Gap-dispatched task',
      resultText: 'done',
      jsonlAgentId: 'wkr_gap',
      nowMs: 1_700_000_000_000,
    })
    expect(decision.deliver).toBe(true)
    if (decision.deliver) {
      expect(decision.chatId).toBe(TOPIC_CHAT)
      expect(decision.inbound.threadId).toBe(Number(TOPIC_THREAD))
      expect(decision.inbound.meta.message_thread_id).toBe(TOPIC_THREAD)
      // And the minted handback turn registers its own surface (fix 2).
      expect(decision.inbound.meta.chat_id).toBe(TOPIC_CHAT)
    }
  })

  it('a properly-attributed worker still resolves via origin — the floor never hijacks it', () => {
    // Origin topic A; a NEWER turn ran in topic B. The attributed worker must
    // keep routing to A (origin), not follow the recent-turn floor to B.
    insertTurn({ turnKey: `${TOPIC_CHAT}:4:1000`, chatId: TOPIC_CHAT, threadId: '4', startedAt: 1000, endedAt: 2000 })
    insertTurn({ turnKey: `${TOPIC_CHAT}:9:5000`, chatId: TOPIC_CHAT, threadId: '9', startedAt: 5000, endedAt: 6000 })
    db.prepare(`
      INSERT INTO subagents
        (id, parent_session_id, parent_turn_key, agent_type, description,
         background, started_at, last_activity_at, status, jsonl_agent_id)
      VALUES ('toolu_ok', 'sess-1', ?, 'worker', 'Attributed', 1, 1500, 1500, 'running', 'wkr_ok')
    `).run(`${TOPIC_CHAT}:4:1000`)

    const dest = resolveWorkerSurfaceChat(db, 'wkr_ok', { fleetChatId: '', ownerDm: OWNER_DM })
    expect(dest.via).toBe('origin')
    expect(dest.chatId).toBe(TOPIC_CHAT)
    expect(dest.threadId).toBe(4)
  })

  it('floor is bounded by the dispatch time — a NEWER unrelated chat turn never captures the surface', () => {
    seedIncident()
    // The operator later drives a turn in a DIFFERENT (possibly shared) group
    // B, AFTER the worker's dispatch. The floor must resolve to the last turn
    // BEFORE the dispatch (topic A) — never leak the worker's surface into B.
    insertTurn({
      turnKey: '-1009999999999:_:9000000',
      chatId: '-1009999999999',
      threadId: null,
      startedAt: 9_000_000,
      endedAt: 9_100_000,
    })
    const dest = resolveWorkerSurfaceChat(db, 'wkr_gap', { fleetChatId: '', ownerDm: OWNER_DM })
    expect(dest.chatId).toBe(TOPIC_CHAT)
    expect(dest.threadId).toBe(Number(TOPIC_THREAD))
    expect(dest.via).toBe('recent-turn')
  })

  it('only post-dispatch turns exist — floor declines and falls to the owner DM, not the newer chat', () => {
    insertGapDispatchedWorker({ id: 'toolu_late', jsonlAgentId: 'wkr_late', startedAt: 1000 })
    insertTurn({ turnKey: '-1008888888888:_:5000', chatId: '-1008888888888', threadId: null, startedAt: 5000, endedAt: 6000 })
    const dest = resolveWorkerSurfaceChat(db, 'wkr_late', { fleetChatId: '', ownerDm: OWNER_DM })
    expect(dest.chatId).toBe(OWNER_DM)
    expect(dest.via).toBe('owner-dm')
  })

  it('empty turns table still floors to the owner DM (durable last resort)', () => {
    insertGapDispatchedWorker({ id: 'toolu_bare', jsonlAgentId: 'wkr_bare', startedAt: 1000 })
    const dest = resolveWorkerSurfaceChat(db, 'wkr_bare', { fleetChatId: '', ownerDm: OWNER_DM })
    expect(dest.chatId).toBe(OWNER_DM)
    expect(dest.via).toBe('owner-dm')
  })

  it('null db (turn registry disabled) degrades to fleet → owner DM as before', () => {
    const dest = resolveWorkerSurfaceChat(null, 'wkr_any', { fleetChatId: '', ownerDm: OWNER_DM })
    expect(dest).toEqual({ chatId: OWNER_DM, via: 'owner-dm' })
  })
})

describe('gateway dispatch-time stamp — stampSubagentDispatchTurn (msg-6897)', () => {
  const TURN_KEY = `${TOPIC_CHAT}:${TOPIC_THREAD}:2000000`

  function seedOpenTurn() {
    insertTurn({
      turnKey: TURN_KEY,
      chatId: TOPIC_CHAT,
      threadId: TOPIC_THREAD,
      startedAt: 2_000_000,
      endedAt: null,
    })
  }

  it('UPDATE path: stamps a hook-inserted row whose parent_turn_key is NULL', () => {
    seedOpenTurn()
    insertGapDispatchedWorker({ id: 'toolu_stamp', jsonlAgentId: 'wkr_stamp', startedAt: 2_000_500 })

    stampSubagentDispatchTurn(db, {
      toolUseId: 'toolu_stamp',
      parentTurnKey: TURN_KEY,
      agentType: 'worker',
      description: 'Gap-dispatched task',
      background: true,
      now: 2_000_500,
    })

    expect(getSubagent(db, 'toolu_stamp')?.parent_turn_key).toBe(TURN_KEY)
    // End-to-end: the stamped row now resolves to the origin topic.
    const origin = resolveSubagentOriginChatDb(db, 'wkr_stamp')
    expect(origin?.chatId).toBe(TOPIC_CHAT)
    expect(origin?.threadId).toBe(Number(TOPIC_THREAD))
  })

  it('INSERT path: the gateway stamp can land BEFORE the hook row (race) and the hook insert then no-ops', () => {
    seedOpenTurn()
    stampSubagentDispatchTurn(db, {
      toolUseId: 'toolu_first',
      parentTurnKey: TURN_KEY,
      agentType: 'worker',
      description: 'Raced dispatch',
      background: true,
      now: 2_000_600,
    })
    const row = getSubagent(db, 'toolu_first')
    expect(row?.parent_turn_key).toBe(TURN_KEY)
    expect(row?.background).toBe(true)
    expect(row?.status).toBe('running')
  })

  it('never overwrites a hook-stamped parent_turn_key (normal in-turn dispatch unchanged)', () => {
    seedOpenTurn()
    db.prepare(`
      INSERT INTO subagents
        (id, parent_session_id, parent_turn_key, agent_type, description,
         background, started_at, last_activity_at, status, jsonl_agent_id)
      VALUES ('toolu_pre', 'sess-1', 'other:4:999', 'worker', 'Pre-stamped', 1, 2000700, 2000700, 'running', 'wkr_pre')
    `).run()

    stampSubagentDispatchTurn(db, {
      toolUseId: 'toolu_pre',
      parentTurnKey: TURN_KEY,
      background: true,
      now: 2_000_700,
    })

    expect(getSubagent(db, 'toolu_pre')?.parent_turn_key).toBe('other:4:999')
  })
})

describe('recent-turn floor internals', () => {
  it('resolveRecentTurnFallbackChat picks the newest PRE-DISPATCH turn and parses its thread', () => {
    insertTurn({ turnKey: 'a:_:100', chatId: '111', threadId: null, startedAt: 100, endedAt: 200 })
    insertTurn({ turnKey: `b:${TOPIC_THREAD}:300`, chatId: TOPIC_CHAT, threadId: TOPIC_THREAD, startedAt: 300, endedAt: null })
    // A turn STARTED AFTER the worker's dispatch must never win the floor.
    insertTurn({ turnKey: 'c:_:900', chatId: '-1007777777777', threadId: null, startedAt: 900, endedAt: 950 })
    insertGapDispatchedWorker({ id: 'toolu_f', jsonlAgentId: 'wkr_f', startedAt: 500 })
    const recent = resolveRecentTurnFallbackChat(db, 'wkr_f')
    expect(recent?.chatId).toBe(TOPIC_CHAT)
    expect(recent?.threadId).toBe(Number(TOPIC_THREAD))
  })

  it('returns null on an empty turns table', () => {
    insertGapDispatchedWorker({ id: 'toolu_g', jsonlAgentId: 'wkr_g', startedAt: 500 })
    expect(resolveRecentTurnFallbackChat(db, 'wkr_g')).toBeNull()
  })

  it('returns null when the worker has no subagents row (no dispatch time to bound by)', () => {
    insertTurn({ turnKey: 'a:_:100', chatId: '111', threadId: null, startedAt: 100, endedAt: 200 })
    expect(resolveRecentTurnFallbackChat(db, 'wkr_unknown')).toBeNull()
  })
})
