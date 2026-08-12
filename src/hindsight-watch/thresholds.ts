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

import { resolveHindsightRecallTunables } from "../setup/hindsight-recall-tunables.js";

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
 * Hard cap on the `/metrics` body we will read.
 *
 * B8's "258,741 B, so 4 MB is ~16× the current body" is STALE by 7×.
 * Re-measured on the live endpoint 2026-07-27: the body is **1,889,558 B**,
 * which made the old 4 MB cap 2.1×, not 16×. And this change adds
 * `HINDSIGHT_API_METRICS_INCLUDE_BANK_ID`, whose worst case is ~27 banks ×
 * the 45,490 B `hindsight_operation_*` block ≈ 1.2 MB more, landing near
 * 3.1 MB — 76 % of a 4 MB cap. One more metric family, or a fleet twice this
 * size, crosses it.
 *
 * 16 MB restores an ~5× margin over the projected post-change body. The cap
 * exists to stop an unbounded read, not to police growth; at 16 MB it still
 * refuses a runaway exposition long before memory pressure matters.
 *
 * Sizing it correctly used to be far more load-bearing than it should have
 * been, because the OVERRUN was fatal: `probe.ts` threw, the throw surfaced
 * as a `ProbeError`, and that took out the retain and LLM signals too — a
 * body one byte over the cap blinded every metrics-derived signal at once,
 * and the recall signals with them. It now degrades: the metrics probe
 * returns null and only the metrics-derived signals go `no-data` (see
 * `probe.ts`). An overrun costs exactly the signals that cannot be computed
 * and nothing else. The raised cap and the degrade are belt and braces,
 * deliberately — a cap whose breach is silent is not a safety mechanism.
 */
export const METRICS_MAX_BYTES = 16 * 1024 * 1024;

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
//   recall p95         8053 ms     (p50 8023 ms — pinned at the then-8 s wall,
//                                    retired by #3759; see RECALL_WALL_MS)
//   consolidation      77 pending, oldest 3.98 h
//
// Each constant records BOTH the sick reading and the healthy one, because a
// threshold justified only by the incident is a threshold nobody can retune.
//
// THE HEALTHY READING IS THE ONE THAT SETS THE LINE, and it has to be drawn
// from the right population. The fleet reading above is measured DURING the
// incident, so it says only "this is broken now" — it cannot say whether a
// threshold survives the fix. The population that can is rows where no bank
// timed out, errored, or hit the shared deadline: the best available proxy
// for a repaired fleet. Over full log history that is n=183 across 9 agents:
//
//   own-bank timeout   0 %       (by construction — this is the conditioner)
//   zero-memory        15.3 %    (warn 25 % → 1.6× headroom, the thinnest)
//   candidate pool     median 41 (warn 8 → 5×, page 3 → 13×)
//   injected score     p50 0.0850, but p10 0.0005 … p90 0.9259
//   recall wall time   p50 6420 ms, p95 8037 ms  ← see RECALL_P95, deleted
//
// Two of the originally-proposed lines did NOT survive that test and were
// re-derived (injected-score warn) or deleted (latency) rather than shipped.
// A threshold is only calibrated once it has been checked against a fleet
// that is WORKING; checking it against the outage only proves it can see the
// outage, which is the easy half.
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
 * PAGE at 0.01 is the well-founded line. Conditioned on a healthy own bank
 * (n=74) the p50 is 0.0850; conditioned on a degraded one (n=247) it is
 * 0.0006 — a ~140× separation, and 98.4 % of degraded rows fall below 0.01
 * against 28.4 % of healthy ones. A 3000-draw bootstrap of the fleet p50 over
 * healthy rows fires at 0.01 in 0.0 % of draws at every window size tried.
 *
 * WARN was 0.05 and that was WRONG — it is the correction worth recording.
 * The healthy distribution is not merely wide, it is bimodal, spanning p10
 * 0.0005 to p90 0.9259: about 3.5 orders of magnitude, because the score is
 * not calibrated across queries. Its p50 of 0.0850 sits only 1.7× above a
 * 0.05 line, so bootstrapping the fleet p50 over healthy rows fires in
 * **22.8 %** of 60-row draws and 15.1 % of 100-row draws — better than one
 * healthy tick in seven. Hysteresis does not rescue that: consecutive ticks
 * read overlapping 200-row / 24 h windows, so their breaches are correlated,
 * not independent, and `BREACHES_TO_FIRE_LEVEL = 2` is close to a single
 * draw. An earlier revision of this comment also claimed ziggy's healthy
 * 0.061 was "two orders of magnitude above the warn line"; it is 1.2×, and
 * ziggy is the number that GOVERNS, being among the lowest healthy readings.
 * That arithmetic error is what let the line through.
 *
 * 0.02 is the re-derived warn: 0.8 % of 60-row healthy draws and 0.0 % at
 * 100 rows and above, while 98.8 % of degraded rows still fall below it and
 * it stays ~33× above the degraded p50. Healthy per-agent p50s: finn 0.7523,
 * reggie 0.5861, gymbro 0.2221, overlord 0.0674, ziggy 0.0601, klanker
 * 0.0226, marko 0.0182. The last two sit near the line — they are also the
 * two whose recall was recovering during the sample, and both are far above
 * the 0.0006 a degraded bank produces.
 *
 * The narrow 0.02 → 0.01 band is an honest limitation, not an oversight: on
 * a bimodal distribution the p50 is a poor estimator, so a genuinely EARLY
 * warning needs a different statistic, not a different constant. The measured
 * candidate is the fraction of injected rows scoring below a fixed floor —
 * healthy 28.4 % vs degraded 98.4 % at a 0.01 floor, which bootstraps to
 * 0.00 % false-fire and 100 % detection anywhere in a 0.60-0.90 threshold
 * band. Filed as follow-up #3793 rather than swapped in here, because changing
 * the estimator changes what the signal MEANS and that deserves its own
 * review, not a post-review substitution.
 *
 * NOTE the denominator: `injected_score_max` is null when nothing was
 * injected, so this SLI scores only rows that DID inject. That is on purpose
 * — the empty case is `recall-zero-memory`'s job, and folding it in here
 * would make one bad signal out of two good ones.
 */
export const RECALL_SCORE_P50_WARN = 0.02;
export const RECALL_SCORE_P50_PAGE = 0.01;

/**
 * The recall wall-time wall the diagnostic p95 is read against, in ms.
 *
 * NOT a fresh literal. #3759 made the recall deadline a DECLARATIVE envelope
 * (`src/setup/hindsight-recall-tunables.ts`), exported fleet-wide via
 * `HINDSIGHT_RECALL_*` (`src/agents/scaffold.ts`) — the highest-precedence
 * layer of hindsight's config load order. The shared parallel fan-out deadline
 * that bounds `total_elapsed_ms` is resolved there; taking it from the resolver
 * (no operator overrides = the stock envelope) means this number tracks the
 * envelope automatically instead of going stale the way the retired hardcoded
 * `8000` did. The stock resolution is 12 s hook ceiling − 2 s headroom = 10 s
 * (10000 ms), and the per-bank request timeout derives to the same 10 s — so
 * whichever way you read "the wall", it is this one number now, not 8 s.
 */
export const RECALL_WALL_MS =
  resolveHindsightRecallTunables(undefined).parallelDeadlineSeconds * 1000;

/*
 * ── B12. The 2026-08-01 → 08-07 quality degradation, and why NONE of the
 *         four signals above could see it ─────────────────────────────────
 *
 * Every threshold above is an ABSOLUTE FLOOR, calibrated so that a fleet which
 * has COLLAPSED trips it and a working fleet never does. That is the correct
 * shape for the six-week outage they were built for. It is the wrong shape for
 * a degradation, and the fleet ran one for a week with all fourteen signals
 * green.
 *
 * Measured 2026-08-12 over every agent's `recall_log.jsonl`, cache hits
 * excluded, one row per real recall (`n` is fleet-wide rows for that UTC day):
 *
 *   day     n    lat p50   lat p95   top-hit p50   pool p50   deadline_hit
 *   08-01   570   6660 ms   9037 ms      0.5493        58        22.3 %
 *   08-02   441   7801 ms   9033 ms      0.2856        61        37.2 %
 *   08-03   431   7993 ms   9034 ms      0.1857        78        39.2 %
 *   08-04   488   5749 ms   9029 ms      0.5593        89        12.5 %
 *   08-05   452   6161 ms   9028 ms      0.6046        85        17.9 %
 *   08-06   552   6173 ms   9034 ms      0.5700        83        26.6 %
 *   08-07   381   5111 ms   9031 ms      0.6593        87        15.7 %
 *   ── recall repaired 08-08 ──────────────────────────────────────────────
 *   08-08   492   1263 ms   2778 ms      0.8759        90         0.2 %
 *   08-09   358   1251 ms   4316 ms      0.8459        95         0.0 %
 *   08-10   457   1121 ms   1545 ms      0.8638        97         0.0 %
 *   08-11   440   1090 ms   1455 ms      0.8953        90         0.0 %
 *
 * Why each existing signal stayed silent, in its own terms:
 *
 *   - `RECALL_SCORE_P50_WARN` is 0.02. The worst daily reading was 0.1857 —
 *     9× above the warn line — while quality had fallen ~5× off its own
 *     baseline. The floor is set where injected memory becomes indistinguish-
 *     able from noise, and a 5× regression never gets there.
 *   - `RECALL_POOL_MEDIAN_WARN` is 8. The pool GREW, 58 → 87. A floor cannot
 *     fire on a metric moving the right way while the thing it proxies for
 *     moves the wrong way.
 *   - `RECALL_OWN_BANK_TIMEOUT_*` reads own-bank failure, and the own bank was
 *     answering. Slowly, but answering.
 *   - Latency carried no threshold at all — the deletion note this block
 *     replaces.
 *
 * The three constants below are the response, and each is a DIFFERENT kind of
 * instrument from a floor: an absolute latency line (now that a healthy band
 * exists), a self-relative quality line, and a line against the deadline.
 */

/**
 * Recall wall-time p95: warn / page, in ms.
 *
 * THE PRIOR DELETION WAS CORRECT AND ITS PRECONDITION HAS NOW BEEN MET. The
 * signal was drafted at 4 s / 6 s and deleted twice, both times because the
 * "healthy" population it was calibrated against was itself running AT the
 * wall: n=183 conditioned rows from 2026-07-27 read p50 6420 ms / p95 8037 ms,
 * right-censored at the then-8 s per-bank timeout. Against that population any
 * line below the wall fires on healthy traffic, and
 * `recall-log.test.ts` still asserts exactly that, on the same fixture. The
 * removal named its own precondition — "a re-baseline against a fleet whose
 * recall is BOTH fixed AND running the 10 s envelope" (follow-up #3792). That
 * fleet now exists.
 *
 * The healthy population is `repaired-fleet.fixture.ts`: the half-open window
 * 2026-08-10 00:00 → 08-13 00:00 UTC, UNCONDITIONED because it needs no
 * conditioning — over 972 rows, 3 had a degraded own bank and ZERO hit the
 * deadline. It reads
 *
 *   p50 1093 ms   p90 1347 ms   p95 1477 ms   max 2759 ms
 *
 * against a `deadline_effective_ms` of ~9993 ms. That is a healthy band of a
 * kind that has never previously been measurable here: the whole healthy
 * distribution now sits at ~15 % of the wall, where in July it sat at ~80 %.
 *
 * WARN 3000 ms is 2.0× the healthy p95 and above the slowest single healthy
 * recall observed (2759 ms). PAGE 6000 ms is 4.0× it. Both are far below the
 * sick era's 9027-9037 ms, so the whole of 08-01 → 08-07 pages — verified by
 * replaying the real logs through the tick reduction at the true 15-minute
 * cadence: 96/96 ticks per day page across all seven days, and 0/337 ticks
 * fire anywhere from 08-09 00:00 onward.
 *
 * THE ONE CAVEAT, recorded rather than hidden, and measured in the unit that
 * actually matters. The same replay breaches the WARN arm on 138 of the 480
 * ticks from 08-08 onward, which sounds alarming and is the wrong number to
 * reason about: a breaching tick is not a DM. Hysteresis
 * ({@link BREACHES_TO_FIRE_LEVEL} to fire, {@link CLEARS_TO_RESOLVE} to
 * resolve, {@link RENOTIFY_MS} between reminders) collapses those 138 ticks
 * into EIGHT messages —
 *
 *   08-08  fire + 3 six-hourly reminders, resolved 22:30
 *   08-09  fire 23:30, 1 reminder, resolved 08-10 11:45
 *   08-11 onward  0/192 ticks breach, 0 messages
 *
 * — every one of them on the incident's own recovery tail. A tick reads a
 * trailing 24 h window, so through 08-09 and 08-10 that window still contains
 * the tail (08-09 rows reach p99 7238 ms) and the trailing p95 peaks at
 * 4578 ms before settling under 1600 ms from 08-11 onward. Eight DMs telling
 * the operator recall is still slow while recall was still slow is the signal
 * working, not chatter, and the steady state is silence.
 *
 * The alternative considered and rejected was warn 6000 / page 8000, 1.31×
 * above that 4578 ms recovery peak, which emits 3 messages instead of 8. It
 * buys five fewer DMs across one recovery in exchange for doubling the
 * detection floor permanently, and it is NOT a drop-in retune: 6000 as a warn
 * would put a fleet running a 7000 ms p95 — slow, and completing, so
 * `recall-deadline-pinning` stays silent on it — one arm away from unwatched.
 * `recall-degradation.test.ts` pins that shape deliberately. If this ever does
 * need retuning, re-derive it against a fresh capture rather than adopting
 * these numbers.
 */
export const RECALL_P95_WARN_MS = 3000;
export const RECALL_P95_PAGE_MS = 6000;

/**
 * Recall-quality regression against the fleet's OWN trailing baseline: the
 * fractional drop that warns / pages.
 *
 * This is the signal built for B12 specifically, and it is the only one in
 * this file that is not an absolute line. It asks a different question — not
 * "is recall broken" but "is recall materially worse than it has recently
 * been" — and that is the question the 08-01 → 08-07 week needed asked.
 *
 * Scored on the SAME two statistics the floors use (`scoreP50`, `poolMedian`),
 * OR'd, because they fail independently and the incident moved only one of
 * them. The comparison is the current tick against the MEDIAN of the previous
 * `RECALL_BASELINE_DAYS` completed days, each day itself reduced to the median
 * of its ticks — medians throughout, so neither one bad tick nor one bad day
 * can set or spoil the line.
 *
 * 40 % / 60 % replayed against the real logs (baseline warmed from 07-20,
 * scored on each day's WORST tick):
 *
 *   08-02  baseline 0.6465 → worst tick 0.2770   57.2 % drop   WARN
 *   08-03  baseline 0.6465 → worst tick 0.0572   91.2 % drop   PAGE
 *   08-04  baseline 0.6465 → worst tick 0.1857   71.3 % drop   PAGE
 *   08-05 … 08-12                                   ≤37.2 %    silent
 *
 * So it fires on 08-02, four days into a week nothing else saw, and goes quiet
 * once the repair lands. Note what it does NOT do: by 08-05 the degradation is
 * IN its own baseline and the signal stops. That is inherent to a trailing
 * baseline and is stated here rather than papered over — this signal catches
 * the ONSET of a regression, not its plateau. A plateau is what the absolute
 * floors are for, and if a plateau sits between the two, that gap is real.
 *
 * A relative drop is meaningless when the baseline is already at the floor
 * (0.002 → 0.0005 is a "75 % regression" on a fleet that is simply broken, and
 * already paging from `recall-injected-score`), so each arm requires its
 * baseline to sit above that arm's absolute WARN line before it will score —
 * see `evaluateRecallQualityRegression`. That reuses the existing constants
 * deliberately: the two signals then partition the space instead of both
 * shouting about the same collapse.
 */
export const RECALL_QUALITY_DROP_WARN = 0.4;
export const RECALL_QUALITY_DROP_PAGE = 0.6;

/**
 * Trailing baseline window, in completed UTC days, and the minimum before the
 * signal will score at all.
 *
 * 7 days because a shorter window absorbs a slow regression into its own
 * baseline faster (the 08-05 blind spot above gets worse), and a longer one
 * starts comparing against a materially different fleet — agents are added,
 * banks grow, and the query mix moves. 3 days minimum so a fresh install or a
 * restored state file reports `no-data` rather than firing off one day of
 * history.
 */
export const RECALL_BASELINE_DAYS = 7;
export const RECALL_BASELINE_MIN_DAYS = 3;

/**
 * Per-day observation cap, per series. The bound on the whole baseline is
 * `(RECALL_BASELINE_DAYS + 1) × RECALL_BASELINE_MAX_OBS_PER_DAY × 2` numbers —
 * 1536 at these values, ~15 KB of JSON, next to a `ring` that already carries
 * far more.
 *
 * 96 is a full day at the recommended 15-minute cadence, so in production
 * nothing is ever dropped. A faster cadence drops the OLDEST observations of
 * that day, which keeps the cap hard and the day's median honest (it becomes
 * the median of that day's most recent 96 ticks, not of a biased subsample).
 */
export const RECALL_BASELINE_MAX_OBS_PER_DAY = 96;

/**
 * Deadline pinning: the share of recalls that were CUT OFF, warn / page, as a
 * fraction of the rows that carry a boolean `deadline_hit`.
 *
 * A DIFFERENT failure from `recall-latency`, which is why it is a different
 * signal: a p95 of 6 s against a 10 s wall means recall is slow and completing;
 * a window where a third of recalls hit the wall means that third never
 * completed at all and those agents were handed whatever had arrived by then.
 * The two need different remedies (make it faster vs raise the ceiling / find
 * what hangs), so collapsing them would put the wrong fix in the DM.
 *
 * WHY A RATE AND NOT `p95 / deadline_effective_ms` — this signal shipped in
 * #4614 as `p95 >= 0.90 × deadline`, and review was right to reject it. That
 * fraction is not a health measurement, it is a comparison of two independent
 * config knobs:
 *
 *   - `parallel_deadline_seconds` (10) is the fan-out wall, and it is what
 *     `deadline_effective_ms` reports. `parallel_recall.py:128-129` grants a
 *     straggler the whole remaining budget with no epsilon.
 *   - `request_timeout_seconds` (9, fleet-wide) is a SEPARATE per-request
 *     ceiling — `recall.py:2088` → `client.py:127`'s `urlopen(timeout=)`.
 *
 * The observed ~9.03 s truncation point is the SECOND knob, so the ratio was
 * really measuring 9/10. `switchroom.yaml` records that knob being revised
 * 8 → 9 on 2026-07-29 ("still one full second below the shared
 * parallel_deadline_seconds (10)"), which is exactly the step in the data:
 * timed-out slots have a median of 8018 ms before that date and 9019 ms after.
 * An operator moving either knob moves the verdict without anything about
 * recall having changed.
 *
 * That is not hypothetical. Replaying the log with the ratio, the week of
 * 07-20 → 07-26 (n = 1768, knob at 8) scores 0.803-0.806 — UNDER the 0.90
 * line, silent — while 84-95 % of every recall on those days hit the deadline.
 * The ratio was blind to the worst week in the record and got there by scoring
 * it as HEALTHIER (0.81) than the milder August incident (0.90). The rate is
 * config-independent and monotone in the harm:
 *
 *   era                       n      deadline_hit %   old ratio   old verdict
 *   07-20 → 07-26 (knob 8)   1768        84.0-95.0    0.80-0.81   SILENT (!)
 *   08-01 → 08-07 (knob 9)   3315        12.5-39.2    0.90-0.90   page
 *   08-08 → 08-12 (repaired) 1821         0.0- 0.2    0.13-0.43   silent
 *
 * 0.05 / 0.20 derived from that separation. The healthy CEILING is 0.2 % over
 * 1821 post-repair rows, so warn sits 25× above the worst healthy day and page
 * 100× above it, while the sick FLOOR is 12.5 % — every one of 08-01 → 08-07
 * clears warn (12.5, 15.7, 17.9 → warn; 22.3, 26.6, 37.2, 39.2 → page) and
 * every day from 08-08 on is silent on both. A 60× gap is what earns a
 * two-tier split here: the old ratio's 6× spread genuinely could not support
 * one, which is why it carried a single severity, and this one can.
 */
export const RECALL_DEADLINE_HIT_WARN = 0.05;
export const RECALL_DEADLINE_HIT_PAGE = 0.2;

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
 * ── B9. The 2026-07-29 consolidation outage, and why the signal above could
 *        not see it ──────────────────────────────────────────────────────
 *
 * The `overlord` bank's consolidation job failed on ~every attempt from 04:28
 * to 07:09 UTC on 2026-07-29, backing up 38,000 unconsolidated memories. No
 * signal fired. It was found because the operator happened to ask.
 *
 * `CONSOLIDATION_AGE_*` above is measured against `status IN ('pending',
 * 'processing')` (`probeConsolidationQueue`), and the failing path calls
 * `_mark_operation_failed` immediately — so a failed row leaves that set
 * within milliseconds. `evaluateConsolidationQueueAge` then reads `pending
 * === 0` and returns `state: "ok"` — its detail no longer claims
 * `"consolidation queue empty"` (that all-clear string was corrected by #3989
 * to name where failures ARE counted), but the SIGNAL is still structurally
 * blind here. The measurement is INVERTED: the more reliably a bank fails, the
 * healthier it reads. That is not a threshold set too high; it is a set the
 * evidence cannot enter.
 *
 * Live measurements taken on the production host, read-only, 2026-07-29
 * 07:1x UTC (the incident's tail, ~10 min after the corrupt index was
 * rebuilt), and used to set every constant below:
 *
 *  B9a  Streak query — `failed` rows newer than the pair's last `completed`
 *       row, grouped by `(bank_id, operation_type)`:
 *         overlord | consolidation | 103 | 668 s
 *       and NOTHING else across 20 banks. One row, one bank, one op type:
 *       the healthy floor for this measurement is literally zero.
 *  B9b  Same window, `(bank, op_type, status)` census: `overlord` held 3,753
 *       COMPLETED retains and 3,753 completed batch_retains against those
 *       112 failed consolidations. A bank-wide streak is therefore useless —
 *       every successful retain would reset it.
 *  B9c  Per-bank `pending_consolidation` across the fleet:
 *         overlord 38,130 · carrie 45 · switchroom-dev 12 · every other
 *         bank 0 (n = 20 banks, 676,720 memory units).
 *       The largest HEALTHY reading is 45. Absolute depth is still the wrong
 *       threshold — a bank mid-ingest legitimately runs deep and the number
 *       is unbounded — but it bounds the floor below which growth is not
 *       worth looking at.
 *  B9d  Every `failed` row carried `different vector dimensions 384 and 0`,
 *       raised out of an HNSW index scan. `memory_units.embedding` is
 *       `vector(384)` and 0 rows have `vector_dims(embedding) <> 384`, so the
 *       damage is inside the index structure, not in the data.
 *  B9e  Canary cost: 89 HNSW indexes probed in 0.45 s wall (one `docker
 *       exec`), 0 corrupt at the time of measurement.
 */

/**
 * Consecutive terminal consolidation failures for one `(bank, operation_type)`
 * pair: warn / page.
 *
 * **3** to warn because the healthy fleet's streak is 0 (B9a) — there is no
 * band of "a few failures are normal" to sit above. Three consecutive
 * failures with no completion in between is already the signature of a
 * deterministic, non-retryable fault rather than a flake, and at the
 * 15-minute cron cadence the incident's failure rate (112 failures over
 * 2.7 h ≈ one per 87 s) clears 3 inside the FIRST tick after onset.
 *
 * **10** to page: a fault that has survived ten attempts is not going to
 * retry its way out, and the bank has been unconsolidated long enough that
 * recall against it is already degraded.
 *
 * Deliberately NOT keyed on the incident's error string. Any deterministic
 * non-retryable consolidation failure — a corrupt index, a poisoned row, a
 * schema drift, an LLM contract change — produces the same shape, and the
 * shape is what is thresholded.
 */
export const CONSOLIDATION_FAILURE_STREAK_WARN = 3;
export const CONSOLIDATION_FAILURE_STREAK_PAGE = 10;

/**
 * How fresh the newest failure in a streak must be for the streak to count.
 *
 * Without this the signal never resolves: a streak is defined relative to the
 * last COMPLETED op, so a bank that is fixed but idle (no new consolidation
 * demand) keeps its historical streak forever and alerts forever. Two hours
 * bounds the post-fix tail while still being several times the observed
 * inter-failure gap during the incident (87 s), so an ongoing fault cannot
 * age itself out mid-incident.
 */
export const CONSOLIDATION_STREAK_RECENCY_S = 2 * 60 * 60;

/**
 * Per-bank unconsolidated depth: the floor below which GROWTH is not worth
 * scoring, and the growth thresholds themselves.
 *
 * Growth, not absolute depth, because absolute depth has no defensible line:
 * `klanker` holds 202,549 memory units and a bank mid-ingest legitimately
 * carries thousands of unconsolidated ones, so any absolute threshold is
 * either noise or useless (B9c). What is NOT legitimate is a depth that only
 * ever goes up.
 *
 * The shape deliberately mirrors {@link QUEUE_FLOOR} /
 * {@link QUEUE_GROWTH_FRACTION} / {@link QUEUE_GROWTH_MIN_ABS} — the same
 * "deep AND rising" conjunction, applied per bank instead of to one fleet
 * series — so there is one growth idiom in this file, not two.
 *
 *  - **500 floor**: an order of magnitude above the largest healthy reading
 *    (45, B9c), so an ordinary ingest burst never reaches the conjunction.
 *  - **50 % fraction / +500 absolute** to warn over the ~2 h window
 *    (`RING_MAX` × 15 min).
 *  - **+5000 absolute** to page. The incident grew ~38,000 in 2.7 h ≈
 *    14,000/h ≈ 28,000 per window: it pages on the first full window.
 */
export const PENDING_CONSOLIDATION_FLOOR = 500;
export const PENDING_CONSOLIDATION_GROWTH_FRACTION = 0.5;
export const PENDING_CONSOLIDATION_GROWTH_WARN_ABS = 500;
export const PENDING_CONSOLIDATION_GROWTH_PAGE_ABS = 5000;

/**
 * Rows the HNSW canary samples per index.
 *
 * Each sampled row costs one nearest-neighbour search. 3 is enough that the
 * probe walks the graph rather than getting lucky on an entry point, and the
 * whole sweep — 89 indexes — measured 0.45 s (B9e). Raising it multiplies the
 * only cost this probe has.
 */
export const VECTOR_INDEX_SAMPLE_ROWS = 3;

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
