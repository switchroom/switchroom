"""Subscription plans and per-task model roles in the starter overlay.

Three plans can lead: the Claude plan (the agent's Claude Code login), the
ChatGPT plan (Hermes' openai-codex provider) and the SuperGrok plan (Hermes'
xai-oauth provider). `primary_plan` picks the main chat model's plan and
`roles` picks the lead plan for every other task role. A plan is used only
when its login exists and its provider is granted; there is no API-key path.
See docs/choose-your-plans.md.
"""
from __future__ import annotations

import importlib.util
import json
import os
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
DOCTOR = SCRIPTS / "switchroom-doctor.py"
RENDER = SCRIPTS / "render-overlay-config.py"

try:
    import yaml  # noqa: F401
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


fixture = _load("starter_overlay_fixture", ROOT / "tests" / "starter_overlay_fixture.py")

CLAUDE_ENV = {"CLAUDE_CONFIG_DIR": "/opt/data/.claude-login-dir"}
ALL_PLANS = ("chatgpt", "grok")
CLAUDE_PROVIDERS = {"claude-subscription-directsdk-experimental", "claude-acp"}
GRANTED = sorted(CLAUDE_PROVIDERS | {"openai-codex", "xai-oauth"})
OTHER_ROLES = ("coding", "fast", "approvals", "compression")


def overlay_copy(tmp: str, agent_body: str = "values: {}\n", defaults_edit=None) -> Path:
    config_dir = Path(tmp) / "fleet-config"
    shutil.copytree(FLEET_CONFIG, config_dir)
    if defaults_edit is not None:
        path = config_dir / "defaults.yaml"
        path.write_text(defaults_edit(path.read_text(encoding="utf-8")), encoding="utf-8")
    (config_dir / "agents" / "ops.yaml").write_text(
        "profile: ops\nrole: operator\napply_mode: merge\n" + agent_body, encoding="utf-8")
    return config_dir


def providers_in(config_text: str) -> set[str]:
    return {p for p in ("openai-codex", "xai-oauth", *CLAUDE_PROVIDERS) if p in config_text}


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class SubscriptionPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _load("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name

    def container(self, name: str, env: dict = CLAUDE_ENV, **logins):
        root = fixture.full_container_root(Path(self.tmp) / name, env, **logins)
        return self.sd.ContainerPaths(root=root, hermes_home="/opt/data")

    def render(self, paths, env: dict = CLAUDE_ENV, config_dir: Path = FLEET_CONFIG, agent: str = "ops"):
        return self.sd.render(config_dir, agent, self.sd.env_names(env), CONTRACT, environ=env, paths=paths)

    def diagnose(self, config, paths, env: dict = CLAUDE_ENV, check_files: bool = True):
        lines, problems = self.sd.diagnose(config, env, CONTRACT, check_files=check_files, granted=GRANTED,
                                           paths=paths)
        return dict(line.split(": ", 1) for line in lines if not line.startswith("warning:")), problems, lines

    # ----------------------------------------------------- each plan off without a login

    def test_chatgpt_and_grok_are_fully_off_without_their_login(self) -> None:
        cases = {
            "no auth.json": {},
            "only an API key": {"api_keys": ALL_PLANS},
        }
        for label, logins in cases.items():
            with self.subTest(case=label):
                paths = self.container(label.replace(" ", "-"), **logins)
                rendered = self.render(paths)
                text = self.sd.dump_config(rendered)
                self.assertEqual(providers_in(text) & {"openai-codex", "xai-oauth"}, set())
                for plan, what in (("chatgpt", "ChatGPT login"), ("grok", "SuperGrok login")):
                    decision = rendered.plan_decisions[plan]
                    self.assertFalse(decision.on)
                    self.assertIn(f"no {what} in /opt/data/auth.json", decision.reason)
                lines, problems, _ = self.diagnose(rendered.config, paths)
                self.assertEqual(problems, [])
                self.assertTrue(lines["model-roles.plan.chatgpt"].startswith("off: no ChatGPT login"))
                self.assertTrue(lines["model-roles.plan.grok"].startswith("off: no SuperGrok login"))
                # Claude still leads everything, so nothing else changed.
                for role in self.sd.ROLES:
                    self.assertTrue(lines[f"model-roles.{role}"].startswith("on: claude "), role)
                    self.assertNotIn("chatgpt", lines[f"model-roles.{role}"])

    def test_a_login_on_the_host_render_is_not_trusted(self) -> None:
        # Without --check-files the auth store cannot be seen, so the plans stay off.
        rendered = self.sd.render(FLEET_CONFIG, "ops", self.sd.env_names(CLAUDE_ENV), CONTRACT, environ=CLAUDE_ENV)
        for plan in self.sd.PLANS:
            self.assertFalse(rendered.plan_decisions[plan].on, plan)
        self.assertFalse(rendered.plan_decisions["chatgpt"].checked)
        self.assertIn("was not checked", rendered.plan_decisions["grok"].reason)
        self.assertEqual(providers_in(self.sd.dump_config(rendered)), set())

    def test_claude_plan_is_fully_off_without_the_claude_login(self) -> None:
        paths = self.container("no-claude", env={}, claude_login=False, plans=ALL_PLANS)
        rendered = self.render(paths, env={})
        text = self.sd.dump_config(rendered)
        self.assertEqual(providers_in(text) & CLAUDE_PROVIDERS, set())
        self.assertFalse(rendered.plan_decisions["claude"].on)
        self.assertIn("CLAUDE_CONFIG_DIR not set", rendered.plan_decisions["claude"].reason)
        # The main model falls to the next plan in order, never to an API key.
        self.assertEqual(rendered.leaves["model.provider"], "openai-codex")
        lines, problems, _ = self.diagnose(rendered.config, paths, env={})
        self.assertEqual(problems, [])
        self.assertEqual(lines["model-roles.plan.claude"], "off: CLAUDE_CONFIG_DIR not set")
        self.assertEqual(lines["model-roles"], "on")

    def test_a_pooled_oauth_login_counts_and_an_api_key_beside_it_is_warned(self) -> None:
        paths = self.container("pooled", pooled=("chatgpt",), api_keys=("chatgpt",))
        rendered = self.render(paths, config_dir=overlay_copy(self.tmp, "primary_plan: chatgpt\nvalues: {}\n"))
        self.assertTrue(rendered.plan_decisions["chatgpt"].on)
        self.assertEqual(rendered.leaves["model.provider"], "openai-codex")
        _, problems, raw = self.diagnose(rendered.config, paths)
        self.assertEqual(problems, [])
        warning = [line for line in raw if line.startswith("warning: model-roles.plan.chatgpt")]
        self.assertEqual(len(warning), 1, raw)
        self.assertIn("API key for openai-codex", warning[0])
        self.assertNotIn("synthetic", "\n".join(raw))

    # ------------------------------------------------- per-role routing and fallbacks

    def test_per_role_routing_renders_the_chosen_plan(self) -> None:
        paths = self.container("all", plans=ALL_PLANS)
        config_dir = overlay_copy(self.tmp, "primary_plan: grok\nroles:\n  coding: chatgpt\n  fast: grok\n"
                                            "  approvals: chatgpt\n  compression: claude\nvalues: {}\n")
        rendered = self.render(paths, config_dir=config_dir)
        config = rendered.config
        expected = {"main": ("xai-oauth", "grok-4.6"), "coding": ("openai-codex", "gpt-6-sol"),
                    "fast": ("xai-oauth", "grok-composer-2.5-fast"), "approvals": ("openai-codex", "gpt-6-luna"),
                    "compression": ("claude-subscription-directsdk-experimental", "sonnet")}
        for role, (provider, model) in expected.items():
            for provider_leaf, model_leaf, _ in self.sd.ROLE_TARGETS[role]:
                with self.subTest(role=role, leaf=provider_leaf):
                    self.assertEqual(rendered.leaves[provider_leaf], provider)
                    self.assertEqual(rendered.leaves[model_leaf], model)
        # Fallbacks: the lead plan's models, then the other plans in defaults.yaml order.
        self.assertEqual(config["fallback_providers"], [
            {"provider": "claude-subscription-directsdk-experimental", "model": "opus"},
            {"provider": "claude-acp", "model": "sonnet"},
            {"provider": "openai-codex", "model": "gpt-6-sol"}])
        self.assertEqual(config["delegation"]["fallback_providers"], [
            {"provider": "claude-subscription-directsdk-experimental", "model": "opus"},
            {"provider": "claude-acp", "model": "sonnet"},
            {"provider": "xai-oauth", "model": "grok-composer-2.5-fast"}])
        self.assertEqual([m["provider"] for m in config["auxiliary"]["title_generation"]["fallback_chain"]],
                         ["claude-subscription-directsdk-experimental", "openai-codex"])
        self.assertEqual(config["_switchroom"]["role_plans"], {"main": "grok", "coding": "chatgpt", "fast": "grok",
                                                               "approvals": "chatgpt", "compression": "claude"})
        lines, problems, _ = self.diagnose(config, paths)
        self.assertEqual(problems, [])
        self.assertTrue(lines["model-roles.main"].startswith("on: grok xai-oauth/grok-4.6, then claude "))
        self.assertTrue(lines["model-roles.coding"].startswith("on: chatgpt openai-codex/gpt-6-sol"))
        for plan in self.sd.PLANS:
            self.assertEqual(lines[f"model-roles.plan.{plan}"], "on")

    def test_fallbacks_only_use_granted_plans_with_a_login(self) -> None:
        paths = self.container("all", plans=ALL_PLANS)
        narrowed = overlay_copy(self.tmp, "granted_providers: [claude-subscription-directsdk-experimental, "
                                          "claude-acp, openai-codex]\nvalues: {}\n")
        rendered = self.render(paths, config_dir=narrowed)
        self.assertNotIn("xai-oauth", self.sd.dump_config(rendered))
        self.assertEqual(rendered.plan_decisions["grok"].reason, "provider xai-oauth is not granted")
        for role in self.sd.ROLES:
            route = self.sd.role_route(rendered.config, role)
            self.assertTrue({m["provider"] for m in route} <= {"claude-subscription-directsdk-experimental",
                                                               "claude-acp", "openai-codex"}, role)
            self.assertIn("openai-codex", {m["provider"] for m in route}, role)
        # Granted but not logged in is the same: grok drops out.
        grok_absent = self.container("chatgpt-only", plans=("chatgpt",))
        rendered = self.render(grok_absent)
        self.assertNotIn("xai-oauth", self.sd.dump_config(rendered))
        # An ungranted provider pasted into any role is a setup-check problem.
        config = rendered.config
        config["delegation"]["fallback_providers"].append({"provider": "openrouter", "model": "any"})
        _, problems, _ = self.diagnose(config, grok_absent)
        self.assertIn("model provider openrouter is not in the granted list", problems)

    def test_switching_primary_plan_changes_the_main_model_only(self) -> None:
        paths = self.container("all", plans=ALL_PLANS)
        baseline = self.render(paths).leaves
        main_leaves = set(self.sd.ROLE_TARGETS["main"][0]) | {"_switchroom.primary_plan", "_switchroom.role_plans"}
        for plan, (provider, model) in (("chatgpt", ("openai-codex", "gpt-6-sol")),
                                        ("grok", ("xai-oauth", "grok-4.6"))):
            with self.subTest(primary_plan=plan), tempfile.TemporaryDirectory() as tmp:
                edit = lambda text, plan=plan: text.replace("    primary_plan: claude\n", f"    primary_plan: {plan}\n")
                switched = self.render(paths, config_dir=overlay_copy(tmp, defaults_edit=edit)).leaves
                changed = {k for k in set(baseline) | set(switched) if baseline.get(k) != switched.get(k)}
                self.assertEqual(changed - main_leaves, set())
                self.assertEqual((switched["model.provider"], switched["model.default"]), (provider, model))
                self.assertEqual(switched["_switchroom.role_plans"],
                                 dict(baseline["_switchroom.role_plans"], main=plan))
                # A one-line per-agent switch does the same.
                agent = self.render(paths, config_dir=overlay_copy(tmp + "/agent", f"primary_plan: {plan}\nvalues: {{}}\n"))
                self.assertEqual(agent.leaves, switched)

    # ------------------------------------------------------------ the setup check

    def test_setup_check_reports_every_plan_and_role(self) -> None:
        paths = self.container("chatgpt", plans=("chatgpt",))
        rendered = self.render(paths)
        report = [line for line in rendered.report_lines() if line.startswith("model-roles")]
        _, _, raw = self.diagnose(rendered.config, paths)
        doctor = [line for line in raw if line.startswith("model-roles")]
        expected = ["model-roles"] + [f"model-roles.plan.{p}" for p in self.sd.PLANS] + [
            f"model-roles.{r}" for r in self.sd.ROLES]
        self.assertEqual([line.split(": ")[0] for line in report], expected)
        self.assertEqual([line.split(": ")[0] for line in doctor], expected)
        # The renderer's report and the setup check agree line for line.
        self.assertEqual(report, doctor)
        for line in doctor:
            self.assertRegex(line, r"^[a-z.-]+: (on|on: .+|off: .+)$")

    def test_a_login_removed_after_render_is_reported_off_never_half_on(self) -> None:
        with_login = self.container("before", plans=ALL_PLANS)
        config_dir = overlay_copy(self.tmp, "primary_plan: chatgpt\nroles:\n  coding: grok\nvalues: {}\n")
        config = self.render(with_login, config_dir=config_dir).config
        self.assertEqual(config["model"]["provider"], "openai-codex")
        without = self.container("after")
        lines, problems, _ = self.diagnose(config, without)
        self.assertEqual(problems, [])
        self.assertTrue(lines["model-roles.plan.chatgpt"].startswith("off: no ChatGPT login"))
        self.assertTrue(lines["model-roles.plan.grok"].startswith("off: no SuperGrok login"))
        self.assertEqual(lines["model-roles"], "off: dropped from the model chain: the main provider openai-codex "
                                               "is off (the chatgpt plan)")
        self.assertTrue(lines["model-roles.main"].startswith("off: dropped from the model chain: its lead model "
                                                             "openai-codex/gpt-6-sol needs the chatgpt plan"))
        self.assertTrue(lines["model-roles.coding"].startswith("off: "), lines["model-roles.coding"])
        # A role still led by a plan that is on stays on and names the dead fallbacks.
        self.assertIn("(fallbacks on chatgpt, grok are off)", lines["model-roles.fast"])
        # Re-rendering without the login leaves no trace of either plan.
        rerendered = self.render(without, config_dir=config_dir)
        self.assertEqual(providers_in(self.sd.dump_config(rerendered)) & {"openai-codex", "xai-oauth"}, set())

    def test_turning_model_roles_off_renders_no_role(self) -> None:
        paths = self.container("all", plans=ALL_PLANS)
        rendered = self.render(paths, config_dir=overlay_copy(self.tmp, "defaults:\n  model-roles: false\nvalues: {}\n"))
        for leaf in self.sd.ROLE_LEAVES | {"_switchroom.primary_plan", "_switchroom.role_plans"}:
            self.assertNotIn(leaf, rendered.leaves)
        lines, _, _ = self.diagnose(rendered.config, paths)
        for role in self.sd.ROLES:
            self.assertEqual(lines[f"model-roles.{role}"], "off: turned off in this agent's config")

    def test_doctor_cli_prints_plan_and_role_lines_without_secrets(self) -> None:
        paths = self.container("cli", plans=ALL_PLANS)
        config = Path(self.tmp) / "ops.yaml"
        config.write_text(self.sd.dump_config(self.render(paths)), encoding="utf-8")
        env_file = Path(self.tmp) / "ops.env"
        env_file.write_text("".join(f"{k}={v}\n" for k, v in CLAUDE_ENV.items()), encoding="utf-8")
        result = subprocess.run([sys.executable, str(DOCTOR), "--config", str(config), "--env-file", str(env_file),
                                 "--no-process-env", "--check-files", "--root", str(paths.root),
                                 "--granted", ",".join(GRANTED)],
                                cwd=ROOT, text=True, capture_output=True, check=False, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("model-roles.plan.grok: on\n", result.stdout)
        self.assertIn("model-roles.approvals: on: claude ", result.stdout)
        self.assertNotIn("synthetic", result.stdout + result.stderr)
        rendered = subprocess.run([sys.executable, str(RENDER), "--fleet-config", str(FLEET_CONFIG), "--agent", "ops",
                                   "--env-file", str(env_file), "--report", "--check-files", "--root", str(paths.root)],
                                  cwd=ROOT, text=True, capture_output=True, check=False, timeout=60)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        self.assertIn("model-roles.plan.chatgpt: on\n", rendered.stderr)
        self.assertNotIn("synthetic", rendered.stdout + rendered.stderr)

    # ------------------------------------------------------------ overlay validation

    def test_routing_mistakes_are_refused(self) -> None:
        agent_cases = {
            "unknown plan": ("primary_plan: gemini\nvalues: {}\n", "must be one of"),
            "main in roles": ("roles:\n  main: grok\nvalues: {}\n", "main follows primary_plan"),
            "unknown role": ("roles:\n  vision: grok\nvalues: {}\n", "unknown role"),
            "role leaf in values": ("values:\n  delegation.provider: openai-codex\n", "routed with primary_plan"),
            "main leaf in values": ("values:\n  model.provider: xai-oauth\n", "routed with primary_plan"),
        }
        for label, (body, message) in agent_cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(self.sd.DefaultsError, message):
                    self.render(None, config_dir=overlay_copy(tmp, body))
        defaults_cases = {
            "provider outside its plan": (lambda t: t.replace("main: [{provider: xai-oauth, model: grok-4.6}]",
                                                              "main: [{provider: openrouter, model: grok-4.6}]"),
                                          "does not bill the grok plan"),
            "role missing": (lambda t: t.replace("      compression: claude\n", ""), "every role"),
            "renderer leaf in shared values": (lambda t: t.replace("  web.use_gateway: false\n",
                                                                   "  web.use_gateway: false\n  delegation.model: x\n"),
                                               "built by the renderer"),
        }
        for label, (edit, message) in defaults_cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                config_dir = overlay_copy(tmp, defaults_edit=edit)
                self.assertNotEqual((config_dir / "defaults.yaml").read_text(encoding="utf-8"),
                                    (FLEET_CONFIG / "defaults.yaml").read_text(encoding="utf-8"))
                with self.assertRaisesRegex(self.sd.DefaultsError, message):
                    self.render(None, config_dir=config_dir)
        # An agent that turns model roles off may choose its own models.
        with tempfile.TemporaryDirectory() as tmp:
            own = self.render(None, config_dir=overlay_copy(
                tmp, "defaults:\n  model-roles: false\nvalues:\n  model.provider: claude-acp\n  model.default: sonnet\n"))
        self.assertEqual(own.leaves["model.provider"], "claude-acp")

    def test_docs_show_the_one_line_switch(self) -> None:
        guide = (ROOT / "docs" / "choose-your-plans.md").read_text(encoding="utf-8")
        self.assertIn("primary_plan: chatgpt", guide)
        for plan in ("claude", "chatgpt", "grok"):
            self.assertIn(f"`{plan}`", guide)
        for provider in ("openai-codex", "xai-oauth"):
            self.assertIn(f"hermes auth add {provider} --type oauth", guide)
        defaults = (FLEET_CONFIG / "defaults.yaml").read_text(encoding="utf-8")
        self.assertIn("    primary_plan: claude\n", defaults)


def _hermes_core() -> tuple[str, str] | None:
    """(interpreter, PYTHONPATH) for a Hermes Agent install, when one is present.

    HERMES_AGENT_SOURCE names a checkout or install root; the Fleet image's own
    install at /opt/hermes is used otherwise. CI source checks have neither.
    """
    for base in filter(None, (os.environ.get("HERMES_AGENT_SOURCE"), "/opt/hermes")):
        root = Path(base)
        if (root / "hermes_cli" / "config.py").is_file():
            venv = root / ".venv" / "bin" / "python"
            interpreter = str(venv) if venv.is_file() else sys.executable
            site = sorted((root / ".venv" / "lib").glob("python3*/site-packages"))
            return interpreter, os.pathsep.join([str(root)] + [str(s) for s in site])
    return None


# Hermes' own checks, run inside its interpreter: config structure, the
# fallback-chain readers for main and delegation, the provider registry,
# the model catalogue and the auxiliary task table.
HERMES_PROBE = r"""
import json, sys
from hermes_cli.config import validate_config_structure
from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_cli.fallback_config import get_fallback_chain, scoped_fallback_chain
from hermes_cli.providers import normalize_provider
from hermes_cli.auth import PROVIDER_REGISTRY
from hermes_cli.models_catalog_static import _PROVIDER_MODELS
config, roles = json.load(sys.stdin)
issues = [i.message for i in validate_config_structure(config) if i.severity == "error"]
problems = list(issues)
if get_fallback_chain(config) != config.get("fallback_providers", []):
    problems.append("main fallback chain changed by Hermes")
delegation = config.get("delegation", {})
if delegation.get("fallback_providers") and scoped_fallback_chain(
        [], delegation["fallback_providers"], pinned=True, owner="delegation") != delegation["fallback_providers"]:
    problems.append("delegation fallback chain changed by Hermes")
for task in roles["auxiliary"]:
    block = DEFAULT_CONFIG["auxiliary"].get(task)
    if not isinstance(block, dict) or "provider" not in block or "model" not in block:
        problems.append(f"auxiliary.{task} is not a Hermes task")
for key in ("provider", "model", "fallback_providers"):
    if key not in DEFAULT_CONFIG["delegation"]:
        problems.append(f"delegation.{key} is not a Hermes setting")
for provider, model in roles["routes"]:
    if normalize_provider(provider) != provider:
        problems.append(f"{provider} is an alias, not a canonical provider id")
    if provider in ("openai-codex", "xai-oauth"):
        if provider not in PROVIDER_REGISTRY or PROVIDER_REGISTRY[provider].auth_type == "api_key":
            problems.append(f"{provider} is not a Hermes OAuth provider")
        if model not in _PROVIDER_MODELS.get(provider, []):
            problems.append(f"{model} is not in Hermes' {provider} catalogue")
print(json.dumps(problems))
"""


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
@unittest.skipUnless(_hermes_core(), "needs a Hermes Agent install (set HERMES_AGENT_SOURCE)")
class RenderedRolesPassHermesValidationTests(unittest.TestCase):
    """The rendered model roles pass Hermes core's own provider config checks."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _load("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")

    def test_every_plan_leading_every_role_passes(self) -> None:
        core = _hermes_core()
        assert core is not None
        interpreter, pythonpath = core
        for plan in self.sd.PLANS:
            with self.subTest(primary_plan=plan), tempfile.TemporaryDirectory() as tmp:
                body = f"primary_plan: {plan}\nroles:\n" + "".join(f"  {r}: {plan}\n" for r in OTHER_ROLES)
                root = fixture.full_container_root(Path(tmp), CLAUDE_ENV, plans=ALL_PLANS)
                paths = self.sd.ContainerPaths(root=root, hermes_home="/opt/data")
                rendered = self.sd.render(overlay_copy(tmp, body + "values: {}\n"), "ops",
                                          self.sd.env_names(CLAUDE_ENV), CONTRACT, environ=CLAUDE_ENV, paths=paths)
                routes = sorted({(m["provider"], m["model"]) for role in self.sd.ROLES
                                 for m in self.sd.role_route(rendered.config, role)})
                self.assertIn(("openai-codex", "gpt-6-sol"), routes)
                self.assertIn(("xai-oauth", "grok-4.6"), routes)
                home = Path(tmp) / "hermes-home"
                home.mkdir()
                env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "HERMES_HOME": str(home),
                       "PYTHONPATH": pythonpath, "PYTHONNOUSERSITE": "1"}
                result = subprocess.run([interpreter, "-c", HERMES_PROBE], input=json.dumps(
                    [rendered.config, {"auxiliary": sorted({t.split(".")[1] for r in self.sd.ROLES
                                                             for t, _, _ in self.sd.ROLE_TARGETS[r]
                                                             if t.startswith("auxiliary.")}),
                                       "routes": routes}]),
                    text=True, capture_output=True, check=False, timeout=180, env=env, cwd=tmp)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]), [])


if __name__ == "__main__":
    unittest.main()
