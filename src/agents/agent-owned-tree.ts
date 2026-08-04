/**
 * Agent-tree ownership sweep — the reconcile-path twin of `alignAgentUid`
 * (scaffold.ts). Fixes #3168.
 *
 * ## Why this exists
 *
 * Every agent's `claude` process runs as its own dedicated container UID
 * (10001–10999, `allocateAgentUid`), and its state dir
 * `~/.switchroom/agents/<name>/` is bind-mounted into the container. But
 * the writers of that state dir often run as ROOT:
 *
 *   - hostd spawns `switchroom agent restart <a> --wait --force` for every
 *     agent on every update rollout (src/cli/rollout.ts:681; the spawned
 *     process needs root — rollout.ts:42; hostd itself is `USER 0:0`,
 *     docker/Dockerfile.hostd:124), and `agent restart` reconciles first.
 *   - `sudo switchroom apply` / in-hostd `switchroom apply` scaffold as root.
 *
 * A root writer that creates a NEW inode leaves it root-owned. The apply
 * path has always been protected by the `alignAgentUid` chown sweep
 * (src/cli/apply.ts:1501) — the reconcile path had NO such sweep. The
 * poison case (2026-07-12 incident, v0.18.13 → v0.18.14 roll): reconcile
 * rewrites `.claude/settings.json` via atomicWriteFileSync (tmp + rename;
 * the rename replaces the inode) with mode 0600 → root:root 0600 → the
 * agent UID cannot read its own permission allowlist → Claude Code silently
 * loads NO allowlist → every tool call throws an operator approval card.
 * All 12 fleet agents wedged simultaneously, on every rollout.
 *
 * In-place writeFileSync sites (start.sh, CLAUDE.md) truncate the existing
 * inode and happen to preserve ownership — but any site that creates a new
 * inode (atomic rewrite, first-write of a new file, plugin dir recopy) lands
 * root-owned. Rather than chase call sites forever, reconcile ends with this
 * deterministic sweep: chown the whole agent tree to the agent UID whenever
 * the process runs as root, then ASSERT the files reconcile touched are
 * readable by the agent UID and fail loudly if not.
 *
 * ## Rule for future scaffold/reconcile authors
 *
 * Any file written into an agent's home by a root-running process MUST end
 * up owned by that agent's UID (`allocateAgentUid(name)`) and readable by
 * it. New write sites inside `reconcileAgent` are covered by this sweep as
 * long as they (a) live under the agent dir and (b) run before the sweep at
 * the end of `reconcileAgent`. Writers OUTSIDE reconcile must chown
 * explicitly (see apply.ts's alignAgentUid, broker mint_grant's
 * chown-after-write) and pin it with a regression test.
 *
 * ## Symlink safety
 *
 * The sweep shells `chown -h -R` (`--no-dereference`). `-R` alone is NOT
 * enough: GNU chown's -R defaults to -P (never traverse, lchown each
 * visited symlink), but busybox chown has no -H/-L/-P at all and without
 * `-h` it DEREFERENCES every visited entry — so on a busybox host a
 * planted symlink (e.g. `workspace/x -> /etc/shadow`) would get chowned
 * as root on the next rollout. `-h` is supported by both GNU and busybox
 * and is a behavioral no-op on GNU's -R traversal (symlinks were lchowned
 * anyway; regular files are unaffected). `alignAgentUid` (scaffold.ts),
 * the apply-path sweep this mirrors, passes the same flag.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allocateAgentUid } from "./agent-uid.js";

/**
 * Classify a failed `chown -h -R` (execFileSync throw) as a benign
 * vanished-file race vs a real ownership failure. Returns true ONLY when
 * chown exited non-zero AND every stderr line is a "No such file or
 * directory" (ENOENT) error — i.e. an inode disappeared mid-walk, which is
 * safe to ignore because a gone file has no ownership to restore. Any other
 * error line (Operation not permitted, Permission denied, Read-only file
 * system, …) or empty/uninterpretable stderr → false → caller re-throws.
 * Assumes LC_ALL=C wording (chownTree pins it).
 */
export function isChownVanishedRaceOnly(err: unknown): boolean {
  const e = err as { stderr?: Buffer | string | null } | null | undefined;
  const raw = e?.stderr == null ? "" : e.stderr.toString();
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false; // fail-closed: no evidence it was a race
  return lines.every((l) => /: No such file or directory$/.test(l));
}

/**
 * The agent-dir SUBDIRECTORIES the scoped sweep recurses into (#3333
 * amendment A). Root reconcile writers land inside these state dirs
 * (`.claude/` — settings.json + subagents + backups; `.claude-cron/` —
 * the cron .mcp.json; `telegram/` — the inbox). Everything else at the top
 * level is a single file (start.sh, CLAUDE.md*, cron-session.sh,
 * .mcp.json, .resume-mode-migration-warned, the SOUL.md symlink) captured
 * by the top-level SHALLOW chown; the giant caches that make the full
 * sweep slow (home/ ~96% of inodes, workspace/, tmp/) are deliberately
 * NOT recursed into.
 *
 * This is the single source of truth for scope-of-sweep; the widened
 * post-sweep assert (#3333 stage 3) derives its candidate set from the
 * same constant so scope-of-sweep == scope-of-assert.
 */
export const SCOPED_RECURSIVE_SUBDIRS = [
  ".claude",
  ".claude-cron",
  "telegram",
] as const;

/**
 * Top-level agent-dir files a root reconcile writer can create/rewrite that
 * MUST stay agent-readable (#3333 amendment A + finding 1). These are the
 * critical members of the top-level SHALLOW sweep — the ones whose owner-only
 * (0600) form would silently wedge the agent (#3168). `cron-session.sh` and
 * `.resume-mode-migration-warned` are the leak-list entries the enumeration
 * found outside the original static assert set; `CLAUDE.md` is included
 * because it is root-rewritten in place. Not exhaustive of every top-level
 * file (the sweep re-owns them all) — this is the ASSERT allowlist, the
 * subset we fail loudly on.
 */
export const SCOPED_TOP_LEVEL_CRITICAL = [
  "start.sh",
  ".mcp.json",
  "CLAUDE.md",
  "cron-session.sh",
  ".resume-mode-migration-warned",
] as const;

/**
 * The STATIC scoped candidate set for the post-sweep readability assert
 * (#3333 stage 3, amendment B). Derived from the SAME scope constants the
 * sweep uses, so scope-of-sweep == scope-of-assert. The reconcile assert
 * unions this with the dynamic per-run `changes` list — it NEVER replaces
 * it (dropping `changes` would narrow coverage of touched-but-out-of-scope
 * files). Missing paths are harmless: findAgentUnreadablePaths skips them.
 */
export function scopedAssertCandidates(agentDir: string): string[] {
  return [
    join(agentDir, ".claude", "settings.json"),
    join(agentDir, ".claude-cron", ".mcp.json"),
    ...SCOPED_TOP_LEVEL_CRITICAL.map((f) => join(agentDir, f)),
  ];
}

/**
 * Env flag that switches the reconcile sweep from the full recursive chown
 * to the scoped sweep (#3333). Default OFF — the flag is injected by the
 * rollout ONLY into the canary restart spawn (stage 4, amendment C), never
 * globally, so a staged canary roll flips one agent at a time.
 */
export const SCOPED_SWEEP_ENV = "SWITCHROOM_SCOPED_OWNERSHIP_SWEEP";

/**
 * Process/syscall seams, injectable for tests (unit tests run as an
 * unprivileged UID and cannot chown to 10001+; they stub these to record
 * calls and to simulate a root euid).
 */
export const ownershipRuntime = {
  geteuid: (): number | undefined => process.geteuid?.(),
  /**
   * Recursive chown. Throws on failure (stderr captured in the error).
   * `-h` is load-bearing on busybox hosts — see "Symlink safety" above.
   */
  chownTree: (uid: number, gid: number, rootDir: string): void => {
    try {
      execFileSync("chown", ["-h", "-R", "--", `${uid}:${gid}`, rootDir], {
        stdio: ["ignore", "ignore", "pipe"],
        // LC_ALL=C pins chown's stderr wording so the race classifier below
        // is deterministic across hosts/locales (busybox + GNU both honour it).
        env: { ...process.env, LC_ALL: "C" },
        // Generous maxBuffer (#4365). A churning tree can emit MANY per-file
        // ENOENT lines; the default 1 MB cap makes execFileSync SIGTERM-KILL
        // chown mid-walk (status===null, signal set) and TRUNCATE stderr. A
        // truncated all-ENOENT tail is not evidence a real EPERM didn't follow,
        // so overflow would defeat the fail-closed classifier below. 64 MB is
        // far past any realistic churn so normal races never truncate.
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // Fail CLOSED on abnormal termination (#4365). execFileSync reports a
      // clean non-zero EXIT as a numeric `.status` with no `.signal`; a
      // maxBuffer overflow (or any kill) instead sets `.signal` and leaves
      // `.status` null — and its captured stderr is TRUNCATED. An all-ENOENT
      // tail of truncated stderr is NOT proof the run was a pure vanished-file
      // race (a real EPERM could have been emitted past the cutoff), so the
      // ENOENT-swallow is valid ONLY for a normal exited-non-zero chown with
      // complete stderr. Re-throw anything else before classifying.
      const e = err as { status?: number | null; signal?: string | null } | null | undefined;
      if (e?.signal != null || typeof e?.status !== "number") throw err;
      // chown -R exits non-zero if ANY entry failed. During a live rollout the
      // agent's own workspace may be churning (a mid-test Postgres data dir,
      // a git checkout, node_modules) so inodes vanish between chown's readdir
      // and its lchown — a benign ENOENT race, NOT an ownership failure. Swallow
      // the exit ONLY when EVERY stderr line is such a vanished-file error, and
      // re-throw on any real failure (EPERM/EACCES/EROFS): a still-present,
      // still-mis-owned file is the #3168 invariant we must fail loudly on.
      if (!isChownVanishedRaceOnly(err)) throw err;
    }
  },
  /**
   * SHALLOW chown (no `-R`) of the given paths — the top-level pass of the
   * scoped sweep (#3333 amendment A). `-h` is retained for the same busybox
   * symlink-safety reason as chownTree: a top-level entry may be a symlink
   * (SOUL.md → workspace/SOUL.md) and must be lchowned, not dereferenced.
   * Without `-R`, a directory arg chowns only the dir inode, not its
   * contents — so home/ workspace/ tmp/ are never traversed here.
   */
  chownShallow: (uid: number, gid: number, paths: string[]): void => {
    if (paths.length === 0) return;
    // `--` end-of-options guard + LC_ALL=C mirror chownTree's hardening
    // (#4366): a path beginning with `-` must not be parsed as a flag, and the
    // pinned locale keeps chown's stderr wording stable across hosts. This
    // helper has no race classifier and deliberately doesn't grow one here.
    execFileSync("chown", ["-h", "--", `${uid}:${gid}`, ...paths], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
  },
  /**
   * Whether the scoped sweep is enabled for this invocation (#3333). Reads
   * the per-invocation env flag; default OFF. Injectable so tests can flip
   * it without mutating process.env.
   */
  scopedSweepEnabled: (): boolean => process.env[SCOPED_SWEEP_ENV] === "1",
  /** Monotonic clock (ms), injectable so the timing log is deterministic in tests. */
  now: (): number => Date.now(),
  /**
   * Count the inodes under `rootDir` (best-effort, instrumentation only —
   * #3333). Shells `find | wc -l` so busybox and GNU both work; `rootDir`
   * is passed as a positional arg (not interpolated) to avoid shell
   * injection. Returns null when the count itself fails — instrumentation
   * must never break the sweep.
   */
  countInodes: (rootDir: string): number | null => {
    try {
      const out = execFileSync("sh", ["-c", 'find "$1" 2>/dev/null | wc -l', "sh", rootDir], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  },
};

/**
 * The scoped sweep (#3333 amendment A). Instead of `chown -h -R` over the
 * whole ~620k-inode agent tree (hours at single-spindle IOPS), re-own only
 * what root reconcile writers actually touch:
 *
 *   1. SHALLOW chown of the agent dir itself + every direct child (files
 *      and symlinks — captures start.sh, CLAUDE.md*, cron-session.sh,
 *      .mcp.json, .resume-mode-migration-warned, SOUL.md, regardless of
 *      name). Directory children get only their dir inode chowned, NOT
 *      their contents — so home/ workspace/ tmp/ are skipped.
 *   2. Recursive `chown -h -R` into the scoped state SUBDIRS
 *      (SCOPED_RECURSIVE_SUBDIRS) that exist — the dirs root writers create
 *      new inodes inside (.claude/settings.json, subagents, backups;
 *      .claude-cron/.mcp.json; telegram/ inbox).
 *
 * The walk itself is never hand-rolled: `readdirSync` reads ONE directory
 * level for the shallow pass, and the recursion is done by `chown -h -R`,
 * preserving `-h` symlink semantics throughout (amendment A).
 */
export function chownScopedTree(uid: number, gid: number, agentDir: string): void {
  let children: string[];
  try {
    children = readdirSync(agentDir).map((name) => join(agentDir, name));
  } catch {
    children = [];
  }
  ownershipRuntime.chownShallow(uid, gid, [agentDir, ...children]);
  for (const sub of SCOPED_RECURSIVE_SUBDIRS) {
    const subPath = join(agentDir, sub);
    if (existsSync(subPath)) {
      ownershipRuntime.chownTree(uid, gid, subPath);
    }
  }
}

/**
 * When the current process runs as root, chown the agent's state tree to
 * the agent's deterministic container UID. No-op (returns null) when not
 * root: a non-root writer is either the agent itself (files already land
 * correctly owned) or the operator under the apply path (alignAgentUid's
 * sudo sweep owns that case).
 *
 * Returns the UID the tree was aligned to, or null when skipped.
 * Throws when the chown itself fails — a root process that wrote into the
 * agent tree but cannot restore ownership WILL wedge the agent on
 * permission prompts, so this must be loud, not best-effort.
 */
export function alignAgentTreeOwnershipIfRoot(
  name: string,
  agentDir: string,
): number | null {
  if (ownershipRuntime.geteuid() !== 0) return null;
  if (!existsSync(agentDir)) return null;
  const uid = allocateAgentUid(name);
  // Instrumentation (#3333 stage 1): time the sweep and count the inodes it
  // walks, so a real roll can validate the "~620k → ~5k" scoping thesis
  // before the scoped sweep flips on. Pure observation — no behaviour change,
  // never allowed to break the sweep (countInodes returns null on failure).
  const scoped = ownershipRuntime.scopedSweepEnabled();
  const inodes = ownershipRuntime.countInodes(agentDir);
  const startedAt = ownershipRuntime.now();
  try {
    if (scoped) {
      chownScopedTree(uid, uid, agentDir);
    } else {
      ownershipRuntime.chownTree(uid, uid, agentDir);
    }
    const elapsedMs = ownershipRuntime.now() - startedAt;
    console.log(
      `[ownership-sweep] #3333 agent=${name} scope=${scoped ? "scoped" : "full"} uid=${uid} ` +
        `inodes=${inodes ?? "unknown"} elapsedMs=${elapsedMs} dir=${agentDir}`,
    );
  } catch (err) {
    throw new Error(
      `reconcile wrote into ${agentDir} as root but could not restore agent ` +
        `ownership (target uid ${uid}): ${(err as Error).message}. ` +
        `The agent cannot read root-owned 0600 files (settings.json permission ` +
        `allowlist → approval-card storm). Fix manually: chown -h -R ${uid}:${uid} ${agentDir}`,
    );
  }
  return uid;
}

/**
 * Post-sweep assertion: return every path (of the given candidates) that
 * exists but is NOT readable by the agent UID — i.e. not owned by the agent
 * and not other-readable. This is the deterministic guard for #3168: if a
 * future change writes an agent file after the sweep (or breaks the sweep),
 * reconcile fails loudly instead of silently storming the operator with
 * permission cards on the next rollout.
 *
 * Symlinks are skipped (their own mode bits are irrelevant on Linux; their
 * targets may deliberately live outside the agent tree, e.g. the shared
 * bundled-skills pool). Group-readability is deliberately ignored — agent
 * containers run with a single supplementary-group-free uid:gid, so
 * owner-or-other is the honest readability predicate.
 *
 * The `fs` seam is injectable so the SAME readability predicate can be
 * reused off the reconcile hot-path — the `switchroom doctor` pre-flight
 * (#3157 direction 2, `doctor-agent-dotfile-ownership.ts`) drives it with a
 * synthetic stat table to assert a root:root 0600 settings.json is flagged
 * for the agent's ACTUAL runtime uid (0 for a `root:` agent, the
 * deterministic 10001+ uid otherwise) without needing a real chown. Defaults
 * to node:fs so every existing caller (the reconcile assert) is unchanged.
 */
export interface UnreadableScanFs {
  lstatSync: (p: string) => { isSymbolicLink(): boolean };
  statSync: (p: string) => { uid: number; mode: number; isDirectory(): boolean };
}

export function findAgentUnreadablePaths(
  candidates: string[],
  agentUid: number,
  fs: UnreadableScanFs = { lstatSync, statSync },
): string[] {
  const bad: string[] = [];
  for (const p of candidates) {
    let ls;
    try {
      ls = fs.lstatSync(p);
    } catch {
      continue; // deleted / never created — nothing to read
    }
    if (ls.isSymbolicLink()) continue;
    const st = fs.statSync(p);
    if (st.uid === agentUid) continue;
    const otherReadable = st.isDirectory()
      ? (st.mode & 0o005) === 0o005 // need r+x to read through a dir
      : (st.mode & 0o004) === 0o004;
    if (!otherReadable) bad.push(p);
  }
  return bad;
}
