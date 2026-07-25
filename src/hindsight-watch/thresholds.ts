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
 * Minimum retain observations in the rolling window before the rate and
 * latency signals are allowed to fire. A "50 % failure rate" over 2 retains
 * is noise, and hindsight goes genuinely idle overnight. Below this the
 * signal reports `insufficient-data`, which neither fires NOR clears — a
 * quiet night can't silently resolve a live alert.
 *
 * 20 ≈ the retain volume of a single busy 15-minute interval (B2 saw 17
 * retains complete in ~5 minutes of drain), so a real storm crosses it
 * within one interval and a quiet fleet crosses it within the 2 h window.
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
 */
export const RETAIN_FAILURE_RATE = 0.1;

/**
 * Retain p95 (seconds) that fires S4, the early-warning signal.
 *
 * 120 s is 1.7× the measured p95 (B2: 69.9 s), above the worst single retain
 * ever observed (76.4 s), 40 % of the client's retain LLM timeout (B5: 300 s)
 * — so it fires BEFORE retains start timing out — and is the largest finite
 * histogram bucket (B4), i.e. the highest threshold the exposition can
 * resolve. A p95 that lands in `+Inf` is reported as "> 120 s" and fires.
 */
export const RETAIN_P95_SECONDS = 120;

/**
 * Spool depth below which queue growth is not worth waking anyone for.
 *
 * 100 is under a single agent's observed steady spool (B3: klanker 124,
 * marko 119, finn 115 while draining), so it cannot mask a fleet-wide
 * problem, and it stops a handful of in-flight retries from paging.
 */
export const QUEUE_FLOOR = 100;

/**
 * Growth over the rolling window that fires S2, as a fraction of the
 * window-start depth. Paired with {@link QUEUE_GROWTH_MIN_ABS} so a small
 * base can't fire on rounding.
 *
 * The queue is a retry spool: it is SUPPOSED to be non-zero and it is
 * supposed to drain. Alerting on depth alone would have paged continuously
 * through today's legitimate 5,636 → 616 drain (B3). Alerting on GROWTH
 * means a draining queue is silent and a queue that turns around is not.
 * 10 % / 2 h is roughly one agent's worth of new spool per window at the
 * observed fleet size.
 */
export const QUEUE_GROWTH_FRACTION = 0.1;
export const QUEUE_GROWTH_MIN_ABS = 20;

/**
 * Consecutive breaching checks before a signal fires (hysteresis in).
 * 2 checks = 30 min at the recommended 15-min cadence for the rate/latency/
 * depth signals; the discrete container and dead-retain events fire on the
 * first observation because they are edges, not levels — they cannot flap.
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

/** Hard cap on the `/metrics` body we will read (the live body is ~60 KB). */
export const METRICS_MAX_BYTES = 4 * 1024 * 1024;

/** `/metrics` fetch timeout. The endpoint answers in single-digit ms. */
export const METRICS_TIMEOUT_MS = 10_000;
