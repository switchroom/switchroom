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
that. Exhausting MAX_ATTEMPTS retires the entry to ``.dead`` only when
the failure is PERMANENT (``is_permanent_failure`` — a 4xx a re-POST
cannot fix). A transient failure never retires the memory, however many
attempts it has burned.

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

Deduplication — the identity is (bank, part position, content)
--------------------------------------------------------------
``reconcile_tail`` re-enqueues the same transcript slice on every boot
until its watermark is confirmed, so a stalled upstream multiplied one
memory into dozens of identical files. (The measured 63% / 84.7 MB
collapse on this fleet was achieved by ``dedupe_queue.py``, a one-shot
out-of-band sweep keyed on ``(bank, document_id, sha256(content))`` with
no size index. What follows is the *preventive* guard that stops the
duplicates accumulating in the first place — a different mechanism, and
it does not get the credit for that number.)

**Same bank + same position in a split + byte-identical content is the
same memory.** The key is ``(bank_id, part_position, sha256(content))``;
the rest of ``document_id`` is deliberately NOT in it (switchroom #3688).
Including the whole id made the guard a near-no-op against the producer
that actually fills this queue: ``subagent_retain.py`` embeds the
sub-agent's own session id in the document id
(``{parent}-sub-{agent_id}-r{start}-{end}``), so every SubagentStop
re-queues a near-identical slice of the SAME parent transcript under a
FRESH id. Measured on this fleet 2026-07-26: 1,060 queued files across 11
agents collapsing to ~368 ``(bank_id, part_position, sha256(content))``
groups (~65% duplicates, top group 32x — 32 distinct document ids over
one byte-identical 45,000-char part). Keyed with the whole id, the guard
matched none of them.

The part position (the ``-p{i}of{n}`` index, total discarded) stays in
the key because a split's parts are not guaranteed to differ from one
another — repetitive content cut on a character bound yields identical
parts — and merging those would leave the document missing positions
upstream. That is content loss, not a redundant copy, so it is not part
of the trade below. See :func:`_part_position`.

WHAT THIS COSTS, stated exactly. Two *different* documents whose content
happens to be byte-identical for one part now collapse onto one queue
entry, so the loser's document can end up missing that part upstream.
That is a real difference and it is the accepted trade, because the thing
this queue exists to protect is the MEMORY, not the container: the
surviving entry carries byte-identical content into the SAME bank, so no
text and no extractable fact is lost — only the second copy of it. The
alternative is the measured status quo, where identical text is extracted
by the LLM 32 times over, at ~168 s a part, for one memory. Collapsing is
also reversible: ``collapse_duplicates()`` MOVES the loser into the
bounded ``pending-duplicate/`` archive rather than deleting it.

The filename key only protects entries queued by THIS build. Entries
already on disk carry the old id-bearing key, so a new enqueue of their
content computes a different key and never matches them — the safe
direction (a missed dedupe costs a file, a false one would cost a
memory), but it leaves the accumulated backlog duplicated.
``collapse_duplicates()`` closes that: it recomputes the key from CONTENT
for every live entry, so it is generation-agnostic, and the drain runs it
before doing any work.

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
ANY client deadline — including the out-of-hook backlog deadline that
``drain_pending._backlog_timeout()`` now takes from the same derivation.
Such an entry fails every drain and burns its ``MAX_ATTEMPTS``: the
mechanism that stranded 154 of the 629 entries in the 2026-07-25 fleet
backlog. (It is no longer renamed ``.dead`` for that — a client-side
timeout is not a permanent failure — but it still never drains until it
is split, so splitting remains the fix. Such an entry is therefore
IMMORTAL, and ``enqueue`` is the only caller of the splitter, so one
queued before #3610 is never split in place. That is precisely the shape
``drain_pending._drain_order`` / ``_over_budget`` exist to contain: it is
demoted behind every entry still inside its attempt budget and abstains
from the stall guard, so it can delay only itself rather than wedging the
drain.) Note this is orthogonal to the re-post loop
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

from .retain_split import (
    part_document_id,
    part_metadata,
    retain_content_limit,
    split_retain_content,
)


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
# ``collapse_duplicates`` retires the losing copies here, on the same terms
# as the other two archives: a collapsed duplicate is byte-identical to an
# entry that is STILL QUEUED, so this archive is the most redundant of the
# three — but it is still a MOVE, never a delete.
DUPLICATE_MAX_ENTRIES = int(
    os.environ.get("HINDSIGHT_PENDING_DUPLICATE_MAX_ENTRIES") or 500
)
DUPLICATE_MAX_BYTES = int(
    os.environ.get("HINDSIGHT_PENDING_DUPLICATE_MAX_BYTES") or (64 * 1024 * 1024)
)
# ``resplit_over_bound_entries`` retires the pre-split original here. Like
# the duplicate archive, this copy is REDUNDANT by construction: it is only
# moved once at least one NEW queue file exists for it (a dedupe hit is not a
# new file — see ``resplit_over_bound_entries``), and the parts carry the
# whole memory. So
# it is bounded on the same terms — a MOVE into a capped archive, never a
# delete of a memory that has nowhere else to live. (``pending-dead/`` is the
# deliberate exception: see :func:`dead_dir`.)
RESPLIT_MAX_ENTRIES = int(
    os.environ.get("HINDSIGHT_PENDING_RESPLIT_MAX_ENTRIES") or 500
)
RESPLIT_MAX_BYTES = int(
    os.environ.get("HINDSIGHT_PENDING_RESPLIT_MAX_BYTES") or (64 * 1024 * 1024)
)
# Fields that belong to a queue ENTRY rather than to the caller's PAYLOAD.
# `enqueue()` takes a payload, so an entry read back off disk has to be
# stripped of them before it can be re-enqueued (see
# `resplit_over_bound_entries`).
#
# Which members are load-bearing, checked against `_build_entry` (it is the
# only writer of the first four):
#
#   - `attempt_count`, `last_attempt_at`, `dead_at` are LOAD-BEARING.
#     `_build_entry` uses `setdefault` for `attempt_count` and never touches
#     the other two, so leaving them in really does round-trip an exhausted
#     retry budget — and a `last_attempt_at` from days ago paired with a
#     fresh `attempt_count: 1` — straight into the new parts, sending a
#     re-split part back toward `.dead` on its first failure.
#   - `schema`, `failed_at`, `error_class`, `error_message` are
#     DEFENCE-IN-DEPTH. `_build_entry` assigns all four unconditionally, so
#     they cannot round-trip today. They are stripped anyway to keep the
#     contract "what goes into `enqueue()` is a payload, not an entry" true
#     of the dict itself, so no future `setdefault` here (as `attempt_count`
#     already is) silently starts inheriting them. The strip is asserted on
#     the payload, not only on the resulting entries — see
#     `test_the_parts_carry_no_stale_attempt_metadata`.
_ENTRY_ONLY_FIELDS = frozenset(
    {
        "schema",
        "failed_at",
        "error_class",
        "error_message",
        "attempt_count",
        "last_attempt_at",
        "dead_at",
    }
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


def duplicate_dir() -> str:
    """Archive directory for entries retired by ``collapse_duplicates``."""
    return os.environ.get("HINDSIGHT_PENDING_DUPLICATE_DIR") or _sibling(
        "pending-duplicate"
    )


def dead_dir() -> str:
    """Archive directory for ``MAX_ATTEMPTS`` failures (sibling of the queue).

    ``.dead`` markers used to be written INSIDE the queue directory, as
    ``<entry>.json.dead``. A ``.dead`` marker is the ONLY remaining copy of
    that memory — ``mark_dead`` unlinks the live entry once the marker is
    durable — so leaving it in the live queue directory put the last copy of
    a memory in the one directory that external janitorial tooling has every
    reason to sweep. On this fleet exactly that happened: a host cron ran
    ``find <queue> -name '*.dead' -mtime +14 | xargs rm -f``. Measured on
    2026-07-26, 6 such markers were live in the queue directory, each one on
    a countdown to permanent deletion.

    Fixing the janitor is not a fix — the next one has the same shape. The
    product-level fix is that the live queue directory contains ONLY live
    entries, so no glob over it can ever match a memory. Dead markers move
    out to this sibling, alongside ``pending-evicted``/``pending-reconciled``
    /``pending-corrupt``, and ``sweep_legacy_dead_markers`` migrates any that
    a previous version left behind.

    NOT TTL-pruned, deliberately, and NOT trimmed to a cap: a dead entry is
    an unrecovered memory, and dropping it is the loss this whole subsystem
    exists to prevent. It is bounded instead by making it hard to REACH --
    ``resplit_over_bound_entries`` recovers the entries that used to arrive
    here, so the steady-state population is the genuinely unrecoverable ones.
    """
    return os.environ.get("HINDSIGHT_PENDING_DEAD_DIR") or _sibling("pending-dead")


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
    # `.json` ONLY, and that is load-bearing beyond "skip stray files": a
    # `.dead` marker is named `<entry>.json.dead`, so it can never be
    # selected here even if a future caller points a trim at `pending-dead/`.
    # That archive holds the only remaining copy of an unrecovered memory and
    # must stay uncapped; making it structurally unreachable is stronger than
    # relying on nobody wiring up the call. See :func:`dead_dir`.
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


def archive_duplicate(path: str) -> Optional[str]:
    """Retire a REDUNDANT queue entry into ``pending-duplicate/``.

    Used only by ``collapse_duplicates()``, and only for an entry whose
    ``(bank_id, part_position, sha256(content))`` twin is still queued. Like
    ``archive_reconciled`` this MOVES rather than deletes — the survivor is
    evidence, not proof, that the content will land, and this module never
    turns evidence into an irreversible delete.

    Returns the destination path, or ``None`` when the entry could NOT be
    retired — in which case it is still queued and untouched, and the
    caller must not count it as collapsed. A concurrent drain that retired
    the same entry first lands here too (``shutil.move`` raises
    ``FileNotFoundError``, an ``OSError``), which is why the failure path
    is a no-op rather than a raise.
    """
    dest_dir = duplicate_dir()
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(path))
        shutil.move(path, dest)
    except OSError as e:
        print(
            f"[Hindsight] pending: could not archive duplicate "
            f"{os.path.basename(path)} into {dest_dir} ({e}) — entry STAYS "
            f"QUEUED (never deleted)",
            file=sys.stderr,
        )
        return None
    _trim_dir(dest_dir, DUPLICATE_MAX_ENTRIES, DUPLICATE_MAX_BYTES)
    return dest


def collapse_duplicates() -> int:
    """Collapse entries sharing ``(bank_id, part_position, sha256(content))``.

    Returns the number of redundant copies retired.

    ``enqueue()``'s filename-keyed guard stops NEW duplicates. This is the
    other half: it recomputes the key from the entry's own CONTENT, so it
    also collapses entries written by an older build (whose filename key
    still carries ``document_id`` and therefore never matches) and entries
    whose duplicate arrived while a drain held them. Generation-agnostic by
    construction — the filename is not consulted for identity at all.

    SURVIVOR SELECTION is deterministic and durability-first: the copy with
    the LOWEST ``attempt_count`` wins, ties broken by oldest filename. All
    copies carry byte-identical content, so any of them delivers the same
    memory; the one with the most attempts left is the one most likely to
    get there before ``MAX_ATTEMPTS`` promotes it to ``.dead``. Picking the
    oldest outright would systematically keep the most-attempted copy —
    exactly backwards.

    An entry whose key is ``None`` (no ``content``) is never grouped: its
    identity cannot be established, so it is always kept.

    A copy that cannot be archived stays queued and is NOT counted, so the
    return value is a count of retires that actually happened.
    """
    groups: dict[str, list[tuple[int, str, dict]]] = {}
    for order, (path, entry) in enumerate(iter_entries()):
        key = _dupe_key(entry)
        if not key:
            continue
        groups.setdefault(key, []).append((order, path, entry))

    collapsed = 0
    for key, members in groups.items():
        if len(members) < 2:
            continue
        survivor = min(
            members,
            key=lambda m: (int(m[2].get("attempt_count", 1) or 1), m[0]),
        )
        for member in members:
            if member is survivor:
                continue
            if archive_duplicate(member[1]) is not None:
                collapsed += 1
        print(
            f"[Hindsight] pending: collapsed {len(members) - 1} duplicate "
            f"cop{'y' if len(members) == 2 else 'ies'} of key {key} onto "
            f"{os.path.basename(survivor[1])} (byte-identical content, same "
            f"bank; the copies are archived under {duplicate_dir()}, not "
            f"deleted)",
            file=sys.stderr,
        )
    return collapsed


def resplit_dir() -> str:
    """Archive directory for entries retired by ``resplit_over_bound_entries``."""
    return os.environ.get("HINDSIGHT_PENDING_RESPLIT_DIR") or _sibling(
        "pending-resplit"
    )


def resplit_over_bound_entries() -> tuple[int, int]:
    """Re-split queued entries whose content exceeds the current bound.

    Returns ``(entries_resplit, parts_written)``.

    THE ENTRY THIS EXISTS FOR is one whose ``content`` is larger than
    ``retain_content_limit()``. Such an entry is not slow, it is IMPOSSIBLE:
    the server runs one sequential extraction call per chunk, so the POST
    cannot finish inside the deadline the drain waits, and re-POSTing it is
    guaranteed waste. Today it either churns forever at the back of the drain
    order or — if the server rejects the body as a 4xx, which
    ``is_permanent_failure`` correctly classifies as permanent — goes
    ``.dead``. Both outcomes are wrong for a memory that is perfectly
    recoverable: ``enqueue()`` already knows how to split it.

    Two ways an over-bound entry gets into a queue, and both are live here:
      * it was enqueued by a build older than the split-on-enqueue path;
      * the bound MOVED under it. It does that whenever the client deadline
        or the deadline-safety fraction changes, so this is not a one-off
        migration — it is the queue's standing response to a bound change.
    Measured on this fleet 2026-07-26: 18 of 211 queued entries exceeded
    100,000 chars, the largest 744,546 — i.e. 15x the bound.

    Ordering matters. The original is archived into ``pending-resplit/`` only
    AFTER at least one NEW queue file exists for it, so a crash mid-way leaves
    the original queued (worst case: the parts are written twice, and a
    re-split is deterministic, so the second write dedupes onto the first). If
    NOT ONE new part file appeared — ``enqueue_parts`` refused the whole memory
    as larger than the queue cap, the disk is full, or every part deduped onto
    something already queued — the original is left queued untouched and is
    not counted. Nothing is deleted on any path.

    "NEW file", not "``_enqueue_one`` returned a path", is the load-bearing
    distinction, and it is why the count is a set difference against the
    queue listing taken just before the call. ``_enqueue_one`` returns the
    path of an ALREADY-QUEUED identical entry on a dedupe hit. When the
    splitter yields a SINGLE part for this content — which it does whenever
    the entry is over the bound but still one part's worth under the CURRENT
    bound — ``enqueue_parts`` re-enqueues the payload unchanged, so the dupe
    key matches the very entry being re-split and the "written" path IS the
    original. Counting that as a part archived a live memory into a capped
    archive while logging "into 0 queued part(s)".

    A refusal here does NOT stamp the drop ledger
    (``record_refusal_as_drop=False``): the ledger means permanently lost and
    `switchroom doctor` fails on it, but the original is still queued and is
    retried on every backlog drain, so stamping it would climb forever. The
    same reasoning applies one level down, to a PER-PART failure — an
    over-cap part, or a part whose write hit ENOSPC — which is why the drops
    are collected on ``deferred_drops`` and only stamped
    (``record_deferred_drops``) on the branches below where the original has
    actually left the live queue.

    WHAT THIS COSTS, honestly. One entry becomes N, so the queue gets DEEPER
    (measured worst case on this fleet: 744,546 chars -> 23 parts). On a
    queue already at its cap that means ``enqueue``'s eviction path sheds
    the oldest entries into ``pending-evicted/`` — shed, not destroyed,
    except under the sustained-ENOSPC case ``_evict_to_fit`` documents. The
    trade is deliberate: depth is recoverable, and an over-bound entry is
    not drainable at any depth.
    """
    limit = retain_content_limit()
    resplit = 0
    parts = 0
    for path, entry in iter_entries():
        content = entry.get("content")
        if not isinstance(content, str) or len(content) <= limit:
            continue

        payload = {k: v for k, v in entry.items() if k not in _ENTRY_ONLY_FIELDS}
        d = _ensure_dir()
        before = set(_list_entries(d))
        deferred: list = []
        _first, returned = enqueue_parts(
            payload,
            RuntimeError(
                f"re-split: content was {len(content)} chars, over the current "
                f"{limit}-char retain bound"
            ),
            record_refusal_as_drop=False,
            deferred_drops=deferred,
        )
        # New FILES only. A queue-depth delta would be wrong in both
        # directions: 0 when a part deduped onto an existing entry (the
        # single-part case dedupes onto the original itself), and understated
        # whenever `_evict_to_fit` shed an entry to make room for a part.
        written = len([p for p in returned if os.path.basename(p) not in before])
        if written == 0:
            print(
                f"[Hindsight] pending: could not re-split "
                f"{os.path.basename(path)} ({len(content)} chars, bound "
                f"{limit}) — entry STAYS QUEUED (never deleted)",
                file=sys.stderr,
            )
            continue

        dest_dir = resplit_dir()
        try:
            os.makedirs(dest_dir, mode=0o700, exist_ok=True)
            shutil.move(path, os.path.join(dest_dir, os.path.basename(path)))
        except OSError as e:
            if os.path.exists(path):
                # The parts are already queued; leaving the original queued
                # too means the memory is retained twice, which the upsert on
                # document_id makes harmless. Losing it would not be.
                print(
                    f"[Hindsight] pending: re-split {os.path.basename(path)} "
                    f"into {written} part(s) but could not archive the original "
                    f"into {dest_dir} ({e}) — it STAYS QUEUED (never deleted)",
                    file=sys.stderr,
                )
                continue
            # The move failed because the original is NO LONGER IN THE QUEUE:
            # writing the parts filled it and `_evict_to_fit` FIFO-shed the
            # very entry being re-split (it is the oldest — the parts are all
            # newer than it). Saying "STAYS QUEUED" here is simply false, and
            # this is the line an operator reads under exactly that pressure.
            # Nothing is lost — the parts carry the whole memory and the
            # original is under `evicted_dir()` — but the entry IS retired
            # from the live queue, so it counts like an archived one below.
            print(
                f"[Hindsight] pending: re-split {os.path.basename(path)} into "
                f"{written} queued part(s); the original could not be archived "
                f"into {dest_dir} ({e}) because writing the parts filled the "
                f"queue and it was itself evicted — it is NOT queued, it is "
                f"under {evicted_dir()} (the parts carry the whole memory)",
                file=sys.stderr,
            )
        else:
            _trim_dir(dest_dir, RESPLIT_MAX_ENTRIES, RESPLIT_MAX_BYTES)
            print(
                f"[Hindsight] pending: re-split {os.path.basename(path)} "
                f"({len(content)} chars, over the {limit}-char bound) into "
                f"{written} queued part(s); the original is archived under "
                f"{dest_dir}, not deleted",
                file=sys.stderr,
            )

        # Reached only on the branches where the original has LEFT the live
        # queue (archived, or evicted out from under the archive). Both are
        # a completed re-split, so both count — the `continue` above used to
        # skip the accounting on the evicted branch, returning (0, 0) after
        # genuinely writing N parts, which silenced phase 0c's `_blog` line
        # and under-reported `summary["resplit"]`.
        resplit += 1
        parts += written
        # And only now can a per-part failure be called a loss: the original
        # is gone from the queue, so nothing will retry the parts that never
        # got written. While it was still queued, stamping these would have
        # failed `switchroom doctor` for a memory that was never lost.
        record_deferred_drops(deferred)
    return resplit, parts


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


_PART_SUFFIX_TAIL_RE = re.compile(r"-p(\d+)of\d+$")


def _part_position(entry: dict) -> str:
    """Where this entry sits inside a split retain, as ``"7"`` / ``"2.1"``.

    ``""`` for an unsplit retain. Read off the ``-p{i}of{n}`` suffix chain
    that :func:`lib.retain_split.part_document_id` appends, innermost split
    last, so a re-split part reads ``"2.1"`` (part 1 of part 2).

    Only the INDEX is taken; the total is deliberately discarded. That is
    what lets the key still collapse the duplicates it exists for: the
    32-way group measured on this fleet carried ``-p7of15``, ``-p7of16``
    and ``-p7of18`` over byte-identical content, because the enclosing
    transcript kept growing while the part itself did not. Keying on the
    total would have split that group three ways and matched nothing.
    """
    doc = entry.get("document_id")
    if not isinstance(doc, str):
        return ""
    indices = []
    while True:
        m = _PART_SUFFIX_TAIL_RE.search(doc)
        if not m:
            break
        indices.append(m.group(1))
        doc = doc[: m.start()]
    return ".".join(reversed(indices))


def _dupe_key(entry: dict) -> Optional[str]:
    """Stable 16-hex identity of a queued retain, or ``None``.

    Derived from ``(bank_id, part_position, sha256(content))`` and NOTHING
    ELSE. Two entries sharing this key carry byte-identical content, for
    the same bank, at the same position inside a split — the same memory,
    however it got queued and whatever document id the producer stamped on
    it.

    The part position is in the key because a split's parts are NOT
    guaranteed to differ from each other: ``split_retain_content`` cuts on
    a character bound, so highly repetitive content (a long run of
    identical log lines, a padded transcript) yields byte-identical parts.
    Without the position, a 10-part memory collapses to a single queued
    part and the other nine positions never reach the bank — real loss, not
    a redundant copy. With it, parts of one memory can never merge into
    each other while duplicate re-enqueues of the SAME position still do.

    The WHOLE ``document_id`` used to be the key's dominant term and is not
    any more (switchroom #3688) — see the module docstring for the
    measurement that forced it and for the exact cost. Short version: the
    id varies per enqueue for the producer that dominates this queue
    (``subagent_retain.py`` embeds the sub-agent session id), so an
    id-bearing key never matched a re-enqueue and the queue refilled itself
    faster than it drained. The part position is the one fragment of the id
    that survives into the key, and only because dropping it would lose
    content rather than duplicate it.

    ``None`` when ``content`` is absent: identity cannot be established, so
    the entry must always be kept rather than merged. An EMPTY string is
    identity enough — degenerate, but two empty retains into one bank are
    genuinely the same (non-)memory.

    Nothing else in the entry may enter this key. ``failed_at``,
    ``error_message``, ``attempt_count`` and ``last_attempt_at`` all drift
    between the first enqueue and the re-enqueue this guard exists to
    catch; keying on any of them re-creates the no-op the size pre-filter
    once was.
    """
    content = entry.get("content")
    if content is None:
        return None
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False, sort_keys=True)
    h = hashlib.sha256()
    # Length-prefixed so a bank id ending in digits cannot be confused with
    # the part position that follows it.
    for field in (str(entry.get("bank_id")), _part_position(entry)):
        h.update(b"%d:" % len(field))
        h.update(field.encode("utf-8"))
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


def record_deferred_drops(drops: list) -> int:
    """Stamp the ledger for drops ``enqueue_parts`` handed back deferred.

    Call this ONLY once the caller's own copy of the memory has left the
    live queue — that is the moment a per-part failure stops being a
    retryable "nothing was written, the original stays queued" and becomes
    the permanent loss ``record_drop`` claims. Returns how many were
    recorded, so a caller can assert it stamped nothing on the keep-queued
    branches.
    """
    for payload, error in drops:
        record_drop(payload, error)
    return len(drops)


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
    return enqueue_parts(payload, error)[0]


def enqueue_parts(
    payload: dict,
    error: BaseException,
    *,
    record_refusal_as_drop: bool = True,
    deferred_drops: Optional[list] = None,
) -> tuple[Optional[str], list[str]]:
    """``enqueue()``, plus EVERY path ``_enqueue_one`` handed back.

    ``enqueue()`` returns only the first path, which cannot tell a caller
    how many entries the call actually put in the queue. Callers that own a
    copy of the memory (``resplit_over_bound_entries`` holds the original)
    need that: they may only retire their copy once the parts are down.

    The returned list is the paths ``_enqueue_one`` RETURNED, which is not
    the same as the paths it CREATED — a dedupe hit returns the path of an
    already-queued identical entry. The caller decides what that means for
    it; :func:`resplit_over_bound_entries` subtracts the paths that were
    already queued before the call, which is what makes a re-split that
    deduped straight back onto its own original count as zero parts.

    ``record_refusal_as_drop=False`` suppresses the drop-ledger entry on the
    two whole-memory refusals below. ``record_drop`` means "this memory is
    PERMANENTLY LOST" — `switchroom doctor` fails on a non-zero ledger — so
    a caller that keeps the memory queued when the refusal comes back must
    not stamp it.

    ``deferred_drops`` closes the same hole on the PER-PART door. A per-part
    failure inside ``_enqueue_one`` (its own ``MAX_BYTES`` refusal, or a
    write that fails after eviction made room) is NOT self-evidently a loss:
    when every part fails, ``enqueue_parts`` hands back nothing, the caller
    keeps its copy queued, and phase 0c retries the whole thing on the next
    backlog drain — so stamping there makes the ledger climb by one part per
    part per drain while describing zero lost memories, and it never resets
    once the disk is fixed. Pass a list and those drops are collected onto it
    instead; call :func:`record_deferred_drops` only on the branch where the
    caller's copy actually leaves the live queue. With ``deferred_drops=None``
    (the producers: ``session_end`` / ``retain``, who hold no other copy) the
    ledger is stamped immediately, exactly as before.
    """
    d = _ensure_dir()

    content = payload.get("content")
    parts = split_retain_content(content) if isinstance(content, str) else [content]
    total = len(parts)
    if total <= 1:
        one = _enqueue_one(d, payload, error, deferred_drops=deferred_drops)
        return one, ([] if one is None else [one])

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
        if record_refusal_as_drop:
            record_drop(payload, ValueError(
                f"entry is {total_bytes} bytes across {total} parts, larger than "
                f"the whole HINDSIGHT_PENDING_MAX_BYTES cap ({MAX_BYTES}); "
                f"refusing this entry rather than evicting the entire queue for it"
            ))
        return None, []
    if total > MAX_ENTRIES:
        if record_refusal_as_drop:
            record_drop(payload, ValueError(
                f"entry splits into {total} parts, more than the whole "
                f"HINDSIGHT_PENDING_MAX_ENTRIES cap ({MAX_ENTRIES}); refusing "
                f"this entry rather than evicting the entire queue for it"
            ))
        return None, []

    first: Optional[str] = None
    returned: list[str] = []
    for part_payload in part_payloads:
        # Each part goes through the FULL enqueue pipeline — dedupe, the
        # MAX_BYTES refusal, eviction, the drop ledger — because each part
        # is an independently drainable memory, not a fragment that only
        # means something alongside its siblings. A part that cannot be
        # written is recorded as a drop (or collected onto ``deferred_drops``
        # for the caller to decide, see above) and the remaining parts still
        # go in; returning ``None`` for the whole memory because part 7 of 9
        # hit ENOSPC would discard eight recoverable turns.
        #
        # A part CAN evict an earlier part of the same memory when the queue
        # is already at its cap (eviction is FIFO and earlier parts are
        # older). That is the same trade `_evict_to_fit` documents — the
        # evicted part MOVES to ``pending-evicted/``, so it is shed, not
        # destroyed, except under the sustained-ENOSPC case named there.
        written = _enqueue_one(
            d, part_payload, error, deferred_drops=deferred_drops
        )
        if written is not None:
            returned.append(written)
            if first is None:
                first = written
    return first, returned


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


def _enqueue_one(
    d: str,
    payload: dict,
    error: BaseException,
    *,
    deferred_drops: Optional[list] = None,
) -> Optional[str]:
    """Write exactly ONE queue entry for ``payload``. See ``enqueue()``.

    ``deferred_drops``, when a list is passed, DEFERS both ``record_drop``
    calls below: the ``(payload, error)`` pair is appended to the list
    instead of being stamped on the ledger straight away. The caller then
    owns the decision and must call :func:`record_deferred_drops` if — and
    only if — it stops keeping its own copy of the memory. See
    ``enqueue_parts`` for why that decision cannot be made here.
    """
    def _drop(err: BaseException) -> None:
        if deferred_drops is None:
            record_drop(payload, err)
        else:
            deferred_drops.append((payload, err))

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
        _drop(ValueError(
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
        # ``_drop`` defers it for a caller that still holds the memory.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        _drop(write_err)
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


#: HTTP statuses that are 4xx but describe a TRANSIENT condition, so they
#: must be read as retryable despite the 4xx class.
_RETRYABLE_4XX = frozenset({408, 425, 429})


def is_permanent_failure(error: BaseException) -> bool:
    """True when ``error`` can never succeed on a later identical retry.

    This is the gate on ``mark_dead`` (see ``drain_pending._record_failure``).
    Getting it wrong in the permissive direction costs a re-POST — which is an
    upsert, so it costs time. Getting it wrong in the strict direction costs
    the USER'S MEMORY. So the rule is deliberately asymmetric: an error is
    permanent only when we can positively identify it as a client-side defect
    in the request itself. Everything we cannot classify is retryable.

    PERMANENT — a 4xx other than 408/425/429. The server understood us and
    rejected the request: a malformed payload, an unknown bank, an oversized
    body, a bad token. Re-POSTing the identical bytes reproduces it exactly,
    so attempts are pure waste and ``.dead`` is the honest outcome.

    RETRYABLE — everything else. Notably 5xx, which is what a failed
    fact-extraction surfaces as::

        HTTP 500 ...: {"detail": "Fact extraction failed: 1/1 chunks failed.
        First failures: chunk 0: JSONDecodeError: Expecting value: line 1
        column 1 (char 0)"}

    That 500 means the extraction model returned an empty or non-JSON
    completion for one chunk (measured 2026-07-26: Ollama returning
    ``content: ""`` with all-zero usage, and gpt-oss-20b emitting a numbered
    prose list instead of the JSON schema). It is a property of one sampling
    run, NOT of the queued content — the very same entry succeeds on a later
    attempt. Counting it toward ``MAX_ATTEMPTS`` is what turned a flaky model
    into permanently lost memories: five unlucky samples and a real memory
    went ``.dead``.

    Timeouts, connection resets, DNS failures and anything unrecognised are
    retryable for the same reason — none of them is evidence that the content
    can never be persisted.

    The fleet bears this out. A census of every ``.dead`` marker on this host
    (2026-07-26, 129 markers across 10 agents) found the retiring error was
    ``TimeoutError`` 128 times and ``URLError`` once. **Not one was a 4xx.**
    Every permanently-lost memory here was lost to a transient failure, so
    this gate would have kept all 129 queued and drainable. Two were retired
    at 00:56Z that same morning — this was live, not historical.

    ``client.HindsightClient._request`` re-raises ``urllib`` HTTP failures as
    ``RuntimeError(f"HTTP {code} from {url}: {body}")`` with the original
    ``HTTPError`` chained on ``__cause__``, so the status is read from the
    cause when present and parsed out of the message otherwise (the message
    form is what a de-chained/re-serialised error leaves behind).
    """
    code = getattr(error, "code", None)
    cause = getattr(error, "__cause__", None)
    if not isinstance(code, int) and cause is not None:
        code = getattr(cause, "code", None)
    if not isinstance(code, int):
        text = str(error)
        if text.startswith("HTTP "):
            head = text[5:].split(" ", 1)[0]
            if head.isdigit():
                code = int(head)
    if not isinstance(code, int):
        return False
    return 400 <= code < 500 and code not in _RETRYABLE_4XX


def mark_dead(path: str, entry: dict) -> Optional[str]:
    """Retire an entry that exceeded ``MAX_ATTEMPTS`` into ``dead_dir()``.

    Returns the marker path, or ``None`` if it failed.

    WHERE THE MARKER GOES, AND WHY IT MOVED. This used to write
    ``<path>.dead`` — i.e. INSIDE the live queue directory. Since the marker
    is the only remaining copy of the memory (the live entry is unlinked once
    it is durable), that put the last copy of a memory in the directory
    external janitors sweep. It is not hypothetical: a host cron on this
    fleet ran ``find <queue> -name '*.dead' -mtime +14 -delete``. Measured
    2026-07-26, 6 such markers were live in the queue directory, each on a
    countdown to permanent deletion. The marker now lands in the
    ``pending-dead/`` sibling, so the live queue directory holds ONLY live
    entries and no glob over it can match a memory. See :func:`dead_dir`.

    FAILURE IS NOT DELETION. If the marker cannot be written at all, this
    returns ``None`` and **leaves the live entry exactly where it is**. The
    drain then re-attempts it on the next run, which is wasteful and visible;
    the alternative — falling back to a marker inside the queue directory —
    would quietly restore the loss channel this function exists to close.
    Queued-and-retrying beats destroyed, every time.

    Crash-window invariant (#1094 item 3): **a live ``<path>.json`` entry
    must never carry a ``dead_at`` stamp.** The old two-step form violated
    this — it wrote the dead_at-stamped payload back to the *live* path
    (rename tmp -> path) and only then renamed path -> path.dead, so a
    crash between the two renames left a live entry with ``dead_at`` set
    that the drainer would re-enter and re-bump. Here we instead:

      1. write the dead_at-stamped payload to a ``.tmp`` inside ``dead_dir()``
      2. ``os.replace(tmp, dead_path)``  — the marker appears in one atomic
         step, in a directory the drainer never lists at all
      3. ``os.unlink(path)``            — drop the original live entry

    At every crash point the invariant holds: the ``dead_at`` stamp only ever
    lands in ``dead_dir()``. A crash after step 2 leaves both the (stale, no-
    dead_at) live entry and the marker; the next drain re-marks it dead
    (``os.replace`` overwrites the marker idempotently), never observing a
    live entry with dead_at. Step 1 writes the tmp in the DESTINATION
    directory so step 2 is a same-directory rename and cannot fail on a
    cross-filesystem boundary halfway through.
    """
    entry["dead_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    dest_dir = dead_dir()
    dead_path = os.path.join(dest_dir, os.path.basename(path) + ".dead")
    tmp = dead_path + ".tmp"
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
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
        # Clean up a possibly-orphaned tmp so it doesn't linger. The live
        # entry is deliberately left alone — see "FAILURE IS NOT DELETION".
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return None


def sweep_legacy_dead_markers() -> int:
    """Move ``*.dead`` markers left inside the queue dir into ``dead_dir()``.

    Versions before this one wrote the marker as ``<entry>.json.dead``, next
    to the live entries. Those markers are the only copy of their memory and
    are sitting in the directory a janitor sweeps, so an upgrade has to
    RELOCATE them, not just stop producing new ones. Returns the number moved.

    Idempotent and safe to run on every drain: a queue with no legacy markers
    does no work and returns 0. A marker whose name already exists in
    ``dead_dir()`` is left where it is rather than overwritten — the two are
    the same entry by construction (the name carries the queue's unique
    suffix), but "leave both copies" is the answer that cannot lose one.
    """
    d = pending_dir()
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".dead"))
    except OSError:
        return 0
    if not names:
        return 0

    dest_dir = dead_dir()
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
    except OSError as e:
        print(
            f"[Hindsight] pending: cannot create {dest_dir} ({e}); "
            f"{len(names)} legacy .dead marker(s) STAY in the live queue "
            f"directory (they are not deleted)",
            file=sys.stderr,
        )
        return 0

    moved = 0
    for name in names:
        dest = os.path.join(dest_dir, name)
        if os.path.exists(dest):
            continue
        try:
            shutil.move(os.path.join(d, name), dest)
        except OSError:
            continue
        moved += 1
    if moved:
        print(
            f"[Hindsight] pending: relocated {moved} legacy .dead marker(s) "
            f"out of the live queue directory into {dest_dir} — the live "
            f"queue now holds only live entries",
            file=sys.stderr,
        )
    return moved
