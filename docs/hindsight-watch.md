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
| `consolidation-queue-age` | oldest pending `async_operations` row ≥2 h (warn) / ≥12 h (page) | level |
| `consolidation-failure-streak` | ≥3 (warn) / ≥10 (page) consecutive **failed** `async_operations` for one `(bank, operation_type)` pair, newest within 2 h | edge |
| `pending-consolidation-depth` | one bank's unconsolidated memories ≥500 **and** grew by ≥max(500, 50 %) across the window (≥5 000 pages) | level |
| `vector-index-corruption` | a nearest-neighbour probe against an HNSW index raises | edge |
| `llm-fallback-ineffective` | ≥2 % (warn) / ≥10 % (page) of hindsight LLM calls failed outright | level |

The five recall signals read `recall_log.jsonl` — the hook's own telemetry —
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
set being measured — and `evaluateConsolidationQueueAge` reports
`"consolidation queue empty"` when that count is zero. The more reliably a
bank's consolidator fails, the healthier it reads. On 2026-07-29 the `overlord`
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
- **no RECALL latency signal, either** — drafted at 4 s / 6 s and deleted in
  review for the same reason as the retain one below. Measured over the
  healthy-conditioned population (no bank timed out, errored, or hit the
  shared deadline; n=183 across 9 agents) the fleet reads **p50 6420 ms, p95
  8037 ms**, and every one of the nine agents' healthy p95 lands between
  7816 ms and 11859 ms. The drafted page line of 6000 ms therefore sat *below
  the healthy median*, and a resampling test puts its false-fire rate at
  >90 % of healthy windows. Raising it above the noise does not rescue it
  either: the per-bank budget is 8 s, so any line clear of healthy traffic can
  only ever mean "pinned at the deadline", which `recall-own-bank-timeout`
  already reports from a cleaner instrument. Wall time is still *shown* — it
  rides along on the own-bank-timeout DM as diagnostic context — it just
  carries no threshold until recall is repaired and the distribution can be
  re-baselined.
- **no RETAIN p95 latency signal** — deliberately removed rather than retuned.
  Hindsight's exposition tops out at a finite `le` of 120 s, and a *healthy*
  post-#3610 backend already runs 52 of 268 retains (19.4 %) past it, because
  #3610 sizes content so a max-size part lands ~276 s inside the 280 s client
  deadline. So the instrument is blind across exactly the 120–280 s band
  where an early warning would live, and any threshold it *can* resolve fires
  permanently on a healthy fleet. Restoring the signal needs new `le` edges
  from hindsight — an instrument change, not a constant change.
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
| recall p95 | ≥4 s / ≥6 s | **8063 ms** (bank budget 8000 ms) | ~1.1 s | PAGE |
| consolidation oldest | ≥2 h / ≥12 h | **4.6 h** (122 pending) | — | WARN |
| LLM outright-failure rate | ≥2 % / ≥10 % | **0.00 %** (0/800) | — | clean |

`consolidation-queue-age` landing on WARN rather than PAGE is the severity
split doing real work: a backlog worth mentioning is not a backlog worth
waking someone for.

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
