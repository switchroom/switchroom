# hindsight-bench — recall latency vs bank size and contention

`switchroom hindsight-bench` measures one thing: **how long a Hindsight recall
takes**, as a function of (a) how big the bank is and (b) how many recalls are
in flight at once. It reports **percentiles, not means** — the question the
epic asks is about the tail, and a mean hides exactly the tail it is asking
about.

It exists because #4474's premise — *"consistent latency across any bank size
and good quality/performance including when we have contention on the box for
many queries"* — was unfalsifiable. There was no number to move. Every fix in
the epic (index drops, `ef_search` tuning, arm parallelism) is an assertion
until something measures it the same way twice. This is that something.

Jobs served: `reference/jobs/remember-across-sessions.md` — recall is the read
half of it, and a recall that takes 20 s is a recall the agent's user gave up
waiting for.

## Safety: what it does to the live box

**The harness never mutates the memory bank.** Recall is a read path; the
harness only reads it. It does not retain, does not consolidate, does not
write memories, and does not reset statistics as a side effect.

Three mechanisms enforce that rather than merely promising it:

| Guard | Mechanism |
|---|---|
| Read-only DB sessions | Every psql session is opened with `PGOPTIONS=-c default_transaction_read_only=on`. |
| The clamp is *verified*, not declared | Before the sweep, the harness runs a real `CREATE TEMP TABLE` and requires Postgres to **reject** it. A `SHOW transaction_read_only` check would pass against a session that could still write; this one cannot. Failing the probe aborts the run. |
| `pg_stat_reset()` is opt-in | Only under an explicit `--reset-stats`. It is never a side effect of a default run, because #4476's acceptance depends on a controlled reset epoch. |

`--allow-writes` is the single documented escape hatch, and it exists for one
reason: `--contention write` needs a writable session for its own scratch
table. Without the flag, a writable session aborts the run.

### Blast radius of `--contention`

`--contention` **deliberately degrades the live box while it runs.** That is
the point — it is measuring what other agents experience under load — but it
means every agent's recall is slower for the duration. Defaults are
conservative (2 load backends, 2 % block sample) and every knob is a flag, so
the load level is a parameter and not a fixed constant.

Two independent stops bound an orphaned load generator:

1. an absolute in-SQL deadline computed at start, so a backend that loses its
   parent still stops on its own;
2. a `pg_terminate_backend` sweep keyed on a dedicated `application_name`,
   run from the `finally` **and** from explicit `SIGINT`/`SIGTERM` handlers
   (Ctrl-C does not run a `finally`, so without the handlers an abandoned run
   would keep hammering production until its deadline).

### What the contention generator does *not* reproduce

It reproduces the two **box-level** mechanisms a retain/consolidation storm
imposes on the read path — buffer-pool eviction (`read`) and WAL / checkpoint /
autovacuum pressure (`write`, against a scratch table the harness owns). It
does **not** reproduce the LLM half of such a storm, and no tuning here will:
driving real model calls to manufacture load would burn subscription quota to
produce a benchmark number, which `CLAUDE.md`'s subscription-honest constraint
forbids.

Consequence, stated plainly: **a number measured under this generator is a
lower bound** on what a real consolidation storm does.

Relatedly, the ~9.1 s/call spike of 2026-08-06 that #4474 cites is a *recorded
claim*, not a measurement this harness reproduces — the container logs for that
window rotated before anyone replayed them. The generator manufactures
contention synthetically and never cites the incident as evidence.

## What it measures

One **cell** is a `(bank, concurrency)` pair. For each cell the harness:

1. runs `--warmup` recalls and discards them (first-touch page faults are not
   the thing being measured);
2. runs `--samples` recalls through a **pull-based worker pool**, so `c=8`
   means eight recalls genuinely in flight at all times. Batching would have
   measured batch-max latency instead, which is a different and less useful
   number;
3. times each call to **full body read**, not to first byte;
4. reduces to `p50 / p95 / p99`, plus `min`, `max`, mean, **population
   variance and stddev**, the sample count, and the error count.

Percentiles are **nearest-rank, non-interpolated**. Errored calls are counted
separately and never folded into the percentiles — a timeout is not a fast
call and must not flatter the tail.

Every cell also records `meanResults` and `zeroResultCalls`. Without them a
latency table cannot distinguish *"recall got faster"* from *"recall stopped
finding anything"*, which are the same number and opposite outcomes. The
human-readable summary prints a loud block whenever any cell returned zero
results.

### The bank-size axis uses real banks

`--banks spread:5` picks five real banks spread evenly in **log10(row count)**
space, so the axis is dominated by scale rather than by whichever banks happen
to be biggest. `top:<n>`, `all`, and an explicit comma list are also accepted.

**Known gap (#4475 item 3):** there is no synthetic bank *above* the current
largest real bank. Creating one means writing hundreds of thousands of
embedded rows into the live production database, which the safety contract
above forbids, and no restored clone is available to write them into instead.
The size axis therefore extends only as far as production actually reaches.
This is a scope decision, not an oversight; extending the axis needs a
restored clone first.

### Arm attribution is a separate pass

`--arms [n]` runs a low-sample traced pass that attributes time to the
individual recall arms. Tracing changes what is being timed, so **arm results
must never be compared against the latency table** — they answer "where does
the time go", not "how long does it take".

## Output

Every run emits:

- **`--out <path>` — a JSON result file.** Self-describing: it carries the full
  run configuration, the DB state at run time (`shared_buffers`,
  `effective_cache_size`, `hnsw.ef_search`, `memory_units` heap/index sizes,
  per-bank row counts, the largest indexes with lifetime scan counts, the
  `pg_stat` reset epoch, server version), the instance state (image tag and
  reranker candidate cap), and every cell. It is diffable across runs and is
  what the verdict modes consume.
- **`--csv <path>` — a flat per-cell CSV**, for pasting into an issue comment
  or a spreadsheet.
- **a human-readable summary on stdout.**

The image tag and reranker cap are read **by name** (`docker inspect --format
'{{.Config.Image}}'`, `printenv <ONE_VAR>`). A bare `docker inspect` or bare
`printenv` prints every injected secret, so neither is ever run.

The result file carries `schema: 1`. Bump it when a field's meaning changes;
the comparison modes refuse to compare across schema versions.

## Verdict modes

These do not measure anything — they read result files and return an exit code,
so they work in CI or a cron.

```
switchroom hindsight-bench --compare idle-a.json idle-b.json
switchroom hindsight-bench --contention-compare idle-a.json contended.json
switchroom hindsight-bench --plot idle-a.json contended.json --out chart.svg
```

- **`--compare` (AC1, reproducibility.)** PASS when every shared cell's p95
  agrees within `--tolerance` (default 0.1 = ±10 %). Prints the per-cell
  relative delta and names the worst cell.
- **`--contention-compare` (AC4, does the load generator work?)** PASS when the
  contended run's p95 is meaningfully **above** the idle run's. A load
  generator that does not move p95 is broken, and this is the check that says
  so.
- **`--plot`** renders a dependency-free SVG (log x-axis, Okabe-Ito palette).

`--json` makes either verdict machine-readable. Exit codes: `0` PASS, `1` FAIL,
`2` usage/IO error.

### Both verdicts refuse a run they only partly measured

A cell is **ungradeable** when every call errored, or when more than 10 % of
them did. Ungradeable cells are named in the report and force `FAIL`, and the
contention verdict says explicitly that the failure is on the measurement
rather than the generator.

This is not hypothetical tidiness. During the 2026-08-07 baseline the Hindsight
container was recreated by unrelated fleet work mid-sweep. Two of ten cells lost
their data; the eight survivors still cleared the contention threshold
comfortably, so before this gate existed the run would have printed a confident
PASS over a sweep that had partly failed. One of the damaged cells kept six
samples out of forty and reported the **lowest** p95 in the run — a percentile
over whichever calls were fast enough not to time out is not a fast cell, it is
a broken one.

Neither verdict is graded on whichever cells happened to survive. Re-run.

## Running it

```bash
# default: 5 banks × {1,4,8,16} concurrency, idle, read-only
switchroom hindsight-bench --out idle.json --csv idle.csv --label "baseline"

# the same sweep under synthetic read contention
switchroom hindsight-bench --contention read --contention-workers 2 \
  --contention-scan-pct 2 --out contended.json --label "contended"
```

A sweep is **slow by construction**: 20 cells × (samples + warm-up) sequential
recalls, and a large bank at `c=16` is measured in tens of seconds per call.
Budget tens of minutes per run and do not run two concurrently — two sweeps
contend with each other and both results are garbage.

## Baseline

See `docs/hindsight-bench-baseline.md` for the captured post-index-drop
baseline, the reproducibility number actually achieved, and what that baseline
can and cannot tell us.
