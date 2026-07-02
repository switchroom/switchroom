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


class SplitTextTests(unittest.TestCase):
    def test_empty_and_whitespace(self) -> None:
        self.assertEqual(server._split_text("", 100), [])
        self.assertEqual(server._split_text("   \n  ", 100), [])

    def test_short_text_single_piece(self) -> None:
        self.assertEqual(server._split_text("hello world", 100), ["hello world"])

    def test_every_piece_within_cap(self) -> None:
        text = (
            "First sentence here. Second sentence follows. Third one too! "
            "And a fourth? Yes indeed, a fifth as well."
        )
        pieces = server._split_text(text, 30)
        self.assertTrue(pieces)
        for p in pieces:
            self.assertLessEqual(len(p), 30, msg=f"piece over cap: {p!r}")
            self.assertTrue(p.strip(), msg="empty piece emitted")

    def test_splits_on_sentence_boundaries(self) -> None:
        text = "One. Two. Three. Four."
        pieces = server._split_text(text, 8)
        self.assertGreater(len(pieces), 1)
        # Reassembling the words preserves content (order + tokens).
        self.assertEqual(
            " ".join(pieces).split(),
            text.split(),
        )

    def test_single_token_longer_than_max_emitted_whole(self) -> None:
        # A single unbroken token longer than max_chars is emitted whole
        # rather than sliced mid-character (documented contract).
        big = "x" * 50
        pieces = server._split_text(big, 10)
        self.assertEqual(pieces, [big])

    def test_long_word_run_breaks_on_whitespace(self) -> None:
        # A long run of words (one "unit", no sentence punctuation) is broken
        # on whitespace so no piece exceeds the cap, but individual words that
        # fit are never sliced.
        words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
        text = " ".join(words)  # > cap, no sentence boundary
        pieces = server._split_text(text, 12)
        for p in pieces:
            self.assertLessEqual(len(p), 12, msg=f"piece over cap: {p!r}")
        self.assertEqual(" ".join(pieces).split(), words)

    def test_paragraph_boundary_split(self) -> None:
        text = "Para one is here.\n\nPara two is also here and longer."
        pieces = server._split_text(text, 25)
        for p in pieces:
            self.assertLessEqual(len(p), 25)
        self.assertTrue(len(pieces) >= 2)


class ParseMultipartTests(unittest.TestCase):
    @staticmethod
    def _build(boundary: str, parts: list[tuple[str, bytes]]) -> bytes:
        delim = ("--" + boundary).encode()
        chunks = []
        for disp, data in parts:
            chunks.append(delim + b"\r\n")
            chunks.append(
                f'Content-Disposition: form-data; {disp}\r\n\r\n'.encode()
            )
            chunks.append(data + b"\r\n")
        chunks.append(delim + b"--\r\n")
        return b"".join(chunks)

    def test_non_multipart_content_type(self) -> None:
        self.assertEqual(
            server._parse_multipart(b"whatever", "application/json"),
            (None, None),
        )

    def test_missing_boundary(self) -> None:
        self.assertEqual(
            server._parse_multipart(b"x", "multipart/form-data"),
            (None, None),
        )

    def test_extracts_audio_and_language(self) -> None:
        boundary = "BOUNDARY123"
        body = self._build(
            boundary,
            [
                ('name="audio"; filename="a.ogg"', b"\x00\x01\x02rawaudio"),
                ('name="language"', b"en"),
            ],
        )
        audio, language = server._parse_multipart(
            body, f"multipart/form-data; boundary={boundary}"
        )
        self.assertEqual(audio, b"\x00\x01\x02rawaudio")
        self.assertEqual(language, "en")

    def test_audio_only_language_none(self) -> None:
        boundary = "b2"
        body = self._build(boundary, [('name="audio"', b"bytes")])
        audio, language = server._parse_multipart(
            body, f"multipart/form-data; boundary={boundary}"
        )
        self.assertEqual(audio, b"bytes")
        self.assertIsNone(language)

    def test_quoted_boundary(self) -> None:
        boundary = "quoted-b"
        body = self._build(boundary, [('name="audio"', b"q")])
        audio, _ = server._parse_multipart(
            body, f'multipart/form-data; boundary="{boundary}"'
        )
        self.assertEqual(audio, b"q")


class _FakeAuthHandler:
    """A minimal stand-in exercising server.Handler._authed without opening a
    real socket. Records the JSON status the handler would send on failure."""

    def __init__(self, token_header: str | None) -> None:
        self._headers = {} if token_header is None else {"X-Voice-Token": token_header}
        self.sent: tuple[int, dict] | None = None

    # Matches BaseHTTPRequestHandler.headers.get(name, default) shape.
    class _Headers:
        def __init__(self, d: dict) -> None:
            self._d = d

        def get(self, name: str, default: str = "") -> str:
            return self._d.get(name, default)

    @property
    def headers(self):  # noqa: ANN201
        return self._Headers(self._headers)

    def _send_json(self, status: int, body: dict) -> None:
        self.sent = (status, body)


class AuthedTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = server.SHARED_TOKEN

    def tearDown(self) -> None:
        server.SHARED_TOKEN = self._orig

    def _authed(self, configured: str, presented: str | None) -> bool:
        server.SHARED_TOKEN = configured
        h = _FakeAuthHandler(presented)
        return server.Handler._authed(h)

    def test_empty_configured_token_fails_closed(self) -> None:
        # No token configured → EVERY call is rejected, even a matching header.
        self.assertFalse(self._authed("", None))
        self.assertFalse(self._authed("", ""))
        self.assertFalse(self._authed("", "anything"))

    def test_correct_token_authorizes(self) -> None:
        self.assertTrue(self._authed("s3cret", "s3cret"))

    def test_wrong_token_rejected(self) -> None:
        self.assertFalse(self._authed("s3cret", "nope"))

    def test_missing_header_rejected(self) -> None:
        self.assertFalse(self._authed("s3cret", None))

    def test_rejection_sends_401(self) -> None:
        server.SHARED_TOKEN = "s3cret"
        h = _FakeAuthHandler("wrong")
        server.Handler._authed(h)
        self.assertIsNotNone(h.sent)
        self.assertEqual(h.sent[0], 401)

    def test_uses_constant_time_compare(self) -> None:
        # Guard against regressing to a plain `==` compare — the source must
        # route the secret comparison through hmac.compare_digest.
        import inspect

        src = inspect.getsource(server.Handler._authed)
        self.assertIn("compare_digest", src)


class WatchdogTests(unittest.TestCase):
    def setUp(self) -> None:
        # Isolate global watchdog state per test.
        self._orig_max = server.VOICE_WATCHDOG_MAX_TIMEOUTS
        server.VOICE_WATCHDOG_MAX_TIMEOUTS = 3
        with server._watchdog_lock:
            server._consecutive_timeouts = 0
            server._wedged = False

    def tearDown(self) -> None:
        server.VOICE_WATCHDOG_MAX_TIMEOUTS = self._orig_max
        with server._watchdog_lock:
            server._consecutive_timeouts = 0
            server._wedged = False

    def test_wedges_after_threshold_consecutive_timeouts(self) -> None:
        self.assertFalse(server._is_wedged())
        server._note_timeout()
        server._note_timeout()
        self.assertFalse(server._is_wedged())
        server._note_timeout()  # 3rd hits threshold
        self.assertTrue(server._is_wedged())

    def test_success_resets_counter(self) -> None:
        server._note_timeout()
        server._note_timeout()
        server._note_success()  # reset
        server._note_timeout()
        server._note_timeout()
        self.assertFalse(server._is_wedged())  # only 2 since reset
        server._note_timeout()
        self.assertTrue(server._is_wedged())

    def test_wedge_is_sticky_across_success(self) -> None:
        for _ in range(3):
            server._note_timeout()
        self.assertTrue(server._is_wedged())
        # A late success does NOT un-wedge — we let the restart happen.
        server._note_success()
        self.assertTrue(server._is_wedged())


if __name__ == "__main__":
    unittest.main()
