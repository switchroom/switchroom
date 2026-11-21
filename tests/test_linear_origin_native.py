"""Mounted origin evidence against the pinned native owner/receipts, without a model or live account."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import asdict, replace
import inspect
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from linear_fake_api import load_plugin
from linear_native_db import NativeDb

SOURCE = os.environ.get("HERMES_AGENT_SRC")
GUARDED_ROOT = os.environ.get("HERMES_LINEAR_ORIGIN_TEST_ROOT")
if SOURCE and GUARDED_ROOT:
    sys.path.insert(0, SOURCE)
plugin = load_plugin()
from hermes_fleet_linear_plugin import origin, transport, work, cleanup


@unittest.skipUnless(SOURCE and GUARDED_ROOT, "requires the guarded manifest-pinned origin proof entrypoint")
class OriginScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        guard_root = os.environ.get("HERMES_LINEAR_ORIGIN_TEST_ROOT")
        if not guard_root:
            raise RuntimeError("Use scripts/run-linear-origin-scenarios.py; native imports require the audited isolation guard")
        self.temp = tempfile.TemporaryDirectory(dir=guard_root)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        isolated = {"PATH": os.defpath, "HOME": str(self.home), "USERPROFILE": str(self.home),
                    "HERMES_HOME": str(self.home), "HERMES_PROFILE": "default",
                    "XDG_CONFIG_HOME": str(self.home / "xdg-config"), "XDG_CACHE_HOME": str(self.home / "xdg-cache"),
                    "CLAUDE_CONFIG_DIR": str(self.home / ".claude"), "GH_CONFIG_DIR": str(self.home / ".config/gh"),
                    "HERMES_AGENT_SRC": SOURCE, "HERMES_LINEAR_ORIGIN_TEST_ROOT": guard_root}
        self.env = patch.dict(os.environ, isolated, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        (self.home / "config.yaml").write_text("model:\n  default: fixture\nplatform_toolsets:\n  cli: []\n  desktop: []\n")
        from gateway.config import GatewayConfig
        from gateway.session import SessionStore
        from gateway.session_authority import initialize_session_authority
        from gateway.session_controls import AuthorityConnection
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from gateway.session_context import reset_session_vars
        self.assertTrue(Path(inspect.getfile(AuthorityConnection)).resolve().is_relative_to(Path(SOURCE).resolve()))
        token = set_hermes_home_override(self.home)
        self.addCleanup(reset_hermes_home_override, token)
        reset_session_vars()
        self.addCleanup(reset_session_vars)
        self.settings = {"identity": {"organization_id": "workspace", "teams": ["team"]},
                         "specialist_scope": {"allowed_team_ids": ["team"], "allowed_project_ids": ["project"],
                                              "allowed_requester_ids": ["requester"]}}
        self.config = {"model": {"default": "fixture"}, "platform_toolsets": {"cli": [], "desktop": []}}
        self.store = SessionStore(self.home / "sessions", GatewayConfig())
        persistence = self.store._scoped_persistence()
        self.addCleanup(persistence.close)
        self.db = NativeDb(persistence, self.home)
        self.addCleanup(self.db.close)
        self.runner = SimpleNamespace(session_store=self.store, _session_db=persistence, adapters={},
                                      _draining=False, config=GatewayConfig(), _cached_agent_for=lambda key: None,
                                      _peek_session_state=lambda key: None, _primary_profile_name="default")
        self.runner._adapter_for_source = lambda source: self.runner.adapters.get(source.platform)
        self.runner._adapter_flag = lambda *args: False
        self.runner._adapter_profile_for_source = lambda source: None
        self.runner._is_user_authorized_for_source = lambda *args, **kwargs: True
        self.authority = await initialize_session_authority(self.runner, profile_id=str(self.home), instance_id="fixture")
        self.authority._schedule = lambda ref: None
        self.conn = AuthorityConnection(self.authority, SimpleNamespace(write=lambda frame: None), {
            "provider": "local", "user_id": "uid:1000", "profile_id": str(self.home), "instance_id": "fixture",
            "native_bootstrap": True,
            "capabilities": ["session:create", "session:read", "session:submit", "session:control"]}, operator=True)
        self.addAsyncCleanup(self.conn.close)
        self.loop = asyncio.get_running_loop()
        self.origin_context = ContextVar("linear_origin_test_context", default=None)
        self.origin_context.set("native-turn-context")
        self.calls = []
        self.before_rpc = None
        # Owner calls the code under test may make. Inspection reads receipts only; a scenario
        # that exercises a native control (the handover's lost-attempt Discard) widens this itself.
        self.owner_methods = frozenset({"prompt.receipt"})

        async def rpc(method, **params):
            async def on_owner():
                self.assertIn(method, self.owner_methods, "origin inspection must never attach or compute runtime inventory")
                self.calls.append((method, params))
                if self.before_rpc:
                    self.before_rpc(method, params)
                result = await self.conn.dispatch({"id": len(self.calls), "method": method, "params": params})
                if "error" in result:
                    raise RuntimeError(result["error"]["message"])
                return result["result"]
            if asyncio.get_running_loop() is self.loop:
                return await on_owner()
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(on_owner(), self.loop))

        @asynccontextmanager
        async def client(home):
            self.assertEqual(home, self.home)
            self.assertEqual(self.origin_context.get(), "native-turn-context")
            yield SimpleNamespace(rpc=rpc), SimpleNamespace(instance_id=self.authority.instance_id,
                                                            authority_epoch=self.authority.epoch)
        patcher = patch.object(origin, "_client", client)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def local(self, text="Take over ABC-1", *, source="gui", extra=None, work_context=None, intent="queue"):
        from gateway.config import Platform
        from gateway.session import SessionEntry, SessionSource
        from gateway.session_contract import SessionRef
        from gateway.session_lifecycle import _now
        from gateway.session_policy import LocalSessionPolicy, SURFACES
        from linear_native_db import commit_local_session
        from linear_native_db import local_identity
        from linear_native_db import admit_session_input
        # Build synthetic fixture policy through the native immutable type/atomic writer.
        # The launch planner also initializes profile credentials; no launch occurs in this proof.
        request_id = ("kanban:" + json.dumps([work_context[k] for k in ("board", "task_id", "run_id")], separators=(",", ":"))
                      if work_context else "origin-local-" + str(len(self.authority.sessions)))
        self.sid = local_identity(str(self.home), self.conn.actor.subject, request_id)
        request = {"source": source, "model": "fixture", "cwd": str(self.home), "toolsets": []}
        if work_context:
            request.update({k: work_context[k] for k in ("board", "task_id", "run_id")})
        policy = LocalSessionPolicy(source=source, platform=SURFACES.get(source, "cli"), cwd=str(self.home), model="fixture",
            toolsets=(), config_json=json.dumps(self.config), request_json=json.dumps(request),
            terminal_json=json.dumps({"TERMINAL_ENV": "local", "TERMINAL_CWD": str(self.home)}),
            safe_mode=True, ignore_user_config=True, kanban_json=json.dumps(work_context) if work_context else None)
        native_source = SessionSource(platform=Platform.LOCAL, chat_id=self.sid,
                                      user_id=self.conn.actor.subject, chat_type="dm")
        route = self.store._generate_session_key(native_source)
        entry = SessionEntry(route, self.sid, _now(), _now(), origin=native_source, platform=Platform.LOCAL)
        commit_local_session(self.db, epoch=self.authority.epoch, receipt={
            "profile_id": str(self.home), "principal_id": self.conn.actor.subject, "request_id": request_id,
            "session_id": self.sid, "route": route, "entry": entry.to_dict(), "policy": asdict(policy)})
        self.ref = self.authority._publish_route(native_source, self.sid, route)
        payload = {"text": text}
        if extra:
            from gateway.session_cli_turn import admit_cli_turn
            payload.update(admit_cli_turn(extra))
        if work_context:
            payload["kanban_card_v1"] = {k: work_context[k] for k in ("board", "task_id", "run_id")}
        row = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid,
            request_id=request_id if work_context else "request-1", payload=payload, intent=intent)
        self.admission = row["admission_id"]
        self.claim()
        self.bind("local", self.sid)
        if work_context:
            self.bind("local", self.sid, source="kanban")

    def claim(self):
        from linear_native_db import claim_session_input
        self.row = claim_session_input(self.db, epoch=self.authority.epoch, session_id=self.sid)
        self.authority.executing[self.sid] = self.row["generation"]

    def bind(self, platform, sid, *, source=None, key=None, user="uid:1000", chat="", thread="", scope=""):
        from gateway.session_context import set_session_vars
        set_session_vars(platform=platform, source=source or platform, session_key=key or self.authority.sessions[self.sid].route,
                         session_id=sid, user_id=user, user_id_alt="", chat_id=chat, chat_type="dm", thread_id=thread,
                         scope_id=scope, profile="default", ui_session_id="tab")

    async def messaging(self, platform):
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.platforms.event import MessageEvent
        from gateway.session_contract import SessionRef
        source = SessionSource(platform=Platform(platform), chat_id="chat", user_id="human", chat_type="dm",
                               thread_id="thread", scope_id="scope")
        self.runner.adapters[source.platform] = SimpleNamespace()
        event = MessageEvent(text="Take over ABC-1", message_id="message-1", source=source)
        receipt = await self.authority.admit_native(event)
        self.sid, self.admission, self.ref = receipt.ref.session_id, receipt.admission_id, receipt.ref
        self.claim()
        self.bind(platform, self.sid, user="human", chat="chat", thread="thread", scope="scope")

    async def api(self, *, session_id="api-session", request_id="api-request"):
        from gateway.session_api import bind_api_session
        from gateway.session_contract import SessionRef
        from linear_native_db import admit_session_input
        self.sid = session_id
        self.ref = bind_api_session(self.authority, self.sid)
        payload = {"text": "Take over ABC-1", "api_turn_v1": {"history": None, "settings": {},
            "transfer_auth": {"principal": "principal:fixture:" + "a" * 32, "transport_family": "local-api"}}}
        row = admit_session_input(self.db, epoch=self.authority.epoch, principal_id="api",
                                  session_id=self.sid, request_id=request_id, payload=payload)
        self.admission = row["admission_id"]
        self.claim()
        self.bind("api_server", self.sid, user="api_server")

    async def desktop(self):
        """A Desktop chat from main after the supported owner adoption (Agent #196).

        Adoption commits a native local receipt with Desktop's ``gui`` policy while the stored row
        keeps its ``desktop`` label; its turns bind ``source=desktop`` and the conversation as chat.
        (Adoption itself loads the gateway model bootstrap, which this proof forbids importing.)"""
        await self.local(source="gui")
        self.db._execute_write(lambda c: c.execute("UPDATE sessions SET source='desktop' WHERE id=?", (self.sid,)))
        self.bind("local", self.sid, source="desktop", chat=self.sid)

    async def current(self):
        context = transport.capture_context()
        return await asyncio.to_thread(origin.current, context, self.settings)

    async def inspected(self, ref):
        return await asyncio.to_thread(origin.inspect, ref, self.settings)

    async def async_registered_tool(self, action, *, expect_refusal=False, **selectors):
        """The native tool_call bridge on a provider loop, off the owner RPC loop."""
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from tools.registry import registry
        from model_tools import handle_function_call
        if not hasattr(self, "tool_manager"):
            configured = {**self.config, "plugins": {"entries": {"linear": {
                "settings": {"enabled": True, **self.settings}}}}}
            (self.home / "config.yaml").write_text(json.dumps(configured))
            self.tool_manager = PluginManager(scope_key=str(self.home))
            context = PluginContext(PluginManifest(name="linear", source="user",
                path=str(Path(plugin.__file__).parent)), self.tool_manager)
            plugin.register(context)
            self.addCleanup(self.tool_manager.unload)
            self.assertIsNotNone(registry.get_entry("linear", scope=str(self.home)))

        async def provider_callback():
            self.assertIsNot(asyncio.get_running_loop(), self.loop)
            result = handle_function_call("tool_call", {"calls": [{"name": "linear", "arguments": {
                "action": action, **selectors}}]}, enabled_tools=["linear"], enabled_toolsets=["linear"],
                session_id=self.sid)
            result = json.loads(result)
            if expect_refusal:
                self.assertTrue(result.get("error") or result.get("ok") is False, result)
            else:
                self.assertIn("ok", result, result)  # The registered plugin must actually run.
            return result

        # Native conversation execution is off the owner loop; provider SDK callbacks
        # can run a separate asyncio loop there. The real owner dispatch below must
        # still answer the inspection's prompt.receipt requests during this call.
        return await asyncio.wait_for(asyncio.to_thread(lambda: asyncio.run(provider_callback())), 15)

    async def test_registered_origin_tool_on_async_provider_loop_keeps_owner_responsive(self):
        await self.local()
        result = await self.async_registered_tool("origin_reference")
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["permission_granted"])
        ref = result["reference"]
        self.assertEqual(ref["admission_id"], self.admission)
        self.assertEqual(ref["profile"], "default")
        self.assertEqual(ref["scope_digest"], origin._digest(origin.scope(self.settings)))
        self.assertGreaterEqual(len(self.calls), 2)
        inspected = await self.inspected(ref)
        self.assertEqual(inspected["policy"]["source"], "gui")
        self.assertEqual(inspected["scope"], origin.scope(self.settings))

    async def test_registered_work_tool_on_async_provider_loop_keeps_owner_responsive(self):
        await self.kanban()
        result = await self.async_registered_tool("work_reference")
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["permission_granted"])
        ref = result["reference"]
        self.assertEqual(ref["admission_id"], self.admission)
        self.assertEqual(ref["profile"], "default")
        self.assertEqual(ref["scope_digest"], origin._digest(origin.scope(self.settings)))
        self.assertGreaterEqual(len(self.calls), 2)
        inspected = await self.work_inspected(ref)
        self.assertFalse(inspected["permission_granted"])
        self.assertEqual(inspected["requester"]["original_requester"], "unknown")

    async def test_registered_evidence_tools_on_async_provider_loop_refuse_selectors(self):
        await self.local()
        for action in ("origin_reference", "work_reference"):
            for selector in ("profile", "session_id", "home", "task_id", "issue"):
                with self.subTest(action=action, selector=selector):
                    result = await self.async_registered_tool(action, expect_refusal=True,
                                                              **{selector: "forged"})
                    self.assertFalse(result.get("ok", False))
        self.assertEqual(self.calls, [])

    async def test_registered_origin_tool_on_async_provider_loop_refuses_settled_admission(self):
        from linear_native_db import settle_session_input
        await self.local()
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="completed")
        result = await self.async_registered_tool("origin_reference")
        self.assertFalse(result["ok"])
        self.assertNotIn("reference", result)

    async def test_registered_evidence_tools_on_async_provider_loop_preserve_pending_stop(self):
        from gateway import session_ancillary
        for action in ("origin_reference", "work_reference"):
            with self.subTest(action=action):
                if action == "origin_reference":
                    await self.local()
                else:
                    await self.kanban()
                session_ancillary.record_process_stop(self.authority, self.ref, self.row["generation"])
                result = await self.async_registered_tool(action)
                self.assertFalse(result["ok"])
                self.assertNotIn("reference", result)
                self.assertIsNotNone(session_ancillary.process_stop_pending(self.db, self.sid))

    def during_origin_readback(self, change):
        """Run a finite fixture writer during the second actual owner receipt."""
        count = 0
        def arriving(_method, _params):
            nonlocal count
            count += 1
            if count == 2:
                change()
        self.before_rpc = arriving

    def retained_origin_payload(self, change):
        """Explicit retained-row fault, not a supported mutation of immutable input."""
        payload = json.loads(self.db._read_one(
            "SELECT payload_json FROM session_admissions WHERE admission_id=?", (self.admission,))[0])
        change(payload)
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))

    async def test_origin_readback_rechecks_native_messaging_workspace(self):
        for platform in ("telegram", "slack"):
            with self.subTest(platform=platform):
                await self.messaging(platform)
                before, after = str(self.home / "before"), str(self.home / "after")
                self.db.update_session_cwd(self.sid, before)
                ref = (await self.current())["reference"]
                self.during_origin_readback(lambda: self.db.update_session_cwd(self.sid, after))
                with self.assertRaises(transport.Unavailable):
                    await self.inspected(ref)
                self.assertEqual(self.db.get_session(self.sid)["cwd"], after)
                self.before_rpc = None
                evidence = await self.inspected(ref)
                self.assertEqual(evidence["policy"]["cwd"], after)
                self.assertFalse(evidence["permission_granted"])

    async def test_origin_readback_rechecks_retained_text_and_requester(self):
        for field in ("text", "requester"):
            with self.subTest(field=field):
                await self.api(session_id="api-" + field, request_id="request-" + field)
                ref = (await self.current())["reference"]
                def change(payload):
                    if field == "text":
                        payload["text"] = "Different exact original instruction"
                    else:
                        payload["api_turn_v1"]["transfer_auth"]["principal"] = "principal:fixture:" + "b" * 32
                self.during_origin_readback(lambda: self.retained_origin_payload(change))
                with self.assertRaises(transport.Unavailable):
                    await self.inspected(ref)
                self.before_rpc = None
                evidence = await self.inspected(ref)
                self.assertEqual(evidence["original_message"] if field == "text" else evidence["requester"]["principal"],
                    "Different exact original instruction" if field == "text" else "principal:fixture:" + "b" * 32)
                self.assertFalse(evidence["permission_granted"])

    async def test_origin_readback_rechecks_consumed_local_policy(self):
        from linear_native_db import POLICY_PREFIX, local_receipt
        from gateway.session_policy import restore_policy
        await self.local()
        ref = (await self.current())["reference"]
        def change():
            # Explicit fault in the otherwise immutable native creation receipt;
            # the actual native decoder must project its new workspace/tool policy.
            receipt = local_receipt(self.db, self.sid)
            receipt["policy"]["cwd"] = str(self.home / "different workspace")
            for field, key in (("terminal_json", "TERMINAL_CWD"), ("request_json", "cwd")):
                value = json.loads(receipt["policy"][field])
                value[key] = receipt["policy"]["cwd"]
                receipt["policy"][field] = json.dumps(value)
            self.assertEqual(restore_policy(receipt["policy"]).cwd, receipt["policy"]["cwd"])
            self.db.set_meta(POLICY_PREFIX + self.sid, json.dumps(receipt))
        self.during_origin_readback(change)
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)
        self.before_rpc = None
        evidence = await self.inspected(ref)
        self.assertEqual(evidence["policy"]["cwd"], str(self.home / "different workspace"))
        self.assertFalse(evidence["permission_granted"])

    async def test_origin_readback_rechecks_current_stop_checkpoint(self):
        from gateway import session_ancillary
        await self.messaging("telegram")
        ref = (await self.current())["reference"]
        supported = callable(getattr(session_ancillary, "process_stop_pending", None))
        key = "fixture.pending.stop." + self.sid
        # Pinned fae lacks the optional getter. Its adapter reads real native meta;
        # compatibility Core exercises the actual native checkpoint writer/getter.
        adapter = patch.object(session_ancillary, "process_stop_pending",
            lambda db, sid: db.state_meta.get("fixture.pending.stop." + sid), create=True)
        if not supported:
            adapter.start()
            self.addCleanup(adapter.stop)
        def stop():
            if supported:
                session_ancillary.record_process_stop(self.authority, self.ref, self.row["generation"])
            else:
                self.db.set_meta(key, "pending")
        self.during_origin_readback(stop)
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)
        self.assertIsNotNone(session_ancillary.process_stop_pending(self.db, self.sid))

    async def test_origin_readback_preserves_native_text_and_decoded_policy(self):
        await self.messaging("telegram")
        cwd = " workspace with spaces/\u00e9:unchanged "
        self.db.update_session_cwd(self.sid, cwd)
        ref = (await self.current())["reference"]
        # A native writer running with the exact same value is not a changed
        # projection; do not add path grammar or normalize native TEXT.
        self.during_origin_readback(lambda: self.db.update_session_cwd(self.sid, cwd))
        evidence = await self.inspected(ref)
        self.assertEqual(evidence["policy"]["cwd"], cwd)
        self.assertFalse(evidence["permission_granted"])

    async def kanban(self, *, existing=False, idempotency_key=None, intent="queue", claimer="fixture-host:CLAIM_PRIVATE_SENTINEL"):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_connect import _sqlite_connect
        if not existing:
            from agent import runtime_session_store
            # Synthetic successful-adoption process marker: no owner bootstrap or model.
            worker = patch.object(runtime_session_store, "_worker_process", True)
            worker.start()
            self.addCleanup(worker.stop)
            self.board_path = self.home / "kanban.db"
            kb.init_db(self.board_path)
            self.board = _sqlite_connect(self.board_path)
            self.board.row_factory = __import__("sqlite3").Row
            self.addCleanup(self.board.close)
            self.task_id = kb.create_task(self.board, title="Take over ABC-1", body="Finish the remaining checks",
                assignee="default", created_by="fixture-agent", tenant="tenant", workspace_kind="dir",
                workspace_path=str(self.home), skills=[], idempotency_key=idempotency_key)
        task = kb.claim_task(self.board, self.task_id, claimer=claimer)
        self.assertIsNotNone(task)
        self.work_context = {"board": "default", "db": str(self.board_path), "task_id": task.id,
            "run_id": task.current_run_id, "claim_lock": task.claim_lock, "profile": "default",
            "workspace": task.workspace_path, "branch": task.branch_name, "tenant": task.tenant,
            "workspaces_root": str(self.home), "skills": [], "goal_mode": task.goal_mode,
            "goal_max_turns": task.goal_max_turns, "goal_text": task.title + "\n\n" + task.body,
            "context": "UNRELATED_FROZEN_CONTEXT", "max_runtime_seconds": task.max_runtime_seconds, "accept_hooks": True}
        await self.local("work kanban task " + task.id, source="kanban", work_context=self.work_context, intent=intent)
        # Actual managed Kanban workers bind the AIAgent/compression session ID but no chat
        # platform/source/key. Exercise precisely that supported binder, with no env identity.
        from gateway.session_context import reset_session_vars, set_current_session_id
        reset_session_vars()
        set_current_session_id(self.sid)
        import psutil
        from hermes_cli.process_identity import worker_birth
        with kb.write_txn(self.board):
            kb._append_event(self.board, task.id, "owner_admitted", {"db": str(self.home / "state.db"),
                "session_id": self.sid, "request_id": self.row["request_id"], "pid": os.getpid(),
                "birth": worker_birth(psutil.Process())},
                run_id=task.current_run_id)
            kb._append_event(self.board, task.id, "worker_bound", {"pid": os.getpid(), "claim_lock": task.claim_lock},
                run_id=task.current_run_id)

    async def work_current(self):
        return await asyncio.to_thread(work.current, work.capture_context(), self.settings)

    async def work_inspected(self, ref):
        return await asyncio.to_thread(work.inspect, ref, self.settings)

    async def test_delegated_worker_progress_reads_actual_owner_frames_without_replay_or_attachment(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin import worker_progress
        await self.kanban()
        task = kb.get_task(self.board, self.task_id)
        events = [kb.Event.from_row(row) for row in self.board.execute(
            "SELECT * FROM task_events WHERE task_id=? ORDER BY id", (task.id,))]
        adapter = SimpleNamespace(profile_home=self.home, board="default", history=lambda *args: events)
        self.owner_methods = frozenset({"prompt.receipt", "session.info"})
        generation = self.row["generation"]
        self.authority.publish_execution(self.sid, generation, "tool.start", {
            "tool_id": "held-command", "name": "terminal", "args": {"command": "SECRET_ARGUMENT_SENTINEL"}})
        step = await asyncio.to_thread(worker_progress.current, adapter, task)
        try:
            from gateway.session_execution_progress import execution_progress
        except ImportError:
            self.assertIsNone(step, "Old Core refuses the optional execution-only projection")
            return
        self.assertIsNotNone(step)
        self.assertEqual(step["worker_session_id"], self.sid)
        self.assertEqual(step["run_id"], task.current_run_id)
        self.assertEqual(step["execution_generation"], generation)
        self.assertEqual(step["phrase"], "in the terminal")
        self.assertNotIn("SECRET_ARGUMENT_SENTINEL", json.dumps(step))
        self.assertTrue(any(method == "session.info" and fields.get("execution_only") is True
                            for method, fields in self.calls))
        self.assertEqual(set(method for method, _ in self.calls), {"prompt.receipt", "session.info"})
        # Finishing the real call clears the safe projection while the same
        # delegated execution and Kanban attempt remain running.
        self.authority.publish_execution(self.sid, generation, "tool.complete", {"tool_id": "held-command"})
        self.assertIsNone(await asyncio.to_thread(worker_progress.current, adapter, task))
        self.assertEqual(kb.get_task(self.board, task.id).status, "running")
        self.assertIsNone(execution_progress(self.authority, self.ref))

    async def test_delegated_worker_progress_refuses_wrong_attempt_before_owner_rpc(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin import worker_progress
        await self.kanban()
        task = kb.get_task(self.board, self.task_id)
        events = [kb.Event.from_row(row) for row in self.board.execute(
            "SELECT * FROM task_events WHERE task_id=? ORDER BY id", (task.id,))]
        adapter = SimpleNamespace(profile_home=self.home, board="default", history=lambda *args: events)
        task.current_run_id += 1
        self.assertIsNone(await asyncio.to_thread(worker_progress.current, adapter, task))
        self.assertEqual(self.calls, [])

    async def test_delegated_worker_progress_cannot_borrow_later_unrelated_admission(self):
        from hermes_cli import kanban_db as kb
        from linear_native_db import settle_session_input, admit_session_input
        from hermes_fleet_linear_plugin import worker_progress
        await self.kanban()
        task = kb.get_task(self.board, self.task_id)
        events = [kb.Event.from_row(row) for row in self.board.execute(
            "SELECT * FROM task_events WHERE task_id=? ORDER BY id", (task.id,))]
        adapter = SimpleNamespace(profile_home=self.home, board="default", history=lambda *args: events)
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
            generation=self.row["generation"], outcome="completed")
        admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="unrelated-later-input",
            payload={"text": "An unrelated local conversation"}, intent="queue")
        self.claim()
        self.assertIsNone(await asyncio.to_thread(worker_progress.current, adapter, task))
        self.assertTrue(self.calls)
        self.assertEqual(set(method for method, _ in self.calls), {"prompt.receipt"})

    def process_witness(self, start):
        from gateway.drain_control import current_instantiation_epoch
        return f"{current_instantiation_epoch()}|{start}"

    def original_worker_birth(self, birth):
        # Finite PID-reuse fixture: preserve the exact native admission/run
        # coordinates while supplying a known earlier native monotonic birth.
        event = self.board.execute("SELECT id,payload FROM task_events WHERE task_id=? AND run_id=? AND kind='owner_admitted'",
                                   (self.task_id, self.work_context["run_id"])).fetchone()
        marker = json.loads(event["payload"])
        marker["birth"] = birth
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(marker), event["id"]))

    def earlier_native_birth(self):
        import psutil
        from hermes_cli.process_identity import worker_birth
        # Native PID 1 supplies an actual earlier boot-relative sample; no
        # process launch, fabricated units or live ownership change occurs.
        old = worker_birth(psutil.Process(1))
        self.assertLess(old, worker_birth(psutil.Process()))
        return old

    async def stopped_issue(self, *, existing=False, idempotency_key=None, review_stop=False,
                            claimer="fixture-host:CLAIM_PRIVATE_SENTINEL"):
        from hermes_cli import kanban_db as kb
        from linear_native_db import (register_worker_execution, adopt_worker_execution,
            mutate_worker_execution, settle_session_input)
        from hermes_fleet_linear_plugin.store import Store
        from gateway import session_ancillary
        await self.kanban(existing=existing, idempotency_key=idempotency_key, claimer=claimer)
        # Finite native state fixtures: real register/adopt/finish and admission settlement;
        # no actual model, process launch, owner bootstrap or production Stop.
        executor = "admission-worker:" + self.admission
        args = dict(epoch=self.authority.epoch, execution_id=executor, session_id=self.sid,
                    generation=self.row["generation"])
        register_worker_execution(self.db, **args, kind="compute", adoption_secret="fixture-adoption-private")
        adopt_worker_execution(self.db, **args, adoption_secret="fixture-adoption-private")
        mutate_worker_execution(self.db, **args, sequence=1, operation="execution.finish", payload={})
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        with kb.write_txn(self.board):
            self.board.execute("UPDATE task_events SET payload=? WHERE kind='worker_bound' AND task_id=?",
                (json.dumps({"pid": 99999998, "started_at": self.process_witness(1), "claim_lock": self.work_context["claim_lock"]}), self.task_id))
            kb._append_event(self.board, self.task_id, "spawned", {"pid": 99999999, "started_at": self.process_witness(2)},
                             run_id=self.work_context["run_id"])
            self.board.execute("UPDATE task_runs SET worker_pid=99999999,worker_started_at=? WHERE id=?",
                               (self.process_witness(2), self.work_context["run_id"]))
        if review_stop:
            self.assertTrue(kb.request_review(self.board, self.task_id, summary="fixture review",
                                             expected_run_id=self.work_context["run_id"]))
            if review_stop == "ready":
                self.assertTrue(kb.reopen_review_task(self.board, self.task_id))
            else:
                self.assertTrue(kb.assign_task(self.board, self.task_id, None))
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="fixture Stop"))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        if review_stop:
            self.assertTrue(kb.assign_task(self.board, self.task_id, "default"))
        self.linear_state = self.home / "linear" / "state.db"
        self.linear_store = Store(self.linear_state)
        self.assertTrue(self.linear_store.bind_native("issue-one", self.task_id, "default", "default", at=1))
        # Optional corrective-core getter adapter, explicitly synthetic on pinned fae; it
        # executes a real native read-only meta lookup, not an unconditional success stub.
        getter = patch.object(session_ancillary, "process_stop_pending",
            lambda db, sid: db.state_meta.get("fixture.pending.stop." + sid), create=True)
        getter.start()
        self.addCleanup(getter.stop)

    async def cleanup_inspected(self, *, stop_id=None, metadata=None, ingress=None):
        from agent import runtime_session_store
        with patch.object(runtime_session_store, "_worker_process", False):
            return await asyncio.to_thread(cleanup.inspect, self.linear_state, "issue-one", "default",
                                           self.stop_id if stop_id is None else stop_id, self.settings, metadata, ingress=ingress)

    async def triage_cleanup_issue(self, *, control_only=False, settle_admission=True):
        """Reach the recurrence fence with real native writers in the guarded fixture."""
        from hermes_cli import kanban_db as kb
        from linear_native_db import (register_worker_execution, adopt_worker_execution,
            mutate_worker_execution, settle_session_input)
        await self.stopped_issue()
        self.first_stop_id = self.stop_id
        self.assertTrue(kb.unblock_task(self.board, self.task_id, expected_event_id=self.stop_id))
        if not control_only:
            await self.kanban(existing=True)
            args = dict(epoch=self.authority.epoch, execution_id="admission-worker:" + self.admission,
                        session_id=self.sid, generation=self.row["generation"])
            register_worker_execution(self.db, **args, kind="compute", adoption_secret="fixture-loop-adoption")
            adopt_worker_execution(self.db, **args, adoption_secret="fixture-loop-adoption")
            mutate_worker_execution(self.db, **args, sequence=1, operation="execution.finish", payload={})
            if settle_admission:
                settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                                     generation=self.row["generation"], outcome="interrupted")
            with kb.write_txn(self.board):
                # Preserve the first attempt's claim and every retained worker.
                self.board.execute("UPDATE task_events SET payload=? WHERE kind='worker_bound' AND run_id=?",
                    (json.dumps({"pid": 99999998, "started_at": self.process_witness(1),
                                 "claim_lock": self.work_context["claim_lock"]}), self.work_context["run_id"]))
                kb._append_event(self.board, self.task_id, "spawned",
                                 {"pid": 99999999, "started_at": self.process_witness(2)},
                                 run_id=self.work_context["run_id"])
                self.board.execute("UPDATE task_runs SET worker_pid=99999999,worker_started_at=? WHERE id=?",
                                   (self.process_witness(2), self.work_context["run_id"]))
        latest = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="fixture recurring pause",
                                     expected_event_id=latest,
                                     expected_run_id=None if control_only else self.work_context["run_id"]))
        event = kb.list_events(self.board, self.task_id)[-1]
        self.stop_id = event.id
        self.assertEqual(event.kind, "block_loop_detected")
        task = kb.get_task(self.board, self.task_id)
        self.assertEqual((task.status, task.block_kind, task.block_recurrences),
                         ("triage", "needs_input", kb.BLOCK_RECURRENCE_LIMIT))
        return event

    async def test_cleanup_triage_admitted_native_loop_uses_pause_anchor_without_writes(self):
        from hermes_cli import kanban_db as kb
        loop = await self.triage_cleanup_issue()
        with kb.write_txn(self.board):
            kb._append_event(self.board, self.task_id, "worker_result",
                {"pid": 99999998, "claim_lock": self.work_context["claim_lock"], "exit_code": 130,
                 "last_output": "Finite interrupted fixture"}, run_id=loop.run_id)
        result_id = kb.list_events(self.board, self.task_id)[-1].id
        before = {table: [tuple(row) for row in self.board.execute("SELECT * FROM " + table)]
                  for table in ("tasks", "task_runs", "task_events")}
        admissions = self.db._read_all("SELECT * FROM session_admissions")
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertFalse(evidence["permission_granted"])
        self.assertEqual((evidence["stop_event_id"], evidence["latest_event_id"]), (loop.id, result_id))
        self.assertEqual(len(evidence["attempts"]), 2)
        self.assertEqual(evidence["control_only_runs"], [])
        for selector in (self.first_stop_id, result_id):
            rejected = await self.cleanup_inspected(stop_id=selector)
            self.assertFalse(rejected["quiescence_proven"])
            self.assertFalse(rejected["permission_granted"])
        for table, rows in before.items():
            self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM " + table)], rows)
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), admissions)

    async def test_cleanup_triage_queued_loop_recognizes_only_strict_control_cohort(self):
        loop = await self.triage_cleanup_issue(control_only=True)
        control = self.board.execute("SELECT * FROM task_runs WHERE id=?", (loop.run_id,)).fetchone()
        self.assertEqual((control["status"], control["outcome"], control["claim_lock"]), ("blocked", "blocked", None))
        self.assertEqual(control["started_at"], control["ended_at"])
        self.assertEqual(self.board.execute("SELECT COUNT(*) FROM task_events WHERE run_id=?",
                                           (loop.run_id,)).fetchone()[0], 1)
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertFalse(evidence["permission_granted"])
        self.assertEqual(evidence["control_only_runs"], [loop.run_id])
        self.assertEqual(len(evidence["attempts"]), 1)
        for key, value in (("claim_lock", "unproved-claim"), ("worker_pid", 99999999),
                           ("profile", "foreign"), ("ended_at", control["ended_at"] + 1)):
            with self.subTest(field=key):
                self.board.execute(f"UPDATE task_runs SET {key}=? WHERE id=?", (value, loop.run_id))
                try:
                    held = await self.cleanup_inspected()
                    self.assertFalse(held["quiescence_proven"])
                    self.assertFalse(held["permission_granted"])
                finally:
                    self.board.execute(f"UPDATE task_runs SET {key}=? WHERE id=?", (control[key], loop.run_id))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_triage_loop_rejects_malformed_payload_and_counter_lookalikes(self):
        from hermes_cli import kanban_db as kb
        loop = await self.triage_cleanup_issue()
        original = json.dumps(loop.payload)
        payload = loop.payload
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        changes = ({key: value for key, value in payload.items() if key != "limit"},
                   {**payload, "unexpected": True}, {**payload, "kind": "dependency"},
                   {**payload, "source_status": "running"}, {**payload, "reason": ""},
                   {**payload, "recurrences": True}, {**payload, "recurrences": kb.BLOCK_RECURRENCE_LIMIT - 1},
                   {**payload, "recurrences": kb.BLOCK_RECURRENCE_LIMIT + 1},
                   {**payload, "limit": True}, {**payload, "limit": kb.BLOCK_RECURRENCE_LIMIT + 1})
        for changed in changes:
            with self.subTest(payload=changed):
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(changed), loop.id))
                try:
                    held = await self.cleanup_inspected()
                    self.assertFalse(held["quiescence_proven"])
                    self.assertFalse(held["permission_granted"])
                finally:
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (original, loop.id))
        self.board.execute("UPDATE tasks SET block_recurrences=? WHERE id=?",
                           (kb.BLOCK_RECURRENCE_LIMIT + 1, self.task_id))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_triage_manual_status_without_native_loop_anchor_is_unknown(self):
        await self.stopped_issue()
        self.board.execute("UPDATE tasks SET status='triage' WHERE id=?", (self.task_id,))
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertFalse(held["permission_granted"])

    async def test_cleanup_triage_loop_still_requires_canonical_admission_settlement(self):
        from linear_native_db import settle_session_input
        await self.triage_cleanup_issue(settle_admission=False)
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertFalse(held["permission_granted"])
        self.assertEqual(held["reason"], "native_admission_not_settled")
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_triage_loop_late_worker_binding_is_unknown(self):
        from hermes_cli import kanban_db as kb
        loop = await self.triage_cleanup_issue()
        with kb.write_txn(self.board):
            kb._append_event(self.board, self.task_id, "worker_registered",
                             {"pid": 99999997, "started_at": self.process_witness(3)}, run_id=loop.run_id)
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertFalse(held["permission_granted"])
        self.assertEqual(held["reason"], "late_worker_binding_after_stop")

    async def test_cleanup_triage_loop_rechecks_native_history_during_owner_receipt(self):
        from hermes_cli import kanban_db as kb
        loop = await self.triage_cleanup_issue()
        def arriving(_method, _params):
            self.before_rpc = None
            with kb.write_txn(self.board):
                kb._append_event(self.board, self.task_id, "worker_result",
                                 {"pid": 99999998, "claim_lock": self.work_context["claim_lock"], "exit_code": 130},
                                 run_id=loop.run_id)
        self.before_rpc = arriving
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertFalse(held["permission_granted"])
        self.assertEqual(held["reason"], "cleanup_evidence_changed")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    def reap_fixture_terminal_workers(self):
        from hermes_cli import kanban_db_dispatch as dispatcher
        import time
        def no_signal(_pid, _signal):
            raise AssertionError("source fixture must not signal any process")
        after_grace = int(time.time()) + dispatcher.TERMINAL_WORKER_REAP_GRACE_SECONDS + 1
        with patch.object(dispatcher.time, "time", return_value=after_grace):
            self.assertEqual(dispatcher.reap_terminal_workers(self.board, signal_fn=no_signal), [])

    async def test_cleanup_native_terminal_reaper_cleared_slots_still_requires_every_event_fate(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue(review_stop=True, claimer=kb._host_prefix() + "CLAIM_PRIVATE_SENTINEL")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        before = [tuple(row) for row in self.board.execute("SELECT * FROM task_events ORDER BY id")]
        self.reap_fixture_terminal_workers()
        run = self.board.execute("SELECT * FROM task_runs WHERE id=?", (self.work_context["run_id"],)).fetchone()
        self.assertEqual((run["worker_pid"], run["worker_started_at"]), (None, None))
        self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM task_events ORDER BY id")], before)
        result = await self.cleanup_inspected()
        self.assertTrue(result["quiescence_proven"], result)
        original = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind='spawned'",
                                      (self.task_id,)).fetchone()
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        live = {"pid": os.getpid(), "started_at": _process_fingerprint(os.getpid())}
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(live), original["id"]))
        result = await self.cleanup_inspected()
        self.assertFalse(result["quiescence_proven"])
        self.assertEqual(result["reason"], "old_worker_alive")
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (original["payload"], original["id"]))
        for pid, birth in ((99999999, None), (None, self.process_witness(2)), (99999997, self.process_witness(2))):
            self.board.execute("UPDATE task_runs SET worker_pid=?,worker_started_at=? WHERE id=?",
                               (pid, birth, run["id"]))
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_runs SET worker_pid=NULL,worker_started_at=NULL WHERE id=?", (run["id"],))
        self.board.execute("UPDATE task_events SET kind='unverified_submitter' WHERE id=?", (original["id"],))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_events SET kind='spawned' WHERE id=?", (original["id"],))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_host_namespace_disposition_keeps_fresh_native_stop_and_scope_checks(self):
        from gateway.drain_control import current_instantiation_epoch
        from test_linear_namespace_dispositions import receipt_fixture, root_metadata
        from linear_native_db import admit_session_input
        from hermes_cli import kanban_db as kb
        await self.stopped_issue(review_stop=True, claimer=kb._host_prefix() + "CLAIM_PRIVATE_SENTINEL")
        self.reap_fixture_terminal_workers()
        original_epoch = current_instantiation_epoch()
        boot, _, start = original_epoch.rpartition(":")
        changed_epoch = boot + ":" + str(int(start) + 1)
        ingress, leaf, receipt = receipt_fixture(self.home, original_epoch)
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=changed_epoch):
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
            # The real UID1000-created file has no host receipt authority.
            untrusted = await self.cleanup_inspected(ingress=ingress)
            self.assertFalse(untrusted["quiescence_proven"])
        actual_reader = cleanup._namespace_disposition
        def fixture_reader(*args):
            # Explicit synthetic root custody; real descriptor/file/native owner
            # reads. This source fixture is not an actual host disposal proof.
            with root_metadata():
                return actual_reader(*args)
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=changed_epoch), \
                patch.object(cleanup, "_namespace_disposition", side_effect=fixture_reader):
            proven = await self.cleanup_inspected(ingress=ingress)
            self.assertTrue(proven["quiescence_proven"], proven)
            self.assertFalse(proven["permission_granted"])
            self.assertTrue(all(worker["fate"] == "namespace_disposed"
                                for attempt in proven["attempts"] for worker in attempt["workers"]))
            self.assertFalse((await self.cleanup_inspected(stop_id=self.stop_id - 1, ingress=ingress))["quiescence_proven"])
            self.db.set_meta("fixture.pending.stop." + self.sid, "pending")
            self.assertFalse((await self.cleanup_inspected(ingress=ingress))["quiescence_proven"])
            self.db.set_meta("fixture.pending.stop." + self.sid, None)
            def changed_receipt(_method, _params):
                self.before_rpc = None
                leaf.chmod(0o640)
                leaf.write_text(json.dumps({**receipt, "container_id": "b" * 64}))
                leaf.chmod(0o440)
            self.before_rpc = changed_receipt
            raced = await self.cleanup_inspected(ingress=ingress)
            self.assertFalse(raced["quiescence_proven"])
            self.assertEqual(raced["reason"], "cleanup_evidence_changed")
            leaf.chmod(0o640)
            leaf.write_text(json.dumps(receipt))
            leaf.chmod(0o440)
            self.assertTrue((await self.cleanup_inspected(ingress=ingress))["quiescence_proven"])
            # A disposed old namespace never settles newly queued native work.
            admit_session_input(self.db, epoch=self.authority.epoch,
                principal_id=self.conn.actor.subject, session_id=self.sid, request_id="still-pending",
                payload={"text": "Do not run this source fixture"})
            self.assertFalse((await self.cleanup_inspected(ingress=ingress))["quiescence_proven"])

    async def restarted_instance_issue(self):
        """HF-617: the whole instance restarted mid-attempt, killing the attempt and its gateway.

        Returns this (later) instance's epoch. The attempt's admission is already settled
        interrupted, as core (hermes-agent #217) settles it at startup; no host receipt exists.
        """
        from gateway.drain_control import current_instantiation_epoch
        await self.stopped_issue()
        event = self.board.execute("SELECT id,payload FROM task_events WHERE task_id=? AND kind='owner_admitted'",
                                   (self.task_id,)).fetchone()
        marker = json.loads(event["payload"])
        self.live_owner = dict(marker)
        marker["pid"] = 99999996  # the old gateway went down with its instance
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(marker), event["id"]))
        self.owner_event = event["id"]
        boot, _, start = current_instantiation_epoch().rpartition(":")
        self.recorded_start = int(start)
        return boot + ":" + str(int(start) + 1)

    def core_restart_proof(self):
        try:
            from hermes_cli.kanban_owner_recovery import attempt_instance_replaced  # noqa: F401
        except ImportError:
            return False
        return True

    async def test_cleanup_hf617_restart_settled_by_core_lets_takeover_proceed_once(self):
        from hermes_cli import kanban_db as kb
        restarted = await self.restarted_instance_issue()
        ingress = self.home / "protected" / "default" / "ingress.db"  # no host receipt was ever written
        before = {table: [tuple(row) for row in self.board.execute("SELECT * FROM " + table)]
                  for table in ("tasks", "task_runs", "task_events")}
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=restarted):
            evidence = await self.cleanup_inspected(ingress=ingress)
            if not self.core_restart_proof():
                # A core without #217's proof holds, and says what is needed.
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "restart_proof_unsupported")
                self.assertIn("Update the agent", evidence["needed"])
                return
            self.assertTrue(evidence["quiescence_proven"], evidence)
            self.assertFalse(evidence["permission_granted"])
            fates = [worker["fate"] for attempt in evidence["attempts"] for worker in attempt["workers"]]
            self.assertTrue(fates)
            self.assertEqual(set(fates), {"instance_replaced"})
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        # A reboot (another boot id) ended the old instance too.
        rebooted = "00000000-0000-4000-8000-000000000001:1"
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=rebooted):
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        for table, rows in before.items():
            self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM " + table)], rows)
        # The takeover then starts the remainder exactly once: the Stop anchor admits one resume,
        # and the same evidence cannot be replayed for a second execution.
        self.assertTrue(kb.unblock_task(self.board, self.task_id, expected_event_id=self.stop_id))
        self.assertFalse(kb.unblock_task(self.board, self.task_id, expected_event_id=self.stop_id))
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=restarted):
            replay = await self.cleanup_inspected()
        self.assertFalse(replay["quiescence_proven"])

    async def test_cleanup_hf617_old_attempt_that_may_be_alive_stays_held_with_plain_reason(self):
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        restarted = await self.restarted_instance_issue()
        boot = restarted.rpartition(":")[0]
        async def inspected(epoch):
            with patch("gateway.drain_control.current_instantiation_epoch", return_value=epoch):
                return await self.cleanup_inspected()
        # The gateway that admitted the old attempt is still running here.
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(self.live_owner), self.owner_event))
        result = await inspected(restarted)
        self.assertEqual((result["quiescence_proven"], result["reason"]), (False, "old_gateway_alive"))
        self.assertIn("may still be running", result["needed"])
        live_owner = dict(self.live_owner, pid=99999996)
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(live_owner), self.owner_event))
        # The recorded instance is not an earlier one: another running copy may own the attempt.
        result = await inspected(boot + ":" + str(self.recorded_start - 1))
        self.assertEqual((result["quiescence_proven"], result["reason"]), (False, "worker_instance_not_earlier"))
        self.assertIn("confirmed stopped", result["needed"])
        # This instance's identity cannot be read right now: never mistaken for a restart.
        for degraded in ("", ":" + str(self.recorded_start + 1), "not-a-boot-id:" + str(self.recorded_start + 1)):
            with self.subTest(epoch=degraded):
                result = await inspected(degraded)
                self.assertEqual((result["quiescence_proven"], result["reason"]), (False, "worker_identity_unreadable"))
                self.assertIn("Check again", result["needed"])
        # A worker of the current instance is alive: the long-standing live-PID hold.
        self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
            (json.dumps({"pid": os.getpid(), "started_at": _process_fingerprint(os.getpid()),
                         "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        result = await self.cleanup_inspected()
        self.assertEqual((result["quiescence_proven"], result["reason"]), (False, "old_worker_alive"))
        self.assertIn("still running", result["needed"])
        # Mixed evidence (one worker from this instance, one from before the restart) is not core's proof.
        self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
            (json.dumps({"pid": 99999998, "started_at": restarted + "|1",
                         "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        result = await inspected(restarted)
        self.assertFalse(result["quiescence_proven"])
        self.assertEqual(result["reason"], "old_instance_unproven" if self.core_restart_proof()
                         else "restart_proof_unsupported")

    def cancelled_control(self):
        """Pinned-fae final-row adapter for candidate c9b8ad4's atomic Stop writer.

        This does not execute the unaccepted writer. Its final native row has the same
        principal/request/payload/status and NULL generation; no prompt or worker exists.
        The target is the logical owner_admitted session, never a physical worker SID.
        """
        from linear_native_db import admit_session_input, cancel_session_input
        identity = json.dumps(["completion", "fixture-process", 123.0], separators=(",", ":"))
        row = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id="native-process-stop", session_id=self.sid, request_id=identity,
            payload={"process_completion": identity, "route": "fixture-process-route"})
        row = cancel_session_input(self.db, epoch=self.authority.epoch,
                                   admission_id=row["admission_id"])
        self.assertEqual((row["status"], row["outcome"], row["generation"]),
                         ("terminal", "cancelled", None))
        self.assertEqual(set(row["payload"]), {"process_completion", "route"})
        self.assertEqual(row["target_session_id"], self.sid)
        return row

    def reference_through_a2a(self, captured):
        # These are the actual primitives used by tools._send_task and adapter._prepare_task.
        # No SendMessage handler, task store, audit, network or dispatch is invoked.
        from plugins.platforms.a2a import protocol, security
        wire = json.dumps(captured, sort_keys=True, separators=(",", ":"))
        safe = security.redact_outbound(wire)
        self.assertEqual(safe, wire)
        message = protocol.text_message(protocol.ROLE_USER, safe, context_id="fixture-context")
        extracted = protocol.extract_text(json.loads(json.dumps({"message": message})))
        self.assertEqual(extracted, wire)
        framed = security.wrap_inbound("configured-peer", extracted)
        prefix = security.PRIVACY_PREFIX.format(peer="configured-peer")
        self.assertTrue(framed.startswith(prefix))
        decoded = json.loads(framed[len(prefix):])
        self.assertEqual(decoded, captured)
        self.assertFalse(decoded["permission_granted"])
        # Keep the real scrub/framer enabled: preservation must not depend on bypassing them.
        self.assertNotIn("sk-" + "a" * 40, security.redact_outbound("sk-" + "a" * 40))
        self.assertIn("[filtered]", security.wrap_inbound("configured-peer", "<|system|>"))
        return decoded["reference"]

    async def test_a2a_reference_framing_preserves_each_interactive_surface(self):
        for surface in ("local", "api", "telegram", "slack"):
            with self.subTest(surface=surface):
                if surface == "local":
                    await self.local()
                elif surface == "api":
                    await self.api()
                else:
                    await self.messaging(surface)
                captured = await self.current()
                ref = self.reference_through_a2a(captured)
                evidence = await self.inspected(ref)
                self.assertEqual(evidence["reference"], ref)
                self.assertFalse(evidence["permission_granted"])

    async def test_a2a_work_reference_framing_preserves_unknown_requester(self):
        await self.kanban()
        ref = self.reference_through_a2a(await self.work_current())
        evidence = await self.work_inspected(ref)
        self.assertEqual(evidence["requester"], {"kind": "native_dispatcher", "original_requester": "unknown"})
        self.assertFalse(evidence["permission_granted"])

    async def test_a2a_explicit_api_ids_stay_private_and_survive_native_framing(self):
        # Native API permits arbitrary explicit path-safe IDs. They remain private even
        # when the A2A scrub would intentionally alter them if carried in peer text.
        await self.api(session_id="fixture@example.invalid", request_id="sk-" + "a" * 40)
        captured = await self.current()
        self.assertNotIn("session_id", captured["reference"])
        self.assertNotIn("input_id", captured["reference"])
        self.assertNotIn(self.sid, json.dumps(captured))
        self.assertNotIn(self.row["request_id"], json.dumps(captured))
        evidence = await self.inspected(self.reference_through_a2a(captured))
        self.assertEqual(evidence["requester"]["kind"], "api_credential")
        self.assertEqual(evidence["requester"]["principal"], "principal:fixture:" + "a" * 32)
        self.assertFalse(evidence["permission_granted"])

    async def test_stop_control_receipt_is_never_origin_or_requester_authority(self):
        from linear_native_db import settle_session_input
        await self.local()
        control = self.cancelled_control()
        captured = await self.current()
        self.assertEqual(captured["reference"]["admission_id"], self.admission)
        evidence = await self.inspected(captured["reference"])
        self.assertEqual(evidence["original_message"], "Take over ABC-1")
        self.assertNotEqual(evidence["requester"]["principal_id"], control["principal_id"])
        forged = dict(captured["reference"], admission_id=control["admission_id"])
        with self.assertRaises(transport.Unavailable):
            await self.inspected(forged)
        settle_session_input(self.db, epoch=self.authority.epoch,
            admission_id=self.admission, generation=self.row["generation"], outcome="interrupted")
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_cleanup_terminal_stop_controls_are_data_not_execution_or_proof(self):
        await self.stopped_issue()
        control = self.cancelled_control()
        before = self.db._read_all("SELECT * FROM session_admissions")
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertFalse(evidence["permission_granted"])
        self.assertNotIn(control["request_id"], json.dumps(evidence))
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), before)
        # A terminal cancellation is never a substitute for a clear native Stop checkpoint.
        self.db.set_meta("fixture.pending.stop." + self.sid, "pending")
        pending = await self.cleanup_inspected()
        self.assertFalse(pending["quiescence_proven"])
        self.assertEqual(pending["reason"], "native_stop_checkpoint_pending")

    async def test_cleanup_owner_cli_proves_only_bound_stopped_work_without_state_changes(self):
        from hermes_fleet_linear_plugin import ops
        import argparse
        from agent import runtime_session_store
        await self.stopped_issue()
        self.db.append_message(self.sid, "user", "PRIVATE_TRANSCRIPT_SENTINEL")
        before = [tuple(r) for r in self.board.execute("SELECT * FROM task_events")]
        native = self.db._read_all("SELECT * FROM session_admissions")
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertFalse(evidence["permission_granted"])
        self.assertEqual(evidence["stop_event_id"], self.stop_id)
        for private in ("CLAIM_PRIVATE_SENTINEL", "PRIVATE_TRANSCRIPT_SENTINEL", str(self.board_path), "fixture-adoption-private"):
            self.assertNotIn(private, json.dumps(evidence))
        self.assertEqual([tuple(r) for r in self.board.execute("SELECT * FROM task_events")], before)
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), native)
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["inspect-cleanup", "issue-one", "--expected-stop-event-id", str(self.stop_id)])
        with patch.object(runtime_session_store, "_worker_process", False), patch("builtins.print") as printed:
            rc = await asyncio.to_thread(ops.run, args, self.linear_state, self.home / "unused", "deployment-routing-alias", origin_settings=self.settings)
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(printed.call_args.args[0])["quiescence_proven"])
        self.board.execute("ALTER TABLE task_runs DROP COLUMN worker_started_at")
        damaged = await self.cleanup_inspected()
        self.assertFalse(damaged["quiescence_proven"])
        self.assertEqual(damaged["reason"], "cleanup_evidence_unavailable")

    async def test_cleanup_native_review_stop_control_row_preserves_executed_attempt_proof(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue(review_stop=True)
        rows = self.board.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY id", (self.task_id,)).fetchall()
        self.assertEqual(len(rows), 2)
        control = rows[-1]
        self.assertEqual((control["profile"], control["status"], control["outcome"], control["claim_lock"]),
                         (None, "blocked", "blocked", None))
        self.assertEqual(control["started_at"], control["ended_at"])
        board_before = {table: [tuple(row) for row in self.board.execute("SELECT * FROM " + table)]
                        for table in ("tasks", "task_runs", "task_events")}
        native_before = self.db._read_all("SELECT * FROM session_admissions")
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertFalse(evidence["permission_granted"])
        self.assertEqual([attempt["run_id"] for attempt in evidence["attempts"]], [rows[0]["id"]])
        self.assertEqual(evidence["control_only_runs"], [control["id"]])
        for table, before in board_before.items():
            self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM " + table)], before)
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), native_before)
        event = self.board.execute("SELECT * FROM task_events WHERE run_id=?", (control["id"],)).fetchone()
        def changed_control(_method, _params):
            self.before_rpc = None
            payload = {**json.loads(event["payload"]), "reason": "changed control"}
            self.board.execute("UPDATE task_runs SET summary=? WHERE id=?", (payload["reason"], control["id"]))
            self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(payload), event["id"]))
        self.before_rpc = changed_control
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_runs SET summary=? WHERE id=?", (control["summary"], control["id"]))
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (event["payload"], event["id"]))
        # A later native reaffirmed Stop remains a fresh checkpoint over the same history.
        latest = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="fixture Stop again",
                                     expected_event_id=latest))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_native_review_stop_control_row_from_assigned_ready_card(self):
        await self.stopped_issue(review_stop="ready")
        control = self.board.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC", (self.task_id,)).fetchone()
        self.assertEqual(control["profile"], "default")
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(evidence["control_only_runs"], [control["id"]])
        self.assertEqual(len(evidence["attempts"]), 1)

    async def test_cleanup_native_review_stop_control_lookalikes_remain_unknown(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue(review_stop=True)
        control = self.board.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC", (self.task_id,)).fetchone()
        mutations = {"profile": "foreign", "step_key": "execution", "status": "done", "outcome": "completed",
            "claim_lock": "retained-claim", "claim_expires": 1, "worker_pid": 99999999,
            "worker_started_at": self.process_witness(1), "max_runtime_seconds": 1, "last_heartbeat_at": 1,
            "started_at": control["started_at"] - 1, "ended_at": control["ended_at"] + 1,
            "summary": "different reason", "metadata": "{}", "error": "execution error"}
        for field, changed in mutations.items():
            with self.subTest(field=field):
                self.board.execute(f"UPDATE task_runs SET {field}=? WHERE id=?", (changed, control["id"]))
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                self.board.execute(f"UPDATE task_runs SET {field}=? WHERE id=?", (control[field], control["id"]))
        event = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND run_id=?",
                                   (self.task_id, control["id"])).fetchone()
        original = json.loads(event["payload"])
        for changed in ({k: v for k, v in original.items() if k != "source_status"},
                        {**original, "source_status": "running"}, {**original, "reason": "other reason"},
                        *({**original, "recurrences": value} for value in (None, 0, True, kb.BLOCK_RECURRENCE_LIMIT)),
                        {**original, "reaffirmed": True}):
            self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(changed), event["id"]))
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (event["payload"], event["id"]))
        for kind in ("claimed", "owner_admitted", "spawned", "worker_bound", "blocked", "unknown_future_event"):
            with self.subTest(event=kind):
                with kb.write_txn(self.board):
                    kb._append_event(self.board, self.task_id, kind, original, run_id=control["id"])
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                latest = kb.list_events(self.board, self.task_id)[-1].id
                self.board.execute("DELETE FROM task_events WHERE id=?", (latest,))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_control_row_never_substitutes_for_missing_or_ambiguous_attempt_owner(self):
        await self.stopped_issue(review_stop=True)
        admitted = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind='owner_admitted'",
                                      (self.task_id,)).fetchone()
        self.board.execute("UPDATE task_events SET kind='unverified_owner' WHERE id=?", (admitted["id"],))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_events SET kind='owner_admitted' WHERE id=?", (admitted["id"],))
        claimed = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind='claimed'",
                                     (self.task_id,)).fetchone()
        self.board.execute("UPDATE task_events SET kind='owner_admitted',payload=? WHERE id=?",
                           (admitted["payload"], claimed["id"]))
        ambiguous = await self.cleanup_inspected()
        self.assertFalse(ambiguous["quiescence_proven"])
        self.assertEqual(ambiguous["reason"], "attempt_native_admission_missing_or_ambiguous")
        self.board.execute("UPDATE task_events SET kind='claimed',payload=? WHERE id=?", (claimed["payload"], claimed["id"]))
        self.db.set_meta("fixture.pending.stop." + self.sid, "pending")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.db.set_meta("fixture.pending.stop." + self.sid, None)
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_optional_native_event_absence_is_compatible_and_scoped(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        optional = self.board.execute("SELECT id,payload FROM task_events WHERE task_id=? AND kind='claimed'",
                                      (self.task_id,)).fetchone()
        self.assertIsNotNone(optional)
        foreign = kb.create_task(self.board, title="Unrelated work", assignee="default", created_by="fixture-agent")
        kb._append_event(self.board, foreign, "blocked", None)
        self.board.execute("UPDATE task_events SET payload='[]' WHERE task_id=? AND kind='blocked'", (foreign,))
        foreign_rows = [tuple(row) for row in self.board.execute("SELECT * FROM task_events WHERE task_id=?", (foreign,))]
        for raw in (None, "null"):
            with self.subTest(raw=raw):
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, optional["id"]))
                try:
                    event = kb.Event.from_row(self.board.execute("SELECT * FROM task_events WHERE id=?", (optional["id"],)).fetchone())
                    self.assertIsNone(event.payload)
                    result = await self.cleanup_inspected()
                    self.assertTrue(result["quiescence_proven"], result)
                    self.assertFalse(result["permission_granted"])
                    self.assertEqual(self.board.execute("SELECT payload FROM task_events WHERE id=?", (optional["id"],)).fetchone()[0], raw)
                    self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM task_events WHERE task_id=?", (foreign,))], foreign_rows)
                finally:
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (optional["payload"], optional["id"]))
                # A nonempty retained optional map changing during owner readback
                # invalidates that read; its stable native absence remains supported.
                self.assertTrue(json.loads(optional["payload"]))
                def arriving(_method, _params):
                    self.before_rpc = None
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, optional["id"]))
                self.before_rpc = arriving
                try:
                    result = await self.cleanup_inspected()
                    self.assertEqual(result["state"], "unknown")
                    self.assertEqual(result["reason"], "cleanup_evidence_changed")
                    self.assertFalse(result["permission_granted"])
                    self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
                finally:
                    self.before_rpc = None
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (optional["payload"], optional["id"]))
        for raw in ("[]", "1", '"scalar"'):
            with self.subTest(unsupported=raw):
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, optional["id"]))
                try:
                    result = await self.cleanup_inspected()
                    self.assertEqual(result["state"], "unknown")
                    self.assertFalse(result["quiescence_proven"])
                finally:
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (optional["payload"], optional["id"]))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_required_native_event_absence_is_unknown_in_owner_cli_and_readback(self):
        import argparse
        from agent import runtime_session_store
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin import ops
        await self.stopped_issue()
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["inspect-cleanup", "issue-one", "--expected-stop-event-id", str(self.stop_id)])
        required = self.board.execute("SELECT id,kind,payload FROM task_events WHERE task_id=? AND "
                                      "(id=? OR kind IN ('owner_admitted','spawned','worker_bound'))",
                                      (self.task_id, self.stop_id)).fetchall()
        self.assertEqual({row["kind"] for row in required}, {"blocked", "owner_admitted", "spawned", "worker_bound"})
        for event in required:
            for raw in (None, "null"):
                with self.subTest(kind=event["kind"], raw=raw):
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, event["id"]))
                    try:
                        decoded = kb.Event.from_row(self.board.execute("SELECT * FROM task_events WHERE id=?", (event["id"],)).fetchone())
                        self.assertIsNone(decoded.payload)
                        result = await self.cleanup_inspected()
                        self.assertEqual(result["state"], "unknown")
                        self.assertFalse(result["quiescence_proven"])
                        self.assertFalse(result["permission_granted"])
                        with patch.object(runtime_session_store, "_worker_process", False), patch("builtins.print") as printed:
                            rc = await asyncio.to_thread(ops.run, args, self.linear_state, self.home / "unused", "default", origin_settings=self.settings)
                        cli = json.loads(printed.call_args.args[0])
                        self.assertEqual(rc, 1)
                        self.assertEqual(cli["state"], "unknown")
                        self.assertFalse(cli["quiescence_proven"])
                        self.assertFalse(cli["permission_granted"])
                        self.assertEqual(self.board.execute("SELECT payload FROM task_events WHERE id=?", (event["id"],)).fetchone()[0], raw)
                    finally:
                        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (event["payload"], event["id"]))
                    self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
                    def arriving(_method, _params):
                        self.before_rpc = None
                        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, event["id"]))
                    self.before_rpc = arriving
                    try:
                        changed = await self.cleanup_inspected()
                        self.assertEqual(changed["state"], "unknown")
                        self.assertFalse(changed["quiescence_proven"])
                        self.assertFalse(changed["permission_granted"])
                    finally:
                        self.before_rpc = None
                        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (event["payload"], event["id"]))
                    self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_required_native_event_absence_never_skips_newer_blocked_control(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        old_id = self.stop_id
        old_payload = self.board.execute("SELECT payload FROM task_events WHERE id=?", (old_id,)).fetchone()[0]
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", expected_event_id=old_id))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        new_payload = self.board.execute("SELECT payload FROM task_events WHERE id=?", (self.stop_id,)).fetchone()[0]
        for raw in (None, "null"):
            with self.subTest(raw=raw):
                # Only the latest actual blocked control selects the current Stop;
                # missing metadata in an older control is not a blanket refusal.
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, old_id))
                try:
                    self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
                    self.assertEqual((await self.cleanup_inspected(stop_id=old_id))["state"], "unknown")
                finally:
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (old_payload, old_id))
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, self.stop_id))
                try:
                    for selector in (old_id, self.stop_id):
                        result = await self.cleanup_inspected(stop_id=selector)
                        self.assertEqual(result["state"], "unknown")
                        self.assertFalse(result["quiescence_proven"])
                        self.assertFalse(result["permission_granted"])
                finally:
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (new_payload, self.stop_id))
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        for raw in (None, "null"):
            current = self.stop_id
            written = {}
            def arriving(_method, _params):
                self.before_rpc = None
                self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", expected_event_id=current))
                newest = kb.list_events(self.board, self.task_id)[-1]
                written.update(id=newest.id, payload=json.dumps(newest.payload))
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, newest.id))
            self.before_rpc = arriving
            try:
                result = await self.cleanup_inspected()
                self.assertEqual(result["state"], "unknown")
                self.assertFalse(result["quiescence_proven"])
                self.assertFalse(result["permission_granted"])
                fresh = await self.cleanup_inspected(stop_id=written["id"])
                self.assertEqual(fresh["state"], "unknown")
                self.assertFalse(fresh["quiescence_proven"])
            finally:
                self.before_rpc = None
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (written["payload"], written["id"]))
                self.stop_id = written["id"]
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_unsupported_pending_and_live_admission_are_unknown(self):
        from gateway import session_ancillary
        await self.stopped_issue()
        with patch.object(session_ancillary, "process_stop_pending", None):
            result = await self.cleanup_inspected()
        self.assertEqual(result["reason"], "native_stop_checkpoint_unsupported")
        self.db.set_meta("fixture.pending.stop." + self.sid, "pending")
        result = await self.cleanup_inspected()
        self.assertFalse(result["quiescence_proven"])
        self.assertEqual(result["reason"], "native_stop_checkpoint_pending")
        self.db._execute_write(lambda c: c.execute("DELETE FROM state_meta WHERE key=?", ("fixture.pending.stop." + self.sid,)))
        self.db._execute_write(lambda c: c.execute("UPDATE session_admissions SET status='started',outcome=NULL WHERE admission_id=?", (self.admission,)))
        result = await self.cleanup_inspected()
        self.assertFalse(result["quiescence_proven"])
        self.assertEqual(result["reason"], "native_admission_not_settled")

    async def test_cleanup_unknown_workers_or_missing_executor_never_become_settlement(self):
        from linear_native_db import register_worker_execution
        await self.stopped_issue()
        executor = "admission-worker:" + self.admission
        self.db._execute_write(lambda c: c.execute("UPDATE worker_executions SET status='unknown' WHERE execution_id=?", (executor,)))
        result = await self.cleanup_inspected()
        self.assertEqual(result["reason"], "native_worker_or_spawner_unsettled")
        self.db._execute_write(lambda c: c.execute("UPDATE worker_executions SET status='terminal' WHERE execution_id=?", (executor,)))
        child = self.sid + "-child"
        self.db.create_session(child, source="subagent", parent_session_id=self.sid)
        register_worker_execution(self.db, epoch=self.authority.epoch, execution_id=executor + "/child:fixture",
            session_id=child, generation=0, kind="child", adoption_secret="fixture-child-private")
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_child_spawner_unsettled")
        self.db._execute_write(lambda c: c.execute("DELETE FROM worker_executions WHERE execution_id=?", (executor + "/child:fixture",)))
        self.db._execute_write(lambda c: (c.execute("DELETE FROM worker_receipts WHERE execution_id=?", (executor,)),
            c.execute("DELETE FROM worker_executions WHERE execution_id=?", (executor,))))
        result = await self.cleanup_inspected()
        self.assertEqual(result["reason"], "native_executor_settlement_missing")

    async def test_cleanup_live_recycled_and_unverifiable_worker_fingerprints(self):
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        real = _process_fingerprint(os.getpid())
        self.assertIsNotNone(real)
        def bound(fingerprint):
            self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
                (json.dumps({"pid": os.getpid(), "started_at": fingerprint, "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        bound(real)
        self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")
        bound(self.process_witness(1))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.original_worker_birth(self.earlier_native_birth())
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(evidence["attempts"][0]["workers"][0]["fate"], "recycled")
        bound(None)
        self.assertEqual((await self.cleanup_inspected())["reason"], "worker_identity_missing")

    async def test_cleanup_scoped_checkpoint_retains_owned_obligations_and_foreign_records(self):
        from gateway.status import get_process_start_time
        await self.stopped_issue()
        route = self.authority.sessions[self.sid].route
        foreign = {"session_key": "foreign", "owner_task_id": "foreign", "pid": os.getpid(),
                   "host_start_time": get_process_start_time(os.getpid()), "systemd_unit": "FOREIGN_SCOPE_PRIVATE"}
        own = {"session_key": route, "parent_session_id": self.sid, "pid": os.getpid(),
               "host_start_time": get_process_start_time(os.getpid()), "pid_scope": "host"}
        path = self.home / "processes.json"
        for changes in ({}, {"host_start_time": 1}, {"pid": 99999997}, {"systemd_unit": "pending-native-scope"}):
            with self.subTest(changes=changes):
                path.write_text(json.dumps([foreign, {**own, **changes}]))
                before = path.read_bytes()
                evidence = await self.cleanup_inspected()
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "scoped_process_cleanup_unknown")
                self.assertNotIn("FOREIGN_SCOPE_PRIVATE", json.dumps(evidence))
                self.assertEqual(path.read_bytes(), before)
        # A recycled legacy leader cannot discharge native ownership either.
        # Success requires native retirement of the attributed obligation.
        path.write_text(json.dumps([foreign]))
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(evidence["scoped_checkpoint"], {"scoped_records": 0, "recycled_records": 0})

    async def test_cleanup_new_stop_unblock_foreign_binding_and_late_spawner_invalidate(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", expected_event_id=self.stop_id))
        self.assertEqual((await self.cleanup_inspected())["reason"], "stop_event_changed")
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        with kb.write_txn(self.board):
            kb._append_event(self.board, self.task_id, "worker_bound", {"pid": 99999998,
                "started_at": self.process_witness(1), "claim_lock": self.work_context["claim_lock"]}, run_id=self.work_context["run_id"])
        self.assertEqual((await self.cleanup_inspected())["reason"], "late_worker_binding_after_stop")
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        self.assertEqual((await self.cleanup_inspected())["reason"], "task_not_currently_stopped")

    async def test_cleanup_stop_changes_during_receipt_or_owner_restart_are_unknown(self):
        from hermes_cli import kanban_db as kb
        from linear_native_db import begin_runtime_epoch
        await self.stopped_issue()
        def stop(method, params):
            self.before_rpc = None
            kb.block_task(self.board, self.task_id, kind="needs_input", expected_event_id=self.stop_id)
        self.before_rpc = stop
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        self.authority.epoch = begin_runtime_epoch(self.db, instance_id="different-owner")
        # Endpoint still reports old instance: independently read epoch/instance must refuse.
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_owner_changed")

    async def test_cleanup_missing_reporting_link_discovers_unique_native_work_without_adopting(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        with self.linear_store._tx() as db:
            db.execute("DELETE FROM metadata WHERE key='native-binding:issue-one'")
            db.execute("DELETE FROM work WHERE issue_id='issue-one'")
        self.board.execute("UPDATE tasks SET idempotency_key='linear:issue-one' WHERE id=?", (self.task_id,))
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(evidence["discovery_source"], "native_history_discovery")
        self.assertIsNone(self.linear_store.get("issue-one"))
        kb.create_task(self.board, title="second plausible work", assignee="default", idempotency_key=None,
                       body="Linear issue issue-one: https://linear.example/issue")
        # Marker-only metadata is owner CLI discovery data, not authorization.
        from agent import runtime_session_store
        with patch.object(runtime_session_store, "_worker_process", False):
            result = await asyncio.to_thread(cleanup.inspect, self.linear_state, "issue-one", "default", self.stop_id,
                self.settings, {"id": "issue-one", "identifier": "ABC-1", "url": "https://linear.example/issue"})
        self.assertEqual(result["reason"], "native_history_match_missing_or_ambiguous")
        self.assertIsNone(self.linear_store.get("issue-one"))

    async def test_cleanup_task_scope_holds_saved_and_idempotency_conflicts(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue(idempotency_key="linear:issue-one")
        metadata = {"id": "issue-one", "identifier": "ABC-1", "url": "https://linear.example/issue/ABC-1"}
        own = "Linear issue ABC-1: " + metadata["url"]
        conflicts = ["Linear issue OTHER-2: https://linear.example/issue/OTHER-2",
                     own + "\nLinear issue OTHER-2: https://linear.example/issue/OTHER-2",
                     "Linear issue ABC-1: https://linear.example/issue/other"]
        for body in conflicts:
            with self.subTest(body=body):
                self.assertTrue(kb.edit_task(self.board, self.task_id, body=body))
                before = [tuple(row) for row in self.board.execute("SELECT * FROM tasks")]
                evidence = await self.cleanup_inspected(metadata=metadata)
                self.assertEqual(evidence["reason"], "native_task_issue_scope_conflict")
                self.assertFalse(evidence["quiescence_proven"])
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM tasks")], before)
        # A native idempotency key still selects the conflicting executor when
        # no reporting link exists; explicit conflict must not become absence.
        with self.linear_store._tx() as db:
            db.execute("DELETE FROM metadata WHERE key='native-binding:issue-one'")
            db.execute("DELETE FROM work WHERE issue_id='issue-one'")
        self.assertEqual((await self.cleanup_inspected(metadata=metadata))["reason"], "native_task_issue_scope_conflict")

    async def test_cleanup_task_scope_preserves_manual_alias_and_foreign_controls(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _set_worker_pid
        await self.stopped_issue()
        metadata = {"id": "issue-one", "identifier": "ABC-1", "url": "https://linear.example/issue/ABC-1"}
        foreign = kb.create_task(self.board, title="Foreign retained work", assignee="default",
            idempotency_key="linear:another-issue", body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2")
        claimed = kb.claim_task(self.board, foreign, claimer="fixture-foreign-worker")
        _set_worker_pid(self.board, foreign, os.getpid(), run_id=claimed.current_run_id, claim_lock=claimed.claim_lock)
        for body in ("Manual work with an incidental OTHER-2 reference",
                     "\n".join(["Linear issue issue-one: " + metadata["url"],
                                 "Linear issue ABC-1: " + metadata["url"],
                                 "Linear issue ABC-1: " + metadata["url"]])):
            with self.subTest(body=body):
                self.assertTrue(kb.edit_task(self.board, self.task_id, body=body))
                before = [tuple(row) for row in self.board.execute("SELECT * FROM tasks")]
                evidence = await self.cleanup_inspected(metadata=metadata)
                self.assertTrue(evidence["quiescence_proven"], evidence)
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual([tuple(row) for row in self.board.execute("SELECT * FROM tasks")], before)
        # Without independently supplied URL metadata, an explicit marker
        # remains unproved; no parser or alias grammar is added by cleanup.
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_task_scope_conflict_arriving_after_discovery_is_unknown(self):
        from contextlib import closing
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_connect import _sqlite_connect
        from hermes_fleet_linear_plugin.bridge import Kanban
        await self.stopped_issue(idempotency_key="linear:issue-one")
        discover = Kanban.discover
        changed = False
        def change_after_discovery(reader, issue):
            nonlocal changed
            found = discover(reader, issue)
            if not changed:
                changed = True
                with closing(_sqlite_connect(self.board_path)) as writer:
                    writer.row_factory = __import__("sqlite3").Row
                    self.assertTrue(kb.edit_task(writer, self.task_id,
                        body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2"))
            return found
        with patch.object(Kanban, "discover", change_after_discovery):
            evidence = await self.cleanup_inspected(
                metadata={"id": "issue-one", "identifier": "ABC-1", "url": "https://linear.example/issue/ABC-1"})
        self.assertEqual(evidence["reason"], "native_task_issue_scope_conflict")
        # Without the issue's own link the same marker is unproved discovery data, named as such.
        self.assertEqual((await self.cleanup_inspected())["reason"], "issue_metadata_required")

    async def test_cleanup_task_scope_and_binding_changes_during_owner_receipt_are_unknown(self):
        from hermes_cli import kanban_db as kb
        import uuid
        await self.stopped_issue()
        def conflict(_method, _params):
            self.before_rpc = None
            self.assertTrue(kb.edit_task(self.board, self.task_id,
                body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2"))
        self.before_rpc = conflict
        metadata = {"id": "issue-one", "identifier": "ABC-1", "url": "https://linear.example/issue/ABC-1"}
        self.assertEqual((await self.cleanup_inspected(metadata=metadata))["reason"], "native_task_issue_scope_conflict")
        self.assertTrue(kb.edit_task(self.board, self.task_id, body="Authorized marker-free manual task"))
        def same_scope_edit(_method, _params):
            self.before_rpc = None
            self.assertTrue(kb.edit_task(self.board, self.task_id, body="Updated authorized manual instruction"))
        self.before_rpc = same_scope_edit
        self.assertEqual((await self.cleanup_inspected())["reason"], "cleanup_evidence_changed")
        def link_change(_method, _params):
            self.before_rpc = None
            revision = self.linear_store.binding_revision("issue-one")
            self.assertIsNotNone(self.linear_store.replace_native_binding("issue-one", self.task_id, "default", "default",
                expected_revision=revision, request_id=str(uuid.uuid4()), owner_ref="session-new",
                requester_activity="activity-new", at=2))
        self.before_rpc = link_change
        self.assertEqual((await self.cleanup_inspected())["reason"], "cleanup_evidence_changed")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_foreign_binding_and_scope_fence_are_not_authority(self):
        await self.stopped_issue()
        with self.linear_store._tx() as db:
            db.execute("UPDATE metadata SET value=? WHERE key='native-binding:issue-one'",
                       (json.dumps({"issue_id": "issue-one", "task_id": self.task_id, "board": "default", "profile": "foreign"}),))
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_history_match_missing_or_ambiguous")
        with self.linear_store._tx() as db:
            db.execute("INSERT INTO specialist_scope_fence(issue_id,reason,fenced_at) VALUES('issue-one','fixture',1)")
        self.assertEqual((await self.cleanup_inspected())["reason"], "issue_scope_fenced")

    async def test_cleanup_primary_payload_native_mapping_validation_precedes_access(self):
        from linear_native_db import find_session_admission, _json, RuntimeStoreError
        await self.stopped_issue()
        original = json.loads(self.db._read_one(
            "SELECT payload_json FROM session_admissions WHERE admission_id=?", (self.admission,))[0])
        def retained(payload):
            encoded = json.dumps(payload)
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (encoded, self.admission)))
            return encoded
        for payload in ([], None, "scalar", True, 1, 0.5):
            with self.subTest(payload=payload):
                with self.assertRaises(RuntimeStoreError):
                    _json(payload)
                encoded = retained(payload)  # Explicit fault in an actual settled native row.
                decoded = find_session_admission(self.db, principal_id=self.row["principal_id"],
                    session_id=self.sid, request_id=self.row["request_id"])
                self.assertEqual(decoded["payload"], payload)
                evidence = await self.cleanup_inspected()
                self.assertEqual(evidence["state"], "unknown")
                self.assertEqual(evidence["reason"], "native_admission_state_unreadable")
                self.assertFalse(evidence["quiescence_proven"])
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual(self.db._read_one(
                    "SELECT payload_json FROM session_admissions WHERE admission_id=?", (self.admission,))[0], encoded)
        # Valid mappings retain the native payload contract; a mapping alone
        # does not replace the independently required Kanban attempt binding.
        retained({})
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_admission_not_settled")
        for payload in (original, {**original, "opaque": {"nested": [None, {}, [], " text ", 3]}}):
            self.assertIsInstance(json.loads(_json(payload)), dict)
            retained(payload)
            evidence = await self.cleanup_inspected()
            self.assertTrue(evidence["quiescence_proven"], evidence)
            self.assertFalse(evidence["permission_granted"])

    async def test_cleanup_primary_payload_fault_during_owner_readback_returns_unknown(self):
        await self.stopped_issue()
        def arriving(_method, _params):
            self.before_rpc = None
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE session_admissions SET payload_json='[]' WHERE admission_id=?", (self.admission,)))
        self.before_rpc = arriving
        evidence = await self.cleanup_inspected()
        self.assertFalse(evidence["quiescence_proven"])
        self.assertEqual(evidence["state"], "unknown")
        self.assertFalse(evidence["permission_granted"])

    async def test_cleanup_native_policy_context_mapping_is_checked_before_access(self):
        from linear_native_db import local_receipt, POLICY_PREFIX
        from gateway.session_policy import restore_policy
        await self.stopped_issue()
        original = local_receipt(self.db, self.sid)
        def context(value):
            receipt = json.loads(json.dumps(original))
            receipt["policy"]["kanban_json"] = json.dumps(value)
            # The actual native policy decoder accepts this retained field's
            # encoded value; cleanup must decode its consumed mapping itself.
            self.assertEqual(restore_policy(receipt["policy"]).kanban_json, json.dumps(value))
            encoded = json.dumps(receipt)
            self.db.set_meta(POLICY_PREFIX + self.sid, encoded)
            return encoded
        for value in ([], None, "scalar", True, 1, 0.5):
            with self.subTest(value=value):
                encoded = context(value)
                evidence = await self.cleanup_inspected()
                self.assertEqual(evidence["state"], "unknown")
                self.assertFalse(evidence["quiescence_proven"])
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual(self.db.get_meta(POLICY_PREFIX + self.sid), encoded)
        saved = json.loads(original["policy"]["kanban_json"])
        for value in (saved, {**saved, "opaque": {"nested": [None, {}, []]}}):
            context(value)
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def arriving(_method, _params):
            self.before_rpc = None
            context([])
        self.before_rpc = arriving
        evidence = await self.cleanup_inspected()
        self.assertEqual(evidence["state"], "unknown")
        self.assertFalse(evidence["quiescence_proven"])

    async def test_cleanup_saved_binding_mapping_is_checked_before_access(self):
        await self.stopped_issue()
        original = self.linear_store.native_binding("issue-one")
        def binding(value):
            encoded = json.dumps(value)
            with self.linear_store._tx() as db:
                db.execute("UPDATE metadata SET value=? WHERE key='native-binding:issue-one'", (encoded,))
            return encoded
        for value in ([], None, "scalar", True, 1, 0.5):
            with self.subTest(value=value):
                encoded = binding(value)  # Explicit fault in the actual Store writer's row.
                evidence = await self.cleanup_inspected()
                self.assertEqual(evidence["state"], "unknown")
                self.assertFalse(evidence["quiescence_proven"])
                self.assertFalse(evidence["permission_granted"])
                with self.linear_store._tx() as db:
                    self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='native-binding:issue-one'").fetchone()[0], encoded)
        for value in (original, {**original, "opaque": {"nested": [None, {}, []]}}):
            binding(value)
            self.assertEqual(self.linear_store.native_binding("issue-one"), value)
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def arriving(_method, _params):
            self.before_rpc = None
            binding([])
        self.before_rpc = arriving
        evidence = await self.cleanup_inspected()
        self.assertEqual(evidence["state"], "unknown")
        self.assertFalse(evidence["quiescence_proven"])

    async def test_work_current_preserves_unknown_requester_and_selective_privacy(self):
        from hermes_cli import kanban_db as kb
        await self.kanban()
        self.db.append_message(self.sid, "user", "UNRELATED_PRIVATE_HISTORY")
        kb.create_task(self.board, title="UNRELATED_PRIVATE_CARD", assignee="default")
        before = [tuple(r) for r in self.board.execute("SELECT * FROM tasks")]
        admission_before = self.db._read_all("SELECT * FROM session_admissions")
        result = await self.work_current()
        evidence = await self.work_inspected(result["reference"])
        self.assertEqual(evidence["requester"], {"kind": "native_dispatcher", "original_requester": "unknown"})
        self.assertEqual(evidence["work"]["instruction"], "Take over ABC-1\n\nFinish the remaining checks")
        self.assertEqual(evidence["scope"]["declared"], origin.scope(self.settings))
        self.assertEqual(evidence["scope"]["workspace"], str(self.home))
        self.assertFalse(evidence["permission_granted"])
        for private in ("CLAIM_PRIVATE_SENTINEL", "UNRELATED_FROZEN_CONTEXT", "UNRELATED_PRIVATE_HISTORY",
                        "UNRELATED_PRIVATE_CARD", str(self.board_path), self.conn.actor.subject):
            self.assertNotIn(private, json.dumps(evidence))
        self.assertEqual([tuple(r) for r in self.board.execute("SELECT * FROM tasks")], before)
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), admission_before)
        with self.assertRaises(transport.Unavailable):
            await self.current()  # Interactive origin rules remain unchanged for producers.

    async def test_work_registered_boundary_and_cli_are_separate_and_selector_free(self):
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from tools.registry import registry
        from hermes_fleet_linear_plugin import ops
        import argparse
        await self.kanban()
        self.config["plugins"] = {"entries": {"linear": {"settings": {"enabled": True, **self.settings}}}}
        (self.home / "config.yaml").write_text(json.dumps(self.config))
        manager = PluginManager(scope_key=str(self.home))
        self.addCleanup(manager.unload)
        plugin.register(PluginContext(PluginManifest(name="linear"), manager))
        handler = registry.get_entry("linear", scope=str(self.home)).handler
        result = json.loads(await asyncio.to_thread(handler, {"action": "work_reference"}))
        self.assertTrue(result["ok"], result)
        for selector in ("session_id", "task_id", "home", "profile", "body", "issue"):
            denied = json.loads(await asyncio.to_thread(handler, {"action": "work_reference", selector: "forged"}))
            self.assertFalse(denied["ok"])
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["inspect-work", "--reference-json", json.dumps(result["reference"])])
        with patch("builtins.print") as printed:
            code = await asyncio.to_thread(ops.run, args, self.home / "unused", self.home / "unused", "default",
                                           origin_settings=self.settings)
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(printed.call_args.args[0])["permission_granted"])

    def registered_linear(self):
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from hermes_cli.plugins_loader import run_with_load_deadline
        from tools.registry import registry
        self.config["plugins"] = {"entries": {"linear": {"settings": {"enabled": True, **self.settings}}}}
        (self.home / "config.yaml").write_text(json.dumps(self.config))
        manager = PluginManager(scope_key=str(self.home))
        context = PluginContext(PluginManifest(name="linear"), manager)
        self.addCleanup(manager.unload)
        # Real discovery registers on a deadline thread with copied ContextVars.
        run_with_load_deadline("linear", context, lambda: plugin.register(context))
        return manager, registry

    async def test_native_kanban_bootstrap_exposes_only_work_reference_before_session_binding(self):
        from gateway.session_kanban import bind_worker_context
        from gateway.session_context import reset_session_vars, set_current_session_id
        from gateway.session_policy import policy_scope, restore_policy
        from linear_native_db import local_receipt
        from hermes_fleet_linear_plugin import chat
        await self.kanban()
        original_schema = json.loads(json.dumps(chat.SCHEMA))
        original_cwd = Path.cwd()
        self.addCleanup(os.chdir, original_cwd)
        # Same native ordering as managed_worker.execute: adopted process marker,
        # validated claim binding, discovery, then AIAgent's current session ID.
        reset_session_vars()
        policy_data = local_receipt(self.db, self.sid)["policy"]
        bind_worker_context({"policy": policy_data})
        manager, registry = self.registered_linear()
        names = {"linear", "linear_work_reference"}
        self.assertEqual([d["function"]["name"] for d in registry.get_definitions(names)], ["linear"])
        entry = registry.get_entry("linear_work_reference", scope=str(self.home))
        self.assertEqual(entry.schema["parameters"], {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["work_reference"]}},
            "required": ["action"], "additionalProperties": False})
        self.assertEqual(entry.description, entry.schema["description"])
        for guidance in ("metadata.issue_comment", "gateway reporting outbox", "coordinator", "unknown"):
            self.assertIn(guidance, entry.description)
        self.assertEqual(chat.SCHEMA, original_schema)
        with policy_scope(restore_policy(policy_data)):
            self.assertEqual([d["function"]["name"] for d in registry.get_definitions(names)], ["linear_work_reference"])
            from model_tools import get_tool_definitions, handle_function_call
            definitions = get_tool_definitions(enabled_toolsets=["linear"], quiet_mode=True,
                                               skip_tool_search_assembly=True)
            self.assertEqual([d["function"]["name"] for d in definitions if d["function"]["name"] in names],
                             ["linear_work_reference"])
            from agent.delegation_context import delegated_child_context, non_dispatcher_owned_context
            for execution in (delegated_child_context(), non_dispatcher_owned_context()):
                with execution:
                    definitions = get_tool_definitions(enabled_toolsets=["linear"], quiet_mode=True,
                                                       skip_tool_search_assembly=True)
                    self.assertEqual([d["function"]["name"] for d in definitions if d["function"]["name"] in names],
                                     ["linear"])
                definitions = get_tool_definitions(enabled_toolsets=["linear"], quiet_mode=True,
                                                   skip_tool_search_assembly=True)
                self.assertEqual([d["function"]["name"] for d in definitions if d["function"]["name"] in names],
                                 ["linear_work_reference"])
            set_current_session_id(self.sid)
            result = json.loads(await asyncio.to_thread(handle_function_call, "tool_call", {"calls": [{
                "name": "linear_work_reference", "arguments": {"action": "work_reference"}}]},
                enabled_tools=["linear_work_reference"], enabled_toolsets=["linear"], session_id=self.sid))
            self.assertTrue(result["ok"], result)
            evidence = await self.work_inspected(result["reference"])
            self.assertFalse(evidence["permission_granted"])
            self.assertEqual(evidence["requester"]["original_requester"], "unknown")
            denied = json.loads(await asyncio.to_thread(entry.handler, {"action": "work_reference", "issue": "ABC-1"}))
            self.assertFalse(denied["ok"])
            # Inventory reduction grants no chat transport or remote mutation rights.
            denied = json.loads(await asyncio.to_thread(entry.handler, {"action": "status", "issue": "ABC-1"}))
            self.assertFalse(denied["ok"])
            self.assertIn("native host-bound session", denied["message"])
        self.assertEqual([d["function"]["name"] for d in registry.get_definitions(names)], ["linear"])
        manager.unload()

    async def test_linear_worker_inventory_does_not_change_ordinary_or_other_execution_contexts(self):
        from agent import runtime_session_store
        from agent.delegation_context import delegated_child_context, non_dispatcher_owned_context
        from gateway.session_policy import policy_scope, restore_policy
        from linear_native_db import local_receipt
        from hermes_fleet_linear_plugin import chat
        await self.local()
        original_schema = json.loads(json.dumps(chat.SCHEMA))
        manager, registry = self.registered_linear()
        names = {"linear", "linear_work_reference"}
        def ordinary_inventory():
            definitions = registry.get_definitions(names)
            self.assertEqual([d["function"]["name"] for d in definitions], ["linear"])
            self.assertEqual(definitions[0]["function"], original_schema)
        # Ordinary managed coordinators also adopt; stray task hints are not identity.
        with patch.object(runtime_session_store, "_worker_process", True), patch.dict(os.environ, {"HERMES_KANBAN_TASK": "stray"}):
            ordinary_inventory()
            policy = restore_policy(local_receipt(self.db, self.sid)["policy"])
            for source in ("gui", "slack", "telegram"):
                with policy_scope(replace(policy, source=source)):
                    ordinary_inventory()
        # A task environment hint alone cannot turn an owner into a registered worker.
        with patch.dict(os.environ, {"HERMES_KANBAN_TASK": "forged"}), patch.object(runtime_session_store, "_worker_process", False):
            ordinary_inventory()
        await self.kanban()
        policy = restore_policy(local_receipt(self.db, self.sid)["policy"])
        with policy_scope(policy):
            self.assertEqual([d["function"]["name"] for d in registry.get_definitions(names)], ["linear_work_reference"])
            for execution in (delegated_child_context(), non_dispatcher_owned_context()):
                with execution:
                    ordinary_inventory()
                    entry = registry.get_entry("linear_work_reference", scope=str(self.home))
                    denied = json.loads(await asyncio.to_thread(entry.handler, {"action": "work_reference"}))
                    self.assertFalse(denied["ok"])
                self.assertEqual([d["function"]["name"] for d in registry.get_definitions(names)], ["linear_work_reference"])
        ordinary_inventory()
        self.assertEqual(chat.SCHEMA, original_schema)
        manager.unload()

    async def test_selected_admission_native_constructor_and_known_header_controls(self):
        from linear_native_db import admit_session_input, cancel_session_input, RuntimeStoreError

        await self.local()
        params = {"epoch": self.authority.epoch, "principal_id": self.conn.actor.subject,
                  "session_id": self.sid, "request_id": "invalid-header", "payload": {"text": "fixture"}}
        for key in ("principal_id", "session_id", "request_id"):
            for value in (None, "", "x" * 1025, True):
                with self.subTest(key=key, value=value), self.assertRaises(RuntimeStoreError):
                    admit_session_input(self.db, **{**params, key: value})
        for intent in (None, "", "future-native-intent", 1):
            with self.subTest(intent=intent), self.assertRaises(RuntimeStoreError):
                admit_session_input(self.db, **params, intent=intent)
        for payload in ([], None, {"value": float("nan")}):
            # Core93 checks native Stop membership before _json; None fails there.
            errors = (RuntimeStoreError, TypeError) if payload is None else RuntimeStoreError
            with self.subTest(payload=payload), self.assertRaises(errors):
                admit_session_input(self.db, **{**params, "payload": payload})
        # A valid maximum-length native ID is not trimmed or given a new grammar.
        admit_session_input(self.db, **{**params, "request_id": " " * 1024})
        for native_work in (False, True):
            for intent in ("queue", "steer", "redirect"):
                with self.subTest(native_work=native_work, intent=intent):
                    await (self.kanban(intent=intent) if native_work else self.local(intent=intent))
                    current = self.work_current if native_work else self.current
                    inspected = self.work_inspected if native_work else self.inspected
                    ref = (await current())["reference"]
                    self.assertFalse((await inspected(ref))["permission_granted"])
                    # Historical and foreign malformed headers are outside this selected claim.
                    history = admit_session_input(self.db, epoch=self.authority.epoch,
                        principal_id=self.conn.actor.subject, session_id=self.sid,
                        request_id="historical", payload={"text": "unused"})
                    cancel_session_input(self.db, epoch=self.authority.epoch,
                                         admission_id=history["admission_id"])
                    self.db.create_session("foreign-header", source="gui")
                    foreign = admit_session_input(self.db, epoch=self.authority.epoch,
                        principal_id="foreign", session_id="foreign-header",
                        request_id="foreign-" + self.admission, payload={"text": "unused"})
                    def damage(conn):
                        conn.execute("PRAGMA ignore_check_constraints=ON")
                        try:
                            for row in (history, foreign):
                                conn.execute("UPDATE session_admissions SET intent=? WHERE admission_id=?",
                                             ("future-native-intent", row["admission_id"]))
                        finally:
                            conn.execute("PRAGMA ignore_check_constraints=OFF")
                    self.db._execute_write(damage)
                    self.assertFalse((await inspected(ref))["permission_granted"])
                    for row in (history, foreign):
                        self.assertEqual(self.db._read_one(
                            "SELECT intent FROM session_admissions WHERE admission_id=?", (row["admission_id"],))[0],
                            "future-native-intent")

    async def test_selected_admission_header_faults_return_structured_owner_cli_unavailable(self):
        import argparse
        from hermes_fleet_linear_plugin import ops

        for native_work in (False, True):
            await (self.kanban() if native_work else self.local())
            current = self.work_current if native_work else self.current
            inspected = self.work_inspected if native_work else self.inspected
            ref = (await current())["reference"]
            parser = argparse.ArgumentParser()
            ops.setup(parser)
            args = parser.parse_args(["inspect-work" if native_work else "inspect-origin",
                                      "--reference-json", json.dumps(ref)])
            long_target = "x" * 1025
            if self.db.get_session(long_target) is None:
                self.db.create_session(long_target, source="gui")
            faults = {"admission_id": ("", "x" * 1025), "request_id": ("", "x" * 1025),
                      "principal_id": ("", "x" * 1025), "target_session_id": (long_target,),
                      "intent": ("future-native-intent", ""), "seq": (0, -1),
                      "owner_epoch": (0, -1, 1.5), "generation": (0, -1, 1.5),
                      "status": ("queued", "unknown", "unsupported"), "outcome": ("completed",),
                      "payload_json": ("[]", '{"value":NaN}')}
            for column, values in faults.items():
                selector, identity = (("admission_id", self.admission) if column == "target_session_id"
                                      else ("target_session_id", self.sid))
                original = self.db._read_one(
                    f"SELECT {column} FROM session_admissions WHERE {selector}=?", (identity,))[0]
                for value in values:
                    def update(value):
                        def write(conn):
                            conn.execute("PRAGMA ignore_check_constraints=ON")
                            try:
                                conn.execute(f"UPDATE session_admissions SET {column}=? WHERE {selector}=?",
                                             (value, identity))
                            finally:
                                conn.execute("PRAGMA ignore_check_constraints=OFF")
                        self.db._execute_write(write)
                    with self.subTest(native_work=native_work, column=column, value=value):
                        update(value)
                        try:
                            with self.assertRaises(transport.Unavailable):
                                await current()
                            with self.assertRaises(transport.Unavailable):
                                await inspected(ref)
                            with patch("builtins.print") as printed:
                                code = await asyncio.to_thread(ops.run, args, self.home / "unused", self.home / "unused",
                                                               "default", origin_settings=self.settings)
                            result = json.loads(printed.call_args.args[0])
                            self.assertEqual(code, 1)
                            self.assertFalse(result["ok"])
                            self.assertFalse(result["permission_granted"])
                            self.assertEqual(self.db._read_one(
                                f"SELECT {column} FROM session_admissions WHERE {selector}=?", (identity,))[0], value)
                        finally:
                            update(original)
                        self.assertFalse((await inspected(ref))["permission_granted"])

    async def test_selected_admission_header_changes_during_owner_readback_are_refused(self):
        for native_work in (False, True):
            await (self.kanban() if native_work else self.local())
            current = self.work_current if native_work else self.current
            inspected = self.work_inspected if native_work else self.inspected
            for column, value in (("intent", "steer"), ("seq", self.row["seq"] + 1000),
                                  ("principal_id", "different-valid-native-principal")):
                original = self.row[column]
                def update(value):
                    self.db._execute_write(lambda conn: conn.execute(
                        f"UPDATE session_admissions SET {column}=? WHERE admission_id=?", (value, self.admission)))
                with self.subTest(native_work=native_work, column=column):
                    ref = (await current())["reference"]
                    self.during_origin_readback(lambda: update(value))
                    try:
                        with self.assertRaises(transport.Unavailable):
                            await inspected(ref)
                    finally:
                        self.before_rpc = None
                        update(original)
                    self.assertFalse((await inspected(ref))["permission_granted"])

    async def test_work_owner_cli_missing_native_columns_is_unavailable_without_repair(self):
        import argparse
        from hermes_fleet_linear_plugin import ops

        await self.kanban()
        ref = (await self.work_current())["reference"]
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["inspect-work", "--reference-json", json.dumps(ref)])

        async def inspected():
            with patch("builtins.print") as printed:
                code = await asyncio.to_thread(ops.run, args, self.home / "unused", self.home / "unused",
                                               "default", origin_settings=self.settings)
            return code, json.loads(printed.call_args.args[0])

        self.assertEqual((await inspected())[0], 0)
        columns = {
            "tasks": ("status", "current_run_id", "claim_lock", "claim_expires", "assignee",
                      "workspace_path", "branch_name", "tenant", "title", "body", "goal_mode",
                      "goal_max_turns", "max_runtime_seconds", "skills", "workspace_kind", "project_id",
                      "completion_contract", "model_override", "provider_override", "reasoning_effort"),
            "task_runs": ("status", "claim_lock", "claim_expires", "profile"),
        }
        for table, names in columns.items():
            original = [tuple(row) for row in self.board.execute(f"SELECT * FROM {table}")]
            for column in names:
                with self.subTest(table=table, column=column):
                    missing = "missing_" + column
                    self.board.execute(f"ALTER TABLE {table} RENAME COLUMN {column} TO {missing}")
                    try:
                        code, result = await inspected()
                        self.assertEqual(code, 1)
                        self.assertFalse(result["ok"])
                        self.assertFalse(result["permission_granted"])
                        self.assertIn("unavailable", result["message"].lower())
                        present = {row[1] for row in self.board.execute(f"PRAGMA table_info({table})")}
                        self.assertIn(missing, present)
                        self.assertNotIn(column, present)
                        self.assertEqual([tuple(row) for row in self.board.execute(f"SELECT * FROM {table}")], original)
                    finally:
                        self.board.execute(f"ALTER TABLE {table} RENAME COLUMN {missing} TO {column}")
                    code, result = await inspected()
                    self.assertEqual(code, 0)
                    self.assertFalse(result["permission_granted"])
                    self.assertEqual(result["reference"], ref)

    async def test_work_stale_run_claim_lease_and_scope_are_refused(self):
        await self.kanban()
        ref = (await self.work_current())["reference"]
        for column, value in (("current_run_id", 999), ("claim_lock", "different"), ("claim_expires", 1),
                              ("assignee", "foreign"), ("workspace_path", "/foreign"), ("tenant", "foreign"),
                              ("body", "Different request"), ("skills", '["different"]'), ("project_id", "changed")):
            old = self.board.execute(f"SELECT {column} FROM tasks WHERE id=?", (self.task_id,)).fetchone()[0]
            self.board.execute(f"UPDATE tasks SET {column}=? WHERE id=?", (value, self.task_id))
            with self.subTest(column=column), self.assertRaises(transport.Unavailable):
                await self.work_inspected(ref)
            self.board.execute(f"UPDATE tasks SET {column}=? WHERE id=?", (old, self.task_id))
        self.board.execute("UPDATE task_runs SET claim_expires=1 WHERE id=?", (self.work_context["run_id"],))
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(ref)

    async def test_work_stop_and_successor_need_a_fresh_reference(self):
        from hermes_cli import kanban_db as kb
        from linear_native_db import settle_session_input
        await self.kanban()
        old = (await self.work_current())["reference"]
        token = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="Stop", expected_event_id=token))
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(old)
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        await self.kanban(existing=True)
        new = (await self.work_current())["reference"]
        self.assertNotEqual(old["admission_id"], new["admission_id"])
        self.assertNotEqual(old["work_digest"], new["work_digest"])
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(old)
        self.assertFalse((await self.work_inspected(new))["permission_granted"])

    async def test_work_spoofed_carriers_and_claim_markers_are_refused(self):
        from agent import runtime_session_store
        from agent.delegation_context import delegated_child_context, non_dispatcher_owned_context
        from gateway.session_context import reset_session_vars, set_current_session_id
        await self.local()
        with self.assertRaises(transport.Unavailable):
            work.capture_context()  # Ordinary local/peer carriers cannot become worker registrations.
        with patch.object(runtime_session_store, "_worker_process", True), self.assertRaises(transport.Unavailable):
            await asyncio.to_thread(work.current, work.capture_context(), self.settings)
        await self.kanban()
        for scope in (delegated_child_context(), non_dispatcher_owned_context()):
            with scope, self.assertRaises(transport.Unavailable):
                work.capture_context()
        with patch.object(runtime_session_store, "_worker_process", False), self.assertRaises(transport.Unavailable):
            work.capture_context()
        reset_session_vars()
        with patch.dict(os.environ, {"HERMES_SESSION_ID": self.sid, "HERMES_KANBAN_TASK": self.task_id,
                                     "HERMES_SESSION_SOURCE": "kanban"}):
            with self.assertRaises(transport.Unavailable):
                work.capture_context()
        set_current_session_id(self.sid)
        self.board.execute("UPDATE task_events SET payload=? WHERE kind='worker_bound' AND task_id=?",
                           (json.dumps({"pid": os.getpid(), "claim_lock": "spoof"}), self.task_id))
        with self.assertRaises(transport.Unavailable):
            await self.work_current()

    async def test_work_tracked_read_transaction_preserves_a_live_board_write_lock(self):
        from hermes_cli.sqlite_safe_read import connect_tracked, has_live_connection
        import sqlite3
        await self.kanban()
        self.assertTrue(has_live_connection(self.board_path))
        self.board.execute("BEGIN IMMEDIATE")
        try:
            evidence = await self.work_inspected((await self.work_current())["reference"])
            self.assertFalse(evidence["permission_granted"])
            competing = connect_tracked(self.board_path, timeout=0.01, isolation_level=None)
            try:
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    competing.execute("BEGIN IMMEDIATE")
            finally:
                competing.close()
            self.assertTrue(self.board.in_transaction)
            self.assertTrue(has_live_connection(self.board_path))
        finally:
            self.board.rollback()

    async def test_stop_checkpoint_capability_distinguishes_unknown_clear_and_pending(self):
        from gateway import session_ancillary
        from linear_native_db import settle_session_input
        await self.local()
        interactive = (await self.current())["reference"]
        supported = callable(getattr(session_ancillary, "process_stop_pending", None))
        # An in-flight Stop retains a started receipt. A supported pending
        # checkpoint refuses; the older ABI reports unknown, never clear.
        # Adopt only a finite interrupt endpoint so the older Core does not
        # need its unrelated gateway bootstrap to inspect a cached-agent slot.
        self.authority.adopt_agent(self.sid, self.row["generation"], SimpleNamespace(interrupt=lambda *args: None))
        await self.authority.interrupt(self.conn.actor, self.ref, self.row["generation"])
        if supported:
            with self.assertRaises(transport.Unavailable):
                await self.inspected(interactive)
        else:
            evidence = await self.inspected(interactive)
            self.assertEqual(evidence["stop_evidence"]["state"], "unknown")
            self.assertFalse(evidence["stop_evidence"]["quiescence_proven"])
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        with self.assertRaises(transport.Unavailable):
            await self.inspected(interactive)
        await self.kanban()
        current = (await self.work_current())["reference"]
        self.assertEqual((await self.work_inspected(current))["stop_evidence"]["state"], "clear" if supported else "unknown")
        # The corrective core's existing getter reads a single native meta checkpoint. Test
        # that optional ABI against real native RO state, without changing the pinned core.
        key = "fixture.pending.stop." + self.sid
        with patch.object(session_ancillary, "process_stop_pending", lambda db, sid: db.state_meta.get("fixture.pending.stop." + sid), create=True):
            clear = (await self.work_current())["reference"]
            self.assertEqual((await self.work_inspected(clear))["stop_evidence"]["state"], "clear")
            self.db.set_meta(key, "1:1")
            with self.assertRaises(transport.Unavailable):
                await self.work_inspected(clear)
            with self.assertRaises(transport.Unavailable):
                await self.work_current()
            await self.local()
            self.db.set_meta("fixture.pending.stop." + self.sid, "1:1")
            with self.assertRaises(transport.Unavailable):
                await self.current()

    async def test_work_newer_stop_during_inspection_is_rechecked(self):
        from hermes_cli import kanban_db as kb
        await self.kanban()
        ref = (await self.work_current())["reference"]
        count = 0
        def stop(method, params):
            nonlocal count
            count += 1
            if count == 2:
                kb.block_task(self.board, self.task_id, kind="needs_input", reason="new Stop")
        self.before_rpc = stop
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(ref)

    async def test_work_restart_and_settlement_invalidate_without_invented_requester(self):
        from linear_native_db import begin_runtime_epoch, settle_session_input
        await self.kanban()
        ref = (await self.work_current())["reference"]
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(ref)
        self.authority.epoch = begin_runtime_epoch(self.db, instance_id="new-owner")
        self.authority.instance_id = "new-owner"
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(ref)

    async def test_surfaces_preserve_original_principal_and_scope_without_grant(self):
        for platform in ("local", "telegram", "slack", "api_server"):
            with self.subTest(platform=platform):
                if platform == "local":
                    await self.local()
                elif platform == "api_server":
                    await self.api()
                else:
                    await self.messaging(platform)
                current = await self.current()
                self.assertEqual(set(current), {"reference", "permission_granted"})
                self.assertFalse(current["permission_granted"])
                evidence = await self.inspected(current["reference"])
                self.assertEqual(evidence["original_message"], "Take over ABC-1")
                self.assertEqual(evidence["scope"], origin.scope(self.settings))
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual(evidence["requester"]["principal_id"], self.row["principal_id"])
                if platform == "api_server":
                    self.assertEqual(evidence["requester"]["kind"], "api_credential")
                    self.assertEqual(evidence["requester"]["principal"], "principal:fixture:" + "a" * 32)
                self.assertEqual(evidence["reference"]["admission_id"], self.admission)
                self.assertNotIn("session_id", evidence["reference"])
                self.assertNotIn("input_id", evidence["reference"])

    async def test_desktop_chat_supplies_origin_for_its_authenticated_owner(self):
        # Review 1 Nov: an adopted Desktop chat keeps stored source "desktop", which was refused.
        await self.desktop()
        current = await self.current()
        self.assertEqual(set(current), {"reference", "permission_granted"})
        self.assertFalse(current["permission_granted"])
        self.assertEqual(current["reference"]["admission_id"], self.admission)
        evidence = await self.inspected(current["reference"])
        self.assertEqual(evidence["original_message"], "Take over ABC-1")
        self.assertEqual(evidence["requester"], {"principal_id": self.conn.actor.subject,
                                                 "kind": "local_principal", "platform": "local"})
        self.assertEqual(evidence["policy"]["source"], "gui")
        self.assertFalse(evidence["permission_granted"])

    async def test_desktop_label_without_the_native_owner_is_still_refused(self):
        from linear_native_db import admit_session_input, settle_session_input
        await self.desktop()
        # Input admitted for someone other than the conversation's authenticated owner.
        settle_session_input(self.db, epoch=self.authority.epoch,
            admission_id=self.admission, generation=self.row["generation"], outcome="interrupted")
        row = admit_session_input(self.db, epoch=self.authority.epoch, principal_id="uid:someone-else",
                                  session_id=self.sid, request_id="foreign-request", payload={"text": "Take over ABC-1"})
        self.admission = row["admission_id"]
        self.claim()
        with self.assertRaises(transport.Unavailable):
            await self.current()
        # A legacy Desktop host binds platform "desktop" and has no native owner receipt.
        self.bind("desktop", self.sid, source="desktop")
        with self.assertRaisesRegex(transport.Unavailable, "Desktop"):
            await self.current()

    async def test_messaging_input_cannot_borrow_a_desktop_label(self):
        await self.messaging("telegram")
        self.db._execute_write(lambda c: c.execute("UPDATE sessions SET source='desktop' WHERE id=?", (self.sid,)))
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_desktop_work_reports_resolve_to_the_desktop_conversation(self):
        # Chat updates use native Kanban notify subscriptions. From an adopted Desktop turn the
        # subscription targets the native local route for this conversation with a single 'wake'
        # delivery (core #206: one delivery per completion, not notify+wake), and the owner's
        # read-only delivery handle resolves that same live Desktop session.
        from tools.kanban_tools import _resolve_notify_target
        await self.desktop()
        target = _resolve_notify_target()
        self.assertEqual((target["platform"], target["chat_id"], target["delivery_mode"]),
                         ("local", self.sid, "wake"))
        handle = await self.conn.dispatch({"id": 901, "method": "session.delivery_handle",
                                           "params": {"session_id": target["chat_id"]}})
        self.assertEqual(handle.get("result", {}).get("session_id"), self.sid, handle)
        self.assertEqual(handle["result"]["stored_session_id"], self.sid)
        self.assertEqual(handle["result"]["profile_id"], str(self.home))
        live = self.authority.sessions[self.sid].source  # What the native local adapter delivers to.
        self.assertEqual((live.platform.value, live.chat_id), (target["platform"], target["chat_id"]))
        # The origin reference from the same turn still verifies after the delivery read.
        self.assertEqual((await self.current())["reference"]["admission_id"], self.admission)

    async def test_native_registered_tool_captures_the_actual_current_caller(self):
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from tools.registry import registry
        await self.local()
        self.config["plugins"] = {"entries": {"linear": {"settings": {"enabled": True, **self.settings}}}}
        (self.home / "config.yaml").write_text(json.dumps(self.config))
        manager = PluginManager(scope_key=str(self.home))
        self.addCleanup(manager.unload)
        plugin.register(PluginContext(PluginManifest(name="linear"), manager))
        handler = registry.get_entry("linear", scope=str(self.home)).handler
        result = json.loads(await asyncio.to_thread(handler, {"action": "origin_reference"}))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["reference"]["admission_id"], self.admission)
        self.assertFalse(result["permission_granted"])
        self.assertEqual((await self.inspected(result["reference"]))["original_message"], "Take over ABC-1")
        denied = json.loads(await asyncio.to_thread(handler, {"action": "origin_reference", "session_id": "forged"}))
        self.assertFalse(denied["ok"])

    async def test_queued_input_and_other_history_are_not_dumped(self):
        from gateway.session_contract import Submission
        await self.local()
        self.db.append_message(self.sid, "user", "UNRELATED_PRIVATE_HISTORY")
        await self.authority.submit(self.conn.actor, Submission("queued", self.ref, {"text": "QUEUED_PRIVATE_TEXT"}, "queue"))
        evidence = await self.inspected((await self.current())["reference"])
        serialized = json.dumps(evidence)
        self.assertNotIn("UNRELATED_PRIVATE_HISTORY", serialized)
        self.assertNotIn("QUEUED_PRIVATE_TEXT", serialized)
        self.assertEqual(evidence["original_message"], "Take over ABC-1")

    async def test_changed_scope_and_spoofed_reference_are_refused(self):
        await self.local()
        ref = (await self.current())["reference"]
        for key, value in (("profile", "foreign"), ("session_id", "foreign"), ("admission_id", "foreign"),
                           ("input_id", "foreign"), ("execution_generation", ref["execution_generation"] + 1),
                           ("authority_epoch", ref["authority_epoch"] + 1), ("instance_id", "restarted")):
            with self.subTest(key=key), self.assertRaises(transport.Unavailable):
                await self.inspected({**ref, key: value})
        self.settings["identity"]["teams"] = ["different-team"]
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)

    async def test_stop_or_settlement_between_reference_and_inspection_invalidates(self):
        from linear_native_db import settle_session_input
        await self.local()
        ref = (await self.current())["reference"]
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)

    async def test_stop_during_read_is_rechecked(self):
        from linear_native_db import settle_session_input
        await self.local()
        resume_count = 0
        def stop(method, params):
            nonlocal resume_count
            if method == "prompt.receipt":
                resume_count += 1
                if resume_count == 2:
                    settle_session_input(self.db, epoch=self.authority.epoch,
                        admission_id=self.admission, generation=self.row["generation"], outcome="interrupted")
        self.before_rpc = stop
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_child_bot_and_producer_origins_are_refused(self):
        await self.local(extra={"turn_author": {"id": "bot:peer", "is_bot": True}})
        with self.assertRaises(transport.Unavailable):
            await self.current()
        context = transport.capture_context()
        with self.assertRaises(transport.Unavailable):
            await asyncio.to_thread(origin.current, replace(context, delegated_child=True), self.settings)
        await self.local(source="tool")
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_api_without_authenticated_transfer_principal_is_refused(self):
        await self.api()
        payload = self.row["payload"]
        ref = (await self.current())["reference"]
        for auth in (None, {"principal": "Ken", "transport_family": "local-api"},
                     {"principal": "opaque-unknown", "transport_family": "remote-api"}):
            with self.subTest(auth=auth):
                payload["api_turn_v1"]["transfer_auth"] = auth
                self.db._execute_write(lambda c: c.execute(
                    "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))
                with self.assertRaises(transport.Unavailable):
                    await self.current()
                with self.assertRaises(transport.Unavailable):
                    await self.inspected(ref)

    async def test_native_bot_and_caller_identity_mismatch_are_refused(self):
        await self.messaging("telegram")
        context = transport.capture_context()
        with self.assertRaises(transport.Unavailable):
            await asyncio.to_thread(origin.current, replace(context, user_id="forged"), self.settings)
        payload = self.row["payload"]
        payload["native_text_v1"]["source"]["is_bot"] = True
        self.db._execute_write(lambda c: c.execute(
            "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_compression_tips_keep_the_original_admission_on_each_surface(self):
        for platform in ("local", "telegram", "slack", "api_server"):
            with self.subTest(platform=platform):
                if platform == "local":
                    await self.local()
                elif platform == "api_server":
                    await self.api()
                else:
                    await self.messaging(platform)
                original = (await self.current())["reference"]
                stored = self.db.get_session(self.sid)
                tip = self.sid + "-compressed"
                self.db.publish_compression_child(parent_session_id=self.sid, child_session_id=tip,
                    source=stored["source"], messages=[{"role": "user", "content": "Synthetic compression checkpoint"}],
                    require_compression_lease=False)
                from gateway.session_context import set_current_session_id
                set_current_session_id(tip)
                compressed = (await self.current())["reference"]
                self.assertEqual(compressed, original)
                self.assertEqual((await self.inspected(compressed))["reference"]["admission_id"], self.admission)

    async def reset_current_origin(self, *, compress_before=False, compress_after=False):
        from gateway.session_context import set_current_session_id
        from linear_native_db import local_receipt
        from linear_native_db import reset_local_target, local_physical_target
        from linear_native_db import settle_session_input, admit_session_input
        await self.local()
        old = (await self.current())["reference"]
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="completed")
        self.authority.executing.pop(self.sid, None)
        parent = self.sid
        if compress_before:
            parent = self.sid + "-compressed"
            self.db.publish_compression_child(parent_session_id=self.sid, child_session_id=parent,
                source="gui", messages=[{"role": "user", "content": "Native checkpoint before reset"}],
                require_compression_lease=False)
        saved = local_receipt(self.db, self.sid)
        tip = parent + "-reset"
        reset_local_target(self.db, epoch=self.authority.epoch, parent_session_id=parent,
                           entry={**saved["entry"], "session_id": tip})
        if compress_after:
            compressed = tip + "-compressed"
            self.db.publish_compression_child(parent_session_id=tip, child_session_id=compressed,
                source="gui", messages=[{"role": "user", "content": "Native checkpoint after reset"}],
                require_compression_lease=False)
            tip = compressed
        row = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="request-after-reset",
            payload={"text": "Take over remaining work after reset"})
        self.admission = row["admission_id"]
        self.claim()
        set_current_session_id(tip)
        self.assertEqual(local_physical_target(self.db, self.sid), tip)
        return old, tip

    async def test_origin_native_reset_and_compression_resolve_the_current_logical_admission(self):
        import argparse
        from gateway.session_authorities import admission_owner
        from hermes_fleet_linear_plugin import ops
        for before, after in ((False, False), (True, False), (False, True)):
            with self.subTest(compress_before=before, compress_after=after):
                old, tip = await self.reset_current_origin(compress_before=before, compress_after=after)
                self.assertEqual(admission_owner(self.authority, tip), self.sid)
                self.assertNotEqual(self.db.get_compression_lineage(tip)[0], self.sid)
                retained = self.db._read_all("SELECT * FROM session_admissions")
                result = await self.current()
                ref = result["reference"]
                self.assertEqual(ref["admission_id"], self.admission)
                self.assertNotEqual(ref, old)
                evidence = await self.inspected(ref)
                self.assertEqual(evidence["original_message"], "Take over remaining work after reset")
                self.assertFalse(evidence["permission_granted"])
                with self.assertRaises(transport.Unavailable):
                    await self.inspected(old)
                parser = argparse.ArgumentParser()
                ops.setup(parser)
                args = parser.parse_args(["inspect-origin", "--reference-json", json.dumps(ref)])
                with patch("builtins.print") as printed:
                    code = await asyncio.to_thread(ops.run, args, self.home / "unused", self.home / "unused",
                                                   "default", origin_settings=self.settings)
                self.assertEqual(code, 0)
                self.assertFalse(json.loads(printed.call_args.args[0])["permission_granted"])
                self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), retained)

    async def test_origin_native_reset_preserves_readback_stop_and_active_mutation_guards(self):
        from gateway import session_ancillary
        from linear_native_db import local_receipt
        from linear_native_db import reset_local_target
        from linear_native_db import RuntimeStoreError, settle_session_input
        _, tip = await self.reset_current_origin(compress_after=True)
        ref = (await self.current())["reference"]
        saved = local_receipt(self.db, self.sid)
        with self.assertRaises(RuntimeStoreError):
            reset_local_target(self.db, epoch=self.authority.epoch, parent_session_id=tip,
                               entry={**saved["entry"], "session_id": tip + "-forbidden"})
        self.assertEqual(local_receipt(self.db, self.sid), saved)
        self.assertFalse((await self.inspected(ref))["permission_granted"])
        original = self.db._read_one("SELECT payload_json FROM session_admissions WHERE admission_id=?",
                                             (self.admission,))[0]
        self.during_origin_readback(lambda: self.retained_origin_payload(
            lambda payload: payload.update(text="Changed during post-reset owner receipt")))
        try:
            with self.assertRaises(transport.Unavailable):
                await self.inspected(ref)
        finally:
            self.before_rpc = None
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (original, self.admission)))
        self.assertFalse((await self.inspected(ref))["permission_granted"])
        self.authority.adopt_agent(self.sid, self.row["generation"], SimpleNamespace(interrupt=lambda *args: None))
        await self.authority.interrupt(self.conn.actor, self.ref, self.row["generation"])
        if callable(getattr(session_ancillary, "process_stop_pending", None)):
            with self.assertRaises(transport.Unavailable):
                await self.inspected(ref)
        else:
            self.assertEqual((await self.inspected(ref))["stop_evidence"]["state"], "unknown")
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                             generation=self.row["generation"], outcome="interrupted")
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)

    async def test_work_native_compression_keeps_its_admission_and_reset_remains_guarded(self):
        from gateway.session_context import set_current_session_id
        from linear_native_db import local_receipt
        from linear_native_db import reset_local_target
        from linear_native_db import RuntimeStoreError
        await self.kanban()
        ref = (await self.work_current())["reference"]
        saved = local_receipt(self.db, self.sid)
        with self.assertRaises(RuntimeStoreError):
            reset_local_target(self.db, epoch=self.authority.epoch, parent_session_id=self.sid,
                               entry={**saved["entry"], "session_id": self.sid + "-forbidden"})
        self.assertEqual(local_receipt(self.db, self.sid), saved)
        tip = self.sid + "-compressed"
        self.db.publish_compression_child(parent_session_id=self.sid, child_session_id=tip,
            source="kanban", messages=[{"role": "user", "content": "Native worker compression checkpoint"}],
            require_compression_lease=False)
        set_current_session_id(tip)
        self.assertEqual((await self.work_current())["reference"], ref)
        self.assertFalse((await self.work_inspected(ref))["permission_granted"])
        saved = local_receipt(self.db, self.sid)
        with self.assertRaises(RuntimeStoreError):
            reset_local_target(self.db, epoch=self.authority.epoch, parent_session_id=tip,
                               entry={**saved["entry"], "session_id": tip + "-forbidden"})
        self.assertEqual(local_receipt(self.db, self.sid), saved)
        self.assertFalse((await self.work_inspected(ref))["permission_granted"])

    async def test_owner_restart_invalidates_a_previously_valid_reference(self):
        from linear_native_db import begin_runtime_epoch
        await self.local()
        ref = (await self.current())["reference"]
        self.authority.epoch = begin_runtime_epoch(self.db, instance_id="restarted")
        self.authority.instance_id = "restarted"
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)

    async def test_origin_projection_does_not_change_native_state(self):
        await self.local()
        before = self.db._read_all("SELECT * FROM session_admissions")
        sessions = self.db._read_all("SELECT * FROM sessions")
        evidence = await self.inspected((await self.current())["reference"])
        self.assertEqual(self.db._read_all("SELECT * FROM session_admissions"), before)
        self.assertEqual(self.db._read_all("SELECT * FROM sessions"), sessions)
        self.assertFalse(evidence["permission_granted"])

    async def test_native_steering_transfer_is_ambiguous(self):
        from linear_native_db import admit_session_input, steer_session_input
        await self.local()
        queued = admit_session_input(self.db, epoch=self.authority.epoch, principal_id="operator",
            session_id=self.sid, request_id="steer", payload={"text": "different instruction"})
        steer_session_input(self.db, epoch=self.authority.epoch, admission_id=queued["admission_id"],
                            generation=self.row["generation"])
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_unknown_execution_does_not_become_requester_authority(self):
        await self.local()
        self.db._execute_write(lambda c: c.execute(
            "UPDATE session_admissions SET status='unknown' WHERE admission_id=?", (self.admission,)))
        with self.assertRaises(transport.Unavailable):
            await self.current()

    async def test_native_reconciled_unknown_history_does_not_block_a_new_request(self):
        from linear_native_db import (admit_session_input, begin_runtime_epoch, claim_session_input,
            recover_session_inputs, resolve_unknown_session_input, RuntimeStoreError)
        await self.local()
        old_id, old_generation = self.admission, self.row["generation"]
        self.authority.epoch = begin_runtime_epoch(self.db, instance_id="recovered")
        self.authority.instance_id = "recovered"
        recover_session_inputs(self.db, epoch=self.authority.epoch)
        new = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="new-request",
            payload={"text": "Take over a new increment of ABC-1"})
        # The native owner itself prohibits execution behind unresolved uncertainty.
        with self.assertRaisesRegex(RuntimeStoreError, "unknown_execution"):
            claim_session_input(self.db, epoch=self.authority.epoch, session_id=self.sid)
        resolve_unknown_session_input(self.db, epoch=self.authority.epoch,
                                      admission_id=old_id, generation=old_generation)
        self.admission = new["admission_id"]
        self.claim()
        evidence = await self.inspected((await self.current())["reference"])
        self.assertEqual(evidence["original_message"], "Take over a new increment of ABC-1")
        self.assertNotEqual(evidence["reference"]["admission_id"], old_id)

    async def test_old_steering_history_does_not_block_the_current_generation(self):
        from linear_native_db import admit_session_input, steer_session_input, settle_session_input
        await self.local()
        old_generation = self.row["generation"]
        steering = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="old-steer",
            payload={"text": "Earlier bounded clarification"})
        steer_session_input(self.db, epoch=self.authority.epoch,
                            admission_id=steering["admission_id"], generation=old_generation)
        settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
            generation=old_generation, outcome="completed", _transfers={steering["admission_id"]: True})
        later = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="later",
            payload={"text": "Take over the remaining work on ABC-1"})
        self.admission = later["admission_id"]
        self.claim()
        evidence = await self.inspected((await self.current())["reference"])
        self.assertGreater(evidence["reference"]["execution_generation"], old_generation)
        self.assertEqual(evidence["original_message"], "Take over the remaining work on ABC-1")


    async def test_cleanup_partial_conflicting_and_opaque_checkpoint_ownership_is_unknown(self):
        await self.stopped_issue()
        route = self.authority.sessions[self.sid].route
        entries = [{}, {"session_key": route}, {"parent_session_id": self.sid},
                   {"session_key": "foreign", "parent_session_id": self.sid},
                   {"session_key": route, "parent_session_id": "foreign"},
                   {"session_key": "foreign", "parent_session_id": "foreign", "owner_task_id": self.sid}]
        for entry in entries:
            entry.update(pid=os.getpid(), systemd_unit="unresolved-private-scope")
            with self.subTest(entry=entry):
                (self.home / "processes.json").write_text(json.dumps([entry]))
                evidence = await self.cleanup_inspected()
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "checkpoint_ownership_ambiguous")
                self.assertFalse(evidence["permission_granted"])
                self.assertNotIn("unresolved-private-scope", json.dumps(evidence))

    async def test_cleanup_native_spawn_before_admission_stays_unknown(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _set_worker_pid, _process_fingerprint
        from gateway import session_ancillary
        getter = getattr(session_ancillary, "process_stop_pending", None)
        await self.stopped_issue()
        # Use the real candidate getter when supported; the release pin retains
        # the explicitly labelled read-only fixture getter from stopped_issue.
        if getter is not None:
            self.enterContext(patch.object(session_ancillary, "process_stop_pending", getter))
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="transient", reason="temporary retry"))
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        task = kb.claim_task(self.board, self.task_id, claimer="fixture-second-claim")
        self.assertIsNotNone(task)
        _set_worker_pid(self.board, self.task_id, os.getpid(), run_id=task.current_run_id, claim_lock=task.claim_lock)
        self.assertIsNotNone(_process_fingerprint(os.getpid()))
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="Stop before native admission"))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        evidence = await self.cleanup_inspected()
        self.assertFalse(evidence["quiescence_proven"])
        # Original native admission binding is validated before any positive
        # live-PID reuse proof; this spawned-but-unadmitted attempt stays held.
        self.assertEqual(evidence["reason"], "attempt_native_admission_missing_or_ambiguous")
        self.assertFalse(evidence["permission_granted"])

    async def test_cleanup_unadmitted_attempt_without_recorded_worker_is_unknown(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="transient"))
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        task = kb.claim_task(self.board, self.task_id, claimer="fixture-unadmitted-claim")
        self.assertIsNotNone(task)
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="unadmitted Stop"))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        evidence = await self.cleanup_inspected()
        self.assertFalse(evidence["quiescence_proven"])
        self.assertEqual(evidence["reason"], "attempt_native_admission_missing_or_ambiguous")

    async def test_cleanup_two_admitted_attempts_check_old_run_state_and_worker(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        old = dict(self.board.execute("SELECT * FROM task_runs WHERE id=?", (self.work_context["run_id"],)).fetchone())
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        # A reason-free parked transient transition resets the native recurrence
        # policy without synthesizing an unexecuted handoff run.
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="transient"))
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        await self.stopped_issue(existing=True)
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(len(evidence["attempts"]), 2)
        for changes in ({"status": "running"}, {"status": "unknown"}, {"ended_at": None}, {"profile": "foreign"},
                        {"worker_pid": os.getpid(), "worker_started_at": _process_fingerprint(os.getpid())}):
            with self.subTest(changes=changes):
                for key, value in changes.items():
                    self.board.execute("UPDATE task_runs SET " + key + "=? WHERE id=?", (value, old["id"]))
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                for key in changes:
                    self.board.execute("UPDATE task_runs SET " + key + "=? WHERE id=?", (old[key], old["id"]))
        old_binding = dict(self.board.execute("SELECT * FROM task_events WHERE run_id=? AND kind='owner_admitted'",
                                              (old["id"],)).fetchone())
        self.board.execute("DELETE FROM task_events WHERE id=?", (old_binding["id"],))
        self.assertEqual((await self.cleanup_inspected())["reason"], "attempt_native_admission_missing_or_ambiguous")
        columns = ",".join(old_binding)
        self.board.execute("INSERT INTO task_events (" + columns + ") VALUES (" + ",".join("?" for _ in old_binding) + ")",
                           tuple(old_binding.values()))
        def old_run_change(method, params):
            self.before_rpc = None
            self.board.execute("UPDATE task_runs SET summary='changed while inspecting' WHERE id=?", (old["id"],))
        self.before_rpc = old_run_change
        self.assertEqual((await self.cleanup_inspected())["reason"], "cleanup_evidence_changed")

    async def test_cleanup_orphan_and_ambiguous_attempt_events_never_disappear(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        for kind in ("owner_admitted", "spawned", "worker_registered", "worker_bound"):
            with self.subTest(kind=kind), kb.write_txn(self.board):
                kb._append_event(self.board, self.task_id, kind,
                    {"pid": 99999999, "started_at": self.process_witness(2)}, run_id=999999)
            evidence = await self.cleanup_inspected()
            self.assertFalse(evidence["quiescence_proven"])
            self.board.execute("DELETE FROM task_events WHERE id=(SELECT MAX(id) FROM task_events WHERE task_id=?)", (self.task_id,))
        binding = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind='owner_admitted'", (self.task_id,)).fetchone()
        with kb.write_txn(self.board):
            kb._append_event(self.board, self.task_id, "owner_admitted", json.loads(binding["payload"]), run_id=binding["run_id"])
        self.assertEqual((await self.cleanup_inspected())["reason"], "admission_after_stop_or_missing")
        token = kb.list_events(self.board, self.task_id)[-1].id
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", expected_event_id=token))
        self.stop_id = kb.list_events(self.board, self.task_id)[-1].id
        self.assertEqual((await self.cleanup_inspected())["reason"], "attempt_native_admission_missing_or_ambiguous")

    async def test_cleanup_retained_native_job_scope_requires_native_owner_retirement(self):
        from gateway import session_ancillary
        from hermes_cli import kanban_db as kb
        getter = getattr(session_ancillary, "process_stop_pending", None)
        await self.stopped_issue()
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="transient"))
        self.assertTrue(kb.unblock_task(self.board, self.task_id))
        await self.stopped_issue(existing=True)
        if getter is not None:
            self.enterContext(patch.object(session_ancillary, "process_stop_pending", getter))
        entry = {"session_id": "proc_cleanup_fixture", "session_key": self.authority.sessions[self.sid].route,
                 "parent_session_id": self.sid, "owner_task_id": self.sid, "pid": 99999997,
                 "host_start_time": 123, "pid_scope": "host", "native_job_scope": True}
        checkpoint = self.home / "processes.json"
        receipt_path = self.home / "logs" / "process-output" / "proc_cleanup_fixture.scope.exit"
        receipt_path.parent.mkdir(parents=True)
        # Adversarial receipt-like fixtures, never an actual kernel exit claim.
        # Even a structurally affirmative file cannot replace native retirement:
        # pending reader/output ownership settlement also retains the checkpoint.
        positive = {"version": 1, "pid": entry["pid"], "birth": entry["host_start_time"],
                    "quiescent": True, "exit_code": 0}
        receipts = [None, "malformed", {**positive, "quiescent": False}, {**positive, "pid": 99999996},
                    {**positive, "birth": 124}, {**positive, "exit_code": None}, positive]
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                if receipt is None:
                    receipt_path.unlink(missing_ok=True)
                else:
                    receipt_path.write_text(receipt if isinstance(receipt, str) else json.dumps(receipt))
                checkpoint.write_text(json.dumps([entry]))
                before = checkpoint.read_bytes()
                evidence = await self.cleanup_inspected()
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "scoped_process_cleanup_unknown")
                self.assertFalse(evidence["permission_granted"])
                self.assertEqual(checkpoint.read_bytes(), before)
        for flag in (1, 0, None, "false", "true"):
            with self.subTest(flag=flag):
                checkpoint.write_text(json.dumps([{**entry, "native_job_scope": flag,
                                                  "pid": os.getpid(), "host_start_time": 1}]))
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        # Model only the owner's later checkpoint retirement in this finite
        # fixture; inspection itself never performs cleanup or writes the file.
        checkpoint.write_text("[]")
        retired = await self.cleanup_inspected()
        self.assertTrue(retired["quiescence_proven"], retired)
        self.assertEqual(len(retired["attempts"]), 2)
        # A positively foreign managed scope is preserved and excluded, never
        # used to discharge the inspected task or exposed in its evidence.
        checkpoint.write_text(json.dumps([{**entry, "session_key": "foreign", "parent_session_id": "foreign",
                                          "owner_task_id": "foreign"}]))
        before = checkpoint.read_bytes()
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.assertEqual(checkpoint.read_bytes(), before)
        def newly_retained(method, params):
            self.before_rpc = None
            checkpoint.write_text(json.dumps([entry]))
        self.before_rpc = newly_retained
        raced = await self.cleanup_inspected()
        self.assertFalse(raced["quiescence_proven"])
        self.assertEqual(raced["reason"], "scoped_process_cleanup_unknown")

    async def test_cleanup_saved_manual_binding_cannot_hide_another_matching_live_task(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _set_worker_pid
        await self.stopped_issue()
        other = kb.create_task(self.board, title="Retained work on the same issue", assignee="default",
                               idempotency_key="linear:issue-one")
        claimed = kb.claim_task(self.board, other, claimer="fixture-other-claim")
        _set_worker_pid(self.board, other, os.getpid(), run_id=claimed.current_run_id, claim_lock=claimed.claim_lock)
        self.assertTrue(kb.block_task(self.board, other, kind="needs_input", reason="Stop before admission"))
        evidence = await self.cleanup_inspected()
        self.assertFalse(evidence["quiescence_proven"])
        self.assertEqual(evidence["reason"], "native_history_match_missing_or_ambiguous")
        self.assertFalse(evidence["permission_granted"])

    async def test_cleanup_single_saved_target_and_unrelated_live_work_remain_readable(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _set_worker_pid
        await self.stopped_issue()
        self.board.execute("UPDATE tasks SET idempotency_key='linear:issue-one' WHERE id=?", (self.task_id,))
        other = kb.create_task(self.board, title="Work on a different issue", assignee="default",
                               idempotency_key="linear:another-issue")
        claimed = kb.claim_task(self.board, other, claimer="fixture-unrelated-claim")
        _set_worker_pid(self.board, other, os.getpid(), run_id=claimed.current_run_id, claim_lock=claimed.claim_lock)
        evidence = await self.cleanup_inspected()
        self.assertTrue(evidence["quiescence_proven"], evidence)
        self.assertEqual(evidence["task_id"], self.task_id)
        self.assertEqual(evidence["discovery_source"], "saved_native_binding")

    async def test_cleanup_same_snapshot_rechecks_tasks_created_after_discovery(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin.bridge import Kanban
        await self.stopped_issue()
        original = Kanban.discover
        inserted = []
        def racing(reader, issue):
            found = original(reader, issue)
            if not inserted:
                from hermes_cli.kanban_db_connect import _sqlite_connect
                from contextlib import closing
                with closing(_sqlite_connect(self.board_path)) as writer:
                    writer.row_factory = __import__("sqlite3").Row
                    inserted.append(kb.create_task(writer, title="New matching executor", assignee="default",
                                                   idempotency_key="linear:issue-one"))
            return found
        with patch.object(Kanban, "discover", racing):
            evidence = await self.cleanup_inspected()
        self.assertTrue(inserted, evidence)
        self.assertFalse(evidence["quiescence_proven"])
        self.assertEqual(evidence["reason"], "native_history_match_missing_or_ambiguous")

    async def test_cleanup_matching_task_arriving_during_receipt_readback_invalidates(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        def arriving(method, params):
            self.before_rpc = None
            kb.create_task(self.board, title="New matching task", assignee="default", idempotency_key="linear:issue-one")
        self.before_rpc = arriving
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_strict_predicate_keys_and_native_event_normalization_precede_selection(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        cases = [(b"\xff", self.work_context["run_id"], "spawned", False),
                 (self.task_id.encode(), self.work_context["run_id"], "spawned", False),
                 (self.task_id, b"\xff", "spawned", False),
                 (self.task_id, self.work_context["run_id"], b"spawned", False),
                 (self.task_id, self.work_context["run_id"], "spawned", True)]
        for task_key, run_key, kind, negative in cases:
            with self.subTest(task_key=task_key, run_key=run_key, kind=kind, negative=negative):
                with kb.write_txn(self.board):
                    kb._append_event(self.board, task_key, kind, {"pid": os.getpid(),
                        "started_at": _process_fingerprint(os.getpid())}, run_id=run_key)
                    event_id = self.board.execute("SELECT MAX(id) FROM task_events").fetchone()[0]
                    if negative:
                        self.board.execute("UPDATE task_events SET id=-1 WHERE id=?", (event_id,))
                        event_id = -1
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                self.board.execute("DELETE FROM task_events WHERE id=?", (event_id,))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_corrupt_retained_run_predicate_key_is_not_foreign_absence(self):
        await self.stopped_issue()
        original = dict(self.board.execute("SELECT * FROM task_runs WHERE id=?", (self.work_context["run_id"],)).fetchone())
        for field, value in (("task_id", b"\xff"), ("status", b"running"), ("ended_at", "not-a-native-epoch")):
            with self.subTest(field=field):
                self.board.execute("UPDATE task_runs SET " + field + "=? WHERE id=?", (value, original["id"]))
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                self.board.execute("UPDATE task_runs SET " + field + "=? WHERE id=?", (original[field], original["id"]))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_saved_binding_checks_other_boards_and_archived_matching_work(self):
        from contextlib import closing
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_connect import _sqlite_connect
        from hermes_cli.kanban_db_dispatch import _set_worker_pid
        await self.stopped_issue()
        slug = "retained-project"
        kb.create_board(slug)
        with closing(_sqlite_connect(kb.kanban_db_path(board=slug))) as other_board:
            other_board.row_factory = __import__("sqlite3").Row
            other = kb.create_task(other_board, title="Retained executor in another board", assignee="default",
                                   idempotency_key="linear:issue-one", board=slug)
            claimed = kb.claim_task(other_board, other, claimer="fixture-other-board")
            _set_worker_pid(other_board, other, os.getpid(), run_id=claimed.current_run_id, claim_lock=claimed.claim_lock)
            self.assertTrue(kb.block_task(other_board, other, kind="needs_input", reason="Stop before admission"))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        kb.remove_board(slug, archive=True)
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_native_birth_validation_refuses_malformed_and_unreadable_witnesses(self):
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        real = _process_fingerprint(os.getpid())
        self.assertIsNotNone(real)
        epoch, start = real.split("|")
        def bound(pid, fingerprint):
            self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
                (json.dumps({"pid": pid, "started_at": fingerprint, "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        malformed = [None, True, False, 0, 1, "", "unverified", "|", "|1", "previous-unproved-epoch|1",
                     *(epoch + "|" + value for value in ("", "True", "False", "0", "-1", "nan", "inf", "-inf", "1e9999", "1|2"))]
        for witness in malformed:
            with self.subTest(witness=witness):
                bound(os.getpid(), witness)
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        # Invalid identity never becomes a gone-process proof either.
        bound(99999997, "|")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        for pid in (True, False, 0, -1, None, str(os.getpid())):
            with self.subTest(pid=pid):
                bound(pid, real)
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        for number in (start, str(float(start)), "+" + start):
            with self.subTest(number=number):
                bound(os.getpid(), epoch + "|" + number)
                self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")
        bound(os.getpid(), real)
        with patch("hermes_cli.kanban_db_dispatch._process_fingerprint", return_value=None):
            self.assertEqual((await self.cleanup_inspected())["reason"], "worker_identity_unreadable")
        with patch("gateway.drain_control.current_instantiation_epoch", return_value=""):
            self.assertEqual((await self.cleanup_inspected())["reason"], "worker_identity_unreadable")
        # Retained spawn/run records use canonical current-epoch fixture births;
        # the actual native comparator still proves known recycled and gone IDs.
        bound(os.getpid(), self.process_witness(1))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.original_worker_birth(self.earlier_native_birth())
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        bound(99999997, self.process_witness(1))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])


    async def test_cleanup_retained_symlink_and_unreadable_checkpoint_are_unknown(self):
        await self.stopped_issue()
        checkpoint = self.home / "processes.json"
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        checkpoint.symlink_to(self.home / "missing-process-records.json")
        self.assertEqual((await self.cleanup_inspected())["reason"], "checkpoint_unreadable")
        checkpoint.unlink()
        checkpoint.write_text("[]")
        original = Path.lstat
        def unreadable(path, *args, **kwargs):
            if path == checkpoint:
                raise PermissionError("finite unreadable checkpoint metadata")
            return original(path, *args, **kwargs)
        with patch.object(Path, "lstat", unreadable):
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_native_linux_birth_sources_never_prove_live_pid_recycled(self):
        import psutil
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        from hermes_cli.process_identity import process_birth
        self.assertTrue(psutil.LINUX, "this Linux source-fault fixture requires its actual platform")
        await self.stopped_issue()
        pid = os.getpid()
        direct = _process_fingerprint(pid)
        stat_path = Path("/proc/" + str(pid) + "/stat")
        original_text, original_bytes = Path.read_text, Path.read_bytes
        def failing(original):
            def read(path, *args, **kwargs):
                if path == stat_path:
                    raise PermissionError("finite direct-stat read failure")
                return original(path, *args, **kwargs)
            return read
        def bound(witness):
            self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
                (json.dumps({"pid": pid, "started_at": witness, "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        bound(direct)
        # Core reads /proc/<pid>/stat as text on older releases and as bytes on newer ones; fail both.
        with patch.object(Path, "read_text", failing(original_text)), \
                patch.object(Path, "read_bytes", failing(original_bytes)):
            fallback = _process_fingerprint(pid)
            self.assertNotEqual(direct, fallback)
            self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")
        # Persist the actual fallback, then inspect with the actual direct read restored.
        bound(fallback)
        self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")
        with patch("hermes_cli.process_identity.worker_birth", side_effect=PermissionError("finite unreadable native birth")):
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        bound(self.process_witness(1))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        # An old fallback number alone cannot prove reuse across clock steps.
        epoch = direct.split("|")[0]
        bound(epoch + "|" + str(round((process_birth(psutil.Process(pid)) - 10) * 100)))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.original_worker_birth(self.earlier_native_birth())
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        # Changing the native identity during the independent observation is unknown.
        with patch("hermes_cli.kanban_db_dispatch._process_fingerprint", side_effect=[direct, self.process_witness(1)]):
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])


    async def test_cleanup_psutil_identity_errors_are_structured_unknown(self):
        import psutil
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        pid = os.getpid()
        self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
            (json.dumps({"pid": pid, "started_at": _process_fingerprint(pid),
                         "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        actual_process = psutil.Process
        for target in ("psutil.Process", "hermes_cli.process_identity.process_birth", "hermes_cli.process_identity.worker_birth"):
            for error in (psutil.AccessDenied(pid), psutil.NoSuchProcess(pid)):
                with self.subTest(target=target, error=type(error).__name__):
                    def fault(*args, **kwargs):
                        # Race only at the independent birth lookup; keep native
                        # liveness probing real so NoSuchProcess is not an earlier
                        # authoritative gone-PID observation.
                        caller = inspect.currentframe().f_back
                        while caller and caller.f_globals.get("__name__") == "unittest.mock":
                            caller = caller.f_back
                        if target == "psutil.Process" and caller.f_code is not cleanup._pid_gone.__code__:
                            return actual_process(*args, **kwargs)
                        raise error
                    with patch(target, side_effect=fault):
                        evidence = await self.cleanup_inspected()
                    self.assertFalse(evidence["quiescence_proven"])
                    self.assertEqual(evidence["state"], "unknown")
                    self.assertEqual(evidence["reason"], "worker_identity_unreadable")
                    self.assertFalse(evidence["permission_granted"])
        self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")


    async def test_cleanup_duplicate_checkpoint_keys_and_unknown_run_states_hold_proof(self):
        await self.stopped_issue()
        checkpoint = self.home / "processes.json"
        route = self.authority.sessions[self.sid].route
        for pair in (("session_key", route), ("parent_session_id", self.sid), ("systemd_unit", "owned-scope")):
            with self.subTest(pair=pair):
                key, value = pair
                checkpoint.write_text('[{"session_key":' + json.dumps(route) + ',"parent_session_id":' + json.dumps(self.sid)
                    + ',' + json.dumps(key) + ':' + json.dumps(value) + ',' + json.dumps(key) + ':"foreign"}]')
                result = await self.cleanup_inspected()
                self.assertEqual(result["reason"], "checkpoint_duplicate_key")
                self.assertFalse(result["quiescence_proven"])
        checkpoint.unlink()
        for status in ("unrecognized-state", "running", "unknown", "", "BLOCKED"):
            with self.subTest(status=status):
                self.board.execute("UPDATE task_runs SET status=? WHERE id=?", (status, self.work_context["run_id"]))
                result = await self.cleanup_inspected()
                self.assertEqual(result["reason"], "run_not_settled")
                self.assertFalse(result["quiescence_proven"])
        for status in cleanup._SETTLED_RUN_STATUSES:
            with self.subTest(status=status):
                self.board.execute("UPDATE task_runs SET status=? WHERE id=?", (status, self.work_context["run_id"]))
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_live_reuse_requires_original_matching_native_monotonic_receipt(self):
        import psutil
        from hermes_cli.process_identity import worker_birth
        await self.stopped_issue()
        # A mismatching legacy fingerprint is not an original monotonic witness.
        self.board.execute("UPDATE task_events SET payload=? WHERE task_id=? AND kind='worker_bound'",
            (json.dumps({"pid": os.getpid(), "started_at": self.process_witness(1),
                         "claim_lock": self.work_context["claim_lock"]}), self.task_id))
        event = self.board.execute("SELECT id,payload FROM task_events WHERE task_id=? AND kind='owner_admitted'", (self.task_id,)).fetchone()
        original = json.loads(event["payload"])
        for changes in ({"birth": None}, {"birth": True}, {"birth": 0}, {"birth": float("nan")},
                        {"birth": "1"}, {"pid": True}, {"pid": 1}):
            with self.subTest(changes=changes):
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps({**original, **changes}), event["id"]))
                result = await self.cleanup_inspected()
                self.assertFalse(result["quiescence_proven"])
                self.assertEqual(result["reason"], "worker_identity_unproven")
        self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (json.dumps(original), event["id"]))
        self.assertEqual((await self.cleanup_inspected())["reason"], "old_worker_alive")
        self.original_worker_birth(self.earlier_native_birth())
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        with patch("hermes_cli.process_identity.worker_birth", side_effect=[worker_birth(psutil.Process()), worker_birth(psutil.Process()) + 1]):
            self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])


    async def test_cleanup_accepts_actual_settled_admission_and_control_outcomes(self):
        from linear_native_db import (admit_session_input, claim_session_input,
            list_session_admissions, settle_session_input, steer_session_input)
        await self.stopped_issue()
        self.cancelled_control()
        for outcome in ("completed", "interrupted", "rejected", "failed"):
            with self.subTest(outcome=outcome):
                receiving = admit_session_input(self.db, epoch=self.authority.epoch,
                    principal_id=self.conn.actor.subject, session_id=self.sid, request_id="settled-history-" + outcome,
                    payload={"text": "Finite native history outcome"})
                claimed = claim_session_input(self.db, epoch=self.authority.epoch, session_id=self.sid)
                self.assertEqual(claimed["admission_id"], receiving["admission_id"])
                transferred = admit_session_input(self.db, epoch=self.authority.epoch,
                    principal_id=self.conn.actor.subject, session_id=self.sid, request_id="transfer-history-" + outcome,
                    payload={"text": "Finite bounded clarification"})
                steer_session_input(self.db, epoch=self.authority.epoch,
                    admission_id=transferred["admission_id"], generation=claimed["generation"])
                # A terminal row carrying a live native steering transfer is still held.
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                settle_session_input(self.db, epoch=self.authority.epoch,
                    admission_id=receiving["admission_id"], generation=claimed["generation"], outcome=outcome,
                    _transfers={transferred["admission_id"]: True})
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        retained = list_session_admissions(self.db, session_id=self.sid, pending_only=False)
        self.assertEqual({row["outcome"] for row in retained},
                         {"completed", "interrupted", "rejected", "failed", "cancelled", "steered"})

    async def test_cleanup_malformed_or_independent_unknown_admission_outcome_is_held(self):
        from linear_native_db import (admit_session_input, claim_session_input,
            list_session_admissions, settle_session_input)
        await self.stopped_issue()
        control = self.cancelled_control()
        for outcome in (None, "unknown", "unrecognized-state", "steering", "", "COMPLETED", b"completed", b"\xff", 123):
            with self.subTest(outcome=outcome):
                self.db._execute_write(lambda conn: conn.execute(
                    "UPDATE session_admissions SET outcome=? WHERE admission_id=?", (outcome, control["admission_id"])))
                result = await self.cleanup_inspected()
                self.assertFalse(result["quiescence_proven"])
                self.assertEqual(result["reason"], "native_session_has_unsettled_work")
                self.assertFalse(result["permission_granted"])
        # A later legitimate completion cannot discharge an independently unknown row.
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET outcome='unknown' WHERE admission_id=?", (control["admission_id"],)))
        valid = admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=self.sid, request_id="later-valid-history",
            payload={"text": "Finite later native completion"})
        claimed = claim_session_input(self.db, epoch=self.authority.epoch, session_id=self.sid)
        self.assertEqual(claimed["admission_id"], valid["admission_id"])
        settle_session_input(self.db, epoch=self.authority.epoch,
            admission_id=valid["admission_id"], generation=claimed["generation"], outcome="completed")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET status='unknown' WHERE admission_id=?", (control["admission_id"],)))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        bad = [row for row in list_session_admissions(self.db, session_id=self.sid, pending_only=False)
               if row["admission_id"] == control["admission_id"]]
        self.assertEqual((bad[0]["status"], bad[0]["outcome"]), ("unknown", "unknown"))


    async def test_cleanup_encoded_owned_predicate_keys_cannot_hide_retained_rows(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _process_fingerprint
        await self.stopped_issue()
        run = kb._synthesize_ended_run(self.board, self.task_id, outcome="completed", profile="default")
        self.board.execute("UPDATE task_runs SET task_id=?,status='running',ended_at=NULL,worker_pid=? WHERE id=?",
                           (self.task_id.encode(), os.getpid(), run))
        row = self.board.execute("SELECT * FROM task_runs WHERE id=?", (run,)).fetchone()
        self.assertEqual(kb.Run.from_row(row).task_id, self.task_id)
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("DELETE FROM task_runs WHERE id=?", (run,))
        payload = {"pid": os.getpid(), "started_at": _process_fingerprint(os.getpid())}
        for task_key, run_key in ((self.task_id.encode(), None),
                                  ("foreign", str(self.work_context["run_id"]).encode()),
                                  ("foreign", self.work_context["run_id"] + 0.5)):
            with self.subTest(task_key=task_key, run_key=run_key):
                kb._append_event(self.board, task_key, "spawned", payload, run_id=run_key)
                event = self.board.execute("SELECT * FROM task_events ORDER BY id DESC LIMIT 1").fetchone()
                if run_key is not None:
                    self.assertEqual(kb.Event.from_row(event).run_id, self.work_context["run_id"])
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
                self.board.execute("DELETE FROM task_events WHERE id=?", (event["id"],))
        comment = kb.add_comment(self.board, self.task_id, "fixture", "Native retained comment")
        self.board.execute("UPDATE task_comments SET task_id=? WHERE id=?", (self.task_id.encode(), comment))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.board.execute("UPDATE task_comments SET task_id=? WHERE id=?", (self.task_id, comment))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_readable_encoded_foreign_keys_preserve_unrelated_live_work(self):
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_dispatch import _process_fingerprint, _set_worker_pid
        await self.stopped_issue()
        other = kb.create_task(self.board, title="Unrelated retained work", assignee="default",
                               idempotency_key="linear:another-issue")
        claimed = kb.claim_task(self.board, other, claimer="fixture-foreign-claim")
        _set_worker_pid(self.board, other, os.getpid(), run_id=claimed.current_run_id, claim_lock=claimed.claim_lock)
        self.board.execute("UPDATE task_runs SET task_id=? WHERE id=?", (other.encode(), claimed.current_run_id))
        kb._append_event(self.board, other.encode(), "spawned",
            {"pid": os.getpid(), "started_at": _process_fingerprint(os.getpid())},
            run_id=str(claimed.current_run_id).encode())
        comment = kb.add_comment(self.board, other, "fixture", "Unrelated native comment")
        self.board.execute("UPDATE task_comments SET task_id=? WHERE id=?", (other.encode(), comment))
        result = await self.cleanup_inspected()
        self.assertTrue(result["quiescence_proven"], result)
        self.assertEqual(result["task_id"], self.task_id)
        # SQLite's raw BLOB/TEXT distinction remains intact; no read repair occurred.
        row = self.board.execute("SELECT * FROM task_runs WHERE id=?", (claimed.current_run_id,)).fetchone()
        self.assertIsInstance(row["task_id"], bytes)
        self.assertEqual(kb.Run.from_row(row).task_id, other)
        self.assertIsNone(self.board.execute("SELECT id FROM task_runs WHERE task_id=?", (other,)).fetchone())


    async def test_cleanup_corrupted_retained_owned_worker_statuses_are_unknown(self):
        import sqlite3
        from linear_native_db import register_worker_execution
        await self.stopped_issue()
        extra = "retained-owned-compute"
        register_worker_execution(self.db, epoch=self.authority.epoch, execution_id=extra,
            session_id=self.sid, generation=self.row["generation"], kind="compute", adoption_secret="fixture-extra")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        # Ordinary native storage rejects these states. The fault below models
        # corrupted retained state explicitly, never a valid native write path.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE worker_executions SET status='unreadable' WHERE execution_id=?", (extra,)))
        for status in ("unreadable", "", b"running", b"\xff", 123):
            with self.subTest(status=status):
                def corrupt(conn):
                    conn.execute("PRAGMA ignore_check_constraints=ON")
                    try:
                        conn.execute("UPDATE worker_executions SET status=? WHERE execution_id=?", (status, extra))
                    finally:
                        conn.execute("PRAGMA ignore_check_constraints=OFF")
                self.db._execute_write(corrupt)
                before = self.db._execute_write(lambda conn: conn.execute(
                    "SELECT status FROM worker_executions WHERE execution_id=?", (extra,)).fetchone()[0])
                result = await self.cleanup_inspected()
                self.assertFalse(result["quiescence_proven"])
                self.assertEqual(result["reason"], "native_worker_state_unreadable")
                self.assertFalse(result["permission_granted"])
                after = self.db._execute_write(lambda conn: conn.execute(
                    "SELECT status FROM worker_executions WHERE execution_id=?", (extra,)).fetchone()[0])
                self.assertEqual(before, after)

    async def test_cleanup_valid_extra_terminal_workers_and_foreign_scope_remain_readable(self):
        from linear_native_db import register_worker_execution, adopt_worker_execution, mutate_worker_execution
        await self.stopped_issue()
        owned = dict(epoch=self.authority.epoch, execution_id="retained-terminal-compute",
                     session_id=self.sid, generation=self.row["generation"])
        register_worker_execution(self.db, **owned, kind="compute", adoption_secret="fixture-owned")
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_worker_or_spawner_unsettled")
        adopt_worker_execution(self.db, **owned, adoption_secret="fixture-owned")
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_worker_or_spawner_unsettled")
        mutate_worker_execution(self.db, **owned, sequence=1, operation="execution.finish", payload={})
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        foreign = self.sid + "-unrelated-worker-scope"
        self.db.create_session(foreign, source="local")
        register_worker_execution(self.db, epoch=self.authority.epoch, execution_id="unrelated-compute",
            session_id=foreign, generation=0, kind="compute", adoption_secret="fixture-foreign")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def corrupt_foreign(conn):
            conn.execute("PRAGMA ignore_check_constraints=ON")
            try:
                conn.execute("UPDATE worker_executions SET status='unreadable' WHERE execution_id='unrelated-compute'")
            finally:
                conn.execute("PRAGMA ignore_check_constraints=OFF")
        self.db._execute_write(corrupt_foreign)
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])


    async def test_cleanup_runtime_selector_types_hold_encoded_retained_keys_without_repair(self):
        from linear_native_db import register_worker_execution, adopt_worker_execution, mutate_worker_execution
        from linear_native_db import local_receipt
        await self.stopped_issue()
        owned = dict(epoch=self.authority.epoch, execution_id="selector-proof-worker", session_id=self.sid,
                     generation=self.row["generation"])
        register_worker_execution(self.db, **owned, kind="compute", adoption_secret="fixture-selector")
        adopt_worker_execution(self.db, **owned, adoption_secret="fixture-selector")
        mutate_worker_execution(self.db, **owned, sequence=1, operation="execution.finish", payload={})
        control = self.cancelled_control()
        foreign = self.sid + "-selector-foreign"
        self.db.create_session(foreign, source="local")
        self.db.set_meta("selector-proof-meta", "opaque unrelated payload")
        reads = []
        def counted(store, *args, **kwargs):
            reads.append(args)
            return real_receipt(store, *args, **kwargs)
        from hermes_fleet_linear_plugin import native_store
        real_receipt = native_store.local_receipt
        # Receipts come through the storage interface; the evidence's own two-snapshot digest is the stability proof.
        with patch.object(native_store, "local_receipt", counted):
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.assertTrue(reads)
        cases = (("worker_executions", "execution_id", "execution_id", owned["execution_id"]),
                 ("worker_executions", "session_id", "execution_id", owned["execution_id"]),
                 ("session_admissions", "target_session_id", "admission_id", control["admission_id"]),
                 ("sessions", "id", "id", foreign),
                 ("sessions", "parent_session_id", "id", foreign),
                 ("sessions", "chat_id", "id", foreign),
                 ("state_meta", "key", "key", "selector-proof-meta"))
        for table, column, selector, value in cases:
            with self.subTest(table=table, column=column):
                row = self.db._execute_write(lambda conn: conn.execute(
                    f"SELECT rowid AS native_rowid,{column} FROM {table} WHERE {selector}=?", (value,)).fetchone())
                original = row[column]
                damaged = (original or self.sid).encode()
                def update_key(raw):
                    # Explicit corruption/restoration of this isolated fixture;
                    # production inspection never disables constraints or repairs.
                    self.db._conn.execute("PRAGMA foreign_keys=OFF")
                    try:
                        self.db._execute_write(lambda conn: conn.execute(
                            f"UPDATE {table} SET {column}=? WHERE rowid=?", (raw, row["native_rowid"])))
                    finally:
                        self.db._conn.execute("PRAGMA foreign_keys=ON")
                update_key(damaged)
                try:
                    result = await self.cleanup_inspected()
                    self.assertFalse(result["quiescence_proven"])
                    self.assertEqual(result["reason"], "native_runtime_ownership_key_unreadable")
                    retained = self.db._execute_write(lambda conn: conn.execute(
                        f"SELECT {column} FROM {table} WHERE rowid=?", (row["native_rowid"],)).fetchone()[0])
                    self.assertEqual(retained, damaged)
                finally:
                    update_key(original)
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_runtime_key_snapshot_rechecks_rpc_race_and_ignores_foreign_payload(self):
        from linear_native_db import register_worker_execution
        await self.stopped_issue()
        foreign = self.sid + "-unrelated-scope"
        self.db.create_session(foreign, source="local")
        register_worker_execution(self.db, epoch=self.authority.epoch, execution_id="foreign-selector-proof",
            session_id=foreign, generation=0, kind="compute", adoption_secret="fixture-foreign-selector")
        def foreign_corruption(conn):
            conn.execute("PRAGMA ignore_check_constraints=ON")
            try:
                conn.execute("UPDATE worker_executions SET status='unreadable' WHERE execution_id='foreign-selector-proof'")
                conn.execute("UPDATE sessions SET model_config='not-json' WHERE id=?", (foreign,))
            finally:
                conn.execute("PRAGMA ignore_check_constraints=OFF")
        self.db._execute_write(foreign_corruption)
        self.db.set_meta("unrelated-payload", "not-json")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def arriving(method, params):
            self.before_rpc = None
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE state_meta SET key=? WHERE key='unrelated-payload'",
                (("fixture.pending.stop." + self.sid).encode(),)))
        self.before_rpc = arriving
        result = await self.cleanup_inspected()
        self.assertFalse(result["quiescence_proven"])
        self.assertEqual(result["reason"], "native_runtime_ownership_key_unreadable")


    async def test_cleanup_runtime_bounded_identity_contract_rejects_empty_and_oversize_selectors(self):
        from linear_native_db import (RuntimeStoreError, register_worker_execution,
            adopt_worker_execution, mutate_worker_execution, admit_session_input)
        await self.stopped_issue()
        owned = dict(epoch=self.authority.epoch, execution_id="bounded-selector-worker", session_id=self.sid,
                     generation=self.row["generation"])
        register_worker_execution(self.db, **owned, kind="compute", adoption_secret="fixture-bounds")
        adopt_worker_execution(self.db, **owned, adoption_secret="fixture-bounds")
        mutate_worker_execution(self.db, **owned, sequence=1, operation="execution.finish", payload={})
        control = self.cancelled_control()
        cases = (("worker_executions", "execution_id", "execution_id", owned["execution_id"]),
                 ("worker_executions", "session_id", "execution_id", owned["execution_id"]),
                 ("session_admissions", "target_session_id", "admission_id", control["admission_id"]))
        for table, column, selector, value in cases:
            original = self.db._execute_write(lambda conn: conn.execute(
                f"SELECT rowid AS native_rowid,{column} FROM {table} WHERE {selector}=?", (value,)).fetchone())
            for bad in ("", "x" * 1025):
                with self.subTest(table=table, column=column, length=len(bad)):
                    # These are refusals by the actual native writers, not a
                    # second implementation of their identity grammar.
                    with self.assertRaisesRegex(RuntimeStoreError, "invalid_params"):
                        if column == "target_session_id":
                            admit_session_input(self.db, epoch=self.authority.epoch,
                                principal_id=self.conn.actor.subject, session_id=bad, request_id="bad-target",
                                payload={"text": "Finite native identity refusal"})
                        else:
                            register_worker_execution(self.db,
                                **{**owned, column: bad}, kind="compute", adoption_secret="fixture-bounds")
                    def update_key(raw):
                        # Corrupt/restore only this isolated retained-state fixture.
                        self.db._conn.execute("PRAGMA foreign_keys=OFF")
                        try:
                            self.db._execute_write(lambda conn: conn.execute(
                                f"UPDATE {table} SET {column}=? WHERE rowid=?", (raw, original["native_rowid"])))
                        finally:
                            self.db._conn.execute("PRAGMA foreign_keys=ON")
                    update_key(bad)
                    try:
                        result = await self.cleanup_inspected()
                        self.assertFalse(result["quiescence_proven"])
                        self.assertEqual(result["reason"], "native_runtime_ownership_key_unreadable")
                        retained = self.db._execute_write(lambda conn: conn.execute(
                            f"SELECT {column} FROM {table} WHERE rowid=?", (original["native_rowid"],)).fetchone()[0])
                        self.assertEqual(retained, bad)
                    finally:
                        update_key(original[column])
                    self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_cleanup_preserves_actual_native_identity_and_broader_text_contracts(self):
        from linear_native_db import register_worker_execution, adopt_worker_execution, mutate_worker_execution, admit_session_input
        await self.stopped_issue()
        for execution_id in (" ", "e" * 1024):
            args = dict(epoch=self.authority.epoch, execution_id=execution_id,
                        session_id=self.sid, generation=self.row["generation"])
            register_worker_execution(self.db, **args, kind="compute", adoption_secret="fixture-valid-bound")
            adopt_worker_execution(self.db, **args, adoption_secret="fixture-valid-bound")
            mutate_worker_execution(self.db, **args, sequence=1, operation="execution.finish", payload={})
        for index, foreign in enumerate((" ", "s" * 1024)):
            self.db.create_session(foreign, source="local", chat_id="")
            admit_session_input(self.db, epoch=self.authority.epoch,
                principal_id=self.conn.actor.subject, session_id=foreign, request_id="valid-bound-" + str(index),
                payload={"text": "Unrelated valid native work"})
            register_worker_execution(self.db, epoch=self.authority.epoch,
                execution_id="foreign-bound-" + str(index), session_id=foreign, generation=0,
                kind="compute", adoption_secret="fixture-foreign-bound")
        # SessionDB's constructor and metadata writer have broader TEXT
        # contracts. Do not import RuntimeStore's identifier bound into them.
        for session in ("", "w" * 2048):
            self.db.create_session(session, source="local", chat_id="")
        self.db.create_session("foreign-wide-parent", source="local", parent_session_id="w" * 2048,
                                         chat_id="c" * 2048)
        self.db.set_meta("", "opaque metadata")
        self.db.set_meta("native-prefix:" + "m" * 2048, "opaque metadata")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
