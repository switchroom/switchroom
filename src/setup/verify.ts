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
 *     up across consecutive samples (a crash-looping container is "Up" for
 *     a moment, then "Restarting"). Any terminal state (exited / restarting)
 *     fails immediately; a timeout fails with the last observed state.
 *   - `verifyFleetContainers` — reuse doctor's `checkContainerRuntimeHealth`
 *     (the 2026-06-23 stuck/crash-loop signature) rather than inventing a
 *     parallel health surface, and translate its rows into setup findings.
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
}

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
export const AGENT_UP_TIMEOUT_MS = 30_000;
/**
 * Gap between `docker ps` samples while waiting. Wide enough that
 * AGENT_STABLE_SAMPLES spans several seconds — a container that restarts
 * every second cannot fake stability across the window.
 */
export const AGENT_POLL_INTERVAL_MS = 2_000;
/**
 * Consecutive "Up" samples required before we call a start verified. A
 * crash-looping container shows "Up 1 second" between restarts, so a single
 * sample is not evidence that it *stayed* up.
 */
export const AGENT_STABLE_SAMPLES = 3;

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

function isUp(h: ContainerHealth | "absent"): boolean {
  return h === "running-healthy" || h === "running-no-healthcheck";
}

const DOCKER_UNAVAILABLE_FIX =
  "Install/start Docker (the fleet runs as containers), then re-run `switchroom setup`.";

/**
 * Poll until the agent container is up and has stayed up.
 *
 * Called ONLY after a start was actually attempted, so every non-up
 * outcome here is a real failure — including "container never appeared".
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
        return {
          name,
          status: "ok",
          detail:
            `${container} is up and stayed up across ${stable} checks` +
            (health === "running-healthy" ? " (healthcheck: healthy)" : ""),
        };
      }
    } else {
      // absent / created / other — still coming up; don't credit stability.
      stable = 0;
    }

    if (i < maxSamples - 1) await sleep(intervalMs);
  }

  const lastDesc = last === "absent" ? "no such container" : last;
  return {
    name,
    status: "fail",
    detail:
      `${container} did not reach a stable running state within ` +
      `${Math.round(timeoutMs / 1000)}s (last docker state: ${lastDesc})`,
    fix: `docker logs ${container} --tail 50`,
  };
}

/**
 * Fleet-level runtime verification, reusing doctor's runtime health check.
 *
 * Returns:
 *   - a `fail` when docker is unreachable (nothing in the fleet can run),
 *   - a `fail` for doctor's stuck/crash-loop signature,
 *   - a `pending` when no agent container exists yet (the normal state
 *     right after a first-install `setup`, which runs before `apply`),
 *   - `ok` otherwise.
 */
export function verifyFleetContainers(
  config: SwitchroomConfig,
  deps: VerifyDeps = {},
): VerifyFinding[] {
  const listContainers = deps.listContainers ?? listSwitchroomContainers;
  const rows = listContainers();

  if (rows === null) {
    return [
      {
        name: "docker runtime",
        status: "fail",
        detail: "docker is not reachable — `docker ps` failed",
        fix: DOCKER_UNAVAILABLE_FIX,
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
  // memory container is something setup itself caused and must own. Absent
  // is fine (memory backend `none`, or an older install).
  const hindsight = rows.find((r) => r.name === "switchroom-hindsight");
  if (hindsight) {
    const h = classifyContainerStatus(hindsight.status);
    if (h === "restarting" || h === "created") {
      out.push({
        name: "hindsight memory",
        status: "fail",
        detail: `switchroom-hindsight is ${h === "restarting" ? "crash-looping" : "stuck in Created"}`,
        fix: "docker logs switchroom-hindsight --tail 50",
      });
    } else if (h === "exited") {
      out.push({
        name: "hindsight memory",
        status: "pending",
        detail: "switchroom-hindsight is not running",
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
      `not up: ${notUp.join(", ")}`,
    fix:
      "The fleet is not running yet. Next: `switchroom apply` then " +
      "`docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d`",
  });
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
