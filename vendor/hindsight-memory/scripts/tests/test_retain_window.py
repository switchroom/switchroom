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
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from retain import run_retain, select_retain_window  # noqa: E402


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


def _human_msg(text: str) -> dict:
    return {"role": "user", "content": text}


def _tool_result_msg(tool_use_id: str, text: str) -> dict:
    # Claude Code emits tool results as role="user" with a content list of
    # tool_result blocks — exactly the shape read_transcript() produces.
    return {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": text}],
    }


def _assistant_msg(text: str) -> dict:
    return {"role": "assistant", "content": text}


def _contains_text(messages: list, needle: str) -> bool:
    for m in messages:
        c = m.get("content")
        if isinstance(c, str) and needle in c:
            return True
    return False


class SelectRetainWindowToolHeavyTurn(unittest.TestCase):
    """Finding 1 regression: tool_result messages are role="user" but are NOT
    human turns. A tool-heavy turn must not push the human's fact out of the
    window. These FAIL before the content.py boundary fix and pass after.
    """

    def test_tool_heavy_single_turn_keeps_human_fact_in_window(self):
        # One logical human turn: the fact, then 3 sequential tool rounds.
        # OLD boundary semantics count the 3 tool_result "user" messages as
        # 3 turns and slice them off — dropping the human fact. NEW semantics
        # count only the 1 human turn, so the whole (1 human-turn) transcript
        # is retained and the fact survives.
        fact = "my deploy token is DURABILITY_TOKEN_XYZ"
        messages = [
            _human_msg(fact),
            _assistant_msg("let me look that up"),
            _tool_result_msg("t1", "file a"),
            _assistant_msg("checking more"),
            _tool_result_msg("t2", "file b"),
            _assistant_msg("one more"),
            _tool_result_msg("t3", "file c"),
            _assistant_msg("here is your answer"),
        ]
        result, _ = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertTrue(
            _contains_text(result, "DURABILITY_TOKEN_XYZ"),
            "human fact fell outside the retain window on a tool-heavy turn "
            "(silent memory loss). Window was: "
            + repr([m.get("content") for m in result]),
        )

    def test_tool_heavy_current_turn_among_prior_human_turns(self):
        # Two prior human turns, then a tool-heavy current turn whose human
        # message carries the fact. window=3 human turns must include the
        # current turn's human message regardless of tool volume.
        fact = "the current fact is CURRENT_FACT_42"
        messages = [
            _human_msg("older turn 0"),
            _assistant_msg("a0"),
            _human_msg("older turn 1"),
            _assistant_msg("a1"),
            _human_msg(fact),
            _assistant_msg("looking"),
            _tool_result_msg("t1", "r1"),
            _assistant_msg("more"),
            _tool_result_msg("t2", "r2"),
            _assistant_msg("more"),
            _tool_result_msg("t3", "r3"),
            _assistant_msg("done"),
        ]
        result, _ = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2, all_messages=messages
        )
        self.assertTrue(_contains_text(result, "CURRENT_FACT_42"))
        # And the window is anchored to 3 HUMAN turns — so the oldest human
        # message ("older turn 0") is the window start.
        self.assertTrue(_contains_text(result, "older turn 0"))


class SelectRetainWindowForce(unittest.TestCase):
    """Finding 2: SessionEnd force=True widens chunked mode to full-session."""

    def test_force_retains_full_session_in_chunked_mode(self):
        messages = _transcript(10)  # turns 0..9
        result, full_window = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2,
            all_messages=messages, force=True,
        )
        # Forced sweep at SessionEnd retains everything, not just the window.
        self.assertEqual(_user_turn_indices(result), list(range(10)))
        self.assertEqual(len(result), len(messages))
        self.assertTrue(full_window)

    def test_no_force_still_windows_in_chunked_mode(self):
        # Guard: the force widening must not leak into normal per-turn fires.
        messages = _transcript(10)
        result, _ = select_retain_window(
            "chunked", retain_every_n=1, overlap_turns=2,
            all_messages=messages, force=False,
        )
        self.assertEqual(_user_turn_indices(result), [7, 8, 9])  # last 3 turns


class RunRetainStopHookActiveGuard(unittest.TestCase):
    """switchroom #2848 Phase 3 — blocked-Stop double-fire guard.

    When directive_verify.py blocks a Stop, the model continues and the Stop
    event fires AGAIN with ``stop_hook_active: true``. run_retain must no-op on
    that re-fire — no store, no increment_turn_count — so the same logical turn
    can't produce a duplicate transcript document or drift the cadence counter.
    """

    _CONFIG = {"autoRetain": True, "retainEveryNTurns": 10, "retainMode": "chunked"}

    def test_stop_hook_active_noops_no_store_no_increment(self):
        hook_input = {
            "session_id": "s1",
            "transcript_path": "/some/path.jsonl",
            "stop_hook_active": True,
        }
        with mock.patch("retain.load_config", return_value=self._CONFIG), \
                mock.patch("retain.increment_turn_count") as inc, \
                mock.patch("retain.read_transcript") as read_t, \
                mock.patch("retain.get_api_url") as get_url:
            result = run_retain(hook_input, force=False)
        # Early-return skip with the dedicated reason.
        self.assertEqual(result.get("status"), "skipped")
        self.assertEqual(result.get("reason"), "stop_hook_active")
        # No cadence increment, no transcript read, no API resolution/store.
        inc.assert_not_called()
        read_t.assert_not_called()
        get_url.assert_not_called()

    def test_first_stop_not_guarded(self):
        # The FIRST Stop (no stop_hook_active) must NOT be short-circuited by
        # this guard — it proceeds into normal retain flow (which we stub out
        # right after the guard by making the transcript empty).
        hook_input = {
            "session_id": "s2",
            "transcript_path": "/some/path.jsonl",
            "stop_hook_active": False,
        }
        with mock.patch("retain.load_config", return_value=self._CONFIG), \
                mock.patch("retain.read_transcript", return_value=[]) as read_t:
            result = run_retain(hook_input, force=False)
        # Got past the guard into the flow — proven by the transcript read.
        read_t.assert_called_once()
        self.assertEqual(result.get("status"), "skipped")
        self.assertEqual(result.get("reason"), "empty transcript")

    def test_forced_session_end_sweep_exempt_from_guard(self):
        # A forced (SessionEnd) sweep is a distinct hook event and must always
        # flush even if stop_hook_active happens to be set — the guard is
        # gated on `not force`.
        hook_input = {
            "session_id": "s3",
            "transcript_path": "/some/path.jsonl",
            "stop_hook_active": True,
        }
        with mock.patch("retain.load_config", return_value=self._CONFIG), \
                mock.patch("retain.read_transcript", return_value=[]) as read_t:
            result = run_retain(hook_input, force=True)
        # force=True bypasses the stop_hook_active guard → reaches transcript read.
        read_t.assert_called_once()
        self.assertEqual(result.get("reason"), "empty transcript")


if __name__ == "__main__":
    unittest.main()
