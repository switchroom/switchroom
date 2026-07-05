/**
 * Tool-surface right-sizing for the switchroom-telegram MCP server (P4).
 *
 * switchroom-telegram is the primary interface, so its tool schemas are
 * always-loaded on EVERY agent, every turn (~8k tokens). Two reductions,
 * both native to Claude Code tool-search (honored in 2.1.177; the MCP SDK
 * preserves `_meta` on tools/list — @modelcontextprotocol/sdk ToolSchema
 * has `_meta: z.record(...).optional()`):
 *
 *   A. Connection gating — linear_* tools are advertised only when the
 *      agent has the Linear connection configured (the gateway sets
 *      SWITCHROOM_TELEGRAM_LINEAR=1 from channels.telegram.linear_agent.
 *      enabled). A non-Linear agent never carries their schema at all.
 *
 *   B. Per-tool deferral — the server is no longer pinned wholesale
 *      (scaffold sets alwaysLoad:false). We pin ONLY the load-bearing hot
 *      tools via `_meta["anthropic/alwaysLoad"]` so they never defer (the
 *      reply path must never pay a ToolSearch round-trip before it can
 *      answer); the ~14 cold tools defer and load on first use.
 *
 * Pure + side-effect free so it's unit-testable in isolation (bridge.ts
 * has import-time side effects). Both reductions are non-destructive — every
 * tool the agent is entitled to still works; cold ones just load on demand.
 */

/** Minimal shape we need from a tool schema. */
export interface NamedTool {
  name: string
  [k: string]: unknown
}

/**
 * Hot tools pinned loaded — must never defer. The reply path plus the
 * frequently-used early-turn ops. Everything NOT in this set defers under
 * tool-search.
 */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  'reply',
  'get_recent_messages',
  'react',
  'edit_message',
  'send_typing',
  'download_attachment',
])

/** Linear tools — advertised only when the Linear connection is configured. */
export const LINEAR_TOOLS: ReadonlySet<string> = new Set([
  'linear_agent_activity',
  'linear_create_issue',
  'linear_agent_setup',
])

/** The env var the gateway sets (per .mcp.json) when Linear is configured. */
export const LINEAR_ENV = 'SWITCHROOM_TELEGRAM_LINEAR'

export interface ToolFilterOpts {
  /** True when the Linear connection is configured for this agent. */
  linearEnabled: boolean
}

/**
 * Apply connection gating (A) + per-tool deferral pins (B) to a tool list.
 * Returns a NEW array; inputs are not mutated. Order is preserved.
 */
export function buildEffectiveToolSchemas<T extends NamedTool>(
  schemas: ReadonlyArray<T>,
  opts: ToolFilterOpts,
): Array<T & { _meta?: { 'anthropic/alwaysLoad': true } }> {
  return schemas
    .filter((t) => opts.linearEnabled || !LINEAR_TOOLS.has(t.name))
    .map((t) =>
      ALWAYS_LOAD_TOOLS.has(t.name)
        ? { ...t, _meta: { 'anthropic/alwaysLoad': true as const } }
        : t,
    )
}
