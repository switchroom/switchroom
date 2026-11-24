"""Inbox addressing is independent of the local chat/executor namespace."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import closing

from linear_fake_api import load_plugin
from linear_ingress_fixture import IngressStore, Route

load_plugin()
from hermes_fleet_linear_plugin.bridge import Bridge
from hermes_fleet_linear_plugin.store import Store


class IngressBindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.inbox = self.home / "ingress.db"
        self.producer = IngressStore(self.inbox)
        self.store = Store(self.home / "state.db")

    def enqueue(self, profile, delivery, event=None):
        route = Route(profile, profile, "/webhook/" + profile, self.home / "unused", self.inbox)
        self.producer.enqueue(route, delivery, json.dumps(event or {"type": "unused"}).encode())

    def statuses(self):
        with closing(sqlite3.connect(self.inbox)) as db:
            return dict(db.execute("SELECT delivery_id, status FROM deliveries"))

    def bridge(self, settings=None):
        return Bridge(self.store, SimpleNamespace(), SimpleNamespace(executor_profile="default"),
                      profile="default", settings=settings)

    def test_explicit_inbox_binding_imports_only_target_without_relabeling_executor(self):
        self.enqueue("worker-a", "target")
        self.enqueue("default", "local-name")
        self.enqueue("worker-b", "foreign")
        bridge = self.bridge({"ingress_profile": "worker-a"})
        bridge.drain_ingress(self.inbox)
        self.assertEqual(self.statuses(), {"target": "imported", "local-name": "pending", "foreign": "pending"})
        self.assertEqual(bridge.profile, "default")
        self.assertTrue(bridge.chat_profile_matches("default"))
        self.assertFalse(bridge.chat_profile_matches("worker-a"))
        self.assertFalse(self.store.active())
        self.assertFalse(self.store.pending())

    def test_target_stop_uses_same_binding_and_precedes_bounded_normal_work(self):
        from unittest.mock import patch
        self.store.put("i", "chat", "owner")
        self.enqueue("worker-a", "a-work", {"type": "unused", "tag": "work"})
        stop = {"agentActivity": {"signal": "stop", "createdAt": "2026-10-06T00:00:00Z"},
                "agentSession": {"issue": {"id": "i"}}, "tag": "target-stop"}
        self.enqueue("worker-a", "z-stop", stop)
        self.enqueue("default", "foreign-stop", {**stop, "agentSession": {"issue": {"id": "other"}}})
        bridge = self.bridge({"ingress_profile": "worker-a", "ingress_database": str(self.inbox)})
        seen = []
        with patch.object(bridge, "handle_webhook", side_effect=lambda event: seen.append(event["tag"])):
            bridge.drain_ingress(self.inbox, limit=1)
        self.assertEqual(seen, ["target-stop", "work"])
        self.assertEqual(self.statuses(), {"a-work": "imported", "z-stop": "imported", "foreign-stop": "pending"})

    def test_failing_delivery_backs_off_without_holding_newer_deliveries(self):
        from unittest.mock import patch
        for name in ("bad-1", "bad-2", "good"):
            self.enqueue("default", name, {"type": "unused", "tag": name})
        with closing(sqlite3.connect(self.inbox)) as db, db:
            db.execute("UPDATE deliveries SET received_at = 1000")
        now = [1000.0]
        bridge = Bridge(self.store, SimpleNamespace(), SimpleNamespace(executor_profile="default"),
                        profile="default", clock=lambda: now[0])
        seen = []
        def handle(event):
            seen.append(event["tag"])
            if event["tag"].startswith("bad"): raise RuntimeError("synthetic failure")
        with patch.object(bridge, "handle_webhook", side_effect=handle):
            with self.assertLogs("hermes_plugins.linear", "ERROR"):
                bridge.drain_ingress(self.inbox, limit=2)  # both failures fill the batch
            bridge.drain_ingress(self.inbox, limit=2)  # backing off: the newer delivery is not held
            self.assertEqual(seen, ["bad-1", "bad-2", "good"])
            now[0] = 1005  # first retry is due 5 s after receipt, and logs one line, not a traceback
            with self.assertLogs("hermes_plugins.linear", "WARNING") as logs:
                bridge.drain_ingress(self.inbox)
            self.assertTrue(all(r.levelname == "WARNING" and not r.exc_info for r in logs.records))
            bridge.drain_ingress(self.inbox)
            self.assertEqual(seen, ["bad-1", "bad-2", "good", "bad-1", "bad-2"])
        with patch.object(bridge, "handle_webhook"):
            bridge.recover(self.inbox)  # a restart retries backed-off deliveries at once
        self.assertEqual(self.statuses(), {"bad-1": "imported", "bad-2": "imported", "good": "imported"})
        self.enqueue("default", "stuck", {"type": "unused", "tag": "bad-stuck"})
        with closing(sqlite3.connect(self.inbox)) as db, db:  # stuck under the old every-tick loop
            db.execute("UPDATE deliveries SET received_at = 1000, attempts = 1800 WHERE delivery_id = 'stuck'")
        now[0] = 1000 + 86_402  # still tried once after a day, so it parks loudly instead of idling
        with patch.object(bridge, "handle_webhook", side_effect=handle), self.assertLogs("hermes_plugins.linear", "ERROR"):
            bridge.drain_ingress(self.inbox)
        self.assertEqual(self.statuses()["stuck"], "failed")

    def test_failing_stop_retries_sooner_than_ordinary_work(self):
        from unittest.mock import patch
        self.store.put("i", "chat", "owner")
        stop = {"agentActivity": {"signal": "stop"}, "agentSession": {"issue": {"id": "i"}}}
        self.enqueue("default", "stop", stop)
        self.enqueue("default", "work", {"type": "unused"})
        with closing(sqlite3.connect(self.inbox)) as db, db:
            db.execute("UPDATE deliveries SET received_at = 1000, attempts = 8")
        bridge = Bridge(self.store, SimpleNamespace(), SimpleNamespace(executor_profile="default"),
                        profile="default", clock=lambda: 1000 + 1300)  # Stop due at +1235, other work at +1535
        with patch.object(bridge, "handle_webhook") as handle:
            bridge.drain_ingress(self.inbox)
        self.assertEqual(handle.call_count, 1)  # the Stop is due; ordinary work waits its longer gap
        self.assertEqual(self.statuses(), {"stop": "imported", "work": "pending"})

    def test_absent_binding_preserves_legacy_profile_selection(self):
        self.enqueue("default", "local")
        self.enqueue("worker-a", "foreign")
        self.bridge().drain_ingress(self.inbox)
        self.assertEqual(self.statuses(), {"local": "imported", "foreign": "pending"})

    def test_reopened_consumer_keeps_owner_and_does_not_repeat_imports(self):
        from unittest.mock import patch
        self.store.put("i", "chat", "owner", last_updated_at=1000)
        before = self.store.get("i")
        self.enqueue("worker-a", "target")
        self.bridge({"ingress_profile": "worker-a"}).drain_ingress(self.inbox)
        reopened = Bridge(Store(self.store.path), SimpleNamespace(), SimpleNamespace(executor_profile="default"),
                          profile="default", settings={"ingress_profile": "worker-a"})
        with patch.object(reopened, "handle_webhook") as handle:
            reopened.drain_ingress(self.inbox)
            handle.assert_not_called()
        self.assertEqual(reopened.store.get("i"), before)
        with closing(sqlite3.connect(self.inbox)) as db:
            self.assertEqual(db.execute("SELECT status, attempts FROM deliveries").fetchone(), ("imported", 1))

    def test_drains_reuse_one_connection_and_read_pending_rows_by_index(self):
        """HF-755: a drain neither reconnects nor scans every filed payload."""
        from hermes_fleet_linear_plugin import bridge as bridge_module
        self.enqueue("default", "first")
        bridge = self.bridge()
        bridge.drain_ingress(self.inbox)
        connection = bridge_module._ingress_local.connection[1]
        self.enqueue("default", "second")
        bridge.drain_ingress(self.inbox)
        self.bridge().drain_ingress(self.inbox)  # another bridge on this thread shares it too
        self.assertIs(bridge_module._ingress_local.connection[1], connection)
        self.assertEqual(self.statuses(), {"first": "imported", "second": "imported"})
        with closing(sqlite3.connect(self.inbox)) as db:
            plan = " ".join(row[-1] for row in db.execute(
                "EXPLAIN QUERY PLAN SELECT payload FROM deliveries WHERE profile = ? AND status = 'pending' "
                "ORDER BY received_at, delivery_id", ("default",)))
        self.assertIn("deliveries_pending_by_profile", plan)
        self.assertNotIn("SCAN deliveries", plan)

    def test_a_replaced_inbox_or_failed_drain_gets_a_new_connection(self):
        from unittest.mock import patch
        from hermes_fleet_linear_plugin import bridge as bridge_module
        bridge = self.bridge()
        self.enqueue("default", "first")
        bridge.drain_ingress(self.inbox)
        first = bridge_module._ingress_local.connection[1]
        self.inbox.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(self.inbox) + suffix).unlink(missing_ok=True)
        self.producer = IngressStore(self.inbox)
        self.enqueue("default", "after-replace")
        bridge.drain_ingress(self.inbox)
        self.assertEqual(self.statuses(), {"after-replace": "imported"})
        second = bridge_module._ingress_local.connection[1]
        self.assertIsNot(first, second)
        with self.assertRaises(sqlite3.ProgrammingError):
            first.execute("SELECT 1")  # the old file's connection was closed, not leaked
        self.enqueue("default", "later")
        with patch.object(bridge, "_stop_deliveries", side_effect=sqlite3.OperationalError("disk I/O error")):
            with self.assertRaises(sqlite3.OperationalError):
                bridge.drain_ingress(self.inbox)
        self.assertIsNone(bridge_module._ingress_local.connection)
        bridge.drain_ingress(self.inbox)
        self.assertEqual(self.statuses(), {"after-replace": "imported", "later": "imported"})

    def test_an_inbox_that_cannot_take_the_index_still_drains(self):
        from unittest.mock import patch
        from hermes_fleet_linear_plugin import bridge as bridge_module
        self.enqueue("default", "only")
        with patch.object(bridge_module, "INGRESS_PENDING_INDEX", "CREATE INDEX broken ON missing_table (x)"):
            self.bridge().drain_ingress(self.inbox)
        self.assertEqual(self.statuses(), {"only": "imported"})

    def test_cli_route_uses_explicit_ingress_or_native_profile_never_deployment_env(self):
        import os
        import sys
        from unittest.mock import patch
        plugin = load_plugin()
        for native in ('default', 'nested'):
            for configured in (None, 'worker-a'):
                values: dict[str, object] = {'enabled': True}
                if configured is not None:
                    values['ingress_profile'] = configured
                commands = {}
                context = SimpleNamespace(get_config=lambda key, default=None: values.get(key, default),
                    register_tool=lambda **kwargs: None, register_hook=lambda *args: None,
                    register_cli_command=lambda name, description, setup, handler: commands.update({name: handler}))
                with patch.dict(os.environ, {'HERMES_PROFILE': 'foreign-deployment', '_HERMES_GATEWAY': ''}), \
                     patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: self.home),
                        'hermes_cli.profiles': SimpleNamespace(get_active_profile_name=lambda: native)}), \
                     patch.object(plugin.ops, 'run', return_value=0) as run:
                    plugin.register(context)
                    commands['linear'](SimpleNamespace())
                    self.assertEqual(run.call_args.args[3], configured or native)

    def test_registered_service_forwards_explicit_binding_to_bridge(self):
        import asyncio
        from unittest.mock import patch
        plugin = load_plugin()
        captured = {}
        values = {"enabled": True, "identity": {"viewer_id": "app-a", "organization_id": "org-a"},
                  "ingress_profile": "worker-a"}
        context = SimpleNamespace(get_config=lambda key, default=None: values.get(key, default),
                                  register_tool=lambda **kwargs: None, register_hook=lambda *args: None,
                                  register_cli_command=lambda *args: None)
        class Captured(Exception): pass
        def capture(*args, **kwargs):
            captured.update(kwargs)
            raise Captured()
        async def run():
            runtime = SimpleNamespace(profile_home=self.home, profile_name="default", stop_event=asyncio.Event())
            with patch.object(plugin.BoundLinearAPI, "viewer_id", return_value="app-a"), \
                    patch.object(plugin, "token_provider", return_value=lambda: "synthetic"), \
                    patch.object(plugin, "Store"), patch.object(plugin, "Kanban"), \
                    patch.object(plugin, "Bridge", side_effect=capture), \
                    patch.dict(__import__("sys").modules, {"hermes_cli.profiles": SimpleNamespace(get_active_profile_name=lambda: "default")}):
                with self.assertRaises(Captured):
                    await asyncio.wait_for(plugin._reporting_loop(context, self.home, __import__("threading").Event(), {}), 5)
        asyncio.run(run())
        self.assertEqual(captured["settings"].get("ingress_profile"), "worker-a")
        self.assertIsNotNone(captured["profile"])

    def test_invalid_binding_refuses_service_before_credentials_or_state_admission(self):
        import asyncio
        from unittest.mock import Mock, patch
        from hermes_fleet_linear_plugin import transport
        plugin = load_plugin()
        for invalid in ("", " worker-a", "../worker-a", [], False, 123):
            with self.subTest(value=invalid):
                services = {}
                values = {"enabled": True, "identity": {"viewer_id": "app-a", "organization_id": "org-a"},
                          "ingress_profile": invalid}
                context = SimpleNamespace(get_config=lambda key, default=None: values.get(key, default),
                                          register_tool=lambda **kwargs: None, register_hook=lambda *args: None,
                                          register_cli_command=lambda *args: None)
                async def run():
                    stop = asyncio.Event()
                    runtime = SimpleNamespace(profile_home=self.home, profile_name="default", stop_event=stop)
                    api = SimpleNamespace(viewer_id=lambda: "app-a", clock=lambda: 0, paused_until=0)
                    def admit(*args, **kwargs):
                        stop.set()
                        return Mock()
                    with patch.object(plugin, "BoundLinearAPI", return_value=api) as api_factory, \
                            patch.object(plugin, "token_provider") as credentials, \
                            patch.object(plugin, "Store") as store, patch.object(plugin, "Kanban"), \
                            patch.object(plugin, "Bridge", side_effect=admit), patch.object(transport, "Server"):
                        with self.assertRaisesRegex(ValueError, "ingress_profile"):
                            await asyncio.wait_for(plugin._reporting_loop(context, self.home, __import__("threading").Event(), {}), 5)
                        api_factory.assert_not_called()
                        credentials.assert_not_called()
                        store.assert_not_called()
                asyncio.run(run())
