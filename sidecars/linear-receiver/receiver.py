#!/usr/bin/env python3
"""Linear webhook receiver: verify each delivery, then file it in one agent's inbox.

Linear posts a webhook when a person delegates an issue to an agent's OAuth
app, @mentions it, sends it a message in its Agent Session or presses Stop.
This receiver is the only thing that listens for those posts. For each one it:

1. matches the exact URL path to one configured agent (anything else is 404);
2. checks the ``linear-signature`` HMAC-SHA256 of the raw body with that
   agent's own webhook signing secret, in constant time (401 on mismatch);
3. requires the signed ``webhookTimestamp`` to be within one minute of now and
   a ``Linear-Delivery`` id and body it has not already filed (stale is 401,
   a repeated id or a repeated body under a new id is acknowledged and never
   filed twice, a reused id with other content is 400). The delivery id is
   not signed, so the body digest is what stops a captured delivery being
   re-posted under fresh ids;
4. checks that the delivery is for that agent's own Linear workspace and app,
   and that a session event comes from a person on the agent's allowlist.
   Anything else is acknowledged with 200 and dropped, so it never starts work;
5. commits the raw body to the agent's SQLite inbox before answering 200.

The agent's Linear plugin reads that inbox (``deliveries`` table) and does the
work. The receiver never holds an OAuth token, never calls Linear and never
treats anything in the payload as permission: the payload only has to match
the identity the operator configured.

It is off unless ``LINEAR_RECEIVER_PUBLIC_URL`` is an https URL and at least
one configured agent has its signing secret. ``check`` prints

    linear-receiver: on
    linear-receiver: off: <reason>

and ``serve`` prints the same line, then exits 0 when off. Standard library
only; nothing is installed.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import hmac
import json
import logging
import math
import os
import re
import sqlite3
import sys
import threading
import time
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

LOGGER = logging.getLogger("linear-receiver")

NAME = "linear-receiver"
PUBLIC_URL_ENV = "LINEAR_RECEIVER_PUBLIC_URL"
DEFAULT_CONFIG = Path("/config/linear-receiver.json")
DEFAULT_INBOX_ROOT = Path("/inbox")
DEFAULT_PORT = 8646
SIGNATURE_HEADER = "linear-signature"
DELIVERY_HEADER = "Linear-Delivery"
# Linear recommends refusing a signed webhook more than a minute old.
MAX_CLOCK_SKEW_MS = 60_000
MAX_BODY_BYTES = 1_048_576
# Linear fails a delivery that has no answer within 5 s.
REQUEST_DEADLINE_SECONDS = 3.0
SQLITE_BUSY_SECONDS = 1.5
MAX_WORKERS = 16
MAX_PENDING_DELIVERIES = 1_000
# Filed and processed rows older than this are pruned; pending rows never are.
RETAIN_PROCESSED_SECONDS = 7 * 86_400

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
DELIVERY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

SCHEMA = """CREATE TABLE IF NOT EXISTS deliveries (
    logical_agent TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    payload BLOB NOT NULL,
    payload_sha256 TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (logical_agent, delivery_id)
)"""
# Not unique: an inbox written before this index existed may already hold a
# replayed copy, and refusing to open it would stop every delivery.
DIGEST_INDEX = ("CREATE INDEX IF NOT EXISTS deliveries_by_digest "
                "ON deliveries (logical_agent, payload_sha256)")


class ConfigError(ValueError):
    """The receiver configuration is unusable; the receiver stays off."""


@dataclasses.dataclass(frozen=True)
class Agent:
    """One agent's own Linear app identity and inbox. Nothing here is secret."""

    name: str                    # the agent's profile name; also its inbox directory
    path: str                    # exact webhook URL path, /linear/<name>
    organization_id: str         # the agent's Linear workspace (organization.id)
    app_user_id: str             # the agent's app user (viewer.id)
    allowed_actor_ids: frozenset[str]  # Linear user ids that may start or steer work
    secret_env: str              # environment variable holding the signing secret
    oauth_client_id: str | None = None  # optional: also require this OAuth app


@dataclasses.dataclass(frozen=True)
class Result:
    status: int
    outcome: str  # filed, duplicate, ignored:<why> or refused:<why>

    @property
    def filed(self) -> bool:
        return self.outcome == "filed"


@dataclasses.dataclass(frozen=True)
class Decision:
    on: bool
    reason: str = ""

    def line(self) -> str:
        return f"{NAME}: on" if self.on else f"{NAME}: off: {self.reason}"


# --- configuration ---------------------------------------------------------

def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ConfigError(f"{label} must be a Linear id")
    return value


def parse_config(raw: Any) -> dict[str, Agent]:
    """Strictly parse ``{"agents": [...]}``; any unknown or duplicate field is refused."""
    if not isinstance(raw, Mapping) or set(raw) != {"agents"}:
        raise ConfigError("config must contain only an agents list")
    entries = raw["agents"]
    if not isinstance(entries, list) or not entries:
        raise ConfigError("agents must be a nonempty list")
    allowed = {"name", "organization_id", "app_user_id", "allowed_actor_ids", "secret_env", "oauth_client_id"}
    required = allowed - {"oauth_client_id"}
    agents: dict[str, Agent] = {}
    secret_envs: set[str] = set()
    for entry in entries:
        if not isinstance(entry, Mapping) or not required <= set(entry) or set(entry) - allowed:
            raise ConfigError("each agent needs exactly name, organization_id, app_user_id, "
                              "allowed_actor_ids, secret_env and optionally oauth_client_id")
        name = entry["name"]
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            raise ConfigError("agent name must be lowercase letters, digits and dashes")
        path = f"/linear/{name}"
        if path in agents:
            raise ConfigError(f"duplicate agent: {name}")
        secret_env = entry["secret_env"]
        if not isinstance(secret_env, str) or not ENV_RE.fullmatch(secret_env) or secret_env == PUBLIC_URL_ENV:
            raise ConfigError(f"{name}: secret_env must be an upper-case variable name")
        if secret_env in secret_envs:
            raise ConfigError(f"{name}: each agent needs its own signing secret")
        actors = entry["allowed_actor_ids"]
        if not isinstance(actors, list) or not actors:
            raise ConfigError(f"{name}: allowed_actor_ids must be a nonempty list")
        actor_ids = frozenset(_identifier(actor, f"{name}: allowed actor") for actor in actors)
        app_user_id = _identifier(entry["app_user_id"], f"{name}: app_user_id")
        if app_user_id in actor_ids:
            raise ConfigError(f"{name}: the agent's own app user cannot be an allowed actor")
        client = entry.get("oauth_client_id")
        agents[path] = Agent(
            name=name, path=path,
            organization_id=_identifier(entry["organization_id"], f"{name}: organization_id"),
            app_user_id=app_user_id, allowed_actor_ids=actor_ids, secret_env=secret_env,
            oauth_client_id=None if client is None else _identifier(client, f"{name}: oauth_client_id"),
        )
        secret_envs.add(secret_env)
    return agents


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError(f"duplicate key in config: {key}")
        result[key] = value
    return result


def load_config(path: Path) -> dict[str, Agent]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ConfigError(f"no config at {path}") from exc
    except OSError as exc:
        raise ConfigError(f"config at {path} cannot be read") from exc
    try:
        raw = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"config at {path} is not JSON") from exc
    return parse_config(raw)


def secret_for(agent: Agent, environ: Mapping[str, str]) -> bytes | None:
    value = (environ.get(agent.secret_env) or "").strip()
    return value.encode("utf-8") if value else None


def _public_url_problem(environ: Mapping[str, str]) -> str | None:
    url = (environ.get(PUBLIC_URL_ENV) or "").strip()
    if not url:
        return f"{PUBLIC_URL_ENV} is not set"
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.query or parts.fragment or parts.username:
        return f"{PUBLIC_URL_ENV} must be a plain https URL"
    return None


def decide(config_path: Path, environ: Mapping[str, str]) -> tuple[Decision, dict[str, Agent], list[str]]:
    """Whether the receiver serves, which agents it serves, and a note per agent left off."""
    problem = _public_url_problem(environ)
    if problem:
        return Decision(False, problem), {}, []
    try:
        agents = load_config(config_path)
    except ConfigError as exc:
        return Decision(False, str(exc)), {}, []
    active = {path: agent for path, agent in agents.items() if secret_for(agent, environ)}
    notes = [f"{agent.name}: off: {agent.secret_env} is not set"
             for agent in agents.values() if agent.path not in active]
    if not active:
        return Decision(False, "no agent has its webhook signing secret set"), {}, notes
    return Decision(True), active, notes


def webhook_urls(agents: Mapping[str, Agent], environ: Mapping[str, str]) -> list[str]:
    base = (environ.get(PUBLIC_URL_ENV) or "").strip().rstrip("/")
    return [f"{agent.name}: {base}{agent.path}" for agent in agents.values()]


# --- verification ----------------------------------------------------------

def valid_signature(secret: bytes | None, body: bytes, supplied: Any) -> bool:
    """Constant-time HMAC-SHA256 check over the exact raw body. No secret, no pass."""
    if not secret or not isinstance(supplied, str):
        return False
    try:
        actual = bytes.fromhex(supplied.strip())
    except ValueError:
        return False
    expected = hmac.new(secret, body, hashlib.sha256).digest()
    return hmac.compare_digest(expected, actual)


def fresh(event: Mapping[str, Any], now_ms: int) -> bool:
    stamp = event.get("webhookTimestamp")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
        return False
    return abs(now_ms - stamp) <= MAX_CLOCK_SKEW_MS


def _id_of(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def session_actor(event: Mapping[str, Any]) -> str | None:
    """The person behind an Agent Session event, as the signed payload names them."""
    if event.get("action") == "created":
        session = event.get("agentSession")
        if not isinstance(session, Mapping):
            return None
        creator = session.get("creator")
        return _id_of(session.get("creatorId")) or (_id_of(creator.get("id")) if isinstance(creator, Mapping) else None)
    if event.get("action") == "prompted":
        activity = event.get("agentActivity")
        if not isinstance(activity, Mapping):
            return None
        user = activity.get("user")
        return _id_of(activity.get("userId")) or (_id_of(user.get("id")) if isinstance(user, Mapping) else None)
    return None


def _touches_app(event: Mapping[str, Any], app_user_id: str) -> bool:
    sources = [value for value in (event.get("data"), event.get("updatedFrom")) if isinstance(value, Mapping)]
    return any(source.get(key) == app_user_id for source in sources for key in ("delegateId", "assigneeId"))


def route_problem(agent: Agent, event: Any) -> str | None:
    """None when this delivery belongs to this agent; otherwise why it is dropped.

    Only identity the operator configured counts. The payload must match it;
    nothing in the payload can widen it.
    """
    if not isinstance(event, Mapping):
        return "not_an_object"
    if event.get("organizationId") != agent.organization_id:
        return "unknown_workspace"
    if agent.oauth_client_id is not None and event.get("oauthClientId") != agent.oauth_client_id:
        return "unknown_app"
    kind = event.get("type")
    if kind == "AgentSessionEvent":
        if event.get("appUserId") != agent.app_user_id:
            return "unknown_app"
        if event.get("action") not in ("created", "prompted"):
            return "unsupported_action"
        actor = session_actor(event)
        if actor is None or actor == agent.app_user_id or actor not in agent.allowed_actor_ids:
            return "unknown_actor"
        return None
    if kind == "Issue":
        # Issue updates never start work; the plugin uses them to notice a person
        # closing, reassigning or undelegating work it already holds.
        return None if _touches_app(event, agent.app_user_id) else "not_this_agent"
    return "unsupported_type"


# --- inbox -----------------------------------------------------------------

class Inbox:
    """The agent's ``deliveries`` table: the contract the Linear plugin drains."""

    def __init__(self, database: Path) -> None:
        database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.database = database
        self._lock = threading.Lock()
        with self._connect(5.0) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(SCHEMA)
            db.execute(DIGEST_INDEX)

    def _connect(self, timeout: float = SQLITE_BUSY_SECONDS):
        db = sqlite3.connect(self.database, timeout=timeout, isolation_level=None)
        db.execute("PRAGMA synchronous=FULL")
        return _Closing(db)

    def file(self, agent: Agent, delivery_id: str, body: bytes, received_at: int) -> str:
        """Commit once. ``filed``, ``duplicate``, or ValueError for a reused id.

        A body already filed for this agent under another delivery id is a
        ``duplicate`` too: the id header is unsigned, the body is not.
        """
        digest = hashlib.sha256(body).hexdigest()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT payload_sha256 FROM deliveries WHERE logical_agent = ? AND delivery_id = ?",
                                 (agent.name, delivery_id)).fetchone()
                if row is not None:
                    db.execute("ROLLBACK")
                    if row[0] != digest:
                        raise ValueError("delivery id reused with different content")
                    return "duplicate"
                if db.execute("SELECT 1 FROM deliveries WHERE logical_agent = ? AND payload_sha256 = ? LIMIT 1",
                              (agent.name, digest)).fetchone() is not None:
                    db.execute("ROLLBACK")
                    return "duplicate"
                pending = db.execute("SELECT COUNT(*) FROM deliveries WHERE status = 'pending'").fetchone()[0]
                if pending >= MAX_PENDING_DELIVERIES:
                    db.execute("ROLLBACK")
                    raise OverflowError("inbox is full")
                db.execute("INSERT INTO deliveries (logical_agent, delivery_id, profile, payload, payload_sha256, "
                           "received_at) VALUES (?, ?, ?, ?, ?, ?)",
                           (agent.name, delivery_id, agent.name, body, digest, received_at))
                db.execute("DELETE FROM deliveries WHERE status != 'pending' AND received_at < ?",
                           (received_at - RETAIN_PROCESSED_SECONDS,))
                db.execute("COMMIT")
            except sqlite3.Error:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        return "filed"


class _Closing:
    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db

    def __enter__(self) -> sqlite3.Connection:
        return self.db

    def __exit__(self, *_exc: object) -> None:
        self.db.close()


class SeenDeliveries:
    """In-memory delivery-id and body-digest cache over the replay window.

    The inbox's primary key and digest index are the durable record; this
    cache also refuses a replay after the plugin has processed and pruned the
    row, and costs no database work on a hot replay. Linear signs the body,
    not the ``Linear-Delivery`` header, so a body seen under any id counts.
    The window covers the whole span a signed timestamp stays fresh.
    """

    def __init__(self, window_seconds: float = 2 * MAX_CLOCK_SKEW_MS / 1000) -> None:
        self.window = window_seconds
        self._seen: dict[tuple[str, str], tuple[float, str]] = {}
        self._digests: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def check(self, agent: str, delivery_id: str, digest: str, now: float) -> str | None:
        with self._lock:
            for key in [k for k, (at, _) in self._seen.items() if now - at > self.window]:
                del self._seen[key]
            for key in [k for k, at in self._digests.items() if now - at > self.window]:
                del self._digests[key]
            seen = self._seen.get((agent, delivery_id))
            body_seen = (agent, digest) in self._digests
        if seen is not None:
            return "duplicate" if seen[1] == digest else "reused"
        return "duplicate" if body_seen else None

    def remember(self, agent: str, delivery_id: str, digest: str, now: float) -> None:
        with self._lock:
            self._seen.setdefault((agent, delivery_id), (now, digest))
            self._digests.setdefault((agent, digest), now)


# --- the request path -------------------------------------------------------

class Receiver:
    def __init__(self, agents: Mapping[str, Agent], environ: Mapping[str, str], inbox_root: Path,
                 *, clock=time.time) -> None:
        self.agents = dict(agents)
        self.secrets = {path: secret_for(agent, environ) for path, agent in self.agents.items()}
        self.inboxes = {path: Inbox(inbox_root / agent.name / "ingress.db") for path, agent in self.agents.items()}
        self.seen = SeenDeliveries()
        self.clock = clock

    def handle(self, path: str, body: bytes, signature: Any, delivery_id: Any) -> Result:
        agent = self.agents.get(path)
        if agent is None:
            return Result(404, "refused:unknown_path")
        # Signature first, over the exact bytes, before anything reads the body.
        if not valid_signature(self.secrets.get(path), body, signature):
            return Result(401, "refused:bad_signature")
        if not isinstance(delivery_id, str) or not DELIVERY_RE.fullmatch(delivery_id):
            return Result(400, "refused:missing_delivery_id")
        try:
            event = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return Result(400, "refused:not_json")
        now = self.clock()
        if not isinstance(event, Mapping) or not fresh(event, int(now * 1000)):
            return Result(401, "refused:stale_or_missing_timestamp")
        digest = hashlib.sha256(body).hexdigest()
        replay = self.seen.check(agent.name, delivery_id, digest, now)
        if replay == "duplicate":
            return Result(200, "duplicate")
        if replay == "reused":
            return Result(400, "refused:reused_delivery_id")
        problem = route_problem(agent, event)
        if problem is not None:
            self.seen.remember(agent.name, delivery_id, digest, now)
            return Result(200, f"ignored:{problem}")
        try:
            outcome = self.inboxes[path].file(agent, delivery_id, body, int(now))
        except ValueError:
            return Result(400, "refused:reused_delivery_id")
        except (OverflowError, OSError, sqlite3.Error):
            # Our fault, not the sender's: Linear retries a 5xx.
            return Result(503, "refused:inbox_unavailable")
        self.seen.remember(agent.name, delivery_id, digest, now)
        return Result(200, outcome)


def make_handler(receiver: Receiver) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = NAME
        sys_version = ""

        def setup(self) -> None:
            super().setup()
            self.deadline = time.monotonic() + REQUEST_DEADLINE_SECONDS
            self.connection.settimeout(REQUEST_DEADLINE_SECONDS)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - base signature
            del format, args
            return  # no paths, bodies or ids in access logs

        def _reply(self, status: int, text: str) -> None:
            payload = (text + "\n").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

        def do_GET(self) -> None:
            self._reply(200, "ok") if self.path == "/health" else self._reply(404, "not found")

        def do_POST(self) -> None:
            if self.path not in receiver.agents:
                self._reply(404, "not found")
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._reply(411, "length required")
                return
            if length < 0 or length > MAX_BODY_BYTES:
                self._reply(413, "payload too large")
                return
            try:
                body = self.rfile.read(length)
            except TimeoutError:
                self._reply(408, "request timeout")
                return
            if len(body) != length:
                self._reply(400, "incomplete body")
                return
            result = receiver.handle(self.path, body, self.headers.get(SIGNATURE_HEADER),
                                     self.headers.get(DELIVERY_HEADER))
            agent = receiver.agents[self.path].name
            if result.outcome.startswith("refused:") or result.outcome.startswith("ignored:"):
                LOGGER.warning("%s agent=%s outcome=%s status=%d", NAME, agent, result.outcome, result.status)
            self._reply(result.status, result.outcome.split(":", 1)[0])

        do_PUT = do_PATCH = do_DELETE = lambda self: self._reply(405, "method not allowed")  # noqa: E731

    return Handler


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, address, handler, *, max_workers: int = MAX_WORKERS) -> None:
        self._slots = threading.BoundedSemaphore(max_workers)
        super().__init__(address, handler)

    def process_request(self, request, client_address) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("check", "serve"))
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--inbox-root", type=Path, default=DEFAULT_INBOX_ROOT)
    parser.add_argument("--host", default="0.0.0.0", help="inside the container; compose publishes one port")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s", stream=sys.stderr)
    decision, agents, notes = decide(args.config, environ)
    print(decision.line(), flush=True)
    for note in notes:
        print(f"{NAME}.{note}", flush=True)
    if decision.on:
        for url in webhook_urls(agents, environ):
            print(f"{NAME}.webhook {url}", flush=True)
    if args.command == "check" or not decision.on:
        return 0
    receiver = Receiver(agents, environ, args.inbox_root)
    server = BoundedServer((args.host, args.port), make_handler(receiver))
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
