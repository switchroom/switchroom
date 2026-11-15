#!/usr/bin/env python3
"""Prove a published artifact serves exactly the reviewed bytes.

Fetches one URL with no redirects, no credentials and no cookies, bounds the
response, requires an exact 200 and compares the body's SHA-256 with the
expected file or digest. A login page, a redirect or a mismatch is a failure,
never delivery.

  verify_artifact.py --url http://127.0.0.1:8647/artifact/<uuid>/ --expected-file report.html
  verify_artifact.py --url https://artifacts.example.test/artifact/<uuid>/ --expected-sha256 <hex>
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
import urllib.error
import urllib.request

DEFAULT_MAX_BYTES = 25 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


def fetch(url: str, max_bytes: int, timeout: float = 30.0) -> tuple[int, bytes]:
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "artifact-verify"})
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(max_bytes + 1)
            return response.status, body
    except urllib.error.HTTPError as error:
        return error.code, b""


def verify(url: str, expected_sha256: str, max_bytes: int = DEFAULT_MAX_BYTES) -> str:
    if not re.fullmatch(r"https?://[^/?#@]+/artifact/[0-9a-f-]{36}/", url):
        return "refused: the URL must be an /artifact/<uuid>/ route with no credentials or query"
    status, body = fetch(url, max_bytes)
    if status != 200:
        return f"failed: HTTP {status}, expected exactly 200"
    if len(body) > max_bytes:
        return "failed: response is larger than the limit"
    digest = hashlib.sha256(body).hexdigest()
    if digest != expected_sha256:
        return f"failed: served sha256 {digest} does not match the reviewed {expected_sha256}"
    return f"ok: {len(body)} bytes, sha256 {digest}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify a published artifact byte for byte.")
    parser.add_argument("--url", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--expected-file")
    group.add_argument("--expected-sha256")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)
    if args.expected_file:
        with open(args.expected_file, "rb") as handle:
            expected = hashlib.sha256(handle.read()).hexdigest()
    else:
        expected = args.expected_sha256.lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            parser.error("--expected-sha256 must be 64 hex characters")
    result = verify(args.url, expected, args.max_bytes)
    print(result)
    return 0 if result.startswith("ok:") else 1


if __name__ == "__main__":
    raise SystemExit(main())
