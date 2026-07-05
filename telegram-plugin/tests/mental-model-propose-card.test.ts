import { describe, it, expect } from "vitest";
import { renderMentalModelProposeCard } from "../gateway/mental-model-propose-card.js";

/**
 * The proposal RENDERS an operator approval card (hindsight Phase 5). Mirrors
 * the vault-request-access card: agent name + model name + source query +
 * rationale, with the same escaping discipline.
 */
describe("renderMentalModelProposeCard", () => {
  it("renders a card carrying the agent, model name, source query, and rationale", () => {
    const card = renderMentalModelProposeCard({
      agent: "coach",
      name: "training-plan-state",
      source_query: "What is the athlete's current plan?",
      reason: "I keep re-deriving the plan state every session",
      refresh_after_consolidation: true,
    });
    expect(card).toContain("proposes a mental model");
    expect(card).toContain("coach");
    // Model name rendered inside a code span (literal).
    expect(card).toContain("`training-plan-state`");
    expect(card).toContain("What is the athlete's current plan?");
    expect(card).toContain("I keep re-deriving the plan state every session");
    expect(card).toContain("refresh after consolidation: `on`");
    // The card explains the approve/deny semantics so the operator can decide.
    expect(card).toContain("Approve");
    expect(card).toContain("Deny");
    expect(card).toContain("memory.mental_models[]");
  });

  it("renders 'why: not provided' when no rationale is supplied (agent-side omission is visible)", () => {
    const card = renderMentalModelProposeCard({
      agent: "coach",
      name: "plan",
      source_query: "q",
    });
    expect(card).toContain("why: _not provided_");
    expect(card).toContain("refresh after consolidation: `off`");
  });

  it("defuses a backtick in the model name so it can't break out of the code span", () => {
    const card = renderMentalModelProposeCard({
      agent: "coach",
      name: "pl`an",
      source_query: "q",
    });
    // The raw backtick must not survive verbatim inside the span.
    expect(card).not.toContain("`pl`an`");
  });
});
