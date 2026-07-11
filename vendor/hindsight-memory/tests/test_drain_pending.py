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


def _seed_entry(pending_dir: str, document_id: str = "doc-x", attempt: int = 1) -> str:
    os.makedirs(pending_dir, mode=0o700, exist_ok=True)
    ts_ms = int(time.time() * 1000)
    name = f"{ts_ms}-{document_id}.json"
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

    def test_drain_empty_queue_is_noop(self):
        import drain_pending

        summary = drain_pending.drain({})
        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["retried"], 0)
        self.assertEqual(summary["dead"], 0)
        self.assertFalse(summary["stalled"])
        self.assertFalse(summary["budget_exceeded"])

    def test_drain_success_deletes_entry(self):
        path = _seed_entry(self._pending)
        import drain_pending

        with patch("urllib.request.urlopen", return_value=FakeOk()):
            summary = drain_pending.drain({})
        self.assertEqual(summary["drained"], 1)
        self.assertEqual(summary["retried"], 0)
        self.assertFalse(os.path.exists(path))

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

        with patch("urllib.request.urlopen", side_effect=maybe_ok):
            summary = drain_pending.drain({})

        self.assertEqual(summary["drained"], 2)
        self.assertEqual(summary["retried"], 1)


if __name__ == "__main__":
    unittest.main()
