/**
 * Issue #305 Option A — resolve which sub-agent (by jsonl_agent_id) is
 * calling progress_update.
 *
 * Three resolution strategies, in priority order:
 *   1. agentIdHint — exact match on subagents.jsonl_agent_id
 *   2. toolUseIdHint — exact match on subagents.id (parent's Agent tool_use_id)
 *   3. Heuristic: most-recently-started running sub-agent in the active turn
 *      for this chat. Logs a stderr warning when multiple candidates exist.
 *
 * Returns null if no match (caller falls through to message-send).
 * Never throws; SQL errors return null.
 *
 * Extracted from gateway.ts so the resolver can be unit-tested against an
 * in-memory SQLite DB without spinning up the full grammY bot harness.
 */

/**
 * Minimal duck-typed interface that matches both bun:sqlite's `Database`
 * and the `SqliteDatabase` shape returned by `openTurnsDb`. We accept the
 * narrowed shape so the resolver can run against any equivalent handle.
 */
export interface ResolverDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export interface ResolveCallingSubagentOpts {
  db: ResolverDb | null
  chatId: string
  threadId?: number | string
  agentIdHint: string | null
  toolUseIdHint: string | null
}

export type ResolveCallingSubagentResult = { agentId: string } | null

export function resolveCallingSubagent(
  opts: ResolveCallingSubagentOpts,
): ResolveCallingSubagentResult {
  if (opts.db == null) return null
  try {
    if (opts.agentIdHint != null) {
      const row = opts.db.prepare(
        "SELECT jsonl_agent_id FROM subagents WHERE jsonl_agent_id = ? AND status = 'running'",
      ).get(opts.agentIdHint) as { jsonl_agent_id: string } | undefined
      if (row?.jsonl_agent_id) return { agentId: row.jsonl_agent_id }
    }
    if (opts.toolUseIdHint != null) {
      const row = opts.db.prepare(
        "SELECT jsonl_agent_id FROM subagents WHERE id = ? AND status = 'running'",
      ).get(opts.toolUseIdHint) as { jsonl_agent_id: string | null } | undefined
      if (row?.jsonl_agent_id) return { agentId: row.jsonl_agent_id }
    }
    // Heuristic fallback.
    const turnRow = opts.db.prepare(
      "SELECT turn_key FROM turns WHERE chat_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    ).get(opts.chatId) as { turn_key: string } | undefined
    if (turnRow?.turn_key == null) return null
    const candidates = opts.db.prepare(
      "SELECT jsonl_agent_id FROM subagents WHERE parent_turn_key = ? AND status = 'running' AND jsonl_agent_id IS NOT NULL ORDER BY started_at DESC",
    ).all(turnRow.turn_key) as Array<{ jsonl_agent_id: string }>
    if (candidates.length === 0) return null
    if (candidates.length > 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `progress_update: heuristic resolution selected most-recent of ${candidates.length} running sub-agents (chat=${opts.chatId}); pass agent_id explicitly to avoid mis-attribution`,
      )
    }
    return { agentId: candidates[0].jsonl_agent_id }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('progress_update: resolveCallingSubagent SQL error', err)
    return null
  }
}
