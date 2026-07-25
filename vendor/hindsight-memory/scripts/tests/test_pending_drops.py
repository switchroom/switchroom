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


def _payload(bank="bank-a", content="hello", doc="doc-1"):
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

    def test_ledgers_live_outside_the_queue_dir(self):
        """So they can never be listed as an entry, drained, or counted."""
        pending.MAX_ENTRIES = 1
        pending.enqueue(_payload(doc="d0"), RuntimeError("x"))
        with redirect_stderr(io.StringIO()):
            pending.enqueue(_payload(doc="d1"), RuntimeError("x"))
        for p in (pending.evictions_log_path(), pending.drops_path()):
            self.assertNotEqual(os.path.dirname(p), self._dir.rstrip("/"))
        self.assertEqual(pending.count(), 1)


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
        for i in range(n):
            pending.enqueue(
                _payload(content=f"turn-{i}", doc=f"doc-{i}"), RuntimeError("boom")
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
        durable = {"doc-0", "doc-1", "doc-2", "doc-3"}

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
            ["doc-4", "doc-5"],
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

    def test_session_start_reconcile_respects_the_hook_budget(self):
        """The GET replaces the POST; it must not be an extra unbounded call."""
        self._queue(10)
        os.environ["HINDSIGHT_DRAIN_BUDGET_S"] = "2"
        seen = []

        def slow_get(entry, timeout=30):
            import time as _t

            seen.append(timeout)
            _t.sleep(0.5)
            return True

        with unittest.mock.patch.object(drain_pending, "_document_state", slow_get):
            summary = drain_pending.drain(CONFIG)

        self.assertTrue(summary["budget_exceeded"])
        self.assertTrue(all(t <= 5 for t in seen), f"timeout not clamped: {seen}")
        self.assertGreater(pending.count(), 0)

    def test_reconcile_phase_skips_already_durable_entries_without_posting(self):
        """The free pass: 70.4% of a measured fleet backlog was already
        durable. Re-POSTing those is duplicated LLM extraction for zero new
        memory; a GET costs nothing on the model pool."""
        self._queue(6)
        posted = []
        durable = {"doc-0", "doc-1", "doc-2"}

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
