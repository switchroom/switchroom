/**
 * Tests for notion-write-pretool — RFC §8 PR 3.
 *
 * The pure `decide()` function is the test surface. Live `runHook()`
 * is exercised in PR 5's UAT.
 */

import { describe, expect, it } from "vitest";

import { decide, parseHookInput } from "./notion-write-pretool.js";
import { type NotionApiClient } from "../notion/db-resolver.js";
import { PageDbCache } from "../notion/page-db-cache.js";
import type { SwitchroomConfig } from "../config/schema.js";

// Fresh cache per call — the module-level CACHE in notion-write-pretool
// is process-wide; tests must NOT share it across cases or stale
// resolutions leak between tests.
const freshCache = () => new PageDbCache({ maxEntries: 32, ttlMs: 60_000 });

const DB_ESSAYS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DB_PRIVATE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const NULL_CLIENT: NotionApiClient = {
  async getPage() {
    throw new Error("should not be called");
  },
  async getBlock() {
    throw new Error("should not be called");
  },
};

function cfg(): SwitchroomConfig {
  return {
    notion_workspace: {
      vault_key: "notion/integration-token",
      databases: { essays: DB_ESSAYS, private: DB_PRIVATE },
    },
    agents: {
      clerk: { notion_workspace: {} }, // full access
      carrie: { notion_workspace: { databases: ["essays"] } }, // essays only
      ghost: {}, // no notion at all
    },
  } as unknown as SwitchroomConfig;
}

describe("decide — non-notion tools fall through", () => {
  it("allows tool_name without the mcp__notion__ prefix", async () => {
    const r = await decide(
      { tool_name: "Bash", tool_input: {} },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });

  it("allows when tool_name is missing", async () => {
    const r = await decide(
      { tool_input: {} },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });
});

describe("decide — banned create_database", () => {
  it("blocks create_database with a clear reason", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__create_database",
        tool_input: { parent: { page_id: "x" } },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/disabled in switchroom v1/);
    expect(r.reason).toMatch(/Notion's UI/);
  });
});

describe("decide — top-level notion_workspace missing", () => {
  it("blocks when global notion_workspace is missing", async () => {
    const bare = {
      agents: { clerk: { notion_workspace: {} } },
    } as unknown as SwitchroomConfig;
    const r = await decide(
      {
        tool_name: "mcp__notion__query_database",
        tool_input: { database_id: DB_ESSAYS },
      },
      { agentName: "clerk", configLoader: () => bare, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/not configured globally/);
  });
});

describe("decide — args-resolved (DB in args)", () => {
  it("allows query_database for an allowlisted DB", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__query_database",
        tool_input: { database_id: DB_ESSAYS },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });

  it("blocks query_database for a DB outside the agent's allowlist", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__query_database",
        tool_input: { database_id: DB_PRIVATE },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/not in carrie's allowlist/);
  });

  it("allows admin agent (no databases filter) to access any DB", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__query_database",
        tool_input: { database_id: DB_PRIVATE },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });

  it("allows create_page with allowlisted parent.database_id", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__create_page",
        tool_input: { parent: { database_id: DB_ESSAYS } },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });
});

describe("decide — walk required", () => {
  it("walks page → DB and allows when in allowlist", async () => {
    const client: NotionApiClient = {
      async getPage(id: string) {
        expect(id).toBe("page-1");
        return { parent: { type: "database_id", database_id: DB_ESSAYS } };
      },
      async getBlock() {
        throw new Error("not used");
      },
    };
    const r = await decide(
      {
        tool_name: "mcp__notion__update_page",
        tool_input: { page_id: "page-1" },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: client, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });

  it("walks block → page → DB and blocks when outside allowlist", async () => {
    const client: NotionApiClient = {
      async getPage(id: string) {
        if (id === "page-1") {
          return { parent: { type: "database_id", database_id: DB_PRIVATE } };
        }
        throw new Error(`unexpected page ${id}`);
      },
      async getBlock(id: string) {
        if (id === "block-1") {
          return { parent: { type: "page_id", page_id: "page-1" } };
        }
        throw new Error(`unexpected block ${id}`);
      },
    };
    const r = await decide(
      {
        tool_name: "mcp__notion__append_block_children",
        tool_input: { block_id: "block-1" },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: client, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/not in carrie's allowlist/);
  });

  it("blocks standalone (workspace-parented) page writes", async () => {
    const client: NotionApiClient = {
      async getPage() {
        return { parent: { type: "workspace", workspace: true } };
      },
      async getBlock() {
        throw new Error("not used");
      },
    };
    const r = await decide(
      {
        tool_name: "mcp__notion__update_page",
        tool_input: { page_id: "standalone-1" },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: client, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/standalone page|database parent/);
  });

  it("fails closed on resolver API error", async () => {
    const client: NotionApiClient = {
      async getPage() {
        throw new Error("Notion API: 404");
      },
      async getBlock() {
        throw new Error("Notion API: 404");
      },
    };
    const r = await decide(
      {
        tool_name: "mcp__notion__update_page",
        tool_input: { page_id: "page-x" },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: client, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/could not resolve|404/);
  });
});

describe("decide — args-malformed", () => {
  it("blocks update_page with no page_id", async () => {
    const r = await decide(
      { tool_name: "mcp__notion__update_page", tool_input: {} },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/missing page_id|rejected/);
  });

  it("blocks unknown new notion tools", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__some_future_tool",
        tool_input: { foo: "bar" },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/unknown notion tool/);
  });
});

describe("decide — search special-case", () => {
  it("allows search for admin-shaped agents (no databases filter)", async () => {
    // clerk has notion_workspace: {} — full access. Search is unfiltered
    // at the upstream-share-list boundary, which is acceptable for admin
    // agents.
    const r = await decide(
      {
        tool_name: "mcp__notion__search",
        tool_input: { query: "essays" },
      },
      { agentName: "clerk", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("allow");
  });

  it("BLOCKS search for agents with a databases filter (v1 privacy gate)", async () => {
    // carrie has notion_workspace: { databases: [essays] }. Without the
    // launcher-side post-filter (tracked at #1913), allowing carrie's
    // search would leak snippets from other DBs the integration was
    // shared with. v1 posture: block honestly.
    const r = await decide(
      {
        tool_name: "mcp__notion__search",
        tool_input: { query: "essays" },
      },
      { agentName: "carrie", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/search.*blocked/i);
    expect(r.reason).toMatch(/query_database/);
    expect(r.reason).toMatch(/1913/);
  });

  it("blocks search when the agent has no notion_workspace", async () => {
    const r = await decide(
      {
        tool_name: "mcp__notion__search",
        tool_input: { query: "essays" },
      },
      { agentName: "ghost", configLoader: cfg, apiClient: NULL_CLIENT, cache: freshCache() },
    );
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/no notion_workspace/);
  });
});

describe("parseHookInput", () => {
  it("parses valid JSON", () => {
    expect(parseHookInput('{"tool_name":"Bash"}')).toEqual({
      tool_name: "Bash",
    });
  });

  it("returns null for malformed", () => {
    expect(parseHookInput("not json")).toBeNull();
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("null")).toBeNull();
  });
});
