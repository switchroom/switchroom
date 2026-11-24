"""Linear plugin diagnostics: metadata-only decision lines, bounded volume, honest levels.

Job spec "Diagnosable failures": a failed handoff, closure or takeover can be
explained from these lines alone, and they never carry content or credentials.
"""
from __future__ import annotations

import ast
import asyncio
import collections
import contextlib
import json
import logging
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from linear_fake_api import ROOT, load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import api as linear_api  # noqa: E402
from hermes_fleet_linear_plugin import chat, diag  # noqa: E402
from hermes_fleet_linear_plugin.api import LinearError  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

LOGGER = "hermes_plugins.linear"
ISSUE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
TASK = "t_1234abcd"
SECRET_TOKEN = "lin_api_SyntheticSecretToken0123456789"
EMAIL = "someone@example.com"
BODY = f"Please ship it. Bearer {SECRET_TOKEN}\nContact {EMAIL} https://example.com/x?token=abc"
FORBIDDEN = (SECRET_TOKEN, EMAIL, "Bearer", "lin_", "@", "Please ship it", "https://", "\n")
LINE = re.compile(r"linear\.evt action=[a-z_.?]+ outcome=[a-z_?-]+ reason=[a-z0-9_?-]+( [a-z_]+=[A-Za-z0-9_.+?-]+)*")


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def lines(self, level: int | None = None) -> list[str]:
        return [r.getMessage() for r in self.records if level is None or r.levelno == level]


class DiagCase(unittest.TestCase):
    def setUp(self) -> None:
        diag.reset()
        self.now = [1000.0]
        self.wall = [1_900_000_000.0]
        self.cpu = [50.0]  # this thread's CPU time
        for name, source in (("_now", self.now), ("_wall", self.wall), ("_cpu", self.cpu)):
            patcher = patch.object(diag, name, lambda source=source: source[0])
            patcher.start()
            self.addCleanup(patcher.stop)
        self.capture = Capture()
        logger = logging.getLogger(LOGGER)
        previous = logger.level
        logger.setLevel(logging.DEBUG)
        logger.addHandler(self.capture)
        self.addCleanup(logger.removeHandler, self.capture)
        self.addCleanup(logger.setLevel, previous)
        self.addCleanup(diag.reset)

    def assertNoContent(self, records=None) -> None:
        for record in records if records is not None else self.capture.records:
            text = record.getMessage()
            if record.exc_info:
                text += logging.Formatter().formatException(record.exc_info)
            for forbidden in FORBIDDEN:
                self.assertNotIn(forbidden, text)


class FieldSafetyTests(DiagCase):
    def test_every_field_rejects_content_and_credentials(self) -> None:
        hostile = [BODY, SECRET_TOKEN, EMAIL, "Bearer abc", "https://example.com/?q=1", "a\nb", "x" * 500,
                   "ABC-1 extra", "t_1234abcd\n", {"body": BODY}, [BODY], b"bytes", 3.5e300, True]
        for value in hostile:
            fields = {key: value for key in diag.FIELDS}
            diag.evt("status.write", "refused", value if isinstance(value, str) else "-", **fields)
            diag.evt(value if isinstance(value, str) else "status.write", value if isinstance(value, str) else "-")
        self.assertTrue(self.capture.records)
        self.assertNoContent()
        for line in self.capture.lines():
            self.assertRegex(line, LINE)

    def test_unknown_keys_are_dropped_and_known_ids_are_shortened(self) -> None:
        diag.remember({"id": ISSUE, "identifier": "ABC-584", "title": BODY})
        line = diag.render("status.write", "refused", "updated_after_source", iss=ISSUE, task=TASK,
                           sess="9f8e7d6c-1111-4222-8333-444455556666", row="93ff1e7f-aaaa-4bbb-8ccc-dddd",
                           attempt=0, ms=12.7, body=BODY, title=BODY, state="blocked")
        self.assertEqual(line, "linear.evt action=status.write outcome=refused reason=updated_after_source "
                               "issue=ABC-584 iss=0a1b2c3d task=t_1234abcd sess=9f8e7d6c row=93ff1e7f "
                               "attempt=0 ms=12 state=blocked")

    def test_fixed_field_set_and_agent_context(self) -> None:
        diag.configure(agent="alpha", profile="default")
        diag.evt("native.event", "queued", "native_gave_up", iss=ISSUE, task=TASK, evt=8558, kind="gave_up")
        self.assertEqual(self.capture.lines(), [
            "linear.evt action=native.event outcome=queued reason=native_gave_up agent=alpha profile=default "
            "iss=0a1b2c3d task=t_1234abcd evt=8558 kind=gave_up"])

    def test_reason_vocabulary_is_closed(self) -> None:
        diag.evt("status.write", "refused", "made_up_reason")
        diag.evt("status.write", "refused", "native_crashed")
        diag.evt("status.write", "invented_outcome", "-")
        self.assertIn("reason=?", self.capture.lines()[0])
        self.assertIn("reason=native_crashed", self.capture.lines()[1])
        self.assertIn("outcome=?", self.capture.lines()[2])


class VolumeTests(DiagCase):
    def test_warning_once_per_fifteen_minutes_then_suppressed_count(self) -> None:
        # One binding whose read raises on every 2 s tick for an hour.
        for _ in range(1800):
            diag.warn("binding.held", "held", "retryable_http", iss=ISSUE, task=TASK, exc="LinearError")
            self.now[0] += 2
        warnings = self.capture.lines(logging.WARNING)
        self.assertLessEqual(len(warnings), 4)
        self.assertNotIn("suppressed=", warnings[0])
        self.assertIn("suppressed=", warnings[-1])

    def test_distinct_issues_and_reasons_are_not_merged(self) -> None:
        diag.warn("binding.held", "held", "retryable_http", iss=ISSUE)
        diag.warn("binding.held", "held", "non_retryable", iss=ISSUE)
        diag.warn("binding.held", "held", "retryable_http", iss="ffffffff-0000-4000-8000-000000000000")
        self.assertEqual(len(self.capture.lines(logging.WARNING)), 3)

    def test_repeated_refusal_is_hourly_and_applied_is_never_deduped(self) -> None:
        for _ in range(30):
            diag.evt("status.write", "refused", "updated_after_source", iss=ISSUE, task=TASK)
            diag.evt("status.write", "applied", "-", iss=ISSUE, task=TASK)
            self.now[0] += 60
        lines = self.capture.lines(logging.INFO)
        self.assertEqual(sum("outcome=refused" in line for line in lines), 1)
        self.assertEqual(sum("outcome=applied" in line for line in lines), 30)

    def test_transition_logs_not_running_once(self) -> None:
        for _ in range(1800):
            diag.transition("delegate.write", "skipped", "not_running", key=ISSUE, iss=ISSUE, task=TASK)
        self.assertEqual(len(self.capture.lines()), 1)
        diag.transition("delegate.write", "queued", "binding_recovery", key=ISSUE, iss=ISSUE)
        self.assertEqual(len(self.capture.lines()), 2)

    def test_hard_cap_of_two_hundred_info_lines_per_hour(self) -> None:
        for index in range(2000):
            diag.evt("status.write", "applied", "-", iss=f"{index:08x}")
            diag.count("sent")
            diag.tick_done(self.now[0])
            self.now[0] += 1.7  # one hour
        info = self.capture.lines(logging.INFO)
        self.assertLessEqual(len(info), diag.HOURLY_CAP)
        self.assertTrue(any("reconcile.summary" in line for line in info), "summaries keep flowing")
        throttled = [line for line in self.capture.lines(logging.WARNING) if "diag.throttled" in line]
        self.assertEqual(len(throttled), 1)

    def test_idle_budget_zero_lines_and_hourly_health_only_with_linked_work(self) -> None:
        gauges = {"n_bindings": 0, "n_pending": 0}
        for _ in range(1800 * 3):  # three idle hours at 2 s ticks
            diag.tick_done(self.now[0], lambda: gauges)
            self.now[0] += 2
        self.assertEqual(self.capture.lines(), [])
        gauges = {"n_bindings": 18, "n_pending": 0, "n_held": 0, "n_failed_unreported": 0}
        for _ in range(1800 * 3):
            diag.tick_done(self.now[0], lambda: gauges)
            self.now[0] += 2
        lines = self.capture.lines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(all("action=service.health" in line and "n_bindings=18" in line for line in lines))

    def test_routine_background_work_never_triggers_a_summary(self) -> None:
        for _ in range(1800):  # one hour of heartbeats and keepalive comments on running work
            diag.native_event("heartbeat", iss=ISSUE, task=TASK, evt=1)
            diag.count("content")
            diag.tick_done(self.now[0])
            self.now[0] += 2
        self.assertEqual(self.capture.lines(), [])

    def test_summary_once_per_minute_only_when_something_happened(self) -> None:
        for second in range(0, 600, 2):
            if second < 120:
                diag.count("events")
            diag.tick_done(self.now[0])
            self.now[0] += 2
        summaries = [line for line in self.capture.lines() if "reconcile.summary" in line]
        self.assertEqual(len(summaries), 2)
        self.assertIn("n_events=", summaries[0])


class TickTimingTests(DiagCase):
    """reconcile.summary splits the slowest tick into Linear request time and local work."""

    def api(self, seconds: float = 1.5, statuses=None):
        statuses = list(statuses or [])
        def transport(url, body, headers):
            self.now[0] += seconds  # the request itself takes this long
            return (statuses.pop(0) if statuses else 200), {}, b'{"data": {"viewer": {"id": "v"}}}'
        return linear_api.LinearAPI(lambda: "token", transport=transport)

    def summary(self) -> dict[str, int]:
        lines = [line for line in self.capture.lines() if "reconcile.summary" in line]
        self.assertEqual(len(lines), 1, lines)
        return {key: int(value) for key, value in re.findall(r" ((?:max_tick|n)_[a-z_]+)=(\d+)", lines[0])}

    def flush_summary(self) -> None:
        diag.count("events")
        self.now[0] += diag.SUMMARY_EVERY_S
        diag.tick_done(self.now[0])

    def tick(self, api, *, local: float, requests: int) -> None:
        started = self.now[0]
        diag.tick_begin()
        self.now[0] += local / 2
        for _ in range(requests):
            api.graphql("query Viewer { viewer { id } }")
        self.now[0] += local / 2
        diag.tick_done(started)

    def test_summary_splits_api_and_local_time_and_counts_requests(self) -> None:
        api = self.api(seconds=1.5)
        self.tick(api, local=0.5, requests=2)   # 3.5 s: 3.0 s Linear, 0.5 s local, 2 requests
        self.tick(api, local=1.2, requests=0)   # 1.2 s, all local
        self.flush_summary()
        values = self.summary()
        self.assertEqual(values["max_tick_ms"], 3500)
        self.assertEqual(values["max_tick_api_ms"], 3000)
        self.assertEqual(values["max_tick_local_ms"], 1200)  # the slowest local part, from the second tick
        self.assertEqual(values["max_tick_api_calls"], 2)
        self.assertEqual(values["n_api_calls"], 2)

    def test_a_credential_retry_is_a_second_request(self) -> None:
        refreshed = []
        api = self.api(seconds=0.25, statuses=[401, 200])
        token = Mock(return_value="token")
        token.invalidate = lambda: refreshed.append(True)
        api.token = token
        self.tick(api, local=0.0, requests=1)
        self.flush_summary()
        values = self.summary()
        self.assertEqual(refreshed, [True])
        self.assertEqual((values["max_tick_api_calls"], values["max_tick_api_ms"]), (2, 500))

    def test_requests_outside_the_ticking_thread_are_not_counted(self) -> None:
        api = self.api(seconds=2.0)
        api.graphql("query Viewer { viewer { id } }")  # before any tick: not counted
        started = self.now[0]
        diag.tick_begin()
        worker = threading.Thread(target=api.graphql, args=("query Viewer { viewer { id } }",))
        worker.start()
        worker.join()  # a chat tool's request on its own thread, while this tick runs
        diag.tick_done(started)
        self.flush_summary()
        values = self.summary()
        self.assertEqual(values["max_tick_ms"], 2000)
        self.assertEqual(values["max_tick_api_ms"], 0)
        self.assertEqual(values["max_tick_local_ms"], 2000)
        self.assertEqual(values["n_api_calls"], 0)

    def test_nested_requests_are_timed_once(self) -> None:
        started = self.now[0]
        diag.tick_begin()
        with diag.api_time():
            self.now[0] += 1.0
            with diag.api_time():
                diag.api_sent()
                self.now[0] += 1.0
        diag.tick_done(started)
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_ms"], values["max_tick_api_ms"], values["max_tick_local_ms"]),
                         (2000, 2000, 0))

    def test_requests_alone_never_trigger_a_summary(self) -> None:
        api = self.api(seconds=0.1)
        for _ in range(100):
            self.tick(api, local=0.0, requests=3)
            self.now[0] += 2
        self.assertEqual(self.capture.lines(), [])

    def test_time_blocked_on_an_issue_lock_held_elsewhere_is_wait_not_local(self) -> None:
        bridge = Bridge.__new__(Bridge)
        bridge._guard, bridge._locks = threading.Lock(), collections.defaultdict(threading.RLock)
        holding, release = threading.Event(), threading.Event()
        def chat_tool() -> None:
            with bridge.lock(ISSUE):
                holding.set()
                release.wait(5)
        holder = threading.Thread(target=chat_tool)
        holder.start()
        holding.wait(5)
        started = self.now[0]
        diag.tick_begin()
        threading.Timer(0.05, lambda: (self.now.__setitem__(0, self.now[0] + 3.0), release.set())).start()
        with bridge.lock(ISSUE):            # blocks until the chat tool lets go, 3 s later
            with bridge.lock(ISSUE):        # re-entry on the same thread never waits
                self.assertTrue(bridge.lock(ISSUE)._is_owned())
                self.now[0] += 0.25         # own work under the lock
        diag.tick_done(started)
        holder.join(5)
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_ms"], values["max_tick_wait_ms"], values["max_tick_local_ms"],
                          values["max_tick_api_ms"]), (3250, 3000, 250, 0))

    def test_time_blocked_on_the_store_write_lock_is_wait(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "state.db")
            other = sqlite3.connect(Path(tmp) / "state.db", isolation_level=None, check_same_thread=False)
            self.addCleanup(other.close)
            other.execute("BEGIN IMMEDIATE")  # another process is mid-write
            def commit_later() -> None:
                self.now[0] += 2.0
                other.execute("COMMIT")
            threading.Timer(0.05, commit_later).start()
            started = self.now[0]
            diag.tick_begin()
            store.diag_counts(self.wall[0])
            diag.tick_done(started)
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_wait_ms"], values["max_tick_local_ms"]), (2000, 0))

    def test_bridge_tick_reports_its_own_split(self) -> None:
        api = self.api(seconds=4.0)
        bridge = Bridge.__new__(Bridge)
        bridge.store = SimpleNamespace(diag_counts=lambda now: {"n_bindings": 1})
        bridge.clock = lambda: self.wall[0]
        def pump() -> None:
            self.now[0] += 0.75  # local work
            api.graphql("query Viewer { viewer { id } }")
        bridge._recover_stops = lambda: None
        bridge.pump_kanban = pump
        bridge.recheck = lambda: api.graphql("query Viewer { viewer { id } }")
        bridge.flush = lambda: None
        with patch.object(time, "monotonic", lambda: self.now[0]):
            bridge.tick()
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_ms"], values["max_tick_api_ms"], values["max_tick_local_ms"],
                          values["max_tick_api_calls"]), (8750, 8000, 750, 2))


    def test_local_time_separates_running_from_waiting_to_run(self) -> None:
        """local_cpu is the thread's own CPU outside requests; the rest of local is off-CPU."""
        def transport(url, body, headers):
            self.now[0] += 1.0   # a request: 1 s wall,
            self.cpu[0] += 0.2   # 0.2 s of it decoding on this thread, which is the request's
            return 200, {}, b'{"data": {"viewer": {"id": "v"}}}'
        api = linear_api.LinearAPI(lambda: "token", transport=transport)
        started = self.now[0]
        diag.tick_begin()
        self.now[0] += 1.0
        self.cpu[0] += 0.5       # own work actually running
        api.graphql("query Viewer { viewer { id } }")
        self.now[0] += 2.0       # runnable but not running: another thread held the interpreter
        diag.tick_done(started)
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_ms"], values["max_tick_api_ms"], values["max_tick_local_ms"],
                          values["max_tick_local_cpu_ms"]), (4000, 1000, 3000, 500))

    def test_local_cpu_never_exceeds_local_time(self) -> None:
        started = self.now[0]
        diag.tick_begin()
        self.now[0] += 0.5
        self.cpu[0] += 0.75       # a clock skew between the two timers is clamped, never reported as more
        diag.tick_done(started)
        self.flush_summary()
        values = self.summary()
        self.assertEqual((values["max_tick_local_ms"], values["max_tick_local_cpu_ms"]), (500, 500))


class DetailSettingTests(DiagCase):
    def test_there_is_no_detail_mode_or_diagnostics_setting(self) -> None:
        # The time-boxed detail mode was unused fleet-wide and is gone (T4, decision 5).
        self.assertNotIn("diagnostics", plugin.SETTINGS)
        self.assertFalse(hasattr(diag, "detail"))
        self.assertFalse(diag.transition("delegate.write", "skipped", "task_finished", key="k", quiet=True))
        self.assertEqual(self.capture.records, [])


class Kanban:
    executor_profile, board = "default", None

    def __init__(self, status: str = "blocked") -> None:
        self.status = status

    def require_task(self, task_id):
        return SimpleNamespace(id=task_id, body="", assignee="default", status=self.status, current_run_id=None)

    get = require_task


class Api:
    specialist_scope = None

    def __init__(self, *, state="started", fail_comment=False) -> None:
        self.state, self.fail_comment, self.comments = state, fail_comment, []

    @contextlib.contextmanager
    def guarded_mutation(self, guard):
        yield

    def issue(self, ref):
        return {"id": ref, "identifier": "ABC-566", "title": BODY, "description": BODY,
                "state": {"type": self.state, "id": "s"}, "delegate": None, "updatedAt": "2026-01-01T00:00:00Z",
                "team": {"key": "HF", "states": {"nodes": []}}}

    def viewer_id(self):
        return "app-user"

    def create_comment(self, client_id, issue_id, body):
        if self.fail_comment:
            raise LinearError("Linear rejected: " + body, retryable=False)
        self.comments.append(body)

    def verify_comment(self, comment_id, issue_id, body):
        return True


class BridgePathTests(DiagCase):
    def make(self, api: Api, kanban: Kanban | None = None) -> tuple[Bridge, Store]:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Store(Path(tmp.name) / "state.db")
        store.bind_native(ISSUE, TASK, "default", "default", at=0)
        bridge = Bridge(store, api, kanban or Kanban(), profile="default",
                        settings={"ingress_profile": "alpha"})
        return bridge, store

    def test_one_webhook_delivery_is_routed_once_while_it_waits_for_its_commit(self) -> None:
        # HF-823: HF-813 event bfed45f8 was logged as routed 13 times in 4 s. The delivery stays
        # pending until native input commits it, so every drain hands it over again; only the first
        # hand-over is routing. A failed hand-over routes it anew on the retry.
        from linear_ingress_fixture import IngressStore, Route
        bridge, _store = self.make(Api())
        inbox = Path(tempfile.mkdtemp(dir=self.enterContext(tempfile.TemporaryDirectory()))) / "ingress.db"
        route = Route("agent-a", "alpha", "/webhook/alpha", inbox.parent / "unused", inbox)
        event = {"type": "AgentSessionEvent", "action": "created", "webhookId": "evt-1",
                 "agentSession": {"id": "sess-1", "issue": {"id": ISSUE}}}
        IngressStore(inbox).enqueue(route, "evt-1", json.dumps(event).encode())
        calls, outcomes = [], [True, True, LinearError("receiver interrupted"), True, True]
        def native(delivery):
            calls.append(delivery.delivery_id)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        bridge.native_ingress = native
        for _ in range(5):
            bridge.drain_ingress(inbox, retry_now=True)
        self.assertEqual(calls, ["evt-1"] * 5)  # still offered each drain: the receiver keeps one submission
        routed = [line for line in self.capture.lines() if "outcome=routed" in line and "reason=native_routed" in line]
        self.assertEqual(len(routed), 2, routed)  # once, then once more after the failed hand-over

    def test_failed_comment_logs_metadata_only_and_keeps_reason_on_row(self) -> None:
        bridge, store = self.make(Api(fail_comment=True))
        row_id = store.enqueue("comment", {"issue_id": ISSUE, "body": BODY, "content_action": True,
                                           "unlinked_content": True})
        bridge.flush()
        warnings = self.capture.lines(logging.WARNING)
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn("action=outbox.retry outcome=failed reason=non_retryable", warnings[0])
        self.assertIn("exc=LinearError", warnings[0])
        self.assertNoContent()
        self.assertEqual(store.outbox_row(row_id)["payload"]["failure_reason"], "non_retryable")

    def test_applied_comment_is_counted_not_logged_and_never_logs_its_body(self) -> None:
        bridge, store = self.make(Api())
        store.enqueue("comment", {"issue_id": ISSUE, "body": BODY, "content_action": True, "unlinked_content": True})
        bridge.flush()
        self.assertEqual(self.capture.lines(logging.INFO), [])
        self.assertNoContent()

    def test_refused_status_names_the_fence_and_persists_it(self) -> None:
        # ABC-566: a terminal-looking status write refused with no trace. Now the line and the row say why.
        bridge, store = self.make(Api(state="completed"))
        row_id = store.enqueue("status", {"issue_id": ISSUE, "task_id": TASK, "state": "blocked"})
        self.assertTrue(row_id)
        bridge.flush()
        refused = [line for line in self.capture.lines(logging.INFO) if "action=status.write" in line]
        self.assertEqual(len(refused), 1, self.capture.lines())
        self.assertIn("outcome=refused reason=issue_closed", refused[0])
        self.assertIn("issue=ABC-566", refused[0])
        self.assertIn(f"row={row_id[:8]}", refused[0])
        self.assertEqual(store.outbox_row(row_id)["payload"]["outcome_reason"], "issue_closed")
        self.assertNoContent()

    def test_bound_issue_webhook_is_one_line_without_payload_text(self) -> None:
        bridge, store = self.make(Api())
        event = {"type": "Issue", "action": "update", "data": {"id": ISSUE, "title": BODY, "description": BODY}}
        unbound = {"type": "Issue", "action": "update", "data": {"id": "ffffffff-0000-4000-8000-000000000000"}}
        comment = {"type": "Comment", "action": "create", "data": {"body": BODY}}
        with tempfile.TemporaryDirectory() as directory:
            inbox = Path(directory) / "ingress.db"
            import sqlite3
            with contextlib.closing(sqlite3.connect(inbox)) as db, db:
                db.execute("CREATE TABLE deliveries (logical_agent TEXT, delivery_id TEXT, profile TEXT, payload TEXT, "
                           "received_at REAL, attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending')")
                for index, payload in enumerate((event, unbound, comment)):
                    db.execute("INSERT INTO deliveries (logical_agent, delivery_id, profile, payload, received_at) "
                               "VALUES ('alpha', ?, 'alpha', ?, 0)", (f"dlv-{index}", json.dumps(payload)))
            bridge.drain_ingress(inbox, retry_now=True)
        deliveries = [line for line in self.capture.lines() if "action=webhook.delivery" in line]
        self.assertEqual(len(deliveries), 1, self.capture.lines())
        self.assertIn("outcome=routed reason=bound_issue_recheck", deliveries[0])
        self.assertIn("kind=Issue.update", deliveries[0])
        self.assertNoContent()

    def test_issue_webhook_echo_and_coalesced_recheck_are_named(self) -> None:
        api = Api()
        api.identity = {"viewer_id": "app-user"}
        bridge, store = self.make(api)
        echo = {"type": "Issue", "action": "update", "actor": {"id": "app-user"}, "data": {"id": ISSUE, "title": BODY}}
        human = {"type": "Issue", "action": "update", "actor": {"id": "human-1"}, "data": {"id": ISSUE, "title": BODY}}
        with tempfile.TemporaryDirectory() as directory:
            inbox = Path(directory) / "ingress.db"
            import sqlite3
            with contextlib.closing(sqlite3.connect(inbox)) as db, db:
                db.execute("CREATE TABLE deliveries (logical_agent TEXT, delivery_id TEXT, profile TEXT, payload TEXT, "
                           "received_at REAL, attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending')")
                for index, payload in enumerate((echo, human, human)):
                    db.execute("INSERT INTO deliveries (logical_agent, delivery_id, profile, payload, received_at) "
                               "VALUES ('alpha', ?, 'alpha', ?, ?)", (f"dlv-{index}", json.dumps(payload), index))
            bridge.drain_ingress(inbox, retry_now=True)
        deliveries = [line for line in self.capture.lines() if "action=webhook.delivery" in line]
        self.assertEqual([re.search(r"outcome=\S+ reason=\S+", line).group(0) for line in deliveries],
                         ["outcome=ignored reason=own_echo", "outcome=routed reason=bound_issue_recheck",
                          "outcome=deduped reason=recheck_coalesced"], self.capture.lines())
        self.assertNoContent()

    def test_delegate_recovery_names_its_skip_once(self) -> None:
        bridge, store = self.make(Api())
        row = store.get(ISSUE)
        adapter = Kanban("running")  # Running, but its claim is not readable yet.
        with patch.object(Bridge, "_current_claim", staticmethod(lambda adapter, task: None)):
            for _ in range(50):
                bridge._recover_binding_delegate(row, adapter)
        lines = self.capture.lines()
        self.assertEqual(lines, [
            "linear.evt action=delegate.write outcome=skipped reason=claim_unconsumed agent=alpha profile=default "
            f"iss=0a1b2c3d task={TASK}"])


class DemotedErrorTests(DiagCase):
    def test_duplicate_create_replay_is_info_not_error(self) -> None:
        client_id = "0b8f5a7e-3c1d-4e2f-9a6b-7c8d9e0f1a2b"
        payload = {"data": None, "errors": [{"message": "conflict on insert of Comment",
                                              "extensions": {"code": "INPUT_ERROR",
                                                             "userPresentableMessage": f"id {client_id} exists"}}]}
        api = linear_api.LinearAPI(lambda: SECRET_TOKEN, transport=lambda url, body, headers: (
            200, {}, json.dumps(payload).encode()))
        api.create_comment(client_id, ISSUE, BODY)  # treated as success
        self.assertEqual([r for r in self.capture.records if r.levelno >= logging.ERROR], [])
        self.assertEqual(self.capture.lines(logging.INFO), [
            "linear.evt action=api.result outcome=deduped reason=duplicate_create code=INPUT_ERROR"])
        self.assertNoContent()

    def test_real_graphql_error_stays_error(self) -> None:
        payload = {"errors": [{"message": "Argument Validation Error", "extensions": {"code": "INVALID_INPUT"}}]}
        api = linear_api.LinearAPI(lambda: SECRET_TOKEN, transport=lambda url, body, headers: (
            200, {}, json.dumps(payload).encode()))
        with self.assertRaises(LinearError):
            api.graphql("query Q { viewer { id } }")
        self.assertEqual(len([r for r in self.capture.records if r.levelno == logging.ERROR]), 1)

    def _serve(self, error: BaseException) -> None:
        class Context:
            def __init__(self) -> None:
                self.unloads = []

            def get_config(self, key, default=None):
                return {"enabled": True}.get(key, default)

            def register_tool(self, **kwargs):
                pass

            def register_hook(self, name, callback):
                pass

            def on_unload(self, callback):
                self.unloads.append(callback)

        async def failing(*args, **kwargs):
            raise error

        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: Path(home.name)
        context = Context()
        with patch.dict(sys.modules, {"hermes_constants": constants}), \
                patch.dict(os.environ, {"_HERMES_GATEWAY": "1"}), \
                patch.object(plugin, "_reporting_loop", failing):
            os.environ.pop("HERMES_KANBAN_TASK", None)
            plugin.register(context)
            for _ in range(500):  # let the service fail on its own before unload
                if self.capture.records:
                    break
                threading.Event().wait(0.01)
            for close in context.unloads:
                close()

    def test_shutdown_race_is_info_without_traceback(self) -> None:
        self._serve(RuntimeError("cannot schedule new futures after shutdown"))
        self.assertEqual([r for r in self.capture.records if r.levelno >= logging.WARNING or r.exc_info], [])
        self.assertEqual(self.capture.lines(logging.INFO), [
            "linear.evt action=service.stop outcome=stopped reason=shutdown exc=RuntimeError"])

    def test_genuine_crash_keeps_error_and_traceback(self) -> None:
        self._serve(ValueError("synthetic crash"))
        errors = [r for r in self.capture.records if r.levelno == logging.ERROR]
        self.assertEqual(len(errors), 1)
        self.assertIn("reason=crash", errors[0].getMessage())
        self.assertIsNotNone(errors[0].exc_info)


class StartupTests(DiagCase):
    def test_version_line_names_the_running_build(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Store(Path(tmp.name) / "state.db")
        store.bind_native(ISSUE, TASK, "default", "default", at=0)
        diag.configure(agent="alpha", profile="default")
        diag.service_start(store, 2.0, 300.0)
        line = self.capture.lines(logging.INFO)[0]
        version = (ROOT / "plugins/linear/plugin.yaml").read_text().split("version:", 1)[1].split()[0]
        self.assertIn("action=service.start outcome=started", line)
        self.assertIn(f"ver={version}", line)
        self.assertRegex(line, r" sha=[0-9a-f]{8}")
        self.assertIn("n_bindings=1", line)
        self.assertNotIn("detail=", line)

    def test_logger_is_under_the_core_component_prefix(self) -> None:
        # Core routes hermes_plugins.* to gateway.log (about six weeks of history).
        self.assertTrue(diag.LOGGER_NAME.startswith("hermes_plugins."))
        source = "\n".join(path.read_text() for path in (ROOT / "plugins/linear").glob("*.py"))
        self.assertNotRegex(source, r'getLogger\("linear')


class ReasonCoverageTests(unittest.TestCase):
    """Every refusal branch in the decision functions names a code from the closed set."""

    SOURCE = (ROOT / "plugins/linear/bridge.py").read_text()
    DECISIONS = ("_send", "may_write", "_stop", "_guarded_stop", "_send_delegate", "_recover_binding_delegate",
                 "_handle_webhook")
    # The two remaining literal returns: may_write already recorded the reason; an unknown kind is "not_applied".
    ALLOWED_BARE_FALSE = 2

    def test_reason_literals_are_in_the_vocabulary(self) -> None:
        codes = re.findall(r'diag\.(?:because|skip|warn|evt|transition|detail)\(\s*"([a-z0-9_]+)"', self.SOURCE)
        codes += re.findall(r'diag\.(?:warn|evt|detail|transition)\("[a-z._]+", "[a-z_-]+", "([a-z0-9_]+)"', self.SOURCE)
        codes += re.findall(r'_log_delegate\(row, "([a-z_]+)"', self.SOURCE)
        reasons = {code for code in codes if code not in diag.ACTIONS}
        self.assertTrue(reasons)
        self.assertEqual(sorted(code for code in reasons if code not in diag.REASONS and "." not in code), [])

    def test_every_tool_reply_code_logs_by_name(self) -> None:
        # Live 4 Nov 2026: create_issue refusals logged reason=? (project_required was not in the set).
        codes = set()
        for name in ("chat.py", "__init__.py"):
            codes |= set(re.findall(r'code="([a-z0-9_]+)"', (ROOT / "plugins/linear" / name).read_text()))
        self.assertIn("project_required", codes)
        self.assertEqual(sorted(code for code in codes if code not in diag.REASONS), [])

    def test_each_tool_result_logs_its_own_line(self) -> None:
        diag.reset()
        with self.assertLogs(diag.LOGGER_NAME, level="INFO") as logs:
            for _ in range(3):
                diag.tool_result({"action": "create_issue"}, '{"ok": false, "code": "request_refused"}')
            diag.tool_result({"action": "status", "issue": "QA-10"}, '{"ok": false, "code": "request_refused"}')
        self.assertEqual(len(logs.output), 4)
        self.assertTrue(all("reason=request_refused" in line for line in logs.output))

    def test_decision_functions_have_no_silent_refusals(self) -> None:
        tree = ast.parse(self.SOURCE)
        silent = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in self.DECISIONS:
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Return) and (sub.value is None or (
                            isinstance(sub.value, ast.Constant) and sub.value.value is False)):
                        silent.append((node.name, sub.lineno))
        self.assertEqual(len(silent), self.ALLOWED_BARE_FALSE, silent)
        self.assertTrue(all(name == "_send" for name, _ in silent), silent)


if __name__ == "__main__":
    unittest.main()
