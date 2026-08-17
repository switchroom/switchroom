# Decisive-relative-gap ranking regression set (RFC memory-redesign P11)

The regression set that gates RFC memory-redesign item **P11**
(`HINDSIGHT_CE_DECISIVE_RELATIVE_GAP`). P11 was the last blocked RFC item, and
the block was the absence of exactly this asset:

> **Gate, and it is hard:** a fixed-query regression set must exist first … No
> such set exists today. Building it is the actual work of this item; turning the
> knob is one line.
> — `workspace/memory-redesign/phase4-rfc.md:796-799`

This set is that gate, built as an **offline, deterministic** fixture suite in
the same shape as the recall-quality suite next door (`../metrics.py` /
`../queryset/v1.yaml` / `../test_recall_quality.py`): a versioned+hashed YAML
asset, a pure scorer with no I/O, a strict loader, a `--selftest` validator, and
a unittest that asserts outcomes.

## What the knob actually is (read this before adding a case)

`HINDSIGHT_CE_DECISIVE_RELATIVE_GAP` is a **ranking-damping knob**, not an
"abstain / no confident answer" gate. There is no abstention anywhere in the
engine or the shim, and P11 introduces none — so this set has **no `abstain`
class**, and building one would encode a policy that neither the code nor the RFC
has.

The final ranking score baked by the CE-saturation patch
(`docker/Dockerfile.hindsight`, `_boost_authority` ~L400 and the damped
`combined_score` ~L435) is:

```
combined_score = cross_encoder_score_normalized * (boost_product ** k)
boost_product  = recency_boost * temporal_boost * proof_count_boost
each boost      = 1 + alpha * (signal - 0.5),  signal in [0, 1]
k               = min(1.0, log1p(gap) / log(hi / lo))
```

`k` confines the boost product's worst-case max/min ratio to exactly `1 + gap`.
So the knob **bounds how far the recency / temporal / proof_count boosts may
perturb the cross-encoder's ordering**:

- **decisive** — one candidate's CE score leads by more than the worst-case boost
  span, so the CE order holds regardless of the boosts. This is the fix: on the
  measured saturated bank (`overlord`, every CE inside 0.9800-0.9999) the single
  highest-CE memory had ranked 7th behind older, more-proven ones.
- **bunched** — the CE scores are close, so the boosts decide, and recency (the
  strongest boost, alpha 0.2) wins. That is **constraint 4, "recency bias is
  correct"** (`phase4-rfc.md:46`), which is the constraint P11 serves
  (`phase4-rfc.md:960`).
- **rollback** — widening `gap` to `>= ~0.651` clamps `k` to `1.0`, i.e.
  byte-for-byte upstream scoring with the patch inert. This is the documented
  container-restart rollback path (`recall.py:573`), and it reproduces the
  pre-patch defect (old high-proof outranks fresh high-CE) on purpose.

## Is the threshold pinned?

**Yes — the RFC and the patch pin it, so nothing here is invented policy.**

- Default gap **`0.02`** (`Dockerfile.hindsight:343`) — the measured saturation
  spread on bank `overlord`.
- Clamp / rollback threshold **`~0.6510721`** (`= expm1(log(hi/lo))` at the
  production alphas `(0.2, 0.2, 0.1)`; `recall.py:573`,
  `hindsight-search-patches.test.ts:354`).

Every case nonetheless carries an explicit `gap`, so the set is reproducible
regardless of host env **and** the eventual implementer can sweep the knob per
deployment. One subtlety the boundary cases encode: `1 + gap` is a *worst-case*
band (all three boosts maxed in opposition); the gap at which a *specific* pair
actually flips is tighter and depends on which signals differ. `dg-bnd-004/005`
straddle the ~0.134 flip of the canonical fresh-CE-vs-old-proof pair, which is
**not** the 0.651 clamp.

## Layout

```
decisive_gap/
  ranker.py             pure re-implementation of the baked scorer; no I/O, no env
  fixtures.py           strict loader (unknown key / dup id / out-of-range = error)
  fixtures/v1.yaml       the versioned, hashed asset
  validate_fixtures.py  zero-cost lint + --selftest (a tampered expectation must fail)
  test_decisive_gap.py  unittest: per-case expected-top + class invariants + drift guard
```

`ranker.py` is a client-side re-implementation for the same reason `../metrics.py`
recomputes RRF as `rrf_client`: CI must assert offline without the 6.4 GB pinned
image. **The authority that the *baked* code matches this is the docker probe**
`tests/docker/hindsight-search-patches.test.ts`; `DriftGuard` in the test pins
`ranker.py` to the exact constants that probe asserts (`k = 0.03949271225122802`,
damped ratio `1.02`, undamped ratio `~1.651`, clamp `~0.651`), so a divergence
between this offline set and what actually ranks the fleet's recalls fails loudly.

## Run

```bash
pip install pyyaml
python3 evals/recall/decisive_gap/validate_fixtures.py            # lint the asset
python3 evals/recall/decisive_gap/validate_fixtures.py --selftest # prove the lint can fail
python3 -m unittest discover -s evals/recall -p 'test_*.py' -t .   # discovers this suite too
```

## Why these cases go green, not red

The task that commissioned this set anticipated pending/xfail cases, on the
premise that the ranking rule was unimplemented. It is not: the CE-saturation
patch **ships** at the default gap, so the ranking behaviour is live and these
assertions **pass**. This set is therefore a *validation asset* for safely tuning
the knob (run it at a candidate gap, see which cases move), not a spec for
unbuilt behaviour — which is why no case is `xfail`.

The one part of P11's RFC gate that is **genuinely unbuilt** is a live,
per-bank, human-judged before/after run of real operator queries
(`phase4-rfc.md:796-798`). That cannot be an offline fixture — this repo is
public and the banks are private, and it needs relevance judgements the
`../qrels/` campaign has not produced yet (see `../README.md`, "Graded metrics").
It is deferred on the same judgement coverage the recall-quality suite waits on,
not delivered here.

## Adding a case

1. Pick a class, or add one to `classes` with a one-line description. An
   undeclared class is a hard lint error.
2. Give it a stable id `dg-<class-prefix>-NNN`.
3. Write the `text` yourself — authored flavour only, never a real query, bank,
   or transcript slice. The assertion is on the scores, never the wording.
4. Set each candidate's `ce` and its three boost signals in `[0, 1]`
   (`recency` / `temporal` / `proof`; omitted signals default to the neutral
   `0.5`). Set `gap` and `expect_top`.
5. Run `python3 evals/recall/decisive_gap/validate_fixtures.py` — it recomputes
   the ranking and rejects an `expect_top` that does not match the mechanic, so a
   hand-computed expectation cannot silently drift.
