"""Switchroom #2848 Stage B — unit tests for the directive-capture nudge.

Stage A audit measured a ~55% miss rate on durable corrections: agents are
told (guidance-only) to persist standing rules with
`mcp__hindsight__create_directive`, but capture is a per-agent lottery. Stage B
adds DETERMINISTIC (regex) detection of correction / standing-rule-shaped
inbound in recall.py's UserPromptSubmit hook and appends a terse advisory nudge
to the turn's additionalContext — the model does the actual judgment in-session
(no model callsite; claude-native invariant).

These tests pin:
  * True positives — the audit's real MISSES + the issue's listed shapes.
  * True negatives — pleasantries and questions must NOT fire (guard against
    "always happy to help" / "never mind" tripping the bare always/never).
  * The nudge is APPENDED to context without disturbing recall output
    (_combine_context), and the nudge string is the create_directive advisory.
  * The trivial-stateless recall gate is unaffected — a correction is never
    trivial-skipped, and greetings still are (no regression on recall.py:582).

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from recall import (  # noqa: E402
    _DIRECTIVE_CAPTURE_NUDGE,
    _combine_context,
    _is_trivial_stateless,
    looks_like_standing_rule,
)


# Correction / standing-rule-shaped inbound that MUST fire the nudge.
# The first block is drawn verbatim (paraphrased) from Stage A's clear MISSES
# — the exact corrections the guidance-only path silently dropped.
CORRECTIONS = [
    # --- Stage A clear misses ---
    "you should always hyperlink linear issues when mentioning",
    "i also want you to always provide a direct link to open the email",
    "i want this behaviour of validate, dont assume as a general agent behaviour",
    "don't make stuff up, investigate and validate",
    "validate not assume, don't guess",
    "We shouldn't publish confidential Buildkite data, so don't use names",
    "The repo mekenthompson/switchroom is closed/dead. We use only switchroom/switchroom now",
    # --- Stage A true captures (must also detect — the loop should fire on these) ---
    "i never use them",
    "We don't use streaming reply anymore",
    "i always want you to help better format articles for readability",
    # --- the issue's listed standing-rule shapes ---
    "from now on, prefer British spelling",
    "going forward, use GFM syntax",
    "call me Ken, not Kenneth",
    "stop doing that",
    "stop using em-dashes",
    "don't do that again",
    "remember to close the loop with a summary",
    "make sure you cite the file and line",
    "make sure not to leak the token",
    "no, it's actually the blue one",
    "that's wrong",
    "that's not what I asked for",
    "I'd prefer you keep replies short",
    "we prefer concise answers",
    "in the future, ping me before deploying",
]

# Pleasantries, one-off questions, acks — must NOT fire (false positives cost
# tokens + noise; the negative guard scrubs pleasantry shapes first).
NON_CORRECTIONS = [
    "always happy to help!",
    "I'm always glad to assist",
    "never mind, forget it",
    "nevermind that",
    "thanks as always",
    "as always, appreciate it",
    "can you check the deploy status",
    "what time is it",
    "how do I fix this bug",
    "tell me about the project",
    "the CI issue is now closed",  # 'closed' alone, not "it's/that's closed"
    "please run the tests",
    "what's the weather like",
    # The <channel …> envelope wrapper on its own must never trigger.
    '<channel user="ken" chat_id="123">',
]


class TestDirectiveCaptureDetection(unittest.TestCase):
    def test_corrections_fire_the_nudge(self):
        for p in CORRECTIONS:
            with self.subTest(prompt=p):
                self.assertTrue(
                    looks_like_standing_rule(p),
                    f"expected standing-rule detection for {p!r}",
                )

    def test_pleasantries_and_questions_do_not_fire(self):
        for p in NON_CORRECTIONS:
            with self.subTest(prompt=p):
                self.assertFalse(
                    looks_like_standing_rule(p),
                    f"FALSE POSITIVE: nudge would fire for {p!r}",
                )

    def test_empty_and_non_string_are_false(self):
        for bad in ("", "   ", None, 123, [], {}):
            with self.subTest(value=bad):
                self.assertFalse(looks_like_standing_rule(bad))

    def test_pleasantry_scrub_does_not_mask_a_real_rule(self):
        # A message that opens with a pleasantry AND states a real rule must
        # still fire — the negative guard scrubs only the pleasantry span.
        self.assertTrue(
            looks_like_standing_rule(
                "always happy to help — but from now on use British spelling"
            )
        )
        self.assertTrue(
            looks_like_standing_rule("never mind that, but always cite the file")
        )


class TestNudgeAppendedWithoutDisturbingRecall(unittest.TestCase):
    def test_nudge_string_is_the_create_directive_advisory(self):
        self.assertIn("create_directive", _DIRECTIVE_CAPTURE_NUDGE)
        self.assertIn("directive_capture_check", _DIRECTIVE_CAPTURE_NUDGE)

    def test_combine_appends_nudge_after_recall_block(self):
        base = "<hindsight_memories>\n…\n</hindsight_memories>"
        out = _combine_context(base, _DIRECTIVE_CAPTURE_NUDGE)
        # Recall block preserved verbatim, nudge appended after it.
        self.assertTrue(out.startswith(base))
        self.assertTrue(out.endswith(_DIRECTIVE_CAPTURE_NUDGE))
        self.assertIn(base + "\n\n", out)

    def test_combine_with_no_nudge_leaves_recall_output_untouched(self):
        base = "<hindsight_memories>\n…\n</hindsight_memories>"
        self.assertEqual(_combine_context(base, None), base)

    def test_combine_with_only_nudge_emits_nudge_alone(self):
        self.assertEqual(
            _combine_context("", _DIRECTIVE_CAPTURE_NUDGE), _DIRECTIVE_CAPTURE_NUDGE
        )
        self.assertEqual(
            _combine_context(None, _DIRECTIVE_CAPTURE_NUDGE), _DIRECTIVE_CAPTURE_NUDGE
        )

    def test_combine_empty_is_empty(self):
        self.assertEqual(_combine_context(None, None), "")
        self.assertEqual(_combine_context("", ""), "")


class TestTrivialSkipUnaffected(unittest.TestCase):
    """The nudge must not perturb the trivial-stateless recall gate
    (recall.py:582). Corrections carry standing-rule signals and are never
    stateless, so they must NOT be trivial-skipped; greetings still are."""

    def test_corrections_are_never_trivial_skipped(self):
        for p in CORRECTIONS:
            with self.subTest(prompt=p):
                self.assertFalse(
                    _is_trivial_stateless("", p),
                    f"correction {p!r} was trivial-skipped — recall gate regressed",
                )

    def test_greetings_still_trivial_skip(self):
        for p in ("hi", "hello", "what time is it", "good morning"):
            with self.subTest(prompt=p):
                self.assertTrue(_is_trivial_stateless("", p))


if __name__ == "__main__":
    unittest.main()
