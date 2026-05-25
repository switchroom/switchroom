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
