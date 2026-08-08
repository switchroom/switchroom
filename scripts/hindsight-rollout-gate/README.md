# Hindsight server-bump rollout gate

Operational tooling that decides go/no-go for a Hindsight **server** upgrade
(the `switchroom-hindsight` image), by measuring whether recall results and
recall latency changed across the restart.

Originally written for the 0.8.6 → 0.9.0 bump (epic switchroom#4525, WP0
switchroom#4527) and kept outside the repo. It is in the repo now because a
runbook depends on it and because it was proven to need tests — see below.

| file | what |
|---|---|
| `rollout_gate.sh` | the driver. `pre` then `post`. Use this, not the pieces. |
| `canned_recall.py` | captures 10 fixed queries × N banks: `result_count`, ordered `memory_ids`, latency, **plus instance identity and capture time** |
| `compare_baseline.py` | the comparator that produces the verdict |
| `expected_shifts.json` | declared, version-scoped expected-shift cells |
| `soak_measure.py` | per-agent cache-miss recall count / median / p90 from `recall_log.jsonl` |
| `tests/` | the self-test (`python3 -m unittest discover -s tests -t .`) |

## Why this is shaped like this

The first version of these scripts would have produced a **fully-red board at
rollout time on completely healthy data**.

WP6 (switchroom#4533) ran the control experiment that proved it: it compared a
captured baseline against **the same code (0.8.6) on a fresh restore of that
instance's own dump**. Identical code, identical data — **30/30 cells flagged
at Jaccard 0.36–0.75**. Independently confirmed by the stage-4 validator on
switchroom#4525.

The Jaccard number is not measuring the code. It is dominated by physical row
order: `_select_with_temporal_coverage` and friends stable-sort on similarity
with no deterministic tiebreaker, so ties inherit SQL row order, and anything
that changes plans — a `pg_restore` rebuilding every index with fresh
statistics, hours of organic ingest — reshuffles `LIMIT`-ed retrieval arms.

So the 0.8 floor is meaningful in **exactly one** configuration:

> **live-before vs live-after, on the same running instance, with the baseline
> captured minutes beforehand.**

The old scripts could not tell that configuration apart from any other, because
the artifact recorded neither which instance it came from nor how stale it was.
Everything below exists to close that.

## The workflow

```sh
export HINDSIGHT_API_URL=http://127.0.0.1:18888

# 1. MINUTES before the maintenance window, against LIVE production:
./rollout_gate.sh pre

# 2. ... perform the upgrade ...

# 3. Immediately after, same instance:
./rollout_gate.sh post        # captures, then compares, then prints the verdict
```

`post` reuses the run directory, the API URL and the pinned recency anchor that
`pre` recorded, so those cannot drift between the two halves by accident.

Exit codes from the comparator:

| code | meaning |
|---|---|
| `0` | **GATE PASS** — no failing cells. Declared expected shifts may be present and are always listed. |
| `1` | **GATE FAIL** — at least one failing cell. This is a verdict about the upgrade. |
| `2` | **GATE MISUSE** — the two captures are not validly comparable. This is *not* a verdict about the upgrade; fix the inputs and re-run. |

Distinguishing 2 from 1 is the point. A runbook that cannot tell "the gate says
no" from "you used the gate wrong" trains the operator to ignore red.

## Instance identity

Every capture records an `instance` block. The comparator refuses (exit 2) when
any of these disagree between the two captures:

| field | why it is identity |
|---|---|
| `db_system_identifier` | the Postgres cluster identity, read read-only via `pg_controldata`. **The strong one**: invariant across an application-image upgrade (same data directory), different on any `pg_restore` into a fresh cluster. Exactly the signal that would have caught WP6's comparison B. |
| `api_url` | catches "baseline came from the staging container" |
| `instance_id` | optional operator label |

Recorded but deliberately **not** identity: `api_version` (it is *supposed* to
change across the upgrade) and `banks_fingerprint` (a bank added mid-window is
a comparability note, not a different instance — it warns).

If the cluster-identity probe cannot run, the capture and every report say so
loudly: identity was then only checked `api_url`-deep, which does not catch a
repoint to different data. Override the probe with `--db-identity-cmd` (any
read-only command printing one stable token) for a different topology.

## Freshness

The comparator refuses (exit 2) a baseline more than `--max-baseline-age-hours`
(default **4h**) older than the post run — "minutes, not days". A baseline
frozen days earlier absorbs hours of organic ingest and partially false-alarms
on its own, with no code change involved.

`--allow-stale-baseline` and `--allow-cross-instance` downgrade these to
warnings, but stamp the whole report **ADVISORY ONLY — not a valid gate**. They
exist for post-hoc investigation, not for rollout decisions.

## Declared expected shifts

`expected_shifts.json` declares cells that are *known* to move for a understood,
non-defect reason. A declaration:

* **reclassifies** a cell from `FAIL` to `expected-shift` — only while its
  measured Jaccard is inside the declared band;
* **never silences it** — every declared cell is printed inline *and* again in
  a dedicated "Declared expected-shift cells (reported, never silenced)"
  section, with its measured value and the reason;
* **still fails below the band** (`jaccard < jaccard_min`) — the declaration is
  a band, not a floor removal;
* **still fails on a count swing** — the declared 0.9.0 shift is count-neutral,
  so a count move means it is not the declared shift;
* **reports `expected-shift-not-observed`** when the measurement is *above* the
  band. A declaration that stops matching reality is a stale declaration, and
  it must be visible rather than quietly satisfied;
* **is version-scoped** via `from_api_version` / `to_api_version`, so it retires
  itself once the fleet moves past the versions it was reasoned about, instead
  of excusing the same cell forever. A declaration that matched no cell is
  reported as such.

The one shipped declaration is `temporal-relative` for 0.8.6 → 0.9.0. Band
0.60–0.85, derived from WP6's byte-identical-data measurements (overlord 0.793,
klanker 0.688, finn 0.782) widened only enough to absorb the ingest that accrues
between a live pre-capture and a live post-capture minutes later. It is
deliberately not widened to cover WP6's comparison-B artefact range (0.36–0.75):
the low end must stay a failure.

**This entry needs the epic owner's explicit sign-off** before the WP7 window —
WP6 and the stage-4 validator both flagged that Jaccard cannot say whether the
shift is better or worse, only that it is real, bounded, deterministic,
count-neutral and latency-neutral.

## Soak measurement

`soak_measure.py` is unchanged and keeps using the WP0 frozen window. Latency
medians/p90 are robust to organic ingest, so they do **not** need the
live-before/live-after treatment — only the result-set comparison does.

```sh
./soak_measure.py --json soak-metrics-<date>.json          # pre
./soak_measure.py --since <0.9.0 rollout ts> --json ...    # post-flight
```

## Self-test

```sh
python3 -m unittest discover -s tests -t .
```

Stdlib only, no network. It drives the real comparator against known-good and
known-bad inputs, including the actual WP6 measurements, and asserts the verdict
and exit code — because the failure this whole rework exists for was a gate that
reported red on healthy data and had never been run against either kind of
input. Runs in CI via `.github/workflows/ci-tests-python.yml`.
