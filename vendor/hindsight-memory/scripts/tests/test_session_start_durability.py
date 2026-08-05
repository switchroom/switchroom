"""The SessionStart hook must still DO its durability work.

The hook was made ``"async": true`` (hooks/hooks.json) so a stacked
drain + reconcile + health-probe budget can no longer overrun the
SessionStart timeout and get the process SIGKILLed mid-drain. Async only
helps if the two durability calls are still MADE on the healthy path —
if a refactor drops one, the queue silently stops draining and abrupt-kill
turns stop being recovered, which is the exact outage the hook exists to
prevent and which no attachment record would surface (a successful
SessionStart hook that injects no context leaves no transcript trace).

So this pins the OUTCOME, not the wiring: on a reachable server,
``session_start.main()`` invokes ``drain_pending.drain`` and then
``reconcile_tail.reconcile``, in that order (reconcile runs AFTER the
drain by design — it recovers what SessionEnd never managed to enqueue).

Lives under ``scripts/tests/`` because that is the only python test
directory CI discovers (``ci-tests-python.yml`` runs ``unittest discover``
from ``vendor/hindsight-memory/scripts``).
"""

import io
import os
import sys
import unittest
import unittest.mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import reconcile_tail  # noqa: E402
import session_start  # noqa: E402


class _ReachableClient:
    """Stand-in for HindsightClient — reachable, no network."""

    def __init__(self, *_a, **_kw):
        pass

    def health_check(self, timeout=5, retries=3):
        return True


class DurabilityWorkStillRunsTest(unittest.TestCase):
    CONFIG = {"autoRetain": True, "autoRecall": True}

    def _run_main(self, config=None):
        """Run ``session_start.main()`` against a reachable server with the
        two durability calls stubbed, returning the ordered call log."""
        calls = []

        def fake_drain(cfg):
            calls.append("drain")

        def fake_reconcile(cfg, hook_input=None):
            calls.append("reconcile")

        cfg = dict(self.CONFIG if config is None else config)
        with unittest.mock.patch.object(drain_pending, "drain", fake_drain), \
            unittest.mock.patch.object(reconcile_tail, "reconcile", fake_reconcile), \
            unittest.mock.patch.object(session_start, "load_config", lambda: cfg), \
            unittest.mock.patch.object(
                session_start,
                "get_api_url",
                lambda c, debug_fn=None, allow_daemon_start=True: (
                    "http://127.0.0.1:9/none"
                ),
            ), \
            unittest.mock.patch.object(
                session_start, "HindsightClient", _ReachableClient
            ), \
            unittest.mock.patch.object(sys, "stdin", io.StringIO("{}")):
            session_start.main()
        return calls

    def test_drain_and_reconcile_both_run_on_a_reachable_server(self):
        calls = self._run_main()
        self.assertIn("drain", calls, "queued retains must still be drained")
        self.assertIn(
            "reconcile",
            calls,
            "un-committed abrupt-kill turns must still be reconciled",
        )

    def test_reconcile_runs_after_the_drain(self):
        calls = self._run_main()
        self.assertEqual(
            calls,
            ["drain", "reconcile"],
            "reconcile recovers what SessionEnd never enqueued, so it must "
            "run AFTER the drain replays what it did",
        )

    def test_disabled_memory_skips_both(self):
        """The control case: with both autoRecall and autoRetain off, the
        hook returns before touching the durability path. Without this the
        assertions above could be satisfied by calls that fire
        unconditionally."""
        calls = self._run_main(config={"autoRetain": False, "autoRecall": False})
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
