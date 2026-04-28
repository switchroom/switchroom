import { describe, it, expect } from "vitest";
import { analyseVaultHealth, type VaultHealthInput } from "../src/vault/doctor.js";

// Minimal helper — all schedule entries can have empty secrets by default.
function makeInput(overrides: Partial<VaultHealthInput> = {}): VaultHealthInput {
  return {
    vaultKeys: undefined,
    agentSchedules: {},
    brokerConfigured: false,
    brokerRunning: undefined,
    ...overrides,
  };
}

describe("analyseVaultHealth", () => {
  // ── Broker checks ──────────────────────────────────────────────────────

  it("returns ok when broker not configured", () => {
    const result = analyseVaultHealth(makeInput({ brokerConfigured: false }));
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  it("returns ok when broker configured and running", () => {
    const result = analyseVaultHealth(
      makeInput({ brokerConfigured: true, brokerRunning: true })
    );
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  it("returns fail when broker configured but not running", () => {
    const result = analyseVaultHealth(
      makeInput({ brokerConfigured: true, brokerRunning: false })
    );
    const fail = result.find((d) => d.check === "broker-running");
    expect(fail).toBeDefined();
    expect(fail!.level).toBe("fail");
    expect(fail!.fix).toContain("vault broker unlock");
  });

  it("does not emit broker-running fail when brokerRunning is undefined", () => {
    const result = analyseVaultHealth(
      makeInput({ brokerConfigured: true, brokerRunning: undefined })
    );
    const fail = result.find((d) => d.check === "broker-running");
    expect(fail).toBeUndefined();
  });

  // ── Missing vault keys ─────────────────────────────────────────────────

  it("returns fail for cron secrets referencing missing vault keys", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "stripe/live-key": {},
        },
        agentSchedules: {
          "my-agent": [
            { secrets: ["stripe/live-key", "missing/key"] },
          ],
        },
      })
    );
    const fail = result.find((d) => d.check === "missing-vault-keys");
    expect(fail).toBeDefined();
    expect(fail!.level).toBe("fail");
    expect(fail!.message).toContain("missing/key");
    expect(fail!.message).toContain("my-agent/schedule[0]");
  });

  it("does not emit missing-key fail when vault keys undefined", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: undefined,
        agentSchedules: {
          "my-agent": [{ secrets: ["any/key"] }],
        },
      })
    );
    const fail = result.find((d) => d.check === "missing-vault-keys");
    expect(fail).toBeUndefined();
  });

  it("passes when all cron secrets exist in vault", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "api/key": {},
        },
        agentSchedules: {
          "my-agent": [{ secrets: ["api/key"] }],
        },
      })
    );
    const fail = result.find((d) => d.check === "missing-vault-keys");
    expect(fail).toBeUndefined();
  });

  // ── Sensitive keys without scope ───────────────────────────────────────

  it("warns on sensitive key names without scope", () => {
    const sensitiveKeys = [
      "my-oauth-token",
      "stripe-api-key",
      "db_password",
      "some-secret",
      "service-token",
    ];
    const vaultKeys: Record<string, { scope?: { allow?: string[]; deny?: string[] } }> = {};
    for (const k of sensitiveKeys) vaultKeys[k] = {};

    const result = analyseVaultHealth(makeInput({ vaultKeys }));
    const warn = result.find((d) => d.check === "sensitive-keys-unscoped");
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warn");
    for (const k of sensitiveKeys) {
      expect(warn!.message).toContain(k);
    }
  });

  it("does not warn on sensitive key that has an allow scope", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "my-oauth-token": { scope: { allow: ["agent-a"] } },
        },
      })
    );
    const warn = result.find((d) => d.check === "sensitive-keys-unscoped");
    expect(warn).toBeUndefined();
  });

  it("does not warn on sensitive key that has a deny scope", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "stripe-api-key": { scope: { deny: ["agent-b"] } },
        },
      })
    );
    const warn = result.find((d) => d.check === "sensitive-keys-unscoped");
    expect(warn).toBeUndefined();
  });

  it("does not warn on non-sensitive key names", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "telegram/bot-id": {},
          "mff/endpoint": {},
        },
      })
    );
    const warn = result.find((d) => d.check === "sensitive-keys-unscoped");
    expect(warn).toBeUndefined();
  });

  // ── Unreferenced vault keys ────────────────────────────────────────────

  it("emits info for vault keys not referenced in any schedule", () => {
    // Fixture key names must NOT be substrings of each other —
    // `expect.not.toContain("used/key")` would otherwise fail on
    // a message that legitimately includes "unused/key".
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "active/key": {},
          "stale/key": {},
        },
        agentSchedules: {
          "my-agent": [{ secrets: ["active/key"] }],
        },
      })
    );
    const info = result.find((d) => d.check === "unreferenced-vault-keys");
    expect(info).toBeDefined();
    expect(info!.level).toBe("info");
    expect(info!.message).toContain("stale/key");
    expect(info!.message).not.toContain("active/key");
  });

  it("does not emit unreferenced info when all keys are referenced", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: { "api/key": {} },
        agentSchedules: {
          "my-agent": [{ secrets: ["api/key"] }],
        },
      })
    );
    const info = result.find((d) => d.check === "unreferenced-vault-keys");
    expect(info).toBeUndefined();
  });

  // ── Multi-issue combinations ───────────────────────────────────────────

  it("returns multiple diagnostics when multiple issues exist", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: {
          "my-oauth-token": {},   // sensitive, unscoped
          "orphan/key": {},       // unreferenced
        },
        agentSchedules: {
          "my-agent": [{ secrets: ["nonexistent/key"] }], // missing key
        },
        brokerConfigured: true,
        brokerRunning: false,     // broker not running
      })
    );

    const checks = result.map((d) => d.check);
    expect(checks).toContain("broker-running");
    expect(checks).toContain("missing-vault-keys");
    expect(checks).toContain("sensitive-keys-unscoped");
    expect(checks).toContain("unreferenced-vault-keys");
  });

  it("returns single ok diagnostic when everything is healthy", () => {
    const result = analyseVaultHealth(
      makeInput({
        vaultKeys: { "reports/api-key": { scope: { allow: ["reports"] } } },
        agentSchedules: {
          "reports": [{ secrets: ["reports/api-key"] }],
        },
        brokerConfigured: true,
        brokerRunning: true,
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });
});
