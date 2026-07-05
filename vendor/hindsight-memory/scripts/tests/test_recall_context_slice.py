"""Switchroom follow-up to #2830 — recall-side coverage of the tool-boundary
slice fix.

#2830 fixed silent-memory-loss in ``slice_last_turns_by_user_boundary``:
Claude Code emits tool results as ``role="user"`` messages, and the old
boundary counter treated each one as a turn. A tool-heavy turn (>=N sequential
tool rounds) could therefore fill a fixed-size window with tool_result
pseudo-turns and push the real human message OUTSIDE it.

That same slice function backs TWO call sites:
  1. the RETAIN window (covered by ``test_retain_window.py``), and
  2. the RECALL context slice, via ``compose_recall_query``.

#2830 shipped a test only for the retain path. This file closes the reviewer
nit by exercising the RECALL path end-to-end over a tool-heavy transcript:
the composed recall query must still carry the real human turn's text and must
not be truncated at the tool_result pseudo-boundaries.

These tests FAIL if the ``_is_tool_result_only_user_message`` guard is reverted
(the tool_result messages become boundaries again and the human turn is sliced
off), and pass with the guard in place.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.content import compose_recall_query  # noqa: E402


def _human_msg(text: str) -> dict:
    return {"role": "user", "content": text}


def _assistant_msg(text: str) -> dict:
    return {"role": "assistant", "content": text}


def _tool_result_msg(tool_use_id: str, text: str) -> dict:
    # Claude Code emits tool results as role="user" with a content list of
    # tool_result blocks — exactly the shape read_transcript() produces.
    return {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": text}],
    }


class ComposeRecallQueryToolHeavyTurn(unittest.TestCase):
    """The recall context slice must count HUMAN turns, not tool_result
    pseudo-turns — otherwise a tool-heavy turn drops the human's text from the
    recall query, so recall searches on the tool output instead of what the
    human actually said.
    """

    def test_tool_heavy_prior_turn_keeps_human_text_in_recall_context(self):
        # A prior human turn stating a fact, then 3 sequential tool rounds,
        # then the assistant answer. The current (latest) query is separate.
        # recall_context_turns=2 asks for the latest turn + one prior HUMAN
        # turn. OLD boundary semantics count the 3 tool_result "user" messages
        # as turns and never reach the human fact; NEW semantics skip them and
        # anchor to the real human turn, so its text lands in "Prior context:".
        prior_fact = "my prod database is called ORCHID_PRIMARY"
        messages = [
            _human_msg(prior_fact),
            _assistant_msg("let me look that up"),
            _tool_result_msg("t1", "queried schema table 1"),
            _assistant_msg("checking more"),
            _tool_result_msg("t2", "queried schema table 2"),
            _assistant_msg("one more"),
            _tool_result_msg("t3", "queried schema table 3"),
            _assistant_msg("here is your schema"),
        ]
        result = compose_recall_query(
            "what port does it listen on",
            messages,
            recall_context_turns=2,
        )
        self.assertIn("Prior context:", result)
        self.assertIn(
            "ORCHID_PRIMARY",
            result,
            "human turn text was sliced out of the recall context by the "
            "tool_result pseudo-boundaries (recall-side silent memory loss). "
            "Composed query was: " + repr(result),
        )
        # The tool_result content must NOT leak in as if it were a human turn.
        self.assertNotIn("queried schema table", result)

    def test_recall_context_anchors_to_human_turns_across_tool_volume(self):
        # Two prior human turns, the older one carrying a fact, each turn
        # followed by tool rounds. recall_context_turns=3 (latest + 2 prior
        # HUMAN turns) must reach back past ALL the tool_result messages to the
        # oldest human turn — tool volume must not consume the turn budget.
        oldest_fact = "the deploy key is FALCON_9_KEY"
        messages = [
            _human_msg(oldest_fact),
            _assistant_msg("looking"),
            _tool_result_msg("t1", "tool output alpha"),
            _assistant_msg("more"),
            _tool_result_msg("t2", "tool output beta"),
            _human_msg("and remind me of the region too"),
            _assistant_msg("checking region"),
            _tool_result_msg("t3", "tool output gamma"),
            _assistant_msg("region is ap-southeast-2"),
        ]
        result = compose_recall_query(
            "put those together for me",
            messages,
            recall_context_turns=3,
        )
        self.assertIn("Prior context:", result)
        # Both prior HUMAN turns survive; the oldest human fact is reached.
        self.assertIn("FALCON_9_KEY", result)
        self.assertIn("and remind me of the region too", result)
        # No tool_result payload masquerades as human context.
        self.assertNotIn("tool output", result)


if __name__ == "__main__":
    unittest.main()
