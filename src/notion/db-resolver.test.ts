/**
 * Tests for db-resolver — RFC §8.2 PR 3.
 */

import { describe, expect, it, vi } from "vitest";

import {
  dispatchTool,
  MAX_WALK_DEPTH,
  resolveDbForNode,
  type NotionApiClient,
} from "./db-resolver.js";
import { PageDbCache } from "./page-db-cache.js";

const DB = "11111111-1111-1111-1111-111111111111";
const DB2 = "22222222-2222-2222-2222-222222222222";

function mockClient(
  pages: Record<string, Awaited<ReturnType<NotionApiClient["getPage"]>>["parent"]> = {},
  blocks: Record<string, Awaited<ReturnType<NotionApiClient["getBlock"]>>["parent"]> = {},
): NotionApiClient & { calls: { kind: string; id: string }[] } {
  const calls: { kind: string; id: string }[] = [];
  return {
    calls,
    async getPage(id: string) {
      calls.push({ kind: "page", id });
      const parent = pages[id];
      if (!parent) throw new Error(`unknown page ${id}`);
      return { parent };
    },
    async getBlock(id: string) {
      calls.push({ kind: "block", id });
      const parent = blocks[id];
      if (!parent) throw new Error(`unknown block ${id}`);
      return { parent };
    },
  };
}

describe("resolveDbForNode — direct DB parent", () => {
  it("resolves a page whose parent is a database in one call", async () => {
    const client = mockClient({
      "page-1": { type: "database_id", database_id: DB },
    });
    const cache = new PageDbCache();
    const r = await resolveDbForNode("page-1", "page", client, cache);
    expect(r).toEqual({ kind: "db", dbId: DB, apiCalls: 1 });
    // Result cached.
    expect(cache.get("page-1")).toEqual({ kind: "hit", dbId: DB });
  });

  it("resolves a block whose parent is a database in one call", async () => {
    const client = mockClient({}, {
      "block-1": { type: "database_id", database_id: DB },
    });
    const r = await resolveDbForNode("block-1", "block", client, new PageDbCache());
    expect(r).toEqual({ kind: "db", dbId: DB, apiCalls: 1 });
  });
});

describe("resolveDbForNode — walks", () => {
  it("walks block → page → DB (2 calls)", async () => {
    const client = mockClient(
      { "page-1": { type: "database_id", database_id: DB } },
      { "block-1": { type: "page_id", page_id: "page-1" } },
    );
    const r = await resolveDbForNode("block-1", "block", client, new PageDbCache());
    expect(r).toEqual({ kind: "db", dbId: DB, apiCalls: 2 });
    expect(client.calls).toEqual([
      { kind: "block", id: "block-1" },
      { kind: "page", id: "page-1" },
    ]);
  });

  it("walks block → block → page → DB (3 calls)", async () => {
    const client = mockClient(
      { "page-1": { type: "database_id", database_id: DB } },
      {
        "block-1": { type: "block_id", block_id: "block-2" },
        "block-2": { type: "page_id", page_id: "page-1" },
      },
    );
    const r = await resolveDbForNode("block-1", "block", client, new PageDbCache());
    expect(r.kind).toBe("db");
    if (r.kind === "db") expect(r.dbId).toBe(DB);
    expect(r.apiCalls).toBe(3);
  });
});

describe("resolveDbForNode — no-DB outcomes", () => {
  it("returns no-db for a workspace-parented page", async () => {
    const client = mockClient({
      "page-1": { type: "workspace", workspace: true },
    });
    const cache = new PageDbCache();
    const r = await resolveDbForNode("page-1", "page", client, cache);
    expect(r).toEqual({ kind: "no-db", apiCalls: 1 });
    // Negative cached too.
    expect(cache.get("page-1")).toEqual({ kind: "hit", dbId: null });
  });

  it("walks page → page → ... → workspace (no DB)", async () => {
    const client = mockClient({
      "page-1": { type: "page_id", page_id: "page-2" },
      "page-2": { type: "workspace", workspace: true },
    });
    const r = await resolveDbForNode("page-1", "page", client, new PageDbCache());
    expect(r.kind).toBe("no-db");
    expect(r.apiCalls).toBe(2);
  });

  it("gives up at MAX_WALK_DEPTH and returns no-db", async () => {
    // Build a chain: page-0 → page-1 → page-2 → page-3 → page-4 ...
    const pages: Record<string, { type: "page_id"; page_id: string }> = {};
    for (let i = 0; i < MAX_WALK_DEPTH + 2; i += 1) {
      pages[`page-${i}`] = { type: "page_id", page_id: `page-${i + 1}` };
    }
    const client = mockClient(pages);
    const r = await resolveDbForNode("page-0", "page", client, new PageDbCache());
    expect(r.kind).toBe("no-db");
    expect(r.apiCalls).toBe(MAX_WALK_DEPTH);
  });
});

describe("resolveDbForNode — cache short-circuit", () => {
  it("returns hit without API call when cached", async () => {
    const client = mockClient();
    const cache = new PageDbCache();
    cache.set("page-1", DB);
    const r = await resolveDbForNode("page-1", "page", client, cache);
    expect(r).toEqual({ kind: "db", dbId: DB, apiCalls: 0 });
    expect(client.calls.length).toBe(0);
  });

  it("returns no-db without API call when cached null", async () => {
    const client = mockClient();
    const cache = new PageDbCache();
    cache.set("page-1", null);
    const r = await resolveDbForNode("page-1", "page", client, cache);
    expect(r).toEqual({ kind: "no-db", apiCalls: 0 });
  });
});

describe("resolveDbForNode — errors", () => {
  it("returns error on API failure", async () => {
    const client: NotionApiClient = {
      async getPage() {
        throw new Error("404");
      },
      async getBlock() {
        throw new Error("404");
      },
    };
    const r = await resolveDbForNode("page-1", "page", client, new PageDbCache());
    expect(r.kind).toBe("error");
  });

  it("returns error on cycle", async () => {
    const client = mockClient(
      {},
      {
        "block-1": { type: "block_id", block_id: "block-2" },
        "block-2": { type: "block_id", block_id: "block-1" },
      },
    );
    const r = await resolveDbForNode("block-1", "block", client, new PageDbCache());
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.reason).toMatch(/cycle/);
    }
  });
});

describe("dispatchTool", () => {
  it("rejects create_database (both naming conventions)", () => {
    expect(dispatchTool("create_database", {})).toEqual({
      kind: "banned-tool",
      toolName: "create_database",
    });
    expect(dispatchTool("create-database", {})).toEqual({
      kind: "banned-tool",
      toolName: "create-database",
    });
  });

  it("resolves DB-id directly from query_database args", () => {
    expect(dispatchTool("query_database", { database_id: DB })).toEqual({
      kind: "args-resolved",
      dbId: DB,
    });
  });

  it("resolves DB-id directly from create_page with parent.database_id", () => {
    expect(
      dispatchTool("create_page", { parent: { database_id: DB } }),
    ).toEqual({ kind: "args-resolved", dbId: DB });
  });

  it("requires walk for create_page with parent.page_id", () => {
    expect(
      dispatchTool("create_page", { parent: { page_id: "page-1" } }),
    ).toEqual({ kind: "walk-required", startId: "page-1", startKind: "page" });
  });

  it("requires walk for update_page", () => {
    expect(dispatchTool("update_page", { page_id: "page-1" })).toEqual({
      kind: "walk-required",
      startId: "page-1",
      startKind: "page",
    });
  });

  it("requires walk for update_block / delete_block / append_block_children", () => {
    for (const name of [
      "update_block",
      "delete_block",
      "append_block_children",
    ]) {
      expect(dispatchTool(name, { block_id: "block-1" })).toEqual({
        kind: "walk-required",
        startId: "block-1",
        startKind: "block",
      });
    }
  });

  it("requires walk for create_comment with parent.page_id", () => {
    expect(
      dispatchTool("create_comment", { parent: { page_id: "page-1" } }),
    ).toEqual({ kind: "walk-required", startId: "page-1", startKind: "page" });
  });

  it("rejects create_comment without parent.page_id", () => {
    expect(
      dispatchTool("create_comment", { discussion_id: "discussion-1" }),
    ).toMatchObject({ kind: "args-malformed" });
  });

  it("rejects unknown tools by default", () => {
    expect(dispatchTool("notion_unknown_new_tool", { foo: "bar" })).toMatchObject({
      kind: "args-malformed",
    });
  });

  it("rejects malformed args", () => {
    expect(dispatchTool("update_page", {})).toMatchObject({
      kind: "args-malformed",
    });
    expect(dispatchTool("update_page", undefined)).toMatchObject({
      kind: "args-malformed",
    });
  });

  it("punts search to the post-filter (dispatcher returns args-malformed)", () => {
    expect(dispatchTool("search", { query: "foo" })).toMatchObject({
      kind: "args-malformed",
    });
  });
});
