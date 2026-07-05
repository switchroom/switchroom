import { describe, it, expect } from "vitest";
import { assertSelfScopedMentalModelEdit } from "./config-edit-validator.js";

/**
 * The mental-model self-scope gate (hindsight Phase 5): a NON-admin agent may
 * ONLY append declared models to its OWN
 * `agents.<caller>.memory.mental_models[]` via config_propose_edit. This is the
 * enforced boundary that (together with the operator approval tap) makes an
 * agent-proposes → human-approves flow safe: an agent can propose but can never
 * escalate — a forged proposal diff touching any other field/agent is rejected.
 */

const BEFORE = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
`;

describe("assertSelfScopedMentalModelEdit", () => {
  it("PERMITS appending a model to the caller's own memory.mental_models (created from absent)", () => {
    const after = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the plan?
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
`;
    expect(assertSelfScopedMentalModelEdit(BEFORE, after, "coach")).toEqual({ ok: true });
  });

  it("PERMITS appending a second model without dropping the first", () => {
    const before = `agents:
  coach:
    memory:
      mental_models:
        - name: a
          source_query: qa
`;
    const after = `agents:
  coach:
    memory:
      mental_models:
        - name: a
          source_query: qa
        - name: b
          source_query: qb
`;
    expect(assertSelfScopedMentalModelEdit(before, after, "coach")).toEqual({ ok: true });
  });

  it("REJECTS removing/replacing an existing declared model (not additive)", () => {
    const before = `agents:
  coach:
    memory:
      mental_models:
        - name: a
          source_query: qa
`;
    const after = `agents:
  coach:
    memory:
      mental_models:
        - name: b
          source_query: qb
`;
    const r = assertSelfScopedMentalModelEdit(before, after, "coach");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("removes existing mental model");
  });

  it("REJECTS a diff that also touches ANOTHER agent (cross-agent escalation)", () => {
    const after = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the plan?
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
        - mcp__hostd__agent_restart
`;
    const r = assertSelfScopedMentalModelEdit(BEFORE, after, "coach");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("outside agents.coach.memory.mental_models");
  });

  it("REJECTS a diff that smuggles in a tools.allow widen alongside the model (self-escalation)", () => {
    const after = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the plan?
    tools:
      allow:
        - Bash
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
`;
    const r = assertSelfScopedMentalModelEdit(BEFORE, after, "coach");
    expect(r.ok).toBe(false);
  });

  it("REJECTS appending a model to a DIFFERENT agent's block than the caller", () => {
    const after = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
    memory:
      mental_models:
        - name: open-matters
          source_query: which matters?
`;
    // caller is coach, but the edit adds a model to lawyer → not self-scoped.
    const r = assertSelfScopedMentalModelEdit(BEFORE, after, "coach");
    expect(r.ok).toBe(false);
  });
});
