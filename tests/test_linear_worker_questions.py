"""A real dispatched worker asks through the native registry and verified Linear input.

Only the provider HTTP and model decisions are fixtures. No live account or user
answer is fabricated: the disposable provider supplies a clearly scoped test reply.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import subprocess
import sys

from types import MethodType
import unittest
from unittest.mock import patch

if os.environ.get("HERMES_AGENT_SRC"):
    sys.path.insert(0, os.environ["HERMES_AGENT_SRC"])


@unittest.skipUnless(os.environ.get('HERMES_AGENT_SRC'), 'requires explicit native source')
class WorkerQuestions(unittest.IsolatedAsyncioTestCase):
    async def test_real_worker_question_and_bound_reply_keep_one_run(self):
        await self.isolated_flow(False)

    async def test_stop_retires_real_worker_question_without_accepting_late_choice(self):
        await self.isolated_flow(True)

    async def isolated_flow(self, stop):
        if os.environ.get("HERMES_WORKER_QUESTION_CHILD"):
            return await self.flow(stop=stop)
        environment = {key: os.environ[key] for key in (
            "PATH", "LANG", "TZ", "HOME", "HERMES_HOME", "HERMES_RUNTIME_DIR",
            "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PYTHONDONTWRITEBYTECODE", "HERMES_AGENT_SRC",
        ) if key in os.environ}
        environment["HERMES_WORKER_QUESTION_CHILD"] = "stop" if stop else "complete"
        name = "test_stop_retires_real_worker_question_without_accepting_late_choice" if stop else "test_real_worker_question_and_bound_reply_keep_one_run"
        result = await asyncio.to_thread(subprocess.run, [sys.executable, str(Path(__file__).resolve()),
            "WorkerQuestions." + name], env=environment, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr[-6000:])

    async def flow(self, stop=False):
        from test_linear_native_input_seam import NativeInputSeamScenarios
        fixture = NativeInputSeamScenarios()
        await fixture.asyncSetUp()
        worker_env = patch.dict(os.environ, PYTHONPATH=os.environ["HERMES_AGENT_SRC"])
        worker_env.start()
        self.addCleanup(worker_env.stop)
        self.addCleanup(fixture.doCleanups)
        self.addAsyncCleanup(fixture.asyncTearDown)
        from hermes_cli import kanban_db as kb
        from gateway.session_contract import SessionActor, Submission
        from gateway.session_authority import SessionAuthority
        from gateway.session_kanban import build_kanban_policy
        from gateway.session_kanban_prompts import bind_consumer
        from gateway.session_local import create_local_session
        from tools.clarify_gateway import get_pending

        requests = []
        worker_waiting, release_worker = threading.Event(), threading.Event()
        self.addCleanup(release_worker.set)
        class Model(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                messages = body.get('messages') or []
                tools = {item['function']['name'] for item in body.get('tools', [])}
                if tools and not worker_waiting.is_set():
                    worker_waiting.set()
                    assert release_worker.wait(40), "follow-up coordinator did not release the worker"
                returned = any(item.get('role') == 'tool' and 'Blue' in str(item.get('content')) for item in messages)
                name = 'kanban_complete' if returned else 'clarify'
                args = ({'summary': 'Confirmed Blue; no files or settings changed.'} if returned else
                        {'questions': [{'question': 'Choose Blue or Green.', 'choices': ['Blue', 'Green']}]})
                message = {'role': 'assistant', 'content': 'Verified bounded result.'}
                finish = 'stop'
                if tools:
                    assert name in tools, (name, tools)
                    message = {'role': 'assistant', 'content': None, 'tool_calls': [{'index': 0,
                        'id': 'choice-' + str(len(requests)), 'type': 'function',
                        'function': {'name': name, 'arguments': json.dumps(args)}}]}
                    finish = 'tool_calls'
                payload = json.dumps({'id': 'worker-choice', 'choices': [{'index': 0, 'message': message,
                    'finish_reason': finish}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}).encode()
                kind = 'application/json'
                if body.get('stream'):
                    payload = ('data: ' + json.dumps({'id': 'worker-choice', 'choices': [{'index': 0,
                        'delta': message, 'finish_reason': finish}]}) + '\n\ndata: [DONE]\n\n').encode()
                    kind = 'text/event-stream'
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        peer = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=peer.serve_forever, daemon=True).start()
        self.addCleanup(peer.server_close)
        self.addCleanup(peer.shutdown)
        cfg = {'gateway': {'multiplex_profiles': False},
               'model': {'default': 'loop-model', 'provider': 'custom', 'api_key': 'loopback-only',
                         'base_url': f'http://127.0.0.1:{peer.server_port}/v1'},
               'platform_toolsets': {'cli': ['file', 'kanban', 'terminal']},
               'auxiliary': {'title_generation': {'enabled': False}},
               'agent': {'max_turns': 8, 'api_max_retries': 0, 'clarify_timeout': 20},
               'approvals': {'single_query_mode': 'deny'}, 'terminal': {'backend': 'local'}}
        (fixture.home / 'config.yaml').write_text(json.dumps(cfg))
        fixture.adapter.set_authorization_check(lambda actor, *_a, **_k: actor == fixture.USER)
        remember = fixture.bridge.store.remember_conversation_input
        def commit_consumer(*args, **kwargs):
            staged = fixture.bridge.store.get(fixture.ISSUE)
            self.assertEqual(fixture.board.get(staged['task_id']).status, 'blocked')
            with fixture.board.conn() as conn:
                self.assertIsNone(kb.claim_task(conn, staged['task_id']))
            return remember(*args, **kwargs)
        with patch.object(fixture.bridge.store, 'remember_conversation_input', side_effect=commit_consumer):
            await fixture.deliver('delegated-choice', 'Use clarify to choose Blue or Green, then confirm.', action='created')
            await fixture.until(lambda: fixture.receipts and fixture.inbox_row('delegated-choice')[2] == 'imported')
        await fixture.until(lambda: fixture.receipts and fixture.inbox_row('delegated-choice')[2] == 'imported')
        task_id = fixture.bridge.store.get(fixture.ISSUE)['task_id']
        with fixture.board.conn() as conn:
            task = kb.claim_task(conn, task_id)
            from hermes_cli.kanban_db_workspace import resolve_workspace, set_workspace_path
            workspace = resolve_workspace(task, board=fixture.board.board)
            set_workspace_path(conn, task_id, workspace)
            task = kb.get_task(conn, task_id)
        actor = SessionActor('owner', str(fixture.home), frozenset({'session:create', 'session:submit'}), 'test-owner')
        connection = type('Connection', (), {'authority': fixture.authority, 'actor': actor, 'native_owner': True})()
        params = {'board': fixture.board.board or 'default', 'task_id': task.id,
                  'run_id': task.current_run_id, 'claim_lock': task.claim_lock}
        policy, secrets = build_kanban_policy(connection, params, cfg)
        policy = await bind_consumer(fixture.authority, policy)
        self.assertIn('prompt_consumer_admission_id', json.loads(policy.kanban_json))
        ref = create_local_session(fixture.authority, actor, {'request_id': 'real-choice-worker'},
                                   trusted_policy=policy, trusted_secrets=secrets)
        # Use the ordinary authenticated runtime endpoints for worker adoption;
        # persistence never falls back to a fixture connection or direct writes.
        from gateway.control_socket import GatewayControlServer, build_identify_payload
        from gateway.runtime_bootstrap import TicketStore
        from gateway.run_api import start_gateway_api, stop_gateway_api
        fixture.runner.session_ticket_store = TicketStore(fixture.authority.instance_id, frozenset({str(fixture.home)}))
        descriptor = {**build_identify_payload(), 'instance_id': fixture.authority.instance_id,
            'runtime_protocol': 1, 'authority_epoch': fixture.authority.epoch, 'state': 'starting',
            'supervisor': 'none', 'capabilities': ['session-authority-v1', 'durable-admission-v1'],
            'served_profiles': [{'profile_id': str(fixture.home), 'home': str(fixture.home)}]}
        fixture.runner.session_runtime_descriptor = descriptor
        server = GatewayControlServer(fixture.home, verb_handlers={'identify': lambda: descriptor})
        server.ticket_store = fixture.runner.session_ticket_store
        self.assertTrue(await server.start())
        self.addAsyncCleanup(server.stop)
        api = await start_gateway_api(fixture.runner)
        self.addAsyncCleanup(stop_gateway_api, api)
        descriptor.update(state='ready', api_origin=api.api_origin)
        fixture.authority._schedule = MethodType(SessionAuthority._schedule, fixture.authority)
        await fixture.authority.submit(actor, Submission('real-choice-worker', ref,
            {'text': f'work kanban task {task.id}', 'finite': True}, 'queue'))
        self.assertTrue(await asyncio.to_thread(worker_waiting.wait, 25))
        # Inspect the complete request received by the provider before the scripted
        # model supplies clarify. A forced tool call alone cannot prove that a
        # genuinely bound Linear worker was told it may ask its human a question.
        worker_requests = [body for body in requests if body.get('tools')]
        self.assertTrue(worker_requests)
        for body in worker_requests:
            system_messages = [item for item in body['messages']
                               if item.get('role') in ('system', 'developer')]
            self.assertTrue(system_messages)
            system_prompt = '\n'.join(
                item['content'] if isinstance(item['content'], str) else
                '\n'.join(block['text'] for block in item['content'] if block.get('type') == 'text')
                for item in system_messages)
            self.assertIn('Kanban task execution protocol', system_prompt)
            self.assertIn('trusted human conversation for `clarify`', system_prompt)
            self.assertIn('use `clarify` to ask the human in this task\'s bound conversation and wait', system_prompt)
            self.assertIn('Continue this same task after the answer', system_prompt)
            self.assertNotIn('Do not call `clarify`', system_prompt)
            self.assertNotIn('there is no live user to answer', system_prompt)
            self.assertNotIn('Block on genuine ambiguity', system_prompt)
        frozen_consumer = json.loads(policy.kanban_json)['prompt_consumer_admission_id']
        async def coordinate_status(event):
            from gateway.session_results import execution_result
            execution_result.get()['result'] = {'completed': True, 'final_response': 'The worker is still working.'}
            return 'The worker is still working.'
        fixture.model = coordinate_status
        await fixture.deliver('ordinary-status-before-question', 'What is the status?')
        await fixture.until(lambda: fixture.inbox_row('ordinary-status-before-question')[2] == 'imported')
        newest = fixture.bridge.store.conversation_input(fixture.ISSUE, fixture.SESSION)
        self.assertNotEqual(newest['admission_id'], frozen_consumer)
        self.assertEqual(fixture.board.get(task_id).current_run_id, task.current_run_id)
        release_worker.set()
        try:
            await fixture.until(lambda: any(row.get('native_prompt', {}).get('producer')
                for row in fixture.bridge.store.conversation_questions(fixture.ISSUE, fixture.SESSION)))
        except BaseException:
            print("MODEL_REQUEST_COUNT", len(requests))
            for log in fixture.home.glob("**/*.log"):
                print("WORKER_LOG", log.name, log.read_text()[-12000:])
            raise
        question = next(row for row in fixture.bridge.store.conversation_questions(fixture.ISSUE, fixture.SESSION)
                        if row['native_prompt'].get('producer'))
        pending = get_pending(question['native_prompt']['clarify_id'])
        self.assertIsNotNone(pending)
        from tools.clarify_tool import strip_recommended
        self.assertEqual([strip_recommended(choice) for choice in pending.choices], ['Blue', 'Green'])
        self.assertEqual(pending.producer['session_id'], ref.session_id)
        from gateway.session_kanban_prompts import require_consumer
        from linear_native_db import RuntimeStoreError
        fixture.fixture.allowed.remove(fixture.USER)
        with self.assertRaises(RuntimeStoreError):
            await require_consumer(fixture.authority, policy)
        fixture.fixture.allowed.add(fixture.USER)
        if stop:
            await fixture.deliver('stop-worker-choice', 'Stop', signal='stop')
            await fixture.until(lambda: fixture.board.get(task_id).status == 'blocked')
            await fixture.until(lambda: get_pending(pending.clarify_id) is None)
            from tools.clarify_gateway import resolve_gateway_clarify
            self.assertFalse(resolve_gateway_clarify(pending.clarify_id, 'Blue'))
            self.assertEqual(fixture.board.get(task_id).status, 'blocked')
            return
        await fixture.deliver('bound-blue-answer', question['signal_metadata']['options'][0]['value'])
        await fixture.until(lambda: fixture.board.get(task_id).status == 'done')
        with fixture.board.read_conn() as conn:
            self.assertEqual(kb.latest_run(conn, task_id).id, task.current_run_id)
        await fixture.until(lambda: ref.session_id not in getattr(fixture.authority, '_managed_workers', {}))
        self.assertTrue(any('Blue' in str(item.get('messages')) for item in requests[1:]))
        self.assertFalse(any(event.kind == 'block_loop_detected' for event in fixture.board.history(task_id, 0)))
        for _ in range(2):
            await asyncio.to_thread(fixture.bridge.pump_kanban)
            await asyncio.to_thread(fixture.bridge.flush)
        responses = [item for item in fixture.provider.activities.values()
                     if item.get('content', {}).get('type') == 'response']
        self.assertEqual(len(responses), 1)
        comments = list(fixture.provider.comment_records.values())
        self.assertEqual(len(comments), 1)
        comment = comments[0]
        self.assertIsNone(comment['parent'])
        self.assertEqual(comment['user']['id'], fixture.provider.viewer)
        self.assertEqual(comment['issue']['id'], fixture.ISSUE)
        self.assertIn('Blue', comment['body'])
        self.assertTrue(await asyncio.to_thread(fixture.bridge.api.verify_completion_comment,
            comment['id'], fixture.ISSUE, comment['body']))
        pointer = fixture.bridge.store.outbox_row(responses[0]['id'])['payload']
        self.assertTrue(pointer['native_outcome_pointer'])
        self.assertEqual(pointer['requires_comment_id'], comment['id'])
        self.assertNotIn('Blue', responses[0]['content']['body'])
        self.assertEqual(responses[0]['content']['body'],
            'Completed. The result and checks are in the issue comment.')


if __name__ == "__main__":
    unittest.main()
