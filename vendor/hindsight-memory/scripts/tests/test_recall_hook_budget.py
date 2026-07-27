"""Switchroom #3760 review, Major 4 — the recall hook must never spend past its
UserPromptSubmit ceiling.

#3757 inverted the transcript-fallback gate: a per-bank TIMEOUT no longer
suppresses the bounded transcript grep, because timing out was the common case
and suppressing on it left the agent with neither memories nor fallback. That
gate was also, incidentally, the thing protecting the hook ceiling. Without it
the arithmetic was: 10s shared recall deadline + a flat 1.5s grep = 11.5s
against a 12s ceiling, leaving ~0.5s for interpreter startup, config load, the
transcript read, output formatting and the log write — all of which sit outside
``recall_start_monotonic``. An overrun is not a degraded recall: Claude Code
kills the hook and the turn loses memories, the fallback AND the directives,
which is strictly worse than the bug #3757 fixes.

The serial rollback path had the mirror problem — no outer deadline at all, so
raising the per-bank timeout 8s -> 12s let two banks spend 24s.

Acceptance guarantees (outcomes, not code paths):

  1. **The ceiling constant cannot drift from the shipped hook config.**
  2. **The transcript fallback spends at most what is left**, and declines
     entirely rather than gambling the hook when nothing is left.
  3. **The serial path clamps each bank to the remaining budget**, so N banks
     can no longer sum past the ceiling.

Stdlib-only (unittest).
"""

import builtins
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402

PLUGIN_ROOT = os.path.abspath(os.path.join(SCRIPTS_DIR, ".."))


class CeilingMatchesTheShippedHookConfig(unittest.TestCase):
    def test_hook_ceiling_matches_hooks_json(self):
        """`HOOK_CEILING_SECONDS` mirrors a value that lives in another file in
        this same package. Nothing at runtime reconciles them, so this test is
        the reconciliation: if someone retunes the UserPromptSubmit timeout, the
        budget arithmetic must move with it or every clamp here is wrong."""
        with open(os.path.join(PLUGIN_ROOT, "hooks", "hooks.json"), encoding="utf-8") as f:
            hooks = json.load(f)["hooks"]
        timeouts = [
            hook["timeout"]
            for entry in hooks["UserPromptSubmit"]
            for hook in entry["hooks"]
            if "recall.py" in hook.get("command", "")
        ]
        self.assertEqual(len(timeouts), 1, "expected exactly one recall.py UserPromptSubmit hook")
        self.assertEqual(float(timeouts[0]), recall.HOOK_CEILING_SECONDS)

    def test_reserve_leaves_the_shared_deadline_room(self):
        """The shared recall deadline plus the tail reserve must fit inside the
        ceiling, or a fully-elapsed recall breaches it before the fallback is
        even considered."""
        from lib.config import DEFAULTS

        self.assertLess(
            float(DEFAULTS["recallParallelDeadlineSeconds"]) + recall.HOOK_TAIL_RESERVE_SECONDS,
            recall.HOOK_CEILING_SECONDS,
        )


def _transcript(tmpdir, turns):
    path = os.path.join(tmpdir, "transcript.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for i, (role, text) in enumerate(turns):
            f.write(json.dumps({
                "type": role,
                "uuid": f"u-{i}",
                "message": {"role": role, "content": text},
            }) + "\n")
    return path


class FallbackSpendsOnlyWhatIsLeft(unittest.TestCase):
    """The flat 1.5s bound is now ``min(configured, remaining hook budget)``."""

    def setUp(self):
        recall._begin_hook_budget()
        self._tmpdir = tempfile.mkdtemp(prefix="recall-budget-test-")
        self._path = _transcript(self._tmpdir, [
            ("user", "the nginx TLS cert on the webkite container expired"),
            ("assistant", "I renewed the nginx TLS cert and redeployed webkite"),
        ])

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_declines_entirely_when_no_budget_remains(self):
        for budget in (0, -2500):
            block, telemetry = recall._transcript_grep_fallback(
                self._path, "nginx TLS cert webkite", {}, budget_ms=budget
            )
            self.assertIsNone(block, f"fallback ran with {budget}ms of budget")
            self.assertFalse(telemetry["fired"])

    def test_no_budget_means_no_transcript_read_at_all(self):
        """The decline has to happen BEFORE the work, not after. The grep reads
        up to `recallTranscriptFallbackMaxBytes` (256 KiB by default) off disk
        and parses it, and only then starts checking the deadline per turn — so
        relying on the in-loop deadline check to notice an exhausted budget
        still spends the read. With nothing left, nothing is opened."""
        opened = []
        real_open = builtins.open

        def _tracking_open(path, *args, **kwargs):
            opened.append(str(path))
            return real_open(path, *args, **kwargs)

        with patch.object(builtins, "open", _tracking_open):
            block, telemetry = recall._transcript_grep_fallback(
                self._path, "nginx TLS cert webkite", {}, budget_ms=0
            )
        self.assertIsNone(block)
        self.assertFalse(telemetry["fired"])
        self.assertEqual(
            [p for p in opened if p == self._path],
            [],
            "the transcript was read despite the hook budget being exhausted",
        )

    def test_a_healthy_budget_still_allows_the_fallback_to_fire(self):
        """The clamp must not become a permanent off switch — with the ceiling
        untouched the fallback behaves exactly as #3757 shipped it."""
        block, telemetry = recall._transcript_grep_fallback(
            self._path,
            "nginx TLS cert webkite",
            {},
            budget_ms=recall._remaining_hook_budget_seconds() * 1000.0,
        )
        self.assertTrue(telemetry["fired"], f"fallback did not fire: {telemetry}")
        self.assertIsNotNone(block)

    def test_budget_is_measured_from_this_invocation_not_process_lifetime(self):
        """Re-anchoring at main() is what makes the clamp correct in any process
        that runs the hook more than once. Without it the budget decays with
        process age and the fallback silently stops firing."""
        recall._begin_hook_budget()
        first = recall._remaining_hook_budget_seconds()
        time.sleep(0.05)
        stale = recall._remaining_hook_budget_seconds()
        self.assertLess(stale, first)
        recall._begin_hook_budget()
        self.assertGreater(recall._remaining_hook_budget_seconds(), stale)

    def test_import_cost_is_charged_against_the_ceiling(self):
        """`recall_start_monotonic` is taken well into main(), so budgeting from
        it ignores interpreter startup and import cost — the exact spend that
        made the flat 1.5s bound unsafe."""
        self.assertGreater(recall._IMPORT_ELAPSED_SECONDS, 0.0)
        recall._begin_hook_budget()
        self.assertLessEqual(
            recall._remaining_hook_budget_seconds(),
            recall.HOOK_CEILING_SECONDS
            - recall.HOOK_TAIL_RESERVE_SECONDS
            - recall._IMPORT_ELAPSED_SECONDS,
        )


class SerialPathCannotSumPastTheCeiling(unittest.TestCase):
    """`HINDSIGHT_RECALL_PARALLEL=false` has no shared deadline — bank latencies
    SUM. #3757 raised the per-bank timeout 8s -> 12s, which on that path meant
    two banks could spend 24s against a 12s ceiling. Each bank is now clamped to
    what the hook has left when its turn comes."""

    class _Client:
        def __init__(self):
            self.timeouts = []

        def list_directives(self, bank_id, active_only=True, timeout=2):
            return {"items": []}

        def recall(self, bank_id, query, **kwargs):
            self.timeouts.append(kwargs.get("timeout"))
            return {"results": []}

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-serial-budget-")
        self._env = {}
        self._env["CLAUDE_PLUGIN_DATA"] = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _run(self, client, remaining_seconds):
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "additionalBanks": ["second-bank"],
            "recallMaxTokens": 1024,
            "recallBudget": "low",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallTranscriptFallback": False,
            "recallRequestTimeoutSeconds": 12,
            # The rollback lever this test exists for.
            "recallParallel": False,
        }
        hook_input = {
            "prompt": "did the nginx TLS cert renewal land",
            "session_id": "serial-budget",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch.object(
            recall, "_remaining_hook_budget_seconds", return_value=remaining_seconds
        ), patch("sys.stdin", new=io.StringIO(json.dumps(hook_input))), patch(
            "sys.stdout", new=stdout
        ), patch("sys.stderr", new=stderr):
            recall.main()

    def test_bank_timeout_is_clamped_to_the_remaining_budget(self):
        client = self._Client()
        self._run(client, remaining_seconds=3.0)
        self.assertTrue(client.timeouts, "no bank was queried")
        for timeout in client.timeouts:
            self.assertLessEqual(
                timeout, 3.0, "a serial bank was allowed its full configured timeout"
            )

    def test_configured_timeout_still_applies_when_budget_is_ample(self):
        # The clamp is a ceiling, not a replacement: with the whole budget
        # available the operator's configured timeout is what binds.
        client = self._Client()
        self._run(client, remaining_seconds=60.0)
        self.assertTrue(client.timeouts)
        for timeout in client.timeouts:
            self.assertEqual(timeout, 12.0)

    def test_banks_are_skipped_once_the_budget_is_gone(self):
        client = self._Client()
        self._run(client, remaining_seconds=-1.0)
        self.assertEqual(
            client.timeouts, [], "a bank was queried with the hook ceiling already breached"
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
