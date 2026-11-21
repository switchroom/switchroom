"""Generic plugins belong in public; household maps and Webkite do not."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINEAR = ROOT / "plugins" / "linear"
ACP = ROOT / "plugins" / "model-providers" / "claude-acp"
KOKORO = ROOT / "plugins" / "kokoro-voice"
HANDOFF = ROOT / "plugins" / "browser-handoff"
READONLY = ROOT / "plugins" / "readonly-source"
DIRECTSDK = ROOT / "plugins" / "claude-subscription-directsdk"
DOCKERFILE = ROOT / "Dockerfile"
CONTRACT = ROOT / "contracts" / "plugins.json"
HOUSEHOLD = re.compile(
    r"switchroom|kenthompson|pixsoul|autograb|browser\.switchroom|"
    + re.escape("klank" + "er")
    + r"|"
    + re.escape("over" + "lord")
    + r"|"
    + re.escape("gym" + "bro")
    + r"|"
    + re.escape("law" + "gpt"),
    re.I,
)
class PublicGenericPluginTests(unittest.TestCase):
    def test_native_linear_keeps_household_maps_out(self) -> None:
        self.assertFalse((LINEAR / "linear-agents.json").exists())
        self.assertFalse((LINEAR / "linear-publishers.json").exists())
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn("RUN test ! -e /opt/hermes/plugins/linear-agent", dockerfile)
        self.assertNotIn("COPY plugins/linear-agent/", dockerfile)


    def test_claude_acp_ships_the_profile_local_client(self) -> None:
        text = (ACP / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("ClaudeACPClient", text)
        self.assertNotIn("CopilotACPClient", text)
        self.assertTrue((ACP / "client.py").is_file())
        self.assertTrue((ACP / "tool_bridge_mcp.py").is_file())
        self.assertIn("from .client import ClaudeACPClient", text)
        self.assertIn("/usr/local/bin/hermes-claude-acp-subscription", text)
        self.assertNotIn("COPY plugins/model-providers/claude-acp/", DOCKERFILE.read_text(encoding="utf-8"))
        self.assertIn("RUN test ! -e /opt/hermes/plugins/model-providers/claude-acp", DOCKERFILE.read_text(encoding="utf-8"))

    def test_sidecar_era_browser_handoff_is_retired(self) -> None:
        # Camoufox on the agent's own Bot Desktop (with Take over) replaced the
        # sidecar browser, its handoff plugin and recipe (HF-773).
        self.assertFalse(HANDOFF.exists())
        self.assertFalse((ROOT / "recipes" / "browser-handoff").exists())
        self.assertFalse((ROOT / "sidecars" / "camofox").exists())
        self.assertFalse((ROOT / ".github" / "workflows" / "sidecar-camofox.yml").exists())
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        self.assertNotIn("COPY plugins/browser-handoff/", dockerfile)
        # The bake still prunes any inherited copy and proves it is gone.
        self.assertIn("RUN test ! -e /opt/hermes/plugins/browser-handoff", dockerfile)
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        self.assertNotIn("browser-handoff", [item["id"] for item in contract["components"]])
        self.assertNotIn("browser-handoff", [o["id"] for o in contract["public_base"]["opt_in"]])
        packages = json.loads((ROOT / "sidecars" / "packages.json").read_text(encoding="utf-8"))
        self.assertNotIn("camofox", packages["packages"])

    def test_readonly_source_is_generic_and_disabled(self) -> None:
        manifest = (READONLY / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("author: Hermes Fleet Contributors", manifest)
        self.assertNotIn("Ken Thompson", manifest)
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        self.assertNotIn("COPY plugins/readonly-source/", dockerfile)
        self.assertIn("RUN test ! -e /opt/hermes/plugins/readonly-source", dockerfile)
        self.assertIn(
            "COPY --chmod=0755 scripts/tooling-policy-hook /opt/hermes/bin/tooling-policy-hook",
            dockerfile,
        )

    def test_kokoro_voice_is_a_generic_disabled_plugin(self) -> None:
        self.assertTrue((KOKORO / "__init__.py").is_file())
        self.assertTrue((KOKORO / "plugin.yaml").is_file())
        manifest = (KOKORO / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("author: Hermes Fleet Contributors", manifest)
        self.assertNotIn("Ken Thompson", manifest)
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        self.assertNotIn("COPY plugins/kokoro-voice/", dockerfile)
        self.assertIn("RUN test ! -e /opt/hermes/plugins/kokoro-voice", dockerfile)
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        matches = [item for item in contract["components"] if item["id"] == "voice-provider"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["target"], "standalone_public_plugin")
        # Reviewed default, shipped after the container rerun (docs/starter-overlay-acceptance.md):
        # on only under the enable guard (sidecar configured and reachable, no hosted fallback),
        # still mounted from vendor/ rather than baked into the image, and text-only when the
        # sidecar is missing or does not answer.
        self.assertTrue(matches[0]["default_enabled"])
        self.assertEqual(matches[0]["default_role"], "default")
        voice = [d for d in contract["public_base"]["default_set"] if "voice-provider" in d["covers"]]
        self.assertEqual([d["id"] for d in voice], ["voice"])
        self.assertEqual(voice[0]["status"], "shipped")
        self.assertEqual(voice[0]["enable_guard"], {"sidecar": "configured_and_reachable", "hosted_fallback": False})
        self.assertEqual(voice[0]["degrade"]["behaviour"], "text_only_and_report")
        source = (KOKORO / "__init__.py").read_text(encoding="utf-8")
        self.assertNotIn("hermes-kokoro-sidecar", source)
        self.assertIn('parsed.scheme not in {"http", "https"}', source)
        self.assertIn("not parsed.hostname", source)
        self.assertIn("HERMES_KOKORO_SIDECAR_URL is not set", source)
        workflow = (ROOT / ".github" / "workflows" / "fleet-image.yml").read_text(
            encoding="utf-8"
        )
        self.assertEqual(workflow.count('assert not pathlib.Path("/opt/hermes/plugins/kokoro-voice").exists()'), 2)

    def test_generic_plugin_trees_have_no_household_literals(self) -> None:
        roots = (LINEAR, ACP, KOKORO, HANDOFF, READONLY,
                 ROOT / "plugins" / "web" / "perplexity", DIRECTSDK)
        for root in roots:
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix not in {".py", ".yaml", ".json", ".md"}:
                    continue
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(HOUSEHOLD.search(text), path.relative_to(ROOT))

    def test_directsdk_is_pinned_licensed_and_optional(self) -> None:
        import hashlib
        provenance = json.loads((DIRECTSDK / "upstream.json").read_text(encoding="utf-8"))
        self.assertEqual(provenance["source_repository"], "https://github.com/NousResearch/hermes-official-plugins")
        self.assertEqual(provenance["source_revision"], "ab348e1d8d8691f56000875420bc3b29349a902b")
        self.assertEqual(provenance["license"], "MIT")
        self.assertTrue((DIRECTSDK / "LICENSE").is_file())
        self.assertEqual(provenance["license_file"], "LICENSE")
        for relative, digest in provenance["files_sha256"].items():
            self.assertEqual(hashlib.sha256((DIRECTSDK / relative).read_bytes()).hexdigest(), digest)
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        entry = [item for item in contract["components"] if item["id"] == "claude-subscription-directsdk-provider"]
        self.assertEqual(len(entry), 1)
        self.assertFalse(entry[0]["default_enabled"])
        self.assertEqual(entry[0]["default_role"], "default")
        default = [d for d in contract["public_base"]["default_set"] if d["id"] == "claude-subscription-directsdk"]
        self.assertEqual(len(default), 1)
        self.assertEqual(default[0]["covers"], ["claude-subscription-directsdk-provider"])
        self.assertEqual(default[0]["status"], "planned")
        self.assertIs(default[0]["api_key_fallback"], False)
        self.assertEqual(default[0]["upstream_label"], "experimental")
        self.assertNotIn("COPY plugins/claude-subscription-directsdk/", DOCKERFILE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
