/**
 * Tests for `switchroom rollout` — the staggered fleet-deploy verb.
 *
 * Focus is the reliability-critical logic that the manual recipe got wrong
 * in past incidents: correct ordering (apply BEFORE restarts; web/hostd
 * AFTER), canary-first, the per-agent version assert, and STOP-on-first-
 * mismatch (never leave the fleet half-rolled silently). The executor takes
 * injected side-effects so this runs without docker.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  encodeRolloutPhaseLine,
  parseRolloutPhaseLine,
  shouldRefuseDowngrade,
  shouldRefuseStaleCli,
  resolveRollbackTarget,
  PREFLIGHT_STALE_CLI_STEP,
  ROLLOUT_RESULT_SENTINEL,
  ROLLOUT_PHASE_SENTINEL,
  type RolloutDeps,
  type RolloutPhase,
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
  it("orders apply → restarts (canary-first) → web → hostd → hindsight → sweep", () => {
    const steps = planRollout(["clerk", "test-harness"]);
    expect(steps.map((s) => (s.kind === "restart-agent" ? `r:${s.agent}` : s.kind))).toEqual([
      "apply",
      "r:test-harness",
      "r:clerk",
      "refresh-web",
      "refresh-hostd",
      "refresh-hindsight",
      "sweep",
    ]);
  });

  it("places refresh-hindsight immediately after refresh-hostd", () => {
    const kinds = planRollout(["clerk"]).map((s) => s.kind);
    expect(kinds).toContain("refresh-hindsight");
    expect(kinds.indexOf("refresh-hindsight")).toBe(kinds.indexOf("refresh-hostd") + 1);
  });

  it("drops web + hostd + hindsight when skipWeb is set", () => {
    const kinds = planRollout(["clerk"], { skipWeb: true }).map((s) => s.kind);
    expect(kinds).toEqual(["apply", "restart-agent", "sweep"]);
    expect(kinds).not.toContain("refresh-hindsight");
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
  /**
   * Inject the standalone-hindsight-container probe so the refresh-hindsight
   * branch runs without docker. Defaults to false (no container → the step
   * no-ops), matching a CI host with no hindsight — which is why the
   * pre-existing web/hostd tests never trip the hindsight run.
   */
  hindsightExists?: boolean;
}): {
  deps: RolloutDeps;
  runs: string[][];
  logs: string[];
  persisted: string[];
  phases: RolloutPhase[];
} {
  const runs: string[][] = [];
  const logs: string[] = [];
  const persisted: string[] = [];
  const phases: RolloutPhase[] = [];
  const deps: RolloutDeps = {
    run: (args) => {
      runs.push(args);
      return { status: opts.runStatus ? opts.runStatus(args) : 0 };
    },
    probeVersion: (agent) => opts.versions[agent] ?? null,
    log: (line) => logs.push(line),
    emitPhase: (p) => phases.push(p),
    persistPin: (pin) => persisted.push(pin),
    hindsightExists: () => opts.hindsightExists ?? false,
  };
  return { deps, runs, logs, persisted, phases };
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

// ── #2752 refresh-hindsight — pinned tag + fatal recreate ─────────────────

describe("executeRollout — refresh-hindsight (#2752)", () => {
  const TARGET = "v0.15.18";

  it("no-ops cleanly when no hindsight container exists (never runs memory setup)", () => {
    const steps = planRollout(["clerk"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      hindsightExists: false,
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(runs.some((a) => a[0] === "memory")).toBe(false);
  });

  it("Fix 1: passes --tag <target> so the recreate pulls the PINNED image, not :latest", () => {
    const steps = planRollout(["clerk"]);
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      hindsightExists: true,
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(runs).toContainEqual(["memory", "setup", "--recreate", "--tag", TARGET]);
  });

  it("Fix 2: a recreate FAILURE is FATAL — flips ok:false and stops the roll", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({
      versions: { clerk: "0.15.18" },
      hindsightExists: true,
      // Only the hindsight recreate fails; agent restart + apply succeed.
      runStatus: (args) => (args[0] === "memory" ? 1 : 0),
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("refresh-hindsight");
    // NOT folded into the generic non-fatal web/hostd warning string.
    expect(r.warnings.some((w) => /hindsight refresh failed \(non-fatal\)/.test(w))).toBe(false);
    // The agent was already rolled before the fatal memory-backend failure.
    expect(r.rolled).toEqual(["clerk"]);
  });

  it("a web/hostd failure stays non-fatal even while hindsight recreate succeeds", () => {
    const steps = planRollout(["clerk"]);
    const { deps } = harness({
      versions: { clerk: "0.15.18" },
      hindsightExists: true,
      runStatus: (args) => (args[0] === "webd" || args[0] === "hostd" ? 1 : 0),
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(2); // web + hostd only; hindsight succeeded
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
    // apply → canary (test-harness) → persist-pin → rest → refresh-hindsight → sweep.
    expect(kinds).toEqual([
      "apply",
      "r:test-harness",
      "persist-pin",
      "r:clerk",
      "refresh-hindsight",
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

  it("RECREATES the hindsight singleton (standalone docker run — hostd can recreate it)", () => {
    const steps = planRollout(["clerk", "marko"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const kinds = steps.map((s) => s.kind);
    // hindsight is a standalone `docker run` hostd owns via the docker
    // socket — it must be rolled so the memory backend isn't left a version
    // behind (unlike refresh-web/refresh-hostd, separate compose projects).
    expect(kinds).toContain("refresh-hindsight");
    // ...and it lands immediately before the final sweep.
    expect(kinds.indexOf("refresh-hindsight")).toBe(kinds.indexOf("sweep") - 1);
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

  it("apply uses one-shot --pin + --compose-only --non-interactive (pin not yet persisted; scaffold unwritable under hostd)", () => {
    const steps = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", "test-harness": "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    // #2745: a version roll only regenerates compose (image tags +
    // compose-level env + healthcheck). It must NOT run the per-agent
    // scaffold loop, which fails under hostd (state dirs mode 0700, owned
    // by per-agent UIDs, unwritable by the unprivileged hostd process) and
    // hard-aborts the whole roll with rolled:[].
    expect(runs[0]).toEqual(["apply", "--pin", TARGET, "--compose-only", "--non-interactive"]);
  });

  it("surfaces a WARNING that per-agent template changes need a host-side apply (compose-only tradeoff)", () => {
    const steps = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps } = harness({
      versions: { clerk: "0.15.18", "test-harness": "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /compose-only/.test(w) && /host-side/.test(w))).toBe(true);
  });

  it("host-shell path keeps the bare apply — no --compose-only, no tradeoff warning", () => {
    const steps = planRollout(["clerk", "test-harness"], { pinToPersist: TARGET });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18", "test-harness": "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, {});
    expect(r.ok).toBe(true);
    // bare apply reads the already-persisted pin; a privileged host shell
    // CAN scaffold, so no compose-only downgrade and no tradeoff warning.
    expect(runs).toContainEqual(["apply"]);
    expect(r.warnings.some((w) => /compose-only/.test(w))).toBe(false);
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

  // Regression guard for #2558:
  // The restart-agent step on the hostd path must pass --pin <target> to
  // `agent restart` so the in-restart compose regeneration uses the TARGET
  // image tag and not the stale release.pin still in switchroom.yaml (the
  // durable persist-pin step runs AFTER the canary on this path).
  it("restart-agent passes --pin <target> on the hostd path (#2558 regression)", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, runs } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18" },
    });
    executeRollout(steps, TARGET, deps, { hostdContext: true });
    // Every restart-agent invocation on the hostd path must carry --pin.
    const restartRuns = runs.filter((a) => a[0] === "agent" && a[1] === "restart");
    expect(restartRuns.length).toBeGreaterThan(0);
    for (const run of restartRuns) {
      expect(run).toContain("--pin");
      expect(run).toContain(TARGET);
    }
  });

  // Belt-and-braces: on the HOST-SHELL path the pin is persisted BEFORE
  // apply, so bare restart reads the correct pin from config. Passing --pin
  // there is harmless, but the contract is bare restart (no --pin flag) so
  // the operator's PATH is unaffected.
  it("restart-agent does NOT pass --pin on the host-shell path (pin already persisted)", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      // hostdContext NOT set → host-shell path
    });
    const { deps, runs } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18" },
    });
    executeRollout(steps, TARGET, deps);
    const restartRuns = runs.filter((a) => a[0] === "agent" && a[1] === "restart");
    expect(restartRuns.length).toBeGreaterThan(0);
    for (const run of restartRuns) {
      expect(run).not.toContain("--pin");
    }
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

// ── shouldRefuseDowngrade — pure guard for the allow_downgrade flag ────────

describe("shouldRefuseDowngrade (#2487 PR2)", () => {
  const CURRENT = "v0.15.18";

  it("refuses a concrete downgrade when hostdCtx=true and flag is absent", () => {
    expect(shouldRefuseDowngrade(true, "v0.15.16", CURRENT, undefined)).toBe(true);
  });

  it("allows the same downgrade when allow_downgrade=true (operator approved)", () => {
    expect(shouldRefuseDowngrade(true, "v0.15.16", CURRENT, true)).toBe(false);
  });

  it("never refuses an upgrade (newer pin)", () => {
    expect(shouldRefuseDowngrade(true, "v0.15.20", CURRENT, undefined)).toBe(false);
  });

  it("never refuses when compareReleaseTags returns null (sha/channel pins)", () => {
    // sha pin — compareReleaseTags returns null → guard never fires
    expect(shouldRefuseDowngrade(true, "sha-abc1234", CURRENT, undefined)).toBe(false);
    // channel/floating — also returns null
    expect(shouldRefuseDowngrade(true, "latest", CURRENT, undefined)).toBe(false);
  });

  it("host-shell path (hostdCtx=false) is never gated regardless of pin vs current", () => {
    expect(shouldRefuseDowngrade(false, "v0.15.16", CURRENT, undefined)).toBe(false);
    expect(shouldRefuseDowngrade(false, "v0.15.16", CURRENT, false)).toBe(false);
  });

  it("never refuses when pin is absent (target comes from config, not --pin)", () => {
    expect(shouldRefuseDowngrade(true, undefined, CURRENT, undefined)).toBe(false);
  });
});

// ── shouldRefuseStaleCli — driving CLI older than the target (#2542) ────────

describe("shouldRefuseStaleCli (#2542)", () => {
  it("refuses when the driving CLI is strictly older than the target", () => {
    // The exact incident: hostd CLI 0.15.48 driving a roll to v0.15.59.
    expect(shouldRefuseStaleCli("0.15.48", "v0.15.59")).toBe(true);
  });

  it("normalizes the v-prefix on both sides (build-info has no v, --pin does)", () => {
    expect(shouldRefuseStaleCli("v0.15.48", "v0.15.59")).toBe(true);
    expect(shouldRefuseStaleCli("0.15.48", "0.15.59")).toBe(true);
  });

  it("allows when the CLI is the same version as the target", () => {
    expect(shouldRefuseStaleCli("0.15.59", "v0.15.59")).toBe(false);
  });

  it("allows when the CLI is NEWER than the target (a downgrade — other guard's job)", () => {
    expect(shouldRefuseStaleCli("0.15.59", "v0.15.48")).toBe(false);
  });

  it("never fires when either side is unorderable (dev/sha/channel/garbage)", () => {
    expect(shouldRefuseStaleCli("sha-abc1234", "v0.15.59")).toBe(false);
    expect(shouldRefuseStaleCli("0.15.48", "latest")).toBe(false);
    expect(shouldRefuseStaleCli("dev", "v0.15.59")).toBe(false);
    expect(shouldRefuseStaleCli("not-a-version", "v0.15.59")).toBe(false);
  });

  it("never fires when the CLI version is missing", () => {
    expect(shouldRefuseStaleCli(undefined, "v0.15.59")).toBe(false);
    expect(shouldRefuseStaleCli("", "v0.15.59")).toBe(false);
  });

  it("compares across minor/major boundaries, not lexically", () => {
    expect(shouldRefuseStaleCli("0.9.9", "v0.15.0")).toBe(true); // 0.9 < 0.15 (not string compare)
    expect(shouldRefuseStaleCli("0.15.9", "v0.15.10")).toBe(true); // patch 9 < 10
    expect(shouldRefuseStaleCli("1.0.0", "v0.15.59")).toBe(false); // major 1 > 0
  });

  it("the refusal step label is the stable structured-status value", () => {
    expect(PREFLIGHT_STALE_CLI_STEP).toBe("preflight-stale-cli");
  });
});

// ── ROLL_STEP prefix on per-step log lines (#2459) ─────────────────────────

describe("executeRollout — ROLL_STEP greppable step markers (#2459)", () => {
  const TARGET = "v0.15.18";

  it("emits ROLL_STEP apply on the apply step", () => {
    const steps = planRollout(["clerk"]);
    const { deps, logs } = harness({ versions: { clerk: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    const applyLog = logs.find((l) => l.startsWith("ROLL_STEP apply"));
    expect(applyLog).toBeTruthy();
  });

  it("emits ROLL_STEP restart-agent on each restart step", () => {
    const steps = planRollout(["clerk", "marko"]);
    const { deps, logs } = harness({ versions: { clerk: "0.15.18", marko: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    const restartLogs = logs.filter((l) => l.startsWith("ROLL_STEP restart-agent"));
    expect(restartLogs.length).toBe(2);
  });

  it("emits ROLL_STEP refresh-web and ROLL_STEP refresh-hostd", () => {
    const steps = planRollout(["clerk"]);
    const { deps, logs } = harness({ versions: { clerk: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    expect(logs.some((l) => l.startsWith("ROLL_STEP refresh-web"))).toBe(true);
    expect(logs.some((l) => l.startsWith("ROLL_STEP refresh-hostd"))).toBe(true);
  });

  it("emits ROLL_STEP sweep on the sweep step", () => {
    const steps = planRollout(["clerk"]);
    const { deps, logs } = harness({ versions: { clerk: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    expect(logs.some((l) => l.startsWith("ROLL_STEP sweep"))).toBe(true);
  });

  it("emits ROLL_STEP persist-pin when a pinToPersist step is present", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    const { deps, logs } = harness({ versions: { clerk: "0.15.18" } });
    executeRollout(steps, TARGET, deps);
    expect(logs.some((l) => l.startsWith("ROLL_STEP persist-pin"))).toBe(true);
  });
});

// ── #2492 prior_pin capture + resolveRollbackTarget ─────────────────────────

describe("resolveRollbackTarget (#2492)", () => {
  /** Build a minimal completed-rollout terminal audit line with a prior_pin. */
  function completedRolloutLine(priorPin: string, requestId = "roll-1"): string {
    return JSON.stringify({
      ts: "2026-06-01T00:00:00.000Z",
      op: "rollout",
      phase: "terminal",
      caller: { kind: "operator" },
      request_id: requestId,
      result: "completed",
      exit_code: 0,
      duration_ms: 12345,
      prior_pin: priorPin,
    });
  }

  /** Build a rollout terminal audit line WITHOUT prior_pin (e.g. error row). */
  function failedRolloutLine(requestId = "roll-bad"): string {
    return JSON.stringify({
      ts: "2026-06-01T00:01:00.000Z",
      op: "rollout",
      phase: "terminal",
      caller: { kind: "operator" },
      request_id: requestId,
      result: "error",
      exit_code: 1,
      duration_ms: 3000,
    });
  }

  it("returns the prior_pin from the most-recent completed rollout terminal row", () => {
    const logContent =
      completedRolloutLine("v0.15.16", "roll-1") +
      "\n" +
      completedRolloutLine("v0.15.17", "roll-2") +
      "\n";
    const tmp = mkdtempSync(join(tmpdir(), "prior-pin-test-"));
    const logPath = join(tmp, "audit.log");
    writeFileSync(logPath, logContent);
    const result = resolveRollbackTarget(logPath);
    // Most-recent completed row is roll-2 with prior_pin v0.15.17.
    expect(result).toBe("v0.15.17");
  });

  it("skips error rows (no prior_pin) and finds the last completed row", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prior-pin-test-"));
    const logPath = join(tmp, "audit.log");
    const logContent =
      completedRolloutLine("v0.15.16", "roll-1") +
      "\n" +
      failedRolloutLine("roll-bad") +
      "\n";
    writeFileSync(logPath, logContent);
    // Most-recent terminal row is a failed one (no prior_pin); should fall
    // back to the earlier completed row.
    const result = resolveRollbackTarget(logPath);
    expect(result).toBe("v0.15.16");
  });

  it("returns null when no completed rollout rows exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prior-pin-test-"));
    const logPath = join(tmp, "audit.log");
    writeFileSync(logPath, failedRolloutLine() + "\n");
    expect(resolveRollbackTarget(logPath)).toBeNull();
  });

  it("returns null when the audit log does not exist", () => {
    expect(resolveRollbackTarget("/nonexistent/path/audit.log")).toBeNull();
  });

  it("returns null when the log is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prior-pin-test-"));
    const logPath = join(tmp, "audit.log");
    writeFileSync(logPath, "");
    expect(resolveRollbackTarget(logPath)).toBeNull();
  });
});

// ── #2726 — per-phase emission + phase sentinel (durable observability) ──────

describe("rollout phase sentinel", () => {
  it("PHASE and RESULT sentinels are lexically disjoint (neither prefixes the other)", () => {
    // The terminal parser keys on `startsWith(ROLLOUT_RESULT_SENTINEL)`; the
    // phase parser keys on `startsWith(ROLLOUT_PHASE_SENTINEL)`. If either were
    // a prefix of the other, a line could cross-match. Assert disjointness.
    expect(ROLLOUT_PHASE_SENTINEL.startsWith(ROLLOUT_RESULT_SENTINEL)).toBe(false);
    expect(ROLLOUT_RESULT_SENTINEL.startsWith(ROLLOUT_PHASE_SENTINEL)).toBe(false);
  });

  it("a phase line does NOT parse as the terminal RESULT sentinel", () => {
    const phaseLine = encodeRolloutPhaseLine({ phase: "apply", target: "v1.2.3" });
    // The terminal parser must return null for a phase line — a phase row can
    // never be mistaken for the terminal sentinel.
    expect(parseRolloutResultLine(phaseLine)).toBeNull();
  });

  it("the terminal RESULT line does NOT parse as a phase sentinel", () => {
    const resultLine = encodeRolloutResultLine({
      ok: true,
      rolled: ["clerk"],
      warnings: [],
    });
    expect(parseRolloutPhaseLine(resultLine)).toBeNull();
  });

  it("adversarial embed: a phase field value carrying a newline + RESULT sentinel does NOT corrupt the terminal parse", () => {
    // The no-terminal-parse-corruption property is safe TODAY because
    // RolloutPhase has no free-text field. This test LOCKS it: if a future
    // field ever carried attacker/free-text and someone embedded the terminal
    // sentinel in it, the encoded phase line must STILL never parse as the
    // terminal RESULT sentinel. encodeRolloutPhaseLine JSON-encodes the value,
    // so a literal newline becomes `\n` and the embedded `RESULT:{...}` stays
    // inside the JSON string on the single phase line — the line still starts
    // with the PHASE sentinel, and parseRolloutResultLine anchors on
    // startsWith(RESULT_SENTINEL), so it returns null.
    const evil = "\n" + ROLLOUT_RESULT_SENTINEL + '{"ok":true,"rolled":["pwned"],"warnings":[]}';
    const line = encodeRolloutPhaseLine({ phase: "apply", target: evil });
    // The phase line is a SINGLE line (the newline was escaped, not literal).
    expect(line.includes("\n")).toBe(false);
    // The terminal parser must not be fooled — it returns null.
    expect(parseRolloutResultLine(line)).toBeNull();
    // And the phase parser round-trips the (escaped) value faithfully.
    expect(parseRolloutPhaseLine(line)?.phase).toBe("apply");

    // Belt-and-braces: even if such a line were split on newlines (as a reader
    // tailing stdout would), no resulting fragment starts with the RESULT
    // sentinel as a standalone parseable line — the sentinel sits mid-JSON,
    // prefixed by the phase sentinel + JSON quoting, never at line-start.
    for (const frag of line.split("\n")) {
      expect(parseRolloutResultLine(frag)).toBeNull();
    }
  });

  it("round-trips a phase with agent/n/m", () => {
    const phase: RolloutPhase = {
      phase: "agent-start",
      target: "v1.2.3",
      agent: "clerk",
      n: 3,
      m: 8,
    };
    const parsed = parseRolloutPhaseLine(encodeRolloutPhaseLine(phase));
    expect(parsed).toEqual(phase);
  });

  it("rejects malformed JSON and unknown phase names", () => {
    expect(parseRolloutPhaseLine(ROLLOUT_PHASE_SENTINEL + "{not json")).toBeNull();
    expect(
      parseRolloutPhaseLine(ROLLOUT_PHASE_SENTINEL + JSON.stringify({ phase: "bogus", target: "v1" })),
    ).toBeNull();
    // Missing target.
    expect(
      parseRolloutPhaseLine(ROLLOUT_PHASE_SENTINEL + JSON.stringify({ phase: "apply" })),
    ).toBeNull();
    // A plain (non-sentinel) line is not a phase.
    expect(parseRolloutPhaseLine("just a log line")).toBeNull();
  });

  it("tolerates surrounding whitespace on the line", () => {
    const line = "  " + encodeRolloutPhaseLine({ phase: "persist-pin", target: "v9.9.9" }) + "  ";
    expect(parseRolloutPhaseLine(line)?.phase).toBe("persist-pin");
  });
});

describe("executeRollout — phase emission", () => {
  const TARGET = "v0.15.18";

  it("emits apply → canary-start/pass → agent-start/done with n/m", () => {
    const steps = planRollout(["test-harness", "clerk", "marko"]);
    const { deps, phases } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18", marko: "0.15.18" },
    });
    executeRollout(steps, TARGET, deps);
    const names = phases.map((p) => p.phase);
    expect(names).toContain("apply");
    // test-harness is the canary (first restart) → canary-start/canary-pass.
    expect(names).toContain("canary-start");
    expect(names).toContain("canary-pass");
    // clerk + marko → agent-start/agent-done.
    expect(names).toContain("agent-start");
    expect(names).toContain("agent-done");
    // Canary is n=1; total m = 3.
    const canaryStart = phases.find((p) => p.phase === "canary-start");
    expect(canaryStart).toMatchObject({ agent: "test-harness", n: 1, m: 3, target: TARGET });
    // A later agent carries its 1-based position.
    const lastDone = phases.filter((p) => p.phase === "agent-done").at(-1);
    expect(lastDone).toMatchObject({ agent: "marko", n: 3, m: 3 });
  });

  it("emits canary-fail (not agent-done) when the canary mismatches and STOPS", () => {
    const steps = planRollout(["test-harness", "clerk"]);
    const { deps, phases } = harness({
      // Canary comes back on the WRONG version → stop.
      versions: { "test-harness": "0.15.17", clerk: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(false);
    const names = phases.map((p) => p.phase);
    expect(names).toContain("canary-start");
    expect(names).toContain("canary-fail");
    expect(names).not.toContain("canary-pass");
    // Never reached clerk.
    expect(names).not.toContain("agent-start");
  });

  it("emits agent-done (per-agent stop) when a NON-canary agent mismatches", () => {
    const steps = planRollout(["test-harness", "clerk"]);
    const { deps, phases } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.17" }, // clerk bad
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(false);
    const names = phases.map((p) => p.phase);
    expect(names).toContain("canary-pass"); // canary was fine
    // clerk failed → agent-done (its start + the fail-shaped done), never canary-*.
    const clerkDone = phases.filter((p) => p.phase === "agent-done" && p.agent === "clerk");
    expect(clerkDone.length).toBe(1);
  });

  it("emits a persist-pin phase on the hostd path", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      hostdContext: true,
      pinToPersist: TARGET,
    });
    const { deps, phases } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18" },
    });
    executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(phases.map((p) => p.phase)).toContain("persist-pin");
  });

  it("does not throw when emitPhase is omitted (older callers)", () => {
    const steps = planRollout(["clerk"]);
    const runs: string[][] = [];
    const deps: RolloutDeps = {
      run: (a) => {
        runs.push(a);
        return { status: 0 };
      },
      probeVersion: () => "0.15.18",
      log: () => {},
      // no emitPhase
    };
    expect(() => executeRollout(steps, TARGET, deps)).not.toThrow();
  });
});
