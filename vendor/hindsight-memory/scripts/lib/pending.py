"""Persistent queue for failed retain payloads.

When a SessionEnd retain fails, the only on-disk record of the turn's
memory is the just-closed transcript — and the agent thinks it was
persisted. To prevent silent data loss (#1071), session_end.py
serializes the *exact retain payload* it would have POSTed into
``~/.hindsight/pending-retains/<unix-ms>-<short-uuid>.json``. The next
SessionStart drains the directory: oldest first, success deletes,
failure bumps an attempt counter (up to MAX_ATTEMPTS) and leaves the
entry for the run after that.

Layout
------
``~/.hindsight/pending-retains/`` (mode 0700, may contain sensitive
memory payloads).

Inside a Switchroom docker agent, ``$HOME`` is the agent UID's home
inside the container, which is NOT a bind-mounted volume. The queue
therefore survives session-to-session within a container's lifetime
(the common case: claude session ends → container keeps running → next
session drains) but NOT container recreate. That's deliberate: this is
a rescue queue for transient retain failures, not a long-term DLQ.
If the upstream is broken long enough that the agent container gets
recreated, the operator has bigger problems and ``switchroom doctor``
already surfaced the backlog.
Each entry is a JSON file ``<unix-ms>-<short-uuid>.json`` containing::

    {
      "schema": 1,
      "api_url":     "<resolved Hindsight URL at time of failure>",
      "api_token":   "<bearer token or null>",
      "bank_id":     "<derived bank id>",
      "document_id": "<retain document id>",
      "content":     "<formatted transcript>",
      "context":     "<retainContext>",
      "metadata":    {...},
      "tags":        [...] or null,
      "failed_at":   "<ISO-8601 UTC>",
      "error_class": "<exception class name>",
      "error_message": "<str(e)>",
      "attempt_count": 1
    }

The file is written via ``write tmp + rename`` so concurrent agents
sharing ``$HOME`` (legacy installs) never observe a half-written entry.

Bounded directory
-----------------
``MAX_ENTRIES`` (1000) caps the queue. When full, ``enqueue()`` refuses
the entry and returns ``None`` — the caller logs loudly and the operator
is expected to drain manually. A chronically full queue means upstream
is broken for a long time; piling on more entries doesn't help.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Optional


SCHEMA = 1
MAX_ENTRIES = 1000
MAX_ATTEMPTS = 5


def pending_dir() -> str:
    """Return the pending-retains directory path.

    Override with ``HINDSIGHT_PENDING_DIR`` for tests. Default:
    ``$HOME/.hindsight/pending-retains/``.
    """
    override = os.environ.get("HINDSIGHT_PENDING_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".hindsight", "pending-retains")


def _ensure_dir() -> str:
    """Create the queue dir with mode 0700 if missing. Return its path."""
    d = pending_dir()
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700, exist_ok=True)
    else:
        # Tighten perms if a previous run created it with looser bits.
        try:
            mode = os.stat(d).st_mode & 0o777
            if mode != 0o700:
                os.chmod(d, 0o700)
        except OSError:
            pass
    return d


def _list_entries(d: str) -> list[str]:
    """Return sorted filenames (oldest first by lexicographic order on
    the ``<unix-ms>-<uuid>.json`` filename pattern).
    """
    try:
        names = [n for n in os.listdir(d) if n.endswith(".json")]
    except FileNotFoundError:
        return []
    names.sort()
    return names


def count() -> int:
    """Number of pending entries. Safe to call when dir doesn't exist."""
    d = pending_dir()
    return len(_list_entries(d))


def enqueue(payload: dict, error: BaseException) -> Optional[str]:
    """Persist a failed retain payload.

    ``payload`` carries the exact arguments that would have gone to
    ``client.retain()`` plus connection info (``api_url``, ``api_token``)
    so the drainer can rebuild the client without re-resolving config.

    Returns the absolute path of the written entry, or ``None`` if the
    queue is full (``MAX_ENTRIES`` reached). Atomic: writes ``<name>.tmp``
    then renames to ``<name>``.
    """
    d = _ensure_dir()
    if len(_list_entries(d)) >= MAX_ENTRIES:
        return None

    entry = dict(payload)
    entry["schema"] = SCHEMA
    entry["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry["error_class"] = type(error).__name__
    entry["error_message"] = str(error)
    entry.setdefault("attempt_count", 1)

    ts_ms = int(time.time() * 1000)
    short_uuid = uuid.uuid4().hex[:12]
    name = f"{ts_ms}-{short_uuid}.json"
    final = os.path.join(d, name)
    tmp = final + ".tmp"

    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.rename(tmp, final)
    return final


def iter_entries() -> list[tuple[str, dict]]:
    """Return ``[(path, entry_dict), ...]`` oldest first.

    Unreadable / malformed files are skipped silently — the drainer
    handles its own logging. We never crash the SessionStart hook on
    a corrupt entry.
    """
    d = pending_dir()
    out: list[tuple[str, dict]] = []
    for name in _list_entries(d):
        p = os.path.join(d, name)
        try:
            with open(p, encoding="utf-8") as f:
                out.append((p, json.load(f)))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def delete_entry(path: str) -> bool:
    """Remove a queue entry. Returns True on success, False otherwise."""
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def update_attempt(path: str, entry: dict, error: BaseException) -> bool:
    """Persist an updated attempt count + error info back to ``path``.

    Atomic: writes ``<path>.tmp`` then renames. Returns True on success.
    """
    entry["attempt_count"] = int(entry.get("attempt_count", 1)) + 1
    entry["last_attempt_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry["error_class"] = type(error).__name__
    entry["error_message"] = str(error)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.rename(tmp, path)
        return True
    except OSError:
        return False


def mark_dead(path: str, entry: dict) -> Optional[str]:
    """Convert an entry that exceeded ``MAX_ATTEMPTS`` into a permanent
    failure marker at ``<path>.dead`` so the queue no longer drains it
    but operators can still inspect.

    Returns the marker path, or ``None`` if it failed.

    Crash-window invariant (#1094 item 3): **a live ``<path>.json`` entry
    must never carry a ``dead_at`` stamp.** The old two-step form violated
    this — it wrote the dead_at-stamped payload back to the *live* path
    (rename tmp -> path) and only then renamed path -> path.dead, so a
    crash between the two renames left a live entry with ``dead_at`` set
    that the drainer would re-enter and re-bump. Here we instead:

      1. write the dead_at-stamped payload to ``<path>.tmp``
      2. ``os.replace(tmp, dead_path)``  — the .dead marker appears in one
         atomic step (never drained: the drainer only lists ``*.json``)
      3. ``os.unlink(path)``            — drop the original live entry

    At every crash point the invariant holds: the ``dead_at`` stamp only
    ever lands on ``<path>.dead``. A crash after step 2 leaves both the
    (stale, no-dead_at) live entry and the .dead marker; the next drain
    re-marks it dead (os.replace overwrites the marker idempotently),
    never observing a live entry with dead_at.
    """
    entry["dead_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    dead_path = path + ".dead"
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dead_path)
        # Marker is durable now; removing the original never resurrects a
        # dead_at-stamped live entry. Best-effort — a leftover live entry
        # is self-healing (re-marked dead on the next pass).
        try:
            os.unlink(path)
        except OSError:
            pass
        return dead_path
    except OSError:
        # Clean up a possibly-orphaned tmp so it doesn't linger.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return None
