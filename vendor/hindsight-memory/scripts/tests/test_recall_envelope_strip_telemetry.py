"""Switchroom hindsight-leverage PR 1 (workstream A1 + A3 stage-1 telemetry).

Two single-concern guarantees:

  1. Query hygiene — the ``<channel …>`` transport envelope is stripped from
     the recall query on BOTH the single-turn and the multi-turn (composed)
     paths, so ~100-200 chars of chat_id/ts/user XML noise never reach the
     embedding or consume the recallMaxQueryChars cap. The stripped query is
     the one recorded in ``recall_log.jsonl`` (acceptance: no ``<channel``
     substring in the logged query). The multi-turn fixture is a regression
     guard for the future ``recallContextTurns`` default flip (A2): it locks
     in that the composed query — both its "Prior context:" lines and its
     trailing latest-query segment — is envelope-free.

  2. Telemetry — every non-cache recall log carries per-bank latency +
     timeout flags, directives-fetch latency, total critical-path wall time,
     and a derived ``deadline_hit`` (any bank hit its hard per-request
     timeout). This is the A3 stage-1 baseline instrumentation, landed ahead
     of the parallelism change so a fresh pre-A3 breach baseline can accrue.

Stdlib-only (unittest + mock); runs under ``python3 -m unittest discover
tests/``. Mirrors the harness in ``test_recall_integration.py``.
"""

import io
import json
import os
import socket
import sys
import tempfile
import shutil
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib.content import compose_recall_query  # noqa: E402


def _memory(text, mem_type="fact", mentioned_at="2026-01-01", mem_id=None):
    out = {"text": text, "type": mem_type, "mentioned_at": mentioned_at}
    if mem_id is not None:
        out["id"] = mem_id
    return out


class _RecordingClient:
    """Fake HindsightClient that records the exact `query` passed to recall().

    Per-bank behaviour (results / exception) is configurable so a bank can be
    made to raise a timeout for the telemetry tests.
    """

    def __init__(self, memories=None, directives=None, bank_behaviour=None):
        self._memories = memories if memories is not None else []
        self._directives = directives if directives is not None else []
        # Maps bank_id -> Exception to raise (e.g. a timeout).
        self._bank_behaviour = bank_behaviour or {}
        self.queries = []  # every query string passed, in call order

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        self.queries.append(query)
        exc = self._bank_behaviour.get(bank_id)
        if exc is not None:
            raise exc
        return {"results": list(self._memories)}


def _run_main_with(client, prompt, config_extra=None):
    """Invoke recall.main with a fake client; capture stdout JSON."""
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


WRAPPED = (
    '<channel source="switchroom-telegram" chat_id="1000000001" '
    'message_id="42" user="testuser" ts="2026-07-20T10:00:00Z">'
    "what did we decide about the auth flow</channel>"
)
BARE = "what did we decide about the auth flow"


class SingleTurnEnvelopeStrip(unittest.TestCase):
    """The single-turn recall query must be the envelope-free inner text —
    identical to what a bare (unwrapped) prompt produces."""

    def test_wrapped_and_bare_produce_identical_query(self):
        wrapped_client = _RecordingClient(memories=[_memory("m")])
        bare_client = _RecordingClient(memories=[_memory("m")])
        _run_main_with(wrapped_client, prompt=WRAPPED)
        _run_main_with(bare_client, prompt=BARE)
        self.assertEqual(len(wrapped_client.queries), 1)
        self.assertEqual(len(bare_client.queries), 1)
        self.assertEqual(wrapped_client.queries[0], bare_client.queries[0])
        self.assertEqual(wrapped_client.queries[0], BARE)

    def test_no_channel_substring_or_attrs_in_query(self):
        client = _RecordingClient(memories=[_memory("m")])
        _run_main_with(client, prompt=WRAPPED)
        q = client.queries[0]
        self.assertNotIn("<channel", q)
        self.assertNotIn("chat_id", q)
        self.assertNotIn("1000000001", q)
        self.assertNotIn("ts=", q)


class MultiTurnComposedEnvelopeStrip(unittest.TestCase):
    """Regression guard for the future recallContextTurns default flip (A2):
    the composed multi-turn query must be envelope-free in BOTH the trailing
    latest-query segment and the "Prior context:" lines."""

    def test_composed_query_helper_strips_wrapped_latest(self):
        # compose_recall_query is called directly here (the helper must be
        # safe for any future caller, per A1). A wrapped latest query and a
        # wrapped prior user turn must both be stripped.
        messages = [
            {"role": "user", "content": '<channel source="telegram" chat_id="9">'
                                         "we were discussing the auth flow</channel>"},
            {"role": "assistant", "content": "right, the OAuth refresh path"},
        ]
        composed = compose_recall_query(WRAPPED, messages, recall_context_turns=2)
        self.assertNotIn("<channel", composed)
        self.assertNotIn("chat_id", composed)
        self.assertIn("Prior context:", composed)
        # Trailing latest-query segment is the bare text.
        self.assertTrue(composed.rstrip().endswith(BARE))
        # Prior user turn text survives, stripped.
        self.assertIn("we were discussing the auth flow", composed)

    def test_composed_query_via_main_has_no_channel(self):
        # End-to-end through main() with recallContextTurns=2 and a transcript
        # on disk whose latest user turn is wrapped.
        tmpdir = tempfile.mkdtemp(prefix="recall-transcript-")
        try:
            transcript = os.path.join(tmpdir, "t.jsonl")
            rows = [
                {"type": "user", "message": {"role": "user",
                 "content": "earlier i mentioned the ORCHID database"}},
                {"type": "assistant", "message": {"role": "assistant",
                 "content": "noted, ORCHID_PRIMARY"}},
                {"type": "user", "message": {"role": "user", "content": WRAPPED}},
            ]
            with open(transcript, "w", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r) + "\n")

            client = _RecordingClient(memories=[_memory("m")])
            hook_input = {
                "prompt": WRAPPED,
                "session_id": "test-session",
                "transcript_path": transcript,
                "cwd": "/tmp",
            }
            config = {
                "autoRecall": True,
                "bankId": "test-bank",
                "recallMaxTokens": 1024,
                "recallBudget": "mid",
                "recallContextTurns": 2,
                "recallMaxQueryChars": 800,
                "recallPromptPreamble": "",
            }
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(recall, "load_config", return_value=config), patch.object(
                recall, "get_api_url", return_value="http://localhost:18888"
            ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
                recall, "ensure_bank_mission", return_value=None
            ), patch.object(recall, "write_state", return_value=None), patch(
                "sys.stdin", new=io.StringIO(json.dumps(hook_input))
            ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
                recall.main()

            self.assertEqual(len(client.queries), 1)
            q = client.queries[0]
            self.assertNotIn("<channel", q)
            self.assertNotIn("chat_id", q)
            self.assertIn("Prior context:", q)
            self.assertTrue(q.rstrip().endswith(BARE))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class _LogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-log-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
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


class StrippedQueryInLog(_LogTestBase):
    def test_logged_query_has_no_channel_envelope(self):
        client = _RecordingClient(memories=[_memory("m", mem_id="m1")])
        _run_main_with(client, prompt=WRAPPED)
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertIn("query", e)
        self.assertEqual(e["query"], BARE)
        self.assertNotIn("<channel", e["query"])
        self.assertNotIn("chat_id", e["query"])


class RecallTelemetryFields(_LogTestBase):
    def test_telemetry_fields_present_on_success(self):
        client = _RecordingClient(memories=[_memory("m", mem_id="m1")])
        _run_main_with(client, prompt=BARE)
        e = self._read_log()[0]
        self.assertIn("total_elapsed_ms", e)
        self.assertIsInstance(e["total_elapsed_ms"], int)
        self.assertGreaterEqual(e["total_elapsed_ms"], 0)
        self.assertIn("directives_elapsed_ms", e)
        self.assertIsInstance(e["directives_elapsed_ms"], int)
        self.assertIn("deadline_hit", e)
        self.assertFalse(e["deadline_hit"])
        # One bank timing record for the own bank, no timeout.
        self.assertIn("bank_timings", e)
        self.assertEqual(len(e["bank_timings"]), 1)
        bt = e["bank_timings"][0]
        self.assertEqual(bt["bank_id"], "test-bank")
        self.assertFalse(bt["timed_out"])
        self.assertIsInstance(bt["elapsed_ms"], int)

    def test_additional_bank_gets_its_own_timing_record(self):
        client = _RecordingClient(memories=[_memory("m", mem_id="m1")])
        _run_main_with(
            client,
            prompt=BARE,
            config_extra={"recallAdditionalBanks": ["shared-bank"]},
        )
        e = self._read_log()[0]
        banks = [bt["bank_id"] for bt in e["bank_timings"]]
        self.assertEqual(banks, ["test-bank", "shared-bank"])

    def test_deadline_hit_true_when_a_bank_times_out(self):
        # Own bank succeeds; the additional bank raises a socket timeout.
        client = _RecordingClient(
            memories=[_memory("m", mem_id="m1")],
            bank_behaviour={"shared-bank": socket.timeout("timed out")},
        )
        _run_main_with(
            client,
            prompt=BARE,
            config_extra={"recallAdditionalBanks": ["shared-bank"]},
        )
        e = self._read_log()[0]
        self.assertTrue(e["deadline_hit"])
        timings = {bt["bank_id"]: bt for bt in e["bank_timings"]}
        self.assertFalse(timings["test-bank"]["timed_out"])
        self.assertTrue(timings["shared-bank"]["timed_out"])

    def test_non_timeout_error_is_not_deadline_hit(self):
        # A 5xx / connection error is an error but NOT a deadline hit.
        client = _RecordingClient(
            memories=[_memory("m", mem_id="m1")],
            bank_behaviour={"shared-bank": RuntimeError("HTTP 503 from server")},
        )
        _run_main_with(
            client,
            prompt=BARE,
            config_extra={"recallAdditionalBanks": ["shared-bank"]},
        )
        e = self._read_log()[0]
        self.assertFalse(e["deadline_hit"])
        timings = {bt["bank_id"]: bt for bt in e["bank_timings"]}
        self.assertFalse(timings["shared-bank"]["timed_out"])


class TimeoutClassifier(unittest.TestCase):
    """Unit coverage for _is_timeout_error's classification."""

    def test_socket_timeout(self):
        self.assertTrue(recall._is_timeout_error(socket.timeout("timed out")))

    def test_builtin_timeout_error(self):
        self.assertTrue(recall._is_timeout_error(TimeoutError("timed out")))

    def test_urlerror_wrapping_timeout(self):
        import urllib.error
        self.assertTrue(
            recall._is_timeout_error(urllib.error.URLError(socket.timeout("timed out")))
        )

    def test_runtime_error_with_timeout_message(self):
        self.assertTrue(recall._is_timeout_error(RuntimeError("request timed out after 8s")))

    def test_plain_http_error_is_not_timeout(self):
        self.assertFalse(recall._is_timeout_error(RuntimeError("HTTP 503 from server")))

    def test_connection_refused_is_not_timeout(self):
        self.assertFalse(recall._is_timeout_error(ConnectionRefusedError("refused")))


if __name__ == "__main__":
    unittest.main()
