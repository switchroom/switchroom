"""Shared fleet pacing lock for Hindsight retain POSTs (switchroom #3244 §1.5).

A single per-agent advisory flock, ``$HOME/.hindsight/retain-inflight.lock``,
serialises the durability-path retain POSTs so at most ONE is in flight for an
agent at a time — covering the live Stop-hook retain, boot reconciliation, and
(PR2) the one-time backfill collectively. This is the "never storm the daemon"
guard.

Usage::

    from lib.pacing import inflight_lock

    with inflight_lock(blocking=False) as acquired:
        if not acquired:
            ...  # someone else holds it — enqueue and return, do NOT wait
        client.retain(...)

* Boot reconcile / backfill acquire it **blocking** (they are batch work and
  should wait their turn).
* The live Stop hook acquires it **non-blocking** (``blocking=False``): if a
  reconcile/backfill holds it the live retain must NOT wait (turn latency must
  not regress) — the caller enqueues its payload to ``pending-retains/`` and
  returns, and the next boot drain delivers it.

The context manager yields ``True`` when the lock was acquired (and releases it
on exit) and ``False`` when a non-blocking acquire failed (nothing to release).
It never raises on lock-infrastructure errors: if flock is unavailable it
fails OPEN (yields ``True``) so durability is never blocked by the lock itself.
"""

from __future__ import annotations

import contextlib
import os
import sys
from typing import Iterator

if sys.platform != "win32":
    import fcntl
else:  # pragma: no cover - switchroom agents are Linux only
    fcntl = None


def lock_path() -> str:
    """Path of the shared inflight lock. Override with ``HINDSIGHT_INFLIGHT_LOCK``."""
    override = os.environ.get("HINDSIGHT_INFLIGHT_LOCK")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".hindsight", "retain-inflight.lock")


@contextlib.contextmanager
def inflight_lock(blocking: bool = True) -> Iterator[bool]:
    """Acquire the shared inflight lock.

    Yields ``True`` if acquired (released on exit), ``False`` if a non-blocking
    acquire could not get it. Fails OPEN (yields ``True``, no real lock) when
    flock is unavailable so the durability path is never blocked by lock
    infrastructure.
    """
    if fcntl is None:
        yield True
        return

    path = lock_path()
    d = os.path.dirname(path)
    try:
        if d and not os.path.isdir(d):
            os.makedirs(d, mode=0o700, exist_ok=True)
    except OSError:
        # Can't even create the dir — fail open rather than block durability.
        yield True
        return

    lock_fd = None
    acquired = False
    try:
        lock_fd = open(path, "w")
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        try:
            fcntl.flock(lock_fd, flags)
            acquired = True
        except OSError:
            if blocking:
                # A blocking acquire that errored (not a would-block) — fail
                # open so batch work still makes progress.
                acquired = True
            else:
                acquired = False
        yield acquired
    except OSError:
        # Could not open the lock file at all — fail open.
        yield True
        return
    finally:
        if lock_fd is not None:
            try:
                if acquired:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            lock_fd.close()
