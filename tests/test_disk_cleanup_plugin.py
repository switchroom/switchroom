"""The published disk-cleanup plugin and the starter overlay's report-only default.

plugins/disk-cleanup is copied byte-for-byte from the Hermes Agent revision
the Fleet image is built on (UPSTREAM.json). The starter overlay renders
``plugins.config.disk-cleanup.session_end_mode: report_only``; these tests run
that rendered config through the plugin's own mode reader and its session-end
hook, and prove nothing is deleted.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "disk-cleanup"
FLEET_CONFIG = ROOT / "examples" / "overlay-repo" / "fleet-config"
CONTRACT = ROOT / "contracts" / "plugins.json"
AGENT_MANIFEST = ROOT / "release" / "agent-image-manifest.json"

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False


def _defaults_module():
    spec = importlib.util.spec_from_file_location("switchroom_defaults", ROOT / "scripts" / "switchroom_defaults.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("switchroom_defaults", module)
    spec.loader.exec_module(module)
    return module


def _deep_merge(base: dict, overlay: dict) -> dict:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


class UpstreamProvenanceTests(unittest.TestCase):
    def test_files_match_the_recorded_upstream_hashes(self) -> None:
        upstream = json.loads((PLUGIN / "UPSTREAM.json").read_text(encoding="utf-8"))
        for name, digest in upstream["files_sha256"].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((PLUGIN / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(sorted(p.name for p in PLUGIN.iterdir()),
                         sorted([*upstream["files_sha256"], "UPSTREAM.json", upstream["license_file"]]))

    def test_licence_and_attribution_are_kept(self) -> None:
        upstream = json.loads((PLUGIN / "UPSTREAM.json").read_text(encoding="utf-8"))
        licence = (PLUGIN / upstream["license_file"]).read_bytes()
        self.assertEqual(upstream["license"], "MIT")
        self.assertEqual(hashlib.sha256(licence).hexdigest(), upstream["license_sha256"])
        self.assertTrue(licence.startswith(b"MIT License"))
        manifest = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("@LVT382009 (original), NousResearch (plugin port)", manifest)

    def test_source_is_the_agent_revision_the_image_is_built_on(self) -> None:
        upstream = json.loads((PLUGIN / "UPSTREAM.json").read_text(encoding="utf-8"))
        agent = json.loads(AGENT_MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(upstream["commit"], agent["revision"])
        self.assertEqual(upstream["repository"], "https://github.com/mekenthompson/hermes-agent.git")


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for overlay YAML")
class ReportOnlyDefaultTests(unittest.TestCase):
    """Load the plugin against a fake Hermes home and the rendered starter config."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.managed_dir = Path(self.tmp.name) / "managed"
        self.managed_dir.mkdir()
        sd = _defaults_module()
        rendered = sd.render(FLEET_CONFIG, "ops", frozenset(), CONTRACT)
        self.assertIn("disk-cleanup", rendered.leaves["plugins.enabled"])
        self.rendered = rendered.config
        self.write_managed(self.rendered)
        self.modules = mock.patch.dict(sys.modules, self.stub_modules())
        self.modules.start()
        self.plugin = self.load_plugin()

    def tearDown(self) -> None:
        self.modules.stop()
        self.tmp.cleanup()

    def write_managed(self, config: dict) -> None:
        (self.managed_dir / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")

    def stub_modules(self) -> dict:
        home, managed_dir = self.home, self.managed_dir

        def read_doc(path):
            path = Path(path)
            if not path.exists():
                raise FileNotFoundError(path)
            return yaml.safe_load(path.read_text(encoding="utf-8"))

        def load_config_readonly():
            user = home / "config.yaml"
            base = read_doc(user) if user.exists() else {}
            return _deep_merge(base or {}, read_doc(managed_dir / "config.yaml") or {})

        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: home
        cli = types.ModuleType("hermes_cli")
        cli.__path__ = []
        config = types.ModuleType("hermes_cli.config")
        config.get_config_path = lambda: home / "config.yaml"
        config.load_config_readonly = load_config_readonly
        backend = types.ModuleType("hermes_cli.config_backend")
        backend.read_config_doc_readonly = read_doc
        scope = types.ModuleType("hermes_cli.managed_scope")
        scope.get_managed_dir = lambda: managed_dir
        return {"hermes_constants": constants, "hermes_cli": cli, "hermes_cli.config": config,
                "hermes_cli.config_backend": backend, "hermes_cli.managed_scope": scope}

    def load_plugin(self):
        name = "disk_cleanup_under_test"
        spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py",
                                                      submodule_search_locations=[str(PLUGIN)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    def create_tracked_test_file(self) -> Path:
        target = self.home / "test_scratch_probe.py"
        args = {"path": str(target)}
        self.plugin._on_pre_tool_call(tool_name="write_file", args=args, task_id="task", tool_call_id="call-1")
        target.write_text("print('probe')\n", encoding="utf-8")
        self.plugin._on_post_tool_call(tool_name="write_file", args=args, task_id="task", tool_call_id="call-1")
        return target

    def test_plugin_reads_report_only_from_the_rendered_config(self) -> None:
        self.assertEqual(self.plugin._session_end_mode(), "report_only")

    def test_session_end_reports_and_never_deletes(self) -> None:
        target = self.create_tracked_test_file()
        with mock.patch.object(self.plugin.dg, "quick", side_effect=AssertionError("quick must not run")), \
                mock.patch.object(self.plugin.dg, "_delete_item", side_effect=AssertionError("no deletion")):
            report = self.plugin._on_session_end(session_id="task")
        self.assertEqual(report["mode"], "report_only")
        self.assertEqual(report["auto_candidates"], 1)
        self.assertTrue(target.exists())

    def test_without_the_rendered_mode_the_plugin_would_delete(self) -> None:
        # Why the renderer and setup check insist on report_only: an enabled
        # plugin with no mode falls back to cleanup and removes the file.
        config = json.loads(json.dumps(self.rendered))
        del config["plugins"]["config"]
        self.write_managed(config)
        self.assertEqual(self.plugin._session_end_mode(), "cleanup")
        target = self.create_tracked_test_file()
        self.plugin._on_session_end(session_id="task")
        self.assertFalse(target.exists())

    def test_register_wires_hooks_and_the_operator_command(self) -> None:
        ctx = mock.Mock()
        self.plugin.register(ctx)
        hooks = {call.args[0] for call in ctx.register_hook.call_args_list}
        self.assertEqual(hooks, {"pre_tool_call", "post_tool_call", "on_session_end"})
        # The only deleting paths left are an operator typing /disk-cleanup
        # quick or deep; no tool is registered for the model to call.
        ctx.register_tool.assert_not_called()
        self.assertEqual(ctx.register_command.call_args.args[0], "disk-cleanup")


if __name__ == "__main__":
    unittest.main()
