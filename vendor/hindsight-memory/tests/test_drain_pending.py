"""Tests for drain_pending.drain() (#1071)."""

import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


class FakeOk:
    """Minimal urlopen() context-manager stand-in for a 200 OK."""

    status = 200

    def __init__(self, body: bytes = b'{"ok": true}'):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


#: A POST-#3244 content-derived document_id (``retain.slice_document_id``):
#: ``{session}-r{start_uuid}-{end_uuid}``. The presence-GET reconcile is gated
#: on this shape — a pre-#3244 bare session id is answered 200 by ANY retain in
#: that session — so the id shape is load-bearing in every drain fixture here.
CONTENT_DERIVED_DOC_ID = (
    "11111111-2222-4333-8444-555555555555"
    "-r00000000-0000-4000-8000-000000000001"
    "-00000000-0000-4000-8000-000000000002"
)


def _seed_entry(
    pending_dir: str, document_id: str = CONTENT_DERIVED_DOC_ID, attempt: int = 1
) -> str:
    os.makedirs(pending_dir, mode=0o700, exist_ok=True)
    ts_ms = int(time.time() * 1000)
    name = f"{ts_ms}-{document_id[:24]}.json"
    path = os.path.join(pending_dir, name)
    payload = {
        "schema": 1,
        "api_url": "http://fake:9077",
        "api_token": None,
        "bank_id": "bank-1",
        "content": "user: hi\nassistant: hi back",
        "document_id": document_id,
        "context": "claude-code",
        "metadata": {},
        "tags": None,
        "failed_at": "2026-05-12T00:00:00Z",
        "error_class": "URLError",
        "error_message": "Connection refused",
        "attempt_count": attempt,
    }
    with open(path, "w") as f:
        json.dump(payload, f)
    return path


class DrainPendingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="hindsight-drain-test-")
        self._pending = os.path.join(self._tmp, "pending-retains")
        # Each test resets modules so module-level config caching can't
        # bleed across.
        for n in ("drain_pending", "lib.pending"):
            sys.modules.pop(n, None)
        self._env = patch.dict(
            os.environ,
            {
                "HINDSIGHT_PENDING_DIR": self._pending,
                "HINDSIGHT_DRAIN_TIMEOUT": "2",
                "HINDSIGHT_DRAIN_BUDGET_S": "60",
            },
            clear=False,
        )
        self._env.start()

    def tearDown(self):
        self._env.stop()
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)
        for n in ("drain_pending", "lib.pending"):
            sys.modules.pop(n, None)

    def _reconciled(self):
        """Basenames archived under ``pending-reconciled/`` (sibling dir)."""
        import lib.pending as pending

        try:
            return sorted(os.listdir(pending.reconciled_dir()))
        except OSError:
            return []

    def test_drain_empty_queue_is_noop(self):
        import drain_pending

        summary = drain_pending.drain({})
        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["retried"], 0)
        self.assertEqual(summary["dead"], 0)
        self.assertFalse(summary["stalled"])
        self.assertFalse(summary["budget_exceeded"])

    def test_drain_reconciles_an_already_durable_entry_without_posting(self):
        """switchroom #3596: GET before POST, in the SessionStart path too.

        This test used to assert `drained == 1` against a mock that answered
        200 to EVERYTHING, including the presence GET — i.e. it asserted
        that an already-durable document gets re-POSTed anyway. That is the
        re-post loop: the hook's clamped timeout guarantees the client gives
        up, so the entry survives and is re-posted on every boot forever
        while the memory was never actually lost.
        """
        path = _seed_entry(self._pending)
        import drain_pending

        posts = []

        def record(req, *a, **kw):
            posts.append(getattr(req, "method", None) or req.get_method())
            return FakeOk()

        with patch("urllib.request.urlopen", side_effect=record):
            summary = drain_pending.drain({})
        self.assertEqual(summary["reconciled"], 1)
        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["retried"], 0)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self._reconciled(), [os.path.basename(path)])
        self.assertEqual(posts, ["GET"], "no retain POST for a durable document")

    def test_drain_refuses_to_reconcile_a_pre_3244_bare_session_id(self):
        """A bare session id's 200 is not evidence about THIS entry.

        The bank answers 200 for a bare session id after any successful
        retain in that session, so reconciling on presence would retire an
        entry whose own content was never committed.
        """
        path = _seed_entry(
            self._pending, document_id="d52ae253-2d26-42e5-a86b-9a354cc0ace5"
        )
        import drain_pending

        methods = []

        def record(req, *a, **kw):
            methods.append(getattr(req, "method", None) or req.get_method())
            raise urllib.error.URLError("upstream down")

        with patch("urllib.request.urlopen", side_effect=record):
            summary = drain_pending.drain({})

        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(methods, ["POST"], "no free-pass GET for a bare session id")
        self.assertTrue(os.path.exists(path), "entry stays queued")
        self.assertEqual(self._reconciled(), [])

    def test_drain_success_archives_the_entry(self):
        """A genuinely absent document is POSTed and the entry RETIRED.

        Retired means moved into ``pending-reconciled/``, not ``os.remove``d:
        this in-hook path retires on the POST's own commit-before-ack 200
        (``async_processing=False``, no confirming GET) — the daemon's word
        about itself, not an independent read (#3244) — so the removal must
        stay recoverable.
        """
        path = _seed_entry(self._pending)
        import drain_pending

        with patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: False
        ):
            with patch("urllib.request.urlopen", return_value=FakeOk()):
                summary = drain_pending.drain({})
        self.assertEqual(summary["drained"], 1)
        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(summary["retried"], 0)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self._reconciled(), [os.path.basename(path)])

    def test_drain_failure_bumps_attempt_count(self):
        path = _seed_entry(self._pending, attempt=1)
        import drain_pending

        def boom(*a, **kw):
            raise urllib.error.URLError("still down")

        with patch("urllib.request.urlopen", side_effect=boom):
            summary = drain_pending.drain({})
        # Single entry → consecutive_failures hits 1, threshold is 3,
        # so we don't stall — but we only had one entry to try.
        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["retried"], 1)
        self.assertTrue(os.path.exists(path))
        with open(path) as f:
            entry = json.load(f)
        self.assertEqual(entry["attempt_count"], 2)
        self.assertIn("last_attempt_at", entry)

    def test_drain_max_attempts_marks_dead(self):
        from lib.pending import MAX_ATTEMPTS

        path = _seed_entry(self._pending, attempt=MAX_ATTEMPTS)
        import drain_pending

        def boom(*a, **kw):
            raise urllib.error.URLError("still down")

        with patch("urllib.request.urlopen", side_effect=boom):
            summary = drain_pending.drain({})
        self.assertEqual(summary["dead"], 1)
        self.assertFalse(os.path.exists(path))
        self.assertTrue(os.path.exists(path + ".dead"))

    def test_drain_stall_guard_stops_after_threshold(self):
        # Seed 10 entries; with a same-error-class stream, the stall
        # guard should trip at STALL_THRESHOLD (3) and leave the rest.
        from drain_pending import STALL_THRESHOLD

        for i in range(10):
            _seed_entry(self._pending, document_id=f"doc-{i:02d}")

        import drain_pending

        def boom(*a, **kw):
            raise urllib.error.URLError("permanent")

        with patch("urllib.request.urlopen", side_effect=boom):
            summary = drain_pending.drain({})

        self.assertTrue(summary["stalled"])
        self.assertEqual(summary["retried"], STALL_THRESHOLD)
        self.assertEqual(summary["drained"], 0)
        # 10 - STALL_THRESHOLD entries should remain untouched (still
        # at attempt_count == 1)
        remaining = [n for n in os.listdir(self._pending) if n.endswith(".json")]
        self.assertEqual(len(remaining), 10)

    def test_per_entry_timeout_clamped_to_remaining_budget(self):
        # #1094 item 2: default HINDSIGHT_DRAIN_TIMEOUT (5) exceeds the
        # budget (4 here), so the effective per-entry timeout must be
        # clamped DOWN to the remaining budget — never the raw 5s.
        self._env.stop()
        self._env = patch.dict(
            os.environ,
            {
                "HINDSIGHT_PENDING_DIR": self._pending,
                "HINDSIGHT_DRAIN_TIMEOUT": "5",
                "HINDSIGHT_DRAIN_BUDGET_S": "4",
            },
            clear=False,
        )
        self._env.start()

        _seed_entry(self._pending)
        import drain_pending

        seen = {"timeout": None}

        def capture(*a, **kw):
            seen["timeout"] = kw.get("timeout")
            raise urllib.error.URLError("down")

        with patch("urllib.request.urlopen", side_effect=capture):
            drain_pending.drain({})

        self.assertIsNotNone(seen["timeout"])
        # Clamped to the ~4s budget remaining, not the raw 5s timeout.
        self.assertLessEqual(seen["timeout"], 4)
        self.assertGreaterEqual(seen["timeout"], 1)

    def test_slow_entry_cannot_overshoot_budget_beyond_clamp_floor(self):
        # A single slow entry must not blow the wall-clock budget by
        # HINDSIGHT_DRAIN_TIMEOUT - budget. With the clamp, overshoot is
        # bounded by the 1s clamp floor (+ scheduling epsilon).
        self._env.stop()
        self._env = patch.dict(
            os.environ,
            {
                "HINDSIGHT_PENDING_DIR": self._pending,
                "HINDSIGHT_DRAIN_TIMEOUT": "5",
                "HINDSIGHT_DRAIN_BUDGET_S": "2",
            },
            clear=False,
        )
        self._env.start()

        _seed_entry(self._pending)
        import drain_pending

        def slow_then_fail(*a, **kw):
            # Sleep exactly as long as the timeout the drainer granted —
            # emulates a request that runs to its (clamped) timeout.
            time.sleep(kw.get("timeout", 5))
            raise urllib.error.URLError("timed out")

        started = time.monotonic()
        with patch("urllib.request.urlopen", side_effect=slow_then_fail):
            drain_pending.drain({})
        elapsed = time.monotonic() - started

        # Budget is 2s; clamped timeout is min(5, ~2)=2, so ~2s of sleep.
        # Without the clamp the entry would sleep the full 5s. Assert we
        # stay near the budget, well under the raw 5s timeout.
        self.assertLess(elapsed, 4.0)

    def test_drain_mixed_success_failure(self):
        # Three entries: server returns alternating ok/fail/ok.
        _seed_entry(self._pending, document_id="doc-a")
        time.sleep(0.005)
        _seed_entry(self._pending, document_id="doc-b")
        time.sleep(0.005)
        _seed_entry(self._pending, document_id="doc-c")

        call_idx = {"n": 0}

        def maybe_ok(*a, **kw):
            i = call_idx["n"]
            call_idx["n"] += 1
            if i == 1:
                raise urllib.error.URLError("middle fail")
            return FakeOk()

        import drain_pending

        # All three documents are genuinely absent, so every entry takes the
        # POST path — otherwise the presence GET would consume call slots
        # and this would be testing the reconcile phase by accident.
        with patch.object(
            drain_pending, "_document_state", lambda e, timeout=30: False
        ):
            with patch("urllib.request.urlopen", side_effect=maybe_ok):
                summary = drain_pending.drain({})

        self.assertEqual(summary["drained"], 2)
        self.assertEqual(summary["retried"], 1)
        self.assertEqual(summary["reconciled"], 0)


if __name__ == "__main__":
    unittest.main()
