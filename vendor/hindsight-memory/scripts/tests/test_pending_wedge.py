"""The drain must never wedge on entries the permanence gate keeps forever.

Lives under ``scripts/tests/`` because that is the only python test directory
CI discovers (``ci-tests-python.yml`` runs ``python3 -m unittest discover
tests/`` with ``working-directory: vendor/hindsight-memory/scripts``).

BACKGROUND. ``pending.is_permanent_failure`` stopped the drain retiring a
memory to ``.dead`` on a transient failure — correct, because a flaky
extraction model was destroying memories that were never unsaveable. But
``.dead`` was doing double duty: it was the honesty policy AND it was the
queue's only un-wedging mechanism. An entry that fails transiently on every
drain (an oversized payload enqueued before #3610 split them, say, which
``lib/pending``'s own docstring notes "still never drains until it is split")
is now immortal. ``iter_entries()`` is oldest-first and backlog concurrency
defaults to 1, so those immortal entries sit at the head of every run, and
three of them trip ``STALL_THRESHOLD`` before anything behind them is tried.

Without the ``_drain_order`` / ``_over_budget`` demotions this file pins,
that produced ``stalled=True, drained=0`` on EVERY run, forever, with healthy
entries queued behind and never attempted.
"""

import io
import json
import os
import sys
import unittest
import unittest.mock
from contextlib import redirect_stderr

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import lib.pending as pending  # noqa: E402

from tests.test_pending_drops import (  # noqa: E402
    CONFIG,
    _QueueTempDirMixin,
    _cd_doc,
    _payload,
)

#: The immortal entries: they fail with a TRANSIENT error on every drain, so
#: the permanence gate correctly refuses to retire them — forever.
POISON = {"c0", "c1", "c2"}


class DrainWedgeTest(_QueueTempDirMixin, unittest.TestCase):
    def _seed(self, n, attempts_for):
        # Entry filenames are `<unix-ms>-<uuid>.json` and FIFO order is the
        # lexicographic sort of that name, so pin the clock to make "oldest"
        # deterministic rather than a uuid tie-break.
        clock = iter(1000.0 + i for i in range(50))
        with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
            for i in range(n):
                pending.enqueue(
                    _payload(content=f"c{i}", doc=_cd_doc(i)), RuntimeError("x")
                )
        for path, entry in pending.iter_entries():
            entry["attempt_count"] = attempts_for(entry["content"])
            with open(path, "w", encoding="utf-8") as f:
                json.dump(entry, f)

    @staticmethod
    def _retry(entry, timeout):
        if entry["content"] in POISON:
            raise TimeoutError("client deadline exceeded")
        return None

    def _drain_once(self):
        # `_document_state` mirrors `_retry`: a healthy entry's POST lands and
        # the confirming GET sees it, a poison entry never persists. Anything
        # else would let the free reconcile pass retire the poison entries and
        # hide the very wedge under test.
        with unittest.mock.patch.object(drain_pending, "_retry_one", self._retry):
            with unittest.mock.patch.object(
                drain_pending,
                "_document_state",
                lambda e, timeout=30: e["content"] not in POISON,
            ):
                with redirect_stderr(io.StringIO()):
                    return drain_pending.drain_backlog(CONFIG, phase="drain")

    def test_poison_heads_do_not_starve_healthy_entries_behind_them(self):
        """The common shape: a few immortal entries in front of good ones.

        They are the OLDEST by construction (they have been failing longest),
        so oldest-first ordering puts them exactly where they do most damage.
        """
        self._seed(6, lambda c: pending.MAX_ATTEMPTS if c in POISON else 0)

        summary = self._drain_once()

        self.assertEqual(summary["drained"], 3, "healthy entries must drain")
        self.assertFalse(summary["stalled"], "3 immortal entries must not stall the run")
        self.assertEqual(pending.count(), 3, "only the immortal entries remain queued")

    def test_whole_queue_over_budget_still_drains_after_recovery(self):
        """The shape that demotion-by-ORDERING alone does not fix.

        An upstream down for a week takes every entry past ``MAX_ATTEMPTS``.
        When it recovers, the over-budget partition holds the entire queue, so
        ordering is a no-op and the poison entries are back at the head. Only
        the stall-guard abstention (``_over_budget``) gets past them.
        """
        self._seed(6, lambda c: pending.MAX_ATTEMPTS)

        summary = self._drain_once()

        self.assertEqual(summary["drained"], 3, "recovered entries must drain")
        self.assertFalse(summary["stalled"])
        self.assertEqual(pending.count(), 3)

    def test_repeated_runs_converge_instead_of_repeating_a_zero_drain(self):
        """The wedge was defined by NON-convergence: identical useless runs."""
        self._seed(6, lambda c: pending.MAX_ATTEMPTS if c in POISON else 0)

        depths = []
        for _ in range(3):
            self._drain_once()
            depths.append(pending.count())

        self.assertEqual(depths, [3, 3, 3], "converges after run 0 and stays there")

    def test_a_genuine_upstream_outage_still_stalls(self):
        """The guard rail on the fix: abstention must not disarm the guard.

        Entries INSIDE their attempt budget still vote, so a real outage is
        caught after ``STALL_THRESHOLD`` and the drain stops hammering it.
        """
        self._seed(6, lambda c: 0)

        def all_fail(entry, timeout):
            raise TimeoutError("upstream down")

        with unittest.mock.patch.object(drain_pending, "_retry_one", all_fail):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: None
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertTrue(summary["stalled"], "a real outage must still stall")
        self.assertEqual(
            summary["retried"], 3, "and stop at STALL_THRESHOLD, not run the queue"
        )

    def test_the_entry_crossing_the_budget_on_this_failure_still_votes(self):
        """``update_attempt`` mutates ``attempt_count`` in place.

        So the abstention check must read the counter BEFORE
        ``_record_failure``. Reading it after would let an entry at
        ``MAX_ATTEMPTS - 1`` abstain on the failure that takes it to the
        budget, quietly weakening the guard for ordinary entries. Three such
        entries are a genuine outage signal and must still stall.
        """
        self._seed(6, lambda c: pending.MAX_ATTEMPTS - 1)

        def all_fail(entry, timeout):
            raise TimeoutError("upstream down")

        with unittest.mock.patch.object(drain_pending, "_retry_one", all_fail):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: None
            ):
                with redirect_stderr(io.StringIO()):
                    summary = drain_pending.drain_backlog(CONFIG, phase="drain")

        self.assertTrue(summary["stalled"])
        self.assertEqual(summary["retried"], 3)


class DrainOrderTest(unittest.TestCase):
    """``_drain_order`` is a STABLE partition — age order survives inside it."""

    def test_over_budget_entries_go_last_and_keep_relative_age(self):
        entries = [
            ("p0", {"attempt_count": pending.MAX_ATTEMPTS}),
            ("p1", {"attempt_count": 0}),
            ("p2", {"attempt_count": pending.MAX_ATTEMPTS + 4}),
            ("p3", {"attempt_count": 2}),
        ]
        self.assertEqual(
            [p for p, _ in drain_pending._drain_order(entries)],
            ["p1", "p3", "p0", "p2"],
        )

    def test_a_missing_or_corrupt_counter_is_treated_as_fresh(self):
        for value in ({}, {"attempt_count": None}, {"attempt_count": "many"}):
            with self.subTest(value=value):
                self.assertFalse(drain_pending._over_budget(value))


if __name__ == "__main__":
    unittest.main()
