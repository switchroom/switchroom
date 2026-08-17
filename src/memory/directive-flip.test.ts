import { describe, it, expect } from "vitest";
import {
  evaluateFlipReadiness,
  measureLiveResidue,
  flipConfigStanza,
} from "./directive-flip.js";
import { RULES_BLOCK_BUDGET_BYTES } from "./rules-block.js";
import type { DirectiveResidueMeasurement } from "./directive-residue.js";
import type { DirectiveAdmin, HindsightDirective } from "./hindsight-directive-admin.js";

/**
 * Memory v2 M3 (Surface-A) — flip readiness gate.
 *
 * The binding precondition is the 6144-byte rules-block budget, not
 * MAX_DIRECTIVES. These tests pin the gate at its boundary and against the two
 * canonical agents from m2-residue.md: ziggy (fits untriaged → the canary) and
 * overlord (4x over budget → must stay unflipped).
 */

function measurement(
  agent: string,
  residueBytes: number,
  residueDirectiveCount = 6,
): DirectiveResidueMeasurement {
  return {
    agent,
    residueBytes,
    residueDirectiveCount,
    totalDirectiveCount: residueDirectiveCount,
    residueTokensEstimate: Math.round(residueBytes / 3.7),
  };
}

describe("evaluateFlipReadiness — the 6144B binding gate", () => {
  it("ziggy (3374B, rules_block on) is READY — the approved canary", () => {
    const r = evaluateFlipReadiness(measurement("ziggy", 3374), {
      rulesBlockEnabled: true,
    });
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.residueBytes).toBe(3374);
    expect(r.budgetBytes).toBe(RULES_BLOCK_BUDGET_BYTES);
  });

  it("overlord (25710B, ~4x over) is NOT ready even with rules_block on", () => {
    const r = evaluateFlipReadiness(measurement("overlord", 25710, 40), {
      rulesBlockEnabled: true,
    });
    expect(r.ready).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("25710B");
    expect(r.reasons[0]).toContain(String(RULES_BLOCK_BUDGET_BYTES));
  });

  it("exactly 6144B is READY (budget is inclusive)", () => {
    const r = evaluateFlipReadiness(measurement("edge", RULES_BLOCK_BUDGET_BYTES), {
      rulesBlockEnabled: true,
    });
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("6145B (one byte over) is NOT ready", () => {
    const r = evaluateFlipReadiness(
      measurement("edge", RULES_BLOCK_BUDGET_BYTES + 1),
      { rulesBlockEnabled: true },
    );
    expect(r.ready).toBe(false);
    expect(r.reasons[0]).toContain("6145B");
  });

  it("in-budget but rules_block OFF is NOT ready (two-flag ordering)", () => {
    const r = evaluateFlipReadiness(measurement("ziggy", 3374), {
      rulesBlockEnabled: false,
    });
    expect(r.ready).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("rules_block");
  });

  it("over budget AND rules_block off surfaces BOTH blockers", () => {
    const r = evaluateFlipReadiness(measurement("overlord", 25710, 40), {
      rulesBlockEnabled: false,
    });
    expect(r.ready).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

describe("measureLiveResidue — measures the bank's CURRENT directive set", () => {
  function fakeAdmin(directives: HindsightDirective[]): DirectiveAdmin {
    return { list: async () => directives } as unknown as DirectiveAdmin;
  }

  it("counts active directives (untriaged ceiling) into the residue", async () => {
    const directives: HindsightDirective[] = [
      { id: "d1", name: "sign-off", content: "end with a wave", priority: 10, is_active: true },
      { id: "d2", name: "no-email", content: "never email without approval", priority: 9, is_active: true },
    ];
    const m = await measureLiveResidue(fakeAdmin(directives), "ziggy");
    expect(m.agent).toBe("ziggy");
    expect(m.residueDirectiveCount).toBe(2);
    expect(m.residueBytes).toBeGreaterThan(0);
  });

  it("excludes inactive directives (never injected, not part of residue)", async () => {
    const directives: HindsightDirective[] = [
      { id: "d1", name: "active", content: "x", priority: 1, is_active: true },
      { id: "d2", name: "retired", content: "y", priority: 1, is_active: false },
    ];
    const m = await measureLiveResidue(fakeAdmin(directives), "ziggy");
    expect(m.residueDirectiveCount).toBe(1);
  });

  it("feeds straight into evaluateFlipReadiness", async () => {
    const directives: HindsightDirective[] = [
      { id: "d1", name: "short", content: "x", priority: 1, is_active: true },
    ];
    const m = await measureLiveResidue(fakeAdmin(directives), "ziggy");
    expect(evaluateFlipReadiness(m, { rulesBlockEnabled: true }).ready).toBe(true);
  });
});

describe("flipConfigStanza", () => {
  it("renders both flags with rules_block true and inject_directives false", () => {
    const stanza = flipConfigStanza("ziggy");
    expect(stanza).toContain("ziggy");
    expect(stanza).toContain("rules_block: true");
    expect(stanza).toContain("inject_directives: false");
  });
});
