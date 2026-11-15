#!/usr/bin/env python3
"""Re-apply an overlay's Hermes Agent patches on the latest upstream and test them.

An overlay that carries its own fixes to Hermes Agent keeps them as plain
patch files listed, in order, in a series file (see
``examples/overlay-repo/patches/series.json``). This tool:

1. resolves the upstream branch (``refs/heads/<ref>``) to one commit, or uses
   ``--upstream-commit``;
2. fetches only that commit into a throwaway work directory;
3. applies each patch in order. A patch that applies is ``applied``; one whose
   change upstream already contains is ``already_upstream`` (a candidate to
   retire); one that does not apply even with a three-way merge is ``failed``
   and stops the run;
4. runs the series' test command in the patched tree, with credential-looking
   environment variables removed, so upstream code never sees a token;
5. writes a JSON report and a Markdown summary.

A series with zero patches is valid: the run reports "nothing to re-apply"
and, unless ``tests.when`` is ``always``, runs no tests.

It never commits, pushes, tags, pins an image, edits a Compose file or starts
a rollout. The only network access is ``git ls-remote`` and ``git fetch`` of
the upstream repository named in the series.

Exit codes: 0 every patch applied (or was already upstream) and tests passed
or were not needed; 1 a patch failed or tests failed; 2 config or usage error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCHEMA = "switchroom-upstream-patches/1"
REPORT_SCHEMA = "switchroom-upstream-patch-test/1"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SECRET_ENV_RE = re.compile(r"(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY$|^KEY$|API_KEY|AUTH)", re.I)
TAIL_LINES = 60
NEVER_DEPLOYS = ("This run never commits, pushes, pins an image, edits Compose or starts a rollout. "
                 "Moving the fleet onto a new upstream is a separate, reviewed step.")


class SeriesError(ValueError):
    pass


def load_series(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SeriesError(f"cannot read {path}: {exc.strerror or exc}") from exc
    except json.JSONDecodeError as exc:
        raise SeriesError(f"{path} is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise SeriesError(f"{path}: schema must be {SCHEMA}")
    upstream = data.get("upstream")
    if not isinstance(upstream, dict):
        raise SeriesError("upstream must be an object with repository and ref")
    repository = upstream.get("repository")
    if not isinstance(repository, str) or not re.fullmatch(r"(https://[^\s]+|file:///[^\s]+)", repository):
        raise SeriesError("upstream.repository must be an https:// (or file:///) git URL")
    ref = upstream.get("ref", "main")
    if not isinstance(ref, str) or not REF_RE.fullmatch(ref) or ".." in ref:
        raise SeriesError("upstream.ref must be a plain branch name")
    base = path.resolve().parent
    patches = data.get("patches")
    if not isinstance(patches, list):
        raise SeriesError("patches must be a list (an empty list is fine)")
    seen: set[str] = set()
    clean = []
    for index, entry in enumerate(patches):
        if not isinstance(entry, dict):
            raise SeriesError(f"patches[{index}] must be an object")
        patch_id = entry.get("id")
        if not isinstance(patch_id, str) or not ID_RE.fullmatch(patch_id) or patch_id in seen:
            raise SeriesError(f"patches[{index}].id must be a unique lower-case id")
        seen.add(patch_id)
        rel = entry.get("file")
        if not isinstance(rel, str) or rel.startswith("/") or ".." in rel.split("/"):
            raise SeriesError(f"{patch_id}: file must be a relative path inside the series directory")
        file = (base / rel).resolve()
        if base not in file.parents or not file.is_file():
            raise SeriesError(f"{patch_id}: patch file {rel} does not exist inside the series directory")
        clean.append({**entry, "file": file})
    tests = data.get("tests", {})
    if not isinstance(tests, dict):
        raise SeriesError("tests must be an object")
    command = tests.get("command", [])
    if not isinstance(command, list) or not all(isinstance(a, str) and a for a in command):
        raise SeriesError("tests.command must be a list of arguments (no shell)")
    when = tests.get("when", "patched")
    if when not in ("patched", "always"):
        raise SeriesError("tests.when must be patched or always")
    timeout = tests.get("timeout_seconds", 1800)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 < timeout <= 6 * 3600:
        raise SeriesError("tests.timeout_seconds must be a positive integer up to 21600")
    return {"repository": repository, "ref": ref, "patches": clean,
            "tests": {"command": command, "when": when, "timeout": timeout}}


def git(repo: Path | None, *args: str, input_text: str | None = None,
        timeout: int = 600) -> subprocess.CompletedProcess[str]:
    cmd = ["git", *(["-C", str(repo)] if repo else []), *args]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(cmd, text=True, capture_output=True, input=input_text, timeout=timeout, env=env, check=False)


def resolve(repository: str, ref: str) -> str:
    listed = git(None, "ls-remote", "--heads", repository, f"refs/heads/{ref}", timeout=120)
    lines = [line.split("\t") for line in listed.stdout.splitlines() if line.strip()]
    commits = [parts[0] for parts in lines if len(parts) == 2 and parts[1] == f"refs/heads/{ref}"]
    if listed.returncode != 0 or len(commits) != 1 or not SHA_RE.fullmatch(commits[0]):
        raise SeriesError(f"could not resolve {ref} in the upstream repository")
    return commits[0]


def fetch(work: Path, repository: str, commit: str, depth: int) -> None:
    for args in (("init", "-q"), ("config", "advice.detachedHead", "false")):
        if git(work, *args).returncode != 0:
            raise RuntimeError("cannot initialise the work repository")
    fetch_args = ["fetch", "-q", "--no-tags"] + ([f"--depth={depth}"] if depth else []) + [repository, commit]
    fetched = git(work, *fetch_args, timeout=1200)
    if fetched.returncode != 0:
        raise RuntimeError(f"cannot fetch upstream commit {commit}: {_short(fetched.stderr)}")
    if git(work, "checkout", "-q", "--detach", commit).returncode != 0:
        raise RuntimeError(f"cannot check out {commit}")
    head = git(work, "rev-parse", "HEAD").stdout.strip()
    if head != commit:
        raise RuntimeError("work tree is not at the resolved upstream commit")


def _short(text: str, lines: int = 12) -> str:
    kept = [line.rstrip() for line in (text or "").splitlines() if line.strip()]
    return "\n".join(kept[:lines])


def apply_patch(work: Path, patch: Path) -> tuple[str, str]:
    """Return (result, detail). result: applied | applied_3way | already_upstream | failed."""
    text = patch.read_text(encoding="utf-8")
    if git(work, "apply", "--check", input_text=text).returncode == 0:
        done = git(work, "apply", "--index", "--whitespace=nowarn", input_text=text)
        return ("applied", "") if done.returncode == 0 else ("failed", _short(done.stderr))
    if git(work, "apply", "--check", "--reverse", input_text=text).returncode == 0:
        return "already_upstream", "upstream already contains this change"
    merged = git(work, "apply", "--3way", "--index", "--whitespace=nowarn", input_text=text)
    if merged.returncode == 0:
        return "applied_3way", _short(merged.stderr)
    return "failed", _short(merged.stderr or merged.stdout)


def scrubbed_env() -> dict[str, str]:
    """The test command's environment, without anything that looks like a credential."""
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV_RE.search(k)}
    for key in [k for k in env if k.startswith(("ACTIONS_", "GITHUB_TOKEN", "GH_"))]:
        env.pop(key)
    return env


def run_tests(work: Path, tests: dict[str, Any]) -> dict[str, Any]:
    try:
        done = subprocess.run(tests["command"], cwd=work, text=True, capture_output=True,
                              timeout=tests["timeout"], env=scrubbed_env(), check=False)
    except FileNotFoundError:
        return {"ran": True, "status": "failed", "exit_code": None, "output_tail": ["test command not found"]}
    except subprocess.TimeoutExpired as exc:
        def as_text(value: Any) -> str:
            return value.decode("utf-8", "replace") if isinstance(value, bytes) else (value or "")
        out = as_text(exc.stdout) + as_text(exc.stderr)
        return {"ran": True, "status": "timeout", "exit_code": None,
                "output_tail": out.splitlines()[-TAIL_LINES:]}
    output = (done.stdout or "") + (done.stderr or "")
    return {"ran": True, "status": "passed" if done.returncode == 0 else "failed",
            "exit_code": done.returncode, "output_tail": output.splitlines()[-TAIL_LINES:]}


def run(series: dict[str, Any], *, commit: str | None = None, ref: str | None = None,
        workdir: Path | None = None, depth: int = 1, skip_tests: bool = False) -> dict[str, Any]:
    ref = ref or series["ref"]
    if not REF_RE.fullmatch(ref) or ".." in ref:
        raise SeriesError("upstream ref must be a plain branch name")
    if commit is None:
        commit = resolve(series["repository"], ref)
    elif not SHA_RE.fullmatch(commit):
        raise SeriesError("--upstream-commit must be a full 40-character commit")
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "upstream": {"repository": series["repository"], "ref": ref, "commit": commit},
        "patches": [], "applied": [], "already_upstream": [], "failed": [], "not_attempted": [],
        "tests": {"ran": False, "status": "skipped", "command": series["tests"]["command"]},
        "deploys": False, "note": NEVER_DEPLOYS,
    }
    with tempfile.TemporaryDirectory(prefix="switchroom-upstream-") as scratch:
        work = Path(workdir) if workdir else Path(scratch) / "upstream"
        work.mkdir(parents=True, exist_ok=True)
        if any(work.iterdir()):
            raise SeriesError("--workdir must be empty")
        fetch(work, series["repository"], commit, depth)
        stopped = False
        for entry in series["patches"]:
            if stopped:
                report["not_attempted"].append(entry["id"])
                report["patches"].append({"id": entry["id"], "result": "not_attempted"})
                continue
            result, detail = apply_patch(work, entry["file"])
            report["patches"].append({"id": entry["id"], "result": result, **({"detail": detail} if detail else {})})
            if result.startswith("applied"):
                report["applied"].append(entry["id"])
            elif result == "already_upstream":
                report["already_upstream"].append(entry["id"])
            else:
                report["failed"].append(entry["id"])
                stopped = True  # later patches may depend on this one; the tree is no longer meaningful
        tests = series["tests"]
        if report["failed"]:
            report["tests"]["reason"] = "a patch failed to apply"
        elif skip_tests:
            report["tests"]["reason"] = "--no-tests"
        elif not tests["command"]:
            report["tests"]["reason"] = "the series names no test command"
        elif not report["applied"] and tests["when"] != "always":
            report["tests"]["reason"] = "nothing to re-apply" if not series["patches"] else "no patch is still needed"
        else:
            report["tests"].update(run_tests(work, tests))
    report["status"] = "fail" if report["failed"] or report["tests"]["status"] in ("failed", "timeout") else "pass"
    return report


def markdown(report: dict[str, Any]) -> str:
    def items(values: list[str]) -> str:
        return ", ".join(f"`{v}`" for v in values) if values else "none"

    up = report["upstream"]
    tests = report["tests"]
    lines = [
        "## Upstream patch test",
        "",
        f"**Result: {report['status']}** against `{up['ref']}` at `{up['commit']}`.",
        "",
        f"- Applied: {items(report['applied'])}",
        f"- Already upstream (retire candidates): {items(report['already_upstream'])}",
        f"- Failed: {items(report['failed'])}",
        f"- Not attempted: {items(report['not_attempted'])}",
        f"- Tests: {tests['status']}" + (f" ({tests['reason']})" if tests.get("reason") else ""),
        "",
        report["note"],
    ]
    if not any(report[k] for k in ("applied", "already_upstream", "failed", "not_attempted")):
        lines[4:4] = ["The series has no patches, so there is nothing to re-apply.", ""]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--series", type=Path, required=True)
    parser.add_argument("--upstream-ref", help="override upstream.ref from the series")
    parser.add_argument("--upstream-commit", help="test this exact commit instead of resolving the ref")
    parser.add_argument("--workdir", type=Path, help="empty directory for the upstream tree (default: a temp dir)")
    parser.add_argument("--fetch-depth", type=int, default=1, help="0 fetches full history (better 3-way merges)")
    parser.add_argument("--no-tests", action="store_true")
    parser.add_argument("--report", type=Path, help="write the JSON report here")
    parser.add_argument("--summary", type=Path, help="append the Markdown summary here (default: $GITHUB_STEP_SUMMARY)")
    args = parser.parse_args(argv)
    try:
        if args.fetch_depth < 0:
            raise SeriesError("--fetch-depth must be 0 or positive")
        series = load_series(args.series)
        report = run(series, commit=args.upstream_commit, ref=args.upstream_ref, workdir=args.workdir,
                     depth=args.fetch_depth, skip_tests=args.no_tests)
    except SeriesError as exc:
        print(json.dumps({"result": "error", "reason": str(exc)}))
        return 2
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"result": "error", "reason": str(exc)[:400]}))
        return 1
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text + "\n", encoding="utf-8")
    summary = args.summary or (Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None)
    if summary:
        with summary.open("a", encoding="utf-8") as handle:
            handle.write(markdown(report))
    print(text)
    print(markdown(report), file=sys.stderr)
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
