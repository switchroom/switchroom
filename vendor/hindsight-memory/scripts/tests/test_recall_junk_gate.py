"""M4 P-REC test (d) — junk gate for `<task-notification>` envelopes.

carve-M4.md packet P-REC, test (d): a `<task-notification>`-prefixed prompt
must not run the noisy NON-directive recall — no `client.recall`, and no
non-directive memory in the emitted transport.

#4756 F2 directive exemption: DIRECTIVES are the one memory class that must
SURVIVE the gate — an agent's standing rules apply on every turn, synthetic or
not. So a gated turn STILL fetches + injects the `<active_directives>` block
(`client.list_directives`), while the `recall` result set stays suppressed.
Asserts on TRANSPORT (what reaches stdout + which client methods are touched),
not on an internal flag, per the red-team's "assert transport, not a flag" rule.

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


class _DirectiveExemptClient:
    """Models a gated task-notification turn after the #4756 F2 fix.

    `list_directives` answers with one active directive (which MUST survive the
    gate and be injected). `recall` returns a real memory but records that it
    was called — the gate must NEVER call it, so a hit on `recall_called` (or
    the memory text appearing in transport) is a regression to the pre-fix
    behavior where the gate dropped directives too.
    """

    def __init__(self):
        self.recall_called = False

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": [{
            "id": "d1", "name": "always-sign-off", "priority": 10,
            "content": "always end replies with a wave",
        }]}

    def recall(self, bank_id, query, **kwargs):
        self.recall_called = True
        return {"results": [{
            "text": "a real memory", "type": "fact", "mentioned_at": "2026-01-01",
            "id": "m1", "scores": {"final": 0.9},
        }]}


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

    def test_task_notification_gate_injects_directives_but_suppresses_recall(self):
        # #4756 F2: on a gated task-notification turn, DIRECTIVES must be
        # injected while the non-directive `recall` result set is suppressed.
        # A test that would pass under the OLD bug (gate emits nothing) is
        # invalid — so assert the directive text is PRESENT (the bug emitted
        # ""), the memory text is ABSENT, and `recall` was never called.
        client = _DirectiveExemptClient()
        out = self._run(
            "<task-notification>a background task finished</task-notification>",
            client,
        )
        self.assertTrue(out, "gated turn must still emit the directives block")
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("<active_directives>", ctx)
        self.assertIn("always end replies with a wave", ctx)
        self.assertNotIn(
            "a real memory", ctx,
            "gate must suppress the non-directive recall result set",
        )
        self.assertFalse(
            client.recall_called,
            "gated turn must never run the memory recall HTTP call",
        )

    def test_task_notification_gate_with_no_directives_emits_nothing(self):
        # No active directives → no empty wrapper, no recall: the gate stays a
        # true no-op on the transport (byte-identical to pre-fix when the bank
        # has nothing to inject).
        client = _AnsweringClient()  # list_directives returns items: []
        out = self._run(
            "<task-notification>a background task finished</task-notification>",
            client,
        )
        self.assertEqual(
            out, "",
            "gated turn with no directives must emit no transport output",
        )

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
