/**
 * The three probes, and the rule that binds them: EVERY probe failure is a
 * signal, never a default.
 *
 * Cost per pass (measured against the live host, 2026-07-25): one HTTP GET
 * of a ~60 KB `/metrics` body, one `docker inspect`, and one `readdir` per
 * agent (11 today). At the recommended 15-minute cadence that is ~4 requests
 * an hour against a backend whose own workers issue thousands — the watchdog
 * cannot itself become the load.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseExposition, readRetainSignals, type RetainSignals } from "./metrics.js";
import {
  DEFAULT_CONTAINER,
  DEFAULT_METRICS_URL,
  METRICS_MAX_BYTES,
  METRICS_TIMEOUT_MS,
} from "./thresholds.js";
import type { Sample } from "./types.js";

/**
 * A probe failed in a way that means the watchdog CANNOT SEE hindsight. It
 * is deliberately an exception rather than a "0" default: the whole point of
 * this module is that an unreachable endpoint reads as an alert, not as a
 * clean bill of health.
 */
export class ProbeError extends Error {
  constructor(
    message: string,
    readonly probe: "metrics" | "docker" | "spool",
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

/** GET `/metrics` and reduce it to the retain signals. Throws on any failure. */
export async function probeMetrics(
  url: string = DEFAULT_METRICS_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<RetainSignals> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProbeError(`GET ${url} failed: ${(e as Error).message}`, "metrics");
  }
  if (!res.ok) throw new ProbeError(`GET ${url} returned HTTP ${res.status}`, "metrics");
  let body: string;
  try {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > METRICS_MAX_BYTES) {
      throw new Error(`body ${buf.byteLength}B exceeds ${METRICS_MAX_BYTES}B cap`);
    }
    body = new TextDecoder().decode(buf);
  } catch (e) {
    throw new ProbeError(`reading ${url}: ${(e as Error).message}`, "metrics");
  }
  try {
    return readRetainSignals(parseExposition(body));
  } catch (e) {
    throw new ProbeError(`parsing ${url}: ${(e as Error).message}`, "metrics");
  }
}

/** The container facts the watchdog reads. */
export interface ContainerFacts {
  restartCount: number;
  startedAt: string;
  /** `State.Health.Status`, or `"none"` when the image defines no healthcheck. */
  health: string;
}

export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "pipe", timeout: 10_000, encoding: "utf8" });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * `docker inspect` the hindsight container. Throws when docker is missing or
 * the container is absent — "I cannot tell whether it is running" is exactly
 * as alarming as "it is not running", and must not be flattened to healthy.
 */
export function probeContainer(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
): ContainerFacts {
  const fmt = "{{.RestartCount}}\t{{.State.StartedAt}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
  const r = run("docker", ["inspect", "--format", fmt, container]);
  if (r.status !== 0) {
    throw new ProbeError(
      `docker inspect ${container} failed (exit ${r.status}): ${r.stderr.trim() || "no stderr"}`,
      "docker",
    );
  }
  const parts = r.stdout.trim().split("\t");
  if (parts.length < 3) {
    throw new ProbeError(`docker inspect ${container}: unparseable output ${JSON.stringify(r.stdout)}`, "docker");
  }
  const restartCount = Number(parts[0]);
  if (!Number.isFinite(restartCount)) {
    throw new ProbeError(`docker inspect ${container}: non-numeric RestartCount ${JSON.stringify(parts[0])}`, "docker");
  }
  return { restartCount, startedAt: parts[1], health: parts[2] };
}

/** Fleet-wide spool depth. */
export interface SpoolDepth {
  pending: number;
  dead: number;
  /** agents whose spool dir was readable (for the operator-facing detail) */
  agents: number;
}

/**
 * Count `*.json` / `*.json.dead` across every agent's spool.
 *
 * Reads the HOST scaffold path (`~/.switchroom/agents/<a>/home/.hindsight/
 * pending-retains`), which is the same directory the agent container sees at
 * `/state/agent/home/.hindsight/pending-retains` — verified live: the
 * compose mount is `~/.switchroom/agents/<name>` → `/state/agent`. That
 * makes this a plain readdir instead of the N `docker exec` round-trips
 * `switchroom doctor` pays (src/cli/doctor.ts, `probePendingRetainsQueue`),
 * which matters for something running every 15 minutes.
 *
 * NOTE the distinction from doctor's comment about a host scan being
 * "always empty": that refers to the OPERATOR's own `$HOME/.hindsight`,
 * which really is empty. The per-agent scaffold path used here is not.
 */
export function probeSpool(
  agentsDir: string = resolve(
    process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
    ".switchroom",
    "agents",
  ),
): SpoolDepth {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch (e) {
    throw new ProbeError(`reading ${agentsDir}: ${(e as Error).message}`, "spool");
  }
  let pending = 0;
  let dead = 0;
  let agents = 0;
  for (const name of names) {
    const dir = resolve(agentsDir, name, "home", ".hindsight", "pending-retains");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // No spool dir for this agent (never spooled, or not an agent dir at
      // all). Absence is not a fault — a missing queue is an empty queue.
      continue;
    }
    agents++;
    for (const f of entries) {
      if (f.endsWith(".json.dead")) dead++;
      else if (f.endsWith(".json")) pending++;
    }
  }
  return { pending, dead, agents };
}

export interface ProbeOptions {
  metricsUrl?: string;
  container?: string;
  agentsDir?: string;
  fetchImpl?: typeof fetch;
  run?: Runner;
  now?: () => number;
}

/** Run all three probes into one sample. Any failure throws a ProbeError. */
export async function probeOnce(opts: ProbeOptions = {}): Promise<{ sample: Sample; spool: SpoolDepth }> {
  const now = opts.now ?? Date.now;
  const retain = await probeMetrics(opts.metricsUrl, opts.fetchImpl);
  const container = probeContainer(opts.container, opts.run);
  const spool = probeSpool(opts.agentsDir);
  return {
    sample: {
      ts: now(),
      retainOk: retain.ok,
      retainFail: retain.fail,
      retainBuckets: retain.buckets,
      pending: spool.pending,
      dead: spool.dead,
      restartCount: container.restartCount,
      startedAt: container.startedAt,
      health: container.health,
    },
    spool,
  };
}
