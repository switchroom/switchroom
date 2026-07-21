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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** Track which builtin-default-missing-from-pool errors we've already
 *  emitted so the loud stderr line fires once per (pool, skill) rather
 *  than once per agent (12 agents = 12 duplicate lines otherwise). */
const warnedMissingDefault = new Set<string>();
function warnMissingBuiltinDefault(poolDir: string, key: string): void {
  const marker = `${poolDir} ${key}`;
  if (warnedMissingDefault.has(marker)) return;
  warnedMissingDefault.add(marker);
  process.stderr.write(
    `switchroom: ERROR — builtin default skill "${key}" is missing from the bundled pool ` +
      `(${poolDir}). It ships in the CLI package but was not synced. ` +
      `Re-run \`switchroom update\` to repair the pool; if it persists this is a packaging bug.\n`,
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
  /** Which builtin-default skill keys are declared but missing from the
   *  bundled pool. These are a loud error (footgun C/D): every entry in
   *  `getBuiltinDefaultSkillEntries()` ships in the CLI package, so a
   *  missing one means a broken sync or a packaging regression, not an
   *  operator choice. Callers (e.g. `switchroom update`) treat a
   *  non-empty list as a failure of the update/converge step. */
  missingFromPool: string[];
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
 * Resolve a symlink's stored target to an absolute path. Relative link
 * targets (the format switchroom now writes — see `linkTargetFor`) are
 * resolved against the link's own directory, exactly as the kernel does
 * on traversal. Absolute targets (legacy links baked with `homedir()`)
 * pass through unchanged. Used for the owned/stale/foreign classification
 * so it works identically for relative and absolute links.
 */
function absoluteLinkTarget(linkPath: string, storedTarget: string): string {
  return isAbsolute(storedTarget)
    ? storedTarget
    : resolve(dirname(linkPath), storedTarget);
}

/**
 * The symlink target switchroom writes for `dest` → `src`: a path RELATIVE
 * to the link's own directory (footgun A). Relative links are invariant
 * under the mount-prefix, so a link written from hostd's `/host-home/...`
 * view resolves correctly in an agent's `/home/<op>/...` view — both share
 * one `~/.switchroom` root. Depth is computed via `path.relative`, never a
 * hardcoded `../` literal, so the correct prefix follows the layout
 * automatically (agents/<name>/.claude/skills → pool is 4 up; a personal
 * pool link would be 3 — a single constant would be wrong for both).
 */
function linkTargetFor(dest: string, src: string): string {
  return relative(dirname(dest), src);
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
    missingFromPool: [],
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
    // `existsSync` follows symlinks, so a pool entry that is itself a
    // dangling symlink reports missing here — which is the right call:
    // an unresolvable pool entry is unusable regardless of how it looks
    // in `ls`. Every builtin default ships in the CLI package, so a
    // missing one is NOT an operator opt-out — it is a broken sync or a
    // packaging regression (footgun C/D). Record it loudly and surface
    // it to callers instead of skipping silently.
    if (!existsSync(src)) {
      // A builtin default missing from the pool is a loud packaging/sync error
      // (footgun C/D): record it and warn once, instead of skipping silently.
      result.missingFromPool.push(entry.key);
      warnMissingBuiltinDefault(poolDir, entry.key);
      // AND prune a now-DANGLING owned _bundled link for this default
      // (footgun E): the pool target vanished, so a stale owned link is dead
      // weight and confuses doctor. Strict ownership scope — only an owned
      // _bundled link, never a personal-pool link or a real dir. (These two
      // behaviors are independent and both must run — see the combined-merge
      // test in reconcile-default-skills.test.ts.)
      if (isOwnedBundledLink(dest, poolDir)) {
        try {
          rmSync(dest, { force: true });
          result.pruned.push(entry.key);
          result.changed = true;
        } catch { /* best effort */ }
      }
      continue;
    }

    // `dest` is declared at the top of the loop (needed by the opt-out prune
    // above); compute the desired RELATIVE link target now that `src` exists.
    const relTarget = linkTargetFor(dest, src);

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
        if (currentTarget === relTarget) {
          // Already the correct RELATIVE link — nothing to do (idempotent).
          result.alreadyPresent.push(entry.key);
          continue;
        }
        // Any other switchroom-owned link is refreshed to the relative
        // form. This covers three cases with one rule:
        //   1. A correct-but-ABSOLUTE link (currentTarget === src) — the
        //      one-time footgun-A migration: rewrite absolute → relative.
        //   2. A stale link inside the current pool after a pool-dir move.
        //   3. A legacy switchroom-owned prefix (dev-checkout
        //      `*/switchroom/skills/*`, packaged `/opt/skills/*`, retired
        //      bun-global — RCA #1164).
        // A FOREIGN link (operator pointed at a custom location) is left
        // alone. Classification resolves relative targets against the
        // link dir first so it is identical for relative and absolute links.
        const resolvedTarget = currentTarget
          ? absoluteLinkTarget(dest, currentTarget)
          : null;
        if (resolvedTarget && isOwnedStaleLink(resolvedTarget, poolDir)) {
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
      symlinkSync(relTarget, dest);
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
