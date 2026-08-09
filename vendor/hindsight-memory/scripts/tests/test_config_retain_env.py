"""Switchroom — the auto-retain cadence knobs must have an env channel.

`retainEveryNTurns`, `retainOverlapTurns`, `retainContext`, and `retainTags`
had a DEFAULTS entry and (for the cadence pair) a settings.json stamp, but NO
entry in `ENV_OVERRIDES`. Env is the TOP of the plugin's config precedence
chain (DEFAULTS -> settings.json -> ~/.hindsight/claude-code.json -> env), so
without an env key an operator's `HINDSIGHT_RETAIN_*` could not reach the
plugin at all, and a docker-exec'd retain that does not inherit the supervised
settings could not be steered either.

The outcome under test: `HINDSIGHT_RETAIN_EVERY_N_TURNS` (and its siblings)
actually OVERRIDE the resolved config value, and env wins over the shipped
default.

Stdlib-only.
"""

import os
import sys
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import DEFAULTS, ENV_OVERRIDES, load_config  # noqa: E402


# Every retain-cadence env var, with the config key it must reach.
RETAIN_ENV = {
    "HINDSIGHT_RETAIN_EVERY_N_TURNS": "retainEveryNTurns",
    "HINDSIGHT_RETAIN_OVERLAP_TURNS": "retainOverlapTurns",
    "HINDSIGHT_RETAIN_CONTEXT": "retainContext",
    "HINDSIGHT_RETAIN_TAGS": "retainTags",
}


def _load_with(env):
    """load_config() with a hermetic environment (no plugin/user settings)."""
    with mock.patch.dict(os.environ, env, clear=True):
        os.environ["CLAUDE_PLUGIN_ROOT"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        os.environ["HOME"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        return load_config()


class EveryRetainNameHasAChannel(unittest.TestCase):
    def test_all_retain_env_names_are_wired(self):
        missing = [name for name in RETAIN_ENV if name not in ENV_OVERRIDES]
        self.assertEqual(missing, [], f"exported but never read: {missing}")

    def test_each_name_maps_to_the_expected_config_key(self):
        for name, key in RETAIN_ENV.items():
            with self.subTest(name=name):
                self.assertEqual(ENV_OVERRIDES[name][0], key)

    def test_every_target_key_exists_in_defaults(self):
        for name, key in RETAIN_ENV.items():
            with self.subTest(name=name):
                self.assertIn(key, DEFAULTS)


class ValuesActuallyLand(unittest.TestCase):
    """The outcome that matters: the loaded config carries the exported value."""

    def test_every_n_turns_env_overrides_the_resolved_value(self):
        # The headline outcome: HINDSIGHT_RETAIN_EVERY_N_TURNS wins over the
        # shipped default, and lands as an int.
        override = DEFAULTS["retainEveryNTurns"] + 5
        cfg = _load_with({"HINDSIGHT_RETAIN_EVERY_N_TURNS": str(override)})
        self.assertEqual(cfg["retainEveryNTurns"], override)
        self.assertIsInstance(cfg["retainEveryNTurns"], int)
        self.assertNotEqual(cfg["retainEveryNTurns"], DEFAULTS["retainEveryNTurns"])

    def test_overlap_turns_env_overrides_the_resolved_value(self):
        cfg = _load_with({"HINDSIGHT_RETAIN_OVERLAP_TURNS": "4"})
        self.assertEqual(cfg["retainOverlapTurns"], 4)

    def test_context_env_overrides_the_resolved_value(self):
        cfg = _load_with({"HINDSIGHT_RETAIN_CONTEXT": "codex"})
        self.assertEqual(cfg["retainContext"], "codex")

    def test_tags_env_accepts_a_json_array(self):
        cfg = _load_with({"HINDSIGHT_RETAIN_TAGS": '["source:transcript"]'})
        self.assertEqual(cfg["retainTags"], ["source:transcript"])

    def test_tags_env_accepts_a_comma_separated_list(self):
        cfg = _load_with({"HINDSIGHT_RETAIN_TAGS": "a,b"})
        self.assertEqual(cfg["retainTags"], ["a", "b"])

    def test_no_retain_env_reproduces_the_default(self):
        baseline = _load_with({})
        for key in RETAIN_ENV.values():
            with self.subTest(key=key):
                self.assertEqual(baseline[key], DEFAULTS[key])


if __name__ == "__main__":
    unittest.main()
