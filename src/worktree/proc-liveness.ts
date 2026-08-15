/**
 * Liveness probe: does ANY live process sit at or below a worktree path?
 *
 * ## Why this exists (the bug it replaces)
 *
 * The reaper used to answer that question with `fuser <path>` / `lsof -t <path>`.
 * Both of those match the path **exactly**. A process whose cwd is a NESTED
 * SUBDIRECTORY of the worktree — `<tree>/src/deep`, i.e. what an agent working
 * in a checkout actually looks like — is invisible to them:
 *
 *     $ mkdir -p /tmp/tree/src/deep && (cd /tmp/tree/src/deep && sleep 60) &
 *     $ fuser /tmp/tree            ; echo $?     # (no output)   1   ← "free"
 *     $ fuser /tmp/tree/src/deep   ; echo $?     # 262751c       0   ← in-use
 *
 * `probePathInUse` therefore reported "free" for a tree an agent was actively
 * working in, and the reaper's third fail-safe ("an in-use probe can
 * DEFINITIVELY report the path as free") would have licensed a
 * `git worktree remove --force` over live work.
 *
 * ## What replaces it
 *
 * On Linux we walk `/proc` ourselves and treat a process as a holder when
 * EITHER
 *   - its `cwd` is the tree root or any directory beneath it, or
 *   - any of its open file descriptors resolves to a path beneath the tree.
 *
 * ## Two subtleties the naive version gets wrong
 *
 * 1. **Mount namespaces (the container/host boundary).** The claim pool and the
 *    per-agent task trees live on the HOST (`~/.switchroom/…`), and this probe
 *    runs host-side (`switchroom worktree reap` / `gc` are host CLI verbs; the
 *    vault/host-home invariants keep them there). But the processes actually
 *    holding those trees are frequently INSIDE an agent container, where the
 *    same directory is mounted at a different path (`/state/agent/home/work/x`).
 *    Reading `/proc/<pid>/cwd` from the host yields the path as seen in THAT
 *    process's mount namespace, so a plain string-prefix test misses it.
 *    We therefore also do an inode walk: `/proc/<pid>/cwd/..`, `/…/../..`, …
 *    are resolved by the kernel in OUR view of the filesystem, so comparing
 *    `(dev, ino)` against the tree root finds a container-side holder no matter
 *    what its path looks like inside the container.
 *
 * 2. **A partial scan is not a negative.** Reading another uid's
 *    `/proc/<pid>/cwd` needs `PTRACE_MODE_READ`; as a non-root operator most of
 *    those fail with EACCES. Finding no holder among the processes we COULD
 *    inspect does not prove the tree is free, so the scan reports how many
 *    entries it could not inspect and the caller degrades to "unavailable"
 *    (= treat as live, keep) rather than "free". Kernel threads are excluded
 *    from that count: they have no mm (empty `cmdline`) and can never hold a
 *    worktree.
 */

import { readdirSync, readlinkSync, realpathSync, statSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** Outcome of one procfs sweep. */
export interface ProcScanResult {
  /**
   *   - "in-use"      — a holder was positively identified.
   *   - "free"        — the sweep completed and found no holder. Only
   *                     DEFINITIVE when `inaccessible === 0`.
   *   - "unavailable" — no readable procfs (non-Linux, or /proc not mounted).
   */
  state: "in-use" | "free" | "unavailable";
  /**
   * Number of userspace processes whose cwd/fds we could not inspect
   * (EACCES/EPERM). A "free" with a non-zero count proves nothing.
   */
  inaccessible: number;
  /** Populated when `state === "in-use"`. */
  holder?: { pid: number; kind: "cwd" | "fd"; via: "path" | "inode"; target: string };
}

export interface ProcScanOptions {
  /** procfs mount point. Injectable so tests can drive a synthetic /proc. */
  procRoot?: string;
  /**
   * Max parent hops for the namespace-proof inode walk. A worktree nested more
   * deeply than this degrades to path matching only.
   */
  maxDepth?: number;
}

/** True when the path component is a pid directory. */
function isPidDir(name: string): boolean {
  return /^\d+$/.test(name);
}

/**
 * `/proc/<pid>/cwd` and `/proc/<pid>/fd/<n>` links to a removed inode carry a
 * " (deleted)" suffix. Strip it before comparing.
 */
function stripDeleted(target: string): string {
  return target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target;
}

function isAtOrBelow(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** errno of a caught fs error, or "" when it has none. */
function errno(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? "";
}

/**
 * A pid whose `cmdline` is empty is a kernel thread: no mm, no cwd of its own
 * (the kernel reports `/`), so it can never hold a worktree. Excluding these
 * keeps the `inaccessible` count honest on a host with hundreds of kthreads.
 */
function isKernelThread(procRoot: string, pid: string): boolean {
  try {
    return readFileSync(join(procRoot, pid, "cmdline")).length === 0;
  } catch {
    return false; // can't tell ⇒ count it as a real process (fail-safe)
  }
}

/**
 * Walk up from `linkPath` (a `/proc/<pid>/cwd` magic symlink) comparing
 * `(dev, ino)` against `rootId` at every hop. The kernel resolves each `..`
 * in OUR mount namespace, which is what makes this work for a process inside a
 * container whose cwd STRING bears no resemblance to the host path.
 *
 * Returns true when the cwd is the root or a descendant of it.
 */
function cwdIsUnderRootByInode(
  linkPath: string,
  rootId: { dev: number; ino: number },
  maxDepth: number,
): boolean {
  // NOTE: the `..` components are appended as raw string suffixes and never
  // via `path.join`, which would collapse them LEXICALLY ("/proc/9/cwd/.." →
  // "/proc/9"). We need the kernel to resolve them PHYSICALLY, through the
  // magic symlink and up the real directory tree.
  let suffix = "";
  let lastDev = -1;
  let lastIno = -1;
  for (let hop = 0; hop <= maxDepth; hop++) {
    let st;
    try {
      st = statSync(linkPath + suffix);
    } catch {
      return false;
    }
    if (st.dev === rootId.dev && st.ino === rootId.ino) return true;
    // Reached the filesystem root of this branch: `..` is a fixed point.
    if (st.dev === lastDev && st.ino === lastIno) return false;
    lastDev = st.dev;
    lastIno = st.ino;
    suffix += "/..";
  }
  return false;
}

/**
 * Scan procfs for any process holding `path` at or below the tree root.
 *
 * Short-circuits on the first holder found. Never throws: an unreadable procfs
 * degrades to `"unavailable"`, which every caller must treat as "assume live".
 */
export function scanProcForHolders(path: string, opts: ProcScanOptions = {}): ProcScanResult {
  const procRoot = opts.procRoot ?? "/proc";
  const maxDepth = opts.maxDepth ?? 64;

  let root: string;
  let rootId: { dev: number; ino: number };
  try {
    root = realpathSync(path);
    const st = statSync(root);
    rootId = { dev: st.dev, ino: st.ino };
  } catch {
    // The tree is gone or unreadable — nothing here can prove it free.
    return { state: "unavailable", inaccessible: 0 };
  }

  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter(isPidDir);
  } catch {
    return { state: "unavailable", inaccessible: 0 };
  }
  if (pids.length === 0) return { state: "unavailable", inaccessible: 0 };

  let inaccessible = 0;

  for (const pid of pids) {
    let blocked = false;

    // ── cwd ────────────────────────────────────────────────────────────────
    const cwdLink = join(procRoot, pid, "cwd");
    try {
      const target = stripDeleted(readlinkSync(cwdLink));
      if (isAtOrBelow(target, root)) {
        return {
          state: "in-use",
          inaccessible,
          holder: { pid: Number(pid), kind: "cwd", via: "path", target },
        };
      }
      // Namespace-proof fallback: the cwd STRING may be a container-internal
      // path for the very same directory. Compare by inode instead.
      if (cwdIsUnderRootByInode(cwdLink, rootId, maxDepth)) {
        return {
          state: "in-use",
          inaccessible,
          holder: { pid: Number(pid), kind: "cwd", via: "inode", target },
        };
      }
    } catch (e) {
      const code = errno(e);
      // ENOENT/ESRCH: the process exited mid-scan — nothing to account for.
      if (code === "EACCES" || code === "EPERM") blocked = true;
    }

    // ── open file descriptors ──────────────────────────────────────────────
    // Path matching only: an fd points at a FILE, so there is no `..` walk to
    // do and no inode of ours to compare it against. A container-side fd is
    // consequently only caught when its path matches; the cwd walk above is
    // the cross-namespace signal.
    const fdDir = join(procRoot, pid, "fd");
    try {
      for (const fd of readdirSync(fdDir)) {
        let target: string;
        try {
          target = stripDeleted(readlinkSync(join(fdDir, fd)));
        } catch {
          continue; // fd closed mid-scan
        }
        if (isAtOrBelow(target, root)) {
          return {
            state: "in-use",
            inaccessible,
            holder: { pid: Number(pid), kind: "fd", via: "path", target },
          };
        }
      }
    } catch (e) {
      const code = errno(e);
      if (code === "EACCES" || code === "EPERM") blocked = true;
    }

    if (blocked && !isKernelThread(procRoot, pid)) inaccessible++;
  }

  return { state: "free", inaccessible };
}
