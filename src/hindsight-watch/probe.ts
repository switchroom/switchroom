/**
 * The three probes, and the rule that binds them: EVERY probe failure is a
 * signal, never a default.
 *
 * Cost per pass (measured against the live host, 2026-07-25 re-measured
 * 2026-07-26): one HTTP GET of the `/metrics` body (258,741 B today), one
 * `docker inspect`, and per agent (12 today) two readdirs plus one small
 * `pending-drops.json` read. No queue ENTRY is ever opened — those carry
 * whole transcripts, p50 ~98 KB. At the recommended 15-minute cadence that
 * is 4 requests an hour against a backend whose own workers issue thousands
 * — the watchdog cannot itself become the load.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  parseExposition,
  readLlmSignals,
  readRetainSignals,
  type LlmSignals,
  type RetainSignals,
} from "./metrics.js";
import { probeRecallLogs, type RecallStats } from "./recall-log.js";
import {
  DEFAULT_CONTAINER,
  DEFAULT_METRICS_URL,
  METRICS_MAX_BYTES,
  METRICS_TIMEOUT_MS,
} from "./thresholds.js";
import type { ConsolidationSample, Sample } from "./types.js";

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

/** The `/metrics` slice one tick consumes. */
export interface MetricsSample {
  retain: RetainSignals;
  /** null when the exposition carries no LLM-call family (see `readLlmSignals`) */
  llm: LlmSignals | null;
}

/**
 * GET `/metrics` and reduce it to the signals one tick needs. Throws on any
 * failure to fetch, read or parse — an unreachable or unparseable endpoint is
 * an alert, never a clean bill of health.
 */
export async function probeMetrics(
  url: string = DEFAULT_METRICS_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricsSample> {
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
    const series = parseExposition(body);
    return { retain: readRetainSignals(series), llm: readLlmSignals(series) };
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
  /** entries in every agent's `pending-evicted/` archive (#3599) */
  evicted: number;
  /** summed `count` of every agent's `pending-drops.json` ledger (#3599) */
  drops: number;
  /** agents whose spool dir was readable (for the operator-facing detail) */
  agents: number;
}

/** Sanity bound on `pending-drops.json`; the real ledger is ~150 B. */
const DROPS_LEDGER_MAX_BYTES = 64 * 1024;

/**
 * Read one agent's `pending-drops.json` `count`, or 0.
 *
 * The ledger is a small fixed-shape object (`{schema, count, last_*}`), so
 * this is one tiny read per agent per tick — nothing like reading the queue
 * entries themselves, which carry whole transcripts. A missing, torn or
 * foreign-shaped ledger reads as 0: `record_drop` writes it tmp+rename so a
 * torn read is a transient the next tick resolves, and inventing a loss out
 * of an unparseable file would be a false alarm on the loudest signal here.
 */
function readDropCount(hindsightDir: string): number {
  const path = resolve(hindsightDir, "pending-drops.json");
  let parsed: unknown;
  try {
    // The real ledger is a few hundred bytes. Refusing anything larger keeps
    // a corrupt or wrongly-named file from being slurped into memory on
    // every tick — this runs unattended on a cron.
    if (statSync(path).size > DROPS_LEDGER_MAX_BYTES) return 0;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null) return 0;
  const n = Number((parsed as { count?: unknown }).count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Count `*.json` / `*.json.dead` across every agent's spool, plus the two
 * loss channels #3599 added beside it — `pending-evicted/` and
 * `pending-drops.json`, both siblings of `pending-retains/`
 * (`lib/pending.py:_sibling`), so neither can be mistaken for a live entry.
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
/**
 * The agents scaffold dir, honouring `SWITCHROOM_HOME` like the rest of the
 * CLI. Shared by the spool and recall-log probes so the two can never read
 * different fleets.
 */
export function resolveAgentsDir(explicit?: string): string {
  return (
    explicit ??
    resolve(process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(), ".switchroom", "agents")
  );
}

export function probeSpool(agentsDir: string = resolveAgentsDir()): SpoolDepth {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch (e) {
    throw new ProbeError(`reading ${agentsDir}: ${(e as Error).message}`, "spool");
  }
  let pending = 0;
  let dead = 0;
  let evicted = 0;
  let drops = 0;
  let agents = 0;
  for (const name of names) {
    const hindsightDir = resolve(agentsDir, name, "home", ".hindsight");
    let entries: string[] | null = null;
    try {
      entries = readdirSync(resolve(hindsightDir, "pending-retains"));
    } catch {
      // No spool dir for this agent (never spooled, or not an agent dir at
      // all). Absence is not a fault — a missing queue is an empty queue.
      // NOTE we deliberately do NOT `continue` here: the two loss channels
      // are SIBLINGS of the queue dir, not children of it, so an operator
      // who deletes `pending-retains` must not thereby make this agent's
      // eviction/drop history invisible (it would read as a decrease, and a
      // decrease is a silent re-baseline).
    }
    if (entries !== null) {
      agents++;
      for (const f of entries) {
        if (f.endsWith(".json.dead")) dead++;
        else if (f.endsWith(".json")) pending++;
        // Anything else (notably the `.tmp` files a torn tmp+rename leaves
        // behind — 8 of them live on this fleet) is not a queue entry.
      }
    }
    try {
      for (const f of readdirSync(resolve(hindsightDir, "pending-evicted"))) {
        if (f.endsWith(".json")) evicted++;
      }
    } catch {
      // Nothing has ever been evicted for this agent. Not a fault.
    }
    // `.dead` markers used to be written INSIDE `pending-retains`; they are
    // now retired into the `pending-dead/` sibling so that no janitor glob
    // over the live queue can match a memory. Both locations are counted:
    // if only the in-queue form were counted, the relocation would read as
    // `dead` dropping to zero, i.e. a silent loss of the loss signal.
    try {
      for (const f of readdirSync(resolve(hindsightDir, "pending-dead"))) {
        if (f.endsWith(".dead")) dead++;
      }
    } catch {
      // Nothing has ever been retired for this agent. Not a fault.
    }
    drops += readDropCount(hindsightDir);
  }
  return { pending, dead, evicted, drops, agents };
}

export interface ProbeOptions {
  metricsUrl?: string;
  container?: string;
  agentsDir?: string;
  fetchImpl?: typeof fetch;
  run?: Runner;
  now?: () => number;
}

/**
 * Shell run inside the hindsight container to read the consolidation queue.
 *
 * Deliberately a near-copy of `docker/hindsight-maintenance.sh`'s `_sql`
 * bootstrap (glob the pg0 install for `psql`, read the instance descriptor for
 * the credentials) rather than a new connection convention, so the watchdog
 * and the maintenance loop cannot end up reading two different databases.
 *
 * Prints `<pending>|<oldest_age_seconds>` on success and nothing on any
 * missing precondition. The password is passed via `PGPASSWORD` in the
 * container's own environment and never crosses back out — the only thing
 * this returns is two integers.
 */
const CONSOLIDATION_QUEUE_SH = `
set -e
B="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "\${B:-/nonexistent}/psql")"
[ -x "$PSQL" ] || exit 0
D=/home/hindsight/.pg0/instances/hindsight/instance.json
[ -r "$D" ] || exit 0

# shlex.quote every field before eval. The descriptor is local and not
# attacker-controlled, but a password containing a shell metacharacter would
# otherwise either break the eval (silently degrading this signal to no-data
# forever) or execute part of itself. Quoting removes the class outright.
eval "$(python3 -c 'import json,shlex,sys
d=json.load(open(sys.argv[1]))
q=lambda k,dflt: shlex.quote(str(d.get(k) or dflt))
print("U=%s DB=%s P=%s PW=%s"%(q("username","hindsight"),q("database","hindsight"),q("port",5432),q("password","")))' "$D")"
[ -n "$PW" ] || exit 0
PGPASSWORD="$PW" "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -tAc \\
  "SELECT count(*)||'|'||coalesce(max(extract(epoch from (now()-created_at)))::bigint,0) FROM async_operations WHERE status IN ('pending','processing')"
`;

/**
 * Read the `async_operations` backlog, or null when it cannot be read.
 *
 * **Soft-fails on purpose**, unlike the three probes above. Those three throw
 * because their absence means the watchdog cannot see the thing it exists to
 * watch. This one needs a psql client and a pg descriptor that legitimately
 * do not exist off-host (CI, a dev laptop), so throwing would make the whole
 * watchdog unrunnable anywhere but production. Null degrades exactly ONE
 * signal to `no-data` — visibly, in the printed output — and the container
 * being down is already covered by the `container` signal.
 */
export function probeConsolidationQueue(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
): ConsolidationSample | null {
  const r = run("docker", ["exec", container, "sh", "-c", CONSOLIDATION_QUEUE_SH]);
  if (r.status !== 0) return null;
  const [pendingRaw, ageRaw] = r.stdout.trim().split("|");
  const pending = Number(pendingRaw);
  const oldestAgeS = Number(ageRaw);
  if (!Number.isFinite(pending) || !Number.isFinite(oldestAgeS)) return null;
  if (pending < 0 || oldestAgeS < 0) return null;
  return { pending, oldestAgeS };
}

/** Run every probe into one sample. A core-probe failure throws a ProbeError. */
export async function probeOnce(
  opts: ProbeOptions = {},
): Promise<{ sample: Sample; spool: SpoolDepth; recall: RecallStats }> {
  const now = opts.now ?? Date.now;
  const ts = now();
  const metrics = await probeMetrics(opts.metricsUrl, opts.fetchImpl);
  const container = probeContainer(opts.container, opts.run);
  const spool = probeSpool(opts.agentsDir);
  // `probeSpool` above already threw if the agents dir is unreadable, so this
  // cannot be reached with a bad dir today. Wrapped anyway: if the two probes
  // are ever reordered, an unreadable dir must still surface as a probe
  // failure rather than as a `recall` block full of confident zeroes.
  let recall: RecallStats;
  try {
    recall = probeRecallLogs(resolveAgentsDir(opts.agentsDir), ts);
  } catch (e) {
    throw new ProbeError(`reading recall logs: ${(e as Error).message}`, "spool");
  }
  const consolidation = probeConsolidationQueue(opts.container, opts.run);
  return {
    sample: {
      ts,
      retainOk: metrics.retain.ok,
      retainFail: metrics.retain.fail,
      llmOk: metrics.llm?.ok,
      llmFail: metrics.llm?.fail,
      pending: spool.pending,
      dead: spool.dead,
      evicted: spool.evicted,
      drops: spool.drops,
      restartCount: container.restartCount,
      startedAt: container.startedAt,
      health: container.health,
      recall,
      consolidation,
    },
    spool,
    recall,
  };
}
