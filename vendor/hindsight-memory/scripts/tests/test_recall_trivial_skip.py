"""Switchroom Phase 6a — unit tests for recall.py's trivial-stateless skip.

`_is_trivial_stateless` gates the auto-recall hook: it returns True only
for prompts that provably never need user memory (current time/date/day,
bare greetings), so the ~1-2s recall arm + ~1024 injected tokens are
skipped on those turns. The load-bearing property is the NO-FALSE-NEGATIVE
guarantee: a prompt that could need memory must never be skipped, because
skipping it would breach the remember-across-sessions continuity job. The
KEEP corpus below is that no-regression gate.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from recall import _is_trivial_stateless  # noqa: E402


# Prompts that provably never need user/session memory — safe to skip.
TRIVIAL = [
    "what time is it",
    "what time is it?",
    "what time is it now",
    "what's the time",
    "time?",
    "current time",
    "what's the date",
    "whats the date",
    "what's today's date",
    "what day is it",
    "what day is it?",
    "what day is it today",
    "what day of the week is it",
    "hi",
    "hello",
    "hey",
    "hey there",
    "good morning",
    "morning",
]

# Prompts that depend on (or might depend on) stored user/project/session
# state — must NEVER be skipped. This is the no-regression gate.
NEEDS_MEMORY = [
    "what host am I on?",          # reads trivial, but needs memory — the "i" trap
    "what's my config",
    "what was I frustrated about",
    "remind me what we discussed",
    "what's the date for my deadline",   # has 'my'
    "what's the date of our last deploy",  # 'our'/'last'/'deploy'
    "what projects do I have",
    "do you remember my preference",
    "what's the status of the deploy",
    "summarize our last conversation",
    "hello, can you check my open items",  # greeting + real ask
    "what time did I say the meeting was",  # 'time' but 'i'/'say'
    "what should I work on",
    "tell me about the project",
    "what's the weather",          # stateless-ish but not in the time/date set → recall anyway
    "how do I fix this",
]


class TestTrivialStatelessSkip(unittest.TestCase):
    def test_trivial_prompts_are_skipped(self):
        for p in TRIVIAL:
            with self.subTest(prompt=p):
                self.assertTrue(
                    _is_trivial_stateless("", p),
                    f"expected trivial/stateless skip for {p!r}",
                )

    def test_memory_prompts_are_never_skipped(self):
        # The critical safety invariant — zero false negatives.
        for p in NEEDS_MEMORY:
            with self.subTest(prompt=p):
                self.assertFalse(
                    _is_trivial_stateless("", p),
                    f"FALSE NEGATIVE: would skip recall for {p!r} which may need memory",
                )

    def test_empty_and_whitespace_do_not_skip_here(self):
        # The <5-char / empty guards live earlier in main(); the classifier
        # itself returns False for empty so it never short-circuits oddly.
        self.assertFalse(_is_trivial_stateless("", ""))
        self.assertFalse(_is_trivial_stateless("", "   "))

    def test_personal_pronoun_blocks_skip(self):
        # Even a time question is kept the moment a stateful token appears.
        self.assertTrue(_is_trivial_stateless("", "what time is it"))
        self.assertFalse(_is_trivial_stateless("", "what time is it for my call"))


if __name__ == "__main__":
    unittest.main()
