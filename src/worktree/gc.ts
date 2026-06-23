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

/** True if an `origin` URL points at the canonical switchroom repo. */
export function isSwitchroomRemote(originUrl: string): boolean {
  return /[:/]switchroom\/switchroom(\.git)?\/?$/.test(originUrl.trim());
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

export interface GcPlan {
  roots: string[];
  trashDir: string;
  orphans: OrphanAction[];
  registered: RegisteredAction[];
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
 * @param roots   directories whose IMMEDIATE subdirs are candidate worktrees.
 */
export function planGc(roots: string[], deps: GcDeps = {}): GcPlan {
  const exists = deps.existsSync ?? existsSync;
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const exec = deps.exec ?? defaultExec;
  const prSignal = deps.prSignal ?? ((repo: string, branch: string) => defaultPrSignal(repo, branch, exec));
  const stamp = deps.dateStamp ?? "undated";
  const trash = join(trashRoot(), stamp);

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

  return {
    roots,
    trashDir: trash,
    orphans,
    registered,
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

  if (plan.orphans.length) mkdirp(plan.trashDir);
  for (const o of plan.orphans) {
    try {
      move(o.dir, o.dest);
      res.quarantined.push(o.dir);
    } catch (e) {
      res.errors.push(`quarantine ${o.dir}: ${(e as Error).message}`);
    }
  }

  for (const r of plan.registered) {
    if (r.verdict !== "remove") continue;
    try {
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
