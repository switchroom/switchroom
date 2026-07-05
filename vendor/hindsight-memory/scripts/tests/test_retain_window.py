"""Switchroom Phase 6b — unit tests for retain.py's window selection.

`select_retain_window()` decides WHAT to retain once a Stop-hook fire
happens (the throttle, which decides WHETHER to fire, is separate and
untouched here). Phase 6b decouples the chunked sliding-window from the
`retainEveryNTurns > 1` gate so chunked mode works at
`retainEveryNTurns=1` — switchroom's every-turn crash-durability setting.

The load-bearing property is DURABILITY: with every-turn firing, the
window must always include the turn that just completed, so a fact told
in a ≤2-turn session survives a restart (the jtbd-memory-survives-restart
UAT). Because the window always extends to the END of the transcript, the
just-completed turn is always inside it.

Stdlib-only; runs under `python3 -m unittest discover tests/`.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from retain import select_retain_window  # noqa: E402


def _transcript(num_turns: int) -> list:
    """Build a transcript of `num_turns` user/assistant turns.

    Each turn = one user message followed by one assistant message. The
    text encodes the turn index so slices can be identified precisely.
    """
    messages = []
    for i in range(num_turns):
        messages.append({"role": "user", "content": f"user turn {i}"})
        messages.append({"role": "assistant", "content": f"assistant turn {i}"})
    return messages


def _user_turn_indices(messages: list) -> list:
    """Return the turn indices present in a sliced message list."""
    return [
        int(m["content"].split()[-1])
        for m in messages
        if m.get("role") == "user"
    ]


class SelectRetainWindowChunkedEveryTurn(unittest.TestCase):
    """The Phase 6b behaviour: chunked slicing works at retain_every_n=1."""

    def test_chunked_n1_slices_recent_window_not_full_session(self):
        # n=1, overlap=2 -> window = max(1,1)+2 = 3 recent turns.
        messages = _transcript(5)  # turns 0..4
        result, full_window = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        # Only the last 3 turns, NOT all 5 — this is the cost fix.
        self.assertEqual(_user_turn_indices(result), [2, 3, 4])
        self.assertLess(len(result), len(messages))
        self.assertTrue(full_window)

    def test_chunked_n1_window_always_includes_the_just_completed_turn(self):
        # DURABILITY: the newest turn (highest index) must be in the window.
        for total in (1, 2, 3, 4, 10, 50):
            messages = _transcript(total)
            result, _ = select_retain_window(
                "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
            )
            newest = total - 1
            self.assertIn(
                newest,
                _user_turn_indices(result),
                f"newest turn {newest} missing from window (total={total})",
            )
            # Window always extends to the very end of the transcript.
            self.assertEqual(result[-1], messages[-1])

    def test_single_turn_session_retains_that_turn(self):
        # The restart-survival case: a 1-turn session. Window (3) exceeds
        # available turns, so the whole (1-turn) transcript is retained.
        messages = _transcript(1)
        result, full_window = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertEqual(_user_turn_indices(result), [0])
        self.assertEqual(result, messages)
        self.assertTrue(full_window)

    def test_two_turn_session_retains_both_turns(self):
        # The exact jtbd shape: fact told in turn 0, one more turn, restart.
        messages = _transcript(2)
        result, _ = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertEqual(_user_turn_indices(result), [0, 1])


class SelectRetainWindowNoRegression(unittest.TestCase):
    """The n>1 chunked path and the full-session path must be unchanged."""

    def test_chunked_n_gt_1_window_is_n_plus_overlap(self):
        # n=10, overlap=2 -> window = 12 turns, identical to the pre-Phase-6b
        # `retain_every_n + overlap_turns` formula (max(10,1)==10).
        messages = _transcript(20)  # turns 0..19
        result, full_window = select_retain_window(
            "chunked", retain_every_n=10, overlap_turns=2, all_messages=messages
        )
        self.assertEqual(_user_turn_indices(result), list(range(8, 20)))  # last 12
        self.assertTrue(full_window)

    def test_chunked_zero_overlap(self):
        # n=1, overlap=0 -> window = 1 (just the current turn).
        messages = _transcript(5)
        result, _ = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=0, all_messages=messages
        )
        self.assertEqual(_user_turn_indices(result), [4])

    def test_full_session_retains_all_regardless_of_n(self):
        messages = _transcript(7)
        for n in (1, 5, 10):
            result, full_window = select_retain_window(
                "full-session", retain_every_n=n, overlap_turns=2, all_messages=messages
            )
            self.assertEqual(_user_turn_indices(result), list(range(7)))
            self.assertEqual(len(result), len(messages))
            self.assertTrue(full_window)

    def test_unknown_mode_falls_back_to_full_session(self):
        messages = _transcript(4)
        result, full_window = select_retain_window(
            "something-else", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertEqual(len(result), len(messages))
        self.assertTrue(full_window)

    def test_returns_a_copy_not_the_same_list_for_full_session(self):
        # select_retain_window returns list(all_messages) for full-session,
        # so mutating the result can't corrupt the caller's transcript.
        messages = _transcript(2)
        result, _ = select_retain_window(
            "full-session", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertIsNot(result, messages)


if __name__ == "__main__":
    unittest.main()
