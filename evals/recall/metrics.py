#!/usr/bin/env python3
"""Pure scoring functions for the Hindsight recall-quality eval (issue #4479).

Everything in this module is a **pure function over ranked id lists**. No HTTP,
no database, no clock, no randomness. That is deliberate: the scoring half of
the suite is the half CI runs, and it has to be reproducible bit-for-bit on a
machine that cannot reach a Hindsight instance.

## Stage vocabulary

A single recall is observed as several ranked lists, taken from the engine's
own ``SearchTrace`` (``hindsight_api/engine/search/trace.py:191`` at tag
``v0.8.6``):

``arm:semantic`` / ``arm:bm25`` / ``arm:graph``
    Raw per-arm rankings, pooled across ``fact_type`` (the engine emits one
    ``RetrievalMethodResults`` per (method, fact_type) pair — see
    ``retrieval.py:214`` for the semantic UNION ALL arms and ``:233`` for the
    BM25 ones). Pooling is by best rank across fact types.
``rrf_engine``
    The engine's own ``rrf_merged`` list. Observational only — it reflects
    whatever fusion, capping and budget the deployed engine applies.
``rrf_client``
    RRF recomputed **here** from the raw arm lists, using the same formula and
    the same ``k`` as ``engine/search/fusion.py:29``
    (``score(d) = sum 1/(k + rank)``, ``k=60``).
``rerank``
    The engine's ``reranked`` list (cross-encoder output).
``final``
    What the caller actually received.

``rrf_client`` exists for one reason: **arm ablation**. To prove the suite is
non-vacuous (#4479 AC1) we need a configuration that is genuinely worse, without
mutating a live instance. Dropping an arm from the client-side fusion does that
exactly — and because the *same* client-side fusion scores both the ablated and
the non-ablated run, the delta between them is attributable to the ablation and
not to any mismatch between this implementation and the engine's. Do not read
``rrf_client`` as a reimplementation of the engine; read it as a controlled
comparator.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence

# Matches `reciprocal_rank_fusion(result_lists, k=60)` —
# hindsight-api-slim/hindsight_api/engine/search/fusion.py:29 (tag v0.8.6).
RRF_K = 60

# Arm order in the engine's fusion call is ["semantic", "bm25", "graph",
# "temporal"] (fusion.py:56). RRF is order-independent for scoring, but the
# order is pinned here so ablation flags and reports name the same things the
# engine does.
ARMS = ("semantic", "bm25", "graph", "temporal")

# The stages every run reports. Ordered coarse-to-fine so a report reads as a
# pipeline walk.
STAGES = (
    "arm:semantic",
    "arm:bm25",
    "arm:graph",
    "rrf_client",
    "rrf_engine",
    "rerank",
    "final",
)


# ─────────────────────────── IR metrics ───────────────────────────
#
# `relevant` is a mapping id -> integer grade (0 = not relevant). Binary
# judgements are just grade 1. A grade of 0 is treated as judged-and-irrelevant,
# which is NOT the same as unjudged — see `judged_coverage`.


def recall_at_k(ranked: Sequence[str], relevant: Mapping[str, int], k: int) -> float:
    """Fraction of graded-positive ids that appear in the top ``k``.

    Returns 0.0 when there is nothing to find, not 1.0. A query with no positive
    judgement contributes no information about recall, and the caller is
    expected to exclude it (``score_case`` does); returning 1.0 here would let an
    unjudged query silently inflate the mean.
    """
    positives = {doc for doc, grade in relevant.items() if grade > 0}
    if not positives:
        return 0.0
    hits = sum(1 for doc in ranked[:k] if doc in positives)
    return hits / len(positives)


def dcg(gains: Iterable[float]) -> float:
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains))


def ndcg_at_k(ranked: Sequence[str], relevant: Mapping[str, int], k: int) -> float:
    """Normalised DCG with the standard ``2**grade - 1`` gain.

    The ideal ranking is computed over the *judged* set only, so nDCG is
    conservative under pooled judgements: an unjudged-but-relevant document
    scores 0 and cannot be compensated for.
    """
    positives = {doc: g for doc, g in relevant.items() if g > 0}
    if not positives:
        return 0.0
    actual = dcg(2 ** positives.get(doc, 0) - 1 for doc in ranked[:k])
    ideal = dcg(2**g - 1 for g in sorted(positives.values(), reverse=True)[:k])
    return actual / ideal if ideal > 0 else 0.0


def reciprocal_rank(ranked: Sequence[str], relevant: Mapping[str, int]) -> float:
    """1/rank of the first graded-positive id, or 0.0 if none is retrieved."""
    positives = {doc for doc, grade in relevant.items() if grade > 0}
    for i, doc in enumerate(ranked, start=1):
        if doc in positives:
            return 1.0 / i
    return 0.0


def judged_coverage(ranked: Sequence[str], relevant: Mapping[str, int], k: int) -> float:
    """Fraction of the top ``k`` that carries **any** judgement.

    This is the label-rot alarm. Judgements are pinned to memory-unit ids in a
    live bank; consolidation rewrites and merges units, so a qrels file silently
    decays into "nothing matches anything" and every metric drifts toward zero
    while looking like a quality regression. A falling coverage number
    distinguishes the two, and ``run_recall_quality.py`` fails the run when it
    drops under ``--min-judged-coverage``.
    """
    if not ranked:
        return 0.0
    return sum(1 for doc in ranked[:k] if doc in relevant) / len(ranked[:k])


# ─────────────────────────── fusion ───────────────────────────


def rrf_fuse(arm_rankings: Mapping[str, Sequence[str]], k: int = RRF_K) -> list[str]:
    """Reciprocal-rank-fuse per-arm ranked id lists into one ranked id list.

    Mirrors ``engine/search/fusion.py:29``: ``score(d) = sum_arms 1/(k + rank)``,
    ranks 1-based, ties broken by first appearance so the result is a total
    order and therefore deterministic. Arms absent from ``arm_rankings`` simply
    contribute nothing — that is how ablation is expressed.
    """
    scores: dict[str, float] = {}
    first_seen: dict[str, int] = {}
    seq = 0
    for arm in ARMS:
        ranked = arm_rankings.get(arm)
        if not ranked:
            continue
        for rank, doc in enumerate(ranked, start=1):
            if doc not in scores:
                scores[doc] = 0.0
                first_seen[doc] = seq
                seq += 1
            scores[doc] += 1.0 / (k + rank)
    return sorted(scores, key=lambda d: (-scores[d], first_seen[d]))


def pool_by_best_rank(lists: Iterable[Sequence[str]]) -> list[str]:
    """Merge several ranked lists of the same arm by each id's best rank.

    The engine emits one arm per (method, fact_type); this collapses them into
    the single "what did the keyword arm return" list the metrics talk about.
    Ties (same best rank in different fact types) keep first-list order, so the
    output is deterministic.
    """
    best: dict[str, tuple[int, int]] = {}
    seq = 0
    for ranked in lists:
        for rank, doc in enumerate(ranked, start=1):
            previous = best.get(doc)
            if previous is None:
                best[doc] = (rank, seq)
                seq += 1
            elif rank < previous[0]:
                # Improve the rank, keep the original first-seen tiebreak so the
                # ordering of equally-ranked ids does not depend on which arm
                # happened to improve last.
                best[doc] = (rank, previous[1])
    return sorted(best, key=lambda d: best[d])


# ─────────────────────── the headline metric ───────────────────────


def zero_result_metric(
    reference_keyword_counts: Mapping[str, int],
    candidate_keyword_counts: Mapping[str, int],
) -> dict[str, object]:
    """``zero_result_queries_answered / zero_result_queries_total`` — #4479 AC2.

    The subset is defined by the **reference** run: every query whose keyword
    arm returned 0 rows there. ``answered`` counts those the **candidate** run's
    keyword arm returned at least one row for.

    Deliberately label-free. This is the number that put pg_search on the table
    (epic #4474, "Quality" row) and it needs no relevance judgements at all —
    only two runs and a row count — which is why it is the metric this suite can
    report honestly at full scale today, while graded metrics depend on qrels
    coverage.

    A query present in the reference but missing from the candidate is counted
    as **not answered**, never skipped: a candidate that errors out on the hard
    queries must not score better than one that answers them.
    """
    subset = sorted(q for q, n in reference_keyword_counts.items() if n == 0)
    answered = [q for q in subset if candidate_keyword_counts.get(q, 0) > 0]
    missing = [q for q in subset if q not in candidate_keyword_counts]
    total = len(subset)
    return {
        "zero_result_queries_total": total,
        "zero_result_queries_answered": len(answered),
        "zero_result_answer_rate": (len(answered) / total) if total else 0.0,
        "zero_result_query_ids": subset,
        "zero_result_answered_ids": sorted(answered),
        "zero_result_unevaluated_ids": sorted(missing),
    }


# ─────────────────────── aggregation ───────────────────────


def score_case(
    ranked: Sequence[str],
    relevant: Mapping[str, int],
    ks: Sequence[int] = (10, 50),
) -> dict[str, float]:
    out: dict[str, float] = {}
    for k in ks:
        out[f"recall@{k}"] = recall_at_k(ranked, relevant, k)
    out["ndcg@10"] = ndcg_at_k(ranked, relevant, 10)
    out["mrr"] = reciprocal_rank(ranked, relevant)
    out["judged_coverage@10"] = judged_coverage(ranked, relevant, 10)
    return out


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def aggregate(per_case: Sequence[Mapping[str, float]]) -> dict[str, float]:
    """Macro-average each metric across cases, rounded to 6 dp.

    Rounding is not cosmetic: it is what makes two runs over identical inputs
    compare *equal* rather than differing in float noise from summation order.
    6 dp is far below the <1 % determinism budget (#4479 AC3) and far above any
    real difference the suite is meant to detect.
    """
    if not per_case:
        return {}
    keys = sorted({k for case in per_case for k in case})
    return {k: round(mean([case[k] for case in per_case if k in case]), 6) for k in keys}


# ─────────────────────── regression gate ───────────────────────


def compare(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
    *,
    max_recall10_drop: float = 0.02,
    max_zero_result_regressions: int = 0,
    gate_stage: str = "final",
) -> dict[str, object]:
    """Grade ``candidate`` against ``baseline``; ``ok=False`` means exit non-zero.

    Two independent budgets, both from #4479's verification block:

    * ``max_recall10_drop`` — absolute drop in ``recall@10`` at ``gate_stage``.
    * ``max_zero_result_regressions`` — count of queries the baseline's keyword
      arm answered that the candidate's does not. This is the guard that a
      tokenizer silently reverting to unstemmed (risk C1 in #4474) trips, and
      it defaults to zero tolerance.

    Failures are split into two kinds, because conflating them makes the gate
    unfalsifiable. ``regressions`` are *measured* — the candidate is provably
    worse. ``ungraded`` means a budget could not be evaluated at all (typically
    no qrels, so ``recall@10`` does not exist on either side). Both block, but
    only the first discriminates: with no judgements committed, *every* compare
    is ungraded, including a run against itself, so an exit code that cannot
    tell the two apart proves nothing about a degraded configuration. ``verdict``
    is ``pass`` / ``regression`` / ``ungraded`` and the caller maps it to a
    distinct exit code.
    """
    regressions: list[str] = []
    ungraded: list[str] = []

    b_stage = (baseline.get("stages") or {}).get(gate_stage) or {}
    c_stage = (candidate.get("stages") or {}).get(gate_stage) or {}
    b_r10 = b_stage.get("recall@10")
    c_r10 = c_stage.get("recall@10")
    drop = None
    if b_r10 is None or c_r10 is None:
        ungraded.append(
            f"recall@10 missing at stage {gate_stage} "
            f"(baseline={b_r10!r}, candidate={c_r10!r}) — cannot grade"
        )
    else:
        drop = round(b_r10 - c_r10, 6)
        if drop > max_recall10_drop:
            regressions.append(
                f"recall@10 at {gate_stage} dropped {drop:.4f} > budget {max_recall10_drop:.4f} "
                f"({b_r10:.4f} -> {c_r10:.4f})"
            )

    b_kw = baseline.get("keyword_arm_row_counts") or {}
    c_kw = candidate.get("keyword_arm_row_counts") or {}
    regressed = sorted(q for q, n in b_kw.items() if n > 0 and c_kw.get(q, 0) == 0)
    if len(regressed) > max_zero_result_regressions:
        regressions.append(
            f"{len(regressed)} queries went keyword-zero that the baseline answered "
            f"(budget {max_zero_result_regressions}): {regressed[:10]}"
            + ("..." if len(regressed) > 10 else "")
        )

    if regressions:
        verdict = "regression"
    elif ungraded:
        verdict = "ungraded"
    else:
        verdict = "pass"

    return {
        "ok": verdict == "pass",
        "verdict": verdict,
        "regressions": regressions,
        "ungraded": ungraded,
        "gate_stage": gate_stage,
        "recall@10_baseline": b_r10,
        "recall@10_candidate": c_r10,
        "recall@10_drop": drop,
        "zero_result_regressions": regressed,
        "budgets": {
            "max_recall10_drop": max_recall10_drop,
            "max_zero_result_regressions": max_zero_result_regressions,
        },
        "findings": regressions + ungraded,
    }


def variance_report(runs: Sequence[Mapping[str, object]]) -> dict[str, object]:
    """Run-to-run spread per metric, for #4479 AC3.

    Reports the **absolute** spread (max - min) rather than a relative one:
    these metrics are already bounded in [0, 1], and a relative spread explodes
    meaninglessly when a metric sits near zero. ``worst_spread`` is therefore
    directly comparable to the 1 % (0.01) budget the AC states.

    Two families are covered, and covering both is not optional:

    * graded per-stage metrics, which exist only when a qrels file was supplied;
    * **label-free** per-case retrieval stability, which always exists — the
      normalised keyword- and semantic-arm row count for every case, plus the
      keyword-arm zero-result rate.

    Without the second family a run with no judgements would compare *nothing*
    and report ``worst_spread: 0.0``, i.e. claim perfect determinism because it
    measured none. ``metrics_compared`` is returned so that claim is always
    checkable, and ``measured`` is False when it is zero.
    """
    if len(runs) < 2:
        return {
            "runs": len(runs),
            "worst_spread": None,
            "worst_metric": None,
            "metrics_compared": 0,
            "measured": False,
            "per_metric": {},
        }

    series: dict[str, list[float]] = {}

    stages = sorted({s for run in runs for s in (run.get("stages") or {})})
    for stage in stages:
        names = sorted({m for run in runs for m in ((run.get("stages") or {}).get(stage) or {})})
        for metric in names:
            if metric == "judged_cases":  # a count, not a [0,1] score
                continue
            series[f"{stage}/{metric}"] = [
                v
                for run in runs
                if (v := ((run.get("stages") or {}).get(stage) or {}).get(metric)) is not None
            ]

    series["label_free/keyword_arm_zero_result_rate"] = [
        float(v)
        for run in runs
        if (v := run.get("keyword_arm_zero_result_rate")) is not None
    ]

    # Per-case arm row counts, normalised by that case's own maximum across the
    # runs so the spread is comparable to the [0, 1] budget. A case whose
    # keyword arm returns 300 rows in one run and 258 in the next is a 14 %
    # swing in the input to fusion, and it is invisible in any graded metric
    # when there are no judgements.
    for arm_key, label in (
        ("keyword_arm_row_counts", "keyword"),
        ("semantic_arm_row_counts", "semantic"),
    ):
        cases = sorted({c for run in runs for c in (run.get(arm_key) or {})})
        for case in cases:
            values = [
                float(v) for run in runs if (v := (run.get(arm_key) or {}).get(case)) is not None
            ]
            if len(values) < 2:
                continue
            scale = max(values) or 1.0
            series[f"label_free/{label}_rows/{case}"] = [v / scale for v in values]

    per_metric: dict[str, dict[str, float]] = {}
    for name, values in series.items():
        if len(values) < 2:
            continue
        per_metric[name] = {
            "min": round(min(values), 6),
            "max": round(max(values), 6),
            "spread": round(max(values) - min(values), 6),
        }

    if not per_metric:
        return {
            "runs": len(runs),
            "worst_spread": None,
            "worst_metric": None,
            "metrics_compared": 0,
            "measured": False,
            "per_metric": {},
        }

    worst_metric = max(per_metric, key=lambda m: per_metric[m]["spread"])
    return {
        "runs": len(runs),
        "worst_spread": per_metric[worst_metric]["spread"],
        "worst_metric": worst_metric,
        "metrics_compared": len(per_metric),
        "measured": True,
        "per_metric": per_metric,
    }
