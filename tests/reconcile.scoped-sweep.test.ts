/**
 * #3333 stage 2 — scoped ownership sweep behind a flag (default OFF).
 *
 * The full recursive `chown -h -R` over an agent's ~620k-inode tree takes
 * hours at single-spindle IOPS (home/ is ~96% of the inodes and is caches,
 * not agent state). The scoped sweep (amendment A) re-owns only what root
 * reconcile writers actually touch: a SHALLOW chown of the top-level
 * (files + symlinks + dir inodes) plus a recursive chown into the scoped
 * state subdirs {.claude/, .claude-cron/, telegram/}. home/ workspace/ tmp/
 * are never traversed.
 *
 * These tests pin:
 *   - flag OFF (default) => full sweep, unchanged (chownTree over agentDir)
 *   - flag ON => shallow top-level + recursion only into existing scoped subdirs
 *   - the excluded caches (home/) are NEVER recursed into
 *   - `-h` symlink safety on the real shallow chown (root-gated)
 *   - a planted root:root 0600 file in .claude IS re-owned by the scoped
 *     sweep; one planted in the excluded home/ is left (root-gated)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignAgentTreeOwnershipIfRoot,
  chownScopedTree,
  ownershipRuntime,
  SCOPED_SWEEP_ENV,
} from "../src/agents/agent-owned-tree.js";
import { allocateAgentUid } from "../src/agents/agent-uid.js";

const AGENT = "scoped-agent";

const real = {
  geteuid: ownershipRuntime.geteuid,
  chownTree: ownershipRuntime.chownTree,
  chownShallow: ownershipRuntime.chownShallow,
  scopedSweepEnabled: ownershipRuntime.scopedSweepEnabled,
  now: ownershipRuntime.now,
  countInodes: ownershipRuntime.countInodes,
};

/** Build an agent-dir skeleton: top-level files + symlink, scoped subdirs, and excluded caches. */
function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "switchroom-scoped-"));
  writeFileSync(join(dir, "start.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "CLAUDE.md"), "x");
  writeFileSync(join(dir, "CLAUDE.md.fingerprint"), "abc");
  writeFileSync(join(dir, "cron-session.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, ".resume-mode-migration-warned"), "1");
  writeFileSync(join(dir, ".mcp.json"), "{}");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  mkdirSync(join(dir, ".claude-cron"), { recursive: true });
  writeFileSync(join(dir, ".claude-cron", ".mcp.json"), "{}");
  mkdirSync(join(dir, "telegram"), { recursive: true });
  // Excluded caches — must never be recursed into.
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "cache.bin"), "big");
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  // Top-level symlink (SOUL.md → workspace/SOUL.md shape).
  writeFileSync(join(dir, "workspace", "SOUL.md"), "soul");
  symlinkSync("workspace/SOUL.md", join(dir, "SOUL.md"));
  return dir;
}

describe("chownScopedTree — call shape (#3333 stage 2)", () => {
  afterEach(() => {
    ownershipRuntime.chownTree = real.chownTree;
    ownershipRuntime.chownShallow = real.chownShallow;
  });

  it("shallow-chowns agentDir + all direct children, recurses only into existing scoped subdirs", () => {
    const dir = makeTree();
    try {
      const shallow: string[][] = [];
      const recursed: string[] = [];
      ownershipRuntime.chownShallow = (_u, _g, paths) => shallow.push(paths);
      ownershipRuntime.chownTree = (_u, _g, root) => recursed.push(root);

      const uid = allocateAgentUid(AGENT);
      chownScopedTree(uid, uid, dir);

      expect(shallow.length).toBe(1);
      const paths = shallow[0];
      expect(paths[0]).toBe(dir); // the dir inode itself
      // every direct child included (files, symlink, subdir inodes)
      for (const child of [
        "start.sh",
        "CLAUDE.md",
        "CLAUDE.md.fingerprint",
        "cron-session.sh",
        ".resume-mode-migration-warned",
        ".mcp.json",
        "SOUL.md",
        "home",
        "workspace",
        "tmp",
      ]) {
        expect(paths).toContain(join(dir, child));
      }

      // recursion ONLY into the three scoped subdirs that exist
      expect(recursed.sort()).toEqual(
        [".claude", ".claude-cron", "telegram"].map((s) => join(dir, s)).sort(),
      );
      // excluded caches are NEVER a recursion root
      expect(recursed).not.toContain(join(dir, "home"));
      expect(recursed).not.toContain(join(dir, "workspace"));
      expect(recursed).not.toContain(join(dir, "tmp"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-owns bundled-skill symlinks under .claude/skills/ (footgun A migration is UID-safe)", () => {
    // The relative-symlink migration (footgun A) rm+re-creates links under
    // .claude/skills/ from a root reconcile writer. Those links must be
    // re-owned to the agent UID, or the agent can't traverse them and the
    // permission allowlist wedges (#3168). The guarantee is that .claude is a
    // recursion root of the scoped sweep — chown -h -R re-owns the link
    // itself (via -h, WITHOUT dereferencing into the shared pool). This test
    // fails loudly if skills are ever moved out of the .claude subtree.
    const dir = makeTree();
    try {
      const skillsDir = join(dir, ".claude", "skills");
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync("../../../../skills/_bundled/dev-protocol", join(skillsDir, "dev-protocol"));

      const recursed: string[] = [];
      ownershipRuntime.chownShallow = () => {};
      ownershipRuntime.chownTree = (_u, _g, root) => recursed.push(root);

      const uid = allocateAgentUid(AGENT);
      chownScopedTree(uid, uid, dir);

      // .claude is a recursion root, so `chown -h -R` covers the skill link.
      expect(recursed).toContain(join(dir, ".claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recurses into schedule.d/ and skills.d/ so root-written cron overlays are re-owned", () => {
    // Clerk incident: root-owned 0600 schedule.d/cron-*.yaml → the agent's
    // scheduler EACCESed on every hot-reload and the crons silently
    // stopped firing. The FULL sweep always healed these; the scoped sweep
    // must cover them too or flipping the #3333 flag on reopens the window.
    const dir = makeTree();
    try {
      mkdirSync(join(dir, "schedule.d"), { recursive: true });
      writeFileSync(join(dir, "schedule.d", "cron-abc123.yaml"), "schedule: []\n");
      mkdirSync(join(dir, "skills.d"), { recursive: true });

      const recursed: string[] = [];
      ownershipRuntime.chownShallow = () => {};
      ownershipRuntime.chownTree = (_u, _g, root) => recursed.push(root);

      const uid = allocateAgentUid(AGENT);
      chownScopedTree(uid, uid, dir);

      expect(recursed).toContain(join(dir, "schedule.d"));
      expect(recursed).toContain(join(dir, "skills.d"));
      // Cache exclusions unchanged.
      expect(recursed).not.toContain(join(dir, "home"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a scoped subdir that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-scoped-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const recursed: string[] = [];
      ownershipRuntime.chownShallow = () => {};
      ownershipRuntime.chownTree = (_u, _g, root) => recursed.push(root);
      chownScopedTree(1, 1, dir);
      expect(recursed).toEqual([join(dir, ".claude")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("alignAgentTreeOwnershipIfRoot — flag gating (#3333 stage 2)", () => {
  beforeEach(() => {
    ownershipRuntime.now = () => 0;
    ownershipRuntime.countInodes = () => 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    ownershipRuntime.geteuid = real.geteuid;
    ownershipRuntime.chownTree = real.chownTree;
    ownershipRuntime.chownShallow = real.chownShallow;
    ownershipRuntime.scopedSweepEnabled = real.scopedSweepEnabled;
    ownershipRuntime.now = real.now;
    ownershipRuntime.countInodes = real.countInodes;
    delete process.env[SCOPED_SWEEP_ENV];
    vi.restoreAllMocks();
  });

  it("flag OFF (default): full sweep — chownTree over agentDir, no shallow pass", () => {
    const dir = makeTree();
    try {
      const full: string[] = [];
      const shallow: string[][] = [];
      ownershipRuntime.geteuid = () => 0;
      ownershipRuntime.scopedSweepEnabled = real.scopedSweepEnabled; // reads env (unset)
      ownershipRuntime.chownTree = (_u, _g, root) => full.push(root);
      ownershipRuntime.chownShallow = (_u, _g, p) => shallow.push(p);

      alignAgentTreeOwnershipIfRoot(AGENT, dir);
      expect(full).toEqual([dir]);
      expect(shallow).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flag ON: scoped sweep — shallow top-level + scoped subdir recursion, agentDir never a full-tree root", () => {
    const dir = makeTree();
    try {
      const recursed: string[] = [];
      const shallow: string[][] = [];
      ownershipRuntime.geteuid = () => 0;
      ownershipRuntime.scopedSweepEnabled = () => true;
      ownershipRuntime.chownTree = (_u, _g, root) => recursed.push(root);
      ownershipRuntime.chownShallow = (_u, _g, p) => shallow.push(p);

      alignAgentTreeOwnershipIfRoot(AGENT, dir);
      expect(shallow.length).toBe(1);
      // the whole-tree chown root (agentDir) must NOT appear — that's the slow path we removed
      expect(recursed).not.toContain(dir);
      expect(recursed.sort()).toEqual(
        [".claude", ".claude-cron", "telegram"].map((s) => join(dir, s)).sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scopedSweepEnabled reads the per-invocation env flag (default OFF)", () => {
    delete process.env[SCOPED_SWEEP_ENV];
    expect(real.scopedSweepEnabled()).toBe(false);
    process.env[SCOPED_SWEEP_ENV] = "1";
    expect(real.scopedSweepEnabled()).toBe(true);
    process.env[SCOPED_SWEEP_ENV] = "0";
    expect(real.scopedSweepEnabled()).toBe(false);
  });
});

describe("chownShallow — -h symlink semantics on non-root CI (#3362 review fix 2)", () => {
  // The root-gated -h tests below self-skip on the non-root CI runner, so a
  // `-h` removal from chownShallow's argv would ship green there. This test
  // runs UNPRIVILEGED: chown to our OWN uid:gid needs no CAP_CHOWN, and a
  // DANGLING symlink makes -h load-bearing — without -h (GNU non-recursive
  // chown and busybox both dereference by default) the chown hits ENOENT and
  // throws; with -h it lchowns the link and succeeds. Outcome-asserting:
  // fails if -h is ever dropped, on any runner.
  it("real chownShallow lchowns a dangling symlink instead of dereferencing (would throw without -h)", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-shallow-h-"));
    try {
      const file = join(dir, "plain");
      writeFileSync(file, "x");
      const dangling = join(dir, "dangling");
      symlinkSync("/nonexistent/target/for-h-test", dangling);
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      expect(() =>
        real.chownShallow(uid, gid, [dir, file, dangling]),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Real-outcome pins: only where the test process has CAP_CHOWN (self-skip on
// the non-root CI runner). The recorder tests above cover the wiring there.
describe("chownScopedTree — real outcomes (root only)", () => {
  it.runIf(process.getuid?.() === 0)(
    "re-owns a planted root:root 0600 file in .claude, leaves the one in excluded home/",
    () => {
      const dir = makeTree();
      try {
        const planted = join(dir, ".claude", "planted.json");
        writeFileSync(planted, "{}", { mode: 0o600 });
        execFileSync("chown", ["0:0", planted]);
        const cachePlanted = join(dir, "home", "planted.bin");
        writeFileSync(cachePlanted, "x", { mode: 0o600 });
        execFileSync("chown", ["0:0", cachePlanted]);

        const uid = allocateAgentUid(AGENT);
        chownScopedTree(uid, uid, dir);

        expect(statSync(planted).uid).toBe(uid); // scoped subdir → re-owned
        expect(statSync(cachePlanted).uid).toBe(0); // excluded cache → untouched
        // top-level shallow pass re-owned the direct children
        expect(statSync(join(dir, "start.sh")).uid).toBe(uid);
        expect(statSync(join(dir, "cron-session.sh")).uid).toBe(uid);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.getuid?.() === 0)(
    "-h: a planted top-level symlink is lchowned, its target is NOT dereferenced",
    () => {
      const dir = makeTree();
      const outside = mkdtempSync(join(tmpdir(), "switchroom-outside-"));
      const secret = join(outside, "secret");
      try {
        writeFileSync(secret, "shadow", { mode: 0o600 });
        execFileSync("chown", ["0:0", secret]);
        symlinkSync(secret, join(dir, "evil-link"));

        const uid = allocateAgentUid(AGENT);
        chownScopedTree(uid, uid, dir);

        // the symlink target (outside the tree) must stay root-owned
        expect(statSync(secret).uid).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
