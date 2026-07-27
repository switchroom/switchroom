/**
 * Every number the hindsight watchdog fires on, with the measurement it came
 * from. No threshold in this file is a guess — each cites the observation
 * that set it, so a future re-baseline is an evidence edit, not a vibe edit.
 *
 * Baseline measurements, host `switchroom` prod, 2026-07-25 (Australia/
 * Melbourne), all read-only:
 *
 *  B1  LiteLLM spend ledger, daily hindsight LLM failure rate, 14 days
 *      (`LiteLLM_SpendLogs`, `end_user='hindsight'`):
 *        2026-07-11..18   0.00 % every day (n = 1..5/day, quiet)
 *        2026-07-19      66.63 % (41,970 / 62,986)   ← the storm
 *        2026-07-20     100.00 % (100,980 / 100,980) ← the storm
 *        2026-07-21     100.00 % (40,724 / 40,724)   ← the storm
 *        2026-07-22      99.94 % (3,362 / 3,364)     ← the storm
 *        2026-07-23       0.00 % (n = 6,182)
 *        2026-07-24       7.07 % (983 / 13,910)
 *      Recent hourly all-tenant failure rate (2026-07-25 01:00..09:00 UTC):
 *      0.03 % .. 2.7 %.
 *
 *  B2  Retain wall time, from `STREAMING RETAIN COMPLETE ... in Ns` in
 *      `docker logs switchroom-hindsight` during an active backlog drain
 *      (n = 17): p50 46.1 s, p90 68.0 s, p95 69.9 s, max 76.4 s. The prior
 *      audit records the steady-state band as 40-66 s.
 *
 *  B3  Spooled retains on disk across the 11 agents
 *      (`~/.switchroom/agents/*​/home/.hindsight/pending-retains`):
 *      616 pending / 0 dead at 2026-07-25 19:1x local, mid-drain, down from
 *      5,636 pending / 135 dead recorded in the morning audit.
 *
 *  B4  `hindsight_operation_duration_seconds_bucket{operation="retain"}`
 *      finite `le` edges: 0.1 .. 60, 120, then `+Inf`. 120 is the largest
 *      finite bucket, so it is the largest latency threshold the exposition
 *      can resolve at all.
 *
 *  B5  `HINDSIGHT_API_RETAIN_LLM_TIMEOUT=300` (docker inspect env).
 *
 * ── RE-BASELINE 2026-07-26, after #3599 / #3610 / #3611 ──────────────────
 *
 * The B1-B5 numbers above were taken BEFORE three changes to this exact
 * subsystem landed on main. They are kept because they are still the record
 * of the incident this watchdog exists for, but three of them no longer
 * describe the system being watched. Re-measured on the same host, live,
 * read-only, 2026-07-26 02:4x local (= 2026-07-25 16:4x UTC):
 *
 *  B6  Retain content is now BOUNDED and SPLIT (#3610,
 *      `vendor/hindsight-memory/scripts/lib/retain_split.py`). One logical
 *      memory over `retain_content_limit()` — 45,000 chars, derived as
 *      3000 chars/chunk × floor(280 s deadline / 18.4 s per chunk) = 15
 *      chunks — becomes N queue entries with `-p<i>of<n>` document ids.
 *      Measured over the live queue (n = 174 entries, all pre-split):
 *        content chars   min 38,150   p50 97,591   p90 356,474   max 744,546
 *        171 / 174 exceed the 45,000-char bound
 *        Σ ceil(len / 45,000) = 765 parts  ⇒  4.397 parts per entry,
 *        worst single entry 17 parts.
 *      So the QUEUE'S UNIT CHANGED: it counts memory PARTS now, not
 *      memories. Any depth or growth threshold expressed in entries and
 *      calibrated pre-#3610 is off by that factor. See
 *      {@link PARTS_PER_MEMORY}.
 *
 *  B7  Retain timeouts are now DERIVED, not the flat 300 s of B5 (#3611,
 *      `src/setup/hindsight.ts`): server per-LLM-call
 *      `HINDSIGHT_API_RETAIN_LLM_TIMEOUT = ceil(16384 / 80.6) = 204 s`, and
 *      the client POST deadline `HINDSIGHT_RETAIN_CLIENT_DEADLINE_S = 280`.
 *      A max-size (45,000-char) part is 15 sequential extraction calls, so
 *      ~276 s of server work is now WITHIN the design envelope rather than
 *      pathological. B5 is superseded.
 *
 *  B7a REVISION: #3611's 204 s was derived from the token budget ALONE and
 *      did not cover the litellm routing chain underneath it
 *      (`gpt-oss-20b-retain` 200 s + `gpt-oss-20b-retain-openrouter` 90 s =
 *      290 s), so the retain fallback hop had 4 s of headroom and could never
 *      complete. Both budgets are now derived from
 *      `src/litellm/timeout-budget.ts` as `max(token-derived floor, local +
 *      fallback + margin)`: `HINDSIGHT_API_RETAIN_LLM_TIMEOUT = 300` and
 *      `HINDSIGHT_RETAIN_CLIENT_DEADLINE_S = 310`, which moves
 *      `retain_content_limit()` 45,000 → 48,000 chars
 *      (3000 × floor(310 / 18.4) = 3000 × 16). The B6 part-count figures
 *      above are stated against 45,000 and are left as the measured record;
 *      re-derived at 48,000 they shift by ~6 %, inside the noise
 *      {@link PARTS_PER_MEMORY} is calibrated against, and move no threshold
 *      in this file.
 *
 *  B8  Live `/metrics`, 2026-07-25 16:44 UTC, container up since
 *      2026-07-25T14:01:35Z (2.7 h), health `healthy`, RestartCount 0:
 *        retain operations   265 success / 3 failure  ⇒  1.1 % failure rate
 *        retain duration cumulative buckets
 *          le=60 → 79, le=120 → 216, +Inf → 268
 *        ⇒ 52 / 268 = 19.4 % of retains on a HEALTHY backend take > 120 s,
 *          i.e. p95 is already saturated above the exposition's largest
 *          finite bucket. This is what killed the p95 signal — see the
 *          "removed" note where `RETAIN_P95_SECONDS` used to be.
 *      Body size 258,741 B, not the ~60 KB recorded on 2026-07-25.
 *
 *  B9  Loss channels. #3599 added two siblings of the queue dir that record
 *      memory leaving the queue WITHOUT being persisted:
 *      `pending-evicted/` (FIFO eviction at the `MAX_ENTRIES` / `MAX_BYTES`
 *      cap; under a full disk the eviction path deletes outright) and
 *      `pending-drops.json` (`record_drop`, a `{count}` ledger for entries
 *      that could not be written at all). Live counts today: 18 `.dead`
 *      markers (klanker 10, overlord 8), 0 evicted, no drops ledger on any
 *      agent. `.dead` alone is therefore still a real signal but no longer
 *      a complete one — hence the `retain-loss` signal in `types.ts`.
 *
 *  B10 INTERVAL corroboration of B8. B8's counters are cumulative since the
 *      container came up, which cannot show what a single watchdog TICK
 *      would see. Two `/metrics` reads exactly 900 s apart (2026-07-25 16:44
 *      → 16:59 UTC — one 15-minute tick), differenced:
 *        retains completed        17 success / 0 failure ⇒ 0.0 % interval
 *        duration bucket deltas   le=60 → 4, le=120 → 11, +Inf → 17
 *        ⇒ 6 / 17 = 35.3 % of this interval's retains exceeded 120 s
 *      on a backend healthy throughout. The interval reading is WORSE than
 *      B8's cumulative 19.4 %, which strengthens rather than weakens the
 *      case for deleting the p95 signal. 17 retains per tick also confirms
 *      the {@link MIN_RETAIN_SAMPLES} arithmetic (~140-200 per 2 h window),
 *      and the largest finite `le` is still 120.0 (B4 holds).
 */

/** How many samples the rolling window keeps (8 × 15 min = 2 h). */
export const RING_MAX = 8;

/**
 * Discard window samples older than this relative to the newest one.
 *
 * Derivation: `RING_MAX` × the recommended 15-minute cadence is a 105-minute
 * span; 3 h leaves ~2× slack for a late or skipped tick while still being far
 * shorter than any real outage. The failure it prevents is concrete — if the
 * cron is stopped for a day, the ring's oldest sample is a day-old counter
 * value, and a "failure rate over the last 1440m" or a "queue grew +5000 in
 * 1440m" verdict would page the operator about an era that already ended.
 * Beyond this age the watchdog re-baselines and honestly reports `no-data`
 * for one interval instead.
 */
export const MAX_SAMPLE_AGE_MS = 3 * 60 * 60_000;

/**
 * Minimum retain observations in the rolling window before the failure-rate
 * signal is allowed to fire. A "50 % failure rate" over 2 retains
 * is noise, and hindsight goes genuinely idle overnight. Below this the
 * signal reports `insufficient-data`, which neither fires NOR clears — a
 * quiet night can't silently resolve a live alert.
 *
 * 20 ≈ the retain volume of a single busy 15-minute interval (B2 saw 17
 * retains complete in ~5 minutes of drain), so a real storm crosses it
 * within one interval and a quiet fleet crosses it within the 2 h window.
 *
 * Still correct after #3610: B8 measured 268 retains in the 2.7 h since the
 * container came up (~99/h, ~25 per 15-minute tick), so a 2 h window carries
 * ~200 observations — an order of magnitude over the floor. Splitting only
 * pushes this the safe way (one oversized memory now issues several POSTs,
 * so the retain COUNT rises), and the floor's job is protecting against too
 * FEW samples.
 */
export const MIN_RETAIN_SAMPLES = 20;

/**
 * Retain failure fraction over the rolling window that fires S1.
 *
 * 0.10 sits ≥ 3.7× above the worst healthy hour ever measured (B1: 2.7 %),
 * an order of magnitude above the 0.00 % that eight consecutive healthy days
 * produced, and well under the storm this exists to catch (B1: 66-100 %
 * daily; the reported retain-failure storm ran at ~28 %). Anything tighter
 * would flap on a single bad Ollama failover; anything looser would have let
 * 2026-07-24's 7 % day pass without a second look but still catch nothing
 * new.
 *
 * Re-checked against B8: the post-#3611 healthy fleet runs at 1.1 % retain
 * failure (3 / 268), so 0.10 still sits ~9× above measured normal. #3611's
 * derived budget makes this MORE reliable, not less: the server per-call
 * timeout (204 s) is now strictly inside the client deadline (280 s), so a
 * slow extraction dies server-side and lands in the `success="false"`
 * counter this signal reads, instead of the client abandoning a POST whose
 * outcome the counter never records.
 */
export const RETAIN_FAILURE_RATE = 0.1;

/*
 * REMOVED: `RETAIN_P95_SECONDS` / the `retain-latency-p95` signal.
 *
 * It was 120 s: "1.7× the measured p95 (B2: 69.9 s) and 40 % of the 300 s
 * client timeout (B5), so it fires BEFORE retains start timing out". Both
 * halves of that derivation died with #3610/#3611, and the signal is not
 * re-derivable — it is unmeasurable with this exposition:
 *
 *  1. 120 s is the largest FINITE `le` edge hindsight exports (B4). No
 *     threshold above it is resolvable at all; a p95 past it can only be
 *     reported as "> 120 s".
 *  2. The healthy fleet is already past it. B8: 52 / 268 retains (19.4 %)
 *     exceeded 120 s while the failure rate was 1.1 % and the container was
 *     `healthy` with RestartCount 0. A 120 s threshold fires permanently on
 *     a healthy backend.
 *  3. That is by design, not decay. #3610 bounds a retain POST at 45,000
 *     chars precisely so it FITS the 280 s client deadline: 15 sequential
 *     extraction calls at the measured 18.4 s each ≈ 276 s. Latency
 *     anywhere in 120..280 s is now inside the design envelope.
 *
 * So the exposition is blind across exactly the 120-280 s band where an
 * early warning would have to live, and everything below that band is
 * normal. What the signal was for is now covered structurally: content is
 * bounded so a correctly-sized POST fits the deadline, and an overrun
 * surfaces as a retain FAILURE, which `RETAIN_FAILURE_RATE` already reads.
 *
 * Restoring it needs an instrument change, not a constant change: hindsight
 * would have to export `le` edges above 280 s (or a retain-duration summary
 * / `_sum` and `_count` pair). Until then a latency threshold here would be
 * a number that always fires, which is worse than no signal — it trains the
 * operator to ignore the watchdog.
 */

/**
 * Parts a single logical memory becomes in the spool after #3610's split.
 *
 * This is the unit-conversion factor for every entry-COUNT threshold below.
 * Before #3610 one queued entry was one memory; now one memory over the
 * 45,000-char content bound is one entry per part, so a queue depth stated
 * in entries means something different than it did when `QUEUE_FLOOR` and
 * `QUEUE_GROWTH_MIN_ABS` were first set.
 *
 * B7b REVISION (#3693): the bound is now a FRACTION of the client deadline
 * rather than the whole of it, moving `retain_content_limit()` 48,000 →
 * 33,000. Unlike B7a's ~6 % this is a 45 % change and is NOT inside the
 * noise: the same backlog splits into ~1.45× as many parts with not one new
 * memory behind it, so leaving the factor at 4.4 would tighten every count
 * threshold below by that much and reintroduce exactly the B6 false positive
 * they exist to prevent. The B6 population (174 pre-split entries) no longer
 * exists to re-measure, so the revision is applied as the bound RATIO:
 *
 *   4.4 × (45,000 / 33,000) = 6.0
 *
 * Ratio-scaling is EXACT for entries far above the bound and OVER-estimates
 * for entries below it (those are one part at either bound), so the factor
 * errs high — i.e. quieter — which is the safe direction for a watchdog.
 * Corroborated against the live 2026-07-26 backlog (209 entries): re-splitting
 * it at 33,000 rather than 48,000 moves 336 parts → 531, a ratio of 1.58,
 * slightly above the 1.45 applied here, so 6.0 remains the conservative side.
 *
 * 4.4 was measured, not assumed (B6): over the 174 live pre-split queue
 * entries, `Σ ceil(content_chars / 45,000) / 174 = 4.397`. That population
 * is deliberately the right one to calibrate against — it is a real backlog
 * on this fleet, and the concrete false positive being prevented is exactly
 * what happens when THAT backlog is re-enqueued through the post-#3610
 * path: 174 entries become 765 with not one new memory behind them.
 *
 * Two honest limits on this number:
 *  - It is the BACKLOG distribution, which skews large (small retains drain
 *    first and are not in it). Steady-state parts-per-memory is lower, so
 *    the factor is a conservative — i.e. quieter — one.
 *  - The worst single entry splits 23 ways at the 33,000 bound (17 at
 *    45,000), so a handful of very large memories can still move the depth a
 *    long way. That is the reason the absolute growth floor below is scaled
 *    at all.
 */
export const PARTS_PER_MEMORY = 6.0;

/**
 * Convert a threshold stated in MEMORIES into the spool's post-#3610 unit.
 *
 * `Math.round`, not `Math.ceil`, on purpose: `100 * 4.4` is 440.00000000000006
 * in IEEE-754 doubles, so `ceil` silently yields 441 while `20 * 4.4` (exact)
 * yields 88 — an operator-visible threshold that depends on float
 * representation is a bug waiting to be argued about. The factor is an
 * empirical ~4.4, so rounding to nearest is the honest operation, and
 * `thresholds.test.ts` pins the two resulting constants.
 */
function inParts(memories: number): number {
  return Math.round(memories * PARTS_PER_MEMORY);
}

/**
 * Spool depth below which queue growth is not worth waking anyone for.
 *
 * The intent is unchanged from the original 100: stay under a single
 * agent's observed steady spool so a fleet-wide problem cannot hide beneath
 * the floor, while a handful of in-flight retries never pages. The intent
 * is expressed in MEMORIES ({@link QUEUE_FLOOR_MEMORIES}); the constant the
 * evaluator compares against is that count converted into the spool's
 * post-#3610 unit, parts.
 *
 * 100 memories × 4.4 = 440 entries. Sanity check against B6: today's live
 * fleet holds 174 pre-split entries ≈ 765 parts, comfortably above 440 —
 * i.e. this backlog still reads as "deep enough to care about", which it
 * is. A drained fleet sits near zero and is silent.
 */
export const QUEUE_FLOOR_MEMORIES = 100;
export const QUEUE_FLOOR = inParts(QUEUE_FLOOR_MEMORIES);

/**
 * Growth over the rolling window that fires S2, as a fraction of the
 * window-start depth. Paired with {@link QUEUE_GROWTH_MIN_ABS} so a small
 * base can't fire on rounding.
 *
 * The queue is a retry spool: it is SUPPOSED to be non-zero and it is
 * supposed to drain. Alerting on depth alone would have paged continuously
 * through the legitimate 5,636 → 616 drain of B3. Alerting on GROWTH means
 * a draining queue is silent and a queue that turns around is not.
 *
 * The FRACTION needs no #3610 rescale — it is dimensionless, so converting
 * the queue's unit from memories to parts leaves it invariant.
 */
export const QUEUE_GROWTH_FRACTION = 0.1;

/**
 * Absolute growth floor, in the spool's post-#3610 unit.
 *
 * The original 20 meant "twenty distinct memories failed and stayed
 * failed". After #3610 twenty failing memories enqueue ~88 entries, and,
 * read the other way, a mere FIVE worst-case memories (17 parts each, B6)
 * would clear an unscaled floor of 20 — one bad hour of long transcripts
 * would page as if the spool had turned around. So the floor is the same
 * intent, converted: 20 memories × 4.4 = 88 parts.
 *
 * What this deliberately does NOT suppress: the one-time step when a
 * pre-split backlog is re-enqueued through the #3610 path (B6: 174 → 765).
 * That is a >4× jump in depth and it WILL fire the fraction test once. It
 * should — an operator watching this fleet's spool quadruple deserves to be
 * told, once, even though the cause is benign. Building migration-shaped
 * suppression into a watchdog is how watchdogs learn to stay quiet.
 */
export const QUEUE_GROWTH_MIN_ABS_MEMORIES = 20;
export const QUEUE_GROWTH_MIN_ABS = inParts(QUEUE_GROWTH_MIN_ABS_MEMORIES);

/**
 * Consecutive breaching checks before a signal fires (hysteresis in).
 * 2 checks = 30 min at the recommended 15-min cadence for the rate and depth
 * signals; the discrete container and memory-loss events fire on the first
 * observation because they are edges, not levels — they cannot flap.
 */
export const BREACHES_TO_FIRE_LEVEL = 2;
export const BREACHES_TO_FIRE_EDGE = 1;

/** Consecutive clean checks before a firing signal resolves (hysteresis out). */
export const CLEARS_TO_RESOLVE = 2;

/**
 * Re-notify cadence while a signal stays firing. One DM, then silence for
 * 6 h. Matches the `repeat_interval: 4h` order of magnitude the one working
 * Grafana → Telegram route on this host already uses, biased longer because
 * hindsight incidents are hours-to-days, not minutes.
 */
export const RENOTIFY_MS = 6 * 60 * 60 * 1000;

/** Default `/metrics` endpoint — hindsight runs `--network host` on 18888. */
export const DEFAULT_METRICS_URL = "http://127.0.0.1:18888/metrics";

/** Default container name the docker probe inspects. */
export const DEFAULT_CONTAINER = "switchroom-hindsight";

/**
 * Hard cap on the `/metrics` body we will read. B8 measured the live body at
 * 258,741 B — 4× the ~60 KB recorded a day earlier, so this cap is sized for
 * the growth, not for today's reading: 4 MB is ~16× the current body.
 */
export const METRICS_MAX_BYTES = 4 * 1024 * 1024;

/** `/metrics` fetch timeout. The endpoint answers in single-digit ms. */
export const METRICS_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────
// Recall SLIs — the READ half of memory
//
// Every threshold below was measured against the live fleet on 2026-07-27,
// over the trailing 200 rows of each agent's `recall_log.jsonl` (2109 rows,
// 12 agents). Fleet-wide readings at that moment:
//
//   own-bank timeout   86.0 %  (1023/1189 rows carrying bank_timings)
//   zero-memory        46.6 %  (983/2109 rows carrying result_count)
//   candidate pool     median 18   (per-agent: 0 for finn/klanker/overlord)
//   injected score     p50 0.0011  (n=284; gymbro 0.22, reggie 0.61 healthy)
//   recall p95         8053 ms     (p50 8023 ms — pinned at the 8 s budget)
//   consolidation      77 pending, oldest 3.98 h
//
// Each constant records BOTH the sick reading and the healthy one, because a
// threshold justified only by the incident is a threshold nobody can retune.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Own-bank timeout rate: warn / page.
 *
 * The agent's own bank is the one carrying its memory; a recall that misses
 * it has, in practice, no agent memory in it even when `result_count > 0`
 * (2026-07-26 snapshot: of 1148 own-bank timeouts, only 28 returned anything
 * at all, from the smaller side banks).
 *
 * 5 % / 15 % is TIGHTER than `doctor-recall-health.ts`'s 10 % / 25 %, and
 * deliberately so: doctor is a pull check an operator runs after they already
 * suspect something, while this pushes a DM. The regression it exists to
 * catch spent its first week in the 5-15 % band and its sixth at 97 %. A
 * healthy agent sits at 0 % — lawgpt, test-harness and kdogg all measured
 * exactly 0 on the same snapshot — so 5 % is not near the noise floor of a
 * working fleet, it is an order of magnitude above it.
 *
 * Today's fleet reading of 86 % pages, immediately and correctly.
 */
export const RECALL_OWN_BANK_TIMEOUT_WARN = 0.05;
export const RECALL_OWN_BANK_TIMEOUT_PAGE = 0.15;

/**
 * Zero-memory turn rate: warn / page.
 *
 * The rate at which recall completes and injects nothing. A genuinely empty
 * match IS normal — which is exactly why `doctor-recall-health.ts` refuses to
 * score `result_count` at all — so this threshold is set where "normal
 * emptiness" stops being a credible explanation rather than where emptiness
 * begins.
 *
 * The healthy end of this fleet measured 0 % (test-harness, kdogg), 14.4 %
 * (ziggy) and 22.5 % (lawgpt) — so a warn at 25 % clears every agent that is
 * working, and a page at 40 % means the majority of turns are running blind.
 * Today's fleet reading is 46.6 % and pages; carrie is at 85.5 %.
 *
 * This is a WEAKER signal than the two below and is kept as corroboration,
 * not as the primary: on its own it cannot separate "the index is empty" from
 * "the queries genuinely match nothing".
 */
export const RECALL_ZERO_MEMORY_WARN = 0.25;
export const RECALL_ZERO_MEMORY_PAGE = 0.4;

/**
 * Candidate-pool floor: median `pre_cap_count + overlap_dropped`.
 *
 * **This is one of the two signals that catch the failure nothing else sees.**
 * A recall can be fast, return HTTP 200, time out nowhere, and still hand the
 * agent nothing — because the candidate pool it ranked was empty. Latency
 * signals miss it (it is fast), timeout signals miss it (nothing timed out),
 * result-count signals half-miss it (an empty match looks identical), and
 * `probeHindsight`'s MCP `initialize` misses it entirely.
 *
 * `pre_cap_count` is measured AFTER the overlap gate, so `overlap_dropped` is
 * added back: scoring the post-gate number alone would read an aggressive
 * overlap gate as an empty index, which points at the wrong fix.
 *
 * The healthy fleet median is 28-40 (clerk 40, test-harness 38, gymbro 36,
 * carrie 29, ziggy 29, marko 28). A median under 8 means half of all recalls
 * had almost nothing to rank; under 3 means the retrieval layer is returning
 * essentially nothing and the reranker is decorating noise. finn, klanker and
 * overlord all measured a median of **0** on 2026-07-27 — this signal pages
 * on them today and no other check in the repo notices.
 */
export const RECALL_POOL_MEDIAN_WARN = 8;
export const RECALL_POOL_MEDIAN_PAGE = 3;

/**
 * Injected top-hit score: p50 of `injected_score_max`.
 *
 * **The second signal that catches the invisible failure.** Where the pool
 * floor asks "was there anything to rank", this asks "was what we injected
 * worth injecting". They fail independently: a healthy-sized pool of
 * irrelevant candidates clears the floor and still poisons the turn, and
 * #3541 shipped this field precisely because volume alone cannot distinguish
 * "the reranker is working" from "8 mediocre memories per turn".
 *
 * `injected_score_max` is the BEST score in the injected set, so it is a
 * generous measure — a p50 of 0.01 means half of all turns had no injected
 * memory scoring above 0.01, i.e. the strongest thing the agent was given was
 * indistinguishable from noise.
 *
 * Healthy agents measured 0.61 (reggie), 0.22 (gymbro) and 0.061 (ziggy) —
 * two orders of magnitude above the warn line. The degraded ones measured
 * 0.0005-0.0042. Today's fleet p50 is 0.0011 and pages.
 *
 * NOTE the denominator: `injected_score_max` is null when nothing was
 * injected, so this SLI scores only rows that DID inject. That is on purpose
 * — the empty case is `recall-zero-memory`'s job, and folding it in here
 * would make one bad signal out of two good ones.
 */
export const RECALL_SCORE_P50_WARN = 0.05;
export const RECALL_SCORE_P50_PAGE = 0.01;

/**
 * Recall p95 wall time: warn / page, in ms.
 *
 * `total_elapsed_ms` is the recall hook's whole critical path. The hook's own
 * budget is 12 s (`vendor/hindsight-memory/hooks/hooks.json`) and the
 * per-bank budget is 8 s, so a p95 near 8 000 ms means the tail is not slow —
 * it is *pinned at the deadline*, i.e. timing out. Today's fleet p50 is
 * 8023 ms and p95 is 8053 ms: the distribution has collapsed onto the budget.
 *
 * 4 s / 6 s sits above the 0.6-4.3 s an unloaded server answers in and below
 * the 8 s wall. It is deliberately CORRELATED with own-bank-timeout rather
 * than independent — at an 8 s per-bank budget, a p95 over 6 s essentially
 * means >5 % of recalls timed out. It earns its place by catching the
 * approach: latency degrades through the 4-6 s band for days before enough
 * requests cross 8 s to move the timeout rate, so this is the early warning
 * and the timeout rate is the confirmation. Both firing at once is expected
 * and is not double-paging a single fault by accident — it is a fault severe
 * enough to have crossed two independent lines.
 */
export const RECALL_P95_WARN_MS = 4_000;
export const RECALL_P95_PAGE_MS = 6_000;

/**
 * Consolidation queue age: warn / page, in seconds.
 *
 * The `async_operations` queue carries consolidation and the retain
 * pipeline's deferred work. A rising oldest-entry age means the workers are
 * not draining it — memory is accepted and then never actually consolidated.
 *
 * 2 h matches `SWITCHROOM_HINDSIGHT_QUEUE_LAG_WARN_S` in
 * `docker/hindsight-maintenance.sh`, which already computes this exact number
 * — and then only writes it to a container log nobody reads. Reusing the
 * number rather than inventing one keeps the two views consistent; the change
 * here is that breaching it now reaches a human.
 *
 * 12 h for the page: past half a day the backlog is no longer a transient
 * spike, and the entries at the head are old enough that the sessions that
 * produced them are over.
 *
 * Live reading 2026-07-27: 77 pending, oldest 14 327 s (3.98 h) — warns
 * today, does not page. That is the intended resolution: a real, ongoing
 * degradation that is not yet an emergency.
 */
export const CONSOLIDATION_AGE_WARN_S = 2 * 60 * 60;
export const CONSOLIDATION_AGE_PAGE_S = 12 * 60 * 60;

/**
 * Minimum scored rows before a recall SLI is trusted.
 *
 * Below this a single bad recall dominates the rate and the signal would flap
 * on a quiet fleet. 30 is ~1.5 % of the 2109-row live window and is reached
 * by every non-idle agent. Under the floor the verdict is `no-data`, which is
 * inert: it neither fires nor silently resolves a live alert.
 */
export const RECALL_MIN_SAMPLES = 30;

/**
 * Hindsight LLM-lane failure rate: warn / page.
 *
 * ## Why this is the fallback signal, and why it is not inverted
 *
 * LiteLLM's router fallback is **inside one client request**: hindsight asks
 * for `openai/gpt-oss-20b-retain`, the router tries the local deployment,
 * fails, and hops to `gpt-oss-20b-retain-openrouter` — all within the single
 * call hindsight is awaiting (`src/litellm/timeout-budget.ts`). Hindsight
 * therefore records the model it ASKED for, never the one that served, and
 * `hindsight_llm_calls_total` carries no OpenRouter series at all (verified:
 * 0 matching series on the live endpoint, 2026-07-27).
 *
 * The useful consequence is that this counter already answers the question we
 * want asked. `success="false"` on a gpt-oss lane means the local deployment
 * failed **and the OpenRouter fallback did not rescue it** — which is exactly
 * "the fallback is not working", stated positively. A fallback that never
 * fires can no longer read as clean, because the local failures it failed to
 * absorb are the numerator.
 *
 * That is the un-inversion. The check alerts on the fallback FAILING, and
 * never on OpenRouter merely serving — the latter is a legitimate,
 * subscription-honest lane for the local gpt-oss models and is policed
 * separately, on credential scoping, by
 * `src/fleet-health/litellm-config-sensor.ts`.
 *
 * Live baseline 2026-07-27: 800 calls, **0 failures** (0.00 %). So a 2 % warn
 * is not near the noise floor — there is no noise floor. It is set low
 * because a working fallback should absorb essentially everything, and the
 * defect class it guards (a timeout-budget mismatch that cuts the fallback
 * hop off mid-flight) turns *every* failover into a guaranteed error rather
 * than a rare one — so the failure mode is a step change, not a drift.
 */
export const LLM_FAILURE_RATE_WARN = 0.02;
export const LLM_FAILURE_RATE_PAGE = 0.1;

/**
 * Minimum LLM calls in the window before the failure rate is scored.
 *
 * Hindsight issued 800 calls in the observed period; an idle hour can issue
 * none. Under the floor the signal is `no-data` rather than a 0 % pass.
 */
export const LLM_MIN_SAMPLES = 20;
