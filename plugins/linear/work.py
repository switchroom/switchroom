"""Current native dispatcher work evidence; never human consent or a control grant."""
from __future__ import annotations

import asyncio
from contextlib import closing
import contextvars
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import time
from typing import Any

from . import origin
from .transport import Unavailable, native_json_object

FIELDS = origin.REFERENCE_FIELDS | {"kind", "work_digest"}


@dataclass(frozen=True)
class WorkContext:
    home: str
    profile: str
    session_id: str


def capture_context() -> WorkContext:
    """The worker binds its actual session ID even when no chat surface is bound."""
    from agent.runtime_session_store import is_worker_process
    from agent.delegation_context import is_dispatcher_owned_worker_context
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_active_profile_name
    from .transport import _native_profile
    if not is_worker_process() or not is_dispatcher_owned_worker_context():
        _refuse()
    bound = {var.name: value for var, value in contextvars.copy_context().items()}
    sid = bound.get("HERMES_SESSION_ID")
    if not isinstance(sid, str) or not sid or len(sid) > 4096:
        _refuse()
    home = Path(get_hermes_home()).resolve(strict=True)
    return WorkContext(str(home), _native_profile(get_active_profile_name(), home), sid)


def _refuse():
    raise Unavailable("The exact current native dispatcher work cannot be independently verified.")


def reference(value: Any) -> dict:
    if (not isinstance(value, dict) or set(value) != FIELDS or value.get("kind") != "native_work"
            or not isinstance(value.get("work_digest"), str) or len(value["work_digest"]) != 64):
        _refuse()
    origin.reference({k: v for k, v in value.items() if k in origin.REFERENCE_FIELDS})
    return dict(value)


def _projection(home: Path, profile: str, current: dict, declared: dict,
                context: WorkContext | None) -> tuple[dict, str]:
    """Coordinates come ONLY from the owner's saved policy. No file snapshots or raw DB reads."""
    from . import native_store
    from .native_store import local_receipt, local_identity
    from .origin_state import current_admission
    from gateway.session_policy import restore_policy
    from hermes_cli.sqlite_safe_read import connect_tracked
    from hermes_cli.profiles import resolve_profile_env
    sid = current["session_id"]
    with native_store.reader(home) as db:
        saved = local_receipt(db, sid)
        policy = restore_policy(saved["policy"])
        if policy.source != "kanban" or not policy.kanban_json or saved["profile_id"] != str(home):
            _refuse()
        frozen = native_json_object(policy.kanban_json)
        requested = native_json_object(policy.request_json)
        row = native_store.get_admission(db, current["admission_id"])
        header = current_admission(row)
        if header != current["admission_header"]:
            _refuse()
        if (row["target_session_id"] != sid or row["owner_epoch"] != current["authority_epoch"]
                or row["generation"] != current["execution_generation"]
                or row["principal_id"] != saved["principal_id"]):
            _refuse()
        board, tid, run, lock = (frozen[k] for k in ("board", "task_id", "run_id", "claim_lock"))
        if (any(not isinstance(v, str) or not v for v in (board, tid, lock)) or type(run) is not int
                or frozen["profile"] != profile or Path(resolve_profile_env(profile)).resolve() != home
                or policy.cwd != frozen["workspace"]):
            _refuse()
        request = "kanban:" + json.dumps([board, tid, run], separators=(",", ":"))
        card = {"board": board, "task_id": tid, "run_id": run}
        if (saved["request_id"] != request or row["request_id"] != request
                or sid != local_identity(str(home), saved["principal_id"], request)
                or row["payload"].get("kanban_card_v1") != card
                or row["payload"].get("text") != "work kanban task " + tid
                or any(key in row["payload"] for key in ("native_text_v1", "api_turn_v1", "cli_turn_v1", "cron_v1", "local_automation_v1"))
                or any(requested.get(k) != v for k, v in {"source": "kanban", **card}.items())):
            _refuse()
    # This connection participates in native lock tracking. URI mode=ro + query_only + explicit
    # read transaction preserve SQLite locking and ensure every joined record is one snapshot.
    path = Path(frozen["db"]).resolve(strict=True)
    with closing(connect_tracked(path.as_uri() + "?mode=ro", uri=True, isolation_level=None)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        task = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        attempt = conn.execute("SELECT * FROM task_runs WHERE id=? AND task_id=?", (run, tid)).fetchone()
        if (task is None or attempt is None or task["status"] != "running" or attempt["status"] != "running"
                or task["current_run_id"] != run or task["claim_lock"] != lock or attempt["claim_lock"] != lock
                or any(type(r["claim_expires"]) is not int or r["claim_expires"] <= time.time() for r in (task, attempt))
                or task["assignee"] != profile or attempt["profile"] != profile):
            _refuse()
        for column, key in (("workspace_path", "workspace"), ("branch_name", "branch"), ("tenant", "tenant")):
            if task[column] != frozen[key]:
                _refuse()
        instruction = "\n\n".join(p for p in (task["title"], task["body"]) if p)
        if (instruction != frozen["goal_text"] or not instruction or len(instruction) > 16384
                or bool(task["goal_mode"]) != frozen["goal_mode"]
                or task["goal_max_turns"] != frozen["goal_max_turns"]
                or task["max_runtime_seconds"] != frozen["max_runtime_seconds"]):
            _refuse()
        def event(kind):
            found = conn.execute("SELECT payload FROM task_events WHERE task_id=? AND run_id=? AND kind=? ORDER BY id DESC LIMIT 1",
                                 (tid, run, kind)).fetchone()
            return (native_json_object(found[0], allow_null=True) or {}) if found else {}
        skills = json.loads(task["skills"] or "[]")
        if event("claimed").get("source_status") == "review":
            skills = list(dict.fromkeys([*skills, "sdlc-review"]))
        if frozen["skills"] != skills:
            _refuse()
        admitted, bound = event("owner_admitted"), event("worker_bound")
        if (admitted.get("session_id") != sid or admitted.get("request_id") != request
                or Path(admitted.get("db", "")).resolve() != home / "state.db"
                or bound.get("claim_lock") != lock or type(bound.get("pid")) is not int or bound["pid"] <= 0
                or context is not None and bound["pid"] != os.getpid()):
            _refuse()
        from .origin_state import stop_evidence
        result = {"requester": {"kind": "native_dispatcher", "original_requester": "unknown"},
                  "work": {"board": board, "task_id": tid, "run_id": run, "instruction": instruction},
                  "scope": {"declared": declared, "profile": profile, "workspace": frozen["workspace"],
                            "branch": frozen["branch"], "tenant": frozen["tenant"], "skills": frozen["skills"]},
                  "stop_evidence": stop_evidence(home, sid), "permission_granted": False}
        # Claim tokens, DB paths, unrelated worker context and private history never leave this function.
        digest = origin._digest({"policy": frozen, "principal": saved["principal_id"], "admission_header": header,
                                 "task_scope": {key: task[key] for key in ("workspace_kind", "project_id", "completion_contract",
                                      "skills", "model_override", "provider_override", "reasoning_effort")},
                                 "admitted": admitted, "bound": bound, "projection": result})
        return result, digest


async def _inspect(home, profile, declared, ref=None, context=None):
    async with origin._client(home) as (client, endpoint):
        from .origin_state import resolve_reference
        sid = context.session_id if context else await asyncio.to_thread(resolve_reference, home, ref)
        snapshot, active = await origin._snapshot(client, home, sid)
        active = {**active, "session_id": snapshot["session_id"]}
        evidence, digest = await asyncio.to_thread(_projection, home, profile, active, declared, context)
        observed = reference({"version": origin.VERSION, "kind": "native_work", "profile": profile,
            "admission_id": active["admission_id"],
            "instance_id": endpoint.instance_id, "authority_epoch": endpoint.authority_epoch,
            "execution_generation": snapshot["execution_generation"], "scope_digest": origin._digest(declared),
            "work_digest": digest})
        if endpoint.authority_epoch != active["authority_epoch"] or ref is not None and ref != observed:
            _refuse()
        after, current = await origin._snapshot(client, home, snapshot["session_id"])
        repeated, after_digest = await asyncio.to_thread(_projection, home, profile,
            {**current, "session_id": after["session_id"]}, declared, context)
        if after != snapshot or current != {k: v for k, v in active.items() if k != "session_id"} or after_digest != digest:
            _refuse()
        return {"reference": observed, **repeated}


def _run(home, profile, declared, ref=None, context=None):
    try:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            run = asyncio.run
        else:
            from model_tools import _run_async as run
        return run(_inspect(home, profile, declared, ref, context))
    except Unavailable:
        raise
    except (RuntimeError, OSError, ValueError, ImportError, KeyError, IndexError, TypeError, sqlite3.DatabaseError) as exc:
        raise Unavailable("Current native work evidence is unavailable; no permission was granted.") from exc


def current(context: WorkContext, settings: dict) -> dict:
    result = _run(Path(context.home), context.profile, origin.scope(settings), context=context)
    return {"reference": result["reference"], "requester": result["requester"], "permission_granted": False}


def inspect(value: Any, settings: dict) -> dict:
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_active_profile_name
    ref = reference(value)
    if ref["profile"] != get_active_profile_name():
        _refuse()
    return _run(Path(get_hermes_home()).resolve(strict=True), ref["profile"], origin.scope(settings), ref=ref)
