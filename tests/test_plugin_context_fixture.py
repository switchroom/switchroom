"""The plugin-context fixture really enforces core's settings-key contract (HF-793).

Three guards:

* the fixture's key table behaves as core documents it, whichever validator it picked;
* when ``hermes_cli`` is importable, the vendored copy and the real validator agree on every key,
  so the copy cannot drift in an environment that has core;
* every literal key a public plugin passes to ``get_config`` / ``set_config`` is valid, so the
  failure mode that kept Aggie's connectors from loading cannot recur through another plugin.
"""

from __future__ import annotations

import ast
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_fixture():
    spec = importlib.util.spec_from_file_location("plugin_context_fixture", ROOT / "tests" / "plugin_context_fixture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = _load_fixture()

VALID = ("enabled", "worker_model", "timeout", "retry.policy", "a", "A-b_c", "x" * 128, "api_url", "chat_guard")
INVALID = (
    "", ".", "model", "Model", "MODEL.name", "model.name", "plugins", "plugins.entries.other.settings.enabled",
    "security", "security.level", "settings", "settings.enabled",
    "a/b", "a\\b", "../x", "a..b", ".a", "a.", "-a", "_a", "a b", "x" * 129, "é",
    None, 1, b"model", ("a",),
)
# Reserved roots are only reserved at the root: a nested segment named model is a normal key.
NESTED_OK = ("retry.model", "limits.plugins", "a.settings")


class FixtureContractTests(unittest.TestCase):
    def test_valid_keys_are_accepted(self) -> None:
        for key in VALID + NESTED_OK:
            with self.subTest(key=key):
                self.assertEqual(fixture.plugin_relative_segments(key), tuple(key.split(".")))

    def test_invalid_keys_are_rejected(self) -> None:
        for key in INVALID:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    fixture.plugin_relative_segments(key)

    def test_vendored_copy_alone_enforces_the_same_table(self) -> None:
        for key in VALID + NESTED_OK:
            with self.subTest(valid=key):
                fixture._vendored_relative_segments(key)
        for key in INVALID:
            with self.subTest(invalid=key):
                with self.assertRaises(ValueError):
                    fixture._vendored_relative_segments(key)

    @unittest.skipIf(fixture.REAL_RELATIVE_SEGMENTS is None, "hermes_cli is not importable here; the vendored copy is the contract")
    def test_vendored_copy_agrees_with_the_real_core_validator(self) -> None:
        real = fixture.REAL_RELATIVE_SEGMENTS
        self.assertEqual(fixture.VALIDATOR_SOURCE, "hermes_cli")
        for key in VALID + NESTED_OK + INVALID:
            with self.subTest(key=key):
                try:
                    expected = ("ok", real(key))
                except ValueError:
                    expected = ("rejected", None)
                try:
                    actual = ("ok", fixture._vendored_relative_segments(key))
                except ValueError:
                    actual = ("rejected", None)
                self.assertEqual(actual, expected)
        from hermes_cli import plugins_state
        self.assertEqual(fixture._PLUGIN_SETTING_RESERVED_ROOTS, plugins_state._PLUGIN_SETTING_RESERVED_ROOTS)
        self.assertEqual(fixture._PLUGIN_SETTING_SEGMENT_RE.pattern, plugins_state._PLUGIN_SETTING_SEGMENT_RE.pattern)

    def test_the_context_reads_settings_then_the_legacy_subtree_and_records_rejections(self) -> None:
        context = fixture.RealContractContext(
            "demo", {"enabled": True, "retry": {"policy": "fast"}}, legacy_config={"old": 1, "enabled": False})
        self.assertIs(context.get_config("enabled"), True)  # settings win over the legacy subtree
        self.assertEqual(context.get_config("retry.policy"), "fast")
        self.assertEqual(context.get_config("old"), 1)
        self.assertEqual(context.get_config("missing", "dflt"), "dflt")
        self.assertEqual(context.get_config("retry.missing", 7), 7)
        with self.assertRaises(ValueError):
            context.get_config("model", "sonnet")  # the HF-793 call: a default must not rescue it
        self.assertEqual(context.rejected, ["model"])

    def test_register_tool_records_and_refuses_malformed_or_duplicate_tools(self) -> None:
        context = fixture.RealContractContext("demo")
        handler = lambda args, **kwargs: "{}"  # noqa: E731
        context.register_tool(name="t", toolset="ts", schema={"type": "object"}, handler=handler)
        self.assertEqual(context.tools["t"]["toolset"], "ts")
        with self.assertRaises(ValueError):
            context.register_tool(name="t", toolset="ts", schema={"type": "object"}, handler=handler)
        with self.assertRaises(ValueError):
            context.register_tool(name="u", toolset="", schema={"type": "object"}, handler=handler)
        with self.assertRaises(ValueError):
            context.register_tool(name="v", toolset="ts", schema={"type": "object"}, handler=None)


class PublicPluginKeyTests(unittest.TestCase):
    """Static guard: literal settings keys in public plugin source are valid under core's contract."""

    SKIP_PARTS = {"tests", "evals", "__pycache__", "node_modules"}

    def literal_keys(self):
        for path in sorted((ROOT / "plugins").rglob("*.py")):
            if self.SKIP_PARTS & set(path.relative_to(ROOT / "plugins").parts):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in {"get_config", "set_config"}
                        and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                    yield path.relative_to(ROOT), node.lineno, node.args[0].value

    def test_every_literal_plugin_settings_key_is_valid_for_core(self) -> None:
        seen = list(self.literal_keys())
        self.assertTrue(seen, "the scan found no get_config calls; the guard is not looking at the plugins")
        self.assertIn("worker_model", {key for _, _, key in seen})
        for path, line, key in seen:
            with self.subTest(path=str(path), line=line, key=key):
                fixture.plugin_relative_segments(key)

    def test_the_guard_catches_the_regression_it_exists_for(self) -> None:
        tree = ast.parse("ctx.get_config('model', 'sonnet')")
        call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call))
        with self.assertRaises(ValueError):
            fixture.plugin_relative_segments(call.args[0].value)


if __name__ == "__main__":
    unittest.main()
