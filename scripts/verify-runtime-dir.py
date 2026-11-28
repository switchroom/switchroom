#!/usr/bin/env python3
"""Bake-time check that the runtime UID owns XDG_RUNTIME_DIR (HF-856).

Runs inside the candidate image as its default user. The agent image bakes XDG_RUNTIME_DIR root-owned
and fixes it in a root start hook, which never runs here because this image starts as UID 1000; an
unowned directory makes every Bot Desktop start fail on its display-allocation lock, so Camoufox and
Take over never come up. This proves, without the network or a display:

* XDG_RUNTIME_DIR is /tmp/hermes-runtime, a real directory (not a symlink), owned 1000:1000, mode 0700,
  with no stale dbus-1 state;
* the Bot Desktop's start() reaches and takes its display-allocation lock in that directory.
"""
from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path

EXPECTED_DIR = Path("/tmp/hermes-runtime")
RUNTIME_UID = 1000
RUNTIME_GID = 1000


class LockTaken(Exception):
    """Raised from inside the allocation lock to stop start() before it launches a display."""


def fail(message: str) -> None:
    print(f"verify-runtime-dir: FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_dir(path: Path, uid: int, gid: int) -> list[str]:
    """Return every problem with ``path`` as a private runtime directory for ``uid``:``gid``."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return [f"{path} does not exist"]
    if stat.S_ISLNK(st.st_mode):
        return [f"{path} is a symlink"]
    if not stat.S_ISDIR(st.st_mode):
        return [f"{path} is not a directory"]
    problems = []
    if (st.st_uid, st.st_gid) != (uid, gid):
        problems.append(f"{path} is owned {st.st_uid}:{st.st_gid}, expected {uid}:{gid}")
    if stat.S_IMODE(st.st_mode) != 0o700:
        problems.append(f"{path} has mode {stat.S_IMODE(st.st_mode):o}, expected 700")
    if os.path.lexists(path / "dbus-1"):
        problems.append(f"{path}/dbus-1 is left over from the build")
    return problems


def check_alloc_lock(runtime_dir: Path) -> None:
    """Drive the real start() up to its allocation lock and stop it there."""
    from tools.bot_desktop import resources, runtime

    if runtime._ALLOC_LOCK.parent != runtime_dir:
        fail(f"Bot Desktop allocation lock is {runtime._ALLOC_LOCK}, expected it in {runtime_dir}")
    held = []

    def pick_display() -> int:  # called by start() with the allocation lock held
        held.append(runtime._ALLOC_LOCK.exists())
        raise LockTaken

    runtime._pick_display = pick_display
    resources.memory_blocker = lambda *args, **kwargs: None  # CI memory is not what this proves
    try:
        runtime.start(wait_seconds=1)
    except LockTaken:
        pass
    except PermissionError as exc:
        fail(f"Bot Desktop start() cannot take its allocation lock: {exc}")
    except RuntimeError as exc:
        fail(f"Bot Desktop start() stopped before its allocation lock: {exc}")
    else:
        fail("Bot Desktop start() returned without taking its allocation lock")
    if held != [True]:
        fail("Bot Desktop start() did not hold its allocation lock file")
    lock = os.lstat(runtime._ALLOC_LOCK)
    if lock.st_uid != os.getuid():
        fail(f"allocation lock is owned by uid {lock.st_uid}, not the runtime uid")


def main() -> None:
    if os.getuid() != RUNTIME_UID or os.getgid() != RUNTIME_GID:
        fail(f"run as {RUNTIME_UID}:{RUNTIME_GID}, not {os.getuid()}:{os.getgid()}")
    configured = os.environ.get("XDG_RUNTIME_DIR", "")
    if Path(configured) != EXPECTED_DIR:
        fail(f"XDG_RUNTIME_DIR is {configured!r}, expected {EXPECTED_DIR}")
    problems = check_dir(EXPECTED_DIR, RUNTIME_UID, RUNTIME_GID)
    if problems:
        fail("; ".join(problems))
    with tempfile.TemporaryDirectory(prefix="runtime-dir-home-") as home:
        os.environ["HERMES_HOME"] = home  # a throwaway profile: start() writes only its own state dir
        check_alloc_lock(EXPECTED_DIR)
    print(f"verify-runtime-dir: OK: {EXPECTED_DIR} is {RUNTIME_UID}:{RUNTIME_GID} 0700 and the "
          "Bot Desktop allocation lock is taken there")


if __name__ == "__main__":
    main()
