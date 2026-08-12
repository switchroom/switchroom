/**
 * worktree gc — reclaim dev worktrees that outlived their pull request.
 *
 * The problem this solves (2026-06-23 sprawl): coding agents create dev
 * worktrees via raw `git worktree add ~/code/<repo>-<slug>` (the standard dev
 * process) and rarely remove them once the PR squash-merges. Over months this
 * accreted ~300 directories / 20GB on the dev host. The existing reaper
 * (`src/worktree/reaper.ts`) only governs registry-CLAIMED worktrees (the
 * in-container agent pool) — it never touches these unclaimed dev worktrees.
 *
 * Two failure classes:
 *   1. REGISTERED-but-unremoved — still in `git worktree list`, PR merged.
 *   2. ORPHANED dirs — the dir's `.git` FILE points at a
 *      `<repo>/.git/worktrees/<name>` admin dir that was already pruned, so
 *      `git -C <dir> ...` fatals. The directory lingers.
 *
 * gc handles both, SAFELY (adversarial-review hardened):
 *   - Orphans are attributed by their OWN gitdir pointer (works across
 *     multiple checkouts of the same repo) and only swept when the pointer
 *     targets a *validated* switchroom repo. They are QUARANTINED (moved to a
 *     trash dir), never `rm`'d outright — uncommitted work in an orphan can't
 *     be verified via git, so we keep it recoverable (global "trash over rm").
 *   - Registered worktrees are removed ONLY on a positive `MERGED` signal from
 *     `gh` AND an effectively-clean tree. CLOSED (abandoned) is NOT eligible.
 *     A squash-merged branch is never an ancestor of origin/main, so there is
 *     deliberately no ancestry-based fallback: no `gh` ⇒ no removal.
 *   - Registry-claimed and per-agent worktrees are excluded (the reaper owns
 *     those; GC'ing them races a live agent).
 *
 * Pure decision functions are exported and unit-tested; the orchestrator takes
 * injectable deps so it can be driven from tests without touching disk/git.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { listRecords } from "./registry.js";
import { probePathInUse, type PathUseState } from "./reaper.js";
import { detectCheckoutKind } from "./remove-checkout.js";

// ── pure helpers ────────────────────────────────────────────────────────────

/** PR state signal for a branch. `error` = couldn't determine (treat as keep). */
export type PrSignal = "merged" | "open" | "closed" | "none" | "error";

/** Parse the `gitdir: <path>` line from a worktree's `.git` FILE. */
export function parseGitdirPointer(dotGitFileContents: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(dotGitFileContents);
  return m ? m[1] : null;
}

/**
 * Given a worktree gitdir (`<repo>/.git/worktrees/<name>`), return `<repo>`.
 * Returns null if the path isn't shaped like a worktree admin dir.
 */
export function repoRootFromWorktreeGitdir(gitdir: string): string | null {
  const idx = gitdir.indexOf("/.git/worktrees/");
  if (idx <= 0) return null;
  return gitdir.slice(0, idx);
}

/**
 * True if an `origin` URL points at a switchroom checkout GC should own.
 *
 * That is the canonical `switchroom/switchroom` repo AND the dead
 * `mekenthompson/switchroom` fork (archived, read-only, hundreds of commits
 * behind — see the `.rev-pr4` incident where a fork-origin clone survived 8
 * days uncollected). A fork-origin clone must be GC-ELIGIBLE just like a
 * canonical-origin one, so both owners count as "ours". The match is anchored
 * to the exact repo name, so `mekenthompson/switchroom-web` and other repos
 * are NOT over-matched. Handles https/ssh, optional `.git`, and a trailing
 * slash. Note: this only decides whether a checkout ALREADY under an
 * agent-managed scan root (Phase A ~/code orphans, Phase C home/work task
 * trees) is switchroom-owned — it never widens WHERE the GC looks, and every
 * downstream safety guard (merged PR, clean, pushed, idle, not-in-use) still
 * applies before anything is reclaimed.
 */
export function isSwitchroomRemote(originUrl: string): boolean {
  return /[:/](?:switchroom|mekenthompson)\/switchroom(\.git)?\/?$/.test(originUrl.trim());
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/** Parse `git worktree list --porcelain` output into entries. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, bare: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line.startsWith("branch ")) {
      // e.g. "branch refs/heads/feat/foo"
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * True if a worktree's `git status --porcelain` lines represent no genuine
 * uncommitted work. Build noise is tolerated: a modified `src/build-info.ts`
 * (regenerated on every build) and untracked `*.tgz` pack artifacts. ANYTHING
 * else — including a staged-but-uncommitted new file (`A  docs/x.md`) — counts
 * as dirty, so the worktree is protected from removal.
 */
export function isEffectivelyClean(porcelainLines: string[]): boolean {
  for (const raw of porcelainLines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    // modified build-info.ts (any non-?? status)
    if (path === "src/build-info.ts" && status !== "??") continue;
    // untracked pack tarballs
    if (status === "??" && /\.tgz$/.test(path)) continue;
    return false;
  }
  return true;
}

export type RegisteredVerdict =
  | "remove"
  | "skip-protected"
  | "skip-unmerged"
  | "skip-unknown"
  | "skip-dirty";

export interface ClassifyInput {
  isMain: boolean;
  isBare: boolean;
  isRegistryClaimed: boolean;
  isAgentWorktree: boolean;
  isEphemeralPath: boolean;
  prSignal: PrSignal;
  clean: boolean;
}

/** Decide the fate of one REGISTERED worktree. Order is safety-first. */
export function classifyRegistered(i: ClassifyInput): RegisteredVerdict {
  if (i.isMain || i.isBare || i.isRegistryClaimed || i.isAgentWorktree || i.isEphemeralPath) {
    return "skip-protected";
  }
  if (i.prSignal === "error") return "skip-unknown";
  if (i.prSignal !== "merged") return "skip-unmerged"; // open / closed / none
  if (!i.clean) return "skip-dirty";
  return "remove";
}

/**
 * Branch/path conventions used by the claim pool, per-agent worktrees, and
 * Claude Code's own `isolation: worktree` checkouts. GC must never touch these
 * — they are managed by the reaper or the harness and may be live.
 */
export function looksLikeAgentWorktree(path: string, branch: string | null): boolean {
  if (/(^|\/)work\//.test(path)) return true;
  if (/\/\.claude\/worktrees\//.test(path)) return true; // Claude Code isolation worktrees
  if (branch && /^(agent|task)\//.test(branch)) return true;
  return false;
}

/**
 * A path we must never touch — ephemeral or container-internal mounts. `/state`
 * is the in-container agent home; such worktree paths can leak into a repo's
 * `git worktree list` and must be ignored on the host.
 */
export function isEphemeralPath(path: string): boolean {
  const p = resolve(path);
  for (const root of ["/tmp", "/host", "/state"]) {
    if (p === root || p.startsWith(root + "/")) return true;
  }
  return false;
}

// ── task-tree (home/work) coverage — RFC §4 ─────────────────────────────────
//
// The dev-worktree sweep above (Phase A/B) roots at ~/code and, via
// `looksLikeAgentWorktree`, deliberately SKIP-protects anything under a
// `work/` path — so per-task trees an agent/harness drops at
// `~/.switchroom/agents/<name>/home/work/<slug>` are never touched, and grow
// without bound (the ~25G+ overhang). RFC §4 closes that gap with a dedicated,
// guard-gated sweep of the task-tree roots.
//
// Task trees are NOT uniformly git worktrees. A live census found three shapes:
//   - "worktree" — `.git` is a FILE pointing at an owner repo's admin dir.
//   - "clone"    — `.git` is a DIRECTORY (a full standalone clone, or a repo
//                  nested inside another checkout). Same handling: it responds
//                  to `git -C <dir> …` identically, and is quarantined as a
//                  self-contained directory.
// A naive coverage that keyed off worktree detection (as the old `work/` skip
// does) would miss the majority of the overhang (the clones + nested repos).
// Both shapes go through the SAME guard gauntlet below; only the post-reclaim
// bookkeeping differs (a reaped worktree also prunes its owner repo's admin
// metadata).

/** Physical shape of a task-tree candidate directory. */
export type TaskTreeShape = "worktree" | "clone";

/**
 * Push state of a task tree's branch. Everything other than `pushed` fails
 * toward preservation (the tree is kept, or only the operator escape hatch
 * may quarantine it).
 */
export type PushState = "pushed" | "unpushed" | "no-upstream" | "detached" | "error";

/** Derive the push state from raw git facts. Pure, for unit testing. */
export function pushStateFrom(opts: {
  detached: boolean;
  upstream: string | null;
  /** commit count of `@{upstream}..HEAD`; negative ⇒ the count command failed. */
  aheadCount: number;
}): PushState {
  if (opts.detached) return "detached";
  if (!opts.upstream) return "no-upstream";
  if (opts.aheadCount < 0) return "error";
  if (opts.aheadCount > 0) return "unpushed";
  return "pushed";
}

/**
 * True for the agent's STABLE per-repo tree branch (`agent/<name>/main`,
 * `agent-worktree.ts`). That tree is durable identity, not a disposable task
 * tree, and must never be reaped even if it somehow lands under a task root.
 */
export function isStablePerRepoBranch(branch: string | null): boolean {
  return !!branch && /^agent\/[^/]+\/main$/.test(branch);
}

export type TaskTreeVerdict =
  /** clean + pushed + idle + (merged|closed) PR + provably free → reclaim. */
  | "reap"
  /** registry-claimed / stable per-repo tree / ephemeral mount → never touch. */
  | "skip-protected"
  /** no fuser/lsof to prove it idle → treat as live, keep (fail-safe). */
  | "skip-probe-unavailable"
  /** a live process holds the path open → keep. */
  | "skip-in-use"
  /** uncommitted effective changes → keep (escape-hatch eligible). */
  | "skip-dirty"
  /** detached / no upstream / commits ahead of upstream → keep (escape-hatch eligible). */
  | "skip-unpushed"
  /** newest tracked mtime within the idle window → keep. */
  | "skip-active"
  /** couldn't determine the PR state → keep. */
  | "skip-unknown"
  /** PR still open / no PR → keep. */
  | "skip-unmerged";

export interface TaskTreeClassifyInput {
  isRegistryClaimed: boolean;
  isStablePerRepoTree: boolean;
  isEphemeralPath: boolean;
  clean: boolean;
  pushed: PushState;
  prSignal: PrSignal;
  idle: boolean;
  inUse: PathUseState;
}

/**
 * Decide the fate of ONE task tree. Order is safety-first — every guard that
 * can preserve fires before the single `reap` outcome, and the two data-loss
 * guards (in-use, dirty) come before anything the escape hatch can act on, so a
 * live or dirty-and-in-use tree can never be quarantined.
 */
export function classifyTaskTree(i: TaskTreeClassifyInput): TaskTreeVerdict {
  if (i.isRegistryClaimed || i.isStablePerRepoTree || i.isEphemeralPath) {
    return "skip-protected";
  }
  // In-use guards come first: a tree a live process holds is never eligible for
  // reap OR for the escape hatch, even if it is also dirty.
  if (i.inUse === "unavailable") return "skip-probe-unavailable";
  if (i.inUse === "in-use") return "skip-in-use";
  // Data-loss guards. Both are escape-hatch eligible (operator quarantines,
  // reversibly) but never auto-reaped.
  if (!i.clean) return "skip-dirty";
  if (i.pushed !== "pushed") return "skip-unpushed";
  // Freshness before the PR signal so an active tree never spends a `gh` call.
  if (!i.idle) return "skip-active";
  if (i.prSignal === "error") return "skip-unknown";
  if (i.prSignal !== "merged" && i.prSignal !== "closed") return "skip-unmerged";
  return "reap";
}

// ── plan types ──────────────────────────────────────────────────────────────

export interface OrphanAction {
  dir: string;
  owner: string; // validated switchroom repo root the orphan belonged to
  dest: string; // quarantine destination
}

export interface RegisteredAction {
  path: string;
  branch: string | null;
  verdict: RegisteredVerdict;
  prSignal: PrSignal;
  repo: string;
}

export interface TaskTreeAction {
  dir: string;
  shape: TaskTreeShape;
  /** owner repo (worktree shape only) — pruned after reclaim; null for a clone. */
  ownerRepo: string | null;
  branch: string | null;
  verdict: TaskTreeVerdict;
  prSignal: PrSignal;
  idle: boolean;
  /** quarantine destination when this tree is actioned. */
  dest: string;
  /**
   * True iff this run will move the tree to trash: an automatic `reap`, or —
   * when the operator escape hatch (`escapeHatch`) is on — an IDLE
   * dirty/unpushed tree. Everything else is surfaced but untouched.
   */
  willAct: boolean;
}

export interface GcPlan {
  roots: string[];
  taskTreeRoots: string[];
  trashDir: string;
  orphans: OrphanAction[];
  registered: RegisteredAction[];
  taskTrees: TaskTreeAction[];
  reposToPrune: string[];
  skipped: { dir: string; reason: string }[];
}

export interface GcDeps {
  existsSync?: (p: string) => boolean;
  readDir?: (p: string) => string[];
  readFile?: (p: string) => string;
  /** stat for the `.git`-is-a-directory check; default uses statSync. */
  stat?: (p: string) => { isDirectory: () => boolean };
  /** run a command, return stdout; throw on non-zero exit. */
  exec?: (file: string, args: string[], cwd?: string) => string;
  /** PR signal for a branch; default shells `gh`. */
  prSignal?: (repo: string, branch: string) => PrSignal;
  /** ISO-ish date stamp for the quarantine subdir (no Date.now in tests). */
  dateStamp?: string;

  // ── task-tree (home/work) sweep seams (RFC §4) ──
  /** Probe whether a path is held open by a live process. Default: reaper's. */
  probeInUse?: (path: string) => PathUseState;
  /** Newest tracked-file mtime (ms) under a task tree. Default: `git ls-files`. */
  newestTrackedMtimeMs?: (dir: string) => number;
  /** Idle threshold in days for a task tree (default 14). */
  idleDays?: number;
  /** "now" in ms for the idle comparison (default Date.now). */
  nowMs?: number;
  /**
   * Operator escape hatch: when true, IDLE dirty/unpushed task trees are
   * quarantined (reversibly) rather than merely surfaced. Default false.
   */
  escapeHatch?: boolean;
}

const defaultExec = (file: string, args: string[], cwd?: string): string =>
  execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString();

function defaultPrSignal(repo: string, branch: string, exec: GcDeps["exec"]): PrSignal {
  try {
    const out = exec!(
      "gh",
      [
        "pr", "list",
        "--repo", "switchroom/switchroom",
        "--head", branch,
        "--state", "all",
        "--json", "state",
        "--limit", "1",
      ],
      repo,
    );
    const arr = JSON.parse(out || "[]") as { state?: string }[];
    if (!arr.length) return "none";
    const st = String(arr[0].state ?? "").toLowerCase();
    if (st === "merged") return "merged";
    if (st === "open") return "open";
    if (st === "closed") return "closed";
    return "none";
  } catch {
    return "error";
  }
}

/**
 * Newest mtime (ms) across a task tree's git-TRACKED files — the RFC §2 idle
 * signal. `git ls-files` excludes `node_modules` and other untracked/ignored
 * churn, so a `bun install` does not reset the clock. On ANY error we return
 * `Date.now()` (age 0 ⇒ not idle ⇒ keep) — fail toward preservation.
 */
function defaultNewestTrackedMtimeMs(
  dir: string,
  exec: NonNullable<GcDeps["exec"]>,
): number {
  let out: string;
  try {
    out = exec("git", ["-C", dir, "ls-files", "-z"]);
  } catch {
    return Date.now();
  }
  const files = out.split("\0").filter(Boolean);
  let newest = 0;
  for (const f of files) {
    try {
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* file vanished mid-scan — ignore */
    }
  }
  // Empty/unreadable tree → treat as active (keep), never as ancient.
  return newest || Date.now();
}

/** Default trash root. Override via SWITCHROOM_WORKTREE_TRASH for tests. */
export function trashRoot(): string {
  return resolve(
    process.env.SWITCHROOM_WORKTREE_TRASH ??
      join(homedir(), ".switchroom", "worktree-gc-trash"),
  );
}

// ── planner ─────────────────────────────────────────────────────────────────

/**
 * Build a GC plan for the given roots without mutating anything.
 *
 * @param roots          directories whose IMMEDIATE subdirs are candidate dev
 *                       worktrees (Phase A/B — the ~/code sweep).
 * @param taskTreeRoots  per-agent `home/work` roots whose IMMEDIATE subdirs are
 *                       candidate task trees (Phase C — RFC §4). These are a
 *                       SEPARATE input, not folded into `roots`, because they
 *                       carry different semantics (all tree shapes, the
 *                       `work/` carve-out, the pushed + idle guards, and
 *                       merged-OR-closed eligibility).
 */
export function planGc(
  roots: string[],
  deps: GcDeps = {},
  taskTreeRoots: string[] = [],
): GcPlan {
  const exists = deps.existsSync ?? existsSync;
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const exec = deps.exec ?? defaultExec;
  const prSignal = deps.prSignal ?? ((repo: string, branch: string) => defaultPrSignal(repo, branch, exec));
  const stamp = deps.dateStamp ?? "undated";
  const trash = join(trashRoot(), stamp);
  const probeInUse = deps.probeInUse ?? probePathInUse;
  const newestMtime = deps.newestTrackedMtimeMs ?? ((dir: string) => defaultNewestTrackedMtimeMs(dir, exec));
  const idleDays = deps.idleDays ?? 14;
  const nowMs = deps.nowMs ?? Date.now();
  const escapeHatch = deps.escapeHatch ?? false;

  // registry-claimed worktree paths (excluded from the registered sweep).
  let claimed: Set<string>;
  try {
    claimed = new Set(listRecords().map((r) => resolve(r.path)));
  } catch {
    claimed = new Set();
  }

  // Cache: repoRoot → is a validated switchroom repo?
  const validatedRepo = new Map<string, boolean>();
  const isSwitchroomRepo = (repoRoot: string): boolean => {
    if (validatedRepo.has(repoRoot)) return validatedRepo.get(repoRoot)!;
    let ok = false;
    try {
      if (exists(repoRoot)) {
        const url = exec("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
        ok = isSwitchroomRemote(url);
      }
    } catch {
      ok = false;
    }
    validatedRepo.set(repoRoot, ok);
    return ok;
  };

  const orphans: OrphanAction[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  const ownerRepos = new Set<string>(); // validated repos discovered via orphans

  // ── Phase A: orphan attribution + quarantine plan ──
  for (const root of roots) {
    if (!exists(root)) continue;
    let entries: string[];
    try {
      entries = readDir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      if (isEphemeralPath(dir)) continue;
      const dotGit = join(dir, ".git");
      // A real clone has a `.git` DIRECTORY; a worktree has a `.git` FILE.
      if (!exists(dotGit)) continue;
      let st;
      try {
        st = stat(dotGit);
      } catch {
        continue;
      }
      if (st.isDirectory()) continue; // real repo — never touch
      let ptr: string | null = null;
      try {
        ptr = parseGitdirPointer(readFile(dotGit));
      } catch {
        continue;
      }
      if (!ptr) continue;
      const repoRoot = repoRootFromWorktreeGitdir(ptr);
      if (!repoRoot) continue;
      if (!isSwitchroomRepo(repoRoot)) {
        skipped.push({ dir, reason: `gitdir points outside a switchroom repo (${repoRoot})` });
        continue;
      }
      ownerRepos.add(repoRoot);
      // Orphan ⇔ the admin dir the pointer references is gone. If it still
      // exists the worktree is live/registered → handled by Phase B.
      if (exists(ptr)) continue;
      orphans.push({ dir, owner: repoRoot, dest: join(trash, name) });
    }
  }

  // ── Phase B: registered, merged-and-clean sweep ──
  const registered: RegisteredAction[] = [];
  const reposToPrune = new Set<string>(ownerRepos);
  for (const repo of ownerRepos) {
    let porcelain = "";
    try {
      porcelain = exec("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }
    for (const wt of parseWorktreeList(porcelain)) {
      const wtPath = resolve(wt.path);
      const isMain = wtPath === resolve(repo);
      const claimedWt = claimed.has(wtPath);
      const agentWt = looksLikeAgentWorktree(wt.path, wt.branch);
      const ephemeral = isEphemeralPath(wt.path);
      let sig: PrSignal = "error";
      let clean = false;
      // Only spend a gh call / status check on plausible candidates.
      if (!isMain && !wt.bare && !claimedWt && !agentWt && !ephemeral && wt.branch) {
        sig = prSignal(repo, wt.branch);
        if (sig === "merged") {
          try {
            const status = exec("git", ["-C", wt.path, "status", "--porcelain"]);
            clean = isEffectivelyClean(status.split("\n"));
          } catch {
            clean = false;
          }
        }
      }
      const verdict = classifyRegistered({
        isMain,
        isBare: wt.bare,
        isRegistryClaimed: claimedWt,
        isAgentWorktree: agentWt,
        isEphemeralPath: ephemeral,
        prSignal: sig,
        clean,
      });
      registered.push({ path: wt.path, branch: wt.branch, verdict, prSignal: sig, repo });
    }
  }

  // ── Phase C: per-agent task-tree sweep (home/work — RFC §4) ──
  // A dedicated path, NOT routed through classifyRegistered, so the `work/`
  // carve-out is achieved structurally (these roots never reach the blanket
  // `looksLikeAgentWorktree` skip) and all three tree shapes are covered.
  const taskTrees: TaskTreeAction[] = [];
  for (const root of taskTreeRoots) {
    if (!exists(root)) continue;
    let entries: string[];
    try {
      entries = readDir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      if (isEphemeralPath(dir)) continue;
      const dotGit = join(dir, ".git");
      if (!exists(dotGit)) continue; // not a git tree — leave it
      let shape: TaskTreeShape;
      try {
        shape = stat(dotGit).isDirectory() ? "clone" : "worktree";
      } catch {
        continue;
      }

      // Safety gate: only ever touch a checkout of the canonical switchroom
      // repo. `git -C <dir> remote get-url origin` works for worktree AND clone.
      let remoteOk = false;
      try {
        remoteOk = isSwitchroomRemote(exec("git", ["-C", dir, "remote", "get-url", "origin"]));
      } catch {
        remoteOk = false;
      }
      if (!remoteOk) {
        skipped.push({ dir, reason: "not a switchroom task tree" });
        continue;
      }

      // Owner repo (for post-reclaim `worktree prune`) — worktree shape only.
      let ownerRepo: string | null = null;
      if (shape === "worktree") {
        try {
          const ptr = parseGitdirPointer(readFile(dotGit));
          if (ptr) ownerRepo = repoRootFromWorktreeGitdir(ptr);
        } catch {
          ownerRepo = null;
        }
      }

      // Branch / detached HEAD.
      let branch: string | null = null;
      let detached = false;
      try {
        const b = exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
        if (b === "HEAD") detached = true;
        else branch = b;
      } catch {
        detached = true; // can't read HEAD ⇒ treat as detached ⇒ unpushed ⇒ keep
      }

      const claimedWt = claimed.has(resolve(dir));
      const stableTree = isStablePerRepoBranch(branch);
      const ephemeral = isEphemeralPath(dir);
      const protectedTree = claimedWt || stableTree || ephemeral;

      // Effective cleanliness (build noise tolerated; anything else ⇒ dirty).
      let clean = false;
      try {
        clean = isEffectivelyClean(exec("git", ["-C", dir, "status", "--porcelain"]).split("\n"));
      } catch {
        clean = false; // can't inspect ⇒ assume dirty ⇒ keep
      }

      // Push state: uncommitted-clean does NOT imply pushed.
      let upstream: string | null = null;
      let aheadCount = 0;
      if (!detached) {
        try {
          upstream =
            exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim() ||
            null;
        } catch {
          upstream = null;
        }
        if (upstream) {
          try {
            aheadCount = parseInt(exec("git", ["-C", dir, "rev-list", "--count", "@{upstream}..HEAD"]).trim(), 10);
            if (!Number.isFinite(aheadCount)) aheadCount = -1;
          } catch {
            aheadCount = -1; // count failed ⇒ error ⇒ keep
          }
        }
      }
      const pushed = pushStateFrom({ detached, upstream, aheadCount });

      // Idle: newest tracked mtime older than the idle window.
      let idle = false;
      try {
        idle = (nowMs - newestMtime(dir)) / 86_400_000 >= idleDays;
      } catch {
        idle = false; // can't tell ⇒ treat as active ⇒ keep
      }

      // Spend the probe + `gh` call only when every cheaper guard has passed
      // (mirrors Phase B). classifyTaskTree checks in-use/clean/pushed/idle
      // before the PR signal, so an uncalled `error`/`unavailable` is only ever
      // consulted when an earlier guard has already decided the verdict.
      let inUse: PathUseState = "unavailable";
      let sig: PrSignal = "error";
      if (!protectedTree) {
        inUse = probeInUse(dir);
        if (inUse === "free" && clean && pushed === "pushed" && idle && branch) {
          sig = prSignal(dir, branch);
        }
      }

      const verdict = classifyTaskTree({
        isRegistryClaimed: claimedWt,
        isStablePerRepoTree: stableTree,
        isEphemeralPath: ephemeral,
        clean,
        pushed,
        prSignal: sig,
        idle,
        inUse,
      });

      // Automatic reap, OR — under the operator escape hatch — an IDLE
      // dirty/unpushed tree (reversible quarantine; never a live/in-use one,
      // since those resolve to skip-in-use before skip-dirty/skip-unpushed).
      const willAct =
        verdict === "reap" ||
        (escapeHatch && idle && (verdict === "skip-dirty" || verdict === "skip-unpushed"));

      if (willAct && ownerRepo) reposToPrune.add(ownerRepo);

      taskTrees.push({
        dir,
        shape,
        ownerRepo,
        branch,
        verdict,
        prSignal: sig,
        idle,
        dest: join(trash, name),
        willAct,
      });
    }
  }

  return {
    roots,
    taskTreeRoots,
    trashDir: trash,
    orphans,
    registered,
    taskTrees,
    reposToPrune: [...reposToPrune],
    skipped,
  };
}

// ── executor ────────────────────────────────────────────────────────────────

export interface GcApplyResult {
  quarantined: string[];
  removed: string[];
  branchesDeleted: string[];
  pruned: string[];
  errors: string[];
}

export interface ApplyDeps {
  mkdirp?: (p: string) => void;
  move?: (src: string, dest: string) => void;
  exec?: (file: string, args: string[], cwd?: string) => string;
}

/** Execute a plan. Mutates disk/git. Caller gates this behind --yes. */
export function applyGc(plan: GcPlan, deps: ApplyDeps = {}): GcApplyResult {
  const exec = deps.exec ?? defaultExec;
  const mkdirp = deps.mkdirp ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  // Default move: `mv` handles cross-device (rename would EXDEV); fall back to
  // renameSync only if mv is unavailable.
  const move =
    deps.move ??
    ((src: string, dest: string) => {
      try {
        renameSync(src, dest);
      } catch {
        exec("mv", [src, dest]);
      }
    });

  const res: GcApplyResult = { quarantined: [], removed: [], branchesDeleted: [], pruned: [], errors: [] };

  const taskTreeActions = (plan.taskTrees ?? []).filter((t) => t.willAct);
  if (plan.orphans.length || taskTreeActions.length) mkdirp(plan.trashDir);
  for (const o of plan.orphans) {
    try {
      move(o.dir, o.dest);
      res.quarantined.push(o.dir);
    } catch (e) {
      res.errors.push(`quarantine ${o.dir}: ${(e as Error).message}`);
    }
  }

  // Task trees (RFC §4): quarantine to trash (recoverable) for BOTH automatic
  // reaps and operator escape-hatch dirty/unpushed reclaims — "trash over rm".
  // A worktree-shaped tree's owner repo is pruned afterward (it is already in
  // plan.reposToPrune, handled by the prune loop below) to clear the now-dangling
  // admin entry.
  for (const t of taskTreeActions) {
    try {
      move(t.dir, t.dest);
      res.quarantined.push(t.dir);
    } catch (e) {
      res.errors.push(`quarantine ${t.dir}: ${(e as Error).message}`);
    }
  }

  for (const r of plan.registered) {
    if (r.verdict !== "remove") continue;
    try {
      if (detectCheckoutKind(r.path) === "clone") {
        // Independent clone (post worktree-collision fix): the task branch,
        // refs, and metadata all live INSIDE the directory — removing it is
        // the whole cleanup. Nothing to delete or prune in the source repo.
        rmSync(r.path, { recursive: true, force: true });
        res.removed.push(r.path);
        continue;
      }
      exec("git", ["-C", r.repo, "worktree", "remove", "--force", r.path]);
      res.removed.push(r.path);
      if (r.branch) {
        try {
          exec("git", ["-C", r.repo, "branch", "-D", r.branch]);
          res.branchesDeleted.push(r.branch);
        } catch {
          /* branch may already be gone; non-fatal */
        }
      }
    } catch (e) {
      res.errors.push(`remove ${r.path}: ${(e as Error).message}`);
    }
  }

  for (const repo of plan.reposToPrune) {
    try {
      exec("git", ["-C", repo, "worktree", "prune"]);
      res.pruned.push(repo);
    } catch (e) {
      res.errors.push(`prune ${repo}: ${(e as Error).message}`);
    }
  }

  return res;
}

// ── trash purge ─────────────────────────────────────────────────────────────

export interface TrashEntry {
  path: string;
  ageDays: number;
}

/** Select quarantined dirs older than `olderThanDays` for hard deletion. */
export function selectPurgeTargets(
  entries: TrashEntry[],
  olderThanDays: number,
): string[] {
  return entries.filter((e) => e.ageDays >= olderThanDays).map((e) => e.path);
}

/** Enumerate quarantined worktree dirs as `<trashRoot>/<stamp>/<name>`. */
export function listTrashEntries(nowMs: number, deps: GcDeps = {}): TrashEntry[] {
  const exists = deps.existsSync ?? existsSync;
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  const root = trashRoot();
  if (!exists(root)) return [];
  const out: TrashEntry[] = [];
  for (const stamp of readDir(root)) {
    const stampDir = join(root, stamp);
    let names: string[];
    try {
      names = readDir(stampDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(stampDir, name);
      let mtimeMs = nowMs;
      try {
        mtimeMs = statSync(p).mtimeMs;
      } catch {
        /* keep nowMs → ageDays 0 */
      }
      out.push({ path: p, ageDays: (nowMs - mtimeMs) / 86_400_000 });
    }
  }
  return out;
}

/** Hard-delete the given quarantined dirs. */
export function purgeTrash(paths: string[]): { deleted: string[]; errors: string[] } {
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
      deleted.push(p);
    } catch (e) {
      errors.push(`${p}: ${(e as Error).message}`);
    }
  }
  return { deleted, errors };
}

/** Default scan roots: ~/code (where dev worktrees live). */
export function defaultRoots(): string[] {
  return [join(homedir(), "code")];
}

/**
 * Default per-agent task-tree roots for the RFC §4 sweep. `planGc` reads the
 * IMMEDIATE subdirs of each LITERAL root, so the per-agent
 * `agents/<name>/home/{work,workspace}` glob must be expanded to concrete
 * per-agent paths here — a bare glob string
 * would be read as a literal directory name and match nothing. Only existing
 * roots are returned. Container HOME (`/state/agent/home`) maps to
 * `<agentDir>/home` on the host, so per-task trees land under
 * `<agentDir>/home/work/<slug>`; the bounded stable per-repo tree
 * (`<agentDir>/work/<slug>`) is deliberately NOT scanned.
 */
export function defaultTaskTreeRoots(): string[] {
  const agentsDir = join(homedir(), ".switchroom", "agents");
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const name of names.sort()) {
    for (const sub of ["home/work", "home/workspace"]) {
      const r = join(agentsDir, name, sub);
      if (existsSync(r)) roots.push(r);
    }
  }
  return roots;
}
