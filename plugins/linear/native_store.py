"""Read-only access to the native owner's state through the Agent's storage interface.

Every read goes through ``persistence_assembly`` and the ``persistence`` contracts (never a backend module). Records
are returned as the plain dicts the evidence code compares, so a changed field is a visible mismatch and a refusal
stays a refusal. Imports of Agent modules are deferred to call time: importing this module activates nothing.
"""
from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterator

_CHAIN_CAP = 1000  # the native lineage walk's bound; an exhausted walk is storage_unavailable, never a partial set


def refusal(reason: str):
    from persistence.core.errors import AuthorityRefusal
    return AuthorityRefusal(reason)


def refusal_type():
    from persistence.core.errors import AuthorityRefusal
    return AuthorityRefusal


@contextmanager
def reader(home: Path) -> Iterator[Any]:
    """An owned read-only storage handle on ``home``'s ``state.db``; it never creates, migrates or repairs."""
    from persistence_assembly import open_persistence_reader
    with open_persistence_reader(Path(home) / "state.db") as store:
        yield store


@contextmanager
def read_ctx(home: Path) -> Iterator[sqlite3.Connection]:
    """One read-only snapshot of ``state.db`` for the table-level checks the contracts do not offer."""
    path = Path(home) / "state.db"
    try:
        from hermes_cli.sqlite_safe_read import connect_tracked as connect
    except ImportError:  # an Agent without the tracking helper
        connect = sqlite3.connect
    conn = connect(path.as_uri() + "?mode=ro", uri=True, isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        yield conn
    finally:
        conn.close()


def text(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise refusal("invalid_params")
    return value


def json_object(value):
    if not isinstance(value, dict):
        raise refusal("invalid_params")
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise refusal("invalid_params") from exc


def admission_row(record) -> dict | None:
    """An admission record as the dict the evidence code reads; ``None`` stays ``None``."""
    if record is None:
        return None
    return {"seq": record.seq, "admission_id": record.admission_id, "request_id": record.request_id,
            "principal_id": record.principal_id, "target_session_id": record.target_session_id,
            "payload": dict(record.payload) if isinstance(record.payload, Mapping) else record.payload, "intent": str(record.intent.value), "status": str(record.status.value),
            "outcome": record.outcome, "owner_epoch": record.owner_epoch, "generation": record.generation}


def _undecodable(exc: ValueError) -> None:
    """Re-raise a refusal; only a row the typed record could not be built from falls back to the raw read."""
    if isinstance(exc, refusal_type()):
        raise exc


def _raw_admissions(store, where: str, args: tuple) -> list[dict]:
    """Rows as stored, undecoded beyond their payload: the fallback when the typed record refuses a row.

    A malformed historical or foreign row must not hide the one selected row, and the selected row's own header is
    validated by its consumer; so a row the contract cannot build is still read, never repaired or skipped."""
    with read_ctx(Path(store.scope.profile_dir)) as conn:
        out = []
        for row in conn.execute(f"SELECT * FROM session_admissions WHERE {where} ORDER BY seq", args):
            item = dict(row)
            item["payload"] = json.loads(item.pop("payload_json"))
            for key in ("payload_digest", "lineage_json", "retired_at"):
                item.pop(key, None)
            out.append(item)
        return out


def get_admission(store, admission_id: str) -> dict | None:
    try:
        return admission_row(store.admissions.get(admission_id=admission_id))
    except ValueError as exc:
        _undecodable(exc)
        rows = _raw_admissions(store, "admission_id=?", (admission_id,))
        return rows[0] if rows else None


def find_admission(store, *, principal_id: str, session_id: str, request_id: str) -> dict | None:
    try:
        return admission_row(store.admissions.find(principal_id=principal_id, session_id=session_id,
                                                   request_id=request_id))
    except ValueError as exc:
        _undecodable(exc)
        rows = _raw_admissions(store, "principal_id=? AND target_session_id=? AND request_id=?",
                               (principal_id, session_id, request_id))
        return rows[0] if rows else None


def list_admissions(store, session_id: str, *, pending_only: bool = False) -> list[dict]:
    try:
        return [admission_row(r) for r in store.admissions.list(session_id=session_id, pending_only=pending_only)]
    except ValueError as exc:
        _undecodable(exc)
        where = "target_session_id=?" + (" AND status IN ('queued','started','unknown')" if pending_only else "")
        return _raw_admissions(store, where, (session_id,))


def receipt_dict(binding) -> dict:
    out = {"profile_id": binding.profile_id, "principal_id": binding.principal_id, "request_id": binding.request_id,
           "session_id": binding.session_id, "route": binding.route, "entry": dict(binding.entry),
           "policy": dict(binding.policy), "lineage": list(binding.lineage)}
    if binding.legacy_session_id is not None:
        out["legacy_session_id"] = binding.legacy_session_id
    return out


def local_receipt(store, session_id: str) -> dict:
    """The stored creation receipt; absent or undecodable is a ``storage_unavailable`` refusal."""
    return receipt_dict(store.bindings.receipt(session_id))


def local_identity(profile_id, principal_id, request_id) -> str:
    from persistence.authority.bindings import local_session_id
    return str(local_session_id(profile_id, principal_id, request_id))


def session_row(store, session_id: str) -> dict | None:
    record = store.sessions.get(session_id)
    return None if record is None else record.as_session_row()


def canonical_owner(store, session_id: str) -> str:
    """The compression root, then the local reset owner: the session a native admission is held against."""
    lineage = store.lineage.lineage(session_id)
    return str(store.bindings.lineage_owner(lineage[0] if lineage else session_id))


def _physical_target(store, session_id: str) -> str:
    if not store.bindings.binding_marks(session_id).policy:
        return session_id
    receipt = store.bindings.receipt(session_id)
    if receipt.session_id != session_id:
        raise refusal("storage_unavailable")
    return str(store.bindings.validate_lineage(receipt))


def runtime_lineage(store, session_id: str) -> set[str]:
    """Every physical session of one logical conversation: its local owner's current transcript, the owner a segment's
    ``chat_id`` names while that receipt's lineage holds it, closed over compression continuations both ways."""
    targets = {session_id, _physical_target(store, session_id)}
    record = store.sessions.get(session_id)
    chat = getattr(record, "chat_id", None) if record is not None else None
    if chat and store.bindings.binding_marks(chat).policy and session_id in store.bindings.receipt(chat).lineage:
        targets.update({chat, _physical_target(store, chat)})
    frontier = list(targets)
    for _ in range(_CHAIN_CAP):
        found: set[str] = set()
        for sid in frontier:
            chain = store.lineage.lineage(sid)
            root = chain[0] if chain else sid
            found.update(chain)
            found.update(edge.session_id for edge in store.sessions.descendants(root))
        frontier = sorted(found - targets)
        if not frontier:
            return targets
        targets.update(frontier)
    raise refusal("storage_unavailable")


def linked_worker_admission(conn, session_id, generation, owner_epoch, statuses):
    """The one admission of ``(generation, owner_epoch)`` in ``statuses`` held against ``session_id`` or its lineage."""
    placeholders = ",".join("?" for _ in statuses)
    rows = conn.execute(f"""SELECT * FROM session_admissions
        WHERE generation=? AND owner_epoch=? AND status IN ({placeholders})
          AND (target_session_id=? OR EXISTS (
              SELECT 1 FROM json_each(session_admissions.lineage_json) WHERE value=?
          )) ORDER BY seq""", (generation, owner_epoch, *statuses, session_id, session_id)).fetchall()
    if len(rows) > 1:
        raise refusal("admission_conflict")
    return rows[0] if rows else None


def session_row_raw(conn, session_id):
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if row is None:
        raise refusal("not_found")
    return row


def descendant_range(execution_id):
    """``(low, high)`` bounds every descendant id of ``execution_id`` on the primary key index
    (';' sorts right after the separator's ':')."""
    from persistence.workers.vocabulary import CHILD_SEPARATOR
    return execution_id + CHILD_SEPARATOR, execution_id + CHILD_SEPARATOR[:-1] + ";"
