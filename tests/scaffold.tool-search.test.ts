/**
 * Tool-search wiring (context-token optimization, 2026-06-06).
 *
 * Enabling Claude Code's ENABLE_TOOL_SEARCH defers (lazy-loads) MCP tool
 * schemas so the ~31k-token integration-server surface stops occupying the
 * window every turn. Two halves must stay wired:
 *   1. the ENABLE_TOOL_SEARCH env var (default `auto`, kill-switchable);
 *   2. `alwaysLoad: true` pinned on the LOAD-BEARING framework servers
 *      (switchroom-telegram, hindsight, agent-config) so reply /
 *      get_recent_messages / recall never defer (the orphaned-reply hazard).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildToolSearchEnvVars } from "../src/agents/scaffold.js";

const scaffoldSrc = readFileSync(resolve(__dirname, "..", "src", "agents", "scaffold.ts"), "utf-8");

const SAVED = {
  disable: process.env.SWITCHROOM_DISABLE_TOOL_SEARCH,
  mode: process.env.SWITCHROOM_TOOL_SEARCH_MODE,
};
afterEach(() => {
  if (SAVED.disable === undefined) delete process.env.SWITCHROOM_DISABLE_TOOL_SEARCH;
  else process.env.SWITCHROOM_DISABLE_TOOL_SEARCH = SAVED.disable;
  if (SAVED.mode === undefined) delete process.env.SWITCHROOM_TOOL_SEARCH_MODE;
  else process.env.SWITCHROOM_TOOL_SEARCH_MODE = SAVED.mode;
});

describe("buildToolSearchEnvVars — default, override, kill switch", () => {
  it("defaults to ENABLE_TOOL_SEARCH=auto (self-gating, transparent on small tool sets)", () => {
    delete process.env.SWITCHROOM_DISABLE_TOOL_SEARCH;
    delete process.env.SWITCHROOM_TOOL_SEARCH_MODE;
    expect(buildToolSearchEnvVars()).toEqual({ ENABLE_TOOL_SEARCH: "auto" });
  });

  it("SWITCHROOM_TOOL_SEARCH_MODE overrides the value (true / auto:N)", () => {
    delete process.env.SWITCHROOM_DISABLE_TOOL_SEARCH;
    process.env.SWITCHROOM_TOOL_SEARCH_MODE = "true";
    expect(buildToolSearchEnvVars()).toEqual({ ENABLE_TOOL_SEARCH: "true" });
    process.env.SWITCHROOM_TOOL_SEARCH_MODE = "auto:20";
    expect(buildToolSearchEnvVars()).toEqual({ ENABLE_TOOL_SEARCH: "auto:20" });
  });

  it("KILL SWITCH: SWITCHROOM_DISABLE_TOOL_SEARCH=1 omits the var entirely (legacy: all tools loaded)", () => {
    process.env.SWITCHROOM_DISABLE_TOOL_SEARCH = "1";
    expect(buildToolSearchEnvVars()).toEqual({});
  });
});

describe("tool-search wiring (source guards)", () => {
  it("the env helper is spread into BOTH env-builder sites BEFORE agentConfig.env (so per-agent config wins)", () => {
    // Two userEnvQuoted sites (buildScaffold + reconcile) must stay in lockstep.
    const occurrences = scaffoldSrc.match(/\.\.\.buildToolSearchEnvVars\(\),/g) ?? [];
    expect(occurrences.length).toBe(2);
    // Both must precede the agentConfig.env spread.
    for (const block of scaffoldSrc.split("...buildToolSearchEnvVars(),").slice(1)) {
      const head = block.slice(0, 200);
      expect(head).toMatch(/\.\.\.\(agentConfig\.env \?\? \{\}\)/);
    }
  });

  it("the LOAD-BEARING framework servers carry alwaysLoad:true", () => {
    // Each server-entry literal closes its env block first, so look in a
    // window large enough to span past it to the entry's own alwaysLoad.
    const telegram = scaffoldSrc.split('"switchroom-telegram": {')[1]?.slice(0, 600) ?? "";
    expect(telegram).toMatch(/alwaysLoad: true/);
    const agentConfig = scaffoldSrc.split('"agent-config": {')[1]?.slice(0, 500) ?? "";
    expect(agentConfig).toMatch(/alwaysLoad: true/);
    // hindsight pinned in scaffold-integration.ts.
    const integ = readFileSync(resolve(__dirname, "..", "src", "memory", "scaffold-integration.ts"), "utf-8");
    expect(integ).toMatch(/key: "hindsight", value: \{ \.\.\.mcpConfig, alwaysLoad: true \}/);
  });

  it("McpServerConfig carries the optional alwaysLoad field", () => {
    const typeSrc = readFileSync(resolve(__dirname, "..", "src", "memory", "hindsight.ts"), "utf-8");
    expect(typeSrc).toMatch(/alwaysLoad\?: boolean/);
  });
});
