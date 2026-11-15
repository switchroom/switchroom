"""Regressions for the starter defaults the second real-container run found.

See docs/starter-overlay-acceptance.md, "Rerun after the real-boot fixes".

1. Voice: a component may be on only under a shipped default with the enable
   guard. Voice turns on only when its speech sidecar is configured and
   answers, seen from the agent's own network, and never with a hosted
   transcription fallback. The CPU Kokoro server has no transcription.
2. Shared skill pack: mounting the read-only pack must not leave the agent's
   own skills directory owned by root.
3. coding-clis.claude uses the same real-login check as the Claude defaults.
4. An empty Linear token file is reported as empty, not missing.

Every value is synthetic. No status in contracts/plugins.json changes here.
"""
from __future__ import annotations

import copy
import http.server
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
OVERLAY = ROOT / "examples" / "overlay-repo"
FLEET_CONFIG = OVERLAY / "fleet-config"
CONTRACT = ROOT / "contracts" / "plugins.json"
GUARD = {"sidecar": "configured_and_reachable", "hosted_fallback": False}

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False
try:
    import ruamel.yaml  # noqa: F401
    HAVE_A_YAML = True
except ImportError:  # pragma: no cover - environment dependent
    HAVE_A_YAML = HAVE_YAML


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


sd = _load("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")
fixture = _load("starter_overlay_fixture", ROOT / "tests" / "starter_overlay_fixture.py")

FULL_ENV = {
    "CLAUDE_CONFIG_DIR": "/opt/data/.claude",
    "LINEAR_TOKEN_FILE": "/opt/data/secrets/linear-token",
    "LINEAR_VIEWER_ID": "00000000-0000-4000-8000-0000000fa4e1",
    "LINEAR_ORGANIZATION_ID": "00000000-0000-4000-8000-0000000fa4e2",
    "HERMES_KOKORO_SIDECAR_URL": "http://voice:8880/v1",
    "HERMES_KOKORO_SIDECAR_TOKEN": "voice-token-SECRET-value",
    "HONCHO_BASE_URL": "http://honcho:8000",
    "PERPLEXITY_API_KEY": "pplx-SECRET-key-value",
}


def contract() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def lines_of(lines: list[str]) -> dict[str, str]:
    return dict(line.split(": ", 1) for line in lines if not line.startswith("warning:"))


class _Health(http.server.BaseHTTPRequestHandler):
    """A synthetic speech sidecar: /health for a CPU Kokoro-FastAPI, /healthz for the Fleet sidecar."""

    status: dict = {"status": "healthy"}
    calls: list[tuple[str, dict]] = []

    def log_message(self, *args) -> None:  # quiet test server
        pass

    def do_GET(self) -> None:  # noqa: N802
        type(self).calls.append((self.path, dict(self.headers)))
        body = json.dumps(type(self).status).encode("utf-8")
        self.send_response(200 if self.path in ("/health", "/healthz") else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ------------------------------------------------------------------ 1. voice

class VoiceContractGuardTests(unittest.TestCase):
    """The contract rule: a component is on only under a guarded shipped default."""

    def flipped(self, *, guard: bool = True, provider_on: bool = True) -> dict:
        document = copy.deepcopy(contract())
        voice = next(d for d in document["public_base"]["default_set"] if d["id"] == "voice")
        voice["status"] = "shipped"
        if not guard:
            voice.pop("enable_guard", None)
        component = next(c for c in document["components"] if c["id"] == "voice-provider")
        component["default_enabled"] = provider_on
        return document

    def test_the_contract_today_obeys_the_rule(self) -> None:
        self.assertEqual(sd.component_default_problems(contract()), [])

    def test_voice_carries_the_guard_and_says_the_cpu_server_has_no_transcription(self) -> None:
        voice = next(d for d in contract()["public_base"]["default_set"] if d["id"] == "voice")
        self.assertEqual(voice["enable_guard"], GUARD)
        self.assertEqual(voice["covers"], ["voice-provider"])
        self.assertIn("CPU Kokoro server has no transcription", voice["summary"])
        self.assertIn("GPU", voice["summary"])
        self.assertNotIn("Local Kokoro voice replies and local transcription", voice["summary"])

    def test_a_guarded_shipped_voice_may_turn_its_component_on(self) -> None:
        self.assertEqual(sd.component_default_problems(self.flipped()), [])

    def test_without_the_guard_or_with_a_stale_bit_it_is_refused(self) -> None:
        self.assertTrue(sd.component_default_problems(self.flipped(guard=False)))
        self.assertTrue(sd.component_default_problems(self.flipped(provider_on=False)))
        document = copy.deepcopy(contract())
        next(c for c in document["components"] if c["id"] == "voice-provider")["default_enabled"] = True
        problems = sd.component_default_problems(document)
        self.assertEqual(problems, ["component voice-provider is default_enabled but no shipped default covers it"])
        weaker = self.flipped()
        next(d for d in weaker["public_base"]["default_set"] if d["id"] == "voice")["enable_guard"] = {
            "sidecar": "configured_and_reachable", "hosted_fallback": True}
        self.assertTrue(sd.component_default_problems(weaker))

    def test_the_loader_refuses_a_contract_that_breaks_the_rule(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "plugins.json"
            bad.write_text(json.dumps(self.flipped(guard=False)), encoding="utf-8")
            with self.assertRaisesRegex(sd.DefaultsError, "enable guard"):
                sd.load_contract(bad)

    def test_docs_say_the_cpu_server_has_no_transcription_and_keep_the_gpu_variant(self) -> None:
        sidecars = (ROOT / "docs" / "sidecars.md").read_text(encoding="utf-8")
        self.assertIn("has no transcription", sidecars)
        self.assertIn("ghcr.io/mekenthompson/hermes-fleet-kokoro", sidecars)
        self.assertIn("the option for local transcription", sidecars)
        self.assertIn("configured and answers", sidecars)


@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class VoiceReachabilityTests(unittest.TestCase):
    """Voice is on only when the configured speech sidecar answers."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = http.server.ThreadingHTTPServer(("localhost", 0), _Health)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        _Health.status = {"status": "healthy"}
        _Health.calls = []
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        port = self.server.server_address[1]
        self.env = dict(FULL_ENV, HERMES_KOKORO_SIDECAR_URL=f"http://localhost:{port}/v1")
        # The real probe: no voice_probe stand-in.
        self.paths = sd.ContainerPaths(root=fixture.full_container_root(Path(self._tmp.name), self.env))

    def render(self, env: dict | None = None, paths=None):
        env = self.env if env is None else env
        return sd.render(FLEET_CONFIG, "ops", sd.env_names(env), CONTRACT, environ=env, paths=paths)

    def test_a_healthy_cpu_sidecar_turns_voice_on(self) -> None:
        rendered = self.render(paths=self.paths)
        self.assertTrue(rendered.decisions["voice"].on, rendered.decisions["voice"].reason)
        self.assertEqual(rendered.config["tts"]["provider"], "kokoro")
        self.assertEqual(rendered.config["stt"]["provider"], "kokoro_sidecar")
        self.assertEqual([c[0] for c in _Health.calls], ["/health"])
        # The health check sends no token.
        self.assertFalse([h for _, h in _Health.calls if "Authorization" in h or "X-Voice-Token" in h])
        lines = lines_of(sd.diagnose(rendered.config, self.env, CONTRACT, check_files=True, paths=self.paths)[0])
        self.assertEqual(lines["voice"], "on")

    def test_the_fleet_gpu_sidecar_is_probed_on_its_own_route(self) -> None:
        _Health.status = {"ok": True, "tts": True, "stt": True}
        env = dict(self.env, HERMES_KOKORO_SIDECAR_URL=f"http://localhost:{self.server.server_address[1]}")
        self.assertTrue(self.render(env, self.paths).decisions["voice"].on)
        self.assertEqual([c[0] for c in _Health.calls], ["/healthz"])

    def test_an_unhealthy_or_unreachable_sidecar_keeps_voice_text_only(self) -> None:
        _Health.status = {"status": "starting"}
        unhealthy = self.render(paths=self.paths)
        closed = socket_free_port()
        unreachable = self.render(dict(self.env, HERMES_KOKORO_SIDECAR_URL=f"http://localhost:{closed}/v1"),
                                  self.paths)
        for rendered, reason in ((unhealthy, "is not healthy for speech"), (unreachable, "does not answer")):
            with self.subTest(reason=reason):
                decision = rendered.decisions["voice"]
                self.assertFalse(decision.on)
                self.assertIn(reason, decision.reason)
                self.assertNotIn("localhost", decision.reason)
                self.assertEqual(rendered.config["tts"]["provider"], "text-only")
                self.assertNotIn("kokoro-voice", rendered.config.get("plugins", {}).get("enabled", []))
                self.assertIn("tts", rendered.config["agent"]["disabled_toolsets"])
                self.assertIs(rendered.config["stt"]["enabled"], False)
                self.assertEqual(sd.diagnose(rendered.config, self.env, CONTRACT)[1], [])

    def test_a_host_render_cannot_see_the_sidecar_so_voice_stays_off(self) -> None:
        rendered = self.render(paths=None)
        decision = rendered.decisions["voice"]
        self.assertFalse(decision.on)
        self.assertFalse(decision.checked)
        self.assertIn("the voice sidecar was not checked", decision.reason)
        self.assertEqual(rendered.config["tts"]["provider"], "text-only")
        self.assertEqual(_Health.calls, [])

    def test_voice_on_never_leaves_transcription_to_a_hosted_service(self) -> None:
        config = self.render(paths=self.paths).config
        self.assertIsNone(sd.hosted_speech_problem(config))
        for stt in ("openai", None):
            with self.subTest(stt=stt):
                changed = copy.deepcopy(config)
                if stt is None:
                    del changed["stt"]["provider"]
                else:
                    changed["stt"]["provider"] = stt
                problem = sd.hosted_speech_problem(changed)
                self.assertIsNotNone(problem)
                self.assertIn("could fall back to a hosted service", problem)
                self.assertIn(problem, sd.diagnose(changed, self.env, CONTRACT)[1])
        # Transcription turned off entirely is not a fallback.
        off = copy.deepcopy(config)
        off["stt"] = {"enabled": False}
        self.assertIsNone(sd.hosted_speech_problem(off))


def socket_free_port() -> int:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("localhost", 0))
        return sock.getsockname()[1]


# ------------------------------------------------------------- 2. skill pack

@unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
class SkillPackMountPointTests(unittest.TestCase):
    """The agent user creates the pack's mount point, so its skills dir stays its own."""

    def setUp(self) -> None:
        self.compose = yaml.safe_load((OVERLAY / "compose.yaml").read_text(encoding="utf-8"))
        self.services = self.compose["services"]

    def test_each_agent_waits_for_its_own_skills_init(self) -> None:
        for agent in ("ops", "worker"):
            with self.subTest(agent=agent):
                init = self.services[f"{agent}-skills-init"]
                agent_spec = self.services[agent]
                self.assertEqual(agent_spec["depends_on"][f"{agent}-skills-init"],
                                 {"condition": "service_completed_successfully"})
                # The agent user, from the agent's own image, so the fresh state
                # volume is filled from the same image contents as before.
                self.assertEqual(init["user"], "${HERMES_UID:-1000}:${HERMES_GID:-1000}")
                self.assertEqual(init["image"], agent_spec["image"])
                self.assertEqual(init["entrypoint"], ["mkdir", "-p", fixture.SKILL_PACK])
                self.assertEqual(init["network_mode"], "none")
                self.assertEqual(init["cap_drop"], ["ALL"])
                self.assertIs(init["read_only"], True)
                self.assertEqual(init["restart"], "no")
                state = next(v for v in agent_spec["volumes"] if v.endswith(":/opt/data"))
                self.assertEqual(init["volumes"], [state])
                # The pack itself stays a read-only bind into that mount point.
                self.assertIn(f"./vendor/hermes-fleet/skills:{fixture.SKILL_PACK}:ro", agent_spec["volumes"])
                for key in ("privileged", "ports", "cap_add", "devices", "env_file"):
                    self.assertNotIn(key, init)

    def test_the_init_makes_the_skills_dir_the_agent_users(self) -> None:
        # What the init runs, as this (non-root) test user on an empty state dir.
        if os.geteuid() == 0:
            self.skipTest("ownership is meaningless as root")
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "opt-data"
            state.mkdir()
            command = self.services["ops-skills-init"]["entrypoint"]
            target = state / Path(command[-1]).relative_to("/opt/data")
            target.mkdir(parents=True, exist_ok=True)  # mkdir -p
            self.assertEqual((state / "skills").stat().st_uid, os.getuid())
            self.assertTrue(os.access(state / "skills", os.W_OK))


@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class SkillsDirWritableTests(unittest.TestCase):
    """The setup check reports the pack off when the agent lost its own skills dir."""

    def test_a_skills_dir_the_agent_cannot_write_is_reported(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root can write anything")
        with tempfile.TemporaryDirectory() as tmp:
            paths = sd.ContainerPaths(root=fixture.full_container_root(Path(tmp), FULL_ENV),
                                      voice_probe=fixture.healthy_voice)
            config = sd.render(FLEET_CONFIG, "ops", sd.env_names(FULL_ENV), CONTRACT,
                               environ=FULL_ENV, paths=paths).config
            skills = paths.at("/opt/data/skills")
            self.assertEqual(lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
                             ["shared-skill-pack"], "on")
            skills.chmod(0o555)
            try:
                line = lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
                self.assertFalse(sd.readiness("shared-skill-pack", sd.env_names(FULL_ENV), environ=FULL_ENV,
                                              paths=paths).on)
            finally:
                skills.chmod(0o755)
        self.assertTrue(line["shared-skill-pack"].startswith(
            "off: disabled: the agent cannot write /opt/data/skills"), line["shared-skill-pack"])
        self.assertIn("cannot save its own skills", line["shared-skill-pack"])


# ------------------------------------------------------- 3. coding-clis.claude

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class CodingCliClaudeLoginTests(unittest.TestCase):
    def lines(self, credentials: str | None, *, codex: bool = True) -> dict[str, str]:
        with tempfile.TemporaryDirectory() as tmp:
            # ``codex`` keeps one other CLI logged in, so coding-clis is on and
            # prints its per-CLI lines.
            root = fixture.full_container_root(Path(tmp), FULL_ENV, claude_login=False, cli_login=codex)
            if credentials is not None:
                fixture.write(root / FULL_ENV["CLAUDE_CONFIG_DIR"].lstrip("/") / ".credentials.json", credentials)
            paths = sd.ContainerPaths(root=root, voice_probe=fixture.healthy_voice)
            config = sd.render(FLEET_CONFIG, "ops", sd.env_names(FULL_ENV), CONTRACT,
                               environ=FULL_ENV, paths=paths).config
            return lines_of(sd.diagnose(config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])

    def test_an_empty_or_placeholder_login_file_is_not_a_login(self) -> None:
        for credentials in ("", "{}", '{"claudeAiOauth": {"accessToken": ""}}', "not json"):
            with self.subTest(credentials=credentials):
                lines = self.lines(credentials)
                self.assertEqual(lines["coding-clis.claude"], "off: disabled: no claude login found")
                self.assertEqual(lines["claude-subscription-directsdk"],
                                 "off: disabled: no Claude login found in CLAUDE_CONFIG_DIR")
                self.assertEqual(lines["coding-clis"], "on")
                self.assertEqual(lines["coding-clis.codex"], "on")
                # With no other login, an empty Claude file does not turn coding-clis on.
                alone = self.lines(credentials, codex=False)
                self.assertEqual(alone["coding-clis"], "off: disabled: no coding CLI login found")

    def test_a_real_shaped_login_is_on_for_both(self) -> None:
        lines = self.lines(json.dumps(fixture.CLAUDE_LOGIN), codex=False)
        self.assertEqual(lines["coding-clis.claude"], "on")
        self.assertEqual(lines["coding-clis.codex"], "off: disabled: no codex login found")
        self.assertEqual(lines["claude-subscription-directsdk"], "on")
        self.assertEqual(lines["coding-clis"], "on")

    def test_the_home_relative_login_uses_the_same_check(self) -> None:
        env = {"HOME": "/opt/data/home"}
        with tempfile.TemporaryDirectory() as tmp:
            paths = sd.ContainerPaths(root=Path(tmp))
            login = fixture.write(Path(tmp) / "opt/data/home/.claude/.credentials.json", "")
            self.assertFalse(sd._cli_login("claude", env, paths))
            login.write_text(json.dumps(fixture.CLAUDE_LOGIN), encoding="utf-8")
            self.assertTrue(sd._cli_login("claude", env, paths))


# ----------------------------------------------------------------- 4. linear

@unittest.skipUnless(HAVE_A_YAML, "a YAML library is required")
class LinearTokenWordingTests(unittest.TestCase):
    def decision(self, token: str | None):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture.full_container_root(Path(tmp), FULL_ENV, linear_token=False)
            if token is not None:
                fixture.write(root / FULL_ENV["LINEAR_TOKEN_FILE"].lstrip("/"), token)
            paths = sd.ContainerPaths(root=root, voice_probe=fixture.healthy_voice)
            rendered = sd.render(FLEET_CONFIG, "ops", sd.env_names(FULL_ENV), CONTRACT,
                                 environ=FULL_ENV, paths=paths)
            lines = lines_of(sd.diagnose(rendered.config, FULL_ENV, CONTRACT, check_files=True, paths=paths)[0])
        return rendered, lines

    def test_an_empty_token_file_is_reported_as_empty(self) -> None:
        rendered, lines = self.decision("")
        self.assertEqual(rendered.decisions["linear"].reason, "the file named by LINEAR_TOKEN_FILE is empty")
        self.assertEqual(lines["linear"], "off: disabled: the file named by LINEAR_TOKEN_FILE is empty")
        self.assertIs(rendered.config["plugins"]["entries"]["linear"]["settings"]["enabled"], False)

    def test_a_missing_token_file_is_still_reported_as_missing(self) -> None:
        rendered, lines = self.decision(None)
        self.assertEqual(lines["linear"], "off: disabled: the file named by LINEAR_TOKEN_FILE does not exist")
        rendered, lines = self.decision("synthetic-token\n")
        self.assertEqual(lines["linear"], "on")


if __name__ == "__main__":
    unittest.main()
