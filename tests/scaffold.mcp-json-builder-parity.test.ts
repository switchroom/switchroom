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
 * H2 drift guard (Drive reliability audit, 2026-05-16). `scaffoldAgent`
 * and `reconcileAgent` build the project `.mcp.json` `mcpServers` object
 * with two INDEPENDENT literal copies. The `gdrive` entry is single-
 * sourced via `resolveGdriveMcpEntry`, but the surrounding servers
 * (switchroom-telegram, agent-config, hostd) are hand-duplicated — a
 * future edit to one builder only would silently diverge scaffold-vs-
 * reconcile output, exactly the bug-4/bug-8 class (the .mcp.json Claude
 * actually loads no longer matching what scaffold intended).
 *
 * This pins byte-identical output for a representative Drive-enabled
 * config across both builders. If it ever fails, the two builders have
 * drifted and must be reconciled (ideally collapsed into one shared
 * `buildMcpServersObject()` — tracked follow-up).
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

describe("scaffoldAgent vs reconcileAgent: .mcp.json builder parity (H2)", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "switchroom-mcp-parity-"));
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it("emits a byte-identical .mcp.json from scaffold and from reconcile", () => {
    const name = "parity-agent";
    const account = "pixsoul@gmail.com";
    const agentConfig = makeAgentConfig({
      google_workspace: { account },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
      google_accounts: { [account]: { enabled_for: [name] } },
      google_workspace: { tier: "extended" },
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

    // Sanity: the representative config must actually exercise gdrive +
    // the hand-duplicated siblings, else the parity assertion is vacuous.
    const parsed = JSON.parse(afterScaffold);
    expect(Object.keys(parsed.mcpServers)).toContain("gdrive");
    expect(Object.keys(parsed.mcpServers)).toContain("switchroom-telegram");

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
