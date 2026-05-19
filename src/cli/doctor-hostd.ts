/**
 * Host-control daemon (hostd) doctor checks (#1471).
 *
 * `doctor` had ZERO visibility into hostd — operators only discovered a
 * missing/drifted daemon when `/update apply` silently fell back to the
 * broken legacy path. These probes surface it up front:
 *
 *   1. configured   — is `host_control.enabled: true`? (Default-on
 *      since RFC C Phase 2 / #1338; a disabled state means /restart and
 *      /update apply use the legacy in-agent fallback, which fails on
 *      docker installs — #926.)
 *   2. running      — when enabled, is the `switchroom-hostd` container
 *      actually up?
 *   3. image drift  — is the running hostd image meaningfully older
 *      than the agent fleet's image? This is the field failure mode:
 *      `switchroom update --skip-images` intentionally skips the
 *      `refresh-hostd` step, so a fleet that rolled forward while hostd
 *      did not ends up with a stale daemon and a CLI↔daemon version
 *      gap. Remediation: `switchroom hostd install` (or a
 *      `switchroom update` WITHOUT `--skip-images`).
 *
 * All probes accept dependency-injected docker access so
 * `tests/doctor-hostd.test.ts` drives every branch without containers.
 */

import { spawnSync } from "node:child_process";

import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export const HOSTD_CONTAINER = "switchroom-hostd";

/** Hours the hostd image may lag the agent image before it's flagged.
 *  Same-release builds (one docker-images workflow run) are minutes
 *  apart; a real drift is the fleet rolled and hostd didn't — hours+. */
export const HOSTD_DRIFT_HOURS = 2;

/** Docker injection seam. Tests pass fakes; production uses spawnSync. */
export interface HostdProbeDeps {
  /**
   * `docker inspect <ref> --format <fmt>` → trimmed stdout, or null on
   * any failure (no docker, missing ref, transient error).
   */
  dockerInspect?: (ref: string, format: string) => string | null;
}

function realDockerInspect(ref: string, format: string): string | null {
  try {
    const r = spawnSync("docker", ["inspect", ref, "--format", format], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Created-timestamp (ISO) of the image a container runs, or null. */
function imageCreatedAt(
  container: string,
  dockerInspect: (ref: string, format: string) => string | null,
): string | null {
  const imageId = dockerInspect(container, "{{.Image}}");
  if (!imageId) return null;
  return dockerInspect(imageId, "{{.Created}}");
}

export function runHostdChecks(
  config: SwitchroomConfig,
  deps: HostdProbeDeps = {},
): CheckResult[] {
  const dockerInspect = deps.dockerInspect ?? realDockerInspect;
  const enabled = config.host_control?.enabled === true;

  if (!enabled) {
    return [
      {
        name: "hostd: configured",
        status: "warn",
        detail:
          "host_control.enabled is not true — /restart and /update apply " +
          "use the legacy in-agent fallback, which fails on docker installs (#926)",
        fix: "Set `host_control: { enabled: true }` in switchroom.yaml and run `switchroom hostd install`",
      },
    ];
  }

  const results: CheckResult[] = [
    {
      name: "hostd: configured",
      status: "ok",
      detail: "host_control.enabled: true",
    },
  ];

  const status = dockerInspect(HOSTD_CONTAINER, "{{.State.Status}}");
  if (status !== "running") {
    results.push({
      name: "hostd: running",
      status: "fail",
      detail:
        status === null
          ? `${HOSTD_CONTAINER} container not found`
          : `${HOSTD_CONTAINER} is ${status}, not running`,
      fix: "Run `switchroom hostd install` on the host to (re)create the daemon",
    });
    return results; // drift check is meaningless without a running daemon
  }
  results.push({
    name: "hostd: running",
    status: "ok",
    detail: `${HOSTD_CONTAINER} running`,
  });

  // Image-drift: compare hostd's image vintage to a running agent's.
  const hostdCreated = imageCreatedAt(HOSTD_CONTAINER, dockerInspect);
  let agentCreated: string | null = null;
  for (const name of Object.keys(config.agents ?? {})) {
    agentCreated = imageCreatedAt(`switchroom-${name}`, dockerInspect);
    if (agentCreated) break;
  }
  if (!hostdCreated || !agentCreated) {
    results.push({
      name: "hostd: image drift",
      status: "ok",
      detail: "skipped — no running agent image to compare against",
    });
    return results;
  }
  const hostdMs = Date.parse(hostdCreated);
  const agentMs = Date.parse(agentCreated);
  if (Number.isNaN(hostdMs) || Number.isNaN(agentMs)) {
    results.push({
      name: "hostd: image drift",
      status: "ok",
      detail: "skipped — unparseable image timestamps",
    });
    return results;
  }
  const lagHours = (agentMs - hostdMs) / 3_600_000;
  if (lagHours > HOSTD_DRIFT_HOURS) {
    results.push({
      name: "hostd: image drift",
      status: "warn",
      detail:
        `hostd image is ~${lagHours.toFixed(1)}h older than the agent fleet ` +
        `image — likely a \`switchroom update --skip-images\` left it behind ` +
        `(that flag skips the refresh-hostd step)`,
      fix: "Run `switchroom hostd install` (or `switchroom update` without `--skip-images`)",
    });
  } else {
    results.push({
      name: "hostd: image drift",
      status: "ok",
      detail: `in sync with the agent fleet image (±${HOSTD_DRIFT_HOURS}h)`,
    });
  }
  return results;
}
