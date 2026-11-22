"""Profile-private chat RPC to the single gateway-owned Linear bridge.

API/desktop tool handlers live in another process. They submit the host-owned
invocation context to this bridge; they never start another scheduler or worker.
"""
from __future__ import annotations
import contextvars
import json
import os
import socket
import socketserver
import stat
import struct
import threading
from pathlib import Path
from dataclasses import asdict, dataclass
from typing import Any, Callable

MAX_BYTES = 65536
OWNED = 'A Linear gateway service already owns this profile'
CONTEXT_FIELDS = ('home', 'profile', 'platform', 'source', 'session_key', 'session_id', 'message_id',
                  'user_id', 'user_id_alt', 'chat_id', 'chat_type', 'thread_id', 'scope_id',
                  'ui_session_id', 'delegated_child', 'native_board', 'native_db_path',
                  'pinned_board', 'pinned_db_path')

@dataclass(frozen=True)
class NativeContext:
    home: str
    profile: str
    platform: str
    source: str
    session_key: str
    session_id: str
    message_id: str = ''
    user_id: str = ''
    user_id_alt: str = ''
    chat_id: str = ''
    chat_type: str = ''
    thread_id: str = ''
    scope_id: str = ''
    ui_session_id: str = ''
    delegated_child: bool = False
    native_board: str = ''
    native_db_path: str = ''
    pinned_board: str = ''
    pinned_db_path: str = ''

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_wire(cls, value: Any, home: Path, profile: str) -> NativeContext:
        if isinstance(value, dict) and set(value) == set(CONTEXT_FIELDS) - {'message_id'}:
            value = {**value, 'message_id': ''}  # Older ordinary RPC clients carry no Activity proof.
        if (not isinstance(value, dict) or set(value) != set(CONTEXT_FIELDS) or
                any(not isinstance(v, str) or len(v) > 4096 for k, v in value.items() if k != 'delegated_child') or
                type(value.get('delegated_child')) is not bool):
            raise Unavailable('Linear request has no trusted native session context')
        context = cls(**value)
        if (bool(context.native_board) != bool(context.native_db_path) or
                bool(context.pinned_board) != bool(context.pinned_db_path)):
            raise Unavailable('Linear request has incomplete native board context')
        if (context.home != str(Path(home).resolve(strict=True)) or context.profile != profile or
                not context.platform or not context.session_key or not context.session_id):
            raise Unavailable('Linear request belongs to another profile or has no native session')
        return context


def native_json_object(raw: Any, *, allow_null: bool = False, encoding: str = 'utf-8') -> dict | None:
    """Decode consumed native metadata without a lossy fallback to absence."""
    if isinstance(raw, bytes):
        raw = raw.decode(encoding)
    value = json.loads(raw) if raw is not None else None
    if value is None and allow_null:
        return None
    if not isinstance(value, dict):
        raise ValueError('Native metadata must be a JSON object')
    return value


def native_board_metadata(board: Any = None) -> dict:
    """Inspect native directory identity and archive state without lossy defaults."""
    from hermes_cli import kanban_db as kb
    try:
        target = board if board is not None else kb.get_current_board()
        path = kb.board_metadata_path(target)
        if path.is_symlink():
            raise ValueError('Native board metadata is a symlink')
        try:
            raw = native_json_object(path.read_bytes(), encoding='utf-8-sig')
        except FileNotFoundError:
            raw = {}  # Native supports absent metadata, including fresh default setup.
        if 'archived' in raw and type(raw['archived']) is not bool:
            raise ValueError('Native board archive state is invalid')
        return {'slug': path.parent.name, 'archived': raw.get('archived', False)}
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        raise Unavailable('Native board metadata is unavailable or invalid; inspect existing work') from exc


def native_board_target(board: Any = None) -> tuple[str, str]:
    """Inspect an existing native target without initializing or creating its board."""
    from hermes_cli import kanban_db as kb
    if board is not None and (not isinstance(board, str) or not board.strip()):
        raise Unavailable('track board must name an existing native board')
    try:
        target = board if board is not None else kb.get_current_board()
        metadata = native_board_metadata(target)
        slug = metadata['slug']
        path = Path(kb.kanban_db_path(board=slug)).resolve(strict=True)
        if not kb.board_exists(slug) or metadata.get('archived') or not path.is_file():
            raise Unavailable('The native board is missing or archived; inspect existing work')
        return slug, str(path)
    except (KeyError, ValueError, OSError) as exc:
        raise Unavailable('The native board is missing, archived or invalid; inspect existing work') from exc


def _native_profile(profile: str, home: Path) -> str:
    """Validate native session ownership; deployment labels are never aliases."""
    from hermes_cli.profiles import profile_matches_home
    if not profile_matches_home(profile, home):
        raise Unavailable('The native session profile does not match its Hermes home')
    return profile


def capture_context(*, track: bool = False, board: Any = None) -> NativeContext:
    """Read the context actually bound by upstream producers, never model args or env fallbacks.

    Upstream set_session_vars binds the named ContextVars for API and messaging turns. The
    public bound_session_key excludes environment fallback; copy_context excludes it for every
    other caller field too. Only an exact native profile/home match is accepted;
    deployment configuration cannot supply a missing caller or alias its identity.
    """
    try:
        from gateway.session_context import bound_session_key
        from hermes_constants import get_hermes_home
        from agent.delegation_context import is_delegated_child_process_context, explicit_board_intent_is_pinned
        bound = {var.name: value for var, value in contextvars.copy_context().items()
                 if var.name.startswith('HERMES_SESSION_') or var.name == 'HERMES_UI_SESSION_ID'}
        key = bound_session_key()
        def read(name):
            value = bound.get(name)
            if not isinstance(value, str):
                raise Unavailable('The native host did not bind session context for this tool call')
            return value
        if not key or key != read('HERMES_SESSION_KEY'):
            raise Unavailable('Linear needs a native host-bound session; model identity is not accepted')
        fields = {name: read('HERMES_SESSION_' + name.removeprefix('session_').upper()) for name in
                  ('platform', 'source', 'session_key', 'session_id', 'message_id', 'user_id', 'user_id_alt',
                   'chat_id', 'chat_type', 'thread_id', 'scope_id')}
        fields['ui_session_id'] = read('HERMES_UI_SESSION_ID')
        fields['delegated_child'] = is_delegated_child_process_context()
        fields.update(native_board='', native_db_path='', pinned_board='', pinned_db_path='')
        if explicit_board_intent_is_pinned():
            from hermes_cli import kanban_db as kb
            # The native directory identifies a pin. Metadata availability is
            # checked at native access, so ordinary authorized content can work.
            fields['pinned_board'] = kb.board_metadata_path(kb.get_current_board()).parent.name
            fields['pinned_db_path'] = str(Path(kb.kanban_db_path()).resolve())
        if track:
            fields['native_board'], fields['native_db_path'] = native_board_target(board)
            if fields['pinned_db_path']:
                if fields['native_board'] != fields['pinned_board']:
                    raise Unavailable('The requested native board is outside the caller\'s native board pin')
        home = Path(get_hermes_home()).resolve(strict=True)
        profile = _native_profile(read('HERMES_SESSION_PROFILE') or 'default', home)
        return NativeContext.from_wire({'home': str(home), 'profile': profile, **fields}, home, profile)
    except (ImportError, OSError) as exc:
        raise Unavailable('This Hermes host cannot provide native session/profile context') from exc

class Unavailable(RuntimeError):
    pass

class Uncertain(RuntimeError):
    pass

def endpoint(home: Path) -> Path:
    return Path(home) / 'linear-transport' / 'chat.sock'

def _private_parent(home: Path, *, create: bool = False) -> Path:
    home = Path(home).resolve(strict=True)
    path = endpoint(home).parent
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise Unavailable('Linear transport directory is not private to this profile')
    return path

def request(home: Path, payload: dict[str, Any], *, timeout: float = 20.0) -> Any:
    sent = False
    try:
        path = _private_parent(home) / 'chat.sock'
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise Unavailable('Linear transport socket is not private to this profile')
        body = json.dumps(payload).encode() + b'\n'
        if len(body) > MAX_BYTES:
            raise Unavailable('Linear request is too large')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(path))
            # Linux peer identity binds the listener to the profile's UID.
            if struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] != os.geteuid():
                raise Unavailable('Linear service belongs to another user')
            sent = True
            client.sendall(body)
            with client.makefile('rb') as stream:
                response = stream.readline(MAX_BYTES + 1)
            if not response.endswith(b'\n') or len(response) > MAX_BYTES:
                raise ValueError('incomplete Linear response')
            result = json.loads(response)
            if not isinstance(result, dict) or set(result) != {'result'}:
                raise ValueError('invalid Linear response')
            return result['result']
    except Unavailable:
        raise
    except (OSError, ValueError) as exc:
        if sent:
            raise Uncertain('Linear request may have been captured; inspect delivery before retrying with the same request id') from exc
        raise Unavailable('The Linear gateway service is not available on this profile') from exc

class Server:
    def __init__(self, home: Path, profile: str, chat: Callable) -> None:
        self.home = Path(home).resolve(strict=True)
        parent = _private_parent(self.home, create=True)
        self.path = parent / 'chat.sock'
        # A live listener is never displaced by another gateway/discovery.
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise Unavailable('Existing Linear transport is unsafe')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(1.0)
                try:
                    probe.connect(str(self.path))
                except (ConnectionRefusedError, FileNotFoundError):
                    self.path.unlink(missing_ok=True)  # Nobody listens: a stale socket file.
                except (BlockingIOError, TimeoutError):
                    # A live listener whose accept backlog is full (a busy or exiting gateway).
                    raise Unavailable(OWNED) from None
                else:
                    raise Unavailable(OWNED)
        scope = contextvars.copy_context()
        slots = threading.BoundedSemaphore(8)
        def handle(payload, peer_pid):
            op = payload.get('op')
            if op == 'status':
                return {'ok': True, 'profile': profile, 'pid': os.getpid(), 'ready': True}
            if payload.get('home') != str(self.home):
                raise ValueError('Linear request belongs to another profile home')
            if op == 'chat':
                context = NativeContext.from_wire(payload.get('context'), self.home, profile)
                args = payload.get('args')
                if not isinstance(args, dict):
                    raise ValueError('Linear request args must be an object')
                return chat(args, context)
            raise ValueError('Unknown Linear transport operation')
        class Handler(socketserver.StreamRequestHandler):
            def handle(inner):
                if not slots.acquire(blocking=False):
                    return
                try:
                    inner.request.settimeout(20)
                    peer_pid, uid, _gid = struct.unpack(
                        '3i', inner.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.geteuid():
                        return
                    raw = inner.rfile.readline(MAX_BYTES + 1)
                    if not raw.endswith(b'\n') or len(raw) > MAX_BYTES:
                        return
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        return
                    result = scope.copy().run(handle, payload, peer_pid)
                    body = json.dumps({'result': result}).encode() + b'\n'
                    if len(body) <= MAX_BYTES:
                        inner.wfile.write(body)
                except Exception:  # a failed capture has an uncertain outcome for the caller
                    # No exception or request body is reflected into another process.
                    return
                finally:
                    slots.release()
        class Listener(socketserver.ThreadingUnixStreamServer):
            daemon_threads = False
            block_on_close = True
        self.listener = Listener(str(self.path), Handler)
        os.chmod(self.path, 0o600)
        self.inode = self.path.lstat().st_ino
        self.thread = threading.Thread(target=self.listener.serve_forever, daemon=True)
        self.thread.start()
    def close(self) -> None:
        self.listener.shutdown()
        self.listener.server_close()
        self.thread.join(timeout=2)
        try:
            if self.path.lstat().st_ino == self.inode:
                self.path.unlink()
        except FileNotFoundError:
            pass

def chat_request(home: Path, args: dict[str, Any], context: Any) -> str:
    # Only capture_context() at the registered tool boundary produces this snapshot.
    validated = NativeContext.from_wire(context.to_wire(), home, context.profile)
    # take_over and resume_owner wait for the other agent's A2A answer (at most its wait_seconds).
    if args.get('action') in ('take_over', 'resume_owner'):
        from .takeover import CLIENT_TIMEOUT_SECONDS
        timeout = CLIENT_TIMEOUT_SECONDS
    else:
        timeout = 20.0
    return request(home, {'op': 'chat', 'home': str(Path(home).resolve(strict=True)),
                          'args': args, 'context': validated.to_wire()}, timeout=timeout)
