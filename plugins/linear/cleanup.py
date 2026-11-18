"""Owner-CLI-only, read-only cleanup evidence for an existing Linear/native binding."""
from __future__ import annotations

import asyncio
from contextlib import closing, contextmanager
import hashlib
import json
import os
import re
import stat
from pathlib import Path
import sqlite3
import uuid

from . import diag, origin
from .transport import Unavailable, native_json_object


# task_runs' documented schema plus ended-run values written by native
# kanban_db (_end_run/_synthesize_ended_run), kanban_db_controls and
# kanban_db_dispatch (_DeadWorker/_record_task_failure). This is evidence
# validation only: unfamiliar future native states require native reconciliation.
_SETTLED_RUN_STATUSES = frozenset({
    "done", "blocked", "crashed", "timed_out", "failed", "released",
    "reclaimed", "stale", "rate_limited", "spawn_failed", "gave_up",
    "review", "ready", "todo", "scheduled", "completed", "review_requested",
})


# Native admission writers (the storage interface's settle, cancel and steer transfers). STEERING is in-flight even
# though its row is terminal; unknown or future outcomes are not settlement.
_SETTLED_ADMISSION_OUTCOMES = frozenset({
    "completed", "interrupted", "rejected", "failed", "cancelled", "steered",
})

# Plain statement of the fact a worker-fate hold needs, for the agent to pass on.
HOLD_FACTS = {
    "old_worker_alive": "A process from the earlier attempt is still running here. "
                        "It has to stop before the work can be taken over.",
    "old_gateway_alive": "A process here may be the one that started the earlier attempt, so that attempt "
                         "may still be running. Confirm the earlier attempt has stopped before the work is taken over.",
    "worker_instance_not_earlier": "The earlier attempt ran in another running copy of this agent, "
                                   "not one that has since restarted. That copy has to be confirmed stopped first.",
    "old_instance_unproven": "The earlier attempt ran before a restart, but its record does not yet show that "
                             "everything it started has ended. Confirm that before the work is taken over.",
    "worker_identity_unreadable": "This agent cannot read its own process identity right now, so it cannot tell "
                                  "whether the earlier attempt is still running. Check again shortly.",
    "restart_proof_unsupported": "This agent's version cannot yet confirm that work from before a restart has ended. "
                                 "Update the agent, then check again.",
    "issue_metadata_required": "The check needs the issue's id, key and link to match the task to it. Pass them with "
                               "--issue-json from a fresh Linear status read, then check again.",
}

# A Linear issue key ("ABC-12"). The selector names the issue; only its UUID keys native records.
_ISSUE_KEY = re.compile(r"[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}")

# Optional host lifecycle evidence. Core's own restart proof (attempt_instance_replaced)
# comes first; this host receipt is read only when that proof does not hold, which in
# practice means an older core without it. Like core, this check assumes one live
# instance per home (each container its own volume): a home shared by two live
# containers is unsupported, and a receipt does not make it safe. It shares the existing
# protected per-profile ingress mount. These are immutable physical facts, never
# execution or consent grants.
NAMESPACE_DISPOSITION_DIRECTORY = "namespace-dispositions"
NAMESPACE_DISPOSITION_VERSION = 1
NAMESPACE_DISPOSITION_MAX_BYTES = 16384
NAMESPACE_DISPOSITION_FIELDS = frozenset({
    "version", "kind", "deployment_profile", "native_profile", "home", "home_dev", "home_ino",
    "epoch", "container_id", "host_pid1", "pid1_start_ticks", "pid_namespace_inode",
    "host_pid_namespace_inode", "pid_mode", "old_instance_disposed", "pid1_gone",
})


class Unknown(RuntimeError):
    pass


def _require(value, reason):
    if not value:
        raise Unknown(reason)


def _namespace_disposition_path(ingress, epoch):
    directory = Path(ingress).parent / NAMESPACE_DISPOSITION_DIRECTORY
    return directory / (hashlib.sha256(epoch.encode("utf-8")).hexdigest() + ".json")


def _namespace_disposition(ingress, home, deployment_profile, native_profile, epoch):
    """Read only the host-owned receipt in this profile's protected inbox."""
    _require(all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")),
             "namespace_disposition_unsupported")
    path = _namespace_disposition_path(ingress, epoch)
    _require(path.is_absolute() and ".." not in path.parts, "namespace_disposition_unavailable")
    descriptors = []
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(path.anchor, flags)
        descriptors.append(fd)
        for index, part in enumerate(path.parts[1:-1]):
            info = os.fstat(fd)
            _require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                     "namespace_disposition_custody_unproven")
            fd = os.open(part, flags, dir_fd=fd)
            descriptors.append(fd)
            if index >= len(path.parts) - 4:  # Protected profile and receipt directories.
                info = os.fstat(fd)
                _require(info.st_uid == 0 and info.st_gid == 1000
                         and stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o750,
                         "namespace_disposition_custody_unproven")
        info = os.fstat(fd)
        _require(info.st_uid == 0 and stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022,
                 "namespace_disposition_custody_unproven")
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
        descriptors.append(fd)
        info = os.fstat(fd)
        _require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 1000
                 and stat.S_IMODE(info.st_mode) == 0o440 and info.st_nlink == 1
                 and 0 < info.st_size <= NAMESPACE_DISPOSITION_MAX_BYTES,
                 "namespace_disposition_custody_unproven")
        raw = os.read(fd, info.st_size + 1)
        _require(len(raw) == info.st_size, "namespace_disposition_unavailable")
    except OSError as exc:
        raise Unknown("namespace_disposition_unavailable") from exc
    finally:
        for fd in reversed(descriptors):
            os.close(fd)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result, "namespace_disposition_invalid")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    _require(isinstance(value, dict) and set(value) == NAMESPACE_DISPOSITION_FIELDS,
             "namespace_disposition_invalid")
    _require(all(isinstance(value[key], str) and value[key] for key in
                 ("kind", "deployment_profile", "native_profile", "home", "epoch", "container_id", "pid_mode")),
             "namespace_disposition_invalid")
    _require(type(value["version"]) is int and value["version"] == NAMESPACE_DISPOSITION_VERSION
             and value["kind"] == "pid_namespace_disposed" and value["pid_mode"] == "private"
             and value["old_instance_disposed"] is True and value["pid1_gone"] is True,
             "namespace_disposition_invalid")
    _require(type(value["home_dev"]) is int and value["home_dev"] >= 0
             and all(type(value[key]) is int and value[key] > 0 for key in
                 ("home_ino", "host_pid1", "pid1_start_ticks", "pid_namespace_inode", "host_pid_namespace_inode")),
             "namespace_disposition_invalid")
    boot, separator, start = epoch.rpartition(":")
    _require(separator == ":" and str(uuid.UUID(boot)) == boot and start == str(value["pid1_start_ticks"])
             and value["epoch"] == epoch and value["pid_namespace_inode"] != value["host_pid_namespace_inode"],
             "namespace_disposition_invalid")
    container = value["container_id"]
    _require(isinstance(container, str) and len(container) == 64
             and all(c in "0123456789abcdef" for c in container), "namespace_disposition_invalid")
    home_info = home.stat()
    _require(stat.S_ISDIR(home_info.st_mode)
             and value["deployment_profile"] == deployment_profile == Path(ingress).parent.name
             and value["native_profile"] == native_profile and value["home"] == str(home)
             and (value["home_dev"], value["home_ino"]) == (home_info.st_dev, home_info.st_ino),
             "namespace_disposition_scope_mismatch")
    return {"epoch": epoch, "sha256": hashlib.sha256(raw).hexdigest()}


def _loop_pause_payload(payload):
    """Recognize the native needs-input recurrence guard, never arbitrary TRIAGE."""
    from hermes_cli.kanban_db import BLOCK_RECURRENCE_LIMIT
    return (set(payload) == {"kind", "source_status", "reason", "recurrences", "limit"}
            and payload.get("kind") == "needs_input"
            and payload.get("source_status") in {"ready", "review"}
            and isinstance(payload.get("reason"), str) and bool(payload["reason"])
            and type(payload.get("recurrences")) is int
            and type(payload.get("limit")) is int
            and payload["limit"] == BLOCK_RECURRENCE_LIMIT
            and payload["recurrences"] >= payload["limit"])


def _control_only_run(run, events, native_profile, stop_id):
    """Recognize only the native block writer's never-claimed zero-duration row.

    _end_run retains a real attempt's claim and worker identity. The native
    _synthesize_ended_run instead inserts these fields as NULL, with one block
    event and no claimed/admitted/worker history. Missing attempt evidence alone
    is never a reason to exclude a run from execution checks.
    """
    from hermes_cli.kanban_db import BLOCK_RECURRENCE_LIMIT
    if not (run["status"] == run["outcome"] == "blocked"
            and run["profile"] in (None, native_profile) and run["step_key"] is None
            and type(run["started_at"]) is int and run["started_at"] > 0
            and type(run["ended_at"]) is int and run["ended_at"] == run["started_at"]
            and isinstance(run["summary"], str) and bool(run["summary"])
            and all(run[key] is None for key in ("claim_lock", "claim_expires", "worker_pid",
                "worker_started_at", "max_runtime_seconds", "last_heartbeat_at", "metadata", "error"))):
        return False
    linked = [event for event in events if event["run_id"] == run["id"]]
    if len(linked) != 1 or linked[0]["kind"] not in {"blocked", "block_loop_detected"} or linked[0]["id"] > stop_id:
        return False
    payload = json.loads(linked[0]["payload"])
    if linked[0]["kind"] == "block_loop_detected":
        return _loop_pause_payload(payload) and payload["reason"] == run["summary"]
    return (set(payload) == {"kind", "source_status", "reason", "recurrences"}
            and payload.get("kind") == "needs_input" and payload.get("source_status") in {"ready", "review"}
            and type(payload.get("recurrences")) is int and 0 < payload["recurrences"] < BLOCK_RECURRENCE_LIMIT
            and payload.get("reason") == run["summary"])


@contextmanager
def _read(path):
    from hermes_cli.sqlite_safe_read import connect_tracked
    with closing(connect_tracked(Path(path).resolve(strict=True).as_uri() + "?mode=ro", uri=True, isolation_level=None)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        yield db


def _binding(state, issue, profile):
    if not Path(state).is_file():
        return None
    with _read(state) as db:
        row = db.execute("SELECT value FROM metadata WHERE key=?", ("native-binding:" + issue,)).fetchone()
        work = db.execute("SELECT origin,task_id FROM work WHERE issue_id=?", (issue,)).fetchone()
        fenced = db.execute("SELECT 1 FROM specialist_scope_fence WHERE issue_id=?", (issue,)).fetchone()
        _require(not fenced, "issue_scope_fenced")
        if not row or not work or work["origin"] != "native":
            return None
        bound = native_json_object(row[0])
        if not (bound.get("issue_id") == issue and bound.get("profile") == profile
                and bound.get("task_id") == work["task_id"] and isinstance(bound.get("board"), str)):
            return None  # A stale reporting link does not replace inspection of actual local work.
        return bound


def _discover(home, issue, profile, native_profile, metadata, bound=None):
    from .bridge import Kanban
    from hermes_cli import kanban_db as kb
    class ReadOnlyDiscovery(Kanban):
        def __init__(self):
            # Bypass the ordinary adapter's create/migrate constructor. Its existing discovery
            # algorithm and inherited strict tracked read-only history reader remain unchanged.
            self.kb, self.board = kb, kb.get_current_board()
            self.executor_profile, self.profile_home = native_profile, home
    reader = ReadOnlyDiscovery()
    found = reader.discover(metadata or {"id": issue})
    if bound is not None:
        # A reporting link can include marker-free manual work, but cannot
        # hide any other retained executor discovered through native history.
        _require(len(found) <= 1 and all(adapter.board == bound["board"] and task.id == bound["task_id"]
                                        for adapter, task in found), "native_history_match_missing_or_ambiguous")
    else:
        _require(len(found) == 1, "native_history_match_missing_or_ambiguous")
    if found:
        adapter, task = found[0]
        _require(task.assignee == native_profile and not getattr(adapter, "history_only", False),
                 "native_history_match_foreign_or_archived")
    if bound is None:
        bound = {"issue_id": issue, "task_id": task.id, "board": adapter.board, "profile": profile}
    return bound, reader.for_board(bound["board"])


def _epoch_parts(epoch):
    """Native ``<boot_id>:<pid1 start ticks>``; None for anything degraded or malformed."""
    boot, separator, start = epoch.rpartition(":")
    try:
        valid = separator == ":" and str(uuid.UUID(boot)) == boot and start.isdigit() and int(start) > 0
    except ValueError:
        valid = False
    return (boot, int(start)) if valid else None


def _native_restart_reason(recorded_epoch, epoch, owner, replaced):
    """None when core proves this attempt ended with an earlier instance of this host; else why not.

    A container restart or reboot changes the native instantiation epoch, and a PID
    namespace ends with its PID 1, so no process with the recorded identity can be
    alive here. That holds only for an EARLIER, well-formed instance: the same boot
    orders by PID 1's start, and another boot_id is a reboot. The gateway that admitted
    the attempt must be gone, and core's ``attempt_instance_replaced`` must accept every
    worker the run recorded. Missing or unreadable evidence is never proof.
    """
    old, now = _epoch_parts(recorded_epoch), _epoch_parts(epoch)
    if old is None:
        return "worker_identity_missing"
    if now is None:
        return "worker_identity_unreadable"  # e.g. boot_id unreadable right now: never a restart
    if old[0] == now[0] and old[1] >= now[1]:
        return "worker_instance_not_earlier"
    try:
        from hermes_cli.kanban_owner_recovery import _owner_process_gone
    except ImportError:
        return "restart_proof_unsupported"
    if not (isinstance(owner, dict) and _owner_process_gone(owner)):
        return "old_gateway_alive"
    return "old_instance_unproven" if replaced is None else replaced()


def _attempt_replaced(board, task_id, run_id, session_id):
    """Core's restart proof for one run (hermes-agent #217), read in the cleanup snapshot."""
    try:
        from hermes_cli.kanban_owner_recovery import attempt_instance_replaced
    except ImportError:
        return "restart_proof_unsupported"
    return None if attempt_instance_replaced(board, task_id, run_id, session_id) else "old_instance_unproven"


def _other_instance_fate(recorded_epoch, epoch, owner, replaced, disposition):
    reason = _native_restart_reason(recorded_epoch, epoch, owner, replaced)
    if reason is None:
        return "instance_replaced"
    if disposition is not None:
        try:
            if disposition(recorded_epoch):
                return "namespace_disposed"
        except Unknown as exc:
            if str(exc) != "namespace_disposition_unavailable":
                raise  # A receipt is present but not trustworthy: say so.
    raise Unknown(reason)


def _pid_gone(pid, fingerprint, owner=None, *, replaced=None, disposition=None):
    """Compose native epoch and birth validation; never infer identity from junk."""
    from hermes_cli.kanban_db_dispatch import _process_fingerprint
    from hermes_cli.kanban_db import _pid_alive
    from gateway.drain_control import current_instantiation_epoch
    from gateway.status import _start_times_agree, start_time_fingerprints_match
    _require(type(pid) is int and pid > 0, "worker_identity_missing")
    epoch = current_instantiation_epoch()
    _require(isinstance(epoch, str) and epoch, "worker_identity_unreadable")
    def birth(witness, reason, *, same_epoch=True):
        _require(isinstance(witness, str) and witness.count("|") == 1, reason)
        recorded_epoch, _, start = witness.partition("|")
        _require(not same_epoch or recorded_epoch == epoch, reason)
        try:
            valid = _start_times_agree(start, start)
        except (TypeError, ValueError, OverflowError):
            valid = False
        _require(valid, reason)
        return start
    recorded = birth(fingerprint, "worker_identity_missing", same_epoch=False)
    recorded_epoch = fingerprint.partition("|")[0]
    if recorded_epoch != epoch:
        return _other_instance_fate(recorded_epoch, epoch, owner, replaced, disposition)
    if not _pid_alive(pid):
        return "gone"
    current = birth(_process_fingerprint(pid), "worker_identity_unreadable")
    # Linux's native fingerprint may fall back from boot ticks to epoch
    # centiseconds on a transient /proc read failure. Neither persisted witness
    # identifies which source produced it: compare both native representations
    # rather than interpreting a source change as PID reuse.
    import psutil
    from hermes_cli.process_identity import process_birth, worker_birth
    try:
        process = psutil.Process(pid)
        epoch_birth = round(process_birth(process) * 100)
        readings = [epoch_birth]
        monotonic_birth = worker_birth(process)
        if psutil.LINUX:
            readings.append(monotonic_birth * os.sysconf("SC_CLK_TCK"))
    except psutil.Error as exc:
        raise Unknown("worker_identity_unreadable") from exc
    _require(all(_start_times_agree(value, value) for value in readings), "worker_identity_unreadable")
    _require(any(start_time_fingerprints_match(float(current), value) for value in readings),
             "worker_identity_unreadable")
    _require(not any(start_time_fingerprints_match(float(recorded), value) for value in readings),
             "old_worker_alive")
    # Legacy fingerprint numbers do not identify their historical source.
    # A clock step can move an epoch fallback while its Linux boot birth stays
    # unchanged. Only this exact attempt's fully matched native admission
    # receipt supplies the original native worker_birth, never a PID-only join.
    _require(isinstance(owner, dict) and type(owner.get("pid")) is int and owner["pid"] == pid
             and type(owner.get("birth")) in (int, float), "worker_identity_unproven")
    original_birth = owner["birth"]
    _require(_start_times_agree(original_birth, original_birth), "worker_identity_unproven")
    _require(not _start_times_agree(monotonic_birth, original_birth), "old_worker_alive")
    # Recheck the native identity after the independent reads; a changing
    # incarnation or source that neither reading explains stays uncertain.
    repeated = birth(_process_fingerprint(pid), "worker_identity_unreadable")
    _require(any(start_time_fingerprints_match(float(repeated), value) for value in readings),
             "worker_identity_unreadable")
    try:
        repeated_birth = worker_birth(process)
    except psutil.Error as exc:
        raise Unknown("worker_identity_unreadable") from exc
    _require(_start_times_agree(monotonic_birth, repeated_birth), "worker_identity_unreadable")
    return "recycled"


def _checkpoint(home, owners):
    """Read the canonical scoped checkpoint only; never recover or load a process manager."""
    path = home / "processes.json"
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return {"scoped_records": 0, "recycled_records": 0}
    # A dangling symlink is a retained obligation, not genuine absence. Never
    # follow a checkpoint link or treat inaccessible metadata as an empty file.
    _require(stat.S_ISREG(metadata.st_mode) and metadata.st_size <= 1024 * 1024,
             "checkpoint_unreadable")
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            _require(key not in value, "checkpoint_duplicate_key")
            value[key] = item
        return value
    entries = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_object)
    _require(isinstance(entries, list), "checkpoint_unreadable")
    for entry in entries:
        _require(isinstance(entry, dict), "checkpoint_ownership_ambiguous")
        route = entry.get("session_key")
        attributed = [entry[key] for key in ("parent_session_id", "owner_task_id", "task_id")
                      if entry.get(key) is not None]
        complete = bool(attributed) and all(isinstance(value, str) and value
                                           and value == value.strip() for value in (route, *attributed))
        if (complete and all(route not in keys for keys, _ in owners)
                and all(owner not in ids for owner in attributed for _, ids in owners)):
            continue  # Only positively foreign records can be excluded.
        _require(complete and any(route in keys and all(owner in ids for owner in attributed)
                                  for keys, ids in owners), "checkpoint_ownership_ambiguous")
        # Native Stop retains both legacy and managed checkpoints until its
        # scope, reader and durable ownership/output obligations are reconciled.
        # Neither leader fate nor an exit file lets this reader discharge them.
        raise Unknown("scoped_process_cleanup_unknown")
    return {"scoped_records": 0, "recycled_records": 0}


def _lineage_inputs(store, native, session_id):
    """Prevalidate only mapping fields consumed by native runtime_lineage."""
    from . import native_store
    observed = {"receipts": {}, "reset_models": {}}
    row = native.execute("SELECT chat_id FROM sessions WHERE id=?", (session_id,)).fetchone()
    for logical in dict.fromkeys([session_id, *([row[0]] if row and row[0] else [])]):
        if not store.bindings.binding_marks(logical).policy:
            continue
        receipt = native_store.local_receipt(store, logical)
        observed["receipts"][logical] = receipt
        if logical != session_id and session_id not in receipt.get("lineage", [logical]):
            continue
        lineage = receipt.get("lineage", [])
        if not isinstance(lineage, list):
            continue  # The native helper retains all lineage/topology validation.
        for parent, child in zip(lineage, lineage[1:]):
            reset = native.execute("SELECT child.id,child.model_config FROM sessions AS parent "
                "JOIN sessions AS child ON child.parent_session_id=parent.id "
                "WHERE parent.id=? AND child.id=? AND parent.end_reason='session_reset'", (parent, child)).fetchone()
            if reset is not None:
                observed["reset_models"][reset[0]] = native_json_object(reset[1] or "{}")
    return observed


def _runtime_scope(store, native, session_id, execution_id):
    """Close over retained native sessions and executions inside one read snapshot."""
    from .native_store import runtime_lineage, descendant_range
    sessions, workers, children, inspected, lineage_inputs = set(), {}, {}, set(), {}
    pending_sessions, pending_roots = {session_id}, {execution_id}
    columns = "execution_id,session_id,status,kind,owner_epoch,generation,last_sequence"
    while pending_sessions or pending_roots:
        discovered = set()
        for target in sorted(pending_sessions):
            lineage_inputs[target] = _lineage_inputs(store, native, target)
            discovered.update(runtime_lineage(store, target))
        discovered.difference_update(sessions)
        sessions.update(discovered)
        for row in native.execute(f"SELECT {columns} FROM worker_executions "
                                  "WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY execution_id",
                                  (json.dumps(sorted(discovered)),)):
            workers[row["execution_id"]] = dict(row)
            pending_roots.add(row["execution_id"])
        pending_sessions = set()
        roots, pending_roots = pending_roots - inspected, set()
        for root in sorted(roots):
            inspected.add(root)
            for row in native.execute(f"SELECT {columns} FROM worker_executions "
                                      "WHERE execution_id>=? AND execution_id<? ORDER BY execution_id",
                                      descendant_range(root)):
                workers[row["execution_id"]] = children[row["execution_id"]] = dict(row)
                pending_sessions.add(row["session_id"])
                pending_roots.add(row["execution_id"])
        pending_sessions.difference_update(sessions)
        pending_roots.difference_update(inspected)
    # Each session component and retained execution root is inspected once;
    # the fixed snapshot, not an invented depth cap, bounds this traversal.
    return sessions, [workers[key] for key in sorted(workers)], [children[key] for key in sorted(children)], lineage_inputs


def _require_owned_workers(native, workers, epoch):
    from .native_store import session_row_raw as _session, linked_worker_admission as _linked_worker_admission
    # worker_executions' native CHECK/NOT NULL contract and the actual writers:
    # register binds an integer epoch/generation; begin_runtime_epoch starts at
    # one, session generations start at zero and only advance, and receipt
    # sequences start at zero. Historical terminal rows need not be current.
    for row in workers:
        _require(row["kind"] in ("cron", "child", "compute", "kanban")
                 and row["status"] in ("registered", "running", "unknown", "terminal"),
                 "native_worker_state_unreadable")
        session = _session(native, row["session_id"])
        _require(type(row["owner_epoch"]) is int and 0 < row["owner_epoch"] <= epoch
                 and type(session["runtime_generation"]) is int and session["runtime_generation"] >= 0
                 and type(row["generation"]) is int and 0 <= row["generation"] <= session["runtime_generation"]
                 and type(row["last_sequence"]) is int and row["last_sequence"] >= 0,
                 "native_worker_state_unreadable")
        # Native adoption also joins the admission's physical lineage, not only
        # its logical target. A foreign target cannot hide this active claim.
        _require(_linked_worker_admission(native, row["session_id"], row["generation"], row["owner_epoch"],
                                          ("started", "unknown")) is None, "native_session_has_unsettled_work")


def _require_owned_admissions(native, rows, epoch):
    from .native_store import refusal_type, text as _text, json_object as _json, session_row_raw as _session
    RuntimeStoreError = refusal_type()
    for row in rows:
        try:
            for key in ("admission_id", "request_id", "principal_id", "target_session_id"):
                _text(row[key])
            _json(row["payload"])
        except RuntimeStoreError as exc:
            raise Unknown("native_admission_state_unreadable") from exc
        session = _session(native, row["target_session_id"])
        # admit/import use these native identities, dict payloads and intents.
        # Legacy terminal generations and resultless cancellations may be NULL.
        _require(type(row["seq"]) is int and row["seq"] > 0
                 and row["intent"] in ("queue", "steer", "redirect")
                 and (row["owner_epoch"] is None or
                      (type(row["owner_epoch"]) is int and 0 < row["owner_epoch"] <= epoch))
                 and type(session["runtime_generation"]) is int and session["runtime_generation"] >= 0
                 and (row["generation"] is None or
                      (type(row["generation"]) is int and 0 <= row["generation"] <= session["runtime_generation"])),
                 "native_admission_state_unreadable")


def _snapshot(home, state, issue, binding_profile, native_profile, stop_id, declared, metadata, ingress=None):
    from hermes_cli import kanban_db as kb
    from . import native_store
    from .native_store import (local_receipt, local_identity, text as runtime_identity, json_object as runtime_payload,
                               find_admission as find_session_admission, list_admissions as list_session_admissions)
    RuntimeStoreError = native_store.refusal_type()
    from gateway.session_policy import restore_policy
    from gateway import session_ancillary
    getter = getattr(session_ancillary, "process_stop_pending", None)
    _require(getter is not None, "native_stop_checkpoint_unsupported")
    # The ingress/deployment routing label can differ from the executor's native profile
    # (isolated fleet homes use default). It must never select a home or reject its valid link.
    bound = _binding(state, issue, native_profile)
    source = "saved_native_binding" if bound else "native_history_discovery"
    bound, reader = _discover(home, issue, native_profile, native_profile, metadata, bound)
    path = kb.kanban_db_path(board=bound["board"]).resolve(strict=True)
    receipts, owners, worker_evidence, native_lineages = [], [], [], []
    namespace_evidence = {}
    def disposed(epoch):
        # No receipt at all: core's own evidence decides and names the hold. A present
        # receipt is always read strictly, so an untrusted one holds with its own reason.
        _require(os.path.lexists(_namespace_disposition_path(ingress, epoch)), "namespace_disposition_unavailable")
        if epoch not in namespace_evidence:
            namespace_evidence[epoch] = _namespace_disposition(ingress, home, binding_profile, native_profile, epoch)
        return True
    disposition = disposed if ingress is not None else None
    with reader.history_conn(path, snapshot=True) as board, native_store.reader(home) as db:
        from .bridge import task_issue_match, require_task_issue_scope, native_text_row, native_event_payload
        from .api import LinearError
        with native_store.read_ctx(home) as native:
            # Pin this mode=ro connection (its read transaction is open) for the preflight.
            # No owner RPC runs in this scope.
            # Runtime identities are TEXT, unlike Kanban's legacy decoding.
            # A malformed selector has no proved foreign attribution: hold it
            # before WHERE can hide it, never decode it into identity/authority.
            for table, required, optional in (
                ("worker_executions", ("execution_id", "session_id"), ()),
                ("session_admissions", ("target_session_id",), ()),
                ("sessions", ("id",), ("parent_session_id", "chat_id")),
                ("state_meta", ("key",), ()),
            ):
                for row in native.execute(f"SELECT {','.join(required + optional)} FROM {table}"):
                    if table in ("worker_executions", "session_admissions"):
                        try:
                            for key in required:
                                runtime_identity(row[key])
                        except RuntimeStoreError as exc:
                            raise Unknown("native_runtime_ownership_key_unreadable") from exc
                    _require(all(isinstance(row[key], str) for key in required)
                             and all(row[key] is None or isinstance(row[key], str) for key in optional),
                             "native_runtime_ownership_key_unreadable")
        discovered = reader.tasks(board)
        _require(all(task.id == bound["task_id"] for task in discovered
                     if task_issue_match(task, metadata or {"id": issue})), "native_history_match_missing_or_ambiguous")
        selected = [task for task in discovered if task.id == bound["task_id"]]
        _require(len(selected) == 1, "native_task_missing_or_ambiguous")
        try:
            require_task_issue_scope(selected[0], metadata or {"id": issue})
        except LinearError as exc:
            # Bridge-created tasks name their issue by key and link. Without the issue's own
            # link those lines can be neither matched nor refuted: that is missing discovery
            # data, not a conflict, and it stays unknown either way.
            if not (metadata or {}).get("url"):
                raise Unknown("issue_metadata_required") from exc
            raise Unknown("native_task_issue_scope_conflict") from exc
        # A readable key may still be excluded by SQLite's BLOB/TEXT equality
        # while native row construction identifies it as this task. Validate
        # that boundary before any selected-task predicate can hide a record.
        for table, column in (("tasks", "id"), ("task_runs", "task_id"),
                              ("task_events", "task_id"), ("task_comments", "task_id")):
            if column == "task_id":
                reader.task_keys(board, table)
            for key in board.execute(f"SELECT {column} AS native_key,{column}=? AS selected FROM {table}",
                                     (bound["task_id"],)):
                native_text_row(key, "native_key")
                _require(kb._lossy_text(key["native_key"]) != bound["task_id"] or key["selected"] == 1,
                         "native_task_predicate_ambiguous")
        task = board.execute("SELECT * FROM tasks WHERE id=?", (bound["task_id"],)).fetchone()
        _require(task and task["status"] in {"blocked", "triage"} and task["block_kind"] == "needs_input"
                 and task["current_run_id"] is None and task["claim_lock"] is None
                 and task["assignee"] == native_profile, "task_not_currently_stopped")
        owned_runs = {int(row["id"]) for row in board.execute("SELECT id FROM task_runs WHERE task_id=?", (task["id"],))}
        for key in board.execute("SELECT run_id,task_id=? AS selected_task,"
                                 "run_id IN (SELECT id FROM task_runs WHERE task_id=?) AS selected_run "
                                 "FROM task_events", (task["id"], task["id"])):
            native_text_row(key, "run_id")
            # Event.from_row uses this exact native conversion. A normalized
            # owned run must agree with both actual SQLite ownership predicates.
            _require(kb._opt_int(key["run_id"]) not in owned_runs
                     or (key["selected_task"] == 1 and key["selected_run"] == 1),
                     "attempt_event_task_mismatch")
        events = [{"id": event.id, "run_id": event.run_id, "kind": event.kind,
                   "payload": json.dumps(native_event_payload(event))} for event in reader.history_rows(board, task["id"])]
        stops = [e for e in events if e["kind"] in {"blocked", "block_loop_detected"}]
        _require(stops and stops[-1]["id"] == stop_id
                 and json.loads(stops[-1]["payload"]).get("kind") == "needs_input", "stop_event_changed")
        runs = board.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY id", (task["id"],)).fetchall()
        by_run = {run["id"]: run for run in runs}
        stop = stops[-1]
        if task["status"] == "triage":
            payload = json.loads(stop["payload"])
            paused = by_run.get(stop["run_id"])
            _require(stop["kind"] == "block_loop_detected" and _loop_pause_payload(payload)
                     and type(task["block_recurrences"]) is int
                     and task["block_recurrences"] == payload["recurrences"]
                     and paused is not None and paused["status"] == paused["outcome"] == "blocked"
                     and paused["summary"] == payload["reason"], "native_loop_pause_unproven")
        else:
            _require(stop["kind"] == "blocked", "stop_event_changed")
        bindings = [e for e in events if e["kind"] == "owner_admitted"]
        workers = [e for e in events if e["kind"] in {"spawned", "worker_registered", "worker_bound"}]
        _require(bindings and all(e["id"] < stop_id for e in bindings), "admission_after_stop_or_missing")
        _require(all(e["run_id"] in by_run for e in bindings + workers), "attempt_event_run_unknown")
        controls = {run["id"] for run in runs if _control_only_run(run, events, native_profile, stop_id)}
        # A submitter can spawn before native admission. Inspect every retained run
        # and worker event before requiring admission evidence; absence is never safety.
        for run in runs:
            if run["id"] in controls:
                continue
            native_run = kb.Run.from_row(native_text_row(run, "id", "task_id", "status", "profile", "ended_at"))
            _require(native_run.status in _SETTLED_RUN_STATUSES
                     and native_run.ended_at is not None and native_run.profile == native_profile, "run_not_settled")
        for worker in workers:
            _require(worker["id"] < stop_id, "late_worker_binding_after_stop")
        for run in runs:
            if run["id"] in controls:
                continue
            admitted = [e for e in bindings if e["run_id"] == run["id"]]
            _require(len(admitted) == 1, "attempt_native_admission_missing_or_ambiguous")
            event = admitted[0]
            run_id, marker = run["id"], json.loads(event["payload"])
            sid = marker["session_id"]
            _require(Path(marker["db"]).resolve() == home / "state.db", "foreign_native_owner")
            saved = local_receipt(db, sid)
            policy = restore_policy(saved["policy"])
            frozen = native_json_object(policy.kanban_json or "{}")
            request = "kanban:" + json.dumps([bound["board"], task["id"], run_id], separators=(",", ":"))
            _require(saved["profile_id"] == str(home) and policy.source == "kanban"
                     and frozen.get("board") == bound["board"] and frozen.get("task_id") == task["id"]
                     and frozen.get("run_id") == run_id and frozen.get("profile") == native_profile
                     and frozen.get("claim_lock") == run["claim_lock"]
                     and Path(frozen.get("db", "")).resolve() == path and policy.cwd == frozen.get("workspace")
                     and saved["request_id"] == request and marker["request_id"] == request
                     and sid == local_identity(str(home), saved["principal_id"], request), "native_attempt_binding_mismatch")
            try:
                admission = find_session_admission(db, principal_id=saved["principal_id"], session_id=sid, request_id=request)
            except ValueError as exc:  # a stored row the storage interface cannot decode is unreadable, not absent
                raise Unknown("native_admission_state_unreadable") from exc
            try:
                if admission is not None:
                    runtime_payload(admission["payload"])
            except RuntimeStoreError as exc:
                raise Unknown("native_admission_state_unreadable") from exc
            _require(admission and admission["status"] == "terminal" and admission["outcome"] in {"completed", "interrupted", "failed", "rejected"}
                     and admission["payload"].get("kanban_card_v1") == {"board": bound["board"], "task_id": task["id"], "run_id": run_id},
                     "native_admission_not_settled")
            proof = {}
            def replaced(run_id=run_id, sid=sid, proof=proof):
                if "reason" not in proof:
                    proof["reason"] = _attempt_replaced(board, task["id"], run_id, sid)
                return proof["reason"]
            if run["worker_pid"] is not None or run["worker_started_at"] is not None:
                _pid_gone(run["worker_pid"], run["worker_started_at"], marker, replaced=replaced, disposition=disposition)
            with native_store.read_ctx(home) as native:
                lineage, native_workers, children, lineage_inputs = _runtime_scope(db, native, sid, "admission-worker:" + admission["admission_id"])
                epoch = native.execute("SELECT epoch,instance_id FROM runtime_epoch WHERE singleton=1").fetchone()
                _require(epoch is not None and type(epoch[0]) is int and epoch[0] > 0, "native_owner_unknown")
                runtime_identity(epoch[1])
                _require_owned_workers(native, native_workers, epoch[0])
                _require(all(child["status"] == "terminal" for child in children), "native_child_spawner_unsettled")
                _require(all(row["status"] == "terminal" for row in native_workers), "native_worker_or_spawner_unsettled")
                executor = native.execute("SELECT status,owner_epoch,generation FROM worker_executions WHERE execution_id=?",
                                          ("admission-worker:" + admission["admission_id"],)).fetchone()
                _require(executor and tuple(executor) == ("terminal", admission["owner_epoch"], admission["generation"]),
                         "native_executor_settlement_missing")
            try:
                retained = [row for target in sorted(lineage)
                            for row in list_session_admissions(db, session_id=target, pending_only=False)]
            except ValueError as exc:
                raise Unknown("native_admission_state_unreadable") from exc
            _require(all(row["status"] == "terminal" and row.get("outcome") in _SETTLED_ADMISSION_OUTCOMES
                         for row in retained), "native_session_has_unsettled_work")
            with native_store.read_ctx(home) as native:
                _require_owned_admissions(native, retained, epoch[0])
            _require(all(getter(db, target) is None for target in lineage), "native_stop_checkpoint_pending")
            native_lineages.append({"sessions": sorted(lineage), "admissions": retained,
                                    "workers": native_workers, "children": children, "lineage_inputs": lineage_inputs})
            relevant = [e for e in events if e["run_id"] == run_id and e["kind"] in {"spawned", "worker_registered", "worker_bound"}]
            _require(any(e["kind"] == "worker_bound" for e in relevant)
                     and any(e["kind"] in {"spawned", "worker_registered"} for e in relevant), "worker_binding_evidence_missing")
            observed = []
            submitters = [json.loads(e["payload"]) for e in relevant if e["kind"] in {"spawned", "worker_registered"}]
            # Native terminal reaping clears BOTH mutable PID slots after exit;
            # its immutable event cohort remains. Never infer fate from NULLs:
            # every submitter and interpreter below still needs physical proof.
            cleared = run["worker_pid"] is None and run["worker_started_at"] is None
            _require((cleared and isinstance(run["claim_lock"], str) and bool(run["claim_lock"]))
                     or (run["worker_pid"] is not None and run["worker_started_at"] is not None
                         and any(p.get("pid") == run["worker_pid"] and p.get("started_at") == run["worker_started_at"] for p in submitters)),
                     "submitter_run_identity_missing")
            for worker in relevant:
                data = json.loads(worker["payload"])
                _require(worker["id"] < stop_id, "late_worker_binding_after_stop")
                if worker["kind"] == "worker_bound":
                    _require(data.get("claim_lock") == frozen.get("claim_lock"), "worker_claim_mismatch")
                observed.append({"kind": worker["kind"], "fate": _pid_gone(data.get("pid"), data.get("started_at"), marker,
                                                                         replaced=replaced, disposition=disposition)})
            worker_evidence.append({"run_id": run_id, "workers": observed,
                "scope": {key: frozen.get(key) for key in ("profile", "workspace", "branch", "tenant", "skills")}})
            owners.append(({saved["route"], *lineage}, {*lineage, *(child["session_id"] for child in children)}))
            receipts.append({"session_id": sid, "admission_id": admission["admission_id"],
                             "status": admission["status"], "outcome": admission["outcome"],
                             "authority_epoch": admission["owner_epoch"], "execution_generation": admission["generation"]})
        checkpoint = _checkpoint(home, owners)
        projection = {"issue_id": issue, "board": bound["board"], "task_id": bound["task_id"],
                      "stop_event_id": stop_id, "latest_event_id": events[-1]["id"],
                      "attempts": worker_evidence, "scoped_checkpoint": checkpoint,
                      "control_only_runs": sorted(controls),
                      "stop_checkpoint": "clear", "scope": declared, "discovery_source": source,
                      "owner_epoch": epoch[0], "owner_instance_id": epoch[1]}
        digest = origin._digest({"binding": bound, "task": dict(task), "events": [dict(e) for e in events], "runs": [dict(run) for run in runs],
                                 "receipts": receipts, "native_lineages": native_lineages, "projection": projection,
                                 "namespace_dispositions": namespace_evidence})
        return projection, receipts, digest


async def _inspect(home, state, issue, binding_profile, native_profile, stop_id, declared, metadata, ingress=None):
    async with origin._client(home) as (client, endpoint):
        before, rows, digest = await asyncio.to_thread(_snapshot, home, state, issue, binding_profile, native_profile, stop_id, declared, metadata, ingress)
        _require(before["owner_epoch"] == endpoint.authority_epoch and before["owner_instance_id"] == endpoint.instance_id,
                 "native_owner_changed")
        for row in rows:
            receipt = await client.rpc("prompt.receipt", session_id=row["session_id"], admission_id=row["admission_id"])
            _require(all(receipt.get(k) == row[k] for k in ("admission_id", "status", "outcome", "authority_epoch", "execution_generation"))
                     and receipt.get("ref") == {"profile_id": str(home), "session_id": row["session_id"]}, "native_receipt_changed")
        after, _, repeated = await asyncio.to_thread(_snapshot, home, state, issue, binding_profile, native_profile, stop_id, declared, metadata, ingress)
        _require(digest == repeated and before == after, "cleanup_evidence_changed")
        return {**after, "owner_instance_id": endpoint.instance_id, "owner_epoch": endpoint.authority_epoch,
                "evidence_digest": digest, "quiescence_proven": True, "permission_granted": False}


def inspect(state: Path, issue: str, binding_profile: str, stop_id: int, settings: dict, metadata: dict | None = None,
            *, ingress: Path | None = None) -> dict:
    """Explicit owner CLI boundary; selects only a current saved Linear/native binding."""
    try:
        from hermes_constants import get_hermes_home
        from hermes_cli.profiles import get_active_profile_name
        from agent.delegation_context import is_delegated_child_process_context
        from agent.runtime_session_store import is_worker_process
        _require(not is_delegated_child_process_context() and not is_worker_process(), "owner_cli_required")
        _require(isinstance(issue, str) and 0 < len(issue) <= 1024 and type(stop_id) is int and stop_id > 0, "invalid_cleanup_selector")
        if metadata is not None:
            _require(isinstance(metadata, dict) and issue in (metadata.get("id"), metadata.get("identifier"))
                     and isinstance(metadata.get("id"), str) and set(metadata) <= {"id", "identifier", "url"}
                     and all(isinstance(v, str) and 0 < len(v) <= 4096 for v in metadata.values()), "invalid_issue_discovery_metadata")
            issue = metadata["id"]  # A key selector ("ABC-12") names the same issue; native records use its id.
        elif _ISSUE_KEY.fullmatch(issue):
            raise Unknown("issue_metadata_required")  # Native records are keyed by issue id, never by its key.
        home = Path(get_hermes_home()).resolve(strict=True)
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise Unknown("synchronous_owner_cli_required")
        result = asyncio.run(_inspect(home, state, issue, binding_profile, get_active_profile_name(), stop_id, origin.scope(settings), metadata, ingress))
    except (Unknown, Unavailable, OSError, RuntimeError, ValueError, KeyError, IndexError, TypeError, ImportError, sqlite3.DatabaseError) as exc:
        reason = str(exc) if isinstance(exc, Unknown) else "cleanup_evidence_unavailable"
        diag.evt("cleanup.inspect", "held", reason, evt=stop_id)
        result = {"issue_id": issue, "stop_event_id": stop_id, "quiescence_proven": False,
                  "state": "unknown", "reason": reason, "permission_granted": False}
        if reason in HOLD_FACTS:
            result["needed"] = HOLD_FACTS[reason]
        return result
    diag.evt("cleanup.inspect", "applied", task=result.get("task_id"), evt=stop_id)
    return result
