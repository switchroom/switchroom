/**
 * reconcileDefaultSkills — additive default-skill reconciler.
 *
 * Every Switchroom agent — fleet `assistant` and `foreman` alike — gets
 * a baseline set of skills symlinked into `.claude/skills/` (skill-creator,
 * mcp-builder, webapp-testing, pdf/docx/xlsx/pptx, plus a slim switchroom-
 * core trio: cli/status/health). Agents created before a default was
 * introduced never pick it up unless re-scaffolded; this module is the fix.
 *
 * Mirrors `reconcile-default-mcps.ts`. Two responsibilities:
 *
 *   - `reconcileAgentDefaultSkills(agentDir, optOuts)` — install missing
 *     symlinks for one agent. Idempotent (already-correct symlinks are
 *     left alone, real dirs/files at the same path are never touched).
 *   - `reconcileAllAgentDefaultSkills(agentsDir, agentOptOuts)` — iterate
 *     over every agent directory; called from `switchroom update`.
 *
 * Operator opt-out (per-agent or via `defaults.bundled_skills`):
 *
 *     bundled_skills:
 *       pdf: false              # don't install the pdf skill
 *       skill-creator: false    # don't install the skill-creator skill
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBuiltinDefaultSkillEntries, type BuiltinSkillEntry } from "../memory/scaffold-integration.js";

/**
 * Result for a single agent processed by reconcileAgentDefaultSkills.
 */
export interface AgentSkillReconcileResult {
  /** Agent name */
  name: string;
  /** Which skill keys were added (symlink created) */
  added: string[];
  /** Which skill keys were already present and pointing at the right target */
  alreadyPresent: string[];
  /** Which skill keys were skipped due to opt-out */
  optedOut: string[];
  /** Which skill keys were skipped because a real file/dir is in the way */
  conflicts: string[];
  /** True when at least one symlink was added or refreshed */
  changed: boolean;
}

/**
 * Resolve the path to the bundled skills pool inside the installed
 * Switchroom package. The pool is shipped alongside the dist/ output —
 * see `package.json` "files" — so this resolves correctly whether
 * Switchroom is running from source (`bun run dev`) or from a
 * globally installed copy under `node_modules/switchroom-ai/`.
 *
 * Exposed for tests so they can override the pool location with a tmpdir.
 */
export function getBundledSkillsPoolDir(): string {
  return resolve(import.meta.dirname, "../../skills");
}

/**
 * Reconcile the bundled-default skill set into a single agent.
 *
 * Rules:
 *   - For each entry, symlink `<poolDir>/<key>` → `<agentDir>/.claude/skills/<key>`.
 *   - If the destination is already the correct symlink, leave it (idempotent).
 *   - If the destination is a stale symlink pointing somewhere else under
 *     the pool dir, refresh it (heals after a pool path change).
 *   - If the destination is a real file or directory (operator placed it),
 *     leave it alone and record as a conflict.
 *   - Honour `bundled_skills: { <optOutKey>: false }` — never install opted-out skills.
 *
 * @param agentDir   - Absolute path to the agent directory.
 * @param optOuts    - The agent's effective `bundled_skills` map.
 * @param defaults   - Built-in default entries (override for testing).
 * @param poolDir    - The bundled skills pool dir (override for testing).
 */
export function reconcileAgentDefaultSkills(
  agentDir: string,
  optOuts: Record<string, unknown> = {},
  defaults: BuiltinSkillEntry[] = getBuiltinDefaultSkillEntries(),
  poolDir: string = getBundledSkillsPoolDir(),
): AgentSkillReconcileResult {
  const name = agentDir.split("/").pop() ?? agentDir;
  const result: AgentSkillReconcileResult = {
    name,
    added: [],
    alreadyPresent: [],
    optedOut: [],
    conflicts: [],
    changed: false,
  };

  const claudeDir = join(agentDir, ".claude");
  if (!existsSync(claudeDir)) {
    // Agent not yet scaffolded — skip silently. Scaffolding will call
    // through the same path and pick it up.
    return result;
  }

  const targetDir = join(claudeDir, "skills");
  mkdirSync(targetDir, { recursive: true });

  for (const entry of defaults) {
    if (optOuts[entry.optOutKey] === false) {
      result.optedOut.push(entry.key);
      continue;
    }

    const src = join(poolDir, entry.key);
    if (!existsSync(src)) {
      // Pool missing this skill (e.g. trimmed install). Don't fail the
      // whole reconcile — just skip silently.
      continue;
    }

    const dest = join(targetDir, entry.key);
    let existing;
    try {
      existing = lstatSync(dest);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        let currentTarget: string | null = null;
        try {
          currentTarget = readlinkSync(dest);
        } catch { /* unreadable */ }
        if (currentTarget === src) {
          result.alreadyPresent.push(entry.key);
          continue;
        }
        // Stale symlink — refresh only if it points inside the pool dir.
        // A foreign symlink (e.g. operator pointed to a custom location)
        // is left alone.
        if (currentTarget && currentTarget.startsWith(poolDir)) {
          try { rmSync(dest, { force: true }); } catch { /* best effort */ }
        } else {
          result.conflicts.push(entry.key);
          continue;
        }
      } else {
        // Real dir or file — never touch.
        result.conflicts.push(entry.key);
        continue;
      }
    }

    try {
      symlinkSync(src, dest);
      result.added.push(entry.key);
      result.changed = true;
    } catch (err) {
      // Fallthrough — log via conflicts so the operator sees something
      // happened, but don't throw.
      result.conflicts.push(entry.key);
      void err;
    }
  }

  return result;
}

/**
 * Iterate over every agent directory in `agentsDir` and call
 * `reconcileAgentDefaultSkills` for each.
 *
 * @param agentsDir       - Resolved agents directory (e.g. ~/.switchroom/agents)
 * @param agentOptOuts    - Map of agent name → effective bundled_skills map.
 *                          Agents absent from this map are treated as having
 *                          no opt-outs.
 * @param defaults        - Built-in default entries (override for testing).
 * @param poolDir         - The bundled skills pool dir (override for testing).
 */
export function reconcileAllAgentDefaultSkills(
  agentsDir: string,
  agentOptOuts: Record<string, Record<string, unknown>> = {},
  defaults: BuiltinSkillEntry[] = getBuiltinDefaultSkillEntries(),
  poolDir: string = getBundledSkillsPoolDir(),
): AgentSkillReconcileResult[] {
  if (!existsSync(agentsDir)) return [];

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const results: AgentSkillReconcileResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentDir = resolve(agentsDir, entry.name);
    const optOuts = agentOptOuts[entry.name] ?? {};
    results.push(reconcileAgentDefaultSkills(agentDir, optOuts, defaults, poolDir));
  }

  return results;
}
