import { describe, it, expect } from "vitest";
import { admitSelfScopedNonAdminEdit } from "./config-edit-validator.js";

/**
 * Pins the EITHER/OR admission branch that HostControlServer applies to a
 * non-admin `config_propose_edit` (Fix 6.1): an edit is admitted if it is
 * EITHER a self-scoped `tools.allow` widen OR a self-scoped append to the
 * caller's own `memory.mental_models[]`. Only when BOTH fail is it denied.
 * Previously only the two component validators were pinned; the OR-combination
 * (the thing the server actually decides on) had no test.
 */

const BASE = `agents:
  coach:
    persona: fitness
    tools:
      allow:
        - Read
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
`;

describe("admitSelfScopedNonAdminEdit", () => {
  it("ADMITS a self-scoped tools.allow widen (via=tools.allow)", () => {
    const after = `agents:
  coach:
    persona: fitness
    tools:
      allow:
        - Read
        - Edit(/x)
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
`;
    expect(admitSelfScopedNonAdminEdit(BASE, after, "coach")).toEqual({
      ok: true,
      via: "tools.allow",
    });
  });

  it("ADMITS a self-scoped mental_models append (via=mental_models) when tools.allow is untouched", () => {
    const after = `agents:
  coach:
    persona: fitness
    tools:
      allow:
        - Read
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the plan?
  lawyer:
    persona: legal
`;
    expect(admitSelfScopedNonAdminEdit(BASE, after, "coach")).toEqual({
      ok: true,
      via: "mental_models",
    });
  });

  it("DENIES an edit that touches ANOTHER agent — both branches fail", () => {
    const after = `agents:
  coach:
    persona: fitness
    tools:
      allow:
        - Read
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
    tools:
      allow:
        - Bash
`;
    const r = admitSelfScopedNonAdminEdit(BASE, after, "coach");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The denial carries BOTH diagnostics: the tools.allow detail (surfaced
      // as the primary error) and the mental-model detail (for `.why()`).
      expect(typeof r.detail).toBe("string");
      expect(typeof r.mentalModelDetail).toBe("string");
    }
  });

  it("DENIES an edit that smuggles a foreign field alongside a valid model append", () => {
    const after = `agents:
  coach:
    persona: changed-persona
    tools:
      allow:
        - Read
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the plan?
  lawyer:
    persona: legal
`;
    expect(admitSelfScopedNonAdminEdit(BASE, after, "coach").ok).toBe(false);
  });
});
