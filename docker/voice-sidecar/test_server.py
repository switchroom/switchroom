"""Unit tests for the voice sidecar's TTS speed clamp (server._clamp_speed).

The sidecar accepts an optional `speed` in the /tts JSON body, clamps it to
[0.5, 2.0], and defaults to 1.0 when absent/invalid (exactly today's
behavior). These tests pin that contract. server.py imports kokoro lazily
(inside the synth functions), so it imports cleanly without the ONNX runtime
installed — no model needed to exercise the clamp.

Run: python3 -m unittest discover -s docker/voice-sidecar -p 'test_*.py'
"""

from __future__ import annotations

import unittest

import server


class ClampSpeedTests(unittest.TestCase):
    def test_default_when_absent_or_invalid(self) -> None:
        # None / non-numeric / bool / NaN → 1.0 (today's default).
        for bad in (None, "1.2", "fast", True, False, [], {}, float("nan")):
            self.assertEqual(
                server._clamp_speed(bad), 1.0, msg=f"input={bad!r}"
            )

    def test_in_range_passthrough(self) -> None:
        for v in (0.5, 0.75, 1.0, 1.1, 1.5, 2.0):
            self.assertEqual(server._clamp_speed(v), v, msg=f"input={v!r}")

    def test_clamps_below_min(self) -> None:
        self.assertEqual(server._clamp_speed(0.1), 0.5)
        self.assertEqual(server._clamp_speed(-3.0), 0.5)
        self.assertEqual(server._clamp_speed(0), 0.5)

    def test_clamps_above_max(self) -> None:
        self.assertEqual(server._clamp_speed(2.5), 2.0)
        self.assertEqual(server._clamp_speed(100), 2.0)

    def test_int_is_accepted(self) -> None:
        self.assertEqual(server._clamp_speed(1), 1.0)
        self.assertEqual(server._clamp_speed(2), 2.0)

    def test_bounds_constants(self) -> None:
        self.assertEqual(server.TTS_SPEED_MIN, 0.5)
        self.assertEqual(server.TTS_SPEED_MAX, 2.0)
        self.assertEqual(server.TTS_SPEED_DEFAULT, 1.0)


if __name__ == "__main__":
    unittest.main()
