# P2 recall bench raw results — 2026-08-07 (#4476)

Captured by `switchroom hindsight-bench` against the live Hindsight instance
(`ghcr.io/switchroom/switchroom-hindsight:v0.20.13`). The narrative that grades
these files is `docs/hindsight-bench-p2-residency.md`; this README says only
what each file is and how far it can be trusted.

These are **not** a re-capture of `docs/baselines/hindsight-recall-2026-08-07/`
(P1). The instance changed between the two: the image moved v0.20.12 → v0.20.13
and `shared_buffers` moved 6144 MB → 12288 MB, both at 2026-08-07T03:41:33Z, by
unrelated fleet work. A P1↔P2 latency delta is confounded by that and the
narrative says so at every point it quotes one.

| file | what | window (UTC) | trust |
|---|---|---|---|
| `idle.json` / `.csv` | 5 banks × c=1,4,8,16, n=40, no load. Carries the `pg_stat_reset()` epoch. | 04:56:55 – 05:14:41 | good, but see "external load" |
| `contended-read.json` / `.csv` | 5 banks × c=8,16, n=40, 4 read-contention workers. The AC2 hit-ratio window. | 05:14:57 – 05:26:07 | good — 4/4 backends confirmed attached, 0 errors, 0 zero-result calls |
| `phases.json` | `--phases` attribution pass, 3 banks × c=1,8,16 | 05:31 – 05:41 | the AC3 refutation number; see the caveat below |

Every file carries its own `config`, `db` and `instance` block and `samplesMs`
in completion order, so any of it can be re-reduced without re-running.

## Every latency number here was taken under external load

A second worker (#4478, P4) was benchmarking the same instance from
2026-08-07T04:52:44Z — before the idle window opened — and continued through
the contention window. **No file in this directory is a clean idle
measurement.** The AC1 relation sizes and the AC2 hit ratios are unaffected by
this; the latency cells are not.

This is recorded rather than re-run because the P1 record already establishes
that this harness's run-to-run p95 spread is a median 30.5 % on an unchanged
system, so a "clean" re-run would not have been distinguishable from a dirty
one at the effect size in question.

## `phases.json` is an attribution artefact, not a latency artefact

Tracing a recall serialises megabytes of span data, so the traced milliseconds
in `phases[]` are **not comparable to `cells[]`** in the same file, nor to any
other file here. The product is the *shares* — `dbShareOfServer` and
`maxDbSideGainFraction` — which is what `docs/hindsight-bench-p2-residency.md`
grades AC3 against.

Its `cells[]` block is a low-sample latency sweep (n=8) captured incidentally by
the same run. At c=16, n=8 puts fewer calls through the pool than the pool has
workers, so those three cells never reach the concurrency they are labelled
with. Do not quote them. (`phases[]` does not have this problem: the phase sweep
raises its own call count to `max(samples, concurrency)` for exactly this
reason.)

**There is deliberately no `phases.csv`.** The harness's CSV writer emits the
`cells[]` table only — it carries no phase columns at all — so a `phases.csv`
would have been 100 % the unquotable low-sample latency block and 0 % the
attribution the run exists to produce, published in the single most
copy-pasteable form in this directory, one row away from `idle.csv`'s
identically-shaped rows. The generated file was removed rather than annotated:
a warning in a README does not travel with a CSV that someone diffs. Read the
shares out of `phases.json`.

## What is deliberately not here

- **No write-contention run.** AC5 is graded only against `--contention read`.
  `--contention write` requires `--allow-writes`, which the read-only constraint
  on this work did not authorise. The narrative records AC5's 1.87× as a lower
  bound rather than presenting it as the storm number.
- **No raw `pg_statio` dumps.** The differenced heap-hit figures are transcribed
  into the narrative; the raw checkpoints list every relation on the instance by
  name, including per-agent backup tables whose names are the agent roster this
  repo must not publish (#4499).
- **No sweep logs.** The harness prints the real bank names to stdout by design
  (your screen is not a committed artefact) and the pseudonym mapping to stderr.
  Committing either would undo the anonymisation the JSON files carry.
