/**
 * Liveness-probe outcome tests.
 *
 * The headline case is the REGRESSION test: a process whose cwd is a NESTED
 * SUBDIRECTORY of a worktree must classify the worktree as live. Against the
 * pre-fix probe (`fuser <path>` / `lsof -t <path>`, both exact-match) that test
 * fails — the probe returns "free" and the reaper would force-remove a tree an
 * agent is working in.
 *
 * The synthetic-procfs tests drive `scanProcForHolders` against a fake `/proc`
 * built out of real symlinks, which is how the cross-mount-namespace and
 * partial-sweep behaviours are pinned without needing containers or root.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probePathInUse, probePathInUseWithTools } from "../src/worktree/reaper.js";
import { scanProcForHolders } from "../src/worktree/proc-liveness.js";

/** Wait until `pred()` is true or the deadline passes. */
async function until(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("worktree liveness probe", () => {
  let tmpDir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-liveness-"));
  });

  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── The regression: nested cwd ────────────────────────────────────────────

  const linuxOnly = process.platform === "linux" ? it : it.skip;

  linuxOnly(
    "classifies a tree as in-use when a process cwd is a NESTED SUBDIRECTORY",
    async () => {
      const tree = join(tmpDir, "tree");
      const nested = join(tree, "src", "deep");
      mkdirSync(nested, { recursive: true });

      // A live process sitting in the nested subdir — exactly what an agent
      // working inside a checkout looks like.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        cwd: nested,
        stdio: "ignore",
      });
      children.push(child);
      expect(await until(() => child.pid != null && !child.killed)).toBe(true);
      // Give the kernel a beat to publish /proc/<pid>.
      expect(await until(() => existsSync(`/proc/${child.pid}`))).toBe(true);

      // The OUTCOME that matters: the tree root must be reported live, so the
      // reaper's third fail-safe can never clear it.
      expect(probePathInUse(tree)).toBe("in-use");

      // And the reason the old probe missed it, pinned explicitly: the
      // external tools answer about the exact path only.
      expect(probePathInUseWithTools(tree)).not.toBe("in-use");
    },
  );

  linuxOnly("classifies a tree as in-use when a process holds an fd inside it", async () => {
    const tree = join(tmpDir, "fdtree");
    mkdirSync(join(tree, "sub"), { recursive: true });
    const file = join(tree, "sub", "held.txt");
    writeFileSync(file, "x");

    // This very process holds the fd — no child needed, and /proc/self is
    // always readable.
    const fd = openSync(file, "r");
    try {
      expect(probePathInUse(tree)).toBe("in-use");
    } finally {
      closeSync(fd);
    }
  });

  linuxOnly("reports a genuinely unheld tree as free", () => {
    const tree = join(tmpDir, "idle");
    mkdirSync(join(tree, "src"), { recursive: true });
    // Running as a uid that can inspect every process this yields "free";
    // otherwise the partial-sweep guard downgrades to "unavailable". Both are
    // safe; what must never happen is a false "in-use".
    expect(["free", "unavailable"]).toContain(probePathInUse(tree));
  });

  // ── Synthetic procfs: mechanisms that need a controlled /proc ─────────────

  /** Build a fake procfs entry with a cwd symlink (and optional fds). */
  function fakeProc(
    root: string,
    entries: { pid: string; cwd?: string; fds?: string[]; cmdline?: string }[],
  ): string {
    mkdirSync(root, { recursive: true });
    for (const e of entries) {
      const dir = join(root, e.pid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cmdline"), e.cmdline ?? "node\0");
      if (e.cwd) symlinkSync(e.cwd, join(dir, "cwd"));
      if (e.fds) {
        mkdirSync(join(dir, "fd"), { recursive: true });
        e.fds.forEach((target, i) => symlinkSync(target, join(dir, "fd", String(i + 3))));
      }
    }
    return root;
  }

  it("finds a holder whose cwd path is a container-internal alias of the tree", () => {
    // A process inside an agent container sees the worktree at a different
    // path than the host does. Its /proc/<pid>/cwd STRING therefore shares no
    // prefix with the host path — only the inode walk can match it.
    const tree = join(tmpDir, "host", "tree");
    mkdirSync(join(tree, "src", "deep"), { recursive: true });
    const alias = join(tmpDir, "state-agent"); // stands in for the container view
    symlinkSync(join(tmpDir, "host"), alias);

    const procRoot = fakeProc(join(tmpDir, "proc"), [
      { pid: "4242", cwd: join(alias, "tree", "src", "deep") },
    ]);

    const scan = scanProcForHolders(tree, { procRoot });
    expect(scan.state).toBe("in-use");
    expect(scan.holder?.via).toBe("inode");
    expect(scan.holder?.pid).toBe(4242);
  });

  it("reports free (definitive) when every process is inspectable and none holds the tree", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    const other = join(tmpDir, "elsewhere");
    mkdirSync(other, { recursive: true });

    const procRoot = fakeProc(join(tmpDir, "proc"), [{ pid: "7", cwd: other }]);
    const scan = scanProcForHolders(tree, { procRoot });
    expect(scan).toMatchObject({ state: "free", inaccessible: 0 });
  });

  it("a partial sweep never resolves to free, even when the tools say free", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    expect(
      probePathInUse(tree, {
        scanProc: () => ({ state: "free", inaccessible: 3 }),
        probeTools: () => "free",
      }),
    ).toBe("unavailable");
  });

  // Root can read every /proc entry, so the EACCES accounting can only be
  // observed as a non-root uid. The decision rule it feeds is pinned above,
  // unconditionally.
  const nonRootOnly = (process.getuid?.() ?? 0) === 0 ? it.skip : it;

  nonRootOnly("counts a process it cannot inspect as uninspectable", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    const procRoot = fakeProc(join(tmpDir, "proc"), [{ pid: "9", cwd: tmpDir }]);
    const blocked = join(procRoot, "11");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "cmdline"), "node\0");
    symlinkSync(tmpDir, join(blocked, "cwd"));
    // 0o000 makes both the cwd readlink and the fd readdir fail with EACCES.
    chmodSync(blocked, 0o000);
    try {
      const scan = scanProcForHolders(tree, { procRoot });
      expect(scan).toMatchObject({ state: "free", inaccessible: 1 });
    } finally {
      chmodSync(blocked, 0o755);
    }
  });

  it("a tool hit still wins after a partial sweep", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    expect(
      probePathInUse(tree, {
        scanProc: () => ({ state: "free", inaccessible: 2 }),
        probeTools: () => "in-use",
      }),
    ).toBe("in-use");
  });

  it("falls through to the tools verbatim when there is no procfs at all", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    expect(
      probePathInUse(tree, {
        scanProc: () => ({ state: "unavailable", inaccessible: 0 }),
        probeTools: () => "free",
      }),
    ).toBe("free");
    expect(
      probePathInUse(tree, {
        scanProc: () => ({ state: "unavailable", inaccessible: 0 }),
        probeTools: () => "unavailable",
      }),
    ).toBe("unavailable");
  });

  it("kernel threads are not counted as uninspectable", () => {
    const tree = join(tmpDir, "tree");
    mkdirSync(tree, { recursive: true });
    // Empty cmdline + no cwd link ⇒ a kthread-shaped entry. It must not
    // poison the sweep into "partial".
    const procRoot = join(tmpDir, "proc");
    mkdirSync(join(procRoot, "2"), { recursive: true });
    writeFileSync(join(procRoot, "2", "cmdline"), "");
    const scan = scanProcForHolders(tree, { procRoot });
    expect(scan).toMatchObject({ state: "free", inaccessible: 0 });
  });

  it("treats a vanished tree as unavailable, never free", () => {
    const scan = scanProcForHolders(join(tmpDir, "does-not-exist"), {
      procRoot: join(tmpDir, "proc"),
    });
    expect(scan.state).toBe("unavailable");
  });
});
