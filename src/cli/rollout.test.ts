/**
 * Tests for `switchroom rollout` — the staggered fleet-deploy verb.
 *
 * Focus is the reliability-critical logic that the manual recipe got wrong
 * in past incidents: correct ordering (apply BEFORE restarts; web/hostd
 * AFTER), canary-first, the per-agent version assert, and STOP-on-first-
 * mismatch (never leave the fleet half-rolled silently). The executor takes
 * injected side-effects so this runs without docker.
 */

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
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
  createRolloutDeps,
  isSpawnTimeout,
  ROLLOUT_RUN_TIMEOUT_MS,
  ROLLOUT_PROBE_TIMEOUT_MS,
  type RolloutSpawnSync,
} from "./rollout.js";
import {
  beginPinPersist,
  hasPinJournal,
  pinJournalPath,
  readPinJournal,
  recoverPinJournal,
  PIN_JOURNAL_MAX_AGE_MS,
} from "./rollout-pin-journal.js";
import { getReleasePinFromConfig } from "./release-yaml.js";
import { SCOPED_SWEEP_ENV } from "../agents/agent-owned-tree.js";

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
  /** Injected running-web image tag for the refresh-web skew probe.
   *  Defaults to the roll target shape being unknown (null → probe skipped
   *  by the isVersionAssertable gate never fires a warning). */
  webImageTag?: string | null;
}): {
  deps: RolloutDeps;
  runs: string[][];
  runEnvs: Array<Record<string, string> | undefined>;
  logs: string[];
  persisted: string[];
  phases: RolloutPhase[];
} {
  const runs: string[][] = [];
  const runEnvs: Array<Record<string, string> | undefined> = [];
  const logs: string[] = [];
  const persisted: string[] = [];
  const phases: RolloutPhase[] = [];
  const deps: RolloutDeps = {
    run: (args, runOpts) => {
      runs.push(args);
      runEnvs.push(runOpts?.env);
      return { status: opts.runStatus ? opts.runStatus(args) : 0 };
    },
    probeVersion: (agent) => opts.versions[agent] ?? null,
    log: (line) => logs.push(line),
    emitPhase: (p) => phases.push(p),
    persistPin: (pin) => persisted.push(pin),
    hindsightExists: () => opts.hindsightExists ?? false,
    webImageTag: () => opts.webImageTag ?? null,
  };
  return { deps, runs, runEnvs, logs, persisted, phases };
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

  it("injects the scoped-sweep env into ONLY the canary restart spawn (#3333 amendment C)", () => {
    const steps = planRollout(["clerk", "marko", "nadia"]);
    const { deps, runs, runEnvs } = harness({
      versions: { clerk: "0.15.18", marko: "0.15.18", nadia: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(true);

    // Correlate each restart spawn with the env it was given.
    const restartIdxs = runs
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a[0] === "agent" && a[1] === "restart")
      .map(({ i }) => i);
    expect(restartIdxs.length).toBe(3);

    // Canary = first restarted agent → gets the flag.
    expect(runEnvs[restartIdxs[0]]).toEqual({ [SCOPED_SWEEP_ENV]: "1" });
    // Every subsequent agent → NO flag (global env would defeat the canary).
    expect(runEnvs[restartIdxs[1]]).toBeUndefined();
    expect(runEnvs[restartIdxs[2]]).toBeUndefined();

    // And nothing else in the roll (apply, webd, hostd) carries the flag.
    for (let i = 0; i < runs.length; i++) {
      if (i === restartIdxs[0]) continue;
      expect(runEnvs[i]?.[SCOPED_SWEEP_ENV]).toBeUndefined();
    }
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
    // apply → canary (test-harness) → persist-pin → rest → refresh-web →
    // refresh-hindsight → sweep.
    expect(kinds).toEqual([
      "apply",
      "r:test-harness",
      "persist-pin",
      "r:clerk",
      "refresh-web",
      "refresh-hindsight",
      "sweep",
    ]);
    // persist-pin comes strictly AFTER the canary restart.
    const persistIdx = kinds.indexOf("persist-pin");
    const canaryIdx = kinds.indexOf("r:test-harness");
    expect(persistIdx).toBeGreaterThan(canaryIdx);
  });

  it("DROPS the hostd refresh step (deferred — would SIGKILL itself) but KEEPS refresh-web", () => {
    const kinds = planRollout(["clerk", "marko"], {
      pinToPersist: TARGET,
      hostdContext: true,
    }).map((s) => s.kind);
    // hostd is this process's parent — recreating it mid-roll SIGKILLs the
    // roll. web is a SEPARATE compose project with no parent/child relation
    // to hostd, so it's safe to recreate in-plan; dropping it left web
    // silently stale after every agent-driven roll.
    expect(kinds).not.toContain("refresh-hostd");
    expect(kinds).toContain("refresh-web");
  });

  it("refresh-web lands AFTER all agent restarts and BEFORE refresh-hindsight", () => {
    const steps = planRollout(["clerk", "marko", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const kinds = steps.map((s) => s.kind);
    const webIdx = kinds.indexOf("refresh-web");
    const lastRestartIdx = kinds.lastIndexOf("restart-agent");
    expect(webIdx).toBeGreaterThan(lastRestartIdx);
    expect(webIdx).toBeLessThan(kinds.indexOf("refresh-hindsight"));
  });

  it("skipWeb drops refresh-web on the hostd path too", () => {
    const kinds = planRollout(["clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
      skipWeb: true,
    }).map((s) => s.kind);
    expect(kinds).not.toContain("refresh-web");
    // hindsight recreate is independent of --skip-web on the hostd path.
    expect(kinds).toContain("refresh-hindsight");
  });

  it("RECREATES the hindsight singleton (standalone docker run — hostd can recreate it)", () => {
    const steps = planRollout(["clerk", "marko"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const kinds = steps.map((s) => s.kind);
    // hindsight is a standalone `docker run` hostd owns via the docker
    // socket — it must be rolled so the memory backend isn't left a version
    // behind (unlike refresh-hostd, which stays host-side/self-bump).
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

  // Web-staleness fix: the hostd plan now includes refresh-web (web is a
  // separate compose project with no parent/child relation to hostd, so the
  // recreate cannot SIGKILL the in-flight roll). Assert the executor really
  // invokes `webd install --tag <target>` on this path.
  it("runs `webd install --tag <target>` on the hostd path (web no longer left stale)", () => {
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps, runs } = harness({
      versions: { "test-harness": "0.15.18", clerk: "0.15.18" },
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    expect(runs).toContainEqual(["webd", "install", "--tag", TARGET]);
    // ...and hostd install is NOT run (deferred — would SIGKILL itself).
    expect(runs.some((a) => a[0] === "hostd")).toBe(false);
  });

  // Rollback rolls must FORWARD --allow-downgrade to the singleton
  // installers: their downgrade guard otherwise guard-skips with exit 0 and
  // web/hostd silently stay on the NEWER tag (silent staleness, inverted).
  it("forwards --allow-downgrade to webd install on a downgrade roll (hostd path)", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET, hostdContext: true });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      webImageTag: TARGET,
    });
    const r = executeRollout(steps, TARGET, deps, {
      hostdContext: true,
      allowDowngrade: true,
    });
    expect(r.ok).toBe(true);
    expect(runs).toContainEqual([
      "webd",
      "install",
      "--tag",
      TARGET,
      "--allow-downgrade",
    ]);
  });

  it("forwards --allow-downgrade to webd + hostd install on the host-shell path", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      webImageTag: TARGET,
    });
    executeRollout(steps, TARGET, deps, { allowDowngrade: true });
    expect(runs).toContainEqual(["webd", "install", "--tag", TARGET, "--allow-downgrade"]);
    expect(runs).toContainEqual(["hostd", "install", "--tag", TARGET, "--allow-downgrade"]);
  });

  it("does NOT pass --allow-downgrade on a normal (non-rollback) roll", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET, hostdContext: true });
    const { deps, runs } = harness({
      versions: { clerk: "0.15.18" },
      webImageTag: TARGET,
    });
    executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(runs).toContainEqual(["webd", "install", "--tag", TARGET]);
    expect(runs.some((a) => a.includes("--allow-downgrade"))).toBe(false);
  });

  // Belt-and-braces: webd install exits 0 on a downgrade-guard skip, so the
  // executor probes the RUNNING web tag after the install and warns loudly
  // on any skew from the roll target.
  it("warns LOUDLY when web is left on a different version despite exit 0 (guard.skip)", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET, hostdContext: true });
    const { deps } = harness({
      versions: { clerk: "0.15.18" },
      // Running web is NEWER than the roll target — the guard.skip case on
      // a rollback where the flag wasn't honored.
      webImageTag: "v0.15.19",
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => /running v0\.15\.19, NOT the roll target/.test(x));
    expect(w).toBeTruthy();
    expect(w).toContain(`switchroom webd install --tag ${TARGET} --allow-downgrade`);
  });

  it("no skew warning when web lands on the target (or the probe is unavailable)", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET, hostdContext: true });
    const onTarget = harness({ versions: { clerk: "0.15.18" }, webImageTag: TARGET });
    const r1 = executeRollout(steps, TARGET, onTarget.deps, { hostdContext: true });
    expect(r1.warnings.some((w) => /NOT the roll target/.test(w))).toBe(false);
    // Probe null (web absent/unreadable) → no false-positive warning.
    const noProbe = harness({ versions: { clerk: "0.15.18" }, webImageTag: null });
    const r2 = executeRollout(steps, TARGET, noProbe.deps, { hostdContext: true });
    expect(r2.warnings.some((w) => /NOT the roll target/.test(w))).toBe(false);
  });

  it("emits a web-refresh phase so narration doesn't go silent during the recreate", () => {
    const steps = planRollout(["clerk"], { pinToPersist: TARGET, hostdContext: true });
    const { deps, phases } = harness({
      versions: { clerk: "0.15.18" },
      webImageTag: TARGET,
    });
    executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(phases.some((p) => p.phase === "web-refresh" && p.target === TARGET)).toBe(true);
  });

  it("a failed web refresh on the hostd path stays NON-FATAL and names the host-side command", () => {
    const steps = planRollout(["clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    const { deps } = harness({
      versions: { clerk: "0.15.18" },
      runStatus: (args) => (args[0] === "webd" ? 1 : 0),
    });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    expect(r.ok).toBe(true); // agents already rolled — stale web isn't fatal
    const w = r.warnings.find((x) => /web refresh FAILED/.test(x));
    expect(w).toBeTruthy();
    expect(w).toContain(`switchroom webd install --tag ${TARGET}`);
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

// ── The durable pin must not outlive a roll that failed ──────────────────
//
// Before this, `planRollout` ordered `persist-pin` right after the canary
// (hostd path) / first (host-shell path) and NOTHING reverted it when the
// roll then failed at agent 5 of 12. From that moment the durable pin WAS
// the broken version, so every later restart / crash-loop recreate /
// reconcile / `docker compose up -d` converged the remaining agents onto a
// build that demonstrably failed to boot.
//
// These tests assert the OUTCOME on a real config file — what does
// `release.pin` say after the roll? — not that a hook was invoked.

/**
 * Deps for the pin scenarios below, built from the REAL
 * {@link createRolloutDeps} against a tmpdir config.
 *
 * It used to hand-roll its own persist/commit/revert triple that "mirrored"
 * the production factory. That shape is a false-green generator: a harness
 * that reimplements the thing under test asserts only that the COPY works.
 * It hid three production lines completely — `beginPinPersist` inside
 * `persistPin`, its ordering relative to the config write, and
 * `revertPin`'s `writeConfig: writeConfigPreservingOwnership` — each of which
 * could be deleted from `rollout.ts` with the whole suite still green.
 *
 * Only the four deps that genuinely need faking are overridden: `run` and
 * `probeVersion` (which would otherwise spawn docker), `log` (noise), and
 * `hindsightExists`. The `spawn` handed to the factory throws, so a leak of
 * any un-overridden subprocess dep fails loudly instead of silently shelling
 * out from a unit test.
 */
function pinHarness(opts: {
  versions: Record<string, string | null>;
  runStatus?: (args: string[]) => number;
  initialPin?: string;
}): {
  deps: RolloutDeps;
  configPath: string;
  pin: () => string | undefined;
  journalled: () => boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), "rollout-pin-"));
  // The journal lives in the DURABLE switchroom state dir, NOT beside the
  // config (rollout-pin-journal.ts — inside hostd the config's directory is a
  // container-ephemeral overlay). Point it at a tmpdir so the suite never
  // writes into a real `~/.switchroom`.
  process.env.SWITCHROOM_PIN_JOURNAL_DIR = mkdtempSync(join(tmpdir(), "rollout-pin-state-"));
  const configPath = join(dir, "switchroom.yaml");
  writeFileSync(
    configPath,
    `telegram:\n  bot_token: x\nrelease:\n  pin: ${opts.initialPin ?? "v0.19.3"}\nagents:\n  clerk:\n    extends: default\n`,
    "utf8",
  );
  const deps: RolloutDeps = {
    // THE PRODUCTION persist/commit/revert triple — not a copy of it.
    ...createRolloutDeps({
      configPath,
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: (() => {
        throw new Error("pinHarness: an un-overridden dep tried to spawn a subprocess");
      }) as unknown as RolloutSpawnSync,
      warn: () => undefined,
    }),
    run: (args) => ({ status: opts.runStatus ? opts.runStatus(args) : 0 }),
    probeVersion: (agent) => opts.versions[agent] ?? null,
    log: () => undefined,
    emitPhase: () => undefined,
    hindsightExists: () => false,
  };
  return {
    deps,
    configPath,
    pin: () => getReleasePinFromConfig(readFileSync(configPath, "utf8")),
    journalled: () => hasPinJournal(configPath),
  };
}

describe("executeRollout — durable pin is provisional until the roll is proven", () => {
  const TARGET = "v0.19.4";
  const FLEET = ["test-harness", "clerk", "marko", "nadia", "opal"];

  afterEach(() => {
    delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  });

  it("REVERTS the pin when a non-canary agent fails past a green canary (hostd path)", () => {
    // Canary + 2 agents green, then agent 4 comes back on the OLD version.
    const h = pinHarness({
      versions: {
        "test-harness": "0.19.4",
        clerk: "0.19.4",
        marko: "0.19.4",
        nadia: "0.19.3", // failed to boot the new build
        opal: "0.19.4",
      },
    });
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });
    // Sanity: the plan really does persist the pin BEFORE nadia is restarted.
    expect(steps.findIndex((s) => s.kind === "persist-pin")).toBeLessThan(
      steps.findIndex((s) => s.kind === "restart-agent" && s.agent === "nadia"),
    );

    const r = executeRollout(steps, TARGET, h.deps, { hostdContext: true });

    expect(r.ok).toBe(false);
    expect(r.failedAgent).toBe("nadia");
    expect(r.rolled).toEqual(["test-harness", "clerk", "marko"]);
    // THE outcome: the durable pin does NOT name the failed build, so a later
    // reconcile cannot pull opal (and the rest) onto it.
    expect(h.pin()).toBe("v0.19.3");
    expect(r.pinReverted).toBe(true);
    expect(h.journalled()).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/REVERTED to the prior version/);
  });

  it("REVERTS the pin when a non-canary restart TIMES OUT past a green canary", () => {
    // The timed-out-restart branch (#3605) is a stop-the-roll failure that did
    // not exist when the provisional-pin design was written, and it returned
    // its own result literal rather than going through `fail()`. That made the
    // pin guarantee false on exactly the path it matters most: a wedged
    // container is the failure most likely to leave the durable pin naming a
    // build that cannot boot, which every later reconcile then converges the
    // rest of the fleet onto.
    const h = pinHarness({
      versions: Object.fromEntries(FLEET.map((a) => [a, "0.19.4"])),
    });
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });
    // Sanity: the pin really is persisted BEFORE nadia is restarted.
    expect(steps.findIndex((s) => s.kind === "persist-pin")).toBeLessThan(
      steps.findIndex((s) => s.kind === "restart-agent" && s.agent === "nadia"),
    );
    const deps: RolloutDeps = {
      ...h.deps,
      run: (args, opts) =>
        args[0] === "agent" && args[1] === "restart" && args[2] === "nadia"
          ? { status: 1, timedOut: true }
          : h.deps.run(args, opts),
    };

    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.failedAgent).toBe("nadia");
    // THE outcome: the durable pin does NOT name the build that wedged.
    expect(h.pin()).toBe("v0.19.3");
    expect(r.pinReverted).toBe(true);
    expect(h.journalled()).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/REVERTED to the prior version/);
  });

  it("createRolloutDeps' persistPin JOURNALS to disk before it writes the pin", () => {
    // The production wiring, exercised directly rather than through a harness
    // that mirrors it. Three separate production lines live here and nothing
    // else covers them: the `beginPinPersist` call itself, its ORDERING
    // relative to the config write, and the state dir the journal lands in.
    const stateDir = mkdtempSync(join(tmpdir(), "rollout-persist-state-"));
    process.env.SWITCHROOM_PIN_JOURNAL_DIR = stateDir;
    const dir = mkdtempSync(join(tmpdir(), "rollout-persist-"));
    const configPath = join(dir, "switchroom.yaml");
    writeFileSync(
      configPath,
      `telegram:\n  bot_token: x\nrelease:\n  pin: v0.19.3\nagents:\n  clerk:\n    extends: default\n`,
      "utf8",
    );
    const deps = createRolloutDeps({
      configPath,
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: (() => {
        throw new Error("no subprocess expected");
      }) as unknown as RolloutSpawnSync,
      warn: () => undefined,
    });

    deps.persistPin?.(TARGET);

    // A journal EXISTS on disk, in the durable state dir — delete the
    // `beginPinPersist(configPath, pin)` line from production `persistPin` and
    // this is the assertion that notices.
    const journalPath = pinJournalPath(configPath);
    expect(journalPath.startsWith(stateDir + "/")).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
    // …and it was written BEFORE the config, so it records the pin being
    // REPLACED. Move `beginPinPersist` after `writeConfigPreservingOwnership`
    // and priorPin becomes the new pin — two-phase commit silently defeated,
    // with the journal still present to make it look wired.
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      pin: string;
      priorPin?: string;
    };
    expect(journal.pin).toBe(TARGET);
    expect(journal.priorPin).toBe("v0.19.3");
    expect(getReleasePinFromConfig(readFileSync(configPath, "utf8"))).toBe(TARGET);
    delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  });

  it("createRolloutDeps' revertPin restores the pin through the ownership-preserving writer", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rollout-revert-state-"));
    process.env.SWITCHROOM_PIN_JOURNAL_DIR = stateDir;
    const dir = mkdtempSync(join(tmpdir(), "rollout-revert-"));
    const configPath = join(dir, "switchroom.yaml");
    writeFileSync(
      configPath,
      `telegram:\n  bot_token: x # keep me\nrelease:\n  pin: v0.19.3\nagents:\n  clerk:\n    extends: default\n`,
      "utf8",
    );
    const deps = createRolloutDeps({
      configPath,
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: (() => {
        throw new Error("no subprocess expected");
      }) as unknown as RolloutSpawnSync,
      warn: () => undefined,
    });
    deps.persistPin?.(TARGET);
    const inodeAfterPersist = statSync(configPath).ino;

    expect(deps.revertPin?.()).toBe(true);

    expect(getReleasePinFromConfig(readFileSync(configPath, "utf8"))).toBe("v0.19.3");
    expect(hasPinJournal(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("bot_token: x # keep me");
    // Routed through `writeConfigPreservingOwnership` — NOT a bare
    // `writeFileSync`. The observable signature is the atomic tmp+rename:
    // it REPLACES the inode (which is precisely why that writer has to chown
    // back afterwards — CLAUDE.md's "tmp+rename re-owns the file to the
    // writer's euid" rule). A bare `writeFileSync` truncates in place and
    // keeps the inode, so dropping
    // `writeConfig: writeConfigPreservingOwnership` from production
    // `revertPin` flips this.
    expect(statSync(configPath).ino).not.toBe(inodeAfterPersist);
    delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  });

  it("createRolloutDeps' commitPin RETURNS the error, not just warns it", () => {
    // The executor can only promote a failed commit into RolloutResult.warnings
    // if the real deps factory hands the error back. The suite's own harness
    // only MIRRORS that wiring, so without this the production line is covered
    // by nothing and a rebase could drop the `return` in silence.
    const dir = mkdtempSync(join(tmpdir(), "rollout-commitpin-"));
    process.env.SWITCHROOM_PIN_JOURNAL_DIR = mkdtempSync(
      join(tmpdir(), "rollout-commitpin-state-"),
    );
    const configPath = join(dir, "switchroom.yaml");
    writeFileSync(
      configPath,
      `telegram:\n  bot_token: x\nrelease:\n  pin: v0.19.3\nagents:\n  clerk:\n    extends: default\n`,
      "utf8",
    );
    beginPinPersist(configPath, TARGET);
    // A DIRECTORY at the journal path makes unlink fail for every uid, root
    // included — deterministic rather than privilege-dependent.
    rmSync(pinJournalPath(configPath));
    mkdirSync(pinJournalPath(configPath));
    const warned: string[] = [];
    const deps = createRolloutDeps({
      configPath,
      scriptPath: "switchroom",
      hostdCtx: true,
      spawn: (() => ({ status: 0, stdout: "", stderr: "" })) as unknown as RolloutSpawnSync,
      warn: (line) => {
        warned.push(line);
      },
    });

    const err = deps.commitPin?.();

    expect(typeof err).toBe("string");
    expect(err as string).toMatch(/FAILED to clear/);
    // Still warned to stderr as well — the two surfaces are complementary.
    expect(warned.join(" ")).toMatch(/FAILED to clear/);
  });

  it("REVERTS the pin when the host-shell path (persist FIRST) fails at apply", () => {
    // Worst case called out in the bug report: persist-pin is step 1, so a
    // failed apply used to leave a broken pin with ZERO agents rolled.
    const h = pinHarness({
      versions: {},
      runStatus: (args) => (args[0] === "apply" ? 1 : 0),
    });
    const steps = planRollout(FLEET, { pinToPersist: TARGET });
    expect(steps[0]).toEqual({ kind: "persist-pin", pin: TARGET });

    const r = executeRollout(steps, TARGET, h.deps);

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("apply");
    expect(r.rolled).toEqual([]);
    expect(h.pin()).toBe("v0.19.3");
    expect(r.pinReverted).toBe(true);
  });

  it("REVERTS the pin when the hindsight refresh fails after every agent rolled", () => {
    const h = pinHarness({
      versions: Object.fromEntries(FLEET.map((a) => [a, "0.19.4"])),
      runStatus: (args) => (args[0] === "memory" ? 1 : 0),
    });
    const deps: RolloutDeps = { ...h.deps, hindsightExists: () => true };
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });

    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("refresh-hindsight");
    expect(h.pin()).toBe("v0.19.3");
    expect(r.pinReverted).toBe(true);
  });

  it("COMMITS the pin (and clears the journal) only when the whole roll succeeds", () => {
    const h = pinHarness({
      versions: Object.fromEntries(FLEET.map((a) => [a, "0.19.4"])),
    });
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });

    const r = executeRollout(steps, TARGET, h.deps, { hostdContext: true });

    expect(r.ok).toBe(true);
    expect(r.rolled).toEqual(FLEET);
    expect(h.pin()).toBe(TARGET);
    expect(r.pinReverted).toBeUndefined();
    // No journal left behind — a later hostd boot must NOT revert a proven roll.
    expect(h.journalled()).toBe(false);
  });

  it("surfaces a commit that could NOT clear the journal in the structured warnings", () => {
    // A journal surviving a SUCCESSFUL commit is the exact input that makes a
    // later recovery pass revert a PROVEN pin. It used to go only to the
    // `warn` sink (child stderr), which is invisible on the hostd path — the
    // roll's outcome there is consumed as a result object, and the analogous
    // revert failure already lands in `warnings`.
    const h = pinHarness({
      versions: Object.fromEntries(FLEET.map((a) => [a, "0.19.4"])),
    });
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });
    // A DIRECTORY at the journal path makes unlink fail for every uid,
    // including the root the suite may run as — deterministic, not
    // privilege-dependent. Created after persist so it replaces the journal.
    const deps: RolloutDeps = {
      ...h.deps,
      persistPin: (p) => {
        h.deps.persistPin?.(p);
        rmSync(pinJournalPath(h.configPath));
        mkdirSync(pinJournalPath(h.configPath));
      },
    };

    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    // The roll itself SUCCEEDED and the pin is correct…
    expect(r.ok).toBe(true);
    expect(h.pin()).toBe(TARGET);
    // …but the operator is told, through the structured surface.
    expect(r.warnings.join(" ")).toMatch(/FAILED to clear/);
    expect(r.warnings.join(" ")).toMatch(/may revert a proven/);
    expect(r.warnings.join(" ")).toMatch(/The roll SUCCEEDED/);
  });

  it("leaves the journal in place when a crash beats both commit and revert", () => {
    // Model the SIGKILL case: the pin was persisted, then the process died —
    // executeRollout never returned, so neither commit nor revert ran.
    const h = pinHarness({ versions: {} });
    h.deps.persistPin?.(TARGET);
    expect(h.pin()).toBe(TARGET);
    expect(h.journalled()).toBe(true);

    // The crash-recovery net (hostd boot / next rollout) is stale-gated, so
    // while the writer still looks live it deliberately declines — that gate
    // is what stops a hostd restart mid-roll from reverting a running roll.
    expect(recoverPinJournal(h.configPath)).toMatch(/still looks live/);
    expect(h.pin()).toBe(TARGET);

    // Once the journal ages out (the writer is gone / the roll is long over),
    // the same net reverts it.
    const note = recoverPinJournal(h.configPath, {
      now: Date.now() + PIN_JOURNAL_MAX_AGE_MS + 1,
    });
    expect(note).toMatch(/reverted an UNCOMMITTED/);
    expect(h.pin()).toBe("v0.19.3");
  });

  it("does not touch the pin when the roll never persisted one", () => {
    // Target came from config.release.pin — nothing to persist, nothing to
    // revert. A failure must not spuriously rewrite the config.
    const h = pinHarness({
      versions: { "test-harness": "0.19.3" },
      initialPin: TARGET,
    });
    const steps = planRollout(["test-harness"], { hostdContext: true });
    expect(steps.some((s) => s.kind === "persist-pin")).toBe(false);

    const r = executeRollout(steps, TARGET, h.deps, { hostdContext: true });

    expect(r.ok).toBe(false);
    expect(r.pinReverted).toBeUndefined();
    expect(h.pin()).toBe(TARGET);
  });

  it("does NOT commit a journal it never wrote", () => {
    // `commitPin` unlinks the journal for this config. A roll that persisted
    // NOTHING (target came from `config.release.pin`) must therefore leave it
    // alone: the journal on disk belongs to an earlier roll that crashed
    // mid-persist, and it is the only record that `release.pin` names an
    // unproven build. Deleting it on this roll's success destroys the
    // crash-recovery evidence permanently — every recovery site keys off the
    // file's existence — and the bad pin becomes undetectable.
    const h = pinHarness({
      versions: { "test-harness": "0.19.4" },
      initialPin: TARGET,
    });
    beginPinPersist(h.configPath, TARGET); // the crashed roll's journal
    const steps = planRollout(["test-harness"], { hostdContext: true });
    expect(steps.some((s) => s.kind === "persist-pin")).toBe(false);

    const r = executeRollout(steps, TARGET, h.deps, { hostdContext: true });

    expect(r.ok).toBe(true);
    expect(h.journalled()).toBe(true);
    // …and it still names the earlier roll's write, so recovery can act on it.
    expect(readPinJournal(h.configPath)?.priorPin).toBe(TARGET);
  });

  it("warns loudly when the pin was persisted but no revert hook is wired", () => {
    const deps: RolloutDeps = {
      run: () => ({ status: 0 }),
      probeVersion: () => "0.0.1",
      log: () => undefined,
      persistPin: () => undefined,
    };
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/no revert hook was wired/);
  });

  it("REPORTS a step that THREW instead of dying without a result", () => {
    // `beginPinPersist` THROWS by contract when a live roll already holds the
    // journal, and nothing between it and the commander caught that. The
    // exception escaped `executeRollout`, so `encodeRolloutResultLine` never
    // ran and hostd took its no-sentinel branch: `result` inferred from the
    // exit code, no `rolled`, no `failedStep`. `fail()`'s docstring called
    // itself "the single exit point for every stop-the-roll failure" while
    // this path bypassed it entirely.
    const h = pinHarness({ versions: {} });
    const deps: RolloutDeps = {
      ...h.deps,
      persistPin: () => {
        throw new Error("rollout pin journal: … is held by a LIVE roll (pid 41 …)");
      },
    };
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    expect(steps[0]).toEqual({ kind: "persist-pin", pin: TARGET });

    let r: RolloutResult | undefined;
    expect(() => {
      r = executeRollout(steps, TARGET, deps);
    }).not.toThrow();

    // A structured result exists, so the sentinel gets emitted and the status
    // row names the step instead of reading "error, no detail".
    expect(r?.ok).toBe(false);
    expect(r?.failedStep).toBe("persist-pin");
    expect(r?.warnings.join(" ")).toMatch(/held by a LIVE roll/);
    // And the config is untouched: the throw came from the exclusivity gate,
    // so the journal on disk belongs to the OTHER roll. Reverting here would
    // clobber exactly what that gate exists to protect.
    expect(r?.pinReverted).toBeUndefined();
    expect(h.pin()).toBe("v0.19.3");
  });

  it("names the AGENT when a restart step throws past a persisted pin", () => {
    // The same catch must preserve the two fields the terminal row and the
    // operator narration key off — and, unlike the `persist-pin` throw above,
    // this one IS past the provisional write, so it must revert.
    const h = pinHarness({
      versions: Object.fromEntries(FLEET.map((a) => [a, "0.19.4"])),
    });
    const deps: RolloutDeps = {
      ...h.deps,
      probeVersion: (agent) => {
        if (agent === "nadia") throw new Error("docker daemon vanished");
        return "0.19.4";
      },
    };
    const steps = planRollout(FLEET, { pinToPersist: TARGET, hostdContext: true });

    let r: RolloutResult | undefined;
    expect(() => {
      r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    }).not.toThrow();

    expect(r?.ok).toBe(false);
    expect(r?.failedStep).toBe("restart-agent");
    expect(r?.failedAgent).toBe("nadia");
    expect(r?.warnings.join(" ")).toMatch(/docker daemon vanished/);
    // THE outcome: the durable pin does not name the build the roll abandoned.
    expect(r?.pinReverted).toBe(true);
    expect(h.pin()).toBe("v0.19.3");
    expect(h.journalled()).toBe(false);
  });

  it("carries pinReverted + timedOut across the hostd result sentinel", () => {
    const line = encodeRolloutResultLine({
      ok: false,
      rolled: ["clerk"],
      failedStep: "restart-agent",
      failedAgent: "marko",
      got: null,
      timedOut: true,
      pinReverted: true,
      warnings: [],
    });
    const parsed = parseRolloutResultLine(line);
    expect(parsed?.timedOut).toBe(true);
    expect(parsed?.pinReverted).toBe(true);
  });
});

// ── Timeouts: a wedged container must not hang the executor ──────────────
//
// `deps.run` (spawnSync of `switchroom <subcommand>`) and `deps.probeVersion`
// (`docker exec … switchroom --version`) had NO timeout. A wedged container —
// precisely the case a roll exists to fix — blocks spawnSync forever, which
// blocks executeRollout forever, which holds hostd's `fleetMutationInFlight`
// latch forever (cleared in a `.finally()` that never runs because the child
// never exits). No self-clearing path short of restarting hostd.

describe("createRolloutDeps — every subprocess is bounded", () => {
  function spy(): { calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>; spawn: RolloutSpawnSync } {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const spawn: RolloutSpawnSync = (cmd, args, opts) => {
      calls.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
      return { status: 0, stdout: "0.19.4\n" };
    };
    return { calls, spawn };
  }

  it("passes a positive timeout + SIGKILL to the subcommand spawn", () => {
    const { calls, spawn } = spy();
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn,
      warn: () => undefined,
    });
    deps.run(["apply"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.timeout).toBe(ROLLOUT_RUN_TIMEOUT_MS);
    expect(ROLLOUT_RUN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(calls[0]!.opts.killSignal).toBe("SIGKILL");
  });

  it("passes a positive timeout + SIGKILL to the docker version probe", () => {
    const { calls, spawn } = spy();
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn,
      warn: () => undefined,
    });
    expect(deps.probeVersion("clerk")).toBe("0.19.4");
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.opts.timeout).toBe(ROLLOUT_PROBE_TIMEOUT_MS);
    expect(ROLLOUT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(calls[0]!.opts.killSignal).toBe("SIGKILL");
  });

  it("reports a timed-out subcommand as a clean non-zero failure, not a hang", () => {
    const warns: string[] = [];
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      // Node reports a timeout kill as status:null + the killSignal.
      spawn: () => ({ status: null, signal: "SIGKILL" }),
      warn: (l) => warns.push(l),
    });
    const r = deps.run(["agent", "restart", "clerk", "--wait", "--force"]);
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0); // trips every caller's `status !== 0` gate
    const warned = warns.join(" ");
    expect(warned).toMatch(/did not finish within \d+ms and was SIGKILLed/);
    // The warning must be honest about BOTH known imprecisions, so an
    // operator reading it host-side knows what to check.
    expect(warned).toMatch(/OOM killer/);
    expect(warned).toMatch(/grandchildren are NOT killed/);
  });

  it("treats an ETIMEDOUT-flavoured timeout the same way", () => {
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: () =>
        ({ status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }) as ReturnType<RolloutSpawnSync>,
      warn: () => undefined,
    });
    expect(deps.run(["apply"]).timedOut).toBe(true);
  });

  it("a wedged container's version probe returns null instead of blocking", () => {
    const warns: string[] = [];
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: () => ({ status: null, signal: "SIGKILL", stdout: "" }),
      warn: (l) => warns.push(l),
    });
    expect(deps.probeVersion("clerk")).toBeNull();
    expect(warns.join(" ")).toMatch(/wedged/);
  });

  it("isSpawnTimeout does NOT misread an ordinary non-zero exit as a timeout", () => {
    expect(isSpawnTimeout({ status: 1, signal: null }, "SIGKILL")).toBe(false);
    expect(isSpawnTimeout({ status: 0, signal: null }, "SIGKILL")).toBe(false);
    // A DIFFERENT signal (e.g. an operator's SIGTERM) is not our timeout kill.
    expect(isSpawnTimeout({ status: null, signal: "SIGTERM" }, "SIGKILL")).toBe(false);
  });
});

describe("executeRollout — a timed-out step stops the roll cleanly", () => {
  const TARGET = "v0.19.4";

  it("returns ok:false with timedOut set (the executor never blocks)", () => {
    // The whole point: the executor RETURNS. A returned failure is what lets
    // hostd's `.finally()` run and release `fleetMutationInFlight` — the
    // latch that a hung spawnSync stranded forever.
    const h = pinHarness({
      versions: { "test-harness": null },
      runStatus: () => 0,
    });
    const deps: RolloutDeps = {
      ...h.deps,
      run: (args) =>
        args[0] === "agent" ? { status: 1, timedOut: true } : { status: 0 },
    };
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });

    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.failedAgent).toBe("test-harness");
    expect(r.warnings.join(" ")).toMatch(/timeout and was killed/);
    expect(r.warnings.join(" ")).toMatch(/wedged/);
  });

  it("marks an apply timeout as timedOut and stops before any restart", () => {
    const h = pinHarness({ versions: {} });
    const deps: RolloutDeps = {
      ...h.deps,
      run: (args) => (args[0] === "apply" ? { status: 1, timedOut: true } : { status: 0 }),
    };
    const steps = planRollout(["clerk"], { pinToPersist: TARGET });
    const r = executeRollout(steps, TARGET, deps);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("apply");
    expect(r.timedOut).toBe(true);
    // And the provisional pin still got reverted.
    expect(h.pin()).toBe("v0.19.3");
  });

  it("a timed-out apply stops the roll BEFORE any agent is restarted", () => {
    const { deps } = harness({ versions: {} });
    const runs: string[][] = [];
    const r = executeRollout(planRollout(["clerk"]), TARGET, {
      ...deps,
      run: (args) => {
        runs.push(args);
        return args[0] === "apply" ? { status: 1, timedOut: true } : { status: 0 };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("apply");
    expect(r.timedOut).toBe(true);
    // Stopped BEFORE any restart — a timed-out apply must not roll agents.
    expect(runs.map((a) => a[0])).toEqual(["apply"]);
  });

  it("carries timedOut across the hostd result sentinel", () => {
    // The executor runs in a CHILD process on the hostd path; the only
    // channel back to hostd is the stdout sentinel. If `timedOut` doesn't
    // survive encode→parse, hostd records a bare "exit 1" and the operator
    // never learns the step was killed mid-flight (with docker grandchildren
    // possibly still running).
    const { deps: base } = harness({ versions: { "test-harness": null } });
    const deps: RolloutDeps = {
      ...base,
      run: (args) => (args[0] === "agent" ? { status: 1, timedOut: true } : { status: 0 }),
    };
    const steps = planRollout(["test-harness"], { pinToPersist: TARGET, hostdContext: true });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    const round = parseRolloutResultLine(
      "some noise\n" + encodeRolloutResultLine(r) + "\nmore noise\n",
    );
    expect(round?.timedOut).toBe(true);
    expect(round?.ok).toBe(false);
    expect(round?.failedAgent).toBe("test-harness");
  });

  it("omits timedOut from the sentinel for an ordinary (non-timeout) failure", () => {
    const { deps: base } = harness({ versions: {} });
    const r = executeRollout(planRollout(["clerk"]), TARGET, {
      ...base,
      run: (args) => (args[0] === "apply" ? { status: 1 } : { status: 0 }),
    });
    const round = parseRolloutResultLine(encodeRolloutResultLine(r));
    expect(round?.ok).toBe(false);
    // Absent, not `false` — hostd treats absence as "not a timeout".
    expect(round?.timedOut).toBeUndefined();
  });
});

// ── Review follow-ups: the subprocesses that were STILL unbounded ─────────
//
// `deps.run` and `deps.probeVersion` were not the only children spawned from
// inside `executeRollout`. The `refresh-web` step calls `deployedImageTag`
// (`spawnSync("docker", …)`) and `refresh-hindsight` calls
// `isHindsightContainerExists` (`execFileSync("docker", …)`), both IN-PROCESS.
// The docker CLI has no client-side request timeout, so an unresponsive
// dockerd blocked either one forever — executeRollout never returns, hostd's
// runSwitchroom promise never settles, and `fleetMutationInFlight` is stranded
// permanently. Worse-shaped than the original bug: it strands the latch AFTER
// every agent has already rolled.

describe("createRolloutDeps — the in-process docker probes are bounded too", () => {
  function depsWith(spawn: RolloutSpawnSync, warn: (l: string) => void = () => undefined) {
    return createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn,
      warn,
    });
  }

  it("webImageTag's docker inspect carries a positive timeout + SIGKILL", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const deps = depsWith((cmd, args, opts) => {
      calls.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
      return { status: 0, stdout: "ghcr.io/switchroom/switchroom-web:v0.19.4\n" };
    });

    expect(deps.webImageTag?.()).toBe("v0.19.4");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.args[0]).toBe("inspect");
    // The regression this guards: `spawnSync("docker", args, {encoding})` with
    // NO timeout key at all.
    expect(typeof calls[0]!.opts.timeout).toBe("number");
    expect(calls[0]!.opts.timeout as number).toBeGreaterThan(0);
    expect(calls[0]!.opts.timeout).toBe(ROLLOUT_PROBE_TIMEOUT_MS);
    expect(calls[0]!.opts.killSignal).toBe("SIGKILL");
  });

  it("hindsightExists' docker ps carries a positive timeout + SIGKILL", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const deps = depsWith((cmd, args, opts) => {
      calls.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
      return { status: 0, stdout: "switchroom-hindsight\n" };
    });

    expect(deps.hindsightExists?.()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.args.slice(0, 2)).toEqual(["ps", "-a"]);
    expect(typeof calls[0]!.opts.timeout).toBe("number");
    expect(calls[0]!.opts.timeout as number).toBeGreaterThan(0);
    expect(calls[0]!.opts.timeout).toBe(ROLLOUT_PROBE_TIMEOUT_MS);
    expect(calls[0]!.opts.killSignal).toBe("SIGKILL");
  });

  it("a timed-out docker inspect yields an unknown tag (no throw, no hang)", () => {
    const warns: string[] = [];
    const deps = depsWith(() => ({ status: null, signal: "SIGKILL", stdout: "" }), (l) =>
      warns.push(l),
    );
    // null == "unknown tag" — the refresh-web skew check already skips on
    // null, so a wedged daemon degrades to "no skew assertion", not a hang.
    expect(deps.webImageTag?.()).toBeNull();
    expect(warns.join(" ")).toMatch(/did not answer within \d+ms and was killed/);
  });

  it("a timed-out docker ps reports hindsight as absent rather than hanging", () => {
    const deps = depsWith(() => ({ status: null, signal: "SIGKILL", stdout: "" }));
    // Fails closed: refresh-hindsight no-ops instead of blocking forever.
    expect(deps.hindsightExists?.()).toBe(false);
  });

  // LOW-3 — fail-closed parity with the probe default this runner replaces.
  //
  // `isHindsightContainerExists`'s module default (`defaultDockerProbe`,
  // src/setup/hindsight.ts) wraps its `execFileSync` in try/catch, so ANY
  // throw became a clean `false`. The injected `dockerRun` had no try/catch,
  // so a throw would escape `executeRollout` mid-roll — AFTER every agent has
  // already restarted. spawnSync reports failures on `r.error` rather than
  // throwing (ENOENT included), so this is parity insurance, not a live bug.
  it("a THROWING docker spawn still fails closed for hindsightExists", () => {
    const deps = depsWith(() => {
      throw new Error("spawnSync exploded");
    });
    expect(() => deps.hindsightExists?.()).not.toThrow();
    expect(deps.hindsightExists?.()).toBe(false);
  });

  it("a THROWING docker spawn yields an unknown web tag rather than escaping", () => {
    const deps = depsWith(() => {
      throw new Error("spawnSync exploded");
    });
    expect(() => deps.webImageTag?.()).not.toThrow();
    expect(deps.webImageTag?.()).toBeNull();
  });
});

// ── LOW-2: a TIMED-OUT web/hostd refresh must say so ──────────────────────
//
// Both steps gate only on `r.status !== 0`, and `deps.run` reports a SIGKILLed
// child as `status: 1`. So a timed-out `webd install` / `hostd install`
// produced the generic non-fatal warning that tells the operator to re-run the
// command IMMEDIATELY — while the killed CLI's `docker` grandchildren may
// still be live and mutating the same container. That's the same
// "grandchildren are NOT killed with it" hazard the restart-agent timeout
// branch already surfaces; these steps must surface it too.
describe("executeRollout — a timed-out web/hostd refresh names the timeout", () => {
  const TARGET = "v0.19.4";

  /** Deps whose `webd`/`hostd` spawns report a timeout kill. */
  function timedOutRefreshDeps(which: "webd" | "hostd"): RolloutDeps {
    const { deps: base } = harness({ versions: { clerk: "0.19.4" } });
    return {
      ...base,
      run: (args, o) => {
        const r = base.run(args, o);
        return args[0] === which ? { status: 1, timedOut: true } : r;
      },
    };
  }

  it("refresh-web: the warning says TIMED OUT and to sweep strays BEFORE re-running", () => {
    const deps = timedOutRefreshDeps("webd");
    const r = executeRollout(planRollout(["clerk"]), TARGET, deps);
    // Still non-fatal — agents already rolled.
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => /web refresh/.test(x));
    expect(w).toBeTruthy();
    expect(w).toMatch(/TIMED OUT/);
    expect(w).toMatch(/grandchildren are NOT killed with it/);
    expect(w).toMatch(/BEFORE re-running/);
    expect(w).toContain(`switchroom webd install --tag ${TARGET}`);
  });

  it("refresh-hostd: the warning says TIMED OUT and to sweep strays BEFORE re-running", () => {
    const deps = timedOutRefreshDeps("hostd");
    const r = executeRollout(planRollout(["clerk"]), TARGET, deps);
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => /hostd refresh/.test(x));
    expect(w).toBeTruthy();
    expect(w).toMatch(/TIMED OUT/);
    expect(w).toMatch(/grandchildren are NOT killed with it/);
    expect(w).toMatch(/BEFORE re-running/);
    expect(w).toContain(`switchroom hostd install --tag ${TARGET}`);
  });

  it("an ordinary non-zero refresh exit keeps the plain wording (shapes stay disjoint)", () => {
    const { deps } = harness({
      versions: { clerk: "0.19.4" },
      runStatus: (args) => (args[0] === "webd" || args[0] === "hostd" ? 1 : 0),
    });
    const r = executeRollout(planRollout(["clerk"]), TARGET, deps);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).not.toMatch(/TIMED OUT/);
    expect(r.warnings.some((w) => /web refresh FAILED/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /hostd refresh failed \(non-fatal\)/.test(w))).toBe(true);
  });
});

describe("createRolloutDeps — a timeout can never be reported as success", () => {
  // F5: isSpawnTimeout checks its ETIMEDOUT arm BEFORE status, so a
  // `{status: 0, error: {code: "ETIMEDOUT"}}` shape would have returned
  // `{status: 0, timedOut: true}` — and EVERY caller gates on
  // `if (r.status !== 0)`, so the timeout would have been read as SUCCESS and
  // the roll would have marched on. We could not produce that shape on node
  // v22.23.1, but the JSDoc asserted it as an invariant the code did not
  // enforce. Now it does.
  it("forces a non-zero status when a zero-status result is flagged as a timeout", () => {
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: "switchroom",
      hostdCtx: false,
      spawn: () =>
        ({
          status: 0,
          error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        }) as ReturnType<RolloutSpawnSync>,
      warn: () => undefined,
    });
    const r = deps.run(["agent", "restart", "clerk", "--wait", "--force"]);
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
    expect(r.status).toBe(1);
  });
});

describe("executeRollout — a timed-out restart stops even when the probe PASSES", () => {
  const TARGET = "v0.19.4";

  // F2: the timeout branch used to push a warning and FALL THROUGH to the
  // version probe. A SIGKILL reaps only the direct CLI, so its orphaned
  // `docker compose up -d` grandchild can still bring the container up on the
  // target tag — the probe then passes, `ok` stays true, `timedOut` is never
  // set on the result, and the roll reports SUCCESS for an agent whose
  // post-start reconcile + #3333 scoped ownership sweep were killed and never
  // ran. The pre-existing timeout test could not catch this: it used
  // `versions: { "test-harness": null }`, so the probe failed anyway and the
  // stop was attributable to the null probe, not to the timeout.
  function timedOutRestartDeps(probeVersionValue: string | null): {
    deps: RolloutDeps;
    runs: string[][];
  } {
    const { deps: base, runs } = harness({ versions: { "test-harness": probeVersionValue } });
    return {
      deps: {
        ...base,
        run: (args, o) => {
          const r = base.run(args, o);
          return args[0] === "agent" ? { status: 1, timedOut: true } : r;
        },
      },
      runs,
    };
  }

  it("returns ok:false + timedOut even though the agent reports the target version", () => {
    const { deps, runs } = timedOutRestartDeps(TARGET);
    const steps = planRollout(["test-harness", "clerk"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });

    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });

    // The probe agrees the container is on the target …
    expect(deps.probeVersion("test-harness")).toBe(TARGET);
    // … and the roll STILL stops, flagged as a timeout.
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.failedStep).toBe("restart-agent");
    expect(r.failedAgent).toBe("test-harness");
    expect(r.got).toBe(TARGET);
    // The second agent must never be restarted while the first roll's
    // SIGKILLed grandchild may still be rewriting the compose file.
    expect(runs.filter((a) => a[0] === "agent" && a[1] === "restart")).toHaveLength(1);
    expect(r.rolled).not.toContain("test-harness");
    // The operator is told the agent is half-applied, not rolled.
    expect(r.warnings.join(" ")).toMatch(/timeout and was killed/);
    expect(r.warnings.join(" ")).toMatch(/HALF-APPLIED/);
  });

  it("survives the hostd result sentinel so get_status shows the timeout", () => {
    const { deps } = timedOutRestartDeps(TARGET);
    const steps = planRollout(["test-harness"], { pinToPersist: TARGET, hostdContext: true });
    const r = executeRollout(steps, TARGET, deps, { hostdContext: true });
    const round = parseRolloutResultLine(encodeRolloutResultLine(r));
    expect(round?.ok).toBe(false);
    expect(round?.timedOut).toBe(true);
    expect(round?.failedAgent).toBe("test-harness");
  });

  it("does NOT flag timedOut when the restart exits on its own with a bad version", () => {
    // The disjointness that makes `timedOut` meaningful to hostd: a plain
    // version-assert failure must not look like a killed-mid-flight restart.
    const { deps: base } = harness({ versions: { "test-harness": "v0.19.3" } });
    const steps = planRollout(["test-harness"], { pinToPersist: TARGET, hostdContext: true });
    const r = executeRollout(steps, TARGET, base, { hostdContext: true });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("restart-agent");
    expect(r.timedOut).toBeUndefined();
  });
});
