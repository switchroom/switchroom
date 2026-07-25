/**
 * Unit tests for the gated-write approval predicate — the pure half of
 * the self-approval-bypass fix. The socket-level attack is exercised in
 * `self-approval-bypass.test.ts`; here we pin the decision table itself,
 * including the fail-closed handling of a MISSING origin (old kernel on a
 * mixed-version rollout).
 */
import { describe, it, expect } from "vitest";
import {
  isGatedWriteApproved,
  requireOperatorApprovalForWrites,
  REQUIRE_OPERATOR_WRITE_ENV,
} from "./gated-write-policy.js";

describe("requireOperatorApprovalForWrites", () => {
  it("is OFF by default (no host verifier ⇒ default-on would deny every legitimate write)", () => {
    expect(requireOperatorApprovalForWrites({})).toBe(false);
  });
  it("is ON only for the exact string '1'", () => {
    expect(requireOperatorApprovalForWrites({ [REQUIRE_OPERATOR_WRITE_ENV]: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", "01", " 1"]) {
      expect(requireOperatorApprovalForWrites({ [REQUIRE_OPERATOR_WRITE_ENV]: v })).toBe(false);
    }
  });
});

describe("isGatedWriteApproved — requirement OFF (shipped default)", () => {
  it("allows a granted decision regardless of origin (documents the residual exposure)", () => {
    expect(isGatedWriteApproved({ state: "granted", origin: "agent" }, false).allow).toBe(true);
    expect(isGatedWriteApproved({ state: "granted", origin: "operator" }, false).allow).toBe(true);
    expect(isGatedWriteApproved({ state: "granted" }, false).allow).toBe(true);
  });
  it("still refuses every non-granted state", () => {
    for (const s of ["pending", "denied", "expired", "drift_revoked", "no_decision", null]) {
      expect(isGatedWriteApproved({ state: s }, false).allow).toBe(false);
    }
  });
});

describe("isGatedWriteApproved — requirement ON", () => {
  it("SECURITY: refuses a granted decision with origin='agent' (the self-forgery)", () => {
    const v = isGatedWriteApproved({ state: "granted", origin: "agent" }, true);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toContain("origin='agent'");
  });

  it("SECURITY: refuses a granted decision with NO origin (pre-origin kernel — fail closed)", () => {
    const v = isGatedWriteApproved({ state: "granted" }, true);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toContain("origin='unknown'");
  });

  it("SECURITY: an unexpected origin value is refused, not coerced", () => {
    const v = isGatedWriteApproved(
      { state: "granted", origin: "OPERATOR" as unknown as "operator" },
      true,
    );
    expect(v.allow).toBe(false);
  });

  it("accepts a granted decision with origin='operator' (legitimate tap keeps working)", () => {
    expect(isGatedWriteApproved({ state: "granted", origin: "operator" }, true).allow).toBe(true);
  });

  it("refuses every non-granted state even with origin='operator'", () => {
    for (const s of ["pending", "denied", "expired", "drift_revoked", "no_decision", null]) {
      const v = isGatedWriteApproved({ state: s, origin: "operator" }, true);
      expect(v.allow).toBe(false);
      if (!v.allow) expect(v.reason).toContain("not 'granted'");
    }
  });
});
