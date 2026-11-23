"""Read-only native owner receipts for one current admission. References confer no permission.

Shared by the worker's ``work_reference`` (work.py) and live worker steps (worker_progress.py):
it discovers the existing gateway owner (never launches one), reads the session's one current
admission and checks the owner's ``prompt.receipt`` for it.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from .transport import Unavailable

VERSION = 1
REFERENCE_FIELDS = frozenset({"version", "profile", "admission_id",
                              "instance_id", "authority_epoch", "execution_generation", "scope_digest"})


def _refuse(message: str = "The originating native request is not current and independently verifiable."):
    raise Unavailable(message)


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def scope(settings: dict[str, Any]) -> dict[str, Any]:
    """Only declared non-secret limits; neither identity nor limits grant permission."""
    from . import BoundLinearAPI
    identity = settings.get("identity") or {}
    if not isinstance(identity, dict):
        _refuse("The configured Linear identity cannot be inspected.")
    selected = {key: identity[key] for key in ("organization_id", "teams", "projects") if key in identity}
    try:
        projected = {"linear": selected,
                     "specialist_scope": BoundLinearAPI._validate_specialist_scope(settings.get("specialist_scope"))}
        return json.loads(json.dumps(projected))
    except (ValueError, TypeError) as exc:
        raise Unavailable("The configured requester scope cannot be independently inspected.") from exc


def reference(value: Any) -> dict:
    if (not isinstance(value, dict) or set(value) != REFERENCE_FIELDS
            or type(value.get("version")) is not int or value["version"] != VERSION):
        _refuse("Use the complete reference returned by the current native tool invocation.")
    if (any(not isinstance(value[k], str) or not value[k] or len(value[k]) > 4096
            for k in REFERENCE_FIELDS - {"version", "authority_epoch", "execution_generation"})
            or any(type(value[k]) is not int or value[k] < 1
                   for k in ("authority_epoch", "execution_generation"))):
        _refuse("The native origin reference is malformed.")
    return dict(value)


@asynccontextmanager
async def _client(home: Path):
    """Discover an existing owner only: never launch, recover, or replace a gateway."""
    from hermes_cli.gateway_client import connect_gateway
    from hermes_cli.gateway_runtime import discover_gateway_endpoint, gateway_profile_home
    ready = await asyncio.to_thread(discover_gateway_endpoint, home)
    endpoint = ready.endpoint
    if (ready.state != "ready" or endpoint is None
            or Path(endpoint.profile_id).resolve() != gateway_profile_home(home)):
        _refuse("The existing native owner is unavailable; no runtime was started.")
    async with connect_gateway(endpoint=endpoint) as client:
        yield client, endpoint


async def _snapshot(client, home: Path, session_id: str) -> tuple[dict, dict]:
    snapshot, row = await asyncio.to_thread(read_current, home, session_id)
    receipt = await client.rpc("prompt.receipt", session_id=snapshot["session_id"], admission_id=row["admission_id"])
    if (receipt.get("status") != "started" or receipt.get("outcome") is not None
            or any(receipt.get(k) != row.get(k) for k in
                   ("admission_id", "authority_epoch", "execution_generation"))
            or receipt.get("ref", {}).get("session_id") != snapshot["session_id"]
            or receipt.get("ref", {}).get("profile_id") != str(home)):
        _refuse()
    return snapshot, row


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
