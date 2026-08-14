"""Unit tests for phoneme-length chunking on the TTS path (#4695).

The defect these pin: the sidecar chunked on CHARACTERS (VOICE_TTS_MAX_CHARS
= 1200) but kokoro-onnx synthesizes in PHONEMES and hard-slices any single
batch past MAX_PHONEME_LENGTH = 510:

    kokoro_onnx/__init__.py:97-101 (0.5.0)
        if len(phonemes) > MAX_PHONEME_LENGTH:
            log.warning(...)
        phonemes = phonemes[:MAX_PHONEME_LENGTH]

Kokoro does pre-batch a long phoneme string (Kokoro._split_phonemes), but that
splitter breaks ONLY on `.,!?;` — so a punctuation-free run over 510 phonemes
still overflows.

And the overflow is worse than that slice suggests. Two lines later:

    kokoro_onnx/__init__.py:108
        voice = voice[len(tokens)]        # voices array has exactly 510 rows

A batch that slices to 510 in-vocab phonemes indexes one past the end and
RAISES, failing the whole /tts request — the user gets no voice message at all,
not a truncated one. Reproduced live against the real model, and all 16
over-limit batches in a 1,679-message production corpus land there.

`_FaithfulKokoro` below is a line-by-line port of 0.5.0's `_split_phonemes`
plus both consequences, so it fails exactly where the real engine fails. The
load-bearing assertions are `spoken()` — the phonemes that actually reached
synthesis — and the absence of that IndexError. On the pre-fix server (one
_tts.create per ~1200-char piece) they are RED; with phoneme chunking they pass
with zero loss.

These run WITHOUT numpy / misaki / onnxruntime installed, like the sibling
suites: server.py imports numpy lazily and the G2P + encoder touchpoints are
injected through module globals.

Run: python3 -m unittest discover -s docker/voice-sidecar -p 'test_*.py'
"""

from __future__ import annotations

import re
import sys
import types
import unittest

import server

# The real constant from kokoro_onnx.config, restated so this suite does not
# need the wheel installed. Verified against kokoro-onnx 0.5.0.
MAX_PHONEME_LENGTH = 510


class _FaithfulKokoro:
    """A Kokoro stand-in that truncates EXACTLY like kokoro-onnx 0.5.0.

    Records, per create() call, the phoneme text that survived to synthesis so a
    test can compare it against what was handed in."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.synthesized: list[str] = []
        self.truncated_batches = 0

    # verbatim port of Kokoro._split_phonemes (kokoro_onnx/__init__.py:136-168)
    @staticmethod
    def _split_phonemes(phonemes: str) -> list[str]:
        words = re.split(r"([.,!?;])", phonemes)
        batched: list[str] = []
        current_batch = ""
        for part in words:
            part = part.strip()
            if part:
                if len(current_batch) + len(part) + 1 >= MAX_PHONEME_LENGTH:
                    batched.append(current_batch.strip())
                    current_batch = part
                else:
                    if part in ".,!?;":
                        current_batch += part
                    else:
                        if current_batch:
                            current_batch += " "
                        current_batch += part
        if current_batch:
            batched.append(current_batch.strip())
        return batched

    def create(self, text, voice=None, speed=None, lang=None, is_phonemes=False):  # noqa: ANN001
        self.calls.append(
            {"text": text, "voice": voice, "speed": speed, "lang": lang,
             "is_phonemes": is_phonemes}
        )
        for batch in self._split_phonemes(text):
            if len(batch) > MAX_PHONEME_LENGTH:
                self.truncated_batches += 1
            sliced = batch[:MAX_PHONEME_LENGTH]
            # kokoro_onnx/__init__.py:108 — `voice = voice[len(tokens)]` on a
            # voices array of exactly MAX_PHONEME_LENGTH rows. A batch that
            # slices to 510 IN-VOCAB phonemes indexes one past the end and
            # RAISES, taking the whole /tts request down with it. Reproduced
            # live against kokoro-onnx 0.5.0 on a real corpus message:
            #   IndexError: index 510 is out of bounds for axis 0 with size 510
            # (All 16 over-510 batches in the 1,679-message corpus land here;
            # this fake assumes in-vocab, which held for all 16.)
            if len(sliced) >= MAX_PHONEME_LENGTH:
                raise IndexError(
                    f"index {MAX_PHONEME_LENGTH} is out of bounds for axis 0 "
                    f"with size {MAX_PHONEME_LENGTH}"
                )
            self.synthesized.append(sliced)
        return ([0.0], server.TTS_SAMPLE_RATE)

    def spoken(self) -> str:
        """Every phoneme that actually reached the model, whitespace-normalised
        (chunk seams legitimately renormalise spaces; dropped phonemes do not)."""
        return re.sub(r"\s+", "", "".join(self.synthesized))


def _install_fake_numpy() -> types.ModuleType | None:
    prev = sys.modules.get("numpy")
    fake = types.ModuleType("numpy")
    fake.float32 = "float32"
    fake.zeros = lambda n, dtype=None: [0.0] * int(n)
    fake.asarray = lambda x, dtype=None: list(x)
    fake.concatenate = lambda chunks: [v for c in chunks for v in c]
    sys.modules["numpy"] = fake
    return prev


def _norm(phonemes: str) -> str:
    return re.sub(r"\s+", "", phonemes)


class SplitPhonemesTests(unittest.TestCase):
    """The pure splitter: bounded, lossless, punctuation-preferring."""

    def test_empty(self) -> None:
        self.assertEqual(server._split_phonemes("", 100), ([], 0))
        self.assertEqual(server._split_phonemes("   ", 100), ([], 0))

    def test_short_string_is_one_chunk(self) -> None:
        chunks, cuts = server._split_phonemes("fˈOni:mz", 100)
        self.assertEqual(chunks, ["fˈOni:mz"])
        self.assertEqual(cuts, 0)

    def test_every_chunk_within_cap(self) -> None:
        text = " ".join(["fˈOni:m"] * 400)
        chunks, _ = server._split_phonemes(text, 60)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c), 60, msg=repr(c))

    def test_lossless_over_word_boundaries(self) -> None:
        text = " ".join(f"w{i}" for i in range(500))
        chunks, cuts = server._split_phonemes(text, 61)
        self.assertEqual(cuts, 0)
        self.assertEqual(_norm(" ".join(chunks)), _norm(text))

    def test_lossless_over_clause_boundaries(self) -> None:
        text = ", ".join(["abcdefghij"] * 200) + "."
        chunks, cuts = server._split_phonemes(text, 97)
        self.assertEqual(cuts, 0)
        self.assertEqual(_norm("".join(chunks)), _norm(text))
        for c in chunks:
            self.assertLessEqual(len(c), 97)

    def test_unbreakable_run_is_carried_not_dropped(self) -> None:
        # No space, no clause break: the one case that must still be cut. The
        # cut is COUNTED and the remainder is CARRIED, never discarded.
        run = "x" * 1300
        chunks, cuts = server._split_phonemes(run, 500)
        self.assertGreater(cuts, 0)
        self.assertEqual(_norm("".join(chunks)), run)
        for c in chunks:
            self.assertLessEqual(len(c), 500)

    def test_prefers_clause_break_over_mid_word_cut(self) -> None:
        text = "aaaaa,bbbbb,ccccc,ddddd"
        chunks, cuts = server._split_phonemes(text, 12)
        self.assertEqual(cuts, 0)
        # Each seam lands after a comma, never inside a run of letters.
        for c in chunks[:-1]:
            self.assertTrue(c.endswith(","), msg=repr(c))

    def test_cap_leaves_room_for_kokoros_off_by_one(self) -> None:
        # Kokoro flushes on `>=` MAX_PHONEME_LENGTH, so a break-free chunk of
        # 509+ makes it emit a leading EMPTY batch. 508 is the highest safe cap.
        self.assertLessEqual(server.TTS_MAX_PHONEMES, MAX_PHONEME_LENGTH - 2)
        for size in (server.TTS_MAX_PHONEMES, MAX_PHONEME_LENGTH - 2):
            self.assertEqual(_FaithfulKokoro._split_phonemes("x" * size), ["x" * size])

    def test_our_chunk_is_kokoros_batch_one_for_one(self) -> None:
        # Kokoro re-inserts a space after every break char, so `a,b` comes back
        # as `a, b`. Un-normalised, a 500-phoneme comma-dense chunk re-expands
        # to 749 inside Kokoro and Kokoro re-splits it (508 + 241) — seams we
        # did not choose, and a `batches` count in the meta that is wrong.
        # The last three carry ADJACENT break chars. Kokoro appends a break char
        # FLUSH to the batch, so a chunk that re-inserts a space in front of a
        # lone break unit ("aaaa; ." vs Kokoro's "aaaa;.") is not a fixed point
        # and gets re-batched — the error is in the safe direction (no overflow)
        # but the seams and the `batches` count are still not the ones we chose.
        for dense in (
            "a," * 250,
            "a," * 4000,
            "ab,cd." * 300,
            "ab;.cd" * 300,
            "a?!" * 400,
            "x,,y" * 300,
        ):
            chunks, _ = server._split_phonemes(dense, server.TTS_MAX_PHONEMES)
            for c in chunks:
                rebuilt = _FaithfulKokoro._split_phonemes(c)
                self.assertEqual(
                    rebuilt, [c], msg=f"Kokoro re-batched our chunk: {c[:40]!r}"
                )
                self.assertLessEqual(len(rebuilt[0]), MAX_PHONEME_LENGTH)

    def test_normalize_is_a_fixed_point_of_kokoros_rebuild(self) -> None:
        for raw in ("a,b.c!d?e;f", "  a ,  b  ", "hˈEloU,wˈ3:ld.", "x"):
            norm = server._normalize_phonemes(raw)
            self.assertEqual("".join(_FaithfulKokoro._split_phonemes(norm)), norm)


class NoPhonemeLossThroughSynthesisTests(unittest.TestCase):
    """The outcome test. Runs real-shaped input end-to-end through
    _run_synthesis against a Kokoro that truncates like the real one, and
    asserts nothing was discarded. RED before the phoneme-chunking fix."""

    def setUp(self) -> None:
        self._orig_g2p = server._g2p
        self._orig_warned = server._g2p_warned
        self._orig_tts = server._tts
        self._orig_pcm = server._pcm_to_wav_bytes
        self._orig_ogg = server._wav_to_ogg_opus
        self._prev_numpy = _install_fake_numpy()
        server._pcm_to_wav_bytes = lambda samples, sample_rate: b"WAV"
        server._wav_to_ogg_opus = lambda wav: b"OGG"
        self.tts = _FaithfulKokoro()
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

    @staticmethod
    def _identity_g2p(piece: str):
        """G2P stub with a realistic ~1.15 phonemes-per-char expansion, so a
        1200-char piece phonemises well past 510 exactly as misaki does on real
        text (measured: 1.15-1.30 on the production corpus)."""
        return ("".join(ch + ("ˈ" if ch.isalpha() and ch in "aeiou" else "")
                        for ch in piece), ["tok"])

    def test_long_unpunctuated_clause_loses_no_phonemes(self) -> None:
        # A single clause with spaces but NO `.,!?;` for well over 510
        # phonemes. Kokoro's own batcher cannot break it, so pre-fix the tail
        # was sliced off and never spoken.
        text = " ".join(["consequently"] * 120) + "."
        server._g2p = self._identity_g2p
        expected, _ = self._identity_g2p(text)

        server._run_synthesis(text, voice="af_heart")

        self.assertEqual(self.tts.truncated_batches, 0)
        self.assertEqual(self.tts.spoken(), _norm(expected))

    def test_long_comma_free_paragraph_loses_no_phonemes(self) -> None:
        # Shaped like the real corpus messages that lost audio: long sentences
        # whose individual clauses exceed 510 phonemes.
        sentence = " ".join(["deliberation"] * 60)
        text = ". ".join([sentence] * 4) + "."
        server._g2p = self._identity_g2p
        expected, _ = self._identity_g2p(text)

        server._run_synthesis(text, voice="af_heart")

        self.assertEqual(self.tts.truncated_batches, 0)
        self.assertEqual(self.tts.spoken(), _norm(expected))

    def test_every_batch_handed_to_kokoro_is_within_the_limit(self) -> None:
        text = " ".join(["antidisestablishmentarianism"] * 200)
        server._g2p = self._identity_g2p

        server._run_synthesis(text, voice="af_heart")

        self.assertTrue(self.tts.calls)
        for call in self.tts.calls:
            self.assertTrue(call["is_phonemes"])
            self.assertLessEqual(len(call["text"]), MAX_PHONEME_LENGTH)

    def test_oversized_batch_would_fail_the_whole_request(self) -> None:
        # Guards the fake itself: if this stops raising, kokoro-onnx changed and
        # every "loses no phonemes" assertion above is measuring the wrong thing.
        with self.assertRaises(IndexError):
            self.tts.create("x" * 600, voice="af_heart", is_phonemes=True)

    def test_meta_reports_batches_and_clean_run_has_no_degradation(self) -> None:
        text = " ".join(["consequently"] * 120) + "."
        server._g2p = self._identity_g2p

        _ogg, meta = server._run_synthesis(text, voice="af_heart")

        self.assertEqual(meta["hardCuts"], 0)
        self.assertEqual(meta["unchunkedPieces"], 0)
        self.assertGreater(meta["batches"], 1)


class LossyPathIsLoudTests(unittest.TestCase):
    """Requirement 2 of #4695: whatever remains lossy must not be silent."""

    def setUp(self) -> None:
        self._orig_g2p = server._g2p
        self._orig_tts = server._tts
        self._orig_pcm = server._pcm_to_wav_bytes
        self._orig_ogg = server._wav_to_ogg_opus
        self._orig_log = server._log
        self._prev_numpy = _install_fake_numpy()
        server._pcm_to_wav_bytes = lambda samples, sample_rate: b"WAV"
        server._wav_to_ogg_opus = lambda wav: b"OGG"
        server._tts = _FaithfulKokoro()
        self.logged: list[str] = []
        server._log = self.logged.append

    def tearDown(self) -> None:
        server._g2p = self._orig_g2p
        server._tts = self._orig_tts
        server._pcm_to_wav_bytes = self._orig_pcm
        server._wav_to_ogg_opus = self._orig_ogg
        server._log = self._orig_log
        if self._prev_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self._prev_numpy

    def test_mid_word_cut_is_counted_and_warned(self) -> None:
        # An unbreakable phoneme run: no space, no clause break, over the cap.
        server._g2p = lambda piece: ("x" * 1400, ["tok"])

        _ogg, meta = server._run_synthesis("anything", voice="af_heart")

        self.assertGreater(meta["hardCuts"], 0)
        self.assertTrue(
            any("WARNING" in line and "mid-word" in line for line in self.logged),
            msg=f"no loud log emitted; got {self.logged!r}",
        )

    def test_unphonemizable_piece_is_counted_and_warned(self) -> None:
        # Neither misaki nor Kokoro's espeak tokenizer available: the piece goes
        # to Kokoro as raw text and Kokoro may slice it. Must not be silent.
        server._g2p = None  # _FaithfulKokoro has no .tokenizer either

        _ogg, meta = server._run_synthesis("anything at all", voice="af_heart")

        self.assertEqual(meta["unchunkedPieces"], 1)
        self.assertTrue(
            any(
                "WARNING" in line and "could not phonemize" in line
                for line in self.logged
            ),
            msg=f"no loud log emitted; got {self.logged!r}",
        )

    def test_unphonemizable_piece_is_warned_even_when_kokoro_then_raises(self) -> None:
        # The case the warning exists to report: the unchunked piece really does
        # overflow, so Kokoro raises mid-loop. A post-loop log would never run
        # and the request would 500 as silently as it did pre-#4695.
        server._g2p = None  # _FaithfulKokoro has no .tokenizer either
        text = "x" * 600  # one piece (< VOICE_TTS_MAX_CHARS), > 510 phonemes

        with self.assertRaises(IndexError):
            server._run_synthesis(text, voice="af_heart")

        self.assertTrue(
            any(
                "WARNING" in line and "could not phonemize" in line
                for line in self.logged
            ),
            msg=f"no loud log emitted before the raise; got {self.logged!r}",
        )

    def test_clean_synthesis_emits_no_warning(self) -> None:
        server._g2p = lambda piece: ("fˈOni:mz", ["tok"])

        _ogg, meta = server._run_synthesis("phonemes", voice="af_heart")

        self.assertEqual(meta["hardCuts"], 0)
        self.assertEqual(meta["unchunkedPieces"], 0)
        self.assertFalse([line for line in self.logged if "WARNING" in line])


class MaxPhonemesClampTests(unittest.TestCase):
    """VOICE_TTS_MAX_PHONEMES is clamped to [1, 508]. A clamp that changes the
    operator's value must say so, or the real ceiling is undiscoverable."""

    def setUp(self) -> None:
        self._orig = (server.TTS_MAX_PHONEMES_REQUESTED, server.TTS_MAX_PHONEMES)

    def tearDown(self) -> None:
        server.TTS_MAX_PHONEMES_REQUESTED, server.TTS_MAX_PHONEMES = self._orig

    def _set(self, requested: int) -> None:
        server.TTS_MAX_PHONEMES_REQUESTED = requested
        server.TTS_MAX_PHONEMES = max(
            1, min(server.TTS_MAX_PHONEMES_CEILING, requested)
        )

    def test_in_range_value_is_not_warned(self) -> None:
        self._set(500)
        self.assertIsNone(server._max_phonemes_clamp_warning())

    def test_too_high_is_warned_with_both_numbers(self) -> None:
        self._set(600)
        warning = server._max_phonemes_clamp_warning()
        self.assertIsNotNone(warning)
        self.assertIn("WARNING", warning)
        self.assertIn("600", warning)
        self.assertIn("508", warning)

    def test_zero_is_warned(self) -> None:
        # 0 clamps to 1, which would hard-cut every single phoneme — the worst
        # possible silent misconfiguration.
        self._set(0)
        warning = server._max_phonemes_clamp_warning()
        self.assertIsNotNone(warning)
        self.assertIn("WARNING", warning)
        self.assertIn("clamped to 1", warning)

    def test_ceiling_matches_kokoros_off_by_one(self) -> None:
        self.assertEqual(server.TTS_MAX_PHONEMES_CEILING, MAX_PHONEME_LENGTH - 2)


class EspeakPhonemizeTests(unittest.TestCase):
    """The espeak path is phonemized here so it can be phoneme-chunked too."""

    def setUp(self) -> None:
        self._orig_tts = server._tts
        self._orig_warned = server._espeak_phonemize_warned
        server._espeak_phonemize_warned = False

    def tearDown(self) -> None:
        server._tts = self._orig_tts
        server._espeak_phonemize_warned = self._orig_warned

    def test_returns_text_and_false_without_a_tokenizer(self) -> None:
        server._tts = object()
        self.assertEqual(server._espeak_phonemize("hi"), ("hi", False))

    def test_uses_kokoros_tokenizer_with_the_configured_lang(self) -> None:
        seen: list[tuple] = []

        class _Tok:
            @staticmethod
            def phonemize(text, lang):  # noqa: ANN001
                seen.append((text, lang))
                return "hˈaI"

        class _TTS:
            tokenizer = _Tok()

        server._tts = _TTS()
        self.assertEqual(server._espeak_phonemize("hi"), ("hˈaI", True))
        self.assertEqual(seen, [("hi", server.TTS_LANG)])

    def test_run_synthesis_chunks_the_espeak_path_too(self) -> None:
        # misaki off (the VOICE_TTS_G2P=espeak rollback lever). The piece must
        # still be phoneme-chunked, not handed to Kokoro as one long text blob.
        class _Tok:
            @staticmethod
            def phonemize(text, lang):  # noqa: ANN001
                return "wˈ3:d " * 400  # ~2400 phonemes, well past 510

        tts = _FaithfulKokoro()
        tts.tokenizer = _Tok()

        orig_g2p, orig_pcm, orig_ogg = (
            server._g2p, server._pcm_to_wav_bytes, server._wav_to_ogg_opus
        )
        prev_numpy = _install_fake_numpy()
        server._g2p = None
        server._tts = tts
        server._pcm_to_wav_bytes = lambda samples, sample_rate: b"WAV"
        server._wav_to_ogg_opus = lambda wav: b"OGG"
        try:
            _ogg, meta = server._run_synthesis("irrelevant", voice="af_heart")
        finally:
            server._g2p = orig_g2p
            server._pcm_to_wav_bytes = orig_pcm
            server._wav_to_ogg_opus = orig_ogg
            if prev_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = prev_numpy

        self.assertEqual(tts.truncated_batches, 0)
        self.assertEqual(meta["unchunkedPieces"], 0)
        self.assertGreater(meta["batches"], 1)
        for call in tts.calls:
            self.assertTrue(call["is_phonemes"])
            self.assertLessEqual(len(call["text"]), MAX_PHONEME_LENGTH)

    def test_raising_tokenizer_degrades_to_text(self) -> None:
        class _Tok:
            @staticmethod
            def phonemize(text, lang):  # noqa: ANN001
                raise RuntimeError("espeak exploded")

        class _TTS:
            tokenizer = _Tok()

        server._tts = _TTS()
        self.assertEqual(server._espeak_phonemize("hi"), ("hi", False))


if __name__ == "__main__":
    unittest.main()
