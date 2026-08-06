/**
 * `switchroom config-repo sync` — native port of the operator's hand-written
 * `~/.switchroom-config/sync.sh`, with the four hardening properties that
 * script never had.
 *
 * ## Why this exists (read before "simplifying")
 *
 * `~/.switchroom/switchroom.yaml` is NOT a symlink into the config repo and
 * cannot be: `switchroom setup` / `switchroom auth use|rotate` rewrite that
 * file via `atomicWriteFileSync` → `rename()`, and `rename()` on Linux
 * REPLACES a destination symlink with a fresh regular file. A symlink would
 * therefore silently detach on the first auth/setup mutation. The live file is
 * the source of truth; this repo tracks a COPY, refreshed here. (The
 * `~/.switchroom/skills` → repo symlink is fine — switchroom only reads that
 * pool, never renames it.) {@link copyYamlAsRegularFile} preserves this
 * invariant.
 *
 * ## What this adds over sync.sh
 *
 *  1. **flock** (`<repo>/.sync.lock`, via the vault PID-file lock) so a manual
 *     run and a scheduled tick can never interleave and corrupt the index.
 *  2. **Symlink-target guard** replacing `cp -L`: a workspace file that is a
 *     symlink is only copied if its target resolves INSIDE that agent's own
 *     workspace tree. `cp -L` would happily follow `MEMORY.md ->
 *     ~/.switchroom/credentials/foo.env` and commit the secret content.
 *  3. **Commit-time secret scan** with the same `scanBundleForSecrets` engine
 *     that gates the personal-skill write path — so a secret that arrived by a
 *     direct rw-mount write (bypassing the in-container CLI scan) is caught
 *     before it is committed. On a hit the file is unstaged and a WARN is
 *     emitted; the rest of the commit proceeds.
 *  4. **Force-add of each `agents/<name>/personal-skills/` slice** — closes GAP A: today
 *     `.gitignore`'s blanket `agents/` leaves every mirrored personal skill
 *     untracked, so a repo clone loses them all. Kept as a force-add allowlist
 *     (never a `!agents/**` gitignore negation, whose excluded-directory
 *     semantics silently fail and risk tracking future secret-shaped files).
 *
 * Push is gated by {@link ConfigRepoSyncOptions.requirePrivate}: refuse to push
 * unless the GitHub API confirms the remote is private. Push rides the
 * operator's existing `gh` credential helper — no new secret, nothing moves
 * into a container.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import { scanBundleForSecrets, type SkillFileMap } from "../cli/skill-common.js";
import { acquireLock } from "../vault/flock.js";

/**
 * Hand-owned agent workspace files captured for rollback. Identical set to
 * sync.sh's `OWNED` array. switchroom-GENERATED files (the agentDir CLAUDE.md,
 * settings.json, .mcp.json, compose) are deliberately NOT captured — they
 * regenerate from the product repo + this config.
 */
export const OWNED_WORKSPACE_FILES = [
  "SOUL.md",
  "SOUL.custom.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "CLAUDE.md",
  "CLAUDE.custom.md",
] as const;

/** Personal-skills subdir under each `agents/<name>/` slice in the repo. */
export const PERSONAL_SKILLS_SUBPATH = "personal-skills";

/**
 * Upper bound on a single file read during the commit-time secret scan.
 * A file larger than this is skipped (not scanned) — the scan targets
 * human-authored config/skill text, not multi-MB blobs, and reading a
 * runaway file into a utf-8 string would be wasteful. The private-repo
 * push gate is the second wall for anything the scan does not read.
 */
export const SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Result of one shelled command. */
export interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs an argv and returns a normalized result. Injectable for tests. */
export type CmdRunner = (args: string[]) => CmdResult;

export interface ConfigRepoSyncDeps {
  /** `git` runner already bound to the repo directory (`git -C <repo> …`). */
  git: CmdRunner;
  /** `gh` runner (used only for the require_private visibility probe). */
  gh: CmdRunner;
  /** Line logger (stderr in the CLI; a collector in tests). */
  log: (msg: string) => void;
}

export interface ConfigRepoSyncOptions {
  /** The config repo (must contain a `.git`). */
  repoPath: string;
  /** Live `~/.switchroom/switchroom.yaml` (source of truth, copied in). */
  livePath: string;
  /** Live `~/.switchroom/agents` scaffold dir. */
  agentsDir: string;
  /** When false, commit locally only. */
  push: boolean;
  /** Git remote name (default `origin`). */
  remote: string;
  /** Refuse to push unless the GitHub API confirms the remote is private. */
  requirePrivate: boolean;
  /** Commit message override. */
  message?: string;
}

export interface SecretFinding {
  file: string;
  pattern: string;
  rule_id: string;
}

export interface SkippedSymlink {
  file: string;
  reason: string;
}

export interface ConfigRepoSyncResult {
  committed: boolean;
  commitSha?: string;
  pushed: boolean;
  /** Present when a push was wanted but not performed. */
  pushSkippedReason?: string;
  secretFindings: SecretFinding[];
  skippedSymlinks: SkippedSymlink[];
  warnings: string[];
  /** 0 = clean; 10 = completed but a WARN fired (secret dropped / push skipped). */
  exitCode: number;
}

/** Build the default deps: real git bound to the repo, real gh. */
export function defaultSyncDeps(
  repoPath: string,
  log: (msg: string) => void,
): ConfigRepoSyncDeps {
  const runner =
    (bin: string, prefix: string[]): CmdRunner =>
    (args) => {
      const r = spawnSync(bin, [...prefix, ...args], { encoding: "utf-8" });
      return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").trim(),
        stderr: (r.stderr ?? "").trim(),
      };
    };
  return {
    git: runner("git", ["-C", repoPath]),
    gh: runner("gh", []),
    log,
  };
}

/**
 * Copy the live yaml into the repo AS A REGULAR FILE. If the destination is
 * currently a symlink (a repo someone "simplified"), unlink it first so we
 * never write through the link — see the file header for the rename() trap.
 */
export function copyYamlAsRegularFile(livePath: string, repoYamlPath: string): void {
  try {
    if (lstatSync(repoYamlPath).isSymbolicLink()) unlinkSync(repoYamlPath);
  } catch {
    /* dest absent — nothing to unlink */
  }
  copyFileSync(livePath, repoYamlPath);
}

/** True iff `child`'s realpath is inside (or equal to) `root`'s realpath. */
function isInsideTree(childRealPath: string, rootRealPath: string): boolean {
  if (childRealPath === rootRealPath) return true;
  const rel = relative(rootRealPath, childRealPath);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..";
}

export type GuardedCopyStatus = "copied" | "missing" | "escape" | "irregular";

export interface GuardedCopyResult {
  status: GuardedCopyStatus;
  /** Realpath the symlink resolved to (for escape/irregular diagnostics). */
  target?: string;
}

/**
 * Copy `src` → `dest`, following a symlink ONLY when its target resolves inside
 * `allowedRoot`. This is the guarded replacement for sync.sh's `cp -L`:
 *
 *   - regular file inside the tree → copied
 *   - symlink whose target escapes `allowedRoot` → NOT copied (`escape`)
 *   - symlink/target that is not a regular file → NOT copied (`irregular`)
 *   - src absent → `missing`
 *
 * The dest parent dir is created as needed.
 */
export function guardedCopyFile(
  src: string,
  dest: string,
  allowedRoot: string,
): GuardedCopyResult {
  // lstat (does not follow) purely to distinguish "absent" from "escape".
  try {
    lstatSync(src);
  } catch {
    return { status: "missing" };
  }

  // Resolve through EVERY symlink (leaf AND any intermediate directory) and
  // enforce containment. A `cp -L` follows all of them; checking only the leaf
  // would miss a `workspace/memory -> ~/.switchroom/credentials` dir symlink.
  // realpathSync throws on a dangling link — treat that as missing.
  let real: string;
  try {
    real = realpathSync(src);
  } catch {
    return { status: "missing" };
  }
  let root: string;
  try {
    root = realpathSync(allowedRoot);
  } catch {
    return { status: "escape", target: real };
  }
  if (!isInsideTree(real, root)) {
    return { status: "escape", target: real };
  }

  // Only ever copy a regular file's content.
  let realStat;
  try {
    realStat = statSync(real);
  } catch {
    return { status: "missing" };
  }
  if (!realStat.isFile()) {
    return { status: "irregular", target: real };
  }

  mkdirSync(join(dest, ".."), { recursive: true });
  copyFileSync(real, dest);
  return { status: "copied" };
}

/**
 * Copy one agent's OWNED workspace files + memory + custom-MCP source from the
 * live scaffold into the repo, using the guarded copy. Mutates `skipped` with
 * any symlink-escape/irregular skips. Returns nothing — staging is a later
 * step.
 */
function copyAgentWorkspace(
  agentName: string,
  liveWorkspace: string,
  repoWorkspace: string,
  skipped: SkippedSymlink[],
  log: (m: string) => void,
): void {
  const guard = (src: string, dest: string): void => {
    const r = guardedCopyFile(src, dest, liveWorkspace);
    if (r.status === "escape") {
      const rel = `agents/${agentName}/workspace/${relative(liveWorkspace, src)}`;
      skipped.push({
        file: rel,
        reason: `symlink target ${r.target} is outside the agent workspace tree`,
      });
      log(`config-repo: SKIP ${rel} — symlink escapes workspace (${r.target})`);
    } else if (r.status === "irregular") {
      const rel = `agents/${agentName}/workspace/${relative(liveWorkspace, src)}`;
      skipped.push({ file: rel, reason: `not a regular file (${r.target})` });
    }
  };

  for (const f of OWNED_WORKSPACE_FILES) {
    guard(join(liveWorkspace, f), join(repoWorkspace, f));
  }

  const memDir = join(liveWorkspace, "memory");
  if (dirExists(memDir)) {
    for (const ent of safeReaddir(memDir)) {
      if (ent.endsWith(".md")) guard(join(memDir, ent), join(repoWorkspace, "memory", ent));
    }
  }

  const mcpDir = join(liveWorkspace, "mcp");
  if (dirExists(mcpDir)) {
    for (const ent of safeReaddir(mcpDir)) {
      if (ent.endsWith(".mjs") || ent === "package.json" || ent === ".gitignore") {
        guard(join(mcpDir, ent), join(repoWorkspace, "mcp", ent));
      }
    }
  }
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Force-add the OWNED workspace allowlist for one repo agent dir, past the
 * blanket `agents/` gitignore. `git add -f` is a no-op for a path that does
 * not exist, so unconditional adds are safe.
 */
function forceAddWorkspace(git: CmdRunner, repoAgentWorkspace: string): void {
  for (const f of OWNED_WORKSPACE_FILES) {
    const p = join(repoAgentWorkspace, f);
    if (existsSync(p)) git(["add", "-f", "--", p]);
  }
  const memDir = join(repoAgentWorkspace, "memory");
  for (const ent of safeReaddir(memDir)) {
    if (ent.endsWith(".md")) git(["add", "-f", "--", join(memDir, ent)]);
  }
  const mcpDir = join(repoAgentWorkspace, "mcp");
  for (const ent of safeReaddir(mcpDir)) {
    if (ent.endsWith(".mjs") || ent === "package.json" || ent === ".gitignore") {
      git(["add", "-f", "--", join(mcpDir, ent)]);
    }
  }
}

/**
 * Force-add every non-dot entry under `agents/<name>/personal-skills/` — the
 * GAP A fix. Dot-prefixed siblings (`.<slug>-staging-*`, `.<slug>-prior-*`,
 * `.<slug>-trash-*`, `.journal.jsonl`) are staging/audit artifacts bounded by
 * the mirror's own 24h sweep and are deliberately excluded.
 */
export function forceAddPersonalSkills(git: CmdRunner, repoPersonalSkillsDir: string): void {
  for (const ent of safeReaddir(repoPersonalSkillsDir)) {
    if (ent.startsWith(".")) continue;
    git(["add", "-f", "--", join(repoPersonalSkillsDir, ent)]);
  }
}

/**
 * Parse `owner/repo` out of a GitHub remote URL (https or ssh form).
 * Returns null for a non-GitHub or unparseable remote.
 */
export function parseGitHubSlug(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/**
 * Scan every currently-staged file for embedded secrets and unstage any file
 * that matches. Reuses `scanBundleForSecrets` — the same engine that gates the
 * personal-skill write path — so the host-side commit path enforces the same
 * fail-closed contract for files that bypassed the in-container CLI. Returns
 * the findings (value bytes are never surfaced).
 */
export function scanStagedForSecrets(
  repoPath: string,
  git: CmdRunner,
  log: (m: string) => void,
): SecretFinding[] {
  const listed = git(["diff", "--cached", "--name-only"]);
  const findings: SecretFinding[] = [];
  if (!listed.ok || listed.stdout.length === 0) return findings;

  const seen = new Set<string>();
  for (const relPath of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const abs = join(repoPath, relPath);
    let content: string;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > SCAN_MAX_FILE_BYTES) continue;
      const buf = readFileSync(abs);
      // Skip binary — a NUL byte in the first 8KB is the usual heuristic.
      if (buf.subarray(0, 8192).includes(0)) continue;
      content = buf.toString("utf-8");
    } catch {
      // Deletion or unreadable — nothing to scan.
      continue;
    }
    const bundle: SkillFileMap = { [relPath]: content };
    for (const f of scanBundleForSecrets(bundle)) {
      findings.push({ file: relPath, pattern: f.pattern, rule_id: f.rule_id });
      if (!seen.has(relPath)) {
        seen.add(relPath);
        // Unstage the offending file so it never enters the commit. The file
        // stays on disk (the operator investigates); it is simply not tracked.
        git(["reset", "-q", "HEAD", "--", relPath]);
        log(
          `config-repo: SECRET WITHHELD — unstaged ${relPath} ` +
            `(${f.pattern}); the private repo push gate is the second wall`,
        );
      }
    }
  }
  return findings;
}

/**
 * Query the GitHub API for the remote's visibility. Returns:
 *   - true/false when the API answered
 *   - null when gh is unavailable / unauthenticated / the API was unreachable
 *     (treated by the caller as "unknown → do not push", fail-safe).
 */
export function probeRemoteIsPrivate(
  gh: CmdRunner,
  slug: { owner: string; repo: string },
): boolean | null {
  const r = gh(["api", `repos/${slug.owner}/${slug.repo}`, "--jq", ".private"]);
  if (!r.ok) return null;
  const v = r.stdout.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/**
 * The whole sync: copy → stage → secret-scan → commit → (gated) push.
 * Pure of process concerns (no flock, no exit) — the CLI layer wraps this in
 * the lock and maps {@link ConfigRepoSyncResult.exitCode}.
 */
export function runConfigRepoSync(
  opts: ConfigRepoSyncOptions,
  deps: ConfigRepoSyncDeps,
): ConfigRepoSyncResult {
  const { git, gh, log } = deps;
  const warnings: string[] = [];
  const skippedSymlinks: SkippedSymlink[] = [];

  if (!existsSync(join(opts.repoPath, ".git"))) {
    throw new Error(`config-repo: ${opts.repoPath} is not a git repo (no .git)`);
  }
  if (!existsSync(opts.livePath)) {
    throw new Error(`config-repo: live config not found at ${opts.livePath}`);
  }

  // 1. yaml as a COPY (never a symlink).
  copyYamlAsRegularFile(opts.livePath, join(opts.repoPath, "switchroom.yaml"));

  // 2. Copy each agent's OWNED workspace state, guarded against symlink escape.
  if (dirExists(opts.agentsDir)) {
    for (const name of safeReaddir(opts.agentsDir)) {
      const liveWs = join(opts.agentsDir, name, "workspace");
      if (!dirExists(liveWs)) continue;
      copyAgentWorkspace(
        name,
        liveWs,
        join(opts.repoPath, "agents", name, "workspace"),
        skippedSymlinks,
        log,
      );
    }
  }

  // 3. Stage. `add -A` stages the yaml + any non-ignored change/deletion; the
  // force-add loop pulls in the OWNED workspace allowlist and the mirrored
  // personal skills that the blanket `agents/` ignore would otherwise drop.
  git(["add", "-A"]);
  // The flock file (`<repo>/.sync.lock`, held for the duration of this run)
  // lives at the repo root and is NOT in the operator's `.gitignore`, so
  // `add -A` would otherwise sweep this transient into the commit. Unstage it
  // unconditionally; it is removed on lock release regardless.
  git(["reset", "-q", "HEAD", "--", ".sync.lock"]);
  const repoAgentsDir = join(opts.repoPath, "agents");
  for (const name of safeReaddir(repoAgentsDir)) {
    forceAddWorkspace(git, join(repoAgentsDir, name, "workspace"));
    forceAddPersonalSkills(git, join(repoAgentsDir, name, PERSONAL_SKILLS_SUBPATH));
  }

  // 4. Secret scan every staged file; unstage any hit.
  const secretFindings = scanStagedForSecrets(opts.repoPath, git, log);

  // 5. Commit iff something remains staged.
  const staged = git(["diff", "--cached", "--quiet"]);
  const hasStaged = !staged.ok; // `--quiet` exits 1 when there ARE staged changes
  let committed = false;
  let commitSha: string | undefined;
  if (hasStaged) {
    const msg =
      opts.message ??
      "chore(config-repo): sync switchroom.yaml + workspace state + personal skills from live host";
    const c = git(["commit", "-m", msg]);
    if (!c.ok) {
      throw new Error(`config-repo: git commit failed: ${c.stderr || c.stdout}`);
    }
    committed = true;
    const rev = git(["rev-parse", "HEAD"]);
    if (rev.ok) commitSha = rev.stdout.trim();
    log(`config-repo: committed ${commitSha ?? "(sha unknown)"}`);
  } else {
    log("config-repo: nothing to commit (repo already matches live)");
  }

  // 6. Push, gated by require_private.
  let pushed = false;
  let pushSkippedReason: string | undefined;
  if (opts.push) {
    const remoteUrl = git(["remote", "get-url", opts.remote]);
    if (!remoteUrl.ok) {
      pushSkippedReason = `remote '${opts.remote}' not configured`;
    } else if (opts.requirePrivate) {
      const slug = parseGitHubSlug(remoteUrl.stdout);
      if (!slug) {
        pushSkippedReason = `require_private: cannot parse a GitHub owner/repo from '${remoteUrl.stdout}'`;
      } else {
        const priv = probeRemoteIsPrivate(gh, slug);
        if (priv === null) {
          pushSkippedReason =
            `require_private: could not confirm ${slug.owner}/${slug.repo} is private ` +
            `(gh unavailable / API unreachable) — refusing to push`;
        } else if (priv === false) {
          pushSkippedReason =
            `require_private: remote ${slug.owner}/${slug.repo} is PUBLIC — refusing to push`;
        }
      }
    }

    if (!pushSkippedReason) {
      const p = git(["push", opts.remote, "HEAD"]);
      if (p.ok) {
        pushed = true;
        log(`config-repo: pushed to ${opts.remote}`);
      } else {
        pushSkippedReason = `push failed (offline/auth?) — commits are local, next run retries: ${p.stderr || p.stdout}`;
      }
    }

    if (pushSkippedReason) {
      warnings.push(pushSkippedReason);
      log(`config-repo: WARN — ${pushSkippedReason}`);
    }
  }

  const warned =
    secretFindings.length > 0 || skippedSymlinks.length > 0 || warnings.length > 0;

  return {
    committed,
    commitSha,
    pushed,
    pushSkippedReason,
    secretFindings,
    skippedSymlinks,
    warnings,
    exitCode: warned ? 10 : 0,
  };
}

/**
 * flock-guarded wrapper: acquire `<repo>/.sync.lock` (via the vault PID-file
 * lock) so a manual run and a scheduled tick can never interleave, run the
 * sync, and always release. `budgetMs` bounds how long to wait for a
 * concurrent holder before giving up.
 */
export function runConfigRepoSyncLocked(
  opts: ConfigRepoSyncOptions,
  deps: ConfigRepoSyncDeps,
  budgetMs = 30_000,
): ConfigRepoSyncResult {
  // acquireLock appends `.lock`, so `<repo>/.sync` → `<repo>/.sync.lock`.
  const { release } = acquireLock(join(opts.repoPath, ".sync"), { budgetMs });
  try {
    return runConfigRepoSync(opts, deps);
  } finally {
    release();
  }
}
