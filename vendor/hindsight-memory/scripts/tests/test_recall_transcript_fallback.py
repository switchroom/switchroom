"""Switchroom hindsight-leverage E1 / PR8 (#3369) — bounded transcript-grep
fallback when the fact layer is empty pre-reconcile.

Acceptance guarantees (outcomes, not code paths):

  1. **Fires on all-zero + no deadline hit.** Every bank returns zero results
     and no slot timed out → recall injects a ``<hindsight_transcript_fallback>``
     block containing the recent session turn(s) that mention the query's
     terms, and the recall_log row records ``transcript_fallback=True``.

  2. **Does NOT fire when any bank returned memories.** A non-empty bank result
     suppresses the fallback entirely (no fallback block, log False) — the
     fact layer is not empty.

  3. **Does NOT fire when a bank hit its deadline.** deadline_hit True (a bank
     abandoned at the shared deadline) means the empty result set may be a
     TIMEOUT, not a genuinely empty fact layer — the #3369 sequencing
     constraint — so the fallback is suppressed even though results are empty.

  4. **Byte bound holds.** With a small ``…MaxBytes``, only the transcript TAIL
     is read: a query-matching line that lives only in the (discarded) HEAD is
     never surfaced, and ``transcript_fallback_bytes_read`` never exceeds the
     configured cap.

  5. **Turn + char bounds hold.** ``…MaxTurns`` caps the number of injected
     turns; ``…MaxChars`` caps the emitted characters and sets the
     ``transcript_fallback_truncated`` telemetry flag.

  6. **Config gate + relevance.** ``recallTranscriptFallback=False`` disables it;
     a transcript with no term overlap with the query never fires.

Stdlib-only (unittest); runs under ``python3 -m unittest discover tests/``
from ``scripts/``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402

# Query terms: decide, auth, flow, week (stopwords stripped by _overlap_tokens).
BARE = "what did we decide about the auth flow last week"


def _memory(text, mem_id=None):
    out = {"text": text, "type": "fact", "mentioned_at": "2026-01-01"}
    if mem_id is not None:
        out["id"] = mem_id
    return out


class _Client:
    """Fake HindsightClient with per-bank sleep + result control."""

    def __init__(self, bank_sleep=None, bank_results=None, directives=None):
        self._bank_sleep = bank_sleep or {}
        self._bank_results = bank_results or {}
        self._directives = directives or []
        self._lock = threading.Lock()
        self.recall_calls = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        with self._lock:
            self.recall_calls.append(bank_id)
        sleep_s = self._bank_sleep.get(bank_id, 0.0)
        if sleep_s:
            time.sleep(sleep_s)
        return {"results": list(self._bank_results.get(bank_id, []))}


def _nested_line(role, text):
    """One Claude Code nested-format transcript line."""
    return json.dumps({
        "type": role,
        "uuid": f"u-{abs(hash((role, text))) % 10_000_000}",
        "message": {"role": role, "content": text},
    })


class _Harness(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-fallback-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _write_transcript(self, lines):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return path

    def _read_log(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _run(self, client, config_extra=None, prompt=BARE, transcript_path=""):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": transcript_path,
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            # Keep the shared deadline generous unless a test overrides it.
            "recallParallelDeadlineSeconds": 5,
            # Fallback bounds (defaults mirror config.py; explicit for clarity).
            "recallTranscriptFallback": True,
            "recallTranscriptFallbackMaxBytes": 262144,
            "recallTranscriptFallbackMaxTurns": 6,
            "recallTranscriptFallbackMaxChars": 2000,
            "recallTranscriptFallbackDeadlineMs": 1500,
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
        context = None
        if raw.strip():
            context = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
        return context


class FiresOnEmptyFactLayer(_Harness):
    def test_fires_when_all_banks_zero_and_no_deadline_hit(self):
        transcript = self._write_transcript([
            _nested_line("user", "hello there"),
            _nested_line("user", "we should redo the auth flow with PKCE"),
            _nested_line("assistant", "agreed, the auth flow now uses PKCE"),
            _nested_line("user", "thanks"),
        ])
        client = _Client(bank_results={"own-bank": []})
        context = self._run(client, transcript_path=transcript)

        self.assertIsNotNone(context, "fallback should have produced context")
        self.assertIn("<hindsight_transcript_fallback>", context)
        self.assertIn("PKCE", context)
        # Chronological order preserved (user turn before assistant turn).
        self.assertLess(
            context.index("we should redo the auth flow"),
            context.index("the auth flow now uses PKCE"),
        )

        e = self._read_log()[0]
        self.assertTrue(e["transcript_fallback"])
        self.assertGreaterEqual(e["transcript_fallback_turns"], 2)
        self.assertGreater(e["transcript_fallback_chars"], 0)
        self.assertFalse(e["deadline_hit"])
        self.assertEqual(e["result_count"], 0)

    def test_no_match_in_transcript_does_not_fire(self):
        # Transcript turns share NO terms with the auth-flow query.
        transcript = self._write_transcript([
            _nested_line("user", "what should we cook for dinner tonight"),
            _nested_line("assistant", "maybe a pasta with roasted vegetables"),
        ])
        client = _Client(bank_results={"own-bank": []})
        context = self._run(client, transcript_path=transcript)
        self.assertIsNone(context)
        e = self._read_log()[0]
        self.assertFalse(e["transcript_fallback"])
        self.assertEqual(e["transcript_fallback_turns"], 0)


class DoesNotFireWhenFactLayerNotEmpty(_Harness):
    def test_bank_returned_memories_suppresses_fallback(self):
        transcript = self._write_transcript([
            _nested_line("user", "we should redo the auth flow with PKCE"),
        ])
        client = _Client(bank_results={"own-bank": [_memory("auth uses PKCE", "m1")]})
        context = self._run(client, transcript_path=transcript)
        self.assertIsNotNone(context)
        self.assertIn("<hindsight_memories>", context)
        self.assertNotIn("<hindsight_transcript_fallback>", context)
        e = self._read_log()[0]
        self.assertFalse(e["transcript_fallback"])
        self.assertEqual(e["result_count"], 1)


class DoesNotFireWhenDeadlineHit(_Harness):
    def test_timed_out_bank_suppresses_fallback(self):
        transcript = self._write_transcript([
            _nested_line("user", "we should redo the auth flow with PKCE"),
        ])
        # Own bank returns zero fast; an extra bank sleeps past the 0.5s
        # deadline → abandoned → deadline_hit True even though results are empty.
        client = _Client(
            bank_sleep={"own-bank": 0.0, "slow-bank": 3.0},
            bank_results={"own-bank": [], "slow-bank": []},
        )
        context = self._run(
            client,
            transcript_path=transcript,
            config_extra={
                "recallAdditionalBanks": ["slow-bank"],
                "recallParallelDeadlineSeconds": 0.5,
            },
        )
        self.assertIsNone(context, "fallback must not fire when a bank timed out")
        e = self._read_log()[0]
        self.assertTrue(e["deadline_hit"])
        self.assertFalse(e["transcript_fallback"])


class BoundsHold(_Harness):
    def test_byte_bound_only_reads_tail(self):
        # A query-matching line in the HEAD, padded past the byte window, must
        # not be surfaced; a recent matching line must be.
        pad = _nested_line("assistant", "filler noise " * 40)
        head = _nested_line("user", "the OLD auth flow decision was OAuth1")
        lines = [head] + [pad] * 60 + [
            _nested_line("user", "the NEW auth flow uses PKCE tokens"),
        ]
        transcript = self._write_transcript(lines)
        client = _Client(bank_results={"own-bank": []})
        # 4 KiB tail — comfortably smaller than the head+padding above it.
        context = self._run(
            client,
            transcript_path=transcript,
            config_extra={"recallTranscriptFallbackMaxBytes": 4096},
        )
        self.assertIsNotNone(context)
        self.assertIn("PKCE tokens", context)
        self.assertNotIn("OAuth1", context)
        e = self._read_log()[0]
        self.assertTrue(e["transcript_fallback"])
        self.assertLessEqual(e["transcript_fallback_bytes_read"], 4096)

    def test_turn_bound_caps_matched_turns(self):
        # Ten matching turns, but MaxTurns=3 → at most 3 injected.
        lines = [
            _nested_line("user", f"auth flow revision number {i}")
            for i in range(10)
        ]
        transcript = self._write_transcript(lines)
        client = _Client(bank_results={"own-bank": []})
        context = self._run(
            client,
            transcript_path=transcript,
            config_extra={"recallTranscriptFallbackMaxTurns": 3},
        )
        self.assertIsNotNone(context)
        e = self._read_log()[0]
        self.assertEqual(e["transcript_fallback_turns"], 3)

    def test_char_bound_truncates(self):
        big = "auth flow " + ("detail " * 400)  # ~2800 chars, one turn
        transcript = self._write_transcript([_nested_line("user", big)])
        client = _Client(bank_results={"own-bank": []})
        context = self._run(
            client,
            transcript_path=transcript,
            config_extra={"recallTranscriptFallbackMaxChars": 300},
        )
        self.assertIsNotNone(context)
        e = self._read_log()[0]
        self.assertTrue(e["transcript_fallback"])
        self.assertTrue(e["transcript_fallback_truncated"])
        # The injected excerpt characters are bounded by the cap (the wrapper
        # block adds the fixed preamble/tags around it).
        self.assertLessEqual(e["transcript_fallback_chars"], 300 + len(recall._FALLBACK_BLOCK_PREAMBLE) + 200)


class ConfigGate(_Harness):
    def test_disabled_by_config(self):
        transcript = self._write_transcript([
            _nested_line("user", "we should redo the auth flow with PKCE"),
        ])
        client = _Client(bank_results={"own-bank": []})
        context = self._run(
            client,
            transcript_path=transcript,
            config_extra={"recallTranscriptFallback": False},
        )
        self.assertIsNone(context)
        e = self._read_log()[0]
        self.assertFalse(e["transcript_fallback"])

    def test_no_transcript_path_is_safe(self):
        client = _Client(bank_results={"own-bank": []})
        context = self._run(client, transcript_path="")
        self.assertIsNone(context)
        e = self._read_log()[0]
        self.assertFalse(e["transcript_fallback"])


if __name__ == "__main__":
    unittest.main()
