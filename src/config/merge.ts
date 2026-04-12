/**
 * Three-layer cascade merge: global defaults → per-agent config.
 *
 * clerk.yaml supports a top-level `defaults:` block that is merged into
 * each agent's config before scaffold/reconcile runs. This lets users
 * declare "every agent gets this model / these tools / this MCP server /
 * this schedule" in one place instead of copy-pasting per agent.
 *
 * Merge semantics (see tests/merge.test.ts for the full matrix):
 *
 *   - Scalars (template, bot_token, model, dangerous_mode, ...):
 *     per-agent value wins; defaults fill in when agent leaves the field
 *     unset.
 *
 *   - tools.allow / tools.deny: UNION. Dedup-preserving-order. This is
 *     the critical case — a default allow-list should not be blown away
 *     by an agent adding one more tool.
 *
 *   - mcp_servers: per-key shallow merge. Agent overrides a default
 *     entry by declaring the same key.
 *
 *   - soul, memory: shallow (per-field) merge, agent wins field-by-field.
 *
 *   - schedule: concatenated (defaults entries first). No dedup —
 *     identical cron+prompt would still fire twice, but that's a config
 *     error not a merge error.
 *
 * The function always returns a new AgentConfig; inputs are not mutated.
 */

import type { AgentConfig, AgentDefaults } from "./schema.js";

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function mergeAgentConfig(
  defaults: AgentDefaults | undefined,
  agent: AgentConfig,
): AgentConfig {
  if (!defaults) return agent;

  const merged: AgentConfig = { ...agent };

  // --- Scalar fields: agent wins, defaults fill blanks ---
  //
  // template is optional (no zod default) so that this cascade can
  // distinguish "agent didn't specify" from "agent explicitly chose".
  // If the merged result ends up undefined (neither side set it), the
  // consumer falls back to DEFAULT_TEMPLATE — see scaffold.ts.
  if (defaults.template !== undefined && merged.template === undefined) {
    merged.template = defaults.template;
  }
  if (defaults.bot_token !== undefined && merged.bot_token === undefined) {
    merged.bot_token = defaults.bot_token;
  }
  if (defaults.model !== undefined && merged.model === undefined) {
    merged.model = defaults.model;
  }
  if (defaults.dangerous_mode !== undefined && merged.dangerous_mode === undefined) {
    merged.dangerous_mode = defaults.dangerous_mode;
  }
  if (
    defaults.skip_permission_prompt !== undefined
    && merged.skip_permission_prompt === undefined
  ) {
    merged.skip_permission_prompt = defaults.skip_permission_prompt;
  }
  if (defaults.use_clerk_plugin !== undefined && merged.use_clerk_plugin === undefined) {
    merged.use_clerk_plugin = defaults.use_clerk_plugin;
  }

  // --- tools: union (dedup-preserving-order, defaults first) ---
  if (defaults.tools || merged.tools) {
    const dAllow = defaults.tools?.allow ?? [];
    const aAllow = merged.tools?.allow ?? [];
    const dDeny = defaults.tools?.deny ?? [];
    const aDeny = merged.tools?.deny ?? [];
    merged.tools = {
      allow: dedupe([...dAllow, ...aAllow]),
      deny: dedupe([...dDeny, ...aDeny]),
    };
  }

  // --- soul: shallow field merge, agent wins ---
  //
  // A default soul can provide a fallback persona ("warm, concise") that
  // per-agent soul fields override. Undefined agent fields don't clobber
  // defaults.
  if (defaults.soul || merged.soul) {
    const base = defaults.soul ?? {};
    const override = merged.soul ?? {};
    const combined: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v !== undefined) combined[k] = v;
    }
    // AgentSchema's soul requires name+style; the merged result might be
    // missing one or both if defaults supplies a partial and the agent
    // supplies nothing. That's fine for scaffold.ts which renders soul
    // via Handlebars (missing fields render as empty strings).
    merged.soul = combined as AgentConfig["soul"];
  }

  // --- memory: shallow field merge, agent wins ---
  if (defaults.memory || merged.memory) {
    const base = defaults.memory ?? {};
    const override = merged.memory ?? {};
    const combined: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v !== undefined) combined[k] = v;
    }
    merged.memory = combined as AgentConfig["memory"];
  }

  // --- mcp_servers: per-key shallow merge, agent wins on conflict ---
  if (defaults.mcp_servers || merged.mcp_servers) {
    merged.mcp_servers = {
      ...(defaults.mcp_servers ?? {}),
      ...(merged.mcp_servers ?? {}),
    };
  }

  // --- schedule: concat (defaults first) ---
  //
  // Only prepend defaults when they have entries; otherwise leave the
  // agent's schedule untouched (even if it's the zod default []).
  if (defaults.schedule && defaults.schedule.length > 0) {
    merged.schedule = [...defaults.schedule, ...merged.schedule];
  }

  return merged;
}
