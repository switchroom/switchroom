"""Blocks that wait on the world, not on a person (HF-788, HF-800).

A worker that must wait for other Linear issues, for a plugin change to reach the
running agents, or for CI on a commit it pushed, calls ``kanban_block`` with
``kind: dependency``. Core can keep that as a native dependency wait only when the
card has an open native parent; with none it re-kinds the block to ``needs_input``
(payload ``requested_kind: dependency``, ``rekind_reason: no_open_parent``), because
nothing native would ever clear it. Reported as that ``needs_input``, Linear said
"Waiting on you" about work nobody could answer, and nothing rechecked the condition,
so the card stayed blocked after it cleared.

This module reads such a block: the Linear issues named in its reason, any
``Delivery gate:`` line and any ``CI gate:`` line, and decides when they are
satisfied. The bridge reports it as a dependency wait and resumes the card itself
once the condition holds.

Delivery gate grammar (one line in the block reason)::

    Delivery gate: <plugin>/<file> contains <exact text>

The path is relative to the mounted plugins directory and must stay inside it.
Mounted file bytes are what the bundle runbook accepts as proof of delivery; the
bundle's ``origin_commit`` is not readable from inside an agent container.

CI gate grammar (one line per target in the block reason)::

    CI gate: https://github.com/<owner>/<repo>/pull/<n> [within <n>m|<n>h]
    CI gate: <owner>/<repo>@<40-hex sha> [within <n>m|<n>h]

A parked worker holds no slot and makes no model call. The bridge reads GitHub's REST
API (``gh api repos/...``, so the host's per-owner token routing applies), waits until
every GitHub Actions run and commit status on the exact head has finished, or until
the window (default 3 h, at most 24 h) has passed since the park, then writes the
verdict as a task comment and resumes the same task once. The verdict covers every
run on that head, a superset of the required checks; merging still binds the
required checks to the reviewed head.

Where Core has the ``kanban_wait_claim`` hook (HF-850) the plugin claims each such wait
before Core writes it (``claim_wait``): Core marks it ``source: external_wait``, a board
hold, so nobody is pinged or woken and the block-loop breaker does not count it. A wait
naming nothing checkable, a CI park past ``CI_MAX_PARKS``, a task of another profile and
any wait under a specialist scope are not claimed and alert as before.
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

ISSUE_KEY = re.compile(r"(?<![A-Za-z0-9_/-])([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})(?![A-Za-z0-9_-])")
GATE_LINE = re.compile(r"(?im)^[ \t]*Delivery gate:[ \t]*(?P<path>[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)"
                       r"[ \t]+contains[ \t]+(?P<text>\S.*?)[ \t]*$")
CI_LINE = re.compile(r"(?im)^[ \t]*CI gate:[ \t]*(?P<target>\S+?)[.,;]?(?:[ \t]+within[ \t]+(?P<n>[1-9][0-9]{0,3})"
                     r"[ \t]*(?P<unit>m|min|mins|minutes?|h|hr|hrs|hours?))?[ \t]*\.?[ \t]*$")
_CI_PR = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]{0,9})/?")
_CI_COMMIT = re.compile(r"(?:https://github\.com/)?([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:@|/commit/)([0-9a-f]{40})")
_SHA = re.compile(r"[0-9a-f]{40}")
PLUGINS_ROOT = Path(__file__).resolve().parents[1]
MAX_GATE_FILE = 4 * 1024 * 1024
EXTERNAL_WAIT_GAP = 300.0  # seconds between rechecks; well inside one bundle-sync interval
CI_WAIT_GAP = 120.0  # seconds between GitHub reads for a CI wait: three REST reads per target per gap
CI_DEFAULT_WINDOW, CI_MAX_WINDOW = 3 * 3600, 24 * 3600
CI_MAX_PARKS = 20  # CI parks one task may resume by itself; past that a person resumes it
# Conclusions that do not fail CI. Anything else (failure, cancelled, timed_out, action_required,
# startup_failure, stale, an unknown value) is a failed verdict the worker must look at.
CI_PASSING = frozenset({"success", "skipped", "neutral"})
WAIT_CLAIM_HOOK = "kanban_wait_claim"


def parse(payload: dict[str, Any]) -> dict[str, list] | None:
    """The condition a re-kinded worker dependency block waits on, or None.

    None for every other block (a question, a Stop, a handover pause, a runtime fault),
    and for a dependency block naming nothing the bridge can check, which still needs a
    person to resume it.
    """
    if payload.get("requested_kind") != "dependency" or payload.get("rekind_reason") != "no_open_parent":
        return None
    reason = str(payload.get("reason") or "")
    gates = [(m["path"], m["text"].strip("`\"' ")) for m in GATE_LINE.finditer(reason)]
    ci = [gate for gate in (_ci_gate(m) for m in CI_LINE.finditer(reason)) if gate]
    text = CI_LINE.sub(" ", GATE_LINE.sub(" ", reason))
    issues = list(dict.fromkeys(ISSUE_KEY.findall(text)))
    gates = [(path, needle) for path, needle in gates if needle]
    return {"issues": issues, "gates": gates, "ci": ci} if issues or gates or ci else None


def resumable(reason: str, earlier: list[dict[str, Any]]) -> bool:
    """Whether the bridge resumes a parentless dependency wait with this ``reason`` by itself (HF-850).

    Core asks (``kanban_wait_claim``) before it writes the block; a claimed wait is quiet board
    state: no "needs attention" ping, no wake, no block-loop count. ``earlier`` are the payloads of
    the task's earlier ``blocked`` / ``block_loop_detected`` events. A wait naming nothing the bridge
    checks, or a CI park past ``CI_MAX_PARKS`` (the bridge leaves that one for a person), is not
    claimed and alerts as before.
    """
    wait = parse({"requested_kind": "dependency", "rekind_reason": "no_open_parent", "reason": reason})
    if wait is None:
        return False
    return not wait["ci"] or 1 + sum(1 for payload in earlier if (parse(payload) or {}).get("ci")) <= CI_MAX_PARKS


def register_wait_claim(ctx: Any) -> None:
    """Answer Core's ``kanban_wait_claim`` when Core has it; an older Core reports every wait as before.

    Not under a specialist scope: there the bridge may decline to read other issues or to resume.
    """
    try:
        from hermes_cli.plugins import VALID_HOOKS
    except ImportError:
        return
    if WAIT_CLAIM_HOOK in VALID_HOOKS and not ctx.get_config("specialist_scope"):
        ctx.register_hook(WAIT_CLAIM_HOOK, claim_wait)


def claim_wait(*, task_id: str, board: str, reason: str, profile_name: str, **_: Any) -> dict[str, bool] | None:
    """``{"resumes": True}`` for a wait on this profile's own task the bridge resumes (``resumable``).

    Called in the worker before Core writes the block; one read-only look at the task's earlier blocks.
    """
    from hermes_cli import kanban_db

    path = Path(kanban_db.kanban_db_path(board=board))
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        task = conn.execute("SELECT assignee FROM tasks WHERE id = ?", (task_id,)).fetchone()
        rows = conn.execute("SELECT payload FROM task_events WHERE task_id = ? AND kind IN "
                            "('blocked', 'block_loop_detected')", (task_id,)).fetchall()
    if task is None or task[0] != profile_name or not isinstance(reason, str):
        return None
    earlier = [payload for payload in (json.loads(row[0]) if row[0] else None for row in rows) if isinstance(payload, dict)]
    return {"resumes": True} if resumable(reason, earlier) else None


def _ci_gate(match: re.Match) -> dict[str, Any] | None:
    target = match["target"].strip("`\"'<>")
    window = CI_DEFAULT_WINDOW
    if match["n"]:
        window = min(CI_MAX_WINDOW, int(match["n"]) * (3600 if match["unit"].startswith("h") else 60))
    pr, commit = _CI_PR.fullmatch(target), _CI_COMMIT.fullmatch(target)
    if pr:
        return {"repo": pr[1], "pr": int(pr[2]), "sha": None, "window": window}
    if commit:
        return {"repo": commit[1], "pr": None, "sha": commit[2], "window": window}
    return None


def ci_label(gate: dict[str, Any]) -> str:
    """The target as people read it, without a commit hash."""
    return f"{gate['repo']} PR #{gate['pr']}" if gate["pr"] else f"a commit on {gate['repo']}"


def notice(wait: dict[str, list]) -> str:
    """What people read: who the work waits on, and that it continues by itself."""
    parts = []
    if wait["issues"]:
        names = ", ".join(wait["issues"])
        parts.append(f"Blocked on {names}")
    if wait["gates"]:
        parts.append("Waiting for a plugin change to be delivered to the running agents")
    if wait["ci"]:
        parts.append("Waiting for CI on " + ", ".join(ci_label(gate) for gate in wait["ci"]))
    return ("**Waiting for a dependency**\n\n" + ". ".join(parts) + ".\n\n"
            "**Next:** work continues on its own once that is done.")


def gate_met(root: Path, path: str, needle: str) -> bool:
    """Does the mounted file contain the text? Unreadable, missing or outside ``root`` is no."""
    try:
        base = root.resolve()
        target = (base / path).resolve()
        if base not in target.parents or not target.is_file() or target.stat().st_size > MAX_GATE_FILE:
            return False
        return needle in target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def _pages(pages: Any, key: str) -> list:
    if not isinstance(pages, list) or not pages or not isinstance(pages[0], dict):
        raise ValueError(f"incomplete {key} pagination")
    rows = [row for page in pages for row in page[key]]
    if len({row["id"] for row in rows}) != pages[0].get("total_count"):
        raise ValueError(f"incomplete {key} pagination")
    return rows


def ci_state(gate: dict[str, Any], gh: Callable[..., Any]) -> dict[str, Any]:
    """GitHub's answer for one CI gate: ``state`` pending, passed or failed, the head, one line per result.

    Every GitHub Actions run on the exact head (its latest attempt, as GitHub lists it) and every
    commit status context count. No run and no status yet is pending: CI has not started. A PR
    closed without merging is failed. A failed read raises the ``gh`` callable's own error.
    """
    repo, sha = gate["repo"], gate["sha"]
    if gate["pr"]:
        pr = gh(f"repos/{repo}/pulls/{int(gate['pr'])}")
        sha = pr["head"]["sha"]
        if pr["state"] == "closed" and pr.get("merged") is not True:
            return {"state": "failed", "head": sha, "lines": ["the pull request was closed without being merged"]}
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise ValueError("GitHub returned no exact head commit")
    runs = [run for run in _pages(gh(f"repos/{repo}/actions/runs?head_sha={sha}&per_page=100", paginate=True),
                                  "workflow_runs") if run.get("head_sha") == sha]
    combined = gh(f"repos/{repo}/commits/{sha}/status")
    statuses = (combined.get("statuses") or []) if isinstance(combined, dict) else []
    if not runs and not statuses:
        return {"state": "pending", "head": sha, "lines": ["CI has not started on this commit"]}
    pending = failed = False
    lines = []
    for run in sorted(runs, key=lambda item: (str(item.get("name")), int(item["id"]))):
        name = str(run.get("name") or run.get("path") or "workflow")
        if run.get("status") != "completed":
            pending = True
            lines.append(f"{name}: {run.get('status') or 'queued'}")
            continue
        conclusion = str(run.get("conclusion") or "unknown")
        failed |= conclusion not in CI_PASSING
        lines.append(f"{name}: {conclusion}")
    for status in sorted(statuses, key=lambda item: str(item.get("context"))):
        state = str(status.get("state") or "pending")
        pending |= state == "pending"
        failed |= state in ("failure", "error")
        lines.append(f"{status.get('context') or 'status'}: {state}")
    return {"state": "pending" if pending else "failed" if failed else "passed", "head": sha, "lines": lines}


def ci_verdict(gates: list[dict[str, Any]], parked_at: float, now: float,
               check: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any] | None:
    """The verdict to resume with, or None while any gate is still running inside its window.

    ``check`` is ``ci_state`` bound to a GitHub reader that answers ``{"state": "unreadable"}``
    when GitHub refused or did not answer; that waits like pending and is reported at timeout.
    """
    results = []
    for gate in gates:
        result = check(gate)
        if result["state"] in ("pending", "unreadable") and now - parked_at < gate["window"]:
            return None
        results.append((gate, result))
    states = {result["state"] for _gate, result in results}
    overall = "timed out" if states & {"pending", "unreadable"} else "failed" if "failed" in states else "passed"
    return {"overall": overall, "results": results}


def verdict_comment(verdict: dict[str, Any]) -> str:
    """The native task comment the resumed worker reads: the verdict, per target, per run."""
    out = [f"CI verdict: {verdict['overall']}", ""]
    for gate, result in verdict["results"]:
        waited = result["state"] in ("pending", "unreadable")
        head = f" at {result['head']}" if result.get("head") else ""
        window = f" after {gate['window'] // 60} min" if waited else ""
        out.append(f"{ci_label(gate) if gate['pr'] else gate['repo']}{head}: {result['state']}{window}")
        out.extend(f"- {line}" for line in result.get("lines") or [])
    out += ["", "Checked by the Linear plugin while this task was parked on CI, without a model call. "
            "Merging still needs the required checks to pass on the reviewed head."]
    return "\n".join(out)
