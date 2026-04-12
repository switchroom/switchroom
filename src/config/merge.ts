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

import type { AgentConfig, AgentDefaults, AgentHooks, Profile } from "./schema.js";

/**
 * Resolve whether an agent should load the forked clerk-telegram MCP.
 * Reads `channels.telegram.plugin`:
 *   - "clerk"    → load the fork via --dangerously-load-development-channels
 *   - "official" → use the upstream marketplace plugin
 *   - unset      → upstream marketplace plugin (default)
 */
export function usesClerkTelegramPlugin(agent: AgentConfig): boolean {
  return agent.channels?.telegram?.plugin === "clerk";
}

/**
 * Translate clerk's ergonomic hook shape into Claude Code's native
 * settings.json shape. The flat form:
 *
 *   hooks:
 *     UserPromptSubmit:
 *       - command: /path/to/recall.sh
 *         timeout: 12
 *
 * becomes:
 *
 *   {
 *     UserPromptSubmit: [
 *       { hooks: [{ type: "command", command: "/path/to/recall.sh", timeout: 12 }] }
 *     ]
 *   }
 *
 * The nested `{ hooks: [...] }` wrapper is Claude Code's matcher-group
 * structure; we always emit a single group per event since our schema
 * already supports per-entry matchers.
 */
export function translateHooksToClaudeShape(
  hooks: AgentHooks,
): Record<string, unknown> | undefined {
  if (!hooks) return undefined;
  const out: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    out[event] = [
      {
        hooks: entries.map((e) => {
          const entry: Record<string, unknown> = {
            type: "command",
            command: e.command,
          };
          if (e.timeout !== undefined) entry.timeout = e.timeout;
          if (e.async !== undefined) entry.async = e.async;
          if (e.env !== undefined) entry.env = e.env;
          if (e.matcher !== undefined) entry.matcher = e.matcher;
          return entry;
        }),
      },
    ];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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

/**
 * Recursive deep-merge for plain JSON-ish values. Used by the
 * `settings_raw` cascade so users can layer partial overrides:
 *
 *   defaults.settings_raw: { permissions: { defaultMode: "auto" } }
 *   agent.settings_raw:    { permissions: { deny: ["Bash(rm -rf *)"] } }
 *
 * produces:
 *
 *   { permissions: { defaultMode: "auto", deny: [...] } }
 *
 * Semantics:
 *   - Objects are merged per-key recursively.
 *   - Arrays are REPLACED (not concatenated). Users who want array
 *     union should use the typed fields (tools.allow, hooks, skills).
 *     settings_raw is for power-user overrides, not array building.
 *   - Primitives and null override.
 *
 * Exported so scaffold.ts can reuse the same semantics when applying
 * `settings_raw` onto the computed settings.json object.
 */
export function deepMergeJson(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (base === undefined) return override;
  if (
    typeof base !== "object" || base === null || Array.isArray(base)
    || typeof override !== "object" || override === null || Array.isArray(override)
  ) {
    return override;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    // Skip prototype-pollution keys — a `__proto__` or `constructor`
    // entry in settings_raw would otherwise mutate Object.prototype.
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = deepMergeJson(out[k], v);
  }
  return out;
}

/**
 * Full three-layer cascade: global `defaults:` → named profile (from
 * `extends:`) → per-agent config. This is the public entry point that
 * scaffold/reconcile call once at the top; every downstream read sees
 * the merged result.
 *
 * Resolution:
 *   1. If `agent.extends` is set and a matching profile exists in the
 *      clerk.yaml `profiles:` map, stack it between defaults and the
 *      agent (defaults → profile → agent order, each layer wins over
 *      the one below it).
 *   2. If `agent.extends` is set but no inline profile matches, the
 *      name still drives filesystem profile resolution for rendering
 *      assets (CLAUDE.md.hbs, skills/) in scaffold.ts. Missing inline
 *      profiles are silent — not an error — because filesystem-only
 *      profiles are the common case today.
 *   3. If `agent.extends` is unset, only the defaults layer applies.
 *
 * Single-level extends only — profile-to-profile chains are not
 * resolved. Add recursion here if that use case appears.
 */
export function resolveAgentConfig(
  defaults: AgentDefaults | undefined,
  profiles: Record<string, Profile> | undefined,
  agent: AgentConfig,
): AgentConfig {
  const name = agent.extends;
  const profile = name && profiles ? profiles[name] : undefined;

  if (!profile) {
    return mergeAgentConfig(defaults, agent);
  }

  // Treat the inline profile as a synthetic "agent" for the first
  // merge step, then treat the result as "defaults" for the second.
  // Runtime shapes are compatible — Profile is a superset of
  // AgentDefaults (profiles can carry `extends:` themselves, although
  // we don't chain resolution). Strip extends from the synthesized
  // layer so it doesn't leak into the per-agent config.
  const { extends: _unused, ...profileWithoutExtends } = profile;
  const layered = mergeAgentConfig(
    defaults,
    profileWithoutExtends as unknown as AgentConfig,
  );
  return mergeAgentConfig(layered as unknown as AgentDefaults, agent);
}

export function mergeAgentConfig(
  defaults: AgentDefaults | undefined,
  agent: AgentConfig,
): AgentConfig {
  if (!defaults) return agent;

  const merged: AgentConfig = { ...agent };

  // --- Scalar fields: agent wins, defaults fill blanks ---
  //
  // `extends` is read only from the agent/profile — AgentDefaultsSchema
  // does not carry it (defaults IS the bottom of the cascade).
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

  // --- hooks: per-event concat (defaults first, agent extends) ---
  //
  // Unlike tools.allow we do NOT dedup hook entries — two identical
  // command strings may still be intentionally both present (e.g. an
  // auditor hook declared globally and re-declared with a different
  // matcher on an individual agent). Users who want dedup can reach for
  // the matcher field.
  if (defaults.hooks || merged.hooks) {
    const result: Record<string, unknown[]> = {};
    const dHooks = defaults.hooks ?? {};
    const aHooks = merged.hooks ?? {};
    const events = new Set<string>([
      ...Object.keys(dHooks),
      ...Object.keys(aHooks),
    ]);
    for (const event of events) {
      const d = (dHooks as Record<string, unknown[]>)[event] ?? [];
      const a = (aHooks as Record<string, unknown[]>)[event] ?? [];
      result[event] = [...d, ...a];
    }
    merged.hooks = result as AgentConfig["hooks"];
  }

  // --- env: per-key merge, agent wins ---
  if (defaults.env || merged.env) {
    merged.env = {
      ...(defaults.env ?? {}),
      ...(merged.env ?? {}),
    };
  }

  // --- channels: per-channel shallow merge, agent wins ---
  //
  // Today only telegram exists; the structure generalizes for future
  // channels. We merge telegram field-by-field: defaults.channels.telegram
  // lays down the base, agent fields override.
  if (defaults.channels || merged.channels) {
    const dChan = defaults.channels ?? {};
    const aChan = merged.channels ?? {};
    const combined: Record<string, unknown> = { ...dChan };
    for (const [key, value] of Object.entries(aChan)) {
      if (value === undefined) continue;
      // Per-channel deep merge (one level)
      const base = (combined[key] as Record<string, unknown> | undefined) ?? {};
      const override = value as Record<string, unknown>;
      const field: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(override)) {
        if (v !== undefined) field[k] = v;
      }
      combined[key] = field;
    }
    merged.channels = combined as AgentConfig["channels"];
  }

  // --- system_prompt_append: concatenate, defaults first ---
  //
  // Joined with a blank line so each layer reads as a separate
  // paragraph in the final system prompt.
  if (defaults.system_prompt_append || merged.system_prompt_append) {
    const parts = [
      defaults.system_prompt_append,
      merged.system_prompt_append,
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    merged.system_prompt_append = parts.join("\n\n");
  }

  // --- schedule: concat (defaults first) ---
  //
  // Only prepend defaults when they have entries; otherwise leave the
  // agent's schedule untouched. The `?? []` guard protects the
  // cross-layer case in resolveAgentConfig where a profile (cast to
  // AgentConfig for the merge primitive) legitimately has no schedule
  // field at all — without the guard `[...undefined]` would throw.
  if (defaults.schedule && defaults.schedule.length > 0) {
    merged.schedule = [...defaults.schedule, ...(merged.schedule ?? [])];
  }

  // --- skills: union, dedup-preserving-order (defaults first) ---
  //
  // A user with `defaults.skills: [checkin, retain]` and an agent with
  // `skills: [checkin, weekly-review]` ends up with three distinct
  // names; `checkin` is not symlinked twice.
  if (defaults.skills || merged.skills) {
    const d = defaults.skills ?? [];
    const a = merged.skills ?? [];
    merged.skills = dedupe([...d, ...a]);
  }

  // --- settings_raw: deep merge, agent wins ---
  if (defaults.settings_raw || merged.settings_raw) {
    merged.settings_raw = deepMergeJson(
      defaults.settings_raw ?? {},
      merged.settings_raw ?? {},
    ) as AgentConfig["settings_raw"];
  }

  // --- claude_md_raw: concatenate with blank-line separator ---
  if (defaults.claude_md_raw || merged.claude_md_raw) {
    const parts = [defaults.claude_md_raw, merged.claude_md_raw]
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    merged.claude_md_raw = parts.join("\n\n");
  }

  // --- cli_args: concat (defaults first), no dedup ---
  //
  // We don't dedup because a user may pass the same flag with
  // different values (e.g. --add-dir A --add-dir B), and some flags
  // are repeatable by design.
  if (defaults.cli_args || merged.cli_args) {
    merged.cli_args = [
      ...(defaults.cli_args ?? []),
      ...(merged.cli_args ?? []),
    ];
  }

  return merged;
}
