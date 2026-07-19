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
import unittest.mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from directive_verify import (  # noqa: E402
    _VERIFY_BLOCK_REASON,
    _is_directive_write_tool,
    directive_recorded_after,
    evaluate,
    find_last_human_turn,
    invalidate_cache_on_directive_write,
    is_synthetic_inbound,
    looks_like_durable_directive,
    turn_contains_directive_write,
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

    def _mk_id(self, name, tid):
        return {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": tid, "name": name, "input": {}}
            ],
        }

    def _result(self, tid, is_error):
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tid,
                    "is_error": is_error,
                    "content": "boom" if is_error else "ok",
                }
            ],
        }

    def test_errored_create_directive_is_not_recorded(self):
        # SWITCHROOM DIVERGENCE #2903 Fix 1.3: a create_directive whose result
        # errored must NOT count as recorded, so the verifier re-prompts once.
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk_id("mcp__hindsight__create_directive", "toolu_1"),
            self._result("toolu_1", True),
        ]
        self.assertFalse(directive_recorded_after(msgs, 0))

    def test_successful_create_directive_with_result_is_recorded(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk_id("mcp__hindsight__create_directive", "toolu_1"),
            self._result("toolu_1", False),
        ]
        self.assertTrue(directive_recorded_after(msgs, 0))

    def test_one_failed_one_successful_directive_is_recorded(self):
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk_id("mcp__hindsight__create_directive", "toolu_1"),
            self._result("toolu_1", True),
            self._mk_id("mcp__hindsight__create_directive", "toolu_2"),
            self._result("toolu_2", False),
        ]
        self.assertTrue(directive_recorded_after(msgs, 0))

    def test_call_without_id_still_counts_as_attempt(self):
        # Older/testing shape with no tool_use id has no pairable result.
        msgs = [
            {"role": "user", "content": "call me Ken"},
            self._mk("mcp__hindsight__create_directive"),
        ]
        self.assertTrue(directive_recorded_after(msgs, 0))


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

    # --- #2903 Fix 6.2: verify-knob split + directive dedup ------------------

    def test_verify_knob_off_keeps_nudge_but_drops_block(self):
        # directiveCaptureNudge on (Stage B still nudges) but
        # directiveCaptureVerify off → the Stop block must NOT fire.
        msgs = [
            {"role": "user", "content": "From now on, always use British spelling."},
            {"role": "assistant", "content": "Got it."},
        ]
        path = self._write_transcript(msgs)
        cfg = {"directiveCaptureNudge": True, "directiveCaptureVerify": False}
        self.assertIsNone(evaluate(self._hook(msgs, path), cfg))
        # Sanity: with the knob left default (on) the same turn DOES block.
        self.assertEqual(evaluate(self._hook(msgs, path), self.ON), _VERIFY_BLOCK_REASON)

    def test_allows_when_rule_already_an_active_directive(self):
        # The turn restates a rule that is ALREADY in the injected
        # <active_directives> block; the model correctly declines to re-create
        # it. The verifier must NOT block (dedup).
        active_block = (
            "<active_directives>\n"
            "The following are HARD RULES the agent must follow on this turn.\n\n"
            "1. [P10] spelling: Always use British spelling in all replies.\n"
            "</active_directives>"
        )
        msgs = [
            {"role": "user", "content": active_block},
            {"role": "user", "content": "From now on, always use British spelling please."},
            {"role": "assistant", "content": "That's already how I write — noted."},
        ]
        path = self._write_transcript(msgs)
        self.assertIsNone(evaluate(self._hook(msgs, path), self.ON))

    def test_blocks_when_active_directive_is_a_different_rule(self):
        # An unrelated active directive must NOT suppress the block for a new
        # durable rule.
        active_block = (
            "<active_directives>\n"
            "The following are HARD RULES the agent must follow on this turn.\n\n"
            "1. [P10] tz: Always show times in UTC.\n"
            "</active_directives>"
        )
        msgs = [
            {"role": "user", "content": active_block},
            {"role": "user", "content": "From now on, always use British spelling."},
            {"role": "assistant", "content": "Got it."},
        ]
        path = self._write_transcript(msgs)
        self.assertEqual(evaluate(self._hook(msgs, path), self.ON), _VERIFY_BLOCK_REASON)


class TestSyntheticInbound(unittest.TestCase):
    """Non-interactive turns (cron / synthesized inbounds) must never trip the
    blocking directive re-prompt — they aren't human corrections.
    """

    def test_cron_source_is_synthetic(self):
        self.assertTrue(
            is_synthetic_inbound('<channel source="cron">Time for the daily digest.</channel>')
        )

    def test_various_synthetic_sources(self):
        for src in (
            "cron",
            "reaction",
            "resume_interrupted",
            "resume_watchdog_timeout",
            "vault_grant_approved",
            "subagent_handback",
            "obligation_represent",
        ):
            with self.subTest(src=src):
                self.assertTrue(
                    is_synthetic_inbound(f'<channel source="{src}" foo="bar">body</channel>')
                )

    def test_self_closing_synthetic_source(self):
        self.assertTrue(is_synthetic_inbound('<channel source="reaction"/>'))

    def test_telegram_source_is_human(self):
        self.assertFalse(
            is_synthetic_inbound('<channel source="telegram" chat_id="1" user="ken">hi</channel>')
        )

    def test_no_envelope_is_human(self):
        # Interactive session: no channel envelope → treated as human.
        self.assertFalse(is_synthetic_inbound("From now on, always use British spelling."))

    def test_non_string_is_not_synthetic(self):
        for bad in (None, 123, [], {}):
            self.assertFalse(is_synthetic_inbound(bad))

    def test_cron_turn_with_durable_shape_does_not_block(self):
        # A cron inbound whose text happens to contain a durable-rule phrasing
        # must STILL be allowed — capture only makes sense on human turns.
        import json
        import tempfile

        msgs = [
            {
                "role": "user",
                "content": (
                    '<channel source="cron">Reminder: from now on, always '
                    "post the digest at 8am.</channel>"
                ),
            },
            {"role": "assistant", "content": "Posted the digest."},
        ]
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for m in msgs:
                f.write(json.dumps({"type": m["role"], "message": m}) + "\n")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        hook = {"transcript_path": path, "stop_hook_active": False}
        self.assertIsNone(evaluate(hook, {"directiveCaptureNudge": True}))

    def test_telegram_turn_with_durable_shape_still_blocks(self):
        # Control: the SAME durable phrasing on a genuine telegram inbound
        # must still block (proves the synthetic guard didn't over-reach).
        import json
        import tempfile

        msgs = [
            {
                "role": "user",
                "content": (
                    '<channel source="telegram" chat_id="1" user="ken">From now '
                    "on, always use British spelling.</channel>"
                ),
            },
            {"role": "assistant", "content": "Got it."},
        ]
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for m in msgs:
                f.write(json.dumps({"type": m["role"], "message": m}) + "\n")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        hook = {"transcript_path": path, "stop_hook_active": False}
        self.assertEqual(evaluate(hook, {"directiveCaptureNudge": True}), _VERIFY_BLOCK_REASON)


class TestBlockReason(unittest.TestCase):
    def test_reason_mentions_create_directive_and_escape_hatch(self):
        self.assertIn("create_directive", _VERIFY_BLOCK_REASON)
        self.assertIn("one-off", _VERIFY_BLOCK_REASON)
        self.assertIn("<directive_capture_verify>", _VERIFY_BLOCK_REASON)


class TestDirectiveWriteDetection(unittest.TestCase):
    """A4 — the Stop-hook detector that decides whether the just-ended turn
    wrote a directive (and should therefore invalidate the recall cache)."""

    def test_write_tool_names_recognised(self):
        for name in (
            "create_directive",
            "update_directive",
            "delete_directive",
            "mcp__hindsight__create_directive",
            "mcp__hindsight__update_directive",
        ):
            self.assertTrue(_is_directive_write_tool(name), name)

    def test_read_and_unrelated_tools_ignored(self):
        for name in ("list_directives", "recall", "retain", "reflect", "", None):
            self.assertFalse(_is_directive_write_tool(name), name)

    def _assistant_tool_use(self, tool_name):
        return {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "t1", "name": tool_name, "input": {}}],
        }

    def test_turn_with_create_directive_detected(self):
        messages = [
            {"role": "user", "content": "From now on call me Ken."},
            self._assistant_tool_use("mcp__hindsight__create_directive"),
        ]
        self.assertTrue(turn_contains_directive_write(messages, 0))

    def test_turn_without_write_not_detected(self):
        messages = [
            {"role": "user", "content": "What did we decide?"},
            self._assistant_tool_use("mcp__hindsight__list_directives"),
        ]
        self.assertFalse(turn_contains_directive_write(messages, 0))

    def test_write_before_start_index_ignored(self):
        # A directive write in a PRIOR turn (before the current human turn) does
        # not count — only writes after start_index are this turn's.
        messages = [
            self._assistant_tool_use("create_directive"),  # prior turn
            {"role": "user", "content": "Now do something else."},
            {"role": "assistant", "content": "Sure."},
        ]
        self.assertFalse(turn_contains_directive_write(messages, 1))


class TestCacheInvalidationHook(unittest.TestCase):
    """A4 — invalidate_cache_on_directive_write end-to-end: a real transcript
    containing a directive write deletes a seeded cache file."""

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._patch = unittest.mock.patch.dict(
            os.environ, {"CLAUDE_PLUGIN_DATA": self._tmp.name}
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _seed_cache(self, bank_id="bank1"):
        from lib.directives import _cache_name
        from lib.state import read_state, write_state

        write_state(_cache_name(bank_id), {"ts": 1000.0, "bank_id": bank_id, "directives": []})
        self.assertIsNotNone(read_state(_cache_name(bank_id), None))

    def _cache_present(self, bank_id="bank1"):
        from lib.directives import _cache_name
        from lib.state import read_state

        return read_state(_cache_name(bank_id), None) is not None

    def test_directive_write_invalidates_cache(self):
        self._seed_cache()
        messages = [
            {"role": "user", "content": "From now on call me Ken."},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "t1", "name": "create_directive", "input": {}}
                ],
            },
        ]
        invalidate_cache_on_directive_write(messages, {})
        self.assertFalse(self._cache_present())

    def test_no_write_leaves_cache_intact(self):
        self._seed_cache()
        messages = [
            {"role": "user", "content": "What's the weather?"},
            {"role": "assistant", "content": "Sunny."},
        ]
        invalidate_cache_on_directive_write(messages, {})
        self.assertTrue(self._cache_present())

    def test_empty_messages_is_noop(self):
        self._seed_cache()
        invalidate_cache_on_directive_write([], {})
        self.assertTrue(self._cache_present())


class TestMainSingleTranscriptRead(unittest.TestCase):
    """A4 finding 2 — main() must parse the transcript AT MOST ONCE (shared by
    cache-invalidation + capture-verify), and not at all when nothing needs it.
    A Stop hook on a multi-MB session cannot afford a doubled multi-second
    parse inside its 10s budget."""

    def _run_main_counting_reads(self, config, stop_hook_active=False):
        import io
        import json

        import directive_verify as dv

        calls = {"n": 0}

        def _counting_read(_path):
            calls["n"] += 1
            return []

        hook_input = {"transcript_path": "/some/transcript", "stop_hook_active": stop_hook_active}
        with unittest.mock.patch.object(dv, "read_transcript", side_effect=_counting_read), \
             unittest.mock.patch.object(dv, "load_config", return_value=config), \
             unittest.mock.patch("sys.stdin", new=io.StringIO(json.dumps(hook_input))), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()):
            dv.main()
        return calls["n"]

    def test_reads_once_when_cache_and_verify_on(self):
        n = self._run_main_counting_reads({
            "directivesCacheTtlSeconds": 120,
            "directiveCaptureNudge": True,
            "directiveCaptureVerify": True,
        })
        self.assertEqual(n, 1)

    def test_reads_once_when_only_cache_on(self):
        n = self._run_main_counting_reads({
            "directivesCacheTtlSeconds": 120,
            "directiveCaptureNudge": False,
            "directiveCaptureVerify": False,
        })
        self.assertEqual(n, 1)

    def test_reads_once_when_only_verify_on(self):
        n = self._run_main_counting_reads({
            "directivesCacheTtlSeconds": 0,
            "directiveCaptureNudge": True,
            "directiveCaptureVerify": True,
        })
        self.assertEqual(n, 1)

    def test_reads_zero_when_all_disabled(self):
        n = self._run_main_counting_reads({
            "directivesCacheTtlSeconds": 0,
            "directiveCaptureNudge": False,
            "directiveCaptureVerify": False,
        })
        self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main()
