"""Durable per-session retain watermark (switchroom #3244).

Records, per ``(agent, session_id)``, the identity of the last transcript
entry that has been *confirmed* committed to the Hindsight bank. This is the
fact-on-disk that boot reconciliation (``reconcile_tail.py``) diffs against
the surviving ``.jsonl`` transcript to recover work an abrupt session death
(SIGKILL / OOM / watchdog) would otherwise silently drop.

Design (design-20260715.md §1.1):

* **Key = the message ``uuid`` of the last committed transcript entry.** Not
  a turn ordinal (compaction re-indexes) and not a byte offset (shifts on
  compaction); the ``uuid`` Claude Code stamps on every ``.jsonl`` entry is
  stable across compaction and unambiguous. A ``byte_offset_hint`` is stored
  as a fast-path only and never trusted alone.
* **Advance ONLY on confirmed persistence.** ``commit()`` is called only after
  a retain POST the caller made with commit-before-ack semantics
  (``async_processing=False``) returned ok. A watermark that is *behind*
  reality is safe (the reconciler re-POSTs, which upserts idempotently on the
  deterministic ``document_id``); a watermark *ahead* of reality would skip
  real work, so we never write it speculatively.
* **Never moves backward.** ``commit()`` compares the incoming ``last_uuid``'s
  position against the stored one *in the current transcript*; a stored uuid
  that compaction removed is treated as stale (accept the incoming commit) —
  a lost anchor can only cause a safe re-upsert, never a skip.
* **Atomic + flock.** ``write tmp -> fsync -> os.replace`` under an exclusive
  flock (mirrors ``lib/state.py`` / ``lib/pending.py``) so a concurrent async
  Stop hook and a SessionEnd force-retain writing the same session serialize
  and never observe a torn file.

Location: ``$HOME/.hindsight/retained/<session_id>.json`` — same
container-lifetime persistence semantics as ``pending-retains/``. Losing it on
container recreate is safe: no watermark => the reconciler treats the bounded
transcript tail as the gap and re-upserts.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional

if sys.platform != "win32":
    import fcntl
else:  # pragma: no cover - switchroom agents are Linux only
    fcntl = None

SCHEMA = 1


def watermark_dir() -> str:
    """Return the retained-watermark directory.

    Override with ``HINDSIGHT_RETAINED_DIR`` (tests). Default:
    ``$HOME/.hindsight/retained/``.
    """
    override = os.environ.get("HINDSIGHT_RETAINED_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".hindsight", "retained")


def _ensure_dir() -> str:
    d = watermark_dir()
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
    # Never allow a name that resolves to a traversal component.
    return name.replace("..", "_") or "unknown"


def _path(session_id: str) -> str:
    return os.path.join(watermark_dir(), f"{_safe_session(session_id)}.json")


def _lock_path(session_id: str) -> str:
    return os.path.join(watermark_dir(), f"{_safe_session(session_id)}.lock")


def tail_after(messages: list, last_uuid: Optional[str]) -> list:
    """Return the transcript entries AFTER the committed watermark anchor.

    Pure and IO-free — the single shared slice used by BOTH the boot reconciler
    (``reconcile_tail``) and the incremental SessionEnd sweep (``retain``, the
    switchroom memory-RFC P1 change). One implementation, so the reconcile /
    watermark failure category cannot grow a second, divergent copy.

    Two safety fallbacks, both returning the WHOLE transcript — a safe
    re-upsert, never a skip, never an empty slice:

    * ``last_uuid`` falsy (no committed watermark) — e.g. a short session that
      never fired a per-window retain, so the force sweep must flush it whole.
    * ``last_uuid`` absent from ``messages`` (compaction removed the anchor).

    Callers in the retain seam depend on the whole-transcript fallback: an empty
    or skipped slice there DELETES a turn rather than degrading it
    (``retain.py`` §4.3 hazard). Never change a fallback here to return ``[]``.
    """
    if not last_uuid:
        return list(messages)
    for i, m in enumerate(messages):
        if isinstance(m, dict) and m.get("uuid") == last_uuid:
            return messages[i + 1:]
    return list(messages)


def load(session_id: str) -> Optional[dict]:
    """Return the stored watermark dict for ``session_id``, or ``None``."""
    p = _path(session_id)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _atomic_write(session_id: str, entry: dict) -> None:
    d = _ensure_dir()
    final = os.path.join(d, f"{_safe_session(session_id)}.json")
    tmp = final + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, final)


def _would_regress(stored: Optional[dict], last_uuid: str, ordered_uuids) -> bool:
    """True if committing ``last_uuid`` would move the watermark BACKWARD.

    Uses the position of each uuid *in the current transcript* (``ordered_uuids``,
    transcript order). Explicit stale-anchor branch (design §1.1): if the stored
    ``last_uuid`` is not present in the current transcript it was compacted away
    and cannot be positionally compared — treat the stored watermark as stale and
    accept the incoming commit (never a skip, at worst a safe re-upsert).
    """
    if not stored:
        return False
    stored_uuid = stored.get("last_uuid")
    if not stored_uuid or stored_uuid == last_uuid:
        # No stored anchor, or an idempotent re-commit of the same anchor —
        # neither is a backward move.
        return False
    if not ordered_uuids:
        # Without transcript ordering we cannot prove regression; accept
        # (safety leans toward re-upsert, never skip).
        return False
    try:
        stored_idx = ordered_uuids.index(stored_uuid)
    except ValueError:
        # Stored anchor compacted away -> stale -> accept incoming.
        return False
    try:
        incoming_idx = ordered_uuids.index(last_uuid)
    except ValueError:
        # Incoming uuid not in transcript (shouldn't happen); accept.
        return False
    # Regress only if the stored anchor is strictly AHEAD of the incoming one.
    return stored_idx > incoming_idx


def commit(
    session_id: str,
    last_uuid: str,
    document_id: str,
    transcript_path: str = "",
    ordered_uuids=None,
    byte_offset_hint: Optional[int] = None,
) -> Optional[dict]:
    """Advance the watermark for ``session_id`` to ``last_uuid``.

    Refuses to move backward (see ``_would_regress``). Returns the persisted
    watermark dict, or the existing one if the commit was a no-op (regression /
    idempotent). Best-effort: a write failure returns ``None`` and never raises
    — a successful retain must never be failed by a watermark write.

    ``ordered_uuids`` is the list of transcript entry uuids in transcript order,
    used for the monotonic comparison; the caller (retain / reconcile) has the
    transcript in hand.
    """
    if not last_uuid:
        # Nothing to anchor on (legacy/flat transcript with no uuids). We do
        # not persist a uuid-less watermark: the reconciler falls back to
        # treating the bounded tail as the gap, which upserts idempotently.
        return None
    lock_path = _lock_path(session_id)
    entry = {
        "schema": SCHEMA,
        "session_id": session_id,
        "last_uuid": last_uuid,
        "last_document_id": document_id,
        "committed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "transcript_path": transcript_path,
    }
    if byte_offset_hint is not None:
        entry["byte_offset_hint"] = int(byte_offset_hint)

    def _do() -> Optional[dict]:
        stored = load(session_id)
        if _would_regress(stored, last_uuid, ordered_uuids):
            return stored
        _atomic_write(session_id, entry)
        return entry

    if fcntl is not None:
        try:
            _ensure_dir()
            lock_fd = open(lock_path, "w")
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                return _do()
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                lock_fd.close()
        except OSError:
            pass

    # Fallback without lock (best-effort).
    try:
        return _do()
    except OSError:
        return None
