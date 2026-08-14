#!/usr/bin/env python3
"""
switchroom voice sidecar — STT (PR-B2) + TTS (PR-C1).

A tiny HTTP server that wraps `faster-whisper` (CTranslate2) for local,
on-GPU speech-to-text AND `kokoro-onnx` (Kokoro) for local
text-to-speech. It exists so the fleet can transcribe inbound voice
notes and synthesize spoken replies WITHOUT a third-party API key
(vision #3 subscription-honest) and WITHOUT depending on cloud
reachability (vision #4 always-available), WHEN the host has a usable
GPU (the PR-B1 `engine='local'` verdict).

One sidecar, two endpoints, one port (8126). STT and TTS each get their
OWN concurrency lane so a synth never serializes behind a transcribe.

English G2P (heteronyms)
------------------------
By default (VOICE_TTS_G2P=misaki) the TTS path runs misaki's POS-aware
English grapheme→phoneme conversion in-process and feeds the resulting
phoneme string to Kokoro with is_phonemes=True. This fixes English
heteronyms Kokoro's built-in espeak phonemizer mispronounces because
espeak is not part-of-speech aware — e.g. the verb "live" /lˈɪv/ vs the
adjective "live" /lˈaɪv/, or "read" present /ɹˈid/ vs past /ɹˈɛd/. It is
NOT a blanket heteronym fix: "lead" is a KNOWN GAP (#4270) — misaki's
lexicon carries it as a plain string /lˈid/ (not a POS-keyed entry), so
the metal ("made of lead", should be /lˈɛd/) comes out as "leed" in every
sense, and no POS model can split it (the metal and the leed-nouns "took
the lead" are both NN). Pinned explicitly in the Dockerfile.voice build
guard and test_g2p.py's xfail. It is
a strict ENHANCEMENT: misaki is loaded in its own try/except beside the
Kokoro model, and any failure (or VOICE_TTS_G2P=espeak, or a non-English
locale) leaves _g2p None so synthesis degrades to today's espeak path
with the sidecar fully healthy. VOICE_TTS_G2P=espeak is the rollback
lever — no image rebuild. See _load_tts / _phonemize_piece / _run_synthesis.
misaki also accepts a per-word phoneme override via `[word](/phonemes/)`
markup, and THAT IS NOW WIRED: docker/voice-sidecar/overrides.json is a
reviewed table of words misaki gets wrong for this fleet (Postgres, Redis,
…), validated against Kokoro's vocabulary at load and applied inside
_phonemize_piece — i.e. downstream of everything the gateway does, so no
gateway pass can strip it. See _load_tts / text_normalize.apply_overrides.

Token normalisation (Stage B)
-----------------------------
The sidecar — not the gateway — decides how a token is SPOKEN: "90s" →
"ninety seconds", "$1.6M" → "one point six million dollars", "#4661" →
"hash 4661". That lives in text_normalize.py and runs in _run_synthesis
immediately before the text is split into pieces, so every caller of
POST /tts gets it, including callers that never went through the gateway.
The HTTP boundary is unchanged and byte-preserving: callers send the text
they mean, digits and all. VOICE_TTS_NORMALIZE=0 is the kill switch
(byte-identical passthrough); it is INDEPENDENT of VOICE_TTS_G2P=espeak,
which is the phonemizer rollback lever.

HTTP contract
-------------
  POST /stt   multipart: audio=<bytes>, optional language=<iso-639-1>
              header:    X-Voice-Token: <shared secret>
              → 200 { ok: true,  text, language?, durationMs, audioSeconds }
              → 4xx/5xx { ok: false, reason, detail }
  POST /tts   json: { text: str (ANY length), voice?: str, speed?: float, format?: "ogg" }
              speed is clamped to 0.5–2.0; absent/invalid → 1.0 (today's default).
              header:    X-Voice-Token: <shared secret>
              → 200 audio/ogg  (ONE continuous OGG/Opus stream, mono — ready
                for Telegram sendVoice, which REQUIRES OGG/Opus). Text of any
                length is chunked to VOICE_TTS_MAX_CHARS pieces internally,
                each synthesized on the GPU, and re-joined into a SINGLE file.
              → 4xx/5xx { ok: false, reason, detail }
  GET  /healthz
              → 200 { ok: true, status: "ready", stt: true, tts: true }
                only once BOTH models are fully loaded (cold-load can
                take 30-90s; the compose healthcheck start_period is
                generous to match). 503 until both are ready.

Design constraints (reviewed):
  * Auth — every /stt and /tts call must carry the X-Voice-Token shared
    secret (injected from the vault, see compose.ts). A missing/wrong
    token is 401. /healthz is unauthenticated (it leaks nothing).
  * GPU serialization — concurrent fleet requests must not thrash / OOM
    the GPU. STT (VOICE_STT_CONCURRENCY) and TTS (VOICE_TTS_CONCURRENCY)
    each have their own bounded semaphore, default 1; queued callers
    wait. Separate lanes so a synth doesn't block behind a transcribe.
  * Per-request timeout — a single request can't pin the GPU forever
    (VOICE_STT_REQUEST_TIMEOUT_S / VOICE_TTS_REQUEST_TIMEOUT_S) → 503.
  * Input normalization — Telegram voice is OGG/Opus; uploaded audio
    varies. ffmpeg transcodes everything to 16kHz mono WAV before
    whisper so the decoder never has to guess. On the TTS side Kokoro
    emits 24kHz float PCM, which ffmpeg transcodes to mono OGG/Opus.
  * Model weights are fetched ONCE on first boot into a named volume
    (VOICE_MODEL_CACHE), never baked into the image (size + weight-
    redistribution licensing — Kokoro's weights are Apache-2.0 and
    redistributable, but we still fetch-on-boot to keep the image
    lean). Model ids are pinned; if a SHA256 of the downloaded weights
    is configured it is verified fail-closed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── config (env-driven; compose injects these) ─────────────────────────
MODEL_ID = os.environ.get("VOICE_STT_MODEL", "Systran/faster-whisper-base")
MODEL_CACHE = os.environ.get("VOICE_MODEL_CACHE", "/models")
MODEL_SHA256 = os.environ.get("VOICE_STT_MODEL_SHA256", "").strip()
DEVICE = os.environ.get("VOICE_STT_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("VOICE_STT_COMPUTE_TYPE", "float16")
CONCURRENCY = max(1, int(os.environ.get("VOICE_STT_CONCURRENCY", "1")))
REQUEST_TIMEOUT_S = float(os.environ.get("VOICE_STT_REQUEST_TIMEOUT_S", "60"))
LISTEN_PORT = int(os.environ.get("VOICE_STT_PORT", "8126"))
SHARED_TOKEN = os.environ.get("VOICE_SIDECAR_TOKEN", "")
# Reject inputs larger than this BEFORE transcoding (the gateway already
# guards the Telegram 20MB cap; this is defence in depth).
MAX_BYTES = int(os.environ.get("VOICE_STT_MAX_BYTES", str(25 * 1024 * 1024)))

# ── TTS config (Kokoro / kokoro-onnx; PR-C1) ───────────────────────────
# kokoro-onnx is the ONNX runtime path: it avoids torch entirely (it pulls
# onnxruntime + phonemizer-fork + espeakng-loader, the latter bundling the
# espeak-ng shared lib + data so no apt `espeak-ng` package is required) —
# materially lighter than the torch-based `kokoro` package for a CPU/GPU
# sidecar that only needs inference.
#
# Weights are two files from the pinned Apache-2.0 release, fetched once on
# first boot into VOICE_MODEL_CACHE (never baked into the image):
#   VOICE_TTS_MODEL  — the .onnx graph
#   VOICE_TTS_VOICES — the voice-style pack (.bin)
# Each has an optional fail-closed SHA256 pin (VOICE_TTS_*_SHA256).
_KOKORO_RELEASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
TTS_MODEL = os.environ.get("VOICE_TTS_MODEL", "kokoro-v1.0.onnx")
TTS_MODEL_URL = os.environ.get("VOICE_TTS_MODEL_URL", f"{_KOKORO_RELEASE}/kokoro-v1.0.onnx")
TTS_MODEL_SHA256 = os.environ.get("VOICE_TTS_MODEL_SHA256", "").strip()
TTS_VOICES = os.environ.get("VOICE_TTS_VOICES", "voices-v1.0.bin")
TTS_VOICES_URL = os.environ.get("VOICE_TTS_VOICES_URL", f"{_KOKORO_RELEASE}/voices-v1.0.bin")
TTS_VOICES_SHA256 = os.environ.get("VOICE_TTS_VOICES_SHA256", "").strip()
# af_heart is a clear, natural Kokoro US-English voice — a sensible default.
TTS_VOICE = os.environ.get("VOICE_TTS_VOICE", "af_heart")
TTS_LANG = os.environ.get("VOICE_TTS_LANG", "en-us")
# ── G2P engine selection (grapheme→phoneme) ────────────────────────────
# "misaki" (default) runs misaki's POS-aware English G2P in-process and hands
# the resulting phoneme string to Kokoro with is_phonemes=True. That fixes
# English heteronyms Kokoro's built-in espeak phonemizer gets wrong because
# espeak is NOT part-of-speech aware — e.g. the verb "live" /lˈɪv/ vs the
# adjective "live" /lˈaɪv/, or "read" present /ɹˈid/ vs past /ɹˈɛd/. misaki is
# applied ONLY to the English locales (en-us / en-gb); every other TTS_LANG
# keeps the espeak path. Set VOICE_TTS_G2P=espeak to restore the espeak-only
# path fleet-wide — the rollback lever, no image rebuild required.
TTS_G2P = os.environ.get("VOICE_TTS_G2P", "misaki").lower()
# Only OGG/Opus is wired (Telegram sendVoice requires it); the env exists so
# a future format can be added without a contract change.
TTS_FORMAT = os.environ.get("VOICE_TTS_FORMAT", "ogg").lower()
TTS_CONCURRENCY = max(1, int(os.environ.get("VOICE_TTS_CONCURRENCY", "1")))
TTS_REQUEST_TIMEOUT_S = float(os.environ.get("VOICE_TTS_REQUEST_TIMEOUT_S", "60"))
TTS_MAX_CHARS = int(os.environ.get("VOICE_TTS_MAX_CHARS", "1200"))
# Defence-in-depth ceiling on the raw JSON body (text is otherwise unbounded,
# chunked internally). 256KB ≈ ~40k chars of UTF-8 — far above any real reply.
TTS_MAX_BODY_BYTES = int(os.environ.get("VOICE_TTS_MAX_BODY_BYTES", str(256 * 1024)))
TTS_SAMPLE_RATE = 24000  # Kokoro always emits 24kHz mono float PCM.

# ── wedge watchdog (recover from a hung native GPU call) ────────────────
# A per-request FutureTimeout ABANDONS the future but the worker thread keeps
# running the native call — and keeps holding _gpu_sem / _tts_sem. With
# CONCURRENCY=1 a single hung native call permanently holds the only permit,
# so every later request 503s ("timeout") forever while /healthz still says
# "ready" — a silent wedge. Python can't cancel the native call, so the only
# real recovery is to restart the process and let Docker (`restart: always`)
# bring it back with a fresh GPU context.
#
# Mechanism: count CONSECUTIVE per-request timeouts across BOTH lanes. Any
# successful inference/synthesis resets the count (a lane that still completes
# work is not wedged). Once the count reaches VOICE_WATCHDOG_MAX_TIMEOUTS we
# flip a sticky "wedged" flag; /healthz then returns 503, the compose
# healthcheck goes unhealthy, and Docker restarts the container. We flip
# /healthz (rather than os._exit immediately) so an in-flight, still-healthy
# request isn't torn down mid-response — the restart happens on the next
# healthcheck interval, which is the gentlest correct lever.
VOICE_WATCHDOG_MAX_TIMEOUTS = max(
    1, int(os.environ.get("VOICE_WATCHDOG_MAX_TIMEOUTS", "3"))
)
_watchdog_lock = threading.Lock()
_consecutive_timeouts = 0
_wedged = False


def _note_timeout() -> None:
    """Record a per-request GPU timeout. After VOICE_WATCHDOG_MAX_TIMEOUTS
    consecutive timeouts (across both lanes) flip the sticky wedged flag so
    /healthz reports unhealthy and Docker restarts us."""
    global _consecutive_timeouts, _wedged
    with _watchdog_lock:
        _consecutive_timeouts += 1
        _log(
            f"watchdog: timeout #{_consecutive_timeouts} "
            f"(threshold={VOICE_WATCHDOG_MAX_TIMEOUTS})"
        )
        if _consecutive_timeouts >= VOICE_WATCHDOG_MAX_TIMEOUTS and not _wedged:
            _wedged = True
            _log(
                "watchdog: WEDGED — a GPU call likely holds a permit that will "
                "never be released; flipping /healthz to unhealthy so Docker "
                "restarts the container"
            )


def _note_success() -> None:
    """Record a completed inference/synthesis — resets the consecutive-timeout
    counter (a lane that still finishes work is not wedged). Does NOT clear a
    sticky wedge: once we've decided to restart, we let the restart happen."""
    global _consecutive_timeouts
    with _watchdog_lock:
        if _consecutive_timeouts:
            _consecutive_timeouts = 0


def _is_wedged() -> bool:
    with _watchdog_lock:
        return _wedged


# ── model state (loaded once, in a background thread at boot) ───────────
_model = None
_model_lock = threading.Lock()
_model_error: str | None = None
# Bounds concurrent GPU inference so the fleet can't OOM/thrash the card.
_gpu_sem = threading.Semaphore(CONCURRENCY)
# A small pool so a per-request timeout can abandon a slow inference
# without blocking the HTTP handler thread forever.
_pool = ThreadPoolExecutor(max_workers=CONCURRENCY + 2)

# ── TTS (Kokoro) state — its OWN lane so a synth never serializes behind
# an STT transcribe on the shared _gpu_sem above. ───────────────────────
_tts = None
_tts_lock = threading.Lock()
_tts_error: str | None = None
_tts_sem = threading.Semaphore(TTS_CONCURRENCY)
_tts_pool = ThreadPoolExecutor(max_workers=TTS_CONCURRENCY + 2)
# misaki English G2P handle (POS-aware phonemizer), loaded alongside _tts in
# _load_tts when TTS_G2P == "misaki" and TTS_LANG is English. None otherwise or
# if its (optional) load fails — synthesis then degrades to Kokoro's espeak
# phonemization. Guarded by _tts_lock (same lane as _tts).
_g2p = None
# A phonemize failure is logged ONCE (not per request) so a persistent misaki
# fault degrades quietly to the espeak path instead of flooding the log.
_g2p_warned = False

# ── Stage B: token normalisation (text_normalize.py) ────────────────────
# Imported at module scope but NOT allowed to take the service down: if the
# module or its num2words dependency is missing (a mis-built image), voice
# still works — it just speaks raw tokens, i.e. the pre-Stage-B behaviour —
# and /healthz says so. VOICE_TTS_NORMALIZE=0 is the SUPPORTED way to turn
# normalisation off; this branch is for the image being wrong.
try:
    import text_normalize as _norm

    _norm_error: str | None = None
except Exception as exc:  # noqa: BLE001 — degrade, never fail the sidecar
    _norm = None  # type: ignore[assignment]
    _norm_error = f"{type(exc).__name__}: {exc}"
# Pronunciation overrides (overrides.json), validated against Kokoro's real
# vocabulary in _load_tts — an out-of-vocab phoneme is dropped SILENTLY by
# kokoro-onnx's tokenizer, so an unvalidated table deletes words from the
# audio. Guarded by _tts_lock (same lane as _tts/_g2p).
_tts_overrides: list = []
_tts_overrides_rejected: list = []
# A normalise failure is logged ONCE, same reasoning as _g2p_warned.
_norm_warned = False


def _log(msg: str) -> None:
    sys.stderr.write(f"voice-sidecar: {msg}\n")
    sys.stderr.flush()


def _dir_sha256(path: str) -> str:
    """Stable SHA256 over a directory's file contents (sorted by relpath).
    Used to pin the fetched model weights fail-closed."""
    h = hashlib.sha256()
    for root, _dirs, files in sorted(os.walk(path)):
        for name in sorted(files):
            fp = os.path.join(root, name)
            rel = os.path.relpath(fp, path)
            h.update(rel.encode("utf-8"))
            with open(fp, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
    return h.hexdigest()


def _load_model() -> None:
    """Fetch-once + load the whisper model. Runs in a background thread so
    /healthz can report 'not ready' during the (slow) cold load."""
    global _model, _model_error
    try:
        os.makedirs(MODEL_CACHE, exist_ok=True)
        # faster-whisper downloads to download_root on first use and reuses
        # the cached snapshot thereafter (the named volume persists it).
        from faster_whisper import WhisperModel  # heavy import, deferred

        _log(f"loading model {MODEL_ID} (device={DEVICE}, compute={COMPUTE_TYPE}) …")
        model = WhisperModel(
            MODEL_ID,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            download_root=MODEL_CACHE,
        )

        # Fail-closed checksum: if a pin is configured, verify the cached
        # snapshot matches it. A mismatch means tampered / wrong weights —
        # refuse to serve rather than transcribe with an unknown model.
        if MODEL_SHA256:
            snap_root = os.path.join(
                MODEL_CACHE,
                "models--" + MODEL_ID.replace("/", "--"),
                "snapshots",
            )
            if os.path.isdir(snap_root):
                snaps = [
                    os.path.join(snap_root, d) for d in os.listdir(snap_root)
                ]
                target = snaps[0] if snaps else MODEL_CACHE
            else:
                target = MODEL_CACHE
            got = _dir_sha256(target)
            if not hmac.compare_digest(got, MODEL_SHA256):
                raise RuntimeError(
                    f"model checksum mismatch: expected {MODEL_SHA256}, got {got}"
                )
            _log(f"model checksum verified ({got})")

        with _model_lock:
            _model = model
        _log("model ready")
    except Exception as exc:  # noqa: BLE001 — fail closed, report on /healthz
        _model_error = f"{type(exc).__name__}: {exc}"
        _log(f"model load FAILED: {_model_error}")


def _transcode_to_wav(raw: bytes) -> bytes:
    """Normalize arbitrary audio (OGG/Opus, mp3, m4a, …) to 16kHz mono WAV
    via ffmpeg so whisper's decoder gets a known format."""
    with tempfile.NamedTemporaryFile(suffix=".in") as src:
        src.write(raw)
        src.flush()
        out_path = src.name + ".wav"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", src.name,
                    "-ac", "1", "-ar", "16000", "-f", "wav", out_path,
                ],
                check=True,
                timeout=30,
            )
            with open(out_path, "rb") as fh:
                return fh.read()
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass


def _run_inference(wav: bytes, language: str | None) -> dict:
    """The GPU-serialized inference. Acquires the concurrency semaphore so
    only CONCURRENCY transcriptions touch the GPU at once."""
    with _gpu_sem:
        with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
            tf.write(wav)
            tf.flush()
            started = time.time()
            segments, info = _model.transcribe(  # type: ignore[union-attr]
                tf.name,
                language=language or None,
                vad_filter=True,
            )
            text = "".join(seg.text for seg in segments).strip()
            return {
                "text": text,
                "language": getattr(info, "language", None),
                "audioSeconds": float(getattr(info, "duration", 0.0)),
                "durationMs": int((time.time() - started) * 1000),
            }


def _file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_weight(url: str, dest: str, expect_sha: str) -> None:
    """Fetch-once a single weight file into the model cache, fail-closed on
    a configured SHA256 pin. Already-present files are reused (and re-checked
    against the pin if one is set) — the named volume persists them."""
    if os.path.exists(dest):
        if expect_sha:
            got = _file_sha256(dest)
            if not hmac.compare_digest(got, expect_sha):
                raise RuntimeError(
                    f"cached {os.path.basename(dest)} checksum mismatch: "
                    f"expected {expect_sha}, got {got}"
                )
        return
    _log(f"fetching TTS weight {url} → {dest} …")
    tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp)  # noqa: S310 — pinned github release URL
    if expect_sha:
        got = _file_sha256(tmp)
        if not hmac.compare_digest(got, expect_sha):
            os.unlink(tmp)
            raise RuntimeError(
                f"downloaded {os.path.basename(dest)} checksum mismatch: "
                f"expected {expect_sha}, got {got}"
            )
    os.replace(tmp, dest)


def _build_tts_session(model_path: str):
    """Build the Kokoro onnxruntime InferenceSession, preferring the GPU.

    kokoro-onnx 0.5.0's own provider selection defaults to CPU (its
    `find_spec("onnxruntime-gpu")` probe uses the dashed dist name, which is
    never importable, so it silently stays on CPUExecutionProvider even when
    onnxruntime-gpu IS installed). We therefore build the session ourselves
    with an explicit CUDA->CPU provider preference list and hand it to
    `Kokoro.from_session`, so the TTS path actually lands on the GPU.

    Graceful fallback: if CUDA init raises (missing driver, cuDNN mismatch,
    no --gpus), we retry CPU-only rather than failing the whole sidecar. The
    active providers are logged so it's unambiguous which lane won.
    """
    import onnxruntime as rt  # heavy import, deferred

    available = rt.get_available_providers()
    _log(f"onnxruntime {rt.__version__} available providers: {available}")

    want = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
            if p in available]
    if "CUDAExecutionProvider" in want:
        try:
            sess = rt.InferenceSession(model_path, providers=want)
            active = sess.get_providers()
            if "CUDAExecutionProvider" in active:
                _log(f"TTS onnxruntime session ACTIVE on GPU (providers={active})")
                return sess
            _log(
                "TTS CUDAExecutionProvider requested but not active "
                f"(providers={active}); falling back to CPU"
            )
        except Exception as exc:  # noqa: BLE001 — degrade to CPU, don't die
            _log(f"TTS CUDA session init FAILED ({type(exc).__name__}: {exc}); "
                 "falling back to CPU")

    sess = rt.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    _log(f"TTS onnxruntime session ACTIVE on CPU (providers={sess.get_providers()})")
    return sess


def _kokoro_vocab(kokoro) -> "set[str] | None":
    """Kokoro's phoneme vocabulary, for validating the override table.

    kokoro-onnx builds its tokenizer from a fixed vocab; a symbol outside it
    is dropped WITHOUT ERROR (kokoro_onnx/tokenizer.py), so an override
    carrying one silently deletes that word from the audio. Reads the live
    tokenizer first and falls back to the packaged default; returns None if
    neither is reachable (validation is then skipped, and said so in the log).
    """
    try:
        vocab = getattr(getattr(kokoro, "tokenizer", None), "vocab", None)
        if vocab:
            return set(vocab)
    except Exception:  # noqa: BLE001 — fall through to the packaged default
        pass
    try:
        from kokoro_onnx.config import DEFAULT_VOCAB

        return set(DEFAULT_VOCAB)
    except Exception:  # noqa: BLE001
        return None


def _load_overrides(kokoro) -> None:
    """Load overrides.json and validate every phoneme against Kokoro's vocab.

    Rejected entries are DROPPED and logged loudly (and surfaced on /healthz)
    rather than shipped — a bad entry is worse than no entry, because the
    failure mode is a missing word, not a wrong one.
    """
    global _tts_overrides, _tts_overrides_rejected
    if _norm is None:
        return
    vocab = _kokoro_vocab(kokoro)
    if vocab is None:
        _log("TTS overrides: Kokoro vocab unavailable — loading table UNVALIDATED")
    accepted, rejected = _norm.load_overrides(vocab=vocab)
    with _tts_lock:
        _tts_overrides = accepted
        _tts_overrides_rejected = rejected
    _log(f"TTS pronunciation overrides: {len(accepted)} active, {len(rejected)} rejected")
    for match, reason in rejected:
        _log(f"TTS override REJECTED {match!r}: {reason}")


def _load_tts() -> None:
    """Fetch-once + load the Kokoro ONNX model. Runs in a background thread
    (like _load_model) so /healthz reports 'not ready' during the cold load
    and the server doesn't block on boot."""
    global _tts, _tts_error, _g2p
    try:
        os.makedirs(MODEL_CACHE, exist_ok=True)
        model_path = os.path.join(MODEL_CACHE, TTS_MODEL)
        voices_path = os.path.join(MODEL_CACHE, TTS_VOICES)
        _fetch_weight(TTS_MODEL_URL, model_path, TTS_MODEL_SHA256)
        _fetch_weight(TTS_VOICES_URL, voices_path, TTS_VOICES_SHA256)

        from kokoro_onnx import Kokoro  # heavy import, deferred

        _log(f"loading TTS model {TTS_MODEL} (voice={TTS_VOICE}) …")
        session = _build_tts_session(model_path)
        # from_session lets us drive the provider selection (GPU-first) rather
        # than kokoro-onnx's CPU-defaulting constructor.
        kokoro = Kokoro.from_session(session, voices_path)
        with _tts_lock:
            _tts = kokoro
        _log("TTS model ready")
        _load_overrides(kokoro)
    except Exception as exc:  # noqa: BLE001 — fail closed, report on /healthz
        _tts_error = f"{type(exc).__name__}: {exc}"
        _log(f"TTS model load FAILED: {_tts_error}")
        return

    # Build the misaki English G2P in its OWN try/except: it is an ENHANCEMENT
    # (heteronym-correct phonemes), NOT a requirement. If anything here fails —
    # misaki not installed, spaCy model missing, espeak fallback init error —
    # the sidecar stays fully healthy (_tts is already set, /healthz untouched)
    # and synthesis degrades to Kokoro's built-in espeak phonemizer, i.e.
    # exactly today's behavior. Only the English locales use it.
    if TTS_G2P == "misaki" and TTS_LANG in ("en-us", "en-gb"):
        try:
            from misaki import en, espeak  # heavy import, deferred

            british = TTS_LANG == "en-gb"
            g2p = en.G2P(
                trf=False,  # torch-free path (no spacy-curated-transformers)
                british=british,
                fallback=espeak.EspeakFallback(british=british),
            )
            with _tts_lock:
                _g2p = g2p
            _log(f"misaki G2P ready (lang={TTS_LANG}, british={british})")
        except Exception as exc:  # noqa: BLE001 — enhancement; degrade gracefully
            _log(
                f"misaki G2P load FAILED ({type(exc).__name__}: {exc}); "
                "falling back to espeak phonemization"
            )


def _pcm_to_wav_bytes(samples, sample_rate: int) -> bytes:
    """Pack Kokoro's float32 PCM (-1..1) into a 16-bit mono WAV container so
    ffmpeg can read it from a known format."""
    import numpy as np  # local — only TTS needs numpy

    pcm16 = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm16 * 32767.0).astype("<i2")
    buf = tempfile.SpooledTemporaryFile()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())
    buf.seek(0)
    return buf.read()


def _wav_to_ogg_opus(wav: bytes) -> bytes:
    """Transcode WAV → mono OGG/Opus via ffmpeg. Telegram sendVoice REQUIRES
    OGG/Opus, so this is the only supported output container."""
    with tempfile.NamedTemporaryFile(suffix=".wav") as src:
        src.write(wav)
        src.flush()
        out_path = src.name + ".ogg"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", src.name,
                    "-ac", "1", "-c:a", "libopus", "-f", "ogg", out_path,
                ],
                check=True,
                timeout=30,
            )
            with open(out_path, "rb") as fh:
                return fh.read()
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass


_SENTENCE_RE = None


def _split_text(text: str, max_chars: int) -> list[str]:
    """Split arbitrarily-long text into pieces ≤ max_chars, preferring
    paragraph then sentence then whitespace boundaries so a synthesized chunk
    never cuts mid-word (which would click / mispronounce). Each returned piece
    is non-empty and ≤ max_chars (a single token longer than max_chars is
    emitted whole rather than sliced mid-character)."""
    import re

    global _SENTENCE_RE
    if _SENTENCE_RE is None:
        # Split AFTER sentence-final punctuation (kept) or on a blank line.
        _SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+|\n{2,}")

    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    units = [u.strip() for u in _SENTENCE_RE.split(text) if u.strip()]
    pieces: list[str] = []
    cur = ""
    for unit in units:
        # A single unit longer than max_chars must itself be broken on
        # whitespace so no piece exceeds the cap.
        if len(unit) > max_chars:
            if cur:
                pieces.append(cur)
                cur = ""
            sub = ""
            for w in unit.split(" "):
                cand = (sub + " " + w).strip()
                if len(cand) > max_chars and sub:
                    pieces.append(sub)
                    sub = w
                else:
                    sub = cand
            if sub:
                cur = sub
            continue
        cand = (cur + " " + unit).strip()
        if len(cand) > max_chars and cur:
            pieces.append(cur)
            cur = unit
        else:
            cur = cand
    if cur:
        pieces.append(cur)
    return [p for p in pieces if p]


TTS_SPEED_MIN = 0.5
TTS_SPEED_MAX = 2.0
TTS_SPEED_DEFAULT = 1.0


def _clamp_speed(value: object) -> float:
    """Coerce an incoming speed to a float in [TTS_SPEED_MIN, TTS_SPEED_MAX].

    Absent / non-numeric / NaN → TTS_SPEED_DEFAULT (1.0), i.e. today's
    behavior. Out-of-range numbers are clamped to the nearest bound."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return TTS_SPEED_DEFAULT
    speed = float(value)
    if speed != speed:  # NaN
        return TTS_SPEED_DEFAULT
    return max(TTS_SPEED_MIN, min(TTS_SPEED_MAX, speed))


def _phonemize_piece(piece: str) -> tuple[str, bool]:
    """Convert one text piece to a Kokoro phoneme string via misaki's POS-aware
    English G2P.

    Returns (phonemes, True) on success — the caller then hands `phonemes` to
    Kokoro with is_phonemes=True, which is what makes heteronyms come out right.
    Returns (piece, False) — the raw TEXT, unchanged — when misaki is not in
    play (VOICE_TTS_G2P=espeak, a non-English locale, or a failed G2P load left
    _g2p None) OR when the misaki call itself raises / yields nothing; the
    caller then passes the text to Kokoro and gets today's espeak
    phonemization. A phonemize failure is logged ONCE, never per request.

    Pure and stub-testable WITHOUT misaki installed: the G2P handle is read from
    the module global, so a test can inject a fake (or None) and exercise both
    branches. Never raises — a phoneme miss must never fail a synthesis."""
    global _g2p_warned
    with _tts_lock:
        g2p = _g2p
        overrides = _tts_overrides
    if g2p is None:
        return piece, False
    try:
        # Pronunciation overrides are misaki-specific markup, so they are
        # applied HERE and nowhere earlier: on the espeak fallback path (g2p
        # is None, above) the `[word](/…/)` markup would be read out as
        # punctuation. Marked-up text is kept in its own local for exactly
        # that reason — every failure return below hands back the ORIGINAL
        # piece, never the markup.
        marked = piece
        if overrides and _norm is not None:
            marked = _norm.apply_overrides(piece, overrides)
        phonemes, _tokens = g2p(marked)
        if not phonemes:
            return piece, False
        return phonemes, True
    except Exception as exc:  # noqa: BLE001 — degrade to the espeak text path
        if not _g2p_warned:
            _g2p_warned = True
            _log(
                f"misaki phonemize failed ({type(exc).__name__}: {exc}); "
                "falling back to espeak text path (logged once)"
            )
        return piece, False


def _normalize_text(text: str) -> str:
    """Stage B — rewrite the request text into its spoken form.

    Runs BEFORE _split_text so the splitter sees final text (a rule that
    lengthens a piece, e.g. "$1.6M" → five words, must not push a piece past
    TTS_MAX_CHARS after the split). Never raises: a normaliser bug degrades
    to the raw text — today's behaviour — instead of failing the synthesis,
    and is logged once.
    """
    global _norm_warned
    if _norm is None:
        return text
    try:
        return _norm.normalize(text)
    except Exception as exc:  # noqa: BLE001 — degrade to raw text
        if not _norm_warned:
            _norm_warned = True
            _log(
                f"text normalisation failed ({type(exc).__name__}: {exc}); "
                "speaking raw text (logged once)"
            )
        return text


def _run_synthesis(text: str, voice: str, speed: float = TTS_SPEED_DEFAULT) -> tuple[bytes, dict]:
    """The TTS-serialized synthesis. Acquires the TTS semaphore so only
    TTS_CONCURRENCY synths run at once — a separate lane from STT.

    Accepts text of ANY length: it is split into pieces ≤ TTS_MAX_CHARS on
    sentence/paragraph boundaries, each synthesized on the GPU, and the raw
    24kHz PCM concatenated into ONE stream (with a short inter-piece pad so
    joins sound natural and never click) before a SINGLE opus encode. The
    caller therefore always gets one valid, continuous Ogg/Opus file."""
    import numpy as np  # local — only TTS needs numpy

    with _tts_sem:
        started = time.time()
        text = _normalize_text(text)
        pieces = _split_text(text, TTS_MAX_CHARS)
        if not pieces:
            pieces = [text]

        # ~120ms of silence between pieces at 24kHz mono — keeps the cadence
        # natural across a sentence join without a jarring click.
        pad = np.zeros(int(TTS_SAMPLE_RATE * 0.12), dtype=np.float32)

        chunks: list[np.ndarray] = []
        sample_rate = TTS_SAMPLE_RATE
        for i, piece in enumerate(pieces):
            # misaki's POS-aware G2P runs here, INSIDE _tts_sem — so with
            # VOICE_TTS_CONCURRENCY defaulting to 1, spaCy is never called
            # concurrently. On a hit we hand Kokoro the phoneme string
            # (is_phonemes=True — the heteronym fix); on any miss we hand it the
            # raw TEXT and Kokoro phonemizes via espeak (today's path). A
            # regression must never route a phoneme string through the espeak
            # text path, so the two branches are kept explicit. See
            # _phonemize_piece / VOICE_TTS_G2P=espeak (rollback lever).
            content, is_phonemes = _phonemize_piece(piece)
            if is_phonemes:
                samples, sample_rate = _tts.create(  # type: ignore[union-attr]
                    content, voice=voice, speed=speed, is_phonemes=True
                )
            else:
                samples, sample_rate = _tts.create(  # type: ignore[union-attr]
                    piece, voice=voice, speed=speed, lang=TTS_LANG
                )
            arr = np.asarray(samples, dtype=np.float32)
            if i > 0:
                chunks.append(pad)
            chunks.append(arr)

        all_samples = (
            np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        )
        wav = _pcm_to_wav_bytes(all_samples, sample_rate)
        ogg = _wav_to_ogg_opus(wav)
        elapsed_ms = int((time.time() - started) * 1000)
        audio_seconds = round(len(all_samples) / float(sample_rate), 3)
        meta = {
            "audioSeconds": audio_seconds,
            "durationMs": elapsed_ms,
            "voice": voice,
            "speed": speed,
            "pieces": len(pieces),
            "chars": len(text),
        }
        _log(
            f"synth: {len(text)} chars -> {len(pieces)} piece(s) -> "
            f"{audio_seconds:.2f}s audio in {elapsed_ms}ms"
        )
        return ogg, meta


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # silence default access logging
        pass

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_bytes(self, status: int, content_type: str, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authed(self) -> bool:
        # Constant-time compare of the shared secret. A sidecar with no token
        # configured refuses every call (fail closed).
        token = self.headers.get("X-Voice-Token", "")
        if not SHARED_TOKEN or not hmac.compare_digest(token, SHARED_TOKEN):
            self._send_json(401, {"ok": False, "reason": "unauthorized"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.split("?")[0] != "/healthz":
            self._send_json(404, {"ok": False, "reason": "not-found"})
            return
        with _model_lock:
            stt_ready = _model is not None
        with _tts_lock:
            tts_ready = _tts is not None
            overrides_active = list(_tts_overrides)
            overrides_rejected = list(_tts_overrides_rejected)
        # A sticky wedge (too many consecutive GPU timeouts — see the watchdog
        # above) reports unhealthy even when both models loaded, so the compose
        # healthcheck restarts the container to release the stuck permit.
        if _is_wedged():
            self._send_json(
                503,
                {
                    "ok": False,
                    "reason": "wedged",
                    "stt": stt_ready,
                    "tts": tts_ready,
                    "detail": "consecutive GPU timeouts — restarting to recover",
                },
            )
        elif stt_ready and tts_ready:
            body = {
                "ok": True,
                "status": "ready",
                "stt": True,
                "tts": True,
                "normalize": _norm is not None and _norm.normalize_enabled(),
                "overrides": len(overrides_active),
            }
            # A rejected override is a word that will be MISSING from the
            # audio if anyone re-adds it unvalidated, so it is surfaced here
            # (degraded, not unhealthy — the rest of the table still works).
            if overrides_rejected or _norm_error:
                degraded: dict = {}
                if overrides_rejected:
                    degraded["overridesRejected"] = [
                        {"match": m, "reason": r} for m, r in overrides_rejected
                    ]
                if _norm_error:
                    degraded["normalize"] = _norm_error
                body["degraded"] = degraded
            self._send_json(200, body)
        else:
            self._send_json(
                503,
                {
                    "ok": False,
                    "reason": "loading",
                    "stt": stt_ready,
                    "tts": tts_ready,
                    "detail": {"stt": _model_error, "tts": _tts_error},
                },
            )

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0]
        if route == "/stt":
            self._handle_stt()
        elif route == "/tts":
            self._handle_tts()
        else:
            self._send_json(404, {"ok": False, "reason": "not-found"})

    def _handle_stt(self) -> None:
        if not self._authed():
            return

        with _model_lock:
            ready = _model is not None
        if not ready:
            self._send_json(
                503, {"ok": False, "reason": "model-not-ready", "detail": _model_error}
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "reason": "empty-body"})
            return
        if length > MAX_BYTES + (1 << 20):  # +1MB multipart slack
            self._send_json(
                413, {"ok": False, "reason": "audio-too-large", "detail": str(length)}
            )
            return

        body = self.rfile.read(length)
        audio, language = _parse_multipart(body, self.headers.get("Content-Type", ""))
        if audio is None or len(audio) == 0:
            self._send_json(400, {"ok": False, "reason": "no-audio-part"})
            return
        if len(audio) > MAX_BYTES:
            self._send_json(
                413, {"ok": False, "reason": "audio-too-large", "detail": str(len(audio))}
            )
            return

        try:
            wav = _transcode_to_wav(audio)
        except subprocess.TimeoutExpired:
            self._send_json(503, {"ok": False, "reason": "transcode-timeout"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                400, {"ok": False, "reason": "transcode-failed", "detail": str(exc)[:200]}
            )
            return

        # Run inference with a hard server-side timeout so a wedged GPU
        # call can't pin the worker forever.
        future = _pool.submit(_run_inference, wav, language)
        try:
            result = future.result(timeout=REQUEST_TIMEOUT_S)
        except FutureTimeout:
            # The worker keeps running (and holding _gpu_sem) — feed the
            # watchdog so repeated wedges trigger a restart-to-recover.
            _note_timeout()
            self._send_json(503, {"ok": False, "reason": "timeout"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                500, {"ok": False, "reason": "inference-failed", "detail": str(exc)[:200]}
            )
            return

        _note_success()
        self._send_json(200, {"ok": True, **result})

    def _handle_tts(self) -> None:
        if not self._authed():
            return

        with _tts_lock:
            ready = _tts is not None
        if not ready:
            self._send_json(
                503, {"ok": False, "reason": "model-not-ready", "detail": _tts_error}
            )
            return

        if TTS_FORMAT != "ogg":
            self._send_json(
                500, {"ok": False, "reason": "unsupported-format", "detail": TTS_FORMAT}
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "reason": "empty-body"})
            return
        # /tts accepts text of ANY length (chunked internally to TTS_MAX_CHARS
        # and re-joined into one file), but a hard byte ceiling still guards
        # against an abusive multi-MB body.
        if length > TTS_MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "reason": "body-too-large"})
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "reason": "invalid-json"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"ok": False, "reason": "invalid-json"})
            return

        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            self._send_json(400, {"ok": False, "reason": "empty-text"})
            return
        # No length cap here: text of ANY length is accepted and chunked
        # internally to TTS_MAX_CHARS-sized pieces, then re-joined into ONE
        # ogg/opus stream (see _run_synthesis). The byte-length guard above is
        # the only ceiling.
        text = text.strip()

        fmt = payload.get("format", TTS_FORMAT)
        if fmt not in (None, "ogg"):
            self._send_json(
                400, {"ok": False, "reason": "unsupported-format", "detail": str(fmt)}
            )
            return

        voice = payload.get("voice")
        if voice is not None and not isinstance(voice, str):
            self._send_json(400, {"ok": False, "reason": "invalid-voice"})
            return
        voice = (voice or TTS_VOICE).strip() or TTS_VOICE

        # Optional playback speed. Clamp to [0.5, 2.0]; absent/invalid → 1.0
        # (exactly today's behavior).
        speed = _clamp_speed(payload.get("speed"))

        # Run synthesis with a hard server-side timeout so a wedged synth
        # can't pin the worker forever (its own TTS pool/lane).
        future = _tts_pool.submit(_run_synthesis, text, voice, speed)
        try:
            ogg, meta = future.result(timeout=TTS_REQUEST_TIMEOUT_S)
        except FutureTimeout:
            # The worker keeps running (and holding _tts_sem) — feed the
            # watchdog so repeated wedges trigger a restart-to-recover.
            _note_timeout()
            self._send_json(503, {"ok": False, "reason": "timeout"})
            return
        except AssertionError as exc:  # kokoro rejects unknown voice / bad speed
            self._send_json(
                400, {"ok": False, "reason": "synthesis-rejected", "detail": str(exc)[:200]}
            )
            return
        except subprocess.TimeoutExpired:
            self._send_json(503, {"ok": False, "reason": "transcode-timeout"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                500, {"ok": False, "reason": "synthesis-failed", "detail": str(exc)[:200]}
            )
            return

        _note_success()
        # Telegram sendVoice consumes these bytes directly: OGG/Opus, mono.
        self.send_response(200)
        self.send_header("Content-Type", "audio/ogg")
        self.send_header("Content-Length", str(len(ogg)))
        self.send_header("X-Voice-Duration-Ms", str(meta["durationMs"]))
        self.send_header("X-Voice-Audio-Seconds", str(meta["audioSeconds"]))
        self.send_header("X-Voice-Voice", meta["voice"])
        self.end_headers()
        self.wfile.write(ogg)


def _parse_multipart(body: bytes, content_type: str):
    """Minimal multipart/form-data parser — extracts the `audio` part bytes
    and an optional `language` field. Avoids a framework dependency."""
    if "multipart/form-data" not in content_type:
        return None, None
    marker = "boundary="
    idx = content_type.find(marker)
    if idx < 0:
        return None, None
    boundary = content_type[idx + len(marker):].strip().strip('"')
    delim = ("--" + boundary).encode("utf-8")
    audio = None
    language = None
    for part in body.split(delim):
        if not part or part in (b"--\r\n", b"--", b"\r\n"):
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end < 0:
            continue
        headers = part[:header_end].decode("utf-8", "replace")
        data = part[header_end + 4:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        disp = next((l for l in headers.splitlines() if "content-disposition" in l.lower()), "")
        if 'name="audio"' in disp:
            audio = data
        elif 'name="language"' in disp:
            language = data.decode("utf-8", "replace").strip() or None
    return audio, language


def main() -> int:
    if not SHARED_TOKEN:
        _log("WARNING: VOICE_SIDECAR_TOKEN is empty — every /stt and /tts call will 401")
    threading.Thread(target=_load_model, daemon=True).start()
    threading.Thread(target=_load_tts, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    _log(
        f"listening on :{LISTEN_PORT} "
        f"(stt-concurrency={CONCURRENCY}, tts-concurrency={TTS_CONCURRENCY})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
