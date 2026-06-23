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
import { readFileSync, chownSync, statSync } from "node:fs";
import type { Command } from "commander";
import { getConfig, getConfigPath } from "./helpers.js";
import { setReleasePinInConfig } from "./release-yaml.js";
import { resolveOperatorUid } from "./operator-uid.js";
import { writeConfigFileSync } from "../util/atomic.js";
import { compareReleaseTags } from "../config/release-resolve.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";

/** One ordered step of a rollout plan. Pure data so it unit-tests. */
export type RolloutStep =
  | { kind: "persist-pin"; pin: string }
  | { kind: "apply" }
  | { kind: "restart-agent"; agent: string }
  | { kind: "refresh-web" }
  | { kind: "refresh-hostd" }
  | { kind: "sweep" };

export interface RolloutPlanOpts {
  /** Skip the web + hostd refresh (step 3). */
  skipWeb?: boolean;
  /**
   * When set (i.e. the operator passed `--pin`), persist `release.pin` to
   * switchroom.yaml as the FIRST step so the roll is durable — apply,
   * restart, web and hostd then all read the same persisted pin. Omitted
   * when the target already came from the config's `release.pin` (nothing
   * to persist).
   */
  pinToPersist?: string;
  /**
   * hostd/MCP path (#2487). When true the plan is reshaped for the
   * unattended, agent-invoked rollout:
   *
   *   1. persist-pin moves from FIRST to AFTER the canary agent confirms
   *      the target version (so a failed canary never leaves a persisted-
   *      but-unverified pin that the next reconcile rolls fleet-wide —
   *      brick scenario #2). The canary is rolled on a one-shot `--pin`
   *      image ref via `apply`'s reading of the env-passed target; the
   *      durable pin is only written once the canary is green.
   *   2. the web + hostd refresh steps are DROPPED entirely — an
   *      agent-invoked rollout must not synchronously recreate its own
   *      hostd container (it would SIGKILL the in-flight rollout, which
   *      is hostd's own child — brick scenario #1). The executor reports
   *      "hostd/web refresh deferred — run host-side" instead.
   *
   * Gating the new ordering behind this explicit flag (not euid) keeps the
   * host-shell path's persist-first behavior a deliberate choice.
   */
  hostdContext?: boolean;
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
  const steps: RolloutStep[] = [];
  const ordered = orderAgentsCanaryFirst(agents);

  if (opts.hostdContext) {
    // hostd/MCP path (#2487): persist the pin AFTER the canary confirms,
    // and DROP the hostd/web refresh (defer to host-side). The bare
    // `apply` reads the env-passed one-shot target, so the canary rolls
    // on the target image WITHOUT a durable pin write first.
    steps.push({ kind: "apply" });
    const [canary, ...rest] = ordered;
    if (canary !== undefined) {
      steps.push({ kind: "restart-agent", agent: canary });
      // Durable pin is written only once the canary is green — a failed
      // canary returns from executeRollout BEFORE this step is reached.
      if (opts.pinToPersist) {
        steps.push({ kind: "persist-pin", pin: opts.pinToPersist });
      }
      for (const agent of rest) {
        steps.push({ kind: "restart-agent", agent });
      }
    } else if (opts.pinToPersist) {
      // No agents to roll (shouldn't happen — caller guards) but keep
      // the persist intent consistent.
      steps.push({ kind: "persist-pin", pin: opts.pinToPersist });
    }
    steps.push({ kind: "sweep" });
    return steps;
  }

  // Host-shell path: persist-FIRST (durable before any restart), then
  // the web + hostd refresh — unchanged, deliberate.
  if (opts.pinToPersist) steps.push({ kind: "persist-pin", pin: opts.pinToPersist });
  steps.push({ kind: "apply" });
  for (const agent of ordered) {
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
      case "persist-pin":
        lines.push(`  ${n}. persist release.pin=${s.pin} to switchroom.yaml (durable)`);
        break;
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
  /**
   * Durably persist `release.pin = pin` to switchroom.yaml (comment-
   * preserving, atomic, ownership-restoring). Only invoked for a
   * `persist-pin` step. Optional so callers that never persist (and tests)
   * can omit it.
   */
  persistPin?(pin: string): void;
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
 * Pure guard: returns true when the downgrade should be refused.
 *
 * Refuses only when ALL of:
 *   - hostdContext is true (agent-invoked path, not host-shell),
 *   - pin is supplied (not floating from config),
 *   - allowDowngrade is falsy (operator hasn't authorized the rollback),
 *   - compareReleaseTags returns a negative (concrete downgrade, not a
 *     channel/sha which returns null).
 *
 * Exported for unit testing.
 */
export function shouldRefuseDowngrade(
  hostdContext: boolean,
  pin: string | undefined,
  current: string | undefined,
  allowDowngrade: boolean | undefined,
): boolean {
  if (!hostdContext) return false;
  if (!pin) return false;
  if (allowDowngrade) return false;
  const cmp = compareReleaseTags(pin, current);
  return cmp !== null && cmp < 0;
}

/**
 * `failedStep` label for a roll refused up-front because the DRIVING CLI is
 * older than the target (#2542). Surfaced via the sentinel → hostd status row
 * so `get_status` shows the cause structurally, not just in a stderr tail.
 */
export const PREFLIGHT_STALE_CLI_STEP = "preflight-stale-cli";

/**
 * Pure guard: returns true when the roll must be refused because the CLI
 * DRIVING the rollout is OLDER than the target it's being asked to deploy.
 *
 * Why this is fatal, not a warning (#2542): the rollout's `apply` +
 * per-agent-restart steps regenerate the compose file using THIS CLI's own
 * generator code and version stamp. An older CLI cannot produce a newer
 * target's compose correctly — even when `--pin` resolves the image tag, the
 * compose schema/stamp is the old CLI's — so the roll boots agents on the
 * stale version, fails the canary, and leaves compose drifted to a version
 * older than what's running (a downgrade landmine). The only safe outcome is
 * to refuse BEFORE the first mutation; there is no "work correctly" branch for
 * an old CLI driving a new target.
 *
 * Conservative, mirroring the downgrade guard: refuses ONLY when both the CLI
 * version and the target are clean `vX.Y.Z` semvers and the CLI is strictly
 * older. A dev/sha/channel/unparseable version on either side is unorderable
 * (`compareReleaseTags` → null) and never blocks.
 *
 * Exported for unit testing.
 */
export function shouldRefuseStaleCli(
  cliVersion: string | undefined,
  target: string,
): boolean {
  if (!cliVersion) return false;
  const cmp = compareReleaseTags(
    `v${normalizeVersion(cliVersion)}`,
    `v${normalizeVersion(target)}`,
  );
  return cmp !== null && cmp < 0;
}

/**
 * True when this `switchroom rollout` was spawned by the host-control
 * daemon on behalf of an agent MCP call (#2487). hostd sets
 * `SWITCHROOM_HOSTD_CONTEXT=1` on the child env. The flag flips three
 * deliberate behaviors versus the host-shell path:
 *   - persist the durable pin AFTER the canary, not before (planRollout);
 *   - defer the hostd/web self-refresh (planRollout drops those steps);
 *   - suppress "Run with sudo" guidance + soften the persistPin chown-back
 *     (we're already euid 0 inside the hostd container, not via sudo).
 */
export function isHostdContext(): boolean {
  return process.env.SWITCHROOM_HOSTD_CONTEXT === "1";
}

/**
 * Sentinel prefix for the machine-readable rollout result line. hostd
 * parses this off the spawned child's stdout to populate STRUCTURED
 * status fields (`rolled[]`, `failedStep`, `failedAgent`) instead of
 * flattening the outcome into a stdout tail (#2487 item 4). Emitted only
 * on the hostd-context path; harmless on the host-shell path (we don't
 * emit it there).
 */
export const ROLLOUT_RESULT_SENTINEL = "SWITCHROOM_ROLLOUT_RESULT:";

/** Serialize a result for the sentinel line hostd parses. */
export function encodeRolloutResultLine(result: RolloutResult): string {
  return (
    ROLLOUT_RESULT_SENTINEL +
    JSON.stringify({
      ok: result.ok,
      rolled: result.rolled,
      ...(result.failedStep ? { failedStep: result.failedStep } : {}),
      ...(result.failedAgent ? { failedAgent: result.failedAgent } : {}),
      ...(result.got !== undefined ? { got: result.got } : {}),
      warnings: result.warnings,
    })
  );
}

/** Parse the last sentinel line out of a rollout child's stdout. Returns
 *  null when no sentinel was emitted (e.g. the child died before
 *  finishing). hostd uses this to recover structured fields. */
export function parseRolloutResultLine(
  stdout: string,
): {
  ok: boolean;
  rolled: string[];
  failedStep?: string;
  failedAgent?: string;
  got?: string | null;
  warnings: string[];
} | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith(ROLLOUT_RESULT_SENTINEL)) {
      try {
        return JSON.parse(line.slice(ROLLOUT_RESULT_SENTINEL.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Execute a rollout plan. STOPS at the first failure that can strand the
 * fleet (apply failure, or an agent that doesn't return on the target
 * version). web/hostd refresh failures are non-fatal warnings — the agents
 * are already rolled; a stale dashboard/daemon doesn't strand them.
 */
export interface RolloutExecOpts {
  /**
   * hostd/MCP path (#2487). When true, the durable pin is NOT yet
   * persisted at the `apply` step (it's persisted after the canary), so
   * `apply` is given the one-shot `--pin <target>` to regenerate compose
   * against the target image. On the host-shell path the pin is already
   * persisted, so a bare `apply` reads it from config.
   */
  hostdContext?: boolean;
}

export function executeRollout(
  steps: RolloutStep[],
  target: string,
  deps: RolloutDeps,
  execOpts: RolloutExecOpts = {},
): RolloutResult {
  const targetNorm = normalizeVersion(target);
  const rolled: string[] = [];
  const warnings: string[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case "persist-pin": {
        // On the hostd path this runs AFTER the canary is green; on the
        // host-shell path it runs FIRST. Either way: durably persist so
        // subsequent reconciles read the same pin.
        deps.log(`ROLL_STEP persist-pin — release.pin=${step.pin} to switchroom.yaml`);
        if (deps.persistPin) {
          deps.persistPin(step.pin);
        } else {
          warnings.push(`persist-pin requested but no persist hook wired; pin NOT durable`);
        }
        break;
      }
      case "apply": {
        // hostd path: pin not yet persisted (it follows the canary), so
        // pass the one-shot --pin so compose regenerates on the target.
        // host-shell path: pin already persisted → bare apply reads it.
        deps.log(`ROLL_STEP apply — regenerating compose for ${target}`);
        const applyArgs = execOpts.hostdContext
          ? ["apply", "--pin", target]
          : ["apply"];
        const r = deps.run(applyArgs);
        if (r.status !== 0) {
          return { ok: false, rolled, failedStep: "apply", warnings };
        }
        break;
      }
      case "restart-agent": {
        deps.log(`ROLL_STEP restart-agent — ${step.agent} (--wait --force)`);
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
        deps.log(`ROLL_STEP refresh-web — webd install --tag ${target}`);
        const r = deps.run(["webd", "install", "--tag", target]);
        if (r.status !== 0) warnings.push(`web refresh failed (non-fatal); agents already rolled`);
        break;
      }
      case "refresh-hostd": {
        deps.log(`ROLL_STEP refresh-hostd — hostd install --tag ${target}`);
        const r = deps.run(["hostd", "install", "--tag", target]);
        if (r.status !== 0) warnings.push(`hostd refresh failed (non-fatal); agents already rolled`);
        break;
      }
      case "sweep": {
        deps.log(`ROLL_STEP sweep`);
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
  const hostdCtx = isHostdContext();
  program
    .command("rollout")
    .description(
      "Deploy a pinned version to the fleet, safely (staggered restart + " +
        "per-agent version assert + web/hostd refresh)." +
        (hostdCtx ? "" : " Run with sudo."),
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
    .option(
      "--allow-downgrade",
      "Permit rolling to an older semver tag (operator-approved rollback path). " +
        "When set, the downgrade guard is relaxed so --pin may be older than the " +
        "current release.pin. All other safety rails apply unchanged.",
    )
    .option("--dry-run", "Print the plan and exit without changing anything.")
    .action(async (opts: { pin?: string; agents?: string; skipWeb?: boolean; allowDowngrade?: boolean; dryRun?: boolean }) => {
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
      // #2542 — stale-CLI guard: refuse up-front when the CLI DRIVING this
      // roll is older than the target. An older CLI regenerates compose with
      // its own stale generator + version stamp (the roll's apply +
      // per-agent-restart steps), which boots agents on the stale version,
      // fails the canary, and leaves compose downgraded below what's running.
      // Refuse BEFORE the first mutation — there is no safe "work correctly"
      // path for an old CLI driving a new target. Applies to BOTH the hostd
      // path (the incident: source-unlinked hostd CLI behind the tag) and the
      // host-shell path (an operator on a stale CLI). Conservative: only a
      // clean vX.Y.Z < vX.Y.Z comparison blocks (dev/sha/channel never do).
      if (shouldRefuseStaleCli(SWITCHROOM_VERSION, target)) {
        const cli = normalizeVersion(SWITCHROOM_VERSION);
        const refusal =
          `rollout refused: the driving switchroom CLI is v${cli}, OLDER than ` +
          `the --pin target ${target}. An older CLI regenerates the compose file ` +
          `with its own (stale) generator and version stamp, which would boot ` +
          `agents on v${cli}, fail the canary, and leave compose downgraded ` +
          `below what's running. ` +
          (hostdCtx
            ? `Refresh hostd's CLI first — host-side: \`switchroom hostd install ` +
              `--tag ${target}\` — then re-run the roll.`
            : `Upgrade this CLI to >= ${target} first (e.g. \`switchroom update ` +
              `--pin ${target}\`, or rebuild your checkout), then re-run.`) +
          ` Nothing was changed.`;
        process.stderr.write(refusal + "\n");
        // Surface the cause STRUCTURALLY on the hostd path so get_status / the
        // audit row show failed_step + got, not just a stderr tail (#2542 AC4).
        if (hostdCtx) {
          process.stdout.write(
            encodeRolloutResultLine({
              ok: false,
              rolled: [],
              failedStep: PREFLIGHT_STALE_CLI_STEP,
              got: cli,
              warnings: [refusal],
            }) + "\n",
          );
        }
        process.exitCode = 2;
        return;
      }
      // #2487 PR2 — downgrade guard: reject a version older than the
      // current release.pin on the hostd path UNLESS --allow-downgrade is
      // set (the operator-approved rollback path). compareReleaseTags is
      // conservative: it only refuses a clean vX.Y.Z → older-vX.Y.Z move,
      // never a channel/sha (those return null and never block).
      if (shouldRefuseDowngrade(hostdCtx, opts.pin, config.release?.pin, opts.allowDowngrade)) {
        const current = config.release?.pin;
        process.stderr.write(
          `rollout (hostd path) refuses a DOWNGRADE: ${opts.pin} is older ` +
            `than the current pin ${current}. Pass --allow-downgrade to ` +
            `authorize an operator-approved rollback to a known-good earlier ` +
            `tag. Nothing was changed.\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (opts.allowDowngrade) {
        const current = config.release?.pin;
        process.stdout.write(
          `⤵ DOWNGRADE authorized (operator-approved rollback): ${current ?? "<unpinned>"} → ${opts.pin ?? target}\n`,
        );
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

      // Persist the pin durably only when the operator passed --pin; a
      // target read from config.release.pin is already persisted.
      const steps = planRollout(requested, {
        skipWeb: opts.skipWeb,
        pinToPersist: opts.pin ?? undefined,
        hostdContext: hostdCtx,
      });

      if (opts.dryRun) {
        // Dry-run prints the plan (incl. the persist step) and writes NOTHING
        // — it returns before executeRollout, so no persist/apply/restart runs.
        process.stdout.write(formatRolloutPlan(steps, target) + "\n");
        return;
      }

      const configPath = getConfigPath(program);
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
        persistPin: (pin) => {
          const before = readFileSync(configPath, "utf8");
          const after = setReleasePinInConfig(before, pin);
          if (after === before) return; // idempotent no-op
          // Config-file write: tries atomic rename(2) first; falls back to
          // in-place rewrite on EBUSY/EXDEV/EINVAL (single-file bind mount
          // inside the hostd container rejects rename over the mount point).
          writeConfigFileSync(configPath, after, statSync(configPath).mode & 0o777);
          // chown-back rationale differs by path:
          //   host-shell: rollout self-elevates via sudo; a root write
          //     would leave the operator-owned config root-owned and
          //     EACCES-lock other yaml verbs. chown back to the operator.
          //   hostd: we're euid 0 inside the hostd container's mount
          //     namespace (NOT via sudo). The config is a bind-mounted
          //     single file at /state/config/switchroom.yaml whose
          //     on-disk owner is the operator on the host. resolveOperatorUid()
          //     must resolve the operator's uid for the chown to be
          //     meaningful; if it can't, we SKIP the chown rather than
          //     chown to a wrong/garbage uid — leaving the host's existing
          //     ownership intact is safer than corrupting it (#2487 item 8).
          try {
            if (typeof process.geteuid === "function" && process.geteuid() === 0) {
              const uid = resolveOperatorUid();
              if (uid !== undefined) {
                chownSync(configPath, uid, uid);
              } else if (hostdCtx) {
                process.stderr.write(
                  "⚠️  rollout (hostd path): could not resolve operator uid; " +
                    "skipping config chown-back to avoid leaving switchroom.yaml " +
                    "root-owned. Verify ownership host-side if other yaml verbs " +
                    "EACCES.\n",
                );
              }
            }
          } catch {
            /* dev hosts may lack CAP_CHOWN — best-effort */
          }
        },
      };

      process.stdout.write(
        `${opts.allowDowngrade ? "Rolling back" : "Rolling"} ${requested.length} agent(s) to ${target}…\n`,
      );
      const result = executeRollout(steps, target, deps, { hostdContext: hostdCtx });

      // hostd path: the hostd/web refresh was intentionally dropped from
      // the plan (it would SIGKILL this very process). Surface that as a
      // deferral note so the operator knows to refresh host-side.
      if (hostdCtx) {
        result.warnings.push(
          "hostd/web refresh deferred — run host-side (`switchroom webd install` " +
            "/ `switchroom hostd install`). An agent-invoked rollout cannot " +
            "recreate its own hostd container without killing itself.",
        );
      }

      for (const w of result.warnings) process.stderr.write(`⚠️  ${w}\n`);

      // hostd parses this sentinel to populate STRUCTURED status fields
      // (rolled[]/failedStep/failedAgent) instead of a flattened tail.
      if (hostdCtx) {
        process.stdout.write(encodeRolloutResultLine(result) + "\n");
      }

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
