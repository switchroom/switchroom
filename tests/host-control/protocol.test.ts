import { describe, it, expect } from "vitest";
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  deniedResponse,
  errorResponse,
  buildEnvelope,
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

  // Bug 1: the gated verbs gained an optional `reason` (for the operator
  // approval card's `why:` line). Assert the wire schema PERMITS it on each —
  // a `.object()` that doesn't declare `reason` would strip it on decode and
  // the forwarded rationale would silently vanish.
  it("preserves an optional `reason` on each gated verb's request args", () => {
    const cases: HostdRequest[] = [
      { v: 1, op: "rollout", request_id: "r-1", args: { pin: "v0.16.24", reason: "promote canary" } },
      { v: 1, op: "update_apply", request_id: "ua-1", args: { pin: "v0.16.24", reason: "ship fix" } },
      { v: 1, op: "agent_start", request_id: "as-1", args: { name: "scribe", reason: "bring it up" } },
      { v: 1, op: "agent_stop", request_id: "ast-1", args: { name: "scribe", reason: "drain it" } },
      { v: 1, op: "agent_logs", request_id: "al-1", args: { name: "scribe", reason: "triage wedge" } },
      { v: 1, op: "agent_exec", request_id: "ae-1", args: { name: "scribe", argv: ["ls"], reason: "inspect" } },
    ];
    for (const req of cases) {
      const decoded = decodeRequest(encodeRequest(req).trimEnd());
      expect(decoded).toEqual(req);
      expect((decoded as { args?: { reason?: string } }).args?.reason).toBeTruthy();
    }
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

describe("hostd protocol — dashboard read-ops (agent_status / agent_schedule)", () => {
  it("round-trips an agent_status request (whole fleet — name omitted)", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_status",
      request_id: "st-1",
      args: {},
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips an agent_status request narrowed to one agent", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_status",
      request_id: "st-2",
      args: { name: "clerk" },
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips an agent_schedule request (whole fleet)", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_schedule",
      request_id: "sc-1",
      args: {},
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips an agent_schedule request narrowed to one agent", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_schedule",
      request_id: "sc-2",
      args: { name: "clerk" },
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("rejects an agent name that isn't kebab-case ASCII", () => {
    const wire = JSON.stringify({
      v: 1,
      op: "agent_status",
      request_id: "st-bad",
      args: { name: "bad name!" },
    });
    expect(() => decodeRequest(wire)).toThrow();
  });

  it("round-trips the optional structured `payload` field on a completed response", () => {
    const payload = JSON.stringify({
      statuses: {
        clerk: { active: "active", uptime: "2026-06-15T00:00:00Z", memory: "256MB", pid: 7 },
      },
    });
    const resp: HostdResponse = {
      v: 1,
      request_id: "st-1",
      result: "completed",
      exit_code: 0,
      duration_ms: 12,
      payload,
    };
    const decoded = decodeResponse(encodeResponse(resp).trimEnd());
    expect(decoded).toEqual(resp);
    // The producer-shaped JSON survives intact for the caller to re-parse.
    expect(JSON.parse(decoded.payload!)).toEqual(JSON.parse(payload));
  });

  it("ResponseSchema accepts a response WITHOUT payload (backwards-compat)", () => {
    const resp: HostdResponse = {
      v: 1,
      request_id: "no-payload",
      result: "completed",
      exit_code: 0,
      duration_ms: 0,
      stdout_tail: "hi",
    };
    const decoded = decodeResponse(encodeResponse(resp).trimEnd());
    expect(decoded).toEqual(resp);
    expect(decoded.payload).toBeUndefined();
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

  // #1778 — request_id is optional. CLI emit sites (vault denial,
  // agent-config sibling JSON key) no longer fabricate placeholders;
  // hostd-path responses still thread the real RPC id through.
  it("accepts an envelope without request_id (now optional, #1778)", () => {
    const { request_id: _omit, ...rest } = base;
    void _omit;
    const r = ErrorEnvelopeSchema.safeParse(rest);
    expect(r.success).toBe(true);
  });

  it("round-trips an envelope without request_id through safeParse", () => {
    const noId = { v: 1 as const, code: "VAULT-BROKER-DENIED", human: "denied" };
    const r = ErrorEnvelopeSchema.safeParse(noId);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.request_id).toBeUndefined();
      expect(r.data).toEqual(noId);
    }
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

describe("buildEnvelope — pure constructor (#1778)", () => {
  it("produces a minimal envelope (no fix, no opts)", () => {
    const env = buildEnvelope("E_FOO", "broken");
    expect(env).toEqual({ v: 1, code: "E_FOO", human: "broken" });
    expect(env.fix).toBeUndefined();
    expect(env.request_id).toBeUndefined();
    expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("threads request_id, why, docs through opts", () => {
    const env = buildEnvelope("E_FOO", "broken", undefined, {
      why: "because",
      docs: "https://example.com/x",
      request_id: "req-9",
    });
    expect(env).toEqual({
      v: 1,
      code: "E_FOO",
      human: "broken",
      why: "because",
      docs: "https://example.com/x",
      request_id: "req-9",
    });
    expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("passes each fix.kind variant through verbatim", () => {
    const cases = [
      { kind: "flip_yaml_flag", yaml_path: "hostd.x", to: true } as const,
      { kind: "request_vault_grant", vault_key: "svc/key" } as const,
      { kind: "operator_action", subkind: "policy_denied", operator_steps: ["s1"] } as const,
      { kind: "operator_action", subkind: "infra" } as const,
      { kind: "retry_after", retry_at: "2026-01-01T00:00:00Z" } as const,
      { kind: "quota_exceeded", quota: "q", current: 1, limit: 2 } as const,
      { kind: "bad_input", field: "f" } as const,
      { kind: "bad_input" } as const,
    ];
    for (const fix of cases) {
      const env = buildEnvelope("E_FOO", "h", fix);
      expect(env.fix).toEqual(fix);
      expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(true);
    }
  });

  it("does not synthesize a fix for an unknown code (caller's job)", () => {
    const env = buildEnvelope("E_NEVER_SEEN_BEFORE", "huh");
    expect(env.fix).toBeUndefined();
  });

  it("does not validate fix payloads itself — schema is the gate", () => {
    // Missing required fields for the kind: buildEnvelope passes
    // through as-is. ErrorEnvelopeSchema.safeParse is what catches it.
    const env = buildEnvelope("E_FOO", "h", {
      // @ts-expect-error — intentionally malformed for the test
      kind: "quota_exceeded",
    });
    expect(env.fix).toEqual({ kind: "quota_exceeded" });
    expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("omits why / docs / request_id when undefined (no nullish keys leak in)", () => {
    const env = buildEnvelope("E_FOO", "h", undefined, { why: undefined });
    expect("why" in env).toBe(false);
    expect("docs" in env).toBe(false);
    expect("request_id" in env).toBe(false);
  });
});
