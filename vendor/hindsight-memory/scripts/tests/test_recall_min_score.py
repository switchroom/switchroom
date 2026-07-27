"""Switchroom #3837 — the opt-in absolute relevance floor (`recallMinScore`).

The failure this exists for, measured from the fleet's own `recall_log.jsonl`
(all agents, `injected_score_max` conditioned on `deadline_hit`):

    deadline_hit TRUE   n=249   median best injected score 0.0006
    deadline_hit FALSE  n=205   median best injected score 0.4663

276 of 454 logged turns injected memories whose BEST score was below 0.01. A
turn whose bank timed out does not inject nothing — it injects side-bank
residue under the banner "Relevant memories from past conversations", and the
agent cannot tell that from real recall. Silence with a disclosure is strictly
better than noise without one.

What the floor must NOT become is #3761's removed lexical gate. That gate was
deleted after a 330-query replay showed every floor value had
``top1lost% == zero%``, and the same fleet data says 28.4% of HEALTHY turns
have a best injected score under 0.01 against 98.4% of degraded ones
(`src/hindsight-watch/thresholds.ts`). So the floor ships OFF, and when it is
switched on it binds on degraded turns only unless the operator widens the
scope deliberately.

These tests assert OUTCOMES — what reaches `additionalContext` and what lands
on the log row — not that a branch was taken:

  * an all-below-floor set injects NO memory content, and the turn still says
    recall was degraded (the #3619 disclosure) rather than going silent;
  * a mixed set injects the above-floor entries and only those;
  * the log row's `dropped_below_min_score` matches what was actually dropped;
  * the shipped default (floor 0) leaves the injected context byte-identical;
  * the default scope does not touch a HEALTHY turn — the #3761 regression;
  * a score-less result is never dropped (missing score != irrelevant);
  * the withheld notice is per-turn state and never reaches the recall cache.

Stdlib-only (unittest + mock); runs under ``python3 -m unittest discover
tests/``. Harness mirrors ``test_recall_degraded_notice.py``.
"""

import io
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from recall import _filter_by_min_score, min_score_withheld_notice  # noqa: E402

OWN = "test-bank"
SIDE = "shared-bank"

# The two regimes the fleet measurement separates: what a timed-out turn's
# residue actually scores, and what a real hit scores.
NOISE = 0.0006
REAL = 0.9497


def _memory(text, mem_id, score=None):
    m = {"text": text, "type": "fact", "mentioned_at": "2026-01-01", "id": mem_id}
    if score is not None:
        m["scores"] = {"final": score}
    return m


def _directive(name, content, priority=5):
    return {
        "id": f"id-{name}",
        "bank_id": OWN,
        "name": name,
        "content": content,
        "priority": priority,
        "is_active": True,
        "tags": [],
    }


class _Client:
    """Fake HindsightClient with per-bank results / exceptions."""

    def __init__(self, bank_results=None, bank_errors=None, directives=None):
        self._bank_results = bank_results or {}
        self._bank_errors = bank_errors or {}
        self._directives = directives or []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        exc = self._bank_errors.get(bank_id)
        if exc is not None:
            raise exc
        return {"results": [dict(m) for m in self._bank_results.get(bank_id, [])]}


class FilterUnitTests(unittest.TestCase):
    def test_threshold_zero_is_passthrough(self):
        results = [_memory("a", "m1", NOISE), _memory("b", "m2", REAL)]
        kept, dropped = _filter_by_min_score(results, 0.0)
        self.assertEqual(kept, results)
        self.assertEqual(dropped, 0)

    def test_drops_only_below_threshold(self):
        low = _memory("low", "m1", NOISE)
        high = _memory("high", "m2", REAL)
        kept, dropped = _filter_by_min_score([low, high, low], 0.01)
        self.assertEqual(kept, [high])
        self.assertEqual(dropped, 2)

    def test_threshold_is_inclusive(self):
        exact = _memory("exact", "m1", 0.01)
        kept, dropped = _filter_by_min_score([exact], 0.01)
        self.assertEqual(kept, [exact])
        self.assertEqual(dropped, 0)

    def test_all_below_yields_empty_set(self):
        results = [_memory(f"n{i}", f"m{i}", NOISE) for i in range(6)]
        kept, dropped = _filter_by_min_score(results, 0.01)
        self.assertEqual(kept, [])
        self.assertEqual(dropped, 6)

    def test_scoreless_result_is_kept_not_dropped(self):
        """`_result_final_score` returns -inf for a malformed / score-less
        entry. Dropping on that sentinel would turn an upstream response-shape
        change into total, silent recall loss — the failure mode is far worse
        than admitting one unranked memory."""
        unscored = _memory("no scores key", "m1")
        broken = {"text": "malformed", "id": "m2", "scores": {"final": "NaN-ish"}}
        kept, dropped = _filter_by_min_score([unscored, broken], 0.5)
        self.assertEqual(kept, [unscored, broken])
        self.assertEqual(dropped, 0)


class WithheldNoticeUnitTests(unittest.TestCase):
    def test_silent_when_nothing_was_dropped(self):
        self.assertEqual(min_score_withheld_notice(0, 0.01), "")

    def test_names_the_count_and_the_floor(self):
        notice = min_score_withheld_notice(6, 0.01)
        self.assertIn("6", notice)
        self.assertIn("0.01", notice)

    def test_tells_the_agent_to_treat_absence_as_unknown(self):
        """The notice exists to change behaviour on a thin turn. If it stops
        saying this it is decoration."""
        self.assertIn("UNKNOWN", min_score_withheld_notice(3, 0.01))

    def test_is_a_single_short_line(self):
        notice = min_score_withheld_notice(3, 0.01)
        self.assertNotIn("\n", notice)
        self.assertLess(len(notice), 400)


class _MainHarness(unittest.TestCase):
    """Drives `recall.main()` end to end with an isolated recall log."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-min-score-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _log_row(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        self.assertTrue(rows, "no recall_log row was written")
        return rows[-1]

    def _run(self, client, config_extra=None):
        hook_input = {
            "prompt": "what did we decide about the auth flow",
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": OWN,
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
        }
        if config_extra:
            config.update(config_extra)
        stdout = io.StringIO()
        stderr = io.StringIO()
        self._cached = []
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch.object(
            recall, "_cache_ttl_secs", return_value=300
        ), patch.object(recall, "_cache_lookup", return_value=None), patch.object(
            recall,
            "_cache_store",
            side_effect=lambda key, value: self._cached.append(value),
        ), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()
        raw = stdout.getvalue()
        if not raw.strip():
            return None
        return json.loads(raw)["hookSpecificOutput"]["additionalContext"]

    def _degraded_noise_client(self, n=6, score=NOISE, directives=None):
        """The measured shape: own bank times out, a side bank answers with
        residue scoring in the noise band."""
        return _Client(
            bank_results={
                SIDE: [_memory(f"noise fact {i}", f"m{i}", score) for i in range(n)]
            },
            bank_errors={OWN: socket.timeout("timed out")},
            directives=directives,
        )


class AllBelowFloorInjectsNothingButStillDiscloses(_MainHarness):
    def test_no_memory_content_is_injected(self):
        ctx = self._run(
            self._degraded_noise_client(),
            {
                "recallAdditionalBanks": [SIDE],
                "recallMinScore": 0.01,
            },
        )
        self.assertIsNotNone(ctx)
        self.assertNotIn("<hindsight_memories>", ctx)
        for i in range(6):
            self.assertNotIn(f"noise fact {i}", ctx)

    def test_the_turn_still_says_recall_was_degraded(self):
        """Withholding must not re-create the #3619 ambiguity. An empty recall
        that looks like an empty MEMORY is the bug; the agent has to be told
        its own bank did not answer."""
        ctx = self._run(
            self._degraded_noise_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        self.assertIsNotNone(ctx)
        self.assertTrue(ctx.startswith("[Hindsight] Memory recall was DEGRADED"))
        self.assertIn(OWN, ctx)

    def test_the_turn_also_says_candidates_were_withheld(self):
        ctx = self._run(
            self._degraded_noise_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        self.assertIn("below the configured relevance floor", ctx)
        self.assertIn("UNKNOWN", ctx)

    def test_log_row_reports_the_drop(self):
        self._run(
            self._degraded_noise_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        row = self._log_row()
        self.assertEqual(row["dropped_below_min_score"], 6)
        self.assertEqual(row["min_score_floor"], 0.01)
        self.assertEqual(row["min_score_scope"], "degraded")
        self.assertTrue(row["min_score_applied"])
        self.assertEqual(row["result_count"], 0)
        # Nothing was injected, so the quality aggregates have nothing to
        # summarise — the pairing an operator reads as "the floor bound here".
        self.assertIsNone(row["injected_score_max"])


class MixedSetInjectsOnlySurvivors(_MainHarness):
    def _mixed_client(self):
        return _Client(
            bank_results={
                SIDE: [
                    _memory("real decision about auth", "m-real", REAL),
                    _memory("noise fact 0", "m0", NOISE),
                    _memory("noise fact 1", "m1", NOISE),
                ]
            },
            bank_errors={OWN: socket.timeout("timed out")},
        )

    def test_above_floor_memory_is_injected_and_below_floor_ones_are_not(self):
        ctx = self._run(
            self._mixed_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        self.assertIsNotNone(ctx)
        self.assertIn("<hindsight_memories>", ctx)
        self.assertIn("real decision about auth", ctx)
        self.assertNotIn("noise fact 0", ctx)
        self.assertNotIn("noise fact 1", ctx)

    def test_no_withheld_notice_when_survivors_remain(self):
        """A partial drop still injects real memories; the turn does not need
        the extra line and a notice that fires on ordinary turns gets ignored
        exactly when it matters."""
        ctx = self._run(
            self._mixed_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        self.assertNotIn("below the configured relevance floor", ctx)

    def test_log_row_counts_only_the_dropped(self):
        self._run(
            self._mixed_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        row = self._log_row()
        self.assertEqual(row["dropped_below_min_score"], 2)
        self.assertEqual(row["result_count"], 1)
        self.assertEqual(row["memory_ids"], ["m-real"])


class DefaultOffChangesNothing(_MainHarness):
    def test_noise_is_injected_exactly_as_before_when_the_floor_is_unset(self):
        """The shipped default. Every one of the six sub-0.01 memories still
        reaches the agent — this feature is inert until an operator opts in,
        and a non-zero default sneaking in here fails this test."""
        ctx = self._run(
            self._degraded_noise_client(), {"recallAdditionalBanks": [SIDE]}
        )
        self.assertIsNotNone(ctx)
        self.assertIn("<hindsight_memories>", ctx)
        for i in range(6):
            self.assertIn(f"noise fact {i}", ctx)
        self.assertNotIn("below the configured relevance floor", ctx)
        row = self._log_row()
        self.assertEqual(row["dropped_below_min_score"], 0)
        self.assertEqual(row["min_score_floor"], 0.0)
        self.assertFalse(row["min_score_applied"])
        self.assertEqual(row["result_count"], 6)

    def test_explicit_zero_is_byte_identical_to_unset(self):
        unset = self._run(
            self._degraded_noise_client(), {"recallAdditionalBanks": [SIDE]}
        )
        explicit = self._run(
            self._degraded_noise_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.0},
        )
        self.assertIsNotNone(unset)
        self.assertEqual(unset, explicit)

    def test_a_non_numeric_floor_is_treated_as_off(self):
        """Config arrives from JSON and from the env cast; a garbage value must
        degrade to disabled, never to "drop everything"."""
        ctx = self._run(
            self._degraded_noise_client(),
            {"recallAdditionalBanks": [SIDE], "recallMinScore": "0.5"},
        )
        self.assertIsNotNone(ctx)
        self.assertIn("noise fact 0", ctx)
        self.assertEqual(self._log_row()["dropped_below_min_score"], 0)


class ScopeDefaultsToDegradedTurnsOnly(_MainHarness):
    """#3761's finding, honoured: a low `scores.final` does not imply noise on
    a HEALTHY turn (28.4% of healthy rows sit under 0.01), so the default scope
    must not touch one."""

    def _healthy_noise_client(self):
        return _Client(
            bank_results={
                OWN: [_memory(f"noise fact {i}", f"m{i}", NOISE) for i in range(6)]
            }
        )

    def test_healthy_turn_is_untouched_at_the_default_scope(self):
        ctx = self._run(self._healthy_noise_client(), {"recallMinScore": 0.5})
        self.assertIsNotNone(ctx)
        for i in range(6):
            self.assertIn(f"noise fact {i}", ctx)
        row = self._log_row()
        self.assertEqual(row["dropped_below_min_score"], 0)
        self.assertFalse(row["min_score_applied"])
        self.assertEqual(row["min_score_scope"], "degraded")

    def test_scope_all_binds_on_a_healthy_turn(self):
        ctx = self._run(
            self._healthy_noise_client(),
            {"recallMinScore": 0.5, "recallMinScoreScope": "all"},
        )
        self.assertIsNotNone(ctx)
        self.assertNotIn("<hindsight_memories>", ctx)
        row = self._log_row()
        self.assertEqual(row["dropped_below_min_score"], 6)
        self.assertTrue(row["min_score_applied"])
        self.assertEqual(row["min_score_scope"], "all")

    def test_scope_all_emptying_a_healthy_turn_is_never_silent(self):
        """No bank failed, so the #3619 degraded notice does NOT fire — this is
        the case where the withheld notice is the only thing standing between
        the agent and "I remember nothing"."""
        ctx = self._run(
            self._healthy_noise_client(),
            {"recallMinScore": 0.5, "recallMinScoreScope": "all"},
        )
        self.assertIsNotNone(ctx)
        self.assertNotIn("DEGRADED", ctx)
        self.assertIn("below the configured relevance floor", ctx)

    def test_an_unknown_scope_falls_back_to_degraded(self):
        ctx = self._run(
            self._healthy_noise_client(),
            {"recallMinScore": 0.5, "recallMinScoreScope": "everything"},
        )
        self.assertIn("noise fact 0", ctx)
        self.assertEqual(self._log_row()["min_score_scope"], "degraded")


class ScorelessResultsSurviveTheFloor(_MainHarness):
    def test_a_result_without_scores_is_injected_under_a_high_floor(self):
        client = _Client(
            bank_results={SIDE: [_memory("unranked but real", "m1")]},
            bank_errors={OWN: socket.timeout("timed out")},
        )
        ctx = self._run(
            client, {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.9}
        )
        self.assertIsNotNone(ctx)
        self.assertIn("unranked but real", ctx)
        self.assertEqual(self._log_row()["dropped_below_min_score"], 0)


class WithheldNoticeIsNotCached(_MainHarness):
    def test_cache_write_carries_the_directives_without_the_notice(self):
        """Same discipline as #3619's degraded notice: the withheld line is
        per-turn state. If it reached `context_message` it would be cached and
        replayed on a later healthy hit, telling the agent memories were
        withheld on a turn where none were."""
        client = self._degraded_noise_client(
            directives=[_directive("trailer", "End every response with: [OK]", 10)]
        )
        ctx = self._run(
            client,
            {"recallAdditionalBanks": [SIDE], "recallMinScore": 0.01},
        )
        self.assertIn("below the configured relevance floor", ctx)
        self.assertIn("End every response with: [OK]", ctx)
        self.assertEqual(len(self._cached), 1)
        self.assertNotIn("below the configured relevance floor", self._cached[0])
        self.assertNotIn("DEGRADED", self._cached[0])
        self.assertIn("End every response with: [OK]", self._cached[0])


if __name__ == "__main__":
    unittest.main()
