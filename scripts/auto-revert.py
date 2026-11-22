#!/usr/bin/env python3
"""Revert a fast-lane merge that turned main red; never deliver it.

A fast-lane PR merges after cheap checks, with some real-Agent legs deferred
to main push CI (`deferred_on_pr` in the push plan from source-ci.py). When
that push run fails, this opens a revert PR with squash auto-merge armed and
files an issue. It acts only when all hold, otherwise it only reports:

- the failed run is the newest push CI run on main for that commit;
- the commit's plan deferred work from its PR (fully gated merges already ran
  the same suite before merge, so their red is a flake or drift, not a
  culprit to revert blindly);
- the commit's parent was green on main (only the first red commit is
  reverted; reverts are never stacked);
- no newer push run on main has gone green since (a fix already landed);
- no revert branch or PR for this commit exists yet.

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


def push_runs(runs: Sequence[dict[str, Any]], sha: str | None = None) -> list[dict[str, Any]]:
    keep = [r for r in runs if r.get("event") == "push" and r.get("head_branch") == "main"
            and r.get("path") == WORKFLOW_PATH and (sha is None or r.get("head_sha") == sha)]
    return sorted(keep, key=lambda r: (str(r.get("created_at", "")), int(r.get("id", 0))))


def decide(*, run: dict[str, Any], runs_for_sha: Sequence[dict[str, Any]],
           parent_runs: Sequence[dict[str, Any]], newer_main_runs: Sequence[dict[str, Any]],
           plan: dict[str, Any] | None, revert_exists: bool) -> tuple[str, str]:
    """Return (action, reason); action is 'revert', 'report' or 'none'."""
    if run.get("conclusion") != "failure":
        return "none", f"run concluded {run.get('conclusion')!r}"
    newest = push_runs(runs_for_sha)
    if not newest or newest[-1].get("id") != run.get("id"):
        return "none", "a newer CI run exists for this commit"
    if any(r.get("status") == "completed" and r.get("conclusion") == "success" for r in newer_main_runs):
        return "none", "main has gone green again since this commit"
    if revert_exists:
        return "none", "a revert for this commit already exists"
    deferred = (plan or {}).get("deferred_on_pr") or []
    if not deferred:
        return "report", "fully gated merge went red on main: the PR ran this suite, so this is a flake or drift"
    parent = push_runs(parent_runs)
    if not parent or parent[-1].get("status") != "completed" or parent[-1].get("conclusion") != "success":
        return "report", "parent commit was not green on main; not stacking a revert"
    return "revert", "fast-lane merge (deferred: " + ", ".join(sorted(deferred)) + ") turned main red"


def gh_json(args: Sequence[str]) -> Any:
    return json.loads(subprocess.check_output(["gh", *args], text=True))


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(ROOT), *args], text=True, capture_output=True, check=check)


def main_runs(repository: str, **query: str) -> list[dict[str, Any]]:
    params = "&".join(f"{k}={v}" for k, v in {"event": "push", "branch": "main", "per_page": "50", **query}.items())
    return gh_json(["api", f"repos/{repository}/actions/workflows/ci.yml/runs?{params}"])["workflow_runs"]


def push_plan(parent: str, sha: str) -> dict[str, Any] | None:
    result = subprocess.run([sys.executable, str(ROOT / "scripts/source-ci.py"), "select", "--event", "push",
                             "--base", parent, "--head", sha], text=True, capture_output=True, check=False)
    try:
        return json.loads(result.stdout) if result.returncode == 0 else None
    except ValueError:
        return None


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
    parents = git("rev-list", "--parents", "-n", "1", sha).stdout.split()[1:]
    if len(parents) != 1:
        action, reason, parent = "report", "commit is not a single-parent main commit", ""
    else:
        parent = parents[0]
        newer = [r for r in push_runs(main_runs(args.repository))
                 if str(r.get("created_at", "")) > str(run.get("created_at", ""))]
        branch = f"auto-revert/{sha[:12]}"
        exists = bool(git("ls-remote", "--heads", "origin", branch, check=False).stdout.strip())
        action, reason = decide(run=run, runs_for_sha=main_runs(args.repository, head_sha=sha),
                                parent_runs=main_runs(args.repository, head_sha=parent),
                                newer_main_runs=newer, plan=push_plan(parent, sha), revert_exists=exists)
    out(f"auto-revert: {action}: {reason}")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as stream:
            stream.write(f"action={action}\nsha={sha}\nparent={parent}\nreason={reason}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
