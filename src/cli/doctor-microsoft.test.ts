/**
 * Tests for doctor-microsoft probes — RFC #1873 §9 PR 5.
 */

import { describe, expect, it } from "vitest";

import {
  computeMicrosoftEnabledAgents,
  runMicrosoftChecks,
  type MicrosoftProbeDeps,
} from "./doctor-microsoft.js";
import type { SwitchroomConfig } from "../config/schema.js";

const baseConfig = (overrides: Partial<SwitchroomConfig> = {}): SwitchroomConfig =>
  ({
    agents: {
      clerk: {
        microsoft_workspace: { account: "bob@example.com" },
      },
    },
    microsoft_accounts: {
      "bob@example.com": { enabled_for: ["clerk"] },
    },
    microsoft_workspace: {
      microsoft_client_id: "vault:microsoft-oauth-client-id",
      microsoft_client_secret: "vault:microsoft-oauth-client-secret",
    },
    ...overrides,
  }) as SwitchroomConfig;

// ────────────────────────────────────────────────────────────────────────
// Suppress probes when MS not configured
// ────────────────────────────────────────────────────────────────────────

describe("runMicrosoftChecks — silent skip when MS not configured", () => {
  it("returns [] when no microsoft_* config exists", () => {
    const cfg = { agents: { clerk: {} } } as unknown as SwitchroomConfig;
    expect(runMicrosoftChecks(cfg)).toEqual([]);
  });

  it("does not skip when microsoft_workspace block exists alone (operator partway through setup)", () => {
    const cfg = {
      agents: { clerk: {} },
      microsoft_workspace: { microsoft_client_id: "x" },
    } as unknown as SwitchroomConfig;
    const results = runMicrosoftChecks(cfg);
    // No agent has account set → no oauth-client check needed
    expect(results.filter((r) => r.status === "fail")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Config matrix
// ────────────────────────────────────────────────────────────────────────

describe("runMicrosoftChecks — config matrix", () => {
  it("happy path: aligned agent → ok", () => {
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps());
    const matrix = results.find((r) => r.name === "microsoft:matrix:clerk");
    expect(matrix?.status).toBe("ok");
  });

  it("agent has account set but no microsoft_accounts entry → fail", () => {
    const cfg = baseConfig({ microsoft_accounts: {} });
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const matrix = results.find((r) => r.name === "microsoft:matrix:clerk");
    expect(matrix?.status).toBe("fail");
    expect(matrix?.detail).toContain("no microsoft_accounts");
  });

  it("agent has account but is NOT in enabled_for → fail", () => {
    const cfg = baseConfig({
      microsoft_accounts: { "bob@example.com": { enabled_for: ["other"] } },
    });
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const matrix = results.find((r) => r.name === "microsoft:matrix:clerk");
    expect(matrix?.status).toBe("fail");
    expect(matrix?.detail).toContain("not listed in microsoft_accounts");
  });

  it("agent is in enabled_for but has no per-agent account → reverse-direction fail", () => {
    const cfg = baseConfig();
    cfg.agents.clerk = {} as unknown as SwitchroomConfig["agents"][string];
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const reverse = results.find((r) =>
      r.name.startsWith("microsoft:matrix:reverse:"),
    );
    expect(reverse?.status).toBe("fail");
    expect(reverse?.detail).toContain("ACCOUNT_NOT_FOUND");
  });

  it("agent uses different account than enabled_for says → reverse-direction fail", () => {
    const cfg = baseConfig();
    cfg.agents.clerk = {
      microsoft_workspace: { account: "ken@contoso.com" },
    } as unknown as SwitchroomConfig["agents"][string];
    cfg.microsoft_accounts = {
      "bob@example.com": { enabled_for: ["clerk"] },
    };
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const reverse = results.find((r) =>
      r.name.startsWith("microsoft:matrix:reverse:"),
    );
    expect(reverse?.status).toBe("fail");
  });
});

// ────────────────────────────────────────────────────────────────────────
// OAuth client
// ────────────────────────────────────────────────────────────────────────

describe("runMicrosoftChecks — OAuth client", () => {
  it("happy path: client_id + secret → ok with confidential-client detail", () => {
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps());
    const oauth = results.find((r) => r.name === "microsoft:oauth-client-configured");
    expect(oauth?.status).toBe("ok");
    expect(oauth?.detail).toContain("confidential");
  });

  it("public-client: client_id only → ok with public-client detail", () => {
    const cfg = baseConfig();
    delete cfg.microsoft_workspace!.microsoft_client_secret;
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const oauth = results.find((r) => r.name === "microsoft:oauth-client-configured");
    expect(oauth?.status).toBe("ok");
    expect(oauth?.detail).toContain("public-client");
  });

  it("missing microsoft_workspace block → ok (uses shipped default app)", () => {
    // A default Microsoft OAuth app ships, so omitting the block is the
    // normal zero-config case — not a failure. The broker resolves the
    // default client_id.
    const cfg = baseConfig();
    delete cfg.microsoft_workspace;
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const oauth = results.find((r) => r.name === "microsoft:oauth-client-configured");
    expect(oauth?.status).toBe("ok");
    expect(oauth?.detail).toContain("shipped default");
  });

  it("empty client_id → ok (falls back to shipped default app)", () => {
    const cfg = baseConfig();
    cfg.microsoft_workspace!.microsoft_client_id = "";
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const oauth = results.find((r) => r.name === "microsoft:oauth-client-configured");
    expect(oauth?.status).toBe("ok");
    expect(oauth?.detail).toContain("shipped default");
  });

  it("skips OAuth check entirely when no agents enabled (just YAML in setup)", () => {
    const cfg = baseConfig();
    cfg.microsoft_accounts = {}; // no agents enabled
    const results = runMicrosoftChecks(cfg, defaultMockDeps());
    const oauth = results.find((r) => r.name === "microsoft:oauth-client-configured");
    expect(oauth).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Launcher heartbeat
// ────────────────────────────────────────────────────────────────────────

function defaultMockDeps(overrides: Partial<MicrosoftProbeDeps> = {}): MicrosoftProbeDeps {
  return {
    existsSync: () => false,
    readFileSync: () => "",
    homeDir: () => "/home/test",
    now: () => 1_000_000_000_000,
    ...overrides,
  };
}

describe("runMicrosoftChecks — launcher heartbeat", () => {
  it("missing heartbeat file → warn (launcher hasn't started yet)", () => {
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => false,
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("warn");
    expect(hb?.detail).toContain("missing");
  });

  it("malformed heartbeat → warn", () => {
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => true,
      readFileSync: () => "{ not valid json",
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("warn");
    expect(hb?.detail).toContain("parse error");
  });

  it("missing required fields → warn", () => {
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ lastRefreshMs: 1000 }),
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("warn");
    expect(hb?.detail).toContain("malformed");
  });

  it("fresh heartbeat (last refresh <90min ago, next in future) → ok", () => {
    const now = 1_000_000_000_000;
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        lastRefreshMs: now - 10 * 60 * 1000,    // 10min ago
        nextRefreshMs: now + 45 * 60 * 1000,    // 45min from now
        expiresAtMs: now + 50 * 60 * 1000,
      }),
      now: () => now,
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("ok");
    expect(hb?.detail).toMatch(/10min ago/);
    expect(hb?.detail).toMatch(/45min/);
  });

  it("stale heartbeat (last refresh >90min ago) → fail", () => {
    const now = 1_000_000_000_000;
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        lastRefreshMs: now - 120 * 60 * 1000,   // 2h ago
        nextRefreshMs: now - 60 * 60 * 1000,    // overdue
        expiresAtMs: now - 55 * 60 * 1000,
      }),
      now: () => now,
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("fail");
    expect(hb?.detail).toContain("refresh loop appears dead");
  });

  it("overdue but not yet stale → warn", () => {
    const now = 1_000_000_000_000;
    const results = runMicrosoftChecks(baseConfig(), defaultMockDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        lastRefreshMs: now - 70 * 60 * 1000,    // 70min ago
        nextRefreshMs: now - 10 * 60 * 1000,    // 10min overdue
        expiresAtMs: now - 5 * 60 * 1000,
      }),
      now: () => now,
    }));
    const hb = results.find((r) => r.name === "microsoft:launcher-heartbeat:clerk");
    expect(hb?.status).toBe("warn");
    expect(hb?.detail).toContain("missed its scheduled time");
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeMicrosoftEnabledAgents
// ────────────────────────────────────────────────────────────────────────

describe("computeMicrosoftEnabledAgents", () => {
  it("returns aligned agents only", () => {
    const cfg = baseConfig();
    cfg.agents.notenabled = {} as unknown as SwitchroomConfig["agents"][string];
    cfg.agents.misaligned = {
      microsoft_workspace: { account: "missing@account.com" },
    } as unknown as SwitchroomConfig["agents"][string];
    expect(computeMicrosoftEnabledAgents(cfg)).toEqual(["clerk"]);
  });

  it("returns [] when nothing configured", () => {
    const cfg = { agents: { clerk: {} } } as unknown as SwitchroomConfig;
    expect(computeMicrosoftEnabledAgents(cfg)).toEqual([]);
  });
});
