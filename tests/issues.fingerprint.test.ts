import { describe, it, expect } from "vitest";
import { computeFingerprint } from "../src/issues/fingerprint.js";

describe("computeFingerprint", () => {
  it("is a stable function of (source, code)", () => {
    expect(computeFingerprint("hook:handoff", "cli-error")).toBe(
      "hook:handoff::cli-error",
    );
    // Same inputs → same output, idempotent.
    expect(computeFingerprint("hook:handoff", "cli-error")).toBe(
      computeFingerprint("hook:handoff", "cli-error"),
    );
  });

  it("distinguishes different sources", () => {
    expect(computeFingerprint("hook:handoff", "cli-error")).not.toBe(
      computeFingerprint("hook:other", "cli-error"),
    );
  });

  it("distinguishes different codes", () => {
    expect(computeFingerprint("boot:auth-check", "expired")).not.toBe(
      computeFingerprint("boot:auth-check", "missing"),
    );
  });

  it("rejects empty source", () => {
    expect(() => computeFingerprint("", "code")).toThrow(/source is required/);
  });

  it("rejects empty code", () => {
    expect(() => computeFingerprint("source", "")).toThrow(/code is required/);
  });
});
