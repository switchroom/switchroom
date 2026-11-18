"""The Honcho plugin import repoint is exact, fails closed, and runs before the core-seam check."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("patch_honcho_core_imports", ROOT / "scripts" / "patch-honcho-core-imports.py")
patcher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(patcher)

INIT = "import re\nfrom agent.skill_commands import extract_user_instruction_from_skill_message\nX = 1\n"
CLIENT = ("import json\nfrom hermes_state_common import TITLE_SOURCE_DERIVED, TITLE_SOURCE_LLM\n"
          "_AUTO = frozenset({TITLE_SOURCE_DERIVED, TITLE_SOURCE_LLM})\n")


def _plugin(tmp: Path, init: str = INIT, client: str = CLIENT) -> Path:
    plugin = tmp / "honcho"
    plugin.mkdir()
    (plugin / "__init__.py").write_text(init, encoding="utf-8")
    (plugin / "client.py").write_text(client, encoding="utf-8")
    return plugin


class HonchoCoreImportPatch(unittest.TestCase):
    def test_both_imports_move_to_their_current_homes(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = _plugin(Path(tmp))
            patcher.patch(plugin)
            init = (plugin / "__init__.py").read_text(encoding="utf-8")
            client = (plugin / "client.py").read_text(encoding="utf-8")
        self.assertIn("from session_rules.turns import extract_user_instruction_from_skill_message\n", init)
        self.assertNotIn("agent.skill_commands", init)
        self.assertIn("from persistence.conversation.sessions import TitleSource\n", client)
        self.assertNotIn("hermes_state_common", client)
        self.assertTrue(init.endswith("X = 1\n") and client.endswith("TITLE_SOURCE_LLM})\n"))

    def test_the_title_sources_keep_their_string_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = _plugin(Path(tmp))
            patcher.patch(plugin)
            line = (plugin / "client.py").read_text(encoding="utf-8").splitlines()[2]
        namespace = {"TitleSource": type("TitleSource", (), {
            "DERIVED": type("V", (), {"value": "derived"}), "LLM": type("V", (), {"value": "llm"})})}
        exec(line, namespace)
        self.assertEqual((namespace["TITLE_SOURCE_DERIVED"], namespace["TITLE_SOURCE_LLM"]), ("derived", "llm"))

    def test_a_pin_that_already_changed_the_import_stops_the_bake(self):
        for init, client in ((INIT.replace("agent.skill_commands", "session_rules.turns"), CLIENT),
                             (INIT, CLIENT.replace("hermes_state_common", "somewhere_else"))):
            with tempfile.TemporaryDirectory() as tmp:
                plugin = _plugin(Path(tmp), init, client)
                with self.assertRaises(SystemExit):
                    patcher.patch(plugin)

    def test_dockerfile_repoints_before_the_seam_check(self):
        text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertLess(text.index("patch-honcho-core-imports.py /opt/hermes/plugins/memory/honcho"),
                        text.index("verify-honcho-plugin-core-seams.py /opt/hermes/plugins/memory/honcho /opt/hermes"))


if __name__ == "__main__":
    unittest.main()
