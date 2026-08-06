/**
 * self-improve-review-audience.test.ts — the self-improvement review labelling
 * rule (Ken, 2026-08-07).
 *
 * THE BUG THIS GUARDS
 * -------------------
 * A self-improvement review turn is injected with an explicit contract
 * (`buildReviewPrompt`): act on the signal, do NOT reply with tools, end when
 * done. It is OFF the operator reply path — its inbound targets a placeholder
 * chat. Its trailing transcript prose is the agent reasoning to ITSELF. But the
 * outbox backstop captured that prose and delivered it into the operator's DM
 * as a RAW, UNLABELLED message — Ken saw the agent musing to itself ("I own
 * personal-garmin, but the script I hand-rolled…") with nothing to say it was a
 * self-improvement note.
 *
 * THE DESIGN UNDER TEST — CARD GATE, SUPPRESS THE REST
 * ---------------------------------------------------
 * A review turn's ONE sanctioned operator-facing output is a well-formed CARD
 * (a message opening with `SELF_IMPROVEMENT_TITLE`). The backstop delivers a
 * review-originated record ONLY IF its text is such a card; everything else —
 * the raw reasoning — classifies `internal` and is suppressed. Deterministic:
 * the gate is an EXACT title-line prefix, and the failure direction is SAFE (a
 * mis-typed card is withheld, never a real answer swallowed; a review inbound
 * has no waiting question to swallow).
 *
 *   - surfacing review turn (emits the card)  ⇒ delivered, self-labelled
 *   - no-op review turn (silent / raw prose)  ⇒ suppressed
 *   - normal non-review turn                  ⇒ untouched
 *
 * PARITY. The `.mjs` hook (unbundled) and the TS self-improve machinery cannot
 * share a module, so `REVIEW_SOURCE` and the card title are mirrored. This file
 * PINS both equalities — a rename on either side reds CI here rather than
 * silently splitting the copies and making the feature inert.
 */

import { describe, it, expect } from "vitest";

// The TS source of truth for the review source tag + the card title, and the
// prompt builder that carries the operator-output contract.
import {
  REVIEW_SOURCE as REVIEW_SOURCE_TS,
  SELF_IMPROVEMENT_CARD_TITLE,
  buildReviewPrompt,
} from "../src/self-improve/review-prompt.js";
import type { LearningSignal } from "../src/self-improve/types.js";

// The unbundled `.mjs` mirror that the Stop hook + the sweep actually run.
import {
  REVIEW_SOURCE as REVIEW_SOURCE_MJS,
  AUDIENCE_INTERNAL,
  AUDIENCE_USER,
  isReviewOriginatedSource,
  isSelfImprovementCard,
  decideCaptureAudience,
  shouldFrameSelfImprovement,
  applySelfImprovementFraming,
  formatSelfImprovementFraming,
  SELF_IMPROVEMENT_TITLE,
} from "../telegram-plugin/hooks/audience-classify.mjs";

import { GATEWAY_SIGNATURES } from "../src/fleet-health/detect.js";

const REVIEW_PROSE = [
  "I own personal-garmin, but the script I hand-rolled against this turn was the",
  "shared garmin skill's garmin-history-pull, which only samples every 3rd day.",
  "The durable fix is a first-class hrv-trend subcommand; I logged it as a",
  "pending suggestion rather than auto-applying.",
].join(" ");

/** A well-formed card, exactly as the prompt instructs the model to emit it. */
const REVIEW_CARD = [
  `${SELF_IMPROVEMENT_TITLE} — pending suggestion logged`,
  "- **Signal:** had to hand-roll python twice to pull daily HRV",
  "- **Suggestion:** add an `hrv-trend` command to the garmin skill",
  "- **Status:** T2, logged for your review, nothing auto-applied",
].join("\n");

describe("parity — the mirrored constants cannot silently drift", () => {
  it("REVIEW_SOURCE: the .mjs mirror equals the TS source of truth", () => {
    expect(REVIEW_SOURCE_MJS).toBe(REVIEW_SOURCE_TS);
    expect(REVIEW_SOURCE_MJS).toBe("self_improve_review");
  });

  it("the card title: the TS prompt constant equals the .mjs gate title", () => {
    // If these split, the model emits one string and the backstop gate keys on
    // another — every surfacing card falls through and is suppressed.
    expect(SELF_IMPROVEMENT_CARD_TITLE).toBe(SELF_IMPROVEMENT_TITLE);
    expect(SELF_IMPROVEMENT_CARD_TITLE).toBe("🔧 **Self-improvement**");
  });

  it("isReviewOriginatedSource keys ONLY on the exact source tag", () => {
    expect(isReviewOriginatedSource(REVIEW_SOURCE_TS)).toBe(true);
    for (const v of [undefined, null, "", "telegram", "cron", "channel", "SELF_IMPROVE_REVIEW"]) {
      expect(isReviewOriginatedSource(v as string)).toBe(false);
    }
  });
});

describe("card gate — an EXACT title-line prefix, safe failure direction", () => {
  it("recognises a well-formed card, tolerating leading whitespace", () => {
    expect(isSelfImprovementCard(REVIEW_CARD)).toBe(true);
    expect(isSelfImprovementCard(`\n\n${REVIEW_CARD}`)).toBe(true);
    // Bare title line (outcome on the same line after ` — `) still qualifies.
    expect(isSelfImprovementCard(`${SELF_IMPROVEMENT_TITLE} — done`)).toBe(true);
  });

  it("rejects raw reasoning and anything not opening with the title", () => {
    for (const v of [REVIEW_PROSE, "", "   ", undefined, null, 1, {}, "Self-improvement: x"]) {
      expect(isSelfImprovementCard(v as string)).toBe(false);
    }
  });
});

describe("audience — the card delivers, the reasoning is suppressed", () => {
  it("review + card ⇒ user; review + non-card ⇒ internal", () => {
    expect(decideCaptureAudience({ reviewOriginated: true, reviewTextIsCard: true })).toBe(
      AUDIENCE_USER,
    );
    expect(decideCaptureAudience({ reviewOriginated: true, reviewTextIsCard: false })).toBe(
      AUDIENCE_INTERNAL,
    );
    // Missing card flag defaults to "not a card" ⇒ suppressed (safe direction).
    expect(decideCaptureAudience({ reviewOriginated: true })).toBe(AUDIENCE_INTERNAL);
  });

  it("the review branch is checked FIRST, independent of reply-throw/obligation", () => {
    // A card delivers even with signals that would otherwise route `user`, and
    // raw reasoning is suppressed even though a review inbound never opens an
    // obligation — the branch does not consult those at all.
    expect(
      decideCaptureAudience({
        reviewOriginated: true,
        reviewTextIsCard: false,
        replyToolThrewThisTurn: false,
        openInboundObligation: true,
      }),
    ).toBe(AUDIENCE_INTERNAL);
  });

  it("positive-evidence-only: a non-review turn is completely unaffected", () => {
    // reviewOriginated anything-but-true ⇒ the rest of the classifier decides.
    for (const v of [undefined, null, false, "true", 1, {}]) {
      expect(decideCaptureAudience({ reviewOriginated: v as boolean })).toBe(AUDIENCE_USER);
    }
    // And the pre-existing throw/obligation asymmetry is untouched.
    expect(
      decideCaptureAudience({ replyToolThrewThisTurn: true, openInboundObligation: false }),
    ).toBe(AUDIENCE_INTERNAL);
    // The card flag alone (no reviewOriginated) never changes a normal turn.
    expect(decideCaptureAudience({ reviewTextIsCard: true })).toBe(AUDIENCE_USER);
  });
});

describe("residual title framing — the gate-off belt-and-braces", () => {
  it("frames ONLY on an exact boolean true, with a kill switch", () => {
    expect(shouldFrameSelfImprovement({ reviewOriginated: true })).toBe(true);
    for (const v of [undefined, null, false, "true", 1, {}, []]) {
      expect(shouldFrameSelfImprovement({ reviewOriginated: v })).toBe(false);
    }
    expect(shouldFrameSelfImprovement({ reviewOriginated: true }, { frameEnabled: false })).toBe(
      false,
    );
  });

  it("labels raw prose additively (title first, prose verbatim)", () => {
    const framed = applySelfImprovementFraming(REVIEW_PROSE);
    expect(framed).toContain(REVIEW_PROSE);
    expect(framed.startsWith(SELF_IMPROVEMENT_TITLE)).toBe(true);
    expect(framed.indexOf(SELF_IMPROVEMENT_TITLE)).toBeLessThan(framed.indexOf("I own"));
  });

  it("is IDEMPOTENT: a real card is not double-titled", () => {
    expect(applySelfImprovementFraming(REVIEW_CARD)).toBe(REVIEW_CARD);
  });

  it("an empty body is left alone — a title about nothing is not a message", () => {
    expect(applySelfImprovementFraming("")).toBe("");
    expect(applySelfImprovementFraming("   \n ")).toBe("   \n ");
  });
});

describe("the review prompt locks the operator-output contract", () => {
  const signals: LearningSignal[] = [
    { kind: "repeated-fix", reason: "hand-rolled the same HRV pull twice", evidence: "two turns" },
  ];

  it("carries the EXACT card format the gate expects", () => {
    const p = buildReviewPrompt(signals);
    // The title line the gate keys on, verbatim.
    expect(p).toContain(SELF_IMPROVEMENT_CARD_TITLE);
    // The three structured fields, in the operator-approved shape.
    expect(p).toContain("- **Signal:**");
    expect(p).toContain("- **Suggestion:**");
    expect(p).toContain("- **Status:**");
    // A well-formed card built to the prompt's spec passes the runtime gate.
    expect(isSelfImprovementCard(`${SELF_IMPROVEMENT_CARD_TITLE} — outcome`)).toBe(true);
  });

  it("instructs silence on a no-op and forbids trailing reasoning", () => {
    const p = buildReviewPrompt(signals);
    expect(p.toLowerCase()).toContain("silent");
    // The no-raw-reasoning rule is stated, not just implied.
    expect(p.toLowerCase()).toContain("reasoning");
  });
});

describe("telemetry — a framed delivery is a delivery, not an alarm", () => {
  it("the framing line matches NO gateway alarm signature", () => {
    const line = formatSelfImprovementFraming({
      turnNonce: "5550001:_#7311",
      turnId: "5550001:_#7311",
      chatId: "5550001",
      textSha256: "abcdef012345",
      source: REVIEW_SOURCE_TS,
    });
    for (const [name, re] of Object.entries(GATEWAY_SIGNATURES)) {
      expect(re.test(line), `${name} must not match a by-design framed delivery`).toBe(false);
    }
  });
});
