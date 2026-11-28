"""Overlay renderer: mixed-type leaves, typed dicts, nulls, per-agent secret
references, preserved and removed leaves, and where routing leaves may be set.

Every overlay here is synthetic (profile ``example-agent``, team ``ENG``).
"""
from __future__ import annotations

import importlib.util
import json
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

try:
    import yaml  # noqa: F401
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False

AGENT = "example-agent"
SECRET = "synthetic-SECRET-token-value-123"
# Extra schema leaves these tests declare (the starter schema stays minimal).
EXTRA_SCHEMA = """\
  display.platforms.chat.tool_progress: bool|str
  linear_like.team_states: dict[str|null]
  headers_like.counts: dict[int]
  headers_like.flags: dict[bool|str]
  mcp_servers.example: dict
  headers_like.name: str
"""


def _module():
    spec = importlib.util.spec_from_file_location("switchroom_defaults", SCRIPTS / "switchroom_defaults.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("switchroom_defaults", module)
    spec.loader.exec_module(module)
    return module


def overlay(tmp: str, agent_body: str, *, defaults_append: str = "", schema_extra: str = EXTRA_SCHEMA,
            values_extra: str = "") -> Path:
    config_dir = Path(tempfile.mkdtemp(dir=tmp)) / "fleet-config"
    shutil.copytree(FLEET_CONFIG, config_dir)
    (config_dir / "agents" / "ops.yaml").unlink()
    (config_dir / "agents" / "worker.yaml").unlink()
    schema = config_dir / "schema.yaml"
    schema.write_text(schema.read_text(encoding="utf-8").rstrip("\n") + "\n" + schema_extra, encoding="utf-8")
    defaults = config_dir / "defaults.yaml"
    text = defaults.read_text(encoding="utf-8")
    if values_extra:
        text = text.replace("values:\n  prompt_caching", "values:\n" + values_extra + "  prompt_caching", 1)
    defaults.write_text(text + defaults_append, encoding="utf-8")
    (config_dir / "agents" / f"{AGENT}.yaml").write_text(
        f"profile: {AGENT}\nrole: operator\napply_mode: merge\n" + agent_body, encoding="utf-8")
    return config_dir


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class OverlayRendererGapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sd = _module()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name

    def render(self, body: str, env: dict | None = None, *, check_refs: bool = True, **kwargs):
        env = env or {}
        config_dir = overlay(self.tmp, body, **kwargs)
        return self.sd.render(config_dir, AGENT, self.sd.env_names(env), CONTRACT, environ=env,
                              verify_agent_refs=check_refs)

    def rejects(self, body: str, message: str, **kwargs) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = overlay(tmp, body, **kwargs)
            with self.assertRaisesRegex(self.sd.DefaultsError, message):
                self.sd.render(config_dir, AGENT, frozenset(), CONTRACT, environ={})

    # ------------------------------------------------------------ G1
    def test_mixed_bool_or_str_leaf(self) -> None:
        for value, literal in ((True, "true"), (False, "false"), ("all", "all")):
            with self.subTest(value=value):
                rendered = self.render(f"values:\n  display.platforms.chat.tool_progress: {literal}\n")
                self.assertEqual(rendered.config["display"]["platforms"]["chat"]["tool_progress"], value)
        self.rejects("values:\n  display.platforms.chat.tool_progress: 3\n", "type mismatch")
        self.rejects("values:\n  display.platforms.chat.tool_progress: [a]\n", "type mismatch")

    def test_typed_dict_leaves(self) -> None:
        rendered = self.render(
            "values:\n  headers_like.counts: {a: 1, b: 2}\n  headers_like.flags: {x: true, y: text}\n")
        self.assertEqual(rendered.config["headers_like"]["counts"], {"a": 1, "b": 2})
        self.assertEqual(rendered.config["headers_like"]["flags"], {"x": True, "y": "text"})
        self.rejects("values:\n  headers_like.counts: {a: one}\n", "expected dict\\[int\\]")
        self.rejects("values:\n  headers_like.counts: {a: true}\n", "expected dict\\[int\\]")
        self.rejects("values:\n  headers_like.flags: {x: 1}\n", "expected dict\\[bool\\|str\\]")
        self.rejects("values:\n  headers_like.counts: [1]\n", "expected dict\\[int\\]")
        # A typed dict without |null still refuses nulls.
        self.rejects("values:\n  headers_like.counts: {a: null}\n", "expected dict\\[int\\]")

    def test_schema_rejects_unknown_type_names(self) -> None:
        for bad in ("dict[float]", "dict[]", "dict[str|nul]", "bool|int", "dict[dict]"):
            with self.subTest(kind=bad), tempfile.TemporaryDirectory() as tmp:
                config_dir = overlay(tmp, "values: {}\n", schema_extra=f"  headers_like.bad: '{bad}'\n")
                with self.assertRaisesRegex(self.sd.DefaultsError, "unsupported type"):
                    self.sd.load_schema(config_dir)

    def test_unknown_leaves_are_still_rejected(self) -> None:
        self.rejects("values:\n  headers_like.undeclared: 1\n", "unknown leaf")
        # A typed dict leaf allows nested keys under it, but not a sibling leaf.
        self.rejects("values:\n  linear_like.team_states.ENG: {blocked: null}\n", "unknown leaf")

    # ------------------------------------------------------------ G2
    def test_null_inside_a_nullable_dict_leaf(self) -> None:
        rendered = self.render("values:\n  linear_like.team_states:\n    ENG: {blocked: null, started: In Progress}\n")
        self.assertEqual(rendered.config["linear_like"]["team_states"],
                         {"ENG": {"blocked": None, "started": "In Progress"}})
        text = self.sd.dump_config(rendered)
        self.assertEqual(self.sd.load_yaml(_write(self.tmp, text))["linear_like"]["team_states"]["ENG"]["blocked"], None)

    def test_nulls_stay_rejected_everywhere_else(self) -> None:
        self.rejects("values:\n  linear_like.team_states: null\n", "null is ambiguous")
        self.rejects("values:\n  headers_like.name: null\n", "null is ambiguous")
        self.rejects("values:\n  mcp_servers.example: {a: null}\n", "expected dict")
        self.rejects("values:\n  linear_like.team_states: {ENG: {blocked: 3}}\n", "expected dict\\[str\\|null\\]")

    # ------------------------------------------------------------ G3
    REF_BODY = ("values:\n  mcp_servers.example:\n    url: https://mcp.example.test/mcp\n"
                "    headers:\n      Authorization: Bearer ${EXAMPLE_MCP_TOKEN}\n")

    def test_agent_secret_reference_passes_through_unresolved(self) -> None:
        env = {"EXAMPLE_MCP_TOKEN": SECRET}
        rendered = self.render(self.REF_BODY, env)
        header = rendered.config["mcp_servers"]["example"]["headers"]["Authorization"]
        self.assertEqual(header, "Bearer ${EXAMPLE_MCP_TOKEN}")
        everything = self.sd.dump_config(rendered) + json.dumps(rendered.provenance) + "\n".join(rendered.report_lines())
        self.assertNotIn(SECRET, everything)

    def test_unset_agent_reference_fails_by_name_only(self) -> None:
        with self.assertRaises(self.sd.DefaultsError) as caught:
            self.render(self.REF_BODY, {"OTHER_VARIABLE": SECRET})
        self.assertIn("EXAMPLE_MCP_TOKEN", str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))
        # An empty value counts as unset.
        with self.assertRaises(self.sd.DefaultsError):
            self.render(self.REF_BODY, {"EXAMPLE_MCP_TOKEN": "  "})

    def test_reference_is_unchecked_without_an_environment_view(self) -> None:
        rendered = self.render(self.REF_BODY, {}, check_refs=False)
        self.assertEqual(rendered.config["mcp_servers"]["example"]["headers"]["Authorization"],
                         "Bearer ${EXAMPLE_MCP_TOKEN}")

    def test_malformed_references_are_rejected(self) -> None:
        for ref in ("${lower_case}", "${}", "${A B}", "${env:bad-name}"):
            with self.subTest(ref=ref):
                self.rejects(f"values:\n  headers_like.name: 'x {ref}'\n", "invalid variable name")

    def test_shared_values_still_may_not_reference_variables(self) -> None:
        self.rejects("values: {}\n", "must not reference environment variables",
                     values_extra="  headers_like.name: ${EXAMPLE_MCP_TOKEN}\n")

    def test_cli_verifies_names_only(self) -> None:
        config_dir = overlay(self.tmp, self.REF_BODY)
        env_file = Path(self.tmp) / "agent.env"
        env_file.write_text(f"EXAMPLE_MCP_TOKEN={SECRET}\n", encoding="utf-8")
        base = [sys.executable, str(RENDER), "--fleet-config", str(config_dir), "--agent", AGENT, "--report"]

        def run(*extra: str) -> subprocess.CompletedProcess:
            return subprocess.run([*base, *extra], cwd=ROOT, text=True, capture_output=True, check=False, timeout=60)

        ok = run("--env-file", str(env_file))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("Bearer ${EXAMPLE_MCP_TOKEN}", ok.stdout)
        self.assertNotIn(SECRET, ok.stdout + ok.stderr)
        # An environment view without the variable: fail by name, no value anywhere.
        empty = Path(self.tmp) / "empty.env"
        empty.write_text(f"OTHER_VARIABLE={SECRET}\n", encoding="utf-8")
        missing = run("--env-file", str(empty))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("EXAMPLE_MCP_TOKEN", missing.stderr)
        self.assertNotIn(SECRET, missing.stdout + missing.stderr)
        # No environment view at all (a plain host render): nothing to verify against.
        blind = run()
        self.assertEqual(blind.returncode, 0, blind.stderr)
        self.assertIn("${EXAMPLE_MCP_TOKEN}", blind.stdout)

    # ------------------------------------------------------------ G4
    def test_preserve_runtime_leaves_are_left_out_of_the_managed_file(self) -> None:
        plain = self.render("values: {}\n")
        self.assertIn("terminal.cwd", plain.leaves)
        kept = self.render("preserve_runtime_leaves: [terminal.cwd, web.use_gateway]\nvalues: {}\n")
        self.assertNotIn("terminal.cwd", kept.leaves)
        self.assertNotIn("terminal", kept.config)
        self.assertNotIn("terminal.cwd", kept.provenance)
        self.assertNotIn("web", kept.config)
        self.assertEqual(kept.preserved, ["terminal.cwd", "web.use_gateway"])
        self.assertIn("preserved (left to the agent's own config.yaml): terminal.cwd, web.use_gateway",
                      kept.report_lines())
        # Everything else is untouched.
        self.assertEqual({k: v for k, v in plain.leaves.items() if k not in kept.preserved}, kept.leaves)

    def test_preserve_runtime_leaves_validation(self) -> None:
        self.rejects("preserve_runtime_leaves: [no.such.leaf]\nvalues: {}\n", "unknown leaf")
        self.rejects("preserve_runtime_leaves: [terminal.cwd, terminal.cwd]\nvalues: {}\n", "unique")
        self.rejects("preserve_runtime_leaves: terminal.cwd\nvalues: {}\n", "list of unique")
        self.rejects("preserve_runtime_leaves: [terminal.cwd]\nvalues:\n  terminal.cwd: /tmp\n", "also set in values")

    def test_preserving_cannot_hide_a_disk_cleanup_hazard(self) -> None:
        # Dropping the report_only setting while the plugin is on must still be refused.
        self.rejects("preserve_runtime_leaves: [plugins.config.disk-cleanup]\nvalues: {}\n", "report_only")

    def test_remove_leaves_are_absent_fleet_wide(self) -> None:
        plain = self.render("values: {}\n")
        self.assertIn("agent.system_prompt", plain.leaves)
        rendered = self.render("values: {}\n", defaults_append="remove_leaves: [agent.system_prompt]\n")
        self.assertNotIn("system_prompt", rendered.config.get("agent", {}))
        self.assertNotIn("agent.system_prompt", rendered.provenance)
        self.assertEqual(rendered.removed, ["agent.system_prompt"])
        self.assertIn("removed (intentionally absent fleet-wide): agent.system_prompt", rendered.report_lines())
        self.assertEqual({k: v for k, v in plain.leaves.items() if k != "agent.system_prompt"}, rendered.leaves)

    def test_remove_leaves_validation(self) -> None:
        self.rejects("values: {}\n", "unknown leaf", defaults_append="remove_leaves: [no.such.leaf]\n")
        self.rejects("values: {}\n", "unique", defaults_append="remove_leaves: [terminal.cwd, terminal.cwd]\n")
        # A leaf cannot be both set in shared or agent values and intentionally absent.
        self.rejects("values: {}\n", "remove_leaves: terminal.cwd is also set",
                     defaults_append="remove_leaves: [terminal.cwd]\n")
        self.rejects("values:\n  agent.system_prompt: hello\n", "listed in remove_leaves",
                     defaults_append="remove_leaves: [agent.system_prompt]\n")
        self.rejects("preserve_runtime_leaves: [agent.system_prompt]\nvalues: {}\n", "already in remove_leaves",
                     defaults_append="remove_leaves: [agent.system_prompt]\n")

    # ------------------------------------------------------------ G6
    def test_shared_values_may_not_set_routing_or_plugin_leaves(self) -> None:
        for leaf, value in (("model.provider", "claude-acp"), ("delegation.model", "x"),
                            ("plugins.enabled", "[linear]")):
            with self.subTest(leaf=leaf):
                self.rejects("values: {}\n", "built by the renderer; do not set it here.*agent's own values",
                             values_extra=f"  {leaf}: {value}\n")

    def test_plugins_enabled_is_set_per_agent_and_replaces_the_default_list(self) -> None:
        default = self.render("values: {}\n")
        self.assertTrue(len(default.config["plugins"]["enabled"]) > 1)
        own = self.render("values:\n  plugins.enabled: [quota]\n")
        self.assertEqual(own.config["plugins"]["enabled"], ["quota"])
        self.assertEqual(own.provenance["plugins.enabled"], f"agents/{AGENT}.yaml")

    def test_routing_leaves_are_set_per_agent_with_model_roles_off(self) -> None:
        own = self.render("defaults:\n  model-roles: false\nvalues:\n  model.provider: claude-acp\n"
                          "  model.default: sonnet\n")
        self.assertEqual(own.config["model"], {"default": "sonnet", "provider": "claude-acp"})
        self.assertEqual(own.provenance["model.provider"], f"agents/{AGENT}.yaml")
        # With model roles on, the renderer owns them.
        self.rejects("values:\n  model.provider: claude-acp\n", "routed with primary_plan")

    def test_no_model_or_paid_path_by_default(self) -> None:
        # Nothing set and no credentials: no role routes anywhere and no plugin is enabled.
        rendered = self.render("values: {}\n")
        self.assertEqual(self.sd.rendered_role_providers(rendered.config), [])
        for plugin in ("claude-subscription-directsdk-experimental", "claude-acp-provider", "web-perplexity",
                       "kokoro-voice", "linear"):
            self.assertNotIn(plugin, rendered.config["plugins"]["enabled"])


def _write(tmp: str, text: str) -> Path:
    path = Path(tmp) / "rendered.yaml"
    path.write_text(text, encoding="utf-8")
    return path


if __name__ == "__main__":
    unittest.main()
