"""Mounted work-reference and worker-progress evidence against the pinned native owner/receipts, without a model or live account."""
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
from hermes_fleet_linear_plugin import origin, transport, work


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

    async def desktop(self):
        """A Desktop chat from main after the supported owner adoption (Agent #196).

        Adoption commits a native local receipt with Desktop's ``gui`` policy while the stored row
        keeps its ``desktop`` label; its turns bind ``source=desktop`` and the conversation as chat.
        (Adoption itself loads the gateway model bootstrap, which this proof forbids importing.)"""
        await self.local(source="gui")
        self.db._execute_write(lambda c: c.execute("UPDATE sessions SET source='desktop' WHERE id=?", (self.sid,)))
        self.bind("local", self.sid, source="desktop", chat=self.sid)

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
        for action in ("work_reference",):
            for selector in ("profile", "session_id", "home", "task_id", "issue"):
                with self.subTest(action=action, selector=selector):
                    result = await self.async_registered_tool(action, expect_refusal=True,
                                                              **{selector: "forged"})
                    self.assertFalse(result.get("ok", False))
        self.assertEqual(self.calls, [])

    def during_origin_readback(self, change):
        """Run a finite fixture writer during the second actual owner receipt."""
        count = 0
        def arriving(_method, _params):
            nonlocal count
            count += 1
            if count == 2:
                change()
        self.before_rpc = arriving

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

    async def test_a2a_work_reference_framing_preserves_unknown_requester(self):
        await self.kanban()
        ref = self.reference_through_a2a(await self.work_current())
        evidence = await self.work_inspected(ref)
        self.assertEqual(evidence["requester"], {"kind": "native_dispatcher", "original_requester": "unknown"})
        self.assertFalse(evidence["permission_granted"])

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

    async def test_selected_admission_header_changes_during_owner_readback_are_refused(self):
        for native_work in (True,):
            await self.kanban()
            current, inspected = self.work_current, self.work_inspected
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

