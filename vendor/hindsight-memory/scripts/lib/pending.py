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

Bounded directory (switchroom #3596 — evict oldest, never refuse newest)
-----------------------------------------------------------------------
``MAX_ENTRIES`` and ``MAX_BYTES`` bound the queue, both env-overridable.
When either binds, ``enqueue()`` evicts the OLDEST entries into a bounded
archive (``pending-evicted/``) to make room, rather than refusing the
incoming — newest, most likely to matter — memory.

This is a PORT of the design validated out of band on the live fleet and
already in force there via env in ``switchroom.yaml`` (the file patches
themselves do not survive ``switchroom apply``, which is precisely why
this belongs in-repo). Refusing the newest entry was the wrong end to
shed from; the cap size was never the real bug.

Sizing rationale (measured 2026-07-25 on this fleet, carried over from
the validated patch): 5,751 queued entries occupied 432 MB — ~75 KB mean,
but content spans 499 B .. 744 KB (p50 21 KB), so a count cap alone
bounds disk only to within ~1500x; hence ``MAX_BYTES``. Retain fires
every 3rd turn and the busiest agent queues ~100 entries/day, so 2000
entries is ~3 weeks of total upstream outage headroom.

Deduplication
-------------
``reconcile_tail`` re-enqueues the same transcript slice on every boot
until its watermark is confirmed, so a stalled upstream multiplied one
memory into dozens of identical files (measured: 63% of the fleet queue,
84.7 MB). Same bank + same content-derived ``document_id`` + same content
is the same memory — the daemon would upsert them onto one document
anyway — so ``enqueue()`` returns the existing path instead of writing a
copy.

Residual drops
--------------
With eviction in place a *drop* is now rare: it means the entry could not
be written at all (disk full, permissions) even after making room. That
residual case still must not be silent, so it is recorded in the
``pending-drops.json`` ledger — a sibling of the queue dir, like the
eviction log, so it can never be mistaken for a queue entry.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
import uuid
from typing import Optional


SCHEMA = 1

# Queue bounds. BOTH are enforced; whichever binds first triggers eviction.
# Env-driven so the operator can retune without a plugin redeploy — and so
# the values already set fleet-wide in switchroom.yaml keep working.
MAX_ENTRIES = int(os.environ.get("HINDSIGHT_PENDING_MAX_ENTRIES") or 2000)
MAX_BYTES = int(os.environ.get("HINDSIGHT_PENDING_MAX_BYTES") or (256 * 1024 * 1024))
# The archive is bounded too, else eviction just relocates the disk problem.
ARCHIVE_MAX_ENTRIES = int(
    os.environ.get("HINDSIGHT_PENDING_ARCHIVE_MAX_ENTRIES") or 500
)
ARCHIVE_MAX_BYTES = int(
    os.environ.get("HINDSIGHT_PENDING_ARCHIVE_MAX_BYTES") or (64 * 1024 * 1024)
)
MAX_ATTEMPTS = 5

#: Residual-drop ledger. A SIBLING of the queue directory (like the
#: eviction log), never inside it — so it can never be listed as an entry,
#: drained, or counted against the caps.
DROPS_FILE = "pending-drops.json"

#: Cap on the stored ``error_message`` / ``last_error_message``. Upstream
#: errors can carry a full HTTP body; an unbounded copy per entry inflates
#: the queue against MAX_BYTES for no diagnostic gain.
MAX_ERROR_MESSAGE_CHARS = 500


def _clip_error(e: BaseException) -> str:
    """``str(e)`` truncated to ``MAX_ERROR_MESSAGE_CHARS``."""
    s = str(e)
    if len(s) <= MAX_ERROR_MESSAGE_CHARS:
        return s
    return s[:MAX_ERROR_MESSAGE_CHARS] + "…[truncated]"


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


def _sibling(name: str) -> str:
    """Path to ``name`` as a sibling of the queue directory."""
    return os.path.join(os.path.dirname(pending_dir().rstrip("/")), name)


def evicted_dir() -> str:
    """Archive directory for FIFO-evicted entries (sibling of the queue)."""
    return os.environ.get("HINDSIGHT_PENDING_EVICTED_DIR") or _sibling(
        "pending-evicted"
    )


def evictions_log_path() -> str:
    """Append-only eviction ledger.

    This is the deterministic, machine-readable signal that memories are
    being shed — ``switchroom doctor`` reads it. Eviction is not silent
    data loss, but it IS loss, so it must never be inferable only from a
    depth reading.
    """
    return _sibling("pending-evictions.log")


def drops_path() -> str:
    """Path of the residual-drop ledger (sibling of the queue dir)."""
    return _sibling(DROPS_FILE)


def _dir_bytes(d: str, names) -> int:
    total = 0
    for n in names:
        try:
            total += os.path.getsize(os.path.join(d, n))
        except OSError:
            pass
    return total


def _trim_archive() -> None:
    """Keep the archive under its own count/byte caps, oldest-first."""
    a = evicted_dir()
    try:
        names = sorted(n for n in os.listdir(a) if n.endswith(".json"))
    except OSError:
        return
    while names and (
        len(names) > ARCHIVE_MAX_ENTRIES or _dir_bytes(a, names) > ARCHIVE_MAX_BYTES
    ):
        try:
            os.remove(os.path.join(a, names[0]))
        except OSError:
            pass
        names.pop(0)


def _log_eviction(name: str, size: int, reason: str, depth: int, nbytes: int) -> None:
    line = "%s evicted=%s bytes=%d reason=%s queue_depth=%d queue_bytes=%d" % (
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        name,
        size,
        reason,
        depth,
        nbytes,
    )
    try:
        with open(evictions_log_path(), "a", encoding="utf-8") as f:
            print(line, file=f)
    except OSError:
        pass
    print(
        "[Hindsight] pending-retains FULL - evicted OLDEST entry to keep the "
        "newest memory: %s (%d bytes, %s; queue now %d entries / %d bytes). "
        "Archived under %s." % (name, size, reason, depth, nbytes, evicted_dir()),
        file=sys.stderr,
    )


def _evict_to_fit(d: str, incoming_bytes: int) -> int:
    """Evict oldest entries until the incoming entry fits under BOTH caps.

    Returns the number of entries evicted. FIFO: oldest filename first,
    which is oldest by wall-clock because names are ``<unix-ms>-<uuid>.json``.
    """
    names = _list_entries(d)
    nbytes = _dir_bytes(d, names)
    evicted = 0
    archive = evicted_dir()
    while names and (
        len(names) + 1 > MAX_ENTRIES or nbytes + incoming_bytes > MAX_BYTES
    ):
        reason = "count" if len(names) + 1 > MAX_ENTRIES else "bytes"
        victim = names.pop(0)
        vpath = os.path.join(d, victim)
        try:
            vsize = os.path.getsize(vpath)
        except OSError:
            vsize = 0
        try:
            os.makedirs(archive, mode=0o700, exist_ok=True)
            shutil.move(vpath, os.path.join(archive, victim))
        except OSError:
            # Archiving failed (disk full / perms). Still evict — keeping the
            # newest memory is the priority — but say so loudly.
            try:
                os.remove(vpath)
            except OSError:
                break
            reason += "+archive-failed"
        nbytes -= vsize
        evicted += 1
        _log_eviction(victim, vsize, reason, len(names), nbytes)
    if evicted:
        _trim_archive()
    return evicted


def _dupe_key(entry: dict) -> tuple:
    """Identity of a queued retain: (bank, document, content-hash).

    ``document_id`` is already content-derived, so two entries sharing
    this key are the same memory and the daemon would upsert them onto
    the same document.
    """
    content = entry.get("content")
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False, sort_keys=True)
    return (
        entry.get("bank_id"),
        entry.get("document_id"),
        hashlib.sha256(content.encode("utf-8")).hexdigest(),
    )


def _find_duplicate(d: str, entry: dict, blob_bytes: int) -> Optional[str]:
    """Return the path of an already-queued identical entry, or ``None``.

    Size-indexed: ``os.stat()`` is cheap, and only files of EXACTLY the
    incoming size are opened and hashed — normally zero or one — so this
    stays O(dir listing) even at a 2000-entry queue.
    """
    try:
        key = _dupe_key(entry)
    except Exception:
        return None
    if key[1] is None:
        return None  # no document_id -> cannot establish identity, keep it
    for name in _list_entries(d):
        p = os.path.join(d, name)
        try:
            if os.path.getsize(p) != blob_bytes:
                continue
            with open(p, encoding="utf-8") as f:
                other = json.load(f)
        except (OSError, ValueError):
            continue
        try:
            if _dupe_key(other) == key:
                return p
        except Exception:
            continue
    return None


def read_drops() -> dict:
    """Return the residual-drop ledger, or ``{}`` when nothing was dropped.

    Never raises. Catching ``ValueError`` (not ``json.JSONDecodeError``)
    is deliberate: ``open(..., encoding="utf-8")`` raises
    ``UnicodeDecodeError`` — a ``ValueError`` subclass, NOT a
    ``JSONDecodeError`` — on a non-UTF-8 ledger. A narrower catch would
    let a corrupt ledger turn ``enqueue()`` from "returns ``None``" into
    a raiser at exactly the moment the queue is under stress, breaking
    ``session_end.py`` / ``subagent_retain.py``, which handle ``None``.
    """
    try:
        with open(drops_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def record_drop(payload: dict, error: BaseException) -> int:
    """Record one permanently-dropped retain. Returns the new total.

    A drop is the residual case: the payload could not be written even
    after eviction made room (disk full, permissions). Rare, but the one
    outcome where a turn's memory is genuinely gone, so it gets a loud
    stderr line plus a durable ledger entry.

    NOTE (accepted, not a silent bug): the ``count`` bump is a
    read-modify-write with no lock. Two hooks dropping concurrently in
    the same ``$HOME`` can lose an increment, so ``count`` is a floor,
    not an exact tally. That is acceptable — the ledger's job is to make
    loss *visible*, and any non-zero count already fails the doctor row.
    Locking here would mean taking a lock on the disk-full path, which is
    exactly where it is most likely to wedge.
    """
    ledger = read_drops()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        prev = int(ledger.get("count", 0))
    except (TypeError, ValueError):
        prev = 0
    count_now = prev + 1
    ledger.update(
        {
            "schema": SCHEMA,
            "count": count_now,
            "last_dropped_at": now,
            "last_error_class": type(error).__name__,
            "last_error_message": _clip_error(error),
            "last_bank_id": payload.get("bank_id"),
        }
    )
    ledger.setdefault("first_dropped_at", now)

    p = drops_path()
    tmp = p + ".tmp"
    try:
        os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(ledger, f, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    print(
        f"[Hindsight] pending-retains: DROPPED a failed retain for bank "
        f"{payload.get('bank_id')!r} — could not write the queue entry even "
        f"after eviction, so this turn's memory is permanently lost "
        f"({type(error).__name__}: {_clip_error(error)}). "
        f"Total dropped so far: {count_now}.",
        file=sys.stderr,
    )
    return count_now


def enqueue(payload: dict, error: BaseException) -> Optional[str]:
    """Persist a failed retain payload.

    ``payload`` carries the exact arguments that would have gone to
    ``client.retain()`` plus connection info (``api_url``, ``api_token``)
    so the drainer can rebuild the client without re-resolving config.

    Returns the absolute path of the entry — which may be an EXISTING
    identical entry (dedupe) — or ``None`` in the residual case where the
    entry could not be written at all. Atomic: writes ``<name>.tmp`` then
    renames to ``<name>``.

    A full queue no longer refuses the incoming entry: ``_evict_to_fit()``
    sheds the OLDEST entries into ``pending-evicted/`` instead. Refusing
    the newest memory was the wrong end to shed from — it is the turn most
    likely to still matter.
    """
    d = _ensure_dir()

    entry = dict(payload)
    entry["schema"] = SCHEMA
    entry["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry["error_class"] = type(error).__name__
    entry["error_message"] = _clip_error(error)
    entry.setdefault("attempt_count", 1)

    ts_ms = int(time.time() * 1000)
    short_uuid = uuid.uuid4().hex[:12]
    name = f"{ts_ms}-{short_uuid}.json"
    final = os.path.join(d, name)
    tmp = final + ".tmp"

    blob = json.dumps(entry, ensure_ascii=False)
    blob_bytes = len(blob.encode("utf-8"))

    # DEDUPE first: reconcile_tail re-enqueues the same transcript slice on
    # every boot until its watermark is confirmed, so a stalled upstream used
    # to multiply one memory into dozens of identical queue files. Returning
    # the existing path keeps every caller's "queued" contract intact.
    dup = _find_duplicate(d, entry, blob_bytes)
    if dup is not None:
        return dup

    # Then make room by evicting the OLDEST entries rather than refusing
    # this (newest, most valuable) one.
    _evict_to_fit(d, blob_bytes)

    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(blob)
        os.chmod(tmp, 0o600)
        os.rename(tmp, final)
    except OSError as write_err:
        # Residual drop: room was made and the write STILL failed (disk
        # full, permissions). This is the only path that now loses a turn,
        # and it is recorded rather than returned bare — callers handle
        # ``None``, but none of them can see *why* without the ledger.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        record_drop(payload, write_err)
        return None
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
    entry["error_message"] = _clip_error(error)
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
