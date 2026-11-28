#!/command/with-contenv /opt/hermes/.venv/bin/python3
"""Container-start cleanup of a Bot Screen Chromium lock left by the previous container.

Installed as /etc/cont-init.d/017-bot-screen-stale-lock. cont-init.d runs before s6 starts any service, so no
Chromium of THIS container can hold a profile yet. Recreating a container while its Bot Screen Chromium ran
leaves, on the persistent volume:

- ``<home>/bot-desktop/browser-profile/Singleton{Lock,Cookie,Socket}``: the lock names ``<hostname>-<pid>`` of a
  process in the old PID namespace; and
- the launcher's record for that browser under ``<lock dir>/browser-shared-profiles/<digest>/``, tagged with the
  old namespace (``tools/browser_launcher.py``). ``_foreign_holder`` then reads the lock as a browser "in another
  environment" and every browser_* call refuses until someone deletes the lock by hand.

A record from another namespace cannot be judged dead by the launcher, by design. Here it can: the profile's
state lives in this container's own volume, the lock carries this container's hostname, and no process in this
namespace uses the profile, so the browser it names is gone with the old container. The cleanup keeps
everything whenever any of that is not proven: a live process naming the profile, a lock of another hostname, a
listening DevTools port, the launcher's records lock held, or an entry that is not what Chromium writes.

Record layout mirrors hermes-agent ``tools/browser_launcher.py`` / ``browser_launcher_holders.py``: state dir
``sha256(realpath(profile))[:32]``, records ``<digest16>-<pid><ns_tag>.json`` with ``pid``, ``user_data_dir`` and
``ns`` (pid-namespace inode ``:`` boot id), leases ``<record stem>@<holder><ns_tag>.lease``, lock ``.holders.lock``.
It never fails the boot: any error leaves the profile as it was.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import socket
import stat
import sys
from pathlib import Path
from typing import Iterator, Mapping, Optional

SINGLETONS = ("SingletonLock", "SingletonCookie", "SingletonSocket")


def log(message: str) -> None:
    print(f"[bot-screen-stale-lock] {message}", flush=True)


def ns_identity() -> Optional[str]:
    try:
        ino = os.stat("/proc/self/ns/pid").st_ino
        boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    except OSError:
        return None
    return f"{ino}:{boot}"


def profile_digest(profile: Path) -> str:
    return hashlib.sha256(os.path.realpath(profile).encode()).hexdigest()


def lock_dir(env: Mapping[str, str]) -> Path:
    """``gateway.status._get_lock_dir``: ``HERMES_GATEWAY_LOCK_DIR``, else absolute ``$XDG_STATE_HOME`` or
    ``~/.local/state``, + ``hermes/gateway-locks``."""
    if env.get("HERMES_GATEWAY_LOCK_DIR"):
        return Path(env["HERMES_GATEWAY_LOCK_DIR"])
    state = env.get("XDG_STATE_HOME") or ""
    if not os.path.isabs(state):
        state = os.path.join(env.get("HOME") or os.path.expanduser("~"), ".local", "state")
    return Path(state) / "hermes" / "gateway-locks"


def bot_screen_profiles(home: Path) -> list[Path]:
    homes = [home, *sorted(p for p in (home / "profiles").glob("*") if p.is_dir() and not p.is_symlink())]
    return [h / "bot-desktop" / "browser-profile" for h in homes if (h / "bot-desktop" / "browser-profile").is_dir()]


def _cmdline(pid: int) -> list[str]:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace").split("\0")
    except OSError:
        return []


def _names_profile(argv: list[str], profile: str) -> bool:
    for arg in argv:
        if arg.startswith("--user-data-dir="):
            if os.path.realpath(arg.split("=", 1)[1]) == profile:
                return True
    return False


def _process_using(profile: Path) -> Optional[int]:
    real = os.path.realpath(profile)
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and int(entry.name) != os.getpid() and _names_profile(_cmdline(int(entry.name)), real):
            return int(entry.name)
    return None


def _lock_owner(profile: Path) -> Optional[tuple[str, int]]:
    try:
        target = os.readlink(profile / "SingletonLock")
    except OSError:
        return None
    host, _, pid = target.rpartition("-")
    return (host, int(pid)) if pid.isdigit() else ("", -1)


def _devtools_listening(profile: Path) -> bool:
    try:
        port = int((profile / "DevToolsActivePort").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return False
    if not 1 <= port <= 65535:
        return False
    with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=0.5):
        return True
    return False


def _private_dir(path: Path) -> bool:
    try:
        st = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o022


@contextlib.contextmanager
def _records_lock(state: Path) -> Iterator[bool]:
    """The launcher's cross-process records lock, without waiting: held means someone is deciding right now."""
    if not _private_dir(state):
        yield True  # nothing (trustworthy) to clean
        return
    fd = os.open(state / ".holders.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        os.close(fd)


def _old_namespace_records(state: Path, profile: Path) -> list[Path]:
    if not _private_dir(state):
        return []
    real, here, found = os.path.realpath(profile), ns_identity(), []
    for path in sorted(state.glob(f"{profile_digest(profile)[:16]}-*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (isinstance(record, dict) and record.get("ns") != here and isinstance(record.get("user_data_dir"), str)
                and os.path.realpath(record["user_data_dir"]) == real and path.is_file() and not path.is_symlink()):
            found.append(path)
    return found


def clear_profile(profile: Path, locks: Path) -> bool:
    """Remove ``profile``'s Singleton* and old-namespace launcher records when provably stale. True if it removed any."""
    if not profile.is_dir():
        return False
    user = _process_using(profile)
    if user is not None:
        log(f"{profile}: in use by pid {user}; kept")
        return False
    owner = _lock_owner(profile)
    if owner is not None and owner[0] != socket.gethostname():
        log(f"{profile}: SingletonLock names host {owner[0]!r}, not this container; kept")
        return False
    if _devtools_listening(profile):
        log(f"{profile}: its DevTools port is listening; kept")
        return False
    state = locks / "browser-shared-profiles" / profile_digest(profile)[:32]
    removed: list[str] = []
    with _records_lock(state) as free:
        if not free:
            log(f"{profile}: launcher records lock is held; kept")
            return False
        for record in _old_namespace_records(state, profile):
            for lease in state.glob(f"{record.stem}@*.lease"):
                lease.unlink(missing_ok=True)
            record.unlink(missing_ok=True)
            removed.append(record.name)
        for name in SINGLETONS:
            path = profile / name
            if path.is_symlink():  # Chromium writes all three as symlinks; anything else is not ours to delete
                path.unlink(missing_ok=True)
                removed.append(name)
    if removed:
        log(f"{profile}: removed stale {', '.join(removed)}")
    return bool(removed)


def main(env: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if env is None else env
    try:
        home = Path(env.get("HERMES_HOME") or "/opt/data")
        locks = lock_dir(env)
        for profile in bot_screen_profiles(home):
            try:
                clear_profile(profile, locks)
            except Exception as exc:  # never block the container boot over a cleanup
                log(f"{profile}: skipped: {exc}")
    except Exception as exc:
        log(f"skipped: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
