/**
 * reconcileDefaultMcps — additive MCP reconciler for `switchroom update`.
 *
 * Problem: built-in default MCP servers (e.g. @playwright/mcp, added in #358)
 * are written into settings.json only at scaffold time. Agents created before a
 * default was introduced never pick it up unless re-scaffolded.
 *
 * This module is the fix: iterate over every agent directory, check which
 * built-in defaults are missing from settings.json, honour per-agent opt-outs,
 * and add only what's absent. Idempotent — running twice produces no changes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBuiltinDefaultMcpEntries, type BuiltinMcpEntry } from "../memory/scaffold-integration.js";
import { atomicWriteFileSync } from "../util/atomic.js";

/**
 * Result for a single agent processed by reconcileDefaultMcps.
 */
export interface AgentMcpReconcileResult {
  /** Agent name */
  name: string;
  /** Which built-in MCP keys were added */
  added: string[];
  /** Which built-in MCP keys were already present (no change) */
  alreadyPresent: string[];
  /** Which built-in MCP keys were skipped due to opt-out */
  optedOut: string[];
  /**
   * True when settings.json was written (i.e. at least one entry was added).
   * False means the file was untouched.
   */
  changed: boolean;
}

/**
 * Reconcile built-in default MCP entries into a single agent's settings.json.
 *
 * Rules:
 *   - If the agent's settings.json already has an entry for a default key,
 *     leave it alone (user may have customised command/args/env).
 *   - If the agent's effective config opts out (`mcp_servers: { key: false }`),
 *     skip that entry.
 *   - Otherwise, add the missing entry.
 *   - If nothing changed, do NOT write the file (idempotent).
 *
 * @param agentDir      - Absolute path to the agent directory
 * @param mcpOptOuts    - The agent's `mcp_servers` map from switchroom.yaml
 *                        (only `false` values are meaningful here)
 * @param defaults      - Built-in default entries to reconcile
 *                        (defaults to getBuiltinDefaultMcpEntries())
 */
export function reconcileAgentDefaultMcps(
  agentDir: string,
  mcpOptOuts: Record<string, unknown> = {},
  defaults: BuiltinMcpEntry[] = getBuiltinDefaultMcpEntries(),
): AgentMcpReconcileResult {
  const name = agentDir.split("/").pop() ?? agentDir;
  const settingsPath = join(agentDir, ".claude", "settings.json");

  const result: AgentMcpReconcileResult = {
    name,
    added: [],
    alreadyPresent: [],
    optedOut: [],
    changed: false,
  };

  if (!existsSync(settingsPath)) {
    // Agent not yet scaffolded or non-standard layout — skip silently.
    return result;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    // Corrupt settings.json — leave it alone, don't risk overwriting.
    return result;
  }

  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;

  for (const entry of defaults) {
    const isOptOut = mcpOptOuts[entry.optOutKey] === false;
    if (isOptOut) {
      result.optedOut.push(entry.key);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(mcpServers, entry.key)) {
      result.alreadyPresent.push(entry.key);
      continue;
    }

    // Missing and not opted out — add it.
    mcpServers[entry.key] = entry.value;
    result.added.push(entry.key);
  }

  if (result.added.length > 0) {
    settings.mcpServers = mcpServers;
    // Atomic tmp+fsync+rename so a crash/ENOSPC mid-write can never leave a
    // torn or truncated settings.json (which the read at line ~76 would then
    // fail to JSON.parse, silently disabling the agent's MCP servers). Preserve
    // the existing file's inode mode across the swap — the plain writeFileSync
    // this replaced kept the mode of the already-existing file, whereas
    // atomicWriteFileSync creates a fresh tmp inode, so we carry the mode over
    // explicitly (default 0o600 to match the scaffold's settings.json mode).
    let mode = 0o600;
    try {
      mode = statSync(settingsPath).mode & 0o777;
    } catch {
      /* fall back to 0o600 */
    }
    atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", mode);
    result.changed = true;
  }

  return result;
}

/**
 * Iterate over every agent in `agentsDir` and call reconcileAgentDefaultMcps.
 *
 * @param agentsDir   - The resolved agents directory (e.g. ~/.switchroom/agents)
 * @param agentOptOuts - Map of agent name → their `mcp_servers` config block.
 *                       Agents absent from this map are treated as having no
 *                       opt-outs.
 * @param defaults    - Built-in default entries (override for testing)
 */
export function reconcileAllAgentDefaultMcps(
  agentsDir: string,
  agentOptOuts: Record<string, Record<string, unknown>> = {},
  defaults: BuiltinMcpEntry[] = getBuiltinDefaultMcpEntries(),
): AgentMcpReconcileResult[] {
  if (!existsSync(agentsDir)) return [];

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const results: AgentMcpReconcileResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const agentDir = resolve(agentsDir, name);
    const optOuts = agentOptOuts[name] ?? {};
    const result = reconcileAgentDefaultMcps(agentDir, optOuts, defaults);
    results.push(result);
  }

  return results;
}
