import { describe, it, expect } from "vitest";

import {
  buildReviewPrompt,
  isReviewTurn,
  REVIEW_BANNER,
  REVIEW_SOURCE,
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

  it("opens with the shared banner constant (builder/detector single source)", () => {
    expect(buildReviewPrompt(signals).startsWith(REVIEW_BANNER)).toBe(true);
  });

  it("step-5 add-eval-case example passes the REQUIRED --chat flag (R3)", () => {
    // `switchroom self-improve add-eval-case` has `.requiredOption("--chat")`,
    // so a review turn running the documented command verbatim WITHOUT --chat
    // hits a commander error. The example must carry --chat, and must steer
    // the agent to the real operator chat id (not the review placeholder).
    const p = buildReviewPrompt(signals);
    expect(p).toContain("add-eval-case");
    expect(p).toContain("--chat");
    // The example command names both required options together.
    const cmd = p.slice(p.indexOf("add-eval-case"));
    expect(cmd).toMatch(/--skill[\s\S]*--chat|--chat[\s\S]*--skill/);
    // Steers to the operator chat id, not the review turn's placeholder.
    expect(p.toLowerCase()).toContain("operator chat id");
  });
});

describe("isReviewTurn — review-turn detector (issue #2462)", () => {
  const prompt = buildReviewPrompt(signals);

  it("detects the bare banner shape (unit/legacy)", () => {
    expect(isReviewTurn(prompt)).toBe(true);
    expect(isReviewTurn(REVIEW_BANNER + " anything")).toBe(true);
  });

  it("detects the REAL channel-wrapped runtime shape (the loop bug)", () => {
    // The gateway wraps every injected inbound in a <channel …> envelope with
    // our source marker before it lands in the transcript, so the banner is
    // NOT at offset 0. The old `startsWith(BANNER)` missed this entirely.
    const wrapped =
      `<channel source="switchroom-telegram" source="${REVIEW_SOURCE}" ` +
      `triggering_session="abc123">\n${prompt}`;
    expect(wrapped.startsWith(REVIEW_BANNER)).toBe(false); // the trap the old code fell into
    expect(isReviewTurn(wrapped)).toBe(true);
  });

  it("detects a wrapped turn via the banner even if the source marker moves", () => {
    const wrapped = `<channel source="switchroom-telegram">\n${prompt}`;
    expect(isReviewTurn(wrapped)).toBe(true);
  });

  it("does NOT misfire on a normal operator message or a non-review channel inbound", () => {
    expect(isReviewTurn("Resolve bug 2462")).toBe(false);
    expect(isReviewTurn("")).toBe(false);
    expect(
      isReviewTurn(
        `<channel source="switchroom-telegram" source="cron">\nPriority mail watcher tick.`,
      ),
    ).toBe(false);
    // A message that merely mentions the banner mid-text is not a review turn.
    expect(
      isReviewTurn("FYI the gate emits a [self-improvement review] turn when it trips."),
    ).toBe(false);
  });
});
