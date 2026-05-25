/**
 * Telegram bridge unlock-card safety (#1758 Phase 1).
 *
 * The bridge MUST validate `flip_yaml_flag.yaml_path` against the
 * config-edit-validator allowlist before rendering a one-tap approval
 * card. A malformed or hostile envelope from any backend could
 * otherwise nudge the operator into approving an arbitrary flag flip.
 */

import { describe, it, expect } from "vitest";
import { renderErrorEnvelopeCard } from "../gateway/error-envelope-card.js";
import type { HostdResponse } from "../../src/host-control/protocol.js";

function mkResp(fix: HostdResponse["error_envelope"]["fix"]): HostdResponse {
  return {
    v: 1,
    request_id: "r-1",
    result: "error",
    exit_code: null,
    duration_ms: 0,
    error: "E_FOO: foo",
    error_envelope: {
      v: 1,
      code: "E_FOO",
      human: "foo",
      fix,
      request_id: "r-1",
    },
  } as HostdResponse;
}

describe("renderErrorEnvelopeCard — allowlist guard", () => {
  it("renders an approval card for an allowlisted yaml_path", () => {
    const resp = mkResp({
      kind: "flip_yaml_flag",
      yaml_path: "hostd.config_edit_enabled",
      to: true,
    });
    const out = renderErrorEnvelopeCard(resp, "klanker", "a".repeat(32));
    expect(out.kind).toBe("card");
    if (out.kind === "card") {
      expect(out.yaml_path).toBe("hostd.config_edit_enabled");
      expect(out.to).toBe(true);
      expect(out.card.text).toContain("klanker");
    }
  });

  it("falls back to plain-text for a NON-allowlisted yaml_path", () => {
    const resp = mkResp({
      kind: "flip_yaml_flag",
      yaml_path: "hostd.evil_backdoor_flag",
      to: true,
    });
    const out = renderErrorEnvelopeCard(resp, "klanker", "a".repeat(32));
    expect(out).toEqual({ kind: "plain-text" });
  });

  it("falls back to plain-text for request_vault_grant (Phase 2 scope)", () => {
    const resp = mkResp({
      kind: "request_vault_grant",
      vault_key: "openai/api-key",
    });
    const out = renderErrorEnvelopeCard(resp, "klanker", "a".repeat(32));
    expect(out).toEqual({ kind: "plain-text" });
  });

  it("falls back to plain-text when no envelope is present", () => {
    const resp: HostdResponse = {
      v: 1,
      request_id: "r-1",
      result: "error",
      exit_code: null,
      duration_ms: 0,
      error: "legacy string",
    };
    const out = renderErrorEnvelopeCard(resp, "klanker", "a".repeat(32));
    expect(out).toEqual({ kind: "plain-text" });
  });
});
