"""M4 P0 — prefetch buffer + sentinel primitive.

The end-of-turn-N Stop hook (``prefetch.py``) writes a prefetched recall
block into a per-session buffer file, then writes a ``buffer.done`` sentinel
LAST. The start-of-turn-N+1 UserPromptSubmit hook (``recall.py``) polls for a
FRESH sentinel (bounded by ``poll_for_sentinel``'s ``cap_ms``) and, on a hit,
consumes the buffered block instead of running recall synchronously.

Read-after-write safety (the whole ballgame — carve §4 note 1):

  * The payload is written via temp-file + atomic ``os.replace`` (POSIX
    atomic within the same directory).
  * The sentinel is written LAST, also via temp-file + ``os.fsync`` +
    atomic ``os.replace``, and carries a MONOTONIC token (a `time.time_ns()`
    counter, not wall-clock-comparable across machines but perfectly
    ordered within one) — never content or mtime comparison, since two
    writes CAN land in the same filesystem mtime tick.
  * ``read_if_fresh`` treats "sentinel absent" OR "sentinel token not newer
    than ``last_consumed_token``" as a miss (``None``). A torn write
    (payload present, sentinel absent — e.g. the producer crashed between
    the two writes) is INDISTINGUISHABLE from "no fresh buffer yet" by
    construction, so it fails closed to ``None`` rather than serving a
    possibly-incomplete/stale payload.

State dir: ``$HOME/.hindsight/prefetch-buffer/`` (override via
``HINDSIGHT_PREFETCH_BUFFER_DIR`` for tests), mirroring the
``lib/watermark.py`` convention (a distinct dir, not a shared one, so a
polling reader and a writing producer never contend for the same files as
unrelated retain-watermark state).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Optional

if sys.platform != "win32":
    import fcntl
else:  # pragma: no cover - switchroom agents are Linux only
    fcntl = None

SCHEMA = 1

# Default poll behaviour (Hermes's 3s join, hand-rolled — P-REC/P-PRE tune
# the actual cap via config; this is the primitive's own conservative floor
# if a caller passes a cap smaller than one sleep tick).
_MIN_SLEEP_S = 0.02
_MAX_SLEEP_S = 0.1


def buffer_dir() -> str:
    """Return the prefetch-buffer directory.

    Override with ``HINDSIGHT_PREFETCH_BUFFER_DIR`` (tests). Default:
    ``$HOME/.hindsight/prefetch-buffer/``.
    """
    override = os.environ.get("HINDSIGHT_PREFETCH_BUFFER_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".hindsight", "prefetch-buffer")


def _ensure_dir() -> str:
    d = buffer_dir()
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700, exist_ok=True)
    else:
        try:
            mode = os.stat(d).st_mode & 0o777
            if mode != 0o700:
                os.chmod(d, 0o700)
        except OSError:
            pass
    return d


def _safe_session(session_id: str) -> str:
    """Sanitise a session id for use as a filename (no path traversal)."""
    keep = [c if (c.isalnum() or c in "-_.") else "_" for c in (session_id or "unknown")]
    name = "".join(keep)[:200]
    return name.replace("..", "_") or "unknown"


def _buffer_path(session_id: str) -> str:
    return os.path.join(buffer_dir(), f"{_safe_session(session_id)}.buffer.json")


def _sentinel_path(session_id: str) -> str:
    return os.path.join(buffer_dir(), f"{_safe_session(session_id)}.buffer.done")


def write_buffer(
    session_id: str,
    context: str,
    telemetry: Optional[dict] = None,
    query: Optional[str] = None,
) -> None:
    """Write the prefetched recall payload for ``session_id``.

    Atomic (temp file + ``os.replace`` within the same directory). Does NOT
    write the sentinel — the caller MUST call ``write_sentinel`` after this,
    and only once the payload write has returned, to preserve the
    read-after-write ordering guarantee.

    ``query`` (#4778) is the speculative query the producer used to build this
    buffer. It is stored verbatim so the consumer can gate the join on topical
    similarity between it and turn N+1's ACTUAL prompt — the buffer is keyed by
    ``session_id`` alone and, without this, a fresh buffer built for the prior
    turn is served on a topic pivot regardless of relevance. A ``None``/absent
    query is stored as ``""``, which the consumer treats as "cannot establish a
    topic match" and falls through to synchronous recall (fail-safe; also the
    backward-compat behaviour for buffers written before this field existed).
    """
    d = _ensure_dir()
    final = _buffer_path(session_id)
    tmp = final + f".tmp.{os.getpid()}"
    entry = {
        "schema": SCHEMA,
        "session_id": session_id,
        "context": context,
        "query": query or "",
        "telemetry": telemetry or {},
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, final)


def write_sentinel(session_id: str) -> int:
    """Write the ``buffer.done`` sentinel for ``session_id``, LAST.

    Returns the monotonic token written (an ever-increasing integer derived
    from ``time.time_ns()``, disambiguated against the previous token on
    this session so two writes within the same nanosecond still order).
    fsync'd before the atomic rename so a reader that observes the renamed
    file is guaranteed to observe durable content.
    """
    d = _ensure_dir()
    final = _sentinel_path(session_id)
    token = time.time_ns()
    # Guarantee strict monotonicity even under nanosecond-resolution ties or
    # clock weirdness: never emit a token <= the previously written one.
    prev = _read_sentinel_token(session_id)
    if prev is not None and token <= prev:
        token = prev + 1
    tmp = final + f".tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"schema": SCHEMA, "token": token}, f)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, final)
    return token


def _read_sentinel_token(session_id: str) -> Optional[int]:
    path = _sentinel_path(session_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        token = data.get("token")
        return int(token) if token is not None else None
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        return None


def _read_buffer_payload(session_id: str) -> Optional[dict]:
    path = _buffer_path(session_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def sentinel_exists(session_id: str) -> bool:
    """Return True iff a ``buffer.done`` sentinel has EVER been written for
    ``session_id`` (regardless of freshness).

    Cold-start guard (red-team MAJOR finding): a reader must be able to tell
    "no producer has ever run for this session" from "a producer ran but
    hasn't finished this turn's slice yet" WITHOUT paying the full poll cap
    — the former should skip polling entirely (every session-open turn
    would otherwise eat the full poll cap, the opposite of M4's latency
    goal), the latter is exactly what polling is for.
    """
    return os.path.isfile(_sentinel_path(session_id))


def read_if_fresh(session_id: str, last_consumed_token: Optional[int]) -> tuple:
    """Return ``(payload_dict | None, current_token)``.

    ``payload_dict`` (when present) is
    ``{"context": str, "query": str, "telemetry": dict}``. ``query`` (#4778) is
    the speculative query the buffer was built for — the consumer uses it to
    gate the join on topical similarity to turn N+1's prompt. It is ``""`` for a
    legacy buffer written before the field existed.

    Returns ``(None, token_or_last_consumed)`` when:
      * no sentinel exists yet (nothing has been produced this session), or
      * the sentinel's token is not strictly newer than ``last_consumed_token``
        (already consumed — stale from the reader's perspective), or
      * the buffer payload itself is missing/corrupt (a torn write, or a
        sentinel written with no payload at all) — fail-closed, never serve
        a partial/absent payload as fresh.
    """
    token = _read_sentinel_token(session_id)
    if token is None:
        return None, last_consumed_token
    if last_consumed_token is not None and token <= last_consumed_token:
        return None, token
    payload = _read_buffer_payload(session_id)
    if payload is None:
        # Torn write: sentinel landed but payload didn't (or is corrupt).
        # Fail-closed — never serve this as fresh.
        return None, token
    return {
        "context": payload.get("context", ""),
        "query": payload.get("query", ""),
        "telemetry": payload.get("telemetry", {}),
    }, token


def invalidate(session_id: str) -> None:
    """Drop any pending prefetch buffer + sentinel for ``session_id``.

    Called at MUTATION sites — a rule/directive retire (``directive_verify``)
    or a retain (``prefetch.run_prefetch`` before it re-recalls) — so a buffer
    captured BEFORE the mutation can never be consumed AFTER it. This closes
    the resurrection class the M3 red-team (R2, BLOCKER) flagged at the
    M3/M4 intersection: a rule retired mid-session must not re-inject from a
    buffer prefetched while the rule was still active. It is the read-after-
    write ordering the producer already builds for the happy path, extended
    to the mutation path — NOT a reliance on the buffer's TTL (timing, not
    correctness).

    The SENTINEL is removed FIRST so a partial invalidation still fails
    closed: ``read_if_fresh`` checks the sentinel before the payload, so once
    the sentinel is gone the reader returns ``None`` regardless of whether the
    payload unlink also succeeded — an orphaned payload is never served as
    fresh. Best-effort and idempotent: a missing file is a no-op, and the
    function NEVER raises (a failed unlink must not break the turn).
    """
    for path in (_sentinel_path(session_id), _buffer_path(session_id)):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def poll_for_sentinel(session_id: str, last_consumed_token: Optional[int], cap_ms: int) -> bool:
    """Clock-bounded poll for a fresh sentinel. Never busy-spins.

    Returns True as soon as ``read_if_fresh`` would return a payload; False
    once the cumulative sleep time reaches ``cap_ms``. Short sleeps (20-100ms,
    backing off) sum to at most ``cap_ms`` — never a hard-loop re-stat.
    """
    if cap_ms <= 0:
        ctx, _ = read_if_fresh(session_id, last_consumed_token)
        return ctx is not None

    deadline = time.monotonic() + (cap_ms / 1000.0)
    sleep_s = _MIN_SLEEP_S
    while True:
        ctx, _ = read_if_fresh(session_id, last_consumed_token)
        if ctx is not None:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        this_sleep = min(sleep_s, remaining, _MAX_SLEEP_S)
        if this_sleep > 0:
            time.sleep(this_sleep)
        sleep_s = min(sleep_s * 1.5, _MAX_SLEEP_S)
