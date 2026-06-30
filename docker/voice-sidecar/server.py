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

HTTP contract
-------------
  POST /stt   multipart: audio=<bytes>, optional language=<iso-639-1>
              header:    X-Voice-Token: <shared secret>
              → 200 { ok: true,  text, language?, durationMs, audioSeconds }
              → 4xx/5xx { ok: false, reason, detail }
  POST /tts   json: { text: str, voice?: str, format?: "ogg" }
              header:    X-Voice-Token: <shared secret>
              → 200 audio/ogg  (OGG/Opus, mono — ready for Telegram
                sendVoice, which REQUIRES OGG/Opus)
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
# Only OGG/Opus is wired (Telegram sendVoice requires it); the env exists so
# a future format can be added without a contract change.
TTS_FORMAT = os.environ.get("VOICE_TTS_FORMAT", "ogg").lower()
TTS_CONCURRENCY = max(1, int(os.environ.get("VOICE_TTS_CONCURRENCY", "1")))
TTS_REQUEST_TIMEOUT_S = float(os.environ.get("VOICE_TTS_REQUEST_TIMEOUT_S", "60"))
TTS_MAX_CHARS = int(os.environ.get("VOICE_TTS_MAX_CHARS", "1200"))
TTS_SAMPLE_RATE = 24000  # Kokoro always emits 24kHz mono float PCM.

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


def _load_tts() -> None:
    """Fetch-once + load the Kokoro ONNX model. Runs in a background thread
    (like _load_model) so /healthz reports 'not ready' during the cold load
    and the server doesn't block on boot."""
    global _tts, _tts_error
    try:
        os.makedirs(MODEL_CACHE, exist_ok=True)
        model_path = os.path.join(MODEL_CACHE, TTS_MODEL)
        voices_path = os.path.join(MODEL_CACHE, TTS_VOICES)
        _fetch_weight(TTS_MODEL_URL, model_path, TTS_MODEL_SHA256)
        _fetch_weight(TTS_VOICES_URL, voices_path, TTS_VOICES_SHA256)

        from kokoro_onnx import Kokoro  # heavy import, deferred

        _log(f"loading TTS model {TTS_MODEL} (voice={TTS_VOICE}) …")
        kokoro = Kokoro(model_path, voices_path)
        with _tts_lock:
            _tts = kokoro
        _log("TTS model ready")
    except Exception as exc:  # noqa: BLE001 — fail closed, report on /healthz
        _tts_error = f"{type(exc).__name__}: {exc}"
        _log(f"TTS model load FAILED: {_tts_error}")


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


def _run_synthesis(text: str, voice: str) -> tuple[bytes, dict]:
    """The TTS-serialized synthesis. Acquires the TTS semaphore so only
    TTS_CONCURRENCY synths run at once — a separate lane from STT."""
    with _tts_sem:
        started = time.time()
        samples, sample_rate = _tts.create(  # type: ignore[union-attr]
            text, voice=voice, speed=1.0, lang=TTS_LANG
        )
        wav = _pcm_to_wav_bytes(samples, sample_rate)
        ogg = _wav_to_ogg_opus(wav)
        meta = {
            "audioSeconds": round(len(samples) / float(sample_rate), 3),
            "durationMs": int((time.time() - started) * 1000),
            "voice": voice,
        }
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
        if stt_ready and tts_ready:
            self._send_json(
                200, {"ok": True, "status": "ready", "stt": True, "tts": True}
            )
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
            self._send_json(503, {"ok": False, "reason": "timeout"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                500, {"ok": False, "reason": "inference-failed", "detail": str(exc)[:200]}
            )
            return

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
        # Generous JSON cap: TTS_MAX_CHARS chars + envelope slack.
        if length > TTS_MAX_CHARS * 4 + 4096:
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
        text = text.strip()
        if len(text) > TTS_MAX_CHARS:
            self._send_json(
                413,
                {
                    "ok": False,
                    "reason": "text-too-long",
                    "detail": f"{len(text)} > {TTS_MAX_CHARS}",
                },
            )
            return

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

        # Run synthesis with a hard server-side timeout so a wedged synth
        # can't pin the worker forever (its own TTS pool/lane).
        future = _tts_pool.submit(_run_synthesis, text, voice)
        try:
            ogg, meta = future.result(timeout=TTS_REQUEST_TIMEOUT_S)
        except FutureTimeout:
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
