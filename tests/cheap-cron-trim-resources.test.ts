/**
 * L4 refinements: trimmed cron .mcp.json + compose mem/pids bump.
 * Both are config-derived and no-op for the current fleet (no cron-session
 * agents) — these tests pin the behaviour when an agent DOES run one.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeWriteTrimmedCronMcp } from "../src/agents/scaffold.js";
import { parseMemToMib, resolveResourceDefaults } from "../src/agents/compose.js";

const tg = { command: "bun", args: ["run", "start"], env: { TELEGRAM_STATE_DIR: "/state" }, alwaysLoad: true } as never;
const full = {
  "switchroom-telegram": tg,
  hindsight: { command: "x" } as never,
  perplexity: { command: "y" } as never,
  "agent-config": { command: "z" } as never,
};

describe("maybeWriteTrimmedCronMcp", () => {
  it("writes a switchroom-telegram-ONLY config when cron session enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    const path = maybeWriteTrimmedCronMcp(dir, full, true);
    expect(path).toBe(join(dir, ".claude-cron", ".mcp.json"));
    const parsed = JSON.parse(readFileSync(path!, "utf-8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["switchroom-telegram"]);
    // the heavy schema servers are gone (the ~31k-token saving)
    expect(parsed.mcpServers.hindsight).toBeUndefined();
    expect(parsed.mcpServers["agent-config"]).toBeUndefined();
    // the bridge entry is reused verbatim (identity comes from process env)
    expect(parsed.mcpServers["switchroom-telegram"]).toEqual(tg);
  });

  it("no-op when cron session disabled (the whole fleet today)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    expect(maybeWriteTrimmedCronMcp(dir, full, false)).toBeNull();
  });

  it("no-op when the agent has no switchroom-telegram bridge", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-mcp-"));
    expect(maybeWriteTrimmedCronMcp(dir, { hindsight: { command: "x" } as never }, true)).toBeNull();
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
    expect(r.memLimit).toBe("1.5g");
    expect(r.pidsLimit).toBe(500);
  });

  it("bumps mem +512M and pids +128 for a cron-session agent on defaults", () => {
    const r = resolveResourceDefaults("clerk", "default", undefined, { cronSession: true });
    expect(r.memLimit).toBe("2048m"); // 1536 + 512
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
