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
 *
 * `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE` is NOT a default here and must
 * not become one. It is *derived* from the declared context window by
 * `resolveHindsightContextBudget()` (`hindsight-context-budget.ts`, the
 * `batchSize = clamp(⌊(promptBudget − OVERHEAD) / PER_FACT⌋, 1, 12)` line) and
 * emitted from that derivation by `hindsightLlmBudgetEnv()`
 * (`hindsight.ts`). Adding a literal for it to any group in this module would
 * make two emitters race for one key, and would break the preflight in
 * `assertHindsightContextBudgetFits()` that proves prompt + completion fit the
 * window. Batch size is a context-window decision; change the derivation, not
 * this file.
 */

import { HINDSIGHT_PG_ENV_KEYS } from "./hindsight-pg-defaults.js";

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
 *
 * **Deliberately left at upstream's worked-example 4 rather than raised to a
 * specific host's slot count.** The right value is exactly "how many
 * concurrent slots does this operator's local endpoint expose", which is a
 * property of the deployment, not of switchroom — 4 is the value upstream
 * recommends when that number is unknown, and it is safe on the smallest
 * plausible local box. An operator who has measured their pool raises it
 * declaratively, and it survives `switchroom apply`:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     HINDSIGHT_API_LLM_MAX_CONCURRENT: 6
 * ```
 *
 * Note this is the GLOBAL cap. It does not by itself widen consolidation,
 * which is separately pinned by
 * {@link HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT} below.
 */
export const HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT = 4;
export const HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT = 1;

/**
 * Per-op cap on consolidation LLM calls — and the ACTUAL ceiling on
 * consolidation throughput.
 *
 * Worth stating plainly because it is easy to tune the wrong knob: the engine
 * composes this with the global cap rather than replacing it — a consolidation
 * call must acquire this semaphore AND {@link HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT}
 * (`llm_wrapper._build_per_op_semaphores` / `_semaphores_for_scope`, "Per-op
 * acquired first so contention queues on the narrower cap"). At 1 the process
 * makes at most ONE consolidation LLM call at a time, no matter how many
 * worker slots, banks or tag-groups are in flight. So raising worker slots
 * (`HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT`), `LLM_PARALLELISM`, or the
 * global cap pipelines the non-LLM stages and improves fairness, but only THIS
 * value multiplies concurrent consolidation inference.
 *
 * ## Why this is DERIVED and not a literal any more
 *
 * A fixed 1 made the shipped default a hard throttle that no other knob could
 * lift. Measured on the live fleet (2026-07-28, 60 minutes of logs): 168
 * consolidation LLM calls averaging 29.4s consumed 4,936s of LLM wall time in
 * one hour — **1.37 effective concurrency against 6 worker slots**, with the
 * worker reporting `consolidation=6/3(avail=0,cap=6)` and per-batch logs
 * showing `llm=160.9s` for calls the backend serves in ~30s. That gap is
 * queueing on this semaphore and nothing else; `failed_consolidation` was 0 on
 * every bank. The result was a backlog that only grows — 43,155 pending on the
 * busiest bank, rising ~719 every 3 hours.
 *
 * Two failure modes rule out simply picking a bigger literal:
 *
 *  1. **A literal at or above the global cap is inert AND misleading.** The
 *     semaphores compose, so a consolidation cap of 6 against a global cap of 4
 *     permits 4, not 6. Shipping 6 would advertise a ceiling the engine cannot
 *     honour — the same "knob set to a value that does nothing" defect this
 *     module exists to remove.
 *  2. **A literal cannot scale with the operator's endpoint.** The global cap
 *     is deliberately left at upstream's worked-example 4 because only the
 *     operator knows their slot count. Under a fixed consolidation literal, an
 *     operator who measures their pool and raises the global cap gets *zero*
 *     extra consolidation throughput — which is exactly the trap the fleet fell
 *     into.
 *
 * So the default is a function of the caps around it:
 *
 * ```
 *   consolidation = clamp(global − retain − 1, 1, global − 1)
 * ```
 *
 * The `− 1` is upstream's own stated purpose for per-op caps, quoted in
 * `llm_wrapper._build_per_op_semaphores`: "This lets operators reserve headroom
 * in the global pool by capping individual operations (e.g. cap retain at 2 of
 * 4 global slots so the live chat path always has 2 slots available)." Reflect
 * and recall have no per-op cap, so their headroom is whatever the capped lanes
 * leave. Subtracting the retain cap and one further slot guarantees that even
 * with retain AND consolidation both fully saturated, an interactive reflect
 * always has at least one global permit. Background consolidation therefore
 * still cannot crowd the interactive lane off a shared local endpoint — the
 * property the old literal 1 was protecting — while it stops being pinned to a
 * single in-flight call.
 *
 * On switchroom's own defaults (global 4, retain 1) this lands on **2**, double
 * the previous ceiling. On an operator who has raised the global cap to 10 with
 * retain at 6 it lands on 3, and it keeps tracking further changes instead of
 * needing a second yaml line.
 *
 * An explicit operator value still wins outright and is NOT clamped — the
 * derivation only supplies the default:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT: 4
 * ```
 *
 * RESTORE CONDITION (unchanged, inherited from the 2026-07-06 quota incident):
 * if consolidation ever returns to `provider: claude-code`, every concurrent op
 * is a live subprocess spending the subscription's quota and this must go back
 * to a hard 1.
 */
export function hindsightConsolidationLlmMaxConcurrentDefault(
  globalMaxConcurrent: number = HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT,
  retainMaxConcurrent: number = HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT,
): number {
  // Defensive: an operator override arrives as a string and may be junk. A
  // non-finite or non-positive cap falls back to the shipped literal rather
  // than deriving nonsense from it.
  const globalCap =
    Number.isFinite(globalMaxConcurrent) && globalMaxConcurrent >= 1
      ? Math.floor(globalMaxConcurrent)
      : HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT;
  const retainCap =
    Number.isFinite(retainMaxConcurrent) && retainMaxConcurrent >= 0
      ? Math.floor(retainMaxConcurrent)
      : HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT;

  // Never exceed `globalCap - 1` (the reflect/recall reserve) and never fall
  // below 1 (0 would be rejected by the engine: "must be a positive integer").
  const headroomBound = Math.max(1, globalCap - 1);
  return Math.min(headroomBound, Math.max(1, globalCap - retainCap - 1));
}

/**
 * The derived consolidation cap on switchroom's own shipped caps — i.e. what a
 * fresh install with no `hindsight.env` gets. Exported as the readable anchor
 * for docs and tests; the emitted value is always
 * {@link hindsightConsolidationLlmMaxConcurrentDefault} applied to the
 * EFFECTIVE caps, so an operator who raises the global cap moves this too.
 */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT =
  hindsightConsolidationLlmMaxConcurrentDefault();

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

/**
 * Tag groups consolidated concurrently within ONE operation (upstream default
 * `4`).
 *
 * Upstream's `config.py` justifies its 4 as "matches retain_max_concurrent" —
 * i.e. the value is not absolute, it is pegged to how much LLM concurrency the
 * deployment has granted. switchroom holds 2, chosen when a consolidation call
 * was the heaviest thing on a single local backend.
 *
 * ## READ THIS BEFORE TUNING IT: on most switchroom banks it does NOTHING
 *
 * This is a semaphore over *tag groups within one consolidation op*, not over
 * LLM calls. `consolidator.py` only builds it at all under
 * `if llm_parallelism > 1 and len(numbered_groups) > 1:` — with a single tag
 * group there is one group, the `else` branch runs the groups serially, and the
 * semaphore is never constructed. switchroom retains with
 * `retainTags: ["{session_id}"]`, so a bank overwhelmingly resolves to ONE tag
 * set and therefore one group. Confirmed live (2026-07-28): every consolidation
 * batch on this fleet logs `1 llm calls`, at every value of this knob. Upstream
 * tracks the general shape of this as vectorize-io/hindsight#1604.
 *
 * So it is not a throughput knob here and must not be reached for as one.
 * {@link hindsightConsolidationLlmMaxConcurrentDefault} is the knob that
 * actually multiplies concurrent consolidation inference.
 *
 * Left at 2 rather than dropped to 1: on a deployment that DOES tag across
 * several scopes the fan-out is real, and pinning 1 would disable it for those
 * installs to make one fleet's log line tidier. The misleading thing was this
 * comment, not the value.
 *
 * Moved here from a bare constant in `hindsight.ts` (2026-07-27). The value is
 * unchanged; what changes is that it is now a MANAGED key, so an operator can
 * override it through `hindsight.env`. Before this it was emitted
 * unconditionally on both launch paths with no declarative channel, so a
 * `hindsight.env` line for it was silently dropped — the exact failure this
 * module exists to prevent. The right value tracks the host's local LLM slot
 * count, which switchroom cannot know, so it must be overridable:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     # peg to RETAIN_LLM_MAX_CONCURRENT, per upstream's own rationale
 *     HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM: 3
 * ```
 *
 * Ungated: it assumes no hardware, and the previous emission was unconditional
 * — putting it behind a capability gate would silently CHANGE the default on
 * hosts that lack the gate.
 */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM = 2;

/**
 * Cap on observations per *tag scope* (upstream default `-1`, unlimited).
 *
 * Once a tag scope hits the cap, consolidation stops creating new observations
 * and only updates/deletes existing ones — bounding the cost of consolidating
 * a single long-running scope. Tagless observations are unaffected.
 *
 * Switchroom retains with `retainTags: ["{session_id}"]` (vendored plugin
 * default), so a "tag scope" maps roughly to "one session". A very long
 * Telegram session that runs for weeks can accumulate thousands of
 * observations under one scope — that is the case 1000 targets. Most sessions
 * are far below the cap, so for typical agents this is defence-in-depth rather
 * than an active limit.
 *
 * This is NOT a fix for vectorize-io/hindsight#1284 (the upstream
 * unbounded-growth bug for consolidation across a whole bank); it is a
 * companion safety rail until that lands.
 *
 * Moved here from a bare constant in `hindsight.ts` (2026-07-27). The value is
 * unchanged; what changes is that it is now a MANAGED key, so an operator can
 * override it declaratively through `hindsight.env`. Before this it was
 * emitted unconditionally on both launch paths with no declarative channel, so
 * a `hindsight.env` line for it was silently dropped and the documented
 * recourse was to stop the container and re-run `docker run -e …` by hand —
 * which the next `switchroom apply` throws away. How long a session runs, and
 * how many observations that is worth keeping, are properties of one
 * deployment, so the value must be overridable:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     # long-lived sessions on a host with room to consolidate them
 *     HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE: 5000
 * ```
 *
 * Ungated: it assumes no hardware, and the previous emission was
 * unconditional — putting it behind a capability gate would silently revert
 * hosts lacking that gate to upstream's unlimited default.
 */
export const HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE = 1000;

// ─── Container env defaults promoted from bare constants in hindsight.ts ────
//
// Every constant below was emitted unconditionally on BOTH launch paths (the
// `docker run` argv and the compose snippet) from a literal in hindsight.ts,
// and was not a member of HINDSIGHT_PERF_ENV_KEYS. That combination is the
// silent-drop defect: `resolveHindsightPerfOverrides` skips any key outside
// the managed set, so an operator's `hindsight.env` line for one of these was
// discarded with no error and no warning.
//
// They are shipped DEFAULTS, not local tuning, so they also belong in a place
// a reader of switchroom.yaml can discover. Values are unchanged; what changes
// is that they now have a declarative channel. Ungated for the same reason
// MAX_OBSERVATIONS_PER_SCOPE is: the previous emission was unconditional, so
// gating them would silently revert hosts to upstream's defaults.

/**
 * Reranker smart-defaults (v0.13.22).
 *
 * The hindsight server's cross-encoder reranker is the single biggest
 * latency contributor on the recall path — 87% of p50 5.6s on the
 * 2026-05-24 fleet audit. Each of these knobs has a vendor default that
 * is sub-optimal for switchroom's workload (CPU-only, shared host,
 * Telegram-shaped concurrency); we override to the optimal value out of
 * the box so a fresh `switchroom setup` produces a fast hindsight
 * without any operator tuning.
 *
 * - BUCKET_BATCHING: vendor default `false`. Vendor's own config.py
 *   comment promises "36-54% speedup, quality-identical" by sorting
 *   candidate pairs by length to avoid padding waste. Pure win on CPU.
 *
 * - MAX_CANDIDATES: vendor default 300. At our `recallBudget=low`
 *   ~100 candidates feed in and we cap to 12 final memories; scoring
 *   300 wastes ~50% of rerank CPU on candidates that will never make
 *   the top-N.
 *
 * - LOCAL_MAX_CONCURRENT: vendor default 4. With 9 always-on agents
 *   that's up to 36 simultaneous CPU-bound rerank tasks on a shared
 *   16-core host — thrashes. Cap at 2 leaves headroom for burst.
 *
 * - RECALL_MAX_CONCURRENT: vendor default 32. Sized for a dedicated
 *   hindsight box; switchroom is co-tenant with the fleet, hostd,
 *   brokers, etc. 8 matches realistic concurrency without lock
 *   contention.
 *
 * All four are operator-overridable declaratively through `hindsight.env`
 * (they are members of {@link HINDSIGHT_PERF_DEFAULTS_UNGATED}) — but they
 * should never NEED tuning for a single-host fleet install.
 *
 * They previously lived as bare constants in `hindsight.ts`, emitted
 * unconditionally on both launch paths and absent from
 * {@link HINDSIGHT_PERF_ENV_KEYS}, so a `hindsight.env` line for any of them
 * was silently discarded while reading, in yaml, as durable config. The doc
 * comment here used to name "editing the generated compose snippet or the
 * `docker run -e ...` flags" as the recourse — i.e. it documented the exact
 * imperative state the next `switchroom apply` throws away.
 */
export const HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING = "true";
export const HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES = 150;
// Vendor default 4. v0.13.22 dropped this to 2 paired with the now-
// reverted `--cpus=2.0` CPU cap; with CPU restored, 4-way concurrency
// is the right knob — lets 4 fleet agents' recalls overlap without
// thrashing per-pair compute (which is the actual bottleneck, not
// task-level contention).
export const HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT = 4;
export const HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT = 8;

/**
 * Reflect wall-clock timeout. Vendor default is 300s. Mental-model
 * refresh re-runs the model's `source_query` through the agentic reflect
 * loop; on a large bank (observed: 12-13k observations) that legitimately
 * exceeds 300s, so the refresh times out and the model stays stale —
 * which is the main reason user-profile models go unpopulated on
 * high-volume agents (2026-06-19 fleet: refresh timeouts across 8 banks).
 * 600s lets large-bank refreshes complete. Trade-off: an interactive
 * `reflect` query also gets the longer ceiling, but those rarely approach
 * 300s, so the net is strictly more models successfully refreshing.
 */
export const HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S = 600;

/**
 * Per-round memory scope for one consolidation op (upstream default 1000;
 * switchroom held this at 100 from the 2026-07-06 quota throttle).
 *
 * ## This is a CORRECTNESS knob, not only a throughput one
 *
 * The engine SKIPS mental-model refresh entirely on any round that hits this
 * limit — `engine/consolidation/consolidator.py`:
 *
 * ```python
 * if hit_round_limit:
 *     stats["mental_models_refreshed"] = 0
 *     logger.info(f"[CONSOLIDATION] bank={bank_id} skipping mental model refresh "
 *                 f"(round limit hit, re-queued)")
 * ```
 *
 * That is deliberate upstream behaviour (the next round will handle it), but
 * it composes badly with a low limit and a large backlog: a bank whose
 * backlog never drops below the limit hits the limit on EVERY round and
 * therefore NEVER refreshes its mental models. At 100 that described 4 of the
 * 6 banks on this fleet (backlogs measured 2026-07-27: 29,625 / 6,238 / 328 /
 * 165 / 96 / 83 — the top four are all above 100 and the largest was still
 * rising round over round). Mental models are the standing-answer layer
 * agents rely on, so "silently never refreshed" is a correctness failure, not
 * a slow drain.
 *
 * 500 is a 5x scope bump with the same shape of bound — it is still a bound,
 * so a runaway bank still re-queues rather than monopolising a slot, and the
 * consolidation prompt size per LLM call is unchanged (that is
 * `LLM_BATCH_SIZE`, derived from the context window). What it costs is a
 * longer hold on a worker slot per round; what it buys is that a mid-sized
 * bank now finishes a round and refreshes.
 *
 * Raising this was gated on consolidation leaving the shared Anthropic quota
 * — see the RESTORE CONDITION in the block above.
 */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND = 500;

/**
 * Per-type worker slot CEILING for consolidation — upstream
 * `HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT`.
 *
 * ## Ceiling vs floor — two different knobs with confusingly similar names
 *
 * Upstream's own `config.py` warns about this, and switchroom has been
 * silently inheriting the wrong one:
 *
 *   - {@link HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS}
 *     (`HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS`, 1) is the RESERVED
 *     FLOOR: slots consolidation is always guaranteed.
 *   - THIS (`..._SLOT_LIMIT`) is the CEILING: the most slots consolidation may
 *     hold at once, reserved and shared combined
 *     (`WORKER_SLOT_LIMIT_TYPES` in `config.py`, whose consolidation entry
 *     defaults to `4`).
 *
 * switchroom never emitted the ceiling, so every install has silently run on
 * upstream's 4 — and on this fleet that ceiling was observed fully saturated
 * (`consolidation=4/1(avail=0,cap=4)`, four banks consolidating with more
 * queued) while only 5 of the worker's 10 total slots were in use. Five idle
 * slots that consolidation was forbidden from touching.
 *
 * (The 4 default and the 10-slot worker pool are pinned by
 * tests/docker/hindsight-recall-isolation-patches.test.ts, which also proves
 * `validate()` rejects a ceiling above the pool or below this type's own
 * reservation — so this value must sit between MAX_SLOTS and 10.)
 *
 * 6 of `DEFAULT_WORKER_MAX_SLOTS` = 10 leaves 4 slots for every other op type
 * (retain, refresh_mental_model, graph_maintenance, import_documents — all
 * uncapped upstream) while letting consolidation use the idle capacity.
 *
 * Be honest about what this buys: consolidation LLM calls are still
 * serialised by the `CONSOLIDATION_LLM_MAX_CONCURRENT` semaphore (default 1),
 * so 6 slots do NOT mean 6 concurrent LLM calls. What they mean is that six
 * banks' non-LLM stages pipeline, and that a small bank is no longer stuck
 * behind big ones — the claim query is a flat `ORDER BY created_at` across
 * all banks unless a priority map is configured (`ops_postgresql.py`
 * `claim_tasks`; see `HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY` in
 * hindsight-perf-defaults.ts).
 *
 * Emitted explicitly rather than left to the upstream default so the value is
 * legible in `docker inspect` and cannot move under us on an image bump.
 * Subject to the RESTORE CONDITION above: back to 1 if consolidation returns
 * to `provider: claude-code`.
 */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT = 6;

/** Reserved consolidation slot FLOOR — see SLOT_LIMIT above for floor-vs-ceiling. */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS = 1;

/**
 * Age→freshness curve used by the reranker's recency boost (upstream default
 * `"linear"`; validated set is `linear | exponential | none`, config.py:907).
 *
 * ## The failure this addresses
 *
 * Agent banks accumulate point-in-time state facts that nothing ever
 * supersedes. Measured on bank `klanker` (2026-07-28): the query "what version
 * is the switchroom fleet running right now" returned 38 results whose top hit
 * was `Switchroom fleet is running image version v0.18.19` — retained
 * 2026-07-19 and wrong by then — followed by v0.19.6, v0.19.8, v0.18.7 and
 * v0.16.49. The correct current value did not appear at all. A confidently
 * wrong answer is worse than an empty one.
 *
 * Under upstream's `linear` curve the recency signal decays to a 0.1 floor over
 * `linear_window_days`, which defaults to **365**. Across the age range a real
 * bank actually spans (days to a few months) that is a nearly flat line: at 9
 * days the signal is 0.975 and at 90 days it is still 0.753. Recency is
 * nominally enabled and practically absent.
 *
 * `exponential` is the right SHAPE for state facts, because its half-life is
 * defined as the age at which the signal is exactly neutral — younger memories
 * are boosted, older ones penalised, with a smooth asymptote and no hard cutoff
 * (`compute_recency_decay`, reranking.py). Set the half-life to the age past
 * which a "current state" claim should stop being presumed current, and the
 * curve does the rest.
 *
 * ## HONEST MAGNITUDE — read this before claiming it fixes staleness
 *
 * It does not, on its own, and the reason is switchroom's OWN fork. The
 * combined boost is damped by `_boost_authority` (reranking.py, marked
 * `# switchroom:`), which raises the recency × temporal × proof_count product
 * to an exponent derived from `_CE_DECISIVE_RELATIVE_GAP` (default `0.02`,
 * overridable via `HINDSIGHT_CE_DECISIVE_RELATIVE_GAP`):
 *
 *   combined_score = CE_normalized * (recency_boost * temporal_boost *
 *                                     proof_count_boost) ** exponent
 *
 * At the shipped alphas (0.2 / 0.2 / 0.1) and gap 0.02 that exponent is
 * **0.0395**. Computed against the container's own `compute_recency_decay`,
 * the full freshest-vs-oldest recency spread is:
 *
 *   linear / 365d (upstream default)  1 day vs 400 days  →  +0.71%
 *   exponential / 30d (this default)  1 day vs 400 days  →  +0.78%
 *
 * So this default moves the ranking by ~0.07 percentage points today. It is
 * shipped because it is free, because it is the correct curve for the ages
 * banks actually span, and because the moment the CE gap is revisited it is
 * the difference between a working recency signal and a flat one — NOT because
 * it fixes the measured symptom by itself. The binding constraint is the
 * decisive-gap exponent, which reverses a deliberate switchroom decision made
 * on measured cross-encoder saturation and therefore needs its own measured
 * change rather than a guess bundled in here.
 *
 * That change already has a lever and a documented shape: raising
 * `HINDSIGHT_CE_DECISIVE_RELATIVE_GAP` to ~0.65 or above clamps the exponent to
 * 1.0 and restores full upstream boost authority (see that key's entry under
 * {@link HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS}), at which point the exponential/30d
 * curve shipped here yields a ±21% freshest-vs-oldest spread instead of ±0.8%.
 * Deliberately NOT done here.
 *
 * `compute_recency_decay` is reached from exactly one call site
 * (`apply_combined_scoring`, memory_engine.py), so there is no undamped path
 * where this default has more authority than the numbers above.
 */
export const HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION = "exponential";

/**
 * Exponential half-life in days (upstream default `90`).
 *
 * The half-life is the age at which the recency signal is exactly neutral, so
 * it is a direct statement of "how long a current-state claim stays presumed
 * current". 30 days: a fact retained this week is boosted, one from last month
 * is neutral, one from last quarter is penalised (signal 0.125 at 90 days).
 *
 * Upstream's 90 puts the neutral point a full quarter out, which for a fleet
 * whose version, backlog and status facts turn over weekly is indistinguishable
 * from the flat linear curve this replaces.
 *
 * Note the pairing: this value is only read when the decay function is
 * `exponential` (`compute_recency_decay` ignores it otherwise), and an operator
 * who overrides only the function back to `linear` gets
 * {@link HINDSIGHT_DEFAULT_RECENCY_DECAY_LINEAR_WINDOW_DAYS} instead.
 */
export const HINDSIGHT_DEFAULT_RECENCY_DECAY_HALFLIFE_DAYS = 30;

/**
 * `HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD` is deliberately LEFT at
 * upstream's 0.97 and is NOT a managed key here.
 *
 * The duplicate-fact symptom that motivated this module's freshness defaults
 * (five near-identical copies of one "repo is at <path>, version v0.19.5" fact
 * on bank `klanker`, retained on different days) is a RAW-fact duplication, and
 * this knob cannot touch it: `_dedup_adjudicate`
 * (engine/consolidation/consolidator.py) probes
 * `retrieve_semantic_bm25_combined(..., ["observation"], ...)` — observation
 * against observation only. Lowering the threshold would merge more distinct
 * *observations*, i.e. spend real precision for zero effect on the reported
 * bug. Raw-fact duplication is handled at read time by `prefer_observations`
 * instead (already on by default; see vendor/hindsight-memory/scripts/recall.py).
 */

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
  [
    "HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM",
    String(HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM),
  ],
  [
    "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE",
    String(HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE),
  ],
  [
    "HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING",
    HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING,
  ],
  [
    "HINDSIGHT_API_RERANKER_MAX_CANDIDATES",
    String(HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES),
  ],
  [
    "HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT",
    String(HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT),
  ],
  [
    "HINDSIGHT_API_RECALL_MAX_CONCURRENT",
    String(HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT),
  ],
  [
    "HINDSIGHT_API_REFLECT_WALL_TIMEOUT",
    String(HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S),
  ],
  [
    "HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS",
    String(HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS),
  ],
  [
    "HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT",
    String(HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT),
  ],
  [
    "HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND",
    String(HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND),
  ],
  [
    "HINDSIGHT_API_RECENCY_DECAY_FUNCTION",
    HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION,
  ],
  [
    "HINDSIGHT_API_RECENCY_DECAY_HALFLIFE_DAYS",
    String(HINDSIGHT_DEFAULT_RECENCY_DECAY_HALFLIFE_DAYS),
  ],
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
 * Keys switchroom manages but ships NO default for — emitted only when the
 * operator sets them in `hindsight.env` / the process environment.
 *
 * This is the right shape for a knob whose correct value is a property of one
 * *deployment* rather than of the software. Baking such a value into a shipped
 * default hard-codes one installation's facts into a general product; leaving
 * the key out of the managed set entirely leaves the operator with no
 * declarative channel at all, which is exactly how a value ends up set
 * imperatively on a container and silently dropped by the next
 * `switchroom apply`. Neither is acceptable, so: managed key, no default.
 *
 * ### `HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY`
 *
 * Upstream's consolidation claim query is a flat `ORDER BY created_at` across
 * every bank unless a priority map is configured (`ops_postgresql.py`
 * `claim_tasks`: "When *priority_map* is ``None``, uses the default
 * ``ORDER BY created_at``"), so a bank with a 29k backlog gets no preference
 * over one with 83. The map fixes that — but the fix *is* "which banks matter
 * on this host", and bank names are per-deployment (they are agent names).
 * Unset ⇒ upstream's flat FIFO, i.e. this key changes nothing for anyone who
 * does not opt in.
 *
 * Format (`config.py` `_parse_bank_priority`): `pattern:priority,...`, higher
 * priority claimed first, `*` is a wildcard inside a pattern, a bare `*` is
 * the catch-all for unlisted banks, and every priority must be an integer
 * `>= 1` — a malformed entry raises at container startup rather than being
 * ignored, so a typo here fails loudly. Example:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY: "big-bank:3,busy-bank:2,*:1"
 * ```
 *
 * ### `HINDSIGHT_CE_DECISIVE_RELATIVE_GAP`
 *
 * The documented rollback knob for switchroom's CE-saturation damping patch
 * (`docker/Dockerfile.hindsight`, the `reranking.py` block). That patch is
 * unconditional and its failure mode is a *silent* recall-quality regression
 * with no telemetry that would surface it, so the patch deliberately reads its
 * decisive gap from this env var once at import — backing the change out is
 * meant to be a container restart with one env var, not an image rebuild. Any
 * value at or above ~0.65 clamps the damping exponent to 1.0, i.e. exactly
 * upstream ranking behaviour with the patch still baked in.
 *
 * Note the name: this is a switchroom-patch knob, not an upstream one, so it
 * carries NO `HINDSIGHT_API_` prefix and upstream's config parser never sees
 * it. Only the patched module reads it.
 *
 * It is here because an escape hatch that cannot be reached is not an escape
 * hatch. Absent from this set, `resolveHindsightPerfOverrides` skipped it, so
 * a `hindsight.env` line for it never reached the container — and because the
 * patch reads the var once at import, there is no runtime fallback to recover
 * through. Override-only rather than defaulted: switchroom ships the patch's
 * own derived gap, and emitting a value here would replace a derived constant
 * with a hard-coded one on every host.
 *
 * ```yaml
 * hindsight:
 *   env:
 *     HINDSIGHT_CE_DECISIVE_RELATIVE_GAP: "1.0"   # damping off, patch inert
 * ```
 *
 * ### `HINDSIGHT_API_RECENCY_DECAY_LINEAR_WINDOW_DAYS`
 *
 * Inert under the shipped decay function — {@link
 * HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION} is `exponential`, and
 * `compute_recency_decay` reads the linear window only on the `linear` branch.
 * It is managed anyway because an operator who sets
 * `HINDSIGHT_API_RECENCY_DECAY_FUNCTION: linear` in `hindsight.env` would
 * reasonably set the window on the next line, and a key absent from {@link
 * HINDSIGHT_PERF_ENV_KEYS} is silently discarded while reading, in yaml, as
 * durable config — the exact trap this key set was scoped to prevent.
 *
 * Override-only rather than defaulted for the same reason as the two above:
 * emitting upstream's own 365 would add a hard-coded value to every host's
 * `docker inspect` for no behaviour change.
 *
 * ### `HINDSIGHT_API_WORKER_MAX_SLOTS`
 *
 * The total in-flight task budget for the worker poller — the pool that
 * `HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS` reserves out of and that
 * every other operation type shares. switchroom already manages the
 * reservation and the ceiling (both are in {@link
 * HINDSIGHT_PERF_DEFAULTS_UNGATED}) but not the total they are carved from,
 * so an operator could set two of the three terms of one slot policy and not
 * the third.
 *
 * That gap is not theoretical. On the reference fleet this line sat in
 * `hindsight.env` from 2026-07-27 with a measured rationale attached:
 *
 * ```yaml
 * hindsight:
 *   env:
 *     HINDSIGHT_API_WORKER_MAX_SLOTS: 16
 * ```
 *
 * and the container ran `max_slots=10` — upstream's default — for the whole of
 * the following day, because the key was outside this module's managed set and
 * `resolveHindsightPerfOverrides` skipped it. The poller logs the value it
 * actually booted with (`starting polling loop (max_slots=…)`), so the drop was
 * observable, but nothing connected that line back to the yaml.
 *
 * Override-only rather than defaulted for the same reason as the three above:
 * switchroom ships no opinion on the total slot budget, and emitting upstream's
 * own 10 would add a hard-coded value to every host's `docker inspect` for no
 * behaviour change. Note also that upstream validates the slot policy at boot
 * (reservations must sum to <= this, and the consolidation ceiling must sit
 * between the reservation and this), so an incoherent combination fails loudly
 * in the container rather than silently here.
 */
export const HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS: ReadonlySet<string> = new Set([
  "HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY",
  "HINDSIGHT_CE_DECISIVE_RELATIVE_GAP",
  "HINDSIGHT_API_RECENCY_DECAY_LINEAR_WINDOW_DAYS",
  "HINDSIGHT_API_WORKER_MAX_SLOTS",
]);

/**
 * Every key this module manages — and therefore the exact set an operator may
 * override through `hindsight.env` / the process environment.
 *
 * Scoped on purpose: see the "operator override always wins" note at the top
 * of this file for why a blanket `HINDSIGHT_API_*` passthrough is worse.
 */
export const HINDSIGHT_PERF_ENV_KEYS: ReadonlySet<string> = new Set([
  ...[
    ...HINDSIGHT_PERF_DEFAULTS_UNGATED,
    ...HINDSIGHT_PERF_DEFAULTS_GPU,
    ...HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
  ].map(([k]) => k),
  ...HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS,
]);

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

  // The consolidation cap's default is derived from the EFFECTIVE global and
  // retain caps, so an operator who raises the global cap widens consolidation
  // with it instead of staying pinned to a literal the engine may not even be
  // able to honour. See hindsightConsolidationLlmMaxConcurrentDefault. An
  // explicit consolidation override still wins below, unclamped.
  const effectiveCap = (key: string, fallback: number): number => {
    const raw = overrides.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
  };
  const derivedConsolidationCap = String(
    hindsightConsolidationLlmMaxConcurrentDefault(
      effectiveCap("HINDSIGHT_API_LLM_MAX_CONCURRENT", HINDSIGHT_DEFAULT_LLM_MAX_CONCURRENT),
      effectiveCap(
        "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
        HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT,
      ),
    ),
  );

  const out: Array<[string, string]> = [];
  const emitted = new Set<string>();
  for (const group of groups) {
    for (const [key, value] of group) {
      if (emitted.has(key)) continue;
      emitted.add(key);
      const shipped =
        key === "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT" ? derivedConsolidationCap : value;
      out.push([key, overrides.get(key) ?? shipped]);
    }
  }

  // An operator override for a key whose capability group is OFF still has to
  // reach the container — otherwise "operator override wins" would silently
  // mean "operator override is dropped on a GPU-less box". This is also the
  // ONLY path by which a HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS member is emitted:
  // it belongs to no defaults group, so it appears here exactly when the
  // operator set it and is absent otherwise. Append in key order for
  // determinism.
  for (const key of [...overrides.keys()].sort()) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push([key, overrides.get(key)!]);
  }
  return out;
}

// ─── Loud failure for a key that cannot be reached ──────────────────────────

/**
 * Names in `hindsight.env` that switchroom does NOT manage, and therefore
 * silently discards.
 *
 * `resolveHindsightPerfOverrides` skips any key outside
 * {@link HINDSIGHT_PERF_ENV_KEYS} (and `hindsightPgEnvPairs` does the same for
 * {@link HINDSIGHT_PG_ENV_KEYS}). That skip is correct — a blanket
 * `HINDSIGHT_API_*` passthrough would collide with the vars `startHindsight()`
 * derives itself — but it is SILENT, which is the worst available failure
 * mode: the operator writes a line, commits it, and believes they changed
 * something they did not. No error, no warning, and the value in the container
 * is still switchroom's.
 *
 * This is the same defect class as a plugin-side literal that `switchroom
 * apply` reverts: config that reads as durable and isn't. Detection is the
 * durable half — the key list will keep growing, so a mechanism that reports
 * "you wrote a key nothing reads" beats enumerating today's gaps.
 *
 * Pure and total: takes the raw `hindsight.env` record, returns the offending
 * keys in sorted order (empty when everything is managed). The caller decides
 * how loud to be; `switchroom doctor` renders it as a FAIL.
 */
export function findUnmanagedHindsightEnvKeys(
  configEnv?: Record<string, string | number | boolean> | undefined,
): string[] {
  return Object.keys(configEnv ?? {})
    .filter((key) => !HINDSIGHT_PERF_ENV_KEYS.has(key) && !HINDSIGHT_PG_ENV_KEYS.has(key))
    .sort();
}
