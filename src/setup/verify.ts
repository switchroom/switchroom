/**
 * Setup-wizard verification primitives (install-path review H7).
 *
 * The wizard's final step used to print `OK Verification steps ready`
 * unconditionally, and swallowed the optional `agent start` failure in a
 * bare `catch {}`. On a host where nothing could possibly run, setup still
 * reported success — which made every other install failure silent.
 *
 * These helpers give that step something real to assert:
 *
 *   - `waitForAgentContainerUp` — after we asked docker to start an agent,
 *     poll `docker ps` until the container is genuinely up AND has *stayed*
 *     up across a stability WINDOW (a crash-looping container is "Up" for a
 *     moment, then "Restarting"). Any terminal state (exited / restarting)
 *     fails immediately; a timeout fails with the last observed state.
 *   - `verifyFleetContainers` — reuse doctor's `checkContainerRuntimeHealth`
 *     (the 2026-06-23 stuck/crash-loop signature) rather than inventing a
 *     parallel health surface, and translate its rows into setup findings.
 *
 * Both verdicts are sampled over time, and SYMMETRICALLY so (review M4/M5):
 * a single `docker ps` snapshot is evidence neither of health nor of
 * breakage. Every switchroom container is generated with `restart: always`
 * (`src/agents/compose.ts`), so a fleet seconds into a `docker restart` or
 * an `apply` reconcile legitimately reads `created`/`restarting` for a
 * moment — failing on the first frame would exit 1 on a healthy fleet.
 *
 * Design constraints that shaped the statuses:
 *
 *   - `switchroom setup` runs BEFORE `switchroom apply` and before the
 *     fleet is brought up (docs/install.md Step 3 vs Step 5). So "no agent
 *     containers exist yet" is the normal first-install state — it reports
 *     `pending` (honest, no green claim, exit 0), never a fake OK.
 *   - Anything we actually *attempted* in this run and that did not work is
 *     `fail`, which the wizard turns into a non-zero exit.
 *   - A pre-existing container that the operator deliberately stopped is
 *     `pending`, not `fail` — matching doctor, which only flags
 *     created/restarting as broken.
 *
 * Everything is dependency-injected (docker probe + sleep) so tests assert
 * the failure paths without docker and without wall-clock waits.
 */

import {
  classifyContainerStatus,
  checkContainerRuntimeHealth,
  listSwitchroomContainers,
  type ContainerHealth,
  type ContainerRow,
} from "../cli/doctor-docker.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * `fail` is fatal (wizard exits non-zero). `pending` is an honest "not
 * verified / not up yet" — printed in yellow, never as a green OK.
 */
export type VerifyStatus = "ok" | "pending" | "fail";

export interface VerifyFinding {
  name: string;
  status: VerifyStatus;
  detail: string;
  /** Operator-actionable next step; printed under a pending/fail row. */
  fix?: string;
  /**
   * Stable identifier for findings that several probes can independently
   * produce. The wizard de-duplicates on it so a docker-less host gets ONE
   * "docker is not reachable" row instead of one per probe (review L9).
   */
  code?: string;
}

/** De-dup key for the "docker itself is not reachable" verdict (L9). */
export const DOCKER_UNAVAILABLE_CODE = "docker-unavailable";

export interface VerifyDeps {
  /**
   * `docker ps -a --filter name=switchroom-` rows, or null when docker is
   * unavailable / errored. Defaults to the real docker probe doctor uses.
   */
  listContainers?: () => ContainerRow[] | null;
  /** Injected in tests so polling costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long we wait for a just-started agent container to settle. */
export const AGENT_UP_TIMEOUT_MS = 45_000;
/**
 * Gap between `docker ps` samples while waiting.
 */
export const AGENT_POLL_INTERVAL_MS = 2_000;
/**
 * How long a container must stay continuously up before we call the start
 * verified — the real guarantee this check offers.
 *
 * Review M5: the previous "3 consecutive samples" spanned only ~4s of wall
 * clock, so the docstring's crash-loop claim held only for sub-4-second
 * loops. An agent whose `start.sh` dies 8-10s in (a documented failure mode
 * here — npm install / broker socket waits happen in that window) sailed
 * through. 15s covers that class with margin and still fits inside the
 * 45s timeout.
 */
export const AGENT_STABLE_WINDOW_MS = 15_000;
/**
 * Consecutive "Up" samples required, derived from the window so the two can
 * never drift: N samples span (N-1) intervals of wall clock, so we need
 * ceil(window / interval) + 1.
 */
export const AGENT_STABLE_SAMPLES =
  Math.ceil(AGENT_STABLE_WINDOW_MS / AGENT_POLL_INTERVAL_MS) + 1;

/**
 * How many consecutive samples must ALL show a broken fleet before
 * `verifyFleetContainers` returns `fail` (review M4). Symmetric with the
 * `ok` path: `restart: always` means a healthy fleet reads `created` /
 * `restarting` for a beat after `docker restart` or an `apply` reconcile.
 */
export const FLEET_FAIL_CONFIRM_SAMPLES = 3;
/** Gap between the confirmation samples above. */
export const FLEET_FAIL_CONFIRM_INTERVAL_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Container name for an agent — mirrors compose's `container_name:`. */
export function agentContainerName(agent: string): string {
  return `switchroom-${agent}`;
}

/**
 * Health of one agent's container from a `docker ps -a` row set.
 * `absent` = no container with that name at all.
 */
export function agentContainerHealth(
  agent: string,
  rows: ContainerRow[],
): ContainerHealth | "absent" {
  const want = agentContainerName(agent);
  const row = rows.find((r) => r.name === want);
  if (!row) return "absent";
  return classifyContainerStatus(row.status);
}

/**
 * "Demonstrably up." Deliberately excludes `running-unhealthy` (review M6):
 * `switchroom-hindsight` carries a healthcheck added specifically to make a
 * wedged API visible, so "Up 2 minutes (unhealthy)" is a container that is
 * running and NOT working. `running-starting` is also excluded — it is not
 * yet evidence either way, so the poller keeps looking rather than crediting
 * stability.
 */
function isUp(h: ContainerHealth | "absent"): boolean {
  return h === "running-healthy" || h === "running-no-healthcheck";
}

const DOCKER_UNAVAILABLE_FIX =
  "Install/start Docker (the fleet runs as containers), then re-run `switchroom setup`.";

/** Human-readable rendering of a docker health bucket for finding text. */
function describeHealth(h: ContainerHealth | "absent"): string {
  switch (h) {
    case "absent":
      return "no such container";
    case "running-unhealthy":
      return "running but its healthcheck is failing";
    case "running-starting":
      return "running, healthcheck still starting";
    default:
      return h;
  }
}

/**
 * Poll until the agent container is up and has stayed up for
 * {@link AGENT_STABLE_WINDOW_MS}.
 *
 * Called ONLY after a start was actually attempted, so every non-up
 * outcome here is a real failure — including "container never appeared".
 *
 * The guarantee: an `ok` verdict means the container was observed up in
 * every sample across a window of at least `(stableSamples - 1) *
 * intervalMs` milliseconds. A container that dies inside that window fails,
 * whatever it looked like on the first frame.
 */
export async function waitForAgentContainerUp(
  agent: string,
  deps: VerifyDeps = {},
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    stableSamples?: number;
  } = {},
): Promise<VerifyFinding> {
  const listContainers = deps.listContainers ?? listSwitchroomContainers;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? AGENT_UP_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? AGENT_POLL_INTERVAL_MS;
  const stableSamples = opts.stableSamples ?? AGENT_STABLE_SAMPLES;

  const name = `${agent}: container up`;
  const container = agentContainerName(agent);
  // Poll-count rather than wall-clock so the loop is deterministic under
  // an injected no-op sleep.
  const maxSamples = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));

  let stable = 0;
  let last: ContainerHealth | "absent" | "docker-unavailable" = "absent";

  for (let i = 0; i < maxSamples; i++) {
    const rows = listContainers();
    if (rows === null) {
      return {
        name,
        status: "fail",
        detail: `docker ps is unavailable, so ${container} cannot be verified`,
        fix: DOCKER_UNAVAILABLE_FIX,
        code: DOCKER_UNAVAILABLE_CODE,
      };
    }
    const health = agentContainerHealth(agent, rows);
    last = health;

    if (health === "restarting") {
      return {
        name,
        status: "fail",
        detail: `${container} is crash-looping (docker status: Restarting)`,
        fix: `docker logs ${container} --tail 50`,
      };
    }
    if (health === "exited") {
      return {
        name,
        status: "fail",
        detail: `${container} started and then exited`,
        fix: `docker logs ${container} --tail 50`,
      };
    }
    if (isUp(health)) {
      stable++;
      if (stable >= stableSamples) {
        const windowSec = Math.round(((stable - 1) * intervalMs) / 1000);
        return {
          name,
          status: "ok",
          detail:
            `${container} is up and stayed up for ${windowSec}s ` +
            `(${stable} consecutive checks)` +
            (health === "running-healthy" ? " (healthcheck: healthy)" : ""),
        };
      }
    } else {
      // absent / created / starting / unhealthy / other — not evidence of a
      // healthy start; reset the window rather than crediting stability.
      stable = 0;
    }

    if (i < maxSamples - 1) await sleep(intervalMs);
  }

  return {
    name,
    status: "fail",
    detail:
      `${container} did not reach a stable running state within ` +
      `${Math.round(timeoutMs / 1000)}s (last docker state: ${describeHealth(last)})`,
    // Review H3(b): `docker logs` on a container that never existed prints
    // "No such container" — useless guidance exactly when the operator is
    // most lost. Name the state we actually observed.
    fix:
      last === "absent"
        ? `No ${container} container was created. Check that \`switchroom apply\` ` +
          "has generated the compose file, then " +
          `\`switchroom agent start ${agent}\` and read its output.`
        : `docker logs ${container} --tail 50`,
  };
}

/** Knobs for {@link verifyFleetContainers}. */
export interface FleetVerifyOptions {
  /**
   * Whether this run *depends* on docker. False when the operator took the
   * documented `SWITCHROOM_MEMORY_BACKEND=none` / `memory.backend: none`
   * opt-out and nothing container-backed was attempted — then an absent
   * docker is `pending` (honest, exit 0), not a hard fail.
   *
   * Review H1: step 6 honours that opt-out but step 13 did not, so the
   * documented Docker-less path still exited 1. Defaults to true.
   */
  dockerRequired?: boolean;
  /**
   * True when step 6 started (or found already running) the hindsight
   * container in THIS run. Then a missing / dead `switchroom-hindsight` is
   * a failure this wizard owns, rather than "absent is fine" (review H2).
   */
  hindsightExpected?: boolean;
  /** Samples that must all show breakage before returning `fail` (M4). */
  confirmSamples?: number;
  /** Gap between those samples. */
  confirmIntervalMs?: number;
}

/**
 * Fleet-level runtime verification, reusing doctor's runtime health check.
 *
 * Returns:
 *   - a `fail` when docker is unreachable and this run needed it,
 *   - a `fail` for doctor's stuck/crash-loop signature — CONFIRMED across
 *     `confirmSamples` snapshots, symmetric with the `ok` path (review M4),
 *   - a `fail` when memory was set up this run but its container is not
 *     usable (review H2/M6),
 *   - a `pending` when no agent container exists yet (the normal state
 *     right after a first-install `setup`, which runs before `apply`),
 *   - `ok` otherwise.
 */
export async function verifyFleetContainers(
  config: SwitchroomConfig,
  deps: VerifyDeps = {},
  opts: FleetVerifyOptions = {},
): Promise<VerifyFinding[]> {
  const listContainers = deps.listContainers ?? listSwitchroomContainers;
  const sleep = deps.sleep ?? defaultSleep;
  const confirmSamples = Math.max(1, opts.confirmSamples ?? FLEET_FAIL_CONFIRM_SAMPLES);
  const confirmIntervalMs = opts.confirmIntervalMs ?? FLEET_FAIL_CONFIRM_INTERVAL_MS;

  // Sample until either the verdict is non-fatal or every confirmation
  // sample agreed that it is broken. A transient `created`/`restarting`
  // frame during a `restart: always` bounce therefore clears instead of
  // exiting 1 on a healthy fleet.
  let findings = evaluateFleetSnapshot(config, listContainers(), opts);
  const sawFatal = hasFatal(findings);
  for (let i = 1; i < confirmSamples && hasFatal(findings); i++) {
    await sleep(confirmIntervalMs);
    findings = evaluateFleetSnapshot(config, listContainers(), opts);
  }

  if (!hasFatal(findings) && sawFatal) {
    // A crash-looping container reads "Up 1 second" between restarts, so
    // "a later sample was clean" is NOT evidence of health — it is exactly
    // what a flap looks like. Don't hard-fail (that's the M4 false
    // positive), but never print green over it either: downgrade to
    // pending and say what we saw.
    findings = findings.map((f) =>
      f.status === "ok" ? { ...f, status: "pending" as VerifyStatus } : f,
    );
    findings.push({
      name: "runtime stability",
      status: "pending",
      detail:
        "at least one switchroom container was restarting or stuck during " +
        "this check, then recovered — not treated as a failure (containers " +
        "run with `restart: always`), but not verified either",
      fix: "Confirm with `switchroom doctor` once the fleet has settled.",
    });
  }
  return findings;
}

/** One `docker ps` snapshot → findings. Pure; no clock, no I/O. */
function evaluateFleetSnapshot(
  config: SwitchroomConfig,
  rows: ContainerRow[] | null,
  opts: FleetVerifyOptions,
): VerifyFinding[] {
  const dockerRequired = opts.dockerRequired ?? true;

  if (rows === null) {
    return [
      {
        name: "docker runtime",
        status: dockerRequired ? "fail" : "pending",
        detail: dockerRequired
          ? "docker is not reachable — `docker ps` failed"
          : "docker is not reachable — nothing container-backed was verified " +
            "(memory backend is disabled, so setup did not need it)",
        fix: DOCKER_UNAVAILABLE_FIX,
        code: DOCKER_UNAVAILABLE_CODE,
      },
    ];
  }

  const out: VerifyFinding[] = [];

  // Reuse doctor's check verbatim so setup and `switchroom doctor` can
  // never disagree about what "the fleet is stuck" means.
  for (const row of checkContainerRuntimeHealth(config, {
    listContainers: () => rows,
  })) {
    if (row.status === "fail") {
      out.push({
        name: row.name,
        status: "fail",
        detail: row.detail ?? "container runtime health check failed",
        fix: row.fix,
      });
    }
  }

  // Hindsight is started by step 6 of this same wizard, so a crash-looping
  // memory container is something setup itself caused and must own.
  //
  // Review H2: "absent is fine" unconditionally meant that when step 6's
  // silent-return paths (port preflight, `startHindsight` throw) left NO
  // container behind, step 13 saw nothing to complain about and the wizard
  // still printed "Setup complete! Your agents are running." — the exact
  // lie this PR exists to remove. Those returns are now throws, and when
  // step 6 reports it started/found hindsight, step 13 holds it to that.
  const hindsightExpected = opts.hindsightExpected ?? false;
  const hindsight = rows.find((r) => r.name === "switchroom-hindsight");
  const HINDSIGHT_LOGS_FIX = "docker logs switchroom-hindsight --tail 50";
  if (!hindsight) {
    if (hindsightExpected) {
      out.push({
        name: "hindsight memory",
        status: "fail",
        detail:
          "memory setup reported success but there is no switchroom-hindsight container",
        fix: "Re-run `switchroom memory setup` and read its output.",
      });
    }
    // Not expected + absent: nothing to say (backend `none`, opted out, or
    // an older install).
  } else {
    const h = classifyContainerStatus(hindsight.status);
    if (h === "restarting" || h === "created") {
      out.push({
        name: "hindsight memory",
        status: "fail",
        detail: `switchroom-hindsight is ${h === "restarting" ? "crash-looping" : "stuck in Created"}`,
        fix: HINDSIGHT_LOGS_FIX,
      });
    } else if (h === "running-unhealthy") {
      // M6: the hindsight healthcheck exists to make a wedged API visible.
      // Treating "Up (unhealthy)" as running verified a dead backend green.
      out.push({
        name: "hindsight memory",
        status: "fail",
        detail:
          "switchroom-hindsight is running but its healthcheck is failing " +
          "(the memory API is not answering)",
        fix: HINDSIGHT_LOGS_FIX,
      });
    } else if (h === "running-starting") {
      // Normal for the first ~60s after start (--health-start-period 60s).
      out.push({
        name: "hindsight memory",
        status: "pending",
        detail: "switchroom-hindsight is still starting (healthcheck not settled)",
        fix: "Re-check with `switchroom doctor` in a minute.",
      });
    } else if (!isUp(h)) {
      out.push({
        name: "hindsight memory",
        status: hindsightExpected ? "fail" : "pending",
        detail: `switchroom-hindsight is not running (docker state: ${describeHealth(h)})`,
        fix: "Restart it with `switchroom memory setup`, or `docker start switchroom-hindsight`.",
      });
    }
  }

  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) {
    out.push({
      name: "agent containers",
      status: "pending",
      detail: "no agents configured yet — nothing to verify",
      fix: "Add an agent to switchroom.yaml, then `switchroom apply`.",
    });
    return out;
  }

  const running = agents.filter((a) => isUp(agentContainerHealth(a, rows)));
  // Everything not demonstrably up, whatever its docker state — so an
  // unexpected state (paused/dead) is named rather than silently dropped.
  const notUp = agents.filter((a) => !isUp(agentContainerHealth(a, rows)));

  if (running.length === agents.length) {
    out.push({
      name: "agent containers",
      status: "ok",
      detail: `${running.length}/${agents.length} agent container(s) running`,
    });
    return out;
  }

  out.push({
    name: "agent containers",
    status: "pending",
    detail:
      `${running.length}/${agents.length} agent container(s) running — ` +
      `not up: ${notUp
        .map((a) => `${a} (${describeHealth(agentContainerHealth(a, rows))})`)
        .join(", ")}`,
    fix:
      "The fleet is not running yet. Next: `switchroom apply` then " +
      "`docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d`",
  });
  return out;
}

/**
 * Collapse findings that several probes produced for the same underlying
 * fact, keyed on {@link VerifyFinding.code} (review L9: a docker-less host
 * got the same "docker is not reachable" row twice — once from the agent
 * poller, once from the fleet check). Findings without a `code` are always
 * kept; the first occurrence wins so the earliest, most specific wording
 * survives.
 */
export function dedupeFindings(findings: VerifyFinding[]): VerifyFinding[] {
  const seen = new Set<string>();
  const out: VerifyFinding[] = [];
  for (const f of findings) {
    if (f.code) {
      if (seen.has(f.code)) continue;
      seen.add(f.code);
    }
    out.push(f);
  }
  return out;
}

/** True when any finding is fatal. */
export function hasFatal(findings: VerifyFinding[]): boolean {
  return findings.some((f) => f.status === "fail");
}

/** Error thrown by the wizard when verification finds a fatal problem. */
export class SetupVerificationError extends Error {
  readonly findings: VerifyFinding[];
  constructor(findings: VerifyFinding[]) {
    const failed = findings.filter((f) => f.status === "fail");
    super(
      `verification failed: ${failed
        .map((f) => `${f.name} — ${f.detail}`)
        .join("; ")}`,
    );
    this.name = "SetupVerificationError";
    this.findings = findings;
  }
}
