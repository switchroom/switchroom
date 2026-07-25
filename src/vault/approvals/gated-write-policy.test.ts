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
  evaluateGatedWrite,
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

/**
 * `evaluateGatedWrite` is the three-way classifier EVERY gate site in
 * both write hooks calls (drive fast path, drive poll loop, ms-365 poll
 * loop). The review of #3598 mutation-tested the hooks and found the
 * poll-loop site deletable with the suite green, because the rule was
 * inlined per site. It now lives here, once, and these tests are what
 * make the rule covered no matter which call site invokes it.
 */
describe("evaluateGatedWrite — the shared three-way gate", () => {
  it("SECURITY: a live grant that is not operator-verified BLOCKS, never waits", () => {
    // Blocking rather than waiting matters: a `wait` here would spin the
    // hook to its deadline and (in the Drive hook) post the operator a
    // card that would then be self-refused.
    for (const origin of ["agent", undefined] as const) {
      const a = evaluateGatedWrite({ state: "granted", origin }, true);
      expect(a.kind).toBe("block");
      if (a.kind === "block") expect(a.reason).toContain("not proof an operator tapped");
    }
  });

  it("allows an operator-verified grant with the requirement on", () => {
    expect(evaluateGatedWrite({ state: "granted", origin: "operator" }, true).kind).toBe("allow");
  });

  it("flag OFF is a pure no-op: any granted decision allows, origin untouched", () => {
    for (const origin of ["agent", "operator", undefined] as const) {
      expect(evaluateGatedWrite({ state: "granted", origin }, false).kind).toBe("allow");
    }
  });

  it("non-terminal / terminal non-grant states WAIT so each hook keeps its own handling", () => {
    for (const s of ["pending", "no_decision", "denied", "expired", "drift_revoked", null]) {
      for (const req of [true, false]) {
        expect(evaluateGatedWrite({ state: s, origin: "operator" }, req).kind).toBe("wait");
      }
    }
  });
});
