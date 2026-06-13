/**
 * `switchroom rollout` — deploy a pinned version to the fleet, safely.
 *
 * Encodes the correct, hard-won staggered-rollout sequence as one verb so
 * it can't be fumbled (the manual recipe has several easy-to-miss steps —
 * see the footguns below). It orchestrates the EXISTING hardened
 * subcommands (`apply`, `agent restart`, `webd install`, `hostd install`)
 * in the right order; it introduces no new destructive primitive.
 *
 * The sequence:
 *   1. `apply`  — regenerate the compose file with the pinned image refs.
 *      (apply rewrites compose; it does NOT bounce running agents.)
 *   2. For each agent, STAGGERED: `agent restart <a> --wait --force`, then
 *      assert the in-container `switchroom --version` equals the target.
 *      STOP on the first mismatch (report what rolled, what didn't).
 *   3. Refresh `switchroom-web` + `switchroom-hostd` (separate compose
 *      projects that do NOT self-heal on a pin bump) via `webd/hostd
 *      install --tag`.
 *   4. Final sweep — print a per-agent version table.
 *
 * Footguns this closes (each a real past incident, see CLAUDE.md / memory):
 *   - pin bump needs `apply` BEFORE `agent restart` (restart reconciles the
 *     scaffold, not the compose image refs) — step 1 before step 2.
 *   - the shared singletons (vault-broker / approval-kernel / auth-broker)
 *     self-heal on the first `agent restart` (#2170) — no separate step.
 *   - web + hostd are separate compose projects, stale every release —
 *     step 3.
 *   - the `:latest` pull-race / wrong-version-served — the per-agent
 *     `--version` assert in step 2.
 *
 * `--dry-run` prints the plan and changes nothing. Run with sudo (the
 * spawned `apply` / `agent restart` need root when agents are running).
 */

import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { getConfig } from "./helpers.js";

/** One ordered step of a rollout plan. Pure data so it unit-tests. */
export type RolloutStep =
  | { kind: "apply" }
  | { kind: "restart-agent"; agent: string }
  | { kind: "refresh-web" }
  | { kind: "refresh-hostd" }
  | { kind: "sweep" };

export interface RolloutPlanOpts {
  /** Skip the web + hostd refresh (step 3). */
  skipWeb?: boolean;
}

/**
 * Strip a leading `v` and trim, so a config pin (`v0.15.18`) compares equal
 * to an in-container `switchroom --version` (`0.15.18`).
 */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

/**
 * True only when `target` is a concrete semver (optionally `v`-prefixed) we
 * can assert against the in-container `switchroom --version`. A `sha-<hex>`
 * pin is a VALID release.pin but is NOT version-assertable — the CLI always
 * prints the semver, so a sha target would "mismatch" on agent #1 and stop
 * the roll with a confusing message. Reject it up front instead.
 */
export function isVersionAssertable(target: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(target.trim());
}

/**
 * Order agents canary-first: `test-harness` (the sanctioned canary) goes
 * first if present, so a bad build fails on it before touching the rest
 * (stop-on-first-mismatch turns this into an automatic canary gate).
 */
export function orderAgentsCanaryFirst(agents: string[]): string[] {
  const canary = agents.filter((a) => a === "test-harness");
  const rest = agents.filter((a) => a !== "test-harness");
  return [...canary, ...rest];
}

/**
 * Build the ordered step list. Pure — the executor maps each step to a
 * subcommand spawn. Singletons are intentionally NOT a step: the first
 * `restart-agent` self-heals them (#2170).
 */
export function planRollout(
  agents: string[],
  opts: RolloutPlanOpts = {},
): RolloutStep[] {
  const steps: RolloutStep[] = [{ kind: "apply" }];
  for (const agent of orderAgentsCanaryFirst(agents)) {
    steps.push({ kind: "restart-agent", agent });
  }
  if (!opts.skipWeb) {
    steps.push({ kind: "refresh-web" });
    steps.push({ kind: "refresh-hostd" });
  }
  steps.push({ kind: "sweep" });
  return steps;
}

/** Human-readable plan, for `--dry-run`. */
export function formatRolloutPlan(
  steps: RolloutStep[],
  target: string,
): string {
  const lines = [`Rollout plan → ${target}:`];
  let n = 0;
  for (const s of steps) {
    n += 1;
    switch (s.kind) {
      case "apply":
        lines.push(`  ${n}. apply — regenerate compose with ${target} image refs`);
        break;
      case "restart-agent":
        lines.push(`  ${n}. restart ${s.agent} (--wait --force) + assert --version=${target}`);
        break;
      case "refresh-web":
        lines.push(`  ${n}. webd install --tag ${target} (separate compose project)`);
        break;
      case "refresh-hostd":
        lines.push(`  ${n}. hostd install --tag ${target} (separate compose project)`);
        break;
      case "sweep":
        lines.push(`  ${n}. sweep — print per-agent version table`);
        break;
    }
  }
  lines.push("");
  lines.push("Stops on the first agent that doesn't come back on the target version.");
  return lines.join("\n");
}

/** Injectable side-effects so the executor unit-tests without docker. */
export interface RolloutDeps {
  /** Run a `switchroom <args>` subcommand; returns the exit status. */
  run(args: string[]): { status: number };
  /** Probe the in-container `switchroom --version` for an agent. */
  probeVersion(agent: string): string | null;
  /** Emit a progress line. */
  log(line: string): void;
}

export interface RolloutResult {
  ok: boolean;
  /** Agents confirmed on the target version, in order. */
  rolled: string[];
  /** Set when ok=false — the step/agent that stopped the rollout. */
  failedStep?: string;
  failedAgent?: string;
  got?: string | null;
  /** Non-fatal warnings (e.g. web/hostd refresh failures). */
  warnings: string[];
}

/**
 * Execute a rollout plan. STOPS at the first failure that can strand the
 * fleet (apply failure, or an agent that doesn't return on the target
 * version). web/hostd refresh failures are non-fatal warnings — the agents
 * are already rolled; a stale dashboard/daemon doesn't strand them.
 */
export function executeRollout(
  steps: RolloutStep[],
  target: string,
  deps: RolloutDeps,
  /** Whether to pass `--pin <target>` to the apply step. */
  pinOnApply: boolean,
): RolloutResult {
  const targetNorm = normalizeVersion(target);
  const rolled: string[] = [];
  const warnings: string[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case "apply": {
        deps.log(`→ apply — regenerating compose for ${target}`);
        const args = pinOnApply ? ["apply", "--pin", target] : ["apply"];
        const r = deps.run(args);
        if (r.status !== 0) {
          return { ok: false, rolled, failedStep: "apply", warnings };
        }
        break;
      }
      case "restart-agent": {
        deps.log(`→ restart ${step.agent} (--wait --force)`);
        // `agent restart` can exit 0 while still "polling" on boot — do
        // NOT trust its status; the version assert is the real gate.
        deps.run(["agent", "restart", step.agent, "--wait", "--force"]);
        const got = deps.probeVersion(step.agent);
        if (got === null || normalizeVersion(got) !== targetNorm) {
          deps.log(`  ✗ ${step.agent} → ${got ?? "<unreachable>"} (expected ${target}) — STOPPING`);
          return {
            ok: false,
            rolled,
            failedStep: "restart-agent",
            failedAgent: step.agent,
            got,
            warnings,
          };
        }
        rolled.push(step.agent);
        deps.log(`  ✓ ${step.agent} → ${got}`);
        break;
      }
      case "refresh-web": {
        deps.log(`→ webd install --tag ${target}`);
        const r = deps.run(["webd", "install", "--tag", target]);
        if (r.status !== 0) warnings.push(`web refresh failed (non-fatal); agents already rolled`);
        break;
      }
      case "refresh-hostd": {
        deps.log(`→ hostd install --tag ${target}`);
        const r = deps.run(["hostd", "install", "--tag", target]);
        if (r.status !== 0) warnings.push(`hostd refresh failed (non-fatal); agents already rolled`);
        break;
      }
      case "sweep": {
        deps.log(`→ sweep`);
        for (const a of rolled) {
          const v = deps.probeVersion(a);
          deps.log(`  ${a}: ${v ?? "<unreachable>"}`);
        }
        break;
      }
    }
  }
  return { ok: true, rolled, warnings };
}

export function registerRolloutCommand(program: Command): void {
  program
    .command("rollout")
    .description(
      "Deploy a pinned version to the fleet, safely (staggered restart + " +
        "per-agent version assert + web/hostd refresh). Run with sudo.",
    )
    .option(
      "--pin <version>",
      "Version to roll (e.g. v0.15.18). Defaults to release.pin from config.",
    )
    .option(
      "--agents <list>",
      "Comma-separated subset of agents to roll (default: all configured).",
    )
    .option("--skip-web", "Skip the web + hostd refresh step.")
    .option("--dry-run", "Print the plan and exit without changing anything.")
    .action(async (opts: { pin?: string; agents?: string; skipWeb?: boolean; dryRun?: boolean }) => {
      const config = getConfig(program);
      const target = opts.pin ?? config.release?.pin;
      if (!target) {
        process.stderr.write(
          "rollout needs a pinned version: pass --pin vX.Y.Z, or set " +
            "`release.pin` in switchroom.yaml. (A floating channel has no " +
            "fixed version to assert against.)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (!isVersionAssertable(target)) {
        process.stderr.write(
          `rollout asserts the in-container \`switchroom --version\` (always a ` +
            `semver), so the target must be a tagged release like v0.15.18 — ` +
            `\`${target}\` isn't version-assertable. Pass --pin vX.Y.Z.\n`,
        );
        process.exitCode = 2;
        return;
      }
      const allAgents = Object.keys(config.agents ?? {});
      const requested = opts.agents
        ? opts.agents.split(",").map((s) => s.trim()).filter(Boolean)
        : allAgents;
      const unknown = requested.filter((a) => !allAgents.includes(a));
      if (unknown.length > 0) {
        process.stderr.write(`unknown agent(s): ${unknown.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      if (requested.length === 0) {
        process.stderr.write("no agents to roll.\n");
        process.exitCode = 2;
        return;
      }

      const steps = planRollout(requested, { skipWeb: opts.skipWeb });

      if (opts.dryRun) {
        process.stdout.write(formatRolloutPlan(steps, target) + "\n");
        return;
      }

      const scriptPath = process.argv[1] ?? "switchroom";
      const deps: RolloutDeps = {
        run: (args) => {
          const r = spawnSync(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
          return { status: r.status ?? 1 };
        },
        probeVersion: (agent) => {
          const r = spawnSync(
            "docker",
            ["exec", `switchroom-${agent}`, "sh", "-lc", "switchroom --version"],
            { encoding: "utf8" },
          );
          if (r.status !== 0) return null;
          return (r.stdout ?? "").trim().split("\n").pop()?.trim() ?? null;
        },
        log: (line) => process.stdout.write(line + "\n"),
      };

      process.stdout.write(`Rolling ${requested.length} agent(s) to ${target}…\n`);
      const result = executeRollout(steps, target, deps, opts.pin != null);

      for (const w of result.warnings) process.stderr.write(`⚠️  ${w}\n`);

      if (!result.ok) {
        process.stderr.write(
          `\n✗ Rollout STOPPED at ${result.failedStep}` +
            (result.failedAgent ? ` (${result.failedAgent} → ${result.got ?? "unreachable"})` : "") +
            `.\n  Rolled before stop: ${result.rolled.join(", ") || "none"}.\n` +
            `  Fix the cause, then re-run \`switchroom rollout --pin ${target}\` ` +
            `(idempotent — already-current agents bounce back to the same version).\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `\n✅ Rollout complete — ${result.rolled.length} agent(s) on ${target}` +
          `${result.warnings.length ? ` (with ${result.warnings.length} warning(s) above)` : ""}.\n`,
      );
    });
}
