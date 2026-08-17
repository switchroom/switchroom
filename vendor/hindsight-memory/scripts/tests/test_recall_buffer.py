"""M4 P0 — buffer + sentinel primitive, OUTCOME tests (RED test a).

The sentinel/poll race is the whole safety story for M4's prefetch producer
(carve §4 note 1, red-team-verified sound). This module is the FOUNDATION
every other M4 packet depends on: P-REC's join logic and P-PRE's producer
both build on the read-after-write guarantee proven here.

Contract under test:
  (i)   ``buffer.done`` is written strictly AFTER the buffer payload
        (mtime/content ordering — proven via a monotonic token, not wall
        clock, since two writes can land in the same clock tick).
  (ii)  ``read_if_fresh(last_consumed_token)`` returns ``(None, token)``
        when the sentinel is absent, or not newer than ``last_consumed``.
  (iii) A torn write (payload present, sentinel absent) reads as ``None``
        — fail-closed, never a stale/malformed payload leaking through.
  (iv)  ``poll_for_sentinel`` is clock-bounded: never exceeds its cap, no
        busy-spin (sleeps sum to <= cap, with generous tolerance).

Stdlib-only (``python3 -m unittest discover tests/``).
"""

import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib import recall_buffer  # noqa: E402


class RecallBufferBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-m4-buffer-")
        self.env = mock.patch.dict(
            os.environ, {"HINDSIGHT_PREFETCH_BUFFER_DIR": self.tmp}, clear=False
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestSentinelOrdering(RecallBufferBase):
    def test_sentinel_written_strictly_after_payload(self):
        session = "sess-order"
        write_order = []
        real_replace = os.replace

        def _spy_replace(src, dst):
            write_order.append(os.path.basename(dst))
            return real_replace(src, dst)

        with mock.patch("os.replace", side_effect=_spy_replace):
            recall_buffer.write_buffer(session, "<hindsight_memories>x</hindsight_memories>", {"k": "v"})
            recall_buffer.write_sentinel(session)

        buffer_writes = [w for w in write_order if "buffer.json" in w]
        sentinel_writes = [w for w in write_order if "buffer.done" in w]
        self.assertEqual(len(buffer_writes), 1)
        self.assertEqual(len(sentinel_writes), 1)
        self.assertLess(
            write_order.index(buffer_writes[0]),
            write_order.index(sentinel_writes[0]),
            "sentinel must be written strictly AFTER the buffer payload",
        )

    def test_read_if_fresh_returns_none_when_sentinel_absent(self):
        session = "sess-nosentinel"
        recall_buffer.write_buffer(session, "content", {})
        ctx, token = recall_buffer.read_if_fresh(session, last_consumed_token=None)
        self.assertIsNone(ctx)

    def test_read_if_fresh_returns_none_when_sentinel_not_newer(self):
        session = "sess-stale"
        recall_buffer.write_buffer(session, "content", {})
        token = recall_buffer.write_sentinel(session)
        # Already consumed this exact token -> not fresh.
        ctx, new_token = recall_buffer.read_if_fresh(session, last_consumed_token=token)
        self.assertIsNone(ctx)
        self.assertEqual(new_token, token)

    def test_read_if_fresh_returns_payload_when_sentinel_is_newer(self):
        session = "sess-fresh"
        recall_buffer.write_buffer(session, "<hindsight_memories>fact</hindsight_memories>", {"telemetry": 1})
        token = recall_buffer.write_sentinel(session)
        ctx, new_token = recall_buffer.read_if_fresh(session, last_consumed_token=None)
        self.assertIsNotNone(ctx)
        self.assertIn("fact", ctx["context"])
        self.assertEqual(ctx["telemetry"], {"telemetry": 1})
        self.assertEqual(new_token, token)

    def test_torn_write_payload_present_sentinel_absent_reads_as_none(self):
        # Simulate a crash between write_buffer() and write_sentinel(): the
        # payload landed, the sentinel never did. Must fail-closed to None,
        # NEVER read the torn/possibly-incomplete payload as fresh.
        session = "sess-torn"
        recall_buffer.write_buffer(session, "<hindsight_memories>partial</hindsight_memories>", {})
        # No write_sentinel() call — this IS the torn state.
        ctx, token = recall_buffer.read_if_fresh(session, last_consumed_token=None)
        self.assertIsNone(ctx, "torn write (payload without sentinel) must read as None, fail-closed")


class TestPollCap(RecallBufferBase):
    def test_poll_returns_true_when_sentinel_appears(self):
        session = "sess-poll-hit"
        recall_buffer.write_buffer(session, "content", {})
        recall_buffer.write_sentinel(session)
        found = recall_buffer.poll_for_sentinel(session, last_consumed_token=None, cap_ms=500)
        self.assertTrue(found)

    def test_poll_never_exceeds_cap(self):
        # No sentinel ever appears — poll must give up within cap_ms
        # (generous tolerance for test-host scheduling jitter).
        session = "sess-poll-miss"
        cap_ms = 200
        start = time.monotonic()
        found = recall_buffer.poll_for_sentinel(session, last_consumed_token=None, cap_ms=cap_ms)
        elapsed_ms = (time.monotonic() - start) * 1000
        self.assertFalse(found)
        self.assertLess(elapsed_ms, cap_ms + 150, "poll exceeded its cap by more than tolerance")

    def test_poll_does_not_busy_spin(self):
        # A busy-spin would burn far more than a handful of read attempts in
        # the cap window; assert sleep is actually happening by checking the
        # elapsed time is close to (not far below) the cap when nothing
        # ever shows up.
        session = "sess-poll-nospin"
        cap_ms = 150
        start = time.monotonic()
        recall_buffer.poll_for_sentinel(session, last_consumed_token=None, cap_ms=cap_ms)
        elapsed_ms = (time.monotonic() - start) * 1000
        self.assertGreaterEqual(elapsed_ms, cap_ms * 0.5, "poll returned suspiciously fast — looks like it skipped sleeping")


if __name__ == "__main__":
    unittest.main()
