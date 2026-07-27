"""Switchroom #3757 — the recall hook must not put an unbounded BM25 query on
the wire, and the per-bank timeout must be configurable.

The bug: recall.py composed a query from the last 2 turns (up to
``recallMaxQueryChars`` = 800 chars, ~110 tokens) and Hindsight OR-joined every
token into one ``to_tsquery``. Postgres native FTS cannot top-k from the GIN
index, so it ranked the whole matched set before the top-60 heapsort. Measured
on the live ``overlord`` bank (135,565 memory_units, 3 fact-type arms):

    as shipped                 96 terms   119,510 rows ranked   14.0 s
    role labels/header removed 93 terms    86,653 rows ranked   11.8 s
    + capped to 24 terms       24 terms    48,433 rows ranked    2.7 s

(`exec` is the best of three EXPLAIN ANALYZE runs on a live, loaded host; the
unshaped query ranged 14.0-94.1 s across those runs while the shaped one held
2.54-2.76 s, so the cap removes the variance as well as the mean.)

Two of the tokens were scaffolding the hook added itself — ``user`` matched
67,363 rows (50% of the bank) and ``assistant`` 29,942 (22%). The 8s hardcoded
client timeout then fired on 96.8% of that agent's own-bank recalls, so the
model got zero memories on ~3 turns in 4.

Acceptance guarantees (outcomes, not code paths):

  1. **The query on the wire is term-capped.** Whatever the composed query, the
     string passed to ``client.recall`` tokenizes to at most
     ``recallQueryMaxTokens`` distinct BM25 terms.

  2. **Role labels never reach the wire.** ``user`` / ``assistant`` are absent
     from the wire query's tokens even when the composed context contains both
     roles.

  3. **The cap is configurable, not hardcoded** — including ``0`` to disable
     shaping entirely (the rollback lever).

  4. **The per-bank timeout is configurable** and defaults to 12s, not the old
     hardcoded 8.

  5. **Shaping does not leak into the client-side lexical gate.** The
     ``recallMinOverlap`` containment gate keeps measuring against the user's
     real words, so this change cannot silently move an operator's threshold.

Stdlib-only (unittest); runs under ``python3 -m unittest discover tests/``
from ``scripts/``.
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
from lib.content import tokenize_for_bm25  # noqa: E402

# A prior turn plus a latest turn, together well past the term budget. Written
# as real prose because the point is a production-shaped query, not a synthetic
# token soup.
PRIOR_USER = (
    "the v0.19.24 rollout went out this morning and the reaper never swept the "
    "orphaned worktrees on the build host, which left eleven stale claims behind"
)
PRIOR_ASSISTANT = (
    "I compared the published manifest digest against what the agent container "
    "actually pulled and they diverge, so the restart raced the tag and the "
    "container is running the previous image entirely"
)
LATEST = (
    "why did recall for the v0.19.24 rollout return v0.18.15 instead of the "
    "release notes from this morning"
)


def _nested_line(role, text):
    return json.dumps({
        "type": role,
        "uuid": f"u-{abs(hash((role, text))) % 10_000_000}",
        "message": {"role": role, "content": text},
    })


class _Client:
    """Fake HindsightClient that records exactly what went on the wire."""

    def __init__(self, results=None):
        self._results = results or []
        self.calls = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        self.calls.append({"bank_id": bank_id, "query": query, **kwargs})
        return {"results": [dict(r) for r in self._results]}


class _Harness(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-shaping-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _write_transcript(self):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join([
                _nested_line("user", PRIOR_USER),
                _nested_line("assistant", PRIOR_ASSISTANT),
                _nested_line("user", LATEST),
            ]) + "\n")
        return path

    def _run(self, client, config_extra=None, prompt=LATEST, with_transcript=True):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": self._write_transcript() if with_transcript else "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "recallMaxTokens": 1024,
            "recallBudget": "low",
            # 2 turns is the fleet default and the shape that produced the bug.
            "recallContextTurns": 2,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "recallTranscriptFallback": False,
        }
        if config_extra:
            config.update(config_extra)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()
        raw = stdout.getvalue()
        context = None
        if raw.strip():
            context = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
        return context

    def _wire_terms(self, client):
        self.assertTrue(client.calls, "recall never reached the client")
        return set(tokenize_for_bm25(client.calls[0]["query"]))


class WireQueryIsTermCapped(_Harness):
    def test_defaults_to_24_terms(self):
        client = _Client()
        self._run(client)
        self.assertLessEqual(len(self._wire_terms(client)), 24)

    def test_cap_is_configurable(self):
        for cap in (6, 12, 40):
            client = _Client()
            self._run(client, config_extra={"recallQueryMaxTokens": cap})
            self.assertLessEqual(
                len(self._wire_terms(client)), cap, f"cap={cap} not honoured"
            )

    def test_zero_disables_shaping(self):
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        # Rollback lever: the full composed query goes out unshaped.
        self.assertGreater(len(self._wire_terms(client)), 24)

    def test_latest_turn_survives_the_cap(self):
        # The cap must not cost the user the question they just asked.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 8})
        terms = self._wire_terms(client)
        self.assertIn("v0.19.24", terms)
        self.assertNotIn("orphaned", terms, "stale prior context outranked the question")


class RoleLabelsNeverReachTheWire(_Harness):
    def test_user_and_assistant_are_not_bm25_terms(self):
        client = _Client()
        self._run(client)
        terms = self._wire_terms(client)
        # These two were 50% and 22% of the overlord bank's document frequency.
        self.assertNotIn("user", terms)
        self.assertNotIn("assistant", terms)
        # ...and the composed query's own section header.
        self.assertNotIn("prior", terms)
        self.assertNotIn("context", terms)

    def test_still_absent_with_shaping_disabled(self):
        # Fix at source: compose_recall_query no longer emits the labels, so
        # even the rollback lever cannot put them back on the wire.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        terms = self._wire_terms(client)
        self.assertNotIn("user", terms)
        self.assertNotIn("assistant", terms)

    def test_prior_context_content_still_reaches_the_wire(self):
        # Dropping the labels must not drop the turns they labelled.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        terms = self._wire_terms(client)
        self.assertIn("reaper", terms)
        self.assertIn("manifest", terms)


class PerBankTimeoutIsConfigurable(_Harness):
    def test_defaults_to_12_seconds(self):
        client = _Client()
        self._run(client)
        self.assertEqual(client.calls[0]["timeout"], 12.0)

    def test_honours_config(self):
        client = _Client()
        self._run(client, config_extra={"recallRequestTimeoutSeconds": 20})
        self.assertEqual(client.calls[0]["timeout"], 20.0)

    def test_invalid_value_falls_back_to_default(self):
        for bad in ("banana", None, 0, -3):
            client = _Client()
            self._run(client, config_extra={"recallRequestTimeoutSeconds": bad})
            self.assertEqual(client.calls[0]["timeout"], 12.0, f"bad={bad!r}")


class ShapingDoesNotMoveTheOverlapGate(_Harness):
    """The `recallMinOverlap` containment gate is |Q ∩ M| / |M|. If it measured
    against the SHAPED query, shrinking Q would shrink every memory's score and
    silently tighten every operator's configured threshold. It must keep
    measuring against the user's real words."""

    def test_memory_matching_only_stopwords_of_the_prompt(self):
        # "did we decide about the auth flow" — every shared term with the
        # memory below is a stopword that shaping removes. With the gate on the
        # UNSHAPED query the memory clears a 0.5 threshold; against the shaped
        # query it would score 0 and be dropped.
        memory = {"text": "did we decide about the", "type": "fact",
                  "mentioned_at": "2026-01-01", "id": "m1"}
        client = _Client(results=[memory])
        context = self._run(
            client,
            prompt="did we decide about the auth flow",
            with_transcript=False,
            config_extra={"recallMinOverlap": 0.5, "recallContextTurns": 1},
        )
        self.assertIsNotNone(context)
        self.assertIn("did we decide about the", context)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
