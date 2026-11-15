from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "Dockerfile"
VERIFY = ROOT / "scripts" / "verify-public-tree.py"
SCOPE = ROOT / "scripts" / "fleet-image-change-scope.py"
WORKFLOW = ROOT / ".github" / "workflows" / "fleet-image.yml"
PLUGINS = ROOT / "contracts" / "plugins.json"


class PublicKeepsPrivateBinariesOutTests(unittest.TestCase):
    def test_webkite_binary_is_absent(self) -> None:
        self.assertFalse((ROOT / "third_party" / "webkite-0.5.0-linux-amd64").exists())
        self.assertFalse((ROOT / "plugins" / "web" / "webkite").exists())
        self.assertFalse((ROOT / "docs" / "webkite.md").exists())
        self.assertFalse((ROOT / "tests" / "test_webkite_provider.py").exists())

    def test_dockerfile_and_release_omit_webkite(self) -> None:
        dockerfile = DOCKERFILE.read_text(encoding="utf-8").lower()
        workflow = WORKFLOW.read_text(encoding="utf-8").lower()
        scope = SCOPE.read_text(encoding="utf-8")
        verifier = VERIFY.read_text(encoding="utf-8")
        self.assertNotIn("webkite", dockerfile)
        self.assertNotIn("webkite", workflow)
        self.assertNotIn("webkite", scope.lower())
        self.assertNotIn("webkite", verifier.lower())
        self.assertNotIn("third_party/webkite", scope)
        contract = json.loads(PLUGINS.read_text(encoding="utf-8"))
        self.assertFalse(
            any(item["id"] == "webkite-web-provider" for item in contract["components"])
        )

    def test_readme_and_agents_describe_public_product(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertTrue((ROOT / "AGENTS.md").is_file())
        self.assertIn("# Switchroom", readme)
        self.assertIn("opinionated Hermes Agent distribution", readme)
        self.assertIn("AGENTS.md", readme)
        self.assertNotIn("webkite", readme.lower())
        self.assertNotIn("webkite", agents.lower())
        self.assertIn("private binaries", agents.lower())
        self.assertIn("immutable", readme.lower())
