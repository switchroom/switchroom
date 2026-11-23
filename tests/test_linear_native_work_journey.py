"""Real disposable native worker journeys, with only model/Linear network fixtures.

These prove backend execution, not authenticated Telegram/Slack/Desktop client UAT.
The ordinary native daemon/dispatcher helpers come from the explicit Agent source.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC") and os.name != "nt",
                     "requires explicit native source and POSIX process proof")
class NativeWorkJourneyTests(unittest.TestCase):
    def journey(self, mode):
        source = Path(os.environ["HERMES_AGENT_SRC"]).resolve()
        with tempfile.TemporaryDirectory(prefix="linear-worker-journey-") as temporary:
            root = Path(temporary)
            env = {key: os.environ[key] for key in ("PATH", "LANG", "TZ") if key in os.environ}
            env.update(HOME=str(root / "user"), USERPROFILE=str(root / "user"),
                       HERMES_HOME=str(root / "state"), HERMES_AGENT_SRC=str(source),
                       PYTHONPATH=str(source), PYTHONUNBUFFERED="1")
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--child", mode],
                                    cwd=source, env=env, capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt = json.loads((root / "state" / "journey-receipt.json").read_text())
            print(json.dumps({"journey": mode, **receipt}, sort_keys=True))
            return receipt

    def test_assignment_executes_real_tool_and_followup_on_one_worker_then_survives_restart(self):
        result = self.journey("complete")
        self.assertEqual(result["task_status"], "done")
        self.assertTrue(result["real_file_effect"])
        self.assertTrue(result["followup_consumed_same_run"])
        self.assertTrue(result["plugin_recovery_kept_same_run"])
        self.assertTrue(result["owner_restart_did_not_replay"])
        self.assertEqual(result["native_task_count"], 1)
        self.assertEqual(result["owner_admissions"], 1)

    def test_assignment_reuses_an_unlinked_executing_chat_task_and_steers_same_worker(self):
        result = self.journey("reuse")
        self.assertTrue(result["preexisting_task_reused"])
        self.assertTrue(result["followup_consumed_same_run"])
        self.assertTrue(result["owner_restart_did_not_replay"])
        self.assertEqual(result["native_task_count"], 1)
        self.assertEqual(result["owner_admissions"], 1)

    def test_paused_answer_is_saved_before_resume_and_real_worker_finishes_without_reblocking(self):
        result = self.journey("paused-answer")
        self.assertTrue(result["paused_answer_preserved"])
        self.assertTrue(result["followup_consumed_same_run"])
        self.assertEqual(result["task_status"], "done")
        self.assertEqual(result["native_task_count"], 1)

    def test_linear_stop_reaps_owned_worker_and_prevents_later_tool_effect(self):
        result = self.journey("stop")
        self.assertEqual(result["task_status"], "blocked")
        self.assertTrue(result["worker_termination_verified"])
        self.assertTrue(result["forbidden_effect_absent"])
        self.assertTrue(result["restart_preserved_stop"])

    def test_operator_handoff_waits_for_old_worker_exit_and_executes_only_remainder(self):
        result = self.journey("handoff")
        self.assertTrue(result["old_history_preserved"])
        self.assertTrue(result["old_worker_gone_before_target_admission"])
        self.assertTrue(result["completed_effect_not_repeated"])
        self.assertTrue(result["target_remainder_completed"])
        self.assertTrue(result["old_gateway_still_ready"])


def _child(mode):
    from contextlib import closing
    from datetime import datetime, timezone
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    import time
    from unittest.mock import patch

    source = Path(os.environ["HERMES_AGENT_SRC"]).resolve()
    public_tests = Path(__file__).resolve().parent
    sys.path.insert(0, str(source / "tests" / "gateway" / "fixtures"))
    sys.path.insert(0, str(public_tests))
    from local_recovery_probe import daemon, control
    from linear_fake_api import load_plugin
    load_plugin()
    from hermes_fleet_linear_plugin.bridge import Bridge, Kanban
    from hermes_fleet_linear_plugin.store import Store
    from test_linear_specialist_authorization import Authority, ISSUE, SESSION, USER, VIEWER, ACTIVITY
    from hermes_cli import kanban_db as kb, kanban_db_dispatch as dispatch
    from hermes_cli.kanban_db_connect import connect

    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700)
    Path(os.environ["HOME"]).mkdir()
    os.environ.update(HERMES_KANBAN_HOME=str(home), HERMES_PROFILE="default",
                      HERMES_KANBAN_CRASH_GRACE_SECONDS="0")
    board = Kanban("owned", profile="default", profile_home=home)
    receipt = {}

    # Both named agents are authorized for this project workspace, not each
    # other's private Hermes home, memory, session store, or credentials.
    effects = home.parent / "approved-project-workspace"
    effects.mkdir()
    first, followup, forbidden = (effects / name for name in ("phase-a.txt", "phase-b.txt", "must-not-run.txt"))

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = body.get("messages") or []
            self.server.requests.append(body)
            tools = {item["function"]["name"] for item in body.get("tools", [])}
            name, args = None, None
            if messages and tools:
                wire = json.dumps(messages)
                if "TARGET_REMAINDER_SENTINEL" in wire:
                    if not followup.exists():
                        name, args = "write_file", {"path": str(followup), "content": "handoff-remainder-complete"}
                    else:
                        name, args = "kanban_complete", {"summary": "Checkpoint remainder completed without repeating phase A."}
                elif not first.exists():
                    name, args = "write_file", {"path": str(first), "content": "owned-first-effect"}
                elif not self.server.barrier.is_set():
                    self.server.barrier.set()
                    assert self.server.release.wait(70), "coordinator did not release model boundary"
                    name, args = (("write_file", {"path": str(forbidden), "content": "must-not-exist"})
                                  if mode in ("stop", "handoff") else ("read_file", {"path": str(first)}))
                elif mode in ("complete", "reuse", "paused-answer") and not followup.exists():
                    if "FOLLOWUP_NATIVE_SENTINEL" in wire:
                        self.server.saw_followup = True
                        name, args = "write_file", {"path": str(followup), "content": "followup-was-consumed"}
                    else:
                        name, args = "read_file", {"path": str(first)}
                elif mode in ("complete", "reuse", "paused-answer"):
                    name, args = "kanban_complete", {"summary": "Both isolated file effects verified; native operator follow-up applied."}
            message = {"role": "assistant", "content": "Owned journey complete"}
            finish = "stop"
            if name:
                assert name in tools, (name, sorted(tools))
                if name == "write_file" and args["path"] == str(first):
                    self.server.first_writes += 1
                message = {"role": "assistant", "content": None, "tool_calls": [{"index": 0,
                    "id": "journey-" + str(len(self.server.requests)), "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)}}]}
                finish = "tool_calls"
            payload = json.dumps({"id": "journey", "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                                  "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode()
            kind = "application/json"
            if body.get("stream"):
                payload = ("data: " + json.dumps({"id": "journey", "choices": [{"index": 0, "delta": message,
                    "finish_reason": finish}]}) + "\n\ndata: [DONE]\n\n").encode()
                kind = "text/event-stream"
            try:
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

    peer = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    peer.requests, peer.saw_followup = [], False
    peer.first_writes = 0
    peer.barrier, peer.release = threading.Event(), threading.Event()
    thread = threading.Thread(target=peer.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{peer.server_port}/v1"
    os.environ.update(OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=url)
    cfg = {"gateway": {"multiplex_profiles": False},
           "model": {"provider": "custom", "default": "loop-model", "base_url": url},
           "auxiliary": {"title_generation": {"enabled": False}},
           "platform_toolsets": {"cli": ["terminal", "file", "kanban"]},
           "terminal": {"backend": "local"}, "agent": {"api_max_retries": 1, "max_turns": 12},
           "kanban": {"dispatch_in_gateway": False}}
    (home / "config.yaml").write_text(json.dumps(cfg))
    authority = Authority()
    authority.sessions[SESSION]["appUser"] = {"id": VIEWER}
    authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
    authority.issues[ISSUE]["title"] = "Isolated native worker journey"
    authority.issues[ISSUE]["description"] = (
        f"Only write the owned fixture files {first} and {followup}. "
        "Apply any later operator follow-up and complete this bounded task; no network effects.")
    store = Store(home / "linear.db")
    def bridge():
        return Bridge(store, authority.api(scope=None), board, profile="default")
    worker_bridge = bridge()
    stamp = time.time()
    event = {"type": "AgentSessionEvent", "action": "created",
             "createdAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
             "agentSession": {"id": SESSION, "issue": {"id": ISSUE}, "creatorId": USER}}
    if mode == "reuse":
        issue = authority.issues[ISSUE]
        # Ordinary native work has its own retry key and explicit issue link,
        # but no local Linear reporting binding when the assignment arrives.
        task_id = board.create(title=f"{issue['identifier']}: approved ongoing work",
            body=f"Linear issue {ISSUE}: {issue['url']}\n\n{issue['description']}",
            created_by="operator", idempotency_key=f"chat-work:{ISSUE}").id
        assert store.get(ISSUE) is None
    else:
        worker_bridge.handle_webhook(event)
        task_id = store.get(ISSUE)["task_id"]
    assert board.get(task_id).status == "ready"
    if mode == "paused-answer":
        with board.conn() as initial_conn:
            kb.block_task(initial_conn, task_id, reason="Choose Blue or Green", kind="needs_input")
        saved = worker_bridge.followup(ISSUE,
            "FOLLOWUP_NATIVE_SENTINEL: Blue. Preserve phase A and write the requested phase B result.",
            "paused-color-answer")
        assert saved["saved"] and board.get(task_id).status == "blocked"
        # A bridge restart or retry never starts work; the ordinary native
        # operator control is the only resume in this disposable journey.
        saved_again = bridge().followup(ISSUE,
            "FOLLOWUP_NATIVE_SENTINEL: Blue. Preserve phase A and write the requested phase B result.",
            "paused-color-answer")
        assert saved_again["saved"] and board.get(task_id).status == "blocked"
        with board.conn() as initial_conn:
            kb.unblock_task(initial_conn, task_id)
        receipt["paused_answer_preserved"] = True
    dispatch._resolve_hermes_argv = lambda: [sys.executable, "-m", "hermes_cli.main"]
    clients = []
    original_popen = subprocess.Popen
    def spawn(*args, **kwargs):
        child = original_popen(*args, **kwargs)
        if "hermes_cli.kanban_worker_client" in args[0]:
            clients.append(child)
        return child
    def wait_for(predicate, description, timeout=65):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.05)
        raise AssertionError(description)
    env = dict(os.environ)
    try:
        with daemon(source, home, env, barrier=False):
            with patch.object(subprocess, "Popen", spawn), closing(connect(board="owned")) as conn:
                launched = dispatch.dispatch_once(conn, board="owned", max_spawn=1)
                assert [entry[0] for entry in launched.spawned] == [task_id], launched
                assert peer.barrier.wait(60), "native worker never made its first tool effect"
                assert first.read_text() == "owned-first-effect"
                task = kb.get_task(conn, task_id)
                run_id = task.current_run_id
                assert task.status == "running" and run_id is not None
                restarted_bridge = bridge()
                restarted_bridge.recover()
                restarted_bridge.handle_webhook(event)
                current = kb.get_task(conn, task_id)
                if mode == "reuse":
                    receipt["preexisting_task_reused"] = store.get(ISSUE)["task_id"] == task_id
                    assert receipt["preexisting_task_reused"]
                    assert conn.execute("SELECT count(*) FROM tasks").fetchone()[0] == 1
                    assert store.native_intent(f"create:{ISSUE}") is None
                receipt["plugin_recovery_kept_same_run"] = current.current_run_id == run_id and current.claim_lock == task.claim_lock
                if mode in ("complete", "reuse", "paused-answer"):
                    if mode != "paused-answer":
                        restarted_bridge.followup(ISSUE, "FOLLOWUP_NATIVE_SENTINEL: preserve phase A and write the requested phase B result.",
                                                   "isolated-followup-one")
                    # Keep the existing native six-second comment-poll contract real.
                    time.sleep(6.2)
                    peer.release.set()
                    wait_for(lambda: kb.get_task(conn, task_id).status == "done", "task did not finish after native follow-up")
                    wait_for(lambda: all(child.poll() is not None for child in clients), "worker submitter did not exit")
                    receipt.update(real_file_effect=first.read_text() == "owned-first-effect",
                                   followup_consumed_same_run=peer.saw_followup and followup.read_text() == "followup-was-consumed" and
                                   kb.latest_run(conn, task_id).id == run_id)
                else:
                    bound = [entry for entry in kb.list_events(conn, task_id) if entry.kind == "worker_bound"]
                    assert bound, "no native bound worker identity"
                    managed_pid = bound[-1].payload["pid"]
                    stopped_at = time.monotonic()
                    if mode == "handoff":
                        # Exact same supported operator surface the controller
                        # can run inside the old agent's isolated container.
                        command = [sys.executable, "-m", "hermes_cli.main", "kanban", "--board", "owned"]
                        inspected = subprocess.run(command + ["show", task_id, "--json"], env=env,
                            capture_output=True, text=True, timeout=25, check=True)
                        snapshot = json.loads(inspected.stdout)
                        assert snapshot["task"]["status"] == "running"
                        blocked = subprocess.run(command + ["block", task_id, "operator handoff checkpoint preserved",
                            "--kind", "needs_input", "--expected-event-id", str(snapshot["latest_event_id"])],
                            env=env, capture_output=True, text=True, timeout=25)
                        assert blocked.returncode == 0, blocked.stdout + blocked.stderr
                    else:
                        stop = {**event, "action": "prompted",
                                "createdAt": datetime.fromtimestamp(time.time() + 2, timezone.utc).isoformat(),
                                "agentActivity": {"id": ACTIVITY, "user": {"id": USER}, "signal": "stop", "content": {"body": "Stop"}}}
                        restarted_bridge.handle_webhook(stop)
                    assert kb.get_task(conn, task_id).status == "blocked"
                    # Scale only the existing terminal-reaper grace in this disposable fixture.
                    with patch.object(dispatch, "TERMINAL_WORKER_REAP_GRACE_SECONDS", 0):
                        dispatch.reap_terminal_workers(conn)
                    wait_for(lambda: not kb._pid_alive(managed_pid), "managed native worker survived Stop/reaping")
                    wait_for(lambda: all(child.poll() is not None for child in clients), "submitter survived native reaping")
                    receipt["stop_to_verified_quiescence_seconds"] = round(time.monotonic() - stopped_at, 3)
                    # An ACK is not quiescence. A model reply released before the
                    # native watcher ends the managed worker can still do work.
                    # Only after physical exit do we challenge a delayed reply.
                    peer.release.set()
                    receipt.update(worker_termination_verified=any(entry.kind == "terminal_worker_reaped" for entry in kb.list_events(conn, task_id)),
                                   forbidden_effect_absent=not forbidden.exists())
                    if mode == "handoff":
                        old_events = [(entry.id, entry.kind, entry.payload) for entry in kb.list_events(conn, task_id)]
                        original_bytes = first.read_bytes()
                        target = home.parent / "target-state"
                        target.mkdir(mode=0o700)
                        target_user = home.parent / "target-user"
                        target_user.mkdir()
                        (target / "config.yaml").write_text(json.dumps(cfg))
                        target_env = dict(env, HERMES_HOME=str(target), HERMES_KANBAN_HOME=str(target),
                                          HOME=str(target_user), USERPROFILE=str(target_user))
                        with patch.dict(os.environ, target_env, clear=True):
                            target_board = Kanban("owned", profile="default", profile_home=target)
                            target_authority = Authority()
                            target_authority.sessions[SESSION]["appUser"] = {"id": VIEWER}
                            target_authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
                            target_authority.issues[ISSUE]["description"] = (
                                f"TARGET_REMAINDER_SENTINEL. Verified checkpoint: phase A completed at {first}; "
                                f"old execution has stopped. Only write the remaining result to {followup}; do not repeat phase A.")
                            target_store = Store(target / "linear.db")
                            target_bridge = Bridge(target_store, target_authority.api(scope=None), target_board, profile="default")
                            target_bridge.handle_webhook({**event, "createdAt": datetime.now(timezone.utc).isoformat()})
                            target_id = target_store.get(ISSUE)["task_id"]
                            receipt["old_worker_gone_before_target_admission"] = not kb._pid_alive(managed_pid)
                            assert receipt["old_worker_gone_before_target_admission"]
                            with daemon(source, target, target_env, barrier=False), closing(connect(board="owned")) as target_conn:
                                launched = dispatch.dispatch_once(target_conn, board="owned", max_spawn=1)
                                assert [entry[0] for entry in launched.spawned] == [target_id], launched
                                wait_for(lambda: kb.get_task(target_conn, target_id).status == "done", "target remainder did not finish")
                                wait_for(lambda: all(child.poll() is not None for child in clients), "target submitter did not exit")
                                receipt["target_remainder_completed"] = followup.read_text() == "handoff-remainder-complete"
                        receipt["completed_effect_not_repeated"] = first.read_bytes() == original_bytes and peer.first_writes == 1
                        receipt["old_history_preserved"] = old_events == [(entry.id, entry.kind, entry.payload) for entry in kb.list_events(conn, task_id)]
                        receipt["old_gateway_still_ready"] = control(home, "identify")["state"] == "ready"
                receipt["task_status"] = kb.get_task(conn, task_id).status
                receipt["native_task_count"] = conn.execute("SELECT count(*) FROM tasks").fetchone()[0]
        before = first.read_bytes()
        with daemon(source, home, env, barrier=False):
            bridge().recover()
            with closing(connect(board="owned")) as conn:
                assert kb.get_task(conn, task_id).status == receipt["task_status"]
                assert conn.execute("SELECT count(*) FROM tasks").fetchone()[0] == 1
            with closing(__import__("sqlite3").connect((home / "state.db").as_uri() + "?mode=ro", uri=True)) as db:
                receipt["owner_admissions"] = db.execute("SELECT count(*) FROM session_admissions").fetchone()[0]
            receipt["owner_restart_did_not_replay"] = first.read_bytes() == before and receipt["owner_admissions"] == 1
            receipt["restart_preserved_stop"] = mode in ("stop", "handoff") and not forbidden.exists()
    finally:
        peer.release.set()
        for child in clients:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
        peer.shutdown()
        peer.server_close()
        thread.join(timeout=5)
        (home / "journey-receipt.json").write_text(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        _child(sys.argv[2])
    else:
        unittest.main()
