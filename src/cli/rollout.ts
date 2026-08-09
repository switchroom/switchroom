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
 *      install --tag`, then refresh `switchroom-hindsight` (a standalone
 *      `docker run` — also not compose, also no self-heal) via `memory
 *      setup --recreate --tag <target>` (pull the pinned `:vX.Y.Z` +
 *      recreate). A failed recreate is FATAL — it already stopped/removed
 *      the old container, so leaving the roll "ok" would report success on
 *      a fleet whose memory backend is down.
 *   4. Final sweep — print a per-agent version table.
 *
 * Footguns this closes (each a real past incident, see CLAUDE.md / memory):
 *   - pin bump needs `apply` BEFORE `agent restart` (restart reconciles the
 *     scaffold, not the compose image refs) — step 1 before step 2.
 *   - the shared singletons (vault-broker / approval-kernel / auth-broker)
 *     self-heal on the first `agent restart` (#2170) — no separate step.
 *   - web + hostd are separate compose projects, stale every release —
 *     step 3.
 *   - hindsight is a standalone `docker run` (not a compose service), so a
 *     roll never re-pulls it and it drifts stale — observed stuck on claude
 *     2.1.197 while the fleet moved to 2.1.199. Step 3 re-pulls + recreates
 *     it on the PINNED `:vX.Y.Z` (the roll target), not floating `:latest`,
 *     so hindsight lands on the same version as the rest of the fleet.
 *   - the `:latest` pull-race / wrong-version-served — the per-agent
 *     `--version` assert in step 2.
 *
 * `--dry-run` prints the plan and changes nothing. Run with sudo (the
 * spawned `apply` / `agent restart` need root when agents are running).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, chownSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Command } from "commander";
import { getConfig, getConfigPath } from "./helpers.js";
import { setReleasePinInConfig } from "./release-yaml.js";
import {
  beginPinPersist,
  commitPinPersist,
  rollbackPinPersist,
  recoverPinJournal,
} from "./rollout-pin-journal.js";
import { resolveOperatorUid } from "./operator-uid.js";
import {
  HOST_CLI_STAMP_FILENAME,
  PREFLIGHT_HOST_CLI_STALE_STEP,
  hostCliInstallCommand,
  observeHostCli,
  readHostCliStamp,
  shouldRefuseStaleHostCli,
} from "./host-cli-stamp.js";
import { resolveSelfInvocation } from "./self-invoke.js";
import { writeConfigFileSync } from "../util/atomic.js";
import { compareReleaseTags } from "../config/release-resolve.js";
import {
  HOSTD_TEMPLATE_LAST_CHANGED,
  hostdTemplateRegenVerdict,
} from "../config/hostd-template-version.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import {
  readAndFilter,
  defaultAuditLogPath,
  readAuditRaw,
  auditReadFullWindowBytes,
} from "../host-control/audit-reader.js";
import { isHindsightContainerExists, HINDSIGHT_DEFAULT_API_BASE_URL } from "../setup/hindsight.js";
import { createBank, isHindsightEnabled } from "../memory/hindsight.js";
import { deployedImageTag, type DockerRunner } from "./deploy-version-guard.js";
import { SCOPED_SWEEP_ENV } from "../agents/agent-owned-tree.js";
import {
  collectComponents as collectHostComponents,
  detectComponentDrift,
  type ComponentVersion,
  type ExecFn,
} from "./component-versions.js";
import {
  classifyComponent,
  gatedOwners,
  partitionDrift,
  remediationFor,
} from "./component-scope.js";

/** One ordered step of a rollout plan. Pure data so it unit-tests. */
export type RolloutStep =
  | { kind: "persist-pin"; pin: string }
  | { kind: "apply" }
  | { kind: "restart-agent"; agent: string }
  | { kind: "refresh-web" }
  | { kind: "refresh-hostd" }
  | { kind: "refresh-hindsight" }
  | { kind: "sweep" }
  | { kind: "ensure-banks" }
  | { kind: "verify-components" };

/**
 * `failedStep` label for a roll that converged its agents but left an
 * in-scope component behind the target (#3928). Distinct from every
 * other failure label because the recovery is different: nothing needs
 * rolling BACK — a named component needs finishing forward.
 */
export const VERIFY_COMPONENTS_STEP = "verify-components";

/**
 * `failedStep` label for a roll that converged its agents but could not
 * create a brand-new agent's Hindsight bank (the ordering-fix backstop).
 *
 * Same recovery CLASS as {@link VERIFY_COMPONENTS_STEP}: nothing needs
 * rolling BACK — every agent came back on the target and the pin is
 * committed. A named agent's bank needs finishing FORWARD. Surfaced as a
 * structured `drifted[]`-style failure (the agent names), NOT an
 * `agent reconcile <name>` host-CLI instruction string, so the operator
 * recovers through the same tappable surface as every other roll outcome.
 */
export const ENSURE_BANKS_STEP = "ensure-banks";

/**
 * How many times the ensure-banks backstop probes a bank whose check came
 * back Unreachable/Timeout before concluding Hindsight is genuinely down
 * (total attempts, including the first), and how long it waits between
 * attempts.
 *
 * Why retry at all: the roll's ensure-banks step runs while Hindsight is
 * routinely busy (post-restart warm-up, consolidation load), and a single
 * 5s probe timing out is far more often "Hindsight is busy" than "Hindsight
 * is down". Before this retry existed, one busy blip during a fleet roll
 * emitted a scary per-agent "could not verify <agent>'s bank … restart it
 * to recreate the bank" warning for EVERY agent — 12 false alarms on the
 * v0.19.46 roll while every bank sat healthy on the persistent pg volume.
 */
export const ENSURE_BANKS_ATTEMPTS = 3;
export const ENSURE_BANKS_BACKOFF_MS: readonly number[] = [2_000, 5_000];

export interface RolloutPlanOpts {
  /** Skip the web + hostd + hindsight refresh (step 3). */
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
   *   2. the HOSTD refresh step is DROPPED — an agent-invoked rollout
   *      must not synchronously recreate its own hostd container (it
   *      would SIGKILL the in-flight rollout, which is hostd's own child
   *      — brick scenario #1). The executor reports "hostd refresh
   *      deferred — run host-side" instead. The WEB refresh is KEPT:
   *      switchroom-web is a separate compose project with no parent/
   *      child relationship to hostd (it never mounts docker.sock and
   *      nothing in the roll depends on it), so recreating it from
   *      hostd is safe — dropping it left web silently stale on the
   *      prior tag after every agent-driven roll.
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
 * Priority prefix for the agent roll order, AFTER the canary (operator
 * request, 2026-07-31): the operator's primary agents get the new build
 * as early as possible instead of waiting behind the rest of the fleet.
 *
 * Maintainable by edit: add/remove/reorder names here — `orderAgentsForRoll`
 * applies whatever this list says, skipping names not present in the roll.
 *
 * Deliberately AFTER `test-harness`, not before it: the first restarted
 * agent IS the canary gate (stop-on-first-mismatch, persist-pin-after-canary
 * on the hostd path, the #3333 scoped-sweep staging, and hostd's
 * canary-fail auto-rollback all key off restart position 1). Putting
 * `overlord` literally first would make the operator's primary agent the
 * agent that eats a bad build with no gate in front of it — the exact
 * exposure the sanctioned canary exists to absorb.
 */
export const ROLLOUT_PRIORITY_AGENTS: readonly string[] = [
  "overlord",
  "carrie",
  "finn",
];

/**
 * Order agents for a roll: canary first, then the priority prefix, then
 * everything else in its incoming (config) order.
 *
 *   1. `test-harness` (the sanctioned canary) goes first if present, so a
 *      bad build fails on it before touching the rest
 *      (stop-on-first-mismatch turns this into an automatic canary gate).
 *   2. {@link ROLLOUT_PRIORITY_AGENTS}, in that list's order, for those
 *      present in the roll.
 *   3. All remaining agents, preserving their incoming order.
 */
export function orderAgentsForRoll(agents: string[]): string[] {
  const canary = agents.filter((a) => a === "test-harness");
  const priority = ROLLOUT_PRIORITY_AGENTS.filter(
    (p) => p !== "test-harness" && agents.includes(p),
  );
  const prioritySet = new Set(priority);
  const rest = agents.filter(
    (a) => a !== "test-harness" && !prioritySet.has(a),
  );
  return [...canary, ...priority, ...rest];
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
  const ordered = orderAgentsForRoll(agents);

  if (opts.hostdContext) {
    // hostd/MCP path (#2487): persist the pin AFTER the canary confirms,
    // and DROP the hostd self-refresh (defer to host-side / self-bump).
    // The bare `apply` reads the env-passed one-shot target, so the canary
    // rolls on the target image WITHOUT a durable pin write first.
    steps.push({ kind: "apply" });
    // Refresh hindsight BEFORE any agent restarts, not after (ordering fix).
    // Agent bank creation (`createBank`) runs ONLY inside each agent's
    // in-container restart-reconcile; if hindsight is unreachable/stale during
    // the restart window — which it is, when the terminal refresh was the only
    // thing that recreated it — every agent's `createBank` is silently
    // skipped, and a brand-new agent then hits a raw FK violation on its first
    // retain. Recreating hindsight up front means the memory backend is
    // healthy and on the target tag while agents restart, so each agent's own
    // createBank can succeed. refresh-hindsight is FATAL on failure and now
    // runs BEFORE persist-pin (which follows the canary), so a hindsight
    // failure aborts fail-fast, before any agent is touched, with no pin to
    // revert — strictly better than the old terminal position. The executor's
    // refresh-hindsight case still self-guards via hindsightExists().
    steps.push({ kind: "refresh-hindsight" });
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
    // Recreate the web singleton too: switchroom-web is a SEPARATE compose
    // project (`switchroom-web`) with no parent/child relationship to hostd
    // (it never mounts docker.sock; hostd is not its child), so recreating
    // it from inside hostd cannot SIGKILL this roll — unlike refresh-hostd,
    // which stays host-side/self-bump because hostd IS this process's
    // parent. Without this step, web silently stayed on the prior tag after
    // every agent-driven roll (observed: fleet v0.18.10, web v0.18.9).
    // `webd install` inside hostd is host-home-safe via SWITCHROOM_HOST_HOME
    // (resolveWebHostHome refuses a /host-home bind source).
    if (!opts.skipWeb) {
      steps.push({ kind: "refresh-web" });
    }
    steps.push({ kind: "sweep" });
    // Backstop for the ordering fix: after every agent has restarted (and its
    // own restart-reconcile has ensured its bank against the now-healthy
    // hindsight), re-create any bank that still slipped through. Idempotent,
    // needs only bank_id + apiUrl (no container reconcile). Gated on
    // hindsightExists() in the executor. A bank that STILL can't be created is
    // a structured `drifted[]`-style failure, not an `agent reconcile` string.
    steps.push({ kind: "ensure-banks" });
    // Terminal drift gate (#3928) — read-only, and LAST so it sees the
    // host every preceding step has finished mutating.
    steps.push({ kind: "verify-components" });
    return steps;
  }

  // Host-shell path: persist-FIRST (durable before any restart), then
  // the web + hostd refresh — unchanged, deliberate.
  if (opts.pinToPersist) steps.push({ kind: "persist-pin", pin: opts.pinToPersist });
  steps.push({ kind: "apply" });
  // Refresh hindsight BEFORE the restart loop (ordering fix — see the hostd
  // path above for the full rationale): the memory backend must be healthy and
  // on the target tag while agents restart so each agent's own in-container
  // createBank can succeed, instead of being silently skipped against a stale/
  // absent backend and leaving a brand-new agent to hit a raw FK violation.
  // Still gated by --skip-web on this path (skip-web here also skips the hostd
  // + hindsight refresh, per the flag's contract).
  if (!opts.skipWeb) {
    steps.push({ kind: "refresh-hindsight" });
  }
  for (const agent of ordered) {
    steps.push({ kind: "restart-agent", agent });
  }
  if (!opts.skipWeb) {
    steps.push({ kind: "refresh-web" });
    steps.push({ kind: "refresh-hostd" });
  }
  steps.push({ kind: "sweep" });
  // Backstop for the ordering fix (see the hostd path above): re-create any
  // agent bank that still slipped through, after every restart. Gated on
  // hindsightExists() in the executor; a bank that stays missing is a
  // structured failure, not an `agent reconcile` host-CLI string.
  steps.push({ kind: "ensure-banks" });
  // Terminal drift gate (#3928). Emitted even under --skip-web: the gate's
  // SCOPE is derived from the steps present (see gatedOwners), so skipping
  // the refresh steps exempts those components rather than dropping the
  // check for everything else.
  steps.push({ kind: "verify-components" });
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
      case "refresh-hindsight":
        lines.push(`  ${n}. refresh hindsight — pull ${target} + recreate (standalone docker run, not compose)`);
        break;
      case "sweep":
        lines.push(`  ${n}. sweep — print per-agent version table`);
        break;
      case "ensure-banks":
        lines.push(
          `  ${n}. ensure-banks — create any missing agent Hindsight bank ` +
            `(idempotent backstop; structured failure if one stays missing)`,
        );
        break;
      case "verify-components":
        lines.push(
          `  ${n}. verify-components — assert EVERY in-scope component is on ${target} ` +
            `(same inventory \`switchroom update --check\` uses); non-zero exit if any is behind`,
        );
        break;
    }
  }
  lines.push("");
  lines.push("Stops on the first agent that doesn't come back on the target version.");
  return lines.join("\n");
}

/**
 * One rollout phase transition (#2726 durable observability). Emitted by the
 * spawned subprocess on stdout as a `SWITCHROOM_ROLLOUT_PHASE:` sentinel line;
 * hostd — the SOLE writer of the hash-chained host-control audit log — parses
 * each line and persists it as a phase audit row (see the seam note at the top
 * of this file's phase section). The subprocess NEVER writes the chained log
 * directly: two writers to one hash chain forks it (audit-hashchain.ts § the
 * single-writer contract), so the buildable form of "the roll emits a row per
 * phase" is emit-on-stdout, hostd-appends.
 *
 * The `phase` strings are lexically DISJOINT from the terminal-result sentinel
 * (`SWITCHROOM_ROLLOUT_RESULT:`): a phase line starts with a different prefix,
 * and no phase string equals "terminal" (hostd owns that row). This keeps the
 * terminal-sentinel parser (`parseRolloutResultLine`) unable to mistake a phase
 * line for the result line, and vice versa.
 */
export type RolloutPhaseName =
  | "apply"
  | "canary-start"
  | "canary-pass"
  | "canary-fail"
  | "agent-start"
  | "agent-done"
  | "persist-pin"
  // In-plan web singleton refresh (webd install) — emitted just before the
  // spawn so a slow pull/recreate isn't a silent gap in the narration.
  | "web-refresh"
  // Emitted only when `webd install` exited 0 AND the belt-and-braces image
  // tag probe did not detect a version skew — i.e. the roll actually
  // OBSERVED web on the target (or could not disprove it after a clean
  // install). Absent on failure/skew so the narration surface never shows a
  // fabricated ✓.
  | "web-refresh-done"
  // Hindsight singleton refresh (memory setup --recreate): start / observed
  // success / no-container skip. A FAILED recreate emits no -done phase —
  // the roll stops with failedStep=refresh-hindsight and the terminal row
  // carries the truth.
  | "hindsight-refresh"
  | "hindsight-refresh-done"
  | "hindsight-skipped"
  | "hostd-web-deferred"
  // #2645 — hostd self-bump. Emitted by the DAEMON directly (never via the
  // child's stdout sentinel): "self-bump" when the old hostd hands its own
  // recreate to the sibling helper, "self-bump-done" when the new hostd
  // resumes the roll at boot.
  | "self-bump"
  | "self-bump-done";

export interface RolloutPhase {
  phase: RolloutPhaseName;
  /** The rollout target version (carried on every phase for the reader). */
  target: string;
  /** Agent name (agent-start / agent-done / canary-* rows). */
  agent?: string;
  /** 1-based index of this agent in the roll order (agent-start / -done). */
  n?: number;
  /** Total agents being rolled (agent-start / -done). */
  m?: number;
}

/**
 * Sentinel prefix for a per-phase progress line the rollout subprocess writes
 * to stdout. hostd streams the child's stdout, parses each such line, and
 * appends a hash-chained phase audit row through its single-writer append path.
 *
 * MUST stay lexically disjoint from {@link ROLLOUT_RESULT_SENTINEL} so the
 * terminal parser and the phase parser can never cross-match. (`…PHASE:` vs
 * `…RESULT:` — neither is a prefix of the other.)
 */
export const ROLLOUT_PHASE_SENTINEL = "SWITCHROOM_ROLLOUT_PHASE:";

/** Serialize a phase for the sentinel line hostd parses. */
export function encodeRolloutPhaseLine(phase: RolloutPhase): string {
  return (
    ROLLOUT_PHASE_SENTINEL +
    JSON.stringify({
      phase: phase.phase,
      target: phase.target,
      ...(phase.agent !== undefined ? { agent: phase.agent } : {}),
      ...(phase.n !== undefined ? { n: phase.n } : {}),
      ...(phase.m !== undefined ? { m: phase.m } : {}),
    })
  );
}

/**
 * Parse a single line as a rollout PHASE sentinel. Returns null when the line
 * is not a phase line (including when it is the terminal RESULT sentinel — the
 * two are anchored disjoint). Defensive against malformed JSON / unknown phase
 * names so a torn or forged line degrades to "not a phase" rather than throwing.
 */
export function parseRolloutPhaseLine(line: string): RolloutPhase | null {
  const trimmed = line.trim();
  // Anchor: only a line that STARTS with the phase sentinel is a phase line.
  // The result sentinel starts with a different prefix, so it can never match.
  if (!trimmed.startsWith(ROLLOUT_PHASE_SENTINEL)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed.slice(ROLLOUT_PHASE_SENTINEL.length));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const PHASES: ReadonlySet<string> = new Set([
    "apply",
    "canary-start",
    "canary-pass",
    "canary-fail",
    "agent-start",
    "agent-done",
    "persist-pin",
    "web-refresh",
    "web-refresh-done",
    "hindsight-refresh",
    "hindsight-refresh-done",
    "hindsight-skipped",
    "hostd-web-deferred",
    "self-bump",
    "self-bump-done",
  ]);
  if (typeof o.phase !== "string" || !PHASES.has(o.phase)) return null;
  if (typeof o.target !== "string") return null;
  const out: RolloutPhase = {
    phase: o.phase as RolloutPhaseName,
    target: o.target,
  };
  if (typeof o.agent === "string") out.agent = o.agent;
  if (typeof o.n === "number") out.n = o.n;
  if (typeof o.m === "number") out.m = o.m;
  return out;
}

/** Injectable side-effects so the executor unit-tests without docker. */
export interface RolloutDeps {
  /**
   * Run a `switchroom <args>` subcommand; returns the exit status.
   *
   * `opts.env` layers extra env vars onto the spawned process's environment
   * (#3333 amendment C). This is how the scoped-sweep flag is injected into
   * ONLY the canary restart spawn — the reconcile ownership sweep runs
   * inside this spawned `switchroom agent restart` process, so an env set
   * here (and nowhere else) gates exactly one agent, never the whole fleet.
   *
   * `timedOut` is set when the subprocess exceeded
   * {@link ROLLOUT_RUN_TIMEOUT_MS} and was killed. A timeout is a CLEAN,
   * REPORTED failure — never a hang. See the timeout note on
   * {@link createRolloutDeps}.
   */
  run(args: string[], opts?: { env?: Record<string, string> }): { status: number; timedOut?: boolean };
  /**
   * Probe the in-container `switchroom --version` for an agent. Returns null
   * when the agent is unreachable — INCLUDING when the probe timed out
   * against a wedged container (the exact case a roll exists to fix). The
   * executor treats null as a version mismatch and stops the roll, so a
   * wedged container produces a reported failure instead of a hang.
   */
  probeVersion(agent: string): string | null;
  /** Emit a progress line. */
  log(line: string): void;
  /**
   * Emit a structured phase transition. Default (in production) writes an
   * {@link encodeRolloutPhaseLine} sentinel to stdout for hostd to persist;
   * tests inject a spy. Optional so callers that don't narrate (and older
   * tests) can omit it.
   */
  emitPhase?(phase: RolloutPhase): void;
  /**
   * Durably persist `release.pin = pin` to switchroom.yaml (comment-
   * preserving, atomic, ownership-restoring). Only invoked for a
   * `persist-pin` step. Optional so callers that never persist (and tests)
   * can omit it.
   *
   * PROVISIONAL by contract: the production implementation journals the
   * prior config text first (see rollout-pin-journal.ts), so the write is
   * only durable once {@link RolloutDeps.commitPin} runs. The executor calls
   * {@link RolloutDeps.revertPin} on every failure path after this returned
   * **true** — and on none after it returned false, because a no-op persist
   * wrote nothing and journalled nothing, so there is nothing of this roll's to
   * revert (`fail()` gates on `pinPersisted`). See the return contract below.
   *
   * **Returns whether it actually WROTE** — true when a provisional pin write
   * was journalled, false when the call was a no-op because the config already
   * carried this pin. The distinction is load-bearing and NOT cosmetic: the
   * executor's `commitPin` unlinks the journal for this config path, and a
   * journal it did not write belongs to an EARLIER roll that crashed
   * mid-persist. Committing that destroys the only record that `release.pin`
   * names an unproven build (every recovery site keys off the file's
   * existence), so a no-op persist must leave `pinPersisted` false.
   *
   * The return type is deliberately `boolean`, not `boolean | void`: tsc then
   * forces every implementation — production and test alike — to state which
   * it did, instead of the executor remembering to guess.
   */
  persistPin?(pin: string): boolean;
  /**
   * Mark the provisional pin write durable. Called EXACTLY ONCE, at the very
   * end of a fully successful roll. Optional (a caller with no persistPin
   * has nothing to commit).
   *
   * Returns an operator-facing message when the commit did NOT clear the
   * journal, null/void otherwise. A surviving journal is the exact input that
   * makes a later boot revert a PROVEN pin, so the executor promotes it into
   * {@link RolloutResult.warnings} — the same structured surface the revert
   * failure uses. A stderr-only warning would be invisible on the hostd path,
   * where the roll's outcome is consumed as a result object.
   */
  commitPin?(): string | null | void;
  /**
   * Revert a provisional pin write. Called on every failure return after a
   * `persist-pin` step ran, so a roll that fails at agent 5 of 12 cannot
   * leave the durable pin naming a build that failed to boot. Returns true
   * when a pin was actually reverted (for the operator-facing warning).
   */
  revertPin?(): boolean;
  /**
   * Create (idempotently) the Hindsight memory bank for a rolled agent — the
   * injectable seam behind the terminal `ensure-banks` backstop step.
   *
   * Why this exists: agent bank creation (`createBank`) otherwise runs ONLY
   * inside each agent's in-container restart-reconcile. If Hindsight is
   * unreachable during the agent-restart window, that create is silently
   * skipped; harmless for an existing bank (the pg volume persists it) but a
   * real hole for a brand-new agent, whose bank is then never created and
   * whose first `retain` hits a raw FK violation. `ensure-banks` re-runs the
   * create for every rolled agent AFTER `refresh-hindsight` has recreated the
   * container, closing that window deterministically instead of leaving the
   * only recovery to a host-CLI `agent reconcile`.
   *
   * Production wires this to `createBank(apiUrl, bankIdFor(agent))` — needs
   * only a bank id + api url, no container reconcile — and it is idempotent.
   * Tests inject a fake that reports a bank present or missing. A false result
   * whose `reason` is "Unreachable"/"Timeout" is retried with backoff
   * ({@link ENSURE_BANKS_ATTEMPTS} / {@link ENSURE_BANKS_BACKOFF_MS}) and, if
   * it persists, degrades to a single quiet log line — NOT a warning: the
   * probe not getting through is an environment limitation, not evidence any
   * bank is absent, and each agent's own restart-reconcile already had its
   * chance (#2781 philosophy). Any other failure is a structural,
   * roll-failing residue (verify-components-class), NOT an operator
   * instruction to run a host command.
   *
   * Optional — when unwired (no hindsight, or a test that never reaches the
   * step) the `ensure-banks` step is a clean no-op.
   */
  ensureBank?(agent: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Sleep between `ensureBank` retry attempts (the ensure-banks backstop
   * retries an Unreachable/Timeout probe with backoff before concluding
   * Hindsight is down — a consolidation blip must not read as an outage).
   * Defaults to a real `setTimeout` wait; tests inject an instant fake so
   * the retry loop is exercised without wall-clock delay.
   */
  sleepMs?(ms: number): Promise<void>;
  /**
   * Probe whether the standalone `switchroom-hindsight` container exists on
   * this host (the `refresh-hindsight` step no-ops cleanly when it doesn't).
   * Defaults (in production) to {@link isHindsightContainerExists}; tests
   * inject it so the executor's hindsight branch runs without docker.
   */
  hindsightExists?(): boolean;
  /**
   * Probe the image tag the running `switchroom-web` container was created
   * from (null when absent/unreadable). Used by the refresh-web step's
   * belt-and-braces skew check: `webd install` exits 0 on a downgrade-guard
   * skip (deliberate — see deploy-version-guard.ts), so exit status alone
   * cannot distinguish "web recreated on the target" from "web silently
   * left on a different version". Defaults (in production) to
   * {@link deployedImageTag}("switchroom-web"); tests inject it. Optional —
   * when absent the skew check is skipped.
   */
  webImageTag?(): string | null;
  /**
   * Enumerate every switchroom component on this host and the version it
   * is running — the SAME inventory `switchroom update --check` and
   * `switchroom doctor` consume (`component-versions.ts`). Drives the
   * terminal `verify-components` gate (#3928).
   *
   * Optional ONLY as a test seam. Production always wires it in
   * `createRolloutDeps`, and the executor treats an unwired collector as a
   * loud warning rather than a silent pass — an un-gated roll must never
   * look like a converged one.
   */
  collectComponents?(): ComponentVersion[];
}

export interface RolloutResult {
  ok: boolean;
  /** Agents confirmed on the target version, in order. */
  rolled: string[];
  /** Set when ok=false — the step/agent that stopped the rollout. */
  failedStep?: string;
  failedAgent?: string;
  got?: string | null;
  /**
   * True when the roll stopped because a subprocess exceeded its timeout and
   * was killed. Distinguishes "the build is bad" from "the fleet is wedged".
   */
  timedOut?: boolean;
  /**
   * True when a provisional `release.pin` write was rolled back because this
   * roll failed. Surfaced so the operator knows the durable pin still names
   * the PRIOR (working) version.
   */
  pinReverted?: boolean;
  /**
   * Components still BEHIND the target when the roll finished, and in
   * this roll's scope (#3928). Non-empty ⇒ `ok` is false.
   *
   * Structured (not just prose in `warnings`) because the operator reads
   * this outcome through Telegram — hostd lifts it onto the status entry
   * so `get_status` names the stranded components without anyone grepping
   * a truncated stderr tail.
   */
  drifted?: string[];
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
 *   - defer the hostd self-refresh (planRollout drops that step; the web
 *     refresh stays in-plan — safe, separate compose project);
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
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.pinReverted ? { pinReverted: true } : {}),
      ...(result.drifted && result.drifted.length > 0
        ? { drifted: result.drifted }
        : {}),
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
  timedOut?: boolean;
  pinReverted?: boolean;
  drifted?: string[];
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
  /**
   * Operator-approved rollback roll (`rollout --allow-downgrade`). Must be
   * FORWARDED to the singleton installers (`webd install`, `hostd install`):
   * their downgrade guard (deploy-version-guard.ts) otherwise hits
   * `guard.skip` with exit 0 on a rollback — the agents roll back but the
   * singleton silently stays on the NEWER tag with zero warning, the exact
   * silent-staleness class the refresh steps exist to kill, inverted.
   */
  allowDowngrade?: boolean;
}

/** Outcome of the terminal drift gate (#3928). Pure data. */
export interface RolloutDriftVerdict {
  /** Behind the target AND in this roll's scope. Non-empty ⇒ roll fails. */
  gated: ComponentVersion[];
  /**
   * Behind the target but NOT this roll's responsibility — an agent the
   * operator didn't ask to roll, or a singleton whose refresh step
   * `--skip-web` removed. Reported, never silently dropped.
   */
  exempt: ComponentVersion[];
  /** Version the inventory was compared against (normalized `vX.Y.Z`). */
  target: string | null;
}

/**
 * Compare the live component inventory against the roll target, and split
 * the drift into what this roll must answer for and what it must not.
 *
 * Pure: inventory in, verdict out. THE point of this function is that its
 * inputs are the same inventory `switchroom update --check` reads
 * (`collectComponents`) and the same bucketing it applies
 * (`detectComponentDrift`) — so `rollout` and `update --check` cannot
 * disagree about what is in scope, which is exactly what they did in
 * #3928 (`update --check` named `switchroom-web` and
 * `switchroom-hindsight-autoheal` as targets; the roll that had just
 * "succeeded" had never considered them).
 *
 * Scope is derived from the PLAN, not from flags — see `gatedOwners`.
 */
export function evaluateRolloutDrift(
  components: readonly ComponentVersion[],
  target: string,
  steps: readonly RolloutStep[],
  hostdContext: boolean,
): RolloutDriftVerdict {
  // `detectComponentDrift` resolves its target from a release-pin-shaped
  // string, so normalize the roll target to the canonical `vX.Y.Z` first.
  const report = detectComponentDrift(components, `v${normalizeVersion(target)}`);
  const owners = gatedOwners(
    steps.map((s) => s.kind),
    hostdContext,
  );
  const rolledAgents = new Set(
    steps.flatMap((s) => (s.kind === "restart-agent" ? [s.agent] : [])),
  );
  const { gated, exempt } = partitionDrift(report.behind, { owners, rolledAgents });
  return { gated, exempt, target: report.target };
}

export async function executeRollout(
  steps: RolloutStep[],
  target: string,
  deps: RolloutDeps,
  execOpts: RolloutExecOpts = {},
): Promise<RolloutResult> {
  const targetNorm = normalizeVersion(target);
  const rolled: string[] = [];
  const warnings: string[] = [];
  const emit = (phase: RolloutPhase): void => deps.emitPhase?.(phase);

  // Roll-order accounting for the agent-start/-done phase rows: `m` is the
  // total number of agents this plan restarts; `n` is the 1-based position of
  // the agent being restarted. The canary (first restart-agent step) is n=1.
  const totalAgents = steps.filter((s) => s.kind === "restart-agent").length;
  let agentIndex = 0;

  // Set once the `persist-pin` step ran. Every failure return below goes
  // through `fail()`, which reverts that provisional write — a roll that dies
  // at agent 5 of 12 must NOT leave the durable pin naming the build that
  // just failed to boot, because every later restart/reconcile/`compose up`
  // reads that pin and converges the rest of the fleet onto it.
  let pinPersisted = false;

  /**
   * Verdict of the terminal `verify-components` gate (#3928). Computed
   * inside the step loop (it is read-only), ACTED ON after the loop —
   * see the gate below the pin commit for why the ordering matters.
   */
  let driftVerdict: RolloutDriftVerdict | null = null;

  /**
   * Agents whose Hindsight bank could NOT be ensured by the terminal
   * `ensure-banks` backstop (collected in the step, acted on after the loop
   * alongside the drift gate). A non-"Unreachable" failure here is a
   * structural, roll-failing residue — the SAME class as a `verify-components`
   * drift — not a host-CLI instruction. Populated only when the step runs.
   */
  const bankEnsureFailed: string[] = [];

  /**
   * Single exit point for every stop-the-roll failure. Reverting the pin
   * here (rather than at each `return`) is what makes the guarantee
   * structural: a future failure branch cannot forget to revert.
   *
   * "Every" is load-bearing and was once false. A step that THREW — the
   * documented behaviour of `beginPinPersist` when a live roll already holds
   * the journal — bypassed this entirely: the exception escaped the executor
   * and the commander action, so `encodeRolloutResultLine` never ran and hostd
   * fell to its no-sentinel branch (`result: "error"`, no `rolled`, no
   * `failedStep`) on a path where the canary and every earlier agent had
   * already restarted. The step loop below is therefore wrapped in a try/catch
   * that routes a throw through here; see that catch for which throws do and
   * do NOT revert.
   */
  const fail = (partial: Omit<RolloutResult, "ok" | "rolled" | "warnings">): RolloutResult => {
    let pinReverted = false;
    if (pinPersisted && deps.revertPin) {
      try {
        pinReverted = deps.revertPin();
      } catch (e) {
        warnings.push(
          `FAILED to revert the provisional release.pin after a failed roll: ` +
            `${(e as Error).message}. Check \`release.pin\` in switchroom.yaml ` +
            `host-side BEFORE the next reconcile — it may name a build that ` +
            `failed to boot.`,
        );
      }
      if (pinReverted) {
        deps.log(
          `  ↩ reverted the provisional release.pin — the durable pin still ` +
            `names the prior version`,
        );
        warnings.push(
          `The roll failed after the durable pin had been written, so the ` +
            `provisional \`release.pin\` was REVERTED to the prior version. ` +
            `Agents already rolled stay on the target until they next restart; ` +
            `the rest of the fleet will not converge onto the failed build.`,
        );
      }
    } else if (pinPersisted && !deps.revertPin) {
      warnings.push(
        `The roll failed after \`release.pin\` was persisted but no revert ` +
          `hook was wired — the durable pin may still name the failed build. ` +
          `Verify switchroom.yaml host-side.`,
      );
    }
    return {
      ok: false,
      rolled,
      warnings,
      ...partial,
      ...(pinReverted ? { pinReverted: true } : {}),
    };
  };

  /**
   * The step currently executing, for the catch below. A throw carries no
   * step context of its own, and `failedStep` is the field hostd's status row
   * and the operator narration key off.
   */
  let currentStep: RolloutStep | undefined;

  try {
    for (const step of steps) {
      currentStep = step;
      switch (step.kind) {
        case "persist-pin": {
          // On the hostd path this runs AFTER the canary is green; on the
          // host-shell path it runs FIRST. Either way: durably persist so
          // subsequent reconciles read the same pin.
          deps.log(`ROLL_STEP persist-pin — release.pin=${step.pin} to switchroom.yaml`);
          if (deps.persistPin) {
            // Provisional from here on: `fail()` reverts it, and the success
            // path below commits it — but ONLY if a write actually landed.
            // Taken from the return value, not set as a side effect, so the
            // flag cannot outrun the write in either direction: a THROWING
            // persistPin never assigns (the catch below sees false), and a
            // no-op persistPin (config already at this pin — see
            // `createRolloutDeps`' idempotent early return) reports false, so
            // the success path does not commit — i.e. does not unlink — a
            // journal some earlier crashed roll left at this config path.
            pinPersisted = deps.persistPin(step.pin);
          } else {
            warnings.push(`persist-pin requested but no persist hook wired; pin NOT durable`);
          }
          emit({ phase: "persist-pin", target });
          break;
        }
        case "apply": {
          // hostd path: pin not yet persisted (it follows the canary), so
          // pass the one-shot --pin so compose regenerates on the target.
          // host-shell path: pin already persisted → bare apply reads it.
          //
          // On the hostd path we ALSO pass `--compose-only --non-interactive`.
          // A version roll only needs the compose regenerated with the new
          // image tags plus compose-level env (SWITCHROOM_VOICE_ENGINE) and the
          // sidecar healthcheck — all emitted by generateCompose(), which
          // `--compose-only` still runs. What `--compose-only` skips is the
          // per-agent SCAFFOLD loop (start.sh / .mcp.json / settings.json).
          // Under docker mode (v0.7+) per-agent state dirs are mode 0700 owned
          // by per-agent UIDs; hostd runs unprivileged and cannot write into
          // them, so a FULL apply fails scaffold for every agent, returns
          // non-zero, and aborts the whole roll having rolled nothing (every
          // historical hostd rollout in the audit log: failedStep "apply",
          // rolled []). Skipping scaffold lets the roll actually complete.
          deps.log(`ROLL_STEP apply — regenerating compose for ${target}`);
          emit({ phase: "apply", target });
          const applyArgs = execOpts.hostdContext
            ? ["apply", "--pin", target, "--compose-only", "--non-interactive"]
            : ["apply"];
          const r = deps.run(applyArgs);
          if (r.status !== 0) {
            if (r.timedOut) {
              deps.log(`  ✗ apply TIMED OUT after ${ROLLOUT_RUN_TIMEOUT_MS}ms — STOPPING`);
              warnings.push(
                `apply exceeded its ${ROLLOUT_RUN_TIMEOUT_MS}ms timeout and was ` +
                  `killed. The roll stopped cleanly rather than hanging.`,
              );
            }
            return fail({ failedStep: "apply", ...(r.timedOut ? { timedOut: true } : {}) });
          }
          if (execOpts.hostdContext) {
            // SURFACED (not hidden): --compose-only skipped the host-side
            // per-agent scaffold loop (hostd is unprivileged and cannot write
            // per-agent state dirs). This is NOT left stale: the per-agent
            // restart-reconcile that follows for every agent in this roll
            // refreshes each agent's own templates (start.sh / .mcp.json /
            // settings.json) from inside its own container on restart. So a
            // version roll picks up template changes automatically — no
            // agent-run apply, and no manual host apply, is required here.
            // A host-side `sudo switchroom apply` is only for STRUCTURAL
            // changes (new-agent scaffolding / compose regeneration), not for
            // per-agent template refresh on a roll.
            warnings.push(
              `apply ran --compose-only (hostd is unprivileged and cannot ` +
                `write per-agent state dirs). Compose + compose-level env/` +
                `healthcheck are up to date; per-agent template changes ` +
                `(start.sh / .mcp.json / settings.json) are refreshed ` +
                `automatically by each agent's restart-reconcile in this roll. ` +
                `A host-side \`sudo switchroom apply\` is only needed for ` +
                `structural changes (new agents / compose regeneration).`,
            );
          }
          break;
        }
        case "restart-agent": {
          deps.log(`ROLL_STEP restart-agent — ${step.agent} (--wait --force)`);
          agentIndex += 1;
          const isCanary = agentIndex === 1;
          // The first agent restarted is the sanctioned canary gate
          // (stop-on-first-mismatch). Narrate its start/pass/fail distinctly so
          // the operator sees the canary decision, not just "agent 1/N".
          emit(
            isCanary
              ? { phase: "canary-start", target, agent: step.agent, n: agentIndex, m: totalAgents }
              : { phase: "agent-start", target, agent: step.agent, n: agentIndex, m: totalAgents },
          );
          // `agent restart` can exit 0 while still "polling" on boot — do
          // NOT trust its status; the version assert is the real gate.
          //
          // hostd path: pass --pin <target> so the compose regeneration step
          // inside `agent restart` uses the target image tag. Without this,
          // `reconcileAndRestartAgent` re-reads the stale `release.pin` from
          // config and overwrites the correct compose that `apply --pin` just
          // wrote — putting the canary/agent on the old image (#2558). On the
          // host-shell path the pin is already persisted before `apply` runs,
          // so bare restart reads the correct pin from config; passing --pin
          // there is harmless but unnecessary.
          const restartArgs = execOpts.hostdContext
            ? ["agent", "restart", step.agent, "--wait", "--force", "--pin", target]
            : ["agent", "restart", step.agent, "--wait", "--force"];
          // #3333 amendment C — staged canary rollout of the scoped ownership
          // sweep. The reconcile sweep runs INSIDE this spawned `switchroom
          // agent restart` process, so injecting the scoped-sweep env into the
          // canary spawn ONLY (and reading it at the sweep site) flips exactly
          // one agent per roll — the first-restarted canary. A global/container
          // boot env would flip every agent at once and defeat the canary gate.
          // Verify on the roll: the canary's restart-time collapse (scope=scoped
          // in its `[ownership-sweep] #3333` log) with no approval-card storm,
          // before the default is flipped ON (stage 5).
          const restartRes = deps.run(
            restartArgs,
            isCanary ? { env: { [SCOPED_SWEEP_ENV]: "1" } } : undefined,
          );
          if (restartRes.timedOut) {
            // A wedged container is precisely the case a roll exists to fix.
            // Report it as a bounded, structural failure instead of letting the
            // executor (and hostd's fleet-mutation latch) hang forever.
            //
            // STOP THE ROLL — do NOT fall through to the version probe. A
            // timeout here means the `switchroom agent restart` CLI was
            // SIGKILLed mid-flight, and a SIGKILL reaps only the direct child
            // (see ROLLOUT_KILL_SIGNAL): its `docker compose up -d` grandchild
            // can still be live, still rewriting the compose file. Two things
            // follow, and both are silent if we continue:
            //   1. the orphan may well have brought the container up on the
            //      target tag, so the probe PASSES (`got === targetNorm`) and
            //      the roll reports success — while everything the CLI does
            //      AFTER the container starts (the post-start reconcile and the
            //      #3333 scoped ownership sweep injected via SCOPED_SWEEP_ENV
            //      on the canary) was killed and never ran. A half-applied
            //      agent reported as fully rolled.
            //   2. proceeding restarts the NEXT agent while that orphan is
            //      still mutating containers and the shared compose file — the
            //      exact race ROLLOUT_KILL_SIGNAL's note names.
            // A passing probe is evidence the container came up; it is NOT
            // evidence the restart COMPLETED. Fail closed: the operator is told
            // to check for stray docker processes before re-running, which is
            // only coherent if the roll actually stopped.
            warnings.push(
              `\`agent restart ${step.agent}\` exceeded its ` +
                `${ROLLOUT_RUN_TIMEOUT_MS}ms timeout and was killed — the ` +
                `container is likely wedged. The roll stopped cleanly rather ` +
                `than hanging.`,
            );
            const gotAfterKill = deps.probeVersion(step.agent);
            if (gotAfterKill !== null && normalizeVersion(gotAfterKill) === targetNorm) {
              warnings.push(
                `${step.agent} is reporting ${gotAfterKill} (the roll target) ` +
                  `despite the killed restart — its orphaned \`docker compose\` ` +
                  `grandchild most likely finished the container start. The ` +
                  `restart's POST-start work (reconcile / ownership sweep) was ` +
                  `killed with the CLI and did NOT run, so this agent is ` +
                  `HALF-APPLIED, not rolled. Check for stray docker processes ` +
                  `host-side, then re-run.`,
              );
            }
            deps.log(
              `  ✗ ${step.agent} → restart TIMED OUT (killed after ` +
                `${ROLLOUT_RUN_TIMEOUT_MS}ms; probe says ` +
                `${gotAfterKill ?? "<unreachable>"}) — STOPPING`,
            );
            emit(
              isCanary
                ? { phase: "canary-fail", target, agent: step.agent, n: agentIndex, m: totalAgents }
                : { phase: "agent-done", target, agent: step.agent, n: agentIndex, m: totalAgents },
            );
            // Through `fail()`, not a bare literal: this branch is a
            // stop-the-roll failure like any other, and by the time a restart
            // can time out the `persist-pin` step has already written the
            // provisional durable pin. Returning directly would leave
            // `release.pin` naming the build that just wedged a container —
            // which every later restart/reconcile/`compose up` would then
            // converge the rest of the fleet onto. The single exit point is
            // what makes that guarantee structural rather than remembered.
            return fail({
              failedStep: "restart-agent",
              failedAgent: step.agent,
              got: gotAfterKill,
              timedOut: true,
            });
          }

          // The spawned `switchroom agent restart` exited on its own (not a
          // timeout) but with a NON-ZERO status: reconcile or the restart
          // itself failed — e.g. the ownership sweep threw before the container
          // was ever recreated. Do NOT fall through to the version probe: the
          // container is likely still on the OLD image, and even if the probe
          // happened to read the target tag a non-zero restart means the
          // post-reconcile invariant did not hold. Make the exit status a
          // first-class gate so the halt is causal, not a lucky version
          // mismatch.
          if (restartRes.status !== 0) {
            const gotAfterExit = deps.probeVersion(step.agent);
            deps.log(
              `  ✗ ${step.agent} → restart exited ${restartRes.status} ` +
                `(probe says ${gotAfterExit ?? "<unreachable>"}) — STOPPING`,
            );
            emit(
              isCanary
                ? { phase: "canary-fail", target, agent: step.agent, n: agentIndex, m: totalAgents }
                : { phase: "agent-done", target, agent: step.agent, n: agentIndex, m: totalAgents },
            );
            // Same failure shape as the version-mismatch fail below (no
            // `timedOut`): the child ran to completion and exited non-zero, so
            // there are no live SIGKILL-orphaned grandchildren to warn about —
            // hostd/get_status recovery matches the "ran, wrong outcome" case.
            return fail({
              failedStep: "restart-agent",
              failedAgent: step.agent,
              got: gotAfterExit,
            });
          }

          const got = deps.probeVersion(step.agent);
          if (got === null || normalizeVersion(got) !== targetNorm) {
            deps.log(`  ✗ ${step.agent} → ${got ?? "<unreachable>"} (expected ${target}) — STOPPING`);
            // A failed canary is the gate that stops the whole roll; a
            // failed non-canary is a per-agent stop. Narrate both distinctly.
            emit(
              isCanary
                ? { phase: "canary-fail", target, agent: step.agent, n: agentIndex, m: totalAgents }
                : { phase: "agent-done", target, agent: step.agent, n: agentIndex, m: totalAgents },
            );
            return fail({
              failedStep: "restart-agent",
              failedAgent: step.agent,
              got,
              // No `timedOut` here by construction: the timeout branch above
              // returns unconditionally, so reaching this point means the
              // restart exited on its own and the VERSION ASSERT is what
              // failed. Keeping the two failure shapes disjoint is what lets
              // hostd (and `get_status`) distinguish "killed mid-flight,
              // grandchildren may be live" from "ran to completion, wrong
              // version" — they need different operator recovery.
            });
          }
          rolled.push(step.agent);
          deps.log(`  ✓ ${step.agent} → ${got}`);
          emit(
            isCanary
              ? { phase: "canary-pass", target, agent: step.agent, n: agentIndex, m: totalAgents }
              : { phase: "agent-done", target, agent: step.agent, n: agentIndex, m: totalAgents },
          );
          break;
        }
        case "refresh-web": {
          // Forward --allow-downgrade on a rollback roll: webd install's
          // downgrade guard would otherwise guard.skip with exit 0 — agents
          // roll back but web silently stays on the NEWER tag, no warning.
          const downgradeArgs = execOpts.allowDowngrade ? ["--allow-downgrade"] : [];
          deps.log(
            `ROLL_STEP refresh-web — webd install --tag ${target}` +
              (execOpts.allowDowngrade ? " --allow-downgrade" : ""),
          );
          emit({ phase: "web-refresh", target });
          const r = deps.run(["webd", "install", "--tag", target, ...downgradeArgs]);
          if (r.status !== 0) {
            // A TIMED-OUT refresh is not the same failure as a non-zero exit,
            // and the difference is operationally load-bearing. `deps.run`
            // reports both as `status !== 0`, so without this branch a killed
            // `webd install` produces the generic warning that tells the
            // operator to re-run it IMMEDIATELY — while the killed CLI's
            // `docker` grandchildren may still be live and mutating the same
            // container. That is the same "grandchildren are NOT killed with
            // it" signal the restart-agent timeout branch surfaces; surface it
            // here too rather than losing it.
            warnings.push(
              r.timedOut
                ? `web refresh TIMED OUT after ${ROLLOUT_RUN_TIMEOUT_MS}ms and was ` +
                    `killed (non-fatal — agents already rolled) so switchroom-web ` +
                    `is still on the PRIOR version. Its \`docker\` grandchildren ` +
                    `are NOT killed with it: check for stray docker processes ` +
                    `host-side BEFORE re-running, then finish it host-side: ` +
                    `\`switchroom webd install --tag ${target}\`.`
                : `web refresh FAILED (non-fatal — agents already rolled) so ` +
                    `switchroom-web is still on the PRIOR version. Finish it ` +
                    `host-side: \`switchroom webd install --tag ${target}\`.`,
            );
            break;
          }
          // Belt-and-braces skew check: `webd install` exits 0 on a
          // downgrade-guard skip (deliberate — deploy-version-guard.ts), so a
          // zero exit does NOT prove web is on the target. Probe the running
          // container's image tag and warn LOUDLY on any mismatch.
          const webTag = deps.webImageTag?.();
          if (
            webTag !== undefined &&
            webTag !== null &&
            isVersionAssertable(webTag) &&
            normalizeVersion(webTag) !== targetNorm
          ) {
            warnings.push(
              `web refresh completed but switchroom-web is running ${webTag}, ` +
                `NOT the roll target ${target} (most likely its downgrade guard ` +
                `skipped the install). Finish it host-side: \`switchroom webd ` +
                `install --tag ${target} --allow-downgrade\`.`,
            );
            // No web-refresh-done phase: the probe just DISPROVED "web is on
            // the target", so the narration surface must not show a ✓.
            break;
          }
          if (
            webTag !== undefined &&
            webTag !== null &&
            isVersionAssertable(webTag) &&
            normalizeVersion(webTag) === targetNorm
          ) {
            // OBSERVED success: install exited 0 AND the running container's
            // image tag equals the target. Only this earns the ✓ phase —
            // `webd install` exits 0 on a downgrade-guard skip, so exit
            // status alone observes nothing; when the tag probe can't read a
            // tag the card stays on ⏳ and the terminal verify-components
            // gate resolves it.
            emit({ phase: "web-refresh-done", target });
          }
          break;
        }
        case "refresh-hostd": {
          // Same downgrade-guard forwarding as refresh-web (hostd install
          // shares deploy-version-guard.ts) — a host-shell rollback must not
          // leave hostd silently on the newer tag.
          const downgradeArgs = execOpts.allowDowngrade ? ["--allow-downgrade"] : [];
          deps.log(
            `ROLL_STEP refresh-hostd — hostd install --tag ${target}` +
              (execOpts.allowDowngrade ? " --allow-downgrade" : ""),
          );
          const r = deps.run(["hostd", "install", "--tag", target, ...downgradeArgs]);
          // Same timeout-vs-exit distinction as refresh-web above: a killed
          // `hostd install` leaves live `docker` grandchildren, so the operator
          // must sweep for strays before re-running it.
          if (r.status !== 0)
            warnings.push(
              r.timedOut
                ? `hostd refresh TIMED OUT after ${ROLLOUT_RUN_TIMEOUT_MS}ms and ` +
                    `was killed (non-fatal; agents already rolled). Its \`docker\` ` +
                    `grandchildren are NOT killed with it: check for stray docker ` +
                    `processes host-side BEFORE re-running \`switchroom hostd ` +
                    `install --tag ${target}\`.`
                : `hostd refresh failed (non-fatal); agents already rolled`,
            );
          break;
        }
        case "refresh-hindsight": {
          // hindsight is a STANDALONE `docker run` on the mutable `:latest`
          // tag — it is NOT a compose service and does NOT self-heal on a pin
          // bump, so a roll leaves it pinned to whatever `:latest` resolved to
          // when it was last recreated (observed: hindsight stuck on claude
          // 2.1.197 while the fleet moved to 2.1.199). `memory setup --recreate`
          // pulls the latest hindsight image then recreates the container
          // (pull → stop → start), reusing the running host ports so
          // memory.config.url never drifts under the fleet. No-op cleanly when
          // hindsight isn't installed on this host (guard below also returns
          // false when docker is unavailable).
          const hindsightExists = deps.hindsightExists ?? isHindsightContainerExists;
          if (!hindsightExists()) {
            deps.log(`ROLL_STEP refresh-hindsight — no hindsight container on this host; skipping`);
            emit({ phase: "hindsight-skipped", target });
            break;
          }
          // Thread the pinned rollout target through as `--tag <target>` so the
          // recreate pulls `…switchroom-hindsight:v<target>` — the SAME pinned
          // image the rest of the fleet moved to — NOT floating `:latest`
          // (which drifts hindsight off the roll's version; #2752 fix 1).
          deps.log(
            `ROLL_STEP refresh-hindsight — memory setup --recreate --tag ${target} (pull ${target} + recreate)`,
          );
          emit({ phase: "hindsight-refresh", target });
          const r = deps.run(["memory", "setup", "--recreate", "--tag", target]);
          if (r.status !== 0) {
            // FATAL, not a soft warning (#2752 fix 2): `memory setup --recreate`
            // already did `docker stop && docker rm` before the failing
            // `startHindsight`, so a failed recreate leaves the fleet with NO
            // memory backend. Folding that into the generic non-fatal web/hostd
            // warning while returning ok:true reported success on a fleet whose
            // memory is DOWN. Stop the roll (same stop-on-failure semantics as a
            // failed agent restart) and name the manual recovery.
            deps.log(
              `  ✗ hindsight recreate FAILED — the memory backend is DOWN (the ` +
                `recreate stopped + removed the old container before the failed ` +
                `start). Run \`switchroom memory setup\` to bring it back. — STOPPING`,
            );
            return fail({
              failedStep: "refresh-hindsight",
              ...(r.timedOut ? { timedOut: true } : {}),
            });
          }
          emit({ phase: "hindsight-refresh-done", target });
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
        case "ensure-banks": {
          // Terminal backstop for the bank-creation hole this PR closes.
          // `refresh-hindsight` has already run (reordered to BEFORE the
          // agent-restart loop), so the container is up and reachable — but a
          // brand-new agent whose in-container reconcile ran while hindsight
          // was still down never got its bank created, and its first `retain`
          // would hit a raw FK violation. Re-run the idempotent create for
          // EVERY rolled agent so a missing bank is created here rather than
          // left to a host-CLI `agent reconcile`.
          const hindsightExists = deps.hindsightExists ?? isHindsightContainerExists;
          if (!hindsightExists()) {
            deps.log(`ROLL_STEP ensure-banks — no hindsight container on this host; skipping`);
            break;
          }
          if (!deps.ensureBank) {
            // Unwired seam (no hindsight api/bank-id resolvable). Never a
            // silent pass — say the backstop did not run so a missing bank
            // isn't mistaken for a verified one.
            warnings.push(
              `ensure-banks ran with NO bank-ensure hook wired, so brand-new ` +
                `agents' Hindsight banks were NOT verified. If an agent's first ` +
                `\`retain\` fails with a foreign-key error, its bank was never ` +
                `created — recreate it by restarting that agent.`,
            );
            break;
          }
          deps.log(
            `ROLL_STEP ensure-banks — creating any missing agent bank (idempotent) for ${rolled.length} agent(s)`,
          );
          const sleep =
            deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
          const bankUnverified: string[] = [];
          let lastUnreachableReason = "";
          // Once ONE agent's full retry budget concludes unreachable, later
          // agents get a single probe each (they'd almost certainly hit the
          // same wall, and 12 agents × full backoff would stall the roll for
          // minutes) — but still one probe, since Hindsight may come back
          // mid-loop.
          let concludedUnreachable = false;
          for (const a of rolled) {
            let res: { ok: true } | { ok: false; reason: string } = {
              ok: false,
              reason: "not probed",
            };
            // Retry an Unreachable/Timeout probe with backoff before
            // concluding anything: Hindsight is routinely busy during a roll
            // (post-restart warm-up, consolidation load) and a single 5s
            // probe miss is usually "busy", not "down". A DEFINITIVE create
            // rejection is never retried — it is a real answer.
            const maxAttempts = concludedUnreachable ? 1 : ENSURE_BANKS_ATTEMPTS;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                res = await deps.ensureBank(a);
              } catch (e) {
                res = { ok: false, reason: (e as Error).message };
              }
              if (res.ok || !/unreachable|timeout/i.test(res.reason)) break;
              if (attempt < maxAttempts) {
                const backoff =
                  ENSURE_BANKS_BACKOFF_MS[attempt - 1] ??
                  ENSURE_BANKS_BACKOFF_MS[ENSURE_BANKS_BACKOFF_MS.length - 1] ??
                  0;
                deps.log(
                  `  ${a}: bank check ${res.reason.toLowerCase()} — retrying in ${backoff}ms ` +
                    `(attempt ${attempt}/${maxAttempts})`,
                );
                await sleep(backoff);
              }
            }
            if (res.ok) {
              deps.log(`  ${a}: bank present`);
              continue;
            }
            if (/unreachable|timeout/i.test(res.reason)) {
              // Still unreachable after the retries. Degrade QUIETLY, do NOT
              // warn per-agent: "couldn't reach Hindsight to check" is an
              // environment limitation of THIS probe, not evidence any bank
              // is absent (same philosophy as apply's vault-broker-unreachable
              // degrade, #2781). Every existing agent's bank persists on the
              // pg volume and its own restart-reconcile already had its
              // chance to create a missing one — so there is nothing for the
              // operator to do, and a per-agent "restart it to recreate the
              // bank" alarm here cried wolf 12 times on the v0.19.46 roll
              // while every bank sat healthy. A truly brand-new agent whose
              // bank never got created self-heals on its next
              // restart-reconcile. The genuinely-broken case — Hindsight
              // REACHABLE and the create definitively rejected — still falls
              // through to `bankEnsureFailed` below and fails the roll.
              deps.log(
                `  ${a}: bank check ${res.reason.toLowerCase()} after ` +
                  `${maxAttempts} attempt(s) (transient — not treated as a missing bank)`,
              );
              bankUnverified.push(a);
              lastUnreachableReason = res.reason;
              concludedUnreachable = true;
              continue;
            }
            deps.log(`  ✗ ${a}: bank could NOT be created — ${res.reason}`);
            bankEnsureFailed.push(a);
          }
          if (bankUnverified.length > 0) {
            // ONE informational line for the whole roll, in the log — not in
            // `warnings`, which renders as an operator-facing alarm.
            deps.log(
              `ensure-banks: Hindsight was busy/unreachable (${lastUnreachableReason}) while ` +
                `verifying ${bankUnverified.length} bank(s) (${bankUnverified.join(", ")}) — ` +
                `existing banks are unaffected and nothing needs doing; a brand-new agent's ` +
                `bank is created automatically on its next restart-reconcile.`,
            );
          }
          break;
        }
        case "verify-components": {
          // #3928 — the roll's own convergence proof. Read-only: one
          // `docker ps` through the same collector `switchroom update
          // --check` uses, so the two commands cannot disagree about what
          // was in scope. Everything this step finds is decided AFTER the
          // loop (see the gate below the pin commit).
          deps.log(
            `ROLL_STEP verify-components — asserting every in-scope component is on ${target}`,
          );
          if (!deps.collectComponents) {
            // Never a silent pass: an un-gated roll must not be
            // indistinguishable from a proven one.
            warnings.push(
              `verify-components ran with NO component collector wired, so this ` +
                `roll did not prove the host converged. Confirm with ` +
                `\`switchroom update --check\` — anything still BEHIND ${target} ` +
                `was NOT caught here.`,
            );
            break;
          }
          let inventory: ComponentVersion[];
          try {
            inventory = deps.collectComponents();
          } catch (e) {
            // Deliberately caught HERE rather than left to the step loop's
            // catch: that path routes through `fail()`, which reverts the
            // provisional `release.pin`. A read-only inventory probe that
            // could not run is not evidence the build is bad, and reverting
            // the pin of an otherwise-proven roll would drag the whole fleet
            // back on the next reconcile.
            warnings.push(
              `verify-components could not read the component inventory ` +
                `(${(e as Error).message}), so this roll did not prove the host ` +
                `converged. Confirm with \`switchroom update --check\`.`,
            );
            break;
          }
          driftVerdict = evaluateRolloutDrift(
            inventory,
            target,
            steps,
            execOpts.hostdContext === true,
          );
          for (const c of driftVerdict.exempt) {
            // Behind, but this plan never owned it (a `--agents` subset, or
            // a refresh step `--skip-web` removed). Say so — an explicit
            // opt-out earns a named warning, not silence.
            warnings.push(
              `${c.name} is on ${c.version ?? "an unreadable version"}, behind ` +
                `${target}, but was OUTSIDE this roll's scope (no step in this ` +
                `plan owns it). Finish it: ` +
                `${remediationFor(classifyComponent(c), `v${normalizeVersion(target)}`)}`,
            );
          }
          break;
        }
      }
    }
  } catch (e) {
    // A step THREW rather than returning a status. Before this, the throw
    // escaped `executeRollout`, escaped the commander action, and killed the
    // process before `encodeRolloutResultLine` ran — so hostd took its
    // no-sentinel branch and recorded `result: "error"` with no `rolled` /
    // `failedStep` at all, on a path where (hostd ordering) every agent up to
    // the failure has ALREADY restarted.
    //
    // The concrete source is `beginPinPersist`, which THROWS by contract when
    // a live roll already holds the journal (rollout-pin-journal.ts). Routing
    // it here keeps `fail()`'s promise structural: every stop-the-roll
    // failure, thrown or returned, now RETURNS a RolloutResult and reverts a
    // provisional pin exactly when one was written. The commander then does
    // for it what it does for any failed result — the stdout sentinel on the
    // hostd path, the `✗ Rollout STOPPED at …` narration and exit 1 on the
    // host shell.
    //
    // Note which failures do NOT revert: a `persist-pin` step that threw never
    // set `pinPersisted`, so `fail()` correctly leaves the journal alone —
    // reverting on a throw from `beginPinPersist` would revert the OTHER
    // roll's pin, which is precisely the damage the exclusivity gate exists to
    // prevent. A throw from the config write AFTER `beginPinPersist` (the
    // window where the journal exists but `pinPersisted` is still false) is
    // likewise left to the stale-gated recovery sites, which is safe because
    // the pin write is the thing that failed.
    warnings.push(
      `the ${currentStep?.kind ?? "rollout"} step THREW: ${(e as Error).message}. ` +
        `The roll stopped and reported the failure instead of dying without a ` +
        `result.`,
    );
    return fail({
      ...(currentStep ? { failedStep: currentStep.kind } : {}),
      ...(currentStep?.kind === "restart-agent" ? { failedAgent: currentStep.agent } : {}),
    });
  }
  // The roll is PROVEN — every agent came back on the target and no fatal
  // step failed. Only now does the provisional pin become durable: commit
  // clears the crash-recovery journal, so a later hostd boot won't revert it.
  if (pinPersisted && deps.commitPin) {
    try {
      const commitErr = deps.commitPin();
      if (typeof commitErr === "string" && commitErr.length > 0) {
        warnings.push(
          `${commitErr} (The roll SUCCEEDED and release.pin is correct — the ` +
            `risk is a later recovery pass reverting it.)`,
        );
      }
    } catch (e) {
      warnings.push(
        `roll succeeded but committing the durable release.pin threw: ` +
          `${(e as Error).message}. The pin IS written; a stale rollout ` +
          `journal may cause a later boot to revert it — verify host-side.`,
      );
    }
  }
  // ensure-banks gate — a rolled agent whose Hindsight bank still could not
  // be created after `refresh-hindsight` recreated the container is a
  // structural residue, NOT a host-CLI instruction. Same two deliberate
  // properties as the drift gate below: it runs AFTER `commitPin` and does
  // NOT go through `fail()` (every agent came back on the target and the
  // durable pin is correct — nothing needs rolling BACK; a bank needs
  // creating FORWARD), and `rolled` is reported in full so hostd's
  // unattended-failure path sees a past-canary failure and declines to
  // auto-roll-back, surfacing the agent names instead. "Unreachable" probe
  // misses were already degraded to warnings in the step and are absent here.
  if (bankEnsureFailed.length > 0) {
    for (const a of bankEnsureFailed) {
      warnings.push(
        `${a}'s Hindsight bank could NOT be created during the roll — its ` +
          `first \`retain\` will fail with a foreign-key error until the bank ` +
          `exists. Restart ${a} to re-run its bank creation now that Hindsight ` +
          `is back up.`,
      );
    }
    deps.log(
      `  ✗ ensure-banks FAILED — ${bankEnsureFailed.length} agent bank(s) ` +
        `could not be created: ${bankEnsureFailed.join(", ")}`,
    );
    return {
      ok: false,
      rolled,
      warnings,
      failedStep: ENSURE_BANKS_STEP,
      drifted: bankEnsureFailed,
    };
  }
  // #3928 — the convergence gate. A roll that leaves an IN-SCOPE component
  // behind the target does not exit 0. Before this, `switchroom rollout`
  // rolled the fleet to v0.19.30 and exited green while `switchroom update
  // --check` on the same host still reported `switchroom-web` and
  // `switchroom-hindsight-autoheal` on v0.19.26 — the refresh steps had
  // degraded their failures to warnings and nobody checked afterwards.
  // Silent partial success is the deeper defect: it is what let the drift
  // survive three releases.
  //
  // TWO deliberate differences from every other failure in this function:
  //
  //   1. It runs AFTER `commitPin`, and does NOT go through `fail()`. Every
  //      agent came back on the target and the durable pin is CORRECT;
  //      reverting it would drag the converged fleet back to the prior
  //      version on the next reconcile — turning a "one singleton is stale"
  //      finding into a fleet-wide downgrade. Nothing here needs rolling
  //      BACK; a named component needs finishing FORWARD.
  //   2. `rolled` is reported in full, so hostd's unattended-failure path
  //      (`recoverFailedAutoRollout`) sees a past-canary failure and
  //      correctly declines to auto-roll-back, alerting the operator with
  //      the component names instead.
  if (driftVerdict && driftVerdict.gated.length > 0) {
    const normalizedTarget = `v${normalizeVersion(target)}`;
    for (const c of driftVerdict.gated) {
      deps.log(
        `  ✗ ${c.name} → ${c.version ?? "<unreadable>"} (expected ${target}) — STILL BEHIND`,
      );
      warnings.push(
        `${c.name} is STILL on ${c.version ?? "an unreadable version"} after ` +
          `the roll to ${target} — it was in this roll's scope and did not ` +
          `converge. Finish it: ` +
          `${remediationFor(classifyComponent(c), normalizedTarget)}`,
      );
    }
    deps.log(
      `  ✗ verify-components FAILED — ${driftVerdict.gated.length} component(s) ` +
        `still behind ${target}: ${driftVerdict.gated.map((c) => c.name).join(", ")}`,
    );
    return {
      ok: false,
      rolled,
      warnings,
      failedStep: VERIFY_COMPONENTS_STEP,
      drifted: driftVerdict.gated.map((c) => c.name),
    };
  }
  return { ok: true, rolled, warnings };
}

/**
 * Resolve the default rollback target from the audit log (#2492).
 *
 * When `rollout --allow-downgrade` is invoked with NO `--pin`, we look for
 * the most-recent COMPLETED rollout terminal row that carries a `prior_pin`
 * and use that as the downgrade target. This is the "roll back to the last
 * good one" affordance — the operator doesn't need to recall the version.
 *
 * Returns `null` when no such row exists (fresh fleet, no prior rollout, or
 * all prior rollouts failed), in which case the caller should require `--pin`.
 *
 * Exported for unit testing.
 */
export function resolveRollbackTarget(auditLogPath?: string): string | null {
  const logPath = auditLogPath ?? defaultAuditLogPath(homedir());
  let raw: string;
  try {
    // Full window + strict (#3600 review, findings 3 & 4): this resolves
    // the rollback TARGET, so a rollout row missed because it fell
    // outside a 4 MiB tail — `agent_smoke` rows dominate the log — would
    // silently degrade to "no prior rollout found" on exactly the busy
    // hosts that need it. And a read error must not masquerade as
    // absence; the caller then requires an explicit `--pin`.
    raw = readAuditRaw(logPath, {
      windowBytes: auditReadFullWindowBytes(),
      strict: true,
    });
  } catch (err) {
    // A missing log yields "" (not a throw), so reaching here means a REAL
    // I/O failure. Say so — otherwise the caller's "no prior rollout
    // found; pass --pin" reads as a fact about history rather than as
    // "I could not look" (#3600 review, finding 4).
    process.stderr.write(
      `rollout: could not read the hostd audit log at ${logPath}: ${(err as Error).message} — cannot resolve a rollback target from history; pass --pin explicitly.\n`,
    );
    return null;
  }
  // Read all rollout terminal completed rows (most-recent at the end).
  const entries = readAndFilter(raw, { op: "rollout" }, 1000);
  // Walk from the most-recent backwards; the first completed terminal row
  // with a prior_pin is our target.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.phase === "terminal" && e.result === "completed" && e.prior_pin) {
      return e.prior_pin;
    }
  }
  return null;
}

/**
 * Read a positive-integer millisecond budget from an env var, falling back to
 * `fallback` when unset/garbage. Escape hatch for a genuinely slow host —
 * never a way to reintroduce "no timeout" (0/negative/NaN are rejected).
 *
 * SCOPE OF THE OVERRIDE (do not over-read it): the two constants below are
 * evaluated at MODULE LOAD, so `SWITCHROOM_ROLLOUT_*_TIMEOUT_MS` only takes
 * effect when it is set BEFORE this module is imported. That is true of the
 * production entrypoint — the CLI process inherits its environment, and the
 * rollout is a fresh `switchroom rollout` process — so the override works
 * where operators actually use it. It is NOT a general runtime knob: setting
 * `process.env.*` from inside an already-loaded process (or between tests in
 * one vitest worker) will NOT change these values.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Wall-clock budget for a spawned `switchroom <subcommand>` inside a roll.
 *
 * Why a timeout is load-bearing (not defensive polish): `agent restart
 * --wait` and `apply` are `spawnSync`ed. With no `timeout` a wedged container
 * — PRECISELY the case a roll exists to fix — blocks `spawnSync` forever,
 * which blocks `executeRollout` forever, which holds hostd's
 * `fleetMutationInFlight` latch forever (it is cleared in a `.finally()` that
 * never runs because the child never exits). Every subsequent fleet mutation
 * is then refused and the auto-update latch stays `"attempting"`, with no
 * self-clearing path short of restarting hostd.
 *
 * 20 minutes is deliberately generous: `agent restart --wait --force` pulls
 * an image and waits for a health gate, and killing a legitimately-slow pull
 * would itself strand the fleet. Override with
 * `SWITCHROOM_ROLLOUT_RUN_TIMEOUT_MS`.
 */
export const ROLLOUT_RUN_TIMEOUT_MS = envMs(
  "SWITCHROOM_ROLLOUT_RUN_TIMEOUT_MS",
  20 * 60 * 1000,
);

/**
 * Wall-clock budget for the `docker exec … switchroom --version` probe.
 *
 * Much tighter than {@link ROLLOUT_RUN_TIMEOUT_MS} because a healthy
 * container answers in well under a second; anything past this IS the wedge
 * we're detecting. A timed-out probe returns null — which the executor
 * already treats as "not on the target version" and stops the roll on.
 * Override with `SWITCHROOM_ROLLOUT_PROBE_TIMEOUT_MS`.
 */
export const ROLLOUT_PROBE_TIMEOUT_MS = envMs(
  "SWITCHROOM_ROLLOUT_PROBE_TIMEOUT_MS",
  60 * 1000,
);

/** Minimal `spawnSync` shape the deps factory needs — injectable for tests. */
export type RolloutSpawnSync = (
  cmd: string,
  args: string[],
  opts: {
    stdio?: "inherit";
    encoding?: "utf8";
    env?: NodeJS.ProcessEnv;
    timeout: number;
    killSignal: NodeJS.Signals;
  },
) => {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: (Error & { code?: string }) | undefined;
};

/**
 * True when a `spawnSync` result represents a TIMEOUT kill rather than a
 * normal non-zero exit.
 *
 * Node reports a timeout two ways depending on version/platform: an `error`
 * with `code === "ETIMEDOUT"`, and/or `status === null` with `signal` equal to
 * the `killSignal` we passed. Match both — treating a timeout as an ordinary
 * failure would still stop the roll safely, but the operator would lose the
 * "your container is wedged" signal.
 *
 * KNOWN IMPRECISION (diagnostics only). The signal arm cannot distinguish OUR
 * timeout kill from a FOREIGN SIGKILL — the host OOM killer reaping the child,
 * or an operator's `kill -9`. Both surface as `status:null, signal:"SIGKILL"`,
 * so an OOM-killed restart is reported as "wedged / timed out".
 *
 * This is deliberately accepted rather than papered over:
 *   - it CANNOT false-positive on success. A successful child has a numeric
 *     `status` (0), so the safety-critical path — "did this step pass?" — is
 *     never affected. Both cases are genuine failures that must stop the roll;
 *     only the LABEL differs.
 *   - the alternative (timing the call and inferring "did we reach the
 *     budget?") trades a wrong label for a flaky one on a loaded host.
 *
 * The cost is an operator chasing a "wedged container" that was actually
 * OOM-killed, so the emitted warning names both possibilities explicitly
 * rather than asserting the wedge. If this bites, the durable fix is to move
 * off `spawnSync` to an async spawn where the timeout is ours to observe
 * directly.
 */
export function isSpawnTimeout(
  r: { status: number | null; signal?: NodeJS.Signals | null; error?: (Error & { code?: string }) | undefined },
  killSignal: NodeJS.Signals,
): boolean {
  if (r.error && r.error.code === "ETIMEDOUT") return true;
  return r.status === null && r.signal === killSignal;
}

/**
 * Signal used to kill a timed-out rollout subprocess.
 *
 * ## Known limitation: GRANDCHILDREN ARE NOT KILLED
 *
 * `spawnSync`'s `timeout`/`killSignal` signal the DIRECT child only — there is
 * no process-group kill available through `spawnSync` (no `detached`, no
 * negative-pid kill hook). Our direct child is `node switchroom <subcommand>`,
 * and the thing that actually wedges is its own grandchild: the `docker
 * compose up -d` / `docker exec` the subcommand spawned.
 *
 * So on a timeout we reap the CLI but can leave a live `docker` process still
 * mutating containers and, on the restart path, still holding/rewriting the
 * compose file. Meanwhile the roll proceeds to its failure handling. Anything
 * that touches the same compose file during that window (a rollback, a
 * compose restore) races the orphan.
 *
 * This is NOT fixed here — the honest scope of this change is "bound the
 * subprocess so the executor and hostd's fleet-mutation latch cannot hang
 * forever", which it does. Killing the whole tree needs a move off `spawnSync`
 * to `spawn` with `detached: true` + `process.kill(-pid)`, which changes the
 * stdio-inherit and exit-code semantics every caller here depends on, and is
 * its own change with its own tests.
 *
 * Operationally: after a reported rollout timeout, check for stray `docker`
 * processes host-side before re-running the roll. The timeout warning says so.
 *
 * ## That operator instruction does NOT cover the unattended path
 *
 * "Check host-side before re-running" presumes a human between the timeout
 * and the next mutation. On the auto-rollout path there isn't one:
 * `finishFailedAutoRollout` → `recoverFailedAutoRollout` (`server.ts`) re-runs
 * `apply --pin … --compose-only` and, when `failed_step === "restart-agent"`,
 * `agent restart <agent> --wait --force --pin …` immediately — zero delay, no
 * orphan check — possibly CONCURRENT with the SIGKILLed child's still-live
 * `docker compose up -d` on the same compose file. So on the path that
 * matters most (nobody watching), the grandchild-orphan race above is not
 * merely unmitigated, it is actively raced into.
 *
 * Not fixed here — the honest scope of this change is bounding the
 * subprocesses. The durable fix is for `finishFailedAutoRollout` to SKIP
 * auto-recovery when the executor reported `timed_out` and alert instead of
 * re-mutating; that is a hostd-side behaviour change with its own tests and
 * its own blast radius, tracked as a follow-up. Stated here rather than left
 * implicit so the deferral is not read as "the operator instruction covers
 * it".
 */
const ROLLOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";

/**
 * Build the production {@link RolloutDeps}.
 *
 * Extracted from the command action (and `spawnSync` injected) so the timeout
 * contract — every subprocess bounded, a timeout reported cleanly rather than
 * hung — is unit-testable without docker or a real 20-minute wait.
 */
export function createRolloutDeps(params: {
  configPath: string;
  scriptPath: string;
  hostdCtx: boolean;
  /** `process.execPath`. Injected in tests so the compiled-binary
   *  self-invocation shape (#3963) is assertable without a real binary. */
  execPath?: string;
  /** Injected in tests; defaults to node's `spawnSync`. */
  spawn?: RolloutSpawnSync;
  /** Injected in tests; defaults to process.stderr. */
  warn?: (line: string) => void;
  /**
   * Hindsight HTTP API base (no trailing `/mcp/`). Set ONLY when the fleet
   * uses the hindsight memory backend — it is what wires the `ensureBank`
   * hook for the `ensure-banks` backstop. When absent, `ensureBank` is left
   * unwired and the step no-ops.
   */
  hindsightApiUrl?: string;
  /**
   * Map an agent name to its Hindsight bank id (`memory.collection ?? name`),
   * resolved from the loaded config. Paired with `hindsightApiUrl` to wire
   * `ensureBank`.
   */
  resolveBankId?: (agent: string) => string;
}): RolloutDeps {
  const { configPath, scriptPath, hostdCtx } = params;
  const spawn = (params.spawn ?? (spawnSync as unknown as RolloutSpawnSync));
  const warn = params.warn ?? ((line: string) => process.stderr.write(line));
  // #3963: a `bun build --compile` binary is its OWN entrypoint — passing
  // its bunfs bundle path as argv[1] makes commander read it as the
  // subcommand and every step of the roll dies with `unknown command
  // '/$bunfs/root/switchroom-linux-amd64'`. See ./self-invoke.ts.
  const self = resolveSelfInvocation({
    execPath: params.execPath ?? process.execPath,
    scriptPath,
  });

  /**
   * One-shot `docker …` bounded by {@link ROLLOUT_PROBE_TIMEOUT_MS}.
   *
   * `deps.run` and `deps.probeVersion` were not the only subprocesses inside
   * `executeRollout`'s own path: the `refresh-web` step calls
   * {@link deployedImageTag} and the `refresh-hindsight` step calls
   * {@link isHindsightContainerExists}, both of which shell out to `docker`
   * IN-PROCESS. The docker CLI has no client-side request timeout, so with an
   * unresponsive dockerd either call blocked forever — `executeRollout` never
   * returns, hostd's `runSwitchroom` promise never settles (it resolves only
   * on the child's `close`), its `.finally()` never runs, and
   * `fleetMutationInFlight` is stranded permanently. Same bug this whole
   * change exists to close, and worse-shaped: it strands the latch AFTER
   * every agent has already rolled.
   *
   * Both helpers take an injectable runner, so we thread this bounded one in
   * rather than relying on their module defaults (which are also bounded now,
   * belt-and-braces — see DOCKER_INSPECT_TIMEOUT_MS / DOCKER_PROBE_TIMEOUT_MS).
   * Threading through the injected `spawn` is also what makes the bound
   * unit-assertable without docker.
   *
   * Fails CLOSED on a throw. `isHindsightContainerExists`'s module default
   * (`defaultDockerProbe`, `src/setup/hindsight.ts`) wraps its `execFileSync`
   * in try/catch, so before this runner was threaded in, ANY throw from the
   * probe became a clean `false` (→ "no hindsight container → skip"). Node's
   * `spawnSync` reports failures on `r.error` rather than throwing —
   * ENOENT included — so a throw here is theoretical, but "theoretical" is
   * not a contract: swallowing it keeps the injected runner's failure shape
   * identical to the default it replaces, instead of letting an unexpected
   * throw escape `executeRollout` mid-roll after every agent has restarted.
   */
  const dockerRun: DockerRunner = (args) => {
    let r: ReturnType<RolloutSpawnSync>;
    try {
      r = spawn("docker", args, {
        encoding: "utf8",
        timeout: ROLLOUT_PROBE_TIMEOUT_MS,
        killSignal: ROLLOUT_KILL_SIGNAL,
      });
    } catch {
      return { ok: false, stdout: "", stderr: "" };
    }
    if (isSpawnTimeout(r, ROLLOUT_KILL_SIGNAL)) {
      warn(
        `⚠️  rollout: \`docker ${args.join(" ")}\` did not answer within ` +
          `${ROLLOUT_PROBE_TIMEOUT_MS}ms and was killed — most likely an ` +
          `unresponsive docker daemon (though an externally-killed probe is ` +
          `indistinguishable here). Treating as unknown.\n`,
      );
      return { ok: false, stdout: "", stderr: "" };
    }
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  /**
   * Write `text` over the config, then chown back to the operator.
   * Shared by persistPin and revertPin so a revert can never leave the
   * config root-owned when the forward write wouldn't have.
   *
   * chown-back rationale differs by path:
   *   host-shell: rollout self-elevates via sudo; a root write would leave
   *     the operator-owned config root-owned and EACCES-lock other yaml verbs.
   *   hostd: we're euid 0 inside the hostd container's mount namespace (NOT
   *     via sudo). resolveOperatorUid() must resolve the operator's uid for
   *     the chown to be meaningful; if it can't, SKIP the chown rather than
   *     chown to a wrong/garbage uid (#2487 item 8).
   */
  const writeConfigPreservingOwnership = (
    path: string,
    text: string,
    mode: number,
  ): void => {
    // Tries atomic rename(2) first; falls back to in-place rewrite on
    // EBUSY/EXDEV/EINVAL (single-file bind mount inside the hostd container
    // rejects rename over the mount point).
    writeConfigFileSync(path, text, mode);
    try {
      if (typeof process.geteuid === "function" && process.geteuid() === 0) {
        const uid = resolveOperatorUid();
        if (uid !== undefined) {
          chownSync(path, uid, uid);
        } else if (hostdCtx) {
          warn(
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
  };

  return {
    run: (args, opts) => {
      const r = spawn(self.command, [...self.prefixArgs, ...args], {
        stdio: "inherit",
        // #3333 amendment C: layer the per-invocation env (the scoped-sweep
        // flag on the canary spawn) onto the inherited environment.
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        // Bounded by contract — see ROLLOUT_RUN_TIMEOUT_MS.
        timeout: ROLLOUT_RUN_TIMEOUT_MS,
        killSignal: ROLLOUT_KILL_SIGNAL,
      });
      const timedOut = isSpawnTimeout(r, ROLLOUT_KILL_SIGNAL);
      if (timedOut) {
        warn(
          `⚠️  rollout: \`switchroom ${args.join(" ")}\` did not finish within ` +
            `${ROLLOUT_RUN_TIMEOUT_MS}ms and was ${ROLLOUT_KILL_SIGNAL}ed ` +
            `(or was killed from outside — the OOM killer looks identical here; ` +
            `see isSpawnTimeout). Its \`docker\` grandchildren are NOT killed ` +
            `with it: check for stray docker processes host-side before ` +
            `re-running the roll.\n`,
        );
      }
      // A killed child has status null; report a non-zero status so every
      // caller's `status !== 0` check trips.
      //
      // The `timedOut ? 1` arm is not redundant defensiveness — it ENFORCES
      // the invariant isSpawnTimeout's contract asserts. isSpawnTimeout's
      // ETIMEDOUT arm is checked BEFORE status, so a hypothetical
      // `{status: 0, error: {code: "ETIMEDOUT"}}` shape would otherwise
      // return `status: 0, timedOut: true` and every caller's
      // `if (r.status !== 0)` gate would read the timeout as SUCCESS. We
      // could not reproduce that shape on node v22.23.1, but "the runtime
      // happens not to emit it" is not a guarantee — a timeout is never a
      // success, so encode that in the code rather than only in the doc.
      return { status: timedOut ? 1 : (r.status ?? 1), ...(timedOut ? { timedOut: true } : {}) };
    },
    probeVersion: (agent) => {
      const r = spawn(
        "docker",
        ["exec", `switchroom-${agent}`, "sh", "-lc", "switchroom --version"],
        {
          encoding: "utf8",
          timeout: ROLLOUT_PROBE_TIMEOUT_MS,
          killSignal: ROLLOUT_KILL_SIGNAL,
        },
      );
      if (isSpawnTimeout(r, ROLLOUT_KILL_SIGNAL)) {
        warn(
          `⚠️  rollout: version probe for ${agent} did not answer within ` +
            `${ROLLOUT_PROBE_TIMEOUT_MS}ms and was killed — most likely a ` +
            `wedged container (\`docker exec\` never returned), though an ` +
            `externally-killed probe is indistinguishable here. Treating as ` +
            `unreachable. The \`docker exec\` itself may still be running.\n`,
        );
        return null;
      }
      if (r.status !== 0) return null;
      return (r.stdout ?? "").trim().split("\n").pop()?.trim() ?? null;
    },
    log: (line) => process.stdout.write(line + "\n"),
    // #2726 — emit each phase transition as a stdout sentinel line hostd
    // parses into a durable, hash-chained audit row. Harmless on the
    // host-shell path (no hostd tailing stdout there); load-bearing on the
    // hostd path where it drives durable observability + the narration
    // surface. NEVER writes the audit log directly — hostd is the sole
    // writer, preserving the single-writer hash-chain contract.
    emitPhase: (phase) => process.stdout.write(encodeRolloutPhaseLine(phase) + "\n"),
    // Belt-and-braces skew probe for the refresh-web step (webd install
    // exits 0 on a downgrade-guard skip — see deploy-version-guard.ts).
    // Bounded: this `docker inspect` runs IN-PROCESS inside executeRollout.
    webImageTag: () => deployedImageTag("switchroom-web", dockerRun),
    // Bounded for the same reason: the refresh-hindsight step's `docker ps`
    // also runs in-process inside executeRollout.
    hindsightExists: () =>
      isHindsightContainerExists((args) => {
        const r = dockerRun(args);
        return r.ok ? r.stdout : null;
      }),
    // #3928 — the terminal drift gate's inventory. Threaded through the
    // SAME bounded `dockerRun` as the other in-process docker calls: this
    // runs inside `executeRollout`, and an unbounded `docker ps` against an
    // unresponsive daemon would strand hostd's fleet-mutation latch exactly
    // like the probes above.
    collectComponents: () =>
      collectHostComponents(SWITCHROOM_VERSION, ((cmd, args) => {
        // `collectContainerComponents` only ever calls `docker`; asserting
        // it keeps a future caller from silently shelling out to something
        // else through this seam.
        if (cmd !== "docker") return { status: 1, stdout: "" };
        const r = dockerRun(args);
        return { status: r.ok ? 0 : 1, stdout: r.stdout };
      }) satisfies ExecFn,
      // #4571 — inside hostd, SWITCHROOM_VERSION is the hostd IMAGE's CLI,
      // not the host operator's. Hand the collector the stamped host version
      // so the `cli (host)` row stops reporting the container's own version
      // under a `(host)` label.
      observeHostCli({}, params.hostdCtx)),
    persistPin: (pin) => {
      const before = readFileSync(configPath, "utf8");
      const after = setReleasePinInConfig(before, pin);
      // Idempotent no-op: the config already names this pin, so there is
      // nothing to journal, nothing to revert, and — critically — nothing to
      // COMMIT. Reporting false keeps the executor from unlinking a journal
      // this roll never wrote (see RolloutDeps.persistPin).
      if (after === before) return false;
      // PROVISIONAL WRITE. Journal the pin (and the pin it replaces) FIRST so
      // it can be reverted both on a clean failure (revertPin below) and after
      // a crash (recoverPinJournal at hostd boot / next rollout). Without
      // this, a roll that fails at agent 5 of 12 leaves the durable pin naming
      // the failed build and every later reconcile converges the rest of the
      // fleet onto it.
      beginPinPersist(configPath, pin);
      writeConfigPreservingOwnership(
        configPath,
        after,
        statSync(configPath).mode & 0o777,
      );
      return true;
    },
    commitPin: () => {
      const err = commitPinPersist(configPath);
      // Returned (not just warned) so the executor lands it in
      // RolloutResult.warnings \u2014 see RolloutDeps.commitPin.
      if (err) warn(`\u26a0\ufe0f  ${err}\n`);
      return err;
    },
    revertPin: () => {
      // requireStale is deliberately FALSE here: this caller IS the process
      // that wrote the provisional pin and it knows the roll has failed, so
      // the liveness gate (which exists for concurrent recovery sites) would
      // only ever refuse a revert we are certain about.
      const outcome = rollbackPinPersist(configPath, {
        writeConfig: writeConfigPreservingOwnership,
        warn,
      });
      if (outcome.error) {
        warn(
          `⚠️  rollout: FAILED to revert the provisional release.pin=` +
            `${outcome.pin}: ${outcome.error}\n`,
        );
      }
      return outcome.reverted;
    },
    // ensure-banks backstop. Wired ONLY when the fleet runs the hindsight
    // backend (both hindsightApiUrl + resolveBankId present) — otherwise
    // left undefined so the step is a clean no-op. `createBank` is
    // idempotent and needs only a bank id + api url, no container reconcile,
    // and reports {ok:false, reason:"Unreachable"} on a refused connection
    // (which the executor degrades to a warning rather than a roll failure).
    ...(params.hindsightApiUrl && params.resolveBankId
      ? {
          ensureBank: (agent: string) =>
            createBank(params.hindsightApiUrl as string, (params.resolveBankId as (a: string) => string)(agent), {
              timeoutMs: 5000,
            }),
        }
      : {}),
  };
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
    .option(
      "--skip-web",
      "Skip the web refresh (host-shell path: also the hostd + hindsight " +
        "refresh). On the hostd/agent path only the web refresh is skipped — " +
        "hindsight is still recreated and hostd stays deferred regardless.",
    )
    .option(
      "--allow-downgrade",
      "Permit rolling to an older semver tag (operator-approved rollback path). " +
        "When set, the downgrade guard is relaxed so --pin may be older than the " +
        "current release.pin. All other safety rails apply unchanged.",
    )
    .option(
      "--allow-stale-host-cli",
      "Roll the fleet even though the HOST operator CLI is observably behind " +
        "the target. Escape hatch for the host-CLI-first gate: the host CLI is " +
        "then left drifted and every later host-shell command runs old code. " +
        "HOST-SHELL ONLY: deliberately not exposed as an `mcp__hostd__rollout` " +
        "parameter, so an agent cannot roll past the gate on its own — " +
        "overriding requires the same host shell needed to actually fix it.",
    )
    .option("--dry-run", "Print the plan and exit without changing anything.")
    .action(async (opts: { pin?: string; agents?: string; skipWeb?: boolean; allowDowngrade?: boolean; allowStaleHostCli?: boolean; dryRun?: boolean }) => {
      // Crash recovery (host-shell path). A previous roll that was SIGKILLed
      // between the provisional `release.pin` write and its commit leaves a
      // journal on disk; revert it BEFORE reading the config, so this roll
      // (and the downgrade guard's "current pin" comparison) sees the last
      // PROVEN pin rather than an unproven one. No-op when no journal exists.
      // Skipped under --dry-run, which changes nothing by contract.
      if (!opts.dryRun) {
        const note = recoverPinJournal(getConfigPath(program));
        if (note) process.stderr.write(`⚠️  ${note}\n`);
      }
      const config = getConfig(program);
      // #2492 — when --allow-downgrade is set but no --pin was given, default
      // the target to the last completed rollout's prior_pin (the version that
      // was running before that roll). This is the "rollback to last good"
      // affordance: the operator doesn't have to remember the version string.
      let resolvedPin = opts.pin;
      if (opts.allowDowngrade && !resolvedPin) {
        const priorTarget = resolveRollbackTarget();
        if (priorTarget) {
          process.stdout.write(
            `ℹ️  No --pin given with --allow-downgrade; defaulting to prior_pin from last completed rollout: ${priorTarget}\n`,
          );
          resolvedPin = priorTarget;
        }
      }
      const target = resolvedPin ?? config.release?.pin;
      if (!target) {
        process.stderr.write(
          opts.allowDowngrade
            ? "rollout --allow-downgrade needs a target: pass --pin vX.Y.Z, or run " +
                "a successful rollout first so prior_pin is available as the default.\n"
            : "rollout needs a pinned version: pass --pin vX.Y.Z, or set " +
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
            ? `Normally hostd SELF-BUMPS before this child ever spawns ` +
              `(#2645) — seeing this refusal means the self-bump was ` +
              `skipped or resumed while still stale. Refresh hostd's CLI ` +
              `host-side: \`switchroom hostd install --tag ${target}\` — ` +
              `then re-run the roll.`
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
      // #4571 — HOST-CLI-FIRST gate. The host operator CLI must already be on
      // the target before a single agent moves.
      //
      // On the host-shell path the driving CLI IS the host CLI, so the
      // `shouldRefuseStaleCli` guard above already enforces this. On the
      // agent/hostd path it does not: the driving CLI is the hostd IMAGE's
      // bundled CLI, and nothing in the roll ever observed the host binary —
      // it was named in a trailing warning after every agent had already
      // moved. That is how the host CLI reached five releases of drift with
      // every roll exiting green.
      //
      // hostd mounts only `~/.switchroom` (hostd.ts:332): it cannot read
      // `/usr/local/bin`, cannot read an nvm tree, and cannot `npm i -g` on
      // the host. So the roll CANNOT install the host CLI itself and any step
      // claiming to would be a lie. What it can do is REFUSE — deterministic,
      // before the first mutation, with the correct install command derived
      // from what the host CLI recorded about itself
      // (`~/.switchroom/host-cli.json`, written by every host-context CLI
      // invocation). Silence becomes impossible; the ordering becomes real.
      //
      // Conservative, like every other guard here: no stamp (a host CLI older
      // than this feature never wrote one) or an unorderable version never
      // blocks. `--allow-stale-host-cli` is the explicit override.
      const hostCliStamp = readHostCliStamp();
      if (
        !opts.allowStaleHostCli &&
        shouldRefuseStaleHostCli(hostCliStamp, target)
      ) {
        const observed = hostCliStamp?.version ?? "unknown";
        const refusal =
          `rollout refused: the HOST operator CLI is v${observed}, OLDER than ` +
          `the target ${target}. The host CLI must be upgraded FIRST — it is ` +
          `what runs \`switchroom apply\`, \`vault\`, \`doctor\` and the next ` +
          `roll host-side, and leaving it behind is how it silently drifted ` +
          `five releases. Run this on the host, then re-run the roll: ` +
          `${hostCliInstallCommand(hostCliStamp, target)}. ` +
          `(Observed from ${HOST_CLI_STAMP_FILENAME}, refreshed by every ` +
          `host-context switchroom command — if you already upgraded, run any ` +
          `switchroom command on the host to refresh it, or pass ` +
          `--allow-stale-host-cli to roll anyway.) Nothing was changed.`;
        process.stderr.write(refusal + "\n");
        if (hostdCtx) {
          process.stdout.write(
            encodeRolloutResultLine({
              ok: false,
              rolled: [],
              failedStep: PREFLIGHT_HOST_CLI_STALE_STEP,
              got: observed,
              warnings: [refusal],
            }) + "\n",
          );
        }
        process.exitCode = 2;
        return;
      }
      if (opts.allowStaleHostCli && shouldRefuseStaleHostCli(hostCliStamp, target)) {
        process.stderr.write(
          `⚠️  --allow-stale-host-cli: rolling past a HOST operator CLI on ` +
            `v${hostCliStamp?.version} (target ${target}). Fix it host-side ` +
            `with: ${hostCliInstallCommand(hostCliStamp, target)}\n`,
        );
      }
      // #2487 PR2 — downgrade guard: reject a version older than the
      // current release.pin on the hostd path UNLESS --allow-downgrade is
      // set (the operator-approved rollback path). compareReleaseTags is
      // conservative: it only refuses a clean vX.Y.Z → older-vX.Y.Z move,
      // never a channel/sha (those return null and never block).
      // Use resolvedPin (which may have been auto-filled from prior_pin).
      if (shouldRefuseDowngrade(hostdCtx, resolvedPin, config.release?.pin, opts.allowDowngrade)) {
        const current = config.release?.pin;
        process.stderr.write(
          `rollout (hostd path) refuses a DOWNGRADE: ${resolvedPin} is older ` +
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
          `⤵ DOWNGRADE authorized (operator-approved rollback): ${current ?? "<unpinned>"} → ${target}\n`,
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

      // Persist the pin durably only when a pin was explicitly given (either
      // via --pin or auto-resolved from prior_pin); a target read from
      // config.release.pin is already persisted.
      const steps = planRollout(requested, {
        skipWeb: opts.skipWeb,
        pinToPersist: resolvedPin ?? undefined,
        hostdContext: hostdCtx,
      });

      if (opts.dryRun) {
        // Dry-run prints the plan (incl. the persist step) and writes NOTHING
        // — it returns before executeRollout, so no persist/apply/restart runs.
        process.stdout.write(formatRolloutPlan(steps, target) + "\n");
        return;
      }

      const configPath = getConfigPath(program);
      // Empty (not "switchroom") on the degenerate no-argv[1] path:
      // resolveSelfInvocation then falls back to a bare `switchroom` on
      // $PATH instead of passing the literal string as argv[1] to the
      // interpreter, which could never have worked.
      const scriptPath = process.argv[1] ?? "";
      // Wire the ensure-banks backstop ONLY when this fleet runs the hindsight
      // memory backend. The bank id is `memory.collection ?? <agent name>`
      // (the SAME derivation scaffold.ts uses at reconcile), and the api base
      // is the fleet's configured hindsight url with the `/mcp/` suffix
      // stripped, defaulting to the standard loopback endpoint. Left undefined
      // for a non-hindsight fleet so the step no-ops.
      let hindsightApiUrl: string | undefined;
      let resolveBankId: ((agent: string) => string) | undefined;
      if (isHindsightEnabled(config)) {
        const rawUrl = (config.memory?.config as { url?: string } | undefined)?.url;
        hindsightApiUrl = rawUrl
          ? rawUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "")
          : HINDSIGHT_DEFAULT_API_BASE_URL;
        resolveBankId = (agent: string) =>
          (config.agents?.[agent]?.memory as { collection?: string } | undefined)?.collection ?? agent;
      }
      const deps = createRolloutDeps({
        configPath,
        scriptPath,
        hostdCtx,
        hindsightApiUrl,
        resolveBankId,
      });

      process.stdout.write(
        `${opts.allowDowngrade ? "Rolling back" : "Rolling"} ${requested.length} agent(s) to ${target}…\n`,
      );
      const result = await executeRollout(steps, target, deps, {
        hostdContext: hostdCtx,
        // Forwarded to the singleton installers (webd/hostd install) so a
        // rollback roll doesn't get silently guard-skipped there.
        allowDowngrade: opts.allowDowngrade,
      });

      // hostd path: the HOSTD refresh was intentionally dropped from the
      // plan (it would SIGKILL this very process). The WEB refresh now runs
      // in-plan (refresh-web — safe: separate compose project, not hostd's
      // parent), so it is NOT in the deferred list unless --skip-web
      // dropped it. Surface the remaining deferral so the operator knows
      // what to finish host-side.
      if (hostdCtx) {
        // #2645 item 3 — name EXACTLY what is still on the prior version so
        // "rollout done" is never misread as "everything's on the new
        // version". hostd itself is current on this path when the roll was
        // preceded by a self-bump (the daemon tag-bumps its own compose
        // before spawning this child); the host-installed operator CLI
        // never is. switchroom-web was refreshed in-plan (or its failure/
        // skip already produced its own actionable warning above).
        // #4269 — say definitively whether a hostd template regen is needed,
        // instead of hedging "only if the release changed hostd's mounts/env".
        // HOSTD_TEMPLATE_LAST_CHANGED records the release the template last
        // changed shape in (kept honest by check-hostd-template-guard). The
        // in-memory config still holds the PRE-persist pin, so it is a
        // trustworthy "from" only when this roll brought its OWN pin
        // (otherwise target === config pin and the from is unknown).
        const priorPinForTemplate =
          resolvedPin != null ? config.release?.pin : undefined;
        const regenVerdict = hostdTemplateRegenVerdict(target, priorPinForTemplate);
        const regenClause =
          regenVerdict === "required"
            ? `hostd's compose was tag-bumped by the self-bump when one ran, but ` +
              `a template regen is REQUIRED for this roll (hostd's mounts/env ` +
              `changed in ${HOSTD_TEMPLATE_LAST_CHANGED}): run ` +
              `\`switchroom hostd install --tag ${target}\` host-side. `
            : regenVerdict === "not-needed"
              ? `hostd's compose was tag-bumped by the self-bump when one ran; NO ` +
                `template regen is needed for this release — hostd's mounts/env ` +
                `are unchanged since ${HOSTD_TEMPLATE_LAST_CHANGED}. `
              : `hostd's compose was tag-bumped by the self-bump when one ran; a ` +
                `full hostd template regen (only needed when a release changes ` +
                `hostd's mounts/env) is \`switchroom hostd install --tag ${target}\` ` +
                `host-side. `;
        // #4571 — the host CLI clause is now derived from what was OBSERVED,
        // not asserted unconditionally. Reaching here with the host CLI
        // behind means `--allow-stale-host-cli` was passed (the gate refuses
        // otherwise), so the three cases are: measured-and-current (say
        // nothing — the old text claimed drift that no longer exists),
        // measured-and-behind (name the version AND the command derived from
        // the recorded install kind/prefix/owner — `sudo npm i -g` is wrong
        // on a user-prefix nvm install), and unmeasured (say so honestly).
        const hostCliClause = !hostCliStamp
          ? `the host operator CLI's version could NOT be observed from here ` +
            `(no ${HOST_CLI_STAMP_FILENAME} in the switchroom home — it is ` +
            `written by any host-context switchroom command). Confirm it ` +
            `host-side with \`switchroom --version\`; if it is behind: ` +
            `${hostCliInstallCommand(undefined, target)}. `
          : shouldRefuseStaleHostCli(hostCliStamp, target)
            ? `still on the PRIOR version after this roll: the host operator ` +
              `CLI (observed v${hostCliStamp.version}, target ${target}) — ` +
              `you passed --allow-stale-host-cli. Fix it host-side: ` +
              `${hostCliInstallCommand(hostCliStamp, target)}. `
            : "";
        result.warnings.push(
          hostCliClause +
            regenClause +
            `An agent-invoked rollout cannot recreate its own hostd ` +
            `container mid-roll without killing itself.` +
            (opts.skipWeb
              ? ` --skip-web was set, so switchroom-web is ALSO still on the ` +
                `prior version (host-side: \`switchroom webd install --tag ${target}\`).`
              : ""),
        );
        // #2726 — narrate the deferral as a phase so the durable log + the
        // narration surface show "hostd deferred" between the last agent
        // and the terminal row. (Phase name kept as "hostd-web-deferred"
        // for wire/audit-row compatibility; since the in-plan refresh-web
        // landed, only hostd is actually deferred.) Only meaningful on the
        // hostd path (the only path that defers). Emitted only when the
        // roll got far enough to matter — i.e. it wasn't refused before
        // executeRollout ran.
        process.stdout.write(
          encodeRolloutPhaseLine({ phase: "hostd-web-deferred", target }) + "\n",
        );
      }

      for (const w of result.warnings) process.stderr.write(`⚠️  ${w}\n`);

      // hostd parses this sentinel to populate STRUCTURED status fields
      // (rolled[]/failedStep/failedAgent) instead of a flattened tail.
      if (hostdCtx) {
        process.stdout.write(encodeRolloutResultLine(result) + "\n");
      }

      // #3928 — a residual-drift failure is NOT a "stopped partway" failure
      // and must not be narrated as one. The agents ARE on the target and
      // the pin IS committed; what failed is convergence of a component the
      // roll was answerable for. Saying "Rolled before stop" here would send
      // the operator to re-run the agent roll, which is already done and
      // would not touch the component that is actually behind. Name the
      // components and the per-component remediation instead — the warnings
      // printed above carry the exact command for each.
      if (!result.ok && result.failedStep === VERIFY_COMPONENTS_STEP) {
        process.stderr.write(
          `\n✗ Rollout INCOMPLETE — ${(result.drifted ?? []).length} component(s) ` +
            `still behind ${target}: ${(result.drifted ?? []).join(", ") || "unknown"}.\n` +
            `  ${result.rolled.length} agent(s) DID reach ${target} and the pin is ` +
            `committed — re-running the agent roll will not fix this.\n` +
            `  Run the per-component command named in the warning(s) above, then ` +
            `\`switchroom update --check\` to confirm the host is converged.\n`,
        );
        process.exitCode = 1;
        return;
      }

      // ensure-banks residue: the agents reached the target and the pin is
      // committed, but a brand-new agent's Hindsight bank could not be created
      // during the roll. Like the drift residue above, this is a FORWARD fix,
      // not a "stopped partway" stop — re-running the agent roll won't help;
      // the named agent(s) need a restart to re-run bank creation now that
      // hindsight is back up. Named here so it is not narrated as a mid-roll
      // stop that sends the operator to re-run everything.
      if (!result.ok && result.failedStep === ENSURE_BANKS_STEP) {
        process.stderr.write(
          `\n✗ Rollout INCOMPLETE — ${(result.drifted ?? []).length} agent(s) ` +
            `reached ${target} but their Hindsight bank could NOT be created: ` +
            `${(result.drifted ?? []).join(", ") || "unknown"}.\n` +
            `  The pin is committed and the agents ARE on the target — re-running ` +
            `the agent roll will not fix this.\n` +
            `  Restart the named agent(s) to re-run bank creation now that ` +
            `Hindsight is back up (their first \`retain\` fails with a foreign-key ` +
            `error until the bank exists).\n`,
        );
        process.exitCode = 1;
        return;
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

/**
 * Thin `rollback` alias — ergonomic shorthand for
 * `rollout --allow-downgrade [--pin <version>]` (#2492).
 *
 * Registered as a separate subcommand so operators can say
 * `switchroom rollback` instead of the longer form. Semantics:
 *   - If `--to` is given, passes it as `--pin` to the rollout action.
 *   - If `--to` is omitted, the rollout action auto-resolves the target
 *     from the last completed rollout's `prior_pin`.
 * All other rollout safety rails (canary, version-assert, stop-on-
 * mismatch, downgrade guard relaxed exactly once by --allow-downgrade)
 * apply unchanged.
 */
export function registerRollbackCommand(program: Command): void {
  program
    .command("rollback")
    .description(
      "Roll the fleet back to the previous version (operator-approved downgrade). " +
        "Defaults to the version captured in the last completed rollout's prior_pin. " +
        "Equivalent to `rollout --allow-downgrade [--pin <version>]`.",
    )
    .option(
      "--to <version>",
      "Explicit version to roll back to (e.g. v0.15.17). " +
        "Omit to use the last completed rollout's prior_pin.",
    )
    .option(
      "--agents <list>",
      "Comma-separated subset of agents to roll back (default: all configured).",
    )
    .option(
      "--skip-web",
      "Skip the web refresh (host-shell path: also the hostd + hindsight " +
        "refresh). On the hostd/agent path only the web refresh is skipped — " +
        "hindsight is still recreated and hostd stays deferred regardless.",
    )
    .option("--dry-run", "Print the plan and exit without changing anything.")
    .action(async (opts: { to?: string; agents?: string; skipWeb?: boolean; dryRun?: boolean }) => {
      // Delegate entirely to the rollout action with --allow-downgrade.
      // Build the args array and re-invoke via the program's rollout subcommand.
      const rolloutArgs: string[] = ["--allow-downgrade"];
      if (opts.to) rolloutArgs.push("--pin", opts.to);
      if (opts.agents) rolloutArgs.push("--agents", opts.agents);
      if (opts.skipWeb) rolloutArgs.push("--skip-web");
      if (opts.dryRun) rolloutArgs.push("--dry-run");
      // Parse via the program's rollout subcommand.
      await program.parseAsync(["rollout", ...rolloutArgs], { from: "user" });
    });
}
