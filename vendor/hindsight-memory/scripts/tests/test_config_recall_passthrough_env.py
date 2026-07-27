"""Switchroom #3841 — the recall knobs switchroom.yaml exports must actually
land in the loaded config.

Three of them (`recallPreferObservations`, `recallRoles`,
`recallPromptPreamble`) had a config key and a `recall.py` read but NO entry in
`ENV_OVERRIDES`, so there was no channel from switchroom.yaml at all: the only
way to change them was to hand-edit the installed plugin, which
`switchroom apply` reverts by re-copying this tree.

The rest already had entries and only needed the yaml surface — they are
asserted here too, because the failure they guard against is silent in exactly
the same way. `start.sh` exports a NAME; if that name is not a key of
`ENV_OVERRIDES`, `load_config()` ignores it, the plugin default stands, and the
operator's switchroom.yaml reads as though it were in force. Nothing errors.

Stdlib-only.
"""

import json
import os
import sys
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import DEFAULTS, ENV_OVERRIDES, load_config  # noqa: E402


# Every env var `profiles/_base/start.sh.hbs` exports for the #3841
# passthrough, with the config key it must reach.
PASSTHROUGH_ENV = {
    "HINDSIGHT_RECALL_BUDGET": "recallBudget",
    "HINDSIGHT_RECALL_MAX_TOKENS": "recallMaxTokens",
    "HINDSIGHT_RECALL_PREFER_OBSERVATIONS": "recallPreferObservations",
    "HINDSIGHT_RECALL_CONTEXT_TURNS": "recallContextTurns",
    "HINDSIGHT_RECALL_ROLES": "recallRoles",
    "HINDSIGHT_RECALL_PROMPT_PREAMBLE": "recallPromptPreamble",
    "HINDSIGHT_RECALL_MAX_QUERY_CHARS": "recallMaxQueryChars",
    "HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES": "recallTranscriptTailBytes",
    "HINDSIGHT_RECALL_TAGS": "recallTags",
    "HINDSIGHT_RECALL_TAGS_MATCH": "recallTagsMatch",
    "HINDSIGHT_RECALL_TAG_GROUPS": "recallTagGroups",
    "HINDSIGHT_RECALL_TAG_WEIGHTS": "recallTagWeights",
    "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS": "recallAdditionalBankFilters",
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK": "recallTranscriptFallback",
    "HINDSIGHT_RECALL_PARALLEL": "recallParallel",
}


def _load_with(env):
    """load_config() with a hermetic environment (no plugin/user settings)."""
    with mock.patch.dict(os.environ, env, clear=True):
        # Point CLAUDE_PLUGIN_ROOT at a directory with no settings.json so the
        # result is DEFAULTS + env only, and no developer's real
        # ~/.hindsight/claude-code.json can leak in.
        os.environ["CLAUDE_PLUGIN_ROOT"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        os.environ["HOME"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        return load_config()


class EveryExportedNameHasAChannel(unittest.TestCase):
    def test_all_passthrough_env_names_are_wired(self):
        missing = [name for name in PASSTHROUGH_ENV if name not in ENV_OVERRIDES]
        self.assertEqual(missing, [], f"exported but never read: {missing}")

    def test_each_name_maps_to_the_expected_config_key(self):
        for name, key in PASSTHROUGH_ENV.items():
            with self.subTest(name=name):
                self.assertEqual(ENV_OVERRIDES[name][0], key)

    def test_every_target_key_exists_in_defaults(self):
        for name, key in PASSTHROUGH_ENV.items():
            with self.subTest(name=name):
                self.assertIn(key, DEFAULTS)


class ValuesActuallyLand(unittest.TestCase):
    """The outcome that matters: the loaded config carries the exported value."""

    def test_prefer_observations_can_be_turned_off(self):
        self.assertTrue(DEFAULTS["recallPreferObservations"])
        cfg = _load_with({"HINDSIGHT_RECALL_PREFER_OBSERVATIONS": "false"})
        self.assertIs(cfg["recallPreferObservations"], False)

    def test_roles_accepts_the_exported_json_array(self):
        cfg = _load_with({"HINDSIGHT_RECALL_ROLES": '["user"]'})
        self.assertEqual(cfg["recallRoles"], ["user"])

    def test_prompt_preamble_replaces_the_banner(self):
        cfg = _load_with({"HINDSIGHT_RECALL_PROMPT_PREAMBLE": "Past context:"})
        self.assertEqual(cfg["recallPromptPreamble"], "Past context:")

    def test_tag_weights_accepts_the_exported_json_object(self):
        cfg = _load_with({"HINDSIGHT_RECALL_TAG_WEIGHTS": '{"sidechain": 0.8}'})
        self.assertEqual(cfg["recallTagWeights"], {"sidechain": 0.8})

    def test_tag_groups_accepts_both_shapes(self):
        as_list = _load_with({"HINDSIGHT_RECALL_TAG_GROUPS": '[["a","b"],["c"]]'})
        self.assertEqual(as_list["recallTagGroups"], [["a", "b"], ["c"]])
        as_map = _load_with({"HINDSIGHT_RECALL_TAG_GROUPS": '{"g": ["a"]}'})
        self.assertEqual(as_map["recallTagGroups"], {"g": ["a"]})

    def test_empty_collection_exports_assign_rather_than_being_skipped(self):
        # `[]` / `{}` are what switchroom exports when the operator configured
        # nothing. They must ASSIGN (making env authoritative over a stale
        # ~/.hindsight/claude-code.json), not be dropped like an empty string.
        cfg = _load_with(
            {
                "HINDSIGHT_RECALL_TAGS": "[]",
                "HINDSIGHT_RECALL_TAG_GROUPS": "{}",
                "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS": "{}",
            }
        )
        self.assertEqual(cfg["recallTags"], [])
        self.assertEqual(cfg["recallTagGroups"], {})
        self.assertEqual(cfg["recallAdditionalBankFilters"], {})

    def test_exported_defaults_reproduce_the_shipped_config(self):
        """The no-config path: exporting today's effective values changes nothing.

        This is the whole contract of the passthrough — an operator who sets no
        `memory.recall.*` key must get the same loaded config as an agent
        running before the exports existed.
        """
        baseline = _load_with({})
        exported = _load_with(
            {
                "HINDSIGHT_RECALL_BUDGET": baseline["recallBudget"],
                "HINDSIGHT_RECALL_MAX_TOKENS": str(baseline["recallMaxTokens"]),
                "HINDSIGHT_RECALL_PREFER_OBSERVATIONS": str(
                    baseline["recallPreferObservations"]
                ).lower(),
                "HINDSIGHT_RECALL_CONTEXT_TURNS": str(baseline["recallContextTurns"]),
                "HINDSIGHT_RECALL_ROLES": json.dumps(baseline["recallRoles"]),
                "HINDSIGHT_RECALL_PROMPT_PREAMBLE": baseline["recallPromptPreamble"],
                "HINDSIGHT_RECALL_MAX_QUERY_CHARS": str(baseline["recallMaxQueryChars"]),
                "HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES": str(
                    baseline["recallTranscriptTailBytes"]
                ),
                "HINDSIGHT_RECALL_TAGS": json.dumps(baseline["recallTags"]),
                "HINDSIGHT_RECALL_TAGS_MATCH": baseline["recallTagsMatch"],
                # settings.json ships null / DEFAULTS carries None; `{}` is the
                # same thing to recall.py (`config.get(...) or None`) and unlike
                # `null` it actually assigns.
                "HINDSIGHT_RECALL_TAG_GROUPS": "{}",
                "HINDSIGHT_RECALL_TAG_WEIGHTS": json.dumps(baseline["recallTagWeights"]),
                "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS": json.dumps(
                    baseline["recallAdditionalBankFilters"]
                ),
                "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK": str(
                    baseline["recallTranscriptFallback"]
                ).lower(),
                "HINDSIGHT_RECALL_PARALLEL": str(baseline["recallParallel"]).lower(),
            }
        )
        for key in PASSTHROUGH_ENV.values():
            with self.subTest(key=key):
                if key == "recallTagGroups":
                    # None vs {} — equivalent at every read site (`or None`).
                    self.assertFalse(baseline[key])
                    self.assertFalse(exported[key])
                    continue
                self.assertEqual(exported[key], baseline[key])


if __name__ == "__main__":
    unittest.main()
