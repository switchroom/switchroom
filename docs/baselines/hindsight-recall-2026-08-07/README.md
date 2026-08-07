# Recall bench raw results — 2026-08-07

Captured by `switchroom hindsight-bench` against the live Hindsight instance
(`ghcr.io/switchroom/switchroom-hindsight:v0.20.12`) after
`idx_memory_units_embedding` was dropped. The narrative that reads these files
is `docs/hindsight-bench-baseline.md`; this README says only what each file is
and how far it can be trusted.

Every file carries its own `config`, `db` and `instance` block, so it stays
self-describing when pasted into an issue months from now. `samplesMs` holds
every raw latency in completion order, so any of this can be re-reduced without
re-running anything.

| file | what | trust |
|---|---|---|
| `idle-a.json` / `.csv` | 5 banks × c=1,4,8,16, n=40, no load | good — the reference run |
| `idle-b.json` / `.csv` | the same sweep repeated ~20 min later | good — the AC1 repeat |
| `aba3-idle1.json` | `bank-01`@c1, n=100, idle | good — A of the A/B/A |
| `aba3-cont.json` | `bank-01`@c1, n=100, 4 load workers × 10 % scans | good — B, 4/4 backends confirmed attached |
| `aba3-idle2.json` | `bank-01`@c1, n=100, idle | good — the second A |
| `flank-idle1.json` / `.csv` | 5 banks × c=1,4, n=40, idle | good |
| `contended2.json` / `.csv` | the same sweep under load | **partial** — see below |
| `arms.json` | per-retrieval-arm attribution, low-sample traced pass | indicative only; a traced recall serialises megabytes, so these timings are NOT comparable to the latency cells |

## `contended2.json` is partly unusable, deliberately kept

The Hindsight container was recreated by unrelated fleet work at 00:15:50Z,
partway through this sweep. `bank-14@c4` recorded 40 errors and no
samples; `bank-14@c1` recorded 6 samples against 34 errors, and its
resulting p95 of 1728 ms — computed over whichever calls were fast enough not to
fail — would read as the fastest cell in the run.

`switchroom hindsight-bench --contention-compare flank-idle1.json contended2.json`
therefore exits 1 and names both cells `UNGRADEABLE`. That is the correct
behaviour and the file is kept as the fixture that demonstrates it. The eight
intact cells are still informative and are quoted in the baseline as supporting
shape, never as a verdict.

The matching post-contention idle run was lost entirely to the same event and
is not committed — a run of nothing but errors carries no information.

## Not here on purpose

The first contended sweep (before commit `42d9425`) is deleted, not archived.
Its load generator's SQL was syntactically invalid, so every load backend died
on connect while the harness reported them as running; the file records an idle
system under a label claiming otherwise. Keeping it would only give a future
reader a chance to cite it.
