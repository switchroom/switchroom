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

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stderr

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import lib.pending as pending  # noqa: E402

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
        pending.enqueue(_payload(doc="d0"), RuntimeError("x"))
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(doc="d1"), RuntimeError("x"))
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
                        pending.enqueue(_payload(doc=f"d{i}"), RuntimeError("x"))
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
            pending.enqueue(_payload(doc="d0"), RuntimeError("x"))
            with redirect_stderr(io.StringIO()):
                pending.enqueue(_payload(doc="d1"), RuntimeError("x"))
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

    def test_entry_without_document_id_is_always_kept(self):
        """No document_id => identity cannot be established => never merge."""
        p = _payload()
        p.pop("document_id")
        pending.enqueue(dict(p), RuntimeError("x"))
        pending.enqueue(dict(p), RuntimeError("x"))
        self.assertEqual(pending.count(), 2)


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

    def test_backlog_ages_entries_toward_dead_like_the_sequential_drain(self):
        self._queue(1)
        path, entry = pending.iter_entries()[0]
        entry["attempt_count"] = pending.MAX_ATTEMPTS
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entry, f)

        def always_fail(entry, timeout):
            raise ConnectionError("upstream down")

        with unittest.mock.patch.object(drain_pending, "_retry_one", always_fail):
            with redirect_stderr(io.StringIO()):
                summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertEqual(summary["dead"], 1)
        self.assertTrue(os.path.exists(path + ".dead"))
        self.assertFalse(os.path.exists(path))

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

        The in-hook success path retires on a bare 200 while the backlog
        path insists a 200 is not proof. Archiving both makes the weaker
        evidence cost a recoverable file rather than a lost turn.
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

    def test_an_unwritable_archive_still_retires_the_entry(self):
        """A queue that cannot retire entries re-POSTs them forever."""
        pending.enqueue(_payload(doc=_cd_doc(9)), RuntimeError("x"))
        with unittest.mock.patch.object(
            pending.shutil, "move", side_effect=OSError(28, "No space left")
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: True
            ):
                summary = drain_pending.drain(CONFIG)
        self.assertEqual(summary["reconciled"], 1)
        self.assertEqual(pending.count(), 0, "the entry must not stay queued")


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

        def fake_drain(config=None, backlog=False, phase="both", dry_run=False):
            seen.update(backlog=backlog, phase=phase, dry_run=dry_run)
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

    def test_phase_without_backlog_is_refused(self):
        with redirect_stderr(io.StringIO()):
            rc, _ = self._run(["--phase", "reconcile"])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
