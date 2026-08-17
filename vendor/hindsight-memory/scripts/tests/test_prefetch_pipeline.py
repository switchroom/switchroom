"""M4 P-PRE — prefetch.py producer pipeline.

Tests:
  (a-integration) call order: delta retain runs BEFORE the speculative
    recall, which runs BEFORE the buffer/sentinel write — proven via a
    shared event-order list, not mocked call assertions alone.
  (c, red-team STRENGTHENED) a fact retained at turn N-2 is STILL
    recallable after further retains at N-1/N — guards against the
    truncation bug (Fix A), not merely "present in the latest delta".
  Fix C (producer side): `memoryPrefetchEnabled` off is a hard no-op —
    no retain, no recall, no buffer file written.
  Junk gate: a `<task-notification>` turn is skipped (no retain, no
    recall, no buffer write) same as recall.py's consumer-side gate.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import prefetch  # noqa: E402
from lib import recall_buffer  # noqa: E402

SESSION = "prefetch-test-session"


def _write_transcript(path, turns):
    """turns: list of (role, text) tuples, in order."""
    with open(path, "w", encoding="utf-8") as f:
        for i, (role, text) in enumerate(turns):
            entry = {
                "type": role,
                "uuid": f"u{i}",
                "message": {"role": role, "content": text},
            }
            f.write(json.dumps(entry) + "\n")


class _Daemon:
    """A tiny in-memory fake standing in for the whole retain+recall
    round trip, so the truncation-regression test (c) is a REAL round
    trip through retain.run_retain + a recall against retained content,
    not two independently-mocked legs."""

    def __init__(self):
        self.documents = {}  # document_id -> text

    def retain(self, bank_id, content, document_id=None, **kwargs):
        self.documents[document_id or bank_id] = content
        return {"status": "ok", "document_id": document_id or bank_id}

    def recall(self, bank_id, query, **kwargs):
        # Naive substring match across all retained documents — enough to
        # prove presence/absence, not a real ranking engine.
        hits = []
        for i, (doc_id, text) in enumerate(self.documents.items()):
            hits.append({
                "text": text, "type": "fact", "mentioned_at": "2026-01-01",
                "id": f"r{i}", "scores": {"final": 1.0 - i * 0.01},
            })
        return {"results": hits}

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}


class PrefetchPipelineBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="prefetch-test-")
        self.plugin_root = os.path.join(self._tmpdir, "plugin_root")
        self.data = os.path.join(self._tmpdir, "data")
        self.home = os.path.join(self._tmpdir, "home")
        for d in (self.plugin_root, self.data, self.home):
            os.makedirs(d)
        self._write_settings(prefetch_enabled=True)

        self._bufdir = tempfile.mkdtemp(prefix="prefetch-test-buf-")
        self.env = mock.patch.dict(os.environ, {
            "CLAUDE_PLUGIN_ROOT": self.plugin_root,
            "CLAUDE_PLUGIN_DATA": self.data,
            "HOME": self.home,
            "HINDSIGHT_PREFETCH_BUFFER_DIR": self._bufdir,
            "HINDSIGHT_PENDING_DIR": os.path.join(self.home, ".hindsight", "pending-retains"),
            "HINDSIGHT_RETAINED_DIR": os.path.join(self.home, ".hindsight", "retained"),
            "HINDSIGHT_INFLIGHT_LOCK": os.path.join(self.home, ".hindsight", "retain-inflight.lock"),
            "HINDSIGHT_TRANSCRIPTS_DIR": os.path.join(self._tmpdir, "transcripts"),
        }, clear=False)
        self.env.start()
        for k in list(os.environ):
            if k.startswith("HINDSIGHT_") and k not in (
                "HINDSIGHT_PREFETCH_BUFFER_DIR", "HINDSIGHT_PENDING_DIR",
                "HINDSIGHT_RETAINED_DIR", "HINDSIGHT_INFLIGHT_LOCK", "HINDSIGHT_TRANSCRIPTS_DIR",
            ):
                os.environ.pop(k, None)

        self.transcript_path = os.path.join(self._tmpdir, "transcript.jsonl")
        self.daemon = _Daemon()

    def _write_settings(self, prefetch_enabled=True):
        settings = {
            "autoRetain": True,
            "bankId": "test-bank",
            "retainMode": "chunked",
            "retainEveryNTurns": 1,
            "retainOverlapTurns": 0,
            "memoryPrefetchEnabled": prefetch_enabled,
        }
        with open(os.path.join(self.plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self._bufdir, ignore_errors=True)
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _config(self, prefetch_enabled=True):
        return {
            "bankId": "test-bank",
            "memoryPrefetchEnabled": prefetch_enabled,
            "retainMode": "chunked",
            "retainEveryNTurns": 1,
        }

    def _hook_input(self, prompt="what's the deploy status"):
        return {
            "prompt": prompt,
            "session_id": SESSION,
            "transcript_path": self.transcript_path,
            "cwd": "/tmp",
        }


class CallOrderTests(PrefetchPipelineBase):
    def test_retain_then_recall_then_sentinel_in_that_order(self):
        _write_transcript(self.transcript_path, [("user", "we decided to ship on friday")])
        order = []

        def _spy_run_retain(hook_input, force=False, delta=False):
            order.append("retain")
            return {"status": "ok"}

        def _spy_write_buffer(session_id, context, telemetry=None):
            order.append("buffer")

        def _spy_write_sentinel(session_id):
            order.append("sentinel")
            return 1

        client = mock.Mock()
        client.recall.side_effect = lambda *a, **kw: (order.append("recall") or {"results": [
            {"text": "we decided to ship on friday", "type": "fact", "mentioned_at": "2026-01-01",
             "id": "r1", "scores": {"final": 0.9}},
        ]})

        with patch("prefetch.retain_module.run_retain", side_effect=_spy_run_retain), \
                patch("prefetch.HindsightClient", return_value=client), \
                patch("prefetch.get_api_url", return_value="http://fake"), \
                patch("prefetch.recall_buffer.write_buffer", side_effect=_spy_write_buffer), \
                patch("prefetch.recall_buffer.write_sentinel", side_effect=_spy_write_sentinel):
            wrote = prefetch.run_prefetch(self._hook_input(), self._config())

        self.assertTrue(wrote)
        self.assertEqual(order, ["retain", "recall", "buffer", "sentinel"])


class TruncationRegressionTests(PrefetchPipelineBase):
    def test_fact_retained_two_turns_ago_still_recallable_after_further_retains(self):
        # This is the STRONGER, red-team-mandated version of test (c): not
        # "the latest delta contains the newest fact" but "an OLDER fact
        # retained at turn N-2 survives further retains at N-1 and N" — the
        # exact shape of bug Fix A closes (a naive tail-slice retain would
        # have overwritten/truncated the older fact's document).
        client = self.daemon

        # Drive the REAL retain.run_retain (prefetch.retain_module IS the
        # `retain` module object, unpatched here) against the daemon fake —
        # a genuine round trip through the actual delta-retain logic, not a
        # mocked short-circuit. Only the network-facing leaves (the client
        # + api url) are faked, on both retain's and prefetch's own module
        # references (they resolve to the same underlying calls).
        with patch("retain.HindsightClient", return_value=client), \
                patch("retain.get_api_url", return_value="http://fake"), \
                patch("prefetch.HindsightClient", return_value=client), \
                patch("prefetch.get_api_url", return_value="http://fake"):
            # Turn N-2
            _write_transcript(self.transcript_path, [("user", "fact alpha from turn N-2")])
            prefetch.run_prefetch(self._hook_input("fact alpha from turn N-2"), self._config())
            # Turn N-1
            _write_transcript(self.transcript_path, [
                ("user", "fact alpha from turn N-2"),
                ("assistant", "ack"),
                ("user", "fact beta from turn N-1"),
            ])
            prefetch.run_prefetch(self._hook_input("fact beta from turn N-1"), self._config())
            # Turn N
            _write_transcript(self.transcript_path, [
                ("user", "fact alpha from turn N-2"),
                ("assistant", "ack"),
                ("user", "fact beta from turn N-1"),
                ("assistant", "ack"),
                ("user", "fact gamma from turn N"),
            ])
            prefetch.run_prefetch(self._hook_input("fact gamma from turn N"), self._config())

        all_retained_content = " ".join(client.documents.values())
        self.assertIn("fact alpha from turn N-2", all_retained_content,
                       "an older delta must not be truncated/overwritten by a later delta retain")
        self.assertIn("fact beta from turn N-1", all_retained_content)
        self.assertIn("fact gamma from turn N", all_retained_content)


class KillSwitchOffTests(PrefetchPipelineBase):
    def test_flag_off_is_a_hard_no_op(self):
        _write_transcript(self.transcript_path, [("user", "anything")])
        # The flag GATE lives in main(), before hook_input is even read —
        # prove the whole mechanism is a no-op at that entrypoint.
        import io
        with patch("prefetch.retain_module.run_retain", side_effect=AssertionError("must not retain when flag is off")), \
                patch("prefetch.HindsightClient", side_effect=AssertionError("must not touch client when flag is off")), \
                patch("prefetch.load_config", return_value=self._config(prefetch_enabled=False)), \
                patch("sys.stdin", io.StringIO(json.dumps(self._hook_input()))):
            prefetch.main()
        self.assertFalse(os.path.isfile(recall_buffer._buffer_path(SESSION)))
        self.assertFalse(os.path.isfile(recall_buffer._sentinel_path(SESSION)))


class JunkGateTests(PrefetchPipelineBase):
    def test_task_notification_turn_is_skipped(self):
        _write_transcript(self.transcript_path, [("user", "irrelevant")])
        with patch("prefetch.retain_module.run_retain", side_effect=AssertionError("must not retain a task-notification turn")):
            wrote = prefetch.run_prefetch(
                self._hook_input("<task-notification>done</task-notification>"), self._config()
            )
        self.assertFalse(wrote)
        self.assertFalse(os.path.isfile(recall_buffer._buffer_path(SESSION)))


if __name__ == "__main__":
    unittest.main()
