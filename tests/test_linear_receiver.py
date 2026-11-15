"""Linear webhook receiver: signature, replay, identity routing and off-by-default.

Every case drives the real receiver, most of them over real HTTP on a loopback
port, and reads the agent's inbox with the same query the Linear plugin's
drain uses. All ids and secrets are synthetic.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "sidecars" / "linear-receiver" / "receiver.py"
EXAMPLE_CONFIG = ROOT / "examples" / "overlay-repo" / "linear-receiver.json"
DOCTOR = ROOT / "scripts" / "switchroom-doctor.py"


def _load():
    spec = importlib.util.spec_from_file_location("linear_receiver_under_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rx = _load()
rx.LOGGER.disabled = True  # refusals are logged by outcome only; keep test output readable

ORG = "example-org-1"
APP = "example-app-user-1"
PERSON = "example-person-1"
STRANGER = "example-person-2"
SECRET = "example-signing-secret-1"
URL = "https://linear-hooks.example.test"
# The plugin's drain query (plugins/linear/bridge.py drain_ingress), verbatim in shape.
DRAIN = ("SELECT logical_agent, delivery_id, payload, received_at, attempts FROM deliveries "
         "WHERE profile = ? AND status = 'pending' ORDER BY received_at, delivery_id")


def config(**overrides) -> dict:
    agent = {"name": "ops", "organization_id": ORG, "app_user_id": APP,
             "allowed_actor_ids": [PERSON], "secret_env": "LINEAR_WEBHOOK_SECRET_OPS"}
    agent.update(overrides)
    return {"agents": [agent]}


def sign(body: bytes, secret: str = SECRET) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def session_event(*, actor=PERSON, org=ORG, app=APP, action="created", stamp_ms=None, **extra) -> dict:
    stamp_ms = int(time.time() * 1000) if stamp_ms is None else stamp_ms
    event = {"type": "AgentSessionEvent", "action": action, "organizationId": org, "appUserId": app,
             "webhookTimestamp": stamp_ms, "createdAt": "2026-01-01T00:00:00.000Z",
             "agentSession": {"id": "example-session-1", "issue": {"id": "example-issue-1"}}}
    if action == "created" and actor is not None:
        event["agentSession"]["creatorId"] = actor
    if action == "prompted":
        event["agentActivity"] = {"id": "example-activity-1", "userId": actor, "content": {"body": "hi"}}
    event.update(extra)
    return event


def encode(event: dict) -> bytes:
    return json.dumps(event, separators=(",", ":")).encode()


class ReceiverHarness(unittest.TestCase):
    """A real receiver on a loopback port with one configured agent."""

    environ = {rx.PUBLIC_URL_ENV: URL, "LINEAR_WEBHOOK_SECRET_OPS": SECRET}

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config_path = self.root / "linear-receiver.json"
        self.config_path.write_text(json.dumps(self.receiver_config()), encoding="utf-8")
        decision, agents, _ = rx.decide(self.config_path, self.environ)
        self.assertTrue(decision.on, decision.line())
        self.receiver = rx.Receiver(agents, self.environ, self.root / "inbox")
        self.server = rx.BoundedServer(("127.0.0.1", 0), rx.make_handler(self.receiver))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.inbox = self.root / "inbox" / "ops" / "ingress.db"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def receiver_config(self) -> dict:
        return config()

    def post(self, body: bytes, *, signature: str | None = "auto", delivery: str | None = "example-delivery-1",
             path: str = "/linear/ops") -> tuple[int, str]:
        headers = {"Content-Type": "application/json"}
        if signature == "auto":
            signature = sign(body)
        if signature is not None:
            headers["linear-signature"] = signature
        if delivery is not None:
            headers["Linear-Delivery"] = delivery
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read().decode().strip()
        finally:
            connection.close()

    def filed(self) -> list[tuple]:
        if not self.inbox.exists():
            return []
        with contextlib.closing(sqlite3.connect(self.inbox)) as db:
            return db.execute(DRAIN, ("ops",)).fetchall()


class SignatureTests(ReceiverHarness):
    def test_valid_signature_files_the_delivery_for_the_plugin(self) -> None:
        body = encode(session_event())
        self.assertEqual(self.post(body), (200, "filed"))
        rows = self.filed()
        self.assertEqual(len(rows), 1)
        agent, delivery, payload, _received, attempts = rows[0]
        self.assertEqual((agent, delivery, bytes(payload), attempts), ("ops", "example-delivery-1", body, 0))

    def test_a_prompt_from_an_allowed_person_is_filed(self) -> None:
        body = encode(session_event(action="prompted"))
        self.assertEqual(self.post(body), (200, "filed"))
        self.assertEqual(len(self.filed()), 1)

    def test_bad_signature_is_rejected_and_nothing_is_filed(self) -> None:
        body = encode(session_event())
        cases = {
            "other secret": sign(body, "example-other-secret"),
            "other body": sign(body + b" "),
            "truncated": sign(body)[:-2],
            "not hex": "z" * 64,
            "empty": "",
        }
        for label, signature in cases.items():
            with self.subTest(case=label):
                self.assertEqual(self.post(body, signature=signature)[0], 401)
        self.assertEqual(self.filed(), [])

    def test_missing_signature_is_rejected(self) -> None:
        self.assertEqual(self.post(encode(session_event()), signature=None)[0], 401)
        self.assertEqual(self.filed(), [])

    def test_signature_covers_the_raw_bytes_not_the_parsed_json(self) -> None:
        # Same JSON, different bytes: a signature over one never admits the other.
        event = session_event()
        compact, spaced = encode(event), json.dumps(event).encode()
        self.assertNotEqual(compact, spaced)
        self.assertEqual(self.post(spaced, signature=sign(compact))[0], 401)
        self.assertEqual(self.filed(), [])

    def test_missing_secret_fails_closed_even_when_routed(self) -> None:
        agent = next(iter(self.receiver.agents.values()))
        receiver = rx.Receiver({agent.path: agent}, {rx.PUBLIC_URL_ENV: URL}, self.root / "other-inbox")
        body = encode(session_event())
        self.assertEqual(receiver.handle(agent.path, body, sign(body), "example-delivery-1").status, 401)
        self.assertFalse(rx.valid_signature(None, body, sign(body)))
        self.assertFalse(rx.valid_signature(b"", body, hmac.new(b"", body, hashlib.sha256).hexdigest()))

    def test_unknown_path_is_not_found(self) -> None:
        body = encode(session_event())
        for path in ("/linear/other", "/linear/ops/", "/linear/ops?x=1", "/linear"):
            with self.subTest(path=path):
                self.assertEqual(self.post(body, path=path)[0], 404)
        self.assertEqual(self.filed(), [])


class ReplayTests(ReceiverHarness):
    def test_stale_or_future_or_missing_timestamp_is_rejected(self) -> None:
        now = int(time.time() * 1000)
        for label, stamp in {"stale": now - 61_000, "future": now + 61_000}.items():
            with self.subTest(case=label):
                body = encode(session_event(stamp_ms=stamp))
                self.assertEqual(self.post(body, delivery=f"example-{label}")[0], 401)
        for label, value in {"missing": None, "text": "now", "boolean": True}.items():
            with self.subTest(case=label):
                event = session_event()
                if value is None:
                    event.pop("webhookTimestamp")
                else:
                    event["webhookTimestamp"] = value
                self.assertEqual(self.post(encode(event), delivery=f"example-{label}")[0], 401)
        self.assertEqual(self.filed(), [])

    def test_a_replayed_delivery_id_is_never_filed_twice(self) -> None:
        body = encode(session_event())
        self.assertEqual(self.post(body), (200, "filed"))
        self.assertEqual(self.post(body), (200, "duplicate"))
        self.assertEqual(len(self.filed()), 1)

    def test_a_replay_after_the_plugin_processed_the_row_is_still_refused(self) -> None:
        body = encode(session_event())
        self.assertEqual(self.post(body), (200, "filed"))
        with contextlib.closing(sqlite3.connect(self.inbox)) as db:
            db.execute("DELETE FROM deliveries")  # processed and pruned
            db.commit()
        self.assertEqual(self.post(body), (200, "duplicate"))
        self.assertEqual(self.filed(), [])

    def test_the_inbox_refuses_a_replay_the_cache_has_forgotten(self) -> None:
        body = encode(session_event())
        self.assertEqual(self.post(body), (200, "filed"))
        self.receiver.seen = rx.SeenDeliveries()  # a restarted receiver
        self.assertEqual(self.post(body), (200, "duplicate"))
        self.assertEqual(len(self.filed()), 1)

    def test_a_reused_delivery_id_with_other_content_is_rejected(self) -> None:
        self.assertEqual(self.post(encode(session_event())), (200, "filed"))
        other = encode(session_event(action="prompted"))
        self.assertEqual(self.post(other)[0], 400)
        self.receiver.seen = rx.SeenDeliveries()
        self.assertEqual(self.post(other)[0], 400)
        self.assertEqual(len(self.filed()), 1)

    def test_a_delivery_without_an_id_is_rejected(self) -> None:
        body = encode(session_event())
        for delivery in (None, "", "../x", "a" * 300):
            with self.subTest(delivery=delivery):
                self.assertEqual(self.post(body, delivery=delivery)[0], 400)
        self.assertEqual(self.filed(), [])


class IdentityRoutingTests(ReceiverHarness):
    def test_unknown_actor_is_ignored(self) -> None:
        cases = {
            "stranger delegates": session_event(actor=STRANGER),
            "stranger prompts": session_event(action="prompted", actor=STRANGER),
            "no creator": session_event(actor=None),
            "the app itself": session_event(actor=APP),
        }
        for index, (label, event) in enumerate(cases.items()):
            with self.subTest(case=label):
                self.assertEqual(self.post(encode(event), delivery=f"example-actor-{index}"), (200, "ignored"))
        self.assertEqual(self.filed(), [])

    def test_unknown_workspace_or_app_is_ignored(self) -> None:
        cases = {
            "other workspace": session_event(org="example-org-2"),
            "no workspace": {k: v for k, v in session_event().items() if k != "organizationId"},
            "other app": session_event(app="example-app-user-2"),
            "no app": {k: v for k, v in session_event().items() if k != "appUserId"},
        }
        for index, (label, event) in enumerate(cases.items()):
            with self.subTest(case=label):
                self.assertEqual(self.post(encode(event), delivery=f"example-id-{index}"), (200, "ignored"))
        self.assertEqual(self.filed(), [])

    def test_payload_text_cannot_widen_the_route(self) -> None:
        # Fields a sender controls never name a different agent or grant access.
        event = session_event(actor=STRANGER, profile="ops", allowed_actor_ids=[STRANGER],
                              logical_agent="ops", agentSession={"id": "s", "creatorId": STRANGER,
                                                                  "issue": {"id": "i"}})
        self.assertEqual(self.post(encode(event)), (200, "ignored"))
        self.assertEqual(self.filed(), [])

    def test_issue_updates_are_filed_only_when_they_concern_this_app(self) -> None:
        now = int(time.time() * 1000)
        base = {"type": "Issue", "action": "update", "organizationId": ORG, "webhookTimestamp": now}
        mine = dict(base, data={"id": "example-issue-1", "delegateId": None}, updatedFrom={"delegateId": APP})
        other = dict(base, data={"id": "example-issue-2", "delegateId": "example-app-user-2"})
        foreign = dict(mine, organizationId="example-org-2")
        self.assertEqual(self.post(encode(mine), delivery="example-issue-a"), (200, "filed"))
        self.assertEqual(self.post(encode(other), delivery="example-issue-b"), (200, "ignored"))
        self.assertEqual(self.post(encode(foreign), delivery="example-issue-c"), (200, "ignored"))
        self.assertEqual([row[1] for row in self.filed()], ["example-issue-a"])

    def test_other_event_types_and_actions_are_ignored(self) -> None:
        now = int(time.time() * 1000)
        cases = [{"type": "Comment", "action": "create", "organizationId": ORG, "webhookTimestamp": now},
                 session_event(action="updated")]
        for index, event in enumerate(cases):
            self.assertEqual(self.post(encode(event), delivery=f"example-type-{index}"), (200, "ignored"))
        self.assertEqual(self.filed(), [])


class InboxContractTests(unittest.TestCase):
    def test_inbox_matches_the_table_the_plugin_tests_drain(self) -> None:
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_ingress_fixture import IngressStore

        def columns(database: Path) -> list[tuple]:
            with contextlib.closing(sqlite3.connect(database)) as db:
                return db.execute("PRAGMA table_info(deliveries)").fetchall()

        with tempfile.TemporaryDirectory() as tmp:
            ours, theirs = Path(tmp) / "ours.db", Path(tmp) / "theirs.db"
            rx.Inbox(ours)
            IngressStore(theirs)
            self.assertEqual(columns(ours), columns(theirs))


class OauthClientTests(ReceiverHarness):
    def receiver_config(self) -> dict:
        return config(oauth_client_id="example-client-1")

    def test_a_configured_oauth_client_must_match(self) -> None:
        self.assertEqual(self.post(encode(session_event(oauthClientId="example-client-2")), delivery="a"),
                         (200, "ignored"))
        self.assertEqual(self.post(encode(session_event()), delivery="b"), (200, "ignored"))
        self.assertEqual(self.post(encode(session_event(oauthClientId="example-client-1")), delivery="c"),
                         (200, "filed"))
        self.assertEqual([row[1] for row in self.filed()], ["c"])


class OffByDefaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "linear-receiver.json"
        self.path.write_text(json.dumps(config()), encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_off_without_its_secret(self) -> None:
        decision, agents, notes = rx.decide(self.path, {rx.PUBLIC_URL_ENV: URL})
        self.assertEqual(decision.line(), "linear-receiver: off: no agent has its webhook signing secret set")
        self.assertEqual(agents, {})
        self.assertEqual(notes, ["ops: off: LINEAR_WEBHOOK_SECRET_OPS is not set"])
        blank = rx.decide(self.path, {rx.PUBLIC_URL_ENV: URL, "LINEAR_WEBHOOK_SECRET_OPS": "  "})[0]
        self.assertFalse(blank.on)

    def test_off_without_a_public_https_url(self) -> None:
        for url in (None, "", "http://linear-hooks.example.test", "https://", "https://u@h.example.test",
                    "https://h.example.test/?q=1"):
            with self.subTest(url=url):
                environ = {"LINEAR_WEBHOOK_SECRET_OPS": SECRET}
                if url is not None:
                    environ[rx.PUBLIC_URL_ENV] = url
                decision = rx.decide(self.path, environ)[0]
                self.assertFalse(decision.on)
                self.assertIn(rx.PUBLIC_URL_ENV, decision.reason)

    def test_off_with_a_missing_or_bad_config(self) -> None:
        environ = {rx.PUBLIC_URL_ENV: URL, "LINEAR_WEBHOOK_SECRET_OPS": SECRET}
        self.assertIn("no config", rx.decide(self.root / "absent.json", environ)[0].reason)
        bad = {
            "unknown field": config(extra=1),
            "empty actors": config(allowed_actor_ids=[]),
            "app as actor": config(allowed_actor_ids=[APP]),
            "bad name": config(name="../ops"),
            "shared secret": {"agents": [config()["agents"][0], dict(config()["agents"][0], name="worker")]},
            "top-level extra": dict(config(), routes=[]),
        }
        for label, raw in bad.items():
            with self.subTest(case=label):
                self.path.write_text(json.dumps(raw), encoding="utf-8")
                self.assertFalse(rx.decide(self.path, environ)[0].on)
        self.path.write_text('{"agents": [], "agents": []}', encoding="utf-8")
        self.assertIn("duplicate key", rx.decide(self.path, environ)[0].reason)

    def test_on_when_secret_and_url_are_set(self) -> None:
        environ = {rx.PUBLIC_URL_ENV: URL + "/", "LINEAR_WEBHOOK_SECRET_OPS": SECRET}
        decision, agents, notes = rx.decide(self.path, environ)
        self.assertEqual(decision.line(), "linear-receiver: on")
        self.assertEqual(list(agents), ["/linear/ops"])
        self.assertEqual(rx.webhook_urls(agents, environ), [f"ops: {URL}/linear/ops"])
        self.assertEqual(notes, [])

    def test_serve_exits_without_listening_when_off(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch.object(rx, "BoundedServer") as server:
            code = rx.main(["serve", "--config", str(self.path), "--inbox-root", str(self.root / "inbox")],
                           environ={rx.PUBLIC_URL_ENV: URL})
        self.assertEqual(code, 0)
        server.assert_not_called()
        self.assertIn("linear-receiver: off:", out.getvalue())
        self.assertFalse((self.root / "inbox").exists())

    def test_the_shipped_example_is_off_and_never_prints_a_secret(self) -> None:
        environ = {rx.PUBLIC_URL_ENV: URL, "LINEAR_WEBHOOK_SECRET_OPS": SECRET}
        result = subprocess.run([sys.executable, "-I", str(SOURCE), "check", "--config", str(EXAMPLE_CONFIG)],
                                env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], f"linear-receiver: off: {rx.PUBLIC_URL_ENV} is not set")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rx.main(["check", "--config", str(EXAMPLE_CONFIG)], environ=environ)
        self.assertIn("linear-receiver: on", out.getvalue())
        self.assertIn("linear-receiver.worker: off: LINEAR_WEBHOOK_SECRET_WORKER is not set", out.getvalue())
        self.assertNotIn(SECRET, out.getvalue())


class SetupCheckTests(unittest.TestCase):
    def test_setup_check_reports_the_receiver(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent_config = root / "config.yaml"
            agent_config.write_text("{}\n", encoding="utf-8")
            receiver_config = root / "linear-receiver.json"
            receiver_config.write_text(json.dumps(config()), encoding="utf-8")
            command = [sys.executable, str(DOCTOR), "--config", str(agent_config), "--no-process-env",
                       "--linear-receiver-config", str(receiver_config)]
            off = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertIn(f"linear-receiver: off: {rx.PUBLIC_URL_ENV} is not set", off.stdout, off.stderr)
            (root / "secrets").mkdir()
            (root / "secrets" / "linear-receiver.env").write_text(
                f"{rx.PUBLIC_URL_ENV}={URL}\nLINEAR_WEBHOOK_SECRET_OPS={SECRET}\n", encoding="utf-8")
            on = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertIn("linear-receiver: on", on.stdout, on.stderr)
            self.assertNotIn(SECRET, on.stdout + on.stderr)



if __name__ == "__main__":
    unittest.main()
