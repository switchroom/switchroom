/**
 * L4 refinements: trimmed cron .mcp.json + compose mem/pids bump.
 * Both are config-derived and no-op for the current fleet (no cron-session
 * agents) — these tests pin the behaviour when an agent DOES run one.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { maybeWriteCronMcp } from "../src/agents/scaffold.js";
import { parseMemToMib, resolveResourceDefaults } from "../src/agents/compose.js";

const tg = { command: "bun", args: ["run", "start"], env: { TELEGRAM_STATE_DIR: "/state/agents/clerk/telegram" }, alwaysLoad: true } as never;
const hindsight = { command: "x", env: { HINDSIGHT_BANK_ID: "clerk" }, alwaysLoad: true } as never;
const full = {
  "switchroom-telegram": tg,
  hindsight,
  perplexity: { command: "y" } as never,
  "agent-config": { command: "z" } as never,
};

describe("maybeWriteCronMcp (Tier-1 un-starve, #2307)", () => {
  it("writes the FULL MCP set when cron session enabled (shared memory + tools)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    const path = maybeWriteCronMcp(dir, full, true);
    expect(path).toBe(join(dir, ".claude-cron", ".mcp.json"));
    const parsed = JSON.parse(readFileSync(path!, "utf-8"));
    // the heavy schema servers are PRESENT now (deferred via tool-search), not trimmed
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(
      ["agent-config", "hindsight", "perplexity", "switchroom-telegram"],
    );
    // hindsight shares the BASE agent's bank (no <name>-cron fragmentation)
    expect(parsed.mcpServers.hindsight.env.HINDSIGHT_BANK_ID).toBe("clerk");
    expect(parsed.mcpServers.hindsight.alwaysLoad).toBe(true);
  });

  it("isolates the cron bridge's liveness file (RISK #2) while sharing STATE_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    const parsed = JSON.parse(readFileSync(maybeWriteCronMcp(dir, full, true)!, "utf-8"));
    const cronTg = parsed.mcpServers["switchroom-telegram"];
    // distinct liveness path so a live <name>-cron bridge can't mask main
    expect(cronTg.env.SWITCHROOM_BRIDGE_ALIVE_PATH).toBe("/state/agents/clerk/telegram/.bridge-alive-cron");
    // STATE_DIR (access.json / history / gateway.sock) stays SHARED
    expect(cronTg.env.TELEGRAM_STATE_DIR).toBe("/state/agents/clerk/telegram");
    expect(cronTg.alwaysLoad).toBe(true);
  });

  it("does NOT mutate the caller's mcpServers map (the main .mcp.json source)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    maybeWriteCronMcp(dir, full, true);
    expect((full["switchroom-telegram"] as { env: Record<string, string> }).env.SWITCHROOM_BRIDGE_ALIVE_PATH).toBeUndefined();
  });

  it("seeds .claude-cron/.claude.json trust state (PR2 boot-wedge) with the full key set", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    maybeWriteCronMcp(dir, full, true);
    const seed = JSON.parse(readFileSync(join(dir, ".claude-cron", ".claude.json"), "utf-8"));
    expect(seed.hasCompletedOnboarding).toBe(true);
    const project = seed.projects[resolve(dir)];
    expect(project.hasTrustDialogAccepted).toBe(true);
    expect((project.enabledMcpjsonServers as string[]).sort()).toEqual(
      ["agent-config", "hindsight", "perplexity", "switchroom-telegram"],
    );
  });

  it("no-op when cron session disabled (the whole fleet today)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    expect(maybeWriteCronMcp(dir, full, false)).toBeNull();
  });

  it("no-op when the agent has no switchroom-telegram bridge", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    expect(maybeWriteCronMcp(dir, { hindsight: { command: "x" } as never }, true)).toBeNull();
  });
});

describe("parseMemToMib", () => {
  it.each([
    ["1.5g", 1536],
    ["6g", 6144],
    ["256m", 256],
    ["512", 512],
    ["2G", 2048],
  ])("%s → %s MiB", (s, mib) => {
    expect(parseMemToMib(s)).toBe(mib);
  });
  it("unparseable → null", () => {
    expect(parseMemToMib("lots")).toBeNull();
  });
});

describe("resolveResourceDefaults — cron-session bump", () => {
  it("no bump without cronSession (fleet default — byte-identical)", () => {
    const r = resolveResourceDefaults("clerk", "default");
    expect(r.memLimit).toBe("3g");
    expect(r.pidsLimit).toBe(500);
  });

  it("bumps mem +512M and pids +128 for a cron-session agent on defaults", () => {
    const r = resolveResourceDefaults("clerk", "default", undefined, { cronSession: true });
    expect(r.memLimit).toBe("3584m"); // 3072 + 512
    expect(r.pidsLimit).toBe(628); // 500 + 128
  });

  it("does NOT override an explicit operator memory/pids sizing", () => {
    const r = resolveResourceDefaults("clerk", "default", { memory: "3g", pids_limit: 700 }, { cronSession: true });
    expect(r.memLimit).toBe("3g"); // operator value wins, no bump
    expect(r.pidsLimit).toBe(700);
  });

  it("bumps a partial override (mem pinned, pids defaulted)", () => {
    const r = resolveResourceDefaults("clerk", "default", { memory: "3g" }, { cronSession: true });
    expect(r.memLimit).toBe("3g"); // pinned → untouched
    expect(r.pidsLimit).toBe(628); // defaulted → bumped
  });
});
