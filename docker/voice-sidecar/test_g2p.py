"""Unit tests for the misaki G2P integration on the TTS path.

The sidecar's default G2P engine (VOICE_TTS_G2P=misaki) runs misaki's
POS-aware English grapheme→phoneme conversion in-process and hands the
resulting phoneme string to Kokoro with is_phonemes=True — the fix for
English heteronyms Kokoro's built-in espeak phonemizer mispronounces
(verb "live" /lˈɪv/ vs adjective "live" /lˈaɪv/, "read" present /ɹˈid/ vs
past /ɹˈɛd/). These tests pin two contracts:

  1. _phonemize_piece degrades correctly — (piece, False) when misaki is
     absent / disabled / raises, (phonemes, True) only on a real hit.
  2. _run_synthesis ROUTES on that flag: a phoneme string goes to Kokoro
     with is_phonemes=True. A regression that silently routed a phoneme
     string through the espeak text path (or vice-versa) would be a silent
     mispronunciation, so it is pinned here.

     Since #4695 the misaki MISS is a two-step fallback, not one: the piece is
     retried through Kokoro's own espeak tokenizer (_espeak_phonemize) so it
     can still be phoneme-chunked, and only if THAT is unavailable does it go
     to Kokoro as raw TEXT with lang=TTS_LANG. The fallback cases below use a
     stub _tts with no `.tokenizer`, so they exercise that last leg. The
     espeak-tokenizer leg is covered in test_phoneme_chunking.py.

Like test_server.py these run WITHOUT misaki / numpy / onnxruntime / ffmpeg
installed (the CI voice-sidecar job is stdlib-only): server.py imports
misaki and numpy lazily, so the module imports clean, _g2p is injected via
the module global, and the numpy + ffmpeg touchpoints of _run_synthesis are
stubbed. The one test that needs a real misaki is skipped unless it is
installed.

Run: python3 -m unittest discover -s docker/voice-sidecar -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest

import server


class PhonemizePieceTests(unittest.TestCase):
    """The pure degrade/hit helper — the heart of the fallback contract."""

    def setUp(self) -> None:
        self._orig_g2p = server._g2p
        self._orig_warned = server._g2p_warned
        server._g2p = None
        server._g2p_warned = False

    def tearDown(self) -> None:
        server._g2p = self._orig_g2p
        server._g2p_warned = self._orig_warned

    def test_returns_text_and_false_when_g2p_none(self) -> None:
        # misaki disabled / not loaded → hand back the RAW text, flagged False.
        server._g2p = None
        self.assertEqual(server._phonemize_piece("hello world"), ("hello world", False))

    def test_returns_phonemes_and_true_on_hit(self) -> None:
        # A working G2P returns (phonemes, tokens); the helper surfaces the
        # phoneme STRING and True so the caller sets is_phonemes=True.
        server._g2p = lambda piece: ("fˈOni:mz", ["tok"])
        out, is_ph = server._phonemize_piece("phonemes")
        self.assertEqual(out, "fˈOni:mz")
        self.assertTrue(is_ph)

    def test_raising_g2p_degrades_to_text(self) -> None:
        # A misaki call that raises must NEVER fail synthesis — degrade to the
        # espeak text path, flagged False.
        def boom(_piece):
            raise RuntimeError("spaCy exploded")

        server._g2p = boom
        self.assertEqual(server._phonemize_piece("boom"), ("boom", False))

    def test_empty_phoneme_output_degrades_to_text(self) -> None:
        # An empty phoneme string is a miss, not a valid result — Kokoro must
        # get the real text so it can at least espeak-phonemize it.
        server._g2p = lambda piece: ("", [])
        self.assertEqual(server._phonemize_piece("edge"), ("edge", False))

    def test_failure_logged_once(self) -> None:
        # A persistent misaki fault must not flood the log: the warned flag
        # latches after the first failure.
        def boom(_piece):
            raise RuntimeError("x")

        server._g2p = boom
        self.assertFalse(server._g2p_warned)
        server._phonemize_piece("a")
        self.assertTrue(server._g2p_warned)
        server._phonemize_piece("b")  # still degrades, no reset
        self.assertTrue(server._g2p_warned)


class _RecordingTTS:
    """A stand-in for the Kokoro handle: records every create() call's kwargs
    and returns a trivial one-sample PCM result."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, text, voice=None, speed=None, lang=None, is_phonemes=False):  # noqa: ANN001
        self.calls.append(
            {"text": text, "voice": voice, "speed": speed, "lang": lang, "is_phonemes": is_phonemes}
        )
        return ([0.0], server.TTS_SAMPLE_RATE)


def _install_fake_numpy() -> types.ModuleType | None:
    """Inject a fake `numpy` sufficient for _run_synthesis (zeros / asarray /
    concatenate / float32) so the routing can be exercised without the real
    dependency. Returns the previously-installed module (or None) to restore."""
    prev = sys.modules.get("numpy")
    fake = types.ModuleType("numpy")
    fake.float32 = "float32"
    fake.zeros = lambda n, dtype=None: [0.0] * int(n)
    fake.asarray = lambda x, dtype=None: list(x)
    fake.concatenate = lambda chunks: [v for c in chunks for v in c]
    sys.modules["numpy"] = fake
    return prev


class RunSynthesisRoutingTests(unittest.TestCase):
    """Pins that _run_synthesis routes on the is_phonemes flag — the guarantee
    that a phoneme string never silently rides the espeak text path."""

    def setUp(self) -> None:
        self._orig_g2p = server._g2p
        self._orig_warned = server._g2p_warned
        self._orig_tts = server._tts
        self._orig_pcm = server._pcm_to_wav_bytes
        self._orig_ogg = server._wav_to_ogg_opus
        self._prev_numpy = _install_fake_numpy()
        # Stub the numpy/ffmpeg-backed byte producers — this suite tests
        # ROUTING, not audio encoding.
        server._pcm_to_wav_bytes = lambda samples, sample_rate: b"WAV"
        server._wav_to_ogg_opus = lambda wav: b"OGG"
        self.tts = _RecordingTTS()
        server._tts = self.tts
        server._g2p_warned = False

    def tearDown(self) -> None:
        server._g2p = self._orig_g2p
        server._g2p_warned = self._orig_warned
        server._tts = self._orig_tts
        server._pcm_to_wav_bytes = self._orig_pcm
        server._wav_to_ogg_opus = self._orig_ogg
        if self._prev_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self._prev_numpy

    def test_phoneme_hit_routes_with_is_phonemes_true(self) -> None:
        server._g2p = lambda piece: ("lˈɪv", ["tok"])
        ogg, meta = server._run_synthesis("live", voice="af_heart")
        self.assertEqual(ogg, b"OGG")
        self.assertEqual(len(self.tts.calls), 1)
        call = self.tts.calls[0]
        self.assertEqual(call["text"], "lˈɪv")  # the PHONEME string, not "live"
        self.assertTrue(call["is_phonemes"])
        self.assertIsNone(call["lang"])  # lang is NOT passed on the phoneme path

    def test_fallback_routes_as_text_with_lang(self) -> None:
        server._g2p = None  # misaki off → espeak text path
        ogg, meta = server._run_synthesis("live", voice="af_heart")
        self.assertEqual(ogg, b"OGG")
        self.assertEqual(len(self.tts.calls), 1)
        call = self.tts.calls[0]
        self.assertEqual(call["text"], "live")  # the RAW text
        self.assertFalse(call["is_phonemes"])
        self.assertEqual(call["lang"], server.TTS_LANG)

    def test_raising_g2p_falls_back_to_text_path(self) -> None:
        def boom(_piece):
            raise RuntimeError("spaCy exploded")

        server._g2p = boom
        server._run_synthesis("live", voice="af_heart")
        call = self.tts.calls[0]
        self.assertEqual(call["text"], "live")
        self.assertFalse(call["is_phonemes"])
        self.assertEqual(call["lang"], server.TTS_LANG)


@unittest.skipUnless(
    importlib.util.find_spec("misaki") is not None,
    "misaki not installed — the real-G2P heteronym assertion runs in the "
    "build-voice image (Dockerfile.voice build guard)",
)
class RealMisakiHeteronymTests(unittest.TestCase):
    """The OUTCOME test: real misaki emits DIFFERENT phonemes for the two
    senses of each heteronym. Mirrors the Dockerfile build-time guard so the
    behaviour is pinned wherever misaki happens to be installed."""

    @classmethod
    def setUpClass(cls) -> None:
        from misaki import en, espeak

        cls.g2p = en.G2P(
            trf=False, british=False, fallback=espeak.EspeakFallback(british=False)
        )

    def test_live_verb_vs_adjective(self) -> None:
        verb, _ = self.g2p("They live in Sydney.")
        adj, _ = self.g2p("It was a live show.")
        self.assertIn("lˈɪv", verb)
        self.assertIn("lˈIv", adj)
        self.assertNotEqual(verb, adj)

    def test_read_base_vs_past(self) -> None:
        base, _ = self.g2p("Please read this book.")
        past, _ = self.g2p("He read it yesterday.")
        self.assertIn("ɹˈid", base)
        self.assertIn("ɹˈɛd", past)

    def test_lead_verb_sense(self) -> None:
        # The verb sense IS correct today — pin it so a fix attempt for the
        # metal sense can't regress the common verb reading.
        verb, _ = self.g2p("Lead the way.")
        self.assertIn("lˈid", verb)

    @unittest.expectedFailure
    def test_lead_metal_vs_verb_KNOWN_GAP_4270(self) -> None:
        """xfail (#4270): asserts the CORRECT behaviour — metal "lead" should
        be lˈɛd — which misaki 0.9.4 cannot produce: us_gold.json has "lead"
        as a plain string ("lˈid"), not a POS-keyed dict like live/read, so
        Lexicon.lookup never consults the tag (a forced perfect NN tag still
        returns lˈid; upstream main has the same entry, and the metal vs the
        leed-nouns "took the lead"/"dog on a lead" are all NN anyway, so no
        POS model at any cost can split them). If a misaki bump ever fixes
        the lexicon, this becomes an UNEXPECTED SUCCESS (a test failure):
        remove this decorator and flip the Dockerfile.voice known-gap guard
        to a real assertion in the same PR."""
        metal, _ = self.g2p("The pipe is made of lead.")
        verb, _ = self.g2p("Lead the way.")
        self.assertIn("lˈɛd", metal)
        self.assertIn("lˈid", verb)
        self.assertNotEqual(metal, verb)


if __name__ == "__main__":
    unittest.main()
