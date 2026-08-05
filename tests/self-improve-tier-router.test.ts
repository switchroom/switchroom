import { describe, it, expect } from "vitest";

import { classifyTier } from "../src/self-improve/tier-router.js";
import type { ChangeCandidate } from "../src/self-improve/types.js";

const cfg = {
  repetitionThreshold: 2,
  t1MaxChangedLines: 30,
  t1MaxGrowthBytes: 4096,
  maxAutoAppliesPerDay: 3,
  maxOutstandingPending: 5,
};

function candidate(over: Partial<ChangeCandidate>): ChangeCandidate {
  return {
    lesson: "exclude drafts from the digest",
    proposedChange: "add a draft filter to the digest skill",
    ...over,
  };
}

describe("tier router — T1 (auto, silent)", () => {
  it("classifies a small reversible owned single-file edit as T1", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 8 }),
      cfg,
    );
    expect(d.tier).toBe("T1");
  });

  it("treats a one-line owned edit as T1", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 1 }),
      cfg,
    );
    expect(d.tier).toBe("T1");
  });
});

describe("tier router — T2 (propose, never auto-apply in slice 1)", () => {
  it("downgrades to T2 when the agent does NOT own the skill", () => {
    const d = classifyTier(
      candidate({ skillSlug: "shared-thing", ownsSkill: false, changedLines: 5 }),
      cfg,
    );
    expect(d.tier).toBe("T2");
  });

  it("downgrades to T2 when there is no skill target at all", () => {
    const d = classifyTier(candidate({}), cfg);
    expect(d.tier).toBe("T2");
  });

  it("downgrades to T2 when the diff exceeds the T1 cap", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 31 }),
      cfg,
    );
    expect(d.tier).toBe("T2");
    expect(d.reason).toContain("31");
  });

  it("downgrades to T2 when the edit spans multiple files", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 4, multiFile: true }),
      cfg,
    );
    expect(d.tier).toBe("T2");
  });
});

describe("tier router — T3 (ask explicitly; the on-leash floor)", () => {
  it("forces T3 for a new cron, even if otherwise tiny + owned", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 2, touchesCron: true }),
      cfg,
    );
    expect(d.tier).toBe("T3");
  });

  it("forces T3 for a new skill", () => {
    const d = classifyTier(
      candidate({ skillSlug: "brand-new", ownsSkill: true, changedLines: 2, createsNewSkill: true }),
      cfg,
    );
    expect(d.tier).toBe("T3");
  });

  it("forces T3 for a cross-agent change", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 2, crossAgent: true }),
      cfg,
    );
    expect(d.tier).toBe("T3");
  });

  it("forces T3 for an irreversible change", () => {
    const d = classifyTier(
      candidate({ skillSlug: "digest", ownsSkill: true, changedLines: 2, irreversible: true }),
      cfg,
    );
    expect(d.tier).toBe("T3");
  });
});

describe("tier router — T0", () => {
  it("returns T0 when nothing is proposed", () => {
    const d = classifyTier(candidate({ proposedChange: "" }), cfg);
    expect(d.tier).toBe("T0");
  });
});
