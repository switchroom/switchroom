/**
 * Scaffold emission for multi-account Microsoft 365 bindings.
 *
 * `resolveMs365McpEntries` is the plural resolver both the scaffold and
 * reconcile mcpServers-assembly paths call. Pins:
 *   - 1 bound+enabled account → bare `ms-365` key (back-compat, no --account);
 *   - 2 bound+enabled accounts → two `ms-365-<slug>` keys with distinct
 *     --account and --enabled-tools;
 *   - a binding whose account lacks the agent in enabled_for[] → NOT emitted;
 *   - ms365OwnedKeys returns every retractable key for stale-key cleanup.
 * See reference/rfcs/microsoft-multi-account-per-agent.md §2.2, §3.3–3.4.
 */

import { describe, expect, it } from "vitest";

import {
  DOCKER_SWITCHROOM_CLI_PATH,
  resolveMs365McpEntries,
  resolveMs365McpEntry,
  ms365OwnedKeys,
} from "./scaffold.js";
import { microsoftAccountSlug } from "../config/microsoft-workspace-acl.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";

function cfg(
  microsoft_accounts: Record<string, { enabled_for?: string[] }>,
): SwitchroomConfig {
  return { microsoft_accounts } as unknown as SwitchroomConfig;
}

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return partial as unknown as AgentConfig;
}

const STORAGE = "alice@example.com";
const MAIL = "bob@example.com";

describe("resolveMs365McpEntries — single-account back-compat", () => {
  it("emits the bare `ms-365` key with NO --account for a single binding", () => {
    const entries = resolveMs365McpEntries(
      "marko",
      agent({ microsoft_workspace: { account: MAIL } }),
      cfg({ [MAIL]: { enabled_for: ["marko"] } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("ms-365");
    expect(entries[0].value.command).toBe(DOCKER_SWITCHROOM_CLI_PATH);
    expect(entries[0].value.args?.[0]).toBe("m365-mcp-launcher");
    expect(entries[0].value.args).not.toContain("--account");
    // singular shim agrees with the first plural entry
    expect(resolveMs365McpEntry("marko", agent({ microsoft_workspace: { account: MAIL } }), cfg({ [MAIL]: { enabled_for: ["marko"] } }))?.key).toBe("ms-365");
  });

  it("threads block-level tools → --enabled-tools even in the singular form", () => {
    const entries = resolveMs365McpEntries(
      "marko",
      agent({ microsoft_workspace: { account: MAIL, tools: ["list-mail-messages", "get-mail-message"] } }),
      cfg({ [MAIL]: { enabled_for: ["marko"] } }),
    );
    const args = entries[0].value.args ?? [];
    const i = args.indexOf("--enabled-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("list-mail-messages|get-mail-message");
  });
});

describe("resolveMs365McpEntries — multi-account", () => {
  const config = cfg({
    [STORAGE]: { enabled_for: ["marko"] },
    [MAIL]: { enabled_for: ["marko"] },
  });
  const agentCfg = agent({
    microsoft_workspace: {
      accounts: [
        { account: STORAGE, tools: ["drive", "upload-file", "download-file"] },
        { account: MAIL, tools: ["list-mail-messages", "get-mail-message", "list-mail-folders", "search-mail"] },
      ],
    },
  });

  it("emits two entries with distinct ms-365-<slug> keys", () => {
    const entries = resolveMs365McpEntries("marko", agentCfg, config);
    expect(entries).toHaveLength(2);
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      `ms-365-${microsoftAccountSlug(STORAGE)}`,
      `ms-365-${microsoftAccountSlug(MAIL)}`,
    ].sort());
  });

  it("threads the right --account and --enabled-tools per entry", () => {
    const entries = resolveMs365McpEntries("marko", agentCfg, config);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value.args ?? []]));

    const storageArgs = byKey[`ms-365-${microsoftAccountSlug(STORAGE)}`];
    expect(storageArgs[storageArgs.indexOf("--account") + 1]).toBe(STORAGE);
    expect(storageArgs[storageArgs.indexOf("--enabled-tools") + 1]).toBe("drive|upload-file|download-file");

    const mailArgs = byKey[`ms-365-${microsoftAccountSlug(MAIL)}`];
    expect(mailArgs[mailArgs.indexOf("--account") + 1]).toBe(MAIL);
    expect(mailArgs[mailArgs.indexOf("--enabled-tools") + 1]).toBe(
      "list-mail-messages|get-mail-message|list-mail-folders|search-mail",
    );
  });

  it("does NOT emit a binding whose account lacks the agent in enabled_for[]", () => {
    const partial = cfg({
      [STORAGE]: { enabled_for: ["marko"] },
      [MAIL]: { enabled_for: ["someone-else"] }, // marko not enabled here
    });
    const entries = resolveMs365McpEntries("marko", agentCfg, partial);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe(`ms-365-${microsoftAccountSlug(STORAGE)}`);
  });

  it("ms365OwnedKeys returns bare + all per-slug keys for retraction", () => {
    const owned = ms365OwnedKeys(agentCfg);
    expect(owned.has("ms-365")).toBe(true);
    expect(owned.has(`ms-365-${microsoftAccountSlug(STORAGE)}`)).toBe(true);
    expect(owned.has(`ms-365-${microsoftAccountSlug(MAIL)}`)).toBe(true);
  });

  it("hard opt-out (mcp_servers: { ms-365: false }) suppresses all entries", () => {
    const entries = resolveMs365McpEntries(
      "marko",
      agent({ ...agentCfg, mcp_servers: { "ms-365": false } }),
      config,
    );
    expect(entries).toHaveLength(0);
  });
});
