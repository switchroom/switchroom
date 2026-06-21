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
  isVersionAssertable,
  orderAgentsCanaryFirst,
  planRollout,
  formatRolloutPlan,
  executeRollout,
  encodeRolloutResultLine,
  parseRolloutResultLine,
  ROLLOUT_RESULT_SENTINEL,
  type RolloutDeps,
  type RolloutResult,
  type RolloutStep,
} from "./rollout.js";

describe("normalizeVersion", () => {
  it("strips a leading v and trims so config pin == in-container version", () => {
    expect(normalizeVersion("v0.15.18")).toBe("0.15.18");
    expect(normalizeVersion(" 0.15.18 ")).toBe("0.15.18");
    expect(normalizeVersion("v0.15.18")).toBe(normalizeVersion("0.15.18"));
  });
});

describe("isVersionAssertable", () => {
  it("accepts a semver tag with or without the v prefix", () => {
    expect(isVersionAssertable("v0.15.18")).toBe(true);
    expect(isVersionAssertable("0.15.18")).toBe(true);
    expect(isVersionAssertable(" v0.15.18 ")).toBe(true);
  });
  it("rejects a sha-pin (valid release.pin, but not version-assertable)", () => {
    expect(isVersionAssertable("sha-18e9d152")).toBe(false);
    expect(isVersionAssertable("latest")).toBe(false);
    expect(isVersionAssertable("v0.15")).toBe(false);
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
}): { deps: RolloutDeps; runs: string[][]; logs: string[]; persisted: string[] } {
  const runs: string[][] = [];
  const logs: string[] = [];
  const persisted: string[] = [];
  const deps: RolloutDeps = {
    run: (args) => {
      runs.push(args);
      return { status: opts.runStatus ? opts.runStatus(args) : 0 };
    },
    probeVersion: (agent) => opts.versions[agent] ?? null,
    log: (line) => logs.push(line),
    persistPin: (pin) => persisted.push(pin),
  };
  return { deps, runs, logs, persisted };
}

describe("executeRollout", () => {
  const TARGET = "v0.15.18";

  it("happy path: rolls every agent, then refreshes web + hostd", () => {
    const steps = planRollout(["clerk", "marko"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", marko: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(["clerk", "marko"]);
    // apply ran first (always bare — pin is persisted, not passed one-shot),
    // then each restart, then webd + hostd install.
    expect(runs[0]).toEqual(["apply"]);
    expect(runs).toContainEqual(["agent", "restart", "clerk", "--wait", "--force"]);
    expect(runs).toContainEqual(["webd", "install", "--tag", TARGET]);
    expect(runs).toContainEqual(["hostd", "install", "--tag", TARGET]);
  });

  it("persists the pin BEFORE a bare apply when pinToPersist is set", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    // persist-pin is the very first step.
    expect(steps[0]).toEqual({ kind: "persist-pin", pin: TARGET });
    const { deps, runs, persisted } = harness({ versions: { clerk: "0.15.18" } });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(persisted).toEqual([TARGET]); // persisted exactly once
    expect(runs[0]).toEqual(["apply"]); // apply is bare — no one-shot --pin
  });

  it("does NOT persist (no persist-pin step) when target came from config", () => {
    const steps = planRollout(["clerk"]); // no pinToPersist
    expect(steps.find((s) => s.kind === "persist-pin")).toBeUndefined();
    const { deps, persisted } = harness({ versions: { clerk: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    expect(persisted).toEqual([]);
  });

  it("warns (does not crash) if a persist-pin step has no persist hook", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    const runs: string[][] = [];
    const r = executeRollout(steps, TARGET, {
      run: (a) => { runs.push(a); return { status: 0 }; },
      probeVersion: () => "0.15.18",
      log: () => {},
      // persistPin intentionally omitted
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("NOT durable"))).toBe(true);
  });

  it("STOPS at the first agent that comes back on the wrong version", () => {
    const steps = planRollout(["clerk", "marko", "finn"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", marko: "0.15.17" /* stale! */, finn: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps);
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
    const r = executeRollout(steps, TARGET, deps);
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
    const r = executeRollout(steps, TARGET, deps);
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
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(["clerk"]);
    expect(r.warnings.length).toBe(2);
  });

  it("compares versions normalized (v-prefix vs bare)", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({ versions: { clerk: "0.15.18" } });
    // target carries the v-prefix; in-container version does not.
    const r = executeRollout(steps, "v0.15.18", deps);
    expect(r.ok).toBe(true);
  });
});

// ── #2487 hostd/MCP-path ordering + structured result + deferral ──────────

describe("planRollout — hostd context (#2487)", () => {
  const TARGET = "v0.15.18";

  it("persists the pin AFTER the canary, not before", () => {
    const steps = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const kinds = steps.map((s) =>
      s.kind === "restart-agent" ? `r:${s.agent}` : s.kind,
    );
    // apply → canary (test-harness) → persist-pin → rest → sweep.
    expect(kinds).toEqual([
      "apply",
      "r:test-harness",
      "persist-pin",
      "r:clerk",
      "sweep",
    ]);
    // persist-pin comes strictly AFTER the canary restart.
    const persistIdx = kinds.indexOf("persist-pin");
    const canaryIdx = kinds.indexOf("r:test-harness");
    expect(persistIdx).toBeGreaterThan(canaryIdx);
  });

  it("DROPS the hostd/web refresh steps (deferred — would SIGKILL itself)", () => {
    const kinds = planRollout(["clerk", "marko"], {
      pinToPersist: TARGET,
      hostdContext: true,
    }).map((s) => s.kind);
    expect(kinds).not.toContain("refresh-web");
    expect(kinds).not.toContain("refresh-hostd");
  });

  it("host-shell path is unchanged — persist FIRST, web/hostd present", () => {
    const kinds = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
    }).map((s) => s.kind);
    expect(kinds[0]).toBe("persist-pin"); // FIRST, deliberate
    expect(kinds).toContain("refresh-web");
    expect(kinds).toContain("refresh-hostd");
  });
});

describe("executeRollout — hostd context (#2487)", () => {
  const TARGET = "v0.15.18";

  it("apply uses one-shot --pin (pin not yet persisted before canary)", () => {
    const steps = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", "test-harness": "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    expect(runs[0]).toEqual(["apply", "--pin", TARGET]);
  });

  it("does NOT persist the pin when the canary FAILS its version assert", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, persisted, runs } = harness({
      // canary (test-harness) comes back stale → roll STOPS before persist.
      versions: { "test-harness": "0.15.17", clerk: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(false);
    expect(r.failedAgent).toBe("test-harness");
    expect(r.rolled).toEqual([]);
    // The brick-scenario-#2 guard: a failed canary leaves NO persisted pin.
    expect(persisted).toEqual([]);
    // clerk was never touched.
    expect(runs).not.toContainEqual(["agent", "restart", "clerk", "--wait", "--force"]);
  });

  it("persists the pin once the canary is GREEN, then rolls the rest", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, persisted } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(["test-harness", "clerk"]);
    expect(persisted).toEqual([TARGET]); // persisted exactly once, after canary
  });
});

describe("rollout structured-result sentinel (#2487)", () => {
  it("round-trips a successful result through encode/parse", () => {
    const result: RolloutResult = {
      ok: true,
      rolled: ["test-harness", "clerk"],
      warnings: ["hostd/web refresh deferred"],
    };
    const line = encodeRolloutResultLine(result);
    expect(line.startsWith(ROLLOUT_RESULT_SENTINEL)).toBe(true);
    const parsed = parseRolloutResultLine("noise\n" + line + "\nmore noise");
    expect(parsed).toEqual({
      ok: true,
      rolled: ["test-harness", "clerk"],
      warnings: ["hostd/web refresh deferred"],
    });
  });

  it("round-trips a FAILED result with failedAgent/failedStep", () => {
    const result: RolloutResult = {
      ok: false,
      rolled: ["test-harness"],
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: "0.15.17",
      warnings: [],
    };
    const parsed = parseRolloutResultLine(encodeRolloutResultLine(result));
    expect(parsed).toMatchObject({
      ok: false,
      rolled: ["test-harness"],
      failedStep: "restart-agent",
      failedAgent: "clerk",
    });
  });

  it("returns null when no sentinel line is present (child died early)", () => {
    expect(parseRolloutResultLine("Rolling 3 agents…\napply\n")).toBeNull();
  });
});
