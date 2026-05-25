/**
 * Unit tests for the structured error builder (#1758 Phase 1).
 *
 * Verifies:
 *   - builder produces both legacy `error: string` AND `error_envelope`
 *   - legacy string format stable across every `fix.kind` variant
 *   - fire-and-forget recordErrorFriction never throws / blocks
 *   - PostHog never sees PII (human/why/docs/raw vault_key/operator_steps)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the analytics layer BEFORE importing the builder so the builder
// picks up the mocked captureEvent.
const captureEventMock = vi.fn();
vi.mock("../analytics/posthog.js", () => ({
  captureEvent: (...args: unknown[]) => captureEventMock(...args),
  getDistinctId: () => "test-distinct-id",
}));

import { err } from "./error-builder.js";

describe("error-builder — wire shape", () => {
  beforeEach(() => {
    captureEventMock.mockReset();
  });

  it("produces both legacy `error` and `error_envelope`", () => {
    const resp = err("E_CONFIG_EDIT_DISABLED", "config_propose_edit is disabled")
      .why("operator opt-in per RFC §3.3")
      .fixFlipFlag("hostd.config_edit_enabled", true)
      .docs("https://switchroom.dev/docs/config-edit#opt-in")
      .op("config_propose_edit")
      .caller("agent")
      .agentName("klanker")
      .build("req-1", 42);

    expect(resp.result).toBe("error");
    expect(resp.exit_code).toBeNull();
    expect(resp.duration_ms).toBe(42);
    expect(resp.error).toBe(
      "E_CONFIG_EDIT_DISABLED: config_propose_edit is disabled — operator opt-in per RFC §3.3",
    );
    expect(resp.error_envelope).toEqual({
      v: 1,
      code: "E_CONFIG_EDIT_DISABLED",
      human: "config_propose_edit is disabled",
      why: "operator opt-in per RFC §3.3",
      fix: {
        kind: "flip_yaml_flag",
        yaml_path: "hostd.config_edit_enabled",
        to: true,
      },
      docs: "https://switchroom.dev/docs/config-edit#opt-in",
      request_id: "req-1",
    });
  });

  it("legacy `error` string format stable across fix.kind variants", () => {
    const cases: Array<{ name: string; build: () => string | undefined }> = [
      {
        name: "no fix",
        build: () => err("E_FOO", "bar").build("r", 0).error,
      },
      {
        name: "flip_yaml_flag",
        build: () => err("E_FOO", "bar").fixFlipFlag("a.b", 1).build("r", 0).error,
      },
      {
        name: "request_vault_grant",
        build: () => err("E_FOO", "bar").fixVaultGrant("foo/bar").build("r", 0).error,
      },
      {
        name: "operator_action",
        build: () => err("E_FOO", "bar").fixOperatorAction("policy_denied", ["step1"]).build("r", 0).error,
      },
      {
        name: "retry_after",
        build: () => err("E_FOO", "bar").fixRetryAfter("2026-01-01T00:00:00Z").build("r", 0).error,
      },
      {
        name: "quota_exceeded",
        build: () => err("E_FOO", "bar").fixQuotaExceeded("q", 1, 2).build("r", 0).error,
      },
      {
        name: "bad_input",
        build: () => err("E_FOO", "bar").fixBadInput("field").build("r", 0).error,
      },
    ];
    for (const c of cases) {
      const s = c.build();
      expect(s, c.name).toBe("E_FOO: bar"); // why undefined → no suffix
    }
    // Sanity check with .why()
    const withWhy = err("E_FOO", "bar").why("reason").build("r", 0).error;
    expect(withWhy).toBe("E_FOO: bar — reason");
  });

  it(".build() never throws even if telemetry blows up", () => {
    captureEventMock.mockImplementationOnce(() => {
      throw new Error("posthog gone wrong");
    });
    expect(() =>
      err("E_FOO", "bar").build("r", 0),
    ).not.toThrow();
  });

  it("PII discipline — captureEvent never sees human/why/docs/raw vault_key/operator_steps", () => {
    err("VAULT-BROKER-DENIED", "PII-SENSITIVE-HUMAN")
      .why("PII-SENSITIVE-WHY")
      .fixVaultGrant("openai/api-key-VERY-SECRET")
      .docs("https://docs.example.com/PII-SENSITIVE-DOCS")
      .op("vault_request_access")
      .caller("agent")
      .agentName("klanker")
      .build("req-vault", 0);

    expect(captureEventMock).toHaveBeenCalledTimes(1);
    const [event, props] = captureEventMock.mock.calls[0]!;
    expect(event).toBe("switchroom_error_friction");
    const json = JSON.stringify(props);
    expect(json).not.toContain("PII-SENSITIVE-HUMAN");
    expect(json).not.toContain("PII-SENSITIVE-WHY");
    expect(json).not.toContain("PII-SENSITIVE-DOCS");
    expect(json).not.toContain("openai/api-key-VERY-SECRET");
    // sha256 first 16 hex chars
    expect(props.vault_key_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(props.code).toBe("VAULT-BROKER-DENIED");
    expect(props.fix_kind).toBe("request_vault_grant");
    expect(props.has_docs).toBe(true);
  });

  it("operator_steps content stays out of PostHog", () => {
    err("E_FOO", "human")
      .fixOperatorAction("policy_denied", ["PII-STEP-1", "PII-STEP-2"])
      .op("foo")
      .caller("agent")
      .build("r", 0);
    const [, props] = captureEventMock.mock.calls[0]!;
    const json = JSON.stringify(props);
    expect(json).not.toContain("PII-STEP-1");
    expect(json).not.toContain("PII-STEP-2");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
