import { describe, it, expect } from "vitest";
import { checkUserDeclaredMcps } from "../src/cli/doctor.js";
import type {
  AgentConfig,
  SwitchroomConfig,
} from "../src/config/schema.js";

/**
 * Regression-guard probe for the user-declared-mcp_servers gap
 * (#1786 follow-up). Tests the cross-reference between cascade-
 * resolved `mcp_servers` (the operator's contract in switchroom.yaml)
 * and the rendered `.mcp.json.mcpServers` keys (what Claude Code
 * actually loads). Pre-fix the writer silently dropped every user-
 * declared entry; this probe surfaces any recurrence loudly.
 */

const baseTelegram = {
  bot_token: "123:abc",
  forum_chat_id: "-100",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "T",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeConfig(
  agentName: string,
  agentConfig: AgentConfig,
  defaultsMcp?: Record<string, unknown>,
): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: baseTelegram,
    defaults: defaultsMcp ? { mcp_servers: defaultsMcp } : undefined,
    agents: { [agentName]: agentConfig },
  } as unknown as SwitchroomConfig;
}

describe("checkUserDeclaredMcps (#1786 follow-up)", () => {
  it("returns skip when no user-declared mcp_servers exist anywhere", () => {
    const agent = makeAgentConfig();
    const config = makeConfig("a", agent);
    // Rendered .mcp.json carries only the framework set.
    const rendered = {
      "switchroom-telegram": {},
      "agent-config": {},
      hindsight: {},
    };
    const r = checkUserDeclaredMcps("a", agent, config, rendered);
    expect(r.status).toBe("skip");
    expect(r.detail).toMatch(/no user-declared/);
  });

  it("returns ok when defaults.mcp_servers.perplexity is in rendered .mcp.json", () => {
    const agent = makeAgentConfig();
    const config = makeConfig("a", agent, {
      perplexity: { command: "/home/op/.switchroom/mcp-launchers/perplexity-mcp.sh" },
    });
    const rendered = {
      "switchroom-telegram": {},
      perplexity: { command: "/home/op/.switchroom/mcp-launchers/perplexity-mcp.sh" },
    };
    const r = checkUserDeclaredMcps("a", agent, config, rendered);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("perplexity");
  });

  it("returns warn when defaults.mcp_servers.perplexity is missing from rendered .mcp.json (the live fleet pre-#1786 case)", () => {
    const agent = makeAgentConfig();
    const config = makeConfig("a", agent, {
      perplexity: { command: "/home/op/.switchroom/mcp-launchers/perplexity-mcp.sh" },
    });
    // Rendered .mcp.json missing perplexity — the bug.
    const rendered = {
      "switchroom-telegram": {},
      "agent-config": {},
    };
    const r = checkUserDeclaredMcps("a", agent, config, rendered);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/1\/1 declared but missing.*perplexity/);
    expect(r.fix).toMatch(/switchroom agent reconcile/);
  });

  it("respects per-agent mcp_servers (carrie's notion shape)", () => {
    // No defaults, but carrie declares notion at the per-agent level.
    const agent = makeAgentConfig({
      mcp_servers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notion: { type: "http", url: "https://mcp.notion.com/mcp" } as any,
      },
    } as Partial<AgentConfig>);
    const config = makeConfig("carrie", agent);
    const renderedMissing = { "switchroom-telegram": {} };
    expect(checkUserDeclaredMcps("carrie", agent, config, renderedMissing).status).toBe(
      "warn",
    );
    const renderedPresent = {
      "switchroom-telegram": {},
      notion: { type: "http", url: "https://mcp.notion.com/mcp" },
    };
    expect(checkUserDeclaredMcps("carrie", agent, config, renderedPresent).status).toBe(
      "ok",
    );
  });

  it("merges defaults + per-agent, both must be present in rendered output", () => {
    const agent = makeAgentConfig({
      mcp_servers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notion: { type: "http", url: "https://mcp.notion.com/mcp" } as any,
      },
    } as Partial<AgentConfig>);
    const config = makeConfig("a", agent, {
      perplexity: { command: "/launchers/p.sh" },
    });
    // Rendered has perplexity but not notion.
    const rendered = {
      "switchroom-telegram": {},
      perplexity: { command: "/launchers/p.sh" },
    };
    const r = checkUserDeclaredMcps("a", agent, config, rendered);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/notion/);
    expect(r.detail).not.toMatch(/perplexity.*missing/);
  });

  it("filters `false` opt-out sentinels from the declared set (not flagged as missing)", () => {
    // `mcp_servers: { gdrive: false }` is an intentional suppression
    // of the framework gdrive entry — not a missing user-declared
    // entry. The probe must not warn on it.
    const agent = makeAgentConfig({
      mcp_servers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        gdrive: false as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notion: { type: "http", url: "https://mcp.notion.com/mcp" } as any,
      },
    } as Partial<AgentConfig>);
    const config = makeConfig("a", agent);
    const rendered = {
      "switchroom-telegram": {},
      notion: { type: "http", url: "https://mcp.notion.com/mcp" },
      // gdrive correctly absent because of the opt-out.
    };
    const r = checkUserDeclaredMcps("a", agent, config, rendered);
    expect(r.status).toBe("ok");
    // The "declared count" should be 1, not 2 (gdrive: false stripped).
    expect(r.detail).toContain("1 declared");
    expect(r.detail).not.toMatch(/gdrive/);
  });
});
