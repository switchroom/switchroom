import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scaffoldAgent,
  reconcileAgent,
  DOCKER_AGENT_HOME,
} from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

/**
 * switchroom#1892 regression guard. The `.mcp.json` file is bind-mounted
 * into the agent container and consumed by the in-container Claude. Its
 * `TELEGRAM_STATE_DIR` value MUST therefore be the in-container path,
 * regardless of where the writer (host CLI or in-container CLI) is running.
 *
 * Pre-fix, both writers derived it from `agentDir` (HOME-dependent), so
 * host `switchroom apply` wrote `/home/<user>/...` and in-container
 * reconcile wrote `/state/agent/home/...` for the same logical agent.
 * Each invocation flipped the file; every `schedule_add` triggered a
 * broker reconcile that detected drift on its own write and failed with
 * `E_RECONCILE_FAILED`.
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

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  } as unknown as SwitchroomConfig;
}

describe("scaffold/reconcile .mcp.json TELEGRAM_STATE_DIR is environment-independent (#1892)", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "switchroom-tg-state-dir-"));
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it("scaffoldAgent writes the in-container TELEGRAM_STATE_DIR even when agentDir is a host-side path", () => {
    const name = "test-agent";
    const agentConfig = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, agentConfig);

    const res = scaffoldAgent(name, agentConfig, agentsDir, telegramConfig, switchroomConfig);
    const mcp = JSON.parse(readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"));
    const tsd = mcp.mcpServers["switchroom-telegram"].env.TELEGRAM_STATE_DIR;

    expect(tsd).toBe(`${DOCKER_AGENT_HOME}/.switchroom/agents/${name}/telegram`);
    // Belt-and-braces: the host tmpdir path must NOT leak into the value.
    expect(tsd.startsWith(agentsDir)).toBe(false);
  });

  it("reconcileAgent writes the in-container TELEGRAM_STATE_DIR even when agentDir is a host-side path", () => {
    const name = "test-agent-2";
    const agentConfig = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, agentConfig);

    scaffoldAgent(name, agentConfig, agentsDir, telegramConfig, switchroomConfig);
    reconcileAgent(name, agentConfig, agentsDir, telegramConfig, switchroomConfig);

    const mcp = JSON.parse(readFileSync(join(agentsDir, name, ".mcp.json"), "utf-8"));
    const tsd = mcp.mcpServers["switchroom-telegram"].env.TELEGRAM_STATE_DIR;

    expect(tsd).toBe(`${DOCKER_AGENT_HOME}/.switchroom/agents/${name}/telegram`);
    expect(tsd.startsWith(agentsDir)).toBe(false);
  });
});
