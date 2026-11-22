"""Agent-to-agent takeover over A2A: the owner pauses its card, then the work starts here.

The requester's ``take_over`` sends one A2A message to the owning agent (a peer in core's
``a2a_agents`` config) asking it to call its own ``linear`` tool with ``hand_off``. The owner
pauses its one native task with the plain Kanban block, removes itself as the issue's Linear
delegate and answers with that tool's JSON. The requester starts its task only after that
confirmation AND a fresh Linear read showing the owner is no longer the delegate. Whenever
the owner may be paused and nothing runs here, the chat reply and a Linear comment say so
plainly. Nothing resumes the owner automatically: only a person's ``resume_owner``.
"""
from __future__ import annotations

import concurrent.futures
from contextlib import contextmanager
import contextvars
import json
import re
import threading
from typing import Any, Callable

from . import diag

HANDOFF_REASON = "Paused for a handover to {to} [handoff:{request_id}]"
_NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}"
NAME = re.compile(_NAME_PATTERN)
HANDOFF_PATTERN = re.compile(r"Paused for a handover to (?P<to>" + _NAME_PATTERN + r") "
                             r"\[handoff:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]")
DEFAULT_WAIT_SECONDS = 120.0
MAX_WAIT_SECONDS = 300.0
BEFORE_ASK_SECONDS = 40.0  # this side's Linear reads before the owner is asked
START_SECONDS = 60.0  # the fresh read and the start here, after the owner answered
CLIENT_TIMEOUT_SECONDS = BEFORE_ASK_SECONDS + MAX_WAIT_SECONDS + START_SECONDS + 20.0

ASK = ("Linear handover request from {to}. Call your linear tool once with exactly these arguments: {args} "
       "Then reply with that tool's JSON result exactly as it returned it, and nothing else. "
       "Do not change any other work for this request.")
# a2a_call answers that mean nothing reached the owner's agent (unknown tool or peer, auth refused).
_UNSENT = re.compile(r"^(?:Error: (?:unknown agent|both 'agent' and 'message'|peer '[^']*' rejected auth)|"
                     r"Unknown tool)")


_BUSY: set[str] = set()
_BUSY_LOCK = threading.Lock()


@contextmanager
def busy(issue_id: str):
    """One take_over or resume_owner per issue at a time in this gateway (all chat requests are
    served here). Yields False, holding nothing, when another one is already running."""
    with _BUSY_LOCK:
        free = issue_id not in _BUSY
        if free:
            _BUSY.add(issue_id)
    try:
        yield free
    finally:
        if free:
            with _BUSY_LOCK:
                _BUSY.discard(issue_id)


def settings(raw: Any, *, default_name: str) -> dict:
    """``takeover: {name, agents: [{name, delegate_id, a2a, wait_seconds}]}``.

    ``a2a`` names the owner's peer in core's ``a2a_agents`` config. Invalid entries are dropped
    (one diag config line each) rather than failing the service: an agent without a valid entry
    simply cannot take over from that delegate. ``command`` is no longer read."""
    if not isinstance(raw, dict):
        return {"name": default_name, "agents": {}}
    name = raw.get("name") if isinstance(raw.get("name"), str) and NAME.fullmatch(raw["name"]) else default_name
    agents = {}
    for entry in raw.get("agents") or []:
        entry = entry if isinstance(entry, dict) else {}
        wait = entry.get("wait_seconds", DEFAULT_WAIT_SECONDS)
        if not (isinstance(entry.get("name"), str) and NAME.fullmatch(entry["name"])
                and isinstance(entry.get("delegate_id"), str) and 0 < len(entry["delegate_id"]) <= 128
                and isinstance(entry.get("a2a"), str) and 0 < len(entry["a2a"].strip()) <= 128
                and isinstance(wait, (int, float)) and not isinstance(wait, bool) and 0 < wait <= MAX_WAIT_SECONDS):
            diag.evt("diag.config", "skipped", "takeover_unavailable")
            continue
        agents[entry["delegate_id"]] = {"name": entry["name"], "a2a": entry["a2a"].strip(), "wait_seconds": float(wait)}
    return {"name": name, "agents": agents}


def a2a_call(agent: str, message: str) -> Any:
    """Core's own A2A client tool, through the public tool registry (same on fork and upstream)."""
    from tools.registry import registry
    return registry.dispatch("a2a_call", {"agent": agent, "message": message})


def ask(peer: dict, issue: dict, *, to: str, request_id: str, resume: bool = False,
        dispatch: Callable[[str, str], Any] | None = None) -> dict:
    """One A2A message to the owner asking for ``hand_off``. Returns ``{"sent": False}`` when it
    certainly never reached the owner, ``{"sent": True, "reply": None}`` when the outcome is
    unknown (no answer in time, or anything but the tool's strict JSON), else the parsed reply."""
    args = {"action": "hand_off", "issue": issue.get("identifier") or issue["id"], "to": to, "id": request_id,
            **({"resume": True} if resume else {})}
    message = ASK.format(to=to, args=json.dumps(args))
    call = dispatch or a2a_call
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="linear-takeover")
    try:
        # The registry resolves the active profile's tools from context variables.
        future = pool.submit(contextvars.copy_context().run, call, peer["a2a"], message)
        try:
            raw = future.result(timeout=peer["wait_seconds"])
        except concurrent.futures.TimeoutError:
            return {"sent": True, "reply": None}
        except Exception:  # noqa: BLE001 - the message may have gone out: unknown
            return {"sent": True, "reply": None}
    finally:
        pool.shutdown(wait=False)
    text = json.dumps(raw) if isinstance(raw, dict) else str(raw or "")
    try:
        refused = json.loads(text) if text.lstrip().startswith("{") else None
    except ValueError:
        refused = None
    # a2a_call itself answers in plain text; a bare {"error": ...} is the registry refusing the call
    # (unknown or hosted-refused tool, bad arguments) before anything was sent.
    if _UNSENT.match(text.strip()) or (isinstance(refused, dict) and set(refused) == {"error"}):
        return {"sent": False}
    return {"sent": True, "reply": parse(text, issue_id=issue["id"], request_id=request_id)}


def parse(text: str, *, issue_id: str, request_id: str) -> dict | None:
    """The owner's ``hand_off`` JSON from an a2a_call answer, or None. a2a_call puts one
    ``[peer · context …]`` header line first; a single ``` fence around the JSON is tolerated."""
    lines = str(text or "").strip().splitlines()
    if lines and lines[0].startswith("[") and lines[0].rstrip().endswith("]"):
        lines = lines[1:]
    body = "\n".join(lines).strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", body, re.S)
    body = fenced.group(1) if fenced else body
    try:
        reply = json.loads(body)
    except ValueError:
        return None
    if (not isinstance(reply, dict) or type(reply.get("ok")) is not bool or type(reply.get("handed_off")) is not bool
            or not isinstance(reply.get("message"), str) or reply.get("request_id") != request_id
            or reply.get("issue_id") != issue_id or type(reply.get("paused", False)) is not bool
            or type(reply.get("resumed", False)) is not bool):
        return None
    return reply


# -- owner side: the linear tool's hand_off action ---------------------------------------

def _live_pause_for(events: list) -> str | None:
    """The agent the latest live pause hands over to, when it is this flow's handover pause."""
    stops = [event for event in events if event.kind in ("blocked", "block_loop_detected")]
    if not stops or any(event.id > stops[-1].id and event.kind in ("unblocked", "completed", "archived")
                        for event in events):
        return None
    payload = stops[-1].payload or {}
    made = HANDOFF_PATTERN.fullmatch(str(payload.get("reason") or "")) if payload.get("kind") == "needs_input" else None
    return made.group("to") if made else None


def hand_off(bridge, args: dict, context, issue: dict, reply: Callable[..., str]) -> str:
    """Pause this agent's one task for the issue and stop being its delegate, or with
    ``resume: true`` lift exactly such a pause and become the delegate again."""
    from .chat import _uuid
    issue_id, key = issue["id"], issue.get("identifier") or issue["id"]
    to, resume = args.get("to"), args.get("resume", False)
    request_id = _uuid(args.get("id"))
    if not (isinstance(to, str) and NAME.fullmatch(to)) or type(resume) is not bool:
        raise ValueError("hand_off needs to (the other agent's name) and an optional boolean resume.")
    me = bridge.takeover["name"]
    base = {"issue_id": issue_id, "request_id": request_id, "handed_off": False, "paused": False, "resumed": False}

    def answer(ok: bool, message: str, reason: str, **extra: Any) -> str:
        diag.evt("handoff.decision", "applied" if ok else "refused", reason, iss=issue_id)
        return reply(ok, message, **{**base, **extra})

    if context.delegated_child:
        return answer(False, "Native delegated children cannot change work; return the request to the parent agent.",
                      "native_scope_refused")
    viewer = bridge.api.viewer_id()
    with bridge.lock(issue_id):
        row = bridge.store.get(issue_id)
        if not row or row.get("origin") != "native" or not row.get("task_id"):
            return answer(False, f"{me} has no tracked work linked to {key}, so there was nothing to hand over.",
                          "not_bound_here")
        adapter = bridge._binding_adapter(issue_id)
        task = adapter.require_task(row["task_id"])
        pause = _live_pause_for(adapter.history(task.id, 0)) if task.status in ("blocked", "triage") else None
        delegate = (issue.get("delegate") or {}).get("id")
        if resume:
            if pause != to:
                return answer(False, f"{me}'s work on {key} isn't paused for a handover to {to}, so it was left "
                              "as it is.", "handoff_unchanged")
            if delegate not in (None, viewer):
                return answer(False, f"{key} is now delegated to {(issue.get('delegate') or {}).get('name') or 'another agent'}, "
                              f"so {me} was not resumed and two agents never run the same work.", "resume_refused",
                              paused=True)
            with adapter.conn() as conn:
                resumed = adapter.kb.unblock_task(conn, task.id)
            if not resumed:
                return answer(False, f"{me}'s work on {key} couldn't be resumed (its board refused it); it stays "
                              "paused until an operator resumes it.", "block_failed", paused=True)
            routed = _set_delegate(bridge, issue_id, viewer, delegate)
            return answer(True, f"{me} continues its work on {key}" + ("." if routed else
                          ", but couldn't make itself the issue's delegate in Linear again."), "handoff_resumed",
                          resumed=True)
        if pause == to:
            pass  # Already paused for a handover to this agent (a retry): never paused twice.
        elif task.status in ("done", "archived"):
            return answer(False, f"{me}'s work on {key} has already finished, so there was nothing to hand over.",
                          "task_finished_here")
        elif task.status not in ("running", "ready"):
            return answer(False, f"{me}'s work on {key} is {'paused' if task.status in ('blocked', 'triage') else 'waiting on something else'}, "
                          "so it was left as it is and nothing was handed over.", "task_not_handable")
        else:
            reason = HANDOFF_REASON.format(to=to, request_id=request_id)
            try:
                adapter.block(task.id, reason, issue=issue)
            except Exception as exc:  # noqa: BLE001 - history, not the exception, says what happened
                diag.evt("handoff.decision", "failed", "block_failed", iss=issue_id, exc=type(exc).__name__)
            if _live_pause_for(adapter.history(task.id, 0)) != to:
                after = adapter.require_task(task.id).status
                if after in ("running", "ready"):
                    return answer(False, f"{me}'s work on {key} couldn't be paused, so it keeps running and nothing "
                                  "was handed over.", "block_failed")
                return answer(False, f"{me}'s work on {key} changed while it was being paused, so it was left as "
                              "someone set it and nothing was handed over.", "changed_during_handoff",
                              paused=after in ("blocked", "triage"))
        _no_delegate_recovery(bridge, issue_id, task.id)
        if delegate == viewer and not _set_delegate(bridge, issue_id, None, viewer):
            return answer(False, f"{me}'s work on {key} is paused for a handover to {to}, but {me} couldn't remove "
                          "itself as the issue's delegate in Linear.", "takeover_paused", paused=True)
    return answer(True, f"{me}'s work on {key} is paused and {me} is no longer its delegate; {to} can continue it.",
                  "handed_off", handed_off=True, paused=True, task_id=task.id)


def _set_delegate(bridge, issue_id: str, target: str | None, expected: str | None) -> bool:
    """One direct delegate write (never the outbox), checked by a fresh read."""
    from .api import LinearError
    try:
        if expected != target:
            bridge.api.update_issue(issue_id, {"delegateId": target})
        return (bridge._effect_issue(issue_id).get("delegate") or {}).get("id") == target
    except LinearError as exc:
        diag.evt("handoff.decision", "failed", "delegate_not_ours", iss=issue_id, exc=type(exc).__name__)
        return False


def _no_delegate_recovery(bridge, issue_id: str, task_id: str) -> None:
    """The paused owner never re-adds itself as delegate: drop its unsent delegate writes and
    record this binding's delegate-recovery decision as not routed."""
    bridge.store.drop_unsent_delegate(issue_id, task_id, at=bridge.clock())
    key = f"delegate-recovery:{issue_id}:{bridge.store.binding_revision(issue_id)}"
    if bridge.store.native_intent(key) is None:
        bridge.store.native_intent_prepare(key, {"issue_id": issue_id, "task_id": task_id, "route": False})
        bridge.store.native_intent_settle(key, {"state": "applied", "routed": False, "reason": "handed_off"})
