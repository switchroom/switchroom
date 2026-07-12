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
 * The sweep shells `chown -R` exactly like `alignAgentUid` does. GNU/busybox
 * `chown -R` does not traverse symlinks (default -P), so symlinks into the
 * shared bundled-skills pool (`~/.switchroom/skills/`) never re-own pool
 * files — the same battle-tested semantics apply has used fleet-wide.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { allocateAgentUid } from "./agent-uid.js";

/**
 * Process/syscall seams, injectable for tests (unit tests run as an
 * unprivileged UID and cannot chown to 10001+; they stub these to record
 * calls and to simulate a root euid).
 */
export const ownershipRuntime = {
  geteuid: (): number | undefined => process.geteuid?.(),
  /** Recursive chown. Throws on failure (stderr captured in the error). */
  chownTree: (uid: number, gid: number, rootDir: string): void => {
    execFileSync("chown", ["-R", `${uid}:${gid}`, rootDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  },
};

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
  try {
    ownershipRuntime.chownTree(uid, uid, agentDir);
  } catch (err) {
    throw new Error(
      `reconcile wrote into ${agentDir} as root but could not restore agent ` +
        `ownership (target uid ${uid}): ${(err as Error).message}. ` +
        `The agent cannot read root-owned 0600 files (settings.json permission ` +
        `allowlist → approval-card storm). Fix manually: chown -R ${uid}:${uid} ${agentDir}`,
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
 */
export function findAgentUnreadablePaths(
  candidates: string[],
  agentUid: number,
): string[] {
  const bad: string[] = [];
  for (const p of candidates) {
    let ls;
    try {
      ls = lstatSync(p);
    } catch {
      continue; // deleted / never created — nothing to read
    }
    if (ls.isSymbolicLink()) continue;
    const st = statSync(p);
    if (st.uid === agentUid) continue;
    const otherReadable = st.isDirectory()
      ? (st.mode & 0o005) === 0o005 // need r+x to read through a dir
      : (st.mode & 0o004) === 0o004;
    if (!otherReadable) bad.push(p);
  }
  return bad;
}
