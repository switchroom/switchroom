"""Switchroom memory-RFC P1 — incremental SessionEnd sweep, OUTCOME tests.

Before P1 the SessionEnd hook called ``run_retain(force=True)`` which retained
the WHOLE transcript, duplicating content the per-window retains already landed
(RFC §1.2). P1 makes the forced chunked sweep slice only the transcript tail
after the committed watermark, degrading to the whole transcript on any failure
so the §4.3 hazard (a raise here DELETES a turn) is never triggered.

Stdlib-only (`python3 -m unittest discover tests/`). Every test drives the real
hook code against a FAKE in-process daemon (no network, no LLM) and asserts
OUTCOMES — the bytes/turns that actually landed in the bank — not that a code
path ran.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import retain  # noqa: E402
from lib import watermark  # noqa: E402
from lib.client import HindsightClient  # noqa: E402


class FakeDaemon:
    """Records retained documents by document_id with upsert semantics."""

    def __init__(self):
        self.docs = {}   # document_id -> content
        self.posts = []  # [(document_id, async_processing)]

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True,
               observation_scopes=None):
        self.posts.append((document_id, async_processing))
        # Upsert: same document_id overwrites (the daemon contract §1).
        self.docs[document_id] = content
        return {"ok": True}

    def content_blob(self):
        return "\n".join(self.docs.values())

    def bytes_for(self, session_prefix: str) -> int:
        """Total stored content bytes across every document for a session."""
        return sum(
            len(c.encode("utf-8"))
            for doc_id, c in self.docs.items()
            if doc_id.startswith(session_prefix)
        )

    def last_post_content(self) -> str:
        return self.docs[self.posts[-1][0]]


def _write_transcript(path, n_turns, prefix):
    """Flat-format JSONL: n_turns human turns, each user+assistant with a uuid."""
    lines = []
    for i in range(n_turns):
        lines.append(json.dumps(
            {"role": "user", "content": f"user turn {i}", "uuid": f"{prefix}-u{i}"}))
        lines.append(json.dumps(
            {"role": "assistant", "content": f"assistant turn {i}", "uuid": f"{prefix}-a{i}"}))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def _stdin(obj):
    import io
    return io.StringIO(json.dumps(obj))


class IncrementalSweepBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-rfc-p1-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        self.transcripts = os.path.join(self.tmp, "transcripts")
        for d in (self.plugin_root, self.home, self.data, self.transcripts):
            os.makedirs(d)

        self._write_settings(8)  # default cadence for these tests; overridable

        self.env = mock.patch.dict(os.environ, {
            "CLAUDE_PLUGIN_ROOT": self.plugin_root,
            "CLAUDE_PLUGIN_DATA": self.data,
            "HOME": self.home,
            "HINDSIGHT_PENDING_DIR": os.path.join(self.home, ".hindsight", "pending-retains"),
            "HINDSIGHT_RETAINED_DIR": os.path.join(self.home, ".hindsight", "retained"),
            "HINDSIGHT_INFLIGHT_LOCK": os.path.join(self.home, ".hindsight", "retain-inflight.lock"),
            "HINDSIGHT_TRANSCRIPTS_DIR": self.transcripts,
        }, clear=False)
        self.env.start()
        for k in list(os.environ):
            if k.startswith("HINDSIGHT_") and k not in (
                "HINDSIGHT_PENDING_DIR", "HINDSIGHT_RETAINED_DIR",
                "HINDSIGHT_INFLIGHT_LOCK", "HINDSIGHT_TRANSCRIPTS_DIR",
            ):
                os.environ.pop(k, None)

        self.daemon = FakeDaemon()
        self._patches = [
            mock.patch.object(HindsightClient, "retain", self._fake_retain),
            mock.patch("retain.get_api_url", return_value="http://fake"),
        ]
        for p in self._patches:
            p.start()

    def _write_settings(self, every_n_turns: int):
        settings = {
            "autoRetain": True,
            "retainMode": "chunked",
            "retainEveryNTurns": every_n_turns,
            "retainOverlapTurns": 0,
            "bankId": "test-bank",
        }
        with open(os.path.join(self.plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

    def _fake_retain(self, *a, **kw):
        return self.daemon.retain(*a, **kw)

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _hook(self, session):
        return {
            "session_id": session,
            "transcript_path": os.path.join(self.transcripts, f"{session}.jsonl"),
            "cwd": "/x",
        }

    def _fire_window(self, session, transcript_turns, turn_count):
        """Drive a live per-window Stop retain (advances the watermark)."""
        _write_transcript(self._hook(session)["transcript_path"], transcript_turns, session)
        with mock.patch("retain.increment_turn_count", return_value=turn_count), \
                mock.patch("sys.stdin", _stdin(self._hook(session))):
            retain.main()


class TestIncrementalSweep(IncrementalSweepBase):

    def test_two_turn_no_watermark_sweep_retains_both_turns(self):
        # A short session that never fired a per-window retain has no committed
        # watermark, so the forced sweep must flush the WHOLE (2-turn) transcript
        # (RFC §4.2 — short sessions still land on disk).
        session = "sessShort"
        _write_transcript(self._hook(session)["transcript_path"], 2, session)
        self.assertIsNone(watermark.load(session))  # precondition: no watermark

        result = retain.run_retain(self._hook(session), force=True)

        self.assertEqual(result.get("status"), "ok")
        blob = self.daemon.content_blob()
        self.assertIn("user turn 0", blob)
        self.assertIn("user turn 1", blob)

    def test_thirty_turn_sweep_is_incremental_and_smaller_than_full(self):
        # Windows fire at turns 8/16/24 (n=8, overlap 0), then SessionEnd sweeps.
        # The sweep must contain ONLY turns after the last window's tail uuid,
        # and the total bytes stored for the session must be strictly less than
        # the pre-change (full-session sweep) total. This is the test that fails
        # on the bug it guards: a non-incremental sweep re-stores all 30 turns,
        # so the totals become equal and assertLess fires.
        inc = "sessInc"
        for fire_at in (8, 16, 24):
            self._fire_window(inc, fire_at, fire_at)
        # The last window committed its tail uuid as the watermark.
        wm = watermark.load(inc)
        self.assertIsNotNone(wm, "expected the per-window retains to commit a watermark")
        self.assertEqual(wm["last_uuid"], f"{inc}-a23")

        _write_transcript(self._hook(inc)["transcript_path"], 30, inc)
        result = retain.run_retain(self._hook(inc), force=True)
        self.assertEqual(result.get("status"), "ok")

        sweep = self.daemon.last_post_content()
        # Only turns AFTER the watermark (24..29); nothing at/ before it.
        for i in range(24, 30):
            self.assertIn(f"user turn {i}", sweep, f"turn {i} missing from incremental sweep")
        for i in (0, 15, 23):
            self.assertNotIn(f"user turn {i}", sweep,
                             f"turn {i} leaked into the incremental sweep")

        # Pre-change baseline: identical scenario, but the SessionEnd sweep runs
        # full-session (watermark unseen), on a distinct session id in the same
        # daemon so window docs are directly comparable.
        full = "sessFull"
        for fire_at in (8, 16, 24):
            self._fire_window(full, fire_at, fire_at)
        _write_transcript(self._hook(full)["transcript_path"], 30, full)
        with mock.patch("retain.watermark.load", return_value=None):
            self.assertEqual(retain.run_retain(self._hook(full), force=True).get("status"), "ok")

        self.assertLess(
            self.daemon.bytes_for(inc),
            self.daemon.bytes_for(full),
            "incremental sweep did not reduce total retained bytes vs full sweep",
        )

    def test_corrupt_watermark_json_sweeps_whole_transcript_no_raise(self):
        # A watermark file corrupted to invalid JSON must degrade to a whole
        # -transcript sweep, and no exception may escape run_retain (§4.3).
        session = "sessCorrupt"
        _write_transcript(self._hook(session)["transcript_path"], 4, session)
        retained_dir = os.environ["HINDSIGHT_RETAINED_DIR"]
        os.makedirs(retained_dir, exist_ok=True)
        with open(os.path.join(retained_dir, f"{session}.json"), "w") as f:
            f.write("{ this is not valid json ]]]")

        try:
            result = retain.run_retain(self._hook(session), force=True)
        except Exception as e:  # noqa: BLE001 - the whole point is nothing escapes
            self.fail(f"run_retain raised into the SessionEnd seam: {e!r}")

        self.assertEqual(result.get("status"), "ok")
        blob = self.daemon.content_blob()
        for i in range(4):
            self.assertIn(f"user turn {i}", blob)

    def test_watermark_load_raising_degrades_to_full_sweep(self):
        # Belt-and-braces for the §4.3 catch-all: even if the watermark READ
        # itself raises an unexpected error, run_retain must NOT propagate it —
        # it degrades to the whole-transcript sweep.
        session = "sessBoom"
        _write_transcript(self._hook(session)["transcript_path"], 4, session)

        def _boom(_):
            raise RuntimeError("simulated watermark read explosion")

        with mock.patch("retain.watermark.load", side_effect=_boom):
            try:
                result = retain.run_retain(self._hook(session), force=True)
            except Exception as e:  # noqa: BLE001
                self.fail(f"run_retain propagated a watermark read failure: {e!r}")

        self.assertEqual(result.get("status"), "ok")
        blob = self.daemon.content_blob()
        for i in range(4):
            self.assertIn(f"user turn {i}", blob)

    def test_compacted_watermark_uuid_sweeps_whole_transcript(self):
        # The watermark anchor was compacted out of the transcript: tail_after
        # cannot find it and returns the whole transcript (a safe re-upsert).
        session = "sessCompact"
        _write_transcript(self._hook(session)["transcript_path"], 4, session)
        # Commit a watermark whose uuid is NOT present in the transcript.
        watermark.commit(session, "ghost-uuid-not-in-transcript", "doc-ghost",
                         ordered_uuids=["ghost-uuid-not-in-transcript"])
        self.assertEqual(watermark.load(session)["last_uuid"], "ghost-uuid-not-in-transcript")

        result = retain.run_retain(self._hook(session), force=True)
        self.assertEqual(result.get("status"), "ok")
        blob = self.daemon.content_blob()
        for i in range(4):
            self.assertIn(f"user turn {i}", blob)

    def test_every_n_turns_1_is_byte_identical_full_session(self):
        # At retainEveryNTurns==1 the document id is {session_id} and a tail slice
        # would TRUNCATE it (RFC §4.2). The n==1 path must keep the full-session
        # sweep even when a committed watermark exists — byte-identical to before.
        self._write_settings(1)
        session = "sessN1"
        _write_transcript(self._hook(session)["transcript_path"], 4, session)
        # A watermark exists (a prior every-turn fire) sitting mid-transcript.
        watermark.commit(session, f"{session}-a1", "doc-prior",
                         ordered_uuids=[f"{session}-u{i//2}" if i % 2 == 0 else f"{session}-a{i//2}"
                                        for i in range(8)])
        self.assertEqual(watermark.load(session)["last_uuid"], f"{session}-a1")

        result = retain.run_retain(self._hook(session), force=True)
        self.assertEqual(result.get("status"), "ok")

        # Whole transcript, under the plain {session_id} document id — the tail
        # slice must NOT have applied.
        self.assertIn(session, self.daemon.docs, "n==1 sweep must post under the {session_id} id")
        content = self.daemon.docs[session]
        for i in range(4):
            self.assertIn(f"user turn {i}", content, f"turn {i} missing — n==1 sweep was truncated")


if __name__ == "__main__":
    unittest.main()
