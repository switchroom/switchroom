"""A permanently-failing entry must stop costing LLM lane time.

Lives under ``scripts/tests/`` because that is the only python test directory
CI discovers (``ci-tests-python.yml`` runs ``python3 -m unittest discover
tests/`` with ``working-directory: vendor/hindsight-memory/scripts``).

BACKGROUND. The permanence gate (``pending.is_permanent_failure``) keeps an
entry queued past ``MAX_ATTEMPTS`` on anything but a 4xx, and ``_over_budget``
/ ``_drain_order`` then DEMOTE it so it cannot starve healthy entries behind
it. Both are right, and together they bound head-of-line blocking — but not
TOTAL work: the entry is still retried in full on every single run, forever.

That was affordable when every drain was supervised: a 4-second in-hook pass,
or an operator watching a manual sweep. The ``hindsight-drain`` sidecar makes
it unaffordable. Its backlog budget is 3600s (``_backlog_budget_seconds``)
against a 900s cooldown, so a wedged agent spends ~80% of wall-clock draining,
unattended, against 4 lanes shared with live retains, reflect and
consolidation — indefinitely. The interim host stopgap recorded exactly that
shape while it ran: ``finn 280s drained=0 retried=3 STALLED``, ``carrie 564s
drained=0 retried=2 (lane busy)``.

So an entry past ``_attempt_ceiling()`` is PARKED. Parking is not retirement:
the entry stays on disk, keeps being swept for free by the reconcile pass, and
comes back in full under ``--force``. What it stops is paying ~168s of a
shared lane, again, for a POST that has already failed 20 times.

Every test here fails without the ``_park_broken`` call in the drain paths:
the parked entry is retained again, which is the unbounded-retry behaviour.
"""

import io
import json
import os
import re
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


class CircuitBreakerTest(_QueueTempDirMixin, unittest.TestCase):
    ENV_KEYS = _QueueTempDirMixin.ENV_KEYS + ("HINDSIGHT_DRAIN_ATTEMPT_CEILING",)

    def setUp(self):
        super().setUp()
        os.environ.pop("HINDSIGHT_DRAIN_ATTEMPT_CEILING", None)
        self.posted = []

    def _seed(self, attempts_by_content):
        """Queue one entry per ``{content: attempt_count}`` pair."""
        clock = iter(1000.0 + i for i in range(50))
        with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
            for i, content in enumerate(attempts_by_content):
                pending.enqueue(
                    _payload(content=content, doc=_cd_doc(i)), RuntimeError("x")
                )
        for path, entry in pending.iter_entries():
            entry["attempt_count"] = attempts_by_content[entry["content"]]
            with open(path, "w", encoding="utf-8") as f:
                json.dump(entry, f)

    def _record_post(self, entry, timeout):
        self.posted.append(entry["content"])

    def _drain(self, present=False, **kw):
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", self._record_post
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", lambda e, timeout=30: present
            ):
                with redirect_stderr(io.StringIO()) as err:
                    summary = drain_pending.drain(CONFIG, **kw)
        return summary, err.getvalue()

    # ── the breaker itself ────────────────────────────────────────────

    def test_the_unattended_backlog_drain_stops_retrying_a_wedged_entry(self):
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling, "healthy": 1})

        summary, err = self._drain(backlog=True, phase="drain")

        self.assertEqual(
            self.posted,
            ["healthy"],
            "an entry past the attempt ceiling must not be retained again",
        )
        self.assertEqual(summary["parked"], 1)
        self.assertIn("parked 1 entries past the attempt ceiling", err)

    def test_parking_is_not_retirement_the_entry_is_still_on_disk(self):
        """The whole permanence gate rests on never destroying a memory. A
        breaker that deleted, or promoted to ``.dead``, would trade the
        wedge for the data loss the gate exists to prevent."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling})

        self._drain(backlog=True, phase="drain")

        self.assertEqual(pending.count(), 1)
        self.assertEqual(
            [e["content"] for _p, e in pending.iter_entries()], ["wedged"]
        )
        self.assertEqual(
            [n for n in os.listdir(self._dir) if n.endswith(".dead")],
            [],
            "parking must not retire the entry",
        )

    def test_a_parked_entry_is_still_reconciled_for_free(self):
        """Parking withholds the expensive retry, not the cheap proof: if the
        document DID land, the free presence pass still retires the entry."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling})

        summary, _ = self._drain(backlog=True, present=True, phase="reconcile")

        self.assertEqual(summary["reconciled"], 1)
        self.assertEqual(self.posted, [], "no POST was needed")
        self.assertEqual(pending.count(), 0)

    def test_force_retries_the_parked_entries_anyway(self):
        """The escape hatch. Without it the breaker would be a one-way door,
        and an operator who fixed the upstream could never replay."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling, "healthy": 1})

        summary, _ = self._drain(backlog=True, phase="drain", force=True)

        self.assertEqual(sorted(self.posted), ["healthy", "wedged"])
        self.assertEqual(summary["parked"], 0)

    def test_an_entry_one_attempt_below_the_ceiling_still_drains(self):
        """The boundary. A breaker that fired early would park entries the
        demotion logic is still successfully draining."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"nearly": ceiling - 1})

        summary, _ = self._drain(backlog=True, phase="drain")

        self.assertEqual(self.posted, ["nearly"])
        self.assertEqual(summary["parked"], 0)

    def test_the_in_hook_drain_parks_too(self):
        """Same policy on the SessionStart path: a 4s budget spent on an
        entry that has failed 20 times is 4s not spent on the rest."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling, "healthy": 1})

        summary, _ = self._drain()

        self.assertEqual(self.posted, ["healthy"])
        self.assertEqual(summary["parked"], 1)

    def test_repeated_unattended_runs_never_touch_the_wedged_entry_again(self):
        """The actual failure mode: not one wasted run, but every run from
        here to the heat death of the container."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling})

        for _ in range(5):
            self._drain(backlog=True, phase="drain")

        self.assertEqual(self.posted, [], "5 unattended ticks, zero lane time")
        self.assertEqual(pending.count(), 1, "and the memory is still there")

    # ── the ceiling ───────────────────────────────────────────────────

    def test_the_default_ceiling_is_a_multiple_of_the_attempt_budget(self):
        self.assertEqual(
            drain_pending._attempt_ceiling(),
            pending.MAX_ATTEMPTS * drain_pending.ATTEMPT_CEILING_MULTIPLE,
        )
        self.assertGreater(
            drain_pending._attempt_ceiling(),
            pending.MAX_ATTEMPTS,
            "parking at the attempt budget would collide with demotion",
        )

    def test_the_ceiling_is_operator_tunable(self):
        os.environ["HINDSIGHT_DRAIN_ATTEMPT_CEILING"] = "7"
        self.assertEqual(drain_pending._attempt_ceiling(), 7)
        self._seed({"wedged": 7, "healthy": 6})

        summary, _ = self._drain(backlog=True, phase="drain")

        self.assertEqual(self.posted, ["healthy"])
        self.assertEqual(summary["parked"], 1)

    def test_a_ceiling_below_the_attempt_budget_is_clamped_up(self):
        """Below ``MAX_ATTEMPTS`` the breaker would park entries before the
        ordinary retry policy has finished with them."""
        os.environ["HINDSIGHT_DRAIN_ATTEMPT_CEILING"] = "1"
        self.assertEqual(drain_pending._attempt_ceiling(), pending.MAX_ATTEMPTS)

    def test_a_garbage_ceiling_falls_back_to_the_default(self):
        os.environ["HINDSIGHT_DRAIN_ATTEMPT_CEILING"] = "not-a-number"
        self.assertEqual(
            drain_pending._attempt_ceiling(),
            pending.MAX_ATTEMPTS * drain_pending.ATTEMPT_CEILING_MULTIPLE,
        )

    def test_a_corrupt_attempt_counter_never_parks_and_never_raises(self):
        """Same rule as ``_over_budget``: a hand-edited counter must not
        decide policy, and must not blow up the drain path."""
        self.assertFalse(drain_pending._circuit_broken({"attempt_count": "many"}))
        self.assertFalse(drain_pending._circuit_broken({"attempt_count": None}))
        self.assertFalse(drain_pending._circuit_broken({}))

    # ── reporting: parking must be VISIBLE, on every path ─────────────

    def _main(self, argv, present=False):
        """Run the CLI entrypoint, capturing what an operator would see."""
        with unittest.mock.patch.object(drain_pending, "load_config", lambda: CONFIG):
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", self._record_post
            ):
                with unittest.mock.patch.object(
                    drain_pending, "_document_state", lambda e, timeout=30: present
                ):
                    with redirect_stderr(io.StringIO()) as err:
                        rc = drain_pending.main(argv)
        return rc, err.getvalue()

    def test_an_in_hook_run_that_only_parks_still_says_so(self):
        """THE OBSERVABILITY HOLE THE CIRCUIT BREAKER OPENS.

        A run whose entire queue is past the ceiling parks everything and
        does nothing else, so every other summary counter is 0. With
        ``parked`` missing from ``main()``'s gate that run printed NOTHING —
        rc=0, empty stdout, empty stderr — which is byte-identical to "the
        queue was empty". The operator watching a queue that will not shrink
        then has no way to tell "parked by the breaker, needs ``--force``"
        from "ordinary backlog, drains on its own", because ``switchroom
        doctor`` reads only the queue DIRECTORY and both look like a file.

        The ``--backlog`` path narrates its own parking. This is the IN-HOOK
        path, which is the one that runs on every session boot.
        """
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"a": ceiling, "b": ceiling, "c": ceiling})

        rc, err = self._main([])

        self.assertEqual(rc, 0)
        self.assertEqual(self.posted, [], "nothing was retried — all parked")
        self.assertNotEqual(
            err.strip(), "", "a run that parked the whole queue must not be silent"
        )
        self.assertIn("parked=3", err)

    def test_the_summary_line_reports_parked_alongside_other_work(self):
        """The gate is not the only half. With ``parked`` in the gate but
        absent from the printed line, a mixed run opens the gate on its other
        counters and still never names the parked entries."""
        ceiling = drain_pending._attempt_ceiling()
        self._seed({"wedged": ceiling, "healthy": 1})

        rc, err = self._main([], present=True)

        self.assertEqual(rc, 0)
        self.assertIn("reconciled=1", err)
        self.assertIn("parked=1", err)


class CeilingArithmeticTest(_QueueTempDirMixin, unittest.TestCase):
    """How long 20 attempts actually buys — measured, not asserted in prose.

    ``ATTEMPT_CEILING_MULTIPLE``'s comment used to claim 20 attempts was
    "most of a day … far past any transient upstream outage". It is not, and
    the reason is the non-obvious part: attempts convert to wall-clock only
    via the QUEUE SIZE. A drain run attempts each live entry at most once and
    ``enqueue`` already records attempt 1, so the floor is 19 further runs —
    under 5 hours at the sidecar's 900s cooldown. ``STALL_THRESHOLD`` only
    rations attempts while entries are inside ``MAX_ATTEMPTS``; past it they
    abstain from the stall guard, so a uniformly over-budget queue is
    attempted in full on every run.

    This measures the real figures and pins the comment's table to them, so
    the prose cannot drift away from the code again: change the mechanism and
    the measured column moves; delete the table and the parse fails.
    """

    ENV_KEYS = _QueueTempDirMixin.ENV_KEYS + ("HINDSIGHT_DRAIN_ATTEMPT_CEILING",)

    #: Rows the module comment must carry: queue size → drain runs until the
    #: WHOLE queue is parked, under a total upstream outage.
    SIZES = (1, 4, 13, 30)

    #: The sidecar's default cooldown (``profiles/_base/start.sh.hbs``); the
    #: comment's hours column is runs x this.
    COOLDOWN_S = 900

    def setUp(self):
        super().setUp()
        os.environ.pop("HINDSIGHT_DRAIN_ATTEMPT_CEILING", None)
        # No p95 backoff, no pacing: this test counts RUNS, not seconds.
        os.environ.pop("HINDSIGHT_DRAIN_P95_CMD", None)

    def _runs_until_wholly_parked(self, n: int) -> int:
        # Own queue dir per call, so several sizes can be measured in one
        # test without one size's entries contaminating the next. The mixin
        # owns HINDSIGHT_PENDING_DIR and restores it in tearDown; the
        # directory itself lives under the mixin's tmp root and goes with it.
        os.environ["HINDSIGHT_PENDING_DIR"] = os.path.join(
            self._tmp, f"pending-retains-{n}"
        )
        clock = iter(1000.0 + i for i in range(n + 10))
        with unittest.mock.patch.object(pending.time, "time", lambda: next(clock)):
            for i in range(n):
                pending.enqueue(
                    _payload(content=f"e{i}", doc=_cd_doc(i)),
                    ConnectionError("upstream down"),
                )

        def always_fails(entry, timeout=30):
            raise ConnectionError("upstream down")

        runs = 0
        # Generous ceiling on the loop itself: a mechanism change that made
        # parking unreachable must fail loudly rather than hang CI.
        while runs < 500:
            runs += 1
            with unittest.mock.patch.object(
                drain_pending, "_retry_one", always_fails
            ):
                with unittest.mock.patch.object(
                    drain_pending, "_document_state", lambda e, timeout=30: False
                ):
                    with redirect_stderr(io.StringIO()):
                        summary = drain_pending.drain(
                            CONFIG, backlog=True, phase="drain"
                        )
            if summary["parked"] == n:
                return runs
        self.fail(f"a {n}-entry queue never parked wholly within 500 runs")

    def _documented_table(self) -> dict:
        """Parse the table out of ``ATTEMPT_CEILING_MULTIPLE``'s comment."""
        with open(drain_pending.__file__, encoding="utf-8") as f:
            src = f.read()
        rows = re.findall(r"^#: (\d+)\s+(\d+)\s+([\d.]+) h$", src, re.M)
        return {int(q): (int(r), float(h)) for q, r, h in rows}

    def test_the_documented_table_is_what_the_code_actually_does(self):
        documented = self._documented_table()
        self.assertEqual(
            sorted(documented),
            sorted(self.SIZES),
            "ATTEMPT_CEILING_MULTIPLE's comment must document exactly these "
            "queue sizes — the prose is the deliverable here",
        )
        for n in self.SIZES:
            with self.subTest(queue=n):
                measured = self._runs_until_wholly_parked(n)
                runs, hours = documented[n]
                self.assertEqual(
                    measured,
                    runs,
                    f"a {n}-entry queue parks wholly in {measured} runs, but "
                    f"the comment says {runs}",
                )
                self.assertAlmostEqual(
                    hours, runs * self.COOLDOWN_S / 3600.0, places=1
                )

    def test_a_small_queue_parks_well_inside_one_overnight_outage(self):
        """The claim the old comment made, stated as the outcome it is not.

        4 entries — a healthy agent — park entirely in 6 hours. So a single
        overnight upstream outage CAN park a small queue wholesale, which is
        exactly what "far past any transient upstream outage" denied. Pinned
        as an outcome so nobody re-asserts the denial.
        """
        measured = self._runs_until_wholly_parked(4)
        hours = measured * self.COOLDOWN_S / 3600.0
        self.assertLess(
            hours,
            12.0,
            "a 4-entry queue parking in under 12h is the accepted trade — if "
            "this ever became untrue the comment must be re-measured too",
        )


if __name__ == "__main__":
    unittest.main()
