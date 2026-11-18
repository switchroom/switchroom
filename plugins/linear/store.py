"""Issue/task bindings, preserved legacy records and the durable Linear outbox.

The database records reporting and uncertain delivery. It never grants execution.
"""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from collections import Counter
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Iterator
from .api import backoff_delay
from .acceptance import DELIVERY_REFUSAL
MIN_BACKOFF, MAX_BACKOFF, GIVE_UP_AFTER = 60.0, 3600.0, 86_400.0
# A guard-deferred outbox row keeps two quick retries (the native state it waits for is usually
# captured within a tick), then waits 30 s doubling to 30 min instead of re-reading Linear every tick.
GUARD_FREE_DEFERS, GUARD_MIN_BACKOFF, GUARD_MAX_BACKOFF = 2, 30.0, 1800.0
REVIVE_LIMIT, REVIVE_EVERY = 3, 3600.0  # timed-out rows: at most 3 revivals, at most one an hour
SCHEMA = """
CREATE TABLE IF NOT EXISTS work (
  issue_id TEXT PRIMARY KEY, origin TEXT NOT NULL, owner_ref TEXT NOT NULL,
  task_id TEXT, project_id TEXT, last_updated_at REAL NOT NULL DEFAULT 0,
  linear_session_id TEXT, panel_note TEXT, stop_requested_at REAL NOT NULL DEFAULT 0,
  last_event_id INTEGER NOT NULL DEFAULT 0, resume_fence_at REAL NOT NULL DEFAULT 0,
  run_generation INTEGER, ownership_id TEXT, pending_resume TEXT, release_pending INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  hold_reason TEXT);
CREATE TABLE IF NOT EXISTS chat_stop (
  id TEXT PRIMARY KEY, profile TEXT NOT NULL, issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL, source_activity_id TEXT NOT NULL,
  session_key TEXT NOT NULL, run_generation INTEGER,
  status TEXT NOT NULL DEFAULT 'requested', worker_completion TEXT NOT NULL DEFAULT 'unknown',
  completion_activity_id TEXT, uncertainty_activity_id TEXT,
  UNIQUE(profile, issue_id, linear_session_id, source_activity_id));
CREATE TABLE IF NOT EXISTS retirement (
  task_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS specialist_scope_fence (
  issue_id TEXT PRIMARY KEY, reason TEXT NOT NULL, fenced_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chat_admissions (
  request_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL,
  home TEXT NOT NULL, parent_session_key TEXT NOT NULL, parent_session_id TEXT NOT NULL,
  run_generation INTEGER NOT NULL, ownership_id TEXT NOT NULL, task_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','claiming','admitted','rejected','ambiguous')),
  reason_code TEXT, route TEXT);
"""
# The legacy hold scan is a pure function of outbox rows, work identity and native bindings.
# SQLite triggers count every change to those inputs, in every writing process, so the scan
# reruns only after one. Bump HOLD_RULES_VERSION whenever the hold rules change.
HOLD_RULES_VERSION = 1
HOLD_INPUTS, HOLD_SCANNED = "hold-inputs-version", "hold-scanned-version"
# Send bookkeeping that the hold rules never read; a change only to these keys is not an input.
_HOLD_VOLATILE = "'$.write_started','$.mutation_attempt_id','$.conversation_attempt_id','$.last_error','$.attempts'"
_HOLD_BUMP = (f"INSERT INTO metadata(key,value) VALUES ('{HOLD_INPUTS}','1') ON CONFLICT(key) DO UPDATE SET "
              "value=CAST(CAST(value AS INTEGER)+1 AS TEXT)")
_HOLD_PAYLOAD_CHANGED = (
    "(CASE WHEN json_valid(OLD.payload) AND json_valid(NEW.payload) "
    f"THEN json_remove(OLD.payload,{_HOLD_VOLATILE}) IS NOT json_remove(NEW.payload,{_HOLD_VOLATILE}) "
    "ELSE OLD.payload IS NOT NEW.payload END)")
_SCANNED_STATES = "('pending','failed','sent')"
HOLD_TRIGGERS = f"""
CREATE TRIGGER IF NOT EXISTS hold_inputs_outbox_insert AFTER INSERT ON outbox BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_outbox_delete AFTER DELETE ON outbox BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_outbox_update AFTER UPDATE OF kind, payload, state, hold_reason ON outbox
WHEN OLD.kind IS NOT NEW.kind OR OLD.hold_reason IS NOT NEW.hold_reason
  OR (OLD.state IN {_SCANNED_STATES}) IS NOT (NEW.state IN {_SCANNED_STATES}) OR {_HOLD_PAYLOAD_CHANGED}
BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_work_insert AFTER INSERT ON work BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_work_delete AFTER DELETE ON work BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_work_update AFTER UPDATE OF issue_id, origin, task_id ON work
BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_binding_insert AFTER INSERT ON metadata
WHEN NEW.key LIKE 'native-binding:%' BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_binding_delete AFTER DELETE ON metadata
WHEN OLD.key LIKE 'native-binding:%' BEGIN {_HOLD_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS hold_inputs_binding_update AFTER UPDATE ON metadata
WHEN OLD.key LIKE 'native-binding:%' OR NEW.key LIKE 'native-binding:%' BEGIN {_HOLD_BUMP}; END;
"""
# Any change to reporting rows, work, bindings or settled acceptance waits. A finished binding's
# pump skip (Bridge._pump_quiescent) is reused only while this counter stands still.
QUIET_INPUTS = "quiet-inputs-version"
_QUIET_BUMP = _HOLD_BUMP.replace(HOLD_INPUTS, QUIET_INPUTS)
_QUIET_KEYS = "(key LIKE 'native-binding:%' OR key LIKE 'acceptance-recheck-settled:%')"
QUIET_TRIGGERS = f"""
CREATE TRIGGER IF NOT EXISTS quiet_inputs_outbox_insert AFTER INSERT ON outbox BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_outbox_update AFTER UPDATE ON outbox BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_outbox_delete AFTER DELETE ON outbox BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_work_insert AFTER INSERT ON work BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_work_update AFTER UPDATE ON work BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_work_delete AFTER DELETE ON work BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_metadata_insert AFTER INSERT ON metadata
WHEN {_QUIET_KEYS.replace('key', 'NEW.key')} BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_metadata_update AFTER UPDATE ON metadata
WHEN {_QUIET_KEYS.replace('key', 'OLD.key')} OR {_QUIET_KEYS.replace('key', 'NEW.key')} BEGIN {_QUIET_BUMP}; END;
CREATE TRIGGER IF NOT EXISTS quiet_inputs_metadata_delete AFTER DELETE ON metadata
WHEN {_QUIET_KEYS.replace('key', 'OLD.key')} BEGIN {_QUIET_BUMP}; END;
"""
# Retained outbox history grows without bound and nearly every per-issue or per-task lookup
# filters on these payload fields; without an index each one parses every payload.
OUTBOX_INDEXES = """
CREATE INDEX IF NOT EXISTS outbox_payload_issue ON outbox(json_extract(payload, '$.issue_id'));
CREATE INDEX IF NOT EXISTS outbox_payload_task ON outbox(json_extract(payload, '$.task_id'));
"""
# Final replies keep normal delivery even when projected as thoughts. Unattempted one-try
# notes can retire, but an attempted native message retains readback and lifecycle repair.
# Worker actions stay optional/nonblocking in this classification; their uncertain
# send marker is protected separately by retire_advisory for readback-only recovery.
ADVISORY = ("(kind = 'activity' AND ((json_extract(payload, '$.content.type') IN ('thought', 'action') AND "
            "json_extract(payload, '$.native_reply_version') IS NULL) OR "
            "(COALESCE(json_extract(payload, '$.one_try'), 0) = 1 AND NOT "
            "(COALESCE(json_extract(payload, '$.native_reply_version'), 0)=1 AND "
            "COALESCE(json_extract(payload, '$.write_started'), 1)!=0))))")
def advisory(row: dict[str, Any]) -> bool:
    """Disposable notices get one try; an uncertain native conversation effect must be settled."""
    payload = row["payload"]
    return row["kind"] == "activity" and (((payload.get("content") or {}).get("type") in ("thought", "action")
                                           and payload.get("native_reply_version") is None)
                                          or (payload.get("one_try") is True and not (
                                              payload.get("native_reply_version") == 1 and
                                              payload.get("write_started") is not False)))


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._local = threading.local()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript(SCHEMA)
            outbox_columns = {row[1] for row in db.execute("PRAGMA table_info(outbox)")}
            if "hold_reason" not in outbox_columns:
                db.execute("ALTER TABLE outbox ADD COLUMN hold_reason TEXT")
            db.commit()
            db.executescript(HOLD_TRIGGERS)
            db.executescript(QUIET_TRIGGERS)
            db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES (?, '1')", (QUIET_INPUTS,))
            db.commit()
            try:
                db.executescript(OUTBOX_INDEXES)
            except sqlite3.Error:
                pass  # Lookups stay correct, only slower, if a retained payload cannot be indexed.
            columns = {row[1] for row in db.execute("PRAGMA table_info(work)")}
            for name in ("linear_session_id", "panel_note", "pending_resume"):
                if name not in columns:
                    db.execute(f"ALTER TABLE work ADD COLUMN {name} TEXT")
            if "stop_requested_at" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN stop_requested_at REAL NOT NULL DEFAULT 0")
            if "last_event_id" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN last_event_id INTEGER NOT NULL DEFAULT 0")
            if "resume_fence_at" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN resume_fence_at REAL NOT NULL DEFAULT 0")
            if "run_generation" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN run_generation INTEGER")
            if "release_pending" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN release_pending INTEGER NOT NULL DEFAULT 0")
            if "ownership_id" not in columns:
                db.execute("ALTER TABLE work ADD COLUMN ownership_id TEXT")
    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        active = getattr(self._local, "db", None)
        if active is not None:
            yield active
            return
        with closing(sqlite3.connect(self.path, timeout=90, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE")
            self._local.db = db
            try:
                yield db
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
            finally:
                self._local.db = None
    @staticmethod
    def unlinked_content(kind: str, payload: dict[str, Any]) -> bool:
        """An ordinary content request carries no retained execution identity."""
        content_kind = kind in ("comment", "description") or Store.conversation_reply(kind, payload)
        return (content_kind and payload.get("content_action") is True
                and payload.get("unlinked_content") is True and not any(payload.get(key) for key in (
                    "work_owner", "session_key", "admission_id", "claim", "release", "task_id",
                    "stop_intent_id", "requires_status_id", "terminal")))
    @staticmethod
    def conversation_reply(kind: str, payload: dict[str, Any]) -> bool:
        content = payload.get("content") or {}
        return (kind == "activity" and type(payload.get("native_reply_version")) is int
                and payload["native_reply_version"] == 1 and isinstance(content, dict)
                and payload.get("content_action") is True and payload.get("unlinked_content") is True
                and not any(payload.get(key) for key in ("work_owner", "session_key", "admission_id", "claim",
                    "release", "task_id", "stop_intent_id", "requires_status_id", "terminal"))
                and isinstance(payload.get("issue_id"), str) and bool(payload["issue_id"])
                and isinstance(payload.get("session_id"), str) and bool(payload["session_id"])
                and payload.get("requester_sessions") == {payload.get("issue_id"): payload["session_id"]}
                and ((content.get("type") in ("response", "error", "thought", "elicitation")
                      and isinstance(content.get("body"), str))
                     or (content.get("type") == "action" and payload.get("ephemeral") is True
                         and isinstance(content.get("action"), str) and isinstance(content.get("parameter"), str))))

    def normalize_conversation_reply(self, row_id: str) -> dict | None:
        """Recover old reply coordinates without changing its identity, content or attempt history."""
        with self._tx() as db:
            row = self.outbox_row(row_id)
            if not row or row["state"] != "pending" or not self.conversation_reply(row["kind"], row["payload"]):
                return row
            payload = row["payload"]
            # Before interim replies existed, queue_reply emitted only finals, including
            # a thought when native work remained live. Recognize that exact old shape
            # before grafting coordinates; a modern/ambiguous thought remains readback-only.
            legacy_final_thought = (payload["content"]["type"] == "thought" and not any(
                key in payload for key in ("source_activity", "turn_activity", "source_cursor", "turn_final",
                    "write_started", "native_prompt", "one_try", "signal", "signal_metadata", "lifecycle_repair_of")))
            source = payload.get("source_activity")
            if source is None:
                activities = payload.get("requester_activities")
                if activities is not None:
                    if not isinstance(activities, dict) or set(activities) != {payload["issue_id"]}:
                        raise ValueError("legacy reply requester activity is ambiguous")
                    source = activities[payload["issue_id"]]
                else:
                    source = payload["session_id"]  # The original created-session requester scope.
            if not isinstance(source, str) or not source or source != source.strip():
                raise ValueError("legacy reply source is unavailable")
            updated = {"source_activity": source, "turn_activity": payload.get("turn_activity", source),
                       "source_cursor": payload.get("source_cursor", 0)}
            if not payload.get("lifecycle_repair_of") and (
                    payload["content"]["type"] in ("response", "error") or legacy_final_thought):
                updated["turn_final"] = True  # Recover the old producer's final intent, never a UI repair.
            if any(payload.get(key) != value for key, value in updated.items()):
                payload = {**payload, **updated}
                db.execute("UPDATE outbox SET payload=? WHERE id=?", (json.dumps(payload), row_id))
                row["payload"] = payload
            return row

    def conversation_cursor(self, issue_id: str, session_id: str) -> int:
        """Outbox boundary when a new verified provider input is admitted."""
        with self._tx() as db:
            return db.execute(
                "SELECT COALESCE(MAX(rowid), 0) FROM outbox WHERE kind='activity' "
                "AND json_extract(payload, '$.issue_id')=? AND json_extract(payload, '$.session_id')=?",
                (issue_id, session_id)).fetchone()[0]
    @staticmethod
    def _conversation_input_key(issue_id: str, session_id: str) -> str:
        return "native-reply-anchor:" + json.dumps([issue_id, session_id], separators=(",", ":"))

    def conversation_input(self, issue_id: str, session_id: str) -> dict | None:
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?",
                (self._conversation_input_key(issue_id, session_id),)).fetchone()
            return json.loads(row[0]) if row else None

    def remember_conversation_input(self, issue_id: str, session_id: str, activity_id: str,
                                    admission_id: str, sequence: int, terminal: bool,
                                    session_keys: list[str] | None = None) -> dict | None:
        """Project Core's newest receipt as the reply anchor, never webhook arrival order.

        This is one delivery projection per conversation, not an input receipt ledger.
        Reconciliation keeps the original outbox cursor and cannot reopen a finished input.
        """
        if not isinstance(admission_id, str) or not admission_id or type(sequence) is not int or sequence < 1:
            raise ValueError("Native reply anchor requires a committed input receipt")
        with self._tx() as db:
            saved = self.conversation_input(issue_id, session_id)
            if saved and sequence == saved["sequence"] and admission_id != saved["admission_id"]:
                raise ValueError("Native reply anchor has a conflicting input receipt")
            if terminal or saved and sequence <= saved["sequence"]:
                return saved
            anchor = {"activity_id": activity_id, "admission_id": admission_id, "sequence": sequence,
                      "cursor": self.conversation_cursor(issue_id, session_id),
                      "session_keys": list(session_keys or [])}
            db.execute("INSERT INTO metadata(key,value) VALUES (?,?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (self._conversation_input_key(issue_id, session_id), json.dumps(anchor)))
            return anchor

    def conversation_step_superseded(self, row_id: str) -> bool:
        """A delayed ephemeral line must not replace newer input, messages or questions."""
        with self._tx() as db:
            row = db.execute("SELECT payload FROM outbox WHERE id=?", (row_id,)).fetchone()
            if row is None:
                return True
            payload = json.loads(row["payload"])
            current = self.conversation_input(payload["issue_id"], payload["session_id"])
            if current is None or current["activity_id"] != payload.get("source_activity"):
                return True
            return db.execute(
                "SELECT 1 FROM outbox old JOIN outbox newer ON newer.rowid > old.rowid "
                "WHERE old.id=? AND newer.kind='activity' AND newer.state != 'failed' "
                "AND COALESCE(json_extract(newer.payload, '$.applied'), 1) != 0 "
                "AND json_extract(newer.payload, '$.issue_id')=json_extract(old.payload, '$.issue_id') "
                "AND json_extract(newer.payload, '$.session_id')=json_extract(old.payload, '$.session_id') LIMIT 1",
                (row_id,)).fetchone() is not None

    def conversation_finished(self, issue_id: str, session_id: str, source_activity: str,
                              source_cursor: int = 0) -> bool:
        """A reply closes its owning input; unscoped native completion fences the session.

        A queued input may have been admitted before its predecessor's final reply. That
        predecessor must not close the queued input, even if its outbox row is newer.
        """
        with self._tx() as db:
            return db.execute(
                "SELECT 1 FROM outbox WHERE kind='activity' AND state != 'failed' "
                "AND json_type(payload, '$.lifecycle_repair_of') IS NULL "
                "AND (COALESCE(json_extract(payload, '$.applied'), 1) != 0 OR json_extract(payload, '$.turn_final')=1) "
                "AND json_extract(payload, '$.issue_id')=? AND json_extract(payload, '$.session_id')=? "
                "AND (json_extract(payload, '$.turn_final')=1 OR "
                "json_extract(payload, '$.content.type') IN ('response', 'error')) "
                "AND ((json_extract(payload, '$.native_reply_version')=1 AND "
                "COALESCE(json_extract(payload, '$.turn_activity'),json_extract(payload, '$.source_activity'))=?) "
                "OR (json_extract(payload, '$.native_reply_version') IS NULL AND rowid>?)) LIMIT 1",
                (issue_id, session_id, source_activity, source_cursor)).fetchone() is not None

    def newer_conversation_input_open(self, issue_id: str, session_id: str, source_activity: str) -> bool:
        anchor = self.conversation_input(issue_id, session_id)
        return bool(anchor and anchor["activity_id"] != source_activity and not self.conversation_finished(
            issue_id, session_id, anchor["activity_id"], anchor["cursor"]))

    def conversation_final_projection(self, payload: dict, *, native_work_live: bool,
                                      core_latest_activity: str | None = None) -> str | None:
        """Project completion at publication; None means a later completion superseded it."""
        issue, session = payload["issue_id"], payload["session_id"]
        source = payload.get("turn_activity", payload["source_activity"])
        with self._tx() as db:
            # Native work's unscoped Done remains a session fence, independent of chat receipts.
            done = db.execute("SELECT 1 FROM outbox WHERE kind='activity' AND state!='failed' "
                "AND COALESCE(json_extract(payload,'$.applied'),1)!=0 "
                "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.session_id')=? "
                "AND json_extract(payload,'$.native_reply_version') IS NULL "
                "AND json_extract(payload,'$.content.type') IN ('response','error') AND rowid>? LIMIT 1",
                (issue, session, payload.get("source_cursor", 0))).fetchone()
            if done:
                return None
            if core_latest_activity is not None:
                if core_latest_activity != source and not native_work_live:
                    return None  # Core already settled a newer input, even if its ACK callback is late.
                return "thought" if native_work_live else "response"
            anchor = self.conversation_input(issue, session)
            if anchor and anchor["activity_id"] != source:
                if self.conversation_finished(issue, session, anchor["activity_id"], anchor["cursor"]):
                    return "thought" if native_work_live else None
                return "thought"
            return "thought" if native_work_live else "response"

    def reproject_conversation_final(self, row_id: str, expected: dict, content: dict) -> bool:
        """CAS only an unattempted body; another sender's frozen request cannot be rewritten."""
        with self._tx() as db:
            row = self.outbox_row(row_id)
            if (not row or row["state"] != "pending" or row["payload"].get("write_started") is not False
                    or row["payload"].get("content") != expected):
                return False
            db.execute("UPDATE outbox SET payload=json_set(payload,'$.content',json(?)) WHERE id=?",
                       (json.dumps(content), row_id))
            return True

    def conversation_not_attempted(self, row_id: str, attempt_id: str) -> None:
        """Only a pre-transport guard or definitive rejection may clear a fresh attempt."""
        with self._tx() as db:
            db.execute("UPDATE outbox SET payload=json_set(payload,'$.write_started',json('false')) "
                       "WHERE id=? AND state='pending' AND json_extract(payload,'$.native_reply_version')=1 "
                       "AND json_extract(payload,'$.conversation_attempt_id')=?", (row_id, attempt_id))

    def record_question_answer(self, question_id: str, activity_id: str, actor_id: str) -> None:
        """Keep the successful human decision on its existing displayed question receipt."""
        with self._tx() as db:
            row = self.outbox_row(question_id)
            payload = (row or {}).get("payload", {})
            prompt = payload.get("native_prompt") or {}
            fields = ("kind", "session_key", "request_id", "clarify_id", "question", "choices", "multi_select")
            identity = tuple(prompt.get(key) for key in fields)
            rows = db.execute("SELECT id,payload FROM outbox WHERE kind='activity' "
                "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.session_id')=? "
                "AND json_type(payload,'$.native_prompt')='object' AND json_type(payload,'$.answered_by') IS NULL",
                (payload.get("issue_id"), payload.get("session_id"))).fetchall()
            for candidate in rows:
                other = json.loads(candidate["payload"])["native_prompt"]
                if tuple(other.get(key) for key in fields) == identity:
                    db.execute("UPDATE outbox SET payload=json_set(payload,'$.answered_by',?,'$.answer_actor',?) WHERE id=?",
                               (activity_id, actor_id, candidate["id"]))

    def conversation_questions(self, issue_id: str, session_id: str) -> list[dict]:
        """Published or delivery-uncertain questions retain their exact Core prompt identity."""
        with self._tx() as db:
            rows = db.execute("SELECT payload FROM outbox WHERE kind='activity' "
                "AND json_extract(payload,'$.native_reply_version')=1 "
                "AND json_extract(payload,'$.content.type')='elicitation' "
                "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.session_id')=? "
                "AND COALESCE(json_extract(payload,'$.applied'),1)!=0 "
                "AND json_type(payload,'$.native_prompt')='object' "
                "AND (state='sent' OR json_extract(payload,'$.write_started')=1 "
                "OR (attempts>0 AND json_type(payload,'$.write_started') IS NULL)) ORDER BY rowid",
                (issue_id, session_id))
            return [json.loads(row[0]) for row in rows]

    def conversation_question_candidates(self, issue_id: str, session_id: str) -> list[dict]:
        """Possible current presentations; the caller must verify the exact live Core request."""
        with self._tx() as db:
            rows = db.execute("SELECT payload FROM outbox WHERE kind='activity' AND hold_reason IS NULL "
                "AND json_extract(payload,'$.native_reply_version')=1 "
                "AND json_extract(payload,'$.content.type')='elicitation' "
                "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.session_id')=? "
                "AND COALESCE(json_extract(payload,'$.applied'),1)!=0 "
                "AND json_type(payload,'$.native_prompt')='object' AND json_type(payload,'$.answered_by') IS NULL "
                "AND (state IN ('pending','sent') OR json_extract(payload,'$.write_started')=1 "
                "OR (attempts>0 AND json_type(payload,'$.write_started') IS NULL)) ORDER BY rowid DESC",
                (issue_id, session_id))
            return [json.loads(row[0]) for row in rows]

    @staticmethod
    def reporting_notice(kind: str, payload: dict[str, Any]) -> bool:
        return (kind == "activity" and payload.get("reporting_notice_version") == 1
                and payload.get("one_try") is True and bool(payload.get("session_id"))
                and (payload.get("content") or {}).get("type") in ("response", "error", "thought")
                and not any(payload.get(key) for key in (
                    "work_owner", "session_key", "admission_id", "claim", "release", "stop_intent_id", "task_id", "terminal")))
    @classmethod
    def independent_comment(cls, kind: str, payload: dict[str, Any]) -> bool:
        # Adding a new authorized comment does not resolve or repeat an earlier mutation.
        return kind == "comment" and cls.unlinked_content(kind, payload)
    @classmethod
    def independent_message(cls, kind: str, payload: dict[str, Any]) -> bool:
        return (kind == "comment" or cls.conversation_reply(kind, payload)) and cls.unlinked_content(kind, payload)
    @classmethod
    def _delivery_hold_reason(cls, db: sqlite3.Connection, kind: str, payload: dict[str, Any]) -> str | None:
        if cls.unlinked_content(kind, payload):
            return None
        if any(payload.get(key) for key in ("work_owner", "session_key", "admission_id", "claim", "release", "stop_intent_id")):
            return "Retained execution-derived delivery requires explicit reconciliation; automatic replay is disabled"
        if cls.reporting_notice(kind, payload):
            return None  # A newly authorized refusal is reporting, never task admission.
        targets = cls._targets(payload)
        if not targets or not payload.get("task_id"):
            return "Unverified retained delivery has no native reporting binding; inspect its original effect history"
        matched_task = False
        for issue_id in targets:
            work = db.execute("SELECT origin,task_id FROM work WHERE issue_id=?", (issue_id,)).fetchone()
            binding = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-binding:{issue_id}",)).fetchone()
            if not work or work["origin"] != "native" or not binding:
                return "Retained or missing work cannot authorize automatic reporting replay"
            saved = json.loads(binding[0])
            if (saved.get("issue_id") != issue_id or saved.get("task_id") != work["task_id"]
                    or not saved.get("profile") or not saved.get("board")):
                return "Native reporting binding does not match the retained delivery; reconcile before migration"
            matched_task = matched_task or payload["task_id"] == work["task_id"]
            if kind != "project_update" and payload["task_id"] != work["task_id"]:
                return "Native reporting binding does not match the retained delivery; reconcile before migration"
        return None if matched_task else "Native report has no matching task binding; reconcile before migration"
    @staticmethod
    def _hold_marker(db: sqlite3.Connection) -> str | None:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (HOLD_INPUTS,)).fetchone()
        return f"{HOLD_RULES_VERSION}:{row[0]}" if row else None
    @classmethod
    def _hold_legacy_outbox(cls, db: sqlite3.Connection) -> None:
        # The scan is idempotent and holds are monotone, so with unchanged inputs it changes
        # nothing. The marker lives in this transaction, so it rolls back with the scan.
        marker = cls._hold_marker(db)
        if marker is not None:
            scanned = db.execute("SELECT value FROM metadata WHERE key=?", (HOLD_SCANNED,)).fetchone()
            if scanned is not None and scanned[0] == marker:
                return
        cls._hold_scan(db)
        if cls._hold_marker(db) is None:
            db.execute(_HOLD_BUMP)  # A database with no recorded change yet starts counting here.
        # The scan's own hold_reason writes bump the counter: record the value after them.
        db.execute("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (HOLD_SCANNED, cls._hold_marker(db)))
    @classmethod
    def _hold_scan(cls, db: sqlite3.Connection) -> None:
        # Preserve request/effect history exactly: holding changes only this nullable column.
        # Historical sent rows stay sent, but cannot become current native receipts.
        rows = db.execute("SELECT id,kind,payload FROM outbox WHERE state IN ('pending','failed','sent') AND hold_reason IS NULL").fetchall()
        for row in rows:
            reason = cls._delivery_hold_reason(db, row["kind"], json.loads(row["payload"]))
            if reason:
                db.execute("UPDATE outbox SET hold_reason=? WHERE id=?", (reason, row["id"]))
        # A native dependent must not launder an older release/admission receipt.
        changed = True
        while changed:
            changed = False
            for row in db.execute("SELECT id,payload FROM outbox WHERE state IN ('pending','failed','sent') AND hold_reason IS NULL").fetchall():
                payload = json.loads(row["payload"])
                dependencies = {payload.get("requires_status_id"), *(payload.get("terminal_lines") or {}).values()} - {None, ""}
                if any(db.execute("SELECT 1 FROM outbox WHERE id=? AND hold_reason IS NOT NULL", (key,)).fetchone() for key in dependencies):
                    db.execute("UPDATE outbox SET hold_reason=? WHERE id=?",
                               ("Reporting depends on a retained delivery requiring explicit reconciliation", row["id"]))
                    changed = True
    def delivery_allowed(self, row_id: str) -> bool:
        """Fence every consumer, including direct sends and send admission, before effects."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT hold_reason FROM outbox WHERE id=?", (row_id,)).fetchone()
            return bool(row and row[0] is None)
    @staticmethod
    def _admitted(db: sqlite3.Connection, *issue_ids: str) -> bool:
        return all(not db.execute("SELECT 1 FROM specialist_scope_fence WHERE issue_id=?", (ident,)).fetchone()
                   for ident in issue_ids if ident)
    @staticmethod
    def _unresolved_terminal(db: sqlite3.Connection, issue_id: str, *, except_id: str = "") -> list[dict[str, str]]:
        """Attempted terminal writes, oldest first, whose effect stays unknown until an explicit durable resolution."""
        if not issue_id or issue_id.startswith("update:"):
            return []
        rows = db.execute("SELECT id, kind, state, attempts, payload FROM outbox WHERE kind IN ('status','description','delegate') AND "
                          "json_extract(payload, '$.issue_id')=? ORDER BY rowid", (issue_id,)).fetchall()
        return [{"id": row["id"], "kind": row["kind"]} for row in rows
                if row["id"] != except_id and Store.uncertain(row, json.loads(row["payload"]))]
    @staticmethod
    def uncertain(row, payload: dict[str, Any]) -> bool:
        """An attempted terminal or content write whose remote effect stays unknown until resolved."""
        return bool((payload.get("terminal") or payload.get("content_action") or
                     (row["kind"] == "status" and (payload.get("write_started") is True or payload.get("reconcile_required"))))
                    and not payload.get("reconciliation") and (
            payload.get("reconcile_required") or (row["state"] in ("pending", "failed") and (
                payload.get("write_started") is True or (row["attempts"] > 0 and "write_started" not in payload)))))
    @classmethod
    def _effect_admitted(cls, db: sqlite3.Connection, *issue_ids: str, except_id: str = "") -> bool:
        return cls._admitted(db, *issue_ids) and all(
            not cls._unresolved_terminal(db, ident, except_id=except_id)
            and not cls._pending_chat_transfer(db, ident) for ident in issue_ids)
    @staticmethod
    def _pending_chat_transfer(db: sqlite3.Connection, issue_id: str) -> dict | None:
        for row in db.execute("SELECT value FROM metadata WHERE key LIKE 'chat-transfer:%'"):
            transfer = json.loads(row[0])
            if transfer["issue_id"] == issue_id and transfer["state"] in ("prepared", "committed"):
                return transfer
        return None
    @staticmethod
    def _predecessor_transfer_blocks(db: sqlite3.Connection, issue_id: str, payload: dict) -> bool:
        for row in db.execute("SELECT value FROM metadata WHERE key LIKE 'chat-transfer:%'"):
            saved = json.loads(row[0])
            if saved["issue_id"] == issue_id and (
                    payload.get("work_owner") == saved["predecessor"]["ownership_id"] or
                    payload.get("session_key") == saved["predecessor"]["owner_ref"]):
                return True
        return False
    def predecessor_transfer_blocks(self, issue_id: str, payload: dict) -> bool:
        with self._tx() as db:
            return self._predecessor_transfer_blocks(db, issue_id, payload)
    def issue_reconciliation_blocked(self, issue_id: str, *, except_id: str = "") -> list[dict[str, str]]:
        """Falsy when the issue is free; otherwise the held writes, so a refusal can name them."""
        with self._tx() as db:
            return self._unresolved_terminal(db, issue_id, except_id=except_id)
    @contextmanager
    def guard_issue_work(self, issue_id: str) -> Iterator[bool]:
        with self._tx() as db:
            yield self._effect_admitted(db, issue_id)
    def admit_mutation(self, row_id: str, *, terminal: bool = False,
                       expected_content: dict | None = None, conversation_attempt_id: str | None = None,
                       require_unattempted: bool = False, mutation_attempt_id: str | None = None) -> bool:
        """Persist a remote-send marker without using a Linear record as execution authority."""
        if getattr(self._local, "db", None) is not None:
            raise RuntimeError("mutation admission requires its own commit")
        with self._tx() as db:
            row = db.execute("SELECT kind, state, payload FROM outbox WHERE id=?", (row_id,)).fetchone()
            if not row or row["state"] != "pending":
                return False
            self._hold_legacy_outbox(db)
            if not self.delivery_allowed(row_id):
                return False
            payload = json.loads(row["payload"])
            if payload.get("native_outcome_pointer") and not self.outcome_comment_applied(payload):
                return False  # Atomically order the sole terminal pointer behind its verified full comment.
            if (self.after_native_session_history(row['kind'], payload) and
                    self.unsettled_native_session_history(payload['issue_id'], payload['session_id'])):
                return False  # A later question/final must not be reopened by retained session history.
            if expected_content is not None and payload.get("content") != expected_content:
                return False
            if require_unattempted and payload.get("write_started") is not False:
                return False  # Another sender started after this caller read the fresh row.
            if (row['kind'] == 'activity' and payload.get('content', {}).get('type') in ('response', 'error') and
                    self.unsettled_worker_action(payload['issue_id'], payload['session_id'])):
                return False  # Same transaction as the closing publication's send marker.
            if (payload.get("native_history") is True or payload.get("native_progress") is True) and payload.get("requires_status_id"):
                dependency = self.outbox_row(payload["requires_status_id"])
                if not self.history_status_settled(dependency):
                    return False
            targets = self._targets(payload)
            if not self.conversation_reply(row["kind"], payload) and not self._admitted(db, *targets):
                return False
            # A normal authorized issue edit/comment is independent of retained chat ownership.
            # An uncertain prior remote mutation still requires external reconciliation.
            if self.reporting_notice(row["kind"], payload):
                pass  # Informational replies do not repeat or resolve any earlier effect.
            elif payload.get("content_action"):
                if not self.independent_message(row["kind"], payload) and any(self._unresolved_terminal(db, target, except_id=row_id) for target in targets):
                    return False
            else:
                if not self._effect_admitted(db, *targets, except_id=row_id):
                    return False
                if any(self._predecessor_transfer_blocks(db, target, payload) for target in targets):
                    return False
                if payload.get("work_owner") and self.superseded({"id": row_id, "payload": payload}):
                    return False
            native_progress = (row["kind"] in ("comment", "activity") and
                               (payload.get("native_progress") is True or payload.get("native_history") is True)
                               and payload.get("task_id"))
            if terminal or payload.get("terminal") and row["kind"] in ("comment", "activity") or native_progress or self.conversation_reply(row["kind"], payload) or row["kind"] in ("status", "description", "delegate", "project_update"):
                # Every sender replaces this token, including callers that only use
                # the legacy admission API. An older guard cannot clear its marker.
                attempt_id = mutation_attempt_id or uuid.uuid4().hex
                if self.conversation_reply(row["kind"], payload) and conversation_attempt_id:
                    return bool(db.execute("UPDATE outbox SET payload=json_set(payload,'$.write_started',json('true'), "
                        "'$.mutation_attempt_id',?,'$.conversation_attempt_id',?) WHERE id=?",
                        (attempt_id, conversation_attempt_id, row_id)).rowcount)
                return bool(db.execute("UPDATE outbox SET payload=json_set(payload,'$.write_started',json('true'), "
                    "'$.mutation_attempt_id',?) WHERE id=?", (attempt_id, row_id)).rowcount)
            return True

    def mutation_not_attempted(self, row_id: str, attempt_id: str) -> bool:
        """Restore only this sender's proven pre-transport state, never another attempt."""
        with self._tx() as db:
            row = self.outbox_row(row_id)
            payload = (row or {}).get("payload", {})
            if (not row or row["state"] != "pending" or payload.get("write_started") is not True
                    or payload.get("mutation_attempt_id") != attempt_id):
                return False
            db.execute("UPDATE outbox SET payload=json_set(payload,'$.write_started',json('false')) WHERE id=?", (row_id,))
            if payload.get("native_history") is True or payload.get("native_progress") is True:
                self._sequence_native_history(db, payload["issue_id"])
            return True

    def delegate_not_applied(self, row_id: str, *, started_before: bool | None,
                             attempt_id: str | None = None) -> bool:
        """Only an affirmative HTTP rejection can undo this attempt's send marker."""
        if started_before is not False:
            return False
        with self._tx() as db:
            row = db.execute("SELECT kind,state,payload FROM outbox WHERE id=?", (row_id,)).fetchone()
            if not row or row["kind"] != "delegate" or row["state"] != "pending":
                return False
            payload = json.loads(row["payload"])
            if attempt_id is not None and payload.get("mutation_attempt_id") != attempt_id:
                return False
            if payload.get("delegate_routing_version") != 1 or payload.get("reconcile_required") or payload.get("delegate_receipt"):
                return False
            db.execute("UPDATE outbox SET payload=json_set(payload, '$.write_started', json('false')) WHERE id=?", (row_id,))
            return True

    def reconcile_terminal(self, row_id: str, *, outcome: str, evidence: str, at: float) -> bool:
        """Record an operator's verified remote outcome; keep the attempted receipt intact."""
        if outcome not in ("applied", "not_applied") or not evidence.strip():
            raise ValueError("terminal reconciliation requires a verified outcome and evidence")
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT kind, state, attempts, payload, hold_reason FROM outbox WHERE id=?", (row_id,)).fetchone()
            if not row or row["kind"] not in ("status", "description", "delegate"): return False
            payload = json.loads(row["payload"])
            if payload.get("reconciliation") or not self.uncertain(row, payload) and not row["hold_reason"]: return False
            payload["reconciliation"] = {"outcome": outcome, "evidence": evidence.strip(), "at": at}
            payload["reconcile_required"], payload["reported"] = True, 1  # the operator acted; no alert
            if payload.get("release"):
                payload["applied"] = int(outcome == "applied")
                # External release verification is not proof that retained execution ended.
                # Keep its checkpoints, Stop and ownership/effect history unchanged.
            state = "sent" if (payload.get("release") and payload.get("applied") or
                               row["kind"] == "delegate" and outcome == "applied") else "failed"
            db.execute("UPDATE outbox SET payload=?, state=? WHERE id=?", (json.dumps(payload), state, row_id))
            return True
    DISMISSED = "dismissed-delivery:"
    def dismiss_parked(self, marker: str, *, evidence: str, at: float) -> bool:
        """Record an operator's dismissal of one parked inbox delivery and retire its unsent notice.

        Nothing is deleted or replayed: the inbox row stays as it is, and the notice keeps its body
        with the recorded evidence. A notice whose send already started is left for resolution."""
        if not marker or not evidence.strip():
            raise ValueError("dismissal requires the parked delivery and the evidence checked")
        record = {"outcome": "dismissed", "evidence": evidence.strip(), "at": at}
        with self._tx() as db:
            if db.execute("SELECT 1 FROM metadata WHERE key=?", (self.DISMISSED + marker,)).fetchone():
                return False
            db.execute("INSERT INTO metadata (key, value) VALUES (?, ?)", (self.DISMISSED + marker, json.dumps(record)))
            for row in db.execute("SELECT id, payload FROM outbox WHERE state != 'sent' AND "
                                  "json_extract(payload, '$.parked_delivery') = ?", (marker,)).fetchall():
                payload = json.loads(row["payload"])
                if payload.get("reconciliation") or payload.get("write_started"):
                    continue
                payload.update(reconciliation=record, reconcile_required=True, reported=1)
                db.execute("UPDATE outbox SET payload=?, state='failed' WHERE id=?", (json.dumps(payload), row["id"]))
            return True
    @staticmethod
    def _targets(payload: dict[str, Any]) -> set[str]:
        return {ident for ident in (payload.get("owner_issue_id"), payload.get("resolve"),
                                    *(payload.get("line_issues") or {}).values(),
                                    payload.get("issue_id") if not str(payload.get("issue_id", "")).startswith("update:")
                                    else None) if ident}
    def _row_admitted(self, db: sqlite3.Connection, row_id: str, state: str | None = None) -> bool:
        self._hold_legacy_outbox(db)
        row = db.execute("SELECT kind, state, payload, hold_reason FROM outbox WHERE id=?", (row_id,)).fetchone()
        if not row or row["hold_reason"] is not None or state is not None and row["state"] != state:
            return False
        payload = json.loads(row["payload"])
        return self.conversation_reply(row["kind"], payload) or self._admitted(db, *self._targets(payload))
    @contextmanager
    def guard_outbox(self, row_id: str, state: str = "pending") -> Iterator[bool]:
        with self._tx() as db:
            yield self._row_admitted(db, row_id, state)
    @contextmanager
    def guard_issue(self, issue_id: str) -> Iterator[bool]:
        with self._tx() as db:
            yield self._admitted(db, issue_id)
    def activation_cutoff_ms(self, configured: int | None = None) -> int | None:
        """Persist the first fresh-work cutoff; never replace legacy or differently-cut state."""
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='activation_cutoff_ms'").fetchone()
            if row:
                stored = int(row["value"])
                if configured is not None and configured != stored:
                    raise ValueError("linear: activation_cutoff_ms cannot change after it is persisted")
                return stored
            if configured is None:
                return None
            for table in ("work", "outbox", "chat_stop"):
                if db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():
                    raise ValueError("linear: cannot establish activation_cutoff_ms over existing work state")
            db.execute("INSERT INTO metadata (key, value) VALUES ('activation_cutoff_ms', ?)", (str(configured),))
            return configured
    # -- work -------------------------------------------------------------
    def get(self, issue_id: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM work WHERE issue_id = ?", (issue_id,)).fetchone()
        return dict(row) if row else None
    def native_boards(self) -> set[str]:
        """Every board a native binding (current or finished) was recorded on."""
        with self._tx() as db:
            rows = db.execute("SELECT json_extract(value, '$.board') FROM metadata "
                              "WHERE key LIKE 'native-binding:%'").fetchall()
        return {row[0] for row in rows if isinstance(row[0], str) and row[0]}
    def native_binding(self, issue_id: str, profile: str | None = None,
                       board: str | None = None) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?",
                             (f"native-binding:{issue_id}",)).fetchone()
            work = db.execute("SELECT origin,task_id FROM work WHERE issue_id=?", (issue_id,)).fetchone()
        if not row or not work or work["origin"] != "native":
            return None
        binding = json.loads(row[0])
        if (binding["task_id"] != work["task_id"] or
                (profile is not None and binding["profile"] != profile) or
                (board is not None and binding["board"] != board)):
            return None
        return binding
    def bind_native(self, issue_id: str, task_id: str, profile: str, board: str | None,
                    owner_ref: str = "", project_id: str | None = None, *,
                    requester_activity: str | None = None, completion_scope: dict | None = None, at: float) -> bool:
        """Link an inspected task without claiming, resuming or adopting legacy work."""
        if any(not isinstance(value, str) or not value.strip() for value in (issue_id, task_id, profile)):
            raise ValueError("native binding needs an issue, task and profile")
        binding = {"issue_id": issue_id, "task_id": task_id, "profile": profile,
                   "board": board or "default"}
        if completion_scope is not None:
            binding["completion_scope"] = self.validate_completion_scope(completion_scope)
        if requester_activity is not None:
            if not owner_ref or not isinstance(requester_activity, str) or not requester_activity or requester_activity == owner_ref:
                raise ValueError("native reporting needs distinct session and Activity coordinates")
            binding.update(requester_session_id=owner_ref, requester_activity_id=requester_activity)
        with self._tx() as db:
            work = db.execute("SELECT origin,task_id FROM work WHERE issue_id=?", (issue_id,)).fetchone()
            prior = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-binding:{issue_id}",)).fetchone()
            if work or prior:
                return bool(work and work["origin"] == "native" and prior and json.loads(prior[0]) == binding)
            if (not self._effect_admitted(db, issue_id) or self.retired(issue_id) or
                    db.execute("SELECT 1 FROM chat_admissions WHERE issue_id=? AND state IN "
                               "('prepared','claiming','admitted','ambiguous')", (issue_id,)).fetchone()):
                return False
            db.execute("INSERT INTO work (issue_id,origin,owner_ref,task_id,project_id,last_updated_at,linear_session_id) "
                       "VALUES (?,'native',?,?,?,?,?)", (issue_id,owner_ref,task_id,project_id,at,owner_ref or None))
            db.execute("INSERT INTO metadata (key,value) VALUES (?,?)",
                       (f"native-binding:{issue_id}", json.dumps(binding)))
            return True
    @staticmethod
    def validate_completion_scope(value: dict) -> dict:
        """A reporting boundary, never permission to execute or a second task state."""
        if (not isinstance(value, dict) or set(value) != {"mode", "task_spec_sha256", "specified_event_id"}
                or not isinstance(value.get("mode"), str) or value["mode"] not in ("outcome", "progress")
                or not isinstance(value.get("task_spec_sha256"), str)
                or len(value["task_spec_sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in value["task_spec_sha256"])
                or type(value.get("specified_event_id")) is not int or value["specified_event_id"] < 0):
            raise ValueError("Invalid native completion reporting scope")
        return dict(value)
    @staticmethod
    def _binding_snapshot(db: sqlite3.Connection, issue_id: str) -> dict[str, Any]:
        work = db.execute("SELECT * FROM work WHERE issue_id=?", (issue_id,)).fetchone()
        binding = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-binding:{issue_id}",)).fetchone()
        return {"work": dict(work) if work else None, "native_binding": binding[0] if binding else None}
    @staticmethod
    def _binding_revision(issue_id: str, snapshot: dict[str, Any]) -> str:
        # Include absence and the exact stored binding text, not only its parsed target.
        value = json.dumps({"issue_id": issue_id, **snapshot}, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return hashlib.sha256(value.encode()).hexdigest()
    def binding_revision(self, issue_id: str) -> str:
        """Token for an exact inspected reporting projection; it proves no execution state."""
        with self._tx() as db:
            return self._binding_revision(issue_id, self._binding_snapshot(db, issue_id))
    @classmethod
    def _hold_superseded_reports(cls, db: sqlite3.Connection, issue_id: str) -> None:
        # Do not rewrite an attempted request or reinterpret a historical sent receipt.
        # Ordinary content is independent of execution, including uncertain descriptions.
        reason = "Reporting binding was explicitly replaced; retained delivery must not be replayed"
        superseded = set()
        for row in db.execute("SELECT id,kind,payload,hold_reason FROM outbox").fetchall():
            payload = json.loads(row["payload"])
            if issue_id in cls._targets(payload) and not cls.unlinked_content(row["kind"], payload):
                superseded.add(row["id"])
                if row["hold_reason"] is None:
                    db.execute("UPDATE outbox SET hold_reason=? WHERE id=?", (reason, row["id"]))
        changed = True
        while changed:
            changed = False
            for row in db.execute("SELECT id,payload FROM outbox WHERE hold_reason IS NULL").fetchall():
                payload = json.loads(row["payload"])
                dependencies = {payload.get("requires_status_id"), *(payload.get("terminal_lines") or {}).values()} - {None, ""}
                if dependencies & superseded:
                    db.execute("UPDATE outbox SET hold_reason=? WHERE id=?",
                               ("Reporting depends on a superseded delivery; retained history must not be replayed", row["id"]))
                    superseded.add(row["id"])
                    changed = True
    def replace_native_binding(self, issue_id: str, task_id: str, profile: str, board: str | None, *,
                               expected_revision: str, request_id: str, owner_ref: str = "",
                               project_id: str | None = None, requester_activity: str | None = None,
                               completion_scope: dict | None = None, reconcile_complete: bool = False,
                               at: float) -> dict[str, Any] | None:
        """Explicitly replace reporting after caller inspection, never native execution.

        Archive the exact prior projection in the existing immutable intent. Uncertain
        effects, Stop/admission/transfer records and specialist fences remain untouched.
        A stale inspection or scope fence returns None; conflicting request reuse fails.
        """
        if any(not isinstance(value, str) or not value.strip() for value in (issue_id, task_id, profile)):
            raise ValueError("native binding needs an issue, task and profile")
        if (board is not None and (not isinstance(board, str) or not board.strip()) or
                not isinstance(owner_ref, str) or project_id is not None and not isinstance(project_id, str)):
            raise ValueError("native binding has invalid board or reporting scope")
        try:
            parsed = uuid.UUID(request_id)
        except (ValueError, TypeError, AttributeError):
            raise ValueError("reporting replacement needs a canonical request UUIDv4") from None
        if parsed.version != 4 or str(parsed) != request_id:
            raise ValueError("reporting replacement needs a canonical request UUIDv4")
        if (not isinstance(expected_revision, str) or len(expected_revision) != 64 or
                any(char not in "0123456789abcdef" for char in expected_revision)):
            raise ValueError("reporting replacement needs an inspected binding revision")
        binding = {"issue_id": issue_id, "task_id": task_id, "profile": profile, "board": board or "default"}
        if completion_scope is not None:
            binding["completion_scope"] = self.validate_completion_scope(completion_scope)
        if requester_activity is not None:
            if not owner_ref or not isinstance(requester_activity, str) or not requester_activity or requester_activity == owner_ref:
                raise ValueError("native reporting needs distinct session and Activity coordinates")
            binding.update(requester_session_id=owner_ref, requester_activity_id=requester_activity)
        request = {"binding": binding, "expected_revision": expected_revision,
                   "owner_ref": owner_ref, "project_id": project_id}
        if reconcile_complete:
            request["reconcile_complete"] = True
        key = f"track:{issue_id}:{request_id}"
        with self._tx() as db:
            if not self._admitted(db, issue_id):
                return None
            previous = self._binding_snapshot(db, issue_id)
            prior = self.native_intent(key)
            if prior:
                if prior["payload"].get("request") != request:
                    raise ValueError("native intent key reused with conflicting reporting replacement")
                work = previous["work"] or {}
                current = json.loads(previous["native_binding"]) if previous["native_binding"] else None
                return dict(binding) if (prior["state"] == "applied" and current == binding and
                    work.get("origin") == "native" and work.get("task_id") == task_id and
                    work.get("owner_ref") == owner_ref and work.get("project_id") == project_id) else None
            if self._binding_revision(issue_id, previous) != expected_revision:
                return None
            self.native_intent_prepare(key, {"kind": "track", "issue_id": issue_id, "request": request,
                                            "previous": previous, "at": at})
            work = previous["work"] or {}
            old_binding = json.loads(previous["native_binding"]) if previous["native_binding"] else {}
            same_target = (isinstance(old_binding, dict) and work.get("origin") == "native" and work.get("task_id") == task_id and
                           all(old_binding.get(field) == binding[field] for field in ("issue_id", "task_id", "profile", "board")))
            unchanged = (same_target and old_binding == binding and work.get("owner_ref") == owner_ref
                         and work.get("project_id") == project_id)
            if not unchanged:
                self._hold_superseded_reports(db, issue_id)
                if same_target:
                    # Reporting metadata cannot manufacture a newer execution
                    # instruction or suppress an already valid source Stop.
                    db.execute("UPDATE work SET owner_ref=?,project_id=?,linear_session_id=? WHERE issue_id=?",
                               (owner_ref, project_id, owner_ref or None, issue_id))
                else:
                    db.execute("DELETE FROM work WHERE issue_id=?", (issue_id,))
                    db.execute("INSERT INTO work(issue_id,origin,owner_ref,task_id,project_id,last_updated_at,linear_session_id) "
                               "VALUES (?,'native',?,?,?,?,?)", (issue_id, owner_ref, task_id, project_id, at, owner_ref or None))
                db.execute("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (f"native-binding:{issue_id}", json.dumps(binding)))
            self.native_intent_settle(key, {"state": "applied", "binding": binding,
                "revision": self._binding_revision(issue_id, self._binding_snapshot(db, issue_id))})
            return dict(binding)
    def reconcile_completion(self, issue_id: str, request_id: str, event_id: int,
                             writes: list[tuple[str, dict]], *, at: float,
                             status_required: bool = True) -> bool:
        """Repair missing delivery components without repeating native work or applied effects."""
        key = f"track:{issue_id}:{request_id}"
        with self._tx() as db:
            if not self._report_owner_current(db, issue_id, writes):
                return False
            saved = self.native_intent(key)
            request = (saved or {}).get("payload", {}).get("request", {})
            binding = request.get("binding")
            if (not saved or saved.get("state") != "applied" or request.get("reconcile_complete") is not True
                    or not binding or self.native_binding(issue_id) != binding
                    or binding.get("completion_scope", {}).get("mode") != "outcome"):
                return False
            status = next((payload for kind, payload in writes if kind == "status"
                           and payload.get("terminal") and payload.get("state") == "done"), None)
            proof = (status or {}).get("native_completion") or {}
            if (not status or type(event_id) is not int or event_id <= 0 or proof.get("event_id") != event_id
                    or status.get("issue_id") != issue_id or proof.get("scope") != binding["completion_scope"]
                    or any(proof.get(field) != binding[field] for field in ("task_id", "profile", "board"))):
                return False
            prior = self.outbox_row(request_id)
            if prior:
                if (prior["kind"] != "status" or prior["payload"].get("issue_id") != issue_id
                        or prior["payload"].get("native_completion") != proof
                        or prior["payload"].get("completion_reconcile_request_id") != request_id):
                    raise ValueError("Completion reconciliation UUID conflicts with an existing report")
                if prior["state"] == "sent" and prior["payload"].get("applied", 1) == 0:
                    return False  # Exact requests never acquire a newer reporting timestamp.
            existing = db.execute("SELECT * FROM outbox WHERE kind='status' "
                                  "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.state')='done' "
                                  "AND NOT (state='sent' AND COALESCE(json_extract(payload,'$.applied'),1)=0) "
                                  "ORDER BY CASE WHEN state='sent' AND json_extract(payload,'$.applied')=1 "
                                  "THEN 0 WHEN hold_reason IS NULL THEN 1 ELSE 2 END, rowid DESC",
                                  (issue_id,)).fetchall()
            reusable = prior
            if reusable is None:
                for raw in existing:
                    candidate = {**dict(raw), "payload": json.loads(raw["payload"])}
                    if candidate["payload"].get("native_completion") != proof:
                        continue
                    applied = candidate["state"] == "sent" and candidate["payload"].get("applied") == 1
                    if status_required and applied:
                        continue  # A reopened issue needs a current authorized status intent.
                    reusable = candidate
                    break
            if reusable is not None:
                applied = reusable["state"] == "sent" and reusable["payload"].get("applied") == 1
                if reusable.get("hold_reason") and not applied:
                    return False  # A held or uncertain status is never a delivery receipt.
                for kind, payload in writes:
                    if kind != "comment" or not payload.get("assessment"):
                        continue
                    if self.assessment_comment_id(issue_id, payload["body"], completion=proof):
                        continue
                    current = self.outbox_row(payload["id"])
                    if current:
                        if (current["kind"] != "comment" or current["payload"].get("issue_id") != issue_id
                                or current["payload"].get("body") != payload["body"]
                                or current["payload"].get("completion_reconcile_request_id") != request_id):
                            raise ValueError("Completion reconciliation UUID conflicts with an existing report")
                        if current["state"] == "sent" and current["payload"].get("applied", 1) == 0:
                            return False
                        continue
                    sibling = {**payload, "native_completion": proof,
                               "completion_reconcile_request_id": request_id,
                               "source_ms": saved["payload"]["at"]}
                    dependency = "reconciled_status_id" if reusable.get("hold_reason") else "requires_status_id"
                    sibling[dependency] = reusable["id"]
                    if not self.enqueue("comment", sibling, at=at):
                        return False
            else:
                writes = [(kind, payload) for kind, payload in writes
                          if not (kind == "comment" and payload.get("assessment")
                                  and self.assessment_comment_id(issue_id, payload["body"], completion=proof))]
                writes = [(kind, {**payload, "completion_reconcile_request_id": request_id} if kind == "status" else payload)
                          for kind, payload in writes]
                if not self.finish(issue_id, writes, at=at, status_id=request_id):
                    return False
            db.execute("UPDATE work SET last_event_id=MAX(last_event_id,?) WHERE issue_id=?", (event_id, issue_id))
            return True
    def native_intent(self, key: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-intent:{key}",)).fetchone()
        return json.loads(row[0]) if row else None
    def record_unbound_stop(self, issue_id: str, source_ms: float, *, session_id: str,
                            activity_id: str, actor: str) -> dict[str, Any]:
        """Keep the newest authenticated Stop even across independent service instances."""
        with self._tx():
            key = f"unbound-stop:{issue_id}"
            saved, _ = self.native_intent_prepare(key, {"kind": "stop", "issue_id": issue_id})
            if source_ms >= float(saved.get("source_ms") or 0):
                return self.native_intent_settle(key, {"state": "reconcile", "source_ms": source_ms,
                    "session_id": session_id, "activity_id": activity_id, "actor": actor,
                    "control_version": "native-event-guard-v1",
                    "reason": "Stop arrived before a native binding; inspect any in-flight task creation"})
            return saved
    def native_intent_prepare(self, key: str, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Commit a delivery attempt before the native call; only one caller may send.

        Native task creation/comments are not atomic exactly-once APIs. A crash or lost
        response leaves this intent pending reconciliation, never permission to replay.
        """
        if not key or not isinstance(payload, dict):
            raise ValueError("native intent needs a key and immutable payload")
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-intent:{key}",)).fetchone()
            if row:
                saved = json.loads(row[0])
                if saved["payload"] != payload:
                    raise ValueError("native intent key reused with conflicting payload")
                return saved, False
            saved = {"state": "attempting", "payload": payload}
            db.execute("INSERT INTO metadata (key,value) VALUES (?,?)", (f"native-intent:{key}", json.dumps(saved)))
            return saved, True
    def native_intent_settle(self, key: str, updates: dict[str, Any]) -> dict[str, Any]:
        if updates.get("state") not in ("applied", "reconcile") or "payload" in updates:
            raise ValueError("native intent must retain its request and delivery evidence")
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (f"native-intent:{key}",)).fetchone()
            if not row:
                raise ValueError("native intent was not prepared")
            saved = json.loads(row[0])
            if saved["state"] == "applied":
                if any(saved.get(k) != v for k,v in updates.items()):
                    raise ValueError("applied native intent cannot be rewritten")
                return saved
            saved.update(updates)
            db.execute("UPDATE metadata SET value=? WHERE key=?", (json.dumps(saved),f"native-intent:{key}"))
            return saved
    # -- session-free durable chat admission ------------------------------
    def retired(self, issue_id: str | None = None) -> list[dict]:
        with self._tx() as db:
            return [dict(row) for row in db.execute("SELECT * FROM retirement WHERE ? IS NULL OR issue_id=?", (issue_id, issue_id))]
    @staticmethod
    def _report_owner_current(db: sqlite3.Connection, issue_id: str, writes: list) -> bool:
        expected = [payload["native_report_owner"] for _, payload in writes if "native_report_owner" in payload]
        if not expected:
            return True
        row = db.execute("SELECT owner_ref FROM work WHERE issue_id=? AND origin='native'", (issue_id,)).fetchone()
        return bool(row and all(owner == (row["owner_ref"] or "") for owner in expected))

    def _adopt_unattempted_progress(self, db: sqlite3.Connection, issue_id: str, task_id: str,
                                    session_id: str, at: float | None) -> None:
        # Retry counts include failed reads before transport. Only the committed transport
        # marker decides whether this identity is still safe to replace; absence stays uncertain.
        rows = db.execute("SELECT id,payload FROM outbox WHERE kind='comment' AND state='pending' "
            "AND hold_reason IS NULL AND json_type(payload,'$.write_started')='false' "
            "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.task_id')=? "
            "AND (json_extract(payload,'$.native_history')=1 OR json_extract(payload,'$.native_progress')=1) "
            "AND COALESCE(json_extract(payload,'$.terminal'),0)=0 "
            "AND COALESCE(json_extract(payload,'$.assessment'),0)=0 ORDER BY rowid", (issue_id, task_id)).fetchall()
        for row in rows:
            prior = json.loads(row["payload"])
            permanent = prior.get("native_issue_comment") is True
            if permanent and not prior.get("native_report_content"):
                continue  # An issue milestone never becomes a disposable session fallback.
            content = prior.get("native_report_content") or {"type": "thought", "body": prior["body"]}
            payload = {key: value for key, value in prior.items() if key not in
                       ("id", "body", "session_key", "work_owner", "enqueued_at", "native_report_content", "native_issue_comment")}
            payload.update(session_id=session_id, content=content, native_report_owner=session_id)
            if not self.enqueue("activity", payload, at=at):
                raise ValueError("Adopted native progress could not be queued")
            # This transaction also serializes transport admission: an already-attempted
            # identity never qualifies, and an unattempted sender cannot publish after retirement.
            if not permanent:
                db.execute("UPDATE outbox SET state='sent', payload=json_set(payload,'$.applied',0) WHERE id=?", (row["id"],))

    def adopt_session(self, issue_id: str, task_id: str, session_id: str, *, expected_owner: str,
                      notice: dict | None = None, at: float | None = None) -> bool:
        """Report this bound task's progress in a Linear Agent Session; reporting only, never execution.

        Compare-and-set on the inspected owner (``""`` for work started from chat or by take_over),
        so a concurrent rebind or another session's adoption wins and this one changes nothing.
        Proven-unattempted fallback reports receive a new session destination atomically.
        Attempted or uncertain provider identities retain their original destination.
        """
        if not session_id or session_id == expected_owner:
            raise ValueError("session adoption needs a new Agent Session")
        with self._tx() as db:
            if not self._admitted(db, issue_id):
                return False
            if expected_owner and not self.session_answered(issue_id, expected_owner):
                return False  # Liveness can change after the caller inspects the same owner.
            # Read the current closeout inside the adoption transaction: the reporting
            # pump may have captured it after the caller inspected native completion.
            status = self.outbox_row((self.latest_status(issue_id) or {}).get("id", ""))
            status_payload = status["payload"] if status else {}
            closeout_status_id = (status["id"] if status and not status.get("hold_reason")
                                  and status_payload.get("terminal") and status_payload.get("task_id") == task_id else None)
            changed = db.execute("UPDATE work SET owner_ref=?, linear_session_id=? WHERE issue_id=? AND "
                                 "origin='native' AND task_id=? AND owner_ref=?",
                                 (session_id, session_id, issue_id, task_id, expected_owner)).rowcount
            if not changed:
                return False
            if notice and not self.enqueue("activity", notice, at=at):
                raise ValueError("Native session adoption notice could not be queued")
            self._adopt_unattempted_progress(db, issue_id, task_id, session_id, at)
            if closeout_status_id:
                # The original closeout keeps its immutable destination. Adoption and this
                # new session's dependent closeout commit together, including across restarts.
                source = db.execute("SELECT id,kind,state,attempts,payload FROM outbox WHERE hold_reason IS NULL "
                    "AND kind IN ('comment','activity') AND json_extract(payload,'$.requires_status_id')=? "
                    "AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.terminal')=1 "
                    "AND json_extract(payload,'$.issue_id')=? "
                    "AND COALESCE(json_extract(payload,'$.assessment'),0)=0 "
                    "ORDER BY COALESCE(json_extract(payload,'$.native_outcome_pointer'),0) DESC,rowid LIMIT 1",
                    (closeout_status_id, task_id, issue_id)).fetchone()
                if source is None:
                    raise ValueError("Native closeout has no exact session presentation")
                prior = json.loads(source["payload"])
                status = self.outbox_row(closeout_status_id)["payload"]
                payload = {key: value for key, value in prior.items() if key in
                    ("issue_id", "task_id", "terminal", "owner_issue_id", "requires_status_id",
                     "native_outcome_pointer", "requires_comment_id", "native_completion", "outcome_assessment")}
                regular_outcome = source["kind"] == "comment" and prior.get("native_outcome_comment") is True
                if regular_outcome or prior.get("native_outcome_pointer"):
                    if (status.get("state") != "done" or not status.get("native_completion")
                            or prior.get("native_completion") != status["native_completion"]):
                        raise ValueError("Native adopted closeout has a conflicting completion identity")
                if regular_outcome:
                    from .outcome import POINTER_BODY
                    # This comment is the result, not a disposable no-session fallback.
                    # Keep its exact stable identity/receipt and queue only its dependent pointer.
                    body = POINTER_BODY
                    payload.update(native_outcome_pointer=True, requires_comment_id=source["id"])
                else:
                    body = prior["body"] if source["kind"] == "comment" else prior["content"]["body"]
                payload.update(session_id=session_id, content={"type": "response" if status["state"] == "done" else "error",
                    "body": body})
                payload["write_started"] = False
                if not self.enqueue("activity", payload, at=at):
                    raise ValueError("Native session closeout could not be queued")
                if not regular_outcome and source["state"] == "pending" and prior.get("write_started") is False:
                    # Preserve the original immutable body/destination, but never first
                    # publish its fallback after adoption. Admission races use this same tx.
                    db.execute("UPDATE outbox SET state='sent', payload=json_set(payload,'$.applied',0) WHERE id=?",
                               (source["id"],))
            return True
    def session_answered(self, issue_id: str, session_id: str) -> bool:
        """A delivered response closes this session only when no unresolved effect can reopen it."""
        with self._tx() as db:
            rows = db.execute("SELECT state,hold_reason,payload FROM outbox WHERE kind='activity' "
                "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.session_id')=? "
                "ORDER BY json_extract(payload,'$.enqueued_at') DESC,rowid DESC", (issue_id, session_id)).fetchall()
            latest = None
            for row in rows:
                payload = json.loads(row["payload"])
                if payload.get("applied") == 0 or row["state"] == "failed" and payload.get("write_started") is False:
                    continue  # Proven non-publication cannot keep the session live.
                if row["state"] != "sent" or row["hold_reason"] is not None:
                    return False  # Pending, held and possibly applied failures are not completion evidence.
                if latest is None:
                    latest = payload
            return bool(latest and (latest.get("content") or {}).get("type") == "response")
    def put(self, issue_id: str, origin: str, owner_ref: str, *, task_id: str | None = None,
            project_id: str | None = None, last_updated_at: float = 0.0,
            run_generation: int | None = None) -> bool:
        """Import a retained record without adopting/replacing existing work; grants no execution."""
        with self._tx() as db:
            if not self._effect_admitted(db, issue_id) or self.retired(issue_id):
                return False
            return bool(db.execute(
                "INSERT OR IGNORE INTO work (issue_id,origin,owner_ref,task_id,project_id,last_updated_at,run_generation) "
                "VALUES (?,?,?,?,?,?,?)", (issue_id,origin,owner_ref,task_id,project_id,last_updated_at,run_generation)).rowcount)
    def update(self, issue_id: str, **fields: Any) -> bool:
        allowed = {"project_id", "last_updated_at", "linear_session_id", "panel_note", "last_event_id"}
        if not fields or not set(fields) <= allowed:
            raise ValueError("Linear bindings cannot mutate execution ownership or Stop state")
        cols = ", ".join(f"{name} = ?" for name in fields)
        with self._tx() as db:
            if not self._admitted(db, issue_id):
                return False
            return bool(db.execute(f"UPDATE work SET {cols} WHERE issue_id=?", (*fields.values(), issue_id)).rowcount)
    def delete(self, issue_id: str) -> bool:
        with self._tx() as db:
            if not self._admitted(db, issue_id): return False
            db.execute("DELETE FROM work WHERE issue_id = ? AND origin != 'native'", (issue_id,))
            return True
    def retire_untracked(self, issue_id: str, task_id: str | None) -> bool:
        """Stop tracking a record whose native task does not exist; outbox history stays inspectable."""
        with self._tx() as db:
            if not self._admitted(db, issue_id):
                return False
            gone = db.execute("DELETE FROM work WHERE issue_id=? AND task_id IS ?", (issue_id, task_id)).rowcount
            if gone and task_id is not None:  # A fresh link can bind this issue again.
                db.execute("DELETE FROM metadata WHERE key=?", (f"native-binding:{issue_id}",))
            return bool(gone)
    def scope_fenced(self, issue_id: str) -> bool:
        with self._tx() as db:
            return db.execute("SELECT 1 FROM specialist_scope_fence WHERE issue_id = ?",
                              (issue_id,)).fetchone() is not None
    def fence_scope(self, issue_id: str, reason: str, *, at: float) -> None:
        """Persist a permanent authorization denial without deleting work or its evidence."""
        with self._tx() as db:
            db.execute("INSERT OR IGNORE INTO specialist_scope_fence (issue_id, reason, fenced_at) "
                       "VALUES (?, ?, ?)", (issue_id, reason[:500], at))
    def finish(self, issue_id: str, writes: list[tuple[str, dict[str, Any]]], *, at: float,
               release: bool = False, status_id: str | None = None) -> bool:
        """Capture terminal Linear writes before forgetting work, in one durable commit."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            if not self._effect_admitted(db, issue_id) or not self._report_owner_current(db, issue_id, writes):
                return False
            work = db.execute("SELECT ownership_id FROM work WHERE issue_id = ?", (issue_id,)).fetchone()
            if not work: return False
            if any(not self._admitted(db, *self._targets(payload)) for _, payload in writes): return False
            for kind, payload in writes:
                if kind == "project_update":
                    prior = db.execute("SELECT payload, state FROM outbox WHERE kind='project_update' AND hold_reason IS NULL AND "
                                       "json_extract(payload, '$.session_id')=? AND "
                                       "json_extract(payload, '$.project_id') IS ? ORDER BY "
                                       "CASE state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, rowid DESC LIMIT 1",
                                       (payload["session_id"], payload["project_id"])).fetchone()
                    if prior and prior["state"] in ("pending", "failed") and not json.loads(prior["payload"]).get("frozen") \
                            and not self._admitted(db, *self._targets(json.loads(prior["payload"]))): return False
            status_id = status_id or str(uuid.uuid4())
            for kind, payload in writes:
                payload = {**payload, "work_owner": work["ownership_id"]}
                if kind in ("comment", "activity"):
                    payload["write_started"] = False  # Newly captured closeout; persisted before transport.
                row_id = status_id if kind == "status" else (
                    str(payload["id"]) if kind == "comment" and payload.get("id") else str(uuid.uuid4()))
                if kind != "status":
                    payload = {**payload, "requires_status_id": status_id}
                if kind == "comment" and payload.get("native_outcome_comment"):
                    from .outcome import reuse_comment
                    status = next((value for key, value in writes if key == "status"), {})
                    if reuse_comment(self, db, row_id, payload, status=status, status_id=status_id, at=at):
                        continue
                if kind == "project_update":
                    # Project batches have their own queue: an older coalesced batch
                    # may depend on a newer status without blocking that status.
                    payload["issue_id"] = f"update:{payload['session_id']}:{payload['project_id'] or issue_id}"
                    payload["terminal_lines"] = {ident: status_id for ident in payload["lines"]}
                    existing = db.execute("SELECT * FROM outbox WHERE kind = 'project_update' AND hold_reason IS NULL AND "
                                          "json_extract(payload, '$.session_id') = ? AND "
                                          "json_extract(payload, '$.project_id') IS ? "
                                          "ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, "
                                          "rowid DESC LIMIT 1",
                                          (payload["session_id"], payload["project_id"])).fetchone()
                    if existing and self._requester_conflict(json.loads(existing["payload"]), payload):
                        existing = None
                    if existing:
                        prior = json.loads(existing["payload"])
                        if existing["state"] in ("pending", "failed") and not prior.get("frozen"):
                            prior["lines"].update(payload["lines"])
                            for key in ("line_issues", "terminal_lines"):
                                prior.setdefault(key, {}).update(payload.get(key, {}))
                            self._merge_requesters(prior, payload)
                            prior.update({key: value for key, value in payload.items()
                                          if key not in ("lines", "line_issues", "terminal_lines", "requester_sessions", "requester_activities")})
                            prior["enqueued_at"] = at
                            db.execute("UPDATE outbox SET payload = ?, next_at = MAX(next_at, ?) WHERE id = ?",
                                       (json.dumps(prior), at + float(payload.get("quiet", 0)), existing["id"]))
                        continue
                body = json.dumps({**payload, "enqueued_at": payload.get("enqueued_at", at)})
                db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                           (row_id, kind, body, at + float(payload.get("quiet", 0))))
            self._sequence_native_history(db, issue_id)
            if release:
                db.execute("UPDATE work SET release_pending=1 WHERE issue_id=?", (issue_id,))
            else:
                db.execute("DELETE FROM work WHERE issue_id = ? AND origin != 'native'", (issue_id,))
            return True
    def capture_event(self, issue_id: str, event_id: int, writes: list[tuple[str, dict[str, Any]]],
                      *, at: float, forget: bool = False) -> bool:
        """Advance our Kanban cursor with its Linear writes, independently of core's claim cursor."""
        with self._tx() as db:
            if (not self._admitted(db, issue_id) or (writes and not self._effect_admitted(db, issue_id))
                    or not self._report_owner_current(db, issue_id, writes)):
                return False
            row = db.execute("SELECT last_event_id FROM work WHERE issue_id = ?", (issue_id,)).fetchone()
            if not row or event_id <= row["last_event_id"]:
                return False
            if any(not self._admitted(db, *self._targets(payload)) for _, payload in writes): return False
            if any(kind == "status" and payload.get("terminal") for kind, payload in writes):
                # Reuse the established terminal dependency grouping in this same
                # transaction; a crash cannot advance the cursor without its writes.
                if not self.finish(issue_id, writes, at=at):
                    return False
            else:
                for kind, payload in writes:
                    db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                               (str(uuid.uuid4()), kind, json.dumps({**payload, "enqueued_at": at}), at))
            self._sequence_native_history(db, issue_id)
            db.execute("UPDATE work SET last_event_id = ? WHERE issue_id = ?", (event_id, issue_id))
            if forget:
                db.execute("DELETE FROM work WHERE issue_id = ? AND origin != 'native'", (issue_id,))
            return True
    @staticmethod
    def _sequence_native_history(db: sqlite3.Connection, issue_id: str) -> None:
        """Current status precedes only native history durably known not to have started."""
        work = db.execute("SELECT task_id FROM work WHERE issue_id=? AND origin='native'", (issue_id,)).fetchone()
        if not work:
            return
        status = db.execute("SELECT id FROM outbox WHERE kind='status' AND state='pending' AND hold_reason IS NULL "
                            "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.task_id')=? "
                            "ORDER BY rowid DESC LIMIT 1", (issue_id, work["task_id"])).fetchone()
        if status:
            db.execute("UPDATE outbox SET payload=json_set(payload,'$.requires_status_id',?) "
                       "WHERE state='pending' AND hold_reason IS NULL AND kind IN ('comment','activity') AND attempts=0 "
                       "AND (json_extract(payload,'$.native_history')=1 OR json_extract(payload,'$.native_progress')=1) "
                       "AND json_type(payload,'$.write_started')='false' "
                       "AND json_extract(payload,'$.issue_id')=? AND json_extract(payload,'$.task_id')=?",
                       (status["id"], issue_id, work["task_id"]))

    def active(self, origin: str | None = None) -> list[dict[str, Any]]:
        with self._tx() as db:
            rows = db.execute("SELECT * FROM work WHERE ? IS NULL OR origin = ?", (origin, origin)).fetchall()
        return [dict(row) for row in rows]
    def captured_task_activities(self, issue_id: str, task_id: str, session_id: str) -> Counter[tuple[str, str]]:
        """Count captured alerts; legacy rows used issue and session without a task id."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            rows = db.execute(
                "SELECT json_extract(payload, '$.content.type'), json_extract(payload, '$.content.body'), "
                "COUNT(*) FROM outbox WHERE hold_reason IS NULL AND kind = 'activity' AND json_extract(payload, '$.issue_id') = ? "
                "AND (json_extract(payload, '$.task_id') = ? OR "
                "(json_extract(payload, '$.task_id') IS NULL AND "
                "json_extract(payload, '$.session_id') = ? AND "
                "(state IN ('sent', 'pending') OR (state = 'failed' AND attempts > 0)))) GROUP BY 1, 2",
                (issue_id, task_id, session_id)).fetchall()
        return Counter({(kind, body): count for kind, body, count in rows})
    def terminal_captured(self, task_id: str, *, issue_id: str | None = None, state: str | None = None) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            return bool(db.execute("SELECT 1 FROM outbox WHERE hold_reason IS NULL AND kind='status' AND "
                                   "json_extract(payload, '$.task_id')=? AND "
                                   "(? IS NULL OR json_extract(payload, '$.issue_id')=?) AND "
                                   "(? IS NULL OR json_extract(payload, '$.state')=?) AND "
                                   "json_extract(payload, '$.terminal')=1 AND "
                                   "json_extract(payload, '$.admission_id') IS NULL LIMIT 1",
                                   (task_id, issue_id, issue_id, state, state)).fetchone())
    def quiet_version(self) -> str | None:
        """Changes on every write to the inputs of quiescent_closeout and the native binding."""
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (QUIET_INPUTS,)).fetchone()
            return row[0] if row else None
    def quiescent_closeout(self, issue_id: str, task_id: str, *, archived: bool) -> bool:
        """The finished task's reporting is settled locally: the same checks the pump's status,
        delegate and acceptance steps stop at, read in one transaction."""
        with self._tx():
            if self.terminal_captured(task_id, issue_id=issue_id, state="done"):
                return archived or not self.acceptance_recheck(issue_id, task_id)
            return archived and (self.latest_status(issue_id) or {}).get("state") == "todo"
    # A Blocked closeout written before unverified acceptance showed In Review: its own message
    # (acceptance_refusal) names the PR and a receipt class meaning GitHub refused or did not answer.
    _UNVERIFIED_CLOSEOUT = re.compile(r"could not be verified as ready \((https://github\.com/[A-Za-z0-9_.-]+/"
                                      r"[A-Za-z0-9_.-]+/pull/[1-9][0-9]*): (auth|infra|pending): ")
    _CLOSEOUT_HEAD = re.compile(r"/commits/([0-9a-f]{40})/check-runs\)")
    # The newest status intent for an issue, passing over a Done closeout whose send-time re-verify
    # refused it (DELIVERY_REFUSAL): GitHub changed its answer, so the wait that Done ended goes on.
    # A Done refused for any other reason (Linear's) is the issue's last word and ends the wait.
    _LATEST_LIVE_STATUS = ("SELECT id, state, hold_reason, payload FROM outbox WHERE kind='status' "
                           "AND json_extract(payload, '$.issue_id')=? AND NOT (state='failed' "
                           "AND json_extract(payload, '$.state')='done' AND json_extract(payload, '$.terminal')=1 "
                           "AND substr(COALESCE(json_extract(payload, '$.last_error'), ''), 1, ?)=?) "
                           "ORDER BY json_extract(payload, '$.enqueued_at') DESC, rowid DESC LIMIT 1")
    def acceptance_recheck(self, issue_id: str, task_id: str) -> dict[str, Any] | None:
        """The closeout of a done task that waits on GitHub rather than on a person, or None.

        ``in_review``: the latest status is the non-terminal In Review that names the completed
        event (bridge._await_acceptance). ``blocked``: the latest status is a sent terminal Blocked
        closeout of this task whose message says GitHub refused or did not answer, not yet settled
        by a recheck. Either way no pending or delivered Done closeout exists for the task (a Done
        that failed to deliver does not end the wait). Local reads only.
        """
        with self._tx() as db:
            return self._acceptance_recheck(db, issue_id, task_id)
    @classmethod
    def _acceptance_recheck(cls, db: sqlite3.Connection, issue_id: str, task_id: str) -> dict[str, Any] | None:
        latest = db.execute(cls._LATEST_LIVE_STATUS, (issue_id, len(DELIVERY_REFUSAL), DELIVERY_REFUSAL)).fetchone()
        if (not latest or latest["hold_reason"] is not None
                or db.execute("SELECT 1 FROM metadata WHERE key=?", (cls._settled_key(latest["id"]),)).fetchone()):
            return None
        payload = json.loads(latest["payload"])
        if (payload.get("task_id") != task_id or payload.get("admission_id")
                or payload.get("state") not in ("in_review", "blocked")):
            return None  # The common case (Done, running, ...) ends here without the scan below.
        if db.execute("SELECT 1 FROM outbox WHERE hold_reason IS NULL AND kind='status' AND state IN ('pending','sent') "
                      "AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.issue_id')=? "
                      "AND json_extract(payload,'$.state')='done' AND json_extract(payload,'$.terminal')=1 LIMIT 1",
                      (task_id, issue_id)).fetchone():
            return None
        wait = payload.get("acceptance_wait")
        if payload["state"] == "in_review":
            if payload.get("terminal") or not isinstance(wait, dict) or type(wait.get("event_id")) is not int:
                return None
            return {"kind": "in_review", "status_id": latest["id"], "event_id": wait["event_id"],
                    "url": wait.get("url") or "", "classification": wait.get("classification") or "",
                    "head_sha": wait.get("head_sha") or "", "since": wait.get("since", payload.get("enqueued_at"))}
        source_ms = payload.get("source_ms")
        if (not payload.get("terminal") or latest["state"] != "sent" or payload.get("acceptance_final")
                or not isinstance(source_ms, (int, float)) or isinstance(source_ms, bool)):
            return None  # Only an older build's Blocked qualifies; this build's Blocked is a final answer.
        texts = db.execute("SELECT COALESCE(json_extract(payload,'$.body'), json_extract(payload,'$.content.body'), '') "
                           "FROM outbox WHERE hold_reason IS NULL AND json_extract(payload,'$.requires_status_id')=?",
                           (latest["id"],)).fetchall()
        for (text,) in texts:
            found = cls._UNVERIFIED_CLOSEOUT.search(text or "")
            if found:
                head = cls._CLOSEOUT_HEAD.search(text)
                return {"kind": "blocked", "status_id": latest["id"], "source_ms": source_ms, "url": found[1],
                        "classification": found[2], "head_sha": head[1] if head else ""}
        return None
    @staticmethod
    def _settled_key(status_id: str) -> str:
        return f"acceptance-recheck-settled:{status_id}"
    def settle_acceptance_recheck(self, status_id: str) -> None:
        """This waiting closeout is decided (a definite answer, or the 7-day cap): stop asking about it."""
        with self._tx() as db:
            db.execute("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)",
                       (self._settled_key(status_id), json.dumps({"settled": True})))
    def finish_acceptance_recheck(self, issue_id: str, recheck: dict[str, Any],
                                  writes: list[tuple[str, dict[str, Any]]], *, at: float) -> bool:
        """Write a rechecked closeout, only while ``recheck`` is still this task's latest closeout.

        The completed event was consumed when that closeout was captured, so the cursor is not
        moved; a retry, a newer status or a Done written meanwhile refuses the write.
        """
        status = next((payload for kind, payload in writes if kind == "status"), None)
        if not status or not status.get("terminal"):
            return False
        with self._tx() as db:
            work = db.execute("SELECT task_id, last_event_id FROM work WHERE issue_id=? AND origin='native'",
                              (issue_id,)).fetchone()
            if not work or work["task_id"] != status.get("task_id"):
                return False
            current = self._acceptance_recheck(db, issue_id, work["task_id"])
            if (not current or current["kind"] != recheck.get("kind") or current["status_id"] != recheck.get("status_id")
                    or (current["kind"] == "in_review" and work["last_event_id"] < current["event_id"])):
                return False
            return self.finish(issue_id, writes, at=at)
    def assessment_comment_id(self, issue_id: str, body: str, *, completion: dict | None = None) -> str | None:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            rows = db.execute("SELECT * FROM outbox WHERE kind='comment' AND "
                              "json_extract(payload, '$.issue_id')=? AND "
                              "json_extract(payload, '$.assessment')=1 AND "
                              "json_extract(payload, '$.body')=? AND state IN ('sent', 'pending', 'failed') "
                              "ORDER BY CASE WHEN state='sent' AND json_extract(payload,'$.applied')=1 "
                              "THEN 0 ELSE 1 END, rowid DESC", (issue_id, body)).fetchall()
            for raw in rows:
                row = {**dict(raw), "payload": json.loads(raw["payload"])}
                payload = row["payload"]
                if row["state"] == "sent" and payload.get("applied", 1) == 0:
                    continue
                if row["state"] == "failed" and not self.uncertain(row, payload):
                    continue
                dependency = self.outbox_row(payload.get("requires_status_id") or payload.get("reconciled_status_id") or "")
                if (dependency and dependency["state"] == "sent"
                        and dependency["payload"].get("applied", 1) == 0
                        and not self.uncertain(row, payload)):
                    continue  # An unattempted sibling cannot publish behind a known-unapplied status.
                if row.get("hold_reason"):
                    source = dependency
                    if (not completion or not source or source["kind"] != "status"
                            or source["payload"].get("issue_id") != issue_id
                            or source["payload"].get("native_completion") != completion):
                        continue
                return str(row["id"])
        return None
    def superseded(self, row: dict[str, Any]) -> bool:
        payload, owner = row["payload"], row["payload"].get("work_owner")
        with self._tx() as db:
            work = db.execute("SELECT origin,task_id,ownership_id FROM work WHERE issue_id=?", (payload["issue_id"],)).fetchone()
            if work and work["origin"] == "native":
                return bool(payload.get("task_id") and payload["task_id"] != work["task_id"])
            if work: return not owner or work["ownership_id"] != owner
            return bool(db.execute("SELECT 1 FROM outbox WHERE kind='status' AND "
                                   "rowid>(SELECT rowid FROM outbox WHERE id=?) AND "
                                   "json_extract(payload, '$.issue_id')=? AND "
                                   "json_extract(payload, '$.work_owner') IS NOT NULL AND "
                                   "(? IS NULL OR json_extract(payload, '$.work_owner')!=?) LIMIT 1",
                                   (row["id"], payload["issue_id"], owner, owner)).fetchone())
    def hold_terminal(self, row_id: str) -> None:
        with self._tx() as db:
            db.execute("UPDATE outbox SET attempts=MAX(attempts, 1), "
                       "payload=json_set(payload, '$.reconcile_required', 1) WHERE id=?", (row_id,))
    def first_value(self, key: str, value: str) -> str:
        """Keep the first value recorded for ``key`` and return it; later calls cannot change it."""
        with self._tx() as db:
            db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)", (key, value))
            return db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0]
    @staticmethod
    def _prompt_answer_key(issue_id: str, session_id: str, activity_id: str) -> str:
        return "native-prompt-answer:" + json.dumps([issue_id, session_id, activity_id], separators=(",", ":"))

    def prompt_disposition(self, issue_id: str, session_id: str, activity_id: str) -> str | None:
        """Transport routing intent only; Core still owns admission and its receipt."""
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?",
                (self._prompt_answer_key(issue_id, session_id, activity_id),)).fetchone()
            return row[0] if row else None

    def remember_ordinary_prompt(self, issue_id: str, session_id: str, activity_id: str) -> bool:
        """Commit ordinary routing before handoff, atomically against answer consumption."""
        return self.first_value(self._prompt_answer_key(issue_id, session_id, activity_id), "ordinary") == "ordinary"

    def prompt_answer_reserved(self, issue_id: str, session_id: str, activity_id: str) -> bool:
        return self.prompt_disposition(issue_id, session_id, activity_id) not in (None, "ordinary")

    def reserve_prompt_answer(self, issue_id: str, session_id: str, activity_id: str) -> str | None:
        """Commit consumption before core effects; only one adapter may use this activity."""
        token = uuid.uuid4().hex
        saved = self.first_value(self._prompt_answer_key(issue_id, session_id, activity_id), token)
        return token if saved == token else None

    def release_prompt_answer(self, issue_id: str, session_id: str, activity_id: str, token: str) -> None:
        """An unconsumed answer becomes ordinary input, without a replayable routing gap."""
        with self._tx() as db:
            db.execute("UPDATE metadata SET value='ordinary' WHERE key=? AND value=?",
                (self._prompt_answer_key(issue_id, session_id, activity_id), token))

    # -- outbox -----------------------------------------------------------
    def enqueue(self, kind: str, payload: dict[str, Any], *, at: float | None = None) -> str:
        row_id = str(payload.get("id") or uuid.uuid4())
        now = time.time() if at is None else at
        with self._tx() as db:
            existing = db.execute("SELECT kind, payload FROM outbox WHERE id=?", (row_id,)).fetchone()
            if existing:
                saved = json.loads(existing["payload"])
                if kind == "delegate" and any(saved.get(key) != payload.get(key) for key in (
                        "target_delegate_id", "expected_delegate_id", "expected_updated_at",
                        "expected_binding_revision", "native_binding", "task_id", "delegate_routing_version")):
                    raise ValueError("outbox id reused with conflicting delegate routing")
                if existing["kind"] == kind and all(saved.get(k) == payload.get(k) for k in  # a stamped work_owner is not the caller's
                        ("issue_id", "body", "expected_description", "id", "session_key", "work_owner") if k in payload or k != "work_owner"):
                    return row_id
                raise ValueError("outbox id reused with conflicting content")
            # Foreground chat and its delegated worker share one Linear session.
            # Reserve the existing one-minute cap atomically in the outbox itself,
            # including failed attempts, so replacement adapters cannot reset it.
            if kind == "activity" and payload.get("ephemeral") and payload.get("content", {}).get("type") == "action":
                last = self.latest_session_action(payload["issue_id"], payload["session_id"])
                if last and now - last["enqueued_at"] < 60:
                    return ""
            targets = self._targets(payload)
            if payload.get("content_action"):
                if (not self.conversation_reply(kind, payload) and not self._admitted(db, *targets)) or (not self.independent_message(kind, payload) and
                        any(self._unresolved_terminal(db, target) for target in targets)): return ""
            elif self.reporting_notice(kind, payload):
                if not self._admitted(db, *targets): return ""
            elif not self._effect_admitted(db, *targets): return ""
            work = db.execute("SELECT ownership_id FROM work WHERE issue_id=?", (payload.get("issue_id"),)).fetchone()
            body = json.dumps({**payload, "work_owner": work["ownership_id"] if work and not payload.get("content_action") and not self.reporting_notice(kind, payload) else None,
                               "enqueued_at": payload.get("enqueued_at", now)})
            db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)", (row_id, kind, body, now))
        return row_id
    def enqueue_many(self, writes: list[tuple[str, dict[str, Any]]], *, at: float) -> bool:
        with self._tx() as db:
            if any(not self._effect_admitted(db, *self._targets(payload)) for _, payload in writes): return False
            for kind, payload in writes:
                work = db.execute("SELECT ownership_id FROM work WHERE issue_id=?", (payload.get("issue_id"),)).fetchone()
                if work and not self.reporting_notice(kind, payload): payload = {**payload, "work_owner": work["ownership_id"]}
                db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                           (str(uuid.uuid4()), kind, json.dumps({**payload, "enqueued_at": at}), at))
            return True
    def enqueue_once(self, kind: str, payload: dict[str, Any], marker: str, *, at: float) -> str:
        """Capture an ingress failure alert once across retries and process restarts."""
        with self._tx() as db:
            if not self._admitted(db, *self._targets(payload)): return ""
            existing = db.execute("SELECT id FROM outbox WHERE json_extract(payload, '$.parked_delivery') = ?",
                                  (marker,)).fetchone()
            if existing:
                return str(existing["id"])
            row_id = str(uuid.uuid4())
            body = json.dumps({**payload, "parked_delivery": marker, "enqueued_at": at})
            db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                       (row_id, kind, body, at))
            return row_id
    def due(self, now: float) -> list[dict[str, Any]]:
        """Oldest pending issue write per issue, if due, plus any due thought: issue writes go out in order."""
        def eligible(alias: str) -> str:
            dependency = f"json_extract({alias}.payload, '$.requires_status_id')"
            return (f"({alias}.hold_reason IS NULL AND NOT EXISTS (SELECT 1 FROM outbox h WHERE h.id={dependency} "
                    "AND json_extract(h.payload, '$.reconcile_required')=1 AND "
                    f"({alias}.kind != 'project_update' OR json_extract({alias}.payload, '$.issue_id')="
                    "json_extract(h.payload, '$.issue_id'))) AND "
                    f"({alias}.kind = 'project_update' OR COALESCE({dependency}, '') = '' OR "
                    f"EXISTS (SELECT 1 FROM outbox s WHERE s.id = {dependency} "
                    "AND (s.state = 'sent' OR (s.state = 'failed' AND (s.attempts = 0 OR EXISTS ("
                    "SELECT 1 FROM outbox l WHERE l.kind = 'status' AND l.state = 'sent' AND l.rowid > s.rowid "
                    "AND json_extract(l.payload, '$.issue_id') = json_extract(s.payload, '$.issue_id'))))))))")
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            # Older versions retired one-try native messages even after an uncertain send.
            # Recover only that undecided state for readback; explicit refusals remain failed.
            db.execute("UPDATE outbox SET state='pending' WHERE state='failed' AND kind='activity' "
                "AND hold_reason IS NULL AND ((json_extract(payload,'$.native_reply_version')=1 "
                "AND json_extract(payload,'$.one_try')=1) OR json_type(payload,'$.worker_step')='object') "
                "AND json_extract(payload,'$.write_started')=1 "
                "AND json_type(payload,'$.failure_kind') IS NULL AND json_type(payload,'$.applied') IS NULL")
            rows = db.execute(
                "SELECT o.* FROM outbox o WHERE o.state = 'pending' AND " + eligible("o") +
                " AND (" + ADVISORY + " OR (o.kind='activity' AND (json_extract(o.payload, '$.native_reply_version')=1 "
                "OR json_extract(o.payload,'$.native_outcome_pointer')=1)) OR o.rowid = ("  # thoughts never wait for, or hold, issue writes
                # A worker-derived question repair keeps its optional reserve and cannot hold issue-state writes.
                " SELECT MIN(p.rowid) FROM outbox p WHERE p.state = 'pending' AND " + eligible("p") +
                " AND NOT " + ADVISORY + " AND COALESCE(json_extract(p.payload,'$.worker_step_repair'),0)!=1 "
                "AND COALESCE(json_extract(p.payload,'$.native_outcome_pointer'),0)!=1 "
                "AND NOT (p.kind='activity' AND COALESCE(json_extract(p.payload,'$.native_reply_version'),0)=1) "
                "AND json_extract(p.payload, '$.issue_id') IS json_extract(o.payload, '$.issue_id')"
                ")) AND o.next_at <= ? ORDER BY COALESCE(json_extract(o.payload, '$.initial_ack'), 0) DESC, o.rowid", (now,)).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]
    def pending(self, issue_id: str | None = None) -> list[dict[str, Any]]:
        with self._tx() as db:
            rows = db.execute("SELECT * FROM outbox WHERE state = 'pending' AND (? IS NULL OR "
                              "json_extract(payload, '$.issue_id') = ?) ORDER BY rowid", (issue_id, issue_id)).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]
    def last_activity_at(self, issue_id: str, session_id: str) -> float:
        """When this session last showed, or is about to show, an activity; dropped ones do not count."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT MAX(json_extract(payload, '$.enqueued_at')) FROM outbox WHERE hold_reason IS NULL AND kind = 'activity' "
                             "AND (state = 'pending' OR (state = 'sent' AND COALESCE(json_extract(payload, '$.applied'), 1) = 1)) AND "
                             "json_extract(payload, '$.issue_id') = ? AND json_extract(payload, '$.session_id') = ?",
                             (issue_id, session_id)).fetchone()
        return float(row[0] or 0)
    def latest_session_action(self, issue_id: str, session_id: str) -> dict | None:
        """The latest optional action reservation, across foreground and worker producers."""
        with self._tx() as db:
            row = db.execute("SELECT rowid, payload FROM outbox WHERE kind='activity' AND "
                "json_extract(payload, '$.issue_id')=? AND json_extract(payload, '$.session_id')=? AND "
                "json_extract(payload, '$.ephemeral')=1 AND json_extract(payload, '$.content.type')='action' "
                "ORDER BY rowid DESC LIMIT 1", (issue_id, session_id)).fetchone()
            if row is None:
                return None
            replaced = db.execute("SELECT 1 FROM outbox WHERE rowid>? AND kind='activity' AND state='sent' AND "
                "COALESCE(json_extract(payload,'$.applied'),1)=1 AND json_extract(payload,'$.issue_id')=? AND "
                "json_extract(payload,'$.session_id')=? LIMIT 1", (row[0], issue_id, session_id)).fetchone()
        return {**json.loads(row[1]), "_presentation_current": replaced is None}
    def unreported_failed(self) -> list[dict[str, Any]]:
        with self._tx() as db:
            rows = db.execute("SELECT * FROM outbox WHERE state = 'failed' AND hold_reason IS NULL AND NOT " + ADVISORY + " AND "
                              "COALESCE(json_extract(payload, '$.reported'), 0) = 0 ORDER BY rowid").fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]
    def retire_advisory(self, row_id: str, now: float) -> None:
        """Retire a due, unsent thought; one a quota pause deferred keeps its place. It changes no issue: no fence applies."""
        with self._tx() as db:
            db.execute("UPDATE outbox SET state = 'failed' WHERE id = ? AND state = 'pending' AND hold_reason IS NULL AND next_at <= ? AND "
                       + ADVISORY + " AND NOT (COALESCE(json_type(payload,'$.worker_step')='object',0) AND "
                       "COALESCE(json_extract(payload,'$.write_started'),0)=1)", (row_id, now))

    def outcome_comment_applied(self, payload: dict) -> bool:
        """Closing publication depends on this completion's exact regular issue comment."""
        comment = self.outbox_row(payload.get("requires_comment_id", ""))
        return bool(comment and comment["kind"] == "comment" and comment["state"] == "sent" and
                    comment.get("hold_reason") is None and comment["payload"].get("applied") == 1 and
                    comment["payload"].get("issue_id") == payload.get("issue_id") and
                    (comment["payload"].get("native_completion") == payload.get("native_completion") or
                     payload.get("outcome_assessment") is True and comment["payload"].get("assessment") is True))

    @classmethod
    def after_native_session_history(cls, kind: str, payload: dict) -> bool:
        """Only visible decision/closing replies depend on this session's retained history."""
        return (kind == 'activity' and bool(payload.get('session_id')) and
                (payload.get('native_outcome_pointer') is True or
                 cls.conversation_reply(kind, payload) and
                 (payload.get('turn_final') is True or payload['content']['type'] == 'elicitation')))

    def unsettled_native_session_history(self, issue_id: str, session_id: str) -> bool:
        """Retained notes order this session's lifecycle, never its ordinary issue comments."""
        with self._tx() as db:
            rows = db.execute("SELECT state,attempts,hold_reason,payload FROM outbox WHERE kind='activity' "
                "AND state IN ('pending','failed') AND json_extract(payload,'$.native_history')=1 "
                "AND COALESCE(json_extract(payload,'$.ephemeral'),0)!=1 "
                "AND json_type(payload,'$.applied') IS NULL AND json_extract(payload,'$.issue_id')=? "
                "AND json_extract(payload,'$.session_id')=?", (issue_id, session_id)).fetchall()
            for row in rows:
                payload = json.loads(row['payload'])
                attempted = (payload.get('write_started') is True or
                             'write_started' not in payload and row['attempts'] > 0)
                if attempted or (row['hold_reason'] is None and (
                        row['state'] == 'pending' or payload.get('failure_kind') != 'rejected')):
                    return True  # Possible late effects and retryable history retain their exact identity.
            return False

    def unsettled_worker_action(self, issue_id: str, session_id: str) -> bool:
        """Only this session's closing publication waits for its in-flight step or derived question repair."""
        with self._tx() as db:
            return db.execute("SELECT 1 FROM outbox WHERE kind='activity' AND state IN ('pending','failed') AND "
                "(json_type(payload,'$.worker_step')='object' OR json_extract(payload,'$.worker_step_repair')=1) "
                "AND json_extract(payload,'$.write_started')=1 AND "
                "json_type(payload,'$.applied') IS NULL AND json_extract(payload,'$.issue_id')=? AND "
                "json_extract(payload,'$.session_id')=? LIMIT 1", (issue_id, session_id)).fetchone() is not None
    def mark(self, row_id: str, state: str, error: str | None = None) -> None:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return
            # A row marked failed here was refused (or held for an operator), not timed out: never revived.
            db.execute("UPDATE outbox SET state = ?, payload = CASE WHEN ? = 'failed' THEN json_set(payload, "
                       "'$.failure_kind', 'rejected') ELSE payload END WHERE id = ?", (state, state, row_id))
            db.execute("UPDATE outbox SET payload = CASE WHEN ? IS NULL THEN payload ELSE "
                       "json_set(payload, '$.last_error', ?) END WHERE id = ?", (error, error, row_id))
    def mark_sent(self, row_id: str, applied: bool) -> bool:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return False
            db.execute("UPDATE outbox SET state = 'sent', payload = json_set(payload, '$.applied', ?) WHERE id = ?",
                       (int(applied), row_id))
            return True
    def retire_unattempted_action(self, row_id: str, content: dict) -> bool:
        """Drop a disposable status only while its exact content is proven unattempted."""
        with self._tx() as db:
            row = db.execute("SELECT * FROM outbox WHERE id=?", (row_id,)).fetchone()
            if not row or row["state"] != "pending" or row["hold_reason"] is not None:
                return False
            payload = json.loads(row["payload"])
            if (not (self.conversation_reply(row["kind"], payload) or payload.get("worker_step")) or
                    payload.get("write_started") is not False or payload.get("ephemeral") is not True or
                    payload.get("content") != content or content.get("type") != "action"):
                return False
            return self.mark_sent(row_id, False)
    def note_reason(self, row_id: str, key: str, reason: str | None) -> None:
        """Keep a decision's closed reason code on the row, so it outlives log rotation."""
        if reason and key in ("outcome_reason", "failure_reason"):
            with self._tx() as db:
                db.execute(f"UPDATE outbox SET payload=json_set(payload, '$.{key}', ?) WHERE id=?", (reason, row_id))
    def diag_counts(self, now: float) -> dict[str, int]:
        """Gauges for the hourly health line: counts only, never content."""
        with self._tx() as db:
            bindings = db.execute("SELECT COUNT(*) FROM work").fetchone()[0]
            pending, oldest = db.execute("SELECT COUNT(*), MIN(json_extract(payload, '$.enqueued_at')) FROM outbox "
                                         "WHERE state='pending'").fetchone()
            held = db.execute("SELECT COUNT(*) FROM outbox WHERE state='pending' AND (hold_reason IS NOT NULL OR "
                              "json_extract(payload, '$.reconcile_required')=1)").fetchone()[0]
            failed = db.execute("SELECT COUNT(*) FROM outbox WHERE state='failed' AND hold_reason IS NULL AND "
                                "COALESCE(json_extract(payload, '$.reported'), 0)=0").fetchone()[0]
        return {"n_bindings": bindings, "n_pending": pending, "n_held": held, "n_failed_unreported": failed,
                "oldest_pending_s": max(0, int(now - float(oldest))) if oldest is not None else None}
    def native_status_receipt(self, issue_id: str, task_id: str) -> dict | None:
        """Read the latest acknowledged issue write for this native binding."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT payload FROM outbox WHERE kind IN ('status','delegate') AND state='sent' AND hold_reason IS NULL "
                             "AND json_extract(payload,'$.applied')=1 AND json_extract(payload,'$.issue_id')=? "
                             "AND json_extract(payload,'$.task_id')=? AND json_type(payload,'$.issue_write_receipt')='object' "
                             "ORDER BY rowid DESC LIMIT 1", (issue_id, task_id)).fetchone()
        return json.loads(row[0])["issue_write_receipt"] if row else None
    # One delegate write at a time; unrelated rows (status, comments, activities,
    # project updates) never starve delegate recovery.
    _DELEGATE_PENDING = ("SELECT 1 FROM outbox WHERE kind='delegate' AND state='pending' "
                         "AND json_extract(payload, '$.issue_id')=? LIMIT 1")
    def delegate_routed(self, issue_id: str, revision: str) -> bool:
        """A delegate intent exists for this binding revision, or another delegate write is pending."""
        with self._tx() as db:
            return bool(db.execute(self._DELEGATE_PENDING, (issue_id,)).fetchone() or db.execute(
                "SELECT 1 FROM outbox WHERE kind='delegate' AND json_extract(payload, '$.issue_id')=? "
                "AND json_extract(payload, '$.expected_binding_revision')=? LIMIT 1", (issue_id, revision)).fetchone())
    def drop_unsent_delegate(self, issue_id: str, task_id: str, *, at: float) -> int:
        """Refuse this task's queued delegate writes that never started; recovery treats them as decided."""
        with self._tx() as db:
            return db.execute("UPDATE outbox SET state='failed', payload=json_set(payload, "
                              "'$.failure_kind', 'rejected', '$.last_error', 'Admission was superseded before the delegate was sent', "
                              "'$.admission_superseded', json('true'), '$.reported', 1) WHERE kind='delegate' AND state='pending' "
                              "AND json_extract(payload, '$.issue_id')=? AND json_extract(payload, '$.task_id')=? "
                              "AND json_type(payload, '$.write_started')='false'", (issue_id, task_id)).rowcount
    _DELEGATE_WRITTEN = ("SELECT 1 FROM outbox WHERE kind='delegate' AND json_extract(payload, '$.issue_id')=? "
                         "AND json_extract(payload, '$.expected_binding_revision')=? AND NOT (state='failed' "
                         "AND json_type(payload, '$.write_started')='false' AND json_type(payload, '$.delegate_receipt') IS NULL "
                         "AND json_type(payload, '$.recovered_binding') IS NULL "
                         "AND json_type(payload, '$.admission_superseded') IS NULL) LIMIT 1")
    def delegate_unwritten(self, issue_id: str, revision: str) -> bool:
        """This revision's delegate intents all failed before any write, none of them recovery's own."""
        with self._tx() as db:
            return bool(not db.execute(self._DELEGATE_PENDING, (issue_id,)).fetchone()
                        and not db.execute(self._DELEGATE_WRITTEN, (issue_id, revision)).fetchone()
                        and db.execute("SELECT 1 FROM outbox WHERE kind='delegate' AND json_extract(payload, '$.issue_id')=? "
                                       "AND json_extract(payload, '$.expected_binding_revision')=? LIMIT 1",
                                       (issue_id, revision)).fetchone())
    def recover_binding_delegate(self, issue_id: str, payload: dict[str, Any], *, at: float,
                                 supersede_unwritten: bool = False) -> bool:
        """Queue one recovery delegate intent; no caller/requester or work_owner fields are invented.

        supersede_unwritten: this revision's earlier intents all failed before any write
        (delegate_unwritten), so one recovery intent may follow them."""
        with self._tx() as db:
            if not self._effect_admitted(db, issue_id) or not db.execute(
                    "SELECT 1 FROM work WHERE issue_id=? AND origin='native' AND task_id=?",
                    (issue_id, payload["task_id"])).fetchone():
                return False
            if db.execute("SELECT 1 FROM outbox WHERE id=?", (payload["id"],)).fetchone():
                return False
            if db.execute(self._DELEGATE_WRITTEN if supersede_unwritten else
                          "SELECT 1 FROM outbox WHERE kind='delegate' AND json_extract(payload, '$.issue_id')=? "
                          "AND json_extract(payload, '$.expected_binding_revision')=?",
                          (issue_id, payload["expected_binding_revision"])).fetchone():
                return False
            if db.execute(self._DELEGATE_PENDING, (issue_id,)).fetchone():
                return False  # One delegate write at a time; routing history fences the rest.
            db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                       (payload["id"], "delegate", json.dumps({**payload, "enqueued_at": at}), at))
            return True
    def reconcile_status(self, issue_id: str, payload: dict[str, Any], *, at: float) -> bool:
        """Queue a native-derived state only when the newest intent differs.

        A refused In Progress is retried once per claim. Pending native messages
        are sequenced after it, so people read them under the current state.
        """
        with self._tx() as db:
            if not self._effect_admitted(db, issue_id) or not db.execute(
                    "SELECT 1 FROM work WHERE issue_id=? AND origin='native' AND task_id=?",
                    (issue_id, payload.get("task_id"))).fetchone():
                return False
            latest = db.execute(self._LATEST_STATUS, (issue_id,)).fetchone()
            claim = (payload.get("recovered_claim") or {}).get("event_id")
            retry = (latest and claim is not None and self._refused_in_progress(latest)
                     and latest["claim_event"] != claim)
            if latest and latest["intent"] == payload["state"] and not retry:
                return False
            db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, ?, ?, ?)",
                       (str(uuid.uuid4()), "status", json.dumps({**payload, "enqueued_at": at}), at))
            self._sequence_native_history(db, issue_id)
            return True
    _LATEST_STATUS = ("SELECT id, state AS row_state, hold_reason, json_extract(payload, '$.state') AS intent, "
                      "json_extract(payload, '$.enqueued_at') AS at, json_extract(payload, '$.applied') AS applied, "
                      "json_extract(payload, '$.recovered_claim.event_id') AS claim_event FROM outbox "
                      "WHERE kind='status' AND json_extract(payload, '$.issue_id')=? "
                      "ORDER BY json_extract(payload, '$.enqueued_at') DESC, rowid DESC LIMIT 1")
    @staticmethod
    def _refused_in_progress(row) -> bool:
        """An In Progress intent that was delivered as a no-op: Linear does not show it."""
        return (row["intent"] == "in_progress" and row["row_state"] == "sent" and not row["applied"]
                and row["hold_reason"] is None)
    def latest_status(self, issue_id: str) -> dict[str, Any] | None:
        """Newest status intent, including a pending or failed closeout.

        ``refused`` marks an In Progress intent that was refused (not applied),
        so it is not mistaken for Linear already showing In Progress;
        ``recovered`` marks a background claim recovery row.
        """
        with self._tx() as db:
            row = db.execute(self._LATEST_STATUS, (issue_id,)).fetchone()
        if not row or not row["intent"]: return None
        return {"id": row["id"], "state": row["intent"], "refused": self._refused_in_progress(row),
                "recovered": row["claim_event"] is not None}
    def verified_release(self, row_id: str) -> bool:
        row = self.outbox_row(row_id)
        return bool(row and not row.get("hold_reason") and row["state"] == "sent" and row["kind"] == "status"
                    and row["payload"].get("release") and row["payload"].get("applied"))
    @staticmethod
    def history_status_settled(row: dict | None) -> bool:
        if not row or row["kind"] != "status" or row.get("hold_reason"):
            return False
        payload = row["payload"]
        if row["state"] == "sent" and payload.get("applied") == 1:
            return True
        return bool(payload.get("write_started") is False and (
            (row["state"] == "sent" and payload.get("applied") == 0) or
            (row["state"] == "failed" and row["attempts"] == 0)))

    def terminal_status_applied(self, row_id: str) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT state, kind, json_extract(payload, '$.applied') FROM outbox WHERE hold_reason IS NULL AND id = ?",
                             (row_id,)).fetchone()
        return bool(row and row["state"] == "sent" and row["kind"] == "status" and row[2] == 1)
    def terminal_text(self, status_id: str) -> str:
        with self._tx() as db:
            rows = db.execute("SELECT COALESCE(json_extract(payload, '$.body'), "
                              "json_extract(payload, '$.content.body'), '') FROM outbox WHERE "
                              "json_extract(payload, '$.requires_status_id')=?", (status_id,)).fetchall()
        return " ".join(row[0] for row in rows)
    def drop(self, row_id: str) -> None:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return
            db.execute("DELETE FROM outbox WHERE id = ?", (row_id,))
    def defer(self, row_id: str, until: float) -> None:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return
            db.execute("UPDATE outbox SET next_at = ? WHERE id = ?", (until, row_id))
    def defer_guarded(self, row_id: str, now: float) -> float | None:
        """A send guard held this row and left it due: back off so it is not re-read every tick.

        Only a still-pending row whose next_at is not already in the future is touched (a quiet
        period or a sender that moved it wins). The payload is unchanged; the count lives in
        metadata. Returns the row's next_at afterwards, or None when untouched."""
        with self._tx() as db:
            row = db.execute("SELECT next_at FROM outbox WHERE id=? AND state='pending'", (row_id,)).fetchone()
            if row is None or float(row["next_at"]) > now:
                return None
            name = self._backoff_key("outbox-guard:" + row_id)
            saved = db.execute("SELECT value FROM metadata WHERE key=?", (name,)).fetchone()
            defers = int(json.loads(saved[0]).get("failures", 0)) + 1 if saved else 1
            until = float(row["next_at"])
            if defers > GUARD_FREE_DEFERS:
                until = now + backoff_delay(defers - GUARD_FREE_DEFERS, base=GUARD_MIN_BACKOFF, cap=GUARD_MAX_BACKOFF)
                # Bumping next_at only delays a write; no admission is needed to make a row wait.
                db.execute("UPDATE outbox SET next_at=? WHERE id=?", (until, row_id))
            db.execute("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                       (name, json.dumps({"failures": defers, "next_at": until})))
            return until
    # Per-key failure backoff for optional Linear reads made outside the outbox (pump_kanban
    # steps, recovery). Kept in metadata so a restart does not reset it into a tight loop.
    @staticmethod
    def _backoff_key(key: str) -> str:
        return json.dumps(["linear-backoff", key])
    def backoff_ready(self, key: str, now: float) -> bool:
        with self._tx() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (self._backoff_key(key),)).fetchone()
        return row is None or float(json.loads(row[0]).get("next_at", 0)) <= now
    def backoff_fail(self, key: str, now: float, *, base: float = 15.0, cap: float = 3600.0) -> float:
        """Record one more failure for key; returns when it may be tried again (jittered, capped)."""
        with self._tx() as db:
            name = self._backoff_key(key)
            row = db.execute("SELECT value FROM metadata WHERE key=?", (name,)).fetchone()
            failures = int(json.loads(row[0]).get("failures", 0)) + 1 if row else 1
            next_at = now + backoff_delay(failures, base=base, cap=cap)
            db.execute("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                       (name, json.dumps({"failures": failures, "next_at": next_at})))
            return next_at
    def backoff_clear(self, key: str) -> None:
        name = self._backoff_key(key)
        with self._tx() as db:
            if db.execute("SELECT 1 FROM metadata WHERE key=?", (name,)).fetchone():
                db.execute("DELETE FROM metadata WHERE key=?", (name,))
    def effect_admitted(self, issue_id: str) -> bool:
        """Local check (no Linear read): may an issue effect be queued now?"""
        with self._tx() as db:
            return self._effect_admitted(db, issue_id)
    def retry(self, row: dict[str, Any], now: float, error: str | None = None) -> bool:
        """Back off 1 min doubling to 1 h. Returns True when the row is given up (24 h old)."""
        attempts = int(row["attempts"]) + 1
        if now - float(row["payload"].get("enqueued_at", now)) >= GIVE_UP_AFTER:
            with self._tx() as db:
                if not self._row_admitted(db, row["id"]): return False
                db.execute("UPDATE outbox SET state = 'failed', attempts = ?, payload = json_set(CASE WHEN ? IS NULL THEN payload "
                           "ELSE json_set(payload, '$.last_error', ?) END, '$.failure_kind', 'timeout') WHERE id = ?",
                           (attempts, error, error, row["id"]))
            return True
        delay = min(MIN_BACKOFF * 2 ** (attempts - 1), MAX_BACKOFF)
        with self._tx() as db:
            if not self._row_admitted(db, row["id"]): return False
            db.execute("UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?", (attempts, now + delay, row["id"]))
        return False
    def revive_failed(self, now: float) -> int:
        """After any successful write, give timed-out rows one more try (same client id). A status
        write superseded by a later one for the same issue stays failed, so it cannot land stale.
        Rows Linear refused are never revived; a timed-out row is revived at most REVIVE_LIMIT
        times and at most once per REVIVE_EVERY, so steady traffic cannot resend it forever."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            rows = db.execute(
                "SELECT id, payload FROM outbox WHERE state = 'failed' AND hold_reason IS NULL AND attempts > 0 AND "
                "COALESCE(json_extract(payload, '$.failure_kind'), 'timeout') != 'rejected' AND "
                "COALESCE(json_extract(payload, '$.revivals'), 0) < ? AND "
                "(json_extract(payload, '$.revived_at') IS NULL OR json_extract(payload, '$.revived_at') <= ?) AND "
                "COALESCE(json_extract(payload, '$.reconcile_required'), 0)=0 AND NOT " + ADVISORY + " AND NOT ("
                " kind = 'status' AND EXISTS (SELECT 1 FROM outbox l WHERE l.kind = 'status' AND l.rowid > outbox.rowid"
                " AND json_extract(l.payload, '$.issue_id') = json_extract(outbox.payload, '$.issue_id')))",
                (REVIVE_LIMIT, now - REVIVE_EVERY)).fetchall()
            revived = 0
            for row in rows:
                if self._admitted(db, *self._targets(json.loads(row["payload"]))):
                    db.execute("UPDATE outbox SET state='pending', next_at=?, payload=json_set(json_set(payload, "
                               "'$.revivals', COALESCE(json_extract(payload, '$.revivals'), 0) + 1), '$.revived_at', ?) "
                               "WHERE id=?", (now, now, row["id"]))
                    revived += 1
            return revived
    @staticmethod
    def _latest_project_update(db: sqlite3.Connection, session_id: str, project_id: str | None):
        return db.execute("SELECT * FROM outbox WHERE kind = 'project_update' AND hold_reason IS NULL AND "
                          "json_extract(payload, '$.session_id') = ? AND json_extract(payload, '$.project_id') IS ? "
                          "ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, "
                          "rowid DESC LIMIT 1", (session_id, project_id)).fetchone()
    def project_update(self, session_id: str, project_id: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = self._latest_project_update(db, session_id, project_id)
        return {**dict(row), "payload": json.loads(row["payload"])} if row else None
    def outbox_row(self, row_id: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM outbox WHERE id = ?", (row_id,)).fetchone()
        return {**dict(row), "payload": json.loads(row["payload"])} if row else None
    @staticmethod
    def _merge_requesters(prior, payload):
        # An existing member retains its original evidence coordinates, including
        # legacy creator-based evidence. A later Activity cannot thaw its request.
        if not payload.get("requester_sessions"):
            return
        sessions = prior.setdefault("requester_sessions", {})
        for issue, session in payload.get("requester_sessions", {}).items():
            if issue not in sessions:
                sessions[issue] = session
                activity = (payload.get("requester_activities") or {}).get(issue)
                if activity:
                    prior.setdefault("requester_activities", {})[issue] = activity
    @staticmethod
    def _requester_conflict(prior, payload):
        old, new = prior.get("requester_sessions") or {}, payload.get("requester_sessions") or {}
        return bool(old) != bool(new) or any(key in old and old[key] != value for key, value in new.items())
    def queue_project_update(self, payload: dict[str, Any], *, due: float, quiet: bool) -> bool:
        """Merge a session's update atomically with terminal capture in finish()."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            if not self._effect_admitted(db, *self._targets(payload)): return False
            row = self._latest_project_update(db, payload["session_id"], payload["project_id"])
            if row and self._requester_conflict(json.loads(row["payload"]), payload): row = None
            if row:
                prior = json.loads(row["payload"])
                if (row["state"] not in ("pending", "failed") or prior.get("frozen") or
                        prior.get("write_started") is True or
                        ("write_started" not in prior and prior.get("send_body"))):
                    return True
                if prior.get("followup") and not set(payload["lines"]) <= set(prior["lines"]):
                    # A split remainder contains only its original unpublished
                    # members. Later same-session updates cannot reintroduce a
                    # published line or expand the once-per-project/session batch.
                    return True
                if not self._admitted(db, *self._targets(prior)): return False
                prior["lines"].update(payload["lines"])
                prior.setdefault("line_issues", {}).update(payload.get("line_issues", {}))
                self._merge_requesters(prior, payload)
                if payload.get("terminal"):
                    prior["terminal"] = True
                    prior["owner_issue_id"] = payload.get("owner_issue_id")
                    prior["requires_status_id"] = payload.get("requires_status_id")
                    prior.setdefault("terminal_lines", {}).update(payload.get("terminal_lines", {}))
                else:
                    terminal_lines = prior.setdefault("terminal_lines", {})
                    for ident in payload["lines"]:
                        terminal_lines.pop(ident, None)
                    if terminal_lines:
                        ident, status_id = next(reversed(terminal_lines.items()))
                        prior["terminal"] = True
                        prior["owner_issue_id"] = prior["line_issues"].get(ident, "")
                        prior["requires_status_id"] = status_id
                    else:
                        prior["terminal"] = False
                        prior["owner_issue_id"] = ""
                        prior["requires_status_id"] = ""
                prior["resolve"] = payload.get("resolve") or prior.get("resolve")
                next_at = max(due, float(row["next_at"])) if quiet else due
                db.execute("UPDATE outbox SET payload = ?, next_at = ? WHERE id = ?",
                           (json.dumps(prior), next_at, row["id"]))
            else:
                db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, 'project_update', ?, ?)",
                           (str(uuid.uuid4()), json.dumps({**payload, "enqueued_at": due}), due))
            return True
    def project_not_applied(self, row_id: str, *, known_rejection: bool = False, started_before=None,
                            attempt_id: str | None = None) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT payload FROM outbox WHERE id=? AND kind='project_update' AND state='pending' AND hold_reason IS NULL", (row_id,)).fetchone()
            if not row:
                return False
            payload = json.loads(row["payload"])
            if attempt_id is not None and payload.get("mutation_attempt_id") != attempt_id:
                return False
            if known_rejection:
                prior = payload.get("write_started") if started_before is None else started_before
                legacy_create = prior is None and payload.get("send_body") is not None
                # Already started, or a prepared legacy create: do not thaw and do not retry.
                # A missing marker with no send body has not started, even if attempts > 0.
                if prior is True or legacy_create:
                    return False
                if payload.get("send_body") is None:
                    return True
                payload["frozen"] = True
                payload["write_started"] = False
                db.execute("UPDATE outbox SET payload=? WHERE id=?", (json.dumps(payload), row_id))
                return True
            if payload.get("write_started") is not False:
                return False
            db.execute("UPDATE outbox SET payload=json_set(payload, '$.frozen', json('false'), '$.write_started', json('false')) WHERE id=?", (row_id,))
            return True
    def freeze_project_update(self, row_id: str, expected: dict[str, Any], now: float,
                              body: str, project_id: str | None) -> bool | None:
        """Freeze the preflighted body only if it is still unchanged and due."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT * FROM outbox WHERE id = ? AND kind = 'project_update' AND state = 'pending' AND hold_reason IS NULL",
                             (row_id,)).fetchone()
            if not row:
                return False
            if row["next_at"] > now:
                return False
            payload = json.loads(row["payload"])
            if payload != expected:
                return None
            if not self._admitted(db, *self._targets(payload)): return False
            if not payload.get("frozen"):
                # write_started true, or a prepared body with no marker, must not be
                # reprojected. Attempts alone are pre-send retries and may still freeze.
                if payload.get("write_started") is True or (
                        "write_started" not in payload and payload.get("send_body")):
                    return False
                payload["frozen"] = True
                payload["write_started"] = False
                payload["send_body"] = body
                payload["send_project_id"] = project_id
                db.execute("UPDATE outbox SET payload = ? WHERE id = ?", (json.dumps(payload), row_id))
        return True
    def split_project_update(self, row_id: str, expected: dict[str, Any], now: float,
                             waiting: set[str]) -> bool | None:
        """Keep status-blocked lines pending while the eligible lines use this client id."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT payload, next_at FROM outbox WHERE id=? AND kind='project_update' "
                             "AND state='pending' AND hold_reason IS NULL", (row_id,)).fetchone()
            if not row or row["next_at"] > now:
                return False
            if json.loads(row["payload"]) != expected:
                return None
            if not self._admitted(db, *self._targets(expected)): return False
            # The exact unstarted row may partition again as original held
            # members regain scope. Sent siblings do not own this request ID.
            if expected.get("write_started") is True or expected.get("frozen") or (
                    "write_started" not in expected and expected.get("send_body")):
                return False
            if not waiting or waiting == set(expected["lines"]):
                return False
            ready, deferred = dict(expected), dict(expected)
            deferred["followup"] = True
            for part, idents in ((ready, set(expected["lines"]) - waiting), (deferred, waiting)):
                part["lines"] = {ident: expected["lines"][ident] for ident in idents}
                part["line_issues"] = {ident: value for ident, value in expected.get("line_issues", {}).items()
                                       if ident in idents}
                part["terminal_lines"] = {ident: value for ident, value in expected.get("terminal_lines", {}).items()
                                          if ident in idents}
                part["resolve"] = next(iter(part["line_issues"].values()), expected.get("resolve"))
                part["terminal"] = bool(part["terminal_lines"])
                ident = next(iter(part["terminal_lines"]), None)
                part["owner_issue_id"] = part["line_issues"].get(ident, "") if ident else ""
                part["requires_status_id"] = part["terminal_lines"].get(ident, "") if ident else ""
                if part.get("task_id"):
                    # Each split keeps a native reporting anchor belonging to
                    # its own lines, never the removed sibling's task identity.
                    work = db.execute("SELECT task_id FROM work WHERE issue_id=? AND origin='native'",
                                      (part["resolve"],)).fetchone()
                    if work:
                        part["task_id"] = work["task_id"]
            db.execute("UPDATE outbox SET payload=? WHERE id=?", (json.dumps(ready), row_id))
            db.execute("INSERT INTO outbox (id, kind, payload, next_at) VALUES (?, 'project_update', ?, ?)",
                       (str(uuid.uuid4()), json.dumps(deferred), row["next_at"]))
        return True
    def drop_unpublished_update(self, row_id: str, expected: dict[str, Any], now: float) -> bool | None:
        """Forget an empty batch only if no valid line merged during preflight."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            row = db.execute("SELECT payload, next_at FROM outbox WHERE id = ? AND kind = 'project_update' "
                             "AND state = 'pending' AND hold_reason IS NULL", (row_id,)).fetchone()
            if not row or row["next_at"] > now:
                return False
            if json.loads(row["payload"]) != expected:
                return None
            if not self._admitted(db, *self._targets(expected)): return False
            db.execute("DELETE FROM outbox WHERE id = ?", (row_id,))
        return True
    def pending_claim(self, issue_id: str) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            return bool(db.execute(
                "SELECT 1 FROM outbox c WHERE c.hold_reason IS NULL AND c.kind = 'status' AND "
                "json_extract(c.payload, '$.issue_id') = ? AND json_extract(c.payload, '$.claim') = 1 AND "
                "(c.state = 'pending' OR (c.state = 'failed' AND c.attempts > 0 AND NOT EXISTS ("
                "SELECT 1 FROM outbox l WHERE l.kind = 'status' AND l.rowid > c.rowid AND "
                "json_extract(l.payload, '$.issue_id') = ?))) LIMIT 1", (issue_id, issue_id)).fetchone())
    def progress_reported(self, issue_id: str, task_id: str, action: str) -> bool:
        """A native progress milestone for this binding is queued, published, or may have landed.

        Progress coalesced unsent (sent with applied=0) or given up before any send attempt
        never reached Linear, so it does not count and the next spawn says it again.
        A timed-out send (failed after an attempt) may have landed and is revived with the
        same client id, so it counts.
        """
        with self._tx() as db:
            return bool(db.execute(
                "SELECT 1 FROM outbox WHERE hold_reason IS NULL AND kind IN ('activity', 'comment') AND "
                "(state = 'pending' OR (state = 'sent' AND COALESCE(json_extract(payload, '$.applied'), 1) = 1) "
                "OR (state = 'failed' AND attempts > 0)) AND "
                "json_extract(payload, '$.issue_id') = ? AND json_extract(payload, '$.task_id') = ? AND "
                "json_extract(payload, '$.native_progress') = 1 AND "
                "(json_extract(payload, '$.content.action') = ? OR "
                "substr(json_extract(payload, '$.body'), 1, length(?) + 1) = ? || ':') LIMIT 1",
                (issue_id, task_id, action, action, action)).fetchone())
    def has_start_ack(self, issue_id: str, task_id: str) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            return bool(db.execute("SELECT 1 FROM outbox WHERE hold_reason IS NULL AND kind='status' AND "
                                   "json_extract(payload, '$.issue_id')=? AND "
                                   "json_extract(payload, '$.task_id')=? AND "
                                   "json_extract(payload, '$.claim')=1 LIMIT 1", (issue_id, task_id)).fetchone())
    def status_pending(self, row_id: str) -> bool:
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            return bool(db.execute("SELECT 1 FROM outbox WHERE hold_reason IS NULL AND id = ? AND kind = 'status' AND "
                                   "(state = 'pending' OR (state = 'failed' AND attempts > 0))",
                                   (row_id,)).fetchone())
    def report(self, row_id: str) -> None:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return
            db.execute("UPDATE outbox SET payload = json_set(payload, '$.reported', 1) WHERE id = ?", (row_id,))
    def rewrite(self, row_id: str, payload: dict[str, Any], next_at: float) -> None:
        with self._tx() as db:
            if not self._row_admitted(db, row_id): return
            row = db.execute("SELECT kind FROM outbox WHERE id=?", (row_id,)).fetchone()
            if not self.conversation_reply(row["kind"], payload) and not self._admitted(db, *self._targets(payload)): return
            db.execute("UPDATE outbox SET payload = ?, next_at = ? WHERE id = ?", (json.dumps(payload), next_at, row_id))
    def delay_session_updates(self, session_id: str, next_at: float, *, turn_id: str = "") -> None:
        """Quiet period: each identified turn retains its first captured deadline across replay."""
        with self._tx() as db:
            self._hold_legacy_outbox(db)
            rows = db.execute("SELECT id, payload FROM outbox WHERE kind='project_update' AND state='pending' AND hold_reason IS NULL AND "
                              "COALESCE(json_extract(payload, '$.frozen'), 0)=0 AND "
                              "json_extract(payload, '$.session_id')=?", (session_id,)).fetchall()
            if turn_id and rows:
                key = json.dumps(["turn_end", session_id, turn_id])
                db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)", (key, str(next_at)))
                next_at = float(db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0])
            for row in rows:
                if self._admitted(db, *self._targets(json.loads(row["payload"]))):
                    db.execute("UPDATE outbox SET next_at=MAX(next_at, ?) WHERE id=?", (next_at, row["id"]))
