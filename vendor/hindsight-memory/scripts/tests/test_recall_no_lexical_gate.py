"""Switchroom — the lexical-overlap recall gate is gone, and stays gone.

Between the engine's reranker and the ``recallMaxMemories`` head-slice, recall
used to run a ``recallMinOverlap`` gate: any candidate whose containment
overlap ``|Q n M| / |M|`` with the prompt fell under a threshold was discarded.
It was removed outright (no replacement score floor) because measurement showed
it was pure loss:

  * On healthy production rows (non-timeout, non-error, ts >= 2026-07-20,
    n=212 fleet-wide) it discarded 6026 of 7549 post-reranker candidates —
    79.8% fleet-wide, 94.4% for overlord, 91.0% for klanker.
  * Replaying 330 real logged queries against the live engine, it dropped the
    engine's OWN top-ranked candidate on 31.2% of queries.
  * It filtered no measurable noise: the rate at which the best injected
    memory scored below 1e-3 was 27.0% with the gate and 28.2% with no gate.

The root cause is the tokenizer: ``_overlap_tokens`` keeps only alphabetic
tokens of length > 1, so digits, identifiers, version numbers, PR numbers and
file paths are invisible to it. For a fleet that talks in identifiers that is
close to worst case.

So these tests assert OUTCOMES, not code paths. Each one fails if candidates
are dropped for lexical reasons again — including via a stale
``recallMinOverlap`` key left behind in an operator's settings.json, which is
exactly how a removed knob comes back to life.

Stdlib-only (unittest + mock); runs under ``python3 -m unittest discover
tests/``. Harness mirrors ``test_recall_integration.py``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402

BANK = "test-bank"

# A production-shaped recall query: the memory-bearing sentence plus the long
# unrelated prior-context preamble the UserPromptSubmit hook prepends. Query
# length is what made the old gate collapse, so the fixtures keep it realistic.
PREAMBLE = (
    "Prior context: the operator asked about telegram card rendering, then "
    "about vault broker grants, then about the nightly digest schedule and "
    "the reaction dispatch wiring, and separately about docker image "
    "promotion, canary holdback, worktree hygiene and changelog discipline. "
)


def _memory(text, score=0.5, mem_id=None):
    return {
        "text": text,
        "type": "fact",
        "mentioned_at": "2026-01-01",
        "id": mem_id or text,
        "scores": {"final": score},
    }


class _FakeClient:
    def __init__(self, memories, directives=None):
        self._memories = memories
        self._directives = directives or []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        return {"results": [dict(m) for m in self._memories]}


def _run_main_with(client, prompt="what did we decide", config_extra=None):
    hook_input = {
        "prompt": prompt,
        "session_id": "test-session",
        "transcript_path": "",
        "cwd": "/tmp",
    }
    config = {
        "autoRecall": True,
        "bankId": BANK,
        "recallMaxTokens": 4096,
        "recallBudget": "mid",
        "recallContextTurns": 1,
        "recallMaxQueryChars": 800,
        "recallPromptPreamble": "",
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
    return json.loads(raw)["hookSpecificOutput"]["additionalContext"], raw


#
# NOTE (#3999): the former ``GateHelpersAreGoneTests`` hasattr guard
# (``assertFalse(hasattr(recall, "containment_overlap"))``) was dropped as
# redundant — a re-added-but-unwired helper does nothing, and a re-WIRED gate is
# already caught by the outcome assertions in ``NoLexicalDroppingIntegrationTests``
# below (which fail if any candidate is dropped for lexical reasons). Direct
# characterisation of the surviving ``_overlap_tokens`` tokenizer now lives in
# ``test_overlap_tokens.py`` (#3777), not in a hasattr check here.
#


class NoLexicalDroppingIntegrationTests(unittest.TestCase):
    """Wired through main(): what the engine returns is what gets injected."""

    def test_zero_word_overlap_memory_is_still_injected(self):
        """The gate's headline behaviour, inverted. A memory sharing no
        content word with the prompt was dropped outright; the reranker
        ranked it, so it must now survive to the head-slice."""
        client = _FakeClient(
            [
                _memory("deploy staging server", score=0.9),
                _memory("vegan dinner recipes", score=0.8),
            ]
        )
        ctx, _ = _run_main_with(client, prompt="how do we deploy staging server")
        self.assertIsNotNone(ctx)
        self.assertIn("deploy staging server", ctx)
        self.assertIn("vegan dinner recipes", ctx)

    def test_identifier_only_match_survives(self):
        """A memory whose ONLY tie to the prompt is an identifier survives.

        This was the measured root cause of the removed gate: `_overlap_tokens`
        dropped digits, so an identifier-only memory scored 0.0 and was always
        discarded. Two things now hold: (a) #3578 gave the tokenizer digit
        vision, so query and memory now DO share the identifier token; and (b)
        with the gate gone, the memory is injected regardless of overlap."""
        query = PREAMBLE + "did PR #3541 land, and what did v0.19.24 change"
        mem = "#3541 shipped in 0.19.24"
        # Post-#3578 the identifier is visible on both sides.
        self.assertIn(
            "3541",
            recall._overlap_tokens(query) & recall._overlap_tokens(mem),
            "the shared identifier must now be a token on both sides (#3578)",
        )
        ctx, _ = _run_main_with(_FakeClient([_memory(mem, score=0.95)]), prompt=query)
        self.assertIsNotNone(ctx)
        self.assertIn(mem, ctx)

    def test_long_prompt_does_not_starve_recall(self):
        """#3541's failure shape: survival collapsed as the prompt grew, to
        93% zero-result past 600 query chars. Length must now be inert."""
        for repeat in (1, 4, 8):
            query = PREAMBLE * repeat + "where did the connection pool sizing land"
            with self.subTest(query_chars=len(query)):
                ctx, _ = _run_main_with(
                    _FakeClient([_memory(f"m-{i}", score=0.9 - i * 0.01) for i in range(6)]),
                    prompt=query,
                )
                self.assertIsNotNone(ctx)
                for i in range(6):
                    self.assertIn(f"m-{i}", ctx)

    def test_stale_min_overlap_key_is_inert(self):
        """A removed knob comes back to life through leftover config. An
        operator settings.json still carrying `recallMinOverlap: 0.5` must
        drop nothing — under the old code this emptied the block entirely."""
        client = _FakeClient(
            [
                _memory("vegan dinner recipes", score=0.9),
                _memory("totally unrelated chatter", score=0.8),
            ]
        )
        ctx, _ = _run_main_with(
            client,
            prompt="how do we deploy staging server",
            config_extra={"recallMinOverlap": 0.5},
        )
        self.assertIsNotNone(ctx)
        self.assertIn("vegan dinner recipes", ctx)
        self.assertIn("totally unrelated chatter", ctx)

    def test_relevance_order_and_cap_still_apply(self):
        """Removing the gate must not remove the controls that replaced it:
        the engine's `scores.final` sort plus the head-slice ARE the
        precision mechanism now."""
        mems = [_memory(f"m-{i}", score=i / 10.0) for i in range(10)]
        ctx, _ = _run_main_with(
            _FakeClient(mems),
            config_extra={"recallMaxMemories": 3},
        )
        self.assertIsNotNone(ctx)
        for keep in ("m-9", "m-8", "m-7"):
            self.assertIn(keep, ctx)
        for drop in ("m-0", "m-1", "m-2"):
            self.assertNotIn(drop, ctx)


class RecallLogSchemaTests(unittest.TestCase):
    """`overlap_dropped` measured a filter that no longer exists; a
    permanently-zero field reads as "the gate is fine" on every dashboard."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-nogate-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def test_log_row_drops_the_overlap_dropped_field(self):
        _run_main_with(_FakeClient([_memory("a fact", score=0.9)]))
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        self.assertTrue(os.path.isfile(path), "no recall_log.jsonl written")
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(line) for line in f if line.strip()]
        self.assertTrue(rows)
        for row in rows:
            self.assertNotIn("overlap_dropped", row)
            # The quality fields that now carry the load must still be there.
            self.assertIn("injected_score_median", row)
            self.assertIn("pre_cap_count", row)

    def test_every_candidate_reaches_the_cap_stage(self):
        """Volume proof: nothing is lost between the engine response and the
        head-slice. `pre_cap_count` == what the bank returned."""
        mems = [_memory(f"m-{i}", score=0.9 - i * 0.01) for i in range(12)]
        _run_main_with(_FakeClient(mems), config_extra={"recallMaxMemories": 4})
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(rows[-1]["pre_cap_count"], 12)
        self.assertEqual(rows[-1]["result_count"], 4)


if __name__ == "__main__":
    unittest.main()
