/**
 * Capability-gated Hindsight performance defaults.
 *
 * ## Why this file exists
 *
 * Upstream Hindsight publishes 100–600ms recall and 800–3000ms reflect. The
 * 2026-07-26 fleet measurement on this host class found **recall p90 5.83s**
 * and **reflect p90 122s** — 10–58x off. Several of upstream's own documented
 * knobs are left at defaults that are actively wrong for a single-host,
 * one-local-GPU, 12GB-bank deployment. This module makes the right values the
 * out-of-the-box defaults, so a fresh `switchroom memory setup` lands close to
 * upstream's published numbers without operator tuning.
 *
 * Measured evidence behind the specific values (2026-07-26, live fleet):
 *
 *   • `memory_links` 16,604,592 rows / 7,242 MB; `memory_units` 559,316 rows /
 *     3,443 MB; DB total 12 GB. Mean links-per-unit ≈ 29.7.
 *   • graph/link_expansion p50 0.024s vs p90 1.412s — a bimodal hot/cold page
 *     distribution, i.e. I/O bound rather than algorithmic. Upstream's
 *     documented target for this stage is <100ms.
 *   • rerank ≈ 3.98s of the 5.83s recall p90, on CPU.
 *   • 99.7% of recall load is background consolidation (8,800 of 8,830 calls
 *     in 24h) — so bounding background work protects interactive latency.
 *
 * ## Two rules this module exists to enforce
 *
 * 1. **Every default falls back safely.** A knob whose benefit depends on a
 *    host capability is emitted ONLY when the persisted capability verdict
 *    proves that capability. A box with no GPU, or one pointed at a hosted
 *    LLM, gets upstream's default — never a value tuned for hardware it does
 *    not have. The gating shape deliberately mirrors {@link
 *    import("./hindsight.js").hindsightGpuEnabled} (src/setup/hindsight.ts):
 *    one predicate, both launch paths, `=== true` comparisons, absent verdict
 *    ⇒ off. There is exactly one gating mechanism in this codebase.
 *
 * 2. **An operator override always wins.** If a key is set in
 *    `hindsight.env` in switchroom.yaml, or exported in switchroom's own
 *    environment, that value is emitted and our default is suppressed. This
 *    is scoped to {@link HINDSIGHT_PERF_ENV_KEYS} on purpose — a blanket
 *    `HINDSIGHT_API_*` passthrough would collide with the vars
 *    `startHindsight()` derives itself (`HINDSIGHT_API_PORT`, the retain
 *    budget), which is a worse failure than a missing override.
 *
 * ## Not shipped here, and why
 *
 * `HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER=0` was proposed for the
 * background worker. It is NOT emitted: upstream scopes it to "every pool
 * connection of **this process**" (configuration reference), and switchroom's
 * container runs a SINGLE process — `/app/start-all.sh` starts only
 * `hindsight-api`, and `HINDSIGHT_API_WORKER_ENABLED` defaults to `true`
 * ("Enable internal worker in API process"), so consolidation shares the API's
 * connection pool. Setting it to 0 here would serialise the latency-sensitive
 * recall path — including the exact `link_expansion` scan this PR is trying to
 * speed up — rather than only the background work. It needs a separate
 * worker process first; see the PR body.
 *
 * `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` is deliberately untouched (150).
 * The rejection rationale is recorded at
 * src/setup/hindsight-reranker-budget.test.ts:111-118.
 */

/**
 * Host capabilities that gate a performance default.
 *
 * Both fields are plain booleans resolved by the caller from the persisted
 * host-capabilities verdict / the effective LLM config — this module never
 * probes anything itself, so it stays pure and trivially testable.
 */
export interface HindsightPerfCapabilities {
  /**
   * The container can actually reach a GPU — i.e. `hindsightGpuEnabled()`.
   * Gates FP16 reranking (see {@link HINDSIGHT_PERF_DEFAULTS_GPU}).
   */
  gpu: boolean;
  /**
   * The LLM endpoint is on this host or this LAN, i.e. a finite fixed slot
   * pool rather than a cloud provider that absorbs dozens of parallel
   * requests. Gates the LLM concurrency caps
   * (see {@link HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM}).
   */
  localLlm: boolean;
}

/**
 * Reranker candidate budget this module derives its per-source cap from.
 *
 * Imported as a literal rather than from `hindsight.ts` to keep this module
 * free of a cycle (`hindsight.ts` imports THIS file). The two are pinned
 * equal by a test, so they cannot drift.
 */
export const HINDSIGHT_RERANKER_MAX_CANDIDATES_FOR_DERIVATION = 150;

/**
 * Retrieval sources whose candidates are fused by RRF before reranking:
 * semantic, BM25, graph, temporal (upstream configuration reference,
 * `HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE`).
 */
export const HINDSIGHT_RECALL_SOURCE_COUNT = 4;

/**
 * Per-source candidate cap (upstream default `0` = uncapped).
 *
 * Upstream states this knob's purpose verbatim: "Prevents one over-expanding
 * backend from filling the reranker budget on its own." That is precisely our
 * symptom — the graph source expands over 16.6M links and crowds the RRF pool,
 * and reranking is 3.98s of a 5.83s p90.
 *
 * Derived, not picked: 40% of the reranker budget. That satisfies BOTH halves
 * of the invariant the knob exists for —
 *
 *   • one source alone can no longer fill the reranker budget
 *     (`perSource < rerankerMax`), and
 *   • the four sources together can still fill it
 *     (`perSource * sources >= rerankerMax`), so the cap costs little recall
 *     quality when the pool is healthy.
 *
 * "Little", not "nothing", and the difference is worth being precise about.
 * The engine applies the cap per source, after each arm's own sort and BEFORE
 * fusion (memory_engine.py, `per_source_cap` / `cap_per_source` on the
 * semantic, bm25, graph and temporal lists). So the second half proves the
 * fused pool can still be FILLED to the reranker budget — not that the same
 * items reach it. An item ranked, say, #80 in both the semantic and the BM25
 * arm has strong RRF consensus today and would be dropped from both arms
 * before fusion under a 60 cap, so consensus-but-mid-ranked items are the
 * class this trades away. In practice that is small — final k is ~10, and the
 * items that survive fusion are overwhelmingly top-of-arm — but it is a real
 * trade, not a free one.
 *
 * Both halves are asserted in hindsight-perf-defaults.test.ts; raising the
 * reranker budget moves this automatically.
 *
 * NOTE the anchor: 150 is SWITCHROOM's reranker budget, not upstream's.
 * Upstream's `DEFAULT_RERANKER_MAX_CANDIDATES` is 300; the 150 here is a
 * prior switchroom tightening (src/setup/hindsight.ts). The 40% ratio is
 * therefore derived against a switchroom value and would want revisiting if
 * switchroom ever moves back toward upstream's 300 — at which point 40%
 * yields 120 per source, still satisfying both halves, but the absolute
 * per-arm truncation point moves with it.
 */
export const HINDSIGHT_DEFAULT_RECALL_MAX_CANDIDATES_PER_SOURCE = Math.ceil(
  HINDSIGHT_RERANKER_MAX_CANDIDATES_FOR_DERIVATION * 0.4,
);

/**
 * Per-entity graph fan-out cap (upstream default `200`).
 *
 * The LATERAL fan-out is unbounded in practice at 200 against 16.6M links:
 * the mean is 29.7 links per unit, so 200 only ever binds on hub entities —
 * exactly the entities that produce the cold-page p90 (0.024s p50 vs 1.412s
 * p90 is an I/O distribution, not an algorithmic one). 50 is ~1.7x the
 * measured mean: typical entities expand whole, hub entities stop at 4x less
 * work than before.
 */
export const HINDSIGHT_DEFAULT_LINK_EXPANSION_PER_ENTITY_LIMIT = 50;

/**
 * Per-entity graph expansion timeout in seconds (upstream default `10`).
 *
 * At 10s this is not a guard at all: the auto-recall client gives up on a bank
 * long before it fires (`vendor/hindsight-memory/scripts/recall.py` passes an
 * 8s per-bank socket timeout, itself inside a 10s shared fan-out deadline
 * inside a 12s hook ceiling — see hindsight-reranker-budget.test.ts). So a
 * graph stall today kills the WHOLE recall, losing the semantic and BM25
 * results that had already returned, and leaves no telemetry row.
 *
 * A bound BELOW the client's per-bank timeout gives the engine a chance to
 * shed the expensive part instead. Be precise about what it actually sheds —
 * read from the engine source, `engine/search/link_expansion_retrieval.py`:
 *
 *   • The timeout wraps ONE query: the entity-expansion CTE inside
 *     `_expand_combined` (`asyncio.wait_for(conn.fetch(full_query, ...),
 *     timeout=config.link_expansion_timeout)`). On fire it degrades WITHIN the
 *     graph source — it drops entity expansion and re-runs a semantic+causal
 *     query — it does NOT drop the graph source in favour of the other three.
 *   • That fallback `conn.fetch` carries NO timeout of its own. Neither does
 *     the seed lookup (`_find_semantic_seeds`) that runs before it. So this
 *     knob bounds one stage, not the graph source and certainly not recall.
 *   • The whole block runs once per fact_type — three by default
 *     (`world`, `experience`, `observation`), dispatched concurrently by
 *     `retrieve_all_fact_types_parallel` via `asyncio.gather`. Concurrent, so
 *     the waits overlap rather than summing to 6s; but each has its own
 *     unbounded fallback afterwards, and they contend for the same pool.
 *
 * So this is NOT a 2s ceiling on recall, and nothing here makes the 8s client
 * timeout unreachable. What it buys is real but narrower: the single stage
 * most responsible for the cold-page tail stops being allowed to burn 10s per
 * fact_type before it gives up, which leaves the rest of the pipeline enough
 * of the client's 8s to return something.
 *
 * The value: 2s is 20x upstream's documented <100ms target for this stage and
 * above the measured 1.412s p90, so it should not fire on a healthy query at
 * all — it only bites the tail.
 */
export const HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S = 2;

/**
 * Reasoning effort for internal LLM ops (upstream default is ALSO `low`).
 *
 * Pinned rather than inherited. Upstream's low-resource guide says extra
 * reasoning tokens are "pure latency for the extraction and consolidation
 * paths", and reflect p90 is 122s here — but the value is already upstream's
 * default, so this pin buys no behaviour change today. It exists so an
 * upstream default flip cannot silently add reasoning latency to every retain
 * and consolidation call on this fleet, and so the value is legible in
 * `docker inspect`. Deliberately NOT presented as a speed-up.
 */
export const HINDSIGHT_DEFAULT_LLM_REASONING_EFFORT = "low";

/**
 * Global LLM concurrency when the endpoint is local (upstream default `32`).
 *
 * Upstream's top low-resource warning: a default of 32 "assumes a cloud
 * provider that can absorb dozens of parallel requests. A local server with a
 * handful of slots cannot — Hindsight will fill every slot and **starve any
 * other client sharing the endpoint**." This fleet is one RTX 5070 Ti behind
 * LiteLLM, shared with every agent. 4/1/1 is upstream's own worked example for
 * a shared endpoint ("global=4, with retain/consolidation capped low so
 * reflect always has headroom"), and it matches our load shape: 99.7% of
 * recall traffic is background consolidation, which must never crowd out an
 * interactive reflect.
 */
export const HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT = 4;
export const HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT = 1;
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT = 1;

/**
 * Half-precision local reranking. Upstream default `false`, and upstream is
 * explicit about WHY: "27–36% faster on MPS; quality-identical. Disabled by
 * default to avoid regressions on non-MPS deployments — **some CPUs lack
 * native FP16 support**."
 *
 * The caveat is about hosts with no fast FP16 path, which is exactly what the
 * GPU gate excludes. Note honestly that the published 27–36% is an MPS number;
 * on CUDA FP16 is a well-established win but we have not measured it on this
 * host class, so the gate is about SAFETY (never emit it CPU-side), not about
 * promising that figure.
 */
export const HINDSIGHT_DEFAULT_RERANKER_LOCAL_FP16 = "true";

/**
 * Local-reranker batch size (upstream default `32`).
 *
 * 32 is upstream's CPU/MPS value; the vendored `cross_encoder.py` docstring
 * names 128+ as the CUDA value, because a GPU is throughput-bound on batch
 * occupancy rather than per-pair compute. Measured on this host class: rerank
 * of 150 candidates 4.347s → **0.174s**, and end-to-end recall p50 3.2s →
 * **0.8s**.
 *
 * GPU-gated for the same reason as FP16: on a CPU-only box a 128-pair batch is
 * a latency spike and a memory spike, not a speed-up. Absent verdict ⇒ off ⇒
 * upstream's 32.
 */
export const HINDSIGHT_DEFAULT_RERANKER_LOCAL_BATCH_SIZE = 128;

/**
 * Grammar-enforced structured output (upstream default `False`).
 *
 * THE fix for the malformed-JSON storm on a local backend. `gpt-oss:20b`
 * behind llama.cpp answers a schema-constrained request with a prose preamble
 * often enough that ~45% of local calls failed to parse — and a parse failure
 * wedges retain/consolidation rather than erroring visibly. Strict schema hands
 * the provider its strongest schema mode (grammar constraint on llama.cpp), so
 * the malformed shape becomes unrepresentable rather than merely unlikely.
 *
 * Gated on the local-LLM verdict, not hand-set: it is only unambiguously right
 * where the provider actually supports grammar enforcement, and a hosted
 * provider that doesn't should keep upstream's default rather than have a
 * hand-set env var forced on it.
 */
export const HINDSIGHT_DEFAULT_LLM_STRICT_SCHEMA = "true";

/**
 * LLM retry attempts (upstream default `3`).
 *
 * Upstream's own performance guide (`performance#timeouts-and-retries`): a
 * local endpoint is not rate-limited, so aggressive retry mostly adds latency
 * — a local failure is usually deterministic and will fail again. 2 keeps one
 * retry for a genuine transient (a slot evicted mid-request) and drops the
 * third attempt that only ever bought queue time. Local-gated: on a cloud
 * provider, where a 429 IS transient, upstream's 3 is correct.
 */
export const HINDSIGHT_DEFAULT_LLM_MAX_RETRIES = 2;

/** Emitted on every host — bounded work, no hardware assumption. */
export const HINDSIGHT_PERF_DEFAULTS_UNGATED: ReadonlyArray<readonly [string, string]> = [
  [
    "HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE",
    String(HINDSIGHT_DEFAULT_RECALL_MAX_CANDIDATES_PER_SOURCE),
  ],
  [
    "HINDSIGHT_API_LINK_EXPANSION_PER_ENTITY_LIMIT",
    String(HINDSIGHT_DEFAULT_LINK_EXPANSION_PER_ENTITY_LIMIT),
  ],
  [
    "HINDSIGHT_API_LINK_EXPANSION_TIMEOUT",
    String(HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S),
  ],
  ["HINDSIGHT_API_LLM_REASONING_EFFORT", HINDSIGHT_DEFAULT_LLM_REASONING_EFFORT],
];

/** Emitted only when the container can reach a GPU. */
export const HINDSIGHT_PERF_DEFAULTS_GPU: ReadonlyArray<readonly [string, string]> = [
  ["HINDSIGHT_API_RERANKER_LOCAL_FP16", HINDSIGHT_DEFAULT_RERANKER_LOCAL_FP16],
  [
    "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE",
    String(HINDSIGHT_DEFAULT_RERANKER_LOCAL_BATCH_SIZE),
  ],
];

/** Emitted only when the LLM endpoint is local/self-hosted. */
export const HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM: ReadonlyArray<readonly [string, string]> = [
  ["HINDSIGHT_API_LLM_MAX_CONCURRENT", String(HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT)],
  [
    "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
    String(HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT),
  ],
  [
    "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT",
    String(HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT),
  ],
  ["HINDSIGHT_API_LLM_STRICT_SCHEMA", HINDSIGHT_DEFAULT_LLM_STRICT_SCHEMA],
  ["HINDSIGHT_API_LLM_MAX_RETRIES", String(HINDSIGHT_DEFAULT_LLM_MAX_RETRIES)],
];

/**
 * Every key this module manages — and therefore the exact set an operator may
 * override through `hindsight.env` / the process environment.
 *
 * Scoped on purpose: see the "operator override always wins" note at the top
 * of this file for why a blanket `HINDSIGHT_API_*` passthrough is worse.
 */
export const HINDSIGHT_PERF_ENV_KEYS: ReadonlySet<string> = new Set(
  [
    ...HINDSIGHT_PERF_DEFAULTS_UNGATED,
    ...HINDSIGHT_PERF_DEFAULTS_GPU,
    ...HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
  ].map(([k]) => k),
);

/**
 * Resolve the operator's overrides for the managed keys.
 *
 * Precedence, highest first:
 *   1. `hindsight.env` in switchroom.yaml (explicit, version-controlled)
 *   2. switchroom's own process environment (an operator `export`)
 *
 * Keys outside {@link HINDSIGHT_PERF_ENV_KEYS} are ignored, as are empty /
 * whitespace-only values (an empty env var is an accident, not an override —
 * forwarding it would hand the container a value upstream's config parser
 * rejects).
 *
 * @param configEnv `config.hindsight?.env`, if any.
 * @param processEnv Injected for tests; defaults to `process.env`.
 */
export function resolveHindsightPerfOverrides(
  configEnv?: Record<string, string | number | boolean> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of HINDSIGHT_PERF_ENV_KEYS) {
    const fromProcess = processEnv[key];
    if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
      out.set(key, fromProcess.trim());
    }
  }
  for (const [key, raw] of Object.entries(configEnv ?? {})) {
    if (!HINDSIGHT_PERF_ENV_KEYS.has(key)) continue;
    const value = String(raw).trim();
    if (value === "") continue;
    out.set(key, value);
  }
  return out;
}

/**
 * The performance env pairs to hand the hindsight container.
 *
 * Ordering is stable (ungated, then GPU, then local-LLM, each in declaration
 * order) so the docker-run argv and the compose snippet are byte-comparable
 * and a parity test can assert they agree.
 *
 * Every managed key appears at most once in the result — the override
 * REPLACES the default rather than being appended after it, so there is never
 * an `-e K=a -e K=b` pair whose winner depends on docker's argv semantics.
 *
 * @param caps Resolved host capabilities. Anything not proven ⇒ that group is
 *   omitted entirely ⇒ the container keeps upstream's default.
 * @param overrides Result of {@link resolveHindsightPerfOverrides}.
 */
export function hindsightPerfEnv(
  caps: HindsightPerfCapabilities,
  overrides: ReadonlyMap<string, string> = new Map(),
): Array<[string, string]> {
  const groups: ReadonlyArray<readonly [string, string]>[] = [
    HINDSIGHT_PERF_DEFAULTS_UNGATED,
  ];
  if (caps.gpu === true) groups.push(HINDSIGHT_PERF_DEFAULTS_GPU);
  if (caps.localLlm === true) groups.push(HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM);

  const out: Array<[string, string]> = [];
  const emitted = new Set<string>();
  for (const group of groups) {
    for (const [key, value] of group) {
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push([key, overrides.get(key) ?? value]);
    }
  }

  // An operator override for a key whose capability group is OFF still has to
  // reach the container — otherwise "operator override wins" would silently
  // mean "operator override is dropped on a GPU-less box". Append those in
  // key order for determinism.
  for (const key of [...overrides.keys()].sort()) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push([key, overrides.get(key)!]);
  }
  return out;
}
