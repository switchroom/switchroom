#!/usr/bin/env python3
"""Unit tests for the recall-quality scorer (#4479).

These run in CI with no network and no database. They assert **outcomes**: that
each metric moves the way a real regression would move it, and above all that
the regression gate actually fails on a degraded configuration. A gate nobody
has watched go red is decoration.

Run: `python3 -m unittest discover -s evals/recall -p 'test_*.py' -t .`
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from evals.recall import metrics  # noqa: E402
from evals.recall.client import parse_observation  # noqa: E402
from evals.recall.queryset import load_queryset  # noqa: E402
from evals.recall import run_recall_quality as runner  # noqa: E402
from evals.recall.run_recall_quality import apply_ablation, score  # noqa: E402

HERE = Path(__file__).resolve().parent
QUERYSET = HERE / "queryset" / "v1.yaml"
REPO_ROOT = HERE.parent.parent


class IRMetrics(unittest.TestCase):
    def test_recall_at_k_counts_only_the_top_k(self):
        ranked = ["a", "b", "c", "d"]
        relevant = {"a": 1, "d": 1}
        self.assertEqual(metrics.recall_at_k(ranked, relevant, 2), 0.5)
        self.assertEqual(metrics.recall_at_k(ranked, relevant, 4), 1.0)

    def test_recall_is_zero_not_one_when_nothing_is_judged_relevant(self):
        # The fail-open shape (no positives -> perfect score) would let an
        # unjudged query inflate the macro average, which is exactly how a
        # suite goes quietly vacuous.
        self.assertEqual(metrics.recall_at_k(["a"], {"b": 0}, 10), 0.0)

    def test_ndcg_rewards_putting_the_better_document_first(self):
        good = metrics.ndcg_at_k(["a", "b"], {"a": 3, "b": 1}, 10)
        bad = metrics.ndcg_at_k(["b", "a"], {"a": 3, "b": 1}, 10)
        self.assertEqual(good, 1.0)
        self.assertLess(bad, good)

    def test_mrr_is_the_reciprocal_of_the_first_hit(self):
        self.assertEqual(metrics.reciprocal_rank(["x", "y", "a"], {"a": 1}), 1 / 3)
        self.assertEqual(metrics.reciprocal_rank(["x"], {"a": 1}), 0.0)

    def test_judged_coverage_sees_label_rot(self):
        # Every returned id unjudged is what a stale qrels file looks like after
        # consolidation rewrites the bank.
        self.assertEqual(metrics.judged_coverage(["p", "q"], {"a": 1}, 10), 0.0)
        self.assertEqual(metrics.judged_coverage(["a", "q"], {"a": 1}, 10), 0.5)


class Fusion(unittest.TestCase):
    def test_rrf_matches_the_engine_formula(self):
        # score(d) = sum 1/(k + rank); engine/search/fusion.py:29, k=60.
        fused = metrics.rrf_fuse({"semantic": ["a", "b"], "bm25": ["b", "a"]})
        self.assertEqual(sorted(fused), ["a", "b"])
        # "c" is rank 1 in one arm only; "a" is rank 2 in both. 1/61 < 2/62.
        fused2 = metrics.rrf_fuse({"semantic": ["x", "a"], "bm25": ["c", "a"]})
        self.assertLess(fused2.index("a"), fused2.index("c"))

    def test_rrf_is_deterministic_under_ties(self):
        arms = {"semantic": ["a", "b", "c"], "bm25": ["a", "b", "c"]}
        self.assertEqual(metrics.rrf_fuse(arms), metrics.rrf_fuse(arms))

    def test_dropping_an_arm_changes_the_fused_ranking(self):
        arms = {"semantic": ["s1", "s2"], "bm25": ["k1", "k2"]}
        full = metrics.rrf_fuse(arms)
        without = metrics.rrf_fuse({"semantic": arms["semantic"]})
        self.assertIn("k1", full)
        self.assertNotIn("k1", without)

    def test_pool_by_best_rank_keeps_the_better_rank(self):
        pooled = metrics.pool_by_best_rank([["a", "b"], ["b", "c"]])
        self.assertEqual(pooled[0], "a")
        self.assertIn("b", pooled)
        self.assertIn("c", pooled)


class HeadlineMetric(unittest.TestCase):
    def test_subset_comes_from_the_reference_and_answers_from_the_candidate(self):
        out = metrics.zero_result_metric({"q1": 0, "q2": 5, "q3": 0}, {"q1": 4, "q2": 5, "q3": 0})
        self.assertEqual(out["zero_result_queries_total"], 2)
        self.assertEqual(out["zero_result_queries_answered"], 1)
        self.assertEqual(out["zero_result_answer_rate"], 0.5)

    def test_a_query_the_candidate_never_ran_counts_as_unanswered(self):
        out = metrics.zero_result_metric({"q1": 0, "q2": 0}, {"q1": 3})
        self.assertEqual(out["zero_result_queries_answered"], 1)
        self.assertEqual(out["zero_result_unevaluated_ids"], ["q2"])

    def test_no_zero_result_queries_is_a_zero_rate_not_a_crash(self):
        out = metrics.zero_result_metric({"q1": 3}, {"q1": 3})
        self.assertEqual(out["zero_result_queries_total"], 0)
        self.assertEqual(out["zero_result_answer_rate"], 0.0)


class RegressionGate(unittest.TestCase):
    """AC1 in miniature: the gate must go red on a degraded configuration."""

    BASE = {
        "stages": {"final": {"recall@10": 0.80, "ndcg@10": 0.7}},
        "keyword_arm_row_counts": {"q1": 10, "q2": 8, "q3": 0},
    }

    def test_passes_an_identical_run(self):
        verdict = metrics.compare(self.BASE, self.BASE)
        self.assertTrue(verdict["ok"], verdict["findings"])

    def test_fails_when_recall_drops_past_the_budget(self):
        worse = {
            "stages": {"final": {"recall@10": 0.70}},
            "keyword_arm_row_counts": self.BASE["keyword_arm_row_counts"],
        }
        verdict = metrics.compare(self.BASE, worse, max_recall10_drop=0.02)
        self.assertFalse(verdict["ok"])
        self.assertIn("recall@10", verdict["findings"][0])

    def test_a_drop_exactly_at_the_budget_passes(self):
        edge = {
            "stages": {"final": {"recall@10": 0.78}},
            "keyword_arm_row_counts": self.BASE["keyword_arm_row_counts"],
        }
        self.assertTrue(metrics.compare(self.BASE, edge, max_recall10_drop=0.02)["ok"])

    def test_fails_when_the_keyword_arm_goes_zero_on_a_query_it_answered(self):
        # This is the tokenizer-silently-reverts-to-unstemmed guard (risk C1).
        reverted = {
            "stages": {"final": {"recall@10": 0.80}},
            "keyword_arm_row_counts": {"q1": 0, "q2": 8, "q3": 0},
        }
        verdict = metrics.compare(self.BASE, reverted)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["zero_result_regressions"], ["q1"])

    def test_a_missing_stage_is_a_failure_not_a_pass(self):
        verdict = metrics.compare(self.BASE, {"stages": {}, "keyword_arm_row_counts": {}})
        self.assertFalse(verdict["ok"])
        self.assertIn("cannot grade", verdict["findings"][0])


class Ablation(unittest.TestCase):
    """The non-vacuity mechanism, end to end over a synthetic trace."""

    @staticmethod
    def _raw():
        def arm(method, fact_type, ids):
            return {
                "method_name": method,
                "fact_type": fact_type,
                "duration_seconds": 0.0,
                "results": [
                    {"rank": i + 1, "node_id": n, "text": "", "score": 1.0, "score_name": "s"}
                    for i, n in enumerate(ids)
                ],
            }

        return {
            "results": [{"id": "t1"}, {"id": "s1"}],
            "trace": {
                "retrieval_results": [
                    arm("semantic", "world", ["s1", "s2"]),
                    arm("bm25", "world", ["t1", "t2"]),
                    arm("graph", "world", ["g1"]),
                ],
                "rrf_merged": [{"node_id": n} for n in ["t1", "s1", "t2", "s2", "g1"]],
                "reranked": [{"node_id": n} for n in ["t1", "s1"]],
            },
        }

    def test_parse_extracts_every_stage(self):
        obs = parse_observation("q1", "b", self._raw())
        self.assertEqual(obs.arms["bm25"], ["t1", "t2"])
        self.assertEqual(obs.stages["arm:semantic"], ["s1", "s2"])
        self.assertEqual(obs.stages["rerank"], ["t1", "s1"])
        self.assertEqual(obs.stages["final"], ["t1", "s1"])
        self.assertIn("t1", obs.stages["rrf_client"])

    def test_parse_keeps_no_memory_text(self):
        # The repo is public and the banks are private: ids only, always.
        obs = parse_observation("q1", "b", self._raw())
        flat = repr(obs)
        for stage_ids in obs.stages.values():
            for doc in stage_ids:
                self.assertRegex(doc, r"^[a-zA-Z0-9_-]+$")
        self.assertNotIn("text", flat)

    def test_ablating_the_keyword_arm_removes_its_documents(self):
        obs = parse_observation("q1", "b", self._raw())
        apply_ablation(obs, ["bm25"])
        self.assertEqual(obs.arms["bm25"], [])
        self.assertNotIn("t1", obs.stages["rrf_client"])
        self.assertNotIn("t2", obs.stages["rrf_client"])
        self.assertIn("s1", obs.stages["rrf_client"])

    def test_ablation_drops_stages_it_cannot_honestly_recompute(self):
        obs = parse_observation("q1", "b", self._raw())
        apply_ablation(obs, ["bm25"])
        for stage in ("rrf_engine", "rerank", "final"):
            self.assertNotIn(stage, obs.stages)

    def test_ablated_run_scores_worse_and_the_gate_goes_red(self):
        """The AC1 proof in unit form, with no live instance involved."""
        qrels = {"q1": {"t1": 3, "t2": 2}}
        full = parse_observation("q1", "b", self._raw())
        degraded = parse_observation("q1", "b", self._raw())
        apply_ablation(degraded, ["bm25"])

        baseline = score([full], qrels)
        candidate = score([degraded], qrels)

        stage = "rrf_client"
        self.assertGreater(
            baseline["stages"][stage]["recall@10"],
            candidate["stages"][stage]["recall@10"],
        )
        verdict = metrics.compare(baseline, candidate, gate_stage=stage)
        self.assertFalse(verdict["ok"], "ablated run must fail the gate")
        self.assertTrue(any("recall@10" in f for f in verdict["findings"]))
        self.assertEqual(verdict["zero_result_regressions"], ["q1@b"])


class Variance(unittest.TestCase):
    def test_identical_runs_report_zero_spread(self):
        run = {"stages": {"final": {"recall@10": 0.5}}}
        report = metrics.variance_report([run, run])
        self.assertEqual(report["worst_spread"], 0.0)
        self.assertTrue(report["measured"])

    def test_spread_is_absolute_and_names_the_worst_metric(self):
        report = metrics.variance_report(
            [
                {"stages": {"final": {"recall@10": 0.50, "mrr": 0.90}}},
                {"stages": {"final": {"recall@10": 0.53, "mrr": 0.91}}},
            ]
        )
        self.assertAlmostEqual(report["worst_spread"], 0.03, places=6)
        self.assertEqual(report["worst_metric"], "final/recall@10")

    def test_a_single_run_cannot_claim_determinism(self):
        report = metrics.variance_report([{"stages": {}}])
        self.assertEqual(report["runs"], 1)
        self.assertFalse(report["measured"])
        self.assertIsNone(report["worst_spread"])

    def test_comparing_nothing_is_not_perfect_determinism(self):
        """The AC3 analogue of the fail-open scorer.

        A run with no qrels has no graded metrics. If variance only ever looked
        at those, it would report a spread of 0.0 and read as 'identical scores
        across runs' while having compared nothing at all.
        """
        report = metrics.variance_report([{"stages": {}}, {"stages": {}}])
        self.assertFalse(report["measured"])
        self.assertEqual(report["metrics_compared"], 0)
        self.assertIsNone(report["worst_spread"])

    def test_label_free_runs_are_still_measured(self):
        runs = [
            {
                "stages": {},
                "keyword_arm_zero_result_rate": 0.10,
                "keyword_arm_row_counts": {"q1@b": 300, "q2@b": 0},
                "semantic_arm_row_counts": {"q1@b": 100, "q2@b": 100},
            },
            {
                "stages": {},
                "keyword_arm_zero_result_rate": 0.10,
                "keyword_arm_row_counts": {"q1@b": 240, "q2@b": 0},
                "semantic_arm_row_counts": {"q1@b": 100, "q2@b": 100},
            },
        ]
        report = metrics.variance_report(runs)
        self.assertTrue(report["measured"])
        # 300 -> 240 is a 20% swing in the keyword arm's contribution to fusion,
        # and it is invisible in every graded metric when nothing is judged.
        self.assertAlmostEqual(report["worst_spread"], 0.2, places=6)
        self.assertEqual(report["worst_metric"], "label_free/keyword_rows/q1@b")

    def test_an_unmeasured_report_cannot_pass_the_budget(self):
        args = runner.build_parser().parse_args(["run", "--banks", "b"])
        det = metrics.variance_report([{"stages": {}}, {"stages": {}}])
        within = bool(det["measured"]) and (
            det["worst_spread"] is not None
            and det["worst_spread"] <= args.determinism_budget
        )
        self.assertFalse(within)


class ScoreBlock(unittest.TestCase):
    def test_unjudged_cases_are_excluded_from_graded_metrics_but_not_from_label_free_ones(self):
        judged = parse_observation("q1", "b", Ablation._raw())
        unjudged = parse_observation("q9", "b", Ablation._raw())
        block = score([judged, unjudged], {"q1": {"t1": 1}})
        self.assertEqual(block["stages"]["final"]["judged_cases"], 1)
        self.assertEqual(block["cases_ok"], 2)
        self.assertEqual(len(block["keyword_arm_row_counts"]), 2)

    def test_keyword_zero_rate_is_label_free(self):
        empty = parse_observation("q2", "b", {"results": [], "trace": {}})
        block = score([empty], {})
        self.assertEqual(block["keyword_arm_zero_result_count"], 1)
        self.assertEqual(block["keyword_arm_zero_result_rate"], 1.0)


class FailClosed(unittest.TestCase):
    """A run whose cases errored must not report a confident score.

    Every metric here is a ratio over the cases that SUCCEEDED, so a run where
    most cases errored would otherwise exit 0 with a clean-looking number
    computed over the handful that worked.
    """

    def _args(self, argv):
        return runner.build_parser().parse_args(argv)

    def _run_with(self, argv, observations):
        args = self._args(argv)
        real_client, real_suite, real_ident = (
            runner.HindsightRecallClient,
            runner.run_suite,
            runner.engine_identity,
        )
        runner.HindsightRecallClient = lambda *a, **kw: object()
        runner.run_suite = lambda *a, **kw: observations
        runner.engine_identity = lambda client: {"api_url": "test"}
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return runner.cmd_run(args)
        finally:
            runner.HindsightRecallClient = real_client
            runner.run_suite = real_suite
            runner.engine_identity = real_ident

    def test_an_errored_case_exits_non_zero_by_default(self):
        ok = parse_observation("q1", "b", Ablation._raw())
        broken = parse_observation("q2", "b", Ablation._raw())
        broken.ok = False
        broken.error = "timeout"
        code = self._run_with(["run", "--banks", "b", "--quiet"], [ok, broken])
        self.assertEqual(code, runner.EXIT_REGRESSION)

    def test_the_escape_hatch_is_explicit(self):
        ok = parse_observation("q1", "b", Ablation._raw())
        broken = parse_observation("q2", "b", Ablation._raw())
        broken.ok = False
        broken.error = "timeout"
        code = self._run_with(
            ["run", "--banks", "b", "--quiet", "--no-fail-on-error"], [ok, broken]
        )
        self.assertEqual(code, runner.EXIT_OK)

    def test_a_clean_run_still_passes(self):
        ok = parse_observation("q1", "b", Ablation._raw())
        self.assertEqual(self._run_with(["run", "--banks", "b", "--quiet"], [ok]), runner.EXIT_OK)


class QuerySetAsset(unittest.TestCase):
    def test_committed_query_set_meets_the_issue_scope(self):
        qs = load_queryset(QUERYSET)
        self.assertGreaterEqual(len(qs.cases), 100)
        self.assertTrue(qs.provenance.get("method"))

    def test_limit_is_deterministic_and_family_balanced(self):
        qs = load_queryset(QUERYSET)
        a = [c.id for c in qs.limited(21, seed=7).cases]
        b = [c.id for c in qs.limited(21, seed=7).cases]
        self.assertEqual(a, b)
        self.assertNotEqual(a, [c.id for c in qs.limited(21, seed=8).cases])
        families = {c.family for c in qs.limited(21, seed=7).cases}
        self.assertEqual(families, set(qs.families))

    def test_zero_result_probes_are_built_only_from_discarded_lexemes(self):
        """The headline metric's denominator is a function of the stop file.

        The native keyword arm ORs its tokens (engine/sql/postgresql.py:228-234,
        hindsight v0.8.6), so on a populated bank a merely rare phrase still
        matches something. It returns zero rows when the query reduces to an
        EMPTY tsquery — which happens only when every token is discarded by the
        deployed `hindsight_english` regconfig, whose extra stopwords live in
        `docker/hindsight-extra.stop`.

        Confirmed live before this test was written: all 20 cases below scored
        `kw=0`, while nine of ten ordinary-function-word queries scored 172-300.

        So this couples the query set to that file on purpose. Editing the stop
        file changes which queries can score zero, i.e. changes the denominator
        of a number people are meant to trust; this makes that a visible CI
        failure rather than a silent drift.
        """
        stop_path = REPO_ROOT / "docker" / "hindsight-extra.stop"
        self.assertTrue(stop_path.exists(), f"{stop_path} is missing")
        stop = {
            line.strip().lower()
            for line in stop_path.read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn(
            "switchroom", stop, "stop file is not the boilerplate list this test expects"
        )

        def discarded(token: str) -> bool:
            # PostgreSQL's default parser emits a hyphenated word as the whole
            # compound AND its parts, so every piece must be discarded too.
            if token in stop:
                return True
            parts = [p for p in token.split("-") if p]
            return len(parts) > 1 and all(p in stop for p in parts)

        qs = load_queryset(QUERYSET)
        probes = [c for c in qs.cases if c.family == "zero-result-probe"]
        self.assertGreaterEqual(len(probes), 15)
        offenders = {
            case.id: sorted(t for t in case.text.lower().split() if not discarded(t))
            for case in probes
        }
        offenders = {cid: toks for cid, toks in offenders.items() if toks}
        self.assertEqual(
            offenders,
            {},
            "these zero-result-probe cases contain lexemes the deployed regconfig "
            "KEEPS, so they will not drive the keyword arm to zero and do not belong "
            "in this family. Move them to rare-term, or extend the stop file "
            "deliberately",
        )


if __name__ == "__main__":
    unittest.main()
