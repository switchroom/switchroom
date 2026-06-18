/**
 * Tool-search wiring (context-token optimization, 2026-06-06).
 *
 * Enabling Claude Code's ENABLE_TOOL_SEARCH defers (lazy-loads) MCP tool
 * schemas so the ~31k-token integration-server surface stops occupying the
 * window every turn. Two halves must stay wired:
 *   1. the ENABLE_TOOL_SEARCH env var (default `auto`, kill-switchable);
 *   2. The LOAD-BEARING tools never defer (the orphaned-reply hazard).
 *      - hindsight + agent-config: pinned server-wide via `alwaysLoad: true`.
 *      - switchroom-telegram (P4): NO LONGER pinned server-wide
 *        (`alwaysLoad: false`); the bridge pins only the hot tools (reply /
 *        stream_reply / get_recent_messages / react / …) per-tool via
 *        `_meta["anthropic/alwaysLoad"]`, so the ~14 cold tools defer.
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

  it("agent-config + hindsight stay pinned server-wide (alwaysLoad:true)", () => {
    const agentConfig = scaffoldSrc.split('"agent-config": {')[1]?.slice(0, 500) ?? "";
    expect(agentConfig).toMatch(/alwaysLoad: true/);
    // hindsight pinned in scaffold-integration.ts.
    const integ = readFileSync(resolve(__dirname, "..", "src", "memory", "scaffold-integration.ts"), "utf-8");
    expect(integ).toMatch(/key: "hindsight", value: \{ \.\.\.mcpConfig, alwaysLoad: true \}/);
  });

  it("switchroom-telegram is NO LONGER pinned server-wide (P4-B: alwaysLoad:false)", () => {
    // Both writer sites must agree (byte-for-byte invariant, #1892).
    const blocks = scaffoldSrc.split('"switchroom-telegram": {').slice(1);
    expect(blocks.length).toBe(2);
    for (const b of blocks) {
      // The FIRST alwaysLoad after the telegram marker is the telegram
      // entry's own (agent-config's comes later) — must be false now.
      const m = b.match(/alwaysLoad: (true|false)/);
      expect(m?.[1]).toBe("false");
    }
  });

  it("the bridge pins the hot tools per-tool via _meta anthropic/alwaysLoad", () => {
    // P4-B: deferral safety now lives in the bridge's tool-filter, not the
    // server flag. The reply path MUST be in the always-load set.
    const filterSrc = readFileSync(
      resolve(__dirname, "..", "telegram-plugin", "bridge", "tool-filter.ts"),
      "utf-8",
    );
    expect(filterSrc).toMatch(/ALWAYS_LOAD_TOOLS/);
    expect(filterSrc).toMatch(/anthropic\/alwaysLoad/);
    expect(filterSrc).toMatch(/'reply'/);
    expect(filterSrc).toMatch(/'stream_reply'/);
    // and the bridge actually applies it to the tools/list response.
    const bridgeSrc = readFileSync(
      resolve(__dirname, "..", "telegram-plugin", "bridge", "bridge.ts"),
      "utf-8",
    );
    expect(bridgeSrc).toMatch(/buildEffectiveToolSchemas\(TOOL_SCHEMAS/);
  });

  it("McpServerConfig carries the optional alwaysLoad field", () => {
    const typeSrc = readFileSync(resolve(__dirname, "..", "src", "memory", "hindsight.ts"), "utf-8");
    expect(typeSrc).toMatch(/alwaysLoad\?: boolean/);
  });
});
