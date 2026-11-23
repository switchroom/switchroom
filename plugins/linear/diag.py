"""Metadata-only decision logging for the Linear plugin.

One line per decision the plugin makes about an issue (route, write, refuse,
skip, stop, give up), never one per tick, scanned event or HTTP call. Every
value is checked against a per-field pattern, so a mistaken call cannot leak
comment bodies, descriptions, titles, emails, tokens or URLs: anything that
does not match is written as ``?``.

Lines go to the ``hermes_plugins.linear`` logger, so core handlers, rotation
and redaction apply and they also reach ``gateway.log``. Format::

    linear.evt action=status.write outcome=refused reason=updated_after_source agent=a profile=p issue=ABC-1 ...

Volume rules: WARNING at most once per 15 min per (action, reason, issue); a
repeated non-applied INFO decision at most once per 60 min; one summary per
60 s only when something happened; one health line per hour only while work
is linked; and per-issue INFO stops for the rest of the hour at the cap.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

LOGGER_NAME = "hermes_plugins.linear"
log = logging.getLogger(LOGGER_NAME)
PREFIX = "linear.evt"

WARN_WINDOW_S = 900.0       # one WARNING per (action, reason, issue) per 15 min
REPEAT_WINDOW_S = 3600.0    # one identical non-applied INFO decision per hour
SUMMARY_EVERY_S = 60.0
HEALTH_EVERY_S = 3600.0
HOURLY_CAP = 200            # hard cap on INFO lines per hour
# Summaries and service lines are never throttled; reserve their worst case so
# the total stays at or under HOURLY_CAP (60 summaries + health + start/stop).
RESERVED = 64
PER_ISSUE_CAP = HOURLY_CAP - RESERVED

ACTIONS = frozenset({
    "service.start", "service.stop", "service.tick", "service.health", "reconcile.summary",
    "webhook.delivery", "session.start", "session.reuse", "claim.decision", "handoff.decision",
    "stop.decision", "native.event", "status.write", "delegate.write", "content.write",
    "outbox.retry", "tool.result", "binding.held", "auth.reauth_required", "scope.fenced",
    "ingress.parked", "api.result", "diag.throttled", "diag.config", "chat.entrust", "chat.record_done",
    "session.admit", "pr_park.resume",
})
OUTCOMES = frozenset({
    "received", "routed", "ignored", "deduped", "stale", "queued", "applied", "refused",
    "skipped", "retry", "gave_up", "failed", "held", "started", "stopped", "blocked", "released", "-",
})
# Closed reason vocabulary. Each code maps to one code branch; see README "Diagnostics".
REASONS = frozenset({
    "-",
    # status refusal (_send / may_write)
    "release_superseded", "obsolete_progress", "superseded_owner", "superseded_terminal",
    "prereq_status_unapplied", "takeover_or_canceled", "content_owner_changed", "delegate_not_ours",
    "claim_retained", "issue_closed", "updated_after_source", "human_routing_change", "admission_retained",
    "unlinked_content_required", "not_applied",
    # status skip
    "same_state", "human_started_state", "app_not_last_mover", "no_state_mapping",
    "plan_section_human_edit", "plan_section_guard",
    # delegate recovery / delegate write
    "session_owned", "agent_session_scope", "binding_mismatch", "already_decided", "not_running",
    "human_delegate", "human_edit", "moot_before_write", "binding_recovery", "already_delegate",
    "task_finished", "claim_unconsumed", "no_human_fence", "effect_unresolved", "chat_route_retry",
    # outbox
    "rate_limited", "retryable_http", "non_retryable", "auth_unavailable", "scope_denied",
    "give_up_24h", "reconciliation_blocked", "uncertain_terminal", "uncertain_prior",
    "requester_session_missing", "advisory_dropped", "exception",
    # webhook
    "activation_cutoff", "superseded", "scope_fenced", "scope_refused", "unbound_issue",
    "not_session_event", "stamp_missing", "invalid_payload", "native_routed", "bound_issue_recheck",
    "delivery_failed", "no_issue_destination", "own_echo", "recheck_coalesced",
    # session / claim / handoff
    "existing_binding", "reconciliation_required", "assignment_echo", "native_changed",
    "admission_superseded", "activation_unverified", "revision_mismatch", "reconcile_complete",
    "closed_or_elsewhere",
    # chat entrust / record_done
    "record_done_parked", "not_started", "delegated_elsewhere", "contract_mismatch",
    # delegation admission before the model turn (native_input.admit_delegation)
    "delegation_started", "delegation_linked", "admission_declined", "admission_held", "admission_failed",
    "mention_conversation", "delegated_awaiting_session", "session_turn", "same_session",
    "session_adopted", "owner_session_live",
    "finished_work_conversation",
    # stop
    "unbound_recorded", "not_native", "not_delegate", "stale_order", "no_current_run",
    "already_stopped", "block_failed", "unverified",
    # agent-to-agent takeover over A2A (takeover.py owner hand_off, chat.py take_over requester side)
    "handed_off", "handoff_resumed", "handoff_unchanged", "handoff_not_allowed", "handoff_closed", "handoff_unproven",
    "started_other_tasks",
    "not_bound_here", "task_finished_here", "task_not_handable", "changed_during_handoff",
    "takeover_unavailable", "takeover_refused", "takeover_paused", "takeover_notice_unsent", "not_delegated",
    "takeover_in_progress", "local_work_not_runnable", "takeover_not_admitted", "takeover_already_here",
    "takeover_routing_unfinished", "takeover_local_unknown", "resume_refused", "resume_uncertain",
    # service / api / config
    "shutdown", "crash", "identity_unavailable", "socket_owned", "tick_exception", "duplicate_create",
    "readback_differs", "id_reused", "hourly_cap", "invalid_diagnostics", "internal_wording", "budget_deferred",
    # tool replies (chat.py codes)
    "request_refused", "service_unavailable", "context_unavailable", "unsupported_action",
    "authorization_unavailable", "native_scope_refused", "description_conflict",
    "context_or_service_unavailable", "delivery_uncertain", "project_required", "ambiguous_project",
    "unknown_team", "team_required", "not_found", "ambiguous_issue", "issue_alias", "alias_closed",
    # an older build's PR-acceptance closeout closed out again as Done (F28)
    "legacy_closeout",
    # work core's open-PR guard parked, resumed once that PR merges or closes (_resume_pr_park)
    "pr_park_resolved", "pr_park_resumed", "pr_park_changed", "pr_park_no_pr", "pr_open", "pr_unreadable",
    "external_wait_resumed", "issue_open", "issue_unreadable", "delivery_pending", "ci_pending", "ci_park_limit", "wait_changed", "readback_matches",
})
_OPEN_REASON = re.compile(r"(?:native|graphql)_[a-z0-9_]{1,32}")

_INT = re.compile(r"-?[0-9]{1,12}")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,31}")
_HEX8 = re.compile(r"[0-9a-f]{8}")
# Belt and braces: a value that looks like key material is dropped even if its pattern would allow it.
_SECRETISH = re.compile(r"(?i)lin_|bearer|token|secret|passw|api_?key|@|://")
FIELDS: dict[str, re.Pattern | None] = {  # None means integer
    "agent": _NAME, "profile": _NAME,
    "issue": re.compile(r"[A-Z][A-Z0-9]{0,9}-[0-9]{1,7}"),
    "iss": _HEX8, "task": re.compile(r"t_[0-9a-f]{4,32}"), "sess": _HEX8,
    # Native event ids are integers; delivery and row ids are UUID prefixes.
    "evt": re.compile(r"[0-9a-f-]{1,12}"), "row": re.compile(r"[0-9a-f-]{1,8}"),
    "attempt": None, "ms": None,
    # Event/outbox/tool kinds (lower_snake) or a webhook Type.action; no digits, so no key material.
    "kind": re.compile(r"[a-z]{1,24}(?:_[a-z]{1,24}){0,3}|[A-Z][A-Za-z]{1,30}\.[a-z]{1,24}"),
    "state": re.compile(r"[a-z]{1,12}(?:_[a-z]{1,12}){0,2}"),
    "code": re.compile(r"[A-Z0-9_]{1,80}"), "exc": re.compile(r"[A-Z][A-Za-z0-9]{0,63}"),
    "ver": re.compile(r"[0-9]{1,4}(?:\.[0-9A-Za-z-]{1,16}){0,3}"), "sha": re.compile(r"[0-9a-f]{7,40}"),
    "commit": re.compile(r"[0-9a-f]{7,40}"), "lvl": re.compile(r"detail"),
    "detail": re.compile(r"on|off"), "suppressed": None, "next_s": None, "tick_s": None,
    "recheck_s": None, "oldest_pending_s": None, "max_tick_ms": None, "waited_s": None,
    # Slowest tick parts (own work, Linear requests, blocked on another holder) and most requests in one tick.
    "max_tick_local_ms": None, "max_tick_api_ms": None, "max_tick_wait_ms": None, "max_tick_api_calls": None,
    # The part of the local time this thread was actually running; the rest of local is off-CPU
    # (waiting for the interpreter lock or for disk).
    "max_tick_local_cpu_ms": None,
    # Comma-separated field names (create readback differences), never field values.
    "fields": re.compile(r"[a-z][a-z_]{0,23}(?:,[a-z][a-z_]{0,23}){0,7}"),
}
for _name in ("bindings", "pending", "held", "failed_unreported", "events", "status_q", "delegate_q",
              "sent", "refused", "skipped", "retry", "failed", "deliveries", "ignored", "suppressed_info",
              "content", "minor", "api_calls"):
    FIELDS["n_" + _name] = None
ORDER = ("agent", "profile", "issue", "iss", "task", "sess", "evt", "row", "attempt", "ms")
# Optional fields are written in this order after the fixed ones.
EXTRA_ORDER = tuple(key for key in FIELDS if key not in ORDER)
# Truncated identifiers: the first 8 characters of a UUID or row id.
_SHORT = {"iss": 8, "sess": 8, "row": 8, "evt": 12}
REPEATABLE = frozenset({"refused", "skipped", "held", "ignored", "stale", "deduped", "retry"})
EXEMPT = frozenset({"service.start", "service.stop", "service.health", "reconcile.summary", "diag.throttled",
                    "diag.config"})
CONSEQUENTIAL = frozenset({"claimed", "spawned", "crashed", "gave_up", "timed_out", "reclaimed", "blocked",
                           "block_loop_detected", "unblocked", "completed", "archived", "review_requested"})
SUMMARY_COUNTERS = ("events", "status_q", "delegate_q", "sent", "refused", "skipped", "retry", "failed", "held",
                    "deliveries", "ignored", "content", "minor", "api_calls")
# Routine background work (applied comments and keepalives, heartbeats, the requests they make) is
# shown but never triggers a summary on its own, so steadily running work stays near zero lines per hour.
SUMMARY_TRIGGERS = frozenset(SUMMARY_COUNTERS) - {"content", "minor", "api_calls"}
TICK_MAXIMA = ("max_tick_ms", "max_tick_local_ms", "max_tick_api_ms", "max_tick_wait_ms", "max_tick_api_calls",
               "max_tick_local_cpu_ms")


def _now() -> float:
    return time.monotonic()


def _wall() -> float:
    return time.time()


def _cpu() -> float:
    return time.thread_time()


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.agent = self.profile = None
        self.diagnostics: dict[str, Any] | None = None
        self.limits: dict[tuple, list] = {}       # key -> [last emit time, suppressed]
        self.transitions: dict[tuple, str] = {}
        self.keys: dict[str, str] = {}            # issue UUID -> issue key, filled from issue reads
        self.window_start = None
        self.window_count = 0
        self.throttled = 0
        self.counters: dict[str, int] = {}
        self.maxima: dict[str, int] = dict.fromkeys(TICK_MAXIMA, 0)
        self.last_summary = None
        self.last_health = None
        self.activity = 0  # monotonic: counted outcomes plus Linear requests, never reset by summaries


_state = _State()
_tls = threading.local()


def reset() -> None:
    """Forget limiter, counters and configuration (tests and process start)."""
    global _state
    _state = _State()


def configure(diagnostics: Any = None, *, agent: str | None = None, profile: str | None = None) -> None:
    """Set the per-agent context and the optional time-boxed detail setting.

    ``diagnostics: {detail: true, issues: [ABC-1], until: 2026-11-03T00:00Z}`` in the
    plugin's settings block. ``until`` is required, so a forgotten flag expires.
    """
    _state.agent, _state.profile = agent, profile
    _state.diagnostics = None
    # A new reporting service starts a fresh limiter: the first line after a restart is always shown.
    with _state.lock:
        _state.limits.clear()
        _state.transitions.clear()
    if diagnostics is None:
        return
    parsed = _parse_diagnostics(diagnostics)
    if parsed is None:
        evt("diag.config", "refused", "invalid_diagnostics", level=logging.WARNING)
        return
    _state.diagnostics = parsed


def _parse_diagnostics(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) - {"detail", "issues", "until"}:
        return None
    if value.get("detail") is not True:
        return {"detail": False, "issues": (), "until": 0.0}
    issues = value.get("issues") or []
    if not isinstance(issues, list) or any(not isinstance(item, str) or not FIELDS["issue"].fullmatch(item)
                                           for item in issues):
        return None
    until = value.get("until")
    if isinstance(until, datetime):
        moment = until
    elif isinstance(until, str):
        try:
            moment = datetime.fromisoformat(until.strip().replace("Z", "+00:00").replace("z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return {"detail": True, "issues": tuple(issues), "until": moment.timestamp()}


def detail_active(fields: dict[str, Any] | None = None) -> bool:
    config = _state.diagnostics
    if not config or not config["detail"] or _wall() >= config["until"]:
        return False
    if not config["issues"]:
        return True
    fields = fields or {}
    key = fields.get("issue") or _state.keys.get(str(fields.get("iss") or ""))
    return key in config["issues"]


def remember(issue: Any) -> Any:
    """Cache an issue's key from an issue read so later lines can name it. Returns the issue."""
    if isinstance(issue, dict):
        issue_id, key = issue.get("id"), issue.get("identifier")
        if isinstance(issue_id, str) and isinstance(key, str) and FIELDS["issue"].fullmatch(key):
            if len(_state.keys) > 4096:
                _state.keys.clear()
            _state.keys[issue_id] = key
    return issue


def _value(key: str, value: Any) -> str:
    pattern = FIELDS[key]
    if pattern is None:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
            return "?"
        return str(int(value))
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return "?"
    text = str(value)
    if _SECRETISH.search(text):
        return "?"
    if key in _SHORT:
        text = text[:_SHORT[key]]
        if key in ("iss", "sess"):
            text = text.lower()
    return text if pattern.fullmatch(text) else "?"


def _reason(value: Any) -> str:
    if isinstance(value, str) and (value in REASONS or _OPEN_REASON.fullmatch(value)):
        return value
    return "?"


def render(action: str, outcome: str, reason: str = "-", **fields: Any) -> str:
    """The whitelisted logfmt line. Unknown keys are dropped; bad values become ``?``."""
    fields.setdefault("agent", _state.agent)
    fields.setdefault("profile", _state.profile)
    iss = fields.get("iss")
    if not fields.get("issue") and isinstance(iss, str) and iss in _state.keys:
        fields["issue"] = _state.keys[iss]
    parts = [PREFIX, "action=" + (action if action in ACTIONS else "?"),
             "outcome=" + (outcome if outcome in OUTCOMES else "?"), "reason=" + _reason(reason)]
    for key in ORDER + EXTRA_ORDER:
        value = fields.get(key)
        if value is None or value == "":
            continue
        parts.append(f"{key}={_value(key, value)}")
    return " ".join(parts)


def _limit_key(action: str, outcome: str, reason: str, level: int, fields: dict[str, Any]) -> tuple | None:
    if action == "tool.result":
        return None  # one line per tool call: each is a distinct result, never a re-evaluated decision
    subject = fields.get("iss") or fields.get("evt") or fields.get("row") or fields.get("task")
    if level >= logging.WARNING:
        return ("w", action, outcome, reason, str(subject))
    if outcome in REPEATABLE:
        return ("i", action, outcome, reason, str(subject), str(fields.get("task")))
    return None


def evt(action: str, outcome: str, reason: str = "-", *, level: int = logging.INFO,
        exc_info: Any = None, **fields: Any) -> bool:
    """Emit one decision line, subject to the limiter and the hourly cap. True when written."""
    now = _now()
    with _state.lock:
        key = _limit_key(action, outcome, reason, level, fields)
        if key is not None and action not in EXEMPT:
            window = WARN_WINDOW_S if key[0] == "w" else REPEAT_WINDOW_S
            seen = _state.limits.get(key)
            if seen is not None and now - seen[0] < window:
                seen[1] += 1
                return False
            if seen is not None and seen[1]:
                fields["suppressed"] = seen[1]
            _state.limits[key] = [now, 0]
            if len(_state.limits) > 8192:
                _state.limits.clear()
        throttle_line = None
        if level < logging.WARNING:
            if _state.window_start is None or now - _state.window_start >= 3600.0:
                _state.window_start, _state.window_count, _state.throttled = now, 0, 0
            if action not in EXEMPT:
                if _state.window_count >= PER_ISSUE_CAP:
                    _state.throttled += 1
                    if _state.throttled != 1:
                        return False
                    throttle_line = render("diag.throttled", "held", "hourly_cap",
                                           n_suppressed_info=_state.window_count)
                else:
                    _state.window_count += 1
            else:
                _state.window_count += 1
        line = None if throttle_line else render(action, outcome, reason, **fields)
    if throttle_line:
        log.warning("%s", throttle_line)
        return False
    log.log(level, "%s", line, exc_info=exc_info)
    return True


def warn(action: str, outcome: str, reason: str, **fields: Any) -> bool:
    return evt(action, outcome, reason, level=logging.WARNING, **fields)


def detail(action: str, outcome: str, reason: str = "-", **fields: Any) -> bool:
    """A DEBUG-class line, written at INFO with ``lvl=detail`` only while the diagnostics setting is active."""
    if not detail_active(fields):
        return False
    return evt(action, outcome, reason, lvl="detail", **fields)


def transition(action: str, outcome: str, reason: str, *, key: Any, quiet: bool = False, **fields: Any) -> bool:
    """Emit only when the decision for ``key`` changes. ``quiet`` decisions are detail-only."""
    with _state.lock:
        marker = (action, key)
        if _state.transitions.get(marker) == (outcome, reason):
            return False
        _state.transitions[marker] = (outcome, reason)
        if len(_state.transitions) > 8192:
            _state.transitions.clear()
    return (detail if quiet else evt)(action, outcome, reason, **fields)


# -- reason hand-off --------------------------------------------------------
# A refusing branch records its code with ``because(code, value)`` and returns
# the value unchanged; the caller that logs the decision takes it with ``take()``.

def because(reason: str, value: Any = False, outcome: str | None = None) -> Any:
    _tls.reason, _tls.outcome = reason, outcome
    return value


def skip(reason: str, value: Any = True) -> Any:
    return because(reason, value, "skipped")


def clear() -> None:
    _tls.reason = _tls.outcome = None


def take() -> tuple[str | None, str]:
    outcome, reason = getattr(_tls, "outcome", None), getattr(_tls, "reason", None) or "-"
    clear()
    return outcome, reason


def decision(action: str, value: Any, *, ok: str = "applied", no: str = "refused", **fields: Any) -> Any:
    """Log the outcome of a decision function that returned ``value``; returns it unchanged."""
    outcome, reason = take()
    if outcome is None:
        outcome = no if not value else (ok if reason == "-" else "skipped")
    evt(action, outcome, reason, **fields)
    return value


def exc_reason(exc: BaseException) -> str:
    """A reason code from an exception's class, never its message."""
    name = type(exc).__name__
    if name == "RateLimited":
        return "rate_limited"
    if type(getattr(exc, "__cause__", None)).__name__ == "ReauthorizationRequired":
        return "auth_unavailable"
    if hasattr(exc, "retryable"):
        return "retryable_http" if getattr(exc, "retryable") else "non_retryable"
    return "exception"


def exc_fields(exc: BaseException) -> dict[str, Any]:
    return {"exc": type(exc).__name__}


# -- outbox outcomes --------------------------------------------------------

_OUTBOX_ACTION = {"status": "status.write", "delegate": "delegate.write"}


def outbox_fields(row: dict[str, Any], started: float | None = None) -> dict[str, Any]:
    payload = row.get("payload") or {}
    fields = {"iss": payload.get("issue_id"), "task": payload.get("task_id"), "row": row.get("id"),
              "attempt": row.get("attempts"), "kind": row.get("kind")}
    if payload.get("state"):
        fields["state"] = payload.get("state")
    session = payload.get("session_id") or payload.get("session_key")
    if isinstance(session, str):
        fields["sess"] = session
    if started is not None:
        fields["ms"] = (_now() - started) * 1000
    return fields


def outbox_result(row: dict[str, Any], applied: bool, started: float | None = None) -> str | None:
    """Log one delivered outbox row. Returns the reason code to persist, or None when applied."""
    outcome, reason = take()
    if not applied:
        outcome, reason = "refused", (reason if reason != "-" else "not_applied")
    elif outcome != "skipped":
        outcome, reason = "applied", "-"
    action = _OUTBOX_ACTION.get(row.get("kind"), "content.write")
    count("content" if action == "content.write" and outcome != "refused" else
          {"applied": "sent", "refused": "refused", "skipped": "skipped"}[outcome])
    fields = outbox_fields(row, started)
    if action == "content.write" and outcome != "refused":
        detail(action, outcome, reason, **fields)  # ~280 comments per 48h would dominate at INFO
    else:
        evt(action, outcome, reason, **fields)
    return None if outcome == "applied" else reason


def outbox_failure(row: dict[str, Any], exc: BaseException, *, gave_up: bool | None = None,
                   advisory: bool = False) -> str:
    """Log a failed send: retry at INFO, give-up and non-retryable at WARNING (deduped). Returns the code."""
    reason = exc_reason(exc)
    fields = {**outbox_fields(row), **exc_fields(exc)}
    if advisory:
        count("failed")
        detail("content.write", "failed", "advisory_dropped", **fields)
        return "advisory_dropped"
    if gave_up is None:  # non-retryable
        count("failed")
        warn("outbox.retry", "failed", reason, **fields)
    elif gave_up:
        count("failed")
        reason = "give_up_24h"
        warn("outbox.retry", "gave_up", reason, **fields)
    else:
        count("retry")
        attempts = int(row.get("attempts") or 0) + 1
        evt("outbox.retry", "retry", reason, next_s=min(60 * 2 ** (attempts - 1), 3600), **fields)
    return reason


# -- webhook ------------------------------------------------------------------

_STALE = frozenset({"activation_cutoff", "superseded"})
_IGNORED = frozenset({"scope_fenced", "unbound_issue", "not_session_event", "own_echo"})
_REFUSED = frozenset({"stamp_missing", "scope_refused", "invalid_payload"})


def webhook(event: Any, delivery: Any, result: Any = None, *, bound: Callable[[str], Any] | None = None,
            reason: str | None = None) -> Any:
    """Log one consumed delivery. Per line only for session events and bound issues; the rest is counted."""
    taken_outcome, taken = take()
    reason = reason or taken
    event = event if isinstance(event, dict) else {}
    kind = f"{event.get('type')}.{event.get('action')}" if event.get("type") else None
    session = event.get("agentSession") if isinstance(event.get("agentSession"), dict) else {}
    issue_id = ((session.get("issue") or {}).get("id") if isinstance(session.get("issue"), dict) else None) \
        or ((event.get("data") or {}).get("id") if isinstance(event.get("data"), dict) else None)
    count("deliveries")
    per_line = event.get("type") == "AgentSessionEvent" or (
        event.get("type") == "Issue" and isinstance(issue_id, str) and bound is not None and bool(bound(issue_id)))
    if reason in _STALE:
        outcome = "stale"
    elif reason in _IGNORED:
        outcome = "ignored"
    elif reason in _REFUSED:
        outcome = "refused"
    elif reason == "native_routed":
        outcome = "routed"
    else:
        outcome = taken_outcome or ("refused" if result is False else "routed")
    if outcome in ("ignored", "stale"):
        count("ignored")
    if not per_line:
        return result
    evt("webhook.delivery", outcome, reason, kind=kind, iss=issue_id, sess=session.get("id"), evt=delivery)
    return result


# -- summaries ----------------------------------------------------------------

def count(name: str, n: int = 1) -> None:
    with _state.lock:
        _state.counters[name] = _state.counters.get(name, 0) + n
        _state.activity += n


def activity() -> int:
    """Monotonic count of reporting work done (counted outcomes and Linear requests) in this process.

    The reporting loop compares it across a tick: unchanged means the tick found nothing to do."""
    return _state.activity


def native_event(kind: Any, **fields: Any) -> None:
    """A consumed native event: consequential kinds get a line, the rest only a counter."""
    count("events" if kind in CONSEQUENTIAL else "minor")
    if kind in CONSEQUENTIAL:
        evt("native.event", "queued", f"native_{kind}", kind=kind, **fields)
    else:
        detail("native.event", "skipped", "-", kind=kind if isinstance(kind, str) else None, **fields)


# -- tick timing ---------------------------------------------------------------
# A slow reporting tick is mostly waiting. The ticking thread adds up three things:
# - api: wall time inside Linear requests (the shared request lock, credentials, HTTP, decoding
#   the answer) and how many HTTP requests went out;
# - wait: time blocked on a lock another thread or process held (a per-issue bridge lock, the
#   reporting store's write lock), which is neither Linear nor this tick's own work;
# - local: the rest, the tick's own work. local_cpu is the part of it this thread spent running
#   (thread CPU time outside api and wait); local minus local_cpu is time it was runnable or
#   reading but not running: the interpreter lock held by other threads, or disk.
# Other threads (chat tools) are not part of the tick and are not counted.

def tick_begin() -> None:
    # seconds inside Linear requests, HTTP requests sent, seconds blocked, thread CPU inside both
    _tls.tick_api = [0.0, 0, 0.0, 0.0]
    _tls.tick_cpu = _cpu()


@contextmanager
def _timed(slot: int):
    depth = getattr(_tls, "api_depth", 0)
    _tls.api_depth = depth + 1
    started, cpu = _now(), _cpu()
    try:
        yield
    finally:
        _tls.api_depth = depth
        tick = getattr(_tls, "tick_api", None)
        if depth == 0 and tick is not None:  # time inside an outer request is the request's
            tick[slot] += _now() - started
            tick[3] += _cpu() - cpu


def api_time():
    """Time one Linear request on this thread; a nested request is counted once, by the outermost."""
    return _timed(0)


def wait_time():
    """Time blocking on a lock held elsewhere; inside a Linear request it counts as the request."""
    return _timed(2)


def api_sent() -> None:
    """One HTTP request is about to go to Linear (a credential retry is a second one)."""
    tick = getattr(_tls, "tick_api", None)
    if tick is not None:
        tick[1] += 1
    with _state.lock:
        _state.activity += 1


def tick_done(started: float, gauges: Callable[[], dict[str, Any]] | None = None) -> None:
    """End of one reporting tick: at most one summary per 60 s when something happened, one hourly health line."""
    now = _now()
    api_s, calls, wait_s, timed_cpu_s = getattr(_tls, "tick_api", None) or (0.0, 0, 0.0, 0.0)
    cpu_started = getattr(_tls, "tick_cpu", None)
    cpu_s = 0.0 if cpu_started is None else _cpu() - cpu_started - timed_cpu_s
    _tls.tick_api = _tls.tick_cpu = None
    with _state.lock:
        total_ms = int((now - started) * 1000)
        api_ms = max(0, min(total_ms, int(api_s * 1000)))
        wait_ms = max(0, min(total_ms - api_ms, int(wait_s * 1000)))
        local_ms = total_ms - api_ms - wait_ms
        local_cpu_ms = max(0, min(local_ms, int(cpu_s * 1000)))
        for name, value in (("max_tick_ms", total_ms), ("max_tick_local_ms", local_ms),
                            ("max_tick_api_ms", api_ms), ("max_tick_wait_ms", wait_ms),
                            ("max_tick_api_calls", calls), ("max_tick_local_cpu_ms", local_cpu_ms)):
            _state.maxima[name] = max(_state.maxima[name], value)
        if calls:
            _state.counters["api_calls"] = _state.counters.get("api_calls", 0) + calls
        if _state.last_summary is None:
            _state.last_summary = now
        if _state.last_health is None:
            _state.last_health = now
        summary_due = (now - _state.last_summary >= SUMMARY_EVERY_S
                       and any(_state.counters.get(name) for name in SUMMARY_TRIGGERS))
        health_due = now - _state.last_health >= HEALTH_EVERY_S
        if summary_due:
            counters = {f"n_{name}": _state.counters.get(name, 0) for name in SUMMARY_COUNTERS}
            counters.update(_state.maxima)
            _state.counters, _state.last_summary = {}, now
            _state.maxima = dict.fromkeys(TICK_MAXIMA, 0)
        if health_due:
            _state.last_health = now
    if not (summary_due or health_due):
        return
    values = {}
    if gauges is not None:
        try:
            values = gauges() or {}
        except Exception:  # noqa: BLE001 - diagnostics never break reporting
            values = {}
    if summary_due:
        evt("reconcile.summary", "-", n_bindings=values.get("n_bindings"), **counters)
    if health_due and (values.get("n_bindings") or values.get("n_pending")):
        evt("service.health", "-", **{key: values.get(key) for key in (
            "n_bindings", "n_pending", "oldest_pending_s", "n_held", "n_failed_unreported")})


def service_start(store: Any, tick_s: float, recheck_s: float) -> None:
    """The startup line: which plugin build is running and what it inherited. Never breaks startup."""
    try:
        counts = store.diag_counts(_wall())
        counts = counts if isinstance(counts, dict) else {}
    except Exception:  # noqa: BLE001 - diagnostics never break reporting
        counts = {}
    evt("service.start", "started", **version(), tick_s=tick_s, recheck_s=recheck_s,
        detail="on" if detail_active() else "off",
        **{key: counts.get(key) for key in ("n_bindings", "n_pending", "n_held", "n_failed_unreported")})


# -- tool replies -----------------------------------------------------------

READ_ACTIONS = frozenset({"status", "work_reference"})


def tool_result(args: Any, reply: str, started: float | None = None) -> str:
    """Log a chat tool reply's outcome and code; never its message or arguments beyond the issue ref."""
    import json
    try:
        parsed = json.loads(reply)
    except (TypeError, ValueError):
        parsed = {}
    args = args if isinstance(args, dict) else {}
    action, ok = args.get("action"), parsed.get("ok") is True
    ref = args.get("issue") if isinstance(args.get("issue"), str) else ""
    resolved = parsed.get("resolved_issue") if isinstance(parsed, dict) else None
    if isinstance(resolved, dict) and isinstance(resolved.get("issue"), str):
        ref = resolved["issue"]  # a title alias ("QA-10") logs as the key it resolved to
    fields = {"kind": action if isinstance(action, str) else None,
              "issue": ref if FIELDS["issue"].fullmatch(ref) else None,
              "iss": ref if not FIELDS["issue"].fullmatch(ref) else None}
    if started is not None:
        fields["ms"] = (_now() - started) * 1000
    code = parsed.get("code") if isinstance(parsed.get("code"), str) else "-"
    if ok and action in READ_ACTIONS:
        detail("tool.result", "applied", "-", **fields)
    else:
        evt("tool.result", "applied" if ok else "refused", "-" if ok else code, **fields)
    return reply


# -- version ------------------------------------------------------------------

_version: dict[str, str] | None = None


def version() -> dict[str, str]:
    """Plugin version, a content hash of its source files and the git commit when one is visible."""
    global _version
    if _version is not None:
        return _version
    here = Path(__file__).resolve().parent
    result: dict[str, str] = {}
    try:
        for line in (here / "plugin.yaml").read_text().splitlines():
            if line.startswith("version:"):
                result["ver"] = line.split(":", 1)[1].strip()
    except OSError:
        pass
    digest = hashlib.sha256()
    try:
        for path in sorted(here.glob("*.py")):
            digest.update(path.name.encode() + b"\0" + path.read_bytes())
        result["sha"] = digest.hexdigest()[:8]
    except OSError:
        pass
    commit = _git_commit(here)
    if commit:
        result["commit"] = commit[:12]
    _version = result
    return result


def _git_commit(start: Path) -> str | None:
    """Read HEAD without running git; plugins are often mounted from a checkout."""
    for parent in (start, *start.parents[:4]):
        dot = parent / ".git"
        try:
            if dot.is_file():
                text = dot.read_text().strip()
                if not text.startswith("gitdir:"):
                    return None
                dot = (parent / text.split(":", 1)[1].strip()).resolve()
            if not dot.is_dir():
                continue
            head = (dot / "HEAD").read_text().strip()
            if not head.startswith("ref:"):
                return head if re.fullmatch(r"[0-9a-f]{40}", head) else None
            ref = head.split(":", 1)[1].strip()
            common = dot
            if (dot / "commondir").is_file():
                common = (dot / (dot / "commondir").read_text().strip()).resolve()
            for base in (dot, common):
                if (base / ref).is_file():
                    value = (base / ref).read_text().strip()
                    return value if re.fullmatch(r"[0-9a-f]{40}", value) else None
            packed = common / "packed-refs"
            if packed.is_file():
                for line in packed.read_text().splitlines():
                    if line.endswith(" " + ref) and re.fullmatch(r"[0-9a-f]{40}", line.split(" ", 1)[0]):
                        return line.split(" ", 1)[0]
            return None
        except OSError:
            return None
    return None
