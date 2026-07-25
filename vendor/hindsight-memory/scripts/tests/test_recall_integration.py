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
        # One entry per recall() call — lets tests assert the tag-filter
        # kwargs (upstream 962140eef) that main() passed per bank.
        self.recall_calls = []
        # Count list_directives calls so a test can prove the A4 cache saved a
        # round-trip across two recall.main() runs (and did NOT when TTL=0).
        self.list_directives_calls = 0

    def list_directives(self, bank_id, active_only=True, timeout=2):
        self.list_directives_calls += 1
        if self._list_exc is not None:
            raise self._list_exc
        return {"items": list(self._directives)}

    def recall(
        self,
        bank_id,
        query,
        max_tokens=1024,
        budget="mid",
        types=None,
        tags=None,
        tags_match=None,
        tag_groups=None,
        prefer_observations=None,
        timeout=10,
    ):
        self.recall_calls.append(
            {
                "bank_id": bank_id,
                "tags": tags,
                "tags_match": tags_match,
                "tag_groups": tag_groups,
            }
        )
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
        # Disable the A4 directives cache for these integration tests: they all
        # share bank "test-bank" under a real wall clock, so a live cache would
        # leak one test's directive set into the next within the TTL window.
        # Cache hit/miss/TTL/invalidation behaviour is covered hermetically in
        # test_directives.py (isolated CLAUDE_PLUGIN_DATA + injected clock).
        "directivesCacheTtlSeconds": 0,
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

    def test_logs_injected_score_aggregates_post_slice(self):
        """#3541 recall-QUALITY telemetry: the row must carry min/median/max
        of `scores.final` for the memories actually INJECTED — i.e. after the
        head-slice, not the pre-gate candidate pool. Without this, a rollout
        where the gate stops dropping and the cap fills every turn is
        indistinguishable from one feeding 8 mediocre memories per turn.
        """
        def _scored(text, mem_id, final):
            m = _memory(text, mem_id=mem_id)
            m["scores"] = {"final": final}
            return m

        memories = [
            _scored("low", "id-low", 0.10),
            _scored("high", "id-high", 0.90),
            _scored("mid", "id-mid", 0.80),
        ]
        client = _FakeClient(directives=[], memories=memories)
        _run_main_with(client, config_extra={"recallMaxMemories": 2})
        e = self._read_log()[0]
        # Sorted desc then sliced → the 0.10 memory is NOT injected, and must
        # not appear in the aggregates.
        self.assertEqual(e["memory_ids"], ["id-high", "id-mid"])
        self.assertAlmostEqual(e["injected_score_max"], 0.90, places=6)
        self.assertAlmostEqual(e["injected_score_min"], 0.80, places=6)
        self.assertAlmostEqual(e["injected_score_median"], 0.85, places=6)

    def test_injected_score_aggregates_are_null_without_scores(self):
        """Score-less results (or an empty set) must log nulls, never a
        sentinel like -inf that would corrupt a dashboard average."""
        client = _FakeClient(directives=[], memories=[_memory("x", mem_id="x1")])
        _run_main_with(client)
        e = self._read_log()[0]
        self.assertIsNone(e["injected_score_min"])
        self.assertIsNone(e["injected_score_median"])
        self.assertIsNone(e["injected_score_max"])

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


class ContainmentOverlapUnitTests(unittest.TestCase):
    """Switchroom #475 / #3541: pure-function tests for the relevance helpers."""

    def test_identical_text_is_full_overlap(self):
        # Modulo stop-word stripping (`is`, `the`, `a`, `to` removed).
        self.assertEqual(
            recall.containment_overlap("deploy the staging server", "deploy the staging server"),
            1.0,
        )

    def test_disjoint_text_is_zero(self):
        self.assertEqual(
            recall.containment_overlap("deploy staging server", "vegan dinner recipes"),
            0.0,
        )

    def test_partial_overlap_is_between(self):
        score = recall.containment_overlap(
            "deploy staging server",
            "deploy production server",
        )
        # {deploy, staging, server} vs {deploy, production, server}
        # → intersection 2, |M| = 3 → 0.666…
        self.assertAlmostEqual(score, 2 / 3, places=2)

    def test_stopwords_dont_inflate_overlap(self):
        # "the" / "is" / "a" present in both shouldn't count.
        score = recall.containment_overlap("the cat is a pet", "the dog is a pet")
        # Real tokens after stopword strip: {cat, pet} vs {dog, pet}
        # → intersection 1, |M| = 2 → 0.5
        self.assertAlmostEqual(score, 0.5, places=2)

    def test_empty_text_yields_zero(self):
        self.assertEqual(recall.containment_overlap("", "anything at all"), 0.0)
        self.assertEqual(recall.containment_overlap("query", ""), 0.0)

    def test_non_string_inputs_yield_zero(self):
        self.assertEqual(recall.containment_overlap(None, "x"), 0.0)
        self.assertEqual(recall.containment_overlap("x", None), 0.0)

    def test_case_insensitive(self):
        self.assertEqual(
            recall.containment_overlap("DEPLOY Server", "deploy server"),
            1.0,
        )

    def test_punctuation_stripped(self):
        self.assertEqual(
            recall.containment_overlap("deploy, server!", "deploy server"),
            1.0,
        )


class InjectedScoreStatsUnitTests(unittest.TestCase):
    """#3541 — aggregates for the injected set. Must be total and non-fatal:
    telemetry can never take recall down."""

    @staticmethod
    def _m(final):
        return {"text": "t", "scores": {"final": final}}

    def test_odd_count_uses_middle_value(self):
        s = recall._injected_score_stats([self._m(0.1), self._m(0.9), self._m(0.5)])
        self.assertEqual(s["injected_score_min"], 0.1)
        self.assertEqual(s["injected_score_median"], 0.5)
        self.assertEqual(s["injected_score_max"], 0.9)

    def test_even_count_averages_the_two_middles(self):
        s = recall._injected_score_stats(
            [self._m(0.2), self._m(0.4), self._m(0.6), self._m(0.8)]
        )
        self.assertEqual(s["injected_score_median"], 0.5)

    def test_empty_set_is_all_none(self):
        self.assertEqual(
            recall._injected_score_stats([]),
            {
                "injected_score_min": None,
                "injected_score_median": None,
                "injected_score_max": None,
            },
        )

    def test_scoreless_entries_are_excluded_not_treated_as_negative_infinity(self):
        s = recall._injected_score_stats([self._m(0.6), {"text": "no scores"}])
        self.assertEqual(s["injected_score_min"], 0.6)
        self.assertEqual(s["injected_score_max"], 0.6)

    def test_malformed_input_returns_nulls_instead_of_raising(self):
        # A telemetry error must never propagate into the recall path.
        self.assertEqual(
            recall._injected_score_stats(object()),
            {
                "injected_score_min": None,
                "injected_score_median": None,
                "injected_score_max": None,
            },
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
        # 2/|M| = 2/3 = 0.666… ≥ 0.5 → kept
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 0)

    def test_threshold_drops_partial_match_below(self):
        results = [_memory("deploy production server")]
        # 2/|M| = 2/3 = 0.666… < 0.7 → dropped
        kept, dropped = recall._filter_by_overlap(results, "deploy staging server", 0.7)
        self.assertEqual(len(kept), 0)
        self.assertEqual(dropped, 1)


class OverlapGateQueryLengthInvarianceTests(unittest.TestCase):
    """Switchroom #3541 regression: the gate must not be decided by prompt length.

    Production telemetry (1548 recall_log.jsonl rows, ts >= 2026-07-18) showed
    the survival rate through this gate collapsing monotonically as the prompt
    grew — 7.3% at <200 query chars down to 0.9% at 600-750 chars — with a
    93% zero-result rate at the long end. That is the Jaccard union term, not a
    relevance judgement. These tests pin the containment metric that fixes it.
    """

    # A realistic recall query: the memory-bearing sentence plus the long
    # unrelated prior-context preamble the UserPromptSubmit hook prepends.
    CORE_QUERY = "where did we land on the postgres connection pool sizing"
    PREAMBLE = (
        "Prior context: the operator asked about telegram card rendering, then "
        "about vault broker grants, then about the nightly digest schedule and "
        "the reaction dispatch wiring, and separately about docker image "
        "promotion, canary holdback, worktree hygiene, changelog discipline, "
        "eval harness thresholds, skill authoring quotas and mental model "
        "refresh cadence across the whole fleet of agents on this host. "
    )
    MEMORY = "Postgres connection pool sizing was settled at min 5 max 100."

    @staticmethod
    def _filler(n_words):
        """Generate `n_words` DISTINCT unrelated content words.

        Distinctness matters: the metrics operate on token *sets*, so
        repeating the same paragraph would not grow ``|Q|`` and a
        length-sensitivity test built on it would silently pass even under
        the buggy Jaccard metric.

        The words must also be purely alphabetic — ``_overlap_tokens``
        splits on every non-alpha character, so a digit-suffixed word like
        ``filler7word`` collapses to the two tokens ``filler``/``word`` no
        matter how many are emitted.
        """
        letters = "abcdefghijklmnopqrstuvwxyz"
        return " ".join(
            "zz" + letters[i // 26 % 26] + letters[i % 26] for i in range(n_words)
        )

    def test_extra_preamble_does_not_change_the_score(self):
        """In the production regime (query longer than the memory — always
        true for the UserPromptSubmit preamble), piling on more unrelated
        preamble must NOT move the score. Under Jaccard these two differ,
        because the union term grows with the prompt; under containment the
        denominator is the memory, so they are identical."""
        short = recall.containment_overlap(
            self._filler(20) + " " + self.CORE_QUERY, self.MEMORY
        )
        long_ = recall.containment_overlap(
            self._filler(200) + " " + self.CORE_QUERY, self.MEMORY
        )
        self.assertGreater(short, 0.0, "sanity: the memory does overlap the query")
        self.assertAlmostEqual(
            short,
            long_,
            places=6,
            msg="prompt length changed the gate score — the union-term artifact is back",
        )

    def test_relevant_memory_survives_a_production_length_prompt(self):
        """At the fleet default threshold (0.10, scaffold.ts), a clearly
        relevant memory must survive a production-p50-length prompt."""
        query = self.PREAMBLE + self.CORE_QUERY
        self.assertGreater(
            len(query), 400, "sanity: this is a production-shaped long prompt"
        )
        kept, dropped = recall._filter_by_overlap([_memory(self.MEMORY)], query, 0.10)
        self.assertEqual(
            len(kept), 1, "relevant memory was dropped from a long prompt"
        )
        self.assertEqual(dropped, 0)

    def test_gate_still_drops_irrelevant_memories_on_a_long_prompt(self):
        """The floor must still bite: a length-invariant metric must not
        become a passthrough. An unrelated memory is still dropped."""
        query = self.PREAMBLE + self.CORE_QUERY
        kept, dropped = recall._filter_by_overlap(
            [_memory("Ken prefers oat milk in his flat white.")], query, 0.10
        )
        self.assertEqual(len(kept), 0, "gate no longer filters — floor is dead")
        self.assertEqual(dropped, 1)

    # --- switchroom #3541 review F4: what the floor does and does NOT do ---
    #
    # `test_gate_still_drops_irrelevant_memories_on_a_long_prompt` above uses a
    # memory with ZERO shared terms, so it scores 0.000 and would pass at a
    # threshold of 0.001. It proves the gate is not a total no-op; it does not
    # characterise the floor. These two do.

    IRRELEVANT_BUT_OVERLAPPING = (
        "The nightly digest schedule and the reaction dispatch wiring "
        "were changed."
    )

    def test_partially_overlapping_irrelevant_memory_is_KEPT_at_the_default(self):
        """Characterisation, not aspiration: at the 0.10 fleet default the gate
        KEEPS an off-topic memory that merely reuses words from the prompt's
        prior-context preamble.

        This memory has nothing to do with the actual question (postgres pool
        sizing) but shares most of its content tokens with the preamble, so it
        scores ~0.857 — HIGHER than the genuinely relevant memory (~0.571).
        Containment is therefore NOT monotone in relevance on a preamble-heavy
        prompt, which is precisely why the threshold is not raised to try to
        exclude this: any threshold that drops it drops the relevant memory
        first. Precision here is the engine reranker's job, not the gate's.

        If this test ever starts failing because the memory is now dropped,
        the gate's selectivity changed — re-measure before accepting it.
        """
        query = self.PREAMBLE + self.CORE_QUERY
        off_topic = recall.containment_overlap(query, self.IRRELEVANT_BUT_OVERLAPPING)
        relevant = recall.containment_overlap(query, self.MEMORY)
        self.assertGreater(
            off_topic,
            relevant,
            "the relevance inversion this test documents is gone — "
            "re-derive the threshold recommendation",
        )
        kept, dropped = recall._filter_by_overlap(
            [_memory(self.IRRELEVANT_BUT_OVERLAPPING)], query, 0.10
        )
        self.assertEqual(len(kept), 1, "gate selectivity changed — re-measure")
        self.assertEqual(dropped, 0)

    def test_floor_drops_a_long_memory_with_only_incidental_overlap(self):
        """Where the floor DOES bite: because the denominator is the memory's
        own token count, a long memory sharing a single incidental term with
        the prompt scores below 0.10 and is dropped.

        This is the real content of the floor after #3541 — it removes
        candidates with near-zero lexical relationship to the prompt, and
        (deliberately) little else.
        """
        query = self.PREAMBLE + self.CORE_QUERY
        # Exactly 1 shared content token ("docker") out of 17 -> 0.059 < 0.10
        long_incidental = (
            "docker buildx bake emits oci manifests whose provenance "
            "attestations confuse older registries during garbage collection "
            "sweeps"
        )
        score = recall.containment_overlap(query, long_incidental)
        self.assertLess(score, 0.10, "fixture no longer scores below the floor")
        self.assertGreater(score, 0.0, "sanity: there IS some incidental overlap")
        kept, dropped = recall._filter_by_overlap(
            [_memory(long_incidental)], query, 0.10
        )
        self.assertEqual(len(kept), 0, "floor is dead — nothing is being dropped")
        self.assertEqual(dropped, 1)

    # --- switchroom #3541 review F5: the |Q| < |M| regime ---

    def test_short_prompt_uses_the_memory_as_denominator(self):
        """A short prompt must NOT be scored against itself.

        With the textbook overlap coefficient (`min(|Q|, |M|)`) a prompt
        shorter than the memory flips the denominator to the QUERY, and the
        metric silently becomes "what fraction of the prompt is in the
        memory" — a one-word prompt then scores 1.0 against any memory
        containing that word, re-introducing the query-length dependence
        #3541 exists to remove. Dividing by `|M|` unconditionally has no such
        discontinuity.
        """
        memory = "Postgres connection pool sizing was settled at min 5 max 100."
        n_mem = len(recall._overlap_tokens(memory))
        query = "docker"  # 1 content token, far shorter than the memory
        self.assertLess(
            len(recall._overlap_tokens(query)),
            n_mem,
            "sanity: this is the |Q| < |M| regime",
        )
        # A min()-denominator would score this 1.0 (1 shared token / |Q| = 1);
        # dividing by the memory gives 1/2.
        self.assertEqual(recall.containment_overlap(query, "docker image"), 0.5)

        # And a short prompt overlapping the memory scores by the memory:
        q2 = "postgres pool"
        expected = len(
            recall._overlap_tokens(q2) & recall._overlap_tokens(memory)
        ) / n_mem
        self.assertAlmostEqual(
            recall.containment_overlap(q2, memory), expected, places=6
        )

    def test_never_stricter_than_the_jaccard_gate_it_replaces(self):
        """Safety property vs what production runs today: because
        `|Q u M| >= |M|`, containment >= Jaccard for every pair. At a fixed
        threshold this gate admits a SUPERSET of what the deployed Jaccard
        gate admits, so no memory that survives today can be dropped by this
        change. Asserted over the fixtures rather than argued in prose.
        """
        query = self.PREAMBLE + self.CORE_QUERY
        cases = [
            self.MEMORY,
            self.IRRELEVANT_BUT_OVERLAPPING,
            "Ken prefers oat milk in his flat white.",
            "docker",
            "postgres pool sizing",
            self.PREAMBLE,
        ]
        for mem in cases:
            a = recall._overlap_tokens(query)
            b = recall._overlap_tokens(mem)
            jac = (len(a & b) / len(a | b)) if (a and b) else 0.0
            score = recall.containment_overlap(query, mem)
            self.assertGreaterEqual(
                score + 1e-12,
                jac,
                f"containment scored BELOW jaccard for {mem[:40]!r} — "
                f"this change could drop a memory production keeps",
            )
            # Upper bound + exact value. Review finding: the lower bound
            # alone is unfalsifiable for ANY implementation dividing by |M|
            # (a constant `return 1.0` satisfies it), so it survived every
            # mutation and proved nothing. These two pin the metric.
            self.assertLessEqual(score, 1.0, f"containment exceeded 1.0 for {mem[:40]!r}")
            expected = (len(a & b) / len(b)) if b else 0.0
            self.assertAlmostEqual(
                score, expected, places=9,
                msg=f"containment is not |Q n M| / |M| for {mem[:40]!r}",
            )

    def test_strict_subset_memory_scores_strictly_below_one(self):
        """A memory carrying a term the query does NOT have must score < 1.0.

        The companion upper bound to the superset property above: it is what
        actually falsifies a degenerate `return 1.0` implementation.
        """
        query = self.PREAMBLE + self.CORE_QUERY
        # Every token of this memory except `quokka` appears in the query.
        mem = self.CORE_QUERY + " quokka"
        score = recall.containment_overlap(query, mem)
        self.assertLess(score, 1.0)
        self.assertGreater(score, 0.0)
        # And a fully-contained memory reaches exactly 1.0, so the < 1.0
        # above is a property of the missing term, not a ceiling artefact.
        self.assertAlmostEqual(
            recall.containment_overlap(query, self.CORE_QUERY), 1.0, places=9
        )

    def test_survival_does_not_degrade_as_the_prompt_grows(self):
        """Sweep prompt length the way production does and assert the relevant
        memory survives at every length — the monotonic collapse is the bug."""
        for n_filler in (0, 20, 50, 100, 200, 400):
            query = self._filler(n_filler) + " " + self.CORE_QUERY
            kept, _ = recall._filter_by_overlap(
                [_memory(self.MEMORY)], query, 0.10
            )
            self.assertEqual(
                len(kept),
                1,
                f"relevant memory dropped at {n_filler} filler words "
                f"({len(query)} query chars)",
            )


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


class RecallTagFilterIntegrationTests(unittest.TestCase):
    """Upstream 962140eef port — tag filters flow through main() to each
    per-bank recall call, composed with our additional-banks routing."""

    def test_global_tags_passed_to_primary_bank(self):
        client = _FakeClient(memories=[_memory("a fact")])
        _run_main_with(
            client,
            config_extra={
                "recallTags": ["memory_type:rule"],
                "recallTagsMatch": "any_strict",
            },
        )
        self.assertEqual(client.recall_calls[0]["tags"], ["memory_type:rule"])
        self.assertEqual(client.recall_calls[0]["tags_match"], "any_strict")

    def test_no_tags_match_sent_without_tags_or_groups(self):
        client = _FakeClient(memories=[_memory("a fact")])
        _run_main_with(client, config_extra={"recallTagsMatch": "all"})
        self.assertIsNone(client.recall_calls[0]["tags"])
        self.assertIsNone(client.recall_calls[0]["tags_match"])
        self.assertIsNone(client.recall_calls[0]["tag_groups"])

    def test_per_bank_filter_overrides_global_for_additional_bank(self):
        client = _FakeClient(memories=[_memory("a fact")])
        _run_main_with(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallTags": ["tech_stack:supabase"],
                "recallTagsMatch": "any",
                "recallAdditionalBankFilters": {
                    "shared-bank": {
                        "recallTags": ["memory_type:rule"],
                        "recallTagsMatch": "all_strict",
                    }
                },
            },
        )
        primary, extra = client.recall_calls[0], client.recall_calls[1]
        self.assertEqual(primary["bank_id"], "test-bank")
        self.assertEqual(primary["tags"], ["tech_stack:supabase"])
        self.assertEqual(primary["tags_match"], "any")
        self.assertEqual(extra["bank_id"], "shared-bank")
        self.assertEqual(extra["tags"], ["memory_type:rule"])
        self.assertEqual(extra["tags_match"], "all_strict")

    def test_additional_bank_without_override_inherits_global(self):
        client = _FakeClient(memories=[_memory("a fact")])
        _run_main_with(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallTags": ["memory_type:rule"],
            },
        )
        extra = client.recall_calls[1]
        self.assertEqual(extra["tags"], ["memory_type:rule"])
        # Global tags_match defaults are only sent when filters are active.
        self.assertEqual(extra["tags_match"], None)


class DirectivesCacheIntegrationTests(unittest.TestCase):
    """A4 finding 4 — recall.main() honours the directivesCacheTtlSeconds knob
    end-to-end. Isolated CLAUDE_PLUGIN_DATA so the cache file lands in a temp
    state dir and does not leak into (or out of) other tests."""

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._env = patch.dict(os.environ, {"CLAUDE_PLUGIN_DATA": self._tmp.name})
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_ttl_cache_saves_second_list_directives_call(self):
        # Two consecutive recalls (same bank, no directive write between) with a
        # live TTL → exactly one list_directives round-trip; the second serves
        # from cache.
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
        )
        ctx1, _ = _run_main_with(client, config_extra={"directivesCacheTtlSeconds": 60})
        ctx2, _ = _run_main_with(client, config_extra={"directivesCacheTtlSeconds": 60})
        self.assertEqual(client.list_directives_calls, 1)
        # Both turns still emit the directives block (the cache serves the same
        # content on the hit).
        self.assertIn("<active_directives>", ctx1)
        self.assertIn("<active_directives>", ctx2)

    def test_ttl_zero_refetches_each_run(self):
        # TTL=0 disables the cache → every recall fetches live.
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
        )
        _run_main_with(client, config_extra={"directivesCacheTtlSeconds": 0})
        _run_main_with(client, config_extra={"directivesCacheTtlSeconds": 0})
        self.assertEqual(client.list_directives_calls, 2)


if __name__ == "__main__":
    unittest.main()
