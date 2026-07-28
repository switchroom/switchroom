"""Queue eviction/dedupe + two-phase backlog drain (switchroom #3596).

These live under ``scripts/tests/`` deliberately: that is the ONLY python
test directory CI discovers (``ci-tests-python.yml:63`` and
``ci-full.yml:140`` both run ``python3 -m unittest discover tests/`` with
``working-directory: vendor/hindsight-memory/scripts``). The sibling suite
at ``vendor/hindsight-memory/tests/`` is never executed by CI, so a
regression test placed there would gate nothing.

The behaviours pinned here are the ones a well-meaning refactor would
otherwise undo:
  * eviction sheds the OLDEST entry, never the incoming newest one;
  * reconcile-before-retain, so an already-durable document is not
    re-extracted at LLM cost;
  * commit-before-delete -- a 200 is an ack, not proof;
  * backlog concurrency defaults to 1 (the model pool is fleet-shared);
  * the stall guard does not overshoot under concurrency.
"""

import errno
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request
from contextlib import redirect_stderr

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import lib.pending as pending  # noqa: E402
import lib.retain_split as retain_split  # noqa: E402

CONFIG = {"debug": False}

#: A session id of the shape ``retain.py`` sees (a plain uuid).
SESSION = "11111111-2222-4333-8444-555555555555"


def _uuid(n: int) -> str:
    h = f"{n:032x}"
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _cd_doc(i: int = 1) -> str:
    """A POST-#3244 content-derived document_id.

    ``retain.slice_document_id`` → ``{session}-r{start_uuid}-{end_uuid}``.
    Presence-only reconcile is gated on this shape, so the drain tests must
    use it rather than a stand-in like ``doc-1``.
    """
    return f"{SESSION}-r{_uuid(i)}-{_uuid(i + 1000)}"


def _payload(bank="bank-a", content="hello", doc=None):
    if doc is None:
        doc = _cd_doc(1)
    return {
        "api_url": "http://127.0.0.1:9/none",
        "api_token": None,
        "bank_id": bank,
        "document_id": doc,
        "content": content,
        "context": None,
        "metadata": {},
        "tags": None,
    }


class _QueueTempDirMixin:
    #: env knobs a case may set; restored in tearDown so none can leak.
    ENV_KEYS = (
        "HINDSIGHT_PENDING_DIR",
        "HINDSIGHT_PENDING_EVICTED_DIR",
        "HINDSIGHT_PENDING_RECONCILED_DIR",
        # Absent from this tuple the budget/clamp cases ran against whatever
        # the ambient env said — vacuously green in CI, where nothing sets it.
        "HINDSIGHT_DRAIN_TIMEOUT",
        "HINDSIGHT_DRAIN_BUDGET_S",
        "HINDSIGHT_DRAIN_BACKLOG_BUDGET_S",
        "HINDSIGHT_DRAIN_BACKLOG_TIMEOUT",
        "HINDSIGHT_DRAIN_CONCURRENCY",
        "HINDSIGHT_DRAIN_SLEEP_S",
        "HINDSIGHT_DRAIN_P95_CMD",
        "HINDSIGHT_DRAIN_P95_BACKOFF_MS",
        # `_backlog_timeout` derives its default from this (#3610), so an
        # ambient value would silently move the assertions below.
        "HINDSIGHT_RETAIN_CLIENT_DEADLINE_S",
        # The retain content bound, which decides whether `enqueue` splits.
        "HINDSIGHT_RETAIN_MAX_CONTENT_CHARS",
        "HINDSIGHT_PENDING_DUPLICATE_DIR",
        "HINDSIGHT_PENDING_DEAD_DIR",
        "HINDSIGHT_PENDING_RESPLIT_DIR",
    )

    def setUp(self):
        self._env_prev = {k: os.environ.get(k) for k in self.ENV_KEYS}
        self._tmp = tempfile.mkdtemp(prefix="hindsight-pending-test-")
        self._dir = os.path.join(self._tmp, "pending-retains")
        os.environ["HINDSIGHT_PENDING_DIR"] = self._dir
        # Backlog replay paces itself by default; tests must not sleep.
        os.environ["HINDSIGHT_DRAIN_SLEEP_S"] = "0"
        # Hermeticity: a case that cares about the clamp sets this itself;
        # nothing may inherit an ambient value from the caller's shell.
        os.environ.pop("HINDSIGHT_DRAIN_TIMEOUT", None)
        os.environ.pop("HINDSIGHT_DRAIN_BUDGET_S", None)
        self._caps_prev = (pending.MAX_ENTRIES, pending.MAX_BYTES)

    def tearDown(self):
        pending.MAX_ENTRIES, pending.MAX_BYTES = self._caps_prev
        for k, v in self._env_prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _names(self):
        return sorted(n for n in os.listdir(self._dir) if n.endswith(".json"))

    def _archive_names(self):
        try:
            return sorted(os.listdir(pending.evicted_dir()))
        except OSError:
            return []

    def _reconciled_names(self):
        try:
            return sorted(os.listdir(pending.reconciled_dir()))
        except OSError:
            return []


class EvictionTest(_QueueTempDirMixin, unittest.TestCase):
    """A full queue must shed the OLDEST entry, not refuse the newest.

    The pre-fix behaviour returned ``None`` at the cap, i.e. it threw away
    the turn that had just happened -- the one most likely to still matter
    -- and kept a queue full of stale entries instead.
    """

    def test_full_queue_evicts_oldest_and_keeps_the_newest(self):
        pending.MAX_ENTRIES = 3
        # Entry filenames are `<unix-ms>-<uuid>.json` and FIFO order is the
        # lexicographic sort of that name. Real entries are milliseconds
        # apart; a test that enqueues four inside one millisecond would
        # tie-break on the random uuid instead, so pin the clock.
        clock = iter(1000.0 + i for i in range(10))
        with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
            first = pending.enqueue(
                _payload(content="oldest", doc="d0"), RuntimeError("x")
            )
            for i in range(1, 3):
                pending.enqueue(
                    _payload(content=f"mid-{i}", doc=f"d{i}"), RuntimeError("x")
                )
            self.assertEqual(len(self._names()), 3)

            with redirect_stderr(io.StringIO()) as err:
                newest = pending.enqueue(
                    _payload(content="NEWEST", doc="d9"), RuntimeError("x")
                )

        self.assertIsNotNone(newest, "the incoming entry must never be refused")
        self.assertEqual(len(self._names()), 3, "cap still honoured")
        self.assertFalse(os.path.exists(first), "the OLDEST entry was evicted")
        with open(newest, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["content"], "NEWEST")
        self.assertIn("evicted OLDEST", err.getvalue())

    def test_eviction_archives_rather_than_deletes(self):
        pending.MAX_ENTRIES = 2
        pending.enqueue(_payload(content="a", doc="d0"), RuntimeError("x"))
        pending.enqueue(_payload(content="b", doc="d1"), RuntimeError("x"))
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(content="c", doc="d2"), RuntimeError("x"))
        self.assertEqual(len(self._archive_names()), 1)

    def test_a_full_disk_evicts_the_oldest_live_entry_outright_and_says_so(self):
        """The bound on "the entry is never deleted" (#3599 review R4-M1).

        Three documents in this PR asserted a structural invariant the code
        does not have — that no ``os.remove`` in ``pending.py`` can touch a
        LIVE queue entry. ``_evict_to_fit``'s ``OSError`` fallback can, and
        under sustained ENOSPC it does: ``archive_reconciled`` keeps entries
        queued, the queue fills, this fires, its own archive move fails for
        the same reason, and the oldest live entries are removed to keep
        accepting the newest.

        That behaviour is ACCEPTED — a queue must be bounded by something,
        and the newest turn is the one most likely to still matter — but it
        is loss, so what is pinned here is that it is loud and correctly
        labelled, not that it doesn't happen. The ``+archive-failed`` reason
        is the operator's only signal that the payload is GONE rather than
        merely shed, so it is asserted, not just the eviction.
        """
        pending.MAX_ENTRIES = 3
        for i in range(3):
            pending.enqueue(_payload(content=f"c{i}", doc=f"d{i}"), RuntimeError("x"))
        before = self._names()
        self.assertEqual(len(before), 3)

        with unittest.mock.patch.object(
            pending.shutil, "move", side_effect=OSError(28, "No space left on device")
        ):
            with redirect_stderr(io.StringIO()) as err:
                got = pending.enqueue(
                    _payload(content="newest", doc="d-new"), RuntimeError("x")
                )

        self.assertIsNotNone(got, "the newest memory is still accepted")
        names = self._names()
        self.assertEqual(len(names), 3, "the queue stayed bounded")
        self.assertNotIn(before[0], names, "the OLDEST live entry was removed")
        # Set comparison, not slice: these are enqueued inside one
        # millisecond, so their relative order tie-breaks on the dupe key
        # (arbitrary but total — see enqueue()).
        self.assertEqual(
            set(names),
            set(before[1:]) | {os.path.basename(got)},
            "only the oldest went, and the newest arrived",
        )
        self.assertEqual(
            self._archive_names(), [], "the archive move failed, so no copy was kept"
        )
        self.assertIn("evicted OLDEST entry", err.getvalue())

        with open(pending.evictions_log_path(), encoding="utf-8") as f:
            line = f.read().strip()
        self.assertIn(f"evicted={before[0]}", line)
        self.assertIn(
            "+archive-failed",
            line,
            "the ledger must distinguish 'shed into the archive' from "
            "'removed outright' — they are different categories of loss",
        )

    def test_byte_cap_also_triggers_eviction(self):
        """Content spans 499 B .. 744 KB, so a count cap alone bounds disk
        only to within ~1500x. Both caps are load-bearing."""
        pending.MAX_ENTRIES = 1000
        pending.enqueue(_payload(content="x" * 4000, doc="d0"), RuntimeError("x"))
        pending.MAX_BYTES = 5000
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(content="y" * 4000, doc="d1"), RuntimeError("x"))
        self.assertEqual(len(self._names()), 1)
        self.assertEqual(len(self._archive_names()), 1)

    def test_eviction_is_logged_to_the_ledger(self):
        """Eviction is not silent loss, but it IS loss -- doctor reads this."""
        pending.MAX_ENTRIES = 1
        pending.enqueue(_payload(content="m0", doc="d0"), RuntimeError("x"))
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(content="m1", doc="d1"), RuntimeError("x"))
        with open(pending.evictions_log_path(), encoding="utf-8") as f:
            line = f.read().strip()
        self.assertIn("evicted=", line)
        self.assertIn("reason=count", line)
        self.assertIn("queue_depth=", line)

    def test_archive_is_itself_bounded(self):
        """Eviction must not merely relocate the disk problem."""
        pending.MAX_ENTRIES = 1
        prev = pending.ARCHIVE_MAX_ENTRIES
        pending.ARCHIVE_MAX_ENTRIES = 2
        try:
            with redirect_stderr(io.StringIO()):
                for i in range(6):
                    pending.enqueue(_payload(doc=f"d{i}"), RuntimeError("x"))
            self.assertLessEqual(len(self._archive_names()), 2)
        finally:
            pending.ARCHIVE_MAX_ENTRIES = prev

    def test_archive_trim_keeps_the_newest_evictions(self):
        """Direction matters: trimming the wrong end keeps the stale tail.

        ``test_archive_is_itself_bounded`` only pins the COUNT, so reversing
        the trim direction leaves it green while the archive discards
        exactly what was just shed.
        """
        pending.MAX_ENTRIES = 1
        prev = pending.ARCHIVE_MAX_ENTRIES
        pending.ARCHIVE_MAX_ENTRIES = 2
        try:
            clock = iter(1000.0 + i for i in range(20))
            with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
                with redirect_stderr(io.StringIO()):
                    paths = [
                        pending.enqueue(
                            _payload(content=f"m{i}", doc=f"d{i}"), RuntimeError("x")
                        )
                        for i in range(5)
                    ]
            evicted_names = [os.path.basename(p) for p in paths[:-1]]
            self.assertEqual(
                self._archive_names(),
                sorted(evicted_names[-2:]),
                "the archive must keep the most recently evicted entries",
            )
        finally:
            pending.ARCHIVE_MAX_ENTRIES = prev

    def test_eviction_ledger_trim_keeps_the_NEWEST_lines(self):
        """The ledger is the operator's record of what was shed.

        Trimming the head off (keeping the oldest lines) would leave doctor
        reading a frozen prefix while every recent eviction fell out — and
        the existing ledger test only greps for one line, so it stays green
        either way.
        """
        pending.MAX_ENTRIES = 1
        log = pending.evictions_log_path()
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "w", encoding="utf-8") as f:
            for i in range(500):
                f.write(f"ANCIENT-{i:03d} evicted=old bytes=0 reason=count\n")

        prev = (pending.EVICTIONS_LOG_MAX_BYTES, pending.EVICTIONS_LOG_KEEP_LINES)
        pending.EVICTIONS_LOG_MAX_BYTES, pending.EVICTIONS_LOG_KEEP_LINES = 1, 3
        try:
            pending.enqueue(_payload(content="m0", doc="d0"), RuntimeError("x"))
            with redirect_stderr(io.StringIO()):
                pending.enqueue(_payload(content="m1", doc="d1"), RuntimeError("x"))
        finally:
            pending.EVICTIONS_LOG_MAX_BYTES, pending.EVICTIONS_LOG_KEEP_LINES = prev

        with open(log, encoding="utf-8") as f:
            kept = [ln.rstrip("\n") for ln in f]
        self.assertEqual(len(kept), 3, "trimmed to KEEP_LINES")
        self.assertIn("evicted=", kept[-1], "the newest line is the real eviction")
        self.assertEqual(
            [ln for ln in kept if ln.startswith("ANCIENT-000")],
            [],
            "the OLDEST lines must be the ones dropped",
        )
        self.assertTrue(
            kept[0].startswith("ANCIENT-498"),
            f"kept the wrong end of the ledger: {kept[0]!r}",
        )

    def test_the_byte_cap_is_a_boundary_not_an_approximation(self):
        """`nbytes + incoming > MAX_BYTES` evicts; `== MAX_BYTES` does not.

        Off-by-one here is silent: it either sheds a memory that fit, or
        overshoots the cap the operator set.
        """
        pending.MAX_ENTRIES = 1000
        first = pending.enqueue(_payload(content="x" * 100, doc="d0"), RuntimeError("x"))
        second = pending.enqueue(_payload(content="y" * 100, doc="d1"), RuntimeError("x"))
        exact = os.path.getsize(first) + os.path.getsize(second)
        os.remove(second)

        # Exactly at the cap: the incoming entry fits, nothing may be evicted.
        pending.MAX_BYTES = exact
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(content="y" * 100, doc="d1"), RuntimeError("x"))
        self.assertEqual(len(self._names()), 2, "an entry that fits exactly must fit")
        self.assertEqual(self._archive_names(), [], "nothing was over the cap")

        # One byte tighter: the same pair no longer fits, so the oldest sheds.
        os.remove(sorted(os.path.join(self._dir, n) for n in self._names())[-1])
        pending.MAX_BYTES = exact - 1
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(content="y" * 100, doc="d1"), RuntimeError("x"))
        self.assertEqual(len(self._archive_names()), 1, "one byte over must evict")
        self.assertEqual(len(self._names()), 1)

    def test_ledgers_live_outside_the_queue_dir(self):
        """So they can never be listed as an entry, drained, or counted."""
        pending.MAX_ENTRIES = 1
        pending.enqueue(_payload(doc="d0"), RuntimeError("x"))
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(doc="d1"), RuntimeError("x"))
        for p in (pending.evictions_log_path(), pending.drops_path()):
            self.assertNotEqual(os.path.dirname(p), self._dir.rstrip("/"))
        self.assertEqual(pending.count(), 1)


class QueueOrderTest(_QueueTempDirMixin, unittest.TestCase):
    """What the filename ordering does and does not promise.

    FIFO is what eviction and the drain both rely on, and it is exact only
    down to the millisecond: the name carries no finer age information, so
    entries sharing a millisecond tie-break on the dupe key — stable and
    total, but arbitrary. The comment used to claim plain oldest-first.
    """

    def _enqueue_at(self, ms, content):
        with unittest.mock.patch.object(pending.time, "time", lambda: ms / 1000.0):
            return pending.enqueue(_payload(content=content, doc=f"d-{content}"),
                                   RuntimeError("x"))

    def test_entries_are_ordered_by_enqueue_millisecond(self):
        newest = self._enqueue_at(1_700_000_002_000, "third")
        oldest = self._enqueue_at(1_700_000_000_000, "first")
        middle = self._enqueue_at(1_700_000_001_000, "second")
        self.assertEqual(
            [p for p, _ in pending.iter_entries()],
            [oldest, middle, newest],
            "write order must not matter; the millisecond stamp orders them",
        )

    def test_same_millisecond_entries_are_ordered_stably_but_arbitrarily(self):
        paths = [self._enqueue_at(1_700_000_000_000, f"c{i}") for i in range(4)]
        got = [p for p, _ in pending.iter_entries()]
        self.assertEqual(sorted(got), sorted(paths), "every entry is listed once")
        self.assertEqual(got, sorted(got), "the order is the name sort, not enqueue order")
        self.assertEqual(got, [p for p, _ in pending.iter_entries()], "and it is stable")


class DedupeTest(_QueueTempDirMixin, unittest.TestCase):
    """``reconcile_tail`` re-enqueues the same slice on every boot until its
    watermark is confirmed -- 63% of one measured fleet queue was dupes."""

    def test_identical_entry_returns_the_existing_path(self):
        a = pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("x"))
        b = pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("x"))
        self.assertEqual(a, b)
        self.assertEqual(pending.count(), 1)

    def test_different_content_is_not_deduped(self):
        pending.enqueue(_payload(content="one", doc="d1"), RuntimeError("x"))
        pending.enqueue(_payload(content="two", doc="d1"), RuntimeError("x"))
        self.assertEqual(pending.count(), 2)

    def test_dedupe_survives_an_attempted_entry(self):
        """The scenario the guard exists for, and the one it used to miss.

        The queued copy is ALWAYS post-``update_attempt`` by the time
        ``reconcile_tail`` re-enqueues, because the SessionStart drain
        attempts every entry on every boot. A size-indexed dedupe therefore
        matched nothing in steady state and the queue grew by one duplicate
        per boot.
        """
        first = pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("x"))
        _, entry = pending.iter_entries()[0]
        pending.update_attempt(first, entry, TimeoutError("upstream timed out"))
        self.assertNotEqual(
            os.path.getsize(first),
            len(json.dumps(entry, ensure_ascii=False).encode("utf-8")) - 1,
        )

        again = pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("x"))
        self.assertEqual(again, first, "attempted entry must still dedupe")
        self.assertEqual(pending.count(), 1)

    def test_dedupe_survives_a_different_error_message(self):
        """The error string is not part of the memory's identity."""
        a = pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("short"))
        b = pending.enqueue(
            _payload(content="same", doc="d1"), ConnectionError("a much longer error")
        )
        self.assertEqual(a, b)
        self.assertEqual(pending.count(), 1)

    def test_dedupe_reads_no_files(self):
        """The key is in the filename, so a lookup is a listing scan only."""
        pending.enqueue(_payload(content="same", doc="d1"), RuntimeError("x"))
        real_open = open
        queue_dir = self._dir.rstrip("/")

        def no_entry_reads(path, *a, **kw):
            if os.path.dirname(str(path)) == queue_dir:
                raise AssertionError(f"dedupe opened a queue entry: {path}")
            return real_open(path, *a, **kw)

        with unittest.mock.patch("builtins.open", no_entry_reads):
            self.assertIsNotNone(pending._find_duplicate(self._dir, pending._dupe_key(
                {"bank_id": "bank-a", "document_id": "d1", "content": "same"}
            )))

    def test_different_banks_do_not_collide(self):
        pending.enqueue(_payload(bank="bank-a", content="same"), RuntimeError("x"))
        pending.enqueue(_payload(bank="bank-b", content="same"), RuntimeError("x"))
        self.assertEqual(pending.count(), 2)

    def test_entry_without_content_is_always_kept(self):
        """No content => identity cannot be established => never merge.

        This used to key off ``document_id``. It does not any more
        (switchroom #3688): the id varies per enqueue for the producer that
        dominates this queue, so it was never a usable identity. Content is.
        """
        p = _payload()
        p.pop("content")
        pending.enqueue(dict(p), RuntimeError("x"))
        pending.enqueue(dict(p), RuntimeError("x"))
        self.assertEqual(pending.count(), 2)

    def test_entry_without_document_id_still_dedupes_on_content(self):
        """The id is not required for identity — the content carries it."""
        p = _payload(content="same")
        p.pop("document_id")
        a = pending.enqueue(dict(p), RuntimeError("x"))
        b = pending.enqueue(dict(p), RuntimeError("x"))
        self.assertEqual(a, b)
        self.assertEqual(pending.count(), 1)

    def test_same_content_under_a_fresh_document_id_is_ONE_entry(self):
        """THE bug (switchroom #3688), pinned as an outcome.

        Measured on the live fleet 2026-07-26: 1,060 queued files, ~368
        distinct ``(bank_id, part_position, sha256(content))`` groups. The top
        group held
        32 files carrying ONE byte-identical 45,000-char part under 32
        DIFFERENT document ids, because ``subagent_retain.py`` stamps the
        sub-agent's own session id into the id
        (``{parent}-sub-{agent_id}-r{start}-{end}``) and every SubagentStop
        mints a new one. With ``document_id`` in the dedupe key not one of
        those 32 matched, so the queue refilled itself faster than it
        drained and the same LLM extraction was paid for 32 times.

        Restore ``document_id`` to ``_dupe_key`` and this goes red.
        """
        parent = "34c4bbeb-f805-4dd3-b085-46ac2eb57ae9"
        slice_ids = f"r{_uuid(7)}-{_uuid(8)}"
        content = "the same sub-agent work log, byte for byte" * 50
        for agent_id in ("aa2170a03a351e0", "a8857997182e1e9", "a836dfc39b5eb94"):
            pending.enqueue(
                _payload(content=content, doc=f"{parent}-sub-{agent_id}-{slice_ids}"),
                RuntimeError("timed out"),
            )
        self.assertEqual(
            pending.count(),
            1,
            "re-enqueuing identical content under a fresh document_id must be "
            "a no-op, not a new queue entry",
        )

    def test_the_surviving_entry_keeps_a_usable_document_id(self):
        """Dedupe must not leave an entry the drain cannot act on."""
        doc = _cd_doc(3)
        pending.enqueue(_payload(content="c", doc=doc), RuntimeError("x"))
        pending.enqueue(_payload(content="c", doc=_cd_doc(4)), RuntimeError("x"))
        (_, entry), = pending.iter_entries()
        self.assertEqual(entry["document_id"], doc, "the FIRST entry survives")
        self.assertTrue(pending.is_content_derived_document_id(entry["document_id"]))

    def test_identical_parts_of_ONE_split_are_never_merged(self):
        """The parts of a split are positions, not copies.

        ``split_retain_content`` cuts on a character bound, so repetitive
        content yields byte-identical parts. Merging them would leave the
        document missing every position but one — content loss, not a
        redundant copy. Drop ``_part_position`` from the key and this goes
        red: 10 parts collapse to 1.
        """
        pending.MAX_ENTRIES = 20
        pending.MAX_BYTES = 10**9
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        try:
            pending.enqueue(
                _payload(content="z" * 30_000, doc=_cd_doc(5)), RuntimeError("x")
            )
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_MAX_CONTENT_CHARS", None)

        entries = [e for _p, e in pending.iter_entries()]
        self.assertEqual(len(entries), 10, "one queued entry per position")
        self.assertEqual(
            len({e["content"] for e in entries}),
            1,
            "fixture check: the parts really are byte-identical",
        )

    def test_the_same_position_under_a_GROWING_total_still_dedupes(self):
        """The measured 32x group carried -p7of15, -p7of16 and -p7of18.

        The enclosing transcript kept growing between SubagentStops while
        part 7 itself did not change. Key on the total as well as the index
        and that group splits three ways and collapses nothing.
        """
        base = _cd_doc(6)
        for total in (15, 16, 18):
            pending.enqueue(
                _payload(content="part-seven", doc=f"{base}-p7of{total}"),
                RuntimeError("x"),
            )
        self.assertEqual(pending.count(), 1, "one memory, one queue entry")

    def test_a_part_position_is_read_off_the_id_not_the_metadata(self):
        """Entries queued by older builds may carry no part metadata."""
        self.assertEqual(pending._part_position({"document_id": "abc"}), "")
        self.assertEqual(pending._part_position({"document_id": "abc-p7of16"}), "7")
        self.assertEqual(
            pending._part_position({"document_id": "abc-p2of5-p1of2"}),
            "2.1",
            "innermost split reads last",
        )
        self.assertEqual(pending._part_position({"document_id": None}), "")


class CollapseDuplicatesTest(_QueueTempDirMixin, unittest.TestCase):
    """``collapse_duplicates`` — the other half of content-keyed identity.

    ``enqueue``'s filename key stops NEW duplicates. It cannot touch the
    ones already on disk: those were written with the old id-bearing key, so
    a fresh enqueue of their content computes a different key and never
    matches them. This pass recomputes identity from CONTENT, which makes it
    generation-agnostic, and the backlog drain runs it before spending a
    single LLM call.
    """

    def _duplicate_names(self):
        try:
            return sorted(os.listdir(pending.duplicate_dir()))
        except OSError:
            return []

    def _write_legacy(self, name, content, bank="bank-a", doc=None, attempts=1):
        """Write an entry the way an OLDER build would have named it.

        ``<unix-ms>-<uuid>.json`` with no key segment at all — the shape
        that predates #3596 — so nothing about the filename can be doing
        the identity work in these cases.
        """
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        entry = dict(_payload(bank=bank, content=content, doc=doc or _cd_doc(1)))
        entry["attempt_count"] = attempts
        p = os.path.join(self._dir, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(entry, f)
        return p

    def test_duplicates_collapse_to_one_live_entry(self):
        for i in range(5):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same-memory")
        self.assertEqual(pending.count(), 5)

        with redirect_stderr(io.StringIO()):
            collapsed = pending.collapse_duplicates()

        self.assertEqual(collapsed, 4)
        self.assertEqual(pending.count(), 1)

    def test_collapse_archives_the_losers_and_never_deletes_them(self):
        for i in range(3):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same-memory")

        with redirect_stderr(io.StringIO()):
            pending.collapse_duplicates()

        archived = self._duplicate_names()
        self.assertEqual(len(archived), 2, "losers are MOVED, not removed")
        for name in archived:
            with open(os.path.join(pending.duplicate_dir(), name)) as f:
                self.assertEqual(json.load(f)["content"], "same-memory")

    def test_the_copy_with_the_fewest_attempts_survives(self):
        """Durability-first survivor selection.

        Every copy carries identical content, so any of them delivers the
        same memory — but only the one with attempts left can still get
        there before MAX_ATTEMPTS. Keeping the OLDEST outright would
        systematically keep the most-attempted copy, which is backwards.
        """
        self._write_legacy("0000000001000-aaaaaaaaaaa0.json", "same", attempts=4)
        keep = self._write_legacy("0000000002000-aaaaaaaaaaa1.json", "same", attempts=1)
        self._write_legacy("0000000003000-aaaaaaaaaaa2.json", "same", attempts=3)

        with redirect_stderr(io.StringIO()):
            pending.collapse_duplicates()

        survivors = [p for p, _ in pending.iter_entries()]
        self.assertEqual(survivors, [keep])

    def test_distinct_memories_are_never_collapsed(self):
        self._write_legacy("0000000001000-aaaaaaaaaaa0.json", "memory-one")
        self._write_legacy("0000000002000-aaaaaaaaaaa1.json", "memory-two")
        self._write_legacy("0000000003000-aaaaaaaaaaa2.json", "memory-three")

        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.collapse_duplicates(), 0)
        self.assertEqual(pending.count(), 3)

    def test_identical_parts_of_ONE_split_are_never_collapsed(self):
        """The backlog is full of split parts; do not eat a document's tail.

        A legacy 3-part entry whose parts happen to be byte-identical must
        survive the sweep intact. Only the position keeps them apart.
        """
        base = _cd_doc(2)
        for i in range(1, 4):
            self._write_legacy(
                f"000000000{i}000-aaaaaaaaaaa{i}.json",
                "zzz",
                doc=f"{base}-p{i}of3",
            )

        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.collapse_duplicates(), 0)
        self.assertEqual(pending.count(), 3, "every position kept")
        self.assertEqual(self._duplicate_names(), [], "nothing archived")

    def test_the_same_position_from_different_runs_IS_collapsed(self):
        """The complement: same index, different totals and ids -> one entry."""
        for i, total in enumerate((15, 16, 18), start=1):
            self._write_legacy(
                f"000000000{i}000-aaaaaaaaaaa{i}.json",
                "zzz",
                doc=f"{_cd_doc(i)}-p7of{total}",
            )

        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.collapse_duplicates(), 2)
        self.assertEqual(pending.count(), 1)

    def test_same_content_in_different_banks_is_never_collapsed(self):
        self._write_legacy("0000000001000-aaaaaaaaaaa0.json", "same", bank="bank-a")
        self._write_legacy("0000000002000-aaaaaaaaaaa1.json", "same", bank="bank-b")

        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.collapse_duplicates(), 0)
        self.assertEqual(pending.count(), 2)

    def test_entries_without_content_are_never_grouped(self):
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        for i in range(2):
            p = os.path.join(self._dir, f"{1000 + i:013d}-aaaaaaaaaaa{i}.json")
            e = dict(_payload())
            e.pop("content")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(e, f)

        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.collapse_duplicates(), 0)
        self.assertEqual(pending.count(), 2)

    def test_an_unarchivable_duplicate_stays_queued_and_is_not_counted(self):
        """Archiving never falls back to a delete, and never over-reports."""
        for i in range(3):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same")

        with unittest.mock.patch.object(
            pending.shutil, "move", side_effect=OSError("ENOSPC")
        ):
            with redirect_stderr(io.StringIO()) as err:
                collapsed = pending.collapse_duplicates()

        self.assertEqual(collapsed, 0, "a retire that did not happen is not counted")
        self.assertEqual(pending.count(), 3, "the entries are STILL QUEUED")
        self.assertIn("STAYS QUEUED", err.getvalue())

    def test_the_duplicate_archive_is_itself_bounded(self):
        prev = pending.DUPLICATE_MAX_ENTRIES
        pending.DUPLICATE_MAX_ENTRIES = 2
        try:
            for i in range(6):
                self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same")
            with redirect_stderr(io.StringIO()):
                pending.collapse_duplicates()
            self.assertLessEqual(len(self._duplicate_names()), 2)
        finally:
            pending.DUPLICATE_MAX_ENTRIES = prev

    def test_the_backlog_drain_collapses_before_paying_for_extraction(self):
        """The user-visible outcome: one memory costs ONE extraction.

        Thirty-two byte-identical copies is what the live queue actually
        held. At the measured ~168 s per phase-2 extraction, draining them
        all is ~90 minutes of shared LLM lane time to persist one memory.
        """
        for i in range(32):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i:02d}.json", "one-memory")

        posted = []
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: bool(posted)
        ):
            with unittest.mock.patch.object(
                drain_pending,
                "_retry_one",
                lambda e, timeout: posted.append(e["document_id"]),
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG)

        self.assertEqual(summary["collapsed"], 31)
        self.assertEqual(len(posted), 1, "one memory must cost exactly one retain")
        self.assertEqual(pending.count(), 0)

    def test_the_in_hook_drain_does_not_collapse(self):
        """The SessionStart drain's contract is a hard latency ceiling.

        Collapsing reads every queued entry to recompute identity from
        content; that belongs out of hook. New duplicates cannot accumulate
        in-hook anyway — ``enqueue``'s filename key stops those.
        """
        for i in range(4):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same")

        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", lambda e, timeout: None
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["collapsed"], 0)
        self.assertEqual(len(self._duplicate_names()), 0)

    def test_a_dry_run_collapses_nothing(self):
        for i in range(3):
            self._write_legacy(f"{1000 + i:013d}-aaaaaaaaaaa{i}.json", "same")
        with redirect_stderr(io.StringIO()):
            summary = drain_pending.drain_backlog(CONFIG, dry_run=True)
        self.assertEqual(summary["collapsed"], 0)
        self.assertEqual(pending.count(), 3)


class DropLedgerTest(_QueueTempDirMixin, unittest.TestCase):
    """Residual drops -- the entry could not be written even after eviction."""

    def _fail_queue_writes(self):
        real_open = open
        queue_dir = self._dir.rstrip("/")

        def boom(path, *a, **kw):
            p = str(path)
            if p.endswith(".tmp") and os.path.dirname(p) == queue_dir:
                raise OSError(28, "No space left on device")
            return real_open(path, *a, **kw)

        return unittest.mock.patch("builtins.open", boom)

    def test_unwritable_queue_records_a_drop_and_returns_none(self):
        with self._fail_queue_writes():
            with redirect_stderr(io.StringIO()) as err:
                got = pending.enqueue(_payload(), RuntimeError("upstream down"))

        self.assertIsNone(got, "callers handle None; they must still get it")
        self.assertIn("permanently lost", err.getvalue())
        ledger = pending.read_drops()
        self.assertEqual(ledger["count"], 1)
        self.assertEqual(ledger["last_error_class"], "OSError")
        self.assertEqual(ledger["last_bank_id"], "bank-a")

    def test_first_dropped_at_is_not_overwritten_by_later_drops(self):
        with self._fail_queue_writes():
            with redirect_stderr(io.StringIO()):
                pending.enqueue(_payload(content="a"), RuntimeError("x"))
                first = pending.read_drops()["first_dropped_at"]
                pending.enqueue(_payload(content="b"), RuntimeError("x"))
                ledger = pending.read_drops()
        self.assertEqual(ledger["count"], 2)
        self.assertEqual(ledger["first_dropped_at"], first)

    def test_read_drops_survives_a_non_utf8_ledger(self):
        """The narrow-catch bug: UnicodeDecodeError is NOT a JSONDecodeError.

        ``record_drop()`` reads the ledger first, so a corrupt ledger used
        to turn ``enqueue()`` from documented-returns-None into a raiser at
        exactly the moment the queue is under stress -- breaking
        session_end.py / subagent_retain.py, which handle None.
        """
        os.makedirs(os.path.dirname(pending.drops_path()), exist_ok=True)
        with open(pending.drops_path(), "wb") as f:
            f.write(b"\xff\xfe\x00not utf-8 at all")
        self.assertEqual(pending.read_drops(), {})
        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending.record_drop(_payload(), RuntimeError("x")), 1)

    def test_read_drops_survives_malformed_json(self):
        os.makedirs(os.path.dirname(pending.drops_path()), exist_ok=True)
        with open(pending.drops_path(), "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertEqual(pending.read_drops(), {})

    def test_error_messages_are_truncated(self):
        """An unbounded upstream error body inflates the queue against
        MAX_BYTES for no diagnostic gain."""
        path = pending.enqueue(_payload(), RuntimeError("E" * 5000))
        with open(path, encoding="utf-8") as f:
            stored = json.load(f)["error_message"]
        self.assertLessEqual(len(stored), pending.MAX_ERROR_MESSAGE_CHARS + 20)
        self.assertTrue(stored.endswith("[truncated]"))

    def test_oversized_entry_is_refused_without_wiping_the_queue(self):
        """One entry must never cost the whole queue.

        With no guard the eviction loop can never satisfy its condition, so
        it evicts EVERY entry and writes the oversized one anyway -- and
        the bounded archive then discards most of what it just shed.
        """
        pending.MAX_BYTES = 100_000
        for i in range(20):
            pending.enqueue(_payload(content=f"turn-{i}", doc=f"d{i}"), RuntimeError("x"))
        self.assertEqual(pending.count(), 20)

        with redirect_stderr(io.StringIO()) as err:
            got = pending.enqueue(
                _payload(content="z" * 200_000, doc="huge"), RuntimeError("x")
            )

        self.assertIsNone(got, "the oversized entry is refused")
        self.assertEqual(pending.count(), 20, "every other entry survived")
        self.assertIn("larger than the whole", err.getvalue())
        self.assertEqual(pending.read_drops()["count"], 1)

    def test_a_memory_with_more_parts_than_the_count_cap_is_refused(self):
        """The count-cap sibling of the byte-cap guard (#3610).

        Splitting turns one memory into N entries, so the count cap can be
        blown the same way the byte cap can — and with a satisfiable eviction
        loop the later parts shed the earlier ones plus everything already
        queued, leaving a tail fragment and nothing else. Refuse instead.
        """
        pending.MAX_ENTRIES = 4
        pending.MAX_BYTES = 10**9  # only the COUNT cap may fire here
        for i in range(3):
            pending.enqueue(_payload(content=f"turn-{i}", doc=f"d{i}"), RuntimeError("x"))
        self.assertEqual(pending.count(), 3)

        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        try:
            with redirect_stderr(io.StringIO()) as err:
                got = pending.enqueue(
                    _payload(content="z" * 30_000, doc=_cd_doc(9)), RuntimeError("x")
                )
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_MAX_CONTENT_CHARS", None)

        self.assertIsNone(got, "a 10-part memory under a 4-entry cap is refused")
        self.assertEqual(pending.count(), 3, "every other entry survived")
        self.assertIn("more than the whole", err.getvalue())
        self.assertEqual(pending.read_drops()["count"], 1)

    def test_a_split_that_fits_the_count_cap_is_still_queued_per_part(self):
        """The other side of that boundary: refusal must not swallow a
        memory the queue can actually hold."""
        pending.MAX_ENTRIES = 20
        pending.MAX_BYTES = 10**9
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        try:
            got = pending.enqueue(
                _payload(content="z" * 30_000, doc=_cd_doc(9)), RuntimeError("x")
            )
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_MAX_CONTENT_CHARS", None)

        self.assertIsNotNone(got)
        self.assertEqual(pending.count(), 10, "one entry per part")
        self.assertEqual(pending.read_drops(), {}, "nothing was dropped")
        docs = sorted(e["document_id"] for _p, e in pending.iter_entries())
        self.assertEqual(docs[0], f"{_cd_doc(9)}-p10of10")
        for _p, entry in pending.iter_entries():
            self.assertLessEqual(len(entry["content"]), 3000)
            self.assertTrue(
                pending.is_content_derived_document_id(entry["document_id"]),
                "every queued part stays inside the free presence reconcile",
            )

    def test_an_entry_exactly_at_the_byte_cap_is_enqueued_not_dropped(self):
        """``blob_bytes > MAX_BYTES``, not ``>=`` (#3599 review R4-La).

        The boundary was pinned in ``_trim_dir``, ``_evict_to_fit``,
        ``_clamp`` and ``_env_num`` and missed here, so ``>`` → ``>=``
        survived the suite. It is not equivalent and it is not cosmetic: an
        entry whose serialised size lands exactly ON the cap DOES fit —
        ``_evict_to_fit``'s own condition is ``nbytes + incoming >
        MAX_BYTES``, which an empty queue satisfies — so under the mutant a
        writable, storable turn becomes a permanent RESIDUAL DROP. That is
        the one outcome in this module that loses a memory outright, and it
        would be reached by an entry the queue could have held.
        """
        payload = _payload(content="q" * 500, doc="exact-fit")
        probe = pending.enqueue(payload, RuntimeError("x"))
        exact = os.path.getsize(probe)
        os.remove(probe)

        pending.MAX_BYTES = exact
        with redirect_stderr(io.StringIO()) as err:
            got = pending.enqueue(payload, RuntimeError("x"))

        self.assertIsNotNone(got, "an entry exactly at the cap fits within it")
        self.assertEqual(os.path.getsize(got), exact)
        self.assertEqual(pending.count(), 1)
        self.assertNotIn("larger than the whole", err.getvalue())
        self.assertEqual(pending.read_drops(), {}, "nothing was dropped")

    def test_one_byte_over_the_byte_cap_is_refused(self):
        """The other side of the same boundary, so no single comparison
        satisfies both cases."""
        payload = _payload(content="q" * 500, doc="one-over")
        probe = pending.enqueue(payload, RuntimeError("x"))
        exact = os.path.getsize(probe)
        os.remove(probe)

        pending.MAX_BYTES = exact - 1
        with redirect_stderr(io.StringIO()) as err:
            self.assertIsNone(pending.enqueue(payload, RuntimeError("x")))
        self.assertIn("larger than the whole", err.getvalue())
        self.assertEqual(pending.read_drops()["count"], 1)

    def test_corrupt_entry_is_quarantined_not_skipped_forever(self):
        """A skipped corrupt entry is immortal: never reconciled, never
        drained, never aged to .dead, but still counted in the depth."""
        good = pending.enqueue(_payload(), RuntimeError("x"))
        bad = os.path.join(self._dir, "1700000000000-deadbeefdead.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("{ not json at all")

        with redirect_stderr(io.StringIO()) as err:
            entries = pending.iter_entries()

        self.assertEqual([p for p, _ in entries], [good])
        self.assertFalse(os.path.exists(bad), "no longer occupying a queue slot")
        self.assertEqual(pending.count(), 1, "no longer inflating the depth")
        self.assertIn("quarantined", err.getvalue())
        quarantined = os.path.join(
            os.path.dirname(self._dir.rstrip("/")), "pending-corrupt"
        )
        self.assertEqual(os.listdir(quarantined), [os.path.basename(bad)])

    def test_transient_read_error_is_skipped_not_quarantined(self):
        """An OSError is not evidence the payload is bad."""
        pending.enqueue(_payload(), RuntimeError("x"))
        real_open = open

        def flaky(path, *a, **kw):
            if str(path).endswith(".json"):
                raise OSError(11, "Resource temporarily unavailable")
            return real_open(path, *a, **kw)

        with unittest.mock.patch("builtins.open", flaky):
            self.assertEqual(pending.iter_entries(), [])
        self.assertEqual(pending.count(), 1, "entry left intact for the next pass")

    def test_healthy_enqueue_writes_no_drop_ledger(self):
        self.assertIsNotNone(pending.enqueue(_payload(), RuntimeError("x")))
        self.assertEqual(pending.read_drops(), {})
        self.assertFalse(os.path.exists(pending.drops_path()))


class BacklogDrainTest(_QueueTempDirMixin, unittest.TestCase):
    def _queue(self, n):
        """Queue ``n`` entries with POST-#3244 content-derived document_ids."""
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=_cd_doc(i)), RuntimeError("boom")
            )
        self.assertEqual(pending.count(), n)

    def test_session_start_drain_cannot_clear_a_backlog(self):
        """Regression witness for the BUG, not just for the fix.

        The in-hook drain clamps each entry to the remaining hook budget
        while the retain is synchronous, so the queue barely moves. That
        loop is what produced the backlog in the first place.
        """
        self._queue(20)
        os.environ["HINDSIGHT_DRAIN_BUDGET_S"] = "2"

        def slow_ok(entry, timeout):
            import time as _t

            _t.sleep(0.5)

        with unittest.mock.patch.object(drain_pending, "_retry_one", slow_ok):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: False
            ):
                summary = drain_pending.drain(CONFIG)

        self.assertTrue(summary["budget_exceeded"])
        self.assertLess(summary["drained"], 20)
        self.assertGreater(pending.count(), 0)

    # The path that ACTUALLY runs on every boot is the sequential drain, not
    # --backlog. Fixing the re-post loop only in the operator-invoked mode
    # would change nothing operationally: every agent boot would go on
    # re-POSTing its already-durable backlog exactly as before.
    def test_session_start_drain_reconciles_before_re_posting(self):
        self._queue(6)
        posted = []
        durable = {_cd_doc(i) for i in range(4)}

        def exists(entry, timeout=30):
            return entry["document_id"] in durable

        with unittest.mock.patch.object(drain_pending, "_document_state", exists):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", lambda e, timeout: posted.append(e["document_id"])
            ):
                summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["reconciled"], 4)
        self.assertEqual(
            sorted(posted),
            sorted([_cd_doc(4), _cd_doc(5)]),
            "already-durable entries must not be re-POSTed inside the hook",
        )
        self.assertEqual(pending.count(), 0)

    def test_session_start_reconcile_never_deletes_on_an_unknown_result(self):
        """Unknown must fall through to the retry, never to a delete."""
        self._queue(3)
        posted = []
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", lambda e, timeout: posted.append(e)
            ):
                summary = drain_pending.drain(CONFIG)
        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(len(posted), 3, "unknown falls through to the retry")

    def _stalled_upstream(self, budget, timeout):
        """Simulate an upstream that never answers, on a virtual clock.

        Every request consumes exactly the timeout it was given — the shape
        of a hung upstream, and the shape that made the fleet's 9s budget
        take 16.0s. The clock is virtual so the assertion is about the
        drain's arithmetic, not about how fast the test box happens to be.

        Returns ``(seen_get, seen_post, elapsed_fn, patch_contexts)``.
        """
        os.environ["HINDSIGHT_DRAIN_BUDGET_S"] = str(budget)
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = str(timeout)
        clock = {"t": 1000.0}
        start = clock["t"]
        seen_get, seen_post = [], []

        def fake_get(entry, timeout=30):
            seen_get.append(timeout)
            clock["t"] += timeout
            return False  # absent -> falls through to the POST

        def fake_post(entry, timeout):
            seen_post.append(timeout)
            clock["t"] += timeout
            raise TimeoutError("upstream never answered")

        ctx = (
            unittest.mock.patch.object(
                drain_pending.time, "monotonic", lambda: clock["t"]
            ),
            unittest.mock.patch.object(drain_pending, "_document_state", fake_get),
            unittest.mock.patch.object(drain_pending, "_retry_one", fake_post),
        )
        return seen_get, seen_post, (lambda: clock["t"] - start), ctx

    def test_the_per_entry_timeout_is_not_spent_twice(self):
        """One entry = one budget, not one per request.

        The clamp used to be computed ONCE per entry and then spent on the
        presence GET *and* the POST. With the fleet's own settings (budget
        9s, timeout 8s) that is 8 + 8 = 16.0s against a 9s hook budget,
        while the docstring promised an overshoot of at most the 1s clamp
        floor. The POST's timeout must be recomputed against what is left.
        """
        self._queue(1)
        seen_get, seen_post, elapsed, ctx = self._stalled_upstream(budget=9, timeout=8)
        with ctx[0], ctx[1], ctx[2]:
            drain_pending.drain(CONFIG)

        self.assertEqual(seen_get, [8], "the GET gets the full budgeted clamp")
        self.assertEqual(
            seen_post, [1], "the POST must re-clamp against the budget LEFT"
        )
        self.assertLessEqual(
            elapsed(),
            9,
            f"one entry outspent the whole 9s budget "
            f"(gets={seen_get} posts={seen_post})",
        )
        self.assertEqual(pending.count(), 1, "the failed entry stays queued")

    def test_session_start_reconcile_respects_the_hook_budget(self):
        """The GET must not be an extra call bolted onto an unchanged POST.

        Asserts against the BUDGET, with ``HINDSIGHT_DRAIN_TIMEOUT`` set
        explicitly high — the previous form asserted ``t <= 5`` while
        ``_per_entry_timeout()`` defaults to 5, so it held whether or not
        the clamp existed at all, and it never patched ``_retry_one``, so
        the GET+POST path it is named for never ran.
        """
        self._queue(10)
        budget = 9
        seen_get, seen_post, elapsed, ctx = self._stalled_upstream(
            budget=budget, timeout=300
        )
        with ctx[0], ctx[1], ctx[2]:
            summary = drain_pending.drain(CONFIG)

        self.assertTrue(seen_get and seen_post, "the GET+POST path must run")
        self.assertTrue(
            all(t <= budget for t in seen_get + seen_post),
            f"a single request outlived the whole budget: {seen_get} {seen_post}",
        )
        self.assertLessEqual(
            elapsed(),
            budget + 2,
            f"drain overshot the {budget}s hook budget by more than one "
            f"floored GET+POST (gets={seen_get} posts={seen_post})",
        )
        self.assertTrue(summary["budget_exceeded"])
        self.assertGreater(pending.count(), 0)

    def test_reconcile_phase_skips_already_durable_entries_without_posting(self):
        """The free pass: 70.4% of a measured fleet backlog was already
        durable. Re-POSTing those is duplicated LLM extraction for zero new
        memory; a GET costs nothing on the model pool."""
        self._queue(6)
        posted = []
        durable = {_cd_doc(i) for i in range(3)}

        def exists(entry, timeout=30):
            return entry["document_id"] in durable

        with unittest.mock.patch.object(drain_pending, "_document_state", exists):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", lambda e, timeout: posted.append(e)
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")

        self.assertEqual(summary["reconciled"], 3)
        self.assertEqual(posted, [], "reconcile must issue no retains at all")
        self.assertEqual(pending.count(), 3, "only absent documents remain queued")

    def test_reconcile_never_drops_an_entry_on_an_unknown_result(self):
        """Unknown != present. Guessing here deletes the last copy of a turn."""
        self._queue(3)
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: None
        ):
            with redirect_stderr(io.StringIO()):
                summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")
        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(summary["unknown"], 3)
        self.assertEqual(pending.count(), 3)

    def test_drain_confirms_the_document_before_deleting_the_entry(self):
        """Commit-before-delete: a 200 is an ack, not proof (#3244)."""
        self._queue(2)
        with unittest.mock.patch.object(drain_pending, "_retry_one", lambda e, timeout: None):
            # POST succeeds, but the document is still not there.
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: False
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["unknown"], 2)
        self.assertEqual(pending.count(), 2, "unconfirmed entries stay queued")

    def test_drain_never_retires_an_entry_on_an_unknown_result(self):
        """Unknown != confirmed, on the PHASE-2 path too (#3599 review R3-B1).

        The realistic shape: the POST returns 200, the confirming GET hits a
        503 or times out, so ``_document_state`` is ``None``. Counting that
        as durable archives the entry and it is never retried — a degraded
        upstream is exactly the condition this PR exists for. Mirrors
        ``test_reconcile_never_drops_an_entry_on_an_unknown_result``; its
        absence left ``is True`` at the phase-2 site mutable to
        ``is not False`` with both suites green.
        """
        self._queue(4)
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: None
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(summary["drained"], 0, "unknown is not a drain")
        self.assertEqual(summary["unknown"], 4)
        self.assertEqual(pending.count(), 4, "unconfirmed entries stay queued")

    def test_drain_deletes_once_the_document_is_confirmed(self):
        self._queue(5)
        with unittest.mock.patch.object(drain_pending, "_retry_one", lambda e, timeout: None):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")
        self.assertEqual(summary["drained"], 5)
        self.assertEqual(pending.count(), 0)

    def test_backlog_concurrency_defaults_to_one_lane(self):
        """The model pool is small and fleet-shared; width 4 consumes all
        of it, and 11 agents at width 4 is 44 lanes of demand against 4."""
        os.environ.pop("HINDSIGHT_DRAIN_CONCURRENCY", None)
        self.assertEqual(drain_pending._backlog_concurrency(), 1)
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "999"
        self.assertEqual(drain_pending._backlog_concurrency(), 16, "clamped")

    def test_backlog_uses_a_realistic_per_entry_timeout(self):
        """A 1-8s clamp guarantees a client timeout on a 30-90s sync retain
        that the server then commits anyway -- the root cause."""
        os.environ.pop("HINDSIGHT_DRAIN_BACKLOG_TIMEOUT", None)
        self.assertGreaterEqual(drain_pending._backlog_timeout(), 120)

        self._queue(2)
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "90"
        seen = []
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: seen.append(timeout)
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                with redirect_stderr(io.StringIO()):
                    drain_pending.drain_backlog(CONFIG, phase="drain")
        self.assertEqual(seen, [90, 90])

    def test_p95_backoff_pauses_the_drain(self):
        """Replay must never be the thing that trips the latency alarm."""
        self._queue(1)
        os.environ["HINDSIGHT_DRAIN_P95_BACKOFF_MS"] = "38000"
        probes = [90000, 90000, 10000]
        slept = []

        with unittest.mock.patch.object(
            drain_pending, "_p95_probe_ms", lambda: probes.pop(0)
        ):
            with unittest.mock.patch.object(drain_pending.time, "sleep", slept.append):
                with unittest.mock.patch.object(
                    drain_pending, "_retry_one", lambda e, timeout: None
                ):
                    with unittest.mock.patch.object(
                        drain_pending, "_document_state", lambda e, timeout=30: True
                    ):
                        with redirect_stderr(io.StringIO()) as err:
                            summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(slept.count(120), 2, "backed off until p95 recovered")
        self.assertIn("BACKOFF", err.getvalue())
        self.assertEqual(summary["drained"], 1)

    def test_p95_backoff_is_bounded_by_the_drain_budget(self):
        """A persistently slow upstream must not block past the budget.

        An unbounded `while True: sleep(120)` would run indefinitely, past
        the one guarantee this mode makes about how long it will run.
        """
        self._queue(2)
        os.environ["HINDSIGHT_DRAIN_BACKLOG_BUDGET_S"] = "60"
        slept = []

        with unittest.mock.patch.object(
            drain_pending, "_p95_probe_ms", lambda: 99000
        ):
            with unittest.mock.patch.object(drain_pending.time, "sleep", slept.append):
                with unittest.mock.patch.object(
                    drain_pending, "_retry_one", lambda e, timeout: None
                ):
                    with redirect_stderr(io.StringIO()) as err:
                        summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(slept, [], "60s budget cannot absorb a 120s pause")
        self.assertTrue(summary["budget_exceeded"])
        self.assertIn("budget is exhausted", err.getvalue())
        self.assertEqual(pending.count(), 2, "entries stay queued")

    def test_absent_p95_probe_does_not_block(self):
        os.environ.pop("HINDSIGHT_DRAIN_P95_CMD", None)
        self.assertEqual(drain_pending._p95_probe_ms(), -1)

    def test_stall_guard_does_not_overshoot_under_concurrency(self):
        """A wave of `width` identical timeouts must not age `width` entries.

        Recording failures for the whole wave before breaking would bump
        attempt_count on up to `width - 1` extra entries per wave, pushing
        them toward .dead FASTER than the sequential drain -- the opposite
        of this change's purpose.
        """
        self._queue(12)
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "4"

        def always_fail(entry, timeout):
            raise ConnectionError("upstream down")

        with unittest.mock.patch.object(drain_pending, "_retry_one", always_fail):
            with redirect_stderr(io.StringIO()):
                summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertTrue(summary["stalled"])
        self.assertEqual(
            summary["retried"],
            drain_pending.STALL_THRESHOLD,
            "exactly STALL_THRESHOLD entries aged, same as the sequential drain",
        )
        self.assertEqual(pending.count(), 12, "stalled entries stay queued")

    def _exhaust_attempts(self):
        """Queue one entry already sitting on the MAX_ATTEMPTS boundary."""
        self._queue(1)
        path, entry = pending.iter_entries()[0]
        entry["attempt_count"] = pending.MAX_ATTEMPTS
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entry, f)
        return path

    def _drain_failing_with(self, error):
        def always_fail(entry, timeout):
            raise error

        with unittest.mock.patch.object(drain_pending, "_retry_one", always_fail):
            with redirect_stderr(io.StringIO()):
                return drain_pending.drain_backlog(CONFIG, phase="drain")

    def test_backlog_ages_entries_toward_dead_like_the_sequential_drain(self):
        """A PERMANENT failure past MAX_ATTEMPTS still retires the entry."""
        path = self._exhaust_attempts()
        summary = self._drain_failing_with(
            RuntimeError('HTTP 400 from http://h/v1/x: {"detail":"bad payload"}')
        )

        self.assertEqual(summary["dead"], 1)
        # The marker lands in the pending-dead/ archive, NOT beside the live
        # entries -- see `pending.dead_dir`.
        self.assertTrue(os.path.exists(
            os.path.join(pending.dead_dir(), os.path.basename(path) + ".dead")))
        self.assertFalse(os.path.exists(path))
        self.assertFalse(os.path.exists(path + ".dead"))

    def test_extraction_500_past_max_attempts_never_kills_the_memory(self):
        """The regression this gate exists for.

        An HTTP 500 "Fact extraction failed … JSONDecodeError" means the
        extraction model returned an empty or non-JSON completion on THAT
        sampling run. The identical content persists fine on a later attempt,
        so exhausting the attempt budget on it must NOT retire the memory.
        Before the ``is_permanent_failure`` gate this drain produced
        ``dead=1`` and removed the queue entry.
        """
        path = self._exhaust_attempts()
        summary = self._drain_failing_with(
            RuntimeError(
                "HTTP 500 from http://h/v1/x: "
                '{"detail":"Fact extraction failed: 1/1 chunks failed. '
                "First failures: chunk 0: JSONDecodeError: Expecting value: "
                'line 1 column 1 (char 0)"}'
            )
        )

        self.assertEqual(summary["dead"], 0, "a 5xx must never retire a memory")
        self.assertEqual(summary["retried"], 1)
        self.assertFalse(os.path.exists(path + ".dead"))
        self.assertTrue(os.path.exists(path), "the queued memory survives")
        self.assertEqual(pending.count(), 1)

    def test_transient_transport_failure_past_max_attempts_stays_queued(self):
        """Timeouts / connection errors are transient too — never ``.dead``."""
        for error in (ConnectionError("upstream down"), TimeoutError("timed out")):
            with self.subTest(error=type(error).__name__):
                path = self._exhaust_attempts()
                summary = self._drain_failing_with(error)
                self.assertEqual(summary["dead"], 0)
                self.assertTrue(os.path.exists(path))
                os.unlink(path)

    def test_attempt_count_keeps_climbing_past_the_budget_on_transients(self):
        """The counter still records reality; only ``.dead`` is gated."""
        path = self._exhaust_attempts()
        self._drain_failing_with(ConnectionError("upstream down"))
        with open(path, encoding="utf-8") as f:
            entry = json.load(f)
        self.assertEqual(entry["attempt_count"], pending.MAX_ATTEMPTS + 1)

    def test_dry_run_issues_no_writes(self):
        self._queue(3)
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: True
        ):
            with redirect_stderr(io.StringIO()):
                summary = drain_pending.drain_backlog(
                    CONFIG, phase="reconcile", dry_run=True
                )
        self.assertEqual(summary["reconciled"], 3)
        self.assertEqual(pending.count(), 3, "a dry run must not delete anything")


class TransportFailureEndToEndTest(_QueueTempDirMixin, unittest.TestCase):
    """The permanence gate over the REAL client wrapping (#3669 follow-up).

    Every other permanence test injects a synthetic exception at
    ``drain_pending._retry_one`` — i.e. ABOVE ``lib/client.py``. That skips
    the layer which actually decides what a fault LOOKS like to
    ``pending.is_permanent_failure``: ``client._request`` catches only
    ``HTTPError`` and re-raises it as ``RuntimeError("HTTP {code} from …")``
    (lib/client.py:91-97), while a bare ``URLError`` propagates untouched.
    So the gate's input shape is produced there and asserted nowhere.

    These tests patch ``urllib.request.urlopen`` instead and drive the real
    drain, keeping that wrapping in the loop. #3669 added an equivalent
    end-to-end case, but to ``vendor/hindsight-memory/tests/`` — which no
    workflow discovers (ci-tests-python.yml runs ``unittest discover
    tests/`` from ``vendor/hindsight-memory/scripts``), so it never ran.
    """

    def _queue_one(self):
        pending.enqueue(_payload(content="turn-0", doc=_cd_doc(0)), RuntimeError("boom"))
        self.assertEqual(pending.count(), 1)

    def _exhaust_attempts(self):
        """One entry sitting on the MAX_ATTEMPTS boundary."""
        self._queue_one()
        path, entry = pending.iter_entries()[0]
        entry["attempt_count"] = pending.MAX_ATTEMPTS
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entry, f)
        return path

    @staticmethod
    def _http_error(code):
        def raise_it(*_a, **_kw):
            raise urllib.error.HTTPError(
                "http://127.0.0.1:9/none/v1/retain",
                code,
                "rejected",
                {},
                io.BytesIO(b'{"detail":"rejected"}'),
            )

        return raise_it

    def _drain_with_urlopen(self, side_effect):
        with unittest.mock.patch("urllib.request.urlopen", side_effect=side_effect):
            with redirect_stderr(io.StringIO()):
                return drain_pending.drain_backlog(CONFIG, phase="drain")

    def test_outage_past_max_attempts_keeps_the_memory(self):
        """A dead daemon raises bare ``URLError`` — no ``.code``, so transient.

        Before the gate this retired the entry at MAX_ATTEMPTS: an outage
        destroyed memory that was perfectly saveable.
        """
        path = self._exhaust_attempts()

        def down(*_a, **_kw):
            raise urllib.error.URLError("still down")

        summary = self._drain_with_urlopen(down)
        self.assertEqual(summary["dead"], 0, "an outage must never retire a memory")
        self.assertTrue(os.path.exists(path), "the queued memory survives")
        self.assertFalse(os.path.exists(path + ".dead"))

    def test_rate_limit_past_max_attempts_keeps_the_memory(self):
        """429 wears a 4xx code but is the most transient fault there is.

        This is the case the raw ``400 <= code < 500`` rule would get
        wrong, asserted through the real ``HTTP {code} from …`` wrapping.
        """
        path = self._exhaust_attempts()
        summary = self._drain_with_urlopen(self._http_error(429))
        self.assertEqual(summary["dead"], 0, "a rate limit must never retire a memory")
        self.assertTrue(os.path.exists(path))
        self.assertFalse(os.path.exists(path + ".dead"))

    def test_server_rejection_past_max_attempts_still_retires(self):
        """The other half of the gate: a fix that never retires is a leak.

        A positively-rejected payload must still age to ``.dead``, or the
        queue grows without bound.
        """
        path = self._exhaust_attempts()
        summary = self._drain_with_urlopen(self._http_error(400))
        self.assertEqual(summary["dead"], 1, "a 4xx rejection must still retire")
        self.assertTrue(os.path.exists(
            os.path.join(pending.dead_dir(), os.path.basename(path) + ".dead")))
        self.assertFalse(os.path.exists(path))
        self.assertFalse(os.path.exists(path + ".dead"))


class ArchiveFailureNeverDeletesTest(_QueueTempDirMixin, unittest.TestCase):
    """A failure to ARCHIVE is not a licence to DELETE (#3599 review R3-M1).

    The previous ``archive_reconciled`` fell back to ``delete_entry`` on
    ``OSError``. Reproduced: ENOSPC from ``os.makedirs`` removed the entry,
    left ``pending-reconciled/`` empty, and emitted nothing at all — silent,
    unrecorded, irreversible loss of the last on-disk copy of a turn. That
    falsified, verbatim, four separate claims (``drain_pending``'s module
    docstring, ``switchroom doctor``'s backlog fix text, the CHANGELOG, and
    the PR body). The claims are now true because the code is.
    """

    def _queue(self, n):
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=_cd_doc(i)), RuntimeError("boom")
            )
        self.assertEqual(pending.count(), n)

    @staticmethod
    def _enospc(*_a, **_kw):
        raise OSError(28, "No space left on device")

    def test_archive_reconciled_keeps_the_entry_when_the_archive_is_unwritable(self):
        self._queue(1)
        path = os.path.join(self._dir, self._names()[0])
        err = io.StringIO()
        with unittest.mock.patch.object(pending.os, "makedirs", self._enospc):
            with redirect_stderr(err):
                dest = pending.archive_reconciled(path)

        self.assertIsNone(dest, "a failed archive reports failure, not a dest")
        self.assertTrue(
            os.path.exists(path),
            "the entry is the ONLY on-disk copy of the turn; a full disk "
            "must not destroy it",
        )
        self.assertEqual(pending.count(), 1)
        self.assertEqual(self._reconciled_names(), [])

    def test_archive_failure_is_loud_on_stderr(self):
        """Silent loss was the worst part of the old behaviour. Even now
        that nothing is lost, an unwritable archive must be visible."""
        self._queue(1)
        path = os.path.join(self._dir, self._names()[0])
        err = io.StringIO()
        with unittest.mock.patch.object(pending.os, "makedirs", self._enospc):
            with redirect_stderr(err):
                pending.archive_reconciled(path)
        msg = err.getvalue()
        self.assertIn(os.path.basename(path), msg)
        self.assertIn("No space left on device", msg)
        self.assertRegex(msg, r"STAYS QUEUED")

    def test_the_queue_module_exposes_no_delete_primitive(self):
        """Structural, not aspirational: with no ``delete_entry`` there is
        no branch by which the drain path can ``os.remove`` a live entry."""
        self.assertFalse(
            hasattr(pending, "delete_entry"),
            "re-adding a delete primitive re-opens the silent-loss path",
        )

    def test_backlog_drain_counts_an_unarchivable_entry_as_not_retired(self):
        """The summary must not claim a retire that did not happen: the
        entry is still queued, so ``drained`` would be a lie."""
        self._queue(3)
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                with unittest.mock.patch.object(
                    pending.os, "makedirs", self._enospc
                ):
                    with redirect_stderr(io.StringIO()):
                        summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["archive_failed"], 3)
        self.assertEqual(pending.count(), 3, "every entry survives a full disk")

    def test_reconcile_phase_counts_an_unarchivable_entry_as_not_retired(self):
        self._queue(3)
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: True
        ):
            with unittest.mock.patch.object(pending.os, "makedirs", self._enospc):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")

        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(summary["archive_failed"], 3)
        self.assertEqual(pending.count(), 3)

    def test_in_hook_drain_keeps_an_unarchivable_entry(self):
        """The bounded SessionStart path retires on its POST's own
        commit-before-ack 200 (``async_processing=False``, no confirming
        GET) and is the one most likely to run on a nearly-full container
        filesystem."""
        self._queue(2)
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: False
            ):
                with unittest.mock.patch.object(
                    pending.os, "makedirs", self._enospc
                ):
                    with redirect_stderr(io.StringIO()):
                        summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["archive_failed"], 2)
        self.assertEqual(pending.count(), 2)


class PresenceReconcileGateTest(_QueueTempDirMixin, unittest.TestCase):
    """A presence GET may only retire an entry whose id proves ITS content.

    Post-#3244 (`retain.slice_document_id`) the id is
    ``{session}-r{start_uuid}-{end_uuid}`` — a function of which turns the
    entry carries, so a 200 proves this content was committed. A pre-#3244
    entry carries a BARE SESSION ID, for which the bank answers 200 after
    ANY successful retain in that session. Reconciling on that deletes a
    turn that was never committed. Confirmed against a live 525 KB entry on
    this fleet whose ``document_id`` is a bare uuid and whose GET returns
    200.
    """

    BARE_SESSION_ID = "d52ae253-2d26-42e5-a86b-9a354cc0ace5"

    def test_the_id_shape_predicate_separates_the_two_generations(self):
        self.assertTrue(pending.is_content_derived_document_id(_cd_doc(1)))
        # sha256 fallback for uuid-less legacy transcripts
        self.assertTrue(
            pending.is_content_derived_document_id(f"{SESSION}-r" + "a1" * 16)
        )
        # sub-agent namespace reuses the same recipe
        self.assertTrue(
            pending.is_content_derived_document_id(
                f"{SESSION}-sub-worker7-r{_uuid(1)}-{_uuid(2)}"
            )
        )
        for bad in (
            self.BARE_SESSION_ID,
            "conversation",
            "",
            None,
            123,
            f"{SESSION}-r{_uuid(1)}",  # only one uuid: not the slice shape
        ):
            self.assertFalse(
                pending.is_content_derived_document_id(bad), f"must not accept {bad!r}"
            )

    def test_a_split_part_inherits_the_verdict_of_its_core_id(self):
        """#3610's part ids must stay inside #3599's free reconcile.

        The gate is anchored at the end of the id, so ``-p{i}of{n}`` would
        otherwise push EVERY split part outside it — and split parts are, by
        construction, the largest and most expensive entries in the queue.
        Each would take a full re-POST on every drain instead of a sub-second
        presence GET: the re-post loop #3599 fixed, aimed at the worst case.

        The suffix must not rescue a pre-#3244 id, which is the whole point
        of the gate, so both directions are asserted here.
        """
        core = _cd_doc(1)
        for total in (2, 5, 12, 249):
            for index in range(min(total, 3)):
                part = retain_split.part_document_id(core, index, total)
                self.assertTrue(
                    pending.is_content_derived_document_id(part),
                    f"a split part of a content-derived id is content-derived: {part!r}",
                )
        # sha256 fallback core, and the sub-agent namespace, split too
        self.assertTrue(
            pending.is_content_derived_document_id(f"{SESSION}-r" + "a1" * 16 + "-p1of3")
        )
        self.assertTrue(
            pending.is_content_derived_document_id(
                f"{SESSION}-sub-worker7-r{_uuid(1)}-{_uuid(2)}-p2of4"
            )
        )
        # A part re-split under a lowered bound nests its suffix, and is still
        # a pure function of content.
        self.assertTrue(
            pending.is_content_derived_document_id(
                retain_split.part_document_id(
                    retain_split.part_document_id(core, 1, 5), 0, 2
                )
            )
        )
        # A part suffix on a PRE-#3244 id still proves nothing.
        for bad in (
            f"{self.BARE_SESSION_ID}-p1of3",
            "conversation-p2of2",
            f"{SESSION}-r{_uuid(1)}-p1of2",  # only one uuid: not the slice shape
            f"{core}-pXofY",  # not the emitted suffix shape
            f"{core}-p1of2-trailing",  # suffix must be terminal
        ):
            self.assertFalse(
                pending.is_content_derived_document_id(bad), f"must not accept {bad!r}"
            )

    def _queue_bare(self, n=2):
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=self.BARE_SESSION_ID),
                RuntimeError("boom"),
            )

    def test_a_bare_session_id_is_never_reconciled_on_presence_alone(self):
        """The bug: a 200 for the session deletes an uncommitted turn."""
        self._queue_bare(2)
        posted = []

        def post_fails(entry, timeout):
            posted.append(entry)
            raise TimeoutError("upstream slow")

        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: True
        ):
            with unittest.mock.patch.object(drain_pending, "_retry_one", post_fails):
                summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["reconciled"], 0, "presence alone proves nothing here")
        self.assertEqual(len(posted), 2, "such entries must go to the POST instead")
        self.assertEqual(pending.count(), 2, "and stay queued when the POST fails")
        self.assertEqual(
            self._reconciled_names(),
            [],
            "nothing may be retired by the reconcile path on a bare session id",
        )

    def test_backlog_reconcile_phase_also_refuses_a_bare_session_id(self):
        self._queue_bare(2)
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: True
        ):
            with redirect_stderr(io.StringIO()) as err:
                summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")

        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(pending.count(), 2, "left for phase 2, which can make them durable")
        self.assertIn("pre-#3244", err.getvalue())

    def test_reconciled_entries_are_archived_not_deleted(self):
        """The out-of-band tooling this design was ported from ARCHIVES.

        Every retire decision rests on a 200, and a 200 is evidence, not
        proof (#3244). An irreversible ``os.remove`` on evidence is how the
        last on-disk copy of a turn disappears; ``pending-reconciled/`` is
        recoverable and bounded.
        """
        pending.enqueue(_payload(doc=_cd_doc(7)), RuntimeError("x"))
        name = self._names()[0]
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: True
        ):
            summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["reconciled"], 1)
        self.assertEqual(pending.count(), 0, "no longer queued")
        self.assertEqual(self._reconciled_names(), [name], "payload is recoverable")

    def test_a_successful_in_hook_retain_also_archives_rather_than_deletes(self):
        """One durability rule on one path.

        The in-hook success path retires on its POST's own 200 (a
        commit-before-ack, see the test below — NOT a bare async ack, as
        this docstring used to say) while the backlog path additionally
        re-GETs. Archiving both makes the weaker evidence cost a
        recoverable file rather than a lost turn.
        """
        pending.enqueue(_payload(doc=self.BARE_SESSION_ID), RuntimeError("x"))
        name = self._names()[0]
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: None
        ):
            summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["drained"], 1)
        self.assertEqual(pending.count(), 0)
        self.assertEqual(self._reconciled_names(), [name])

    def test_the_in_hook_success_path_commits_synchronously_and_never_re_gets(
        self,
    ):
        """The evidence the in-hook retire ACTUALLY rests on (#3599 R4-B3).

        ``pending._trim_dir``'s cap justification names this population by
        hand — "retires on the POST's own 200 with no confirming GET, and
        that 200 is a commit-before-ack" — so both halves are pinned here
        rather than left as prose. Nothing else in the suite fails if the
        in-hook path goes back to ``async_processing=True`` (making the 200
        a bare ack, which is what the old comment claimed it already was)
        or starts issuing a confirming re-GET it has no hook budget for.

        The event log is ordered on purpose: ONE presence GET *before* the
        POST is the reconcile free pass; the assertion is that nothing
        follows the POST.
        """
        pending.enqueue(_payload(doc=_cd_doc(42)), RuntimeError("x"))
        events = []

        def fake_state(entry, timeout=30):
            events.append("GET")
            return False  # absent → fall through to the POST

        class _Client:
            def __init__(self, *_a, **_kw):
                pass

            def retain(self, **kw):
                events.append(("POST", kw.get("async_processing")))
                return {}

        with unittest.mock.patch.object(drain_pending, "HindsightClient", _Client):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", fake_state
            ):
                summary = drain_pending.drain(CONFIG)

        self.assertEqual(summary["drained"], 1)
        self.assertEqual(
            events,
            ["GET", ("POST", False)],
            "one presence GET before the POST, a SYNCHRONOUS post, and no "
            "confirming GET after it",
        )
        self.assertEqual(len(self._reconciled_names()), 1)

    def test_the_backlog_confirmed_drain_archives_too(self):
        pending.enqueue(_payload(doc=_cd_doc(3)), RuntimeError("x"))
        name = self._names()[0]
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", lambda e, timeout: None
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")
        self.assertEqual(summary["drained"], 1)
        self.assertEqual(self._reconciled_names(), [name])

    def test_the_reconciled_archive_is_bounded_and_sheds_oldest_first(self):
        """An unbounded archive is just a slower disk problem."""
        prev = pending.RECONCILED_MAX_ENTRIES
        pending.RECONCILED_MAX_ENTRIES = 2
        try:
            clock = iter(1000.0 + i for i in range(20))
            with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
                for i in range(5):
                    pending.enqueue(
                        _payload(content=f"c{i}", doc=_cd_doc(i)), RuntimeError("x")
                    )
            queued = self._names()
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                drain_pending.drain(CONFIG)
            self.assertEqual(
                self._reconciled_names(),
                queued[-2:],
                "the archive keeps the NEWEST retirements, trimming oldest-first",
            )
        finally:
            pending.RECONCILED_MAX_ENTRIES = prev

    def test_an_unwritable_archive_keeps_the_entry_rather_than_deleting_it(self):
        """REVERSED from the original assertion, deliberately (#3599 R3-M1).

        This case used to assert ``pending.count() == 0`` — i.e. that a
        failed archive deleted the entry — on the reasoning that a queue
        which cannot retire re-POSTs forever. That trade is backwards: the
        re-POST loop costs duplicated LLM extraction on a disk-full box,
        and the delete costs the last on-disk copy of the turn, silently.
        Sheds the cheaper failure; ``archive_failed`` keeps the summary
        honest about the entry still being queued.
        """
        pending.enqueue(_payload(doc=_cd_doc(9)), RuntimeError("x"))
        with unittest.mock.patch.object(
            pending.shutil, "move", side_effect=OSError(28, "No space left")
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                with redirect_stderr(io.StringIO()) as err:
                    summary = drain_pending.drain(CONFIG)
        self.assertEqual(summary["reconciled"], 0, "nothing was retired")
        self.assertEqual(summary["archive_failed"], 1)
        self.assertEqual(pending.count(), 1, "the only copy of the turn survives")
        self.assertIn("No space left", err.getvalue())


class TrimDirBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """``_trim_dir``'s caps, at the boundary (#3599 review R3-L2).

    A separate site from the enqueue cap in ``_evict_to_fit`` (pinned by
    ``EvictionTest``): ``>`` → ``>=`` here survived the whole sweep. Off by
    one in this direction sheds one archived copy on every call forever,
    including on a directory that is exactly at its cap.
    """

    def _archive(self, sizes):
        """Write ``len(sizes)`` archive files of the given byte sizes."""
        d = os.path.join(self._tmp, "arch")
        os.makedirs(d, exist_ok=True)
        for i, n in enumerate(sizes):
            with open(os.path.join(d, f"{1000 + i:013d}-x.json"), "w") as f:
                f.write("x" * n)
        return d

    def _names_in(self, d):
        return sorted(n for n in os.listdir(d) if n.endswith(".json"))

    def test_exactly_at_the_byte_cap_is_within_it(self):
        d = self._archive([10, 10, 10])
        with redirect_stderr(io.StringIO()) as err:
            dropped = pending._trim_dir(d, max_entries=99, max_bytes=30)
        self.assertEqual(dropped, 0, "30 bytes under a 30-byte cap fits")
        self.assertEqual(len(self._names_in(d)), 3)
        self.assertEqual(err.getvalue(), "", "nothing dropped, nothing logged")

    def test_one_byte_over_the_cap_sheds_the_oldest_only(self):
        d = self._archive([10, 10, 11])
        with redirect_stderr(io.StringIO()):
            dropped = pending._trim_dir(d, max_entries=99, max_bytes=30)
        self.assertEqual(dropped, 1)
        self.assertEqual(
            self._names_in(d),
            [f"{1001:013d}-x.json", f"{1002:013d}-x.json"],
            "oldest first — the newest archived copy is the one worth keeping",
        )

    def test_exactly_at_the_count_cap_is_within_it(self):
        d = self._archive([1, 1, 1])
        self.assertEqual(pending._trim_dir(d, max_entries=3, max_bytes=10**9), 0)
        self.assertEqual(len(self._names_in(d)), 3)

    def test_one_over_the_count_cap_sheds_exactly_one(self):
        d = self._archive([1, 1, 1, 1])
        with redirect_stderr(io.StringIO()):
            self.assertEqual(pending._trim_dir(d, max_entries=3, max_bytes=10**9), 1)
        self.assertEqual(len(self._names_in(d)), 3)

    def test_a_trim_names_what_it_dropped_on_stderr(self):
        """The archive caps are 4x smaller than the queue caps, so a
        full-queue drain trims. Silent trimming makes "archived, never
        deleted" a half-truth; the log line is the other half."""
        d = self._archive([1] * 6)
        with redirect_stderr(io.StringIO()) as err:
            pending._trim_dir(d, max_entries=2, max_bytes=10**9)
        msg = err.getvalue()
        self.assertIn("trimmed 4 archived copies", msg)
        self.assertIn(f"{1000:013d}-x.json", msg, "names the oldest dropped")
        self.assertIn("arch", msg, "names the directory")

    def test_exactly_ten_dropped_names_are_all_listed(self):
        """The name list truncates ABOVE ten, not at ten.

        ``len(dropped) > 10`` vs ``>=`` differ only on a trim of exactly
        ten, where the mutant appends a nonsense "+0 more".
        """
        d = self._archive([1] * 12)
        with redirect_stderr(io.StringIO()) as err:
            pending._trim_dir(d, max_entries=2, max_bytes=10**9)
        msg = err.getvalue()
        self.assertIn("trimmed 10 archived copies", msg)
        self.assertNotIn("more", msg, "ten names fit; there is no remainder")
        self.assertEqual(msg.count("-x.json"), 10)

    def test_eleven_dropped_names_truncate_to_ten_plus_a_remainder(self):
        d = self._archive([1] * 13)
        with redirect_stderr(io.StringIO()) as err:
            pending._trim_dir(d, max_entries=2, max_bytes=10**9)
        msg = err.getvalue()
        self.assertIn("trimmed 11 archived copies", msg)
        self.assertIn("+1 more", msg)
        self.assertEqual(msg.count("-x.json"), 10)

    def test_a_large_trim_caps_the_name_list(self):
        """A 1500-entry trim must not emit a 1500-name line."""
        d = self._archive([1] * 20)
        with redirect_stderr(io.StringIO()) as err:
            pending._trim_dir(d, max_entries=2, max_bytes=10**9)
        msg = err.getvalue()
        self.assertIn("trimmed 18 archived copies", msg)
        self.assertIn("+8 more", msg)
        self.assertLessEqual(msg.count("-x.json"), 10)


class ClampAndEnvKnobBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """``_clamp``'s floor and ``_env_num``'s clamps (#3599 review R3-L4)."""

    def test_clamp_floors_at_one_second_never_zero(self):
        """A 0s timeout fails instantly, turning a near-exhausted budget
        into a guaranteed failure rather than one last bounded shot."""
        started = time.monotonic()
        # Budget already fully spent: remaining <= 0.
        self.assertEqual(drain_pending._clamp(8, budget=0.0, started=started), 1)
        # Remaining just under the floor.
        self.assertEqual(drain_pending._clamp(8, budget=0.9, started=started), 1)

    def test_the_per_entry_timeout_is_floored_at_one_second(self):
        """The invariant ``_clamp``'s equivalence proof rests on (R4-Lb).

        ``_clamp``'s docstring argues its own ``max(1, ...)`` mutants are
        equivalent. They are — but only while ``timeout >= 1``: with
        ``timeout == 0`` and a healthy budget, ``max(0, min(0, n))`` returns
        0, an instant-fail request on every entry. Nothing in ``_clamp``
        rules that input out; ``_per_entry_timeout``'s floor does, and it is
        the ONLY thing that does, because ``drain`` takes its ``timeout``
        from here and passes it to both ``_clamp`` callsites. So the proof
        lives in one function and its precondition lives in another — pin
        the precondition, or the proof rots the day someone "simplifies"
        this ``max``.
        """
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "0"
        self.assertEqual(drain_pending._per_entry_timeout(), 1)
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "-30"
        self.assertEqual(drain_pending._per_entry_timeout(), 1)
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "garbage"
        self.assertEqual(drain_pending._per_entry_timeout(), 5, "default on junk")
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "9"
        self.assertEqual(drain_pending._per_entry_timeout(), 9, "a real value passes")

        # And the consequence the floor buys, stated at the clamp: the
        # smallest timeout _clamp can ever be handed still yields a
        # non-zero, bounded request.
        started = time.monotonic()
        self.assertEqual(
            drain_pending._clamp(
                drain_pending._per_entry_timeout(), budget=100.0, started=started
            ),
            9,
        )
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "0"
        self.assertEqual(
            drain_pending._clamp(
                drain_pending._per_entry_timeout(), budget=100.0, started=started
            ),
            1,
            "a 0s knob must not reach urlopen as a 0s timeout",
        )

    def test_clamp_hands_out_the_remaining_budget_once_past_the_floor(self):
        started = time.monotonic()
        self.assertEqual(drain_pending._clamp(8, budget=3.9, started=started), 3)
        self.assertEqual(
            drain_pending._clamp(2, budget=100.0, started=started),
            2,
            "the caller's timeout still wins when the budget is ample",
        )

    def test_env_num_lo_clamp_raises_a_too_small_value(self):
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "0"
        self.assertEqual(
            drain_pending._backlog_timeout(), 1, "lo=1 must raise 0 to 1"
        )
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "-5"
        self.assertEqual(drain_pending._backlog_timeout(), 1)

    def test_env_num_lo_is_inclusive_and_leaves_larger_values_alone(self):
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "1"
        self.assertEqual(drain_pending._backlog_timeout(), 1)
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "45"
        self.assertEqual(drain_pending._backlog_timeout(), 45)

    def test_env_num_hi_clamp_lowers_a_too_large_value(self):
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "17"
        self.assertEqual(drain_pending._backlog_concurrency(), 16)
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "16"
        self.assertEqual(drain_pending._backlog_concurrency(), 16)

    def test_env_num_falls_back_to_the_default_on_garbage(self):
        default = int(retain_split.retain_client_deadline())
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "not-a-number"
        self.assertEqual(drain_pending._backlog_timeout(), default)
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = ""
        self.assertEqual(
            drain_pending._backlog_timeout(), default, "empty is unset, not 0"
        )

    def test_the_backlog_timeout_defaults_to_the_retain_client_deadline(self):
        """The drain deadline and the content bound are ONE number (#3610).

        A maximally-sized part is sized to just fit inside
        ``retain_client_deadline()``. If the drainer's own deadline were
        shorter — as the ``180`` literal #3599 shipped was — it would abandon a
        correctly-sized part mid-extraction, leave the entry queued, and
        rebuild the re-post loop #3599 fixed. Moving the deadline must move
        both, so this asserts the derivation, not the number.
        """
        os.environ.pop("HINDSIGHT_DRAIN_BACKLOG_TIMEOUT", None)
        os.environ.pop("HINDSIGHT_RETAIN_CLIENT_DEADLINE_S", None)
        # Assert the DERIVATION, per this test's own docstring: the drain
        # deadline is retain_client_deadline(), whatever that currently is.
        # It was pinned to the literal 280 here, which meant the test went
        # stale the moment the deadline became derived from the litellm
        # routing chain (280 -> 310) instead of being hand-set.
        self.assertEqual(
            drain_pending._backlog_timeout(),
            int(retain_split.retain_client_deadline()),
        )

        os.environ["HINDSIGHT_RETAIN_CLIENT_DEADLINE_S"] = "600"
        try:
            self.assertEqual(
                drain_pending._backlog_timeout(),
                600,
                "moving the client deadline must move the drain deadline",
            )
            self.assertEqual(
                retain_split.retain_content_limit(),
                # Same input, less the #3693 safety fraction: the bound is a
                # FRACTION of the deadline, not all of it, so a maximally-sized
                # part still has headroom when the drain waits exactly 600s.
                3000 * int((600 * retain_split.retain_deadline_safety()) // 18.4),
                "and the content bound, from the same input",
            )
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_CLIENT_DEADLINE_S", None)

    def test_an_explicit_backlog_timeout_still_overrides_the_derivation(self):
        os.environ["HINDSIGHT_RETAIN_CLIENT_DEADLINE_S"] = "600"
        os.environ["HINDSIGHT_DRAIN_BACKLOG_TIMEOUT"] = "42"
        try:
            self.assertEqual(drain_pending._backlog_timeout(), 42)
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_CLIENT_DEADLINE_S", None)

    def test_no_clamp_is_applied_when_lo_and_hi_are_absent(self):
        """``lo``/``hi`` default to ``None``; that branch must be a no-op,
        not an accidental floor at 0."""
        os.environ["X_TEST_KNOB"] = "-42"
        try:
            self.assertEqual(
                drain_pending._env_num("X_TEST_KNOB", 1, int), -42
            )
        finally:
            os.environ.pop("X_TEST_KNOB", None)


class P95ProbeTest(_QueueTempDirMixin, unittest.TestCase):
    """A configured-but-broken probe is not the same as an unset one."""

    def test_a_failing_probe_is_not_read_as_a_latency_figure(self):
        """Exit status was ignored, so a typo'd probe's stdout was trusted."""
        os.environ["HINDSIGHT_DRAIN_P95_CMD"] = "echo 12345; exit 3"
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(drain_pending._p95_probe_ms(), -1)
        self.assertIn("exited 3", err.getvalue())
        self.assertIn("DISABLED", err.getvalue())

    def test_a_probe_that_prints_nothing_says_so(self):
        os.environ["HINDSIGHT_DRAIN_P95_CMD"] = "true"
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(drain_pending._p95_probe_ms(), -1)
        self.assertIn("DISABLED", err.getvalue())

    def test_a_healthy_probe_is_read_silently(self):
        os.environ["HINDSIGHT_DRAIN_P95_CMD"] = "echo 41000"
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(drain_pending._p95_probe_ms(), 41000)
        self.assertEqual(err.getvalue(), "")


class CliTest(unittest.TestCase):
    """A membership test on argv silently ran the WRONG drain on a typo."""

    def _run(self, argv):
        seen = {}

        def fake_drain(
            config=None, backlog=False, phase="both", dry_run=False, force=False
        ):
            seen.update(backlog=backlog, phase=phase, dry_run=dry_run, force=force)
            return drain_pending._new_summary()

        with unittest.mock.patch.object(drain_pending, "drain", fake_drain):
            with unittest.mock.patch.object(drain_pending, "load_config", lambda: {}):
                rc = drain_pending.main(argv)
        return rc, seen

    def test_backlog_flag_selects_backlog_mode(self):
        _, seen = self._run(["--backlog"])
        self.assertTrue(seen["backlog"])
        _, seen = self._run([])
        self.assertFalse(seen["backlog"])

    def test_typo_is_rejected_rather_than_silently_running_the_hook_drain(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                self._run(["--backlogg"])
        self.assertNotEqual(cm.exception.code, 0)

    def test_phase_and_dry_run_are_plumbed(self):
        _, seen = self._run(["--backlog", "--phase", "reconcile", "--dry-run"])
        self.assertEqual(seen["phase"], "reconcile")
        self.assertTrue(seen["dry_run"])

    def test_force_is_plumbed_and_defaults_off(self):
        # `--force` overrides the circuit breaker. Parsed-but-dropped would
        # leave the operator's explicit "retry the parked entries" silently
        # doing nothing, which is exactly the class of bug this file exists
        # for (a flag accepted and ignored).
        _, seen = self._run(["--backlog", "--force"])
        self.assertTrue(seen["force"])
        _, seen = self._run(["--backlog"])
        self.assertFalse(seen["force"])

    def test_phase_without_backlog_is_refused(self):
        with redirect_stderr(io.StringIO()):
            rc, _ = self._run(["--phase", "reconcile"])
        self.assertEqual(rc, 2)


class StallGuardBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """The stall guard counts CONSECUTIVE failures of the SAME class.

    Every prior stall test drove a homogeneous error stream, which cannot
    tell ``err_class == last_error_class`` from ``!=``: with one class the
    mutant takes the increment branch every time and the reset branch is
    never reached, so the drain stalls identically. Distinguishing them
    needs an ALTERNATING stream, where the real guard resets and the
    mutant stalls. Same false-green shape as Blocker 1 — the assertion
    exercised the code without pinning the invariant.
    """

    def _queue(self, n):
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=_cd_doc(i)), RuntimeError("boom")
            )
        self.assertEqual(pending.count(), n)

    def _alternating(self):
        """A failure stream whose error CLASS changes every entry."""
        classes = [ConnectionError, TimeoutError]
        n = {"i": 0}

        def fail(entry, timeout):
            cls = classes[n["i"] % 2]
            n["i"] += 1
            raise cls("upstream flapping")

        return fail

    def test_alternating_error_classes_never_stall_the_drain(self):
        self._queue(6)
        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: False
        ):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", self._alternating()
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain(CONFIG)

        self.assertFalse(
            summary["stalled"],
            "a flapping upstream is not a stall — the counter must RESET "
            "when the error class changes",
        )
        self.assertEqual(summary["retried"], 6, "every entry got its attempt")
        self.assertEqual(pending.count(), 6, "failed entries stay queued")

    def test_alternating_error_classes_never_stall_the_backlog_drain(self):
        self._queue(6)
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "1"
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", self._alternating()
        ):
            with redirect_stderr(io.StringIO()):
                summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertFalse(summary["stalled"])
        self.assertEqual(summary["retried"], 6)
        self.assertEqual(pending.count(), 6)

    def test_the_drain_stalls_at_exactly_stall_threshold(self):
        """AT the threshold, not one past it.

        Queueing exactly ``STALL_THRESHOLD`` entries is what separates
        ``>=`` from ``>``: with ``>`` the run ends by exhausting the queue
        and reports no stall at all.
        """
        self._queue(drain_pending.STALL_THRESHOLD)

        def always_fail(entry, timeout):
            raise ConnectionError("upstream down")

        with unittest.mock.patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: False
        ):
            with unittest.mock.patch.object(drain_pending, "_retry_one", always_fail):
                with redirect_stderr(io.StringIO()) as err:
                    summary = drain_pending.drain(CONFIG)

        self.assertTrue(summary["stalled"])
        self.assertIn("stalling drain", err.getvalue())
        self.assertEqual(pending.count(), drain_pending.STALL_THRESHOLD)


class BudgetBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """The budget is spent DOWN TO the tick, not one tick short.

    ``elapsed > budget`` vs ``>=`` is invisible to every wall-clock test
    (real elapsed never lands exactly on the budget), so both loops are
    driven here on a virtual clock that lands on it exactly.
    """

    def _queue(self, n):
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=_cd_doc(i)), RuntimeError("boom")
            )

    def test_the_sequential_drain_uses_the_last_tick_of_its_budget(self):
        self._queue(2)
        os.environ["HINDSIGHT_DRAIN_BUDGET_S"] = "10"
        os.environ["HINDSIGHT_DRAIN_TIMEOUT"] = "10"
        start = 1000.0
        clock = {"t": start}
        gets = []

        def fake_get(entry, timeout=30):
            gets.append(timeout)
            clock["t"] = start + 10.0  # entry 1 consumes the budget EXACTLY
            return True

        with unittest.mock.patch.object(
            drain_pending.time, "monotonic", lambda: clock["t"]
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", fake_get
            ):
                summary = drain_pending.drain(CONFIG)

        self.assertEqual(len(gets), 2, "entry 2 is still inside the budget at t==B")
        self.assertEqual(summary["reconciled"], 2)
        self.assertFalse(summary["budget_exceeded"])
        self.assertEqual(pending.count(), 0)

    def test_the_backlog_wave_loop_uses_the_last_tick_of_its_budget(self):
        self._queue(2)
        os.environ["HINDSIGHT_DRAIN_BACKLOG_BUDGET_S"] = "10"
        os.environ["HINDSIGHT_DRAIN_CONCURRENCY"] = "1"
        # Keep _wait_for_upstream off the clock; its own boundary is pinned
        # by WaitForUpstreamBoundaryTest.
        os.environ["HINDSIGHT_DRAIN_P95_BACKOFF_MS"] = "0"
        start = 1000.0
        clock = {"t": start}

        def fake_post(entry, timeout):
            clock["t"] = start + 10.0  # wave 1 consumes the budget EXACTLY

        with unittest.mock.patch.object(
            drain_pending.time, "monotonic", lambda: clock["t"]
        ):
            with unittest.mock.patch.object(drain_pending, "_retry_one", fake_post):
                with unittest.mock.patch.object(
                    drain_pending, "_document_state", lambda e, timeout=30: True
                ):
                    with redirect_stderr(io.StringIO()):
                        summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(summary["drained"], 2, "wave 2 starts at exactly t==B")
        self.assertFalse(summary["budget_exceeded"])
        self.assertEqual(pending.count(), 0)


class WaitForUpstreamBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """``_wait_for_upstream`` called directly — its three comparisons.

    Driving it through ``drain_backlog`` only ever exercised the
    disabled/slow/recovered cases; the boundaries below all survived a
    mutation sweep because no test pinned them.
    """

    def _wait(self, backoff_ms, probes, now=1000.0, started=1000.0, budget=3600.0):
        slept = []
        seq = list(probes)
        with unittest.mock.patch.object(
            drain_pending.time, "monotonic", lambda: now
        ):
            with unittest.mock.patch.object(
                drain_pending, "_p95_probe_ms", lambda: seq.pop(0)
            ):
                with unittest.mock.patch.object(
                    drain_pending.time, "sleep", slept.append
                ):
                    with redirect_stderr(io.StringIO()) as err:
                        got = drain_pending._wait_for_upstream(
                            backoff_ms, started, budget
                        )
        return got, slept, err.getvalue()

    def test_backoff_disabled_never_pauses_even_when_the_probe_says_slow(self):
        """``backoff_ms <= 0`` means OFF — the probe is not consulted.

        With ``<`` instead of ``<=``, a 0 (explicitly disabled) falls into
        the wait loop and a configured probe reporting 99s of p95 pauses
        the drain for two minutes a wave. Disabled must mean disabled.
        """
        got, slept, _ = self._wait(0, [99000, 99000, 99000])
        self.assertTrue(got)
        self.assertEqual(slept, [], "a disabled backoff must never sleep")

    def test_a_p95_exactly_at_the_threshold_is_not_slow(self):
        """The knob is the tolerated ceiling, inclusive."""
        got, slept, out = self._wait(38000, [38000])
        self.assertTrue(got)
        self.assertEqual(slept, [])
        self.assertNotIn("BACKOFF", out)

    def test_one_ms_over_the_threshold_is_slow(self):
        got, slept, out = self._wait(38000, [38001, 38000])
        self.assertTrue(got)
        self.assertEqual(slept, [120], "paused once, then p95 came back in")
        self.assertIn("BACKOFF", out)

    def test_it_still_waits_when_the_pause_exactly_fits_the_budget(self):
        """120s of pause with exactly 120s left is affordable, not a give-up.

        ``elapsed + 120 > budget`` vs ``>=``: only a clock that lands
        exactly on the budget separates them, so this one is virtual.
        """
        got, slept, out = self._wait(
            38000, [99000, 1000], now=1120.0, started=1000.0, budget=240.0
        )
        self.assertTrue(got, "the wait fit the budget, so it must be taken")
        self.assertEqual(slept, [120])
        self.assertNotIn("budget is exhausted", out)

    def test_it_gives_up_when_the_pause_would_overrun_the_budget(self):
        got, slept, out = self._wait(
            38000, [99000], now=1121.0, started=1000.0, budget=240.0
        )
        self.assertFalse(got)
        self.assertEqual(slept, [])
        self.assertIn("budget is exhausted", out)

    def test_a_zero_p95_is_fast_not_unknown(self):
        """``p95 < 0`` is the UNKNOWN sentinel; 0 is a real, fast reading.

        (``< 0`` vs ``<= 0`` is an equivalent mutant here — a 0 reading
        returns True down either branch, since it is also ``<= backoff_ms``
        for any enabled backoff. Pinned anyway: the OUTCOME is what the
        drain depends on, and it must not become a pause.)
        """
        got, slept, _ = self._wait(38000, [0])
        self.assertTrue(got)
        self.assertEqual(slept, [])


class ClipErrorBoundaryTest(unittest.TestCase):
    """``_clip_error`` clips ABOVE the cap and leaves the cap itself alone.

    The ledger and every queued entry carry this string; the cap exists so
    one pathological upstream message cannot bloat the queue. ``<=`` vs
    ``<`` is invisible unless a message lands exactly on the cap, so that
    is the case pinned here.
    """

    CAP = pending.MAX_ERROR_MESSAGE_CHARS

    def test_a_message_exactly_at_the_cap_is_untouched(self):
        msg = "x" * self.CAP
        out = pending._clip_error(RuntimeError(msg))
        self.assertEqual(out, msg)
        self.assertNotIn("truncated", out)

    def test_one_character_over_the_cap_is_clipped(self):
        out = pending._clip_error(RuntimeError("x" * (self.CAP + 1)))
        self.assertTrue(out.endswith("…[truncated]"))
        self.assertEqual(out[: self.CAP], "x" * self.CAP)

    def test_a_short_message_is_untouched(self):
        self.assertEqual(pending._clip_error(RuntimeError("boom")), "boom")


class EvictionsLogRotationBoundaryTest(_QueueTempDirMixin, unittest.TestCase):
    """The eviction ledger rotates ABOVE its cap, not AT it.

    ``switchroom doctor`` reads this file, and rotation drops all but
    ``EVICTIONS_LOG_KEEP_LINES``. ``>`` vs ``>=`` costs a whole ledger's
    history on a file that is exactly at its ceiling — invisible to the
    existing rotation test, which sets the cap to 1 byte and so can never
    land on the boundary.
    """

    def setUp(self):
        super().setUp()
        self._prev = (
            pending.EVICTIONS_LOG_MAX_BYTES,
            pending.EVICTIONS_LOG_KEEP_LINES,
        )
        self.addCleanup(self._restore)
        log = pending.evictions_log_path()
        os.makedirs(os.path.dirname(log), exist_ok=True)
        self.log = log

    def _restore(self):
        (
            pending.EVICTIONS_LOG_MAX_BYTES,
            pending.EVICTIONS_LOG_KEEP_LINES,
        ) = self._prev

    def _one_line_bytes(self):
        """Write one ledger line with rotation effectively off; return its size."""
        pending.EVICTIONS_LOG_MAX_BYTES = 10**9
        pending.EVICTIONS_LOG_KEEP_LINES = 1
        with redirect_stderr(io.StringIO()):
            pending._log_eviction("aaaa.json", 10, "count", 1, 10)
        return os.path.getsize(self.log)

    def _lines(self):
        with open(self.log, encoding="utf-8") as f:
            return [ln for ln in f.read().splitlines() if ln]

    def test_a_ledger_exactly_at_the_cap_is_not_rotated(self):
        one = self._one_line_bytes()
        # Both lines are the same fixed-width shape, so two of them land
        # exactly on a 2*one cap.
        pending.EVICTIONS_LOG_MAX_BYTES = 2 * one
        with redirect_stderr(io.StringIO()):
            pending._log_eviction("aaaa.json", 10, "count", 1, 10)
        self.assertEqual(os.path.getsize(self.log), 2 * one, "fixture assumption")
        self.assertEqual(len(self._lines()), 2, "a ledger AT the cap is within it")

    def test_one_byte_over_the_cap_rotates_to_the_keep_window(self):
        one = self._one_line_bytes()
        pending.EVICTIONS_LOG_MAX_BYTES = 2 * one - 1
        with redirect_stderr(io.StringIO()):
            pending._log_eviction("aaaa.json", 10, "count", 1, 10)
        self.assertEqual(len(self._lines()), 1, "over the cap, rotation runs")


class DeadMarkersLeaveTheLiveQueueTest(_QueueTempDirMixin, unittest.TestCase):
    """A `.dead` marker is the ONLY copy of its memory, so it must not sit
    in the directory external janitors sweep.

    Live evidence: a host cron on this fleet ran
    ``find <queue> -name '*.dead' -mtime +14 -delete`` (6 markers were live
    in the queue when this was measured on 2026-07-26, each on a countdown
    to permanent deletion). Fixing that one cron is
    not a fix -- the next janitor has the same shape. These tests pin the
    product-level invariant instead: THE LIVE QUEUE DIRECTORY CONTAINS ONLY
    LIVE ENTRIES.
    """

    def _dead_names(self):
        try:
            return sorted(os.listdir(pending.dead_dir()))
        except OSError:
            return []

    def test_a_janitor_globbing_the_live_queue_cannot_match_a_memory(self):
        path = pending.enqueue(_payload(content="doomed"), RuntimeError("x"))
        pending.mark_dead(path, dict(_payload(content="doomed")))

        # This is literally what the host cron matched on.
        leftovers = [n for n in os.listdir(self._dir) if n.endswith(".dead")]
        self.assertEqual(leftovers, [], "no .dead file may remain in the queue dir")
        self.assertEqual(len(self._dead_names()), 1, "and the memory still exists")

    def test_the_marker_still_carries_the_whole_memory(self):
        path = pending.enqueue(_payload(content="precious"), RuntimeError("x"))
        marker = pending.mark_dead(path, dict(_payload(content="precious")))
        with open(marker, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["content"], "precious")
        self.assertTrue(marker.startswith(pending.dead_dir()))

    def test_an_unwritable_dead_archive_leaves_the_entry_QUEUED(self):
        """Failure to archive is never a licence to delete."""
        path = pending.enqueue(_payload(content="stays"), RuntimeError("x"))
        blocker = os.path.join(self._tmp, "blocked")
        with open(blocker, "w", encoding="utf-8") as f:
            f.write("not a directory")
        os.environ["HINDSIGHT_PENDING_DEAD_DIR"] = os.path.join(blocker, "dead")

        self.assertIsNone(pending.mark_dead(path, dict(_payload(content="stays"))))
        self.assertTrue(os.path.exists(path), "the live entry must survive")
        self.assertEqual(pending.count(), 1)

    def test_a_failed_REPLACE_also_leaves_the_entry_QUEUED(self):
        """The other half of "FAILURE IS NOT DELETION".

        `test_an_unwritable_dead_archive_leaves_the_entry_QUEUED` fails at
        `os.makedirs`, so the tmp never exists and the cleanup block's
        `os.unlink(tmp)` raises before anything else in it can run -- which
        shields a stray `os.unlink(path)` placed AFTER it from ever being
        observed. Here the tmp write SUCCEEDS and only `os.replace` fails, so
        every statement in the cleanup block executes.
        """
        path = pending.enqueue(_payload(content="stays"), RuntimeError("x"))
        real_replace = os.replace

        def _fail_replace(src, dst, *a, **kw):
            if str(dst).endswith(".dead"):
                raise OSError("replace refused")
            return real_replace(src, dst, *a, **kw)

        with unittest.mock.patch("os.replace", side_effect=_fail_replace):
            self.assertIsNone(
                pending.mark_dead(path, dict(_payload(content="stays")))
            )

        self.assertTrue(os.path.exists(path), "the live entry must survive")
        self.assertEqual(pending.count(), 1)
        self.assertEqual(self._dead_names(), [], "no marker, so no copy exists")
        # And the orphaned tmp really was cleaned up -- that is what the
        # `os.unlink(tmp)` in the cleanup block is FOR.
        self.assertEqual(
            [n for n in os.listdir(pending.dead_dir()) if n.endswith(".tmp")], []
        )

    def test_legacy_markers_in_the_queue_dir_are_relocated_not_deleted(self):
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        legacy = []
        for i in range(3):
            name = os.path.join(self._dir, f"100{i}000-abc-{i}.json.dead")
            with open(name, "w", encoding="utf-8") as f:
                json.dump(_payload(content=f"old-{i}"), f)
            legacy.append(name)

        self.assertEqual(pending.sweep_legacy_dead_markers(), 3)
        self.assertEqual(
            [n for n in os.listdir(self._dir) if n.endswith(".dead")], []
        )
        self.assertEqual(len(self._dead_names()), 3)
        for name in legacy:
            self.assertFalse(os.path.exists(name))
        # Content survived the move -- this is the whole point.
        moved = os.path.join(pending.dead_dir(), self._dead_names()[0])
        with open(moved, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["content"], "old-0")

    def test_the_sweep_is_idempotent_and_never_overwrites(self):
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        name = os.path.join(self._dir, "1000000-abc-0.json.dead")
        with open(name, "w", encoding="utf-8") as f:
            json.dump(_payload(content="first"), f)
        self.assertEqual(pending.sweep_legacy_dead_markers(), 1)
        self.assertEqual(pending.sweep_legacy_dead_markers(), 0)

        # A same-named marker reappearing must not clobber the archived one.
        with open(name, "w", encoding="utf-8") as f:
            json.dump(_payload(content="second"), f)
        self.assertEqual(pending.sweep_legacy_dead_markers(), 0)
        with open(os.path.join(pending.dead_dir(), os.path.basename(name)),
                  encoding="utf-8") as f:
            self.assertEqual(json.load(f)["content"], "first")

    def test_the_sweep_leaves_live_entries_alone(self):
        pending.enqueue(_payload(content="alive"), RuntimeError("x"))
        self.assertEqual(pending.sweep_legacy_dead_markers(), 0)
        self.assertEqual(pending.count(), 1)

    def test_a_dead_marker_is_STRUCTURALLY_UNTRIMMABLE(self):
        """The deliberate exception: a dead marker is the only copy left.

        Every other archive holds a redundant copy and is capped. This one
        holds unrecovered memories, so a cap would be a delete by another
        name -- exactly the loss channel this change closes. The guarantee
        is not "we remember not to call the trim": `_trim_dir` selects
        `*.json` and a marker is `<entry>.json.dead`, so pointing a trim
        straight at the dead archive with a zero cap still removes nothing.
        """
        for i in range(40):
            path = pending.enqueue(_payload(content=f"dead-{i}"), RuntimeError("x"))
            pending.mark_dead(path, dict(_payload(content=f"dead-{i}")))
        self.assertEqual(len(self._dead_names()), 40)

        with redirect_stderr(io.StringIO()):
            dropped = pending._trim_dir(pending.dead_dir(), 0, 0)
        self.assertEqual(dropped, 0)
        self.assertEqual(len(self._dead_names()), 40, "a memory was trimmed away")

    def _write_legacy_markers(self, n: int) -> list:
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        names = []
        for i in range(n):
            name = f"100{i}000-abc-{i}.json.dead"
            with open(os.path.join(self._dir, name), "w", encoding="utf-8") as f:
                json.dump(_payload(content=f"old-{i}"), f)
            names.append(name)
        return names

    def _legacy_leftovers(self):
        return sorted(n for n in os.listdir(self._dir) if n.endswith(".dead"))

    def test_an_uncreatable_dead_archive_reports_ZERO_relocated(self):
        """The count is a claim about the LIVE QUEUE, not an intention.

        Phase 0b turns it straight into `summary["dead_relocated"]` and the
        line "the queue now holds only live entries, so no janitor glob over
        it can match a memory". When `dead_dir()` cannot be created not one
        marker moved, so returning `len(names)` would print that sentence
        over a queue directory still holding every marker -- the exact
        condition this change exists to end, now with an operator told it was
        fixed.
        """
        self._write_legacy_markers(3)

        with unittest.mock.patch.object(
            pending.os, "makedirs",
            side_effect=OSError(errno.EACCES, "Permission denied"),
        ):
            with redirect_stderr(io.StringIO()) as err:
                moved = pending.sweep_legacy_dead_markers()

        self.assertEqual(moved, 0, "nothing moved, so nothing may be claimed")
        self.assertEqual(
            len(self._legacy_leftovers()), 3,
            "and every marker is still in the janitor's path",
        )
        self.assertEqual(self._dead_names(), [])
        self.assertIn("STAY in the live queue", err.getvalue())

    def test_a_marker_that_could_not_be_MOVED_is_not_counted(self):
        """One marker per `except OSError`, and a `pass` there counts a lie.

        The loop swallows a per-marker failure deliberately -- one unwritable
        marker must not abandon the other nine -- but swallowing it is not
        the same as having moved it. Dropping the `continue` leaves the
        marker in the live queue directory AND reports it relocated.
        """
        names = self._write_legacy_markers(2)
        real_move = shutil.move

        def refuse_the_second(src, dst):
            if str(src).endswith(names[1]):
                raise OSError(errno.EACCES, "Permission denied")
            return real_move(src, dst)

        with unittest.mock.patch.object(pending.shutil, "move", refuse_the_second):
            with redirect_stderr(io.StringIO()) as err:
                moved = pending.sweep_legacy_dead_markers()

        self.assertEqual(moved, 1, "only the marker that actually moved counts")
        self.assertEqual(
            self._legacy_leftovers(), [names[1]],
            "the refused one is still in the live queue directory",
        )
        self.assertEqual(self._dead_names(), [names[0]])
        self.assertIn("relocated 1 legacy .dead marker(s)", err.getvalue())

    def test_the_backlog_drain_relocates_legacy_markers(self):
        """The migration only happens if the drain actually calls it.

        Nothing else on the fleet runs `sweep_legacy_dead_markers`, so an
        unwired phase 0b leaves every existing marker sitting in the janitor's
        path -- the exact condition this change exists to end. Asserting the
        function works in isolation does not catch that; this does.
        """
        path = pending.enqueue(_payload(content="legacy"), RuntimeError("x"))
        legacy = path + ".dead"
        os.replace(path, legacy)

        summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")

        self.assertEqual(summary["dead_relocated"], 1)
        self.assertFalse(os.path.exists(legacy), "marker left in the live queue dir")
        self.assertEqual(self._dead_names(), [os.path.basename(legacy)])

    def test_a_dry_run_relocates_nothing(self):
        path = pending.enqueue(_payload(content="legacy"), RuntimeError("x"))
        legacy = path + ".dead"
        os.replace(path, legacy)

        summary = drain_pending.drain_backlog(CONFIG, phase="reconcile", dry_run=True)

        self.assertEqual(summary["dead_relocated"], 0)
        self.assertTrue(os.path.exists(legacy))


class ResplitOverBoundEntriesTest(_QueueTempDirMixin, unittest.TestCase):
    """An entry over the retain bound is RECOVERABLE, so it must never die.

    Such an entry needs more sequential extraction calls than fit the client
    deadline, so every POST is guaranteed waste; if the server rejects the
    body as a 4xx it is (correctly) classified permanent and the memory goes
    `.dead`. Splitting it is the difference between a lost memory and a slow
    one. Two ways one gets into a queue and both are live on this fleet: an
    older build enqueued it unsplit, or the BOUND MOVED under it.
    """

    def _resplit_names(self):
        try:
            return sorted(os.listdir(pending.resplit_dir()))
        except OSError:
            return []

    def test_an_over_bound_entry_becomes_drainable_parts(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="z" * 90_000), RuntimeError("x"))
        self.assertEqual(pending.count(), 1, "queued unsplit under the old bound")

        # The bound MOVES -- exactly what a deadline or safety-factor change
        # does. The entry is now unretainable as-is.
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(entries, 1)
        self.assertGreaterEqual(parts, 30)
        self.assertFalse(os.path.exists(path), "the original left the queue")
        self.assertEqual(len(self._resplit_names()), 1, "archived, not deleted")
        for _p, entry in pending.iter_entries():
            self.assertLessEqual(len(entry["content"]), 3000)

    def test_no_line_of_the_memory_is_lost_across_the_resplit(self):
        """Every line survives -- that is the guarantee that matters.

        `split_retain_content` promises to lose no MESSAGE, not to be
        byte-exact: it splits on line boundaries and the boundary newline
        itself is not carried into either part (measured: 29 newlines lost
        over a 30-way split). That is a pre-existing property of the splitter
        that the LIVE enqueue path already has; this test pins the property a
        re-split must not go beyond -- no line of the memory may vanish.

        Order is deliberately not asserted: the parts are independent queue
        entries whose filenames carry a random suffix, so `iter_entries()`
        returns them in filename order, not part order. Reassembly is by the
        part metadata, not by queue position.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        body = "".join(f"line {i}\n" for i in range(9000))
        pending.enqueue(_payload(content=body), RuntimeError("x"))

        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        pending.resplit_over_bound_entries()
        rejoined = "\n".join(e["content"] for _p, e in pending.iter_entries())
        surviving = [ln for ln in rejoined.split("\n") if ln]
        expected = [f"line {i}" for i in range(9000)]
        # Cheap, readable failure first: name the lines that went missing
        # rather than dumping a 9000-element list diff.
        missing = sorted(set(expected) - set(surviving))
        self.assertEqual(missing[:10], [], f"{len(missing)} line(s) lost in the re-split")
        self.assertEqual(len(surviving), len(expected), "a line was duplicated or dropped")

    def test_the_resplit_archive_is_itself_bounded(self):
        """The archived original is redundant, so it must not eat the disk.

        It is only moved AFTER its parts are queued, so unlike
        `pending-dead/` (which holds the only copy of an unrecovered memory
        and is deliberately uncapped) this archive can be trimmed on the
        same terms as `pending-duplicate/`.
        """
        prev = pending.RESPLIT_MAX_ENTRIES
        pending.RESPLIT_MAX_ENTRIES = 2
        try:
            os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
            for i in range(5):
                pending.enqueue(_payload(content=f"{i}" * 40_000), RuntimeError("x"))
            os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
            with redirect_stderr(io.StringIO()):
                resplit, _parts = pending.resplit_over_bound_entries()
            self.assertEqual(resplit, 5)
            self.assertLessEqual(len(self._resplit_names()), 2)
        finally:
            pending.RESPLIT_MAX_ENTRIES = prev

    def test_the_archived_original_is_still_readable(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        pending.enqueue(_payload(content="q" * 50_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        pending.resplit_over_bound_entries()

        archived = os.path.join(pending.resplit_dir(), self._resplit_names()[0])
        with open(archived, encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["content"]), 50_000)

    def test_an_entry_within_the_bound_is_untouched(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="small"), RuntimeError("x"))
        self.assertEqual(pending.resplit_over_bound_entries(), (0, 0))
        self.assertTrue(os.path.exists(path))
        self.assertEqual(self._resplit_names(), [])

    def test_resplitting_is_idempotent(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        pending.enqueue(_payload(content="w" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        pending.resplit_over_bound_entries()
        depth = pending.count()
        self.assertEqual(pending.resplit_over_bound_entries(), (0, 0))
        self.assertEqual(pending.count(), depth, "a second pass is a no-op")

    def test_an_entry_that_cannot_be_split_STAYS_QUEUED(self):
        """No part written => the original is left exactly where it was."""
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="v" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        with unittest.mock.patch.object(pending, "_enqueue_one", return_value=None):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (0, 0))
        self.assertTrue(os.path.exists(path), "never deleted on failure")
        self.assertEqual(self._resplit_names(), [])

    #: The exact membership of `pending._ENTRY_ONLY_FIELDS`, spelled out
    #: here rather than read off the module under test.
    #:
    #: This literal is deliberate, and it is what makes the strip testable at
    #: all. Only THREE members are observable in the resulting parts:
    #: `attempt_count` (`_build_entry` uses `setdefault`), `last_attempt_at`
    #: and `dead_at` (`_build_entry` never writes them). The other four --
    #: `schema`, `failed_at`, `error_class`, `error_message` -- are assigned
    #: UNCONDITIONALLY by `_build_entry`, so deleting any of them from the
    #: frozenset changes no entry on disk and no outcome assertion can see
    #: it. They are in the set as defence-in-depth (see the comment on
    #: `_ENTRY_ONLY_FIELDS`), and defence-in-depth that is asserted against
    #: the module's own value is asserted against nothing.
    ENTRY_ONLY_FIELDS = frozenset(
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

    def test_entry_only_fields_is_every_field_build_entry_adds(self):
        """Pin the membership itself; the strip's outcome cannot.

        `_build_entry` is the only writer of the first four, and it writes
        them unconditionally -- so a member dropped from the frozenset is
        invisible in every part on disk. Asserting it here is the only
        thing that fails when one goes missing.
        """
        self.assertEqual(pending._ENTRY_ONLY_FIELDS, self.ENTRY_ONLY_FIELDS)
        built = pending._build_entry(_payload(), RuntimeError("x"))
        self.assertEqual(
            self.ENTRY_ONLY_FIELDS - set(_payload()) - {"last_attempt_at", "dead_at"},
            set(built) - set(_payload()),
            "the set drifted from what `_build_entry` actually stamps; "
            "`last_attempt_at`/`dead_at` come from `update_attempt`/`mark_dead`",
        )

    def test_the_parts_carry_no_stale_attempt_metadata(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="u" * 40_000), RuntimeError("x"))
        for _ in range(4):
            with open(path, encoding="utf-8") as f:
                entry = json.load(f)
            pending.update_attempt(path, entry, RuntimeError("again"))
        stale_stamp = "2020-01-01T00:00:00Z"
        with open(path, encoding="utf-8") as f:
            stale = json.load(f)
        stale["failed_at"] = stale_stamp
        stale["dead_at"] = stale_stamp
        with open(path, "w", encoding="utf-8") as f:
            json.dump(stale, f)
        # Guard the fixture: the assertions below are vacuous unless the
        # original really is carrying EVERY entry-only field, since what is
        # under test is that all of them are stripped off the payload.
        self.assertEqual(stale["attempt_count"], 5)
        self.assertIn("last_attempt_at", stale)
        self.assertEqual(stale["error_class"], "RuntimeError")
        self.assertEqual(stale["error_message"], "again")
        self.assertEqual(
            self.ENTRY_ONLY_FIELDS - set(stale), frozenset(),
            "the fixture must carry every entry-only field",
        )

        # The load-bearing assertion for the four fields `_build_entry`
        # overwrites: catch the payload ON THE WAY IN. "The entry on disk has
        # a fresh `failed_at`" is true whether or not `failed_at` was ever
        # stripped; "the dict handed to `enqueue_parts` has no `failed_at`"
        # is not.
        seen: list[dict] = []
        real_enqueue_parts = pending.enqueue_parts

        def spy(payload, error, **kwargs):
            seen.append(dict(payload))
            return real_enqueue_parts(payload, error, **kwargs)

        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        with unittest.mock.patch.object(pending, "enqueue_parts", spy):
            with redirect_stderr(io.StringIO()):
                pending.resplit_over_bound_entries()

        self.assertEqual(len(seen), 1, "the over-bound entry was re-enqueued")
        self.assertEqual(
            sorted(set(seen[0]) & self.ENTRY_ONLY_FIELDS), [],
            "`enqueue()` takes a PAYLOAD, not an entry read off disk -- every "
            "entry-only field must be stripped before it goes back in",
        )
        self.assertEqual(
            seen[0]["content"], "u" * 40_000,
            "and the payload still carries the memory it is stripping around",
        )

        entries = pending.iter_entries()
        self.assertGreaterEqual(len(entries), 13, "the entry really was split")
        for _p, entry in entries:
            # These three are the ones the strip alone decides: `_build_entry`
            # `setdefault`s `attempt_count` and never writes the other two.
            self.assertEqual(
                entry["attempt_count"], 1,
                "a re-split part starts its own budget -- inheriting an "
                "exhausted one would send it straight back toward .dead",
            )
            self.assertNotIn(
                "dead_at", entry,
                "a fresh part is not born already dead",
            )
            # `update_attempt` stamps `last_attempt_at`, so it is entry-only
            # metadata too. Round-tripping it pairs a timestamp from the old
            # entry's last retry with a fresh `attempt_count: 1` -- an entry
            # that claims it was last attempted before it was ever queued.
            self.assertNotIn(
                "last_attempt_at", entry,
                "a fresh part has never been attempted",
            )
            # The rest are `_build_entry` guarantees, not strip guarantees:
            # they hold even if the field were left on the payload. Kept as
            # a check on `_build_entry`, labelled so no one reads them as
            # coverage of `_ENTRY_ONLY_FIELDS`.
            self.assertEqual(entry["error_class"], "RuntimeError")
            self.assertIn("re-split", entry["error_message"])
            self.assertNotEqual(entry["failed_at"], stale_stamp)
            self.assertEqual(entry["schema"], pending.SCHEMA)

    # --- The archive is only earned by a NEW file -------------------------
    #
    # `_enqueue_one` returns the path of an ALREADY-QUEUED identical entry on
    # a dedupe hit, so "enqueue handed back a path" is not "a part was
    # written". Both cases below are the same bug from two angles: a re-split
    # that wrote nothing must not archive the original, because the archive
    # is capped (`_trim_dir`) and the original is then the only copy.

    def test_a_resplit_that_dedupes_onto_its_own_original_STAYS_QUEUED(self):
        """The real repro, no patching: ONE part, so `enqueue` re-enqueues
        the payload unchanged, the dupe key matches the entry being re-split,
        and the "written" path IS the original.

        A JSON transcript is re-serialised compactly by the splitter, so a
        pretty-printed one over the bound can compact to a single part under
        it. That is not exotic -- it is any indented transcript whose
        whitespace is most of its size.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        blocks = [{"type": "text", "text": f"line {i}"} for i in range(60)]
        content = json.dumps([{"role": "user", "content": blocks}], indent=8)
        path = pending.enqueue(_payload(content=content), RuntimeError("x"))
        self.assertEqual(pending.count(), 1)

        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        self.assertGreater(len(content), 3000, "the entry is over the bound")
        self.assertEqual(
            len(retain_split.split_retain_content(content)), 1,
            "the splitter yields a SINGLE part -- the condition under test",
        )

        with redirect_stderr(io.StringIO()):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (0, 0))
        self.assertTrue(os.path.exists(path), "the ONLY copy was archived away")
        self.assertEqual(pending.count(), 1)
        self.assertEqual(self._resplit_names(), [], "nothing was earned")

    def test_a_deduped_part_is_not_counted_as_a_written_part(self):
        """`_enqueue_one` returns an EXISTING path and writes no new file.

        Distinct from `test_an_entry_that_cannot_be_split_STAYS_QUEUED`,
        which returns None and so makes "no path came back" and "no file
        appeared" true at once -- it cannot tell the two guards apart.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="d" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        # Non-None, already on disk, and no new file is created.
        with unittest.mock.patch.object(pending, "_enqueue_one", return_value=path):
            with redirect_stderr(io.StringIO()):
                entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (0, 0))
        self.assertTrue(os.path.exists(path), "never deleted on a no-op split")
        self.assertEqual(pending.count(), 1)
        self.assertEqual(self._resplit_names(), [])

    def test_the_part_count_is_not_a_queue_depth_delta(self):
        """Parts WRITTEN, not queue growth.

        When the queue is near its cap, `_evict_to_fit` sheds an older entry
        for each part it makes room for, so the depth barely moves while N
        parts are genuinely written. A depth delta under-reports that (and at
        the extreme reads 0, which is the "stays queued" signal) -- so the
        count is taken from what `_enqueue_one` handed back.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        for i in range(10):
            pending.enqueue(
                _payload(content=f"filler-{i}", doc=_cd_doc(i + 50)),
                RuntimeError("x"),
            )
        path = pending.enqueue(_payload(content="y" * 40_000), RuntimeError("x"))
        self.assertEqual(pending.count(), 11)

        # 11 queued + 14 parts does not fit, so writing the parts evicts.
        pending.MAX_ENTRIES = 20
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        with redirect_stderr(io.StringIO()):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(entries, 1)
        # 20 at the cap, less the original once it is archived out.
        self.assertEqual(pending.count(), 19, "the cap held, so eviction fired")
        self.assertLess(
            19 - 11, 14, "the depth grew by less than the parts written"
        )
        self.assertEqual(
            parts, 14,
            "every part written is counted, even the ones whose room was "
            "made by evicting an older entry",
        )
        self.assertFalse(os.path.exists(path), "the original was archived")

    # --- A refusal the caller absorbs is not a permanent loss -------------

    def _refused_resplit_leaves_the_ledger_clean(self, cap: str, value: int):
        """`record_drop` means the memory is GONE; here it is still queued.

        `switchroom doctor` FAILS on a non-zero drop ledger, and phase 0c
        retries on every backlog drain (10 min on this fleet), so stamping a
        refusal turns a safely-queued memory into a permanent, monotonically
        climbing doctor failure.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="r" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        setattr(pending, cap, value)

        with redirect_stderr(io.StringIO()):
            for _ in range(3):  # every drain retries the same entry
                self.assertEqual(pending.resplit_over_bound_entries(), (0, 0))

        self.assertEqual(
            pending.read_drops(), {},
            "nothing was lost -- the original is still queued and retryable",
        )
        self.assertTrue(os.path.exists(path))
        self.assertEqual(self._resplit_names(), [])

    def test_a_resplit_refused_on_the_entry_cap_stamps_no_drop(self):
        self._refused_resplit_leaves_the_ledger_clean("MAX_ENTRIES", 2)

    def test_a_resplit_refused_on_the_byte_cap_stamps_no_drop(self):
        self._refused_resplit_leaves_the_ledger_clean("MAX_BYTES", 4096)

    def test_the_producer_path_still_stamps_a_refused_memory_as_dropped(self):
        """The suppression is scoped to the re-split caller, not global.

        `session_end` / `retain` have no other copy of the memory, so when
        `enqueue` refuses one the turn really is lost and the ledger is the
        only record of it.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        pending.MAX_BYTES = 4096  # smaller than the split memory as a whole
        with redirect_stderr(io.StringIO()):
            self.assertIsNone(
                pending.enqueue(_payload(content="e" * 40_000), RuntimeError("x"))
            )
        self.assertEqual(pending.read_drops().get("count"), 1)
        self.assertEqual(pending.count(), 0)

    # --- ... and neither is a PER-PART failure the caller absorbs ---------
    #
    # The cap refusals above are the whole-memory door. `_enqueue_one` has a
    # second one: its own MAX_BYTES guard and the post-eviction write failure
    # both `record_drop`. When EVERY part fails there, `enqueue_parts` hands
    # back nothing, `written == 0`, and the original correctly STAYS QUEUED --
    # so those drops describe a memory that was not lost, on an entry phase 0c
    # retries every backlog drain (10 min on this fleet), climbing forever and
    # never resetting once the disk is fixed. Same failure mode, same fix.

    @staticmethod
    def _enospc_on_every_rename():
        """A full disk, at the exact syscall `_enqueue_one` fails on."""
        return unittest.mock.patch.object(
            pending.os, "rename",
            side_effect=OSError(errno.ENOSPC, "No space left on device"),
        )

    def test_a_resplit_whose_every_part_fails_to_write_stamps_no_drop(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="p" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        with self._enospc_on_every_rename():
            with redirect_stderr(io.StringIO()):
                for _ in range(3):  # every backlog drain retries this entry
                    self.assertEqual(pending.resplit_over_bound_entries(), (0, 0))

        self.assertEqual(
            pending.read_drops(), {},
            "nothing was lost -- not one part was written, so the original "
            "is still queued and the next drain retries the whole re-split",
        )
        self.assertTrue(os.path.exists(path), "the original never left")
        self.assertEqual(pending.count(), 1)
        self.assertEqual(self._resplit_names(), [])

    def test_a_part_that_fails_is_stamped_once_the_original_is_retired(self):
        """The deferral is not a suppression.

        One part of fourteen hits ENOSPC, thirteen land, so the original IS
        archived -- nothing will ever retry part five again. That IS the
        permanent loss `record_drop` exists to make visible.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="q" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        real_rename = os.rename
        seen = {"n": 0}

        def flaky(src, dst):
            seen["n"] += 1
            if seen["n"] == 5:  # part five of fourteen
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_rename(src, dst)

        with unittest.mock.patch.object(pending.os, "rename", flaky):
            with redirect_stderr(io.StringIO()):
                entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (1, 13), "thirteen of fourteen")
        self.assertFalse(os.path.exists(path), "the original was archived")
        self.assertEqual(
            pending.read_drops().get("count"), 1,
            "the part that never landed is gone for good and must be visible",
        )
        self.assertEqual(
            pending.read_drops().get("last_error_class"), "OSError",
        )

    def test_the_producer_path_still_stamps_a_failed_part_as_dropped(self):
        """The per-part deferral is scoped to the re-split caller too.

        `session_end` / `retain` hold no other copy, so every part that
        cannot be written really is a lost slice of the turn.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        with self._enospc_on_every_rename():
            with redirect_stderr(io.StringIO()):
                self.assertIsNone(
                    pending.enqueue(_payload(content="f" * 40_000), RuntimeError("x"))
                )
        self.assertEqual(pending.count(), 0, "not one part landed")
        self.assertGreaterEqual(
            pending.read_drops().get("count", 0), 14,
            "one drop per part the producer could not write",
        )

    # --- An original evicted out from under its own re-split --------------

    @staticmethod
    def _clock_frozen_at(when: float):
        """Freeze the millisecond `_enqueue_one` stamps into entry names.

        Entry names are `<unix-ms>-<dupe-key>-<uuid>.json` and FIFO order is
        their lexicographic sort, so entries written inside ONE millisecond
        tie-break on the CONTENT-DERIVED dupe key -- stable and total, but
        arbitrary. Production never hits that on the re-split path: the
        original was queued by an EARLIER process, milliseconds to days
        before its parts. A test that enqueues both inside one tick does hit
        it, and then `_evict_to_fit` sheds whichever name happens to sort
        first -- measured 6 failures in 40 isolated runs of the case below
        before this pin. So pin the age relationship the product guarantees
        instead of racing the clock for it.
        """
        return unittest.mock.patch.object(pending.time, "time", lambda: when)

    def _nth_part_write_fails(self, n: int):
        """ENOSPC on the `n`-th part write, and on nothing else.

        Counting every `os.rename` would be wrong: `shutil.move` renames too
        when source and destination share a filesystem, so an eviction inside
        the same loop shifts the count. Only the tmp -> `<entry>.json` rename
        inside the LIVE QUEUE dir is a part landing.
        """
        real_rename = os.rename
        seen = {"n": 0}

        def flaky(src, dst):
            landing = str(dst).endswith(".json") and os.path.dirname(
                os.path.abspath(str(dst))
            ) == os.path.abspath(self._dir)
            if landing:
                seen["n"] += 1
                if seen["n"] == n:
                    raise OSError(errno.ENOSPC, "No space left on device")
            return real_rename(src, dst)

        return unittest.mock.patch.object(pending.os, "rename", flaky)

    def _an_original_older_than_its_parts(self, content: str) -> str:
        """Enqueue `content` stamped an hour ago; return its queue path."""
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        with self._clock_frozen_at(time.time() - 3600):
            path = pending.enqueue(_payload(content=content), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        return path

    def test_a_resplit_that_evicts_its_own_original_says_so(self):
        """The parts fill the queue and FIFO-shed the entry being re-split.

        `total > MAX_ENTRIES` is false at exactly 14 parts and a cap of 14,
        so there is no refusal: part fourteen calls `_evict_to_fit`, which
        sheds the OLDEST entry -- the original. `shutil.move` then raises
        `FileNotFoundError`. Nothing is lost (fourteen parts plus the evicted
        copy), but the old line told the operator the original "STAYS QUEUED"
        when it is in `pending-evicted/`, and returned (0, 0) after writing
        fourteen parts.
        """
        path = self._an_original_older_than_its_parts("z" * 40_000)
        name = os.path.basename(path)
        pending.MAX_ENTRIES = 14

        err = io.StringIO()
        with redirect_stderr(err):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(len(retain_split.split_retain_content("z" * 40_000)), 14)
        self.assertFalse(os.path.exists(path), "the original was evicted")
        self.assertIn(name, self._archive_names(), "...into pending-evicted/")
        self.assertEqual(self._resplit_names(), [], "it was never archived")
        self.assertEqual(pending.count(), 14, "fourteen parts, at the cap")

        log = err.getvalue()
        self.assertNotIn(
            "STAYS QUEUED", log,
            "it is NOT queued -- that is the line an operator reads under "
            "exactly this pressure",
        )
        self.assertIn(pending.evicted_dir(), log, "say where it actually is")

    def test_the_evicted_branch_counts_the_parts_it_actually_wrote(self):
        """The return tuple alone, pinned on its own.

        This is the assertion that keeps the `continue` off the evicted
        branch: with it restored the drain writes fourteen parts and reports
        (0, 0), so phase 0c's `_blog` line and `summary["resplit"]` both go
        silent on a re-split that happened. It is deliberately free of log
        wording and of every archive-location assertion, so no rewording of
        the operator line can retire the guard by accident.
        """
        self._an_original_older_than_its_parts("z" * 40_000)
        pending.MAX_ENTRIES = 14

        with redirect_stderr(io.StringIO()):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(
            (entries, parts), (1, 14),
            "fourteen parts were genuinely written and are queued, so phase "
            "0c's summary and `_blog` line must report them",
        )
        self.assertEqual(pending.count(), 14, "and all fourteen really are live")

    def test_a_part_shed_to_make_room_is_not_counted_as_queued(self):
        """The other side of the eviction race, and an accounting lie.

        FIFO sheds the OLDEST name, which is the original only while the
        original IS the oldest. Freeze the parts into an older millisecond
        and part fourteen evicts a PART instead: `shutil.move` then SUCCEEDS,
        the original is archived under `pending-resplit/`, and the drain used
        to report "into 14 queued part(s)" with thirteen queued and one
        sitting in `pending-evicted/`. Nothing re-drains that directory (see
        `drain_pending`, `probe.ts`, `doctor.ts` -- all of them only count or
        trim it), so the shed part is a slice of the memory that will not
        reach the bank, and the operator line must not paper over it.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="y" * 40_000), RuntimeError("x"))
        name = os.path.basename(path)
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        pending.MAX_ENTRIES = 14

        err = io.StringIO()
        # The parts land an hour "before" the original, so the oldest name in
        # the queue when part fourteen needs room is a part, not the original.
        with self._clock_frozen_at(time.time() - 3600):
            with redirect_stderr(err):
                entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(pending.count(), 13, "thirteen parts survived")
        self.assertEqual(
            self._resplit_names(), [name], "the original WAS archived here"
        )
        shed = self._archive_names()
        self.assertEqual(len(shed), 1, "one part was shed to make room")
        self.assertNotIn(name, shed, "and it was a part, not the original")

        self.assertEqual(
            (entries, parts), (1, 13),
            "a part in pending-evicted/ is not a queued part -- nothing "
            "re-drains that directory",
        )
        log = err.getvalue()
        self.assertIn("into 13 queued part(s)", log)
        self.assertNotIn("into 14 queued part(s)", log)
        # The eviction itself already logs "evicted OLDEST ... into <dir>", so
        # asserting on `evicted_dir()` alone here passes with no re-split line
        # at all -- vacuous. Pin the re-split's OWN line: the operator reading
        # "the original is archived" has to be told, in the same breath, that
        # a part went the other way.
        self.assertRegex(
            log,
            r"re-split \S+ wrote 14 part\(s\).*13 part\(s\) of this memory "
            r"are live",
            "the re-split must reconcile 14 written against 13 live",
        )
        self.assertIn(
            f"FIFO-evicted into {pending.evicted_dir()}", log,
            "and say where the shed part went",
        )
        self.assertIn(shed[0], log, "named, so it can be found")

    def _resplit_with_the_last_part_failing(self):
        """Original evicted AND one part unwritten, the two together.

        Part fourteen is the one that triggers `_evict_to_fit` (the queue is
        at its cap of fourteen), so failing THAT part's write is the only
        arrangement where the original leaves the queue and a part is
        genuinely lost in the same drain. Returns `(entries, parts, log)`.
        """
        path = self._an_original_older_than_its_parts("w" * 40_000)
        pending.MAX_ENTRIES = 14

        err = io.StringIO()
        with self._nth_part_write_fails(14):
            with redirect_stderr(err):
                entries, parts = pending.resplit_over_bound_entries()

        self.assertFalse(os.path.exists(path), "the original left the queue")
        self.assertIn(
            os.path.basename(path), self._archive_names(),
            "by eviction -- pending-resplit/ never got it",
        )
        self.assertEqual(self._resplit_names(), [])
        self.assertEqual((entries, parts), (1, 13), "thirteen of fourteen")
        return entries, parts, err.getvalue()

    def test_a_part_that_fails_is_stamped_when_the_original_is_EVICTED(self):
        """The archived branch is not the only one that retires the original.

        `record_deferred_drops` is reached on BOTH branches below the move,
        and only the archived one was covered: gating the stamp on the
        original having reached `pending-resplit/` left this drain silent
        about part fourteen, which nothing will ever retry -- the original is
        in `pending-evicted/` and no consumer re-drains that directory.
        """
        self._resplit_with_the_last_part_failing()

        self.assertEqual(
            pending.read_drops().get("count"), 1,
            "the part that never landed is gone for good and must be visible",
        )
        self.assertEqual(pending.read_drops().get("last_error_class"), "OSError")

    def test_the_evicted_branch_does_not_reassure_when_a_part_was_lost(self):
        """Two contradictory lines in one drain is a log-lie, not a nuance.

        The evicted branch printed "(the parts carry the whole memory)"
        unconditionally and `record_deferred_drops` then printed "permanently
        lost" for the same entry, in the same drain. A non-empty `deferred`
        is EXACTLY the case where the parts do not carry the whole memory.
        """
        _entries, _parts, log = self._resplit_with_the_last_part_failing()

        self.assertNotIn(
            "carry the whole memory", log,
            "one part never got written, so they demonstrably do not",
        )
        self.assertIn("permanently lost", log, "and the loss is still said")
        self.assertIn(pending.evicted_dir(), log, "with the original's location")

    def test_a_concurrent_reconcile_is_not_reported_as_an_eviction(self):
        """"Gone from the queue" is resolved, not assumed.

        Nothing serialises this drain against an in-hook `drain()` --
        `lib/pacing.py`'s `retain-inflight.lock` is a per-POST storm guard and
        `drain_pending` takes no lock -- so the original can be RECONCILED out
        from under the archive move. Attributing that to eviction told the
        operator the memory was shed when it had just been confirmed durable
        upstream, and stamped a permanent DROP for a part of a memory that
        reached the bank whole.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="v" * 40_000), RuntimeError("x"))
        name = os.path.basename(path)
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        real_move = shutil.move

        def reconcile_first(src, dst):
            """The other process wins the race, between two syscalls here."""
            if os.path.abspath(src) == os.path.abspath(path):
                # Exactly what `archive_reconciled` does in the other
                # process, minus the recursion back through this patch.
                os.makedirs(pending.reconciled_dir(), mode=0o700, exist_ok=True)
                real_move(src, os.path.join(pending.reconciled_dir(), name))
                raise OSError(errno.ENOENT, "No such file or directory")
            return real_move(src, dst)

        err = io.StringIO()
        with self._nth_part_write_fails(5):  # part five never lands
            with unittest.mock.patch.object(pending.shutil, "move", reconcile_first):
                with redirect_stderr(err):
                    entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual(self._reconciled_names(), [name], "that is where it went")
        self.assertEqual(self._archive_names(), [], "it was never evicted")
        self.assertEqual((entries, parts), (1, 13))

        log = err.getvalue()
        self.assertIn(pending.reconciled_dir(), log, "say where it actually is")
        self.assertNotIn("it was itself evicted", log)
        self.assertEqual(
            pending.read_drops(), {},
            "the whole memory is durable upstream, so the part that never "
            "got written is a redundant copy, not a lost turn",
        )

    def test_content_exactly_at_the_bound_is_not_re_split(self):
        """`<= limit` is the bound, and the equal case is the whole point.

        `split_retain_content` passes content of exactly `limit` chars
        through unsplit, so re-splitting it here is pure churn: the payload
        dedupes straight back onto the original and the drain prints "could
        not re-split" about an entry that never needed splitting. At `<`
        every drain does that for every at-the-bound entry.
        """
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"
        path = pending.enqueue(_payload(content="b" * 3000), RuntimeError("x"))
        self.assertEqual(pending.count(), 1, "it was queued whole, not split")

        err = io.StringIO()
        with redirect_stderr(err):
            entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (0, 0))
        self.assertTrue(os.path.exists(path), "untouched")
        self.assertEqual(
            err.getvalue(), "",
            "an entry AT the bound is not even considered -- one char over "
            "is over, one char at is not",
        )

    def test_an_archive_failure_that_leaves_the_original_queued_still_says_so(self):
        """The other branch: the move fails but the entry is still there."""
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="a" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        err = io.StringIO()
        with unittest.mock.patch.object(
            pending.shutil, "move",
            side_effect=OSError(errno.EACCES, "Permission denied"),
        ):
            with redirect_stderr(err):
                entries, parts = pending.resplit_over_bound_entries()

        self.assertEqual((entries, parts), (0, 0), "the original is still queued")
        self.assertTrue(os.path.exists(path))
        self.assertIn("STAYS QUEUED", err.getvalue())

    # --- The (first, paths) contract at total <= 1 ------------------------

    def test_a_single_part_enqueue_returns_the_path_it_wrote(self):
        """`enqueue_parts` exists so a caller holding a copy can decide when
        to retire it. That decision reads the LIST, so the list must carry
        the single-part write too -- returning `(path, [])` would tell every
        such caller "nothing was queued" for the commonest payload there is.
        """
        first, paths = pending.enqueue_parts(
            _payload(content="under the bound"), RuntimeError("x")
        )
        self.assertIsNotNone(first)
        self.assertEqual(
            len(retain_split.split_retain_content("under the bound")), 1,
            "the single-part branch is the one under test",
        )
        self.assertEqual(
            paths, [first],
            "one part written is one path handed back",
        )
        self.assertEqual(pending.count(), 1)

    def test_a_single_part_that_could_not_be_written_returns_no_paths(self):
        """The other half of the contract: `None` means nothing to retire."""
        with self._enospc_on_every_rename():
            with redirect_stderr(io.StringIO()):
                first, paths = pending.enqueue_parts(
                    _payload(content="under the bound"), RuntimeError("x")
                )
        self.assertIsNone(first)
        self.assertEqual(paths, [])

    def test_the_backlog_drain_resplits_before_paying_for_extraction(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        pending.enqueue(_payload(content="t" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        summary = drain_pending.drain_backlog(CONFIG, phase="reconcile")
        self.assertEqual(summary["resplit"], 1)
        self.assertGreaterEqual(summary["resplit_parts"], 14)

    def test_a_dry_run_resplits_nothing(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "100000"
        path = pending.enqueue(_payload(content="s" * 40_000), RuntimeError("x"))
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "3000"

        summary = drain_pending.drain_backlog(
            CONFIG, phase="reconcile", dry_run=True
        )
        self.assertEqual(summary["resplit"], 0)
        self.assertTrue(os.path.exists(path))


if __name__ == "__main__":
    unittest.main()
