from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "examples" / "overlay-repo"
DOCS = ROOT / "docs" / "overlay-repository.md"


class OverlayRepositoryExampleTests(unittest.TestCase):
    def test_required_overlay_files_exist(self) -> None:
        for relative in (
            "README.md",
            "compose.yaml",
            ".gitignore",
            "fleet-config/schema.yaml",
            "fleet-config/defaults.yaml",
            "fleet-config/agents/ops.yaml",
            "fleet-config/agents/worker.yaml",
            "managed/ops.yaml",
        ):
            with self.subTest(relative=relative):
                self.assertTrue((OVERLAY / relative).is_file(), relative)

    def test_docs_and_readme_point_at_the_overlay_example(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8").lower()
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8").lower()
        docs = DOCS.read_text(encoding="utf-8").lower()
        self.assertTrue(DOCS.is_file())
        self.assertIn("examples/overlay-repo", readme)
        self.assertIn("overlay-repository.md", readme)
        self.assertIn("examples/overlay-repo", agents)
        self.assertIn("fleet-config/defaults.yaml", docs)
        self.assertIn("per-agent", docs)
        self.assertIn("private binaries", docs)

    def test_overlay_example_has_no_household_or_secret_material(self) -> None:
        files = [DOCS, ROOT / "README.md", ROOT / "AGENTS.md"]
        files.extend(path for path in OVERLAY.rglob("*") if path.is_file())
        blob = "\n".join(path.read_text(encoding="utf-8").lower() for path in files)
        # Switchroom is the public product name (reference/rfcs/switchroom-positioning.md).
        # Deployment identifiers under that name stay out.
        for token in (
            "browser." + "switch" + "room",
            "switch" + "room-ai",
            "switch" + "room-config",
            "switch" + "room-artifacts",
            "switch" + "room.ai/artifact",
            "mel" + "bourne",
            "o" + "p://",
            "web" + "kite",
            _split("klank") + "er",
            _split("over") + "lord",
            _split("car") + "rie",
            "kenthompson.com" + ".au",
        ):
            self.assertNotIn(token, blob)
        compose = (OVERLAY / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("@sha256:", compose)
        self.assertNotIn(":latest", compose)
        self.assertNotIn("docker.sock", compose)
        self.assertNotIn("privileged:", compose)
        self.assertNotIn("network_mode: host", compose)
        defaults = (OVERLAY / "fleet-config/defaults.yaml").read_text(encoding="utf-8")
        self.assertNotRegex(defaults, r"(?m)^profile:")
        for name in ("ops", "worker"):
            text = (OVERLAY / "fleet-config/agents" / f"{name}.yaml").read_text(encoding="utf-8")
            self.assertRegex(text, rf"(?m)^profile:\s*{name}\s*$")


def _split(name: str) -> str:
    return "".join(name)


if __name__ == "__main__":
    unittest.main()
