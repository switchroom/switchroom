/**
 * Unit tests for src/agents/reconcile-default-mcps.ts
 *
 * Covers:
 *   (a) adds a missing built-in default to settings.json
 *   (b) leaves an existing entry alone (user may have customised it)
 *   (c) honours per-agent opt-out (mcp_servers: { key: false })
 *   (d) idempotent — running twice produces zero changes on the second run
 *   (e) handles agents with no settings.json (non-standard layout)
 *   (f) reconcileAllAgentDefaultMcps iterates over agent directories correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinMcpEntry } from "../memory/scaffold-integration.js";

// Mock node:fs so the M5 atomicity block can force renameSync(2) to fail
// (simulating a crash between the tmp write and the atomic swap) while every
// other fs call keeps its real implementation. atomicWriteFileSync (which
// reconcile-default-mcps.ts now routes through) imports renameSync from
// node:fs, so this mock reaches it. Mirrors src/util/atomic.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import {
  reconcileAgentDefaultMcps,
  reconcileAllAgentDefaultMcps,
} from "./reconcile-default-mcps.js";

// Minimal fixture defaults — tests don't need real npx commands
const FIXTURE_DEFAULTS: BuiltinMcpEntry[] = [
  {
    key: "playwright",
    value: { command: "npx", args: ["-y", "@playwright/mcp@0.0.71", "--snapshot"] },
    optOutKey: "playwright",
  },
];

function makeAgentDir(
  tmpRoot: string,
  name: string,
  settings?: Record<string, unknown>,
): string {
  const agentDir = join(tmpRoot, name);
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  if (settings !== undefined) {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }
  return agentDir;
}

function readSettings(agentDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("reconcileAgentDefaultMcps", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-reconcile-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("(a) adds a missing built-in default to settings.json", () => {
    const agentDir = makeAgentDir(tmpRoot, "alpha", {
      mcpServers: {
        switchroom: { command: "bun", args: ["run", "server.ts"] },
      },
    });

    const result = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);

    expect(result.added).toEqual(["playwright"]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.optedOut).toEqual([]);
    expect(result.changed).toBe(true);

    const written = readSettings(agentDir);
    const servers = written.mcpServers as Record<string, unknown>;
    expect(servers["playwright"]).toEqual(FIXTURE_DEFAULTS[0]!.value);
    // Existing entry untouched
    expect(servers["switchroom"]).toEqual({ command: "bun", args: ["run", "server.ts"] });
  });

  it("(b) leaves an existing entry alone (customised command/args)", () => {
    const customPlaywright = {
      command: "npx",
      args: ["-y", "@playwright/mcp@custom-fork", "--headed"],
    };
    const agentDir = makeAgentDir(tmpRoot, "beta", {
      mcpServers: {
        playwright: customPlaywright,
      },
    });
    const before = readSettings(agentDir);

    const result = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual(["playwright"]);
    expect(result.changed).toBe(false);

    // File should NOT have been rewritten
    const after = readSettings(agentDir);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // The customised entry is untouched
    const servers = after.mcpServers as Record<string, unknown>;
    expect(servers["playwright"]).toEqual(customPlaywright);
  });

  it("(c) honours per-agent opt-out (mcp_servers: { playwright: false })", () => {
    const agentDir = makeAgentDir(tmpRoot, "gamma", {
      mcpServers: {
        switchroom: { command: "bun", args: ["run", "server.ts"] },
      },
    });
    const before = readSettings(agentDir);

    const result = reconcileAgentDefaultMcps(
      agentDir,
      { playwright: false },
      FIXTURE_DEFAULTS,
    );

    expect(result.added).toEqual([]);
    expect(result.optedOut).toEqual(["playwright"]);
    expect(result.changed).toBe(false);

    // File must not be modified
    const after = readSettings(agentDir);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const servers = after.mcpServers as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(servers, "playwright")).toBe(false);
  });

  it("(d) idempotent — second run produces zero changes", () => {
    const agentDir = makeAgentDir(tmpRoot, "delta", {
      mcpServers: {
        switchroom: { command: "bun", args: ["run", "server.ts"] },
      },
    });

    // First run: should add playwright
    const first = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);
    expect(first.added).toEqual(["playwright"]);
    expect(first.changed).toBe(true);

    // Second run: nothing to add
    const second = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent).toEqual(["playwright"]);
    expect(second.changed).toBe(false);

    // Third run for paranoia
    const third = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);
    expect(third.changed).toBe(false);
  });

  it("(e) silently skips agents with no settings.json", () => {
    // Create a directory without .claude/settings.json
    const agentDir = join(tmpRoot, "epsilon");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });

    const result = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);

    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("adds default when mcpServers key is absent entirely", () => {
    const agentDir = makeAgentDir(tmpRoot, "zeta", {
      permissions: { allow: ["Bash"], deny: [] },
      // No mcpServers key at all
    });

    const result = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);

    expect(result.added).toEqual(["playwright"]);
    expect(result.changed).toBe(true);

    const written = readSettings(agentDir);
    const servers = written.mcpServers as Record<string, unknown>;
    expect(servers["playwright"]).toEqual(FIXTURE_DEFAULTS[0]!.value);
    // Other keys preserved
    expect((written.permissions as Record<string, unknown>)["allow"]).toEqual(["Bash"]);
  });
});

describe("reconcileAllAgentDefaultMcps", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-reconcile-all-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("(f) iterates over all agent directories and returns per-agent results", () => {
    const agentsDir = join(tmpRoot, "agents");
    mkdirSync(agentsDir);

    // Agent 1: needs playwright added
    makeAgentDir(agentsDir, "agent1", { mcpServers: { switchroom: {} } });

    // Agent 2: already has playwright
    makeAgentDir(agentsDir, "agent2", {
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@0.0.71"] } },
    });

    // Agent 3: opted out
    makeAgentDir(agentsDir, "agent3", { mcpServers: {} });

    const results = reconcileAllAgentDefaultMcps(
      agentsDir,
      { agent3: { playwright: false } },
      FIXTURE_DEFAULTS,
    );

    expect(results).toHaveLength(3);

    const r1 = results.find(r => r.name === "agent1")!;
    expect(r1.added).toEqual(["playwright"]);
    expect(r1.changed).toBe(true);

    const r2 = results.find(r => r.name === "agent2")!;
    expect(r2.added).toEqual([]);
    expect(r2.alreadyPresent).toEqual(["playwright"]);
    expect(r2.changed).toBe(false);

    const r3 = results.find(r => r.name === "agent3")!;
    expect(r3.optedOut).toEqual(["playwright"]);
    expect(r3.changed).toBe(false);
  });

  it("returns empty array when agentsDir does not exist", () => {
    const results = reconcileAllAgentDefaultMcps(
      join(tmpRoot, "nonexistent"),
      {},
      FIXTURE_DEFAULTS,
    );
    expect(results).toEqual([]);
  });

  it("skips non-directory entries in agentsDir", () => {
    const agentsDir = join(tmpRoot, "agents");
    mkdirSync(agentsDir);
    // A file in the agents dir (not an agent)
    writeFileSync(join(agentsDir, "README.md"), "# agents", "utf-8");
    // A real agent
    makeAgentDir(agentsDir, "realagent", { mcpServers: {} });

    const results = reconcileAllAgentDefaultMcps(agentsDir, {}, FIXTURE_DEFAULTS);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("realagent");
  });
});

describe("reconcileAgentDefaultMcps — atomic write (M5 crash-safety)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-reconcile-atomic-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // BITE: a crash / ENOSPC after the tmp write but before the atomic swap
  // must leave the ORIGINAL settings.json fully intact — never a torn or
  // truncated file (which the JSON.parse read at reconcile-default-mcps.ts:~76
  // would then fail on, silently wiping the agent's MCP servers). Pre-fix this
  // used a bare writeFileSync (truncate-in-place, no rename), so it never
  // touched renameSync: the mocked failure never fired, the write "succeeded",
  // and both assertions below fail.
  it("leaves the original settings.json intact when rename(2) fails mid-write", () => {
    const agentDir = makeAgentDir(tmpRoot, "atomic", {
      mcpServers: { switchroom: { command: "bun", args: ["run", "server.ts"] } },
    });
    const settingsPath = join(agentDir, ".claude", "settings.json");
    const originalRaw = readFileSync(settingsPath, "utf-8");

    // Simulate a hard failure (EIO — NOT one of the bind-mount fallback codes)
    // at the atomic swap. atomicWriteFileSync must clean its tmp and rethrow,
    // leaving the destination untouched.
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });

    expect(() =>
      reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS),
    ).toThrow(/EIO/);

    // The original file is byte-for-byte unchanged — the write was atomic.
    expect(readFileSync(settingsPath, "utf-8")).toBe(originalRaw);
    // No orphaned tempfile left in the .claude dir.
    const claudeDir = join(agentDir, ".claude");
    expect(fs.readdirSync(claudeDir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("round-trips: on success the new entry is present and valid JSON", () => {
    const agentDir = makeAgentDir(tmpRoot, "roundtrip", {
      mcpServers: { switchroom: {} },
    });
    const settingsPath = join(agentDir, ".claude", "settings.json");

    const result = reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);
    expect(result.changed).toBe(true);

    // renameSync (real impl) was used — the atomic path, not a truncate.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers["playwright"]).toEqual(FIXTURE_DEFAULTS[0]!.value);
    // Trailing newline + pretty format preserved (no format change).
    expect(readFileSync(settingsPath, "utf-8").endsWith("\n")).toBe(true);
  });

  it("preserves the settings.json mode across the atomic swap", () => {
    const agentDir = makeAgentDir(tmpRoot, "modekeep", { mcpServers: {} });
    const settingsPath = join(agentDir, ".claude", "settings.json");
    fs.chmodSync(settingsPath, 0o600);

    reconcileAgentDefaultMcps(agentDir, {}, FIXTURE_DEFAULTS);

    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
  });
});
