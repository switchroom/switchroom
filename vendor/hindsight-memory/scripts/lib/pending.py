"""Persistent queue for failed retain payloads.

When a SessionEnd retain fails, the only on-disk record of the turn's
memory is the just-closed transcript — and the agent thinks it was
persisted. To prevent silent data loss (#1071), session_end.py
serializes the *exact retain payload* it would have POSTed into
``~/.hindsight/pending-retains/<unix-ms>-<short-uuid>.json``. The next
SessionStart drains the directory: oldest first, success RETIRES the
entry into the bounded ``pending-reconciled/`` archive (the drain never
deletes — see "Retiring an entry" below for that promise and its one
bound, a full disk), failure bumps an attempt
counter (up to MAX_ATTEMPTS) and leaves the entry for the run after
that.

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
memory into dozens of identical files. (The measured 63% / 84.7 MB
collapse on this fleet was achieved by ``dedupe_queue.py``, a one-shot
out-of-band sweep keyed on ``(bank, document_id, sha256(content))`` with
no size index. What follows is the *preventive* guard that stops the
duplicates accumulating in the first place — a different mechanism, and
it does not get the credit for that number.)

Same bank + same content-derived ``document_id`` + same content is the
same memory — the daemon would upsert them onto one document anyway — so
``enqueue()`` returns the existing path instead of writing a copy.

The dedupe key is carried IN THE FILENAME
(``<unix-ms>-<key>-<uuid>.json``), so a lookup is a prefix match over the
directory listing with ZERO file reads. It deliberately is not inferred
from the serialized bytes: an entry's JSON also carries ``failed_at``,
``error_message``, ``attempt_count`` and — after any drain attempt —
``last_attempt_at``, none of which are part of the memory's identity. An
earlier revision pre-filtered candidates on ``os.path.getsize()``, which
made the guard a no-op in exactly the scenario it was written for: the
queued copy is ALWAYS post-``update_attempt`` by the time
``reconcile_tail`` re-enqueues (the SessionStart drain attempts every
entry on every boot), so its size had already drifted, and a
one-character difference in the error string defeated it too.

Retiring an entry — archive, never delete
-----------------------------------------
The drain retires an entry through ``archive_reconciled()``, which MOVES it
into a bounded ``pending-reconciled/`` sibling. It never ``os.remove``s one.
Every retire decision on that path rests on an HTTP 200 — a presence GET or a
synchronous retain ack — and a 200 is evidence, not proof (#3244); an
irreversible delete on evidence is how the last on-disk copy of a turn
disappears. ``is_content_derived_document_id()`` is the second half of that
guard: a *presence-only* reconcile is sound only for post-#3244
content-derived ids, because a pre-#3244 bare session id answers 200 for any
retain in that session.

The heading says "never delete" about the DRAIN path, and that is exact. The
ENQUEUE path is different and the difference is the bound on this promise
(#3599 review R4-M1): if ``archive_reconciled`` cannot write (ENOSPC), it
keeps the entry queued; entries then accumulate until the queue hits its cap;
``_evict_to_fit`` fires; its own archive move fails for the same reason; and
it removes the OLDEST live entries to keep accepting the newest. So under a
sustained full disk "keep it queued" degrades to "keep the newest, drop the
oldest". Bounded, deliberate and loud — stderr, a ``+archive-failed`` line in
``pending-evictions.log``, and a ``switchroom doctor`` row that fails on any
eviction in the window — but it is loss, so no document here may claim
otherwise. Full statement in ``_evict_to_fit``'s docstring.

Oversized entries
-----------------
An entry larger than ``MAX_BYTES`` can never fit, and the eviction loop
would otherwise evict the ENTIRE queue trying to make room for it and
then write it anyway — trading every queued memory for one. ``enqueue()``
refuses that single entry instead (recorded as a residual drop). Not
reachable at the 256 MB default, but ``HINDSIGHT_PENDING_MAX_BYTES`` is
operator-tunable.

Residual drops
--------------
With eviction in place a *drop* is now rare: it means the entry could not
be written at all (disk full, permissions) even after making room. That
residual case still must not be silent, so it is recorded in the
``pending-drops.json`` ledger — a sibling of the queue dir, like the
eviction log, so it can never be mistaken for a queue entry.

Bounded entries
---------------
``MAX_BYTES`` is about the QUEUE's capacity. A second, much smaller bound
is about whether an entry can ever be DRAINED: ``enqueue()`` splits an
oversized payload into one entry PER PART (``lib/retain_split``) instead
of writing a single giant entry. This is load-bearing, not tidiness. The
daemon runs one sequential extraction LLM call per ``retain_chunk_size``
chars, so an entry above the derived content bound cannot complete inside
ANY client deadline — including the 280s out-of-hook backlog deadline that
``drain_pending._backlog_timeout()`` now takes from the same derivation.
Such an entry fails every drain, burns its ``MAX_ATTEMPTS``, and is
renamed ``.dead``: the mechanism that stranded 154 of the 629 entries in
the 2026-07-25 fleet backlog. Note this is orthogonal to the re-post loop
#3599 fixed — a presence GET retires an oversized entry for free when the
document IS already durable; splitting is what makes the entry drainable
when it is NOT. Part document_ids are deterministic, so a part already
committed by the failed POST is upserted on drain, not duplicated.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from typing import Optional

from .retain_split import part_document_id, part_metadata, split_retain_content


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
# The reconciled archive (see ``archive_reconciled``) is bounded on exactly the
# same terms as ``pending-evicted/`` — an archive that grows without limit is
# just a slower disk problem.
RECONCILED_MAX_ENTRIES = int(
    os.environ.get("HINDSIGHT_PENDING_RECONCILED_MAX_ENTRIES") or 500
)
RECONCILED_MAX_BYTES = int(
    os.environ.get("HINDSIGHT_PENDING_RECONCILED_MAX_BYTES") or (64 * 1024 * 1024)
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

#: The eviction ledger is append-only; these bound it so it cannot grow
#: without limit on a queue that evicts steadily.
EVICTIONS_LOG_MAX_BYTES = 1024 * 1024
EVICTIONS_LOG_KEEP_LINES = 2000


#: Post-#3244 ``document_id`` shape (``retain.slice_document_id``):
#: ``{session_id}-r{start_uuid}-{end_uuid}``, or the legacy-transcript fallback
#: ``{session_id}-r{sha256[:32]}``. ``subagent_retain.py`` uses the same recipe
#: over a ``{session}-sub-{agent}`` composite key, so it matches too.
#: A split retain appends ``-p{i}of{n}`` (``retain_split.part_document_id``).
#: That suffix is a pure function of the SAME content the core id derives
#: from — the split is deterministic in (content, bound) — so a part id is
#: content-derived exactly when its core is, and must be reconcilable on
#: presence for the same reason. Without this the split entries introduced by
#: #3610 would be the ONLY entries excluded from #3599's free phase-1
#: reconcile: every one would take a full re-POST forever, which is the
#: re-post loop #3599 exists to kill, aimed at the largest entries in the
#: queue. It does NOT loosen the pre-#3244 guard: a bare session id with a
#: part suffix (``{session}-p2of5``) still has no content-derived core and
#: still returns False.
_UUID_RE = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
#: ``*``, not ``?``: a part queued under one bound and drained under a smaller
#: one (an operator lowers ``HINDSIGHT_RETAIN_CLIENT_DEADLINE_S``) is re-split
#: at POST time into ``{core}-p2of5-p1of2``. Still a pure function of content,
#: still reconcilable; ``?`` would silently exclude it.
_PART_SUFFIX_RE = r"(?:-p[0-9]+of[0-9]+)*"
_CONTENT_DERIVED_ID_RE = re.compile(
    r"-r(?:%s-%s|[0-9a-fA-F]{32})%s$" % (_UUID_RE, _UUID_RE, _PART_SUFFIX_RE)
)


def is_content_derived_document_id(document_id) -> bool:
    """True iff ``document_id`` is a post-#3244 CONTENT-derived id.

    This is the gate on any *presence-only* reconcile (a GET that returns
    200 ⇒ drop the queue entry). It is only sound when the id identifies
    the entry's own content:

    * **Post-#3244** the id is ``{session_id}-r{start_uuid}-{end_uuid}``
      (``retain.slice_document_id``), a pure function of *which turns* the
      entry carries. A 200 on that id proves *this* content was committed.
    * **Pre-#3244** entries carry a BARE SESSION ID. The bank answers 200
      for that id after ANY successful retain in that session, so a 200
      proves nothing about the queued entry's own content. Reconciling on
      it deletes a turn that was never committed — confirmed against a
      live entry on this fleet (525 KB of content, ``document_id`` a bare
      UUID, GET 200).

    * **Split parts** (``{core}-p{i}of{n}``, #3610) inherit the verdict of
      their core: the part suffix is derived from the same content, so a 200
      on ``…-r{uuid}-{uuid}-p2of5`` proves that part's own content was
      committed. A part suffix on a bare session id proves nothing and is
      still False.

    Anything unrecognised is False: the safe direction is to keep the
    entry and let the POST path decide.
    """
    if not isinstance(document_id, str):
        return False
    return bool(_CONTENT_DERIVED_ID_RE.search(document_id))


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
    """Return sorted filenames, oldest first.

    Order is the lexicographic sort of ``<unix-ms>-[<key>-]<uuid>.json``.
    The millisecond stamp is fixed-width and leading, so this is true
    enqueue order down to the millisecond; entries sharing a millisecond
    tie-break on the remaining segments (stable and total, but arbitrary —
    the name carries no finer age information).
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


def reconciled_dir() -> str:
    """Archive directory for reconciled/drained entries (sibling of the queue).

    The out-of-band drainer this design was ported from ARCHIVES an entry it
    stops draining; it never ``os.remove``s one. That is the difference
    between "we believe this is durable upstream" and "the last on-disk copy
    of this turn is gone", and only the second is irreversible.
    """
    return os.environ.get("HINDSIGHT_PENDING_RECONCILED_DIR") or _sibling(
        "pending-reconciled"
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


def _trim_dir(a: str, max_entries: int, max_bytes: int) -> int:
    """Keep ``a`` under its count/byte caps, deleting OLDEST first.

    Returns the number of archived copies dropped.

    Oldest-first is load-bearing: ``names[0]`` is the lexicographically
    smallest name, and names lead with a fixed-width millisecond stamp, so
    it is the oldest archived entry. Trimming from the other end would keep
    the stale tail and discard what was just shed.

    Both caps are ``>`` — a directory sitting exactly ON a cap is within
    it, and trimming there would shed one entry per call forever.

    The archive caps are deliberately 4x SMALLER than the queue caps (500 /
    64 MB vs 2000 / 256 MB) (#3599 review R3-L1). Sizing them to match
    would put three full-queue copies on a container filesystem (queue +
    ``pending-evicted/`` + ``pending-reconciled/`` = 768 MB), which is the
    disk problem the caps exist to bound.

    WHAT THE TRIM COSTS, honestly (#3599 review R4-B3). An earlier revision
    of this docstring justified the small caps by claiming an entry "only
    reaches ``pending-reconciled/`` once its document was CONFIRMED present
    upstream", so the trim "sheds a redundant copy". That is false for the
    commonest path. Three of the four ways in are corroborated by a GET:

      * in-hook reconcile (``drain_pending.drain``'s presence pass) — a GET
        answered 200 for this entry's content-derived id;
      * backlog phase 1 (``_reconcile_phase``) — the same, out of hook;
      * backlog phase 2 — synchronous POST, then a CONFIRMING re-GET.

    The fourth is not:

      * ``drain``'s in-hook SUCCESS path retires on the POST's own 200 with
        no confirming GET, because a 5s hook budget has no room for one.
        That 200 is NOT a bare async ack — ``_retry_one`` posts
        ``async_processing=False``, so it is a commit-before-ack (#3244
        §1.1) and real upstream evidence of persistence. But it is the
        daemon's word about itself, not an independent read, and this is
        the path that runs on every boot: the common case.

    So for that population the archived copy CAN be the last on-disk copy
    of a turn — precisely when the daemon did not honour ``async=false``.
    Trimming it is a real, if narrow, loss, and the caps stay small anyway:
    this archive is the horizon of a recovery CONVENIENCE, not a durability
    guarantee. The durability guarantee is commit-before-ack. Raising these
    caps 4x would only move the horizon while tripling the disk cost, and a
    daemon that ignores ``async=false`` is a precondition violation to fix
    upstream, not to paper over with 768 MB of container disk. Hence the
    log line: "reversible" has a horizon and the operator is entitled to
    know when it passed.

    ``pending-evicted/`` is a different story again — see ``_evict_to_fit``:
    an entry only reaches it through the ledgered eviction path, and under
    sustained ENOSPC it may not reach it at all.
    """
    try:
        names = sorted(n for n in os.listdir(a) if n.endswith(".json"))
    except OSError:
        return 0
    dropped = []
    while names and (
        len(names) > max_entries or _dir_bytes(a, names) > max_bytes
    ):
        try:
            os.remove(os.path.join(a, names[0]))
        except OSError:
            pass
        dropped.append(names.pop(0))
    if dropped:
        shown = ", ".join(dropped[:10])
        if len(dropped) > 10:
            shown += f", +{len(dropped) - 10} more"
        print(
            f"[Hindsight] pending: trimmed {len(dropped)} archived "
            f"cop{'y' if len(dropped) == 1 else 'ies'} from "
            f"{os.path.basename(a.rstrip('/'))} to stay under its caps "
            f"({max_entries} entries / {max_bytes} bytes): {shown}",
            file=sys.stderr,
        )
    return len(dropped)


def _trim_archive() -> None:
    """Keep the eviction archive under its own count/byte caps."""
    _trim_dir(evicted_dir(), ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_BYTES)


def archive_reconciled(path: str) -> Optional[str]:
    """Retire a queue entry into ``pending-reconciled/``. Returns the dest.

    THE ONLY WAY the drain retires an entry. Every "we no longer need to
    keep this queued" decision on the drain path rests on an HTTP 200 —
    either a presence GET or a synchronous retain ack — and a 200 is
    evidence, not proof (switchroom #3244). ``os.remove`` on that evidence
    is irreversible; a bounded archive is not, and the archive is what the
    out-of-band tooling this design was ported from always did.

    Bounded exactly like ``pending-evicted/`` (``RECONCILED_MAX_ENTRIES`` /
    ``RECONCILED_MAX_BYTES``), so it can never become an unbounded disk
    problem of its own.

    Returns the destination path, or ``None`` when the entry could NOT be
    retired — in which case the entry is still queued and untouched.

    A failure to archive (ENOSPC, EACCES, a read-only mount) is NOT a
    licence to delete (#3599 review R3-M1). An earlier revision fell back
    to ``delete_entry`` on ``OSError``, reasoning that a queue which cannot
    retire would re-POST forever; the cost of that loop is duplicated LLM
    extraction, while the cost of the delete is the last on-disk copy of a
    turn, silently and irreversibly. The cheaper failure wins, and the
    caller is told so it can count the entry honestly rather than report a
    retire that did not happen. The failure is also logged to stderr,
    because the one thing worse than a full disk is a full disk nobody
    hears about.

    "STAYS QUEUED" IS BOUNDED, and the bound is worth stating here because
    this is where the promise is made (#3599 review R4-M1). If the disk
    stays full, entries pile up, the queue hits its cap, and ``enqueue()``
    calls ``_evict_to_fit``, whose own archive move fails for the same
    reason and which then removes the OLDEST live entries outright. So the
    honest full statement is: this function never deletes, and under
    sustained ENOSPC "keep it queued" degrades to "keep the newest, drop
    the oldest" — loudly, via the eviction ledger and a failing doctor row.
    """
    dest_dir = reconciled_dir()
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(path))
        shutil.move(path, dest)
    except OSError as e:
        print(
            f"[Hindsight] pending: could not archive {os.path.basename(path)} "
            f"into {dest_dir} ({e}) — entry STAYS QUEUED (never deleted); "
            f"free disk space or fix permissions, then re-run the drain",
            file=sys.stderr,
        )
        return None
    _trim_dir(dest_dir, RECONCILED_MAX_ENTRIES, RECONCILED_MAX_BYTES)
    return dest


def _log_eviction(name: str, size: int, reason: str, depth: int, nbytes: int) -> None:
    line = "%s evicted=%s bytes=%d reason=%s queue_depth=%d queue_bytes=%d" % (
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        name,
        size,
        reason,
        depth,
        nbytes,
    )
    log = evictions_log_path()
    try:
        with open(log, "a", encoding="utf-8") as f:
            print(line, file=f)
        # Bounded, not append-forever. `switchroom doctor` windows this by
        # timestamp so a single legitimate eviction can't turn the row red
        # permanently, but the FILE still needs a ceiling of its own.
        if os.path.getsize(log) > EVICTIONS_LOG_MAX_BYTES:
            with open(log, encoding="utf-8") as f:
                kept = f.readlines()[-(EVICTIONS_LOG_KEEP_LINES):]
            tmp = log + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(kept)
            os.chmod(tmp, 0o600)
            os.replace(tmp, log)
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

    THE ONE PLACE A LIVE QUEUE ENTRY CAN BE REMOVED (#3599 review R4-M1),
    and it must be read together with ``archive_reconciled``'s "the entry
    STAYS QUEUED" promise, because it is the bound on that promise. Normally
    an eviction is a MOVE into ``pending-evicted/`` and the payload survives.
    Under sustained ENOSPC it is not: ``archive_reconciled`` keeps entries
    queued, the queue fills, this function fires, its own archive move fails
    for the same reason, and the fallback below ``os.remove``s the oldest
    live entries to make room for the newest.

    That is deliberate and it is the accepted behaviour, not an oversight:
    the queue has to be bounded by something, and shedding the OLDEST turns
    to keep accepting new ones is the least-bad bound. It is never silent —
    stderr, a ``+archive-failed`` line in ``pending-evictions.log``, and a
    ``switchroom doctor`` row that fails on any eviction in the window. So
    "keep it queued" degrades to "keep the newest, drop the oldest" when the
    disk stays full, and every document that says "keep it queued" is
    qualified by this paragraph.
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
            # newest memory is the priority — but say so loudly. This is the
            # ONE ``os.remove`` in this module that can touch a LIVE entry,
            # and with the archive move already failed there is no copy left:
            # this line is the bound on "an entry is never deleted". The
            # ``+archive-failed`` reason is what tells the operator (via the
            # ledger and the doctor row) that the payload is gone, not merely
            # moved.
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


def _dupe_key(entry: dict) -> Optional[str]:
    """Stable 16-hex identity of a queued retain, or ``None``.

    Derived from ``(bank_id, document_id, sha256(content))``. The CONTENT
    hash is what makes the key an identity: two entries sharing it carry
    byte-identical content for the same bank and document, so they are the
    same memory and the daemon would upsert them onto the same document.

    Do NOT read this as "``document_id`` is content-derived, therefore a
    matching id means matching content" — that only holds post-#3244
    (``retain.slice_document_id``); pre-#3244 entries carry a bare session
    id shared by every retain in that session. Dedupe is safe on either
    because it hashes the content itself; a *presence GET* is not, which is
    why that path is gated on ``is_content_derived_document_id``.

    ``None`` when there is no ``document_id``: identity cannot be
    established, so the entry must always be kept rather than merged.
    """
    did = entry.get("document_id")
    if did is None:
        return None
    content = entry.get("content")
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False, sort_keys=True)
    h = hashlib.sha256()
    # Length-prefixed so ("ab", "c") and ("a", "bc") cannot collide.
    for part in (str(entry.get("bank_id")), str(did)):
        h.update(b"%d:" % len(part))
        h.update(part.encode("utf-8"))
    h.update(hashlib.sha256(content.encode("utf-8")).digest())
    return h.hexdigest()[:16]


def _find_duplicate(d: str, key: Optional[str]) -> Optional[str]:
    """Return the path of an already-queued identical entry, or ``None``.

    A pure filename prefix match — no file is opened, no payload is
    hashed — because ``enqueue()`` stamps the key into the name. Entries
    written by an older plugin build have no key segment and simply never
    match, which is the safe direction: a missed dedupe costs a duplicate
    file, a false one would discard a distinct memory.
    """
    if not key:
        return None
    needle = f"-{key}-"
    for name in _list_entries(d):
        if needle in name:
            return os.path.join(d, name)
    return None


def quarantine_corrupt(path: str) -> Optional[str]:
    """Move an unparsable entry into the ``pending-corrupt/`` sibling.

    Without this a corrupt entry is IMMORTAL: ``iter_entries()`` skips it,
    so it is never reconciled, never drained and never aged to ``.dead``,
    yet it still occupies a queue slot and still counts toward the depth
    that ``switchroom doctor`` reports — inflating the warning forever
    with eviction as its only exit. Mirrors the out-of-band drainer, which
    moves unparsable entries to ``pending-corrupt`` rather than skipping.

    Returns the new path, or ``None`` if the move failed.
    """
    dest_dir = _sibling("pending-corrupt")
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(path))
        shutil.move(path, dest)
    except OSError:
        return None
    print(
        f"[Hindsight] pending-retains: entry is unparsable, quarantined to "
        f"{dest} (it can no longer block the queue; inspect or delete it).",
        file=sys.stderr,
    )
    return dest


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

    Oversized content is SPLIT into one entry PER PART before anything is
    written, so no entry is ever queued that the drainer cannot finish
    inside one client deadline (see "Bounded entries" above). Content at or
    under the bound is written as a single entry exactly as before, with
    the document_id and metadata untouched.

    Returns the absolute path of the (first) written entry — which may be
    an EXISTING identical entry (dedupe) — or ``None`` in the residual case
    where NO part could be written at all. Atomic per entry: writes
    ``<name>.tmp`` then renames to ``<name>``.

    A full queue no longer refuses the incoming entry: ``_evict_to_fit()``
    sheds the OLDEST entries into ``pending-evicted/`` instead. Refusing
    the newest memory was the wrong end to shed from — it is the turn most
    likely to still matter.
    """
    d = _ensure_dir()

    content = payload.get("content")
    parts = split_retain_content(content) if isinstance(content, str) else [content]
    total = len(parts)
    if total <= 1:
        return _enqueue_one(d, payload, error)

    base_doc = payload.get("document_id", "conversation")
    base_meta = payload.get("metadata")

    part_payloads = []
    for index, part in enumerate(parts):
        part_payload = dict(payload)
        part_payload["content"] = part
        part_payload["document_id"] = part_document_id(base_doc, index, total)
        part_payload["metadata"] = part_metadata(base_meta, index, total)
        part_payloads.append(part_payload)

    # #3599's "an entry larger than the whole cap can never fit" guard,
    # applied to the whole LOGICAL memory rather than to one part, against
    # BOTH caps. Splitting would otherwise defeat it: each part fits, so the
    # eviction loop becomes satisfiable and every part gets written — but the
    # parts together still exceed the cap, so the later parts evict the
    # earlier parts of the same memory AND every unrelated memory already
    # queued. The queue is left holding a tail fragment of one memory and
    # nothing else: strictly worse than #3599's outcome of refusing the one
    # memory that cannot fit, so refuse it here too.
    total_bytes = sum(_entry_blob_bytes(p, error) for p in part_payloads)
    if total_bytes > MAX_BYTES:
        record_drop(payload, ValueError(
            f"entry is {total_bytes} bytes across {total} parts, larger than "
            f"the whole HINDSIGHT_PENDING_MAX_BYTES cap ({MAX_BYTES}); "
            f"refusing this entry rather than evicting the entire queue for it"
        ))
        return None
    if total > MAX_ENTRIES:
        record_drop(payload, ValueError(
            f"entry splits into {total} parts, more than the whole "
            f"HINDSIGHT_PENDING_MAX_ENTRIES cap ({MAX_ENTRIES}); refusing "
            f"this entry rather than evicting the entire queue for it"
        ))
        return None

    first: Optional[str] = None
    for part_payload in part_payloads:
        # Each part goes through the FULL enqueue pipeline — dedupe, the
        # MAX_BYTES refusal, eviction, the drop ledger — because each part
        # is an independently drainable memory, not a fragment that only
        # means something alongside its siblings. A part that cannot be
        # written is recorded as a drop and the remaining parts still go in;
        # returning ``None`` for the whole memory because part 7 of 9 hit
        # ENOSPC would discard eight recoverable turns.
        #
        # A part CAN evict an earlier part of the same memory when the queue
        # is already at its cap (eviction is FIFO and earlier parts are
        # older). That is the same trade `_evict_to_fit` documents — the
        # evicted part MOVES to ``pending-evicted/``, so it is shed, not
        # destroyed, except under the sustained-ENOSPC case named there.
        written = _enqueue_one(d, part_payload, error)
        if written is not None and first is None:
            first = written
    return first


def _build_entry(payload: dict, error: BaseException) -> dict:
    """The on-disk entry dict for ``payload``, exactly as it will be written."""
    entry = dict(payload)
    entry["schema"] = SCHEMA
    entry["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry["error_class"] = type(error).__name__
    entry["error_message"] = _clip_error(error)
    entry.setdefault("attempt_count", 1)
    return entry


def _entry_blob_bytes(payload: dict, error: BaseException) -> int:
    """Serialised size of the entry ``payload`` would be written as.

    Shares ``_build_entry`` with ``_enqueue_one`` so the pre-split total-size
    guard measures the same bytes the per-entry ``MAX_BYTES`` guard does; the
    only field that varies between the two calls is ``failed_at``, whose
    encoding is fixed-width.
    """
    return len(json.dumps(_build_entry(payload, error), ensure_ascii=False).encode("utf-8"))


def _enqueue_one(d: str, payload: dict, error: BaseException) -> Optional[str]:
    """Write exactly ONE queue entry for ``payload``. See ``enqueue()``."""
    entry = _build_entry(payload, error)

    blob = json.dumps(entry, ensure_ascii=False)
    blob_bytes = len(blob.encode("utf-8"))

    key = _dupe_key(entry)
    ts_ms = int(time.time() * 1000)
    short_uuid = uuid.uuid4().hex[:12]
    # The key goes in the NAME so dedupe is a listing prefix match with no
    # file reads. The fixed-width millisecond timestamp remains the LEADING
    # segment, so `_list_entries`' lexicographic sort orders entries by
    # enqueue millisecond. Entries written inside the SAME millisecond tie-
    # break on the dupe key (then the random uuid) — arbitrary, but stable
    # and total; the filename carries no finer age information than the
    # millisecond, so no ordering could do better.
    name = f"{ts_ms}-{key}-{short_uuid}.json" if key else f"{ts_ms}-{short_uuid}.json"
    final = os.path.join(d, name)
    tmp = final + ".tmp"

    # DEDUPE first: reconcile_tail re-enqueues the same transcript slice on
    # every boot until its watermark is confirmed, so a stalled upstream would
    # otherwise multiply one memory into dozens of queue files. Returning the
    # existing path keeps every caller's "queued" contract intact.
    dup = _find_duplicate(d, key)
    if dup is not None:
        return dup

    # An entry bigger than the whole byte cap can never fit. Without this
    # guard the eviction loop below evicts the ENTIRE queue trying to make
    # room and then writes it anyway — trading every queued memory for one.
    if blob_bytes > MAX_BYTES:
        record_drop(payload, ValueError(
            f"entry is {blob_bytes} bytes, larger than the whole "
            f"HINDSIGHT_PENDING_MAX_BYTES cap ({MAX_BYTES}); refusing this "
            f"entry rather than evicting the entire queue for it"
        ))
        return None

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

    A malformed entry is QUARANTINED, not skipped. Skipping made it
    immortal — never reconciled, never drained, never aged to ``.dead``,
    but still holding a queue slot and still counted in the depth doctor
    reports. Transient read errors (``OSError``) are still just skipped;
    only unparsable content is moved aside. We never crash the
    SessionStart hook on a corrupt entry either way.
    """
    d = pending_dir()
    out: list[tuple[str, dict]] = []
    for name in _list_entries(d):
        p = os.path.join(d, name)
        try:
            with open(p, encoding="utf-8") as f:
                out.append((p, json.load(f)))
        except OSError:
            continue
        except ValueError:
            # ValueError, not JSONDecodeError: a non-UTF-8 entry raises
            # UnicodeDecodeError, which is a ValueError but NOT a
            # JSONDecodeError, and is exactly as unparsable.
            quarantine_corrupt(p)
    return out


# There is deliberately NO ``delete_entry`` primitive callable on the DRAIN
# path (#3599 review R3-M1). Its last caller was ``archive_reconciled``'s
# OSError fallback, and while it existed the "never irreversibly removed"
# claim in this module's docstring, in ``drain_pending``'s, in ``switchroom
# doctor``'s backlog fix text and in the CHANGELOG was one ``except
# OSError:`` away from being false. Making that invariant structural — the
# function does not exist, so no drain branch can reach it — is stronger
# than asserting it in prose. On the drain path an entry leaves the queue
# only by MOVING: ``archive_reconciled`` (retired), ``quarantine_corrupt``
# (unparsable), or the ``.dead`` rename.
#
# ONE ``os.remove`` in this module CAN touch a live entry, and an earlier
# revision of this comment wrongly said none could (#3599 review R4-M1):
# ``_evict_to_fit``'s ``OSError`` fallback. It is on the ENQUEUE path, not
# the drain path, and it fires only when the eviction archive move ALSO
# failed — sustained ENOSPC. Read the whole degradation in one line:
#
#   archive_reconciled keeps the entry queued → the queue fills →
#   _evict_to_fit runs → its archive move fails too → the OLDEST live
#   entries are removed to keep accepting the newest.
#
# So the queue IS bounded under a full disk, and it is bounded by dropping
# the oldest turns. That is accepted behaviour (a queue must be bounded by
# something, and the newest turn is the one most likely to still matter),
# and it is loud: stderr, a ``+archive-failed`` ledger line, and a doctor
# row that fails on any eviction in the window. It is NOT invisible and it
# is NOT the drain deleting anything. Every "the entry is never deleted"
# sentence in this repo means "not by the drain, and not while there is
# disk"; ``_evict_to_fit``'s docstring carries the full statement.
#
# ``_trim_dir``'s ``os.remove`` is the third and mildest: it acts on an
# already-retired copy in a bounded archive, never on a live entry.


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
