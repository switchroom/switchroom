/**
 * Sub-agent surface-chat resolution — the DB-backed seam behind the
 * gateway's `resolveSubagentOriginChat` / `resolveWorkerFeedChat` and the
 * handback/progress destination inputs.
 *
 * Extracted (Telegram msg 6897 misroute, 2026-08-04) so the FULL resolution
 * precedence — including the new most-recent-turn floor — is unit-testable
 * against a real registry DB (gateway.ts is not importable in tests; the
 * repo's `decideWorkerFeedDestination` pattern).
 *
 * Precedence (resolveWorkerSurfaceChat):
 *   1. `origin`       — the dispatch-attributed turn: jsonl_agent_id →
 *      subagents.parent_turn_key (walking the nested-parent chain) →
 *      turns.chat_id/thread_id. The correct answer whenever the row was
 *      stamped (pretool-hook marker stamp #2085, gateway dispatch stamp, or
 *      the watcher's started_at window backfill).
 *   2. `fleet`        — the configured fleet chat (permanently '' today).
 *   3. `recent-turn`  — NEW safe-degradation floor: the chat+topic of the
 *      most recent turn AT OR BEFORE the worker's dispatch time. A
 *      gap-dispatched worker (no turns row open at its started_at, stamp
 *      missed) lands NEAR the work — in the topic the operator drove last
 *      before dispatching — instead of the owner DM with the thread
 *      stripped. Bounded by the dispatch time so a turn the operator drives
 *      LATER in an unrelated (possibly shared) chat can never capture the
 *      worker's surface; with no pre-dispatch turn (or no subagents row to
 *      date the dispatch from) the floor declines and resolution falls to
 *      the owner DM.
 *   4. `owner-dm`     — the durable last resort ("wrong chat" beats
 *      "no card").
 */

import {
  getTurnByKey,
  findMostRecentTurn,
  type Turn,
} from '../registry/turns-schema.js'
import {
  resolveSubagentOriginTurnKey,
  getSubagentByJsonlId,
} from '../registry/subagents-schema.js'

/** Structural sqlite shape — byte-matches the registry modules' own
 *  bun:sqlite structural type, so handles flow both ways without casts. */
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  close(): void
}

export interface SubagentSurfaceChat {
  chatId: string
  threadId?: number
}

export type SubagentSurfaceVia = 'origin' | 'fleet' | 'recent-turn' | 'owner-dm' | 'none'

/** Map a turns row to a routable {chatId, threadId}. Null when the row has
 *  no usable chat. thread_id is stored as TEXT — parse defensively. */
function turnToSurfaceChat(turn: Pick<Turn, 'chat_id' | 'thread_id'> | null): SubagentSurfaceChat | null {
  if (turn == null || turn.chat_id.length === 0) return null
  const threadNum =
    turn.thread_id != null && turn.thread_id.length > 0 ? Number(turn.thread_id) : NaN
  return {
    chatId: turn.chat_id,
    ...(Number.isFinite(threadNum) ? { threadId: threadNum } : {}),
  }
}

/**
 * The dispatch-attributed origin chat for a worker (jsonl stem →
 * parent_turn_key chain → turns row). Null on any miss; never throws.
 * The DB-parameterized body of the gateway's `resolveSubagentOriginChat`.
 */
export function resolveSubagentOriginChatDb(
  db: SqliteDatabase,
  jsonlAgentId: string,
): SubagentSurfaceChat | null {
  try {
    const originKey = resolveSubagentOriginTurnKey(db, jsonlAgentId)
    if (originKey == null) return null
    return turnToSurfaceChat(getTurnByKey(db, originKey))
  } catch {
    return null
  }
}

/**
 * The recent-turn routing floor: chat+topic of the newest turns row
 * (running or ended) started AT OR BEFORE the worker's own dispatch time
 * (`subagents.started_at`, looked up by jsonl stem). The bound is
 * load-bearing (see `findMostRecentTurn`): a turn newer than the dispatch
 * can never be the dispatching context, so flooring to it would leak the
 * worker's surface into whatever unrelated chat the operator drove LAST.
 * Null when the worker has no subagents row (no dispatch time to bound by —
 * declining beats guessing), no pre-dispatch turn exists, or the row is
 * unusable; never throws.
 */
export function resolveRecentTurnFallbackChat(
  db: SqliteDatabase,
  jsonlAgentId: string,
): SubagentSurfaceChat | null {
  try {
    const worker = getSubagentByJsonlId(db, jsonlAgentId)
    if (worker == null) return null
    return turnToSurfaceChat(findMostRecentTurn(db, worker.started_at))
  } catch {
    return null
  }
}

/**
 * Once-per-agent recent-turn-floor audit line (msg-6897 hardening). The floor
 * firing is deliberate safe degradation, but it must never be silent — an
 * operator diagnosing a mis-landed worker surface needs the routing decision
 * on stderr, exactly like the gateway's owner-DM fallback log. Bounded FIFO
 * set (a late duplicate line is harmless; the cap bounds a long gateway
 * lifetime); a gateway restart clears it. `log` injectable for tests.
 */
const RECENT_TURN_FLOOR_LOG_CAP = 256
const recentTurnFloorLogged = new Set<string>()
export function noteWorkerRecentTurnFloor(
  agentId: string,
  dest: SubagentSurfaceChat,
  log: (line: string) => void = (line) => process.stderr.write(line),
): void {
  if (recentTurnFloorLogged.has(agentId)) return
  recentTurnFloorLogged.add(agentId)
  if (recentTurnFloorLogged.size > RECENT_TURN_FLOOR_LOG_CAP) {
    const oldest = recentTurnFloorLogged.values().next().value
    if (oldest != null) recentTurnFloorLogged.delete(oldest)
  }
  log(
    `telegram gateway: worker origin unresolved agent=${agentId} — flooring to pre-dispatch recent turn chat=${dest.chatId}${dest.threadId != null ? ` thread=${dest.threadId}` : ''}\n`,
  )
}

/**
 * The full ladder resolved into the SHAPE the handback/progress deciders
 * take (`decideSubagentHandback` / `decideSubagentProgress`): the resolved
 * surface chat in their `fleetChatId` slot ('' on owner-dm/none so each
 * decider's own `ownerChatId` floor stays the last resort) and the resolved
 * topic in `originThreadId` (omitted when none). Audits the recent-turn
 * floor when it fires. One helper so the gateway call sites are a spread,
 * not a third and fourth hand-rolled copy of the precedence.
 */
export function resolveWorkerSurfaceForDecider(
  db: SqliteDatabase | null,
  jsonlAgentId: string,
  opts: { fleetChatId: string; ownerDm: string },
): { fleetChatId: string; originThreadId?: number } {
  const dest = resolveWorkerSurfaceChat(db, jsonlAgentId, opts)
  if (dest.via === 'recent-turn') noteWorkerRecentTurnFloor(jsonlAgentId, dest)
  return {
    fleetChatId: dest.via === 'owner-dm' || dest.via === 'none' ? '' : dest.chatId,
    ...(dest.threadId != null ? { originThreadId: dest.threadId } : {}),
  }
}

/**
 * Full surface-chat precedence for a worker's card/handback/progress
 * destination. `db` may be null (turn registry disabled) — resolution then
 * degrades to fleet → owner DM exactly as before the recent-turn floor.
 */
export function resolveWorkerSurfaceChat(
  db: SqliteDatabase | null,
  jsonlAgentId: string,
  opts: { fleetChatId: string; ownerDm: string },
): { chatId: string; threadId?: number; via: SubagentSurfaceVia } {
  const origin = db != null ? resolveSubagentOriginChatDb(db, jsonlAgentId) : null
  if (origin != null && origin.chatId.length > 0) return { ...origin, via: 'origin' }
  if (opts.fleetChatId.length > 0) return { chatId: opts.fleetChatId, via: 'fleet' }
  const recent = db != null ? resolveRecentTurnFallbackChat(db, jsonlAgentId) : null
  if (recent != null) return { ...recent, via: 'recent-turn' }
  if (opts.ownerDm.length > 0) return { chatId: opts.ownerDm, via: 'owner-dm' }
  return { chatId: '', via: 'none' }
}
