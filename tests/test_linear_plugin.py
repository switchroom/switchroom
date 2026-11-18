"""Unit checks for plugins/linear that need no Agent source (these run in public CI).

The end-to-end rules are proven in tests/test_linear_kanban_scenarios.py against a real Kanban board.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from linear_fake_api import ROOT, SELF, Clock, FakeLinear, load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import api as linear_api  # noqa: E402
from hermes_fleet_linear_plugin import oauth  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

PLUGIN = ROOT / "plugins" / "linear"
# Keep the explicit plugin inventory; review architectural growth in the PR.
# Physical line counts are not a behavioral or safety contract.


class FakeContext:
    def __init__(self, settings: dict) -> None:
        self.settings, self.tools, self.hooks, self.services = settings, [], [], []
        self.cli_commands, self.commands = [], []
        self.unloads = []

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_hook(self, name, callback):
        self.hooks.append(name)

    def on_unload(self, callback):
        self.unloads.append(callback)

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli_commands.append(name)

    def register_command(self, name, handler, description="", args_hint="", argument_mode=None):
        self.commands.append(name)


class LinearOutboxOrderTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Store(Path(tmp.name) / "state.db")
        self.store.bind_native("issue-1", "native-1", "default", "default", at=0)
        self.store.finish("issue-1", [("status", {"issue_id": "issue-1", "task_id": "native-1", "state": "done"}),
                                      ("comment", {"issue_id": "issue-1", "task_id": "native-1", "body": "evidence"})], at=100)
        self.status = next(row for row in self.store.pending() if row["kind"] == "status")

    def test_retryable_failed_status_holds_evidence_until_recovery_or_supersession(self) -> None:
        self.assertTrue(self.store.retry(self.status, 100 + 86_401))
        self.assertEqual(self.store.due(100 + 86_401), [])
        newer = self.store.enqueue("status", {"issue_id": "issue-1", "task_id": "native-1", "state": "in_progress"}, at=100 + 86_402)
        self.assertEqual([row["id"] for row in self.store.due(100 + 86_402)], [newer])
        self.store.mark_sent(newer, True)
        self.assertEqual([row["kind"] for row in self.store.due(100 + 86_402)], ["comment"])
        self.assertFalse(self.store.terminal_status_applied(self.status["id"]))
        self.assertEqual(self.store.revive_failed(100 + 86_402), 0)

    def test_nonretryable_failed_status_does_not_block_later_issue_writes(self) -> None:
        self.store.mark(self.status["id"], "failed")
        [dependent] = self.store.due(100)
        self.assertEqual(dependent["kind"], "comment")
        self.store.mark_sent(dependent["id"], False)
        newer = self.store.enqueue("status", {"issue_id": "issue-1", "task_id": "native-1", "state": "in_progress"}, at=101)
        self.assertEqual([row["id"] for row in self.store.due(101)], [newer])

    def test_legacy_attempted_terminal_without_send_marker_requires_explicit_resolution(self) -> None:
        self.store.rewrite(self.status["id"], {**self.status["payload"], "terminal": True}, 100)
        attempted = self.store.outbox_row(self.status["id"])
        self.store.retry(attempted, 100)
        self.assertTrue(self.store.issue_reconciliation_blocked("issue-1"))
        self.assertFalse(self.store.put("issue-1", "chat", "fresh"))
        self.assertEqual(self.store.enqueue("status", {"issue_id": "issue-1", "task_id": "native-1", "state": "in_progress"}, at=101), "")
        with self.assertRaises(ValueError):
            self.store.reconcile_terminal(self.status["id"], outcome="applied", evidence="", at=102)
        self.assertTrue(self.store.reconcile_terminal(
            self.status["id"], outcome="not_applied", evidence="https://docs.example/verified", at=102))
        self.assertFalse(self.store.issue_reconciliation_blocked("issue-1"))
        self.assertFalse(self.store.put("issue-1", "chat", "fresh"))
        self.assertIsNotNone(self.store.native_binding("issue-1"))
        receipt = self.store.outbox_row(self.status["id"])
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["attempts"], 1)
        self.assertEqual(receipt["payload"]["reconciliation"]["outcome"], "not_applied")


    def test_advisory_thoughts_never_hold_or_wait_for_issue_writes_and_are_not_revived(self) -> None:
        thought = self.store.enqueue("activity", {"issue_id": "issue-1", "task_id": "native-1", "session_id": "s-1",
                                                  "content": {"type": "thought", "body": "Working"}}, at=100)
        self.assertEqual({row["kind"] for row in self.store.due(100)}, {"status", "activity"})
        self.store.retry(self.store.outbox_row(thought), 100)  # a thought backing off holds nothing
        self.assertEqual([row["kind"] for row in self.store.due(100)], ["status"])
        self.store.retry(self.status, 170)  # nor does it wait behind a backing-off issue write
        self.assertEqual([row["id"] for row in self.store.due(200)], [thought])
        self.store.mark(thought, "failed")
        self.store.mark_sent(self.status["id"], True)
        self.assertEqual(self.store.revive_failed(300), 0)
        self.assertEqual(self.store.outbox_row(thought)["state"], "failed")

class LinearPluginUnitTests(unittest.TestCase):
    def test_off_by_default_and_one_block_enables_it(self) -> None:
        idle = FakeContext({})
        plugin.register(idle)
        self.assertEqual((idle.tools, idle.hooks, idle.services), ([], [], []))
        on = FakeContext({"enabled": True})
        plugin.register(on)
        self.assertEqual([t["name"] for t in on.tools], ["linear", "linear_work_reference"])
        self.assertNotIn("inject_invocation_context", on.tools[0])
        self.assertIn("update_description", on.tools[0]["schema"]["parameters"]["properties"]["action"]["enum"])
        self.assertIn("add_comment", on.tools[0]["schema"]["parameters"]["properties"]["action"]["enum"])
        self.assertIn("expected_description", on.tools[0]["schema"]["parameters"]["properties"])
        self.assertIn("execution grant", on.tools[0]["schema"]["parameters"]["properties"]["body"]["description"])
        self.assertNotIn("on_session_end", on.hooks)
        self.assertEqual(on.services, [])
        self.assertEqual((on.cli_commands, on.commands), (["linear"], ["linear-status"]))
        self.assertEqual((idle.cli_commands, idle.commands), ([], []))
        contract = json.loads((ROOT / "contracts" / "plugins.json").read_text(encoding="utf-8"))
        component = next(c for c in contract["components"] if c["id"] == "linear")
        # Reviewed default, planned: off until the starter overlay enables it, and
        # registers nothing without its authorization (the idle case above).
        self.assertFalse(component["default_enabled"])
        self.assertEqual(component["default_role"], "default")
        default = next(d for d in contract["public_base"]["default_set"] if d["id"] == "linear")
        self.assertEqual((default["status"], default["degrade"]["behaviour"]), ("planned", "disable_and_report"))

    def test_production_file_inventory(self) -> None:
        self.assertEqual(sorted(p.name for p in PLUGIN.iterdir() if p.is_file()),
                         ["README.md", "__init__.py", "acceptance.py", "api.py", "bridge.py", "chat.py", "cleanup.py", "diag.py", "guard.py", "handoff.py", "native_input.py", "native_store.py", "oauth.py", "ops.py", "origin.py", "origin_provider.py", "origin_state.py", "outcome.py", "plugin.yaml",
                          "store.py", "transport.py", "work.py", "worker_progress.py"])

    def test_duplicate_create_matches_only_the_live_conflict_shape(self) -> None:
        cid = "0b8f5a7e-3c1d-4e2f-9a6b-7c8d9e0f1a2b"
        conflict = [{"message": "conflict on insert of Comment", "extensions": {
            "code": "INPUT_ERROR", "userPresentableMessage": f"Entity Comment with id {cid} already exists."}}]
        self.assertTrue(linear_api.is_duplicate_create_error(conflict, cid))
        self.assertFalse(linear_api.is_duplicate_create_error(conflict, "another-id"))
        invalid = [{"message": "Argument Validation Error", "extensions": {"code": "INVALID_INPUT"}}]
        self.assertFalse(linear_api.is_duplicate_create_error(invalid, cid))
        self.assertFalse(linear_api.is_duplicate_create_error(None, cid))

    def test_webhook_signature_and_freshness(self) -> None:
        secret, now = b"synthetic-secret", time.time() * 1000
        body = json.dumps({"type": "AgentSessionEvent", "webhookTimestamp": now}).encode()
        good = hmac.new(secret, body, hashlib.sha256).hexdigest()
        self.assertTrue(linear_api.verify_webhook(secret, body, good, now))
        self.assertFalse(linear_api.verify_webhook(b"wrong", body, good, now))
        self.assertFalse(linear_api.verify_webhook(secret, body, good, now + 61_000))
        self.assertFalse(linear_api.verify_webhook(secret, body, "not-hex", now))

    def test_rate_limit_pauses_until_the_reset_header(self) -> None:
        clock, calls = Clock(), []

        def transport(url, body, headers):
            calls.append(json.loads(body))
            reset = str(int((clock() + 90) * 1000))
            return 400, {"X-RateLimit-Requests-Reset": reset}, json.dumps(
                {"errors": [{"message": "limited", "extensions": {"code": "RATELIMITED"}}]}).encode()

        client = linear_api.LinearAPI(lambda: "t", transport=transport, clock=clock)
        with self.assertRaises(linear_api.RateLimited) as caught:
            client.viewer_id()
        self.assertAlmostEqual(caught.exception.until, clock() + 90, delta=1)
        with self.assertRaises(linear_api.RateLimited):
            client.viewer_id()
        self.assertEqual(len(calls), 1)

    def test_malformed_viewer_identity_is_a_linear_error(self) -> None:
        client = linear_api.LinearAPI(
            lambda: "t",
            transport=lambda *args: (200, {}, json.dumps({"data": {"viewer": {}}}).encode()),
        )
        with self.assertRaises(linear_api.LinearError):
            client.viewer_id()
        self.assertIsNone(client._viewer)

    def test_named_mutations_require_literal_success_true(self) -> None:
        mutations = (
            ("issueUpdate", lambda api: api.update_issue("issue-1", {"stateId": "done"})),
            ("commentCreate", lambda api: api.create_comment("client-1", "issue-1", "body")),
            ("agentActivityCreate", lambda api: api.create_activity("client-1", "session-1", {"type": "response"})),
            ("projectUpdateCreate", lambda api: api.create_project_update("client-1", "project-1", "body")),
        )
        malformed = (False, None, 1, "true", {}, "missing")
        for mutation, invoke in mutations:
            for success in malformed:
                with self.subTest(mutation=mutation, success=success):
                    def transport(url, body, headers):
                        query = json.loads(body)["query"]
                        self.assertIn(mutation, query)
                        field = {} if success == "missing" else {"success": success}
                        return 200, {}, json.dumps({"data": {mutation: field}}).encode()

                    api = linear_api.LinearAPI(lambda: "t", transport=transport)
                    with self.assertRaises(linear_api.LinearError) as caught:
                        invoke(api)
                    if success is False:
                        self.assertFalse(caught.exception.retryable)

    def test_named_mutations_accept_literal_success_true(self) -> None:
        mutations = (
            ("issueUpdate", lambda api: api.update_issue("issue-1", {"stateId": "done"})),
            ("commentCreate", lambda api: api.create_comment("client-1", "issue-1", "body")),
            ("agentActivityCreate", lambda api: api.create_activity("client-1", "session-1", {"type": "response"})),
            ("projectUpdateCreate", lambda api: api.create_project_update("client-1", "project-1", "body")),
        )
        for mutation, invoke in mutations:
            with self.subTest(mutation=mutation):
                def transport(url, body, headers):
                    query = json.loads(body)["query"]
                    self.assertIn(mutation, query)
                    return 200, {}, json.dumps({"data": {mutation: {"success": True}}}).encode()

                invoke(linear_api.LinearAPI(lambda: "t", transport=transport))

    def test_unauthorized_refreshes_the_token_once(self) -> None:
        class Token:
            refreshed = 0

            def __call__(self):
                return "fresh" if self.refreshed else "stale"

            def invalidate(self):
                self.refreshed += 1

        def transport(url, body, headers):
            if headers["Authorization"] == "Bearer stale":
                return 401, {}, b"{}"
            return 200, {}, json.dumps({"data": {"viewer": {"id": "app-1"}}}).encode()

        token = Token()
        self.assertEqual(linear_api.LinearAPI(token, transport=transport).viewer_id(), "app-1")
        self.assertEqual(token.refreshed, 1)

    def test_outbox_backoff_give_up_and_revival(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store, now = Store(Path(tmp) / "state.db"), 1_000_000.0
            store.bind_native("i", "native-i", "default", "default", at=0)
            store.enqueue("status", {"issue_id": "i", "task_id": "native-i", "state": "in_progress"}, at=now)
            delays = []
            for _ in range(8):
                [row] = store.due(1e12)
                store.retry(row, now)
                delays.append(store.pending()[0]["next_at"] - now)
            self.assertEqual(delays, [60, 120, 240, 480, 960, 1920, 3600, 3600])
            [row] = store.due(1e12)
            self.assertTrue(store.retry(row, now + 86_400))
            self.assertEqual(store.pending(), [])
            store.enqueue("status", {"issue_id": "i", "task_id": "native-i", "state": "done"}, at=now)
            store.enqueue("comment", {"issue_id": "i", "task_id": "native-i", "body": "x"}, at=now)
            self.assertEqual([r["kind"] for r in store.due(now)], ["status"])  # one issue, in order
            store.revive_failed(now)  # the older status write is superseded: it must not land late
            self.assertEqual([r["payload"]["state"] for r in store.pending() if r["kind"] == "status"], ["done"])

    def test_terminal_outbox_capture_preserves_verified_native_binding_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "state.db")
            store.bind_native("i", "native-i", "default", "default", at=0)
            with self.assertRaises(TypeError):
                store.finish("i", [("status", {"issue_id": "i", "task_id": "native-i", "state": "done"}),
                                   ("activity", {"issue_id": "i", "body": object()})], at=1000)
            self.assertIsNotNone(store.get("i"))
            self.assertEqual(store.pending(), [])
            self.assertTrue(store.finish("i", [("status", {"issue_id": "i", "task_id": "native-i", "state": "done"})], at=1000))
            self.assertIsNotNone(store.native_binding("i"))
            self.assertEqual(len(store.pending()), 1)

    def test_existing_work_table_adds_chat_panel_and_stop_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE work (issue_id TEXT PRIMARY KEY, origin TEXT NOT NULL, "
                           "owner_ref TEXT NOT NULL, task_id TEXT, project_id TEXT, "
                           "last_updated_at REAL NOT NULL DEFAULT 0)")
                db.execute("INSERT INTO work VALUES ('i', 'chat', 'chat-key', NULL, NULL, 0)")
            store = Store(path)
            self.assertEqual(store.get("i")["stop_requested_at"], 0)
            store.update("i", panel_note="Need input")
            with self.assertRaises(ValueError):
                store.update("i", stop_requested_at=0)
            self.assertEqual(Store(path).get("i")["panel_note"], "Need input")






class FakeConnect:
    """A 1Password Connect item: whole-field PATCH semantics, as the live service needs."""

    def __init__(self) -> None:
        self.fields = [{"id": "f1", "label": "client_id", "value": "cid"},
                       {"id": "f2", "label": "client_secret", "value": "secret"},
                       {"id": "f3", "label": "refresh_token", "value": "r0"}]
        self.fail_patch = False
        self.patches = 0

    def __call__(self, method, url, headers, body):
        if method == "PATCH":
            if self.fail_patch:
                raise OSError("Connect down")
            self.patches += 1
            [op] = json.loads(body)
            index = next(i for i, f in enumerate(self.fields) if op["path"] == f"/fields/{f['id']}")
            self.fields[index] = op["value"]
        return {"id": "item-x", "vault": {"id": "vault-x"}, "fields": [dict(f) for f in self.fields]}


class ConnectOAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cache = Path(tmp.name) / "secrets" / "linear-oauth.json"
        self.connect, self.clock, self.posts = FakeConnect(), Clock(), []
        item = oauth.ConnectItem("https://connect.example", "t", "vault-x", "item-x", transport=self.connect)
        self.provider = oauth.ConnectOAuth(item, self.cache, clock=self.clock, post=self.post)

    def post(self, form):
        self.posts.append(form["refresh_token"])
        n = len(self.posts)
        return {"access_token": f"a{n}", "refresh_token": f"r{n}", "expires_in": 3600}

    def refresh_token(self) -> str:
        return next(f["value"] for f in self.connect.fields if f["label"] == "refresh_token")

    def test_refresh_rotates_into_connect_and_caches_the_access_token(self) -> None:
        self.assertEqual(self.provider(), "a1")
        self.assertEqual(self.posts, ["r0"])
        self.assertEqual(self.refresh_token(), "r1")  # rotation stored, whole-field PATCH
        self.assertEqual(self.provider(), "a1")  # cached until near expiry
        self.clock.now += 3600
        self.assertEqual(self.provider(), "a2")
        self.assertEqual(self.posts, ["r0", "r1"])
        self.assertEqual(oct(self.cache.stat().st_mode & 0o777), "0o600")

    def test_connect_outage_keeps_the_rotated_token_and_retries(self) -> None:
        self.connect.fail_patch = True
        self.assertEqual(self.provider(), "a1")
        self.assertEqual(self.refresh_token(), "r0")
        self.clock.now += 3600  # expired: the next refresh must use the rotated token, not the stale one
        self.assertEqual(self.provider(), "a2")
        self.assertEqual(self.posts, ["r0", "r1"])
        self.connect.fail_patch = False
        self.clock.now += 400
        self.provider()
        self.assertEqual(self.refresh_token(), "r2")

    def test_deleted_cache_rebuilds_from_connect(self) -> None:
        self.provider()
        self.cache.unlink()
        self.assertEqual(self.provider(), "a2")
        self.assertEqual(self.posts, ["r0", "r1"])

    def test_rejected_refresh_token_asks_for_reauthorization(self) -> None:
        import io
        import urllib.error
        from unittest import mock

        error = urllib.error.HTTPError(oauth.TOKEN_ENDPOINT, 400, "bad", {}, io.BytesIO(b"{}"))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(oauth.ReauthorizationRequired):
                oauth.ConnectOAuth._post_refresh({"grant_type": "refresh_token"})

    def test_token_failure_is_a_retryable_linear_error(self) -> None:
        def broken():
            raise oauth.ReauthorizationRequired("reauthorize")

        with self.assertRaises(linear_api.LinearError) as caught:
            linear_api.LinearAPI(broken, transport=lambda *a: (200, {}, b"{}")).viewer_id()
        self.assertTrue(caught.exception.retryable)

RESTART = "[Linear] The gateway restarted while you were working on a Linear issue."




class SettingsAllowlistTests(unittest.TestCase):
    def test_every_service_setting_the_bridge_reads_is_loaded_from_config(self) -> None:
        # The service builds its settings only from plugin.SETTINGS; a key the bridge reads but the
        # allowlist omits is silently never loaded (takeover was, so take_over always refused).
        read = set()
        for name in ("__init__.py", "bridge.py"):
            read |= set(re.findall(r'settings\.get\("([a-z_]+)"', (PLUGIN / name).read_text()))
        self.assertTrue({"takeover", "states", "board"} <= read)
        self.assertEqual(sorted(read - set(plugin.SETTINGS)), [])


if __name__ == "__main__":
    unittest.main()
