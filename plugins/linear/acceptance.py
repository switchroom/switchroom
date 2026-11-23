"""Read-only GitHub REST reads for the Linear plugin, as the ambient ``gh`` login.

Native Done is Linear Done (F28, 23 Nov 2026): PR checks no longer gate a closeout, so the
exact-head acceptance proof, its Actions fallback and the waits around them are gone. What is left
is the one ``gh api`` reader used to show a PR's current state in the closing note, to resume work
parked on an open PR once it merged or closed, and to read CI for a CI wait. gh's stderr is never kept.
"""
from __future__ import annotations

import json
import re
import subprocess
from typing import Any


class Denied(Exception):
    """GitHub refused the read (401/403/404) or gh has no login. ``status`` is the HTTP code, if any."""

    def __init__(self, message: str, status: str | None = None) -> None:
        super().__init__(message)
        self.status = status


class Unavailable(Exception):
    """GitHub did not answer usefully: network, rate limit, timeout or a malformed reply."""


def gh_api(endpoint: str, *, paginate: bool = False) -> Any:
    """One ``gh api`` read as the ambient login (the same login core's verifier used)."""
    path = endpoint.split("?")[0]
    command = ["gh", "api", endpoint, "--hostname", "github.com"]
    if paginate:
        command += ["--paginate", "--slurp"]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=30, check=True)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr or ""
        if "rate limit" in stderr.lower():
            raise Unavailable(f"GitHub rate limit on {path}") from None
        denied = re.search(r"HTTP (40[134])", stderr)
        if denied:
            raise Denied(f"HTTP {denied[1]} on {path}", denied[1]) from None
        if exc.returncode == 4:  # gh's authentication-required exit
            raise Denied(f"gh has no login for {path}") from None
        raise Unavailable(f"gh api failed on {path}") from None
    except (OSError, subprocess.SubprocessError):
        raise Unavailable(f"gh api unavailable for {path}") from None
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise Unavailable(f"GitHub returned unreadable JSON for {path}") from None
