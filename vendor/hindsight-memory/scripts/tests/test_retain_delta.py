"""M4 P-RET — per-turn delta retain, OUTCOME tests (red-team Finding A/A2).

Red-team verdict (redteam-M4.md, BINDING): as the carve drafted P-RET, a
per-turn delta retain at ``retainEveryNTurns==1`` would slice the transcript
tail and POST it under ``document_id={session_id}`` — the SAME id the
full-session path uses — which UPSERTS (overwrites) the whole session's
stored memory with just the latest turn on every successful turn. This is the
single most dangerous defect the red-team found (worse than the crash seam
the carve flagged as "the whole ballgame").

The fix under test: ``run_retain(hook_input, delta=True)`` must ALWAYS post
under a distinct, content-derived ``document_id`` (mirroring the existing
``retainEveryNTurns>1`` chunked-mode strategy) — never ``{session_id}`` — so
each delta lands as its own document and prior turns are never truncated.

Stdlib-only (``python3 -m unittest discover tests/``). Every test drives the
real ``retain.run_retain`` against a FAKE in-process daemon (no network, no
LLM) and asserts OUTCOMES (what actually landed in the bank), never a code
path or an internal flag — per the M4 test-harness rule.
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
    """Records retained documents by document_id with upsert semantics —
    exactly the hazard under test: a bad document_id choice silently
    overwrites (upserts) a prior document instead of creating a new one."""

    def __init__(self):
        self.docs = {}   # document_id -> content
        self.posts = []  # [(document_id, content)]

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True,
               observation_scopes=None):
        self.posts.append((document_id, content))
        self.docs[document_id] = content
        return {"ok": True}

    def all_content(self) -> str:
        return "\n".join(self.docs.values())


def _write_transcript(path, n_turns, prefix, start=0):
    lines = []
    for i in range(start, start + n_turns):
        lines.append(json.dumps(
            {"role": "user", "content": f"user turn {i}", "uuid": f"{prefix}-u{i}"}))
        lines.append(json.dumps(
            {"role": "assistant", "content": f"assistant turn {i}", "uuid": f"{prefix}-a{i}"}))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def _append_turn(path, i, prefix):
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n")
        f.write(json.dumps({"role": "user", "content": f"user turn {i}", "uuid": f"{prefix}-u{i}"}))
        f.write("\n")
        f.write(json.dumps({"role": "assistant", "content": f"assistant turn {i}", "uuid": f"{prefix}-a{i}"}))


class DeltaRetainBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-m4-delta-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        self.transcripts = os.path.join(self.tmp, "transcripts")
        for d in (self.plugin_root, self.home, self.data, self.transcripts):
            os.makedirs(d)

        self._write_settings(every_n_turns=1, prefetch_enabled=True)

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

    def _write_settings(self, every_n_turns: int, prefetch_enabled: bool):
        settings = {
            "autoRetain": True,
            "retainMode": "chunked",
            "retainEveryNTurns": every_n_turns,
            "retainOverlapTurns": 0,
            "bankId": "test-bank",
            "memoryPrefetchEnabled": prefetch_enabled,
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


class TestDeltaRetainDoesNotTruncate(DeltaRetainBase):
    """The RED test for red-team Finding A: retain turn N, then retain turn
    N+1 — BOTH facts must survive, not just the latest. As the carve drafted
    it (document_id={session_id} at every_n==1), the second delta would
    upsert-overwrite the first and this test would fail."""

    def test_round_trip_both_turns_survive_delta_retain(self):
        session = "sessDelta"
        path = self._hook(session)["transcript_path"]

        # Turn N: state a novel fact.
        _write_transcript(path, 1, session, start=0)
        result_n = retain.run_retain(self._hook(session), force=False, delta=True)
        self.assertEqual(result_n.get("status"), "ok")

        # Turn N+1: state a second, distinct fact.
        _append_turn(path, 1, session)
        result_n1 = retain.run_retain(self._hook(session), force=False, delta=True)
        self.assertEqual(result_n1.get("status"), "ok")

        # The failing-first assertion: BOTH facts survive across the whole
        # set of documents stored for this session — not just the latest.
        blob = self.daemon.all_content()
        self.assertIn("user turn 0", blob,
                       "turn N's fact was destroyed by the delta retain at turn N+1 "
                       "(document_id collision / truncating overwrite — Finding A)")
        self.assertIn("user turn 1", blob)

    def test_delta_document_id_is_never_the_bare_session_id(self):
        # The load-bearing requirement: delta retain must NEVER post under
        # document_id == session_id (that id is reserved for the
        # full-session / non-delta path and upserts destructively).
        session = "sessDeltaDocId"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 1, session, start=0)
        retain.run_retain(self._hook(session), force=False, delta=True)

        self.assertNotIn(session, self.daemon.docs,
                          "delta retain posted under the bare {session_id} document_id "
                          "— this OVERWRITES the whole-session document on every turn")
        self.assertEqual(len(self.daemon.docs), 1)

    def test_second_delta_document_id_differs_from_first(self):
        session = "sessDeltaDistinctIds"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 1, session, start=0)
        retain.run_retain(self._hook(session), force=False, delta=True)
        first_ids = set(self.daemon.docs.keys())

        _append_turn(path, 1, session)
        retain.run_retain(self._hook(session), force=False, delta=True)
        second_ids = set(self.daemon.docs.keys())

        self.assertEqual(len(second_ids), 2, "each delta must land as its OWN document")
        self.assertTrue(first_ids.issubset(second_ids))


class TestDeltaRetainSlicing(DeltaRetainBase):
    def test_delta_slices_only_tail_after_watermark(self):
        # The second delta's OWN document must contain only the NEW turn,
        # not a re-post of the first turn's content (proves it's an
        # incremental slice, not a full-window resend under a fresh id).
        session = "sessDeltaSlice"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 1, session, start=0)
        retain.run_retain(self._hook(session), force=False, delta=True)
        first_doc_content = list(self.daemon.docs.values())[0]

        _append_turn(path, 1, session)
        retain.run_retain(self._hook(session), force=False, delta=True)

        newest_doc_id, newest_content = self.daemon.posts[-1]
        self.assertIn("user turn 1", newest_content)
        self.assertNotIn("user turn 0", newest_content,
                          "second delta re-sent the first turn — not an incremental slice")

    def test_delta_bypasses_every_n_throttle(self):
        # Delta mode is a distinct per-turn mechanism (called every turn by
        # prefetch.py) — it must fire regardless of retainEveryNTurns, and
        # must NOT consume/advance the every-Nth turn-count throttle.
        self._write_settings(every_n_turns=5, prefetch_enabled=True)
        session = "sessDeltaThrottle"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 1, session, start=0)

        result = retain.run_retain(self._hook(session), force=False, delta=True)
        self.assertEqual(result.get("status"), "ok",
                          "delta retain must fire even when every_n_turns=5 and this "
                          "would be throttled on the normal (non-delta) path")

    def test_delta_watermark_read_failure_degrades_to_full_window_no_raise(self):
        # Mirrors the existing §4.3 hazard discipline: a watermark read
        # failure on the delta path must degrade to a full-window slice
        # (never raise, never emit an empty/lost slice).
        session = "sessDeltaBoom"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 2, session, start=0)

        def _boom(_):
            raise RuntimeError("simulated watermark read explosion")

        with mock.patch("retain.watermark.load", side_effect=_boom):
            try:
                result = retain.run_retain(self._hook(session), force=False, delta=True)
            except Exception as e:  # noqa: BLE001
                self.fail(f"delta retain propagated a watermark read failure: {e!r}")

        self.assertEqual(result.get("status"), "ok")
        blob = self.daemon.all_content()
        self.assertIn("user turn 0", blob)
        self.assertIn("user turn 1", blob)


class TestSessionEndInterplayAtCadenceOne(DeltaRetainBase):
    """Finding A2: the SessionEnd force sweep only used the watermark at
    n>1. On a flipped (every_n==1, prefetch-enabled) agent it must ALSO use
    the watermark, so the SessionEnd sweep doesn't blindly re-post the whole
    session under {session_id} on top of the per-turn delta documents."""

    def test_force_sweep_at_cadence_one_is_incremental_when_prefetch_enabled(self):
        self._write_settings(every_n_turns=1, prefetch_enabled=True)
        session = "sessEndN1"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 1, session, start=0)
        retain.run_retain(self._hook(session), force=False, delta=True)

        _append_turn(path, 1, session)
        result = retain.run_retain(self._hook(session), force=True)
        self.assertEqual(result.get("status"), "ok")

        # The forced sweep's OWN post must be incremental (only the new
        # tail), not a full-session resend that duplicates turn 0.
        newest_doc_id, newest_content = self.daemon.posts[-1]
        self.assertIn("user turn 1", newest_content)
        self.assertNotIn("user turn 0", newest_content,
                          "SessionEnd force sweep at cadence-1 with prefetch enabled "
                          "ignored the watermark and re-swept the whole session")

    def test_force_sweep_at_cadence_one_is_full_session_when_prefetch_disabled(self):
        # Byte-identical-to-today guard: prefetch OFF (the fleet default)
        # must keep the existing full-session force-sweep behaviour even if
        # a watermark happens to exist.
        self._write_settings(every_n_turns=1, prefetch_enabled=False)
        session = "sessEndN1Off"
        path = self._hook(session)["transcript_path"]
        _write_transcript(path, 2, session, start=0)
        watermark.commit(session, f"{session}-a0", "doc-prior",
                          ordered_uuids=[f"{session}-u0", f"{session}-a0",
                                         f"{session}-u1", f"{session}-a1"])

        result = retain.run_retain(self._hook(session), force=True)
        self.assertEqual(result.get("status"), "ok")
        self.assertIn(session, self.daemon.docs,
                       "prefetch-disabled n==1 sweep must post under the bare {session_id} id")
        content = self.daemon.docs[session]
        self.assertIn("user turn 0", content)
        self.assertIn("user turn 1", content)


if __name__ == "__main__":
    unittest.main()
