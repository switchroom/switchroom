"""Alert sink and config loading shared by the Switchroom host monitors.

Monitors decide *whether* to alert; this module only delivers the text. A sink
is either ``stdout`` (the default: cron or a systemd journal picks it up) or a
``webhook`` that receives one JSON POST per alert. The webhook URL is read from
an environment variable named in the config, so the URL itself, which is often
a credential, never sits in a config file, a report or a log line.

Nothing here knows about any particular chat service. Point the webhook at
whatever relay you use (an incoming-webhook URL, a small relay that forwards to
your chat, an alert manager). The payload is ``{"text", "source", "kind",
"host"}``; most incoming webhooks accept ``text``.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, TextIO

SINKS = ("stdout", "webhook")
ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
AGENT_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
DEFAULT_WEBHOOK_ENV = "SWITCHROOM_ALERT_WEBHOOK_URL"
MAX_TEXT = 3500


class ConfigError(ValueError):
    """The operator's config or arguments are invalid (exit code 2)."""


class DeliveryError(RuntimeError):
    """The sink could not deliver an alert. The message never holds the URL."""


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ConfigError(f"duplicate JSON key: {key!r}")
        out[key] = value
    return out


def load_json(path: Path | str) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=_no_duplicates)
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc.strerror or exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} is not valid JSON: {exc.msg} (line {exc.lineno})") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must hold a JSON object")
    return data


def section(config: dict[str, Any], name: str) -> dict[str, Any]:
    value = config.get(name, {})
    if not isinstance(value, dict):
        raise ConfigError(f"{name} must be an object")
    return value


def agents(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """``{"agents": {"<name>": {"roots": {"<label>": "/abs/path"}}}}``, validated."""
    raw = config.get("agents")
    if not isinstance(raw, dict) or not raw:
        raise ConfigError("agents must be a non-empty object")
    out: dict[str, dict[str, Any]] = {}
    for name, detail in raw.items():
        if not isinstance(name, str) or AGENT_RE.fullmatch(name) is None:
            raise ConfigError(f"invalid agent name: {name!r}")
        if not isinstance(detail, dict):
            raise ConfigError(f"agents.{name} must be an object")
        roots = detail.get("roots")
        if not isinstance(roots, dict) or not roots:
            raise ConfigError(f"agents.{name}.roots must be a non-empty object")
        clean: dict[str, Path] = {}
        for label, value in roots.items():
            if not isinstance(label, str) or AGENT_RE.fullmatch(label) is None:
                raise ConfigError(f"agents.{name}.roots has an invalid label: {label!r}")
            if (not isinstance(value, str) or not value.startswith("/") or ".." in value.split("/")
                    or os.path.normpath(value) == "/"):
                raise ConfigError(f"agents.{name}.roots.{label} must be a normalized absolute path below /")
            clean[label] = Path(os.path.normpath(value))
        out[name] = {**detail, "roots": clean}
    return out


class Sink:
    """Deliver alert text to stdout or a webhook."""

    def __init__(self, kind: str = "stdout", *, url_env: str = DEFAULT_WEBHOOK_ENV,
                 timeout: float = 10.0, allow_http: bool = False, source: str = "switchroom",
                 environ: dict[str, str] | None = None, stream: TextIO | None = None,
                 post: Callable[[str, bytes, float], int] | None = None) -> None:
        if kind not in SINKS:
            raise ConfigError(f"alert sink must be one of {', '.join(SINKS)}")
        if ENV_NAME_RE.fullmatch(url_env) is None:
            raise ConfigError("alert.url_env must name an environment variable")
        if not 0 < timeout <= 60:
            raise ConfigError("alert.timeout_seconds must be between 0 and 60")
        self.kind = kind
        self.url_env = url_env
        self.timeout = timeout
        self.allow_http = allow_http
        self.source = source
        self.environ = os.environ if environ is None else environ
        self.stream = stream
        self.post = post or _post
        self.sent: list[dict[str, Any]] = []

    @classmethod
    def from_config(cls, config: dict[str, Any], *, override: str | None = None, source: str,
                    **kwargs: Any) -> "Sink":
        alert = section(config, "alert")
        kind = override or alert.get("sink", "stdout")
        timeout = alert.get("timeout_seconds", 10)
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool):
            raise ConfigError("alert.timeout_seconds must be a number")
        allow_http = alert.get("allow_http", False)
        if not isinstance(allow_http, bool):
            raise ConfigError("alert.allow_http must be true or false")
        url_env = alert.get("url_env", DEFAULT_WEBHOOK_ENV)
        if not isinstance(url_env, str):
            raise ConfigError("alert.url_env must be a string")
        return cls(kind, url_env=url_env, timeout=float(timeout), allow_http=allow_http,
                   source=source, **kwargs)

    def _url(self) -> str:
        url = (self.environ.get(self.url_env) or "").strip()
        if not url:
            raise DeliveryError(f"webhook sink selected but {self.url_env} is not set")
        parsed = urllib.parse.urlsplit(url)
        allowed = {"https"} | ({"http"} if self.allow_http else set())
        if parsed.scheme not in allowed or not parsed.hostname:
            raise DeliveryError(f"{self.url_env} must be an https URL" +
                                (" (or http with allow_http)" if not self.allow_http else ""))
        return url

    def send(self, text: str, *, kind: str) -> None:
        text = text[:MAX_TEXT]
        payload = {"text": text, "source": self.source, "kind": kind, "host": socket.gethostname()}
        if self.kind == "stdout":
            stream = self.stream or sys.stdout
            print(f"[{self.source}] {kind}: {text}", file=stream, flush=True)
        else:
            url = self._url()
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            try:
                status = self.post(url, body, self.timeout)
            except DeliveryError:
                raise
            except Exception as exc:  # noqa: BLE001 - never echo the URL
                raise DeliveryError(f"webhook delivery failed: {type(exc).__name__}") from None
            if not 200 <= status < 300:
                raise DeliveryError(f"webhook delivery failed: HTTP {status}")
        self.sent.append(payload)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        return None


def _post(url: str, body: bytes, timeout: float) -> int:
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "switchroom-monitor/1"})
    try:
        with opener.open(request, timeout=timeout) as response:
            response.read(4096)
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def format_bytes(value: int | None) -> str:
    if value is None:
        return "unknown"
    if value < 1024:
        return f"{value} B"
    number = float(value)
    for unit in ("KiB", "MiB", "GiB", "TiB"):
        number /= 1024
        if number < 1024 or unit == "TiB":
            return f"{number:.1f} {unit}"
    raise AssertionError("unreachable")


def positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ConfigError(f"{label} must be a positive integer")
    return value


def number(value: Any, label: str, *, low: float = 0.0, high: float | None = None) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ConfigError(f"{label} must be a number")
    if value < low or (high is not None and value > high):
        raise ConfigError(f"{label} is out of range")
    return float(value)
