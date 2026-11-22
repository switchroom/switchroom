"""Read-only projection of one native request; imports never activate a runtime or credentials."""
from __future__ import annotations
import json
from pathlib import Path
from .transport import NativeContext, Unavailable

# Core's interactive local surfaces (gateway/session_queued_controls.py). "desktop" is the stored
# label a Desktop chat keeps after the owner adopts it from main.
INTERACTIVE_SOURCES = frozenset({"cli", "tui", "gui", "desktop", "acp"})


def _no_stop_checkpoint(_store, _session_id) -> None:
    return None


def stop_checkpoint_reader():
    """Core's pending-Stop reader, or None when this core cannot answer.

    A core with the durable process-Stop fence exposes ``process_stop_pending``. A core whose Stop is
    the native interrupt plus a best-effort kill (``stop_session_processes``, no fence) never has a
    pending checkpoint, so it reads as clear. A core with neither cannot answer: absence is never false.
    """
    from gateway import session_ancillary
    getter = getattr(session_ancillary, "process_stop_pending", None)
    if getter is not None:
        return getter
    if callable(getattr(session_ancillary, "stop_session_processes", None)):
        return _no_stop_checkpoint
    return None


def stop_evidence(home: Path, session_id: str) -> dict:
    """Read the existing core cleanup checkpoint when supported; absence is never false."""
    getter = stop_checkpoint_reader()
    if getter is None:
        return {"state": "unknown", "source": "native_stop_checkpoint_unavailable", "quiescence_proven": False}
    if getter is _no_stop_checkpoint:
        return {"state": "clear", "source": "native_stop_without_checkpoint", "quiescence_proven": False}
    from . import native_store
    with native_store.reader(home) as store:
        pending = getter(store, session_id)
    if pending is not None:
        _refuse("The native owner has a pending Stop checkpoint; current origin evidence is refused.")
    return {"state": "clear", "source": "native_process_stop_checkpoint", "quiescence_proven": False}


def _refuse(message="The originating native request is not current and independently verifiable."):
    raise Unavailable(message)


def current_admission(row: dict | None) -> dict:
    """Validate only the selected active row against its native writer/claim contract."""
    from .native_store import text, json_object
    if row is None:
        _refuse()
    for key in ("admission_id", "request_id", "principal_id", "target_session_id"):
        text(row[key])
    json_object(row["payload"])
    if (row["intent"] not in ("queue", "steer", "redirect")
            or any(type(row[key]) is not int or row[key] < 1 for key in ("seq", "owner_epoch", "generation"))
            or row["status"] != "started" or row["outcome"] is not None):
        _refuse("The current native admission contract is unavailable.")
    return {key: row[key] for key in ("admission_id", "request_id", "principal_id", "target_session_id",
                                     "seq", "intent", "owner_epoch", "generation", "status", "outcome")}


def resolve_reference(home: Path, ref: dict) -> str:
    """Resolve private logical coordinates only from this owner's exact native admission."""
    from . import native_store
    with native_store.reader(home) as db:
        row = native_store.get_admission(db, ref["admission_id"])
        current_admission(row)
        if (row["owner_epoch"] != ref["authority_epoch"]
                or row["generation"] != ref["execution_generation"]):
            _refuse()
        return row["target_session_id"]


def _policy(db, session_id: str, platform: str) -> dict:
    if platform != "local":
        return {"source": platform}
    from .native_store import local_receipt
    from gateway.session_policy import restore_policy
    policy = restore_policy(local_receipt(db, session_id)["policy"])
    if policy.source not in INTERACTIVE_SOURCES:
        _refuse("Producer and peer sessions cannot supply a human origin reference.")
    return {"source": policy.source, "cwd": policy.cwd, "toolsets": list(policy.toolsets),
            "safe_mode": policy.safe_mode}


def _evidence(home: Path, ref: dict, current: dict, declared_scope: dict,
              context: NativeContext | None) -> dict:
    """Read exactly one native admission, using the owner's native read-only state API."""
    from . import native_store
    from .native_store import json_object as _json
    from gateway.session_operator import is_viewer_input
    from agent.turn_author import parse_turn_author
    with native_store.reader(home) as db:
        sid = current["session_id"]
        row = native_store.get_admission(db, ref["admission_id"])
        if current_admission(row) != current["admission_header"]:
            _refuse()
        if (row["target_session_id"] != sid
                or row["request_id"] != current["input_id"] or row["owner_epoch"] != ref["authority_epoch"]
                or row["generation"] != ref["execution_generation"]):
            _refuse()
        payload = row["payload"]
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 16384 or text != current.get("text"):
            _refuse("The exact original native text cannot be inspected within this bounded request.")
        for key in ("local_automation_v1", "cron_v1", "kanban_card_v1"):
            if key in payload:
                _refuse("Automation cannot supply a human origin reference.")
        for key in ("cli_turn_v1", "api_turn_v1"):
            data = payload.get(key)
            if data is not None:
                _json(data)
            author = parse_turn_author(data.get("turn_author") if data is not None else None)
            if author and author.get("is_bot"):
                _refuse("Bot-authored input cannot supply a human origin reference.")
        requester = {"principal_id": row["principal_id"]}
        if "native_text_v1" in payload:
            native = payload["native_text_v1"]
            _json(native)
            source, event = native["source"], native["event"]
            _json(source)
            _json(event)
            platform = source.get("platform")
            identity = [source.get(k) for k in ("profile", "platform", "chat_id", "thread_id", "user_id")]
            linear = platform == "linear"
            if (platform not in {"telegram", "slack", "linear"} or source.get("is_bot") is not False
                    or not source.get("user_id") or event.get("allow_gateway_control") is not (False if linear else True)
                    or "automation" in native or event.get("inherit_channel_pin") is True
                    or event.get("structured_control") is not None or "native_stop_v1" in payload
                    or row["principal_id"] != "messaging:" + json.dumps(identity, separators=(",", ":"))):
                _refuse("The admission is not ordinary authenticated human messaging input.")
            requester.update(kind="messaging", platform=platform, user_id=source["user_id"],
                             chat_id=source.get("chat_id"), thread_id=source.get("thread_id"),
                             scope_id=source.get("scope_id"))
            if linear:
                message = event.get("message_id")
                if (any(not isinstance(source.get(k), str) or not source[k] for k in ("scope_id", "chat_id", "thread_id"))
                        or message is not None and (not isinstance(message, str) or not message or len(message) > 4096)
                        or source.get("message_id") != message or event.get("user_id") != source["user_id"]
                        or source["scope_id"] != declared_scope["linear"].get("organization_id")):
                    _refuse("The native Linear input has no exact provider message/source identity.")
                requester["message_id"] = message
            if context and (context.platform != platform or context.session_key != native.get("route")
                            or any(getattr(context, k) != str(source.get(k) or "")
                                   for k in ("user_id", "chat_id", "thread_id", "scope_id"))):
                _refuse("The captured caller does not match the admitted native message.")
        elif "api_turn_v1" in payload:
            from gateway.session_api_turn import _valid_transfer_auth
            data = payload["api_turn_v1"]
            _json(data)
            auth = data.get("transfer_auth")
            settings = data.get("settings")
            if settings is not None:
                _json(settings)
            settings = settings if settings is not None else {}
            if (row["principal_id"] != "api" or not _valid_transfer_auth(auth)
                    or settings.get("room_dispatch") is not None
                    or settings.get("room_execution_policy") is not None):
                _refuse("The API admission has no independently attributable ordinary credential principal.")
            platform = "api_server"
            requester.update(kind="api_credential", **auth)
            if context and context.platform != platform:
                _refuse()
        elif is_viewer_input(row):
            local_receipt = native_store.local_receipt
            platform = "local"
            stamp = payload.get("local_operator_v1")
            owner = local_receipt(db, sid)
            if (stamp is None and row["principal_id"] != owner.get("principal_id")
                    or stamp is not None and stamp != {"profile_id": str(home), "session_id": sid,
                                                       "principal_id": row["principal_id"]}):
                _refuse()
            requester.update(kind="local_principal", platform=platform)
            if context and context.platform != platform:
                _refuse()
        else:
            _refuse("The admission is not ordinary native requester input.")
        stored = native_store.session_row(db, sid)
        if not stored or stored.get("source") not in ({platform} if platform != "local" else INTERACTIVE_SOURCES | {"local"}):
            _refuse("The stored session is not an eligible requester surface.")
        policy = _policy(db, sid, platform)
        policy["profile"] = ref["profile"]
        if platform != "local" and stored.get("cwd"):
            policy["cwd"] = stored["cwd"]
    return {"reference": ref, "requester": requester, "original_message": text,
            "policy": policy, "scope": declared_scope, "permission_granted": False}


def read_current(home: Path, session_id: str) -> tuple[dict, dict]:
    """Only this session's lineage and admission state; no transcript, config or tool inventory."""
    from . import native_store
    with native_store.reader(home) as db:
        # Match the native admission owner: compression root, then local reset owner.
        canonical = native_store.canonical_owner(db, session_id)
        session = native_store.session_row(db, canonical)
        if session is None:
            _refuse()
        # Native steering transfers are terminal rows held against the active generation.
        # The native list API includes them only with pending_only=False. Never return them.
        rows = native_store.list_admissions(db, canonical, pending_only=False)
        generation = session.get("runtime_generation")
        started = [r for r in rows if r["status"] == "started" and r.get("generation") == generation]
        if type(generation) is not int or generation < 1 or len(started) != 1:
            _refuse("The originating turn is not current, or has ambiguous steering.")
        row = started[0]
        header = current_admission(row)
        # Authenticate this owner/generation only. Historical uncertainty remains the native
        # owner's responsibility; it is not a blanket refusal of a newly admitted request.
        same_claim = [r for r in rows if r.get("generation") == generation and r.get("owner_epoch") == row["owner_epoch"]]
        if (row["outcome"] is not None or any(r["status"] == "unknown"
                or r.get("outcome") in {"steering", "steered"} for r in same_claim)):
            _refuse()
        snapshot = {"session_id": canonical, "authority_epoch": row["owner_epoch"], "execution_generation": generation}
        current = {"admission_id": row["admission_id"], "input_id": row["request_id"],
                   "authority_epoch": row["owner_epoch"], "execution_generation": row["generation"],
                   "text": row["payload"].get("text"), "admission_header": header}
        return snapshot, current
