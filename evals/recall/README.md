# Hindsight recall-quality regression suite

Scores Hindsight **recall quality** and fails when it regresses. Built for
issue #4479 (phase P6 of epic #4474), which exists because the strongest
datapoint in the whole pg_search investigation was a quality one that lived
only in a dry-run note: the candidate backend answered queries the incumbent
returns **zero rows** for. A note cannot gate a change. This turns it into a
number.

Two things this suite is not:

- **It is not a latency benchmark.** That is P1 (#4475). Timings appear in the
  result file under `timings_not_a_measurement` as diagnostics and are never
  scored, never gated, and must never be quoted as performance figures. The
  box that runs this also serves the live fleet and nothing here isolates it.
- **It is not a writer.** The client can issue exactly three requests:
  `GET /health`, `GET /version`, and `POST .../memories/recall`. Anything else
  raises `ReadOnlyViolation`. Recall is a read path; keeping it one is what
  makes running this against production safe.

## Quick start

```bash
pip install pyyaml

# validate the asset (no network, no database, runs in CI)
python3 evals/recall/validate_queryset.py
python3 evals/recall/validate_queryset.py --selftest
python3 -m unittest discover -s evals/recall -p 'test_*.py' -t .

# score a live configuration
python3 evals/recall/run_recall_quality.py run \
    --banks <bank-a>,<bank-b> --backend native \
    --out evals/recall/results/p6-baseline-native.json

# the AC1 non-vacuity check: a deliberately degraded configuration
python3 evals/recall/run_recall_quality.py run \
    --banks <bank-a> --backend native --disable-keyword-arm \
    --out evals/recall/results/p6-vacuity-check.json

# the gate (exit 0 within budget, exit 1 on regression)
python3 evals/recall/run_recall_quality.py compare \
    evals/recall/results/p6-baseline-native.json \
    evals/recall/results/p6-pgsearch.json \
    --max-recall10-drop 0.02 --max-zero-result-regressions 0
```

`--api-url` defaults to `$HINDSIGHT_API_URL`, then `http://127.0.0.1:18888`.

**`run` fails closed.** Any case that errored exits non-zero, because every
metric here is a ratio over the cases that succeeded and a run where most cases
timed out would otherwise print a confident number over the handful that
worked. `--no-fail-on-error` is the explicit escape hatch.

**On a shared box, pass `--limit N` and `--pace-ms`.** The runner is sequential
by construction and has no concurrency knob, but a full run is
`cases x banks` recall calls and that is real load on a database other people
are measuring.

## What it measures

Every recall is issued with `trace: true`, which returns the engine's own
per-stage view (`hindsight_api/engine/search/trace.py:191`, tag `v0.8.6`). The
suite reduces that to ranked id lists per stage:

| stage | source |
|---|---|
| `arm:semantic` / `arm:bm25` / `arm:graph` | `trace.retrieval_results[]`, pooled across `fact_type` by best rank |
| `rrf_client` | RRF recomputed here from the raw arms, `k=60`, matching `engine/search/fusion.py:29` |
| `rrf_engine` | `trace.rrf_merged[]`, as the engine fused it |
| `rerank` | `trace.reranked[]`, cross-encoder output |
| `final` | what the caller received |

Per-stage reporting is the point: when the keyword arm collapses, the fused
list often barely moves, which is exactly how a tokenizer regression hides for
weeks. A regression that shows up at `arm:bm25` and not at `final` is still a
regression, and the epic's risk C1 is precisely that shape.

### The headline metric

```
zero_result_queries_answered / zero_result_queries_total
```

The subset is every query whose **keyword arm returned zero rows in the
reference run**. `answered` counts how many of those the **candidate** run's
keyword arm returns at least one row for.

This metric needs **no relevance judgements at all**, only two runs and a row
count, which is why it is the number this suite can report honestly at full
scale while the graded metrics wait on judgement coverage. A query present in
the reference but absent from the candidate counts as *not answered*, never as
skipped, so a candidate that errors on the hard queries cannot outscore one
that answers them.

Alongside it, every run reports the label-free `keyword_arm_zero_result_rate`
for itself, so a single run is interpretable without a partner file.

**Why native returns zero rows at all**, since this is the phenomenon under
protection: the native arm builds `to_tsquery('<regconfig>', 'tok1 | tok2 |
...')` (`engine/sql/postgresql.py:229-234`) and gates matching on
`search_vector @@ <that query>`. The terms are OR-ed, so on a large bank almost
any content word matches something. The arm therefore goes to zero essentially
only when the *query itself* reduces to nothing under the configured
regconfig, leaving an empty tsquery that matches no row.

That is not a hypothetical. The fleet sets
`HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE=hindsight_english`, a
`COPY = pg_catalog.english` whose snowball dictionary carries the extra
stopword list in `docker/hindsight-extra.stop`
(`docker/hindsight-entrypoint.sh:593`). That list drops corpus boilerplate —
`claude`, `code`, `agent`, `assistant`, `user`, `switchroom`, `sidechain` —
on top of the standard English stopwords, because those lexemes appear in
nearly every memory and turned the keyword arm into a sequential scan. A query
composed *only* of those words produces an empty tsquery and returns nothing.

Measured on the live instance, that is exactly what happens: of ten
`stopword-heavy` cases, the nine built from ordinary English function words
still returned 172-300 keyword rows, because each retained at least one content
lexeme. The one built from fleet boilerplate — `sw-005`, "claude code agent
assistant switchroom sidechain" — returned **zero**. So the family that matters
for the headline metric is not "queries with lots of stopwords" in the ordinary
sense; it is queries whose every token is boilerplate under *this* regconfig.
Grow that population deliberately, and note that a change to
`hindsight-extra.stop` changes the denominator.

### Graded metrics

`recall@10`, `recall@50`, `nDCG@10`, `MRR`, macro-averaged over judged cases,
computed **per stage**. Also `judged_coverage@10`, which is the label-rot
alarm: judgements are pinned to memory-unit ids in a live bank, consolidation
rewrites those units, and a decayed qrels file otherwise looks exactly like a
quality regression. `--min-judged-coverage` fails the run instead.

Unjudged cases are excluded from graded metrics and still counted in the
label-free ones. A query with no positive judgement scores `0.0`, not `1.0` —
the fail-open shape is how a suite goes quietly vacuous.

## Judgement provenance, and its limits

Stated here rather than left implicit, per #4479 item 6.

Relevance judgements live in `qrels/` as **ids and integer grades only**, never
text, and every file must carry a `judgement` block naming the method, the
judge, the date, and the pool. `load_qrels` refuses a file without one.

Supported methods, with what each is worth:

- **`pooled-graded`** — the standard IR compromise. Pool the top-*k* of every
  arm across every configuration under comparison, judge each (query, memory)
  pair on a graded scale with a judge that never sees ranks or scores. Not
  circular in its *labels*, but the *pool* is system-derived, so `recall@k` is
  really recall-within-pool and an unjudged relevant document is invisible.
  Both metrics are therefore conservative, never optimistic.
- **`known-item`** — derive the query from one specific memory and label that
  memory as the single relevant answer. No judge, exact labels, fully
  deterministic. Its bias is lexical: a query derived from a document shares
  vocabulary with it and flatters the keyword arm. Use it for *relative*
  comparisons between configurations, not as an absolute quality figure. Query
  text derived this way must stay out of the committed query set, because it
  is derived from private memory.
- **`operator`** — a human judged it. Cheapest to trust, most expensive to
  produce, does not scale past a few dozen.

**A suite whose labels came from the system it grades would be circular.** None
of the three above take labels from the ranker under test. What they cannot
escape is that the *candidate pool* comes from retrieval systems, which is the
standard, documented limitation of pooled evaluation and the reason
`judged_coverage@10` is reported on every stage.

## The query set is the asset

`queryset/v1.yaml`, 141 cases across seven families, versioned and hashed into
every result file (`config.queryset_sha256`), so a score can never be compared
against a set it was not computed on.

**No real user, bank, or traffic text is in it, and none may be added.** This
repository is public and the banks are a live operator's private memory. Real
recall traffic shaped the *families* and the *length distribution* only; the
`provenance.shaped_by` block records the aggregate statistics that shaping came
from, and `derive_shape.py` reproduces them so the claim is checkable rather
than asserted: 23,538 recalls across 12 agents, median query 691 characters,
43 % hitting the result cap. The source telemetry records `query_chars` as an
integer and never the query itself, so that path cannot leak text even by
accident.

The single most consequential of those numbers: real auto-recall queries are
not short keyword queries, they are multi-sentence transcript slices clipped at
an 800-character cap. `context-blob` is the largest family because of it.

### Adding a case

1. Pick the family it belongs to, or add one to `families` with a one-line
   description of what it probes. An undeclared family is a hard lint error.
2. Give it a stable id (`<family-prefix>-NNN`). Ids are keys in every qrels
   file; renaming one silently orphans its judgements.
3. Write the `text` yourself. Never paste from a transcript, a log, or a bank.
4. `morphological` cases must carry a `probe:` note saying which surface form
   maps to which stem. Lint rejects one without it.
5. Run `python3 evals/recall/validate_queryset.py`.
6. **Do not delete a case because it currently scores zero.** The
   `zero-result-probe` family exists to score zero somewhere; removing the
   cases that do is how the headline metric's denominator quietly disappears.

Bumping `queryset_version` invalidates comparison against older result files by
design: `compare` shows both versions in its report so a mismatch is visible
rather than silently averaged.

## Non-vacuity: how the suite is made to fail

#4479 AC1 requires the suite to go **red** on a deliberately degraded
configuration, and the abort condition says a suite that cannot is worse than
none at all.

The degradation is `--disable-keyword-arm` (alias for `--ablate-arm bm25`).
Rather than flipping a live configuration, which would mutate production to
prove a point, the ablation removes the arm from the **client-side fusion**:
the arm's ranked list is emptied and `rrf_client` is recomputed without its
contributions. Because the *same* client-side fusion scores the ablated and the
non-ablated run, the delta between them is attributable to the ablation and not
to any mismatch between this implementation and the engine's.

Stages the engine computed downstream of its own fusion (`rrf_engine`,
`rerank`, `final`) are **dropped, not recomputed**, in an ablated run: there is
no honest way to simulate a cross-encoder over a candidate set it never saw.
`compare` therefore falls back to `rrf_client` when the candidate has no
`final` stage, so an ablated run is graded on a stage both runs really have
instead of passing on a technicality.

`test_recall_quality.py::Ablation::test_ablated_run_scores_worse_and_the_gate_goes_red`
pins this offline, with no live instance involved.

### Going red is not enough — the gate has to discriminate

A gate that is red on *everything* proves nothing about a degraded config. That
is not hypothetical here: until judgements are committed there is no
`recall@10` on either side, so the recall budget cannot be evaluated at all —
and a compare of a result file **against itself** was red for exactly that
reason. Red-on-degraded is only evidence if green-on-identical is reachable.

So failures are split by kind, and they do not share an exit code:

| verdict | meaning | exit |
|---|---|---|
| `pass` | every evaluable budget was met | 0 |
| `regression` | a budget was evaluated and **measurably** breached | 1 |
| `ungraded` | no regression found, but a budget could not be evaluated | 3 |

`ungraded` still blocks — an uncertifiable run is not a passing run — but it is
a different claim from "the candidate is worse", and CI can tell them apart.

Live, on the committed artefacts:

- baseline vs `--disable-keyword-arm` → `regression`, exit **1**,
  23 keyword-zero regressions
- ablated run vs an identical copy of itself → `ungraded`, exit **3**,
  0 regressions

The discriminating signal is the keyword-zero regression count, which is
**label-free** — it needs two runs and a row count, no judgements. That is what
makes AC1 demonstrable today rather than after a judgement campaign.

## Determinism

#4479 AC3 asks for identical scores across runs, or a documented bound under
1 %. `--runs N` runs the suite N times and emits a `determinism` block:
per-(stage, metric) min/max/spread, the worst spread and which metric carried
it, plus `keyword_zero_set_jaccard` and `keyword_zero_set_unstable_ids` for the
label-free side.

Spread is reported **absolute**, not relative: these metrics are bounded in
[0, 1], and a relative spread explodes meaninglessly near zero. So
`worst_spread` is directly comparable to the 0.01 budget.

**A determinism report that compared nothing does not pass.** Graded metrics
only exist once a qrels file is loaded, so on an unjudged run the graded series
are all empty. A naive implementation would then take the max of an empty set,
report `worst_spread: 0.0`, and read as *perfectly deterministic* while
actually meaning *measured nothing* — the same fail-open shape this suite
exists to catch in the scorer. The block therefore carries `measured` and
`metrics_compared`, and `within_budget` requires `measured` to be true. When
nothing was comparable, `worst_spread` is `null` and the summary prints
`NOT MEASURED` rather than a number.

That is also why variance covers **label-free series** — the keyword arm's
zero-result rate, and each case's per-arm row counts normalised by that case's
max across runs. Those exist without any judgements, so an unjudged run still
yields a real, falsifiable determinism number instead of an empty one.

Three things drive real nondeterminism, in descending order:

1. **The bank keeps changing.** Live agents retain continuously, so the corpus
   under a second run is not the corpus under the first. This dominates
   everything else and is not fixable from inside the suite. For a tight
   determinism measurement, run against a quiet bank or accept the number.
2. **The cross-encoder reranker**, which affects `rerank` and `final` only.
   `arm:*` and `rrf_client` are downstream of neither it nor any model.
3. **ANN traversal.** Deterministic for a fixed HNSW graph, but the graph
   changes as the bank does, folding back into (1).

If the measured spread exceeds the budget, say so and do not wire the suite as
a hard gate at P3's 2 % budget. That is the issue's own abort/re-scope
condition, not a judgement call to make quietly.

## Result files

`--out` writes a self-describing JSON file: query set id, version and sha256,
banks, declared backend, budget, ablated arms, qrels file and case count, plus
the engine's `/version` and `/health` as it reported them. A result without its
configuration is not a result, so a file pasted into an issue comment stands on
its own.

Bank ids are **pseudonymised by default** (`bank-<sha256[:8]>`); they are the
operator's agent names and a committed baseline should not enumerate a private
fleet. `--no-redact-banks` prints them for local debugging. Memory text never
enters a result file at any setting: observations carry ids only.

### What is committed under `results/`

Four files, all produced by the commands in this README against hindsight
`0.8.6`, one bank, a 28-case `--seed 4479` sample, sequential at concurrency 1:

| file | what it is | exit |
|---|---|---|
| `p6-baseline-native-v1.json` | the quality baseline; `--runs 3`, carries the determinism block | 0 |
| `p6-vacuity-check-keyword-ablated.json` | the same sample with `--disable-keyword-arm` | 0 |
| `p6-vacuity-check-compare.json` | baseline vs ablated — the AC1 red proof | 1 |
| `p6-vacuity-check-control-self-compare.json` | the ablated file vs **itself** — the control that shows the red above is specific | 3 |

The control is the point of the pair: without it, exit 1 on the ablated compare
is not evidence, because a gate that is red on everything is red on nothing.

**These are quality numbers. Nothing in them is a latency measurement.** The
box was running an unrelated latency benchmark throughout, by design, so the
`timings_not_a_measurement` block is diagnostic only and is never scored.

## Layout

```
evals/recall/
  metrics.py               pure scoring; no I/O, no clock, no randomness
  client.py                read-only recall client (allowlisted paths)
  queryset.py              query-set + qrels loading, strict
  run_recall_quality.py    the CLI: run / compare
  validate_queryset.py     zero-cost schema + lint, with --selftest
  test_recall_quality.py   unit tests, incl. the gate-goes-red proof
  derive_shape.py          aggregate-only traffic shape stats (never text)
  queryset/v1.yaml         the versioned asset
  qrels/                   relevance judgements, ids and grades only
  results/                 committed baselines
```
