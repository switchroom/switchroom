/**
 * Regression tests for #3168 — rollout reconcile rewrote agent dotfiles
 * root-owned, so agents couldn't read their own settings.json.
 *
 * Incident (2026-07-12, v0.18.13 → v0.18.14 roll): hostd spawns
 * `switchroom agent restart <a> --wait --force` AS ROOT for every agent on
 * every rollout (src/cli/rollout.ts:681). Restart reconciles first, and
 * reconcileAgent rewrites `.claude/settings.json` via atomicWriteFileSync
 * (tmp + rename — the rename replaces the inode), so the file's owner became
 * root, mode 0600. Every agent's claude (its own uid 10001–10999) could no
 * longer read its permission allowlist → Claude Code silently loaded NO
 * allowlist → all 12 agents threw an operator approval card for every tool
 * call, simultaneously, on every update.
 *
 * The fix: reconcileAgent ends with a deterministic ownership sweep
 * (alignAgentTreeOwnershipIfRoot — the reconcile twin of apply's
 * alignAgentUid) plus a readability assertion that fails the reconcile
 * loudly if any touched file is left unreadable by the agent uid.
 *
 * Pre-fix behavior these tests fail on:
 *   - no sweep call at all when reconcile runs as root (tests 1, 5)
 *   - reconcile "succeeding" while leaving agent-unreadable files (test 4)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileAgent, scaffoldAgent } from "../src/agents/scaffold.js";
import {
  alignAgentTreeOwnershipIfRoot,
  findAgentUnreadablePaths,
  ownershipRuntime,
} from "../src/agents/agent-owned-tree.js";
import { allocateAgentUid } from "../src/agents/agent-uid.js";
import { allocateAgentUid as allocateAgentUidViaCompose } from "../src/agents/compose.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

const AGENT = "test-agent";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const switchroomConfig: SwitchroomConfig = {
  agents: {},
  telegram: telegramConfig,
  defaults: {},
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

const realGeteuid = ownershipRuntime.geteuid;
const realChownTree = ownershipRuntime.chownTree;

describe("reconcileAgent — agent-tree ownership sweep (#3168)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-ownership-"));
  });

  afterEach(() => {
    ownershipRuntime.geteuid = realGeteuid;
    ownershipRuntime.chownTree = realChownTree;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("chowns the agent tree to the agent uid when reconcile runs as root", () => {
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    const calls: Array<{ uid: number; gid: number; rootDir: string }> = [];
    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = (uid, gid, rootDir) => {
      calls.push({ uid, gid, rootDir });
      // Outcome stand-in for non-root test environments (a real chown to
      // 10001+ needs CAP_CHOWN): make the tree agent-readable the way the
      // real sweep would, so the post-sweep readability assertion inside
      // reconcileAgent sees what production sees. The root-gated test below
      // pins the real chown outcome.
      execFileSync("chmod", ["-R", "a+rX", rootDir]);
    };

    reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig);

    const uid = allocateAgentUid(AGENT);
    expect(calls).toEqual([{ uid, gid: uid, rootDir: agentDir }]);
  });

  it("does not chown when reconcile runs unprivileged (agent / operator writers)", () => {
    const config = makeAgentConfig();
    scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    const calls: string[] = [];
    ownershipRuntime.geteuid = () => 10123; // in-container agent-uid reconcile
    ownershipRuntime.chownTree = (_uid, _gid, rootDir) => {
      calls.push(rootDir);
    };

    reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig);
    expect(calls).toEqual([]);
  });

  it("fails the reconcile loudly when the root chown itself fails", () => {
    const config = makeAgentConfig();
    scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = () => {
      throw new Error("read-only file system");
    };

    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(/could not restore agent ownership/);
  });

  it("the chown-failure remediation hint keeps the -h flag (#3168 review F3)", () => {
    // The printed manual-fix command is operator advice that will be pasted
    // as root over an agent-writable tree. Without -h, busybox chown
    // dereferences a planted symlink — the exact F2 hazard, reintroduced by
    // our own error message. Pin the flag so it can't silently regress.
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = () => {
      throw new Error("read-only file system");
    };

    const uid = allocateAgentUid(AGENT);
    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(`Fix manually: chown -h -R ${uid}:${uid} ${agentDir}`);
  });

  it("fails the reconcile when the sweep leaves settings.json unreadable by the agent uid (pre-fix incident shape)", () => {
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    // Simulate the pre-fix state: writer is root, but ownership is never
    // restored (broken/absent sweep). settings.json on disk is mode 0600
    // owned by the test process (0 or 1000 — never the agent's 10001+ uid),
    // which is exactly the poison combination from the incident.
    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = () => {
      /* sweep that fixes nothing */
    };

    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(/agent-unreadable files/);
    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(new RegExp(join(agentDir, ".claude", "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("restores ownership even when reconcile throws AFTER the atomic rewrites (#3168 review F1)", () => {
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);

    // Force a deterministic throw at a point AFTER the settings.json (and
    // .mcp.json) atomic rewrites: the workspace re-seed block calls
    // mkdirSync(<agentDir>/workspace, { recursive: true }), which throws
    // EEXIST/ENOTDIR when a regular FILE occupies that path. This models
    // any post-write failure (ENOSPC, symlink migration error) that
    // pre-backstop left root:root 0600 dotfiles behind with no sweep.
    rmSync(join(agentDir, "workspace"), { recursive: true, force: true });
    writeFileSync(join(agentDir, "workspace"), "not a directory");

    const calls: Array<{ uid: number; gid: number; rootDir: string }> = [];
    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = (uid, gid, rootDir) => {
      calls.push({ uid, gid, rootDir });
    };

    // The original error must surface (not be masked by the backstop)…
    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(/EEXIST|ENOTDIR|file already exists|not a directory/i);

    // …and the ownership sweep must still have run on the error path.
    const uid = allocateAgentUid(AGENT);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toEqual({ uid, gid: uid, rootDir: agentDir });
  });

  it("a failing backstop sweep never masks the original mid-reconcile error", () => {
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);
    rmSync(join(agentDir, "workspace"), { recursive: true, force: true });
    writeFileSync(join(agentDir, "workspace"), "not a directory");

    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = () => {
      throw new Error("chown exploded too");
    };

    // The mkdir failure — the actual bug — must win over the sweep failure.
    expect(() =>
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
    ).toThrow(/EEXIST|ENOTDIR|file already exists|not a directory/i);
  });

  // Real-outcome pin: only executable where the test process actually has
  // CAP_CHOWN. On the CI vitest runner (non-root) this self-skips; the
  // recorder-based tests above cover the wiring there.
  it.runIf(process.getuid?.() === 0)(
    "root reconcile leaves settings.json owned by the agent uid on disk",
    () => {
      const config = makeAgentConfig();
      const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);
      const settingsPath = join(agentDir, ".claude", "settings.json");

      // Pre-fix incident state after a root rollout: root:root 0600.
      expect(statSync(settingsPath).uid).toBe(0);

      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig);

      const uid = allocateAgentUid(AGENT);
      expect(statSync(settingsPath).uid).toBe(uid);
      expect(statSync(settingsPath).gid).toBe(uid);
      // .mcp.json is the other atomic-rewrite (new-inode) victim.
      expect(statSync(join(agentDir, ".mcp.json")).uid).toBe(uid);
      // The whole tree is swept, not just the two incident files.
      expect(statSync(join(agentDir, "start.sh")).uid).toBe(uid);
      expect(statSync(join(agentDir, ".claude")).uid).toBe(uid);
    },
  );

  it.runIf(process.getuid?.() === 0)(
    "root reconcile that throws mid-run still leaves settings.json agent-owned on disk (#3168 review F1)",
    () => {
      const config = makeAgentConfig();
      const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);
      rmSync(join(agentDir, "workspace"), { recursive: true, force: true });
      writeFileSync(join(agentDir, "workspace"), "not a directory");

      expect(() =>
        reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig),
      ).toThrow(/EEXIST|ENOTDIR|file already exists|not a directory/i);

      const uid = allocateAgentUid(AGENT);
      expect(statSync(join(agentDir, ".claude", "settings.json")).uid).toBe(uid);
      expect(statSync(join(agentDir, ".mcp.json")).uid).toBe(uid);
    },
  );
});

describe("alignAgentTreeOwnershipIfRoot", () => {
  afterEach(() => {
    ownershipRuntime.geteuid = realGeteuid;
    ownershipRuntime.chownTree = realChownTree;
  });

  it("no-ops (null) for a missing agent dir even as root", () => {
    ownershipRuntime.geteuid = () => 0;
    const calls: string[] = [];
    ownershipRuntime.chownTree = (_u, _g, d) => {
      calls.push(d);
    };
    expect(alignAgentTreeOwnershipIfRoot("ghost", "/nonexistent/agent-dir")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns the allocated uid after a successful sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-align-tree-"));
    try {
      ownershipRuntime.geteuid = () => 0;
      ownershipRuntime.chownTree = () => {};
      expect(alignAgentTreeOwnershipIfRoot(AGENT, dir)).toBe(allocateAgentUid(AGENT));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findAgentUnreadablePaths", () => {
  let dir: string;
  const foreignUid = allocateAgentUid(AGENT); // never the test process uid

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-unreadable-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags an owner-only file not owned by the agent uid (the incident combination)", () => {
    const f = join(dir, "settings.json");
    writeFileSync(f, "{}", { mode: 0o600 });
    chmodSync(f, 0o600); // umask-proof
    expect(findAgentUnreadablePaths([f], foreignUid)).toEqual([f]);
  });

  it("accepts a world-readable file regardless of owner", () => {
    const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "x", { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(findAgentUnreadablePaths([f], foreignUid)).toEqual([]);
  });

  it("accepts a file owned by the agent uid even at 0600", () => {
    const f = join(dir, "owned.json");
    writeFileSync(f, "{}", { mode: 0o600 });
    chmodSync(f, 0o600);
    const myUid = process.getuid?.() ?? 0;
    expect(findAgentUnreadablePaths([f], myUid)).toEqual([]);
  });

  it("flags a 0700 directory not owned by the agent uid, accepts 0755", () => {
    const locked = join(dir, "locked");
    const open = join(dir, "open");
    mkdirSync(locked, { mode: 0o700 });
    chmodSync(locked, 0o700);
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(findAgentUnreadablePaths([locked, open], foreignUid)).toEqual([locked]);
  });

  it("skips symlinks and missing paths", () => {
    const link = join(dir, "skill-link");
    symlinkSync("/nonexistent/pool/skill", link);
    expect(
      findAgentUnreadablePaths([link, join(dir, "never-written.json")], foreignUid),
    ).toEqual([]);
  });
});

describe("allocateAgentUid extraction (agent-uid.ts)", () => {
  it("compose.js re-export is the same function with the same derivation", () => {
    expect(allocateAgentUidViaCompose).toBe(allocateAgentUid);
    expect(allocateAgentUid(AGENT)).toBeGreaterThanOrEqual(10001);
    expect(allocateAgentUid(AGENT)).toBeLessThanOrEqual(10999);
    expect(allocateAgentUid(AGENT)).toBe(allocateAgentUid(AGENT));
  });
});
