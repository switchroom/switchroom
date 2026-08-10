import { describe, it, expect } from "vitest";
import {
  assessThinkingEffortRisk,
  isAdaptiveThinkingOpus,
} from "./thinking-effort-risk.js";

describe("isAdaptiveThinkingOpus", () => {
  it("matches pinned opus-4.x ids", () => {
    expect(isAdaptiveThinkingOpus("claude-opus-4")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-4-8")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-4-7")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-4-1-20250805")).toBe(true);
    expect(isAdaptiveThinkingOpus("CLAUDE-OPUS-4-8")).toBe(true); // case-insensitive
    expect(isAdaptiveThinkingOpus("  claude-opus-4-8  ")).toBe(true); // trimmed
  });

  // The #1978 CLI merge bug was fixed upstream in claude-code 2.1.156 (pinned
  // by switchroom v0.14.8; docker/Dockerfile.base pins a later build). The guard
  // is legacy scope for pinned Opus 4.x only, so Opus 5 must NOT be flagged.
  it("does NOT match Opus 5 (bug fixed upstream at CLI 2.1.156)", () => {
    expect(isAdaptiveThinkingOpus("claude-opus-5")).toBe(false);
    expect(isAdaptiveThinkingOpus("claude-opus-5-20260501")).toBe(false);
    expect(isAdaptiveThinkingOpus("CLAUDE-OPUS-5")).toBe(false);
    expect(isAdaptiveThinkingOpus("claude-opus-6")).toBe(false);
  });

  // The bare alias resolves to the CLI's current default Opus (Opus 5 on the
  // pinned build), so matching it would flag Opus 5 by proxy.
  it("does NOT match the bare `opus` alias", () => {
    expect(isAdaptiveThinkingOpus("opus")).toBe(false);
    expect(isAdaptiveThinkingOpus("OPUS")).toBe(false);
    expect(isAdaptiveThinkingOpus(" opus ")).toBe(false);
  });

  it("does not match sonnet/haiku or unset", () => {
    expect(isAdaptiveThinkingOpus("sonnet")).toBe(false);
    expect(isAdaptiveThinkingOpus("claude-sonnet-5")).toBe(false);
    expect(isAdaptiveThinkingOpus("haiku")).toBe(false);
    expect(isAdaptiveThinkingOpus(undefined)).toBe(false);
    expect(isAdaptiveThinkingOpus("")).toBe(false);
  });
});

describe("assessThinkingEffortRisk", () => {
  it("flags pinned Opus 4.x with effort above the low floor", () => {
    for (const effort of ["medium", "high", "xhigh", "max"]) {
      const r = assessThinkingEffortRisk("claude-opus-4-8", effort);
      expect(r.risky).toBe(true);
      expect(r.reason).toContain("thinking");
    }
  });

  // Regression guard for the fleet default moving off the `low` floor: an
  // Opus 5 (or `opus`-alias) agent at medium/high must produce NO doctor warn.
  it("does NOT flag Opus 5 or the `opus` alias at any effort", () => {
    for (const model of ["claude-opus-5", "claude-opus-5-20260501", "opus"]) {
      for (const effort of ["medium", "high", "xhigh", "max"]) {
        const r = assessThinkingEffortRisk(model, effort);
        expect(r.risky).toBe(false);
        expect(r.reason).toBeUndefined();
      }
    }
  });

  it("is safe when effort is the floor or unset (scaffold defaults to low)", () => {
    expect(assessThinkingEffortRisk("claude-opus-4-8", "low").risky).toBe(false);
    expect(assessThinkingEffortRisk("claude-opus-4-8", undefined).risky).toBe(false);
    expect(assessThinkingEffortRisk("opus", undefined).risky).toBe(false);
  });

  it("is safe for non-Opus models even at high effort", () => {
    expect(assessThinkingEffortRisk("claude-sonnet-5", "high").risky).toBe(false);
    expect(assessThinkingEffortRisk("sonnet", "max").risky).toBe(false);
    expect(assessThinkingEffortRisk("haiku", "medium").risky).toBe(false);
  });

  it("normalizes case/whitespace on the effort value", () => {
    expect(assessThinkingEffortRisk("claude-opus-4-8", " MEDIUM ").risky).toBe(true);
  });
});
