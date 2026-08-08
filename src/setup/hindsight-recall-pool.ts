/**
 * Optional Hindsight recall/background WORKER SPLIT — a second container that
 * serves recall/reflect only, so the interactive read path stops contending
 * with the single background WorkerPoller for uvicorn workers and DB pool.
 *
 * ## Why this exists
 *
 * The default topology is ONE `switchroom-hindsight` container: embedded pg0
 * Postgres + a single background WorkerPoller + the recall/reflect API, all in
 * one uvicorn process. Under load the background consolidation/retain lane and
 * the interactive recall lane fight for the same worker and the same DB pool,
 * and recall throughput floors out (measured 2.6 rps single-container).
 *
 * The split keeps the existing container as the AUTHORITY — it still owns pg0,
 * the single background WorkerPoller, the healthcheck, and all
 * consolidation/retain processing — but moves it OFF the public port onto a
 * background port ({@link hindsightBackgroundApiPort}, public+1). A NEW sibling
 * container, `switchroom-hindsight-recall`, then takes the public port with N
 * uvicorn workers, its background poller DISABLED, connecting to the authority
 * container's pg0 over host-network loopback. It serves recall/reflect only.
 * Measured 5.6 rps (2.2x) with the split on.
 *
 * The public port never moves: `memory.config.url` (every agent's memory
 * client) keeps pointing at the same port; when the pool is enabled that port
 * is now served by the pool instead of the authority container.
 *
 * ## OFF by default
 *
 * Everything here is gated on `hindsight.recall_pool.enabled` in
 * switchroom.yaml (see {@link resolveRecallPoolConfig}). Absent or false ⇒ this
 * module contributes NOTHING: `startHindsight` launches the single container on
 * the public port exactly as before, and no second container is created. This
 * is a strict, backward-compatible opt-in.
 *
 * ## Connection budget (the load-bearing invariant)
 *
 * pg0 runs with `max_connections=250`. The authority container reserves
 * {@link HINDSIGHT_BACKGROUND_CONNECTION_BUDGET} (write {@link
 * HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE} + read {@link
 * HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE}). The pool's N workers each open a
 * write + read pool, so `N*(write+read)` must fit in what remains under 250
 * with headroom. {@link recallPoolDbPoolSizing} sizes the per-worker pools down
 * from {@link HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET} so the total can never
 * overflow, and {@link assertRecallPoolConnectionBudget} re-proves it for
 * operator overrides — an overflow is a hard boot failure in Postgres, not a
 * soft degrade, so it is caught here before launch.
 *
 * The exact env + docker flags this module emits were validated live on the
 * fleet 2026-08-09 (`hindsight-recallsplit-*` scripts). This module is the
 * first-class, `switchroom apply`-survivable form of that hand-applied topology.
 */

import { execFileSync } from "node:child_process";

import {
  HINDSIGHT_BROKER_SOCK_VOLUME,
  HINDSIGHT_CRED_DIR,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_SHM_SIZE,
  HINDSIGHT_DEFAULT_UID,
  HINDSIGHT_HEALTHCHECK_CMD,
  HINDSIGHT_HOST_NETWORK_BIND_ADDR,
  buildLiteLlmAwareHealthCmd,
  defaultDockerProbe,
  dockerNameMatchesExactly,
  hindsightContainerEnvPairs,
  hindsightGpuEnabled,
  hindsightImageRef,
  pickHindsightLiteLlmProbeUrl,
  type DockerProbe,
  type HindsightLlmConfig,
  type HindsightPerfOptions,
  type LiteLLMHindsightConfig,
} from "./hindsight.js";

/** The sibling container's name and stable worker identity. */
export const HINDSIGHT_RECALL_POOL_CONTAINER = "switchroom-hindsight-recall";
export const HINDSIGHT_RECALL_POOL_WORKER_ID = "switchroom-hindsight-recall";

/**
 * pg0 is launched with `max_connections=250` (upstream default the image
 * bakes; the entrypoint does not raise it). Every pool sizing decision here is
 * relative to this ceiling.
 */
export const HINDSIGHT_PG_MAX_CONNECTIONS = 250;

/**
 * DB pool caps the AUTHORITY (background) container takes when the split is on.
 * The single-container default leaves the pools uncapped-large; capping the
 * background container frees connection headroom for the pool's N workers.
 * Validated live: write 40 / read 20 = 60 connections for the background lane.
 */
export const HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE = 40;
export const HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE = 20;
export const HINDSIGHT_BACKGROUND_CONNECTION_BUDGET =
  HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE + HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE;

/**
 * PostgreSQL's `superuser_reserved_connections` (default 3). These slots at the
 * top of `max_connections` are usable ONLY by superusers, so the effective
 * ceiling for the app's own (non-superuser) connections is `max_connections -
 * superuser_reserved_connections`. It is called out as its own constant so the
 * headroom below is provably ≥ it: the app must never be sized to consume a
 * slot PG will refuse it anyway (that manifests as the same `FATAL: too many
 * clients` the budget exists to prevent).
 */
export const HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS = 3;

/**
 * Connection HEADROOM below `max_connections` that no pool — auto-sized OR
 * operator-overridden — may consume. It covers, in one number:
 *   - PG's {@link HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS} superuser slots
 *     (3), which non-superuser app connections cannot use at all, plus
 *   - the handful of short-lived admin/maintenance connections pg0 opens for
 *     itself (autovacuum launcher, the entrypoint's pg_dump backup loop, `psql`
 *     probes) that are NOT part of either pool's budget. Peak observed live: 55
 *     app connections against the 240 ceiling.
 * 10 ≥ 3 by construction, so the superuser reserve is always inside the
 * headroom and can never be handed out. See {@link asserted at build time below}.
 */
export const HINDSIGHT_RECALL_POOL_HEADROOM = 10;

// The headroom must cover the superuser reserve, or the "effective ceiling"
// reasoning above is a lie. Proven at module load — a future edit that lowers
// the headroom below the reserve fails fast here rather than at pg0 runtime.
if (HINDSIGHT_RECALL_POOL_HEADROOM < HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS) {
  throw new Error(
    `HINDSIGHT_RECALL_POOL_HEADROOM (${HINDSIGHT_RECALL_POOL_HEADROOM}) must be ≥ ` +
      `HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS ` +
      `(${HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS}).`,
  );
}

/**
 * The hard ceiling on TOTAL app connection demand (background + pool):
 * `max_connections - headroom = 250 - 10 = 240`. Every connection PG will
 * actually hand the app must fit under this — the {@link
 * HINDSIGHT_RECALL_POOL_HEADROOM} above (which subsumes the superuser reserve)
 * is deliberately left free. {@link assertRecallPoolConnectionBudget} enforces
 * it against BOTH the auto-sized config and any operator override, so an
 * override cannot silently eat the headroom.
 */
export const HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS =
  HINDSIGHT_PG_MAX_CONNECTIONS - HINDSIGHT_RECALL_POOL_HEADROOM;

/**
 * Connections the pool's workers may share, total. `240 total ceiling - 60
 * background = 180`. This is the budget the auto-sizer divides across workers;
 * because it is the total ceiling minus the background reserve, an auto-sized
 * pool lands exactly on the 240 ceiling and never above it.
 */
export const HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET =
  HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS - HINDSIGHT_BACKGROUND_CONNECTION_BUDGET;

/**
 * Default uvicorn worker count for the pool.
 *
 * Four, not more, because the recall reranker is a GPU cross-encoder
 * (`hindsight_api/engine/reranker/cross_encoder.py` selects `cuda`) and every
 * worker holds its own model on the single GPU — past ~4 the workers contend
 * for VRAM and the reranker, not the DB pool, becomes the bottleneck, so more
 * workers buy latency variance rather than throughput. An operator on a
 * bigger GPU (or a CPU reranker) can raise it via
 * `hindsight.recall_pool.workers`; the connection budget, not this default,
 * is the hard ceiling ({@link assertRecallPoolConnectionBudget}).
 */
export const HINDSIGHT_RECALL_POOL_DEFAULT_WORKERS = 4;

/**
 * The local pg0 DSN the pool connects to over host-network loopback. pg0 binds
 * `127.0.0.1:5432` inside the authority container; because both containers run
 * `--network host` they share the host loopback, so this reaches the authority
 * container's Postgres. Handing hindsight an EXTERNAL `HINDSIGHT_API_DATABASE_URL`
 * is also what makes the app SKIP starting its own embedded pg0
 * (memory_engine.py's pg0 bootstrap is gated on the absence of an external DB
 * URL) — so the pool never launches a second Postgres.
 */
export const HINDSIGHT_RECALL_POOL_PG_DSN =
  "postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight";

/**
 * The env keys the recall-pool overrides use that switchroom does NOT emit on
 * the single-container path. Re-exported from the allowlist owner
 * (hindsight-perf-defaults.ts), where they are added to
 * {@link HINDSIGHT_PERF_ENV_KEYS} so the same keys are also reachable
 * declaratively through `hindsight.env` and so `switchroom doctor`'s
 * unmanaged-key check does not flag them as drift on a split deployment. The
 * constant lives there, not here, to avoid an import cycle.
 */
export { HINDSIGHT_RECALL_POOL_ENV_KEYS } from "./hindsight-perf-defaults.js";

/**
 * The background/authority container's API port when the split is on: the
 * public port + 1. Derived (not hard-coded 18889) so a non-default public port
 * still gets a deterministic, collision-free background port. The public port
 * itself is unchanged and is what the pool binds.
 */
export function hindsightBackgroundApiPort(publicApiPort: number): number {
  return publicApiPort + 1;
}

/**
 * Resolve the PUBLIC api port agents hit (memory.config.url) for a launch,
 * INDEPENDENT of whether the recall split is on. This is the load-bearing
 * invariant behind the split: toggling `hindsight.recall_pool.enabled` must
 * never move the public port. Precedence:
 *
 *   1. `configUrlPort` — the port already in `memory.config.url`.
 *      Authoritative: it honors an operator pin AND equals the port the
 *      launcher itself persisted after the previous launch. A split-ON launch
 *      persists the POOL's public port, so a later split→single `--recreate`
 *      reads that same public port back here instead of inheriting the
 *      authority container's `public+1` (the +1 creep this fixes: without the
 *      config anchor, `getRunningHindsightPorts()` reports the parked authority
 *      at `public+1` and the sole container would bind — and then persist —
 *      that, climbing one port per off→recreate).
 *   2. `reuseApiPort` — the port a container currently publishes, on
 *      `--recreate` with no persisted url. Preserves "don't auto-migrate a live
 *      port mid-recreate". Only reachable before any launch has persisted a url
 *      (i.e. before any pool has ever run), so it is always a genuine
 *      single-container public port, never a parked `public+1`.
 *   3. `defaultApiPort` — fresh host, nothing running or persisted.
 *
 * `basePorts.apiPort` is what the AUTHORITY (split on) or SOLE (split off)
 * container binds: the public port directly when off, `public+1` when on (the
 * pool then takes the public port). `uiPort` is passed through unchanged — it
 * has no split semantics.
 */
export function resolveHindsightLaunchPorts(input: {
  recallEnabled: boolean;
  configUrlPort: number | undefined;
  reuseApiPort: number | undefined;
  uiPort: number;
  defaultApiPort: number;
}): { publicApiPort: number; basePorts: { apiPort: number; uiPort: number } } {
  const publicApiPort =
    input.configUrlPort ?? input.reuseApiPort ?? input.defaultApiPort;
  const apiPort = input.recallEnabled
    ? hindsightBackgroundApiPort(publicApiPort)
    : publicApiPort;
  return { publicApiPort, basePorts: { apiPort, uiPort: input.uiPort } };
}

/** Resolved recall-pool settings, or `null` when the feature is off. */
export interface RecallPoolConfig {
  /** Number of uvicorn workers the pool runs (`--workers`). */
  workers: number;
  /** Per-worker write pool cap (`HINDSIGHT_API_DB_POOL_MAX_SIZE`). */
  dbPoolMaxSize: number;
  /** Per-worker read pool cap (`HINDSIGHT_API_READ_DB_POOL_MAX_SIZE`). */
  readDbPoolMaxSize: number;
}

/** The `hindsight.recall_pool` config shape (see the zod schema). */
export interface RecallPoolConfigInput {
  enabled?: boolean;
  workers?: number;
  db_pool_max_size?: number;
  read_db_pool_max_size?: number;
}

/**
 * Size the pool's per-worker write/read DB pools so `workers*(write+read)`
 * fits within {@link HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET}.
 *
 * Deterministic: split the per-worker budget 40% write / 60% read (recall is
 * read-heavy; the write pool only carries the recall-path's own bookkeeping).
 * The floor + 40/60 split reproduces the values validated live on the fleet,
 * and lands the total exactly on the 240 ceiling — the 10-slot headroom (which
 * subsumes PG's superuser reserve) stays free, so this fits the ENFORCED
 * ceiling, not merely the raw 250 `max_connections`:
 *   - 4 workers → 45/worker → write 18, read 27  (180 pool + 60 bg = 240 ≤ 240)
 *   - 6 workers → 30/worker → write 12, read 18  (180 pool + 60 bg = 240 ≤ 240)
 *
 * Never returns a pool smaller than 1 connection each, so a pathologically
 * high worker count fails the budget assertion loudly rather than emitting a
 * zero-sized pool the engine would reject.
 */
export function recallPoolDbPoolSizing(workers: number): {
  dbPoolMaxSize: number;
  readDbPoolMaxSize: number;
} {
  const perWorker = Math.floor(HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET / workers);
  const dbPoolMaxSize = Math.max(1, Math.floor(perWorker * 0.4));
  const readDbPoolMaxSize = Math.max(1, perWorker - dbPoolMaxSize);
  return { dbPoolMaxSize, readDbPoolMaxSize };
}

/**
 * Assert the total connection demand of the split (background + pool) fits
 * under the ENFORCED ceiling {@link HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS}
 * (`max_connections - headroom = 240`), NOT the raw `max_connections` (250).
 * Asserting against 240 is the load-bearing difference: a legal-LOOKING
 * operator override — e.g. 4 workers × (25 write + 22 read) = 188 pool + 60
 * background = 248 ≤ 250 — would pass a raw-250 check yet leave only 2 slots
 * for PG's superuser reserve (3) and maintenance, so the very `FATAL: sorry,
 * too many clients already` this guard exists to prevent still fires under
 * load. Throws (fail-closed) so the override is caught before launch. Overrides
 * do NOT bypass the headroom.
 */
export function assertRecallPoolConnectionBudget(cfg: RecallPoolConfig): void {
  const poolDemand = cfg.workers * (cfg.dbPoolMaxSize + cfg.readDbPoolMaxSize);
  const total = poolDemand + HINDSIGHT_BACKGROUND_CONNECTION_BUDGET;
  if (total > HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS) {
    throw new Error(
      `hindsight.recall_pool connection budget overflow: ${cfg.workers} workers × ` +
        `(${cfg.dbPoolMaxSize} write + ${cfg.readDbPoolMaxSize} read) = ${poolDemand}, ` +
        `plus ${HINDSIGHT_BACKGROUND_CONNECTION_BUDGET} background = ${total} > the ` +
        `${HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS}-connection ceiling ` +
        `(pg0 max_connections=${HINDSIGHT_PG_MAX_CONNECTIONS} − ` +
        `${HINDSIGHT_RECALL_POOL_HEADROOM} headroom, which reserves PG's ` +
        `${HINDSIGHT_PG_SUPERUSER_RESERVED_CONNECTIONS} superuser slots plus ` +
        `maintenance). Lower hindsight.recall_pool.workers or its ` +
        `db_pool_max_size/read_db_pool_max_size.`,
    );
  }
}

/**
 * Resolve `hindsight.recall_pool` into concrete settings, or `null` when the
 * split is off (the default). Auto-sizes the per-worker DB pools from the
 * worker count unless the operator pins them explicitly, then asserts the
 * connection budget either way.
 */
export function resolveRecallPoolConfig(
  input: RecallPoolConfigInput | undefined,
): RecallPoolConfig | null {
  if (!input || input.enabled !== true) return null;
  const workers =
    input.workers && input.workers > 0 ? Math.floor(input.workers) : HINDSIGHT_RECALL_POOL_DEFAULT_WORKERS;
  const autoSized = recallPoolDbPoolSizing(workers);
  const cfg: RecallPoolConfig = {
    workers,
    dbPoolMaxSize:
      input.db_pool_max_size && input.db_pool_max_size > 0
        ? Math.floor(input.db_pool_max_size)
        : autoSized.dbPoolMaxSize,
    readDbPoolMaxSize:
      input.read_db_pool_max_size && input.read_db_pool_max_size > 0
        ? Math.floor(input.read_db_pool_max_size)
        : autoSized.readDbPoolMaxSize,
  };
  assertRecallPoolConnectionBudget(cfg);
  return cfg;
}

/** True when the split is configured on. Thin wrapper for call-site clarity. */
export function recallPoolEnabled(input: RecallPoolConfigInput | undefined): boolean {
  return resolveRecallPoolConfig(input) !== null;
}

/**
 * The DB pool caps the AUTHORITY (background) container takes when the split is
 * on — write 40 / read 20. Emitted as `hindsight.env`-shaped overrides so they
 * ride the existing operator-override path in `startHindsight`
 * (`resolveHindsightPerfOverrides`), which is why the two keys are added to
 * {@link HINDSIGHT_PERF_ENV_KEYS}. On the single-container path these are NOT
 * emitted, so nothing changes when the split is off.
 */
export function backgroundContainerPoolEnv(): Record<string, string> {
  return {
    HINDSIGHT_API_DB_POOL_MAX_SIZE: String(HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE),
    HINDSIGHT_API_READ_DB_POOL_MAX_SIZE: String(HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE),
  };
}

/**
 * The env overrides that turn a BASE hindsight container env into the recall
 * pool's env: external DB, background poller off, N workers, no migrations, no
 * control-plane, the pool's worker id + port, and the sized-down DB pools.
 *
 * Returned as an ordered list so {@link applyRecallPoolEnvOverrides} can layer
 * it over the base env deterministically.
 */
export function recallPoolEnvOverrides(
  cfg: RecallPoolConfig,
  poolPort: number,
): Array<[string, string]> {
  return [
    // Bind the PUBLIC port with a loopback host (host-network containment,
    // exactly like the base container's HINDSIGHT_API_HOST pin).
    ["HINDSIGHT_API_HOST", HINDSIGHT_HOST_NETWORK_BIND_ADDR],
    ["HINDSIGHT_API_PORT", String(poolPort)],
    // Connect to the authority container's pg0 over loopback; the external URL
    // is ALSO what makes the app skip starting its own embedded pg0.
    ["HINDSIGHT_API_DATABASE_URL", HINDSIGHT_RECALL_POOL_PG_DSN],
    ["HINDSIGHT_API_DB_URL", HINDSIGHT_RECALL_POOL_PG_DSN],
    // N uvicorn workers; recall/reflect only, background poller OFF so there is
    // no double-claim race against the authority container's single poller.
    ["HINDSIGHT_API_WORKERS", String(cfg.workers)],
    ["HINDSIGHT_API_WORKER_ENABLED", "false"],
    // The authority container owns migrations + the control plane; the pool
    // must not run either (a second migrator racing the authority is unsafe).
    ["HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP", "false"],
    ["HINDSIGHT_ENABLE_CP", "false"],
    // Distinct worker identity so `docker inspect` / metrics tell the two
    // containers apart, and so any worker-id-keyed accounting stays separate.
    ["HINDSIGHT_API_WORKER_ID", HINDSIGHT_RECALL_POOL_WORKER_ID],
    // Per-worker DB pools, sized so N*(write+read)+background < max_connections.
    ["HINDSIGHT_API_DB_POOL_MAX_SIZE", String(cfg.dbPoolMaxSize)],
    ["HINDSIGHT_API_READ_DB_POOL_MAX_SIZE", String(cfg.readDbPoolMaxSize)],
  ];
}

/**
 * Layer the recall-pool overrides over a base env, replacing a key IN PLACE
 * when it already exists (so no duplicate `-e KEY=` reaches docker) and
 * appending genuinely-new keys in override order. Docker takes last-wins for a
 * duplicate, but the drift/inspect tooling expects one entry per key, so we
 * keep it single.
 */
export function applyRecallPoolEnvOverrides(
  base: Array<[string, string]>,
  overrides: Array<[string, string]>,
): Array<[string, string]> {
  const overrideMap = new Map(overrides);
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const [k, v] of base) {
    if (overrideMap.has(k)) {
      out.push([k, overrideMap.get(k)!]);
      seen.add(k);
    } else {
      out.push([k, v]);
    }
  }
  for (const [k, v] of overrides) {
    if (!seen.has(k)) out.push([k, v]);
  }
  return out;
}

/**
 * THE complete env the recall-pool container launches with. Reuses
 * {@link hindsightContainerEnvPairs} for the base (same LLM / LiteLLM / perf /
 * host-network / control-plane derivation as the authority container) so the
 * two containers can never drift on those, then layers the pool overrides.
 */
export function hindsightRecallPoolEnvPairs(opts: {
  cfg: RecallPoolConfig;
  poolPort: number;
  litellm?: LiteLLMHindsightConfig;
  llm?: HindsightLlmConfig;
  gpu?: boolean;
  perf?: HindsightPerfOptions;
  cpAccessKey?: string;
}): Array<[string, string]> {
  const { cfg, poolPort, litellm, llm, gpu, perf, cpAccessKey } = opts;
  const base = hindsightContainerEnvPairs({
    apiPort: poolPort,
    litellm,
    llm,
    gpu,
    perf,
    cpAccessKey,
  });
  return applyRecallPoolEnvOverrides(base, recallPoolEnvOverrides(cfg, poolPort));
}

/**
 * Launch (or relaunch) the recall-pool sibling container on `poolPort`.
 *
 * Structural docker flags mirror the authority container EXCEPT: no pg0 data
 * volume and no backups volume (the pool owns no state — it reads the authority
 * container's pg0), and it ALWAYS runs `--network host` (it must reach pg0 on
 * loopback `127.0.0.1:5432`, independent of whether LiteLLM routing is on).
 *
 * The caller is responsible for ordering: the authority container's pg0 must be
 * healthy before this runs, or the pool crash-loops on connection-refused. See
 * {@link waitForHindsightHealthy} and the launcher in src/cli/memory.ts.
 */
export function startHindsightRecallPool(opts: {
  cfg: RecallPoolConfig;
  poolPort: number;
  imageTag?: string;
  litellm?: LiteLLMHindsightConfig;
  llm?: HindsightLlmConfig;
  gpu?: boolean;
  perf?: HindsightPerfOptions;
  cpAccessKey?: string;
  exec?: (cmd: string, args: string[]) => void;
}): void {
  const {
    cfg,
    poolPort,
    imageTag,
    litellm,
    llm,
    gpu,
    perf,
    cpAccessKey,
    exec = (cmd, args) => {
      execFileSync(cmd, args, { stdio: "pipe" });
    },
  } = opts;

  // Re-prove the budget at the launch site too — a caller that hand-built a
  // RecallPoolConfig (not via resolveRecallPoolConfig) still cannot overflow.
  assertRecallPoolConnectionBudget(cfg);

  const envArgs = hindsightRecallPoolEnvPairs({
    cfg,
    poolPort,
    litellm,
    llm,
    gpu,
    perf,
    cpAccessKey,
  }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  // Health probe hits the POOL's own port; pair with the LiteLLM TCP probe when
  // routing is configured, identical to the authority container's healthcheck.
  const probe = pickHindsightLiteLlmProbeUrl(llm, litellm);
  const healthCmd = probe
    ? buildLiteLlmAwareHealthCmd(poolPort, probe)
    // The shared HINDSIGHT_HEALTHCHECK_CMD is pinned to the image's 8888; under
    // --network host the pool binds poolPort, so retarget the probe port.
    : HINDSIGHT_HEALTHCHECK_CMD.replace("localhost:8888", `localhost:${poolPort}`);

  const args = [
    "run", "-d",
    "--name", HINDSIGHT_RECALL_POOL_CONTAINER,
    "--restart", "always",
    "--shm-size", HINDSIGHT_DEFAULT_SHM_SIZE,
    ...(hindsightGpuEnabled(gpu) ? ["--gpus", "all"] : []),
    // The pool MUST share the host network stack: pg0 is on host loopback
    // 127.0.0.1:5432 and LiteLLM (when on) is on 127.0.0.1:4010.
    "--network", "host",
    "--user", "hindsight",
    "--health-cmd", healthCmd,
    "--health-interval", "30s",
    "--health-timeout", "5s",
    "--health-retries", "3",
    "--health-start-period", "60s",
    // Creds dir: private tmpfs, owned by the image's UID 11000 (same as the
    // authority container's tmpfs branch). No pg0 / backups volume — stateless.
    "--tmpfs", `${HINDSIGHT_CRED_DIR}:rw,mode=0700,uid=${HINDSIGHT_DEFAULT_UID},gid=${HINDSIGHT_DEFAULT_UID}`,
    "-v", `${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`,
    ...envArgs,
    hindsightImageRef(imageTag),
  ];

  exec("docker", args);
}

/**
 * Stop and remove the recall-pool sibling container. Called before recreating
 * the authority container (so the pool releases its pg0 connections during the
 * pg0 blip) and on teardown. Idempotent + best-effort per step, like
 * {@link stopHindsight}.
 */
export function stopHindsightRecallPool(
  exec: (cmd: string, args: string[]) => void = (cmd, args) => {
    execFileSync(cmd, args, { stdio: "pipe" });
  },
): void {
  try { exec("docker", ["update", "--restart=no", HINDSIGHT_RECALL_POOL_CONTAINER]); } catch { /* gone */ }
  try { exec("docker", ["stop", HINDSIGHT_RECALL_POOL_CONTAINER]); } catch { /* gone */ }
  try { exec("docker", ["rm", "-f", HINDSIGHT_RECALL_POOL_CONTAINER]); } catch { /* gone */ }
}

/**
 * Whether the recall-pool sibling container is currently running. Exact-name
 * match (the shared `switchroom-hindsight` prefix would otherwise substring-hit
 * the authority container). Lets first-run provisioning tell "authority up,
 * pool dead" from "both up" so it can restore just the missing half.
 */
export function isHindsightRecallPoolRunning(
  probe: DockerProbe = defaultDockerProbe,
): boolean {
  return dockerNameMatchesExactly(
    probe,
    ["ps", "--filter", `name=${HINDSIGHT_RECALL_POOL_CONTAINER}`, "--format", "{{.Names}}"],
    HINDSIGHT_RECALL_POOL_CONTAINER,
  );
}

/**
 * Poll `http://127.0.0.1:<port>/health` until it returns 200 or the deadline
 * passes. Returns true on healthy, false on timeout. Injectable `fetchImpl` +
 * `sleep` keep it deterministic under test.
 *
 * Used to gate the two-container launch ordering: the authority container's
 * pg0 must answer /health before the pool starts (else the pool crash-loops on
 * connection-refused), and the pool must bind its port before
 * `memory.config.url` is declared live. Mirrors the health gate the
 * hand-applied `hindsight-recallsplit-swap.sh` used between steps.
 */
export async function waitForHindsightHealthy(
  port: number,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const {
    timeoutMs = 150_000,
    intervalMs = 3_000,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (res.ok) return true;
    } catch {
      // connection refused / timeout while the server boots — keep polling.
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
