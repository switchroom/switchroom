"""Owner side of an agent-to-agent takeover: stop, prove, hand over. Nothing resumes by itself.

``hermes linear hand-off`` runs inside the profile that owns the work (the old delegate),
started by the requester's ``take_over`` through the operator-configured owner command.
In one call, in code, it:

1. checks everything that can be checked before touching the work (the issue's reporting
   link, the one native task, its issue scope, guarded controls, the native Stop getter and
   any tasks it started) and refuses with nothing changed if any of them fails;
2. pauses the task with one guarded native Stop whose reason names the handover and carries
   the request id;
3. waits for the existing cleanup proof (``cleanup.inspect``) to show the stopped work has
   fully ended, and reports ``handed_off`` with the evidence.

Two agents never run the same work, so nothing here ever resumes the task by itself. When the
proof fails after the pause, the work stays paused (``state: paused``) and the reply says so
plainly; only a person resumes it, through ``--resume`` (the requester's ``resume_owner``), or
retries the takeover. A task already paused for a handover to the same agent is proven again,
never stopped twice, so retrying with the same request id (or a new one) is safe. A pause made
outside this flow (a person's Stop) is only proven, never changed, and a pause for a handover
to a different agent is never proven for this one. One hand-off or resume runs per issue at a
time (a file lock beside the state database). Nothing here grants permission; the requester's
chat request is the authority, exactly as for ``work_on``.

One proof hold is not waiting alone: a stopped Kanban attempt whose worker reported back after the
gateway gave up on it is left ``unknown`` by core, and nothing in that gateway's lifetime settles
it. When a handover pause for the same agent holds on exactly that row (a row still ``started``
is waited on), the owner asks core once to resolve it
(``prompt.resolve_unknown``, the same fenced call as a person's Discard, which first re-runs core's
process-stop cleanup), then proves again with the unchanged proof."""
from __future__ import annotations

import fcntl
import hashlib
import inspect as _inspect
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

from . import cleanup, diag
from .cleanup import Unknown

HANDOFF_REASON = "Paused for a handover to {to} [handoff:{request_id}]"
_NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}"
_NAME = re.compile(_NAME_PATTERN)
HANDOFF_PATTERN = re.compile(r"Paused for a handover to (?P<to>" + _NAME_PATTERN + r") "
                             r"\[handoff:(?P<request_id>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]")
DEFAULT_WAIT_SECONDS = 90.0
MAX_WAIT_SECONDS = 300.0  # What the owner CLI accepts; a takeover entry is capped lower, below.
POLL_SECONDS = 2.0
LOCK_POLL_SECONDS = 0.2
# Budgets. The owner waits at most HANDOFF_LOCK_SECONDS for the issue lock (a busy lock is a
# plain "try again"), so its reply comes within the proof wait plus OWNER_CALL_OVERHEAD_SECONDS.
# One take_over is this side's Linear reads before the owner is asked (a Linear deadline), one
# owner call (the subprocess timeout) and one start here (its own Linear deadline); the chat
# client always outlasts that sum.
HANDOFF_LOCK_SECONDS = 10.0
OWNER_CALL_OVERHEAD_SECONDS = 60.0
TAKEOVER_MAX_WAIT_SECONDS = 120.0
BEFORE_OWNER_BUDGET_SECONDS = 40.0
ENTRUST_BUDGET_SECONDS = 60.0
CLIENT_TIMEOUT_SECONDS = (BEFORE_OWNER_BUDGET_SECONDS + TAKEOVER_MAX_WAIT_SECONDS + OWNER_CALL_OVERHEAD_SECONDS
                          + ENTRUST_BUDGET_SECONDS + 20.0)
STOPPABLE = ("running", "ready")
PAUSED = ("blocked", "triage")
# Cleanup holds that clear by themselves while a stopped worker winds down. Every other hold
# is a fact about the work that waiting will not change, so the proof stops there.
TRANSIENT = frozenset({
    "run_not_settled", "old_worker_alive", "native_admission_not_settled", "native_worker_or_spawner_unsettled",
    "native_child_spawner_unsettled", "native_session_has_unsettled_work", "native_stop_checkpoint_pending",
    "native_executor_settlement_missing", "cleanup_evidence_changed", "cleanup_evidence_unavailable",
    "worker_identity_unreadable", "native_receipt_changed", "scoped_process_cleanup_unknown",
    "native_owner_changed",
})

# Plain sentences for the requester to pass on; never internal codes.
REFUSALS = {
    "not_bound_here": "{owner} has no tracked work linked to this issue, so there was nothing here to hand over.",
    "task_finished_here": "{owner}'s work on this issue has already finished, so there was nothing to hand over.",
    "task_not_handable": "{owner}'s work on this issue is waiting on something else (a dependency, a schedule or "
                         "a review), so it was left as it is.",
    "started_other_tasks": "{owner}'s work on this issue started other tasks that are still open, so it was left "
                           "running; those need to finish or be stopped first.",
    "controls_unsupported": "{owner}'s version can't stop work safely for a handover, so nothing was changed.",
    "changed_during_handoff": "{owner}'s work changed while the handover was being set up, so nothing was changed. "
                              "Try again.",
    "handover_in_progress": "{owner}'s work is already paused for a handover to another agent, so it was left as "
                            "it is.",
    "handoff_busy": "{owner} is already handling a handover step for this issue, so nothing more was changed. "
                    "Try again shortly.",
}


def handoff_reason(to: str, request_id: str) -> str:
    return HANDOFF_REASON.format(to=to, request_id=request_id)


def resume_request_id(request_id: str) -> str:
    return "linear:" + hashlib.sha256(f"handoff-resume:{request_id}".encode()).hexdigest()


def _unchanged(reason: str, message: str) -> dict:
    return {"handed_off": False, "state": "unchanged", "reason": reason, "message": message, "permission_granted": False}


def _refuse(reason: str, owner: str) -> dict:
    diag.evt("handoff.decision", "refused", reason)
    return _unchanged(reason, REFUSALS[reason].format(owner=owner))


def _paused(reason: str, owner: str, to: str, why: str) -> dict:
    """The work stays paused for this handover; nothing resumes it by itself."""
    diag.evt("handoff.decision", "held", reason)
    return {"handed_off": False, "state": "paused", "reason": reason, "permission_granted": False, "why": why,
            "message": f"{owner}'s work is paused for a handover to {to} that didn't complete: {why} "
                       f"Nothing was resumed automatically."}


# Plain facts for the holds people meet most often in a handover; cleanup.HOLD_FACTS has the rest.
HOLD_FACTS = {
    "proof_timeout": "its run did not finish winding down in time.",
    "native_task_issue_scope_conflict": "the task on that agent names a different issue.",
    "native_history_match_missing_or_ambiguous": "that agent has no single task for this issue.",
    "native_history_match_foreign_or_archived": "the task for this issue belongs to another agent or was archived.",
    "issue_scope_fenced": "earlier changes on this issue are held for a check.",
    "native_stop_checkpoint_unsupported": "that agent's version can't confirm a stop has finished.",
    "invalid_cleanup_selector": "the request did not name the issue completely.",
    "cleanup_evidence_unavailable": "its work couldn't be checked.",
}


def _fact(reason: str) -> str:
    fact = HOLD_FACTS.get(reason) or cleanup.HOLD_FACTS.get(reason) or "it couldn't be confirmed safe."
    return fact[0].lower() + fact[1:]


def _hold_message(reason: str) -> str:
    return "The handover couldn't be confirmed safe: " + _fact(reason)


def _stops(events: list) -> list:
    return [event for event in events if event.kind in ("blocked", "block_loop_detected")]


def _live_stop(events: list):
    """The latest Stop, when nothing resumed or finished the task after it."""
    stops = _stops(events)
    if not stops:
        return None
    later = [event for event in events if event.id > stops[-1].id and event.kind in ("unblocked", "completed", "archived")]
    return None if later else stops[-1]


def _handover_to(stop) -> str | None:
    """The agent a Stop paused the work for, when it is this flow's exact guarded handover pause."""
    payload = (stop.payload or {}) if stop is not None else {}
    made = HANDOFF_PATTERN.fullmatch(str(payload.get("reason") or "")) if payload.get("kind") == "needs_input" else None
    return made.group("to") if made else None


def _started_open(adapter, task_id: str) -> bool:
    """Does this task have started tasks that are still open? Their fate is not part of the proof."""
    with adapter.read_conn() as conn:
        children = []
        for row in conn.execute("SELECT task_id, payload FROM task_events WHERE kind='created'"):
            try:
                payload = json.loads(row["payload"] or "null")
            except (TypeError, ValueError):
                continue
            if isinstance(payload, dict) and payload.get("creator_task_id") == task_id:
                children.append(row["task_id"])
    return any((child := adapter.get(task_id_)) is not None and child.status not in ("done", "archived")
               for task_id_ in children)


def _block(adapter, task, reason: str, expected_event_id: int) -> bool:
    """One guarded native Stop. A pause for a handover is not a recurring blocker: it must not
    push the task into the recurrence fence, which cannot be resumed."""
    options = {}
    if "count_recurrence" in _inspect.signature(adapter.kb.block_task).parameters:
        options["count_recurrence"] = not (task.block_kind == "needs_input" and (task.block_recurrences or 0) >= 1)
    with adapter.conn() as conn:
        return adapter.kb.block_task(conn, task.id, reason=reason, kind="needs_input",
                                     expected_run_id=task.current_run_id if task.status == "running" else None,
                                     expected_event_id=expected_event_id, **options)


def _would_fence(adapter, task) -> bool:
    """Would the handover Stop push this task into the recurrence fence (TRIAGE), which cannot be
    resumed? Only on a native whose block cannot skip counting the recurrence."""
    if "count_recurrence" in _inspect.signature(adapter.kb.block_task).parameters:
        return False
    previous = (task.block_recurrences or 0) if task.block_kind == "needs_input" else 0
    return previous + 1 >= int(getattr(adapter.kb, "BLOCK_RECURRENCE_LIMIT", 1))


def _context(state: Path, issue: str, metadata: Any, request_id: Any, to: Any):
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_active_profile_name
    from agent.delegation_context import is_delegated_child_process_context
    from agent.runtime_session_store import is_worker_process
    if is_delegated_child_process_context() or is_worker_process():
        raise Unknown("owner_cli_required")
    try:
        valid_id = isinstance(request_id, str) and str(uuid.UUID(request_id)) == request_id
    except ValueError:
        valid_id = False
    if not (valid_id and isinstance(to, str) and _NAME.fullmatch(to) and isinstance(issue, str) and issue
            and isinstance(metadata, dict) and set(metadata) == {"id", "identifier", "url"}
            and all(isinstance(v, str) and 0 < len(v) <= 4096 for v in metadata.values())
            and issue in (metadata["id"], metadata["identifier"])):
        raise Unknown("invalid_cleanup_selector")
    home = Path(get_hermes_home()).resolve(strict=True)
    return home, get_active_profile_name()


def _adapter(home: Path, board: str, native_profile: str):
    from .bridge import Kanban
    return Kanban(board, profile=native_profile, profile_home=home)


def _handoff_dir(state: Path) -> Path:
    return Path(state).parent / "handoff"


def _digest(kind: str, value: str) -> str:
    return hashlib.sha256(f"{kind}:{value}".encode()).hexdigest()[:32]


@contextmanager
def issue_lock(directory: Path, issue_id: str, timeout: float):
    """One handover step per issue at a time, across processes and threads (flock on a private
    file). Yields False, holding nothing, when the lock is not free within ``timeout`` seconds."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(directory / (_digest("issue", issue_id) + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(LOCK_POLL_SECONDS)
        try:
            yield True
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _checked(state: Path, issue: str, metadata: Any, request_id: Any, to: Any, owner: str, step: Callable) -> dict:
    """Validate the request, take the owner's issue lock, then run ``step(context)``."""
    try:
        context = _context(state, issue, metadata, request_id, to)
    except Unknown as exc:
        diag.evt("handoff.decision", "refused", str(exc))
        return _unchanged(str(exc), _hold_message(str(exc)) + " Nothing was changed.")
    except Exception as exc:  # noqa: BLE001 - nothing has been read or changed yet
        diag.evt("handoff.decision", "refused", "cleanup_evidence_unavailable", exc=type(exc).__name__)
        return _unchanged("cleanup_evidence_unavailable", f"{owner}'s work couldn't be checked, so nothing was changed.")
    with issue_lock(_handoff_dir(state), metadata["id"], HANDOFF_LOCK_SECONDS) as held:
        if not held:
            return _refuse("handoff_busy", owner)
        return step(context)


def hand_off(state: Path, issue: str, binding_profile: str, settings: dict, metadata: dict, *, to: str, request_id: str,
             owner_name: str | None = None, ingress: Path | None = None, wait_seconds: float = DEFAULT_WAIT_SECONDS,
             clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
             inspect_cleanup: Callable[..., dict] = cleanup.inspect) -> dict:
    """Hand this profile's work on one issue to ``to``: "handed_off", "unchanged" (nothing was
    changed) or "paused" (the work is paused for this handover, which didn't complete).

    ``binding_profile`` is the deployment profile the cleanup proof scopes to; ``owner_name``
    only words the reply."""
    owner = owner_name or binding_profile
    wait = max(0.0, min(float(wait_seconds), MAX_WAIT_SECONDS))
    return _checked(state, issue, metadata, request_id, to, owner, lambda context: _hand_off_locked(
        state, binding_profile, settings, metadata, context, to=to, request_id=request_id, owner=owner,
        ingress=ingress, wait=wait, clock=clock, sleep=sleep, inspect_cleanup=inspect_cleanup))


def _hand_off_locked(state: Path, binding_profile: str, settings: dict, metadata: dict, context, *, to: str,
                     request_id: str, owner: str, ingress, wait: float, clock, sleep, inspect_cleanup) -> dict:
    from .api import LinearError
    from .bridge import require_task_issue_scope
    home, native_profile = context
    issue_id = metadata["id"]
    reason = handoff_reason(to, request_id)
    try:
        bound = cleanup._binding(state, issue_id, native_profile)
        if bound is None:
            return _refuse("not_bound_here", owner)
        # Same discovery as the cleanup proof: one native task, this executor, not archived.
        bound, _ = cleanup._discover(home, issue_id, native_profile, native_profile, metadata, bound)
        adapter = _adapter(home, bound["board"], native_profile)
        if not getattr(adapter, "guarded_controls", False):
            return _refuse("controls_unsupported", owner)
        from .origin_state import stop_checkpoint_reader
        if stop_checkpoint_reader() is None:
            return _refuse("controls_unsupported", owner)
        task = adapter.require_task(bound["task_id"])
        try:
            require_task_issue_scope(task, metadata)
        except LinearError:
            raise Unknown("native_task_issue_scope_conflict")
        events = adapter.history(task.id, 0)
        live = _live_stop(events)
        for_to = _handover_to(live) == to
        if live is not None and _handover_to(live) is not None and not for_to:
            # Paused for another agent's handover: proving it here would let two agents continue it.
            return _refuse("handover_in_progress", owner)
        if for_to:
            # Already paused for a handover to this same agent (a retry, or an earlier request
            # that didn't complete): prove that pause, never stop twice.
            stop_id, ours = live.id, True
        elif task.status in ("done", "archived"):
            return _refuse("task_finished_here", owner)
        elif task.status in PAUSED:
            stops = _stops(events)
            if (task.block_kind != "needs_input" or task.current_run_id is not None or not stops
                    or (stops[-1].payload or {}).get("kind") != "needs_input"):
                return _refuse("task_not_handable", owner)
            stop_id, ours = stops[-1].id, False  # A person's pause: prove it, change nothing.
        elif task.status not in STOPPABLE:
            return _refuse("task_not_handable", owner)
        else:
            if _started_open(adapter, task.id):
                return _refuse("started_other_tasks", owner)
            if _would_fence(adapter, task):
                return _refuse("controls_unsupported", owner)
            # Preflight the parts of the proof a Stop cannot change, before stopping anything.
            preflight = inspect_cleanup(state, issue_id, binding_profile, events[-1].id, settings, metadata, ingress=ingress)
            if preflight.get("reason") not in ("task_not_currently_stopped", "stop_event_changed"):
                raise Unknown(preflight.get("reason") or "cleanup_evidence_unavailable")
            stop_id = None
    except Unknown as exc:
        diag.evt("handoff.decision", "refused", str(exc))
        return _unchanged(str(exc), _hold_message(str(exc)) + " Nothing was changed.")
    except Exception as exc:  # noqa: BLE001 - nothing has been stopped yet
        diag.evt("handoff.decision", "refused", "cleanup_evidence_unavailable", exc=type(exc).__name__)
        return _unchanged("cleanup_evidence_unavailable", f"{owner}'s work couldn't be checked, so nothing was changed.")

    task_id = bound["task_id"]
    if stop_id is None:
        # The one guarded Stop. From here on the work may be paused: nothing ever resumes it here.
        try:
            _block(adapter, task, reason, events[-1].id)
        except Exception as exc:  # noqa: BLE001
            # Native block commits before it delivers Stop to the running worker; a delivery
            # error leaves the Stop in place. History, not the exception, says what happened.
            diag.evt("handoff.decision", "held", "unverified", exc=type(exc).__name__)
        try:
            after = adapter.history(task_id, 0)
        except Exception as exc:  # noqa: BLE001
            diag.evt("handoff.decision", "held", "stop_unverified", exc=type(exc).__name__)
            return _paused("stop_unverified", owner, to, "its work couldn't be checked after it was asked to stop, "
                                                        "so it may be paused.")
        live = _live_stop(after)
        if live is None or (live.payload or {}).get("reason") != reason:
            if not any((stop.payload or {}).get("reason") == reason for stop in _stops(after)):
                return _refuse("changed_during_handoff", owner)  # The guarded Stop never landed.
            diag.evt("handoff.decision", "skipped", "changed_during_handoff", task=task_id)
            return _unchanged("changed_during_handoff", f"Someone resumed, stopped or finished {owner}'s work during "
                                                        "the handover, so it was left as they set it, and nothing was "
                                                        "handed over.")
        stop_id, ours = live.id, True
        diag.evt("handoff.decision", "stopped", "-", task=task_id, evt=stop_id)

    # Prove the stopped work has ended. Only holds that clear while a worker winds down are waited on.
    deadline = clock() + wait
    resolve_tried = False
    while True:
        try:
            proof = inspect_cleanup(state, issue_id, binding_profile, stop_id, settings, metadata, ingress=ingress)
        except Exception as exc:  # noqa: BLE001 - an unreadable proof is not a proof
            diag.evt("handoff.decision", "held", "cleanup_evidence_unavailable", exc=type(exc).__name__)
            proof = {"quiescence_proven": False, "reason": "cleanup_evidence_unavailable"}
        if (proof.get("quiescence_proven") is not True and proof.get("reason") == "native_admission_not_settled"
                and ours and not resolve_tried):
            # Once per hand-off, counted only when core is actually asked: a row still ``started``
            # (the worker's stop ack and loss note can take ~40 s) leaves the attempt for a later poll.
            resolved = _resolve_lost_attempt(home, adapter, bound, task_id, stop_id, to)
            if resolved is not None:
                resolve_tried = True
            if resolved:
                continue
        if proof.get("quiescence_proven") is True:
            diag.evt("handoff.decision", "applied", "handed_off", task=task_id, evt=stop_id)
            return {"handed_off": True, "state": "handed_off", "issue_id": issue_id, "task_id": task_id,
                    "board": bound["board"], "stop_event_id": stop_id, "stopped_here": ours,
                    "evidence_digest": proof.get("evidence_digest"), "to": to, "permission_granted": False,
                    "message": f"{owner}'s work stopped and is confirmed finished; {to} can continue it."}
        held = proof.get("reason") or "cleanup_evidence_unavailable"
        if held not in TRANSIENT or clock() >= deadline:
            break
        sleep(POLL_SECONDS)
    held = "proof_timeout" if held in TRANSIENT else held
    if not ours:
        diag.evt("handoff.decision", "refused", "handoff_unchanged", task=task_id, evt=stop_id)
        return _unchanged(held, _hold_message(held) + f" {owner}'s work was left as it was, and nothing was handed over.")
    return _paused(held, owner, to, _fact(held))


def _lost_attempt(home: Path, adapter, bound: dict, task_id: str, stop_id: int, to: str) -> dict | None:
    """The stopped run's admission row when, and only when, core left it exactly ``unknown``
    under this flow's live pause: the task blocked with no current run, the live Stop is
    ``stop_id`` and is a guarded handover pause for ``to`` (from this request or an earlier one
    for the same agent; a person's pause or another agent's never qualifies), and the row is that
    run's Kanban card attempt.
    Any other row (``started``, terminal, foreign, missing) is None: nothing is resolved."""
    from .native_store import reader, local_receipt, find_admission
    task = adapter.require_task(task_id)
    if task.status != "blocked" or task.current_run_id is not None or task.block_kind != "needs_input":
        return None
    events = adapter.history(task_id, 0)
    live = _live_stop(events)
    if (live is None or live.id != stop_id or live.kind != "blocked"
            or _handover_to(live) != to or (live.payload or {}).get("kind") != "needs_input"):
        return None
    with adapter.read_conn() as conn:
        runs = [int(row["id"]) for row in conn.execute("SELECT id FROM task_runs WHERE task_id=? ORDER BY id", (task_id,))]
    if not runs or live.run_id not in (None, runs[-1]):
        return None
    run_id = runs[-1]  # The run our Stop ended: the task's latest, with no current run since.
    admitted = [event for event in events if event.kind == "owner_admitted" and event.run_id == run_id]
    if len(admitted) != 1 or admitted[0].id >= stop_id:
        return None
    marker = admitted[0].payload or {}
    request = "kanban:" + json.dumps([bound["board"], task_id, run_id], separators=(",", ":"))
    sid = marker.get("session_id")
    if (not isinstance(sid, str) or not sid or marker.get("request_id") != request
            or Path(str(marker.get("db") or "")).resolve() != home / "state.db"):
        return None
    with reader(home) as db:
        saved = local_receipt(db, sid)
        if saved.get("request_id") != request:
            return None
        row = find_admission(db, principal_id=saved["principal_id"], session_id=sid, request_id=request)
    if (row is None or row.get("status") != "unknown" or row.get("target_session_id") != sid
            or type(row.get("generation")) is not int or not isinstance(row.get("payload"), dict)
            or row["payload"].get("kanban_card_v1") != {"board": bound["board"], "task_id": task_id, "run_id": run_id}):
        return None
    return {"session_id": sid, "admission_id": row["admission_id"], "execution_generation": row["generation"]}


async def _resolve_unknown(home: Path, row: dict) -> None:
    """Core's own fenced Discard over the local owner connection the proof's receipt read uses."""
    from . import origin
    async with origin._client(home) as (client, _endpoint):
        await client.rpc("prompt.resolve_unknown", session_id=row["session_id"], admission_id=row["admission_id"],
                         execution_generation=row["execution_generation"])


def _resolve_lost_attempt(home: Path, adapter, bound: dict, task_id: str, stop_id: int, to: str) -> bool | None:
    """Ask core to settle our stopped attempt's ``unknown`` row: True when it was asked and
    answered, False when it was asked and refused (or unreachable), None when nothing was asked
    (no such row yet, e.g. still ``started``, or unreadable evidence). Never raises. A core with
    the durable process-Stop fence re-runs its cleanup first and refuses (``process_stop_unknown``)
    when owned processes can't be proven gone, leaving the row ``unknown``; a native-Stop core
    settles the row, and the scoped process checkpoint below keeps the proof holding instead. The proof, not this answer,
    decides the handover: it still checks worker processes, the executor row, lineage, the Stop
    checkpoint and the scoped process checkpoint."""
    import asyncio
    try:
        row = _lost_attempt(home, adapter, bound, task_id, stop_id, to)
    except Exception as exc:  # noqa: BLE001 - unreadable evidence: resolve nothing
        diag.evt("handoff.decision", "skipped", "native_attempt_unknown", task=task_id, evt=stop_id, exc=type(exc).__name__)
        return None
    if row is None:
        diag.evt("handoff.decision", "skipped", "native_attempt_unknown", task=task_id, evt=stop_id)
        return None
    diag.evt("handoff.decision", "started", "native_attempt_unknown", task=task_id, evt=stop_id)
    try:
        asyncio.run(_resolve_unknown(home, row))
    except Exception as exc:  # noqa: BLE001 - core refused or the owner is unreachable: stay paused
        code = str(getattr(exc, "reason", "") or exc)
        diag.evt("handoff.decision", "failed", "native_attempt_unknown", task=task_id, evt=stop_id,
                 exc=type(exc).__name__, **({"kind": code} if re.fullmatch(r"[a-z]{1,24}(?:_[a-z]{1,24}){0,3}", code) else {}))
        return False
    diag.evt("handoff.decision", "applied", "native_attempt_unknown", task=task_id, evt=stop_id)
    return True


def resume(state: Path, issue: str, binding_profile: str, metadata: dict, *, to: str, request_id: str,
           owner_name: str | None = None) -> dict:
    """A person's explicit resume of work paused for a handover to ``to`` that didn't complete:
    "resumed", or "unchanged" when the work is not paused for that handover (nothing touched).

    Only this flow's exact guarded handover pause for ``to`` is resumed, guarded on the latest
    event; any other pause is a person's to lift. Repeating it with the same request id is safe."""
    owner = owner_name or binding_profile

    def step(context) -> dict:
        home, native_profile = context
        label = resume_request_id(request_id)
        try:
            bound = cleanup._binding(state, metadata["id"], native_profile)
            if bound is None:
                return _refuse("not_bound_here", owner)
            adapter = _adapter(home, bound["board"], native_profile)
            for _ in range(3):  # Late worker events (its exit result) can land between the read and the unblock.
                events = adapter.history(bound["task_id"], 0)
                if any(event.kind == "unblocked" and (event.payload or {}).get("request_id") == label for event in events):
                    break
                live = _live_stop(events)
                if _handover_to(live) != to or adapter.require_task(bound["task_id"]).status != "blocked":
                    diag.evt("handoff.decision", "skipped", "handoff_unchanged", task=bound["task_id"])
                    return _unchanged("handoff_unchanged", f"{owner}'s work on this issue isn't paused for a handover "
                                                           f"to {to}, so it was left as it is.")
                with adapter.conn() as conn:
                    if adapter.kb.unblock_task(conn, bound["task_id"], expected_event_id=events[-1].id, request_id=label):
                        break
            else:
                return _refuse("changed_during_handoff", owner)
        except Exception as exc:  # noqa: BLE001 - unknown: the work stays as it is
            diag.evt("handoff.decision", "failed", "cleanup_evidence_unavailable", exc=type(exc).__name__)
            return _unchanged("cleanup_evidence_unavailable", f"{owner}'s work couldn't be checked, so it was left as "
                                                              "it is. Try again.")
        diag.evt("handoff.decision", "applied", "handoff_resumed", task=bound["task_id"])
        return {"handed_off": False, "state": "resumed", "reason": "handoff_resumed", "permission_granted": False,
                "message": f"{owner} continues its work on this issue."}

    return _checked(state, issue, metadata, request_id, to, owner, step)


# -- requester side -------------------------------------------------------------------------
# The requester reaches the owner only through an operator-configured command that runs the
# owner's own ``hermes ... linear hand-off`` (for example a host bridge into its container).
# The plugin never invents that route: an agent with no configured command for the current
# delegate refuses before anything changes.
_STATES = frozenset({"handed_off", "unchanged", "paused", "resumed"})


def takeover_settings(raw: Any, *, default_name: str) -> dict:
    """``takeover: {name, agents: [{name, delegate_id, command: [argv...], wait_seconds}]}``.

    Invalid entries are dropped (and logged once) rather than failing the service: an agent
    without a valid entry simply cannot take over from that delegate. ``wait_seconds`` is capped
    at TAKEOVER_MAX_WAIT_SECONDS so one take_over always ends inside the chat client's timeout."""
    if not isinstance(raw, dict):
        return {"name": default_name, "agents": {}}
    name = raw.get("name") if isinstance(raw.get("name"), str) and _NAME.fullmatch(raw["name"]) else default_name
    agents = {}
    for entry in raw.get("agents") or []:
        command = entry.get("command") if isinstance(entry, dict) else None
        wait = entry.get("wait_seconds", DEFAULT_WAIT_SECONDS) if isinstance(entry, dict) else None
        if not (isinstance(entry, dict) and isinstance(entry.get("name"), str) and _NAME.fullmatch(entry["name"])
                and isinstance(entry.get("delegate_id"), str) and 0 < len(entry["delegate_id"]) <= 128
                and isinstance(command, list) and command and len(command) <= 32
                and all(isinstance(part, str) and part and "\0" not in part and len(part) <= 512 for part in command)
                and isinstance(wait, (int, float)) and not isinstance(wait, bool) and 0 < wait <= MAX_WAIT_SECONDS):
            diag.evt("diag.config", "skipped", "takeover_unavailable")
            continue
        if wait > TAKEOVER_MAX_WAIT_SECONDS:
            diag.evt("diag.config", "skipped", "takeover_wait_capped")
        agents[entry["delegate_id"]] = {"name": entry["name"], "command": list(command),
                                        "wait_seconds": min(float(wait), TAKEOVER_MAX_WAIT_SECONDS)}
    return {"name": name, "agents": agents}


def request(peer: dict, issue: dict, *, to: str, request_id: str, resume: bool = False,
            run: Callable[..., Any] | None = None) -> dict | None:
    """Run the owner's hand-off (or its --resume) and return its reply, or None when the outcome
    is unknown. Never raises."""
    import subprocess
    run = run or subprocess.run
    metadata = {key: issue[key] for key in ("id", "identifier", "url")}
    argv = [*peer["command"], "linear", "hand-off", issue["id"], "--issue-json", json.dumps(metadata),
            "--to", to, "--from-name", peer["name"], "--request-id", request_id,
            "--wait-seconds", str(int(peer["wait_seconds"]))] + (["--resume"] if resume else [])
    try:
        done = run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, check=False,
                   timeout=(0 if resume else peer["wait_seconds"]) + OWNER_CALL_OVERHEAD_SECONDS)
    except Exception:  # noqa: BLE001 - timeouts, a missing bridge, anything: the outcome is unknown
        return None
    # Bridges can print their own lines (secret loaders, banners) before the reply.
    for line in reversed(str(getattr(done, "stdout", "") or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            reply = json.loads(line)
        except ValueError:
            continue
        if (isinstance(reply, dict) and isinstance(reply.get("handed_off"), bool) and reply.get("state") in _STATES
                and isinstance(reply.get("message"), str) and reply.get("permission_granted") is False):
            if reply["handed_off"] and (reply.get("issue_id") != issue["id"] or reply["state"] != "handed_off"):
                return None
            return reply
    return None
