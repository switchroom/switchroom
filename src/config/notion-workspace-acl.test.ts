/**
 * Tests for notion-workspace-acl — RFC docs/rfcs/notion-integration.md PR 1.
 * Mirrors `microsoft-workspace-acl.test.ts` shape where the model fits.
 */

import { describe, expect, it } from "vitest";

import {
  agentCanAccessNotionDB,
  isNotionIntegrationTokenKeyForAgent,
  normalizeNotionUuid,
  resolveDbNameFromUuid,
  shouldEmitNotionMcp,
  validateNotionWorkspaceConfig,
} from "./notion-workspace-acl.js";
import type { SwitchroomConfig } from "./schema.js";

const DB_ESSAYS_DASHED = "a1b2c3d4-e5f6-7890-1234-567890abcdef";
// Undashed form of DB_ESSAYS_DASHED — verified by stripping dashes.
const DB_ESSAYS_UNDASHED = "a1b2c3d4e5f678901234567890abcdef";
const DB_TASKS_DASHED = "b2c3d4e5-f6a7-8901-2345-67890abcdef0";

// Build a baseline config with the top-level notion_workspace block
// and a single agent with full access. Callers override slices via a
// loose Record so they don't have to satisfy the full nested agent
// shape (schedule, topic_name, ...). Same pattern m365's test uses to
// sidestep deep-type strictness.
const baseConfig = (overrides: Record<string, unknown> = {}): SwitchroomConfig =>
  ({
    agents: {
      clerk: {
        notion_workspace: {},
      },
    },
    notion_workspace: {
      vault_key: "notion/integration-token",
      databases: {
        essays: DB_ESSAYS_DASHED,
        tasks: DB_TASKS_DASHED,
      },
    },
    ...overrides,
  }) as unknown as SwitchroomConfig;

describe("normalizeNotionUuid", () => {
  it("normalizes dashed UUID to undashed lowercase", () => {
    expect(normalizeNotionUuid("A1B2C3D4-E5F6-7890-1234-567890ABCDEF")).toBe(
      "a1b2c3d4e5f678901234567890abcdef",
    );
  });

  it("accepts undashed UUID", () => {
    expect(normalizeNotionUuid("a1b2c3d4e5f678901234567890abcdef")).toBe(
      "a1b2c3d4e5f678901234567890abcdef",
    );
  });

  it("returns null for malformed UUIDs", () => {
    expect(normalizeNotionUuid("not-a-uuid")).toBeNull();
    expect(normalizeNotionUuid("a1b2c3")).toBeNull();
    expect(normalizeNotionUuid("")).toBeNull();
    expect(normalizeNotionUuid(undefined)).toBeNull();
    expect(normalizeNotionUuid(null)).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(normalizeNotionUuid("g1b2c3d4-e5f6-7890-1234-567890abcdef")).toBeNull();
  });
});

describe("shouldEmitNotionMcp", () => {
  it("returns false when agentName is empty", () => {
    expect(shouldEmitNotionMcp("", baseConfig())).toBe(false);
  });

  it("returns false when top-level notion_workspace is missing", () => {
    const cfg = baseConfig();
    delete (cfg as { notion_workspace?: unknown }).notion_workspace;
    expect(shouldEmitNotionMcp("clerk", cfg)).toBe(false);
  });

  it("returns false when agent has no notion_workspace block", () => {
    const cfg = baseConfig({
      agents: { clerk: {} },
    });
    expect(shouldEmitNotionMcp("clerk", cfg)).toBe(false);
  });

  it("returns true for an agent with notion_workspace: {}", () => {
    expect(shouldEmitNotionMcp("clerk", baseConfig())).toBe(true);
  });

  it("returns true for an agent with notion_workspace.databases set", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["essays"] } },
      },
    });
    expect(shouldEmitNotionMcp("carrie", cfg)).toBe(true);
  });

  it("returns false for an agent not present in config.agents", () => {
    expect(shouldEmitNotionMcp("ghost", baseConfig())).toBe(false);
  });
});

describe("isNotionIntegrationTokenKeyForAgent", () => {
  it("returns true for the default vault key on an enabled agent", () => {
    expect(
      isNotionIntegrationTokenKeyForAgent(
        baseConfig(),
        "clerk",
        "notion/integration-token",
      ),
    ).toBe(true);
  });

  it("returns false for an unrelated vault key", () => {
    expect(
      isNotionIntegrationTokenKeyForAgent(
        baseConfig(),
        "clerk",
        "google/refresh-token",
      ),
    ).toBe(false);
  });

  it("honours the operator's vault_key override", () => {
    const cfg = baseConfig({
      notion_workspace: {
        vault_key: "custom/notion-token",
        databases: { essays: DB_ESSAYS_DASHED },
      },
    });
    expect(
      isNotionIntegrationTokenKeyForAgent(cfg, "clerk", "custom/notion-token"),
    ).toBe(true);
    expect(
      isNotionIntegrationTokenKeyForAgent(cfg, "clerk", "notion/integration-token"),
    ).toBe(false);
  });

  it("returns false when agent has mcp_servers.notion = false (hard opt-out)", () => {
    const cfg = baseConfig();
    cfg.agents.clerk = {
      ...cfg.agents.clerk,
      mcp_servers: { notion: false } as unknown as Record<string, unknown>,
    };
    expect(
      isNotionIntegrationTokenKeyForAgent(
        cfg,
        "clerk",
        "notion/integration-token",
      ),
    ).toBe(false);
  });

  it("returns false for agents without notion_workspace", () => {
    const cfg = baseConfig({ agents: { ghost: {} } });
    expect(
      isNotionIntegrationTokenKeyForAgent(
        cfg,
        "ghost",
        "notion/integration-token",
      ),
    ).toBe(false);
  });

  it("returns false when key is empty", () => {
    expect(
      isNotionIntegrationTokenKeyForAgent(baseConfig(), "clerk", ""),
    ).toBe(false);
  });
});

describe("agentCanAccessNotionDB", () => {
  it("allows everything for an agent with no databases filter", () => {
    expect(
      agentCanAccessNotionDB(baseConfig(), "clerk", DB_ESSAYS_DASHED),
    ).toBe(true);
    expect(
      agentCanAccessNotionDB(baseConfig(), "clerk", DB_TASKS_DASHED),
    ).toBe(true);
  });

  it("allows a DB inside the filter list", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["essays"] } },
      },
    });
    expect(
      agentCanAccessNotionDB(cfg, "carrie", DB_ESSAYS_DASHED),
    ).toBe(true);
  });

  it("denies a DB outside the filter list", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["essays"] } },
      },
    });
    expect(
      agentCanAccessNotionDB(cfg, "carrie", DB_TASKS_DASHED),
    ).toBe(false);
  });

  it("denies access for an agent without a notion_workspace block", () => {
    const cfg = baseConfig({ agents: { ghost: {} } });
    expect(
      agentCanAccessNotionDB(cfg, "ghost", DB_ESSAYS_DASHED),
    ).toBe(false);
  });

  it("compares UUIDs after normalizing dashes (mixed forms allowed)", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["essays"] } },
      },
    });
    expect(
      agentCanAccessNotionDB(cfg, "carrie", DB_ESSAYS_UNDASHED),
    ).toBe(true);
  });

  it("rejects an unknown friendly name in the filter (silent deny — apply catches this)", () => {
    const cfg = baseConfig({
      agents: {
        carrie: {
          notion_workspace: { databases: ["nonexistent"] },
        },
      },
    });
    // No DB resolves; nothing in the filter list maps to a real UUID,
    // so every access is denied. (The loader's
    // validateNotionWorkspaceConfig catches this case at config load
    // and emits a clear error — this predicate is just defence in
    // depth.)
    expect(
      agentCanAccessNotionDB(cfg, "carrie", DB_ESSAYS_DASHED),
    ).toBe(false);
  });

  it("returns false for a malformed UUID input", () => {
    expect(
      agentCanAccessNotionDB(baseConfig(), "clerk", "not-a-uuid"),
    ).toBe(false);
  });
});

describe("resolveDbNameFromUuid", () => {
  it("returns the friendly name for a known UUID", () => {
    expect(resolveDbNameFromUuid(baseConfig(), DB_ESSAYS_DASHED)).toBe(
      "essays",
    );
  });

  it("works with un-dashed UUID input", () => {
    expect(resolveDbNameFromUuid(baseConfig(), DB_ESSAYS_UNDASHED)).toBe(
      "essays",
    );
  });

  it("returns null for an unknown UUID", () => {
    expect(
      resolveDbNameFromUuid(
        baseConfig(),
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ),
    ).toBeNull();
  });

  it("returns null when the top-level DB map is empty", () => {
    const cfg = baseConfig({
      notion_workspace: {
        databases: {},
      } as unknown as SwitchroomConfig["notion_workspace"],
    });
    expect(resolveDbNameFromUuid(cfg, DB_ESSAYS_DASHED)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(resolveDbNameFromUuid(baseConfig(), "not-a-uuid")).toBeNull();
  });
});

describe("validateNotionWorkspaceConfig", () => {
  it("returns no issues for a valid config", () => {
    expect(validateNotionWorkspaceConfig(baseConfig())).toEqual([]);
  });

  it("returns no issues when no agent uses notion_workspace", () => {
    const cfg = baseConfig({ agents: { other: {} } });
    delete (cfg as { notion_workspace?: unknown }).notion_workspace;
    expect(validateNotionWorkspaceConfig(cfg)).toEqual([]);
  });

  it("rejects a per-agent DB reference not present in the top-level map", () => {
    const cfg = baseConfig({
      agents: {
        carrie: {
          notion_workspace: { databases: ["nonexistent"] },
        },
      },
    });
    const issues = validateNotionWorkspaceConfig(cfg);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/agents\.carrie\.notion_workspace\.databases/);
    expect(issues[0]).toMatch(/nonexistent/);
    expect(issues[0]).toMatch(/list-dbs/);
  });

  it("rejects per-agent notion_workspace when top-level is missing", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["essays"] } },
      },
    });
    delete (cfg as { notion_workspace?: unknown }).notion_workspace;
    const issues = validateNotionWorkspaceConfig(cfg);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/top-level notion_workspace block is missing/);
  });

  it("aggregates errors across multiple agents", () => {
    const cfg = baseConfig({
      agents: {
        carrie: { notion_workspace: { databases: ["nonexistent"] } },
        finn: { notion_workspace: { databases: ["also-missing"] } },
      },
    });
    const issues = validateNotionWorkspaceConfig(cfg);
    expect(issues.length).toBe(2);
    expect(issues.some((i) => i.includes("carrie"))).toBe(true);
    expect(issues.some((i) => i.includes("finn"))).toBe(true);
  });

  it("ignores agents without notion_workspace", () => {
    const cfg = baseConfig({
      agents: {
        clerk: { notion_workspace: {} },
        nointegration: {},
      },
    });
    expect(validateNotionWorkspaceConfig(cfg)).toEqual([]);
  });

  it("flags empty databases list (defensive — schema also rejects)", () => {
    const cfg = baseConfig({
      agents: {
        carrie: {
          notion_workspace: {
            databases: [],
          } as unknown as Record<string, unknown>,
        },
      },
    });
    const issues = validateNotionWorkspaceConfig(cfg);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/empty list/);
  });
});
