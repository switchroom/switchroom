"""Blocks that wait on the world, not on a person (HF-788).

A worker that must wait for other Linear issues, or for a plugin change to reach
the running agents, calls ``kanban_block`` with ``kind: dependency``. Core can keep
that as a native dependency wait only when the card has an open native parent; with
none it re-kinds the block to ``needs_input`` (payload ``requested_kind:
dependency``, ``rekind_reason: no_open_parent``), because nothing native would ever
clear it. Reported as that ``needs_input``, Linear said "Waiting on you" about work
nobody could answer, and nothing rechecked the condition, so the card stayed blocked
after it cleared.

This module reads such a block: the Linear issues named in its reason and any
``Delivery gate:`` line, and decides when they are satisfied. The bridge reports it
as a dependency wait and resumes the card itself once the condition holds.

Delivery gate grammar (one line in the block reason)::

    Delivery gate: <plugin>/<file> contains <exact text>

The path is relative to the mounted plugins directory and must stay inside it.
Mounted file bytes are what the bundle runbook accepts as proof of delivery; the
bundle's ``origin_commit`` is not readable from inside an agent container.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

ISSUE_KEY = re.compile(r"(?<![A-Za-z0-9_/-])([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})(?![A-Za-z0-9_-])")
GATE_LINE = re.compile(r"(?im)^[ \t]*Delivery gate:[ \t]*(?P<path>[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)"
                       r"[ \t]+contains[ \t]+(?P<text>\S.*?)[ \t]*$")
PLUGINS_ROOT = Path(__file__).resolve().parents[1]
MAX_GATE_FILE = 4 * 1024 * 1024
EXTERNAL_WAIT_GAP = 300.0  # seconds between rechecks; well inside one bundle-sync interval


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
    text = GATE_LINE.sub(" ", reason)
    issues = list(dict.fromkeys(ISSUE_KEY.findall(text)))
    gates = [(path, needle) for path, needle in gates if needle]
    return {"issues": issues, "gates": gates} if issues or gates else None


def notice(wait: dict[str, list]) -> str:
    """What people read: who the work waits on, and that it continues by itself."""
    parts = []
    if wait["issues"]:
        names = ", ".join(wait["issues"])
        parts.append(f"Blocked on {names}")
    if wait["gates"]:
        parts.append("Waiting for a plugin change to be delivered to the running agents")
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
