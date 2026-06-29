import { describe, it, expect } from "vitest";
import { classifyTier } from "./tier-router.js";
import type { ChangeCandidate } from "./types.js";

describe("tier-router synthesized-personal-skill carve-out (#2670)", () => {
  it("routes a synthesized NEW personal skill to T2 (one-tap)", () => {
    const c: ChangeCandidate = {
      lesson: "x",
      proposedChange: "add a new personal skill",
      createsNewSkill: true,
      proposalKind: "synthesized-personal-skill",
    };
    const d = classifyTier(c);
    expect(d.tier).toBe("T2");
    expect(d.reason).toMatch(/one-tap/);
  });

  it("keeps a plain new skill (no provenance) at T3", () => {
    const c: ChangeCandidate = {
      lesson: "x",
      proposedChange: "add a new skill",
      createsNewSkill: true,
    };
    expect(classifyTier(c).tier).toBe("T3");
  });

  it("never lets the carve-out override the cron T3 floor", () => {
    const c: ChangeCandidate = {
      lesson: "x",
      proposedChange: "add a cron",
      touchesCron: true,
      createsNewSkill: true,
      proposalKind: "synthesized-personal-skill",
    };
    expect(classifyTier(c).tier).toBe("T3");
  });

  it("never lets the carve-out override the cross-agent T3 floor", () => {
    const c: ChangeCandidate = {
      lesson: "x",
      proposedChange: "reach another agent",
      crossAgent: true,
      createsNewSkill: true,
      proposalKind: "synthesized-personal-skill",
    };
    expect(classifyTier(c).tier).toBe("T3");
  });

  it("never lets the carve-out override the irreversible T3 floor", () => {
    const c: ChangeCandidate = {
      lesson: "x",
      proposedChange: "irreversible",
      irreversible: true,
      createsNewSkill: true,
      proposalKind: "synthesized-personal-skill",
    };
    expect(classifyTier(c).tier).toBe("T3");
  });
});
