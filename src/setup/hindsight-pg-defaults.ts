/**
 * Embedded-PostgreSQL (pg0) sizing and durability defaults for the hindsight
 * container.
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
 * Note the `-F` in that argv — pg0 runs PostgreSQL with **fsync disabled**.
 * That is a durability defect rather than a tuning choice, and it is fixed
 * through the same mechanism; see {@link HINDSIGHT_PG_DEFAULT_FSYNC}. `-F` is
 * positional and always precedes the merged `-c` block, and postgres applies
 * command-line options in order, so a later `-c fsync=on` wins — verified on a
 * throwaway pg0 instance from the same image (2026-07-29):
 * `pg_settings` reported `fsync | on | command line`.
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
export const HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION = 16 * 1024;

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
 * 16384 − 2560 − 2048 = 11776 MiB.
 *
 * This is a CEILING, not a target. It is what the arithmetic permits; what
 * {@link HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB} actually takes is bounded
 * far below it by the worst-case per-backend memory model, not by this number.
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
 * 1536MB was 6x that, and 19% of the container's original 8 GiB ceiling.
 *
 * 1536→3072 (2026-07-29), moved in the SAME commit that raised
 * `HINDSIGHT_DEFAULT_MEM_LIMIT` 8g→16g, because these two are one decision:
 * a bigger cap that leaves the buffer pool where it was just buys more page
 * cache for data Postgres should have been holding itself. 3072 MiB is 19% of
 * the new 16 GiB ceiling — the same fraction, deliberately, so the sizing
 * stays inside the conventional "25% of available memory" guidance and well
 * inside {@link HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB} (11776 MiB), which a
 * test pins.
 *
 * **Why 3072 and not 4096** (the reading that held 2026-07-29): the budget
 * arithmetic only accounts for the buffer pool itself. The per-backend side is
 * not in it — `work_mem` is applied live per role, `hash_mem_multiplier=2`
 * doubles it for hash nodes, and a parallel plan multiplies that again across
 * workers. Stacking a large pinned pool on top of that worst case was judged
 * not to fit under a 16 GiB cap alongside the ~2.5 GiB app anon set and the
 * page-cache floor.
 *
 * **3072→6144 (2026-07-31).** Promoted to the durable default alongside a
 * round of DB housekeeping on the hot tables (a full `VACUUM` plus
 * autovacuum-threshold tuning), applied and verified live on
 * `switchroom-hindsight` before being baked here. The housekeeping is what
 * makes the larger pool safe against the per-backend caution above: reclaiming
 * dead tuples shrinks the hot working set and the per-backend spill pressure
 * that the 4096 argument was sized against, so a 6144 MiB pool no longer stacks
 * against the same worst case. 6144 is 38% of the 16 GiB cap and stays well
 * inside {@link HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB} (11776 MiB), which a
 * test still pins — the arithmetic ceiling is unchanged, only the target moved.
 * These relief values land on the live fleet only after this change ships and
 * the operator runs a host `switchroom apply`; a live container recreate ahead
 * of that would just reintroduce config-vs-runtime drift, so it is deferred.
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
export const HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB = 6144;

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
 * pool. 4096 MiB was the conservative reading of that under the 8 GiB cap.
 *
 * 4096→7168 (2026-07-29), moved with the cap and the buffer pool. 7168→12288
 * (2026-07-31), moved again with the buffer-pool bump above and verified live
 * with it. Sized to what the container can actually hold AFTER these changes,
 * not to the size of the database: `shared_buffers` (6144) plus a page-cache
 * assumption of ~6144, against a 16 GiB ceiling that still has to carry the
 * ~2.5 GiB app anon set. It allocates nothing (a pure planner hint), so a test
 * pins only that it never exceeds the container's own memory ceiling.
 * The temptation is to declare something near the 12 GB bank size so the
 * planner "knows" the data is cacheable — don't. `effective_cache_size` is
 * the term that prices index scans against sequential ones, so over-declaring
 * it does not make the container hold more, it flips plan shapes on the
 * strength of cache that does not exist under pressure.
 *
 * Honest scope: see the module header. On the link-expansion query this moved
 * total cost ~12% at 300 seeds and changed no plan shape. It is the cheap,
 * zero-memory half of the change, not the whole fix.
 */
export const HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB = 12288;

/** Format a MiB integer the way Postgres wants it on the command line. */
export function pgMib(mib: number): string {
  return `${mib}MB`;
}

/**
 * `shared_buffers` pg0 itself starts with when switchroom's `-c` flag is
 * omitted — the sentinel `off` case. Read off the live argv quoted in the
 * module header (`-c shared_buffers=256MB`).
 */
export const HINDSIGHT_PG0_FALLBACK_SHARED_BUFFERS_MIB = 256;

/**
 * Parse a **docker** size string (`16g`, `512m`, `2G`, `1024`, `2gb`) to MiB.
 *
 * Docker's own parser is base-1024 and treats a bare number as BYTES; a bare
 * number is almost always an operator mistake at this scale, so it is parsed
 * faithfully rather than being second-guessed. Returns `null` for anything
 * unparseable so callers can degrade instead of asserting a wrong number.
 */
export function parseDockerSizeToMib(size: string): number | null {
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*([bkmgt])?b?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "b").toLowerCase()) {
    case "b":
      return n / (1024 * 1024);
    case "k":
      return n / 1024;
    case "m":
      return n;
    case "g":
      return n * 1024;
    case "t":
      return n * 1024 * 1024;
    default:
      return null;
  }
}

/**
 * Parse a **PostgreSQL** memory-parameter value (`6144MB`, `4GB`, `256MB`,
 * `off`, or a bare block count) to MiB.
 *
 * Two shapes that are NOT docker's:
 *  - a bare integer is a count of 8 kB blocks (postgres' `BLCKSZ`), not bytes;
 *  - the sentinel `off` means switchroom omits the `-c` flag entirely, so the
 *    effective value is pg0's own {@link HINDSIGHT_PG0_FALLBACK_SHARED_BUFFERS_MIB}.
 *
 * Returns `null` when the string is not a size switchroom can reason about.
 */
export function parsePgSizeToMib(value: string): number | null {
  const raw = value.trim();
  if (raw.toLowerCase() === "off") return HINDSIGHT_PG0_FALLBACK_SHARED_BUFFERS_MIB;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(kB|MB|GB|TB)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "").toUpperCase()) {
    case "":
      // Bare number = 8 kB blocks.
      return (n * 8) / 1024;
    case "KB":
      return n / 1024;
    case "MB":
      return n;
    case "GB":
      return n * 1024;
    case "TB":
      return n * 1024 * 1024;
    default:
      return null;
  }
}

/**
 * Non-`shared_buffers` memory the container must still be left, in MiB.
 *
 * Not a new number: it is exactly the two reservations the budget derivation
 * above already subtracts out of the ceiling — the app's anonymous working set
 * and the page-cache floor. Stating it as its own constant lets the runtime
 * check use the SAME arithmetic the compile-time budget uses, so the two can
 * never disagree about what "comfortably larger" means.
 */
export const HINDSIGHT_PG_MIN_NON_BUFFER_MIB =
  HINDSIGHT_PG_APP_ANON_MIB + HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB;

/** Render a MiB figure the way an operator reads a docker cap. */
function mib(n: number): string {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024} GiB` : `${Math.round(n)} MiB`;
}

/**
 * Is this container cap comfortably larger than the `shared_buffers` it is
 * configured to pin? Returns a ready-to-print warning, or `null` when safe.
 *
 * ## Why this check exists
 *
 * {@link HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB} is a COMPILE-TIME budget: it
 * is derived from a literal 16 GiB ceiling and pinned by a test. That protects
 * the pair of numbers checked into this repo, and nothing else. Once the cap
 * and `shared_buffers` are both operator-configurable they can be moved
 * independently, at different times, by different mechanisms — and the
 * observed failure is exactly that: an operator raised the live container to
 * 24 GiB to fit a 12 GiB `shared_buffers`, and the next
 * `switchroom memory setup --recreate` put the cap back to the hard-coded
 * 16 GiB default while leaving the 12 GiB buffer pool configured inside the
 * container. Postgres came back up pinning 75% of its cgroup as unreclaimable
 * shared memory, with no warning anywhere.
 *
 * **Warn, do not fail.** Two reasons, and they point the same way:
 *  1. The dangerous state is reached by a DEFAULT re-asserting itself, not by
 *     a bad operator edit. Hard-failing there turns "the memory container is
 *     badly sized" into "the fleet has no memory container at all", which is
 *     strictly worse for every agent on the host.
 *  2. The headroom figure is a heuristic (a measured anon working set plus a
 *     page-cache floor), not a hard kernel limit. A heuristic should not be
 *     able to brick `switchroom setup` on a host whose workload the heuristic
 *     was not measured against.
 *
 * The warning names both numbers and the key to change, which is the whole
 * point: the previous behaviour named neither.
 */
export function hindsightMemBudgetWarning(input: {
  /** Resolved docker memory cap, as it will be handed to docker (`16g`). */
  memLimit: string;
  /** Resolved `shared_buffers`, as it will be handed to pg0 (`12288MB`). */
  sharedBuffers: string;
}): string | null {
  const capMib = parseDockerSizeToMib(input.memLimit);
  const bufMib = parsePgSizeToMib(input.sharedBuffers);
  // Unparseable on either side: say nothing rather than assert a wrong number.
  // The schema regex is what rejects a malformed `hindsight.mem_limit`.
  if (capMib === null || bufMib === null) return null;
  const headroom = capMib - bufMib;
  if (headroom >= HINDSIGHT_PG_MIN_NON_BUFFER_MIB) return null;
  return (
    `hindsight: container memory cap ${input.memLimit} (${mib(capMib)}) leaves only ` +
    `${mib(Math.max(headroom, 0))} above shared_buffers ${input.sharedBuffers} ` +
    `(${mib(bufMib)}) — Postgres pins that buffer pool as unreclaimable shared ` +
    `memory, so the container needs at least ${mib(HINDSIGHT_PG_MIN_NON_BUFFER_MIB)} ` +
    `beyond it (${mib(HINDSIGHT_PG_APP_ANON_MIB)} app working set + ` +
    `${mib(HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB)} page-cache floor). Raise ` +
    `\`hindsight.mem_limit\` to at least ` +
    `${mib(Math.ceil((bufMib + HINDSIGHT_PG_MIN_NON_BUFFER_MIB) / 1024) * 1024)}, or lower ` +
    "`hindsight.env.SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS`."
  );
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
 * Env var carrying `fsync`. Only the literal `on` (any case) applies the flag;
 * anything else — including `off` — leaves pg0's `-F` standing.
 */
export const HINDSIGHT_PG_FSYNC_ENV = "SWITCHROOM_HINDSIGHT_PG_FSYNC";

/**
 * `fsync` — pg0's default is **off**, via the positional `-F` it bakes into
 * the `postgres` argv.
 *
 * ## Why this is not a tuning knob
 *
 * The other two values in this module are performance trade-offs. This one is
 * a correctness property that pg0's default silently gives away.
 *
 * With `fsync=off` PostgreSQL never forces WAL or data pages to stable
 * storage, so an unclean stop can leave a page that was never actually
 * written while the WAL believes it was. `data_checksums` does not catch
 * that: the stale page checksums *correctly*. It is a lost write, not a
 * corrupt one. Recovery completes, the server reports healthy, and the damage
 * is silent.
 *
 * ## The observed failure
 *
 * The live `switchroom-hindsight` container logs 6–20 "database system was not
 * properly shut down; automatic recovery in progress" events per day
 * (`postgresql-2026-07-2[6789].log`: 8 / 20 / 6 / 6). On 2026-07-29 one of
 * them — `04:14:29 performing immediate shutdown because data directory lock
 * file is invalid` — preceded, by ~13 minutes, silent corruption of an HNSW
 * vector index on `memory_units` in the `overlord` bank. Consolidation for
 * that bank wedged for ~2.5 hours behind ~38,000 queued memories, and
 * `data_checksums` (which is on) reported nothing — exactly as the mechanism
 * above predicts. `REINDEX INDEX CONCURRENTLY` repaired it.
 *
 * **This addresses the loss, not the restarts.** What is stopping PostgreSQL
 * that often is a separate question, tracked separately; `fsync=on` only makes
 * those stops survivable.
 *
 * ## Cost
 *
 * Measured on a throwaway pg0 instance from the same image against a
 * `memory_units`-shaped table (220k rows, 384-dim vectors, 88 partial HNSW
 * indexes) under a retain+consolidate pgbench workload: 30–55% fewer
 * transactions per second depending on concurrency. Real, and paid against a
 * workload whose measured demand is single-digit writes per second, which the
 * fsync=on arm clears by more than an order of magnitude.
 */
export const HINDSIGHT_PG_DEFAULT_FSYNC = "on";

/**
 * The pg0 pre-start defaults, in the order the entrypoint receives them.
 *
 * Deliberately NOT capability-gated. Unlike the GPU / local-LLM knobs in
 * hindsight-perf-defaults.ts, the two sizing values are derived from
 * `HINDSIGHT_DEFAULT_MEM_LIMIT` — a value switchroom itself sets on every
 * host — so the "capability" is already proven by construction, and `fsync`
 * has no capability to gate on at all. The runtime safety property is the
 * entrypoint's fallback instead: a pre-start that cannot apply the values
 * leaves the container running pg0's own defaults.
 *
 * `fsync` also carries a hard-coded `on` default *inside the entrypoint*, so
 * durability does not depend on this array having been emitted by a new-enough
 * switchroom. The entry here exists so an operator has a documented,
 * overridable key, and so the compose file states the property explicitly.
 */
export const HINDSIGHT_PG_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [
    HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV,
    pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
  ],
  [HINDSIGHT_PG_SHARED_BUFFERS_ENV, pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB)],
  [HINDSIGHT_PG_FSYNC_ENV, HINDSIGHT_PG_DEFAULT_FSYNC],
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
