"""Unit tests for the Stage B wiring inside server.py.

text_normalize.py is tested on its own (test_text_normalize.py). What is
pinned HERE is the three-way contract between the sidecar and it:

  1. _run_synthesis normalises BEFORE _split_text — so the splitter sees
     final text and a rule that lengthens a piece cannot push it past
     TTS_MAX_CHARS after the split.
  2. The pronunciation overrides reach misaki and ONLY misaki — the
     `[word](/phonemes/)` markup on the espeak fallback path would be read
     out as punctuation, and a phonemize failure must hand back the ORIGINAL
     text, never the markup.
  3. Nothing here can fail a synthesis: a normaliser fault degrades to the
     raw text (today's behaviour) and is logged once.

Runs WITHOUT onnxruntime / misaki / ffmpeg (the CI voice-sidecar job is
stdlib + num2words): numpy is faked and Kokoro is a recording stub, exactly
as in test_g2p.py.

Run: python3 -m unittest discover -s docker/voice-sidecar -p 'test_*.py'
"""

from __future__ import annotations

import sys
import types
import unittest

import server
import text_normalize as tn


class _RecordingTTS:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, text, voice=None, speed=None, lang=None, is_phonemes=False):  # noqa: ANN001
        self.calls.append({"text": text, "is_phonemes": is_phonemes})
        return ([0.0], server.TTS_SAMPLE_RATE)


def _install_fake_numpy():
    prev = sys.modules.get("numpy")
    fake = types.ModuleType("numpy")
    fake.float32 = "float32"
    fake.zeros = lambda n, dtype=None: [0.0] * int(n)
    fake.asarray = lambda x, dtype=None: list(x)
    fake.concatenate = lambda chunks: [v for c in chunks for v in c]
    sys.modules["numpy"] = fake
    return prev


class NormalizeCallSiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = (
            server._tts,
            server._g2p,
            server._pcm_to_wav_bytes,
            server._wav_to_ogg_opus,
            server._norm,
            server._norm_warned,
        )
        self._prev_numpy = _install_fake_numpy()
        server._pcm_to_wav_bytes = lambda samples, sample_rate: b"WAV"
        server._wav_to_ogg_opus = lambda wav: b"OGG"
        self.tts = _RecordingTTS()
        server._tts = self.tts
        server._g2p = None  # espeak text path: Kokoro receives the TEXT
        server._norm_warned = False

    def tearDown(self) -> None:
        (
            server._tts,
            server._g2p,
            server._pcm_to_wav_bytes,
            server._wav_to_ogg_opus,
            server._norm,
            server._norm_warned,
        ) = self._orig
        if self._prev_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self._prev_numpy

    def test_synthesis_speaks_normalised_text(self) -> None:
        # The outcome that matters: Kokoro is asked to say "ninety seconds",
        # never "90s".
        server._run_synthesis("Timeout is 90s.", voice="af_heart")
        spoken = " ".join(c["text"] for c in self.tts.calls)
        self.assertIn("ninety seconds", spoken)
        self.assertNotIn("90s", spoken)

    def test_normalisation_happens_before_splitting(self) -> None:
        # Each piece handed to Kokoro must be ≤ TTS_MAX_CHARS. Normalising
        # AFTER the split would let an expanded piece exceed it.
        long_text = ("A$7.46 for 90s of 16 m cable at 14:30 on 2026-08-14. ") * 40
        server._run_synthesis(long_text, voice="af_heart")
        self.assertGreater(len(self.tts.calls), 1)
        for call in self.tts.calls:
            self.assertLessEqual(len(call["text"]), server.TTS_MAX_CHARS)
            self.assertNotIn("$", call["text"])

    def test_normaliser_failure_degrades_to_raw_text(self) -> None:
        broken = types.SimpleNamespace(
            normalize=lambda text: (_ for _ in ()).throw(RuntimeError("boom")),
            normalize_enabled=lambda: True,
        )
        server._norm = broken
        self.assertEqual(server._normalize_text("90s"), "90s")
        self.assertTrue(server._norm_warned)
        # Logged once, still degrades on every later call.
        self.assertEqual(server._normalize_text("90s"), "90s")

    def test_missing_module_degrades_to_raw_text(self) -> None:
        server._norm = None
        self.assertEqual(server._normalize_text("90s timeout"), "90s timeout")


class OverrideWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = (server._g2p, server._tts_overrides, server._g2p_warned)
        server._g2p_warned = False
        server._tts_overrides = [tn.Override("Postgres", "pˈOstɡɹɛs", True, None)]

    def tearDown(self) -> None:
        server._g2p, server._tts_overrides, server._g2p_warned = self._orig

    def test_overrides_reach_misaki(self) -> None:
        seen: list[str] = []

        def fake_g2p(piece):  # noqa: ANN001
            seen.append(piece)
            return ("pˈOstɡɹɛs", ["tok"])

        server._g2p = fake_g2p
        out, is_ph = server._phonemize_piece("the postgres box")
        self.assertTrue(is_ph)
        self.assertEqual(seen, ["the [postgres](/pˈOstɡɹɛs/) box"])

    def test_markup_never_reaches_the_espeak_path(self) -> None:
        # A phonemize failure hands the caller the ORIGINAL text; if it
        # handed back the marked-up form, Kokoro's espeak phonemizer would
        # read the brackets and slashes out loud.
        def boom(_piece):
            raise RuntimeError("spaCy exploded")

        server._g2p = boom
        out, is_ph = server._phonemize_piece("the postgres box")
        self.assertFalse(is_ph)
        self.assertEqual(out, "the postgres box")

    def test_no_overrides_applied_without_misaki(self) -> None:
        server._g2p = None
        out, is_ph = server._phonemize_piece("the postgres box")
        self.assertEqual((out, is_ph), ("the postgres box", False))


class VocabGuardWiringTests(unittest.TestCase):
    def test_prefers_the_live_tokenizer_vocab(self) -> None:
        kokoro = types.SimpleNamespace(
            tokenizer=types.SimpleNamespace(vocab={"a": 1, "b": 2})
        )
        self.assertEqual(server._kokoro_vocab(kokoro), {"a", "b"})

    def test_load_overrides_rejects_out_of_vocab_and_keeps_serving(self) -> None:
        orig = (server._tts_overrides, server._tts_overrides_rejected)
        try:
            # A vocab that cannot represent ANY shipped entry: every override
            # is rejected, and the sidecar keeps working with none of them.
            server._load_overrides(
                types.SimpleNamespace(tokenizer=types.SimpleNamespace(vocab={"z": 1}))
            )
            self.assertEqual(server._tts_overrides, [])
            self.assertTrue(server._tts_overrides_rejected)
            for _match, reason in server._tts_overrides_rejected:
                self.assertIn("out-of-vocab", reason)
        finally:
            server._tts_overrides, server._tts_overrides_rejected = orig

    def test_shipped_table_loads_against_a_permissive_vocab(self) -> None:
        orig = (server._tts_overrides, server._tts_overrides_rejected)
        try:
            server._load_overrides(types.SimpleNamespace(tokenizer=None))
            # tokenizer=None → falls back to the packaged DEFAULT_VOCAB, which
            # is absent in CI → unvalidated load, but the table must parse.
            self.assertEqual(server._tts_overrides_rejected, [])
            self.assertGreaterEqual(len(server._tts_overrides), 1)
        finally:
            server._tts_overrides, server._tts_overrides_rejected = orig


if __name__ == "__main__":
    unittest.main()
