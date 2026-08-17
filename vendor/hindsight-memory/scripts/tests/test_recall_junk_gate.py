"""M4 P-REC test (d) — junk gate for `<task-notification>` envelopes.

carve-M4.md packet P-REC, test (d): a `<task-notification>`-prefixed prompt
must never reach the network — no `client.recall`, no `client.list_directives`,
no `<hindsight_memories>`/additionalContext in the emitted transport. Asserts
on TRANSPORT (stdout emptiness + a client that raises if touched), not on an
internal flag, per the red-team's "assert transport, not a flag" rule.

Distinct from the gateway's `<channel source=...>` envelope (a real human
message) — this only matches the CLI-native task-notification wrapper.
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


class _RaisingClient:
    """Any network touch is a test failure — this client raises on use."""

    def list_directives(self, *a, **kw):
        raise AssertionError("junk-gated turn must never call list_directives")

    def recall(self, *a, **kw):
        raise AssertionError("junk-gated turn must never call recall")


class _AnsweringClient:
    """A normal client that DOES answer, used to prove the gate did NOT fire."""

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        return {"results": [{
            "text": "a real memory", "type": "fact", "mentioned_at": "2026-01-01",
            "id": "m1", "scores": {"final": 0.9},
        }]}


class JunkGateTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-junk-gate-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _run(self, prompt, client):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "test-bank",
            "recallMaxTokens": 4096,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
        }
        stdout = io.StringIO()
        with patch("recall.load_config", return_value=config), \
                patch("recall.get_api_url", return_value="http://fake"), \
                patch("recall.HindsightClient", return_value=client), \
                patch("recall.ensure_bank_mission"), \
                patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                patch("sys.stdout", stdout):
            recall.main()
        return stdout.getvalue()

    def test_task_notification_prompt_never_touches_the_network_or_emits_context(self):
        out = self._run(
            "<task-notification>a background task finished</task-notification>",
            _RaisingClient(),
        )
        self.assertEqual(out, "", "junk-gated turn must emit no transport output at all")

    def test_ordinary_prompt_with_task_notification_substring_midstring_is_not_gated(self):
        # Only a PREFIX match gates — a real user prompt that happens to
        # mention the phrase must still recall normally and reach the
        # network (proven here by using an ANSWERING client and asserting
        # the real memory shows up in the rendered transport).
        out = self._run(
            "what does a <task-notification> even look like in our hooks?",
            _AnsweringClient(),
        )
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("a real memory", ctx)


if __name__ == "__main__":
    unittest.main()
