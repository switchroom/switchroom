"""The reviewed default-on set (reference/rfcs/default-on-distribution.md).

These guards replace the old "nothing is default-enabled" assertions. They pin
the default set to exactly the reviewed list, require every default to degrade
without blocking startup, forbid ungranted paid paths, and keep everything
outside the list off.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "plugins.json"
RECORD = ROOT / "reference" / "rfcs" / "default-on-distribution.md"

REVIEWED_DEFAULTS = [
    "doctrine-config",
    "gateway-per-agent",
    "secrets-connect",
    "coding-clis",
    "model-roles",
    "claude-subscription-directsdk",
    "claude-acp-connectors",
    "linear",
    "voice",
    "honcho-memory",
    "web-search",
    "camoufox-browser",
    "quota",
    "session-reset-policy",
    "security-guidance",
    "disk-cleanup",
    "shared-skill-pack",
]
REVIEWED_OPT_IN = ["browser-handoff", "agent-to-agent", "artifact-publishing"]
# Components a reviewed default covers. Everything else must stay off.
DEFAULT_COMPONENTS = {
    "claude-subscription-directsdk-provider",
    "claude-acp-provider",
    "claude-account-connectors",
    "linear",
    "voice-provider",
    "web-provider",
    "perplexity-web-provider",
    "camofox",
    "camoufox-desktop",
}
OPT_IN_COMPONENTS = {"browser-handoff"}
# Shipped only when the starter overlay actually enables a default. Wave 0 ships none.
# Proven in real containers: docs/starter-overlay-acceptance.md.
SHIPPED: set[str] = {
    "doctrine-config", "gateway-per-agent", "quota", "session-reset-policy",
    "security-guidance", "disk-cleanup", "honcho-memory",
    "voice", "shared-skill-pack",
}
GRANTED_BILLING = {"none", "principal_plan_login", "operator_supplied_key"}
DEGRADE_BEHAVIOURS = {
    "always_on",
    "disable_and_report",
    "use_env_file_and_report",
    "drop_from_chain_and_report",
    "text_only_and_report",
    "builtin_memory_and_report",
    "default_web_backend_and_report",
    "chromium_only_and_report",
}


def load() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


class DefaultOnContractTests(unittest.TestCase):
    def test_policy_points_at_the_decision_record(self) -> None:
        base = load()["public_base"]
        self.assertEqual(base["policy"], "reviewed_default_set")
        self.assertEqual(base["decision_record"], "reference/rfcs/default-on-distribution.md")
        self.assertTrue(RECORD.is_file())
        self.assertEqual(base["opt_out"], "one_line_per_agent")
        self.assertEqual(base["missing_credential"], "disable_report_in_setup_check_never_block_start")
        self.assertEqual(set(base["billing_values"]), GRANTED_BILLING)
        self.assertNotIn("default_enabled_plugins", base)

    def test_default_set_is_exactly_the_reviewed_list(self) -> None:
        base = load()["public_base"]
        self.assertEqual([d["id"] for d in base["default_set"]], REVIEWED_DEFAULTS)
        self.assertEqual([o["id"] for o in base["opt_in"]], REVIEWED_OPT_IN)
        self.assertFalse(set(REVIEWED_DEFAULTS) & set(REVIEWED_OPT_IN))

    def test_every_default_degrades_and_never_blocks_start(self) -> None:
        for entry in load()["public_base"]["default_set"]:
            with self.subTest(default=entry["id"]):
                self.assertIs(entry["blocks_agent_start"], False)
                self.assertIn(entry["degrade"]["behaviour"], DEGRADE_BEHAVIOURS)
                self.assertTrue(entry["degrade"]["when"])
                self.assertIn("kind", entry["credential"])
                if entry["credential"]["kind"] == "none":
                    self.assertEqual(entry["degrade"]["behaviour"], "always_on")
                else:
                    self.assertNotEqual(entry["degrade"]["behaviour"], "always_on")

    def test_no_default_declares_an_ungranted_paid_path(self) -> None:
        for entry in load()["public_base"]["default_set"]:
            with self.subTest(default=entry["id"]):
                self.assertIn(entry["billing"], GRANTED_BILLING)
                self.assertIsNot(entry.get("api_key_fallback"), True)
                self.assertIsNot(entry.get("adds_ungranted_provider"), True)
        by_id = {d["id"]: d for d in load()["public_base"]["default_set"]}
        for model_path in ("claude-subscription-directsdk", "claude-acp-connectors"):
            self.assertIs(by_id[model_path]["api_key_fallback"], False)
            self.assertEqual(by_id[model_path]["billing"], "principal_plan_login")
        self.assertIs(by_id["model-roles"]["adds_ungranted_provider"], False)
        # A paid key is used only when the operator supplied it.
        self.assertEqual(by_id["web-search"]["billing"], "operator_supplied_key")
        self.assertEqual(by_id["web-search"]["credential"]["kind"], "optional_operator_key")

    def test_specific_defaults_carry_their_reviewed_shape(self) -> None:
        by_id = {d["id"]: d for d in load()["public_base"]["default_set"]}
        self.assertEqual(by_id["gateway-per-agent"]["pinned_config"], {"gateway.multiplex_profiles": False})
        self.assertEqual(by_id["secrets-connect"]["credential"]["fallback"], "env_file")
        self.assertIs(by_id["claude-subscription-directsdk"]["default_model_provider"], True)
        self.assertEqual(by_id["claude-subscription-directsdk"]["upstream_label"], "experimental")
        self.assertEqual(by_id["claude-acp-connectors"]["qualification"], "read_only")
        self.assertEqual(by_id["disk-cleanup"]["mode"], "report_only")
        self.assertEqual(
            sum(1 for d in by_id.values() if d.get("default_model_provider")), 1
        )

    def test_honcho_is_referenced_by_upstream_image_not_vendored(self) -> None:
        # Replaces the old "no honcho in contracts" guard: Honcho may be named as a
        # default, but its AGPL source and any workspace identity stay out.
        entry = next(d for d in load()["public_base"]["default_set"] if d["id"] == "honcho-memory")
        self.assertEqual(
            entry["source"],
            {"vendored": False, "license": "AGPL-3.0", "distribution": "upstream_image_by_digest"},
        )
        text = CONTRACT.read_text(encoding="utf-8").lower()
        for token in ("workspace_id", "workspace-id", "peer_id", "honcho_api_key"):
            self.assertNotIn(token, text)
        self.assertFalse((ROOT / "sidecars" / "honcho").exists())
        self.assertFalse((ROOT / "plugins" / "honcho").exists())

    def test_nothing_is_marked_shipped_until_the_starter_overlay_enables_it(self) -> None:
        base = load()["public_base"]
        self.assertEqual(base["default_statuses"], ["planned", "shipped"])
        self.assertEqual(base["starter_overlay"], "planned")
        for entry in base["default_set"]:
            with self.subTest(default=entry["id"]):
                self.assertIn(entry["status"], base["default_statuses"])
                expected = "shipped" if entry["id"] in SHIPPED else "planned"
                self.assertEqual(entry["status"], expected)

    def test_every_shipped_default_has_container_evidence(self) -> None:
        evidence = (ROOT / "docs" / "starter-overlay-acceptance.md").read_text(encoding="utf-8")
        for entry in load()["public_base"]["default_set"]:
            with self.subTest(default=entry["id"]):
                row = f"| `{entry['id']}` | **shipped** |"
                self.assertEqual(row in evidence, entry["status"] == "shipped")

    def test_components_outside_the_list_stay_off(self) -> None:
        contract = load()
        covered = {cid for d in contract["public_base"]["default_set"] for cid in d["covers"]}
        opt_in = {cid for o in contract["public_base"]["opt_in"] for cid in o["covers"]}
        self.assertEqual(covered, DEFAULT_COMPONENTS)
        self.assertEqual(opt_in, OPT_IN_COMPONENTS)
        shipped_covers = {
            cid
            for d in contract["public_base"]["default_set"]
            if d["status"] == "shipped"
            for cid in d["covers"]
        }
        ids = [c["id"] for c in contract["components"]]
        self.assertTrue(covered <= set(ids))
        self.assertTrue(opt_in <= set(ids))
        for component in contract["components"]:
            with self.subTest(component=component["id"]):
                if component["id"] in covered:
                    role = "default"
                elif component["id"] in opt_in:
                    role = "opt_in"
                else:
                    role = "off"
                self.assertEqual(component["default_role"], role)
                # default_enabled stays the truthful "on today" bit.
                self.assertIs(component["default_enabled"], component["id"] in shipped_covers)

    def test_record_and_readme_agree_with_the_contract(self) -> None:
        record = RECORD.read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        principles = (ROOT / "reference" / "principles.md").read_text(encoding="utf-8")
        self.assertIn("2026-11-15", record)
        self.assertIn("no-off-plan-model-call", record)
        self.assertIn("gateway.multiplex_profiles: false", record)
        self.assertIn("experimental", record)
        self.assertIn("read-only", record)
        self.assertIn("AGPL-3.0", record)
        self.assertIn("Nothing is on by default yet", record)
        for opt in ("Browser handoff", "A2A", "artifact publishing"):
            self.assertIn(opt, record)
        self.assertIn("The bare image still turns nothing on", readme)
        self.assertIn("docs/starter-overlay-acceptance.md", readme)
        self.assertNotIn("Plugins stay off until the overlay turns them on", readme)
        self.assertIn("reference/rfcs/default-on-distribution.md", readme)
        self.assertNotIn("Do not enable optional plugins by default.", agents)
        self.assertIn("reviewed default set", agents)
        self.assertNotIn("Optional plugins stay off until the operator turns them on.", principles)
        self.assertIn("reviewed default set", principles)
        self.assertNotIn("plugins disabled by default", principles)


if __name__ == "__main__":
    unittest.main()
