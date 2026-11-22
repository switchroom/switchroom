#!/usr/bin/env python3
"""Revert the fast-lane merge that turned main red; never deliver it.

A fast-lane PR merges after cheap checks, with some real-Agent legs deferred
to main push CI (`deferred_on_pr` in the push plan from source-ci.py). When a
push run fails, this finds the culprit, the oldest commit of the current red
streak on main (its parent's newest push run is green), and opens a revert
PR with squash auto-merge armed. It acts only when all hold, otherwise it
only reports:

- every push run on main newer than the failed one has completed, and none
  is green (a fix may already be landing; the last completion decides);
- the failed jobs failed in their test steps, not in setup (infra);
- the culprit's plan deferred work from its PR (a fully gated merge already
  ran the same suite, so its red is a flake or drift, not a culprit);
- the culprit is not itself a revert, and has not been reverted already;
- the streak is short enough to walk (STREAK_LIMIT commits).

Delivery needs no action: Plugin pin handoff and Fleet Image publish only
proceed from a green exact-SHA main run.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ".github/workflows/ci.yml"
SHA = re.compile(r"[0-9a-f]{40}")
STREAK_LIMIT = 20
# Steps whose failure is a test verdict. A failure anywhere else (checkout, setup-python, pip,
# Core checkout) is infrastructure: report it, never revert for it.
TEST_STEPS = re.compile(r"^(Unit tests|Real Agent .*|Real native .*|Guarded native .*|Enforce selected work)$")


def push_runs(runs: Sequence[dict[str, Any]], sha: str | None = None) -> list[dict[str, Any]]:
    keep = [r for r in runs if r.get("event") == "push" and r.get("head_branch") == "main"
            and r.get("path") == WORKFLOW_PATH and (sha is None or r.get("head_sha") == sha)]
    return sorted(keep, key=lambda r: (str(r.get("created_at", "")), int(r.get("id", 0))))


def newest_state(runs: Sequence[dict[str, Any]]) -> str:
    """'green', 'red', 'pending' or 'absent' for the newest push run in `runs`."""
    ordered = push_runs(runs)
    if not ordered:
        return "absent"
    run = ordered[-1]
    if run.get("status") != "completed":
        return "pending"
    return "green" if run.get("conclusion") == "success" else "red"


def is_revert(message: str) -> bool:
    return message.startswith(('Revert "', "Revert ")) or "This reverts commit" in message


def failed_in_tests(jobs: Sequence[dict[str, Any]]) -> bool:
    failed = [j for j in jobs if j.get("conclusion") == "failure"]
    if not failed:
        return False
    for job in failed:
        steps = [s for s in job.get("steps") or [] if s.get("conclusion") == "failure"]
        if not steps or not all(TEST_STEPS.match(str(s.get("name", ""))) for s in steps):
            return False
    return True


def decide(*, run: dict[str, Any], newer_main_runs: Sequence[dict[str, Any]], jobs: Sequence[dict[str, Any]],
           streak: Sequence[dict[str, Any]] | None, plan: dict[str, Any] | None) -> tuple[str, str]:
    """Return (action, reason); action is 'revert', 'report' or 'none'.

    `streak` lists the red streak oldest first, each {'sha', 'message', 'reverted'}; None when it
    could not be walked back to a green parent within STREAK_LIMIT.
    """
    if run.get("conclusion") != "failure":
        return "none", f"run concluded {run.get('conclusion')!r}"
    newer = push_runs(newer_main_runs)
    if any(r.get("status") != "completed" for r in newer):
        return "none", "a newer main run is still in flight; its completion decides"
    if any(r.get("conclusion") == "success" for r in newer):
        return "none", "main has gone green again since this run"
    if not failed_in_tests(jobs):
        return "report", "the run failed outside its test steps (infrastructure); not reverting"
    if not streak:
        return "report", "the red streak has no green parent within reach; not reverting"
    culprit = streak[0]
    if is_revert(culprit["message"]):
        return "report", f"culprit {culprit['sha'][:12]} is itself a revert; never reverting a revert"
    if culprit["reverted"]:
        return "none", f"culprit {culprit['sha'][:12]} was already reverted"
    deferred = (plan or {}).get("deferred_on_pr") or []
    if not deferred:
        return "report", (f"culprit {culprit['sha'][:12]} was a fully gated merge: its PR ran this suite, "
                          "so this is a flake or drift")
    return "revert", (f"fast-lane merge {culprit['sha'][:12]} (deferred: " + ", ".join(sorted(deferred))
                      + ") turned main red")


def gh_json(args: Sequence[str]) -> Any:
    return json.loads(subprocess.check_output(["gh", *args], text=True, timeout=60))


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(ROOT), *args], text=True, capture_output=True, check=check)


def main_runs(repository: str, **query: str) -> list[dict[str, Any]]:
    params = "&".join(f"{k}={v}" for k, v in {"event": "push", "branch": "main", "per_page": "100", **query}.items())
    return gh_json(["api", f"repos/{repository}/actions/workflows/ci.yml/runs?{params}"])["workflow_runs"]


def push_plan(parent: str, sha: str) -> dict[str, Any] | None:
    result = subprocess.run([sys.executable, str(ROOT / "scripts/source-ci.py"), "select", "--event", "push",
                             "--base", parent, "--head", sha], text=True, capture_output=True, check=False)
    try:
        return json.loads(result.stdout) if result.returncode == 0 else None
    except ValueError:
        return None


def red_streak(repository: str, sha: str, state: Callable[[str], str]) -> list[dict[str, Any]] | None:
    """Commits of the red streak ending at `sha`, oldest first; None if no green parent in reach."""
    first_parent = git("rev-list", "--first-parent", f"--max-count={STREAK_LIMIT + 1}", sha).stdout.split()
    streak = []
    for commit, parent in zip(first_parent, first_parent[1:]):
        streak.insert(0, commit)
        parent_state = state(parent)
        if parent_state == "green":
            break
        if parent_state not in ("red", "absent"):
            return None
    else:
        return None
    reverted = git("log", "--format=%B", "origin/main").stdout
    return [{"sha": c, "message": git("log", "-1", "--format=%B", c).stdout,
             "reverted": f"This reverts commit {c}" in reverted} for c in streak]


def main(argv: Sequence[str] | None = None, *, out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)
    run = gh_json(["api", f"repos/{args.repository}/actions/runs/{args.run_id}"])
    sha = run.get("head_sha") or ""
    if not SHA.fullmatch(sha):
        raise SystemExit(f"run {args.run_id} has no commit SHA")
    newer = [r for r in push_runs(main_runs(args.repository))
             if str(r.get("created_at", "")) > str(run.get("created_at", ""))]
    jobs = gh_json(["api", f"repos/{args.repository}/actions/runs/{args.run_id}/jobs?filter=latest&per_page=100"])["jobs"]
    streak = red_streak(args.repository, sha, lambda c: newest_state(main_runs(args.repository, head_sha=c)))
    culprit, parent, plan = (streak[0]["sha"], git("rev-parse", streak[0]["sha"] + "^").stdout.strip(), None) \
        if streak else ("", "", None)
    if culprit:
        plan = push_plan(parent, culprit)
    action, reason = decide(run=run, newer_main_runs=newer, jobs=jobs, streak=streak, plan=plan)
    if action == "revert" and git("ls-remote", "--heads", "origin", f"auto-revert/{culprit[:12]}",
                                  check=False).stdout.strip():
        action, reason = "none", f"a revert branch for {culprit[:12]} is already open"
    out(f"auto-revert: {action}: {reason}")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as stream:
            stream.write(f"action={action}\nsha={culprit or sha}\nreason={reason}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
