/**
 * Unit suite for the flip-gate verdict logic + report rendering. Runs under
 * `bun test` (this tree is vitest-excluded) via the `uat/flip/` entry in
 * telegram-plugin/scripts/bun-test-ci.sh. Pure fixtures — no IO.
 */

import { describe, it, expect } from "vitest";
import { evaluateGate, runGate, type GateInput, type Tier2ProbeResults } from "./gate.js";
import { renderFlipReport, renderVerdictLine } from "./report.js";
import type { EquivalenceReport } from "./tier1-equivalence.js";
import type { DirectiveInjectionDelta } from "./recall-log.js";

function passingTier1(): EquivalenceReport {
  return {
    pass: true,
    missing_from_rules: [],
    truncated_or_drifted: [],
    unsourced_rules: [],
    renderedBytes: 1000,
    budgetBytes: 6144,
    withinBudget: true,
    sentinelCount: 3,
    ruleCount: 3,
    sentinelMatchesCount: true,
    residueDirectiveCount: 3,
  };
}

function suppressedDelta(): DirectiveInjectionDelta {
  return {
    baseline: { rowCount: 2, maxDirectiveCount: 6, lastDirectiveCount: 6, everInjectedIds: ["a"], maxDirectivesOmitted: 0 },
    postflip: { rowCount: 2, maxDirectiveCount: 0, lastDirectiveCount: 0, everInjectedIds: [], maxDirectivesOmitted: 0 },
    volumeDelta: 6,
    postflipFullySuppressed: true,
    residualIds: [],
  };
}

describe("evaluateGate", () => {
  it("passes when Tier-1 is clean and no optional inputs are supplied", () => {
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1() });
    expect(v.pass).toBe(true);
    // recall_log + tier2 recorded as skipped, not failing.
    const skipped = v.checks.filter((c) => c.skipped).map((c) => c.name);
    expect(skipped).toContain("recall_log: directives suppressed postflip");
    expect(skipped).toContain("tier2: behavioural probes hold");
  });

  it("fails on a Tier-1 missing guardrail and names it", () => {
    const t1 = passingTier1();
    t1.pass = false;
    t1.missing_from_rules = [{ id: "d9", name: "guard", reason: "unmapped" }];
    const v = evaluateGate({ agent: "ziggy", tier1: t1 });
    expect(v.pass).toBe(false);
    const c = v.checks.find((c) => c.name === "tier1: no missing guardrails")!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain("d9(unmapped)");
  });

  it("fails on an over-budget Tier-1 block", () => {
    const t1 = passingTier1();
    t1.withinBudget = false;
    t1.renderedBytes = 7000;
    const v = evaluateGate({ agent: "ziggy", tier1: t1 });
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.name === "tier1: within 6144B budget")!.pass).toBe(false);
  });

  it("passes recall_log when postflip injection is fully suppressed", () => {
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1(), recallLog: suppressedDelta() });
    const c = v.checks.find((c) => c.name === "recall_log: directives suppressed postflip")!;
    expect(c.pass).toBe(true);
    expect(c.skipped).toBeUndefined();
    expect(v.pass).toBe(true);
  });

  it("fails recall_log when directives are still injected postflip", () => {
    const d = suppressedDelta();
    d.postflipFullySuppressed = false;
    d.postflip.maxDirectiveCount = 2;
    d.residualIds = ["a", "z"];
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1(), recallLog: d });
    expect(v.pass).toBe(false);
    const c = v.checks.find((c) => c.name === "recall_log: directives suppressed postflip")!;
    expect(c.detail).toContain("a, z");
  });

  it("folds a Tier-2 result in when supplied (seam)", () => {
    const failing: Tier2ProbeResults = { pass: false, probes: [{ directiveId: "d1", held: false }] };
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1(), tier2: failing });
    expect(v.pass).toBe(false);
    const c = v.checks.find((c) => c.name === "tier2: behavioural probes hold")!;
    expect(c.pass).toBe(false);
    expect(c.skipped).toBeUndefined();
  });

  it("treats tier2:null as skipped, not a failure", () => {
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1(), tier2: null });
    expect(v.pass).toBe(true);
    expect(v.checks.find((c) => c.name === "tier2: behavioural probes hold")!.skipped).toBe(true);
  });
});

describe("runGate", () => {
  it("exit 0 when every agent passes", () => {
    const inputs: GateInput[] = [
      { agent: "a", tier1: passingTier1() },
      { agent: "b", tier1: passingTier1() },
    ];
    expect(runGate(inputs).exitCode).toBe(0);
  });

  it("exit 1 when any agent fails", () => {
    const bad = passingTier1();
    bad.unsourced_rules = [{ id: "R-9", text: "invented" }];
    const run = runGate([
      { agent: "a", tier1: passingTier1() },
      { agent: "b", tier1: bad },
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.verdicts.find((v) => v.agent === "b")!.pass).toBe(false);
  });
});

describe("renderFlipReport", () => {
  it("renders a PASS matrix with no triage rows", () => {
    const run = runGate([{ agent: "ziggy", tier1: passingTier1(), recallLog: suppressedDelta() }]);
    const md = renderFlipReport(run, { startedAt: new Date("2026-08-18T00:00:00Z"), durationSeconds: 1.2 });
    expect(md).toContain("**Verdict:** PASS (1/1 agents green)");
    expect(md).toContain("| `ziggy` | PASS |");
    expect(md).toContain("No failing checks");
  });

  it("renders a FAIL matrix and lists the failing check verbatim", () => {
    const bad = passingTier1();
    bad.unsourced_rules = [{ id: "R-9", text: "invented" }];
    const run = runGate([{ agent: "ziggy", tier1: bad }]);
    const md = renderFlipReport(run);
    expect(md).toContain("**Verdict:** FAIL");
    expect(md).toContain("| `ziggy` | FAIL |");
    expect(md).toContain("no unsourced rules");
    expect(md).toContain("R-9");
  });
});

describe("renderVerdictLine", () => {
  it("summarizes one verdict compactly", () => {
    const v = evaluateGate({ agent: "ziggy", tier1: passingTier1() });
    const line = renderVerdictLine(v);
    expect(line).toContain("PASS ziggy");
    expect(line).toContain("within 6144B budget");
  });
});
