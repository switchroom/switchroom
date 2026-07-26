/**
 * Embedded-PostgreSQL (pg0) sizing defaults for the hindsight container.
 *
 * ## Why this file exists
 *
 * #3700 shipped the container-env half of the hindsight performance work.
 * This is the other half: the PostgreSQL server parameters, which #3700
 * deliberately left alone because they are a **different mechanism**.
 *
 * Hindsight's DB is embedded pg0. pg0 launches `postgres` with its own tuning
 * baked into the child's **argv**, verified live inside `switchroom-hindsight`
 * (2026-07-26):
 *
 * ```
 * /home/hindsight/.pg0/installation/18.1.0/bin/postgres
 *   -D /home/hindsight/.pg0/instances/hindsight/data -F -p 5432
 *   -c work_mem=64MB -c maintenance_work_mem=512MB
 *   -c effective_cache_size=1GB -c shared_buffers=256MB
 *   -c max_parallel_maintenance_workers=4  … (logging flags)
 * ```
 *
 * Postgres ranks `command line` **above** both `postgresql.conf` and
 * `postgresql.auto.conf`, so `ALTER SYSTEM SET` cannot move these. Verified,
 * not assumed — `ALTER SYSTEM SET effective_cache_size='6GB'` +
 * `pg_reload_conf()` on the live instance left `pg_settings` reporting
 * `setting=131072` (1GB) with `source='command line'`.
 *
 * The one route that works: `EmbeddedPostgres.ensure_running()`
 * (`/app/api/hindsight_api/pg0.py`) short-circuits when the named instance is
 * already running — it returns the existing URI without touching the config.
 * So `docker/hindsight-entrypoint.sh` **pre-starts pg0 with tuned `-c` flags**
 * before `exec`ing the upstream CMD, and hindsight_api adopts the running,
 * tuned instance. This module is the single, testable source of the values
 * that entrypoint receives.
 *
 * Verified live that pg0 **merges** operator `-c` flags over its own defaults
 * rather than replacing them: a probe instance started with
 * `-c effective_cache_size=4GB -c shared_buffers=1536MB` came up with those
 * two values AND pg0's untouched `work_mem=64MB`,
 * `maintenance_work_mem=512MB`, `max_parallel_maintenance_workers=4` and the
 * logging flags still present in argv.
 *
 * ## Two rules, inherited from hindsight-perf-defaults.ts
 *
 * 1. **Safe fallback.** The entrypoint's pre-start is best-effort. If pg0 is
 *    missing, the DB URL is not the default embedded one, or `pg0 start`
 *    fails for any reason, the entrypoint logs and continues — hindsight_api
 *    then starts pg0 itself exactly as it does today. A tuning change can
 *    therefore never be the reason the container fails to boot.
 * 2. **An operator override always wins**, scoped to
 *    {@link HINDSIGHT_PG_ENV_KEYS}, resolved with the same precedence as the
 *    perf defaults (`hindsight.env` over switchroom's own process env).
 *
 * ## What was measured, and what was NOT
 *
 * Be precise, because the motivating issue (#3706) overstates one thing.
 *
 * `EXPLAIN` A/B of the real link-expansion query
 * (`ops_postgresql.build_entity_expansion_cte` + `build_semantic_causal_cte`,
 * 20/100/300 seeds, live `overlord` bank) at
 * `effective_cache_size` 1GB vs 4GB produced **no plan-shape change**: every
 * variant already used index / bitmap-index scans on `memory_links`, and
 * `pg_stat_user_tables` shows `memory_links` at 13 sequential scans against
 * 1,875,153 index scans. So the "the planner is choosing seq scans on
 * memory_links" framing did **not** reproduce. What the A/B did show is a
 * total-cost drop of ~12% at 300 seeds — the planner pricing random I/O more
 * accurately, not choosing a different plan.
 *
 * The measured pathology is the one #3700's own header already names: cold
 * buffer misses (graph/link_expansion p50 0.024s vs p90 1.412s — an I/O
 * distribution, not an algorithmic one). That is a `shared_buffers` problem,
 * which is why this module ships both knobs and does not pretend
 * `effective_cache_size` alone is the fix.
 */

/**
 * Container memory ceiling this module sizes against, in MiB.
 *
 * Imported as a literal rather than from `hindsight.ts` to keep this module
 * free of an import cycle (`hindsight.ts` imports THIS file). A test pins the
 * two equal so they cannot drift.
 *
 * @see import("./hindsight.js").HINDSIGHT_DEFAULT_MEM_LIMIT
 */
export const HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION = 8 * 1024;

/**
 * Non-reclaimable anonymous working set of everything ELSE in the container,
 * in MiB — the API process, the embedding model, the cross-encoder, and
 * next-server.
 *
 * Measured on the live container (2026-07-26): `memory.stat` reported
 * `anon 2350018560` = 2241 MiB, with `file 5465899008` (5212 MiB of
 * reclaimable page cache) bringing `memory.current` to the full 8 GiB
 * ceiling. Rounded UP to 2560 to leave slack for the anon side to grow.
 */
export const HINDSIGHT_PG_APP_ANON_MIB = 2560;

/**
 * Page cache the container must be left able to hold, in MiB.
 *
 * `shared_buffers` is not a substitute for the kernel page cache here: pg0
 * runs Postgres with `shared_memory_type=mmap`, so buffers come out of the
 * cgroup's anon/shmem accounting and directly displace reclaimable cache.
 * Reserving a floor keeps the sizing honest instead of letting
 * `shared_buffers` grow until the container thrashes.
 */
export const HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB = 2048;

/**
 * The largest `shared_buffers` this container may be given, in MiB.
 *
 * Derived, not picked: whatever is left of the memory ceiling once the app's
 * anonymous working set and the page-cache floor are accounted for.
 * 8192 − 2560 − 2048 = 3584 MiB.
 */
export const HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB =
  HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION -
  HINDSIGHT_PG_APP_ANON_MIB -
  HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB;

/**
 * `shared_buffers` (pg0 default `256MB`).
 *
 * 256MB against a 12 GB database is ~2% of the bank — every graph traversal
 * that misses is a kernel round-trip, which is exactly the bimodal
 * cold/hot distribution measured on `link_expansion` (p50 24ms, p90 1.412s).
 * 1536MB is 6x that, and 19% of the container's 8 GiB ceiling — under the
 * conventional "25% of available memory" guidance and comfortably inside
 * {@link HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB} (3584 MiB), which a test
 * pins.
 *
 * **This does NOT require an `shm_size` change**, contrary to the assumption
 * this work started from. That assumption is that `shared_buffers` is a POSIX
 * `/dev/shm` allocation; on this build it is not. Verified live:
 * `shared_memory_type = mmap` and `dynamic_shared_memory_type = posix`, and a
 * probe instance started with `shared_buffers=4GB` left `/dev/shm` at 16 MiB
 * of 2.0 GiB used. `/dev/shm` backs only the parallel-query DSM segments that
 * `HINDSIGHT_DEFAULT_SHM_SIZE` was raised for (observed peak ~533MB), so 2g
 * stays correct and is deliberately left alone.
 */
export const HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB = 1536;

/**
 * `effective_cache_size` (pg0 default `1GB`).
 *
 * A pure planner hint — it allocates nothing. It tells the planner how much of
 * the database it can expect to find in RAM, counting `shared_buffers` **plus**
 * the OS page cache, and it is the term that prices index scans against
 * sequential ones.
 *
 * 1GB is a ~5x under-declaration of what this container measurably holds: the
 * live cgroup was carrying 5212 MiB of page cache on top of the 256MB buffer
 * pool. 4096 MiB is the conservative reading of that — `shared_buffers`
 * (1536) plus a page-cache assumption (2560) well below the 5212 measured —
 * so the planner is told the truth without being told to expect cache the
 * container cannot hold under pressure.
 *
 * Honest scope: see the module header. On the link-expansion query this moved
 * total cost ~12% at 300 seeds and changed no plan shape. It is the cheap,
 * zero-memory half of the change, not the whole fix.
 */
export const HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB = 4096;

/** Format a MiB integer the way Postgres wants it on the command line. */
export function pgMib(mib: number): string {
  return `${mib}MB`;
}

/**
 * Env var carrying the `effective_cache_size` the entrypoint should pass to
 * `pg0 start`. Empty / unset ⇒ the entrypoint skips that flag.
 */
export const HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV =
  "SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE";

/** Env var carrying `shared_buffers`. Empty / unset ⇒ flag skipped. */
export const HINDSIGHT_PG_SHARED_BUFFERS_ENV = "SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS";

/**
 * The pg0 sizing defaults, in the order the entrypoint receives them.
 *
 * Deliberately NOT capability-gated. Unlike the GPU / local-LLM knobs in
 * hindsight-perf-defaults.ts, these two are sized against
 * `HINDSIGHT_DEFAULT_MEM_LIMIT` — a value switchroom itself sets on every
 * host — so the "capability" is already proven by construction. The runtime
 * safety property is the entrypoint's fallback instead: a pre-start that
 * cannot apply the values leaves the container running pg0's own defaults.
 */
export const HINDSIGHT_PG_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [
    HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV,
    pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
  ],
  [HINDSIGHT_PG_SHARED_BUFFERS_ENV, pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB)],
];

/**
 * Every key this module manages — and therefore the exact set an operator may
 * override through `hindsight.env` / switchroom's process environment.
 */
export const HINDSIGHT_PG_ENV_KEYS: ReadonlySet<string> = new Set(
  HINDSIGHT_PG_DEFAULTS.map(([k]) => k),
);

/**
 * Resolve the operator's overrides for the managed pg0 keys.
 *
 * Same precedence and same empty-value discipline as
 * {@link import("./hindsight-perf-defaults.js").resolveHindsightPerfOverrides}:
 * `hindsight.env` beats switchroom's process env, and a blank value is an
 * accident rather than an override so it is ignored.
 *
 * One deliberate difference: the sentinel `"off"` (case-insensitive) IS a
 * legal override and IS forwarded, because an operator needs a way to disable
 * a single knob without disabling the other. The entrypoint treats `off` as
 * "omit this `-c` flag", which restores pg0's own default for it.
 */
export function resolveHindsightPgOverrides(
  configEnv?: Record<string, string | number | boolean> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of HINDSIGHT_PG_ENV_KEYS) {
    const fromProcess = processEnv[key];
    if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
      out.set(key, fromProcess.trim());
    }
  }
  for (const [key, raw] of Object.entries(configEnv ?? {})) {
    if (!HINDSIGHT_PG_ENV_KEYS.has(key)) continue;
    const value = String(raw).trim();
    if (value === "") continue;
    out.set(key, value);
  }
  return out;
}

/**
 * The pg0 sizing env pairs to hand the hindsight container.
 *
 * Stable declaration order, every managed key emitted exactly once, override
 * REPLACES the default rather than being appended after it — so there is
 * never an `-e K=a -e K=b` pair whose winner depends on docker's argv
 * semantics. Shared verbatim by `startHindsight()` and
 * `generateHindsightComposeSnippet()` so the two launch paths cannot drift.
 */
export function hindsightPgEnv(
  overrides: ReadonlyMap<string, string> = new Map(),
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const emitted = new Set<string>();
  for (const [key, value] of HINDSIGHT_PG_DEFAULTS) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push([key, overrides.get(key) ?? value]);
  }
  return out;
}
