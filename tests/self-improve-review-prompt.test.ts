import { describe, it, expect } from "vitest";

import {
  buildReviewPrompt,
  REVIEW_SOURCE,
  REVIEW_MARKER,
  isReviewInjectedText,
} from "../src/self-improve/review-prompt.js";
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

describe("isReviewInjectedText — robust review-turn detection (issue #2462)", () => {
  it("matches the CHANNEL-WRAPPED form (the shape that broke startsWith)", () => {
    const wrapped =
      `<channel source="${REVIEW_SOURCE}" chat_id="1" ts="1">` +
      `${REVIEW_MARKER} blah evidence: no, that's wrong</channel>`;
    expect(isReviewInjectedText(wrapped)).toBe(true);
  });

  it("matches single-quoted and attribute-reordered channel envelopes", () => {
    expect(
      isReviewInjectedText(
        `<channel chat_id="1" source='${REVIEW_SOURCE}'>${REVIEW_MARKER} x</channel>`,
      ),
    ).toBe(true);
  });

  it("matches the BARE banner (older transcripts / unit tests)", () => {
    expect(isReviewInjectedText(`${REVIEW_MARKER} the gate detected a signal`)).toBe(true);
  });

  it("matches the banner even when not at the very start (not startsWith)", () => {
    expect(isReviewInjectedText(`leading noise ${REVIEW_MARKER} ...`)).toBe(true);
  });

  it("does NOT match an ordinary operator turn", () => {
    expect(isReviewInjectedText("No, that's wrong — exclude drafts")).toBe(false);
    expect(isReviewInjectedText("")).toBe(false);
    expect(
      isReviewInjectedText('<channel source="telegram" chat_id="1">hi</channel>'),
    ).toBe(false);
  });
});
