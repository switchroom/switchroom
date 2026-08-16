"""Switchroom — `retainToolCalls` must have an env channel, default unchanged.

RFC memory-redesign P4. `retainToolCalls` (whether retain stores tool_use
inputs + tool_result content) had a DEFAULTS entry of True but NO entry in
`ENV_OVERRIDES` and no scaffold stamp, so an operator could not reach it: env
is the TOP of the plugin's config precedence chain (DEFAULTS -> settings.json
-> ~/.hindsight/claude-code.json -> env), and without an env key
`HINDSIGHT_RETAIN_TOOL_CALLS` could not steer the plugin at all — including a
docker-exec'd retain/backfill that does not inherit the supervised settings.

This PR ships the SETTER ONLY. The invariants under test:

  1. `HINDSIGHT_RETAIN_TOOL_CALLS` is wired in `ENV_OVERRIDES` and maps to the
     `retainToolCalls` config key.
  2. The shipped default is unchanged — `True` — so absent any override the
     fleet behaves byte-identically (the load resolves True with no env set).
  3. Setting the env `false` actually LANDS as Python `False` over the True
     default (proving `false` is reachable, which is the whole point of the
     knob), and `true`/`1`/`yes` resolve back to True.

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

ENV_NAME = "HINDSIGHT_RETAIN_TOOL_CALLS"
CONFIG_KEY = "retainToolCalls"


def _load_with(env):
    """load_config() with a hermetic environment (no plugin/user settings)."""
    with mock.patch.dict(os.environ, env, clear=True):
        os.environ["CLAUDE_PLUGIN_ROOT"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        os.environ["HOME"] = os.path.join(SCRIPTS_DIR, "does-not-exist")
        return load_config()


class RetainToolCallsHasAChannel(unittest.TestCase):
    def test_env_name_is_wired(self):
        self.assertIn(
            ENV_NAME,
            ENV_OVERRIDES,
            f"{ENV_NAME} exported nowhere / never read — the drift P4 closes",
        )

    def test_env_name_maps_to_the_expected_config_key(self):
        self.assertEqual(ENV_OVERRIDES[ENV_NAME][0], CONFIG_KEY)

    def test_env_name_is_typed_bool(self):
        self.assertIs(ENV_OVERRIDES[ENV_NAME][1], bool)

    def test_target_key_exists_in_defaults(self):
        self.assertIn(CONFIG_KEY, DEFAULTS)


class DefaultIsUnchanged(unittest.TestCase):
    """The critical P4 invariant: default stays True, byte-identical fleet."""

    def test_shipped_default_is_true(self):
        self.assertIs(DEFAULTS[CONFIG_KEY], True)

    def test_no_env_reproduces_the_true_default(self):
        cfg = _load_with({})
        self.assertIs(cfg[CONFIG_KEY], True)


class ValuesActuallyLand(unittest.TestCase):
    """The setter must be reachable: env `false` lands as Python False."""

    def test_false_env_overrides_the_true_default(self):
        cfg = _load_with({ENV_NAME: "false"})
        self.assertIs(cfg[CONFIG_KEY], False)
        self.assertNotEqual(cfg[CONFIG_KEY], DEFAULTS[CONFIG_KEY])

    def test_zero_and_no_also_resolve_false(self):
        for falsey in ("0", "no", "False"):
            with self.subTest(value=falsey):
                cfg = _load_with({ENV_NAME: falsey})
                self.assertIs(cfg[CONFIG_KEY], False)

    def test_true_env_resolves_true(self):
        for truthy in ("true", "1", "yes", "TRUE"):
            with self.subTest(value=truthy):
                cfg = _load_with({ENV_NAME: truthy})
                self.assertIs(cfg[CONFIG_KEY], True)


if __name__ == "__main__":
    unittest.main()
