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
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBuiltinDefaultSkillEntries, type BuiltinSkillEntry } from "../memory/scaffold-integration.js";

/** Track which missing-pool-dir warnings we've already emitted so the
 *  stderr line fires once per process rather than once per agent. */
const warnedMissingPool = new Set<string>();
function warnMissingPoolDir(poolDir: string): void {
  if (warnedMissingPool.has(poolDir)) return;
  warnedMissingPool.add(poolDir);
  process.stderr.write(
    `switchroom: bundled skills pool dir not found at ${poolDir} — run \`switchroom update\` to install it.\n`,
  );
}

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
  /** Which owned _bundled links were REMOVED by the ownership-scoped prune
   *  (footgun E): a default that is now opted-out, or an owned link whose
   *  pool target has gone missing (dangling). Strictly scoped — a prune here
   *  can only ever touch a link at `<key>` (a current builtin-default key)
   *  whose target resolves under `.../skills/_bundled/`. Personal-pool links
   *  and operator hand-links are structurally out of scope. */
  pruned: string[];
  /** True when at least one symlink was added or refreshed */
  changed: boolean;
}

/**
 * Resolve the path to the bundled skills pool. Switchroom now mirrors
 * the shipped skill set into `~/.switchroom/skills/_bundled/` on each
 * `switchroom update`, so the runtime resolution is host-stable and
 * works identically across dev checkouts, packaged installs, and
 * docker containers (where the in-image path `/opt/switchroom/skills/`
 * is the wrong answer for an HOME-bind-mounted state dir).
 *
 * Exposed for tests so they can override the pool location with a tmpdir.
 */
export function getBundledSkillsPoolDir(): string {
  return resolve(homedir(), ".switchroom/skills/_bundled");
}

/**
 * Predicate: is `target` a stale symlink that switchroom installed
 * under a previous resolver — and therefore safe to delete and
 * recreate? Matches the current pool dir AND legacy prefixes (any
 * path containing `/switchroom/skills/` — dev-checkout or packaged —
 * the `/opt/skills/` baked-image path used by pre-fix containers, plus
 * the retired bun-global install path `.../node_modules/switchroom-ai/
 * skills/` (RCA: carrie's 7 permanently-dangling links, #1164)).
 */
function isOwnedStaleLink(target: string, poolDir: string): boolean {
  if (target.startsWith(poolDir)) return true;
  if (target.includes("/switchroom/skills/")) return true;
  if (target.startsWith("/opt/skills/")) return true;
  if (target.includes("/switchroom-ai/skills/")) return true;
  return false;
}

/**
 * STRICT ownership test for the prune (footgun E, review CRITICAL).
 *
 * Returns true ONLY when `dest` is a symlink whose target resolves into the
 * bundled pool dir `<poolDir>` (`.../skills/_bundled/`). This is deliberately
 * NARROWER than `isOwnedStaleLink` (which matches any `/switchroom/skills/`
 * target, INCLUDING personal-pool links `skills/<name>` — reusing it for the
 * prune would delete operator/personal skills). A prune must never remove a
 * personal-pool link (target `skills/<name>`) or an operator hand-link, so the
 * prune scope is: name ∈ current builtin-default keys AND this predicate.
 *
 * Relative targets (the form switchroom writes post-footgun-A) are resolved
 * against the link's own directory, exactly as the kernel does on traversal,
 * so this works for both relative and legacy-absolute owned links.
 */
function isOwnedBundledLink(dest: string, poolDir: string): boolean {
  let stored: string | null = null;
  try {
    if (!lstatSync(dest).isSymbolicLink()) return false;
    stored = readlinkSync(dest);
  } catch {
    return false;
  }
  if (!stored) return false;
  const resolved = isAbsolute(stored) ? stored : resolve(dirname(dest), stored);
  // Normalize both to a trailing-slash boundary so `_bundled` can't match a
  // sibling like `_bundledX`.
  const poolPrefix = poolDir.endsWith("/") ? poolDir : poolDir + "/";
  return resolved === poolDir || resolved.startsWith(poolPrefix);
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
    pruned: [],
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

  if (!existsSync(poolDir)) {
    warnMissingPoolDir(poolDir);
    return result;
  }

  for (const entry of defaults) {
    const dest = join(targetDir, entry.key);

    if (optOuts[entry.optOutKey] === false) {
      result.optedOut.push(entry.key);
      // Ownership-scoped prune (footgun E): an opted-out default must not
      // leave a stale owned link behind. Remove the link ONLY when it is an
      // owned _bundled link (target resolves under the pool). A real dir, a
      // personal-pool link, or an operator hand-link at this path is left
      // untouched — the strict `isOwnedBundledLink` scope is what makes this
      // safe (the review CRITICAL: never reuse the broad isOwnedStaleLink).
      if (isOwnedBundledLink(dest, poolDir)) {
        try {
          rmSync(dest, { force: true });
          result.pruned.push(entry.key);
          result.changed = true;
        } catch { /* best effort */ }
      }
      continue;
    }

    const src = join(poolDir, entry.key);
    if (!existsSync(src)) {
      // Pool missing this skill (e.g. trimmed install). Don't fail the whole
      // reconcile. But if we're holding a now-DANGLING owned _bundled link
      // for this default (target vanished), prune it — a dangling owned link
      // is dead weight and confuses doctor. Same strict ownership scope: only
      // an owned _bundled link, never a personal/real entry.
      if (isOwnedBundledLink(dest, poolDir)) {
        try {
          rmSync(dest, { force: true });
          result.pruned.push(entry.key);
          result.changed = true;
        } catch { /* best effort */ }
      }
      continue;
    }

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
        // Stale symlink — refresh if it points inside the current pool
        // OR matches a legacy switchroom-owned prefix (dev-checkout
        // `*/switchroom/skills/*` or packaged `/opt/skills/*`). This
        // is the migration path that heals broken symlinks on user
        // machines after the pool-dir relocation (RCA: #1164). A
        // foreign symlink (operator pointed to a custom location)
        // is left alone.
        if (currentTarget && isOwnedStaleLink(currentTarget, poolDir)) {
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
