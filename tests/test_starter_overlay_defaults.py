"""Starter overlay defaults, the overlay renderer and the setup check.

See reference/rfcs/default-on-distribution.md. The example overlay in
examples/overlay-repo/ turns on the reviewed defaults that are pure config.
A missing credential must render that default off, never a config that
blocks agent start, and the setup check must report it without printing
any secret value.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
FLEET_CONFIG = ROOT / "examples" / "overlay-repo" / "fleet-config"
CONTRACT = ROOT / "contracts" / "plugins.json"
RENDER = SCRIPTS / "render-overlay-config.py"
DOCTOR = SCRIPTS / "switchroom-doctor.py"

try:
    import yaml  # noqa: F401
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False


def _module():
    spec = importlib.util.spec_from_file_location("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("switchroom_defaults", module)
    spec.loader.exec_module(module)
    return module


def _fixture():
    spec = importlib.util.spec_from_file_location("starter_overlay_fixture", ROOT / "tests" / "starter_overlay_fixture.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = _fixture()


def full_paths(sd, tmp, env: dict, **kwargs):
    """ContainerPaths for a synthetic agent container holding every login and mount."""
    return sd.ContainerPaths(root=fixture.full_container_root(Path(tmp), env, **kwargs), hermes_home="/opt/data")


# Secret-looking values. None may ever appear in output.
FULL_ENV = {
    "CLAUDE_CONFIG_DIR": "/opt/data/.claude-login-dir-value",
    "LINEAR_TOKEN_FILE": "/opt/data/secrets/linear-token-value",
    # Synthetic IDs, deliberately fake UUIDs: no deployment identity.
    "LINEAR_VIEWER_ID": "00000000-0000-4000-8000-0000000fa4e1",
    "LINEAR_ORGANIZATION_ID": "00000000-0000-4000-8000-0000000fa4e2",
    "HERMES_KOKORO_SIDECAR_URL": "http://voice-sidecar-value:8880",
    "HERMES_KOKORO_SIDECAR_TOKEN": "voice-token-SECRET-value",
    "HONCHO_BASE_URL": "http://honcho-endpoint-value:8000",
    "PERPLEXITY_API_KEY": "pplx-SECRET-key-value",
    "OP_CONNECT_HOST": "http://connect-host-value:8080",
    "OP_CONNECT_TOKEN": "connect-token-SECRET-value",
}
CONFIGURED = [
    "doctrine-config", "gateway-per-agent", "secrets-connect", "coding-clis", "model-roles",
    "claude-subscription-directsdk", "claude-acp-connectors", "linear", "voice", "honcho-memory",
    "web-search", "quota", "session-reset-policy", "security-guidance", "disk-cleanup", "shared-skill-pack",
]
# Defaults that need no credential and are always on unless an agent opts out.
ALWAYS_ON = [
    "doctrine-config", "gateway-per-agent", "coding-clis", "quota", "session-reset-policy",
    "security-guidance", "disk-cleanup", "shared-skill-pack",
]
PLUGINS_BY_DEFAULT = {
    "claude-subscription-directsdk": ["claude-subscription-directsdk-experimental"],
    "claude-acp-connectors": ["claude-acp-provider", "claude-account-connectors"],
    "linear": ["linear"],
    "voice": ["kokoro-voice"],
    "web-search": ["web-perplexity"],
    "quota": ["quota"],
    "session-reset-policy": ["hermes-session-reset-policy"],
    "security-guidance": ["security-guidance"],
    "disk-cleanup": ["disk-cleanup"],
}


def contract_defaults() -> list[dict]:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))["public_base"]["default_set"]


def run(script: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(script), *args], cwd=ROOT, text=True,
                          capture_output=True, check=False, timeout=60)


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class StarterOverlayRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        # Every login and mount exists inside the synthetic container; a test
        # that removes a variable shows which defaults that turns off.
        self.paths = full_paths(self.sd, self._tmp.name, FULL_ENV)

    def render(self, agent: str = "ops", env: dict | None = None, config_dir: Path = FLEET_CONFIG):
        env = FULL_ENV if env is None else env
        return self.sd.render(config_dir, agent, self.sd.env_names(env), CONTRACT, environ=env, paths=self.paths)

    def test_full_environment_turns_every_configured_default_on(self) -> None:
        rendered = self.render()
        self.assertEqual(list(rendered.decisions), CONFIGURED)
        for default_id, decision in rendered.decisions.items():
            with self.subTest(default=default_id):
                self.assertTrue(decision.on, decision.reason)
        leaves = rendered.leaves
        self.assertIs(leaves["gateway.multiplex_profiles"], False)
        self.assertIs(leaves["agent.verify_on_stop"], True)
        self.assertEqual(leaves["approvals.mode"], "smart")
        for mode in ("approvals.cron_mode", "approvals.unattended_mode", "approvals.single_query_mode"):
            self.assertEqual(leaves[mode], "deny")
        self.assertEqual(leaves["display.busy_input_mode"], "queue")
        self.assertEqual(leaves["model.provider"], "claude-subscription-directsdk-experimental")
        self.assertEqual(leaves["fallback_providers"], [{"provider": "claude-acp", "model": "sonnet"}])
        self.assertEqual(leaves["plugins.entries.claude-account-connectors.settings"]["enabled"], True)
        self.assertEqual(leaves["plugins.entries.linear.settings"]["enabled"], True)
        self.assertEqual(leaves["plugins.entries.linear.settings"]["credentials"]["path"], "${LINEAR_TOKEN_FILE}")
        self.assertEqual(leaves["tts.provider"], "kokoro")
        self.assertEqual(leaves["stt.provider"], "kokoro_sidecar")
        self.assertEqual(leaves["memory.provider"], "honcho")
        self.assertEqual(leaves["web.search_backend"], "perplexity")
        expected_plugins = [p for d in CONFIGURED for p in PLUGINS_BY_DEFAULT.get(d, [])]
        self.assertEqual(leaves["plugins.enabled"], expected_plugins)
        self.assertEqual(rendered.config["gateway"], {"multiplex_profiles": False})

    def test_system_prompt_is_generic_doctrine(self) -> None:
        prompt = self.render().leaves["agent.system_prompt"]
        for phrase in ("Own the outcome", "Ask again only", "never invent"):
            self.assertIn(phrase, prompt)
        self.assertNotRegex(prompt.lower(), r"linear|slack|telegram|kanban|1password|@|https?://")

    def test_rendered_config_never_contains_environment_values(self) -> None:
        rendered = self.render()
        blob = self.sd.dump_config(rendered) + json.dumps(rendered.provenance)
        for value in FULL_ENV.values():
            self.assertNotIn(value, blob)

    def test_opt_out_example_turns_voice_off_for_worker_only(self) -> None:
        worker = self.render("worker")
        self.assertFalse(worker.decisions["voice"].on)
        self.assertIn("agents/worker.yaml", worker.decisions["voice"].reason)
        self.assertNotIn("kokoro-voice", worker.leaves["plugins.enabled"])
        # Off is text-only: a local engine that never speaks, never Hermes' hosted default.
        self.assertEqual(worker.leaves["tts.provider"], "text-only")
        self.assertEqual(worker.leaves["tts.providers.text-only"], {"type": "command", "command": "false"})
        self.assertEqual(worker.leaves["agent.disabled_toolsets"], ["tts"])
        self.assertIs(worker.leaves["voice.auto_tts"], False)
        self.assertIs(worker.leaves["stt.enabled"], False)
        self.assertIsNone(self.sd.hosted_speech_problem(worker.config))
        for default_id in CONFIGURED:
            if default_id != "voice":
                self.assertTrue(worker.decisions[default_id].on, default_id)
        self.assertTrue(self.render("ops").decisions["voice"].on)

    def test_example_agent_file_shows_one_opt_out_line_per_default(self) -> None:
        text = (FLEET_CONFIG / "agents" / "worker.yaml").read_text(encoding="utf-8")
        shown = re.findall(r"(?m)^\s*#?\s*([a-z][a-z-]+): false\s*$", text)
        self.assertEqual(sorted(shown), sorted(CONFIGURED))

    def test_every_default_has_a_working_one_line_opt_out(self) -> None:
        for default_id in CONFIGURED:
            with self.subTest(default=default_id), tempfile.TemporaryDirectory() as tmp:
                config_dir = Path(tmp) / "fleet-config"
                shutil.copytree(FLEET_CONFIG, config_dir)
                (config_dir / "agents" / "ops.yaml").write_text(
                    f"profile: ops\nrole: operator\napply_mode: merge\ndefaults:\n  {default_id}: false\nvalues: {{}}\n",
                    encoding="utf-8")
                rendered = self.render(config_dir=config_dir)
                self.assertFalse(rendered.decisions[default_id].on)
                for plugin in PLUGINS_BY_DEFAULT.get(default_id, []):
                    self.assertNotIn(plugin, rendered.leaves.get("plugins.enabled", []))
                lines, problems = self.sd.diagnose(rendered.config, FULL_ENV, CONTRACT,
                                                   check_files=True, paths=self.paths)
                self.assertIn(f"{default_id}: off: ", "\n".join(lines))
                self.assertEqual(problems, [])

    def test_each_missing_credential_renders_that_default_off(self) -> None:
        for name in FULL_ENV:
            with self.subTest(missing=name):
                env = {k: v for k, v in FULL_ENV.items() if k != name}
                rendered = self.render(env=env)
                affected = {d for d, req in self.sd.REQUIREMENTS.items() if name in req}
                self.assertTrue(affected)
                for default_id in affected:
                    self.assertFalse(rendered.decisions[default_id].on)
                    self.assertIn(name, rendered.decisions[default_id].reason)
                    for plugin in PLUGINS_BY_DEFAULT.get(default_id, []):
                        self.assertNotIn(plugin, rendered.leaves.get("plugins.enabled", []))
                for default_id in set(CONFIGURED) - affected - {"model-roles"}:
                    self.assertTrue(rendered.decisions[default_id].on, default_id)
                self.assert_starts_cleanly(rendered, env)

    def test_no_credentials_at_all_still_renders_a_startable_config(self) -> None:
        rendered = self.render(env={})
        self.assertEqual([d for d, x in rendered.decisions.items() if x.on], ALWAYS_ON)
        self.assertNotIn("model.provider", rendered.leaves)
        self.assertNotIn("fallback_providers", rendered.leaves)
        self.assertEqual(rendered.leaves["plugins.enabled"],
                         ["quota", "hermes-session-reset-policy", "security-guidance", "disk-cleanup"])
        self.assertEqual(rendered.leaves["_switchroom.secrets_source"], "env_file")
        self.assert_starts_cleanly(rendered, {})

    def assert_starts_cleanly(self, rendered, env: dict) -> None:
        """What keeps a config from failing at start: no dangling ${VAR}, no
        enabled plugin whose credential is missing, no ungranted model path."""
        text = self.sd.dump_config(rendered)
        for name in FULL_ENV:
            if name not in env:
                self.assertNotIn("${" + name + "}", text)
        enabled = rendered.leaves.get("plugins.enabled", [])
        for default_id, plugins in PLUGINS_BY_DEFAULT.items():
            if any(p in enabled for p in plugins):
                self.assertTrue(set(self.sd.REQUIREMENTS[default_id]) <= set(env), default_id)
        for plugin in ("linear", "claude-account-connectors"):
            settings = rendered.leaves.get(f"plugins.entries.{plugin}.settings")
            if settings is not None and settings.get("enabled") is True:
                self.assertIn(plugin, enabled)
        granted = {"claude-subscription-directsdk-experimental", "claude-acp"}
        providers = [rendered.leaves.get("model.provider")] + [
            f["provider"] for f in rendered.leaves.get("fallback_providers", [])]
        self.assertTrue({p for p in providers if p} <= granted)
        if "CLAUDE_CONFIG_DIR" not in env:
            self.assertEqual([p for p in providers if p], [])
        lines, problems = self.sd.diagnose(rendered.config, env, CONTRACT, granted=granted,
                                           check_files=True, paths=self.paths)
        self.assertEqual(problems, [])

    def test_fallback_chain_uses_only_granted_providers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "fleet-config"
            shutil.copytree(FLEET_CONFIG, config_dir)
            agent = config_dir / "agents" / "ops.yaml"
            agent.write_text("profile: ops\nrole: operator\napply_mode: merge\n"
                             "granted_providers: [claude-subscription-directsdk-experimental]\nvalues: {}\n",
                             encoding="utf-8")
            rendered = self.render(config_dir=config_dir)
            self.assertEqual(rendered.leaves["model.provider"], "claude-subscription-directsdk-experimental")
            self.assertNotIn("fallback_providers", rendered.leaves)
            self.assertFalse(rendered.decisions["claude-acp-connectors"].on)
            self.assertIn("not granted", rendered.decisions["claude-acp-connectors"].reason)
            agent.write_text("profile: ops\nrole: operator\napply_mode: merge\n"
                             "granted_providers: [some-api-key-provider]\nvalues: {}\n", encoding="utf-8")
            with self.assertRaisesRegex(self.sd.DefaultsError, "may only narrow"):
                self.render(config_dir=config_dir)

    def test_directsdk_off_promotes_the_next_granted_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "fleet-config"
            shutil.copytree(FLEET_CONFIG, config_dir)
            (config_dir / "agents" / "ops.yaml").write_text(
                "profile: ops\nrole: operator\napply_mode: merge\ndefaults:\n"
                "  claude-subscription-directsdk: false\nvalues: {}\n", encoding="utf-8")
            rendered = self.render(config_dir=config_dir)
            self.assertEqual(rendered.leaves["model.provider"], "claude-acp")
            self.assertNotIn("fallback_providers", rendered.leaves)
            self.assertNotIn("claude-subscription-directsdk-experimental", rendered.leaves["plugins.enabled"])

    def test_schema_allowlist_and_types_are_enforced(self) -> None:
        cases = {
            "unknown leaf": ("values:\n  browser.engine: auto\n", "unknown leaf"),
            "wrong type": ("values:\n  gateway.multiplex_profiles: 'false'\n", "type mismatch"),
            "null": ("values:\n  terminal.cwd: null\n", "null"),
            "env in agent values": ("values:\n  terminal.cwd: ${PERPLEXITY_API_KEY}\n", "must not reference"),
            "unknown default": ("defaults:\n  browser-handoff: false\nvalues: {}\n", "not configured"),
            "non-bool opt-out": ("defaults:\n  voice: 'no'\nvalues: {}\n", "true or false"),
        }
        for label, (body, message) in cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                config_dir = Path(tmp) / "fleet-config"
                shutil.copytree(FLEET_CONFIG, config_dir)
                (config_dir / "agents" / "ops.yaml").write_text(
                    "profile: ops\nrole: operator\napply_mode: merge\n" + body, encoding="utf-8")
                with self.assertRaisesRegex(self.sd.DefaultsError, message):
                    self.render(config_dir=config_dir)

    def test_defaults_may_not_reach_outside_the_reviewed_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "fleet-config"
            shutil.copytree(FLEET_CONFIG, config_dir)
            path = config_dir / "defaults.yaml"
            text = path.read_text(encoding="utf-8")
            path.write_text(text + "  browser-handoff:\n    values:\n      terminal.cwd: /tmp\n", encoding="utf-8")
            with self.assertRaisesRegex(self.sd.DefaultsError, "not in the reviewed default set"):
                self.render(config_dir=config_dir)
            path.write_text(text.replace("requires_env: [LINEAR_TOKEN_FILE, LINEAR_VIEWER_ID, LINEAR_ORGANIZATION_ID]",
                                         "requires_env: []"), encoding="utf-8")
            with self.assertRaisesRegex(self.sd.DefaultsError, "requires_env"):
                self.render(config_dir=config_dir)

    def test_overlay_requirements_match_the_doctor_table(self) -> None:
        doc = self.sd.load_yaml(FLEET_CONFIG / "defaults.yaml")
        declared = {d: tuple(e.get("requires_env", [])) for d, e in doc["defaults"].items()}
        self.assertEqual(declared, self.sd.REQUIREMENTS)
        # Each plan's models use only that plan's providers; the Claude plan's
        # providers are the ones the two Claude defaults turn on.
        plans = doc["defaults"]["model-roles"]["plans"]
        self.assertEqual(list(plans), list(self.sd.PLANS))
        for plan, roles in plans.items():
            for models in roles.values():
                self.assertTrue({m["provider"] for m in models} <= set(self.sd.PLAN_PROVIDERS[plan]), plan)
        claude = {m["provider"] for models in plans["claude"].values() for m in models}
        self.assertEqual({self.sd.MODEL_PROVIDER_DEFAULTS[p] for p in claude},
                         {"claude-subscription-directsdk", "claude-acp-connectors"})

    def test_renderer_cli_writes_config_and_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "agent.env"
            env_file.write_text("".join(f"{k}={v}\n" for k, v in FULL_ENV.items() if k != "HONCHO_BASE_URL"),
                                encoding="utf-8")
            out = Path(tmp) / "config.yaml"
            result = run(RENDER, "--fleet-config", str(FLEET_CONFIG), "--agent", "ops",
                         "--env-file", str(env_file), "--output", str(out), "--report")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("honcho-memory: off: HONCHO_BASE_URL not set", result.stderr)
            # On the host the token file cannot be seen, so Linear stays off.
            self.assertIn("linear: off: the Linear token file was not checked", result.stderr)
            checked = run(RENDER, "--fleet-config", str(FLEET_CONFIG), "--agent", "ops",
                          "--env-file", str(env_file), "--output", str(out), "--report",
                          "--check-files", "--root", str(self.paths.root))
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertIn("linear: on", checked.stderr)
            self.assertIn("claude-subscription-directsdk: on", checked.stderr)
            rendered = self.sd.load_yaml(out)
            self.assertNotIn("memory", rendered)
            for value in FULL_ENV.values():
                self.assertNotIn(value, result.stdout + result.stderr + out.read_text(encoding="utf-8"))
            bad = run(RENDER, "--fleet-config", str(FLEET_CONFIG), "--agent", "nobody")
            self.assertEqual(bad.returncode, 2)


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class SwitchroomDoctorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()

    def rendered_file(self, tmp: str, env: dict, agent: str = "ops") -> Path:
        # Rendered where the agent's files are visible, as inside its container.
        paths = full_paths(self.sd, Path(tmp) / f"render-{agent}", env)
        rendered = self.sd.render(FLEET_CONFIG, agent, self.sd.env_names(env), CONTRACT, environ=env, paths=paths)
        path = Path(tmp) / f"{agent}.yaml"
        path.write_text(self.sd.dump_config(rendered), encoding="utf-8")
        return path

    def env_file(self, tmp: str, env: dict) -> Path:
        path = Path(tmp) / "agent.env"
        path.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
        return path

    def doctor(self, tmp: str, env: dict, *extra: str, config_env: dict | None = None):
        config = self.rendered_file(tmp, FULL_ENV if config_env is None else config_env)
        return run(DOCTOR, "--config", str(config), "--env-file", str(self.env_file(tmp, env)),
                   "--no-process-env", *extra)

    def lines(self, result) -> dict[str, str]:
        out = {}
        for line in result.stdout.splitlines():
            default_id, _, status = line.partition(": ")
            out[default_id] = status
        return out

    def test_all_credentials_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self.doctor(tmp, FULL_ENV)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.lines(result)
        # model-roles is followed by one line per subscription plan and task role.
        sub = [key for key in lines if key.startswith("model-roles.")]
        self.assertEqual(sub, [f"model-roles.plan.{p}" for p in self.sd.PLANS]
                         + [f"model-roles.{r}" for r in self.sd.ROLES])
        lines = {key: status for key, status in lines.items() if key not in sub}
        self.assertEqual(list(lines), [d["id"] for d in contract_defaults()])
        for entry in contract_defaults():
            expected = "on" if entry["id"] in CONFIGURED else "off: not configured by the starter overlay yet"
            self.assertEqual(lines[entry["id"]], expected, entry["id"])
        for value in FULL_ENV.values():
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_each_credential_missing_in_turn(self) -> None:
        degrade = {d["id"]: d["degrade"]["behaviour"] for d in contract_defaults()}
        for name in FULL_ENV:
            with self.subTest(missing=name), tempfile.TemporaryDirectory() as tmp:
                env = {k: v for k, v in FULL_ENV.items() if k != name}
                # Both a config rendered without the credential and a stale one
                # rendered with it must report the default off, and exit 0.
                for config_env in (env, FULL_ENV):
                    result = self.doctor(tmp, env, config_env=config_env)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    lines = self.lines(result)
                    for default_id, requires in self.sd.REQUIREMENTS.items():
                        if name in requires:
                            status = lines[default_id]
                            self.assertTrue(status.startswith("off: "), status)
                            self.assertIn(name, status)
                            self.assertIn(self.sd.DEGRADE_TEXT[degrade[default_id]], status)
                    for value in FULL_ENV.values():
                        self.assertNotIn(value, result.stdout + result.stderr)

    def test_degrade_wording_follows_the_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self.doctor(tmp, {}, config_env={})
        lines = self.lines(result)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(lines["voice"].startswith("off: text-only replies"))
        self.assertTrue(lines["honcho-memory"].startswith("off: using built-in memory"))
        self.assertTrue(lines["web-search"].startswith("off: using the default web backend"))
        self.assertTrue(lines["linear"].startswith("off: disabled"))
        self.assertTrue(lines["model-roles"].startswith("off: no granted model provider"))
        self.assertEqual(lines["secrets-connect"], "off: using the env file: OP_CONNECT_HOST, OP_CONNECT_TOKEN not set")
        for default_id in ALWAYS_ON:
            self.assertEqual(lines[default_id], "on", default_id)
        self.assertEqual(lines["doctrine-config"], "on")

    def test_opt_out_is_reported_as_turned_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = self.rendered_file(tmp, FULL_ENV, agent="worker")
            result = run(DOCTOR, "--config", str(config), "--env-file", str(self.env_file(tmp, FULL_ENV)),
                         "--no-process-env")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.lines(result)["voice"], "off: turned off in this agent's config")

    def test_check_files_requires_the_login_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            claude = Path(tmp) / "claude"
            claude.mkdir()
            token = Path(tmp) / "linear-token"
            env = dict(FULL_ENV, CLAUDE_CONFIG_DIR=str(claude), LINEAR_TOKEN_FILE=str(token))
            lines = self.lines(self.doctor(tmp, env, "--check-files"))
            self.assertTrue(lines["claude-subscription-directsdk"].startswith("off: disabled: no Claude login"))
            self.assertTrue(lines["linear"].startswith("off: disabled: the file"))
            # An empty record is not a login.
            (claude / ".credentials.json").write_text("{}", encoding="utf-8")
            token.write_text("x", encoding="utf-8")
            lines = self.lines(self.doctor(tmp, env, "--check-files"))
            self.assertTrue(lines["claude-subscription-directsdk"].startswith("off: disabled: no Claude login"))
            self.assertEqual(lines["linear"], "on")
            (claude / ".credentials.json").write_text(json.dumps(fixture.CLAUDE_LOGIN), encoding="utf-8")
            lines = self.lines(self.doctor(tmp, env, "--check-files"))
            self.assertEqual(lines["claude-subscription-directsdk"], "on")
            self.assertEqual(lines["claude-acp-connectors"], "on")

    def test_ungranted_model_provider_is_a_problem(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ok = self.doctor(tmp, FULL_ENV, "--granted", "claude-subscription-directsdk-experimental,claude-acp")
            bad = self.doctor(tmp, FULL_ENV, "--granted", "claude-subscription-directsdk-experimental")
            config = Path(tmp) / "broken.yaml"
            config.write_text("- not a mapping\n", encoding="utf-8")
            unreadable = run(DOCTOR, "--config", str(config), "--no-process-env")
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("problem: model provider claude-acp is not in the granted list", bad.stdout)
        self.assertEqual(unreadable.returncode, 2)


def expand_env(value, environ: dict):
    """Expand ${NAME} the way Hermes does when it loads config.yaml."""
    if isinstance(value, str):
        return re.sub(r"\$\{(?:env:)?([^}]*)\}", lambda m: environ[m.group(1)], value)
    if isinstance(value, dict):
        return {k: expand_env(v, environ) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_env(v, environ) for v in value]
    return value


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class RenderedSettingsPluginValidationTests(unittest.TestCase):
    """A default rendered on must pass its own plugin's settings validation.

    The renderer only knows variable names; the plugin decides whether the
    settings it is given can start. Each plugin that validates its settings
    is fed the rendered, env-expanded settings here, so a default can never
    be rendered on and then refused at gateway start.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_fake_api import load_plugin
        cls.linear = load_plugin()
        from hermes_fleet_linear_plugin import oauth
        cls.linear_oauth = oauth

    def settings(self, plugin: str, env: dict = FULL_ENV) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(env), CONTRACT, environ=env,
                                      paths=full_paths(self.sd, tmp, env))
        self.assertIn(plugin, rendered.leaves["plugins.enabled"])
        return expand_env(rendered.leaves[f"plugins.entries.{plugin}.settings"], env)

    def start_linear(self, raw: dict, home: Path):
        """The plugin's own start-up validation, as _reporting_loop runs it."""
        settings = {key: raw[key] for key in self.linear.SETTINGS if raw.get(key) is not None}
        self.linear.validate_activation_cutoff_ms(settings.get("activation_cutoff_ms"))
        self.linear.validate_ingress_profile(settings.get("ingress_profile"))
        api = self.linear.BoundLinearAPI(lambda: "", identity=settings.get("identity"),
                                         specialist_scope=settings.get("specialist_scope"),
                                         rate_limit_path=self.linear.rate_limit_path(settings.get("state_database"), home))
        return api, self.linear_oauth.token_provider(settings, home)

    def test_rendered_linear_settings_pass_the_plugins_start_up_validation(self) -> None:
        raw = self.settings("linear")
        self.assertIs(raw["enabled"], True)
        with tempfile.TemporaryDirectory() as tmp:
            api, token = self.start_linear(raw, Path(tmp))
        self.assertEqual(api.identity, {"viewer_id": FULL_ENV["LINEAR_VIEWER_ID"],
                                        "organization_id": FULL_ENV["LINEAR_ORGANIZATION_ID"]})
        self.assertIsInstance(token, self.linear_oauth.TokenFile)
        self.assertEqual(str(token.path), FULL_ENV["LINEAR_TOKEN_FILE"])

    def test_linear_settings_without_identity_are_refused_by_plugin_and_doctor(self) -> None:
        raw = self.settings("linear")
        for broken in ({k: v for k, v in raw.items() if k != "identity"},
                       dict(raw, identity={"viewer_id": FULL_ENV["LINEAR_VIEWER_ID"]}),
                       dict(raw, identity={"viewer_id": " ", "organization_id": FULL_ENV["LINEAR_ORGANIZATION_ID"]})):
            with self.subTest(identity=broken.get("identity")), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError, "identity needs viewer_id and organization_id"):
                    self.start_linear(broken, Path(tmp))
                config = {"plugins": {"enabled": ["linear"], "entries": {"linear": {"settings": broken}}}}
                lines, _ = self.sd.diagnose(config, FULL_ENV, CONTRACT)
                self.assertIn("linear: off: disabled: plugins.entries.linear.settings.identity needs "
                              "viewer_id and organization_id", lines)

    def test_linear_is_omitted_when_any_identity_variable_is_missing(self) -> None:
        for name in self.sd.REQUIREMENTS["linear"]:
            with self.subTest(missing=name):
                env = {k: v for k, v in FULL_ENV.items() if k != name}
                with tempfile.TemporaryDirectory() as tmp:
                    rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(env), CONTRACT, environ=env,
                                              paths=full_paths(self.sd, tmp, FULL_ENV))
                self.assertEqual(rendered.decisions["linear"].reason, f"{name} not set")
                self.assertNotIn("linear", rendered.leaves["plugins.enabled"])
                self.assertEqual(rendered.leaves["plugins.entries.linear.settings"], {"enabled": False})
                lines, _ = self.sd.diagnose(rendered.config, env, CONTRACT)
                self.assertIn(f"linear: off: disabled: {name} not set", lines)

    def test_rendered_connector_settings_pass_the_plugins_validation(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "starter_connectors_under_test", ROOT / "plugins" / "claude-account-connectors" / "plugin.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        raw = self.settings("claude-account-connectors")
        self.assertIs(raw["enabled"], True)
        # Same arguments register() passes; a stub ACP keeps this credential-free.
        backend = module.NativeBackend(raw.get("model", "sonnet"), raw.get("timeout", 90), acp=object())
        self.assertEqual((backend.model, backend.timeout), (raw["model"], raw["timeout"]))
        with self.assertRaises(ValueError):
            module.NativeBackend("not-a-model", raw["timeout"], acp=object())


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class StarterOverlayContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()

    def test_starter_overlay_field_matches_what_the_overlay_renders(self) -> None:
        base = json.loads(CONTRACT.read_text(encoding="utf-8"))["public_base"]
        self.assertEqual(base["starter_overlay_values"], ["configured", "not_configured"])
        declared = {d["id"] for d in base["default_set"] if d["starter_overlay"] == "configured"}
        for entry in base["default_set"]:
            self.assertIn(entry["starter_overlay"], base["starter_overlay_values"])
        overlay = set(self.sd.load_yaml(FLEET_CONFIG / "defaults.yaml")["defaults"])
        self.assertEqual(declared, overlay)
        with tempfile.TemporaryDirectory() as tmp:
            rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(FULL_ENV), CONTRACT, environ=FULL_ENV,
                                      paths=full_paths(self.sd, tmp, FULL_ENV))
        self.assertEqual({d for d, x in rendered.decisions.items() if x.on}, declared)
        for entry in base["default_set"]:
            with self.subTest(default=entry["id"]):
                self.assertIs(self.sd.configured_on(entry["id"], rendered.config),
                              True if entry["id"] in declared else None)

    def test_configuring_a_default_does_not_ship_it(self) -> None:
        # Configured is not shipped: only a default with real-container evidence
        # is shipped (docs/starter-overlay-acceptance.md).
        evidence = (ROOT / "docs" / "starter-overlay-acceptance.md").read_text(encoding="utf-8")
        for entry in contract_defaults():
            proven = f"| `{entry['id']}` | **shipped** |" in evidence
            self.assertEqual(entry["status"], "shipped" if proven else "planned", entry["id"])

    def test_model_defaults_bill_only_the_principals_plan(self) -> None:
        doc = self.sd.load_yaml(FLEET_CONFIG / "defaults.yaml")
        by_id = {d["id"]: d for d in contract_defaults()}
        for default_id, entry in doc["defaults"].items():
            if "model" in entry:
                with self.subTest(default=default_id):
                    self.assertEqual(by_id[default_id]["billing"], "principal_plan_login")
                    self.assertIs(by_id[default_id]["api_key_fallback"], False)
                    self.assertIn(entry["model"]["provider"], doc["granted_providers"])


def _overlay_copy(tmp: str, defaults_edit=None, agent_body: str | None = None) -> Path:
    config_dir = Path(tmp) / "fleet-config"
    shutil.copytree(FLEET_CONFIG, config_dir)
    if defaults_edit is not None:
        path = config_dir / "defaults.yaml"
        path.write_text(defaults_edit(path.read_text(encoding="utf-8")), encoding="utf-8")
    if agent_body is not None:
        (config_dir / "agents" / "ops.yaml").write_text(
            "profile: ops\nrole: operator\napply_mode: merge\n" + agent_body, encoding="utf-8")
    return config_dir


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class StarterOverlayWave1bDefaultsTests(unittest.TestCase):
    """secrets-connect, coding-clis, quota, session-reset-policy,
    security-guidance, disk-cleanup and shared-skill-pack."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()

    def render(self, env: dict = FULL_ENV, config_dir: Path = FLEET_CONFIG, agent: str = "ops"):
        return self.sd.render(config_dir, agent, self.sd.env_names(env), CONTRACT)

    def test_new_defaults_render_their_reviewed_settings(self) -> None:
        leaves = self.render().leaves
        self.assertEqual(leaves["session_reset"], {"mode": "idle", "idle_minutes": 240})
        self.assertEqual(leaves["plugins.config.disk-cleanup"], {"session_end_mode": "report_only"})
        self.assertEqual(leaves["_switchroom.skill_pack"], "/opt/data/skills/switchroom-shared")
        # Hermes reads skills.external_dirs only from the agent's own config.yaml.
        self.assertNotIn("skills", self.render().config)
        self.assertEqual(leaves["_switchroom.secrets_source"], "onepassword_connect")
        expected = next(d for d in contract_defaults() if d["id"] == "coding-clis")["expected"]
        self.assertEqual(leaves["_switchroom.coding_clis"], expected)
        for plugin in ("quota", "hermes-session-reset-policy", "security-guidance", "disk-cleanup"):
            self.assertIn(plugin, leaves["plugins.enabled"])
        # Hermes reads secrets.onepassword only from the agent's own config.yaml,
        # so a managed render that set it would be silently ignored.
        self.assertNotIn("secrets", self.render().config)

    def test_coding_clis_match_the_image_lockfile(self) -> None:
        packages = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["dependencies"]
        image_clis = {"@anthropic-ai/claude-code": "claude", "@openai/codex": "codex",
                      "@xai-official/grok": "grok", "opencode-ai": "opencode"}
        self.assertTrue(set(image_clis) <= set(packages))
        expected = next(d for d in contract_defaults() if d["id"] == "coding-clis")["expected"]
        self.assertEqual(sorted(expected), sorted(image_clis.values()))
        self.assertEqual(sorted(self.sd.CODING_CLI_LOGINS), sorted(expected))

    def test_connect_supplies_only_the_names_it_lists_and_only_while_it_is_on(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = _overlay_copy(tmp, lambda t: t.replace(
                "_switchroom.connect_provides: []", "_switchroom.connect_provides: [PERPLEXITY_API_KEY]"))
            without_key = {k: v for k, v in FULL_ENV.items() if k != "PERPLEXITY_API_KEY"}
            rendered = self.render(without_key, config_dir)
            self.assertTrue(rendered.decisions["web-search"].on)
            lines, problems = self.sd.diagnose(rendered.config, without_key, CONTRACT)
            self.assertIn("web-search: on", lines)
            self.assertIn("secrets-connect: on", lines)
            self.assertEqual(problems, [])
            no_connect = {k: v for k, v in without_key.items() if not k.startswith("OP_CONNECT")}
            rendered = self.render(no_connect, config_dir)
            self.assertFalse(rendered.decisions["web-search"].on)
            self.assertEqual(rendered.leaves["_switchroom.secrets_source"], "env_file")
            lines, _ = self.sd.diagnose(rendered.config, no_connect, CONTRACT)
            self.assertIn("secrets-connect: off: using the env file: OP_CONNECT_HOST, OP_CONNECT_TOKEN not set", lines)
            self.assertIn("web-search: off: using the default web backend: PERPLEXITY_API_KEY not set", lines)
            opted_out = _overlay_copy(tmp + "/b", lambda t: t.replace(
                "_switchroom.connect_provides: []", "_switchroom.connect_provides: [PERPLEXITY_API_KEY]"),
                "defaults:\n  secrets-connect: false\nvalues: {}\n")
            self.assertFalse(self.render(without_key, opted_out).decisions["web-search"].on)

    def test_connect_leaves_are_owned_by_the_connect_default(self) -> None:
        cases = {
            "agent value": (None, "values:\n  _switchroom.connect_provides: [PERPLEXITY_API_KEY]\n"),
            "other default": (lambda t: t.replace("      _switchroom.coding_clis: [claude, codex, grok, opencode]",
                                                  "      _switchroom.coding_clis: [claude]\n"
                                                  "      _switchroom.connect_provides: [PERPLEXITY_API_KEY]"), None),
            "own requirement": (lambda t: t.replace("_switchroom.connect_provides: []",
                                                    "_switchroom.connect_provides: [OP_CONNECT_TOKEN]"), None),
            "unknown cli": (lambda t: t.replace("[claude, codex, grok, opencode]", "[claude, aider]"), None),
        }
        for label, (edit, agent) in cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(self.sd.DefaultsError):
                    self.render(config_dir=_overlay_copy(tmp, edit, agent))

    def test_disk_cleanup_never_renders_or_passes_in_a_deleting_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = _overlay_copy(tmp, agent_body="values:\n  plugins.config.disk-cleanup:\n"
                                                       "    session_end_mode: cleanup\n")
            with self.assertRaisesRegex(self.sd.DefaultsError, "would delete"):
                self.render(config_dir=config_dir)
        config = self.render().config
        del config["plugins"]["config"]
        lines, problems = self.sd.diagnose(config, FULL_ENV, CONTRACT)
        self.assertTrue(any("would delete" in p for p in problems), problems)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_text(yaml.safe_dump(config), encoding="utf-8")
            result = run(DOCTOR, "--config", str(path), "--no-process-env")
        self.assertEqual(result.returncode, 1)

    def test_manual_delete_opt_in_is_refused_in_the_shared_defaults(self) -> None:
        opt_in = "        session_end_mode: report_only\n        allow_manual_delete: true\n"
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = _overlay_copy(tmp, lambda t: t.replace("        session_end_mode: report_only\n", opt_in))
            self.assertIn("allow_manual_delete: true", (config_dir / "defaults.yaml").read_text(encoding="utf-8"))
            with self.assertRaisesRegex(self.sd.DefaultsError, "allow_manual_delete may only be set"):
                self.render(config_dir=config_dir)
        rendered = self.render().config
        self.assertNotIn("allow_manual_delete", rendered["plugins"]["config"]["disk-cleanup"])
        lines, problems = self.sd.diagnose(rendered, FULL_ENV, CONTRACT)
        self.assertFalse([line for line in lines if line.startswith("warning:")], lines)

    def test_one_agent_may_opt_in_and_the_setup_check_warns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = _overlay_copy(tmp, agent_body="values:\n  plugins.config.disk-cleanup:\n"
                                                       "    session_end_mode: report_only\n"
                                                       "    allow_manual_delete: true\n")
            config = self.render(config_dir=config_dir).config
        self.assertIs(config["plugins"]["config"]["disk-cleanup"]["allow_manual_delete"], True)
        lines, problems = self.sd.diagnose(config, FULL_ENV, CONTRACT)
        self.assertEqual(problems, [])
        index = lines.index("disk-cleanup: on")
        self.assertTrue(lines[index + 1].startswith(
            "warning: disk-cleanup: plugins.config.disk-cleanup.allow_manual_delete is true"), lines)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_text(yaml.safe_dump(config), encoding="utf-8")
            result = run(DOCTOR, "--config", str(path), "--no-process-env")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning: disk-cleanup:", result.stdout)

    def test_session_reset_values_the_plugin_would_ignore_are_reported_off(self) -> None:
        config = self.render().config
        lines, _ = self.sd.diagnose(config, FULL_ENV, CONTRACT)
        self.assertIn("session-reset-policy: on", lines)
        for broken, reason in (({"mode": "idle", "idle_minutes": "240"}, "idle_minutes"),
                               ({"mode": "idle", "idle_minutes": 0}, "idle_minutes"),
                               ({"mode": "sometimes", "idle_minutes": 240}, "mode"),
                               ({"mode": "daily"}, "at_hour")):
            with self.subTest(policy=broken):
                config["session_reset"] = broken
                lines, _ = self.sd.diagnose(config, FULL_ENV, CONTRACT)
                status = next(line for line in lines if line.startswith("session-reset-policy: "))
                self.assertTrue(status.startswith("session-reset-policy: off: disabled: session_reset."), status)
                self.assertIn(reason, status)

    def container_root(self, tmp: str, *, plugins: bool = True, skills: bool = True, op: bool = True,
                       mapping: dict | None = None) -> Path:
        root = Path(tmp) / "root"
        if plugins:
            for base, name in (("opt/hermes/plugins", "security-guidance"), ("opt/hermes/plugins", "disk-cleanup"),
                               ("opt/data/plugins", "quota"), ("opt/data/plugins", "hermes-session-reset-policy")):
                (root / base / name).mkdir(parents=True)
                (root / base / name / "plugin.yaml").write_text(f"name: {name}\n", encoding="utf-8")
        if skills:
            (root / "opt/data/skills/switchroom-shared/example-skill").mkdir(parents=True)
            (root / "opt/data/skills/switchroom-shared/example-skill/SKILL.md").write_text(
                "---\nname: x\n---\n", encoding="utf-8")
        if op:
            (root / "usr/local/bin").mkdir(parents=True)
            (root / "usr/local/bin/op").write_text("", encoding="utf-8")
        if mapping is not None:
            (root / "opt/data").mkdir(parents=True, exist_ok=True)
            (root / "opt/data/config.yaml").write_text(yaml.safe_dump(
                {"secrets": {"onepassword": {"enabled": True, "env": mapping}}}), encoding="utf-8")
        return root

    def lines_for(self, config: dict, env: dict, root: Path) -> dict[str, str]:
        lines, _ = self.sd.diagnose(config, env, CONTRACT, check_files=True,
                                    paths=self.sd.ContainerPaths(root=root, hermes_home="/opt/data"))
        return dict(line.split(": ", 1) for line in lines)

    def test_check_files_requires_mounts_skills_connect_mapping_and_cli_logins(self) -> None:
        secret_ref = "vault-ref-SECRET-value"
        # The Perplexity key comes only from Connect here, never the env file.
        env = dict({k: v for k, v in FULL_ENV.items() if k != "PERPLEXITY_API_KEY"}, HOME="/opt/data/home")
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = _overlay_copy(tmp, lambda t: t.replace(
                "_switchroom.connect_provides: []", "_switchroom.connect_provides: [PERPLEXITY_API_KEY]"))
            config = self.render(env, config_dir).config
            root = self.container_root(tmp, mapping={"PERPLEXITY_API_KEY": secret_ref})
            claude = root / env["CLAUDE_CONFIG_DIR"].lstrip("/")
            claude.mkdir(parents=True)
            (claude / ".credentials.json").write_text("{}", encoding="utf-8")
            (root / "opt/data/home/.codex").mkdir(parents=True)
            (root / "opt/data/home/.codex/auth.json").write_text("{}", encoding="utf-8")
            lines = self.lines_for(config, env, root)
            for default_id in ("quota", "session-reset-policy", "security-guidance", "disk-cleanup",
                               "shared-skill-pack", "secrets-connect", "coding-clis"):
                self.assertEqual(lines[default_id], "on", default_id)
            self.assertEqual(lines["web-search"], "on")
            self.assertEqual(lines["coding-clis.claude"], "on")
            self.assertEqual(lines["coding-clis.codex"], "on")
            self.assertEqual(lines["coding-clis.grok"], "off: disabled: no grok login found")
            self.assertEqual(lines["coding-clis.opencode"], "off: disabled: no opencode login found")
            self.assertNotIn(secret_ref, "\n".join(lines.values()))

            bare = self.container_root(tmp + "/bare", plugins=False, skills=False, op=False)
            lines = self.lines_for(config, {k: v for k, v in env.items() if k != "CLAUDE_CONFIG_DIR"}, bare)
            self.assertEqual(lines["quota"], "off: disabled: plugin quota is not present at /opt/data/plugins/quota")
            self.assertTrue(lines["disk-cleanup"].startswith("off: disabled: plugin disk-cleanup is not present"))
            self.assertTrue(lines["shared-skill-pack"].startswith(
                "off: disabled: Hermes finds no skills in /opt/data/skills/switchroom-shared"), lines["shared-skill-pack"])
            self.assertEqual(lines["secrets-connect"], "off: using the env file: the op CLI is not at /usr/local/bin/op")
            self.assertTrue(lines["web-search"].startswith("off: using the default web backend"))
            self.assertEqual(lines["coding-clis"], "off: disabled: no coding CLI login found")

            unmapped = self.container_root(tmp + "/unmapped", mapping={})
            lines = self.lines_for(config, env, unmapped)
            self.assertEqual(lines["secrets-connect"],
                             "off: using the env file: no 1Password reference mapped for PERPLEXITY_API_KEY")
            self.assertTrue(lines["web-search"].startswith("off: "))

    def test_doctor_cli_root_flag_and_no_values_printed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "ops.yaml"
            config.write_text(self.sd.dump_config(self.render()), encoding="utf-8")
            env_file = Path(tmp) / "ops.env"
            env_file.write_text("".join(f"{k}={v}\n" for k, v in FULL_ENV.items()), encoding="utf-8")
            root = self.container_root(tmp, mapping={})
            result = run(DOCTOR, "--config", str(config), "--env-file", str(env_file), "--no-process-env",
                         "--check-files", "--root", str(root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("quota: on", result.stdout)
        self.assertIn("coding-clis: off: disabled: no coding CLI login found", result.stdout)
        for value in FULL_ENV.values():
            self.assertNotIn(value, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
