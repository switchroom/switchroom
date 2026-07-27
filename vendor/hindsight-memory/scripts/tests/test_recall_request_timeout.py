"""Switchroom: the per-bank recall request timeout is a MANAGED KEY, not a literal.

`recall.py` used to pass a bare `timeout=8` to every `client.recall()` call.
That literal lived inside the vendored plugin tree, which `switchroom apply`
rm's and re-copies — so an operator who needed a different value had to
hand-edit the installed plugin and watch the next apply silently revert it. The
live fleet did exactly that, three separate times, each time quietly restoring
shipped defaults while switchroom.yaml read as though it were tuned.

It is now `recallRequestTimeoutSeconds` (env:
HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS), resolved from
`memory.recall.request_timeout_seconds` and stamped/exported by switchroom.

The assertions here are on the VALUE THAT REACHES THE CLIENT, because that is
the thing the bug got wrong. Asserting only that the config key parses would
stay green with the literal still hard-coded at the callsite.

Stdlib-only (unittest); runs under ``python3 -m unittest discover tests/``
from ``scripts/``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib.config import DEFAULTS, ENV_OVERRIDES, load_config  # noqa: E402

BARE = "what did we decide about the auth flow last week"


class _RecordingClient:
    """Captures the `timeout` kwarg of every recall() call."""

    def __init__(self):
        self.timeouts = []

    def recall(self, **kwargs):
        self.timeouts.append(kwargs.get("timeout"))
        return {"memories": []}

    def list_directives(self, *a, **kw):
        return []


class _Harness(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-req-timeout-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _timeouts(self, config_extra=None):
        client = _RecordingClient()
        hook_input = {
            "prompt": BARE,
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
        }
        if config_extra:
            config.update(config_extra)
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=io.StringIO()), patch(
            "sys.stderr", new=io.StringIO()
        ):
            recall.main()
        return client.timeouts


class PerBankTimeoutIsConfigured(_Harness):
    def test_default_matches_the_historical_literal(self):
        # Promotion to a managed key must not change what switchroom ships.
        self.assertEqual(self._timeouts(), [8.0])

    def test_configured_value_reaches_the_client(self):
        self.assertEqual(
            self._timeouts({"recallRequestTimeoutSeconds": 13}), [13.0]
        )

    def test_applies_to_every_bank_in_a_fan_out(self):
        # One hung bank must not be able to outlive its siblings' budget, so
        # the value has to reach EVERY bank, not just the own-bank slot.
        got = self._timeouts(
            {
                "recallRequestTimeoutSeconds": 5,
                "recallAdditionalBanks": ["shared-a", "shared-b"],
            }
        )
        self.assertEqual(len(got), 3)
        self.assertEqual(set(got), {5.0})

    def test_applies_on_the_serial_rollback_path_too(self):
        got = self._timeouts(
            {"recallRequestTimeoutSeconds": 7, "recallParallel": False}
        )
        self.assertEqual(got, [7.0])

    def test_unusable_values_fall_back_instead_of_breaking_recall(self):
        # A malformed or non-positive timeout must not take the pre-turn hook
        # down to a traceback, and must never become "fail instantly".
        for bad in ("not-a-number", None, 0, -3):
            with self.subTest(bad=bad):
                self.assertEqual(
                    self._timeouts({"recallRequestTimeoutSeconds": bad}), [8.0]
                )


class ManagedKeyIsWired(unittest.TestCase):
    def test_key_has_a_default_and_an_env_override(self):
        # Both halves are required for the key to be settable declaratively:
        # the default is the shipped value, the env override is what lets
        # switchroom.yaml outrank a stale ~/.hindsight/claude-code.json.
        self.assertEqual(DEFAULTS["recallRequestTimeoutSeconds"], 8)
        self.assertIn("HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS", ENV_OVERRIDES)
        key, typ = ENV_OVERRIDES["HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS"]
        self.assertEqual(key, "recallRequestTimeoutSeconds")
        self.assertIs(typ, float)

    def test_env_override_wins_over_the_built_in_default(self):
        with patch.dict(
            os.environ,
            {"HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS": "11.5"},
            clear=False,
        ):
            self.assertEqual(load_config()["recallRequestTimeoutSeconds"], 11.5)


if __name__ == "__main__":
    unittest.main()
