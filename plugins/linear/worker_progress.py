"""Optional live steps from the existing owner of a delegated Kanban attempt.

No viewer is attached and no executor is created. Only Core's safe projection of
its current tool crosses this boundary; arguments and event replay are never read.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sqlite3

from . import origin
from .api import LinearError
from .transport import Unavailable

# How long a worker's own kanban_heartbeat note stays on the Agent Session before a generic
# tool step may replace it. Workers are asked for a note per sub-step (HF-775).
NOTE_HOLD_SECONDS = 600


async def _read(home, adapter, task, session_id):
    from .native_store import reader, local_receipt, local_identity
    from gateway.session_policy import restore_policy
    from .origin_state import stop_evidence
    with reader(home) as db:
        saved = local_receipt(db, session_id)
        policy = restore_policy(saved["policy"])
    frozen = json.loads(policy.kanban_json or "null")
    request = "kanban:" + json.dumps([adapter.board, task.id, task.current_run_id], separators=(",", ":"))
    if (policy.source != "kanban" or not isinstance(frozen, dict)
            or saved["profile_id"] != str(home) or saved["request_id"] != request
            or session_id != local_identity(str(home), saved["principal_id"], request)
            or any(frozen.get(k) != v for k, v in {
                "board": adapter.board, "task_id": task.id, "run_id": task.current_run_id,
                "claim_lock": task.claim_lock, "profile": task.assignee}.items())):
        return None
    async with origin._client(home) as (client, endpoint):
        before, current = await origin._snapshot(client, home, session_id)
        if (endpoint.authority_epoch != current["authority_epoch"] or current["input_id"] != request
                or current["admission_header"]["request_id"] != request
                or current["admission_header"]["principal_id"] != saved["principal_id"]
                or current["admission_header"]["target_session_id"] != before["session_id"]):
            return None
        await asyncio.to_thread(stop_evidence, home, session_id)
        info = await client.rpc("session.info", session_id=session_id, execution_only=True)
        progress = info.get("execution_progress") or {}
        if (progress.get("execution_generation") != before["execution_generation"]
                or not isinstance(progress.get("tool"), str) or not progress["tool"]):
            return None  # Older Core, a completed call, Stop or a pending question.
        after, latest = await origin._snapshot(client, home, session_id)
        await asyncio.to_thread(stop_evidence, home, session_id)
        if after != before or latest != current:
            return None
        from agent.display import build_status_phrase
        from .native_input import step_phrase
        phrase = step_phrase(build_status_phrase(progress["tool"], None))
        return {"worker_session_id": session_id, "execution_generation": before["execution_generation"],
                "admission_id": current["admission_id"], "run_id": task.current_run_id, "phrase": phrase}


def current(adapter, task):
    home = getattr(adapter, "profile_home", None)
    if home is None or task.status != "running" or task.current_run_id is None:
        return None
    admitted = next((e for e in reversed(adapter.history(task.id, 0))
                     if e.kind == "owner_admitted" and e.run_id == task.current_run_id), None)
    if admitted is None:
        return None
    evidence = admitted.payload or {}
    session_id = evidence.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return None
    try:
        request = "kanban:" + json.dumps([adapter.board, task.id, task.current_run_id], separators=(",", ":"))
        if (evidence.get("request_id") != request
                or Path(evidence.get("db", "")).resolve() != Path(home) / "state.db"):
            return None
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            run = asyncio.run
        else:
            from model_tools import _run_async as run
        return run(_read(Path(home), adapter, task, session_id))
    except (Unavailable, RuntimeError, OSError, ValueError, ImportError, KeyError, TypeError, sqlite3.DatabaseError):
        return None  # Optional status cannot hold ordinary work or reporting.


def queue(bridge, row, adapter):
    if not row or not row.get("owner_ref") or row.get("stop_requested_at"):
        return
    if not bridge.store.backoff_ready(f"_reconcile_status:{row['issue_id']}", bridge.clock()):
        return  # Optional status shares the reporting binding's persisted refusal pause.
    if not bridge.store.effect_admitted(row["issue_id"]):
        return  # A held native closeout must not spend optional provider reads.
    task = adapter.get(row.get("task_id"))
    if task is None or task.status != "running" or task.current_run_id is None:
        return
    claim = (task.id, task.current_run_id, getattr(task, "claim_lock", None))
    now = bridge.clock()
    last = bridge.store.latest_session_action(row["issue_id"], row["owner_ref"])
    if last and now - last["enqueued_at"] < 60:
        return
    if last and last.get("heartbeat_note") and now - last["enqueued_at"] < NOTE_HOLD_SECONDS:
        return  # A generic tool step must not replace the worker's own fresher note.
    if bridge.store.unsettled_worker_action(row['issue_id'], row['owner_ref']):
        return  # Keep one uncertain optional status; questions and real closeout retain their own paths.
    with bridge.api.optional_work():
        step = current(adapter, task)
        if not step:
            return  # No actual admitted tool means no Linear scope read is needed.
        if (last and last["_presentation_current"] and now - last["enqueued_at"] < 600
                and last.get("worker_step") == step):
            return
        verified = bridge._native_effect_task(row["issue_id"])
        if (verified.status != "running" or
                (verified.id, verified.current_run_id, getattr(verified, "claim_lock", None)) != claim):
            return
        kind, payload = bridge._progress_activity(row, bridge._alert_route(row), "Working", step["phrase"], ephemeral=True)
        payload.update(worker_step=step, step_expires_at=now + 60)
        bridge.store.enqueue(kind, payload, at=now)


def current_payload(bridge, payload):
    """Revalidate the exact producing attempt and tool immediately before transport."""
    if bridge.clock() >= payload.get("step_expires_at", 0):
        return False
    row = bridge.store.get(payload["issue_id"])
    if (not row or row.get("origin") != "native" or row.get("owner_ref") != payload.get("session_id")
            or row.get("task_id") != payload.get("task_id") or row.get("stop_requested_at")):
        return False
    adapter = bridge._binding_adapter(row["issue_id"])
    task = bridge._native_effect_task(row["issue_id"])
    return current(adapter, task) == payload["worker_step"]


def current_question(bridge, payload):
    """Return only a genuine, current prompt under the existing exact actor/run guard."""
    for question in bridge.store.conversation_question_candidates(payload["issue_id"], payload["session_id"]):
        try:
            with bridge._question_publication_guard(question):
                if not bridge._conversation_interim_finished(question):
                    return question
        except LinearError as exc:
            if exc.retryable:
                raise
    return None


def reconcile_after_send(bridge, row):
    """Restore a current question; the native projector alone owns readable closeout."""
    payload = row["payload"]
    question = current_question(bridge, payload)
    if question is not None:
        if not bridge._same_lifecycle_presentation(payload, question):
            bridge._queue_conversation_lifecycle_repair(row, question)
        return
    if payload.get("worker_step_repair") or not current_payload(bridge, payload):
        bridge._mark_dirty(payload["issue_id"])


def reconcile_uncertain(bridge, row):
    """Read the frozen activity receipt; an uncertain optional write is never sent again."""
    payload = row['payload']
    actual = bridge.api.outbound_activity(row['id'], payload['session_id'], payload['issue_id'])
    if actual is None:
        raise LinearError('Worker activity outcome is uncertain; waiting for authoritative readback')
    if actual != payload['content']:
        raise LinearError('Worker activity receipt differs from its frozen content', retryable=False)
    reconcile_after_send(bridge, row)
    return True
