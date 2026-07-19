"""Switchroom hindsight-leverage PR5 — unit tests for recall tag-weight demotion.

`_apply_tag_weights` multiplies a result's ``scores.final`` by a per-tag weight
BEFORE the relevance sort, so a down-weighted tag (e.g. ``sidechain: 0.8``) is
DEMOTED (ranked lower) rather than DROPPED. The load-bearing properties:

  1. A penalised memory sorts BELOW an equal-score un-penalised one.
  2. A penalised memory STILL surfaces when it is the only relevant hit — i.e.
     the mechanism is a re-rank, never the hard demote-tag drop filter.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from recall import _apply_tag_weights, _sort_by_final_score  # noqa: E402


def _mem(text, final, tags=None):
    return {"text": text, "tags": tags or [], "scores": {"final": final}}


class ApplyTagWeights(unittest.TestCase):
    def test_penalised_memory_sorts_below_equal_score_neutral(self):
        neutral = _mem("neutral fact", 0.50, [])
        sidechain = _mem("sidechain fact", 0.50, ["sidechain"])
        results = [sidechain, neutral]  # sidechain first before weighting
        changed = _apply_tag_weights(results, {"sidechain": 0.8})
        _sort_by_final_score(results)
        self.assertEqual(changed, 1)
        # After the 0.8 penalty, the neutral memory ranks first.
        self.assertEqual(results[0]["text"], "neutral fact")
        self.assertEqual(results[1]["text"], "sidechain fact")

    def test_sidechain_still_surfaces_when_only_hit(self):
        # Only a sidechain memory is relevant — it must remain, just penalised.
        only = _mem("the only relevant fact", 0.42, ["sidechain"])
        results = [only]
        _apply_tag_weights(results, {"sidechain": 0.8})
        _sort_by_final_score(results)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["text"], "the only relevant fact")
        # Score was scaled, not zeroed/removed.
        self.assertAlmostEqual(results[0]["scores"]["final"], 0.42 * 0.8)

    def test_higher_scored_sidechain_can_still_beat_weaker_neutral(self):
        # Demotion is a multiplier, not a floor: a strong sidechain hit still
        # outranks a much weaker neutral one.
        strong_sidechain = _mem("strong sidechain", 0.90, ["sidechain"])
        weak_neutral = _mem("weak neutral", 0.30, [])
        results = [weak_neutral, strong_sidechain]
        _apply_tag_weights(results, {"sidechain": 0.8})  # 0.90*0.8 = 0.72 > 0.30
        _sort_by_final_score(results)
        self.assertEqual(results[0]["text"], "strong sidechain")

    def test_empty_or_missing_weights_is_noop(self):
        m = _mem("x", 0.5, ["sidechain"])
        self.assertEqual(_apply_tag_weights([m], {}), 0)
        self.assertEqual(_apply_tag_weights([m], None), 0)
        self.assertEqual(m["scores"]["final"], 0.5)

    def test_untagged_memory_untouched(self):
        m = _mem("x", 0.5, [])
        self.assertEqual(_apply_tag_weights([m], {"sidechain": 0.8}), 0)
        self.assertEqual(m["scores"]["final"], 0.5)

    def test_compound_weight_for_multiple_matching_tags(self):
        m = _mem("x", 1.0, ["sidechain", "anti-pattern"])
        _apply_tag_weights([m], {"sidechain": 0.8, "anti-pattern": 0.5})
        self.assertAlmostEqual(m["scores"]["final"], 1.0 * 0.8 * 0.5)

    def test_weight_of_one_is_noop(self):
        m = _mem("x", 0.5, ["sidechain"])
        self.assertEqual(_apply_tag_weights([m], {"sidechain": 1.0}), 0)
        self.assertEqual(m["scores"]["final"], 0.5)

    def test_scoreless_result_left_untouched(self):
        m = {"text": "x", "tags": ["sidechain"]}  # no scores dict
        self.assertEqual(_apply_tag_weights([m], {"sidechain": 0.8}), 0)
        self.assertNotIn("scores", m)

    def test_non_positive_or_bad_weight_ignored(self):
        m = _mem("x", 0.5, ["sidechain"])
        _apply_tag_weights([m], {"sidechain": 0})       # non-positive → ignored
        _apply_tag_weights([m], {"sidechain": "bad"})   # non-numeric → ignored
        self.assertEqual(m["scores"]["final"], 0.5)


if __name__ == "__main__":
    unittest.main()
