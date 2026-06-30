#!/usr/bin/env python3
"""
switchroom voice STT sidecar (voice feature PR-B2).

A tiny HTTP server that wraps `faster-whisper` (CTranslate2) for local,
on-GPU speech-to-text. It exists so the fleet can transcribe inbound
voice notes WITHOUT a third-party API key (vision #3 subscription-honest)
and WITHOUT depending on cloud reachability (vision #4 always-available),
WHEN the host has a usable GPU (the PR-B1 `engine='local'` verdict).

Scope (PR-B2): STT only. TTS / Kokoro `/tts` lands in PR-C.

HTTP contract
-------------
  POST /stt   multipart: audio=<bytes>, optional language=<iso-639-1>
              header:    X-Voice-Token: <shared secret>
              → 200 { ok: true,  text, language?, durationMs, audioSeconds }
              → 4xx/5xx { ok: false, reason, detail }
  GET  /healthz
              → 200 only once the model is fully loaded (model cold-load
                can take 30-90s; the compose healthcheck start_period is
                generous to match).

Design constraints (reviewed):
  * Auth — every /stt call must carry the X-Voice-Token shared secret
    (injected from the vault, see compose.ts). A missing/wrong token is
    401. /healthz is unauthenticated (it leaks nothing).
  * GPU serialization — concurrent fleet requests must not thrash / OOM
    the GPU. A bounded semaphore (VOICE_STT_CONCURRENCY, default 1)
    serializes the actual whisper inference; queued callers wait.
  * Per-request timeout — a single request can't pin the GPU forever
    (VOICE_STT_REQUEST_TIMEOUT_S, default 60s) → 503 timeout.
  * Input normalization — Telegram voice is OGG/Opus; uploaded audio
    varies. ffmpeg transcodes everything to 16kHz mono WAV before
    whisper so the decoder never has to guess.
  * Model weights are fetched ONCE on first boot into a named volume
    (VOICE_MODEL_CACHE), never baked into the image (size + weight-
    redistribution licensing). The model id is pinned; if a SHA256 of
    the downloaded model dir is configured it is verified fail-closed.
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

# ── model state (loaded once, in a background thread at boot) ───────────
_model = None
_model_lock = threading.Lock()
_model_error: str | None = None
# Bounds concurrent GPU inference so the fleet can't OOM/thrash the card.
_gpu_sem = threading.Semaphore(CONCURRENCY)
# A small pool so a per-request timeout can abandon a slow inference
# without blocking the HTTP handler thread forever.
_pool = ThreadPoolExecutor(max_workers=CONCURRENCY + 2)


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

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.split("?")[0] != "/healthz":
            self._send_json(404, {"ok": False, "reason": "not-found"})
            return
        with _model_lock:
            ready = _model is not None
        if ready:
            self._send_json(200, {"ok": True, "status": "ready"})
        else:
            self._send_json(
                503,
                {"ok": False, "reason": "loading", "detail": _model_error},
            )

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/stt":
            self._send_json(404, {"ok": False, "reason": "not-found"})
            return

        # Auth — constant-time compare of the shared secret. A sidecar with
        # no token configured refuses every call (fail closed).
        token = self.headers.get("X-Voice-Token", "")
        if not SHARED_TOKEN or not hmac.compare_digest(token, SHARED_TOKEN):
            self._send_json(401, {"ok": False, "reason": "unauthorized"})
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
        _log("WARNING: VOICE_SIDECAR_TOKEN is empty — every /stt call will 401")
    threading.Thread(target=_load_model, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    _log(f"listening on :{LISTEN_PORT} (concurrency={CONCURRENCY})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
