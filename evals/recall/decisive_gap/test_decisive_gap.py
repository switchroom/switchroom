#!/usr/bin/env python3
"""Regression tests for the decisive-relative-gap ranker (RFC memory-redesign P11).

Runs in CI with no network, no database and no docker image. It asserts
**outcomes**: for every fixture case, which candidate the gap-damped scorer ranks
first at that case's gap. These are the spec for the knob's ranking behaviour.

The ranking rule this set guards ALREADY SHIPS — the CE-saturation patch bakes it
into the pinned image at the default gap 0.02 — so these assertions PASS against
the faithful re-implementation in ``ranker.py``. This set is therefore a
*validation asset* for tuning ``HINDSIGHT_CE_DECISIVE_RELATIVE_GAP``, not a
pending spec: there is no abstain/"no confident answer" behaviour anywhere in the
engine or shim, and P11 introduces none, so no case is marked xfail. The one part
of P11's RFC gate that is genuinely unbuilt — a live, per-bank, human-judged
before/after run — cannot be an offline fixture and rides on the same qrels
judgement campaign the recall-quality suite's README documents as pending.

`DriftGuard` is the load-bearing safety: it pins ``ranker.py`` to the exact
constants the docker probe (``tests/docker/hindsight-search-patches.test.ts``)
asserts against the *baked* code, so this offline re-implementation cannot drift
from what actually ranks the fleet's recalls without failing loudly here.

Run: `python3 -m unittest discover -s evals/recall -p 'test_*.py' -t .`
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))

from evals.recall.decisive_gap import ranker  # noqa: E402
from evals.recall.decisive_gap.fixtures import DEFAULT_PATH, load_fixtures  # noqa: E402

FIXTURES = load_fixtures(DEFAULT_PATH)


class DriftGuard(unittest.TestCase):
    """Pin ranker.py to the constants the docker probe asserts on the baked code.

    Every literal here is one the probe (hindsight-search-patches.test.ts) checks
    against the real ``apply_combined_scoring``. If upstream re-tunes an alpha or
    the derivation changes, both this and the probe must be updated together — a
    silent divergence between this offline set and the shipped ranker is exactly
    what this class exists to prevent.
    """

    def test_production_alphas_match_the_probe(self):
        # hindsight-search-patches.test.ts:310
        self.assertEqual(ranker.PROD_ALPHAS, (0.2, 0.2, 0.1))

    def test_default_gap_matches_the_patch(self):
        # Dockerfile.hindsight:343
        self.assertEqual(ranker.DEFAULT_GAP, 0.02)

    def test_damping_exponent_at_default_gap(self):
        # hindsight-search-patches.test.ts:327 pins k = 0.03949271225122802.
        self.assertAlmostEqual(ranker.boost_authority(0.02), 0.03949271225122802, places=12)

    def test_damped_worst_case_ratio_is_one_plus_gap(self):
        # hindsight-search-patches.test.ts:329 — damped ratio lands on 1.02 exactly.
        k = ranker.boost_authority(0.02)
        self.assertAlmostEqual(ranker.undamped_boost_ratio() ** k, 1.02, places=9)

    def test_undamped_ratio_is_about_1_65(self):
        self.assertAlmostEqual(ranker.undamped_boost_ratio(), 1.6510721247563356, places=12)

    def test_clamp_threshold_is_about_0_651(self):
        # recall.py:573 / hindsight-search-patches.test.ts:354.
        self.assertAlmostEqual(ranker.clamp_threshold(), 0.6510721247563356, places=12)

    def test_wide_gap_clamps_exponent_to_one(self):
        # hindsight-search-patches.test.ts:346 — gap 1.0 => k == 1.0 (upstream).
        self.assertEqual(ranker.boost_authority(1.0), 1.0)
        self.assertEqual(ranker.boost_authority(ranker.clamp_threshold() * 1.01), 1.0)

    def test_knob_is_monotone_in_the_exponent(self):
        # hindsight-search-patches.test.ts:364 — wider gap damps less.
        exps = [ranker.boost_authority(g) for g in (0.005, 0.02, 0.10, 0.30)]
        self.assertEqual(exps, sorted(exps))
        self.assertLess(exps[0], exps[-1])


class FixtureShape(unittest.TestCase):
    def test_every_declared_class_is_exercised(self):
        # Non-vacuity: a class nothing tests is a claim nothing backs.
        used = {c.cls for c in FIXTURES.cases}
        self.assertEqual(used, set(FIXTURES.classes), "declared classes and used classes diverge")

    def test_the_set_is_not_trivially_small(self):
        self.assertGreaterEqual(len(FIXTURES.cases), 12)


class ExpectedTop(unittest.TestCase):
    """The regression assertion: the gap-damped scorer ranks expect_top first."""


def _make(case):
    def test(self):
        cands = [
            ranker.Candidate(c.id, c.ce, c.recency, c.temporal, c.proof) for c in case.candidates
        ]
        ranked = ranker.rank(cands, case.gap)
        self.assertEqual(
            ranked[0],
            case.expect_top,
            f"{case.id} ({case.cls}, gap={case.gap}): expected {case.expect_top!r} on top, "
            f"got {ranked!r}",
        )

    return test


for _case in FIXTURES.cases:
    setattr(ExpectedTop, f"test_{_case.id.replace('-', '_')}", _make(_case))


class ClassInvariants(unittest.TestCase):
    def test_decisive_cases_preserve_full_ce_order(self):
        # A "decisive" case is one where CE alone should decide, so ranking by
        # combined_score must equal ranking by ce. This is a stronger claim than
        # just the top id and it is the defining property of the class.
        for case in FIXTURES.cases:
            if case.cls != "decisive":
                continue
            cands = [
                ranker.Candidate(c.id, c.ce, c.recency, c.temporal, c.proof)
                for c in case.candidates
            ]
            by_score = ranker.rank(cands, case.gap)
            by_ce = [c.id for c in sorted(cands, key=lambda c: -c.ce)]
            self.assertEqual(by_score, by_ce, f"{case.id}: boosts perturbed a decisive CE order")

    def test_rollback_cases_reproduce_upstream(self):
        # At a rollback gap the exponent must be exactly clamped (upstream scoring).
        for case in FIXTURES.cases:
            if case.cls != "rollback":
                continue
            self.assertEqual(
                ranker.boost_authority(case.gap),
                1.0,
                f"{case.id}: rollback gap {case.gap} did not clamp the exponent to 1.0",
            )


if __name__ == "__main__":
    unittest.main()
