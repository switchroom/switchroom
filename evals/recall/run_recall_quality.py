#!/usr/bin/env python3
"""Hindsight recall-quality eval — runner, scorer and regression gate (#4479).

One command, three modes:

    # score a configuration
    python3 evals/recall/run_recall_quality.py run \\
        --banks bank-a,bank-b --out results/p6-baseline-native.json

    # prove the suite is non-vacuous (#4479 AC1)
    python3 evals/recall/run_recall_quality.py run \\
        --banks bank-a --disable-keyword-arm --out results/p6-vacuity-check.json

    # gate a candidate against a baseline (#4479 AC4; exit 1 on regression)
    python3 evals/recall/run_recall_quality.py compare \\
        results/p6-baseline-native.json results/p6-pgsearch.json \\
        --max-recall10-drop 0.02 --max-zero-result-regressions 0

Read `evals/recall/README.md` before changing scoring. Three things there are
load-bearing and are easy to break by accident: the judgement provenance, the
reason the headline metric is label-free, and the reason nothing here is a
latency measurement.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path

# Support both `python3 evals/recall/run_recall_quality.py` and
# `python3 -m evals.recall.run_recall_quality`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from evals.recall import metrics  # noqa: E402
from evals.recall.client import HindsightRecallClient, RecallObservation  # noqa: E402
from evals.recall.queryset import (  # noqa: E402
    QuerySet,
    load_qrels,
    load_queryset,
)

HERE = Path(__file__).resolve().parent
DEFAULT_QUERYSET = HERE / "queryset" / "v1.yaml"
DEFAULT_API_URL = os.environ.get("HINDSIGHT_API_URL", "http://127.0.0.1:18888")

EXIT_OK = 0
EXIT_REGRESSION = 1
EXIT_USAGE = 2


# ────────────────────────── running ──────────────────────────


def obs_key(query_id: str, bank: str) -> str:
    return f"{query_id}@{bank}"


def run_suite(
    client: HindsightRecallClient,
    qs: QuerySet,
    banks: Sequence[str],
    *,
    ablate_arms: Sequence[str] = (),
    budget: str = "low",
    max_tokens: int = 4096,
    progress: bool = True,
) -> list[RecallObservation]:
    """Execute every (case, bank) pair sequentially.

    Sequential is not an oversight (see `client.py`). Ablation, when requested,
    is applied to the *client-side* view of each response: nothing about the
    live instance changes, and an ablated run issues exactly the same requests
    a normal one does.
    """
    observations: list[RecallObservation] = []
    total = len(qs.cases) * len(banks)
    done = 0
    for bank in banks:
        for case in qs.cases:
            obs = client.recall(
                bank,
                case.id,
                case.text,
                budget=budget,
                max_tokens=max_tokens,
            )
            if ablate_arms:
                apply_ablation(obs, ablate_arms)
            observations.append(obs)
            done += 1
            if progress:
                print(
                    f"  [{done}/{total}] {obs_key(case.id, bank)} "
                    f"{'ok' if obs.ok else 'FAIL ' + (obs.error or '')} "
                    f"kw={len(obs.arms.get('bm25', []))} final={obs.result_count}",
                    file=sys.stderr,
                )
    return observations


def apply_ablation(obs: RecallObservation, ablate_arms: Sequence[str]) -> None:
    """Remove arms from the client-side view of a recall.

    This is how the suite constructs a "deliberately degraded configuration"
    (#4479 AC1) without mutating a live instance. The removed arm's ranked list
    is emptied and `rrf_client` is refused those contributions, so the fused
    ranking is genuinely the one that configuration would produce.

    Stages the engine computed downstream of its own fusion (`rrf_engine`,
    `rerank`, `final`) are NOT recomputed and are dropped instead of being left
    stale, because there is no honest way to simulate a cross-encoder over a
    candidate set it never saw. An ablated run therefore has no `final` stage,
    which is why `--gate-stage` defaults to `rrf_client` when comparing an
    ablated run.
    """
    arms = {arm: ranked for arm, ranked in obs.arms.items() if arm not in ablate_arms}
    for arm in ablate_arms:
        obs.arms[arm] = []
        obs.stages[f"arm:{arm}"] = []
    obs.stages["rrf_client"] = metrics.rrf_fuse(arms)
    for stage in ("rrf_engine", "rerank", "final"):
        obs.stages.pop(stage, None)
    obs.result_count = len(obs.stages["rrf_client"])


# ────────────────────────── scoring ──────────────────────────


def score(
    observations: Sequence[RecallObservation],
    qrels: Mapping[str, Mapping[str, int]],
) -> dict[str, object]:
    """Reduce observations to the score block that lands in the result file."""
    stage_names = sorted({s for obs in observations for s in obs.stages})
    stages: dict[str, dict[str, float]] = {}
    for stage in stage_names:
        per_case = []
        for obs in observations:
            if not obs.ok or stage not in obs.stages:
                continue
            relevant = qrels.get(obs.query_id) or qrels.get(obs_key(obs.query_id, obs.bank))
            if not relevant:
                continue
            per_case.append(metrics.score_case(obs.stages[stage], relevant))
        if per_case:
            stages[stage] = metrics.aggregate(per_case)
            stages[stage]["judged_cases"] = len(per_case)

    keyword_counts = {
        obs_key(obs.query_id, obs.bank): len(obs.arms.get("bm25", []))
        for obs in observations
        if obs.ok
    }
    semantic_counts = {
        obs_key(obs.query_id, obs.bank): len(obs.arms.get("semantic", []))
        for obs in observations
        if obs.ok
    }
    ok = [obs for obs in observations if obs.ok]
    kw_zero = sorted(q for q, n in keyword_counts.items() if n == 0)

    return {
        "stages": stages,
        "keyword_arm_row_counts": keyword_counts,
        "semantic_arm_row_counts": semantic_counts,
        "keyword_arm_zero_result_ids": kw_zero,
        "keyword_arm_zero_result_count": len(kw_zero),
        "keyword_arm_zero_result_rate": round(len(kw_zero) / len(ok), 6) if ok else 0.0,
        "final_zero_result_count": sum(1 for obs in ok if obs.result_count == 0),
        "cases_run": len(observations),
        "cases_ok": len(ok),
        "cases_failed": len(observations) - len(ok),
        "failures": [
            {"case": obs_key(obs.query_id, obs.bank), "error": obs.error}
            for obs in observations
            if not obs.ok
        ],
        # Diagnostics only. NOT a latency measurement: this suite runs on a box
        # that also serves the live fleet and it makes no attempt to isolate.
        "timings_not_a_measurement": {
            "note": "diagnostic only, box is not isolated, never quote as latency",
            "elapsed_ms_min": min((o.elapsed_ms for o in ok if o.elapsed_ms), default=None),
            "elapsed_ms_max": max((o.elapsed_ms for o in ok if o.elapsed_ms), default=None),
        },
    }


def engine_identity(client: HindsightRecallClient) -> dict[str, object]:
    """Whatever the instance will tell us about itself, for the result header.

    #4479 item 5 and #4475 AC2 both say the same thing in different words: a
    result without its configuration is not a result.
    """
    ident: dict[str, object] = {"api_url": client.base_url}
    try:
        ident["version"] = client.version()
    except Exception as exc:  # noqa: BLE001
        ident["version_error"] = f"{type(exc).__name__}: {exc}"
    try:
        ident["health"] = client.health()
    except Exception as exc:  # noqa: BLE001
        ident["health_error"] = f"{type(exc).__name__}: {exc}"
    return ident


def redact_bank(bank: str, redact: bool) -> str:
    """Stable pseudonym for a bank name.

    Bank ids are the operator's agent names. They are not secrets, but this
    repository is public and a committed baseline should not enumerate a
    private fleet, so the default is on. `--no-redact-banks` prints them for
    local debugging.
    """
    if not redact:
        return bank
    return "bank-" + hashlib.sha256(bank.encode()).hexdigest()[:8]


def build_result(
    args: argparse.Namespace,
    qs: QuerySet,
    banks: Sequence[str],
    observations: Sequence[RecallObservation],
    qrels: Mapping[str, Mapping[str, int]],
    ident: Mapping[str, object],
) -> dict[str, object]:
    alias = {bank: redact_bank(bank, args.redact_banks) for bank in banks}
    renamed: list[RecallObservation] = []
    for obs in observations:
        obs.bank = alias.get(obs.bank, obs.bank)
        renamed.append(obs)

    body = score(renamed, qrels)
    body.update(
        {
            "schema_version": 1,
            "kind": "hindsight-recall-quality",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "config": {
                "queryset_id": qs.queryset_id,
                "queryset_version": qs.queryset_version,
                "queryset_case_count": len(qs.cases),
                "queryset_sha256": qs.sha256,
                "banks": [alias[b] for b in banks],
                "banks_redacted": args.redact_banks,
                "backend_declared": args.backend,
                "budget": args.budget,
                "max_tokens": args.max_tokens,
                "ablated_arms": list(args.ablate_arm or []),
                "limit": args.limit,
                "families": args.families,
                "qrels_file": str(args.qrels) if args.qrels else None,
                "qrels_query_count": len(qrels),
                "pace_ms": args.pace_ms,
            },
            "engine": ident,
        }
    )
    return body


# ────────────────────────── reporting ──────────────────────────


def human_summary(result: Mapping[str, object]) -> str:
    cfg = result.get("config") or {}
    lines: list[str] = []
    lines.append("Hindsight recall quality")
    lines.append(
        f"  query set     {cfg.get('queryset_id')} {cfg.get('queryset_version')} "
        f"({cfg.get('queryset_case_count')} cases, sha256 {str(cfg.get('queryset_sha256'))[:12]})"
    )
    lines.append(f"  banks         {', '.join(cfg.get('banks') or [])}")
    lines.append(f"  backend       {cfg.get('backend_declared')}")
    engine = result.get("engine") or {}
    version = (engine.get("version") or {}) if isinstance(engine, dict) else {}
    lines.append(f"  engine        api_version={version.get('api_version')} at {engine.get('api_url')}")
    if cfg.get("ablated_arms"):
        lines.append(f"  ABLATED ARMS  {', '.join(cfg['ablated_arms'])}  (degraded configuration)")
    lines.append("")
    lines.append(
        f"  cases run {result.get('cases_run')}  ok {result.get('cases_ok')}  "
        f"failed {result.get('cases_failed')}"
    )
    lines.append(
        f"  keyword arm zero-result: {result.get('keyword_arm_zero_result_count')}"
        f"/{result.get('cases_ok')} "
        f"({float(result.get('keyword_arm_zero_result_rate') or 0) * 100:.1f}%)"
    )
    lines.append(f"  final zero-result:       {result.get('final_zero_result_count')}")
    stages = result.get("stages") or {}
    if stages:
        lines.append("")
        lines.append("  stage            recall@10 recall@50   ndcg@10       mrr  judged")
        for stage in metrics.STAGES:
            row = stages.get(stage)
            if not row:
                continue
            lines.append(
                f"  {stage:<16}"
                f"{row.get('recall@10', 0):>9.4f} {row.get('recall@50', 0):>9.4f} "
                f"{row.get('ndcg@10', 0):>9.4f} {row.get('mrr', 0):>9.4f} "
                f"{int(row.get('judged_cases', 0)):>7}"
            )
    else:
        lines.append("")
        lines.append(
            "  no graded metrics: no qrels matched. Label-free metrics above are still valid."
        )
    lines.append("")
    lines.append("  timings in this file are diagnostics, not a latency measurement.")
    return "\n".join(lines)


# ────────────────────────── modes ──────────────────────────


def cmd_run(args: argparse.Namespace) -> int:
    qs = load_queryset(args.queryset)
    if args.families:
        qs = qs.filtered(families=args.families.split(","))
    if args.limit:
        qs = qs.limited(args.limit, seed=args.seed)
    banks = [b.strip() for b in args.banks.split(",") if b.strip()]
    if not banks:
        print("error: --banks is required and must name at least one bank", file=sys.stderr)
        return EXIT_USAGE

    qrels = load_qrels(args.qrels) if args.qrels else {}
    client = HindsightRecallClient(
        args.api_url, token=args.api_token, timeout_s=args.timeout_s, pace_ms=args.pace_ms
    )
    ident = engine_identity(client)

    runs: list[dict[str, object]] = []
    for attempt in range(args.runs):
        if args.runs > 1:
            print(f"run {attempt + 1}/{args.runs}", file=sys.stderr)
        observations = run_suite(
            client,
            qs,
            banks,
            ablate_arms=args.ablate_arm or [],
            budget=args.budget,
            max_tokens=args.max_tokens,
            progress=not args.quiet,
        )
        runs.append(build_result(args, qs, banks, observations, qrels, ident))

    result = runs[-1]
    if args.runs > 1:
        det = metrics.variance_report(runs)
        det["budget"] = args.determinism_budget
        # A report that compared nothing must not claim determinism. This is the
        # AC3 analogue of the fail-open scorer: `worst_spread: 0.0` over an empty
        # comparison set reads as "perfectly deterministic" and means "measured
        # nothing".
        det["within_budget"] = bool(det["measured"]) and (
            det["worst_spread"] <= args.determinism_budget
        )
        result["determinism"] = det
        # Label-free metrics have their own stability question: the keyword arm
        # returning rows for a query is the thing the headline metric counts, so
        # a run where that set moves is a run whose headline number moved.
        zero_sets = [set(r.get("keyword_arm_zero_result_ids") or []) for r in runs]
        union = set().union(*zero_sets)
        stable = set.intersection(*zero_sets) if zero_sets else set()
        result["determinism"]["keyword_zero_set_unstable_ids"] = sorted(union - stable)
        result["determinism"]["keyword_zero_set_jaccard"] = (
            round(len(stable) / len(union), 6) if union else 1.0
        )

    if args.min_judged_coverage > 0:
        gate = (result.get("stages") or {}).get(args.gate_stage) or {}
        coverage = gate.get("judged_coverage@10")
        if coverage is not None and coverage < args.min_judged_coverage:
            print(
                f"error: judged coverage {coverage:.4f} at stage {args.gate_stage} is under "
                f"--min-judged-coverage {args.min_judged_coverage:.4f}. The qrels file has "
                "most likely gone stale against a bank that has since consolidated.",
                file=sys.stderr,
            )
            write_out(args.out, result)
            print(human_summary(result))
            return EXIT_REGRESSION

    write_out(args.out, result)
    print(human_summary(result))
    if args.runs > 1:
        det = result["determinism"]
        if not det["measured"]:
            print(
                f"\n  determinism over {det['runs']} runs: NOT MEASURED "
                "(no comparable metrics across runs)"
            )
        else:
            print(
                f"\n  determinism over {det['runs']} runs: worst spread "
                f"{det['worst_spread']:.6f} on {det['worst_metric']} "
                f"across {det['metrics_compared']} metrics "
                f"(budget {args.determinism_budget})"
            )
        if not det["within_budget"]:
            print("  determinism budget EXCEEDED or unmeasured", file=sys.stderr)
            return EXIT_REGRESSION
    # Across ALL runs, not just the one whose scores are reported: with
    # `--runs N` the reported block is the last run, and failures in an earlier
    # run are exactly as disqualifying.
    failed = sum(int(r.get("cases_failed") or 0) for r in runs)
    if failed and args.fail_on_error:
        print(f"\n  {failed} case(s) errored across {len(runs)} run(s)", file=sys.stderr)
        return EXIT_REGRESSION
    return EXIT_OK


def cmd_compare(args: argparse.Namespace) -> int:
    baseline = json.loads(Path(args.baseline).read_text())
    candidate = json.loads(Path(args.candidate).read_text())

    gate_stage = args.gate_stage
    if gate_stage not in (candidate.get("stages") or {}):
        # An ablated run has no post-fusion stages by construction, so fall back
        # to the stage both runs actually have rather than failing on a
        # technicality and hiding a real regression.
        for fallback in ("rrf_client", "arm:bm25"):
            if fallback in (candidate.get("stages") or {}) and fallback in (
                baseline.get("stages") or {}
            ):
                gate_stage = fallback
                break

    verdict = metrics.compare(
        baseline,
        candidate,
        max_recall10_drop=args.max_recall10_drop,
        max_zero_result_regressions=args.max_zero_result_regressions,
        gate_stage=gate_stage,
    )
    zero = metrics.zero_result_metric(
        baseline.get("keyword_arm_row_counts") or {},
        candidate.get("keyword_arm_row_counts") or {},
    )
    report = {
        "schema_version": 1,
        "kind": "hindsight-recall-quality-compare",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "baseline": {
            "file": str(args.baseline),
            "config": baseline.get("config"),
            "engine": baseline.get("engine"),
        },
        "candidate": {
            "file": str(args.candidate),
            "config": candidate.get("config"),
            "engine": candidate.get("engine"),
        },
        "headline": zero,
        "verdict": verdict,
    }
    write_out(args.out, report)

    print("Recall quality comparison")
    print(f"  baseline   {args.baseline}")
    print(f"  candidate  {args.candidate}")
    print(f"  gate stage {verdict['gate_stage']}")
    print("")
    print(
        f"  HEADLINE zero_result_queries_answered/total: "
        f"{zero['zero_result_queries_answered']}/{zero['zero_result_queries_total']} "
        f"({zero['zero_result_answer_rate'] * 100:.1f}%)"
    )
    if zero["zero_result_unevaluated_ids"]:
        print(
            f"  {len(zero['zero_result_unevaluated_ids'])} zero-result queries were not "
            "evaluated by the candidate and are counted as not answered"
        )
    b10, c10 = verdict["recall@10_baseline"], verdict["recall@10_candidate"]
    if b10 is not None and c10 is not None:
        print(f"  recall@10  {b10:.4f} -> {c10:.4f}  (drop {verdict['recall@10_drop']:+.4f})")
    print(f"  keyword-zero regressions: {len(verdict['zero_result_regressions'])}")
    print("")
    if verdict["ok"]:
        print("  PASS: within budget")
        return EXIT_OK
    print("  FAIL:")
    for finding in verdict["findings"]:
        print(f"    - {finding}")
    return EXIT_REGRESSION


def write_out(out: str | None, payload: Mapping[str, object]) -> None:
    if not out:
        return
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {path}", file=sys.stderr)


# ────────────────────────── cli ──────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_recall_quality.py",
        description="Hindsight recall-quality eval (issue #4479)",
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    run = sub.add_parser("run", help="run the suite against a live instance and score it")
    run.add_argument("--queryset", default=str(DEFAULT_QUERYSET))
    run.add_argument("--qrels", default=None, help="relevance judgements (ids only); see qrels/README.md")
    run.add_argument("--banks", required=True, help="comma-separated bank ids")
    run.add_argument("--api-url", default=DEFAULT_API_URL)
    run.add_argument("--api-token", default=os.environ.get("HINDSIGHT_API_TOKEN"))
    run.add_argument("--backend", default="unknown", help="backend label recorded in the result file")
    run.add_argument("--budget", default="low", choices=["low", "medium", "high"])
    run.add_argument("--max-tokens", type=int, default=4096)
    run.add_argument("--timeout-s", type=float, default=60.0)
    run.add_argument("--pace-ms", type=int, default=0, help="minimum gap between recall calls")
    run.add_argument("--limit", type=int, default=0, help="run a deterministic subset of N cases")
    run.add_argument("--families", default=None, help="comma-separated family filter")
    run.add_argument("--seed", type=int, default=0, help="subset selection seed (deterministic)")
    run.add_argument("--runs", type=int, default=1, help="repeat and report run-to-run spread")
    run.add_argument("--determinism-budget", type=float, default=0.01)
    run.add_argument("--gate-stage", default="final")
    run.add_argument("--min-judged-coverage", type=float, default=0.0)
    # Fail-CLOSED by default. Every metric here is a ratio whose denominator is
    # the set of cases that succeeded, so a run where 27 of 28 cases errored
    # would otherwise exit 0 and report a confident-looking score over the one
    # that worked. A quality gate that reports a number after the system fell
    # over is worse than one that reports nothing.
    run.add_argument(
        "--no-fail-on-error",
        dest="fail_on_error",
        action="store_false",
        help="exit 0 even when cases errored (default: any errored case exits non-zero)",
    )
    run.add_argument(
        "--ablate-arm",
        action="append",
        choices=list(metrics.ARMS),
        help="remove an arm from client-side fusion (degraded configuration)",
    )
    run.add_argument(
        "--disable-keyword-arm",
        dest="ablate_arm",
        action="append_const",
        const="bm25",
        help="alias for --ablate-arm bm25 (the #4479 AC1 vacuity check)",
    )
    run.add_argument("--no-redact-banks", dest="redact_banks", action="store_false")
    run.add_argument("--quiet", action="store_true")
    run.add_argument("--out", default=None)
    run.set_defaults(func=cmd_run, redact_banks=True, fail_on_error=True)

    cmp_ = sub.add_parser("compare", help="grade a candidate result file against a baseline")
    cmp_.add_argument("baseline")
    cmp_.add_argument("candidate")
    cmp_.add_argument("--max-recall10-drop", type=float, default=0.02)
    cmp_.add_argument("--max-zero-result-regressions", type=int, default=0)
    cmp_.add_argument("--gate-stage", default="final")
    cmp_.add_argument("--out", default=None)
    cmp_.set_defaults(func=cmd_compare)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
