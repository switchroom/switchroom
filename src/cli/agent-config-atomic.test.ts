/**
 * Atomicity tests for the switchroom.yaml writers in src/cli/agent.ts.
 *
 * The 2026-07-11 durability review flagged the bare readFileSync → writeFileSync
 * (truncate-in-place) rewrites in `switchroom agent` subcommands: a crash /
 * ENOSPC mid-write truncates the fleet-wide config. The writes now route through
 * the bind-mount-aware writeConfigFileSync (tmp + fsync + rename). This pins the
 * atomic outcome for the exported YAML-mutation helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

// Mock node:fs so we can force renameSync(2) to fail while leaving every other
// fs call real. writeConfigFileSync → atomicWriteFileSync imports renameSync
// from node:fs, so the mock reaches it. Mirrors src/util/atomic.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { writeAgentEntryToConfig, updateAgentExtendsInConfig } from "./agent.js";

const SAMPLE = [
  "telegram:",
  "  bot_token: vault:telegram/bot_token",
  "agents:",
  "  alpha:",
  "    extends: default",
  "",
].join("\n");

describe("agent.ts switchroom.yaml writers — atomic write", () => {
  let dir: string;
  let cfg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-agent-cfg-"));
    cfg = join(dir, "switchroom.yaml");
    writeFileSync(cfg, SAMPLE, { mode: 0o644 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips: writeAgentEntryToConfig adds an agent and stays parseable", () => {
    writeAgentEntryToConfig(cfg, "bravo", "default");
    const doc = YAML.parse(readFileSync(cfg, "utf-8"));
    expect(doc.agents.bravo.extends).toBe("default");
    expect(doc.agents.alpha.extends).toBe("default");
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  // BITE: a hard failure at the atomic swap (EPERM) must rethrow and leave
  // switchroom.yaml intact. Pre-fix the bare writeFileSync never called
  // renameSync, so the mocked failure never fired — no throw, file rewritten.
  it("leaves switchroom.yaml intact when rename(2) fails writing a new agent", () => {
    const before = readFileSync(cfg, "utf-8");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });

    expect(() => writeAgentEntryToConfig(cfg, "bravo", "default")).toThrow(/EPERM/);

    expect(readFileSync(cfg, "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("leaves switchroom.yaml intact when rename(2) fails updating extends", () => {
    const before = readFileSync(cfg, "utf-8");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });

    expect(() => updateAgentExtendsInConfig(cfg, "alpha", "worker")).toThrow(/EPERM/);
    expect(readFileSync(cfg, "utf-8")).toBe(before);
  });

  it("preserves the file mode across the write", () => {
    fs.chmodSync(cfg, 0o600);
    writeAgentEntryToConfig(cfg, "charlie", "default");
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
  });
});
