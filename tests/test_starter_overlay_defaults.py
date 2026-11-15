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
}
CONFIGURED = [
    "doctrine-config", "gateway-per-agent", "model-roles", "claude-subscription-directsdk",
    "claude-acp-connectors", "linear", "voice", "honcho-memory", "web-search",
]
PLUGINS_BY_DEFAULT = {
    "claude-subscription-directsdk": ["claude-subscription-directsdk-experimental"],
    "claude-acp-connectors": ["claude-acp-provider", "claude-account-connectors"],
    "linear": ["linear"],
    "voice": ["kokoro-voice"],
    "web-search": ["web-perplexity"],
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

    def render(self, agent: str = "ops", env: dict | None = None, config_dir: Path = FLEET_CONFIG):
        return self.sd.render(config_dir, agent, self.sd.env_names(FULL_ENV if env is None else env), CONTRACT)

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
        self.assertNotIn("tts.provider", worker.leaves)
        self.assertIs(worker.leaves["stt.enabled"], False)
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
                lines, problems = self.sd.diagnose(rendered.config, FULL_ENV, CONTRACT)
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
        self.assertEqual([d for d, x in rendered.decisions.items() if x.on], ["doctrine-config", "gateway-per-agent"])
        self.assertNotIn("model.provider", rendered.leaves)
        self.assertNotIn("fallback_providers", rendered.leaves)
        self.assertNotIn("plugins.enabled", rendered.leaves)
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
        lines, problems = self.sd.diagnose(rendered.config, env, CONTRACT, granted=granted)
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
        self.assertEqual(tuple(doc["defaults"]["model-roles"]["chain"]), self.sd.MODEL_CHAIN_MEMBERS)

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
            self.assertIn("linear: on", result.stderr)
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
        rendered = self.sd.render(FLEET_CONFIG, agent, self.sd.env_names(env), CONTRACT)
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
            (claude / ".credentials.json").write_text("{}", encoding="utf-8")
            token.write_text("x", encoding="utf-8")
            lines = self.lines(self.doctor(tmp, env, "--check-files"))
            self.assertEqual(lines["claude-subscription-directsdk"], "on")
            self.assertEqual(lines["linear"], "on")

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
        rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(env), CONTRACT)
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
                rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(env), CONTRACT)
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
        rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(FULL_ENV), CONTRACT)
        self.assertEqual({d for d, x in rendered.decisions.items() if x.on}, declared)
        for entry in base["default_set"]:
            with self.subTest(default=entry["id"]):
                self.assertIs(self.sd.configured_on(entry["id"], rendered.config),
                              True if entry["id"] in declared else None)

    def test_configuring_a_default_does_not_ship_it(self) -> None:
        for entry in contract_defaults():
            self.assertEqual(entry["status"], "planned", entry["id"])

    def test_model_defaults_bill_only_the_principals_plan(self) -> None:
        doc = self.sd.load_yaml(FLEET_CONFIG / "defaults.yaml")
        by_id = {d["id"]: d for d in contract_defaults()}
        for default_id, entry in doc["defaults"].items():
            if "model" in entry:
                with self.subTest(default=default_id):
                    self.assertEqual(by_id[default_id]["billing"], "principal_plan_login")
                    self.assertIs(by_id[default_id]["api_key_fallback"], False)
                    self.assertIn(entry["model"]["provider"], doc["granted_providers"])


if __name__ == "__main__":
    unittest.main()
