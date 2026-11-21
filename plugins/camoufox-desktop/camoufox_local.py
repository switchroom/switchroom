"""The container's local camofox-browser service: its access key, identity and a tiny REST client.

Standard library only. The Hermes plugin and the dock launcher (``bin/camoufox-open``, run by the
Xfce panel outside Hermes) both import it, so the agent, its crons and the human share one key and
one Camofox ``userId``: whatever the human logs in to in the window, the agent's tools see.

The image's s6 service (``docker/s6/camofox-browser``) creates the same key file the same way, so it
does not matter which side starts first.
"""
from __future__ import annotations

import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

DEFAULT_URL = "http://127.0.0.1:9377"
DEFAULT_USER_ID = "hermes-agent"
# The tab group the dock icon opens. The plugin's tabs use their own task keys; the dock adopts the
# newest tab of the same user first, so a human normally lands on what the agent last had open.
DOCK_SESSION_KEY = "desktop"
DOCK_HOME_URL = "https://duckduckgo.com/"
KEY_FILE_NAME = "access-key"


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or "/opt/data")


def state_dir(home: Optional[Path] = None) -> Path:
    """Persistent service state (profiles, cookies, uploads, key) under the profile volume."""
    return (home or hermes_home()) / "camofox-browser"


def key_path(home: Optional[Path] = None) -> Path:
    return state_dir(home) / KEY_FILE_NAME


def ensure_access_key(home: Optional[Path] = None) -> str:
    """Read the service access key, creating it (0600, exclusive create) when it does not exist yet."""
    path = key_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    if not path.exists():
        # Write a private temp file, then link it into place: link() fails if the service (or another
        # gateway thread) won the race, and a reader never sees a half-written key.
        tmp = path.parent / f".{KEY_FILE_NAME}.{os.getpid()}.{secrets.token_hex(4)}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(secrets.token_hex(32) + "\n")
            try:
                os.link(tmp, path)
            except FileExistsError:
                pass
        finally:
            tmp.unlink(missing_ok=True)
    key = path.read_text(encoding="utf-8").strip()
    if len(key) < 32:
        raise RuntimeError(f"camofox-browser access key at {path} is too short")
    return key


def service_url() -> str:
    return (os.environ.get("CAMOFOX_URL") or DEFAULT_URL).rstrip("/")


class Client:
    """Minimal camofox-browser REST client (Bearer access key, loopback only)."""

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None, timeout: float = 30.0):
        self.url = (url or service_url()).rstrip("/")
        self.key = key if key is not None else ensure_access_key()
        self.timeout = timeout

    def request(self, method: str, path: str, body: Optional[dict] = None,
                timeout: Optional[float] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout or self.timeout) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def healthy(self) -> bool:
        try:
            return bool((self.request("GET", "/health", timeout=3) or {}).get("ok"))
        except (OSError, urllib.error.URLError, ValueError):
            return False

    def tabs(self, user_id: str) -> list[dict]:
        data = self.request("GET", f"/tabs?userId={urllib.parse.quote(user_id)}")
        tabs = data.get("tabs", data) if isinstance(data, dict) else data
        return [t for t in (tabs or []) if isinstance(t, dict)]

    def open_or_raise(self, user_id: str, url: Optional[str] = None) -> str:
        """Raise the user's newest tab, or open one; returns the tab id. Idempotent."""
        tabs = self.tabs(user_id)
        if tabs:
            tab_id = str(tabs[-1].get("tabId") or tabs[-1].get("id"))
        else:
            created = self.request("POST", "/tabs", {
                "userId": user_id, "sessionKey": DOCK_SESSION_KEY, "url": url or DOCK_HOME_URL,
            }, timeout=120)
            tab_id = str(created["tabId"])
        self.request("POST", f"/tabs/{tab_id}/activate", {"userId": user_id})
        return tab_id

    def checkpoint(self, user_id: str) -> None:
        """Ask the server to persist the user's cookies now (the response body is discarded)."""
        self.request("GET", f"/sessions/{urllib.parse.quote(user_id)}/storage_state", timeout=60)
