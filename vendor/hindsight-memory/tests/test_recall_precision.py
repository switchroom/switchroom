"""Retrieval-precision measurement for the Switchroom Phase-1 memory changes.

Per the RFC's outcome-UAT rule (reference/rfcs/hindsight-memory-reimagined.md,
"Measurement"), the bank-starvation fix ships behind a check that compares
recalled-set relevance before/after the sort. These tests assert the two
load-bearing properties of the fix:

  1. The merged multi-bank result set is ordered by the engine's real
     relevance score (`scores.final`) descending.
  2. A high-relevance memory from an ADDITIONAL bank is not starved by the
     count cap when the own bank supplies enough lower-relevance hits to
     fill it — the pre-fix bug (append-then-slice) would drop it.

`_sort_by_final_score` is the in-place sort applied just before the cap in
`process_recall`; the cap itself is a plain head-slice, reproduced here so the
before/after relevance of the capped set is directly comparable.
"""

from recall import _result_final_score, _sort_by_final_score


def _mem(mem_id, final, bank):
    """A recall result as the engine returns it: text + a scores object."""
    return {
        "id": mem_id,
        "text": f"memory {mem_id} from {bank}",
        "bank": bank,
        "scores": {"final": final, "semantic": final, "keyword": final},
    }


def _capped_relevance(results, cap):
    """Mirror process_recall: head-slice at the cap, return kept scores."""
    kept = results[:cap] if cap > 0 else results
    return [_result_final_score(m) for m in kept]


class TestFinalScoreExtraction:
    def test_reads_final_score(self):
        assert _result_final_score(_mem("a", 0.9, "own")) == 0.9

    def test_missing_scores_sorts_last(self):
        assert _result_final_score({"id": "x", "text": "t"}) == float("-inf")

    def test_null_scores_sorts_last(self):
        assert _result_final_score({"id": "x", "scores": None}) == float("-inf")

    def test_missing_final_sorts_last(self):
        assert _result_final_score({"id": "x", "scores": {"semantic": 0.5}}) == float("-inf")

    def test_bool_is_not_a_score(self):
        # True is an int subclass; it must not be mistaken for a 1.0 score.
        assert _result_final_score({"id": "x", "scores": {"final": True}}) == float("-inf")


class TestSortByFinalScore:
    def test_orders_descending(self):
        results = [_mem("a", 0.2, "own"), _mem("b", 0.9, "own"), _mem("c", 0.5, "own")]
        _sort_by_final_score(results)
        assert [m["id"] for m in results] == ["b", "c", "a"]

    def test_stable_on_ties_preserves_own_bank_first(self):
        # Own-bank appears before additional-bank in insertion order; on a
        # score tie the stable sort must keep own-bank ahead.
        results = [_mem("own1", 0.5, "own"), _mem("extra1", 0.5, "profile")]
        _sort_by_final_score(results)
        assert [m["id"] for m in results] == ["own1", "extra1"]

    def test_scoreless_entries_sink_to_the_bottom(self):
        results = [{"id": "noscore", "text": "t"}, _mem("scored", 0.1, "own")]
        _sort_by_final_score(results)
        assert results[0]["id"] == "scored"


class TestCrossBankStarvationRegression:
    """The bug the fix targets: a relevant additional-bank memory dropped at
    the cap because own-bank hits were appended first."""

    def test_high_relevance_additional_bank_memory_survives_cap(self):
        # Own bank fills the cap with mediocre hits; the profile bank has the
        # single most relevant memory. Pre-fix (append own, then extra, then
        # head-slice) the profile hit lands at index 2 and is sliced off.
        cap = 2
        own = [_mem("own_lo1", 0.30, "own"), _mem("own_lo2", 0.25, "own")]
        extra = [_mem("profile_hi", 0.95, "profile")]
        merged = own + extra  # exactly the pre-fix append order

        # Before: append-then-slice starves the profile bank.
        pre_fix_ids = [m["id"] for m in merged[:cap]]
        assert "profile_hi" not in pre_fix_ids

        # After: sort by scores.final before the slice keeps the best memory.
        _sort_by_final_score(merged)
        post_fix_ids = [m["id"] for m in merged[:cap]]
        assert "profile_hi" in post_fix_ids
        assert post_fix_ids[0] == "profile_hi"

    def test_capped_set_relevance_is_no_worse_after_sort(self):
        # Measurement: summed relevance of the capped set must not decrease.
        cap = 3
        merged = [
            _mem("own1", 0.4, "own"),
            _mem("own2", 0.35, "own"),
            _mem("own3", 0.3, "own"),
            _mem("profile1", 0.9, "profile"),
            _mem("shared1", 0.8, "shared"),
        ]
        before = sum(_capped_relevance(list(merged), cap))
        _sort_by_final_score(merged)
        after = sum(_capped_relevance(merged, cap))
        assert after >= before
        # And concretely, the two top additional-bank hits are now retained.
        kept_ids = [m["id"] for m in merged[:cap]]
        assert "profile1" in kept_ids and "shared1" in kept_ids
