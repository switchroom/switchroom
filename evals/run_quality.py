#!/usr/bin/env python3
"""Quality eval runner for switchroom skills."""

import argparse
import asyncio
import os
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).parent
RESULTS_DIR = EVALS_DIR / "results"
SKILLS_DIR = EVALS_DIR.parent / "skills"

DEFAULT_MODEL = "claude-sonnet-5"


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=EVALS_DIR,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def load_skill_content(skill_name: str) -> str | None:
    """Return SKILL.md text, or None if it is missing.

    None is distinct from "" — a missing skill under with_skill=True is a
    hard error (the eval would silently measure the base model), whereas an
    empty file is a real, if degenerate, skill.
    """
    skill_md = SKILLS_DIR / skill_name / "SKILL.md"
    if skill_md.exists():
        return skill_md.read_text()
    return None


async def call_claude(
    prompt: str,
    model: str,
    system_prompt: str | None = None,
    append_system: bool = False,
    timeout: int = 60,
) -> str:
    args = ["claude", "-p", prompt, "--model", model, "--print", "--no-session-persistence"]
    if system_prompt:
        if append_system:
            args.extend(["--append-system-prompt", system_prompt])
        else:
            args.extend(["--system-prompt", system_prompt])
    env = {**os.environ, "SWITCHROOM_EVAL_MODE": "1"}
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd="/tmp",  # clean dir — no CLAUDE.md interference
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"claude -p timed out after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed (exit {proc.returncode}): {stderr.decode().strip()}")
    return stdout.decode("utf-8").strip()


def check_assertions(
    eval_id: str,
    response_text: str,
    expected_contains: list[str],
    expected_not_contains: list[str],
) -> tuple[bool, list[str], list[str]]:
    """Returns (passed, matched_terms, missed_terms).

    Every re.search is wrapped so a malformed regex fragment surfaces as a
    named failure (eval id + offending fragment) rather than crashing the
    whole run. validate_datasets.py compiles these ahead of time, but the
    runner stays defensive.
    """
    matched = []
    missed = []

    def any_alt(pattern: str) -> bool:
        for alt in (a.strip() for a in pattern.split("|")):
            try:
                if re.search(alt, response_text, re.IGNORECASE):
                    return True
            except re.error as ex:
                missed.append(f"REGEX_ERROR [{eval_id}] fragment={alt!r}: {ex}")
        return False

    for pattern in expected_contains:
        if any_alt(pattern):
            matched.append(pattern)
        else:
            missed.append(f"MISSING: {pattern}")

    for pattern in expected_not_contains:
        if any_alt(pattern):
            missed.append(f"FOUND (should not): {pattern}")
        else:
            matched.append(f"NOT_FOUND (good): {pattern}")

    passed = not any(
        m.startswith("MISSING") or m.startswith("FOUND") or m.startswith("REGEX_ERROR")
        for m in missed
    )
    return passed, matched, missed


async def run_eval(
    eval_item: dict,
    model: str,
    with_skill: bool,
    run_index: int,
    timeout: int = 180,
) -> dict:
    skill_name = eval_item.get("primary_skill", "")
    error = None
    skill_content = None
    if with_skill:
        skill_content = load_skill_content(skill_name)
        if skill_content is None:
            # Fail loudly rather than measure the bare model under a
            # with_skill=True label.
            return {
                "id": eval_item["id"],
                "run": run_index,
                "question": eval_item["question"],
                "skill": skill_name,
                "with_skill": True,
                "passed": False,
                "error": f"SKILL.md missing for primary_skill={skill_name!r}",
                "response_preview": "",
                "matched_terms": [],
                "missed_terms": [f"SKILL.md missing: skills/{skill_name}/SKILL.md"],
                "tags": eval_item.get("tags", []),
            }

    try:
        response_text = await call_claude(
            eval_item["question"],
            model,
            system_prompt=skill_content if skill_content else None,
            append_system=True,
            timeout=timeout,
        )
    except Exception as ex:
        return {
            "id": eval_item["id"],
            "run": run_index,
            "question": eval_item["question"],
            "skill": skill_name,
            "with_skill": with_skill,
            "passed": False,
            "error": f"{type(ex).__name__}: {ex}",
            "response_preview": "",
            "matched_terms": [],
            "missed_terms": [f"CALL_ERROR: {ex}"],
            "tags": eval_item.get("tags", []),
        }

    passed, matched, missed = check_assertions(
        eval_item["id"],
        response_text,
        eval_item.get("expected_contains", []),
        eval_item.get("expected_not_contains", []),
    )

    return {
        "id": eval_item["id"],
        "run": run_index,
        "question": eval_item["question"],
        "skill": skill_name,
        "with_skill": with_skill,
        "passed": passed,
        "error": error,
        "response_preview": response_text[:200],
        "matched_terms": matched,
        "missed_terms": missed,
        "tags": eval_item.get("tags", []),
    }


async def run_all(
    evals: list[dict],
    model: str,
    parallel: int,
    ablation: bool,
    runs: int,
    timeout: int = 180,
) -> list[dict]:
    semaphore = asyncio.Semaphore(parallel)

    async def bounded(eval_item, with_skill, run_idx):
        async with semaphore:
            return await run_eval(eval_item, model, with_skill, run_idx, timeout=timeout)

    coros = []
    for e in evals:
        for i in range(runs):
            coros.append(bounded(e, True, i))
            if ablation:
                coros.append(bounded(e, False, i))

    outcomes = await asyncio.gather(*coros, return_exceptions=True)
    rows: list[dict] = []
    for o in outcomes:
        if isinstance(o, Exception):
            # Defensive: run_eval already catches, but never let a bare
            # exception sink a row — the artifact must always exist.
            rows.append({
                "id": "unknown",
                "run": 0,
                "question": "",
                "skill": "",
                "with_skill": True,
                "passed": False,
                "error": f"{type(o).__name__}: {o}",
                "response_preview": "",
                "matched_terms": [],
                "missed_terms": [f"GATHER_ERROR: {o}"],
                "tags": [],
            })
        else:
            rows.append(o)
    return rows


def pass_rate(rows: list[dict]) -> float:
    return (sum(1 for r in rows if r["passed"]) / len(rows)) if rows else 0.0


def compute_uplift(results: list[dict]) -> dict:
    """Per-eval and per-skill uplift = with_skill pass rate − no_skill pass rate.

    Buckets 2–5 read per_eval deltas to reject tautological entries: an eval
    the skill doesn't help (delta <= 0) is not testing the skill.
    """
    by_eval_with: dict[str, list[dict]] = defaultdict(list)
    by_eval_without: dict[str, list[dict]] = defaultdict(list)
    skill_of: dict[str, str] = {}
    for r in results:
        skill_of[r["id"]] = r["skill"]
        (by_eval_with if r["with_skill"] else by_eval_without)[r["id"]].append(r)

    per_eval = {}
    per_skill_with: dict[str, list[dict]] = defaultdict(list)
    per_skill_without: dict[str, list[dict]] = defaultdict(list)
    for eval_id in sorted(set(by_eval_with) | set(by_eval_without)):
        w = pass_rate(by_eval_with.get(eval_id, []))
        n = pass_rate(by_eval_without.get(eval_id, []))
        per_eval[eval_id] = {
            "skill": skill_of.get(eval_id, ""),
            "with_skill_pass_rate": round(w, 3),
            "no_skill_pass_rate": round(n, 3),
            "uplift": round(w - n, 3),
        }
        per_skill_with[skill_of.get(eval_id, "")].extend(by_eval_with.get(eval_id, []))
        per_skill_without[skill_of.get(eval_id, "")].extend(by_eval_without.get(eval_id, []))

    per_skill = {}
    for skill in sorted(set(per_skill_with) | set(per_skill_without)):
        w = pass_rate(per_skill_with.get(skill, []))
        n = pass_rate(per_skill_without.get(skill, []))
        per_skill[skill] = {
            "with_skill_pass_rate": round(w, 3),
            "no_skill_pass_rate": round(n, 3),
            "uplift": round(w - n, 3),
        }
    return {"per_eval": per_eval, "per_skill": per_skill}


def main():
    parser = argparse.ArgumentParser(description="Run quality evals for switchroom skills")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--parallel", type=int, default=5, help="Concurrent requests")
    parser.add_argument("--ablation", action="store_true", help="Also run without skill and gate/report uplift")
    parser.add_argument("--runs", type=int, default=1, help="Runs per (eval, condition) for flakiness detection")
    parser.add_argument("--filter", help="Filter evals by skill name or tag")
    parser.add_argument("--dataset", default=str(EVALS_DIR / "dataset.yaml"))
    parser.add_argument("--timeout", type=int, default=180, help="Per-call timeout in seconds")
    args = parser.parse_args()

    dataset = yaml.safe_load(Path(args.dataset).read_text())
    evals = dataset["evals"]

    if args.filter:
        evals = [
            e for e in evals
            if args.filter in e.get("primary_skill", "")
            or args.filter in e.get("tags", [])
        ]

    if not evals:
        print("FATAL: no evals selected after --filter", file=sys.stderr)
        sys.exit(2)

    print(f"Running {len(evals)} evals x{args.runs} runs "
          f"(ablation={args.ablation}, parallel={args.parallel})")

    results = asyncio.run(run_all(evals, args.model, args.parallel, args.ablation, args.runs, args.timeout))

    # The exit-code gate scores with_skill=True results only — the no-skill
    # arm is a comparison baseline, not a pass/fail target.
    scored = [r for r in results if r["with_skill"]]
    passed = sum(1 for r in scored if r["passed"])
    total = len(scored)
    errored = sum(1 for r in scored if r.get("error"))
    print(f"\nResults (with-skill): {passed}/{total} passed ({errored} errored)")

    # Per-eval flaky roll-up over the scored arm.
    by_id: dict[str, list[dict]] = defaultdict(list)
    for r in scored:
        by_id[r["id"]].append(r)
    for eval_id, rs in sorted(by_id.items()):
        rp = sum(1 for r in rs if r["passed"])
        if rp == len(rs):
            status = "PASS"
        elif any(r.get("error") for r in rs):
            status = "ERROR"
        elif rp > 0:
            status = "FLAKY"
        else:
            status = "FAIL"
        print(f"  [{status}] {eval_id} ({rp}/{len(rs)})")
        if status != "PASS":
            for r in rs:
                for m in r["missed_terms"]:
                    print(f"         {m}")

    uplift = compute_uplift(results) if args.ablation else None
    if uplift:
        print("\nUplift (with-skill − no-skill) per skill:")
        for skill, d in uplift["per_skill"].items():
            print(f"  {skill}: {d['uplift']:+.3f} "
                  f"(with={d['with_skill_pass_rate']:.3f} without={d['no_skill_pass_rate']:.3f})")

    RESULTS_DIR.mkdir(exist_ok=True)
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "git_sha": git_sha(),
        "ablation": args.ablation,
        "runs_per_eval": args.runs,
        "summary": {"passed": passed, "total": total, "errored": errored},
        "uplift": uplift,
        "results": results,
    }
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outfile = RESULTS_DIR / f"quality_{ts}.json"
    outfile.write_text(json.dumps(output, indent=2))
    print(f"\nResults written to {outfile}")

    if passed < total:
        sys.exit(1)


if __name__ == "__main__":
    main()
