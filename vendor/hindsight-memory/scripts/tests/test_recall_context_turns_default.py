"""Switchroom hindsight-leverage PR2 (workstream A2) — coverage for the
``recallContextTurns`` default flip 1 → 2 and its latency bound.

Two things are asserted here:

1. **The default is now 2** (config.py + settings.json), so a bare follow-up
   user message composes with its antecedent human turn — WITHOUT anyone
   setting ``recallContextTurns`` explicitly.
2. **The multi-turn composition is budget- and latency-bounded:**
   - ``truncate_recall_query`` keeps the composed 2-turn query within
     ``recallMaxQueryChars`` even when the antecedent turn is huge — the latest
     turn is always preserved, oldest context is dropped first.
   - ``read_transcript_messages(..., tail_bytes=N)`` parses only the trailing
     N bytes of a large transcript, so the per-recall read stays O(tail_bytes)
     regardless of how large the session ``.jsonl`` has grown. The last human
     turns (which is all the slice needs) still land.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import json
import os
import sys
import tempfile
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import DEFAULTS  # noqa: E402
from lib.content import compose_recall_query, truncate_recall_query  # noqa: E402
from recall import read_transcript_messages  # noqa: E402


class ContextTurnsDefaultIsTwo(unittest.TestCase):
    """The A2 flip: bare follow-ups embed with their antecedent by default."""

    def test_config_default_is_two(self):
        self.assertEqual(DEFAULTS.get("recallContextTurns"), 2)

    def test_settings_json_default_is_two(self):
        settings_path = os.path.join(
            os.path.dirname(SCRIPTS_DIR), "settings.json"
        )
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
        self.assertEqual(settings.get("recallContextTurns"), 2)

    def test_settings_and_config_defaults_agree(self):
        settings_path = os.path.join(
            os.path.dirname(SCRIPTS_DIR), "settings.json"
        )
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
        for key in ("recallContextTurns", "recallTranscriptTailBytes"):
            self.assertEqual(
                settings.get(key),
                DEFAULTS.get(key),
                f"settings.json and config.py disagree on {key}",
            )

    def test_bare_followup_composes_with_antecedent_at_default_turns(self):
        # Simulate what recall.py does with the *default* turn count: a bare
        # pronoun follow-up must carry its antecedent human turn into the query.
        turns = DEFAULTS["recallContextTurns"]
        messages = [
            {"role": "user", "content": "how is the ORCHID_PRIMARY database configured"},
            {"role": "assistant", "content": "it runs Postgres 16 with PITR"},
        ]
        composed = compose_recall_query("and the port?", messages, turns)
        self.assertIn("Prior context:", composed)
        self.assertIn("ORCHID_PRIMARY", composed)
        self.assertTrue(composed.rstrip().endswith("and the port?"))


class ComposedQueryStaysWithinBudget(unittest.TestCase):
    """The composition can never blow the recall query char budget."""

    def test_huge_antecedent_truncated_to_budget_keeping_latest(self):
        max_chars = 800
        huge_antecedent = "x" * 5000  # far larger than the whole budget
        messages = [
            {"role": "user", "content": huge_antecedent},
            {"role": "assistant", "content": "y" * 5000},
        ]
        latest = "and what about staging?"
        composed = compose_recall_query(latest, messages, 2)
        # Pre-truncation the composed query is over budget (the antecedent is 5k).
        self.assertGreater(len(composed), max_chars)
        truncated = truncate_recall_query(composed, latest, max_chars)
        # Bounded — never exceeds the budget.
        self.assertLessEqual(len(truncated), max_chars)
        # The latest turn is always preserved verbatim (never sacrificed to
        # make room for context).
        self.assertTrue(truncated.rstrip().endswith(latest))

    def test_modest_context_fits_and_is_preserved(self):
        max_chars = 800
        messages = [
            {"role": "user", "content": "the deploy target is ap-southeast-2"},
            {"role": "assistant", "content": "noted, Sydney region"},
        ]
        latest = "and the fallback region?"
        composed = compose_recall_query(latest, messages, 2)
        truncated = truncate_recall_query(composed, latest, max_chars)
        self.assertLessEqual(len(truncated), max_chars)
        # Small enough to keep the context line intact.
        self.assertIn("ap-southeast-2", truncated)
        self.assertTrue(truncated.rstrip().endswith(latest))


class TranscriptTailReadIsBounded(unittest.TestCase):
    """The per-recall transcript read is byte-tail-bounded (latency bound)."""

    def _write_transcript(self, path, filler_rows, tail_rows):
        with open(path, "w", encoding="utf-8") as f:
            for r in filler_rows + tail_rows:
                f.write(json.dumps(r) + "\n")

    def test_tail_bytes_reads_only_the_trailing_lines(self):
        tmpdir = tempfile.mkdtemp(prefix="recall-tail-")
        try:
            path = os.path.join(tmpdir, "t.jsonl")
            # A large body of old turns (well over any small tail bound) …
            filler = [
                {"type": "user", "message": {"role": "user",
                 "content": "OLD_TURN_" + str(i) + " " + ("f" * 500)}}
                for i in range(200)
            ]
            # … then the two recent turns we actually want to slice.
            tail = [
                {"type": "user", "message": {"role": "user",
                 "content": "RECENT_FACT the api key is FALCON_9_KEY"}},
                {"type": "assistant", "message": {"role": "assistant",
                 "content": "RECENT_ANSWER got it"}},
            ]
            self._write_transcript(path, filler, tail)

            # Small tail bound — must NOT parse the old filler, but MUST reach
            # the recent turns at the end.
            msgs = read_transcript_messages(path, tail_bytes=4096)
            joined = json.dumps(msgs)
            self.assertIn("RECENT_FACT", joined)
            self.assertIn("RECENT_ANSWER", joined)
            self.assertNotIn("OLD_TURN_0", joined)
            # Bounded read yields far fewer than the 202 total rows.
            self.assertLess(len(msgs), 200)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_tail_bytes_zero_reads_whole_file(self):
        tmpdir = tempfile.mkdtemp(prefix="recall-tail-")
        try:
            path = os.path.join(tmpdir, "t.jsonl")
            rows = [
                {"type": "user", "message": {"role": "user", "content": "FIRST"}},
                {"type": "assistant", "message": {"role": "assistant", "content": "mid"}},
                {"type": "user", "message": {"role": "user", "content": "LAST"}},
            ]
            self._write_transcript(path, [], rows)
            msgs = read_transcript_messages(path, tail_bytes=0)
            joined = json.dumps(msgs)
            self.assertIn("FIRST", joined)
            self.assertIn("LAST", joined)
            self.assertEqual(len(msgs), 3)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_small_file_under_bound_reads_fully(self):
        # When the file is smaller than the tail bound, nothing is dropped —
        # the partial-first-line trim only applies when we actually seek.
        tmpdir = tempfile.mkdtemp(prefix="recall-tail-")
        try:
            path = os.path.join(tmpdir, "t.jsonl")
            rows = [
                {"type": "user", "message": {"role": "user", "content": "ALPHA"}},
                {"type": "user", "message": {"role": "user", "content": "OMEGA"}},
            ]
            self._write_transcript(path, [], rows)
            msgs = read_transcript_messages(path, tail_bytes=262144)
            joined = json.dumps(msgs)
            self.assertIn("ALPHA", joined)
            self.assertIn("OMEGA", joined)
            self.assertEqual(len(msgs), 2)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_missing_transcript_returns_empty(self):
        self.assertEqual(read_transcript_messages("", tail_bytes=4096), [])
        self.assertEqual(
            read_transcript_messages("/nonexistent/nope.jsonl", tail_bytes=4096), []
        )


if __name__ == "__main__":
    unittest.main()
