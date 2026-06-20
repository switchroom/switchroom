import { describe, it, expect } from "vitest";

import { buildReviewPrompt, REVIEW_SOURCE } from "../src/self-improve/review-prompt.js";
import type { LearningSignal } from "../src/self-improve/types.js";

const signals: LearningSignal[] = [
  {
    kind: "operator-correction",
    reason: "Operator pushed back 2x this turn",
    occurrences: 2,
    evidence: "no, that's wrong — exclude drafts",
  },
];

describe("forked-review prompt", () => {
  it("names the source discriminator", () => {
    expect(REVIEW_SOURCE).toBe("self_improve_review");
  });

  it("restricts the toolset and forbids replying", () => {
    const p = buildReviewPrompt(signals);
    expect(p).toContain("[self-improvement review]");
    expect(p.toLowerCase()).toContain("only memory tools");
    expect(p.toLowerCase()).toContain("skill");
    expect(p.toLowerCase()).toContain("do not reply");
  });

  it("carries the detected signals and the tier contract", () => {
    const p = buildReviewPrompt(signals);
    expect(p).toContain("operator-correction");
    expect(p).toContain("T1");
    expect(p).toContain("T2");
    expect(p).toContain("T3");
    // Eval gate is part of the contract handed to the review.
    expect(p).toContain("evals.json");
  });

  it("states that new crons / new skills are never self-served", () => {
    const p = buildReviewPrompt(signals);
    expect(p.toLowerCase()).toContain("never auto-create");
  });
});
