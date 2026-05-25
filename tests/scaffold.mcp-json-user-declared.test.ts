import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

/**
 * Regression test for the user-declared mcp_servers → .mcp.json gap
 * (audit 2026-05-25).
 *
 * Pre-fix the .mcp.json writers in scaffold.ts (both scaffoldAgent and
 * reconcileAgent) were template-driven and emitted only the hardcoded
 * framework set (switchroom-telegram, agent-config, hostd-if-admin,
 * hindsight, gdrive). User-declared `mcp_servers` in switchroom.yaml
 * — either at `defaults.mcp_servers` or per-agent
 * `agents.<name>.mcp_servers` — were silently dropped from .mcp.json
 * even though they landed in settings.json (which Claude Code doesn't
 * load under the `--dangerously-load-development-channels` flag the
 * agent actually uses).
 *
 * Net effect from PR #875 (v0.7.6 docker cutover) until the fix: every
 * operator-declared MCP server on the fleet — perplexity (declared
 * under defaults.mcp_servers) and carrie's notion (declared under her
 * per-agent block) — was effectively dead. `claude mcp list` from
 * inside any agent container returned only the framework set.
 *
 * This test pins both writers so the regression cannot recur.
 */

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("scaffold/reconcile: user-declared mcp_servers reach .mcp.json", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "switchroom-mcp-user-"));
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it("emits a user-declared command-based MCP into .mcp.json (scaffoldAgent)", () => {
    const name = "test-agent";
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        perplexity: {
          command: "/home/test/launchers/perplexity-mcp.sh",
        },
      },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );

    const mcpJson = JSON.parse(readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers).toHaveProperty("perplexity");
    expect(mcpJson.mcpServers.perplexity).toEqual({
      command: "/home/test/launchers/perplexity-mcp.sh",
    });
    // Framework MCPs preserved.
    expect(mcpJson.mcpServers).toHaveProperty("switchroom-telegram");
    expect(mcpJson.mcpServers).toHaveProperty("agent-config");
  });

  it("emits a user-declared HTTP MCP (e.g. notion) into .mcp.json (scaffoldAgent)", () => {
    const name = "carrie-like";
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        notion: {
          type: "http",
          url: "https://mcp.notion.com/mcp",
        },
      },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );

    const mcpJson = JSON.parse(readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
  });

  it("honours the `false` opt-out sentinel (scaffoldAgent)", () => {
    // A user-declared `gdrive: false` must NOT clobber the framework
    // gdrive entry into the map as `false` — filterMcpServers strips
    // `false` values before the spread. (The gdrive-specific opt-out
    // pathway is exercised by separate tests; this assertion just
    // confirms `false` doesn't leak into the rendered output.)
    const name = "optout-agent";
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        gdrive: false as any,
        my_real: { command: "/bin/true" },
      },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );

    const mcpJson = JSON.parse(readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"));
    // The legit user-declared entry lands.
    expect(mcpJson.mcpServers).toHaveProperty("my_real");
    // The `false` sentinel is NOT a stored entry.
    expect(mcpJson.mcpServers.gdrive).not.toBe(false);
  });

  it("user-declared key collides with framework — user wins (matches settings.json semantics)", () => {
    // Operator deliberately overrides a framework MCP (e.g. swapping
    // hindsight's URL). settings.json adds framework entries only when
    // `!settings.mcpServers[entry.key]` — user wins there too. .mcp.json
    // must match that precedence so the two views can't disagree on
    // which definition is live.
    const name = "override-agent";
    const customHindsight = {
      type: "http",
      url: "http://127.0.0.1:99999/custom-hindsight/",
    };
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hindsight: customHindsight as any,
      },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );

    const mcpJson = JSON.parse(readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers.hindsight).toEqual(customHindsight);
  });

  it("reconcileAgent emits the same user-declared MCPs as scaffoldAgent", () => {
    // Mirrors the parity test (scaffold.mcp-json-builder-parity.test.ts)
    // but with user-declared mcp_servers to guard against one builder
    // picking up the spread but the other forgetting it.
    const name = "reconcile-parity";
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        custom_one: { command: "/bin/echo", args: ["one"] },
        custom_two: { type: "http", url: "https://example.test/mcp" },
      },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );
    const mcpPath = join(res.agentDir, ".mcp.json");
    const afterScaffold = readFileSync(mcpPath, "utf-8");

    // Sanity: both user-declared entries landed.
    const scaffoldParsed = JSON.parse(afterScaffold);
    expect(scaffoldParsed.mcpServers).toHaveProperty("custom_one");
    expect(scaffoldParsed.mcpServers).toHaveProperty("custom_two");

    reconcileAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );
    const afterReconcile = readFileSync(mcpPath, "utf-8");

    expect(afterReconcile).toBe(afterScaffold);
  });
});
