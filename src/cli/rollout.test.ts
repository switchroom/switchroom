/**
 * Tests for `switchroom rollout` — the staggered fleet-deploy verb.
 *
 * Focus is the reliability-critical logic that the manual recipe got wrong
 * in past incidents: correct ordering (apply BEFORE restarts; web/hostd
 * AFTER), canary-first, the per-agent version assert, and STOP-on-first-
 * mismatch (never leave the fleet half-rolled silently). The executor takes
 * injected side-effects so this runs without docker.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeVersion,
  orderAgentsCanaryFirst,
  planRollout,
  formatRolloutPlan,
  executeRollout,
  type RolloutDeps,
  type RolloutStep,
} from "./rollout.js";

describe("normalizeVersion", () => {
  it("strips a leading v and trims so config pin == in-container version", () => {
    expect(normalizeVersion("v0.15.18")).toBe("0.15.18");
    expect(normalizeVersion(" 0.15.18 ")).toBe("0.15.18");
    expect(normalizeVersion("v0.15.18")).toBe(normalizeVersion("0.15.18"));
  });
});

describe("orderAgentsCanaryFirst", () => {
  it("puts test-harness first, preserving the rest's order", () => {
    expect(orderAgentsCanaryFirst(["clerk", "test-harness", "marko"])).toEqual([
      "test-harness",
      "clerk",
      "marko",
    ]);
  });
  it("is a no-op when test-harness is absent", () => {
    expect(orderAgentsCanaryFirst(["clerk", "marko"])).toEqual(["clerk", "marko"]);
  });
});

describe("planRollout", () => {
  it("orders apply → restarts (canary-first) → web → hostd → sweep", () => {
    const steps = planRollout(["clerk", "test-harness"]);
    expect(steps.map((s) => (s.kind === "restart-agent" ? `r:${s.agent}` : s.kind))).toEqual([
      "apply",
      "r:test-harness",
      "r:clerk",
      "refresh-web",
      "refresh-hostd",
      "sweep",
    ]);
  });

  it("drops web + hostd when skipWeb is set", () => {
    const kinds = planRollout(["clerk"], { skipWeb: true }).map((s) => s.kind);
    expect(kinds).toEqual(["apply", "restart-agent", "sweep"]);
  });

  it("does NOT emit a singleton step (first restart self-heals them, #2170)", () => {
    const kinds = planRollout(["clerk"]).map((s) => s.kind);
    expect(kinds).not.toContain("refresh-singletons");
  });
});

describe("formatRolloutPlan", () => {
  it("names the target, every step, and the stop-on-mismatch contract", () => {
    const out = formatRolloutPlan(planRollout(["clerk"]), "v0.15.18");
    expect(out).toContain("v0.15.18");
    expect(out).toContain("apply");
    expect(out).toContain("restart clerk");
    expect(out).toContain("Stops on the first agent");
  });
});

// ── executeRollout — the reliability core ────────────────────────────────

/** Build injectable deps that record `run` calls and serve versions. */
function harness(opts: {
  versions: Record<string, string | null>;
  runStatus?: (args: string[]) => number;
}): { deps: RolloutDeps; runs: string[][]; logs: string[] } {
  const runs: string[][] = [];
  const logs: string[] = [];
  const deps: RolloutDeps = {
    run: (args) => {
      runs.push(args);
      return { status: opts.runStatus ? opts.runStatus(args) : 0 };
    },
    probeVersion: (agent) => opts.versions[agent] ?? null,
    log: (line) => logs.push(line),
  };
  return { deps, runs, logs };
}

describe("executeRollout", () => {
  const TARGET = "v0.15.18";

  it("happy path: rolls every agent, then refreshes web + hostd", () => {
    const steps = planRollout(["clerk", "marko"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", marko: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, false);
    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(["clerk", "marko"]);
    // apply ran first, then each restart, then webd + hostd install.
    expect(runs[0]).toEqual(["apply"]);
    expect(runs).toContainEqual(["agent", "restart", "clerk", "--wait", "--force"]);
    expect(runs).toContainEqual(["webd", "install", "--tag", TARGET]);
    expect(runs).toContainEqual(["hostd", "install", "--tag", TARGET]);
  });

  it("passes --pin to apply only when pinOnApply is true", () => {
    const steps: RolloutStep[] = [{ kind: "apply" }];
    const withPin = harness({ versions: {} });
    executeRollout(steps, TARGET, withPin.deps, true);
    expect(withPin.runs[0]).toEqual(["apply", "--pin", TARGET]);

    const noPin = harness({ versions: {} });
    executeRollout(steps, TARGET, noPin.deps, false);
    expect(noPin.runs[0]).toEqual(["apply"]);
  });

  it("STOPS at the first agent that comes back on the wrong version", () => {
    const steps = planRollout(["clerk", "marko", "finn"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", marko: "0.15.17" /* stale! */, finn: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, false);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("restart-agent");
    expect(r.failedAgent).toBe("marko");
    expect(r.got).toBe("0.15.17");
    expect(r.rolled).toEqual(["clerk"]); // only the one before the failure
    // finn was never restarted; web/hostd never refreshed.
    expect(runs).not.toContainEqual(["agent", "restart", "finn", "--wait", "--force"]);
    expect(runs).not.toContainEqual(["webd", "install", "--tag", TARGET]);
  });

  it("STOPS when an agent is unreachable (probe returns null)", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({ versions: { clerk: null } });
    const r = executeRollout(steps, TARGET, deps, false);
    expect(r.ok).toBe(false);
    expect(r.failedAgent).toBe("clerk");
    expect(r.rolled).toEqual([]);
  });

  it("aborts before any restart if apply fails", () => {
    const steps = planRollout(["clerk"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      runStatus: (args) => (args[0] === "apply" ? 1 : 0),
    });
    const r = executeRollout(steps, TARGET, deps, false);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("apply");
    expect(r.rolled).toEqual([]);
    expect(runs).not.toContainEqual(["agent", "restart", "clerk", "--wait", "--force"]);
  });

  it("treats a web/hostd refresh failure as a non-fatal warning (agents already rolled)", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({
      versions: { clerk: "0.15.18" },
      runStatus: (args) => (args[0] === "webd" || args[0] === "hostd" ? 1 : 0),
    });
    const r = executeRollout(steps, TARGET, deps, false);
    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(["clerk"]);
    expect(r.warnings.length).toBe(2);
  });

  it("compares versions normalized (v-prefix vs bare)", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({ versions: { clerk: "0.15.18" } });
    // target carries the v-prefix; in-container version does not.
    const r = executeRollout(steps, "v0.15.18", deps, false);
    expect(r.ok).toBe(true);
  });
});
