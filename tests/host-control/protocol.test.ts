import { describe, it, expect } from "vitest";
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  deniedResponse,
  errorResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  ErrorFixSchema,
  ErrorEnvelopeSchema,
  type HostdRequest,
  type HostdResponse,
} from "../../src/host-control/protocol.js";

describe("hostd protocol — framing & schema", () => {
  it("round-trips an agent_restart request", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_restart",
      request_id: "abc-123",
      args: { name: "klanker", reason: "user", force: true },
    };
    const wire = encodeRequest(req);
    expect(wire.endsWith("\n")).toBe(true);
    const decoded = decodeRequest(wire.trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips an upgrade_status request without args", () => {
    const req: HostdRequest = {
      v: 1,
      op: "upgrade_status",
      request_id: "abc-456",
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips a doctor request without args", () => {
    const req: HostdRequest = {
      v: 1,
      op: "doctor",
      request_id: "doc-001",
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips a get_status request", () => {
    const req: HostdRequest = {
      v: 1,
      op: "get_status",
      request_id: "abc-789",
      args: { target_request_id: "abc-123" },
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("rejects unknown op", () => {
    expect(() => decodeRequest(JSON.stringify({ v: 1, op: "delete_everything", request_id: "x" }))).toThrow();
  });

  it("rejects v != 1", () => {
    expect(() =>
      decodeRequest(
        JSON.stringify({ v: 2, op: "upgrade_status", request_id: "x" }),
      ),
    ).toThrow();
  });

  it("rejects agent names with bad characters", () => {
    expect(() =>
      decodeRequest(
        JSON.stringify({
          v: 1,
          op: "agent_restart",
          request_id: "x",
          args: { name: "klanker;rm -rf /" },
        }),
      ),
    ).toThrow();
  });

  it("rejects oversized frames", () => {
    const big = "x".repeat(MAX_FRAME_BYTES + 10);
    expect(() => decodeRequest(big)).toThrow(RangeError);
  });

  it("round-trips a response", () => {
    const resp: HostdResponse = {
      v: 1,
      request_id: "abc-123",
      result: "completed",
      exit_code: 0,
      duration_ms: 42,
      stdout_tail: "ok",
    };
    const decoded = decodeResponse(encodeResponse(resp).trimEnd());
    expect(decoded).toEqual(resp);
  });

  it("deniedResponse / errorResponse have null exit_code", () => {
    expect(deniedResponse("x", "nope").exit_code).toBeNull();
    expect(errorResponse("x", "boom").exit_code).toBeNull();
  });

  it("exposes the idempotency window constant", () => {
    // Pinned to gateway's restart-marker debounce.
    expect(IDEMPOTENCY_WINDOW_MS).toBe(15_000);
  });
});

describe("error_envelope — #1758 Phase 1 round-trip", () => {
  const variants: Array<{ name: string; fix: unknown }> = [
    { name: "flip_yaml_flag", fix: { kind: "flip_yaml_flag", yaml_path: "hostd.config_edit_enabled", to: true } },
    { name: "request_vault_grant", fix: { kind: "request_vault_grant", vault_key: "openai/api-key" } },
    { name: "operator_action no steps", fix: { kind: "operator_action", subkind: "policy_denied" } },
    { name: "operator_action with steps", fix: { kind: "operator_action", subkind: "infra", operator_steps: ["restart gateway"] } },
    { name: "retry_after", fix: { kind: "retry_after", retry_at: "2026-01-01T00:00:00Z" } },
    { name: "quota_exceeded", fix: { kind: "quota_exceeded", quota: "cron-entries", current: 20, limit: 20 } },
    { name: "bad_input", fix: { kind: "bad_input", field: "agent_name" } },
    { name: "bad_input no field", fix: { kind: "bad_input" } },
  ];
  for (const v of variants) {
    it(`survives encode/decode round-trip — ${v.name}`, () => {
      const resp: HostdResponse = {
        v: 1,
        request_id: "rt-1",
        result: "error",
        exit_code: null,
        duration_ms: 0,
        error: "E_FOO: human",
        error_envelope: {
          v: 1,
          code: "E_FOO",
          human: "human",
          fix: v.fix as never,
          request_id: "rt-1",
        },
      };
      const decoded = decodeResponse(encodeResponse(resp).trimEnd());
      expect(decoded).toEqual(resp);
    });
  }

  it("ResponseSchema accepts a response WITHOUT error_envelope (backwards-compat)", () => {
    const resp: HostdResponse = {
      v: 1,
      request_id: "rt-bc",
      result: "completed",
      exit_code: 0,
      duration_ms: 0,
    };
    const decoded = decodeResponse(encodeResponse(resp).trimEnd());
    expect(decoded).toEqual(resp);
  });
});

// ─────────────────────────────────────────────────────────────────────
// #1761 Phase 2: negative-path schema tests. The discriminator is the
// integrity boundary for the unlock-card path — every garbage shape it
// silently accepts becomes a load-bearing allowlist bypass for the
// gateway-side renderer. Pin the rejections.
// ─────────────────────────────────────────────────────────────────────

describe("ErrorFixSchema — negative paths (#1761)", () => {
  it("rejects an unknown fix.kind", () => {
    const r = ErrorFixSchema.safeParse({ kind: "magic_unlock", token: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects request_vault_grant without vault_key", () => {
    const r = ErrorFixSchema.safeParse({ kind: "request_vault_grant" });
    expect(r.success).toBe(false);
  });

  it("rejects flip_yaml_flag without yaml_path", () => {
    const r = ErrorFixSchema.safeParse({ kind: "flip_yaml_flag", to: true });
    expect(r.success).toBe(false);
  });

  it("rejects operator_action with an unknown subkind", () => {
    const r = ErrorFixSchema.safeParse({
      kind: "operator_action",
      subkind: "smells_bad",
    });
    expect(r.success).toBe(false);
  });

  it("rejects operator_action with an empty operator_steps array", () => {
    const r = ErrorFixSchema.safeParse({
      kind: "operator_action",
      subkind: "policy_denied",
      operator_steps: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects quota_exceeded missing limit", () => {
    const r = ErrorFixSchema.safeParse({
      kind: "quota_exceeded",
      quota: "cron-entries",
      current: 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects retry_after missing retry_at", () => {
    const r = ErrorFixSchema.safeParse({ kind: "retry_after" });
    expect(r.success).toBe(false);
  });

  it("accepts bad_input without field (field is optional)", () => {
    const r = ErrorFixSchema.safeParse({ kind: "bad_input" });
    expect(r.success).toBe(true);
  });
});

describe("ErrorEnvelopeSchema — negative paths (#1761)", () => {
  const base = {
    v: 1 as const,
    code: "E_OK",
    human: "fine",
    request_id: "r-1",
  };

  it("rejects a non-URL docs string", () => {
    const r = ErrorEnvelopeSchema.safeParse({
      ...base,
      docs: "not-a-url-just-a-slug",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a fully-qualified docs URL", () => {
    const r = ErrorEnvelopeSchema.safeParse({
      ...base,
      docs: "https://switchroom.dev/docs/foo",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a lowercase code (e_lowercase)", () => {
    const r = ErrorEnvelopeSchema.safeParse({ ...base, code: "e_lowercase" });
    expect(r.success).toBe(false);
  });

  it("rejects a bare-word code without the E_ / VAULT- prefix", () => {
    const r = ErrorEnvelopeSchema.safeParse({ ...base, code: "FOO" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty human string", () => {
    const r = ErrorEnvelopeSchema.safeParse({ ...base, human: "" });
    expect(r.success).toBe(false);
  });

  it("rejects a missing request_id", () => {
    const { request_id: _omit, ...rest } = base;
    void _omit;
    const r = ErrorEnvelopeSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("accepts the VAULT- prefix shape", () => {
    const r = ErrorEnvelopeSchema.safeParse({
      ...base,
      code: "VAULT-BROKER-DENIED",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an envelope whose nested fix fails the discriminator", () => {
    const r = ErrorEnvelopeSchema.safeParse({
      ...base,
      fix: { kind: "magic_unlock" },
    });
    expect(r.success).toBe(false);
  });
});
