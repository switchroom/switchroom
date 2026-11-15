#!/usr/bin/env python3
"""Read-only origin for reviewed artifacts.

Serves one file per reviewed artifact at ``/artifact/<uuid>/`` and nothing
else. An artifact is served only while all of these hold:

* its UUID is in the reviewed manifest, which a human reviewer writes and the
  agent cannot (the agent never mounts it);
* the file the manifest names, inside the agent's outbox, still has exactly
  the SHA-256 and size the reviewer approved. A file changed after review is
  refused, not served.

Everything else is refused: other methods, other paths, query strings,
credentials, cookies, request bodies, traversal, symlinks and oversized files.
The manifest is re-read on every request, so a review takes effect without a
restart and removing an entry withdraws the artifact at once.

Stdlib only. Run it in a pinned Python image with a read-only root, no
capabilities and the outbox and manifest mounted read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
import stat
import sys
from pathlib import PurePosixPath

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
ROUTE = re.compile(rf"^/artifact/({UUID})/$")
MANIFEST_SCHEMA = 1
DEFAULT_MAX_BYTES = 25 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
}
REFUSED_HEADERS = ("authorization", "cookie", "proxy-authorization")


class Refused(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def safe_relative(name: object) -> str:
    """A manifest path: relative, no traversal, no empty or dot parts."""
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError("artifact path must be a non-empty relative POSIX path")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"artifact path is not a plain relative path: {name!r}")
    return path.as_posix()


def load_manifest(path: str) -> dict[str, dict]:
    """Reviewed entries by UUID. Any malformed manifest serves nothing."""
    with open(path, "rb") as handle:
        raw = handle.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError("manifest is too large")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != MANIFEST_SCHEMA:
        raise ValueError("manifest schema_version must be 1")
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError("manifest artifacts must be an object")
    reviewed = {}
    for key, entry in artifacts.items():
        if not re.fullmatch(UUID, key) or not isinstance(entry, dict):
            raise ValueError(f"bad manifest entry: {key!r}")
        digest = entry.get("sha256")
        size = entry.get("size")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"bad sha256 for {key}")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError(f"bad size for {key}")
        reviewed[key] = {"path": safe_relative(entry.get("path")), "sha256": digest, "size": size}
    return reviewed


def read_reviewed(outbox: str, entry: dict, max_bytes: int) -> bytes:
    """The artifact's bytes, only if they are still exactly what was reviewed."""
    if entry["size"] > max_bytes:
        raise Refused(413, "artifact is larger than the configured limit")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    root = os.open(outbox, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        parts = entry["path"].split("/")
        fd = root
        opened = []
        try:
            for part in parts[:-1]:
                fd = os.open(part, flags | getattr(os, "O_DIRECTORY", 0), dir_fd=fd)
                opened.append(fd)
            leaf = os.open(parts[-1], flags, dir_fd=fd)
        except OSError:
            raise Refused(404, "reviewed artifact is missing") from None
        finally:
            for item in opened:
                os.close(item)
        try:
            info = os.fstat(leaf)
            if not stat.S_ISREG(info.st_mode):
                raise Refused(404, "reviewed artifact is not a regular file")
            if info.st_size != entry["size"]:
                raise Refused(409, "artifact changed after review")
            chunks = []
            remaining = entry["size"] + 1
            while remaining > 0:
                chunk = os.read(leaf, min(remaining, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        finally:
            os.close(leaf)
    finally:
        os.close(root)
    if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise Refused(409, "artifact changed after review")
    return data


def content_type(path: str) -> str:
    return CONTENT_TYPES.get(PurePosixPath(path).suffix.lower(), "application/octet-stream")


def resolve(method: str, target: str, headers, outbox: str, manifest: str, max_bytes: int):
    """(status, headers, body) for one request. Pure, so tests need no socket."""
    if method not in ("GET", "HEAD"):
        raise Refused(405, "only GET and HEAD")
    if "?" in target or "#" in target:
        raise Refused(400, "query strings are refused")
    if not target.startswith("/") or "//" in target or "%" in target:
        raise Refused(400, "only plain origin-form paths")
    for name in REFUSED_HEADERS:
        if headers.get(name):
            raise Refused(400, "credentials and cookies are refused")
    if headers.get("content-length") not in (None, "", "0") or headers.get("transfer-encoding"):
        raise Refused(400, "request bodies are refused")
    match = ROUTE.match(target)
    if not match:
        raise Refused(404, "not an artifact route")
    try:
        reviewed = load_manifest(manifest)
    except (OSError, ValueError):
        raise Refused(503, "no valid reviewed manifest") from None
    entry = reviewed.get(match.group(1))
    if entry is None:
        raise Refused(404, "artifact is not reviewed")
    data = read_reviewed(outbox, entry, max_bytes)
    out_headers = {
        "Content-Type": content_type(entry["path"]),
        "Content-Length": str(len(data)),
        "ETag": f"\"sha256:{entry['sha256']}\"",
        "X-Artifact-SHA256": entry["sha256"],
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    }
    return 200, out_headers, (b"" if method == "HEAD" else data)


def make_handler(outbox: str, manifest: str, max_bytes: int):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "artifact-origin"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def _answer(self, method: str) -> None:
            lowered = {k.lower(): v for k, v in self.headers.items()}
            try:
                status, headers, body = resolve(method, self.path, lowered, outbox, manifest, max_bytes)
            except Refused as refusal:
                status, body = refusal.status, (refusal.reason + "\n").encode()
                headers = {"Content-Type": "text/plain; charset=utf-8", "Content-Length": str(len(body)),
                           "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
                if method == "HEAD":
                    body = b""
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            if body:
                self.wfile.write(body)
            self.close_connection = True

        def do_GET(self) -> None:  # noqa: N802
            self._answer("GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._answer("HEAD")

        def _refuse(self) -> None:
            self._answer(self.command)

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = _refuse

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            # Path and status only: never headers.
            sys.stderr.write("artifact-origin: %s %s\n" % (self.command, self.path.split("?", 1)[0][:200]))

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only origin for reviewed artifacts.")
    parser.add_argument("--outbox", required=True, help="the agent's outbox, mounted read-only")
    parser.add_argument("--manifest", required=True, help="the reviewed manifest, mounted read-only")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8647)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)
    if not os.path.isdir(args.outbox):
        print(f"artifact-origin: off: outbox {args.outbox} is not a directory", file=sys.stderr)
        return 2
    server = http.server.ThreadingHTTPServer((args.bind, args.port),
                                             make_handler(args.outbox, args.manifest, args.max_bytes))
    print(f"artifact-origin: serving reviewed artifacts on port {args.port}", file=sys.stderr, flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
