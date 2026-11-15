"""Regressions for the defects a real-container boot of the starter overlay found.

1. The shared skill pack must sit where Hermes searches (HERMES_HOME/skills);
   Hermes never reads skills.external_dirs from the managed config.
2. The CPU voice sidecar must be a CPU-only image; the Fleet Kokoro image loads
   the CUDA runtime at start and crashes without a GPU.
3. Voice off means text-only: no hosted speech engine, no speech tool.
4. Honcho must start with no egress: its tokenizer file is fetched once,
   pinned by hash, into a cache it reads.
5. A Claude default is on only when the login really exists, not when
   CLAUDE_CONFIG_DIR is merely set.
6. model-roles is off when no provider in the chain is on.
7. The setup check runs with what the Hermes image ships (ruamel.yaml, no PyYAML).

The renderer and the setup check share one readiness decision per default;
RendererDoctorAgreementTests proves they agree, with every credential present
and with each one missing.
"""
from __future__ import annotations

import hashlib
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
OVERLAY = ROOT / "examples" / "overlay-repo"
FLEET_CONFIG = OVERLAY / "fleet-config"
CONTRACT = ROOT / "contracts" / "plugins.json"
DOCTOR = SCRIPTS / "switchroom-doctor.py"
RENDER = SCRIPTS / "render-overlay-config.py"

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False
try:
    import ruamel.yaml  # noqa: F401
    HAVE_RUAMEL = True
except ImportError:  # pragma: no cover - environment dependent
    HAVE_RUAMEL = False
HAVE_A_YAML = HAVE_YAML or HAVE_RUAMEL

FULL_ENV = {
    "CLAUDE_CONFIG_DIR": "/opt/data/.claude",
    "LINEAR_TOKEN_FILE": "/opt/data/secrets/linear-token",
    "LINEAR_VIEWER_ID": "00000000-0000-4000-8000-0000000fa4e1",
    "LINEAR_ORGANIZATION_ID": "00000000-0000-4000-8000-0000000fa4e2",
    "HERMES_KOKORO_SIDECAR_URL": "http://voice:8880/v1",
    "HERMES_KOKORO_SIDECAR_TOKEN": "voice-token-SECRET-value",
    "HONCHO_BASE_URL": "http://honcho:8000",
    "PERPLEXITY_API_KEY": "pplx-SECRET-key-value",
    "OP_CONNECT_HOST": "http://onepassword-connect-api:8080",
    "OP_CONNECT_TOKEN": "connect-token-SECRET-value",
}
O200K_URL = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
# tiktoken_ext/openai_public.py o200k_base expected_hash (tiktoken 0.12.0).
O200K_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
KOKORO_CPU = "ghcr.io/remsky/kokoro-fastapi-cpu@sha256:"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


sd = _load("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")
fixture = _load("starter_overlay_fixture", ROOT / "tests" / "starter_overlay_fixture.py")


def run(script: Path, *args: str, python: list[str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([*(python or [sys.executable]), str(script), *args], cwd=ROOT, text=True,
                          capture_output=True, check=False, timeout=60)


def full_paths(tmp, env: dict = FULL_ENV, **kwargs):
    return sd.ContainerPaths(root=fixture.full_container_root(Path(tmp), env, **kwargs), hermes_home="/opt/data")


def render(env: dict = FULL_ENV, agent: str = "ops", paths=None, config_dir: Path = FLEET_CONFIG):
    return sd.render(config_dir, agent, sd.env_names(env), CONTRACT, environ=env, paths=paths)


def lines_of(lines: list[str]) -> dict[str, str]:
    return dict(line.split(": ", 1) for line in lines if not line.startswith("warning:"))


def compose_doc(name: str) -> dict:
    return yaml.safe_load((OVERLAY / name).read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 1. skills

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class SkillPackDiscoveryTests(unittest.TestCase):
    def test_pack_is_mounted_inside_the_hermes_skills_dir_not_in_external_dirs(self) -> None:
        rendered = render(paths=None)
        self.assertNotIn("skills", rendered.config)
        self.assertEqual(rendered.leaves["_switchroom.skill_pack"], fixture.SKILL_PACK)
        self.assertTrue(fixture.SKILL_PACK.startswith("/opt/data/skills/"))
        schema = sd.load_schema(FLEET_CONFIG)
        self.assertNotIn("skills.external_dirs", schema)

    @unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
    def test_compose_mounts_the_pack_where_the_config_says(self) -> None:
        compose = compose_doc("compose.yaml")
        for agent in ("ops", "worker"):
            binds = [v for v in compose["services"][agent]["volumes"] if isinstance(v, str)]
            self.assertIn(f"./vendor/hermes-fleet/skills:{fixture.SKILL_PACK}:ro", binds, agent)
            self.assertFalse([b for b in binds if "/opt/skill-packs" in b], agent)

    def test_setup_check_walks_the_hermes_skills_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = full_paths(tmp)
            config = render(paths=paths).config
            self.assertEqual(lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
                             ["shared-skill-pack"], "on")
            # The old mount point is outside HERMES_HOME/skills: Hermes never finds it.
            pack = paths.root / fixture.SKILL_PACK.lstrip("/")
            shutil.rmtree(pack)
            fixture.write(paths.root / "opt/skill-packs/shared/example-skill/SKILL.md", "---\nname: x\n---\n")
            line = lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
            self.assertTrue(line["shared-skill-pack"].startswith("off: disabled: Hermes finds no skills"), line)
            config["_switchroom"]["skill_pack"] = "/opt/skill-packs/shared"
            line = lines_of(sd.diagnose(config, FULL_ENV, CONTRACT)[0])["shared-skill-pack"]
            self.assertEqual(line, "off: disabled: /opt/skill-packs/shared is outside /opt/data/skills, "
                                   "where Hermes looks for skills")

    def test_external_dirs_in_the_managed_config_is_a_problem(self) -> None:
        config = render().config
        config["skills"] = {"external_dirs": ["/opt/skill-packs/shared"]}
        _, problems = sd.diagnose(config, FULL_ENV, CONTRACT)
        self.assertTrue(any("never reads for skills" in p for p in problems), problems)

    @unittest.skipUnless(os.environ.get("HERMES_AGENT_SOURCE"), "set HERMES_AGENT_SOURCE to a pinned Agent checkout")
    def test_real_hermes_discovery_matches(self) -> None:
        """Against the real agent.skill_utils: managed external_dirs ignored, the mount found."""
        source = Path(os.environ["HERMES_AGENT_SOURCE"])
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            fixture.write(home / "skills/switchroom-shared/demo-skill/SKILL.md", "---\nname: demo-skill\n---\n")
            fixture.write(home / "config.yaml", "model:\n  provider: none\n")
            fixture.write(Path(tmp) / "elsewhere/other-skill/SKILL.md", "---\nname: other-skill\n---\n")
            fixture.write(Path(tmp) / "managed/config.yaml", f"skills:\n  external_dirs: [{tmp}/elsewhere]\n")
            probe = ("from agent import skill_utils as su\n"
                     "print('\\n'.join(str(p) for _, d in su.get_skill_search_roots(include_project=False)"
                     " for p in su.iter_skill_index_files(d, 'SKILL.md')))\n")
            env = dict(os.environ, HOME=tmp, HERMES_HOME=str(home), HERMES_MANAGED_DIR=f"{tmp}/managed")
            result = subprocess.run([sys.executable, "-c", probe], cwd=source, env=env, text=True,
                                    capture_output=True, check=False, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("switchroom-shared/demo-skill/SKILL.md", result.stdout)
        self.assertNotIn("other-skill", result.stdout)


# ------------------------------------------------------------------- 2. kokoro

@unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
class KokoroCpuSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = (OVERLAY / "compose.sidecars.yaml").read_text(encoding="utf-8")
        self.compose = yaml.safe_load(self.text)

    def test_cpu_default_is_the_upstream_cpu_build_pinned_by_digest(self) -> None:
        voice = self.compose["services"]["voice"]
        image = voice["image"].split(":-", 1)[1].rstrip("}")
        self.assertTrue(image.startswith(KOKORO_CPU), image)
        self.assertRegex(image, r"@sha256:[0-9a-f]{64}$")
        self.assertNotIn("hermes-fleet-kokoro@", voice["image"])
        for key in ("gpus", "deploy", "runtime", "devices"):
            self.assertNotIn(key, voice)
        # Weights are built in: no download at start and no egress network.
        self.assertEqual(voice["environment"]["DOWNLOAD_MODEL"], "false")
        self.assertEqual(voice["networks"], ["voice"])
        self.assertNotIn("voice-egress", self.compose["networks"])

    def test_gpu_variant_stays_documented(self) -> None:
        self.assertIn("GPU variant (optional)", self.text)
        self.assertIn("ghcr.io/mekenthompson/hermes-fleet-kokoro@sha256:", self.text)
        docs = (ROOT / "docs" / "sidecars.md").read_text(encoding="utf-8")
        self.assertIn("kokoro-fastapi-cpu", docs)
        self.assertIn("gpus: all", docs)


class _StubProvider:
    pass


class _KokoroServer(http.server.BaseHTTPRequestHandler):
    calls: list[tuple[str, str, dict]] = []

    def log_message(self, *args) -> None:  # noqa: D401 - quiet test server
        pass

    def _reply(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        type(self).calls.append(("GET", self.path, dict(self.headers)))
        if self.path == "/health":
            self._reply(200, b'{"status": "healthy"}', "application/json")
        else:
            self._reply(404, b"{}", "application/json")

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).calls.append(("POST", self.path, {**dict(self.headers), "_body": body.decode("utf-8", "replace")}))
        if self.path == "/v1/audio/speech":
            self._reply(200, b"OggS synthetic", "audio/ogg")
        else:
            self._reply(404, b"{}", "application/json")


class KokoroVoicePluginOpenAIModeTests(unittest.TestCase):
    """The kokoro-voice plugin drives an OpenAI-compatible Kokoro server (the CPU build)."""

    @classmethod
    def setUpClass(cls) -> None:
        tts = types.ModuleType("agent.tts_provider")
        tts.TTSProvider = _StubProvider
        stt = types.ModuleType("agent.transcription_provider")
        stt.TranscriptionProvider = _StubProvider
        cls._saved = {name: sys.modules.get(name) for name in ("agent", "agent.tts_provider",
                                                                "agent.transcription_provider")}
        sys.modules.setdefault("agent", types.ModuleType("agent"))
        sys.modules["agent.tts_provider"] = tts
        sys.modules["agent.transcription_provider"] = stt
        spec = importlib.util.spec_from_file_location("kokoro_voice_under_test",
                                                      ROOT / "plugins" / "kokoro-voice" / "__init__.py")
        cls.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.plugin)
        cls.server = http.server.ThreadingHTTPServer(("localhost", 0), _KokoroServer)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        for name, module in cls._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def setUp(self) -> None:
        _KokoroServer.calls = []
        port = self.server.server_address[1]
        self.env = {"HERMES_KOKORO_SIDECAR_URL": f"http://localhost:{port}/v1",
                    "HERMES_KOKORO_SIDECAR_TOKEN": "synthetic-voice-token"}

    def with_env(self):
        return unittest.mock.patch.dict(os.environ, self.env)

    def test_speech_uses_the_openai_speech_route_with_a_bearer_token(self) -> None:
        with self.with_env(), tempfile.TemporaryDirectory() as tmp:
            provider = self.plugin.KokoroProvider()
            self.assertTrue(provider.is_available())
            out = provider.synthesize("Hello there.", str(Path(tmp) / "reply.mp3"))
            self.assertEqual(Path(out).read_bytes(), b"OggS synthetic")
        method, path, headers = _KokoroServer.calls[-1]
        self.assertEqual((method, path), ("POST", "/v1/audio/speech"))
        self.assertEqual(headers.get("Authorization"), "Bearer synthetic-voice-token")
        self.assertNotIn("X-Voice-Token", headers)
        body = json.loads(headers["_body"])
        self.assertEqual(body["response_format"], "opus")
        self.assertEqual(body["input"], "Hello there.")

    def test_transcription_reports_itself_unavailable_and_sends_nothing(self) -> None:
        with self.with_env(), tempfile.TemporaryDirectory() as tmp:
            stt = self.plugin.KokoroSidecarSTTProvider()
            self.assertFalse(stt.is_available())
            audio = Path(tmp) / "note.ogg"
            audio.write_bytes(b"OggS")
            result = stt.transcribe(str(audio))
        self.assertFalse(result["success"])
        self.assertFalse([c for c in _KokoroServer.calls if c[0] == "POST"])

    def test_fleet_sidecar_url_keeps_the_fleet_routes(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"HERMES_KOKORO_SIDECAR_URL": "http://voice:8126",
                                                   "HERMES_KOKORO_SIDECAR_TOKEN": "t"}):
            self.assertFalse(self.plugin._openai_compatible())


# -------------------------------------------------------------------- 3. voice

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class VoiceOffIsTextOnlyTests(unittest.TestCase):
    def test_voice_off_names_no_hosted_engine_and_disables_the_tool(self) -> None:
        for env, agent in ((FULL_ENV, "worker"), ({}, "ops")):
            with self.subTest(agent=agent, env=bool(env)):
                rendered = render(env, agent)
                self.assertFalse(rendered.decisions["voice"].on)
                tts = rendered.config["tts"]
                self.assertNotIn(tts["provider"], sd.HOSTED_TTS)
                self.assertEqual(tts["providers"][tts["provider"]]["type"], "command")
                self.assertIn("tts", rendered.config["agent"]["disabled_toolsets"])
                self.assertIs(rendered.config["voice"]["auto_tts"], False)
                self.assertIs(rendered.config["stt"]["enabled"], False)
                _, problems = sd.diagnose(rendered.config, env, CONTRACT)
                self.assertEqual(problems, [])

    def test_the_old_off_config_is_a_problem(self) -> None:
        old = render({}, "ops").config
        del old["tts"], old["voice"], old["agent"]["disabled_toolsets"]
        _, problems = sd.diagnose(old, {}, CONTRACT)
        self.assertIn("voice is off but tts.provider is unset (Hermes uses edge), a hosted speech service", problems)
        old["tts"] = {"provider": "edge"}
        self.assertIn("voice is off but tts.provider is edge, a hosted speech service",
                      sd.diagnose(old, {}, CONTRACT)[1])

    def test_renderer_refuses_a_voice_off_that_leaves_a_hosted_engine(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "fleet-config"
            shutil.copytree(FLEET_CONFIG, config_dir)
            path = config_dir / "defaults.yaml"
            text = path.read_text(encoding="utf-8")
            start = text.index("      tts.provider: text-only\n")
            end = text.index("      voice.auto_tts: false\n") + len("      voice.auto_tts: false\n")
            path.write_text(text[:start] + text[end:], encoding="utf-8")
            with self.assertRaisesRegex(sd.DefaultsError, "hosted speech service"):
                render({}, "ops", config_dir=config_dir)


# ------------------------------------------------------------------- 4. honcho

@unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
class HonchoTokenizerCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = compose_doc("compose.sidecars.yaml")
        self.services = self.compose["services"]
        self.fetch = self.services["honcho-tiktoken"]

    def test_honcho_reads_a_prefilled_cache_and_keeps_no_egress(self) -> None:
        honcho = self.services["honcho"]
        self.assertEqual(honcho["environment"]["TIKTOKEN_CACHE_DIR"], "/tiktoken-cache")
        self.assertIn("honcho-tiktoken:/tiktoken-cache:ro", honcho["volumes"])
        self.assertEqual(honcho["depends_on"]["honcho-tiktoken"], {"condition": "service_completed_successfully"})
        networks = self.compose["networks"]
        self.assertFalse([n for n in honcho["networks"] if not networks[n].get("internal")], honcho["networks"])

    def test_only_the_one_time_fetch_reaches_the_network(self) -> None:
        self.assertEqual(self.fetch["networks"], ["honcho-tiktoken-egress"])
        members = {name for name, svc in self.services.items() if "honcho-tiktoken-egress" in svc.get("networks", [])}
        self.assertEqual(members, {"honcho-tiktoken"})
        self.assertEqual(self.fetch["restart"], "no")
        self.assertEqual(self.fetch["cap_drop"], ["ALL"])
        self.assertIs(self.fetch["read_only"], True)
        self.assertEqual(self.fetch["image"], self.services["honcho"]["image"])

    def test_pin_is_tiktokens_own_hash_for_o200k_base(self) -> None:
        env = self.fetch["environment"]
        self.assertEqual(env["TIKTOKEN_URL"], O200K_URL)
        self.assertEqual(env["TIKTOKEN_SHA256"], O200K_SHA256)

    def run_fetch(self, cache: Path, url: str, sha: str) -> subprocess.CompletedProcess:
        script = self.fetch["entrypoint"][2]
        env = dict(os.environ, TIKTOKEN_URL=url, TIKTOKEN_SHA256=sha, TIKTOKEN_CACHE=str(cache))
        return subprocess.run([sys.executable, "-I", "-c", script], env=env, text=True,
                              capture_output=True, check=False, timeout=60)

    def test_fetch_fills_tiktokens_cache_name_and_refuses_a_wrong_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "o200k_base.tiktoken"
            source.write_bytes(b"synthetic tokenizer ranks\n")
            url = source.as_uri()
            good = hashlib.sha256(source.read_bytes()).hexdigest()
            cache = Path(tmp) / "cache"
            cache.mkdir()
            wrong = self.run_fetch(cache, url, "0" * 64)
            self.assertNotEqual(wrong.returncode, 0)
            self.assertEqual(list(cache.iterdir()), [])
            ok = self.run_fetch(cache, url, good)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            cached = cache / hashlib.sha1(url.encode()).hexdigest()
            self.assertEqual(cached.read_bytes(), source.read_bytes())
            source.write_bytes(b"changed upstream\n")
            again = self.run_fetch(cache, url, good)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("already matches", again.stdout)


# ---------------------------------------------------------------- 5/6. claude

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class ClaudeLoginReadinessTests(unittest.TestCase):
    CLAUDE = ("claude-subscription-directsdk", "claude-acp-connectors")
    PLUGINS = ("claude-subscription-directsdk-experimental", "claude-acp-provider", "claude-account-connectors")

    def assert_claude_off(self, rendered) -> None:
        for default_id in self.CLAUDE + ("model-roles",):
            self.assertFalse(rendered.decisions[default_id].on, default_id)
        for plugin in self.PLUGINS:
            self.assertNotIn(plugin, rendered.leaves.get("plugins.enabled", []))
        self.assertNotIn("model.provider", rendered.leaves)
        self.assertNotIn("fallback_providers", rendered.leaves)
        self.assertIs(rendered.leaves["plugins.entries.claude-account-connectors.settings"]["enabled"], False)

    def test_variable_without_a_login_renders_every_claude_default_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = full_paths(tmp, claude_login=False)
            rendered = render(paths=paths)
            self.assert_claude_off(rendered)
            self.assertEqual(rendered.decisions["claude-subscription-directsdk"].reason,
                             "no Claude login found in CLAUDE_CONFIG_DIR")
            lines = lines_of(sd.diagnose(rendered.config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
            self.assertEqual(lines["claude-subscription-directsdk"],
                             "off: disabled: no Claude login found in CLAUDE_CONFIG_DIR")
            self.assertTrue(lines["model-roles"].startswith("off: no granted model provider"), lines)

    def test_host_render_cannot_see_the_login_and_says_so(self) -> None:
        rendered = render(paths=None)
        self.assert_claude_off(rendered)
        self.assertFalse(rendered.decisions["claude-subscription-directsdk"].checked)
        self.assertIn("--check-files", rendered.decisions["claude-subscription-directsdk"].reason)

    def test_a_real_login_turns_them_on(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rendered = render(paths=full_paths(tmp))
        for default_id in self.CLAUDE + ("model-roles",):
            self.assertTrue(rendered.decisions[default_id].on, default_id)
        self.assertEqual(rendered.leaves["model.provider"], sd.DIRECTSDK_PROVIDER)

    def test_model_roles_is_off_when_both_providers_are_off(self) -> None:
        """The real-boot case: rendered with a login, checked in a container without one."""
        with tempfile.TemporaryDirectory() as tmp:
            config = render(paths=full_paths(Path(tmp) / "with")).config
            self.assertEqual(config["model"]["provider"], sd.DIRECTSDK_PROVIDER)
            paths = full_paths(Path(tmp) / "without", claude_login=False)
            lines = lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
        self.assertTrue(lines["claude-subscription-directsdk"].startswith("off: "), lines)
        self.assertTrue(lines["claude-acp-connectors"].startswith("off: "), lines)
        self.assertEqual(lines["model-roles"], f"off: {sd.NO_MODEL_PROVIDER}")

    def test_model_roles_names_a_main_provider_that_is_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = render(paths=full_paths(tmp)).config
        config["plugins"]["enabled"].remove(sd.DIRECTSDK_PROVIDER)
        line = lines_of(sd.diagnose(config, FULL_ENV, CONTRACT)[0])["model-roles"]
        self.assertTrue(line.startswith("off: dropped from the model chain: the main provider"), line)


# --------------------------------------------------------------------- 7. yaml

@unittest.skipUnless(HAVE_RUAMEL, "ruamel.yaml (what the Hermes image ships) is required")
class DoctorWithoutPyYAMLTests(unittest.TestCase):
    """Run the scripts with PyYAML made unimportable, as in the Hermes image."""

    BLOCK = ("import sys, runpy\n"
             "class _NoPyYAML:\n"
             "    def find_spec(self, name, path=None, target=None):\n"
             "        if name == 'yaml' or name.startswith('yaml.'):\n"
             "            raise ImportError('PyYAML is not installed in this image')\n"
             "sys.meta_path.insert(0, _NoPyYAML())\n"
             "script = sys.argv[1]\n"
             "sys.argv = sys.argv[1:]\n"
             "runpy.run_path(script, run_name='__main__')\n")

    def run_without_pyyaml(self, script: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-c", self.BLOCK, str(script), *args], cwd=ROOT, text=True,
                              capture_output=True, check=False, timeout=60)

    def test_render_and_doctor_run_with_only_ruamel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "ops.env"
            env_file.write_text("".join(f"{k}={v}\n" for k, v in FULL_ENV.items()), encoding="utf-8")
            root = fixture.full_container_root(Path(tmp), FULL_ENV)
            out = Path(tmp) / "ops.yaml"
            rendered = self.run_without_pyyaml(RENDER, "--fleet-config", str(FLEET_CONFIG), "--agent", "ops",
                                               "--env-file", str(env_file), "--output", str(out),
                                               "--check-files", "--root", str(root), "--report")
            self.assertEqual(rendered.returncode, 0, rendered.stderr)
            doctor = self.run_without_pyyaml(DOCTOR, "--config", str(out), "--env-file", str(env_file),
                                             "--no-process-env", "--check-files", "--root", str(root))
            self.assertEqual(doctor.returncode, 0, doctor.stdout + doctor.stderr)
            lines = lines_of(doctor.stdout.splitlines())
            for default_id in ("claude-subscription-directsdk", "linear", "voice", "shared-skill-pack",
                               "secrets-connect", "model-roles"):
                self.assertEqual(lines[default_id], "on", default_id)
            for value in FULL_ENV.values():
                if "SECRET" in value:
                    self.assertNotIn(value, doctor.stdout + doctor.stderr + rendered.stderr)

    def test_duplicate_keys_are_still_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "dup.yaml"
            config.write_text("gateway:\n  multiplex_profiles: false\ngateway:\n  x: 1\n", encoding="utf-8")
            result = self.run_without_pyyaml(DOCTOR, "--config", str(config), "--no-process-env")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("duplicate key", result.stderr)


# --------------------------------------------------------------- agreement

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class RendererDoctorAgreementTests(unittest.TestCase):
    """One readiness decision per default: the renderer's choice and the setup
    check's line agree for every default, with every credential present and
    with each one missing, given the same evidence."""

    def assert_agree(self, env: dict, paths, label: str) -> None:
        rendered = render(env, paths=paths)
        lines = lines_of(sd.diagnose(rendered.config, env, CONTRACT, check_files=paths is not None,
                                     paths=paths)[0])
        for default_id, decision in rendered.decisions.items():
            with self.subTest(case=label, default=default_id):
                line = lines[default_id]
                if decision.on:
                    self.assertEqual(line, "on")
                else:
                    self.assertTrue(line.startswith("off: "), line)
                    if not decision.reason.startswith("turned off in"):
                        self.assertIn(decision.reason, line)

    def test_everything_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = full_paths(tmp)
            self.assert_agree(FULL_ENV, paths, "all present")
            self.assertTrue(all(d.on for d in render(paths=paths).decisions.values()))
        self.assert_agree(FULL_ENV, None, "host render, no file access")

    def test_each_variable_missing(self) -> None:
        for name in FULL_ENV:
            env = {k: v for k, v in FULL_ENV.items() if k != name}
            with tempfile.TemporaryDirectory() as tmp:
                self.assert_agree(env, full_paths(tmp), f"{name} missing")
            self.assert_agree(env, None, f"{name} missing, host")

    def test_each_file_missing(self) -> None:
        cases = {"claude login": {"claude_login": False}, "linear token": {"linear_token": False},
                 "plugins": {"plugins": False}, "skill pack": {"skills": False}, "op binary": {"op": False},
                 "cli logins": {"cli_login": False, "claude_login": False}}
        for label, kwargs in cases.items():
            with tempfile.TemporaryDirectory() as tmp:
                paths = full_paths(tmp, **kwargs)
                self.assert_agree(FULL_ENV, paths, label)
                self.assertTrue([d for d in render(paths=paths).decisions.values() if not d.on], label)

    def test_connect_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "fleet-config"
            shutil.copytree(FLEET_CONFIG, config_dir)
            path = config_dir / "defaults.yaml"
            path.write_text(path.read_text(encoding="utf-8").replace(
                "_switchroom.connect_provides: []", "_switchroom.connect_provides: [PERPLEXITY_API_KEY]"),
                encoding="utf-8")
            env = {k: v for k, v in FULL_ENV.items() if k != "PERPLEXITY_API_KEY"}
            for mapping, web_on in (({"PERPLEXITY_API_KEY": "synthetic-ref"}, True), ({}, False)):
                paths = full_paths(Path(tmp) / str(web_on), env, mapping=mapping)
                rendered = render(env, paths=paths, config_dir=config_dir)
                self.assertIs(rendered.decisions["web-search"].on, web_on)
                lines = lines_of(sd.diagnose(rendered.config, env, CONTRACT, check_files=True, paths=paths)[0])
                self.assertEqual(lines["web-search"] == "on", web_on, lines["web-search"])
                self.assertEqual(lines["secrets-connect"] == "on", web_on, lines["secrets-connect"])


if __name__ == "__main__":
    unittest.main()
