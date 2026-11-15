"""Hermes bundled providers for the local Kokoro and faster-whisper sidecar.

Two sidecars are supported, chosen by HERMES_KOKORO_SIDECAR_URL:

* the Fleet Kokoro sidecar (``http://voice:8126``): ``/tts``, ``/stt`` and
  ``/healthz`` with an ``X-Voice-Token`` header; speech and transcription;
* an OpenAI-compatible Kokoro server such as the CPU build of Kokoro-FastAPI,
  named by a URL ending in ``/v1`` (``http://voice:8880/v1``):
  ``/v1/audio/speech`` with a bearer token and ``/health``; speech only, so
  transcription reports itself unavailable instead of falling back anywhere.
"""
from __future__ import annotations

import json
import mimetypes
import os
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.tts_provider import TTSProvider
from agent.transcription_provider import TranscriptionProvider

DEFAULT_VOICE = "af_heart"
DEFAULT_SPEED = 1.1


def _base_url() -> str:
    raw = os.environ.get("HERMES_KOKORO_SIDECAR_URL", "").strip()
    if not raw:
        raise RuntimeError("HERMES_KOKORO_SIDECAR_URL is not set")
    parsed = urllib.parse.urlparse(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise RuntimeError("HERMES_KOKORO_SIDECAR_URL must be an http(s) host URL")
    return raw.rstrip("/")


def _openai_compatible() -> bool:
    """An OpenAI-compatible Kokoro server is named by a URL ending in /v1."""
    return urllib.parse.urlparse(_base_url()).path.rstrip("/").endswith("/v1")


def _token() -> str:
    token = os.environ.get("HERMES_KOKORO_SIDECAR_TOKEN", "").strip()
    if not token:
        raise RuntimeError("HERMES_KOKORO_SIDECAR_TOKEN is not loaded")
    return token


def _health() -> Dict[str, Any]:
    """Sidecar health as the Fleet sidecar reports it: ``ok``, ``tts`` and ``stt``."""
    if _openai_compatible():
        root = _base_url()[: -len("/v1")]
        with urllib.request.urlopen(root + "/health", timeout=3) as response:
            healthy = json.loads(response.read().decode("utf-8")).get("status") == "healthy"
        return {"ok": healthy, "tts": healthy, "stt": False}
    with urllib.request.urlopen(_base_url() + "/healthz", timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(path: str, body: bytes, content_type: str, timeout: float = 90.0) -> tuple[int, bytes]:
    request = urllib.request.Request(
        _base_url() + path,
        data=body,
        method="POST",
        headers={"Content-Type": content_type,
                 **({"Authorization": "Bearer " + _token()} if _openai_compatible() else {"X-Voice-Token": _token()})},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


class KokoroProvider(TTSProvider):
    @property
    def name(self) -> str:
        return "kokoro"

    @property
    def display_name(self) -> str:
        return "Kokoro + Misaki (local sidecar)"

    @property
    def voice_compatible(self) -> bool:
        return True

    def is_available(self) -> bool:
        try:
            health = _health()
            return bool(health.get("ok") and health.get("tts"))
        except Exception:
            return False

    def list_voices(self) -> List[Dict[str, Any]]:
        return [
            {"id": "af_heart", "display": "Heart (US female)", "language": "en-US", "gender": "female"},
            {"id": "af_bella", "display": "Bella (US female)", "language": "en-US", "gender": "female"},
            {"id": "am_michael", "display": "Michael (US male)", "language": "en-US", "gender": "male"},
            {"id": "bf_emma", "display": "Emma (UK female)", "language": "en-GB", "gender": "female"},
            {"id": "bm_george", "display": "George (UK male)", "language": "en-GB", "gender": "male"},
        ]

    def default_voice(self) -> Optional[str]:
        return os.environ.get("HERMES_KOKORO_VOICE", DEFAULT_VOICE)

    def get_setup_schema(self) -> Dict[str, Any]:
        return {"name": self.display_name, "badge": "local", "tag": "Hermes-owned Kokoro ONNX service", "env_vars": []}

    def synthesize(self, text: str, output_path: str, *, voice: Optional[str] = None, speed: Optional[float] = None, **_: Any) -> str:
        chosen = voice or self.default_voice() or DEFAULT_VOICE
        rate = max(0.5, min(2.0, float(DEFAULT_SPEED if speed is None else speed)))
        if _openai_compatible():
            # "opus" is Ogg Opus, which Telegram voice notes require.
            body = json.dumps({"model": "kokoro", "input": text, "voice": chosen, "speed": rate,
                               "response_format": "opus"}).encode()
            status, audio = _post("/audio/speech", body, "application/json")
        else:
            body = json.dumps({"text": text, "voice": chosen, "speed": rate, "format": "ogg"}).encode()
            status, audio = _post("/tts", body, "application/json")
        if status != 200 or not audio.startswith(b"OggS"):
            raise RuntimeError("Kokoro sidecar returned invalid audio")
        target = Path(output_path).with_suffix(".ogg")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(audio)
        return str(target)


class KokoroSidecarSTTProvider(TranscriptionProvider):
    @property
    def name(self) -> str:
        return "kokoro_sidecar"

    @property
    def display_name(self) -> str:
        return "Faster-Whisper (local voice sidecar)"

    def is_available(self) -> bool:
        try:
            return bool(_health().get("ok") and _health().get("stt"))
        except Exception:
            return False

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": "faster-whisper-base", "display": "Faster-Whisper Base (local GPU)", "languages": ["en"]}]

    def default_model(self) -> Optional[str]:
        return "faster-whisper-base"

    def get_setup_schema(self) -> Dict[str, Any]:
        return {"name": self.display_name, "badge": "local", "tag": "GPU faster-whisper via Hermes voice sidecar", "env_vars": []}

    def transcribe(self, file_path: str, *, language: Optional[str] = None, **_: Any) -> Dict[str, Any]:
        try:
            if _openai_compatible():
                return {"success": False, "transcript": "", "provider": self.name,
                        "error": "this Kokoro server has no transcription; use the Fleet Kokoro sidecar"}
            source = Path(file_path)
            audio = source.read_bytes()
            if not audio:
                return {"success": False, "transcript": "", "provider": self.name, "error": "Audio file is empty"}
            boundary = "----HermesKokoro" + uuid.uuid4().hex
            mime = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
            filename = Path(source.name).name.replace('"', "").replace("\r", "").replace("\n", "") or "audio"
            parts = [
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode(),
                audio,
            ]
            if language:
                parts.append(f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{language}".encode())
            parts.append(f"\r\n--{boundary}--\r\n".encode())
            status, payload = _post("/stt", b"".join(parts), f"multipart/form-data; boundary={boundary}", timeout=120)
            data = json.loads(payload.decode("utf-8", errors="replace"))
            transcript = str(data.get("text") or "").strip()
            if status != 200 or not transcript:
                return {"success": False, "transcript": "", "provider": self.name, "error": str(data.get("error") or "No transcript returned")}
            return {"success": True, "transcript": transcript, "provider": self.name}
        except Exception as exc:
            return {"success": False, "transcript": "", "provider": self.name, "error": f"{type(exc).__name__}: {exc}"}


def register(ctx):
    ctx.register_tts_provider(KokoroProvider())
    ctx.register_transcription_provider(KokoroSidecarSTTProvider())
