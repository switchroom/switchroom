/**
 * Tests for the search post-filter — RFC §8.5 PR 3.
 *
 * The privacy invariant: results from DBs the agent can't access
 * MUST NOT appear in the filtered output. The leak-prevention
 * assertion (carrie searching for a term in clerk's private DB) is
 * pinned here so a regression is structurally caught.
 */

import { describe, expect, it } from "vitest";

import { type NotionApiClient } from "./db-resolver.js";
import { PageDbCache } from "./page-db-cache.js";
import { filterSearchResults, MAX_FILTERED_RESULTS } from "./search-filter.js";
import type { NotionSearchResponse } from "./api-client.js";

const DB_ESSAYS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DB_PRIVATE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const ALLOWED = (db: string) => db === DB_ESSAYS;
const NULL_CLIENT: NotionApiClient = {
  async getPage() {
    throw new Error("should not be called");
  },
  async getBlock() {
    throw new Error("should not be called");
  },
};

describe("filterSearchResults — direct DB parent", () => {
  it("keeps allowed-DB results and drops disallowed", async () => {
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "page-1",
          parent: { type: "database_id", database_id: DB_ESSAYS },
        },
        {
          object: "page",
          id: "page-2",
          parent: { type: "database_id", database_id: DB_PRIVATE },
        },
        {
          object: "page",
          id: "page-3",
          parent: { type: "database_id", database_id: DB_ESSAYS },
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      NULL_CLIENT,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.map((x) => x.id)).toEqual(["page-1", "page-3"]);
    expect(r.filteredOut).toBe(1);
    expect(r.apiCalls).toBe(0);
    expect(r.upstreamCount).toBe(3);
  });

  it("drops workspace-parented (standalone) pages", async () => {
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "page-1",
          parent: { type: "workspace", workspace: true },
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      NULL_CLIENT,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.length).toBe(0);
    expect(r.filteredOut).toBe(1);
  });
});

describe("filterSearchResults — walk required", () => {
  it("walks page→DB and keeps when allowed", async () => {
    const client: NotionApiClient = {
      async getPage(id: string) {
        if (id === "page-1")
          return {
            parent: { type: "database_id", database_id: DB_ESSAYS },
          };
        throw new Error(`unknown page ${id}`);
      },
      async getBlock() {
        throw new Error("not used");
      },
    };
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "page-1",
          parent: { type: "page_id", page_id: "page-1" }, // simulate walk-required form
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      client,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.length).toBe(1);
    expect(r.apiCalls).toBeGreaterThanOrEqual(1);
  });

  it("walks and drops when DB is disallowed", async () => {
    const client: NotionApiClient = {
      async getPage(id: string) {
        if (id === "page-private")
          return {
            parent: { type: "database_id", database_id: DB_PRIVATE },
          };
        throw new Error(`unknown page ${id}`);
      },
      async getBlock() {
        throw new Error("not used");
      },
    };
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "page-private",
          parent: { type: "page_id", page_id: "page-private" },
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      client,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.length).toBe(0);
    expect(r.filteredOut).toBe(1);
  });

  it("treats unresolvable results as denied (fail-closed)", async () => {
    const client: NotionApiClient = {
      async getPage() {
        throw new Error("404");
      },
      async getBlock() {
        throw new Error("404");
      },
    };
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "page-x",
          parent: { type: "page_id", page_id: "page-x" },
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      client,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.length).toBe(0);
    expect(r.errored).toBe(1);
  });
});

describe("filterSearchResults — database results", () => {
  it("keeps an allowed database result by DB id", async () => {
    const resp: NotionSearchResponse = {
      results: [
        { object: "database", id: DB_ESSAYS },
        { object: "database", id: DB_PRIVATE },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      NULL_CLIENT,
      new PageDbCache(),
      ALLOWED,
    );
    expect(r.allowed.map((x) => x.id)).toEqual([DB_ESSAYS]);
    expect(r.filteredOut).toBe(1);
  });
});

describe("filterSearchResults — cap enforcement", () => {
  it("stops walking after MAX_FILTERED_RESULTS and counts the rest as unwalked", async () => {
    let pageFetches = 0;
    const client: NotionApiClient = {
      async getPage() {
        pageFetches += 1;
        return { parent: { type: "database_id", database_id: DB_ESSAYS } };
      },
      async getBlock() {
        throw new Error("not used");
      },
    };
    // Build 25 walk-required results.
    const results = Array.from({ length: 25 }, (_, i) => ({
      object: "page" as const,
      id: `page-${i}`,
      parent: { type: "page_id" as const, page_id: `page-${i}` },
    }));
    const r = await filterSearchResults(
      { results, next_cursor: null, has_more: false },
      client,
      new PageDbCache(),
      ALLOWED,
    );
    expect(pageFetches).toBeLessThanOrEqual(MAX_FILTERED_RESULTS);
    expect(r.unwalked).toBe(25 - MAX_FILTERED_RESULTS);
  });
});

describe("filterSearchResults — privacy invariant (regression gate)", () => {
  it("carrie's search for a term in clerk's private DB returns zero leak snippets", async () => {
    // Carrie's allowlist: only DB_ESSAYS. Clerk has access to DB_PRIVATE too,
    // and writes there. If carrie searches and Notion's `search` returns a
    // hit from DB_PRIVATE, the filter MUST drop it BEFORE the model sees
    // the title or snippet.
    const carrieAllowed = (db: string) => db === DB_ESSAYS;
    const resp: NotionSearchResponse = {
      results: [
        {
          object: "page",
          id: "leaky-page",
          parent: { type: "database_id", database_id: DB_PRIVATE },
          properties: {
            title: { title: [{ plain_text: "clerk's private secret stuff" }] },
          },
        },
      ],
      next_cursor: null,
      has_more: false,
    };
    const r = await filterSearchResults(
      resp,
      NULL_CLIENT,
      new PageDbCache(),
      carrieAllowed,
    );
    expect(r.allowed.length).toBe(0); // <-- THIS is the privacy invariant
    expect(r.filteredOut).toBe(1);
    // The page title MUST NOT appear in the allowed array at all
    expect(JSON.stringify(r.allowed)).not.toContain("private secret");
  });
});
