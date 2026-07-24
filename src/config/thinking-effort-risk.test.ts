import { describe, it, expect } from "vitest";
import {
  assessThinkingEffortRisk,
  isAdaptiveThinkingOpus,
} from "./thinking-effort-risk.js";

describe("isAdaptiveThinkingOpus", () => {
  it("matches the opus alias and pinned opus-4.x / opus-5 ids", () => {
    expect(isAdaptiveThinkingOpus("opus")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-4-8")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-4-7")).toBe(true);
    expect(isAdaptiveThinkingOpus("CLAUDE-OPUS-4-8")).toBe(true); // case-insensitive
    expect(isAdaptiveThinkingOpus("claude-opus-5")).toBe(true);
    expect(isAdaptiveThinkingOpus("claude-opus-5-20260501")).toBe(true); // future date-stamped pin
    expect(isAdaptiveThinkingOpus("CLAUDE-OPUS-5")).toBe(true); // case-insensitive
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
  it("flags Opus 4.x with effort above the low floor", () => {
    for (const effort of ["medium", "high", "xhigh", "max"]) {
      const r = assessThinkingEffortRisk("claude-opus-4-8", effort);
      expect(r.risky).toBe(true);
      expect(r.reason).toContain("thinking");
    }
    expect(assessThinkingEffortRisk("opus", "medium").risky).toBe(true);
  });

  it("flags Opus 5 with effort above the low floor", () => {
    expect(assessThinkingEffortRisk("claude-opus-5", "high").risky).toBe(true);
    expect(assessThinkingEffortRisk("claude-opus-5-20260501", "max").risky).toBe(true);
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
