"""Integration tests for recall.py — block composition + ordering.

Exercises the actual main() flow with stubbed dependencies so we can
verify:
  - The <active_directives> block is emitted ABOVE <hindsight_memories>
  - Empty bank (no directives, no memories) → no output at all
  - Active directives present but no memories → directives block alone
  - Active memories present but no directives → unchanged legacy behavior
  - Recall API failure with directives present → directives still emitted
    (so a recall outage doesn't blind the agent to its own HARD RULES)

Stdlib-only (unittest + mock).
"""

import io
import json
import os
import sys
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402


def _directive(name, content, priority=5):
    return {
        "id": f"id-{name}",
        "bank_id": "test-bank",
        "name": name,
        "content": content,
        "priority": priority,
        "is_active": True,
        "tags": [],
    }


def _memory(text, mem_type="fact", mentioned_at="2026-01-01", mem_id=None, tags=None):
    out = {"text": text, "type": mem_type, "mentioned_at": mentioned_at}
    if mem_id is not None:
        out["id"] = mem_id
    if tags is not None:
        out["tags"] = tags
    return out


class _FakeClient:
    """Stand-in for HindsightClient with configurable responses."""

    def __init__(self, directives=None, memories=None, recall_exc=None, list_exc=None):
        self._directives = directives if directives is not None else []
        self._memories = memories if memories is not None else []
        self._recall_exc = recall_exc
        self._list_exc = list_exc

    def list_directives(self, bank_id, active_only=True, timeout=2):
        if self._list_exc is not None:
            raise self._list_exc
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, max_tokens=1024, budget="mid", types=None, timeout=10):
        if self._recall_exc is not None:
            raise self._recall_exc
        return {"results": list(self._memories)}


def _run_main_with(client, prompt="What is the meaning of life?", config_extra=None):
    """Invoke recall.main with a fake client and capture stdout JSON.

    Returns (additional_context_string_or_None, raw_stdout).

    `config_extra` is merged on top of the baseline config so individual
    tests can override knobs like `recallMaxMemories` or
    `recallAdditionalBanks` without growing the helper signature for
    every new field.
    """
    hook_input = {
        "prompt": prompt,
        "session_id": "test-session",
        "transcript_path": "",
        "cwd": "/tmp",
    }
    config = {
        "autoRecall": True,
        "bankId": "test-bank",
        "recallMaxTokens": 1024,
        "recallBudget": "mid",
        "recallContextTurns": 1,
        "recallMaxQueryChars": 800,
        "recallPromptPreamble": "",
    }
    if config_extra:
        config.update(config_extra)

    stdout = io.StringIO()
    stderr = io.StringIO()
    with patch.object(recall, "load_config", return_value=config), patch.object(
        recall, "get_api_url", return_value="http://localhost:18888"
    ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
        recall, "ensure_bank_mission", return_value=None
    ), patch.object(recall, "write_state", return_value=None), patch(
        "sys.stdin", new=io.StringIO(json.dumps(hook_input))
    ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
        recall.main()

    raw = stdout.getvalue()
    if not raw.strip():
        return None, raw
    parsed = json.loads(raw)
    return parsed["hookSpecificOutput"]["additionalContext"], raw


class RecallIntegrationTests(unittest.TestCase):
    def test_directives_block_appears_above_memories_block(self):
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[_memory("user prefers concise answers")],
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        d_idx = ctx.find("<active_directives>")
        m_idx = ctx.find("<hindsight_memories>")
        self.assertGreaterEqual(d_idx, 0, "active_directives block missing")
        self.assertGreaterEqual(m_idx, 0, "hindsight_memories block missing")
        self.assertLess(d_idx, m_idx, "directives must come before memories")

    def test_empty_bank_emits_no_output(self):
        client = _FakeClient(directives=[], memories=[])
        ctx, raw = _run_main_with(client)
        self.assertIsNone(ctx)
        self.assertEqual(raw.strip(), "")

    def test_directives_only_emits_directives_block_alone(self):
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<active_directives>", ctx)
        self.assertNotIn("<hindsight_memories>", ctx)
        self.assertIn("End every response with: [VERIFIED]", ctx)

    def test_memories_only_unchanged_legacy_behavior(self):
        # No directives → block omitted entirely (not an empty wrapper).
        client = _FakeClient(directives=[], memories=[_memory("an old preference")])
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertNotIn("<active_directives>", ctx)
        self.assertIn("<hindsight_memories>", ctx)
        self.assertIn("an old preference", ctx)

    def test_recall_failure_with_directives_still_emits_directives(self):
        # A recall API outage must NOT blind the agent to its HARD RULES.
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
            recall_exc=RuntimeError("HTTP 503"),
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<active_directives>", ctx)
        self.assertNotIn("<hindsight_memories>", ctx)

    def test_directives_failure_does_not_kill_recall(self):
        # Symmetric: a list_directives failure must not block the recall
        # block from being emitted.
        client = _FakeClient(
            directives=[],
            memories=[_memory("legacy memory still useful")],
            list_exc=RuntimeError("HTTP 500"),
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<hindsight_memories>", ctx)
        self.assertNotIn("<active_directives>", ctx)

    def test_blocks_separated_by_blank_line(self):
        client = _FakeClient(
            directives=[_directive("rule", "do the thing", priority=5)],
            memories=[_memory("a memory")],
        )
        ctx, _ = _run_main_with(client)
        self.assertIn("</active_directives>\n\n<hindsight_memories>", ctx)


class RecallMaxMemoriesCapTests(unittest.TestCase):
    """Tests for the switchroom-local recallMaxMemories count cap.

    The cap is applied client-side after the (primary + additional banks)
    results are concatenated and BEFORE formatting, so it bounds the
    final injected memory count regardless of token budget. <= 0
    disables the cap.
    """

    def test_cap_truncates_over_limit(self):
        memories = [_memory(f"memory {i}") for i in range(8)]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client, config_extra={"recallMaxMemories": 3})
        self.assertIsNotNone(ctx)
        self.assertIn("memory 0", ctx)
        self.assertIn("memory 2", ctx)
        # memory 3 and beyond must be trimmed.
        self.assertNotIn("memory 3", ctx)
        self.assertNotIn("memory 7", ctx)

    def test_cap_zero_disables_truncation(self):
        memories = [_memory(f"memory {i}") for i in range(20)]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client, config_extra={"recallMaxMemories": 0})
        self.assertIsNotNone(ctx)
        # All 20 should make it through.
        for i in range(20):
            self.assertIn(f"memory {i}", ctx)

    def test_cap_below_count_no_op(self):
        # Cap=12 but only 5 memories returned → no slicing.
        memories = [_memory(f"memory {i}") for i in range(5)]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client, config_extra={"recallMaxMemories": 12})
        self.assertIsNotNone(ctx)
        for i in range(5):
            self.assertIn(f"memory {i}", ctx)

    def test_cap_applies_after_additional_banks_concat(self):
        # Primary bank returns 4 memories; additional bank returns 4
        # more. Cap of 5 must apply to the total (slicing keeps primary
        # 0..3 + first 1 from additional). This locks in the rule:
        # "cap is total, not per-bank."
        primary = [_memory(f"primary-{i}") for i in range(4)]

        # Build a client whose `recall` returns different sets per bank.
        class _MultiBankClient(_FakeClient):
            def recall(self, bank_id, **kwargs):
                if bank_id == "test-bank":
                    return {"results": list(primary)}
                if bank_id == "shared-bank":
                    return {"results": [_memory(f"shared-{i}") for i in range(4)]}
                return {"results": []}

        client = _MultiBankClient(directives=[], memories=[])
        ctx, _ = _run_main_with(
            client,
            config_extra={
                "recallMaxMemories": 5,
                "recallAdditionalBanks": ["shared-bank"],
            },
        )
        self.assertIsNotNone(ctx)
        # Primary 0..3 + the first shared (shared-0) survive the cap.
        for i in range(4):
            self.assertIn(f"primary-{i}", ctx)
        self.assertIn("shared-0", ctx)
        # shared-1..3 are sliced off.
        self.assertNotIn("shared-1", ctx)
        self.assertNotIn("shared-3", ctx)

    def test_cap_negative_disables(self):
        # Defensive: negative values are treated the same as 0 (uncapped).
        memories = [_memory(f"memory {i}") for i in range(15)]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client, config_extra={"recallMaxMemories": -1})
        self.assertIsNotNone(ctx)
        for i in range(15):
            self.assertIn(f"memory {i}", ctx)


class DemoteFromRecallTagTests(unittest.TestCase):
    """Switchroom #432 phase 4.4 — memories tagged demote-from-recall
    are filtered out of the auto-recall block but otherwise stay in the
    bank.
    """

    def test_bracketed_tag_is_filtered(self):
        memories = [
            _memory("keep this", tags=[]),
            _memory("drop this", tags=["[demote-from-recall]"]),
        ]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("keep this", ctx)
        self.assertNotIn("drop this", ctx)

    def test_unbracketed_tag_is_filtered(self):
        memories = [
            _memory("keep this"),
            _memory("drop this", tags=["demote-from-recall"]),
        ]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client)
        self.assertIn("keep this", ctx)
        self.assertNotIn("drop this", ctx)

    def test_no_recall_alias_is_filtered(self):
        # `no-recall` is the third accepted variant — shorter to type when
        # tagging via `mcp__hindsight__update_memory`.
        memories = [
            _memory("keep this"),
            _memory("drop this", tags=["no-recall"]),
        ]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client)
        self.assertIn("keep this", ctx)
        self.assertNotIn("drop this", ctx)

    def test_unrelated_tag_is_kept(self):
        memories = [_memory("keep this", tags=["topic:fitness", "user:ken"])]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client)
        self.assertIn("keep this", ctx)

    def test_filter_applies_before_cap(self):
        # 8 memories total, 3 demoted, cap=4. Result: 4 non-demoted
        # memories survive (proves the filter runs first; if the cap
        # ran first we'd see 4 of the 8 including demoted ones).
        memories = [_memory(f"keep {i}") for i in range(5)] + [
            _memory(f"drop {i}", tags=["[demote-from-recall]"]) for i in range(3)
        ]
        client = _FakeClient(directives=[], memories=memories)
        ctx, _ = _run_main_with(client, config_extra={"recallMaxMemories": 4})
        self.assertIsNotNone(ctx)
        # All 4 cap survivors come from the "keep" pool.
        for i in range(4):
            self.assertIn(f"keep {i}", ctx)
        for i in range(3):
            self.assertNotIn(f"drop {i}", ctx)


class RecallTelemetryLogTests(unittest.TestCase):
    """Switchroom #432 phase 4.3 — every recall (hit or miss) appends
    a JSONL record to state/recall_log.jsonl when CLAUDE_PLUGIN_DATA is
    set.
    """

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.mkdtemp(prefix="recall-log-test-")
        # The log writer reads CLAUDE_PLUGIN_DATA at write time. Set it
        # for the test and restore on tearDown.
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _read_log(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_logs_one_line_per_recall_with_memory_ids(self):
        memories = [
            _memory("first", mem_id="mem-1"),
            _memory("second", mem_id="mem-2"),
        ]
        client = _FakeClient(directives=[], memories=memories)
        _run_main_with(client)
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["result_count"], 2)
        self.assertEqual(e["memory_ids"], ["mem-1", "mem-2"])
        self.assertFalse(e["cache_hit"])
        self.assertFalse(e["capped"])
        self.assertEqual(e["bank_id"], "test-bank")

    def test_logs_capped_flag_when_cap_fires(self):
        memories = [_memory(f"m {i}", mem_id=f"id-{i}") for i in range(8)]
        client = _FakeClient(directives=[], memories=memories)
        _run_main_with(client, config_extra={"recallMaxMemories": 3})
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertTrue(e["capped"])
        self.assertEqual(e["pre_cap_count"], 8)
        self.assertEqual(e["result_count"], 3)
        # Only the kept IDs are logged.
        self.assertEqual(e["memory_ids"], ["id-0", "id-1", "id-2"])

    def test_logs_demoted_count(self):
        memories = [
            _memory("keep", mem_id="k1"),
            _memory("drop", mem_id="d1", tags=["[demote-from-recall]"]),
        ]
        client = _FakeClient(directives=[], memories=memories)
        _run_main_with(client)
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["demoted_count"], 1)
        self.assertEqual(entries[0]["memory_ids"], ["k1"])

    def test_no_log_when_plugin_data_unset(self):
        # If CLAUDE_PLUGIN_DATA isn't set, the writer no-ops silently —
        # we don't want a stray log file in the working directory.
        del os.environ["CLAUDE_PLUGIN_DATA"]
        client = _FakeClient(directives=[], memories=[_memory("x", mem_id="x1")])
        _run_main_with(client)
        # No file ever created.
        self.assertEqual(self._read_log(), [])
        # Restore so tearDown's pop doesn't error.
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir


class AckShortCircuitTests(unittest.TestCase):
    """Switchroom: skip recall entirely on conversational acks
    ("thanks", "ok", "got it", etc.) — saves the ~1-5s recall on
    turns where the model is going to produce a one-liner regardless.
    """

    def _assert_no_recall(self, prompt):
        # When ack-skip kicks in, the recall hook returns BEFORE
        # constructing the client, so we can pass a client whose
        # `recall` raises — if the test expectations hold, the raise
        # never fires.
        class _BoomClient:
            def list_directives(self, *a, **kw):
                raise AssertionError("list_directives called on ack-only turn")

            def recall(self, *a, **kw):
                raise AssertionError("recall called on ack-only turn")

        ctx, raw = _run_main_with(_BoomClient(), prompt=prompt)
        # No output → empty stdout, no hookSpecificOutput.
        self.assertIsNone(ctx)
        self.assertEqual(raw.strip(), "")

    def test_simple_thanks(self):
        self._assert_no_recall("thanks")

    def test_thanks_with_punctuation(self):
        self._assert_no_recall("thanks!")
        self._assert_no_recall("Thank you.")

    def test_got_it(self):
        self._assert_no_recall("got it")

    def test_emoji_ack(self):
        self._assert_no_recall("👍")
        self._assert_no_recall("👍👍")  # also stripped to a known phrase

    def test_channel_wrapped_ack(self):
        # Telegram-plugin wraps inbound prompts; the ack-skip must look
        # past the wrapper.
        self._assert_no_recall(
            '<channel source="switchroom-telegram" chat_id="123">thanks</channel>',
        )

    def test_real_question_does_not_skip(self):
        # Sanity: a real question should not be treated as an ack —
        # we expect recall to be CALLED. Use a real fake client (not
        # _BoomClient) and assert it produced output.
        client = _FakeClient(directives=[], memories=[_memory("relevant memory")])
        ctx, _ = _run_main_with(client, prompt="What did we decide about the auth flow?")
        self.assertIsNotNone(ctx)
        self.assertIn("relevant memory", ctx)

    def test_ack_with_extra_words_does_not_skip(self):
        # "thanks for the update" is not a pure ack — should fall
        # through to recall.
        client = _FakeClient(directives=[], memories=[_memory("the relevant fact")])
        ctx, _ = _run_main_with(
            client,
            prompt="thanks for the update on the deployment",
        )
        self.assertIsNotNone(ctx)


class JaccardOverlapUnitTests(unittest.TestCase):
    """Switchroom #475: pure-function tests for the relevance helpers."""

    def test_identical_text_is_full_overlap(self):
        # Modulo stop-word stripping (`is`, `the`, `a`, `to` removed).
        self.assertEqual(
            recall.jaccard_overlap("deploy the staging server", "deploy the staging server"),
            1.0,
        )

    def test_disjoint_text_is_zero(self):
        self.assertEqual(
            recall.jaccard_overlap("deploy staging server", "vegan dinner recipes"),
            0.0,
        )

    def test_partial_overlap_is_between(self):
        score = recall.jaccard_overlap(
            "deploy staging server",
            "deploy production server",
        )
        # {deploy, staging, server} vs {deploy, production, server}
        # → intersection 2, union 4 → 0.5
        self.assertAlmostEqual(score, 0.5, places=2)

    def test_stopwords_dont_inflate_overlap(self):
        # "the" / "is" / "a" present in both shouldn't count.
        score = recall.jaccard_overlap("the cat is a pet", "the dog is a pet")
        # Real tokens after stopword strip: {cat, pet} vs {dog, pet}
        # → intersection 1, union 3 → 0.333…
        self.assertAlmostEqual(score, 1 / 3, places=2)

    def test_empty_text_yields_zero(self):
        self.assertEqual(recall.jaccard_overlap("", "anything at all"), 0.0)
        self.assertEqual(recall.jaccard_overlap("query", ""), 0.0)

    def test_non_string_inputs_yield_zero(self):
        self.assertEqual(recall.jaccard_overlap(None, "x"), 0.0)
        self.assertEqual(recall.jaccard_overlap("x", None), 0.0)

    def test_case_insensitive(self):
        self.assertEqual(
            recall.jaccard_overlap("DEPLOY Server", "deploy server"),
            1.0,
        )

    def test_punctuation_stripped(self):
        self.assertEqual(
            recall.jaccard_overlap("deploy, server!", "deploy server"),
            1.0,
        )


class OverlapFilterUnitTests(unittest.TestCase):
    """Switchroom #475: _filter_by_overlap behaviour."""

    def test_threshold_zero_passthrough(self):
        results = [_memory("totally unrelated text")]
        kept, dropped = recall._filter_by_overlap(results, "deploy server", 0.0)
        self.assertEqual(kept, results)
        self.assertEqual(dropped, 0)

    def test_high_threshold_drops_weak_matches(self):
        results = [
            _memory("deploy server staging"),  # full overlap
            _memory("vegan dinner recipes"),    # zero overlap
        ]
        kept, dropped = recall._filter_by_overlap(results, "deploy server staging", 0.5)
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 1)
        self.assertEqual(kept[0]["text"], "deploy server staging")

    def test_threshold_keeps_partial_match_at_or_above(self):
        results = [_memory("deploy production server")]
        kept, dropped = recall._filter_by_overlap(results, "deploy staging server", 0.5)
        # 2/4 = 0.5 ≥ 0.5 → kept
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 0)

    def test_threshold_drops_partial_match_below(self):
        results = [_memory("deploy production server")]
        kept, dropped = recall._filter_by_overlap(results, "deploy staging server", 0.51)
        self.assertEqual(len(kept), 0)
        self.assertEqual(dropped, 1)


class OverlapGateIntegrationTests(unittest.TestCase):
    """Switchroom #475: gate wired through main()."""

    def test_default_off_passes_everything_through(self):
        # No recallMinOverlap in config → behaves as before.
        client = _FakeClient(
            directives=[],
            memories=[
                _memory("deploy staging server"),
                _memory("vegan dinner recipes"),
            ],
        )
        ctx, _ = _run_main_with(client, prompt="how do we deploy staging?")
        self.assertIsNotNone(ctx)
        self.assertIn("deploy staging server", ctx)
        self.assertIn("vegan dinner recipes", ctx)

    def test_high_threshold_drops_irrelevant_memories(self):
        client = _FakeClient(
            directives=[],
            memories=[
                _memory("deploy staging server"),
                _memory("vegan dinner recipes"),
            ],
        )
        ctx, _ = _run_main_with(
            client,
            prompt="how do we deploy staging server",
            config_extra={"recallMinOverlap": 0.5},
        )
        # Relevant survives, junk doesn't.
        self.assertIsNotNone(ctx)
        self.assertIn("deploy staging server", ctx)
        self.assertNotIn("vegan", ctx)

    def test_threshold_emits_no_block_when_all_dropped(self):
        # All memories below threshold → no <hindsight_memories> block.
        # Telemetry still records the dropped count.
        client = _FakeClient(
            directives=[],
            memories=[
                _memory("vegan dinner recipes"),
                _memory("totally unrelated chatter"),
            ],
        )
        ctx, _ = _run_main_with(
            client,
            prompt="how do we deploy staging server",
            config_extra={"recallMinOverlap": 0.5},
        )
        # No memories survived; with no directives either, we expect no
        # additionalContext at all.
        self.assertIsNone(ctx)


if __name__ == "__main__":
    unittest.main()
