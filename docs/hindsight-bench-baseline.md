# Recall latency baseline — 2026-08-07, post-index-drop

Captured with `switchroom hindsight-bench` (see `docs/hindsight-bench.md`).
The raw result files this narrative is derived from are committed alongside it
under `docs/baselines/hindsight-recall-2026-08-07/`.

This file is the deliverable that outlives phase P1 of epic #4474: it is the
number every later phase (#4476, #4477, #4478) is graded against.

## What it was measured against

| | |
|---|---|
| image | `ghcr.io/switchroom/switchroom-hindsight:v0.20.12` |
| `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` | 150 |
| `shared_buffers` | 6144 MB |
| `effective_cache_size` | 12288 MB |
| `hnsw.ef_search` | unset (server default) |
| `memory_units` | 5184 MB total — heap 2922 MB + indexes 2262 MB |
| working set / `shared_buffers` | 84 % |
| `pg_stat_database.stats_reset` | **NEVER** — cache-hit ratios are cumulative since initdb and are not a statement about this run |
| `memory_units` heap hit ratio | 97.1 % (cumulative, see above) |
| banks swept | `klanker` (230,020 rows), `gymbro` (17,977), `ziggy` (1,493), `lisa-profile` (157), `switchroom-dev` (12) |
| query set | `generic-v1`, budget `mid`, `max_tokens` 4096 |

## Idle latency by bank size and concurrency

`idle-a.json`, n=40 per cell, no synthetic load. p95 in **bold** — the number
every later phase is graded on.

| bank | rows | c=1 | c=4 | c=8 | c=16 |
|---|---:|---:|---:|---:|---:|
| `klanker` | 230,020 | **1886** | **8968** | **16487** | **24129** |
| `gymbro` | 17,977 | **2559** | **5067** | **15944** | **27049** |
| `ziggy` | 1,493 | **4181** | **9361** | **10974** | **23815** |
| `lisa-profile` | 157 | **2394** | **15582** | **20200** | **22383** |
| `switchroom-dev` | 12 | **2562** | **10824** | **13157** | **21801** |

Two things fall out of this table immediately, and neither depends on the
reproducibility question below.

**Bank size is not the dominant axis; concurrency is.** `klanker` has ~19,000×
the rows of `switchroom-dev` and its single-threaded p95 is *lower*. Moving from
c=1 to c=16 multiplies p95 by 9–13× on every bank regardless of size. Whatever
#4474 fixes, "big banks are slow" is not the shape of the problem in the
measured range — queueing is.

**p95 at c=16 is 17–27 s on every bank.** That is well past the point a user has
given up on the recall.

## AC1 — reproducibility: **FAILED**, and here is the real number

The acceptance criterion was p95 within ±10 % per cell across repeated idle
runs. It was not met. The measured result, not a tuned one:

| comparison | n/cell | cells | worst Δ | median Δ | within ±10 % |
|---|---:|---:|---:|---:|---:|
| `idle-a` vs `idle-b` (p95) | 40 | 20 | **82.7 %** | 30.5 % | 3/20 |
| `idle-a` vs `idle-b` (p50) | 40 | 20 | 59.8 % | 21.7 % | 3/20 |
| `aba3-idle1` vs `aba3-idle2`, `klanker`@c1 (p95) | 100 | 1 | **11.5 %** | — | 0/1 |
| `aba3-idle1` vs `aba3-idle2`, `klanker`@c1 (p50) | 100 | 1 | **6.4 %** | — | 1/1 |

**Two distinct causes, and they act on opposite ends of the sweep.**

*1. At low concurrency the estimator is the problem.* p95 at n=40 is a single
order statistic — the 38th sorted sample — drawn from a distribution with
cv ≈ 0.4–0.9. Its own bootstrap 95 % interval has a median half-width of
**15.8 %** across the sweep, and 76–145 % on the c=1 cells. That is larger than
the ±10 % gate: **at n=40 the criterion is unattainable no matter how stable the
system is.** Nine of the twenty cells disagree by less than their own noise
floor — the harness marks those `OUT*` rather than pretending they are clean.
Extrapolating the interval as ∝ 1/√n, p95 to ±10 % needs roughly **n ≈ 2700 per
cell**, about 15 h for a 20-cell sweep.

*2. At high concurrency the system is the problem.* The c=16 cells have a tight
noise floor (3.8–11 %) and still disagree by 20–36 %, always in the same
direction: `idle-b` is faster on 4 of 5 banks. That is real drift over the ~20
minutes between the two sweeps — the live fleet's own load — and no sample count
fixes it.

**What to grade on instead.** The p50 at n=100 on back-to-back runs reproduced
at **6.4 %**, inside ±10 %. If a later phase needs a gate that can actually
fail honestly, grade p50 at n ≥ 100 with the two runs interleaved, or grade on
whether the p95 confidence intervals overlap rather than on a point-estimate
tolerance. The tolerance in the harness is deliberately left at 10 %: widening
it to whatever the noise happens to be is how a measurement stops being one.

## AC4 — the contention mode demonstrably moves the tail: **PASSED**

Measured as A/B/A so drift cannot be mistaken for effect — an idle run, a
contended run, then a second idle run, `klanker`@c1, n=100 each, load = 4
workers × 10 % `TABLESAMPLE` scans, **4 of 4 backends confirmed attached to
PostgreSQL** before the sweep started.

| run | p50 | p95 | p95 95 % CI | cv |
|---|---:|---:|---|---:|
| idle 1 | 984 | 2881 | 1785–4800 | 0.96 |
| **contended** | 1220 | **7919** | 3834–9779 | 1.02 |
| idle 2 | 1047 | 2551 | 1511–5795 | 0.83 |

Contention raises p95 by **+174.9 %** against the preceding idle run and
**+210.4 %** against the following one. Both flanking idle runs sit far below
the contended one, so this is the load, not drift.

Broader shape, `flank-idle1` vs `contended2` (5 banks × c=1,4, n=40): p95 rose
in **7 of 8 gradeable cells**, median **+19.8 %**, worst `lisa-profile`@c4 at
+162.6 %.

> That comparison's own verdict is `FAIL`, on purpose: the Hindsight container
> was recreated by unrelated fleet work partway through the contended sweep, so
> two cells recorded nothing usable and the harness refuses to grade a run it
> only partly measured. The eight surviving cells are reported here as
> supporting shape, not as a verdict. `flank-idle2.json` was lost entirely to
> the same event and is not committed.

## What is NOT in this baseline

`contended.json` from the first pass **was deleted, not committed.** The load
generator's SQL had its `TABLESAMPLE` alias in the wrong position, every load
backend died on connect, and worker stderr was discarded — so the harness
reported "8 backends running" while measuring a completely idle box. Every
contention number from before commit `42d9425` is void. The generator now
counts its own backends in `pg_stat_activity` and refuses to run if none
attached.


## What this baseline cannot tell you

Three limits, stated up front so nobody reads more into the table than is in it.

**1. It cannot show that the index drop helped.** `idx_memory_units_embedding`
(1526 MB, 288 lifetime scans) was dropped from the live database *before* any
measurement existed. There is no pre-drop run to diff against, so the drop's
benefit — a working set falling from 6705 MB to 5179 MB against a 6144 MB
`shared_buffers` — is **inferred from cache arithmetic, not measured**. The
`EXPLAIN` plan was identical either side of the drop; the claimed benefit is
pure cache headroom. This baseline establishes the *post*-drop state. Treating
it as evidence that the drop worked would be reading a single point as a
trend.

**2. "Idle" means "no synthetic load", not "quiescent box".** The measurements
run against the live production database with the whole fleet on it. Other
agents recall, retain, and consolidate throughout. That is deliberate — it is
the environment users actually experience — but it means run-to-run variance
includes real fleet activity, and a repeated run is not a controlled
experiment.

**3. The contention numbers are a lower bound.** The generator reproduces the
box-level mechanisms of a write storm (buffer eviction, WAL/checkpoint
pressure) but not the LLM half, because manufacturing real model calls to
produce a benchmark number would burn subscription quota. A real
retain/consolidation storm is at least this bad, plausibly worse.

Related: the ~9.1 s/call spike of 2026-08-06 that epic #4474 cites is a
**recorded claim, not a measurement** — the container logs for that window
rotated before they could be replayed. Nothing here reproduces that incident;
the contention mode manufactures its load synthetically.

## Known gap: the size axis stops at production's largest bank

#4475 item 3 asks for a synthetic bank *above* the current maximum. That is not
implemented. Creating one means writing hundreds of thousands of embedded rows
into the live production database, which the harness's own safety contract
forbids, and no restored clone exists to write them into instead. Extending the
axis needs a restored clone first; until then the size axis reaches only as far
as production does.

## Reproducing

```bash
switchroom hindsight-bench --banks spread:5 --concurrency 1,4,8,16 \
  --samples 40 --warmup 5 --label "idle" --out idle.json --csv idle.csv
```

Then `--compare` two idle runs for the reproducibility verdict, and
`--contention-compare` an idle run against a contended one.
