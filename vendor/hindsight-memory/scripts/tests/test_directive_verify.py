"""Switchroom #2848 Stage C — unit tests for the Stop-hook directive verify.

Stage B (recall.py) nudges the model to persist a durable rule but still
relies on the model CHOOSING to call create_directive. Stage C
(directive_verify.py) closes the residual gap for the high-confidence case:
on Stop it re-checks the human turn against a NARROW durable-rule regex and,
if the turn stated a durable rule but recorded no create_directive call,
blocks the stop ONCE to re-prompt capture.

These tests pin:
  * The high-precision durable detector — explicit standing-rule framings
    fire; bare "always"/"stop …"/"don't …" and one-off requests do NOT
    (the detector is a STRICT SUBSET of Stage B's inclusive one).
  * Pleasantry scrub is inherited (Stage B negative guard).
  * Transcript parsing — last human turn is isolated (tool_result-only and
    injected recall/nudge blocks are skipped), and a create_directive
    tool_use anywhere after it counts as captured.
  * evaluate() end-to-end: block iff durable-rule-stated AND no directive
    call AND feature on AND not stop_hook_active (loop guard).
  * The block reason is the create_directive re-prompt with a one-off escape.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from directive_verify import (  # noqa: E402
    _VERIFY_BLOCK_REASON,
    directive_recorded_after,
    evaluate,
    find_last_human_turn,
    looks_like_durable_directive,
)
from recall import looks_like_standing_rule  # noqa: E402


# Explicit durable standing-rule framings that MUST fire the verify block.
DURABLE_POSITIVES = [
    "From now on, use British spelling in everything you write.",
    "Going forward, never open a PR without a test plan.",
    "In the future, always run the linter before you commit.",
    "As a rule, keep replies under three sentences.",
    "As a general policy, don't tag me on weekends.",
    "You should always cite the file path when you quote code.",
    "You should never push directly to main.",
    "You must never ping the whole channel.",
    "I want you to always double-check the branch name first.",
    "Please always address me formally.",
    "Please never use em dashes.",
    "I'd prefer you keep the summaries terse.",
    "I prefer that you use tabs, not spaces.",
    "Call me Ken, not Kenneth.",
    "Remember to always sign off with my initials.",
    "Remember that I'm on Sydney time.",
    "Don't ever guess at config values again.",
]

# Shapes that MUST NOT fire the verify block. Either genuine one-offs, or the
# inclusive-but-not-durable shapes Stage B nudges on but Stage C must not
# block on (bare always/never/stop without a standing frame), or pleasantries.
DURABLE_NEGATIVES = [
    # one-off task requests
    "Can you fix the failing test in auth.py?",
    "Please deploy the staging branch now.",
    "What's the status of the build?",
    "Add a docstring to this function.",
    "Run the tests and tell me what breaks.",
    # inclusive-but-not-durable (Stage B may nudge, Stage C must not block):
    # bare always/never/stop/don't and world-fact corrections carry too much
    # one-off risk for a blocking re-prompt.
    "always double-check that number for me here",
    "stop the server so I can restart it",
    "stop using that deprecated endpoint for this test",
    "don't merge that yet, I'm still reviewing",
    "that's wrong, the port is 8080",
    "no longer needed for this one file, skip it",
    "we don't use Jenkins anymore; it's all GitHub Actions now",
    # pleasantries (shared negative scrub)
    "always happy to help, thanks!",
    "never mind, I figured it out.",
    "as always, appreciate the quick turnaround.",
    "thanks as always!",
    # empty / junk
    "",
    "   ",
    "ok",
]


class TestDurableDetector(unittest.TestCase):
    def test_positives_fire(self):
        for text in DURABLE_POSITIVES:
            with self.subTest(text=text):
                self.assertTrue(
                    looks_like_durable_directive(text),
                    f"expected durable-rule detection to FIRE on: {text!r}",
                )

    def test_negatives_do_not_fire(self):
        for text in DURABLE_NEGATIVES:
            with self.subTest(text=text):
                self.assertFalse(
                    looks_like_durable_directive(text),
                    f"expected durable-rule detection NOT to fire on: {text!r}",
                )

    def test_non_string_input(self):
        for bad in (None, 123, [], {}, object()):
            self.assertFalse(looks_like_durable_directive(bad))

    def test_durable_is_subset_of_standing_rule(self):
        # Every high-confidence durable positive must ALSO be caught by Stage
        # B's inclusive detector — Stage C never blocks on something Stage B
        # wouldn't have nudged on.
        for text in DURABLE_POSITIVES:
            with self.subTest(text=text):
                self.assertTrue(
                    looks_like_standing_rule(text),
                    f"durable positive not a subset of standing_rule: {text!r}",
                )


class TestTranscriptParsing(unittest.TestCase):
    def test_find_last_human_turn_plain_string(self):
        msgs = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "from now on use tabs"},
        ]
        idx, text = find_last_human_turn(msgs)
        self.assertEqual(idx, 2)
        self.assertEqual(text, "from now on use tabs")

    def test_skips_tool_result_only_user_message(self):
        msgs = [
            {"role": "user", "content": "from now on use tabs"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "name": "Bash", "input": {}}],
            },
            {
                "role": "user",
                "content": [{"type": "tool_result", "content": "done"}],
            },
        ]
        idx, text = find_last_human_turn(msgs)
        self.assertEqual(idx, 0)
        self.assertEqual(text, "from now on use tabs")

    def test_skips_injected_recall_block(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            {
                "role": "user",
                "content": "<hindsight_memories>old stuff</hindsight_memories>",
            },
        ]
        idx, text = find_last_human_turn(msgs)
        self.assertEqual(idx, 0)
        self.assertEqual(text, "call me Ken")

    def test_extracts_text_from_list_content(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "as a rule, keep it terse"},
                ],
            }
        ]
        idx, text = find_last_human_turn(msgs)
        self.assertEqual(idx, 0)
        self.assertEqual(text, "as a rule, keep it terse")

    def test_no_human_turn(self):
        msgs = [{"role": "assistant", "content": "hi"}]
        idx, text = find_last_human_turn(msgs)
        self.assertIsNone(idx)
        self.assertEqual(text, "")


class TestDirectiveDetection(unittest.TestCase):
    def _mk(self, name):
        return {
            "role": "assistant",
            "content": [{"type": "tool_use", "name": name, "input": {}}],
        }

    def test_detects_mcp_create_directive(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk("mcp__hindsight__create_directive"),
        ]
        self.assertTrue(directive_recorded_after(msgs, 0))

    def test_detects_bare_create_directive(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk("create_directive"),
        ]
        self.assertTrue(directive_recorded_after(msgs, 0))

    def test_ignores_other_tools(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk("mcp__hindsight__recall"),
            self._mk("Bash"),
        ]
        self.assertFalse(directive_recorded_after(msgs, 0))

    def test_only_counts_calls_after_index(self):
        # A create_directive from an EARLIER turn does not count for this one.
        msgs = [
            self._mk("mcp__hindsight__create_directive"),
            {"role": "user", "content": "call me Ken"},
            {"role": "assistant", "content": "sure"},
        ]
        self.assertFalse(directive_recorded_after(msgs, 1))


class TestEvaluate(unittest.TestCase):
    ON = {"directiveCaptureNudge": True}

    def _hook(self, messages, transcript_path, stop_hook_active=False):
        return {
            "transcript_path": transcript_path,
            "stop_hook_active": stop_hook_active,
        }

    def _write_transcript(self, messages):
        import json
        import tempfile

        fd, path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for m in messages:
                f.write(json.dumps({"type": m["role"], "message": m}) + "\n")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        return path

    def test_blocks_on_durable_rule_without_directive(self):
        msgs = [
            {"role": "user", "content": "From now on, always use British spelling."},
            {"role": "assistant", "content": "Got it, will do."},
        ]
        path = self._write_transcript(msgs)
        reason = evaluate(self._hook(msgs, path), self.ON)
        self.assertEqual(reason, _VERIFY_BLOCK_REASON)

    def test_allows_when_directive_recorded(self):
        msgs = [
            {"role": "user", "content": "From now on, always use British spelling."},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "mcp__hindsight__create_directive",
                        "input": {"text": "Always use British spelling."},
                    }
                ],
            },
        ]
        path = self._write_transcript(msgs)
        self.assertIsNone(evaluate(self._hook(msgs, path), self.ON))

    def test_allows_on_one_off_request(self):
        msgs = [
            {"role": "user", "content": "Please fix the failing test in auth.py."},
            {"role": "assistant", "content": "Fixed."},
        ]
        path = self._write_transcript(msgs)
        self.assertIsNone(evaluate(self._hook(msgs, path), self.ON))

    def test_allows_when_feature_disabled(self):
        msgs = [
            {"role": "user", "content": "From now on, always use British spelling."},
            {"role": "assistant", "content": "Got it."},
        ]
        path = self._write_transcript(msgs)
        reason = evaluate(self._hook(msgs, path), {"directiveCaptureNudge": False})
        self.assertIsNone(reason)

    def test_loop_guard_does_not_reblock(self):
        # Already blocked once this turn → respect model judgment, never loop.
        msgs = [
            {"role": "user", "content": "From now on, always use British spelling."},
            {"role": "assistant", "content": "Got it."},
        ]
        path = self._write_transcript(msgs)
        reason = evaluate(
            self._hook(msgs, path, stop_hook_active=True), self.ON
        )
        self.assertIsNone(reason)

    def test_empty_transcript_allows(self):
        self.assertIsNone(evaluate(self._hook([], "/nonexistent/path.jsonl"), self.ON))

    def test_never_raises_on_garbage(self):
        # Defensive: evaluate must degrade to None, never raise.
        self.assertIsNone(evaluate({}, self.ON))


class TestBlockReason(unittest.TestCase):
    def test_reason_mentions_create_directive_and_escape_hatch(self):
        self.assertIn("create_directive", _VERIFY_BLOCK_REASON)
        self.assertIn("one-off", _VERIFY_BLOCK_REASON)
        self.assertIn("<directive_capture_verify>", _VERIFY_BLOCK_REASON)


if __name__ == "__main__":
    unittest.main()
