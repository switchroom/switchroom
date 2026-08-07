# P2 — cache residency and contention isolation: the measurement

Phase P2 of epic #4474, tracked as #4476. Captured 2026-08-07 against the live
Hindsight instance with `switchroom hindsight-bench`. Raw result files are under
`docs/baselines/hindsight-recall-p2-2026-08-07/`; the P1 reference this is
graded against is `docs/hindsight-bench-baseline.md`.

**Headline: the residency criteria pass, the latency criterion does not, and
the phase-attribution pass shows it never could.** That is a negative result
about the epic's central hypothesis, not a shortfall in the work — see
"The falsification" below.

## The instance changed under the baseline

Before any number here can be compared to P1's, this has to be on the record.
`switchroom-hindsight` was recreated at **2026-08-07T03:41:33Z** by unrelated
fleet work — the v0.20.13 rollout — which changed **two** things at once:

| | P1 baseline | P2 measurement |
|---|---|---|
| image | `switchroom-hindsight:v0.20.12` | `switchroom-hindsight:v0.20.13` |
| `shared_buffers` | 6144 MB | **12288 MB** |
| `effective_cache_size` | 12288 MB | **14336 MB** |
| server | PostgreSQL 18.x | PostgreSQL 18.1 |

Both memory settings are confirmed live with `source = command line`, i.e. the
`-c` flag path described in #4474's correction 4 — `ALTER SYSTEM` did not and
could not have moved them.

So the buffer pool doubled, unplanned and un-measured, *between* the baseline
and this run. Every latency delta below is confounded by an image bump. No
statement here attributes a latency change to the pool size, and none should be
made from this data.

## AC1 — residency: **PASS**

`pg_total_relation_size('memory_units')`, live:

| | |
|---|---:|
| `memory_units` heap | 2939 MB |
| `memory_units` indexes | 2280 MB |
| **total** | **5219 MB** |
| `shared_buffers` | 12288 MB |
| **working set / pool** | **42.5 %** |

The criterion is "≤ 90 % of `shared_buffers`", written with a worked example of
"≤ 5530 MB against a 6144 MB pool". It passes on **both** readings: 42.5 % of
the pool that actually exists, and 5219 MB against the 5530 MB absolute figure.

### But the criterion counts the wrong table

`memory_units` is not the largest table on this instance, and it is not the only
one the recall path reads:

| table | total | heap | indexes |
|---|---:|---:|---:|
| **`memory_links`** | **8085 MB** | 2507 MB | 5579 MB |
| `memory_units` | 5219 MB | 2939 MB | 2280 MB |
| `async_operations` | 542 MB | 506 MB | 36 MB |
| `chunks` | 501 MB | 447 MB | 54 MB |
| database total | 16 GB | | |

The recall graph arm traverses `memory_links`. `memory_units` + `memory_links`
is **13304 MB against a 12288 MB pool** — the two hot tables together still do
not fit, even after the pool doubled and the dead index was dropped. #4474's
working-set arithmetic (6703 MB vs 6144 MB) counted `memory_units` alone and
therefore understated the working set by more than the entire overshoot it was
trying to close.

This does not invalidate AC1 as written. It does mean AC1 as written is not a
statement about whether the working set fits.

## AC2 — heap hit ratio under load, on reset counters

`pg_stat_reset()` was run at **2026-08-07T04:56:56.942545Z**, the first such
reset in this instance's life. The cumulative counters it discarded were
snapshotted to the host first. Every ratio below is therefore a statement about
measured load, not about the lifetime since `initdb` — which is what the
criterion demands and what #4474 flagged as missing.

> `idle.json` records `db.statsResetAt` as `04:56:22.400601+00` — an **earlier,
> manual** reset, not the one its counters belong to. That mismatch was a real
> harness bug, found by this PR's own review and fixed in it: `readDbState`
> necessarily runs before `--reset-stats` fires (bank selection needs
> `bankRows` to configure the sweep), so the file recorded
> `config.statsReset: true` beside the epoch the run had just destroyed — and
> beside a `db.heapHitRatio` accumulated over that dead epoch, which is the
> field *this criterion* is graded on. `readStatsEpoch` now re-reads both
> immediately after the reset. The committed P2 files predate the fix and are
> left as captured rather than hand-edited; cite the `04:56:56.942545Z` figure
> above, which is what the `pg_stat_database` checkpoints below are differenced
> from.

The ratio is **differenced between two checkpoints** taken either side of the
contention sweep, not read cumulatively off the reset epoch. A cumulative read
would blend the idle ladder into the answer; the criterion asks what the cache
does *under load*.

Window **2026-08-07T05:14:57Z – 05:26:07Z**, 10 cells at c=8/16 under 4
synthetic read-contention workers, 0 errors, 0 zero-result calls.

| table | heap hit | heap read | heap hit ratio | index hit ratio |
|---|---:|---:|---:|---:|
| `memory_units` | 937,733,726 | 0 | **100.0000 %** | 99.9948 % |
| `entities` | 1,283,303 | 0 | **100.0000 %** | 99.9595 % |
| `unit_entities` | 369,658 | 0 | **100.0000 %** | 99.9358 % |
| `documents` | 901 | 0 | **100.0000 %** | 100.0000 % |
| `memory_links` | 228,363 | 1,768 | **99.2317 %** | 98.7792 % |
| `chunks` | 851 | 19 | 97.8161 % | 99.9193 % |
| **whole database** | **939,751,196** | **1,843** | **99.99980 %** | — |

**AC2: PASS**, by a wide margin — the bar is 99 % and the measured figure is
99.9998 %. `memory_units` served 937 million heap blocks under load without a
single disk read.

The one table that misses 99.9 % is `memory_links`, at 99.23 % heap and 98.78 %
index — the same table AC1 does not count. It is where every remaining physical
read on this box comes from.

### What a 99.9998 % hit ratio actually tells us

It is a PASS, and it is also the single most important number for AC3. Recall
p95 during this window ran **12.9 s – 27.5 s per call** while the buffer pool
was serving essentially every block from memory. Whatever is making recall slow
was not waiting on a disk, because during this measurement the database
practically never touched one. That is an independent, mechanism-level
confirmation of what `--phases` reports below.

## AC3 — the latency goal: **FAIL**

> recall p95 ≥ 30 % and p99 ≥ 40 % below the P1 baseline, at concurrency 8
> and 16.

P2 idle ladder, 5 banks × {1,4,8,16}, 40 samples + 8 warm-up per cell, window
**2026-08-07T04:56:55Z – 05:14:41Z**, read-only clamp verified. Compared cell
for cell against both committed P1 idle runs. Negative = faster than baseline,
which is the direction the criterion wants.

| bank | c | p95 vs idle-A | p95 vs idle-B | p99 vs idle-A | p99 vs idle-B |
|---|---:|---:|---:|---:|---:|
| `bank-01` | 8 | −37.6 % | −31.0 % | −42.4 % | −30.7 % |
| `bank-07` | 8 | −30.2 % | −25.2 % | −30.4 % | −30.4 % |
| `bank-10` | 8 | −25.6 % | −27.5 % | −37.3 % | −39.9 % |
| `bank-12` | 8 | −61.2 % | −36.0 % | −65.8 % | −36.0 % |
| `bank-14` | 8 | −40.6 % | −32.5 % | −39.7 % | −38.7 % |
| `bank-01` | 16 | −6.0 % | **+29.9 %** | −6.0 % | **+29.9 %** |
| `bank-07` | 16 | −34.3 % | −18.3 % | −34.3 % | −18.2 % |
| `bank-10` | 16 | −4.0 % | **+37.4 %** | −7.6 % | **+21.0 %** |
| `bank-12` | 16 | −23.0 % | **+11.5 %** | −22.9 % | **+11.5 %** |
| `bank-14` | 16 | −10.9 % | **+38.1 %** | −4.5 % | **+44.0 %** |

Graded against idle-A, the more pessimistic baseline: at c=8 the p95 bar is
cleared by 4 cells of 5 and the p99 bar by 2 of 5; **at c=16 the p95 bar is
cleared by 1 of 5 and the p99 bar by none.** Graded against idle-B, four of
the five c=16 cells are *slower* than the baseline. AC3 asks for both bars at
both concurrency levels, so it fails on every reading, and it fails hardest at
exactly the concurrency the epic is about.

Two further facts bear on the c=8 column before anyone reads it as a partial
win:

1. **It is not a clean measurement.** A P4 worker (#4478) was running its own
   concurrency sweeps on this box from 04:52:44Z — before this sweep opened and
   throughout it. Every number in the table was taken under external load.
2. **The instrument cannot resolve an effect this size.** P1's own committed
   record (`docs/hindsight-bench-baseline.md`) reports that its AC1
   reproducibility criterion **FAILED**: the same unchanged system, measured
   twice, moved p95 by a **median 30.5 %** (worst cell 82.7 %) and p99 by a
   median 29.2 %, with a bootstrap p95 CI half-width of 15.8 %. AC3's 30 %/40 %
   target is the same size as this harness's run-to-run noise at n=40. The
   idle-A/idle-B disagreement in the table above is that noise, made visible.

### AC3 is also ungradeable as literally written

The criterion says "at concurrency 8 and 16" and #4476 places it in the
contention sweep. P1 committed **no c=8 or c=16 contention baseline** —
`contended2.json` covers c=1 and c=4, and is partly ungradeable. There is no
prior number for a contended c=8/16 comparison to be made against, so that
reading of AC3 has no baseline to exist against at all. The table above is the
idle-to-idle comparison, which is the only one the committed artefacts support.

### Why it fails, measured rather than argued

`--phases` (added in this PR) attributes recall latency to request phases and
reports the **ceiling**: the fraction of end-to-end latency that would vanish
if every PostgreSQL call in the request became instantaneous. Committed as
`docs/baselines/hindsight-recall-p2-2026-08-07/phases.json`, window
**2026-08-07T05:30:28Z – 05:33:42Z**:

| bank | c | DB share of server time | max end-to-end gain from a *perfect* database |
|---|---:|---:|---:|
| `bank-01` | 1 | 33.7 % | **32.4 %** |
| `bank-10` | 1 | 6.6 % | 6.2 % |
| `bank-14` | 1 | 2.2 % | 2.2 % |
| `bank-01` | 8 | 26.6 % | **25.9 %** |
| `bank-10` | 8 | 22.8 % | 21.3 % |
| `bank-14` | 8 | 21.2 % | 19.8 % |
| `bank-01` | 16 | 20.2 % | 18.8 % |
| `bank-10` | 16 | 22.4 % | 20.8 % |
| `bank-14` | 16 | 26.0 % | **24.9 %** |

Read this off the table, not off the headline. The tool's ceiling line reports
**32.4 %**, because it maximises over every cell in the file and the most
database-bound cell is `bank-01` at **c=1**. That is above AC3's 30 % bar, so at
c=1 the ceiling does not by itself refute AC3. Stated plainly because it is the
one number in this document that cuts against its own conclusion.

**AC3 is not a c=1 criterion.** At the two concurrency levels it names:

| | c=8 | c=16 |
|---|---:|---:|
| best cell's max end-to-end gain | **25.9 %** | **24.9 %** |
| AC3's p95 target | 30 % | 30 % |
| AC3's p99 target | 40 % | 40 % |

At c=8 and c=16 a database that answered instantly removes at most **25.9 %** of
recall latency, against a 30 % p95 target and a 40 % p99 target. The p95 bar is
unreachable by ~4 points and the p99 bar by ~14. No amount of cache residency,
index tuning or buffer-pool sizing closes that, because the target is larger
than the entire budget the target's mechanism controls.

The direction of travel says the same thing. The database's share does not grow
with concurrency — on `bank-01` it *falls* (33.7 % → 26.6 % → 20.2 %) as load
rises. The epic's premise is that concurrency pressure lands on the database;
measured, it lands somewhere else. `reranking` and `generate_query_embedding`
are the two largest phases by mean time across every cell in the file, and
`semaphore_wait` — the model-concurrency semaphore, not the connection pool —
appears only at c=16.

This is the number, not the argument, and `--phases` reproduces it.

## AC4 — no correctness regression: **PASS**

Re-verified live, read-only:

- `pg_index WHERE NOT (indisvalid AND indisready)` → **0 rows** database-wide.
- `idx_memory_units_embedding` (the dropped global HNSW) → **absent**.
- `idx_mu_emb_*` per-(bank, fact_type) partial HNSW indexes → **45 present**.

The `EXPLAIN` equivalence and the result-set diff either side of the drop are
recorded on #4476 by the agent that executed it and are not re-derived here;
the drop predates every measurement in this document.

## AC5 — isolation: **PASS under read contention, ungraded under write contention**

> a recall under a storm may not exceed 2× its idle p99.

Same two files as AC2: the P2 idle ladder against the contended sweep, cell for
cell.

| bank | c | p99 idle | p99 contended | ratio |
|---|---:|---:|---:|---:|
| `bank-01` | 8 | 11,039 ms | 17,982 ms | 1.63× |
| `bank-07` | 8 | 11,141 ms | 20,295 ms | **1.82×** |
| `bank-10` | 8 | 8,783 ms | 16,430 ms | **1.87×** |
| `bank-12` | 8 | 7,836 ms | 13,834 ms | 1.77× |
| `bank-14` | 8 | 8,245 ms | 13,890 ms | 1.68× |
| `bank-01` | 16 | 22,694 ms | 27,528 ms | 1.21× |
| `bank-07` | 16 | 17,799 ms | 25,349 ms | 1.42× |
| `bank-10` | 16 | 22,882 ms | 21,941 ms | 0.96× |
| `bank-12` | 16 | 17,251 ms | 16,967 ms | 0.98× |
| `bank-14` | 16 | 21,988 ms | 18,602 ms | 0.85× |

Worst cell **1.87×**, under the 2× bar. AC5 passes as measured — but read the
two qualifications, because the margin is 6.5 % and the harness's own
reproducibility is ±30 %.

1. **Three c=16 cells came out FASTER under contention than idle** (0.85×,
   0.96×, 0.98×). A load generator cannot make recall faster. This is the
   ±30 % run-to-run spread again, and it means the c=16 row of this table is
   noise rather than isolation. The c=8 rows, where the generator moves the
   number consistently in the right direction by 1.6–1.9×, are the ones
   carrying the verdict.
2. **This is a READ storm, not a write storm.** `--contention read` reproduces
   buffer-pool eviction. #4476's criterion is about a retain/consolidation
   storm, whose box-level signature is WAL, checkpoint and autovacuum pressure —
   `--contention write`. That variant was **not run**: it requires
   `--allow-writes`, and the read-only clamp on this work was a hard constraint
   of the dispatch, not a default to opt out of. So **1.87× is a lower bound**
   on what a real storm does, and AC5 is graded only against the milder of the
   two mechanisms. Closing that gap is a one-command follow-up under an
   explicit write authorisation:

   ```bash
   switchroom hindsight-bench --banks spread:5 --concurrency 8 --samples 40 \
     --contention write --contention-workers 2 --allow-writes --out ac5-write.json
   ```

## The falsification

**It fired.** #4474's central hypothesis is that recall latency is a cache
residency problem — that making the working set fit in `shared_buffers` and
isolating it from contention is what produces consistent latency at any bank
size. P2 is the phase that tests it. The test is decisive and it is negative:

| | |
|---|---|
| working set resident? | **yes** — 42.5 % of the pool (AC1) |
| served from cache under load? | **yes** — 99.9998 % heap hit ratio (AC2) |
| isolated from contention? | **yes** — worst 1.87× vs a 2× bar (AC5) |
| correctness intact? | **yes** — 0 invalid indexes (AC4) |
| **recall 30 %/40 % faster?** | **no** — 1 of 5 cells at c=16 on p95, 0 of 5 on p99 (AC3) |

Every precondition the hypothesis names is satisfied *and the latency does not
follow*. That is the shape of a falsification, not of an incomplete phase.

The mechanism is measured, not inferred. A **perfect** database — every
PostgreSQL call returning instantaneously — removes at most **25.9 %** of
end-to-end recall latency at c=8 and **24.9 %** at c=16, against AC3's 30 % p95
and 40 % p99 targets. (At c=1 the ceiling is 32.4 %, above the p95 bar; AC3 is
not a c=1 criterion, and even at c=1 the 40 % p99 bar stays out of reach.)
Recall's time is in `reranking` and `generate_query_embedding`, and at c=16 in
`semaphore_wait` — the model-concurrency semaphore. The remaining latency lives
on the **model** side of the request, not the storage side.

### What this means for the rest of the epic

Stated plainly so it is not rediscovered three phases from now: **P3 (ANN
over-fetch tuning) and P4 (corrected BM25 index) are both database-side, and
this ceiling binds them too.** Neither can produce a 30 % end-to-end p95
improvement at c=8 or c=16, because the entire database budget they operate
inside there is ~25 %.
They may still be worth doing — a BM25 index that stops seq-scanning is worth
having on its own terms, and P4's own numbers should be read as
*database-share* improvements — but the epic's headline goal is not reachable
through any of them, and continuing to grade them against AC3's 30 %/40 % bar
will keep producing failures that are really the bar's fault.

The database-side work that IS indicated by this data is narrow and specific:
`memory_links` is the only table still taking physical reads under load
(99.23 % heap, 98.78 % index), it is the largest table on the instance at
8085 MB, and AC1 does not count it. If any residency work continues, that is
where it belongs — not in `memory_units`, which is already at a flat 100 %.

The lever with actual headroom is the model path: embedding generation,
reranking, and the concurrency semaphore. That is a different epic.

### An instrument caveat that must travel with every number here

P1's committed reproducibility criterion **FAILED** (median 30.5 % p95 spread
between two runs of the same unchanged system). AC3's target is the same size
as that spread. So this document's AC3 verdict does not rest on the latency
deltas — it rests on the `--phases` ceiling and the 99.9998 % hit ratio, both of
which are mechanism-level and neither of which depends on resolving a 30 %
effect. Had AC3 been graded on the latency table alone, the honest verdict
would have been *ungradeable*, not *fail*.

### Measurement conditions, on the record

Both P2 sweeps ran while a **P4 worker (#4478) was benchmarking the same
instance** — it started at 04:52:44Z, before the P2 idle window opened at
04:56:55Z, and continued through the contention window (05:14:57Z – 05:26:07Z).
Every latency number in this document was taken under external load and none of
them should be treated as a clean idle measurement. The AC2 hit ratio and the
AC1 sizes are unaffected by this; the latency tables are.

## Reproducing

```bash
# idle ladder, resetting the statistics epoch
switchroom hindsight-bench --banks spread:5 --concurrency 1,4,8,16 \
  --samples 40 --warmup 8 --reset-stats \
  --out idle.json --csv idle.csv

# the same ladder under synthetic read load
switchroom hindsight-bench --banks spread:5 --concurrency 8,16 \
  --samples 40 --warmup 8 --contention read --contention-workers 4 \
  --out contended.json --csv contended.csv

# where the time actually goes
switchroom hindsight-bench --banks spread:3 --concurrency 1,8,16 \
  --samples 8 --warmup 2 --phases 8 --out phases.json
```
