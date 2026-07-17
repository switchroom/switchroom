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
  retractStaleIntegrationKeys,
  integrationMcpEntries,
  userDeclaredMcpKeys,
  INTEGRATION_MCP_RESOLVERS,
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

describe("retractStaleIntegrationKeys — durable shrink retraction (namespace diff)", () => {
  const ms365 = INTEGRATION_MCP_RESOLVERS.find((i) => i.emitKey === "ms-365")!;
  const slugA = `ms-365-${microsoftAccountSlug(STORAGE)}`;
  const slugB = `ms-365-${microsoftAccountSlug(MAIL)}`;
  const config = cfg({
    [STORAGE]: { enabled_for: ["marko"] },
    [MAIL]: { enabled_for: ["marko"] },
  });

  it("drops a FULLY-REMOVED binding's stale key that config enumeration cannot see", () => {
    // Simulate settings.json.mcpServers from a prior 3-account apply where
    // account B has since been removed. The config still binds 2+ accounts
    // (A, C) so the survivors keep their per-slug keys. Emitted = {slugA, slugC}.
    const slugC = `ms-365-${microsoftAccountSlug("carol@example.com")}`;
    const stillMultiCfg = agent({
      microsoft_workspace: {
        accounts: [{ account: STORAGE }, { account: "carol@example.com" }],
      },
    });
    const cfgAC = cfg({
      [STORAGE]: { enabled_for: ["marko"] },
      "carol@example.com": { enabled_for: ["marko"] },
    });
    const emitted = new Set(
      integrationMcpEntries(ms365, "marko", stillMultiCfg, cfgAC).map((e) => e.key),
    );
    expect([...emitted].sort()).toEqual([slugA, slugC].sort());

    const existing: Record<string, unknown> = {
      hindsight: { command: "x" },
      [slugA]: { command: "a" },
      [slugB]: { command: "b" }, // account B removed from config → stale
      [slugC]: { command: "c" },
    };

    const removed = retractStaleIntegrationKeys(
      ms365,
      emitted,
      existing,
      userDeclaredMcpKeys(stillMultiCfg),
    );

    expect(removed).toEqual([slugB]);
    expect(existing[slugB]).toBeUndefined(); // stale gone — config enumeration alone could NOT see this
    expect(existing[slugA]).toBeDefined(); // surviving account kept
    expect(existing[slugC]).toBeDefined(); // surviving account kept
    expect(existing.hindsight).toBeDefined(); // foreign key untouched
  });

  it("multi→single collapse retracts BOTH old per-slug keys (survivor reverts to bare `ms-365`)", () => {
    // Shrinking from 2 accounts to 1 flips the survivor from `ms-365-<slug>`
    // back to the bare `ms-365` key (documented back-compat). Both stale
    // per-slug keys must be dropped.
    const singleCfg = agent({ microsoft_workspace: { accounts: [{ account: STORAGE }] } });
    const emitted = new Set(
      integrationMcpEntries(ms365, "marko", singleCfg, config).map((e) => e.key),
    );
    expect([...emitted]).toEqual(["ms-365"]); // single-account collapses to bare key

    const existing: Record<string, unknown> = {
      [slugA]: { command: "a" },
      [slugB]: { command: "b" },
    };
    const removed = retractStaleIntegrationKeys(ms365, emitted, existing, userDeclaredMcpKeys(singleCfg));
    expect(removed.sort()).toEqual([slugA, slugB].sort());
    expect(existing[slugA]).toBeUndefined();
    expect(existing[slugB]).toBeUndefined();
  });

  it("also retracts the bare `ms-365` key when an agent goes from single → zero bindings", () => {
    const existing: Record<string, unknown> = { "ms-365": { command: "x" } };
    const removed = retractStaleIntegrationKeys(ms365, new Set(), existing);
    expect(removed).toEqual(["ms-365"]);
    expect(existing["ms-365"]).toBeUndefined();
  });

  it("PROTECTS an operator's hand-declared ms-365-* mcp_servers key", () => {
    const existing: Record<string, unknown> = { "ms-365-custom": { command: "x" } };
    const removed = retractStaleIntegrationKeys(
      ms365,
      new Set(),
      existing,
      new Set(["ms-365-custom"]),
    );
    expect(removed).toEqual([]);
    expect(existing["ms-365-custom"]).toBeDefined();
  });

  it("does not touch keys outside the ms-365 namespace", () => {
    const existing: Record<string, unknown> = {
      gdrive: { command: "g" },
      notion: { command: "n" },
      "ms-365": { command: "m" },
    };
    retractStaleIntegrationKeys(ms365, new Set(), existing);
    expect(existing.gdrive).toBeDefined();
    expect(existing.notion).toBeDefined();
    expect(existing["ms-365"]).toBeUndefined();
  });
});
