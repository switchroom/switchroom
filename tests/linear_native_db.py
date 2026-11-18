"""Test-side adapter from the native-origin fixtures to the Agent's storage interface.

The origin scenarios drive the owner's store the way the owner does: admissions, claims, settlements, worker
executions, creation receipts. ``NativeDb`` presents those verbs over a ``persistence`` handle (the handle the
authority was built with) and keeps a raw writer connection for fixtures that deliberately corrupt retained rows,
which no contract offers. Production code never imports this module.
"""
from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
import sqlite3
import time

POLICY_PREFIX = "gateway.local_policy.v1:"  # the stored key of a creation receipt (an opaque fixture constant)


def refusal_type():
    from persistence.core.errors import AuthorityRefusal
    return AuthorityRefusal


def _p(db):
    """The storage handle of a fixture adapter, or the handle itself."""
    return getattr(db, "persistence", db)


def row_dict(record):
    """An admission record as the dict the scenarios read."""
    if record is None:
        return None
    out = {"seq": record.seq, "admission_id": record.admission_id, "request_id": record.request_id,
           "principal_id": record.principal_id, "target_session_id": record.target_session_id,
           "payload": dict(record.payload) if isinstance(record.payload, Mapping) else record.payload, "intent": record.intent.value, "status": record.status.value,
           "outcome": record.outcome, "owner_epoch": record.owner_epoch, "generation": record.generation}
    for key in ("transcript_mark", "queued_owner_epoch"):
        if hasattr(record, key):
            out[key] = getattr(record, key)
    return out


class NativeDb:
    def __init__(self, persistence, home):
        self.persistence = persistence
        self.home = home
        self.db_path = home / "state.db"
        self._raw = None

    def __getattr__(self, name):
        # The storage interface's repositories (admissions, state_meta, ...) as the plugin's readers take them.
        return getattr(self.persistence, name)

    # -- raw fixture access -------------------------------------------------------------------------------------
    @property
    def _conn(self):
        if self._raw is None:
            persistence = self.persistence
            persistence.ready()  # the store exists before a raw connection opens
            self._raw = sqlite3.connect(self.db_path, isolation_level=None, timeout=30, check_same_thread=False)
            self._raw.row_factory = sqlite3.Row
        return self._raw

    def close(self):
        if self._raw is not None:
            self._raw.close()
            self._raw = None

    def _execute_write(self, fn):
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            result = fn(conn)
            conn.execute("COMMIT")
            return result
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    def _read_all(self, sql, args=()):
        return self._conn.execute(sql, args).fetchall()

    def _read_one(self, sql, args=()):
        return self._conn.execute(sql, args).fetchone()

    @contextmanager
    def _read_ctx(self):
        conn = sqlite3.connect(self.db_path.as_uri() + "?mode=ro", uri=True, isolation_level=None, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("BEGIN")
            yield conn
        finally:
            conn.close()

    # -- store verbs --------------------------------------------------------------------------------------------
    def set_meta(self, key, value):
        if not key:  # the contract refuses an empty key; the retired writer stored opaque text keys
            self._execute_write(lambda c: c.execute("INSERT OR REPLACE INTO state_meta(key, value) VALUES (?,?)", (key, value)))
            return
        self.persistence.state_meta.set(key, value)

    def get_meta(self, key):
        return self.persistence.state_meta.get(key)

    def create_session(self, session_id, *, source, parent_session_id=None, chat_id=None):
        """A bare session row, as the retired constructor wrote it: no lineage marker, no counters."""
        self.persistence.ready()
        self._execute_write(lambda c: c.execute(
            "INSERT OR IGNORE INTO sessions(id, source, parent_session_id, chat_id, started_at) VALUES (?,?,?,?,?)",
            (session_id, source, parent_session_id, chat_id, time.time())))

    def get_session(self, session_id):
        record = self.persistence.sessions.get(session_id)
        return None if record is None else record.as_session_row()

    def update_session_meta(self, session_id, raw):
        self._execute_write(lambda c: c.execute("UPDATE sessions SET model_config=? WHERE id=?", (raw, session_id)))

    def update_session_cwd(self, session_id, cwd):
        self.persistence.sessions.update_cwd(session_id, cwd)

    def append_message(self, session_id, role, content):
        from persistence.conversation.messages import NewMessage
        return self.persistence.messages.append(session_id, NewMessage(role=role, content=content))

    def get_compression_lineage(self, session_id):
        return list(self.persistence.lineage.lineage(session_id))

    def publish_compression_child(self, *, parent_session_id, child_session_id, source, messages, model=None,
                                  model_config=None, system_prompt=None, cwd=None, profile_name=None, **options):
        from persistence.conversation.lineage import CompressionChild
        from persistence.conversation.messages import NewMessage
        child = CompressionChild(session_id=child_session_id, source=source, model=model, model_config=model_config,
                                 system_prompt=system_prompt, cwd=cwd, profile_name=profile_name)
        return self.persistence.lineage.publish_compression_child(
            parent_session_id, child, [NewMessage(role=m["role"], content=m["content"]) for m in messages], **options)


# -- the retired module-level verbs, over the storage interface --------------------------------------------------
def begin_runtime_epoch(db, *, instance_id):
    return _p(db).runtime.begin_epoch(instance_id=instance_id)


def admit_session_input(db, *, epoch, principal_id, session_id, request_id, payload, intent="queue"):
    record, _created = _p(db).admissions.admit(epoch=epoch, principal_id=principal_id, session_id=session_id,
                                                       request_id=request_id, payload=payload, intent=intent)
    return row_dict(record)


def claim_session_input(db, *, epoch, session_id, **options):
    claimed = _p(db).admissions.claim(epoch=epoch, session_id=session_id, **options)
    return row_dict(claimed) if claimed not in (None, False) else claimed


def settle_session_input(db, *, epoch, admission_id, generation, outcome, result=None, _transfers=None):
    return row_dict(_p(db).admissions.settle(epoch=epoch, admission_id=admission_id, generation=generation,
                                                     outcome=outcome, result=result, transfers=_transfers))


def cancel_session_input(db, *, epoch, admission_id):
    return row_dict(_p(db).admissions.cancel(epoch=epoch, admission_id=admission_id))


def steer_session_input(db, *, epoch, admission_id, generation):
    record, created = _p(db).admissions.steer(epoch=epoch, admission_id=admission_id, generation=generation)
    return row_dict(record), created


def recover_session_inputs(db, *, epoch):
    return _p(db).admissions.recover(epoch=epoch)


def resolve_unknown_session_input(db, *, epoch, admission_id, generation, **options):
    return row_dict(_p(db).admissions.resolve_unknown(epoch=epoch, admission_id=admission_id,
                                                              generation=generation, **options))


def find_session_admission(db, *, principal_id, session_id, request_id):
    return row_dict(_p(db).admissions.find(principal_id=principal_id, session_id=session_id,
                                                   request_id=request_id))


def get_session_admission(db, *, admission_id):
    return row_dict(_p(db).admissions.get(admission_id=admission_id))


def list_session_admissions(db, *, session_id, pending_only=True):
    return [row_dict(r) for r in _p(db).admissions.list(session_id=session_id, pending_only=pending_only)]


def register_worker_execution(db, *, kind, **args):
    from persistence.workers.executions import WorkerKind
    try:
        kind = WorkerKind(kind)
    except ValueError as exc:
        raise refusal_type()("invalid_params") from exc
    return _p(db).worker_executions.register(kind=kind, **args)


def adopt_worker_execution(db, **args):
    return _p(db).worker_executions.adopt(**args)


def mutate_worker_execution(db, *, epoch, execution_id, session_id, generation, sequence, operation, payload):
    return _p(db).worker_executions.persist_operation(
        epoch=epoch, execution_id=execution_id, session_id=session_id, generation=generation, sequence=sequence,
        operation=operation, payload=payload)


def reserve_child(db, *, epoch, execution_id, session_id, generation, sequence, secret, profile_id, pid, birth,
                  principal, limits=(1, 1), refused=None):
    reservation = _p(db).worker_executions.reserve_child(
        epoch=epoch, execution_id=execution_id, session_id=session_id, generation=generation, sequence=sequence,
        secret=secret, profile_id=profile_id, pid=pid, birth=birth, principal=principal,
        max_concurrent_children=limits[0], max_spawn_depth=limits[1], refused=refused)
    child = reservation.child
    return None if child is None else {"session_id": child.session_id, "execution_id": child.execution_id,
                                       "generation": child.generation}


def local_receipt(db, session_id):
    from persistence.authority.bindings import SessionBinding  # noqa: F401  (the receipt's contract type)
    binding = _p(db).bindings.receipt(session_id)
    out = {"profile_id": binding.profile_id, "principal_id": binding.principal_id, "request_id": binding.request_id,
           "session_id": binding.session_id, "route": binding.route, "entry": dict(binding.entry),
           "policy": dict(binding.policy), "lineage": list(binding.lineage)}
    if binding.legacy_session_id is not None:
        out["legacy_session_id"] = binding.legacy_session_id
    return out


def local_physical_target(db, session_id):
    bindings = _p(db).bindings
    if not bindings.binding_marks(session_id).policy:
        return session_id
    return str(bindings.validate_lineage(bindings.receipt(session_id)))


def reset_local_target(db, *, epoch, parent_session_id, entry):
    return _p(db).bindings.reset_target(epoch=epoch, parent_session_id=parent_session_id, entry=entry)


def commit_local_session(db, *, epoch, receipt):
    from gateway.session_local import commit_local_session as commit
    return commit(_p(db), epoch=epoch, receipt=receipt)


def __getattr__(name):
    # ``RuntimeStoreError`` is the storage interface's refusal; resolved on first use so this module imports
    # without an Agent on the path (the plain unit suite skips the native scenarios).
    if name == "RuntimeStoreError":
        return refusal_type()
    raise AttributeError(name)


def _json(value):
    from hermes_fleet_linear_plugin.native_store import json_object
    return json_object(value)


def local_identity(profile_id, principal_id, request_id):
    from hermes_fleet_linear_plugin.native_store import local_identity as identity
    return identity(profile_id, principal_id, request_id)


def linked_worker_admission(conn, session_id, generation, owner_epoch, statuses):
    from hermes_fleet_linear_plugin.native_store import linked_worker_admission as linked
    return linked(conn, session_id, generation, owner_epoch, statuses)


def _import_legacy_row(conn, row, epoch, principal_id):
    """A legacy terminal admission row as the retired import wrote it (retained-schema fixture)."""
    import hashlib
    import json
    payload = json.loads(row["payload"])
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    intent = payload.get("intent", "queue")
    intent = "redirect" if intent == "interrupt" else intent
    status = "unknown" if row["status"] == "started" else row["status"]
    target = row["target_session_id"]
    generation = row["generation"]
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    conn.execute("""INSERT INTO session_admissions(admission_id,request_id,principal_id,
        target_session_id,lineage_json,payload_json,payload_digest,intent,status,outcome,owner_epoch,generation)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (row["admission_id"], row["admission_id"], principal_id, target,
                                            json.dumps([target]), encoded, digest, intent, status, row["outcome"],
                                            epoch, generation))
    if generation is not None:
        conn.execute("UPDATE sessions SET runtime_generation=MAX(runtime_generation,?) WHERE id=?", (generation, target))
