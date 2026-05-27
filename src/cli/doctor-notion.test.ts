/**
 * Tests for the Notion doctor probes — RFC §9 PR 4.
 *
 * Branch-covers `runNotionChecks` with injected filesystem + vault
 * ACL reader. Mirrors `doctor-microsoft.test.ts` shape.
 */

import { describe, expect, it } from "vitest";

import { runNotionChecks, computeNotionEnabledAgents } from "./doctor-notion.js";
import type { SwitchroomConfig } from "../config/schema.js";

const DB_ESSAYS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DB_TASKS = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function cfg(overrides: Record<string, unknown> = {}): SwitchroomConfig {
  return {
    notion_workspace: {
      vault_key: "notion/integration-token",
      databases: { essays: DB_ESSAYS, tasks: DB_TASKS },
    },
    agents: {
      clerk: { notion_workspace: {} },
      carrie: { notion_workspace: { databases: ["essays"] } },
      finn: {},
    },
    ...overrides,
  } as unknown as SwitchroomConfig;
}

const okReader = (allow: string[]) => async () => ({
  kind: "ok" as const,
  allow,
});

const notFoundReader = async () => ({ kind: "not_found" as const });

const unreachableReader = async () => ({
  kind: "unreachable" as const,
  msg: "socket missing",
});

describe("computeNotionEnabledAgents", () => {
  it("returns agents with notion_workspace block", () => {
    expect(computeNotionEnabledAgents(cfg())).toEqual(["clerk", "carrie"]);
  });

  it("returns empty when no agent has the block", () => {
    expect(
      computeNotionEnabledAgents(cfg({ agents: { other: {} } })),
    ).toEqual([]);
  });
});

describe("runNotionChecks — skip when not configured", () => {
  it("returns empty when no notion_workspace + no agent uses notion", async () => {
    const bare = { agents: { other: {} } } as unknown as SwitchroomConfig;
    const r = await runNotionChecks(bare);
    expect(r).toEqual([]);
  });
});

describe("runNotionChecks — config matrix", () => {
  it("fails when top-level missing but agents have notion_workspace", async () => {
    const broken = {
      agents: { clerk: { notion_workspace: {} } },
    } as unknown as SwitchroomConfig;
    const r = await runNotionChecks(broken, {
      vaultAclReader: okReader(["clerk"]),
    });
    const top = r.find((c) => c.name === "notion:top-level-block-present");
    expect(top?.status).toBe("fail");
    expect(top?.fix).toMatch(/notion list-dbs/);
  });

  it("passes top-level + db-references-resolvable when config is sound", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk", "carrie"]),
      existsSync: () => false, // no heartbeats — warn-status
    });
    expect(r.find((c) => c.name === "notion:top-level-block-present")?.status).toBe("ok");
    expect(
      r.find((c) => c.name === "notion:db-references-resolvable:carrie")?.status,
    ).toBe("ok");
  });

  it("fails db-references-resolvable when an agent references an unknown DB", async () => {
    const broken = cfg({
      agents: {
        carrie: { notion_workspace: { databases: ["nonexistent"] } },
      },
    });
    const r = await runNotionChecks(broken, {
      vaultAclReader: okReader(["carrie"]),
      existsSync: () => false,
    });
    const probe = r.find(
      (c) => c.name === "notion:db-references-resolvable:carrie",
    );
    expect(probe?.status).toBe("fail");
    expect(probe?.detail).toMatch(/nonexistent/);
  });
});

describe("runNotionChecks — vault ACL drift (load-bearing probe)", () => {
  it("fails when agent has notion_workspace but is missing from ACL", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk"]), // carrie missing!
      existsSync: () => false,
    });
    const carrieAcl = r.find(
      (c) => c.name === "notion:vault-acl-aligned:carrie",
    );
    expect(carrieAcl?.status).toBe("fail");
    expect(carrieAcl?.detail).toMatch(/NOT in the vault ACL/);
    expect(carrieAcl?.fix).toMatch(/vault acl add notion\/integration-token carrie/);
  });

  it("warns when an agent is on ACL but has no notion_workspace block", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk", "carrie", "finn"]), // finn on ACL but no block
      existsSync: () => false,
    });
    const finnProbe = r.find((c) => c.name === "notion:vault-acl-aligned:finn");
    expect(finnProbe?.status).toBe("warn");
    expect(finnProbe?.detail).toMatch(/never reads the token/);
  });

  it("fails integration-token-present when vault key is missing", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: notFoundReader,
      existsSync: () => false,
    });
    const probe = r.find((c) => c.name === "notion:integration-token-present");
    expect(probe?.status).toBe("fail");
    expect(probe?.fix).toMatch(/vault put notion\/integration-token/);
  });

  it("warns when vault-broker is unreachable", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: unreachableReader,
      existsSync: () => false,
    });
    const probe = r.find((c) => c.name === "notion:vault-acl-aligned");
    expect(probe?.status).toBe("warn");
  });
});

describe("runNotionChecks — launcher heartbeat", () => {
  it("warns when heartbeat file is missing", async () => {
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk", "carrie"]),
      existsSync: () => false,
    });
    const probe = r.find(
      (c) => c.name === "notion:launcher-heartbeat:clerk",
    );
    expect(probe?.status).toBe("warn");
    expect(probe?.detail).toMatch(/missing/);
  });

  it("warns when heartbeat is stale (>60s)", async () => {
    let now = 1_000_000;
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk", "carrie"]),
      existsSync: () => true,
      statSync: () => ({ mtimeMs: now - 90_000 }), // 90s old
      now: () => now,
    });
    const probe = r.find(
      (c) => c.name === "notion:launcher-heartbeat:clerk",
    );
    expect(probe?.status).toBe("warn");
    expect(probe?.detail).toMatch(/stale|old/);
  });

  it("passes when heartbeat is fresh", async () => {
    const now = 1_000_000;
    const r = await runNotionChecks(cfg(), {
      vaultAclReader: okReader(["clerk", "carrie"]),
      existsSync: () => true,
      statSync: () => ({ mtimeMs: now - 10_000 }), // 10s old
      now: () => now,
    });
    const probe = r.find(
      (c) => c.name === "notion:launcher-heartbeat:clerk",
    );
    expect(probe?.status).toBe("ok");
  });
});

describe("runNotionChecks — admin-shaped (no databases filter)", () => {
  it("emits a single ok probe for db-references-resolvable when no per-agent filter set", async () => {
    const adminOnly = cfg({
      agents: { clerk: { notion_workspace: {} } },
    });
    const r = await runNotionChecks(adminOnly, {
      vaultAclReader: okReader(["clerk"]),
      existsSync: () => false,
    });
    expect(
      r.filter((c) => c.name.startsWith("notion:db-references-resolvable"))
        .length,
    ).toBeGreaterThan(0);
    expect(
      r.find(
        (c) => c.name === "notion:db-references-resolvable" || c.name === "notion:db-references-resolvable:clerk",
      ),
    ).toBeDefined();
  });
});
