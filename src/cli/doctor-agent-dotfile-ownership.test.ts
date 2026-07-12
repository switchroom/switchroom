/**
 * Tests for the agent dotfile-ownership doctor probe (#3157 direction 2).
 *
 * The 2026-07-12 incident: rollout reconcile left non-root agents'
 * `.claude/settings.json` as `root:root 0600`, so the agent (running as its
 * deterministic 10001+ uid) could not read its own permission allowlist and
 * stormed the operator with approval cards. This probe is the operator-facing
 * pre-flight for an ALREADY-poisoned tree; the tests below pin the outcomes
 * that matter:
 *
 *   - a root:root 0600 settings.json under a NON-root agent → `fail`
 *     (this is the bug; the check exists to surface it)
 *   - the SAME root-owned file under a `root:` agent (runs as uid 0) → `ok`
 *     (benign — the klanker caveat from the issue)
 *   - correctly agent-owned files → `ok`
 *   - other-readable (0644) files → `ok` even when not agent-owned
 *
 * All ownership is simulated via an injected stat table so no real chown
 * (which needs CAP_CHOWN) is required in CI.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runAgentDotfileOwnershipChecks,
  agentDotfileCandidates,
} from "./doctor-agent-dotfile-ownership.js";
import { allocateAgentUid } from "../agents/agent-uid.js";
import type { UnreadableScanFs } from "../agents/agent-owned-tree.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/tmp/agents";

interface FakeStat {
  uid: number;
  mode: number;
  dir?: boolean;
  symlink?: boolean;
}

/** Build an injected stat seam from a { path -> FakeStat } table. A path
 *  absent from the table throws ENOENT (i.e. the file does not exist). */
function fakeScanFs(table: Record<string, FakeStat>): UnreadableScanFs {
  const get = (p: string): FakeStat => {
    const s = table[p];
    if (s === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return s;
  };
  return {
    lstatSync: (p: string) => {
      const s = get(p);
      return { isSymbolicLink: () => s.symlink === true };
    },
    statSync: (p: string) => {
      const s = get(p);
      return { uid: s.uid, mode: s.mode, isDirectory: () => s.dir === true };
    },
  };
}

function cfg(agents: Record<string, { root?: boolean }>): SwitchroomConfig {
  return { agents } as unknown as SwitchroomConfig;
}

const NON_ROOT_AGENT = "clerk";
const ROOT_AGENT = "klanker";

describe("runAgentDotfileOwnershipChecks", () => {
  it("returns no results when there are no agents", () => {
    const r = runAgentDotfileOwnershipChecks(cfg({}), { agentsDir: AGENTS_DIR });
    expect(r).toEqual([]);
  });

  it("FAILS a non-root agent whose settings.json is root:root 0600 (the incident)", () => {
    const agentDir = join(AGENTS_DIR, NON_ROOT_AGENT);
    const settings = join(agentDir, ".claude", "settings.json");
    const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }), {
      agentsDir: AGENTS_DIR,
      existsSync: (p) => p === agentDir,
      // root:root 0600 — owner root (uid 0), no other-read bit.
      scanFs: fakeScanFs({ [settings]: { uid: 0, mode: 0o600 } }),
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe("fail");
    expect(r[0]!.detail).toContain(settings);
    // Remediation targets the agent's REAL uid, not root.
    const uid = allocateAgentUid(NON_ROOT_AGENT);
    expect(r[0]!.fix).toContain(`${uid}:${uid}`);
  });

  it("PASSES the same root-owned file under a root: agent (runs as uid 0 — benign)", () => {
    const agentDir = join(AGENTS_DIR, ROOT_AGENT);
    const settings = join(agentDir, ".claude", "settings.json");
    const r = runAgentDotfileOwnershipChecks(cfg({ [ROOT_AGENT]: { root: true } }), {
      agentsDir: AGENTS_DIR,
      existsSync: (p) => p === agentDir,
      scanFs: fakeScanFs({ [settings]: { uid: 0, mode: 0o600 } }),
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe("ok");
    expect(r[0]!.detail).toContain("uid 0");
  });

  it("PASSES a non-root agent whose settings.json is correctly agent-owned 0600", () => {
    const agentDir = join(AGENTS_DIR, NON_ROOT_AGENT);
    const settings = join(agentDir, ".claude", "settings.json");
    const uid = allocateAgentUid(NON_ROOT_AGENT);
    const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }), {
      agentsDir: AGENTS_DIR,
      existsSync: (p) => p === agentDir,
      scanFs: fakeScanFs({ [settings]: { uid, mode: 0o600 } }),
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe("ok");
    expect(r[0]!.detail).toContain(`uid ${uid}`);
  });

  it("PASSES a root-owned but other-readable (0644) file — the agent can still read it", () => {
    const agentDir = join(AGENTS_DIR, NON_ROOT_AGENT);
    const settings = join(agentDir, ".claude", "settings.json");
    const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }), {
      agentsDir: AGENTS_DIR,
      existsSync: (p) => p === agentDir,
      scanFs: fakeScanFs({ [settings]: { uid: 0, mode: 0o644 } }),
    });
    expect(r[0]!.status).toBe("ok");
  });

  it("skips (no result) an agent that is not scaffolded yet", () => {
    const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }), {
      agentsDir: AGENTS_DIR,
      existsSync: () => false,
      scanFs: fakeScanFs({}),
    });
    expect(r).toEqual([]);
  });

  it("flags a poisoned .mcp.json even when settings.json is fine", () => {
    const agentDir = join(AGENTS_DIR, NON_ROOT_AGENT);
    const uid = allocateAgentUid(NON_ROOT_AGENT);
    const settings = join(agentDir, ".claude", "settings.json");
    const mcp = join(agentDir, ".mcp.json");
    const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }), {
      agentsDir: AGENTS_DIR,
      existsSync: (p) => p === agentDir,
      scanFs: fakeScanFs({
        [settings]: { uid, mode: 0o600 }, // fine
        [mcp]: { uid: 0, mode: 0o600 }, // root-owned
      }),
    });
    expect(r[0]!.status).toBe("fail");
    expect(r[0]!.detail).toContain(mcp);
  });

  it("warns when the agents directory cannot be resolved", () => {
    // No agentsDir passed and no switchroom block → resolveAgentsDir throws
    // (config.switchroom is undefined). Guard against a container-set
    // SWITCHROOM_AGENTS_DIR override, which would otherwise resolve a path.
    const prev = process.env.SWITCHROOM_AGENTS_DIR;
    delete process.env.SWITCHROOM_AGENTS_DIR;
    try {
      const r = runAgentDotfileOwnershipChecks(cfg({ [NON_ROOT_AGENT]: {} }));
      expect(r).toHaveLength(1);
      expect(r[0]!.status).toBe("warn");
    } finally {
      if (prev !== undefined) process.env.SWITCHROOM_AGENTS_DIR = prev;
    }
  });

  it("agentDotfileCandidates covers settings.json, .claude.json and both .mcp.json", () => {
    const c = agentDotfileCandidates("/x");
    expect(c).toContain("/x/.claude/settings.json");
    expect(c.some((p) => p.endsWith(".claude.json"))).toBe(true);
    expect(c).toContain("/x/.mcp.json");
    expect(c).toContain("/x/.claude-cron/.mcp.json");
  });
});
