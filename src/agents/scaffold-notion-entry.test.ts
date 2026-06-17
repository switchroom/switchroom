/**
 * Scaffold-emission gate for the per-agent `notion` MCP entry —
 * RFC reference/rfcs/notion-integration.md PR 2.
 *
 * `resolveNotionMcpEntry` is the pure decision the scaffoldAgent /
 * reconcileAgent / mcpJson paths call. These cases pin the contract:
 *
 *   - an agent WITH a `notion_workspace:` block (even empty) AND a
 *     top-level `notion_workspace:` block → emits the launcher entry;
 *   - an agent WITHOUT a `notion_workspace:` block → does NOT emit;
 *   - top-level `notion_workspace:` missing → does NOT emit, even if
 *     the agent declared one;
 *   - hard opt-out `mcp_servers: { notion: false }` → does NOT emit.
 *
 * Mirrors scaffold-gdrive-entry.test.ts shape. The launcher-side
 * vault-broker ACL drift (config without broker ACL) is enforced at
 * runtime + checked by the doctor probe in PR 4.
 */

import { describe, expect, it } from "vitest";

import {
  DOCKER_SWITCHROOM_CLI_PATH,
  resolveNotionMcpEntry,
} from "./scaffold.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";

const TOP_LEVEL = {
  notion_workspace: {
    vault_key: "notion/integration-token",
    databases: {
      essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef",
    },
  },
};

function cfg(overrides: Record<string, unknown> = {}): SwitchroomConfig {
  return {
    ...TOP_LEVEL,
    agents: {},
    ...overrides,
  } as unknown as SwitchroomConfig;
}

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return partial as unknown as AgentConfig;
}

describe("resolveNotionMcpEntry — emits when configured", () => {
  it("emits when agent has notion_workspace: {} and top-level is set", () => {
    const config = cfg({
      agents: { clerk: { notion_workspace: {} } },
    });
    const entry = resolveNotionMcpEntry("clerk", agent({ notion_workspace: {} }), config);
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe("notion");
    expect(entry?.value.command).toBe(DOCKER_SWITCHROOM_CLI_PATH);
    expect(entry?.value.args?.[0]).toBe("notion-mcp-launcher");
  });

  it("emits when agent has notion_workspace.databases set", () => {
    const config = cfg({
      agents: { carrie: { notion_workspace: { databases: ["essays"] } } },
    });
    const entry = resolveNotionMcpEntry(
      "carrie",
      agent({ notion_workspace: { databases: ["essays"] } }),
      config,
    );
    expect(entry).not.toBeNull();
  });

  it("threads --vault-key and --mcp-version when set", () => {
    const config = cfg({
      notion_workspace: {
        vault_key: "custom/notion-key",
        mcp_version: "9.9.9",
        databases: { essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef" },
      },
      agents: { clerk: { notion_workspace: {} } },
    });
    const entry = resolveNotionMcpEntry("clerk", agent({ notion_workspace: {} }), config);
    expect(entry?.value.args).toContain("--vault-key");
    expect(entry?.value.args).toContain("custom/notion-key");
    expect(entry?.value.args).toContain("--mcp-version");
    expect(entry?.value.args).toContain("9.9.9");
  });

  it("threads HOME + vault-broker socket in the env block", () => {
    const config = cfg({
      agents: { clerk: { notion_workspace: {} } },
    });
    const entry = resolveNotionMcpEntry("clerk", agent({ notion_workspace: {} }), config);
    expect(entry?.value.env?.SWITCHROOM_AGENT_NAME).toBe("clerk");
    expect(entry?.value.env?.SWITCHROOM_CONTAINER).toBe("1");
    expect(entry?.value.env?.HOME).toBeTruthy();
    expect(entry?.value.env?.SWITCHROOM_VAULT_BROKER_SOCK).toBeTruthy();
  });
});

describe("resolveNotionMcpEntry — refuses when not configured", () => {
  it("returns null when agent has no notion_workspace block", () => {
    const config = cfg({ agents: { clerk: {} } });
    expect(resolveNotionMcpEntry("clerk", agent({}), config)).toBeNull();
  });

  it("returns null when top-level notion_workspace block is missing", () => {
    const config = cfg({
      notion_workspace: undefined,
      agents: { clerk: { notion_workspace: {} } },
    });
    expect(
      resolveNotionMcpEntry("clerk", agent({ notion_workspace: {} }), config),
    ).toBeNull();
  });

  it("returns null when switchroomConfig is undefined", () => {
    expect(
      resolveNotionMcpEntry("clerk", agent({ notion_workspace: {} }), undefined),
    ).toBeNull();
  });

  it("returns null for hard opt-out (mcp_servers.notion = false)", () => {
    const config = cfg({
      agents: {
        clerk: {
          notion_workspace: {},
          mcp_servers: { notion: false },
        },
      },
    });
    expect(
      resolveNotionMcpEntry(
        "clerk",
        agent({
          notion_workspace: {},
          mcp_servers: { notion: false } as unknown as Record<string, unknown>,
        }),
        config,
      ),
    ).toBeNull();
  });
});
