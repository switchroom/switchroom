/**
 * #2307 Tier-1 — seedCronConfigDir: the cron session's CLAUDE_CONFIG_DIR
 * (.claude-cron) needs the same onboarding + trust seed as the main .claude
 * dir, or the cron `claude` wedges on the first-run wizard / trust gate and the
 * <agent>-cron bridge never registers. These pin that the seed lands in
 * .claude-cron (NOT .claude), with hasCompletedOnboarding + the trusted project
 * + the FULL cron server key set, and that the main .claude dir is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  seedCronConfigDir,
  createMinimalClaudeConfig,
  preTrustWorkspace,
  ensureMcpServersTrusted,
} from "./onboarding.js";

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "switchroom-cron-seed-"));
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function readCron(): {
  hasCompletedOnboarding?: boolean;
  numStartups?: number;
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; enabledMcpjsonServers?: string[] }>;
} {
  return JSON.parse(readFileSync(join(agentDir, ".claude-cron", ".claude.json"), "utf-8"));
}

describe("seedCronConfigDir (#2307 Tier-1)", () => {
  const keys = ["switchroom-telegram", "hindsight", "agent-config", "perplexity"];

  it("writes .claude-cron/.claude.json with onboarding + trusted project + full server set", () => {
    seedCronConfigDir(agentDir, keys);
    const cron = readCron();
    expect(cron.hasCompletedOnboarding).toBe(true);
    const project = cron.projects![resolve(agentDir)];
    expect(project.hasTrustDialogAccepted).toBe(true);
    expect((project.enabledMcpjsonServers ?? []).sort()).toEqual([...keys].sort());
  });

  it("does NOT touch the main .claude dir", () => {
    seedCronConfigDir(agentDir, keys);
    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(false);
  });

  it("is idempotent — re-seeding unions new server keys, preserves onboarding", () => {
    seedCronConfigDir(agentDir, ["switchroom-telegram"]);
    seedCronConfigDir(agentDir, ["switchroom-telegram", "notion"]);
    const cron = readCron();
    expect(cron.hasCompletedOnboarding).toBe(true);
    expect((cron.projects![resolve(agentDir)].enabledMcpjsonServers ?? []).sort()).toEqual([
      "notion",
      "switchroom-telegram",
    ]);
  });
});

describe("onboarding helpers — configDirName param threads to .claude-cron", () => {
  it("createMinimalClaudeConfig honours configDirName", () => {
    createMinimalClaudeConfig(agentDir, ".claude-cron");
    expect(existsSync(join(agentDir, ".claude-cron", ".claude.json"))).toBe(true);
    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(false);
  });

  it("preTrustWorkspace + ensureMcpServersTrusted target the cron dir, keying off resolve(agentDir)", () => {
    createMinimalClaudeConfig(agentDir, ".claude-cron");
    preTrustWorkspace(agentDir, ".claude-cron");
    ensureMcpServersTrusted(agentDir, ["hindsight"], ".claude-cron");
    const cron = JSON.parse(readFileSync(join(agentDir, ".claude-cron", ".claude.json"), "utf-8"));
    // project key is the WORKSPACE dir (claude's cwd), not the config dir
    expect(cron.projects[resolve(agentDir)].enabledMcpjsonServers).toEqual(["hindsight"]);
  });

  it("default configDirName stays .claude (main session, unchanged)", () => {
    createMinimalClaudeConfig(agentDir);
    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(true);
  });
});
