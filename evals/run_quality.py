#!/usr/bin/env python3
"""Quality eval runner for clerk skills."""

import argparse
import asyncio
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).parent
RESULTS_DIR = EVALS_DIR / "results"
SKILLS_DIR = EVALS_DIR.parent / "skills"

DEFAULT_MODEL = "claude-sonnet-4-6"


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=EVALS_DIR,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def load_skill_content(skill_name: str) -> str:
    skill_md = SKILLS_DIR / skill_name / "SKILL.md"
    if skill_md.exists():
        return skill_md.read_text()
    return ""


async def call_claude(
    prompt: str,
    model: str,
    system_prompt: str | None = None,
    append_system: bool = False,
    timeout: int = 60,
) -> str:
    args = ["claude", "-p", prompt, "--model", model, "--print", "--no-session-persistence", "--bare"]
    if system_prompt:
        if append_system:
            args.extend(["--append-system-prompt", system_prompt])
        else:
            args.extend(["--system-prompt", system_prompt])
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
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
    response_text: str,
    expected_contains: list[str],
    expected_not_contains: list[str],
) -> tuple[bool, list[str], list[str]]:
    """Returns (passed, matched_terms, missed_terms)."""
    matched = []
    missed = []

    for pattern in expected_contains:
        # Support pipe-separated alternatives
        alternatives = [a.strip() for a in pattern.split("|")]
        if any(re.search(alt, response_text, re.IGNORECASE) for alt in alternatives):
            matched.append(pattern)
        else:
            missed.append(f"MISSING: {pattern}")

    for pattern in expected_not_contains:
        alternatives = [a.strip() for a in pattern.split("|")]
        if any(re.search(alt, response_text, re.IGNORECASE) for alt in alternatives):
            missed.append(f"FOUND (should not): {pattern}")
        else:
            matched.append(f"NOT_FOUND (good): {pattern}")

    passed = not any(m.startswith("MISSING") or m.startswith("FOUND") for m in missed)
    return passed, matched, missed


async def run_eval(
    eval_item: dict,
    model: str,
    with_skill: bool,
) -> dict:
    skill_name = eval_item.get("primary_skill", "")
    skill_content = load_skill_content(skill_name) if with_skill else ""

    response_text = await call_claude(
        eval_item["question"],
        model,
        system_prompt=skill_content if skill_content else None,
        append_system=True,
    )

    passed, matched, missed = check_assertions(
        response_text,
        eval_item.get("expected_contains", []),
        eval_item.get("expected_not_contains", []),
    )

    return {
        "id": eval_item["id"],
        "question": eval_item["question"],
        "skill": skill_name,
        "with_skill": with_skill,
        "passed": passed,
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
) -> list[dict]:
    semaphore = asyncio.Semaphore(parallel)

    async def bounded(eval_item, with_skill):
        async with semaphore:
            return await run_eval(eval_item, model, with_skill)

    tasks = []
    for e in evals:
        tasks.append(bounded(e, with_skill=True))
        if ablation:
            tasks.append(bounded(e, with_skill=False))

    return await asyncio.gather(*tasks)


def main():
    parser = argparse.ArgumentParser(description="Run quality evals for clerk skills")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--parallel", type=int, default=5, help="Concurrent requests")
    parser.add_argument("--ablation", action="store_true", help="Also run without skill")
    parser.add_argument("--filter", help="Filter evals by skill name or tag")
    parser.add_argument("--dataset", default=str(EVALS_DIR / "dataset.yaml"))
    args = parser.parse_args()

    dataset = yaml.safe_load(Path(args.dataset).read_text())
    evals = dataset["evals"]

    if args.filter:
        evals = [
            e for e in evals
            if args.filter in e.get("primary_skill", "")
            or args.filter in e.get("tags", [])
        ]

    print(f"Running {len(evals)} evals (ablation={args.ablation}, parallel={args.parallel})")

    results = asyncio.run(run_all(evals, args.model, args.parallel, args.ablation))

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    print(f"\nResults: {passed}/{total} passed")

    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        suffix = "" if r["with_skill"] else " [no-skill]"
        print(f"  [{status}] {r['id']}{suffix}")
        if not r["passed"]:
            for m in r["missed_terms"]:
                print(f"         {m}")

    RESULTS_DIR.mkdir(exist_ok=True)
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "git_sha": git_sha(),
        "ablation": args.ablation,
        "summary": {"passed": passed, "total": total},
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
