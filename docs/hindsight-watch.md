# hindsight-watch — the memory-backend watchdog

`switchroom hindsight-watch` is a **model-free** check that answers one
question on a schedule: *is the fleet's memory backend actually storing
memories?*

It exists because it was once possible for ~28 % of retains to fail for weeks
without anyone noticing — the telemetry was there (hindsight exports 28 metric
families on `/metrics`, and `switchroom doctor` already counts the spool), but
nothing **watched** it and nothing **told a human**. This closes that gap:
a deterministic check on a cron, alerting through the same gateway relay
hostd's degraded-boot notice uses.

Jobs served: `reference/jobs/fleet-stays-healthy.md` (the fleet watches
itself) in service of `reference/jobs/remember-across-sessions.md`.

## What it costs

Per tick: one HTTP GET of `/metrics` (258 741 B today), one `docker inspect`,
and per agent two `readdir`s plus one small `pending-drops.json` read. No
queue **entry** is ever opened — those carry whole transcripts (p50 ~98 KB).
Zero model tokens — no session, no LLM call, ever. At the recommended
15-minute cadence that is 4 requests an hour against a backend whose own
workers issue thousands.

## Signals

| Signal | Fires when | Kind |
|---|---|---|
| `probe` | `/metrics` unreachable, unparseable, or missing the retain series; `docker inspect` fails; the agents dir is unreadable | level |
| `retain-failure-rate` | ≥10 % of retains in the rolling window failed | level |
| `retain-queue-growth` | spool ≥440 entries deep **and** grew by ≥max(88, 10 %) across the window | level |
| `retain-loss` | any new `*.json.dead` marker, `pending-evicted/` entry, or `pending-drops.json` count — memory that left the queue without being persisted | edge |
| `container` | `switchroom-hindsight` unhealthy, restarted, or recreated | edge |
| `recall-own-bank-timeout` | >5 % (warn) / >15 % (page) of recalls had the agent's **own** bank time out or hard-error | level |
| `recall-candidate-floor` | median candidate pool (`pre_cap_count + overlap_dropped`) ≤8 (warn) / ≤3 (page) | level |
| `recall-injected-score` | p50 of `injected_score_max` ≤0.02 (warn) / ≤0.01 (page) | level |
| `recall-zero-memory` | >25 % (warn) / >40 % (page) of recalls injected nothing | level |
| `recall-latency` | recall wall-time p95 ≥3 000 ms (warn) / ≥6 000 ms (page) | level |
| `recall-quality-regression` | p50 `injected_score_max` **or** median candidate pool fell ≥40 % (warn) / ≥60 % (page) below its **own** trailing 7-day baseline | level |
| `recall-deadline-pinning` | recall p95 reaches ≥90 % of the per-row `deadline_effective_ms` — recalls being cut off rather than completing | level |
| `consolidation-queue-age` | oldest pending `async_operations` row ≥2 h (warn) / ≥12 h (page) | level |
| `consolidation-failure-streak` | ≥3 (warn) / ≥10 (page) consecutive **failed** `async_operations` for one `(bank, operation_type)` pair, newest within 2 h | edge |
| `pending-consolidation-depth` | one bank's unconsolidated memories ≥500 **and** grew by ≥max(500, 50 %) across the window (≥5 000 pages) | level |
| `vector-index-corruption` | a nearest-neighbour probe against an HNSW index raises | edge |
| `llm-fallback-ineffective` | ≥2 % (warn) / ≥10 % (page) of hindsight LLM calls failed outright | level |

The seven recall signals read `recall_log.jsonl` — the hook's own telemetry —
because **every layer of the recall path fails open** and none of the metrics
above can see it: `recall.py` exits 0 on a bank timeout (blocking the prompt
would be worse), Claude Code swallows hook stderr on a zero exit, the agent is
handed an empty context indistinguishable from "nothing relevant", and both
`probeHindsight` and the container healthcheck are satisfied by a recall path
that answers fast and empty. The fleet ran at 86 % own-bank timeout for six
weeks with every pre-existing signal green.

**`recall-candidate-floor` and `recall-injected-score` are the two that matter
most.** `doctor-recall-health.ts` deliberately does not score `result_count`
(an empty match is legitimately common), which leaves one failure shape
completely invisible: a recall that is fast, successful, and near-empty. Those
two signals are the only things that see it.

Both readings that set a recall threshold are recorded in
`thresholds.ts`: the one taken during the incident, and — the one that
actually decides the line — the one taken over rows where recall SUCCEEDED.
A threshold checked only against the outage proves it can see the outage,
which is the easy half; the hard half is not firing once the outage is over.
Two drafted lines failed that second check and were re-derived (injected-score
warn, 0.05 → 0.02) or deleted (recall latency) before shipping.

**The three consolidation signals exist because `consolidation-queue-age` is
inverted.** Its probe selects `FROM async_operations WHERE status IN
('pending','processing')`, so an operation that has FAILED is no longer in the
set being measured. When that count is zero `evaluateConsolidationQueueAge`
now reports `"no pending/processing operations (failures are not counted here
— see consolidation-failure-streak)"` rather than the old
`"consolidation queue empty"`, which read as an all-clear on the exact state a
fully-failed queue produces (#3989). The more reliably a bank's consolidator
fails, the emptier that set is — so the string had to stop implying health. On 2026-07-29 the `overlord`
bank's consolidation failed on ~every run from 04:28 to 07:09 UTC and the API
reported `pending_operations: 0, failed_operations: 96, pending_consolidation:
37 711` **simultaneously**, for 2.5 h, with every watchdog signal green. It was
found because an operator happened to ask.

`consolidation-failure-streak` is the one that closes that. It counts
consecutive `failed` rows *since the last `completed` one*, keyed on the
`(bank, operation_type)` **pair** — not the bank, because during the incident
`overlord` completed 3 753 retains while its consolidation failed 112 times,
and a bank-wide streak would have been broken by every successful retain and
never reached 3. It is deliberately error-string-agnostic: it catches any
deterministic non-retryable consolidation failure, not one incident's message.

`pending-consolidation-depth` scores **growth**, not absolute depth, because
some banks legitimately run deep (the fleet holds 676 720 memory units; one
bank carries 202 549) and an absolute line would be either noise or useless.

`vector-index-corruption` exists because `amcheck` has no HNSW support — a
nearest-neighbour probe is the only available verifier for these indexes. Note
the shape in `probe.ts`: the aggregate must be over the correlated subquery's
**result** (`count(nn)`, not `count(*)`), or the planner elides the SubPlan and
the probe silently passes without touching the index. The partial-index
predicate is likewise spliced verbatim from `pg_get_expr(indpred, indrelid)` —
a correlated column reference cannot prove a partial predicate, so the planner
falls back to the single global index and leaves all 88 partial ones unprobed.

Breaches now carry a **severity**: `warn` renders 🟠 "… degraded", `page`
renders 🔴. Every pre-existing signal sets no severity and stays 🔴.

A **level** signal needs two consecutive breaching evaluations to fire; an
**edge** signal fires on the first, because it reports a discrete event that
already happened and cannot flap.

`no-data` is a third, inert state: an idle hindsight neither fires an alert
nor silently resolves one.

## Thresholds and where each number came from

Every constant lives in `src/hindsight-watch/thresholds.ts` with its
measurement in the doc comment. Summary:

- **10 % failure rate** — the storm ran at 66–100 % daily; the worst healthy
  hour measured 2.7 %. 10 % sits an order of magnitude above normal noise and
  an order of magnitude below the incident.
  Re-checked live after #3611: 3 failures in 268 retains = 1.1 %.
- **20-retain sample floor** — a "50 % failure rate" over two retains is
  noise, and hindsight goes genuinely idle overnight. Live throughput is
  ~25 retains per 15-minute tick, so a healthy 2 h window carries ~200.
- **spool floor 440 + growth ≥max(88, 10 %)** — the spool is a *retry queue*:
  non-zero is normal, draining is healthy. Growth is measured newest-versus-
  window-start so a drain (5 636 → 616, observed live) stays silent.

  **Both numbers were re-derived for #3610.** A queue entry is no longer one
  memory: an oversized retain is split at 45 000 chars into one entry *per
  part*. Measured against the live queue — 174 entries, 171 of them over the
  bound, expanding to 765 parts — that is `PARTS_PER_MEMORY = 4.4`. The
  operator-meaningful thresholds are still "100 memories deep" and "20 new
  memories", so both are written as `⌈memories × 4.4⌉` in `thresholds.ts`
  (100 → 440, 20 → 88). Without this, five worst-case memories (17 parts
  each = 85 entries) would have paged under the pre-#3610 numbers.
- **RECALL latency now HAS a signal — restored, after being deleted twice.**
  Drafted at 4 s / 6 s and removed in review both times, correctly: the only
  "healthy" population then available (n=183, 2026-07-27) read **p50 6420 ms,
  p95 8037 ms**, right-censored at the retired 8 s per-bank wall. That
  population was itself running *at* the deadline, so the drafted page line sat
  below its median and a resampling test put the false-fire rate at >90 % of
  healthy windows. The removal named its own precondition — re-baseline against
  a fleet that is both repaired and running the 10 s envelope (#3792). Recall
  was repaired 2026-08-08 and the fleet now reads **p50 1097 ms, p95 1486 ms,
  max 2759 ms** with zero deadline hits over 953 rows, so the healthy
  distribution sits at ~15 % of the wall where it used to sit at ~80 %. The
  shipped lines are 3 000 / 6 000 ms — 2× and 4× the healthy p95 — and both
  bootstrap tests are kept: `recall-log.test.ts` still asserts the old
  population would have chattered, `recall-degradation.test.ts` asserts the
  repaired one does not.
- **no RETAIN p95 latency signal** — deliberately removed rather than retuned.
  Hindsight's exposition tops out at a finite `le` of 120 s, and a *healthy*
  post-#3610 backend already runs 52 of 268 retains (19.4 %) past it, because
  #3610 sizes content so a max-size part lands ~276 s inside the 280 s client
  deadline. So the instrument is blind across exactly the 120–280 s band
  where an early warning would live, and any threshold it *can* resolve fires
  permanently on a healthy fleet. Restoring the signal needs new `le` edges
  from hindsight — an instrument change, not a constant change.
- **the trailing quality baseline is NOT the ring** — `recall-quality-regression`
  compares against the last 7 completed UTC days, which the 8-sample / 3-hour
  ring cannot hold, and which it deliberately must not: the ring exists to
  *forget* across a gap so a stopped cron re-baselines, whereas a regression
  that begins during an outage is exactly the one still worth catching on
  return. So the baseline is a separate `baseline` block in the state file with
  the opposite property, bounded at 8 days × 96 observations × 2 series
  (~15 KB), each day reduced to its median and the baseline taken as the
  median of those. **Today is never part of its own baseline** — include it and
  the current degradation drags the reference toward the measurement. The
  honest limitation, stated because a trailing baseline cannot avoid it: this
  catches the *onset* of a regression, not its plateau. Once a degradation has
  been running for a week it is inside its own baseline and the signal goes
  quiet; the absolute floors are what cover a plateau.
- **window: 8 samples, max 3 h old** — 2 h at a 15-minute cadence, with the
  age cap so a stopped cron re-baselines instead of paging about a stale era.
- **re-notify quiet period: 6 h** — a firing signal DMs once, then at most
  once per 6 h while it stays firing.

### Recall thresholds

Measured by a real `--dry-run` against the live fleet on 2026-07-27,
mid-incident: 430 in-window rows across the 8 agents that had recent recall
telemetry. Each number is quoted against BOTH the sick reading and the
healthiest agent's reading, so the headroom is demonstrated rather than
asserted:

| SLI | Warn / page | Measured (sick) | Measured (healthy agent) | Verdict |
|---|---|---|---|---|
| own-bank timeout rate | >5 % / >15 % | **88.4 %** (380/430) | 0 % | PAGE |
| zero-memory turn rate | >25 % / >40 % | **54.0 %** (232/430) | 0–22.5 % | PAGE |
| candidate-pool median | ≤8 / ≤3 | **0** | 28–40 | PAGE |
| injected top-hit p50 | ≤0.05 / ≤0.01 | **0.0013** (n=198) | 0.061–0.61 | PAGE |
| recall p95 | ≥3 s / ≥6 s | **8063 ms** (bank budget 8000 ms) | ~1.1 s | PAGE |
| consolidation oldest | ≥2 h / ≥12 h | **4.6 h** (122 pending) | — | WARN |
| LLM outright-failure rate | ≥2 % / ≥10 % | **0.00 %** (0/800) | — | clean |

`consolidation-queue-age` landing on WARN rather than PAGE is the severity
split doing real work: a backlog worth mentioning is not a backlog worth
waking someone for.

### The degradation the table above could not see

Every threshold in that table is an **absolute floor** — calibrated so a fleet
that has *collapsed* trips it and a working fleet never does. That is the right
shape for the six-week outage they were built for and the wrong shape for a
degradation. Between **2026-08-01 and 08-07** recall quality fell ~5× and all
fourteen signals stayed green:

| day | n | lat p50 | lat p95 | top-hit p50 | pool p50 | `deadline_hit` |
|---|---|---|---|---|---|---|
| 08-01 | 570 | 6660 ms | 9037 ms | 0.5493 | 58 | 22.3 % |
| 08-02 | 441 | 7801 ms | 9033 ms | 0.2856 | 61 | 37.2 % |
| 08-03 | 431 | 7993 ms | 9034 ms | **0.1857** | 78 | 39.2 % |
| 08-05 | 452 | 6161 ms | 9028 ms | 0.6046 | 85 | 17.9 % |
| 08-07 | 381 | 5111 ms | 9031 ms | 0.6593 | 87 | 15.7 % |
| *repaired 08-08* | | | | | | |
| 08-10 | 457 | 1121 ms | 1545 ms | 0.8638 | 97 | 0.0 % |
| 08-11 | 440 | 1090 ms | 1455 ms | 0.8953 | 90 | 0.0 % |

Why each floor stayed silent, in its own terms:

- **`recall-injected-score`** warns at ≤0.02. The worst day was **0.1857** —
  9× above the line — while quality was ~5× off its own baseline.
- **`recall-candidate-floor`** warns at ≤8. The pool *grew*, 58 → 87. A floor
  cannot fire on a metric moving the right way.
- **`recall-own-bank-timeout`** reads own-bank failure, and the own bank was
  answering — slowly, but answering.
- **latency** carried no threshold at all.

The three signals added in response are each a *different kind of instrument*
from a floor, which is why they are three and not one:

| signal | asks | catches |
|---|---|---|
| `recall-latency` | is recall slow against a wall it is not hitting? | the whole sick week pages |
| `recall-quality-regression` | is recall worse than it *recently was*? | 08-02 warn → 08-03 page, four days before anything else |
| `recall-deadline-pinning` | are recalls being *cut off* rather than completing? | p95 at 90.4 % of the 9993 ms effective deadline, every sick day |

`recall-latency` and `recall-deadline-pinning` are kept separate deliberately:
a p95 of 6 s against a 10 s wall means recall is slow *and completing*; a p95
on the wall means an unknown share never completed and the agent silently got
truncated memory. The two need different fixes, so merging them would put the
wrong remedy in the DM.

Notes on the reduction, all of which are fail-CLOSED by design:

- **Each SLI carries its own denominator.** Topic-filtered rows carry
  `result_count` but no `bank_timings`, so one shared denominator would
  silently dilute whichever rate was computed second.
- **Cache hits are excluded wholesale** — a cache-hit row carries
  `result_count: null` and no timings, so counting it would inflate every
  denominator with rows that measured nothing.
- **`pre_cap_count` alone is not the pool.** It is post-overlap-gate, so the
  gate's drops are added back; scoring it raw would read an aggressive overlap
  gate as an empty index and point at the wrong fix.
- **30-row sample floor per SLI**, and rows older than **24 h** are dropped —
  otherwise a fleet whose recall stopped firing entirely would page forever off
  a frozen log.
- **A missing or partial persisted `recall` block is rejected to `null`**, not
  zero-filled. `undefined / undefined` is `NaN` and every `NaN >= threshold` is
  false, so a corrupt block would otherwise score as a clean pass on all six
  recall signals — the exact fail-open shape this exists to remove.
- **`consolidation-queue-age`'s 2 h warn** matches the existing
  `SWITCHROOM_HINDSIGHT_QUEUE_LAG_WARN_S` default in
  `docker/hindsight-maintenance.sh`, so the push and pull views agree.
- **`llm-fallback-ineffective` reads the failure rate, not OpenRouter
  traffic.** LiteLLM's router fallback happens *inside* one hindsight request,
  so hindsight only ever records the model it ASKED for and no `*-openrouter`
  series exists on `/metrics` (verified: zero, 2026-07-27). A
  `success="false"` therefore means the local deployment failed **and** the
  OpenRouter hop did not rescue it — which is the question worth alerting on.
  A fallback that never fires can no longer read as clean.

### Consolidation thresholds

Measured read-only against the live fleet on 2026-07-29, shortly after the
incident was repaired (baseline block **B9** in `thresholds.ts`):

| Constant | Value | Measurement that set it |
|---|---|---|
| `CONSOLIDATION_FAILURE_STREAK_WARN` | 3 | The streak query returned exactly one row across all 20 banks — `overlord \| consolidation \| 103 \| 668`. Every other `(bank, op)` pair read 0. A healthy fleet's floor is 0, so 3 is three consecutive terminal failures above a population with none, and fires ~15 min into an incident. |
| `CONSOLIDATION_FAILURE_STREAK_PAGE` | 10 | ~2.5 consecutive 15-min ticks of total failure. The incident reached 103. |
| `CONSOLIDATION_STREAK_RECENCY_S` | 2 h | A streak is defined *relative to the last completed op*, so a bank that is fixed but then goes idle keeps its streak for ever. Without this the signal would never resolve. |
| `PENDING_CONSOLIDATION_FLOOR` | 500 | Healthy per-bank depth: `overlord` 38 130 (sick) · `carrie` 45 · `switchroom-dev` 12 · every other bank 0, over 676 720 memory units. |
| `PENDING_CONSOLIDATION_GROWTH_FRACTION` / `_WARN_ABS` / `_PAGE_ABS` | 50 % / 500 / 5 000 | Same "deep **and** rising" conjunction as `retain-queue-growth`, so a draining backlog stays silent. The incident's window growth was ~38 000. |
| `VECTOR_INDEX_SAMPLE_ROWS` | 3 | 89 HNSW indexes swept in **0.45 s** at this sample size. |

Two honest caveats on the canary:

- **The corruption was already repaired when this was built** (last failed row
  07:08:55 UTC, probe run 07:18), so the live sweep returned `VECIDX|89|0|` and
  the raise could not be reproduced end-to-end. What *is* proven is the
  mechanism: `EXPLAIN` over `count(nn)` shows `Index Scan using
  idx_mu_emb_obsv_81cef5f6a42e4b4d` with `SubPlan 1` (9.6 ms), while the same
  query as `count(*)` shows a bare `Aggregate` with no `SubPlan` and no index
  scan (0.8 ms). `probeVectorIndexes` refuses to run — returning `no-data`, not
  `ok` — if the generated SQL ever stops containing `count(nn)`.
- The damage is **inside the index, not the data**: the column is `vector(384)`
  and a full scan found zero off-dimension rows, which is why a nearest-
  neighbour probe (and not a column check) is the detector.

`pending_consolidation` is read in the same psql round trip as the streak
rather than through the `/stats` HTTP endpoint. Same predicate
(`consolidated_at IS NULL AND fact_type IN ('experience','world')`, per
`doctor-observation-scopes.ts`), 0.284 s for the whole fleet against the
1.4–2.1 s **per bank** that endpoint costs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | ran, nothing firing |
| `10` | ran, at least one signal firing |
| `1` | could **not** complete — probe failure, unwritable state, or an alert that reached no gateway |

Exit `1` is deliberate and loud: a watchdog that cannot see, or cannot speak,
is an incident rather than a no-op. An undelivered alert is never recorded as
notified — the next tick retries it.

## Arming it (operator)

1. Dry-run first — evaluates and prints, sends nothing, writes no state:

   ```bash
   switchroom hindsight-watch --dry-run
   ```

2. Install the cron:

   ```bash
   sudo switchroom hindsight-watch --install-cron --cron-user "$USER"
   ```

   This writes `/etc/cron.d/hindsight-watch` (15-minute cadence, `flock -n` so
   ticks cannot overlap, explicit `PATH` because the probes shell out to
   `docker`, mode 0644). It is idempotent — re-running is a no-op when the
   fragment already matches.

   The same command also **provisions `/var/log/hindsight-watch.log`** owned by
   the cron user (#3991) and **installs a logrotate drop-in** at
   `/etc/logrotate.d/hindsight-watch` (#3992). Both are load-bearing: on a
   stock host `/var/log` is `root:syslog 0775`, so the cron's
   `>> /var/log/hindsight-watch.log` redirection would otherwise fail
   "Permission denied" before `switchroom` is even exec'd — every tick dies and
   the `hindsight-watch armed` doctor row FAILs forever with "the watchdog has
   never completed a tick". Pre-creating the file owned by the cron user lets
   its append succeed without write access to `/var/log`; the logrotate drop-in
   (`weekly`, `rotate 8`, `copytruncate`, `su <user> <user>`) bounds the
   ~135 KB/day the 15-minute cron would otherwise grow unbounded. An existing
   log file is left untouched (never truncated, never re-chowned). Provisioning
   the log is FATAL if it fails (an armed cron that cannot write its log is the
   silent-monitoring failure this verb exists to close); the logrotate drop-in
   is best-effort and only WARNs.

   It **refuses to install for `root`**: the state file and the agents
   scaffold live under the operator's `~/.switchroom`, so a root tick would
   read an empty fleet and report a clean bill of health forever.

3. Confirm:

   ```bash
   switchroom doctor    # the `hindsight-watch armed` row
   ```

   `switchroom doctor` **FAILs** while the watchdog is unarmed or its state
   file is stale past an hour (four missed ticks). That row exists because the
   previous version of this doc said "install the cron" and nobody did — the
   watchdog shipped complete and never executed, and nothing anywhere said so.
   A monitoring system whose own absence is silent is not a monitoring system.

Alerts arrive as a plain operator DM through the first agent gateway socket
that accepts them. The gateway fences delivery to its own operator chat, so
the watchdog cannot address a foreign chat.

## Retiring the legacy host watchdog (operator action required)

This in-repo watchdog **supersedes the hand-rolled host script
`hindsight-memory-watchdog.sh`** (armed via `/etc/cron.d/hindsight-memory-watchdog`
on some hosts). That script's `queue-evictions` alert counted every line of
`pending-evictions.log` regardless of reason, so the routine trimming of the
bounded `pending-reconciled/` archive at its cap read as data loss — it fired
"⚠️ Memories are being discarded" on the live fleet 2026-07-30 when **no memory
had been lost** (all 4 831 evictions fleet-wide were `reason=archive-count`,
i.e. an already-acked archive expiring), and its copy named a
`~/.hindsight/pending-evicted/` directory that does not exist on any agent
(#4009).

The `retain-loss` signal here does not have that defect: it reads the loss
channels by directory (`pending-dead/`, `pending-evicted/`, `pending-drops.json`)
and treats a DECREASE as a re-baseline, so a bounded archive expiring cannot be
read as loss. Collapsed duplicates are surfaced separately as
`… N collapsed-duplicate (not loss)` (#3896) precisely so a `collapse_duplicates`
pass reads as an explained spool drain rather than as missing memory.

Once this watchdog is armed and you have confirmed a clean tick (`switchroom
doctor`), **retire the legacy host cron** so the two do not double-alert:

```bash
# Inspect first, then remove the legacy fragment (HOST op — run as the operator):
sudo rm -f /etc/cron.d/hindsight-memory-watchdog
```

This is a host filesystem change outside `switchroom.yaml`, so it is not
performed by any switchroom command — it is left to the operator deliberately.

## Flags

```
--dry-run             evaluate and print; send no DM and write no state
--json                machine-readable output
--metrics-url <url>   default http://127.0.0.1:18888/metrics
--container <name>    default switchroom-hindsight
--state <path>        default ~/.switchroom/hindsight-watch/state.json
--agents-dir <path>   default ~/.switchroom/agents
--install-cron        write /etc/cron.d/hindsight-watch and exit
--cron-user <user>    unix user the cron tick runs as (never root)
```
