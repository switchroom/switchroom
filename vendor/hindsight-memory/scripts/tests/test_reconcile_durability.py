"""Switchroom #3244 — durable-retain / boot-reconciliation outcome tests.

Stdlib-only (`python3 -m unittest discover tests/`). Every test drives the real
hook code against a FAKE in-process daemon (no network, no LLM) and asserts
OUTCOMES — content landed in the bank / entries landed in the pending queue /
the watermark's value — not merely that a code path ran.

Covers the PR1 slice of design-20260715.md §4: tests 1 (SIGKILL→boot recall),
2 (failed Stop retain enqueued), 3 (live-Stop + reconcile ⇒ ONE doc via the
single deterministic id), 6 (watermark monotonicity + uuid-not-found), 7
(200-not-persisted / commit-before-ack), 9 (dry-run/seam zero writes), 10 (a
bound ENQUEUES the remainder).
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

import reconcile_tail  # noqa: E402
import retain  # noqa: E402
from lib import watermark  # noqa: E402
from lib.client import HindsightClient  # noqa: E402


class FakeDaemon:
    """Records retained documents by document_id with upsert semantics.

    ``fail`` → every POST raises (stressed/unreachable daemon).
    ``drop_async`` → an ``async_processing=True`` POST 200s but does NOT persist
    (ack-of-receipt, extraction lost) — the #3244 async-200 hazard. An
    ``async_processing=False`` POST always persists (commit-before-ack).
    """

    def __init__(self):
        self.docs = {}          # document_id -> {content, metadata, async}
        self.posts = []         # [(document_id, async_processing)]
        self.fail = False
        self.drop_async = False

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True):
        self.posts.append((document_id, async_processing))
        if self.fail:
            raise RuntimeError("simulated daemon failure")
        persisted = (not async_processing) or (not self.drop_async)
        if persisted:
            # Upsert: same document_id overwrites (the daemon contract §1).
            self.docs[document_id] = {
                "content": content, "metadata": metadata, "async": async_processing,
            }
        return {"ok": True}

    # Any content substring present across all stored docs?
    def content_blob(self):
        return "\n".join(d["content"] for d in self.docs.values())


def _write_transcript(path, n_turns, session_prefix="u"):
    """Flat-format JSONL: n_turns human turns (user+assistant), each with a uuid."""
    lines = []
    for i in range(n_turns):
        lines.append(json.dumps({"role": "user", "content": f"user turn {i}", "uuid": f"{session_prefix}-u{i}"}))
        lines.append(json.dumps({"role": "assistant", "content": f"assistant turn {i}", "uuid": f"{session_prefix}-a{i}"}))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


class DurabilityTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-3244-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        self.transcripts = os.path.join(self.tmp, "transcripts")
        for d in (self.plugin_root, self.home, self.data, self.transcripts):
            os.makedirs(d)

        # chunked + n=3 → the deployed default, which exercises the
        # content-derived document_id path (§1). bankMission empty → no mission
        # PATCH. autoRetain on.
        settings = {
            "autoRetain": True,
            "autoRecall": True,
            "retainMode": "chunked",
            "retainEveryNTurns": 3,
            "retainOverlapTurns": 0,
            "bankId": "test-bank",
            "reconcileOnStart": True,
        }
        with open(os.path.join(self.plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

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
            mock.patch("reconcile_tail.get_api_url", return_value="http://fake"),
        ]
        for p in self._patches:
            p.start()

    def _fake_retain(self, *a, **kw):
        return self.daemon.retain(*a, **kw)

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _config(self):
        from lib.config import load_config
        return load_config()

    def _pending_entries(self):
        from lib import pending
        return pending.iter_entries()


class TestForwardFix(DurabilityTestBase):
    # -- Test 1: SIGKILL-after-work → next-boot reconcile surfaces it -----------
    def test_sigkill_then_boot_reconcile_recovers_all_turns(self):
        session = "sessA"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 5, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # (b) Stop retains fire but the daemon REFUSES them. run via main() so
        # the A2 enqueue path is exercised.
        self.daemon.fail = True
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()

        # watermark did NOT advance (no confirmed persistence) ...
        self.assertIsNone(watermark.load(session))
        # ... and the failed Stop retain was ENQUEUED, not dropped (A2).
        self.assertEqual(len(self._pending_entries()), 1)

        # (c) No SessionEnd fires (abrupt kill). (d) Boot against a healthy daemon.
        self.daemon.fail = False
        reconcile_tail.reconcile(self._config(), hook_input=hook)

        # OUTCOME: all 5 turns' content is now in the bank.
        blob = self.daemon.content_blob()
        for i in range(5):
            self.assertIn(f"user turn {i}", blob)
        # And the watermark now anchors on the last committed entry.
        wm = watermark.load(session)
        self.assertIsNotNone(wm)
        self.assertEqual(wm["last_uuid"], f"{session}-a4")

    # -- Test 2: failed Stop retain is enqueued, not dropped --------------------
    def test_failed_stop_retain_enqueued_with_deterministic_id(self):
        session = "sessB"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 3, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        self.daemon.fail = True
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()

        entries = self._pending_entries()
        self.assertEqual(len(entries), 1)
        _, entry = entries[0]
        # The queued payload carries the deterministic content-derived id.
        self.assertTrue(entry["document_id"].startswith(f"{session}-r"))
        self.assertIn(f"{session}-u", entry["document_id"])  # full uuids, not 8-char

        # Drain against a healthy daemon delivers it and deletes the entry.
        self.daemon.fail = False
        from drain_pending import drain
        drain(self._config())
        self.assertEqual(len(self._pending_entries()), 0)
        self.assertIn(entry["document_id"], self.daemon.docs)

    # -- Test 3 (rewritten): live Stop + reconcile of same window ⇒ ONE doc -----
    def test_live_stop_and_reconcile_converge_on_single_document(self):
        session = "sessC"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 3, session_prefix=session)  # window(3) == whole transcript
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # Live Stop retain — writes the content-derived id, advances watermark.
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        self.assertEqual(len(self.daemon.docs), 1)
        live_id = self.daemon.posts[0][0]
        self.assertTrue(live_id.startswith(f"{session}-r"))

        # Simulate a watermark loss (container recreate) so reconcile RE-posts
        # the same window — proving the two paths collide on document_id.
        os.remove(os.path.join(os.environ["HINDSIGHT_RETAINED_DIR"], f"{session}.json"))
        reconcile_tail.reconcile(self._config(), hook_input=hook)

        # Two POSTs, identical id, still exactly ONE stored document (upsert).
        self.assertEqual(len(self.daemon.docs), 1)
        self.assertEqual(self.daemon.posts[-1][0], live_id)

    # -- Test 7: commit-before-ack; 200-not-persisted doesn't advance watermark -
    def test_durability_posts_are_synchronous_and_gate_the_watermark(self):
        session = "sessD"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 3, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # A failing durability POST must NOT advance the watermark ...
        self.daemon.fail = True
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        self.assertIsNone(watermark.load(session))

        # ... and every durability POST is async_processing=False (commit-before
        # -ack), so a bare async-200 can never falsely mark work committed.
        self.assertTrue(self.daemon.posts, "expected at least one durability POST")
        self.assertTrue(all(async_flag is False for _, async_flag in self.daemon.posts))

        # Next boot re-catches the turns and advances the watermark.
        self.daemon.fail = False
        reconcile_tail.reconcile(self._config(), hook_input=hook)
        self.assertIsNotNone(watermark.load(session))
        self.assertIn("user turn 2", self.daemon.content_blob())

    # -- Test 10: a bound (200-turn cap) ENQUEUES the remainder -----------------
    def test_turn_cap_enqueues_remainder_never_truncates(self):
        session = "sessE"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 6, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # Cap the boot reconcile at 2 human turns; the other 4 must be enqueued,
        # not dropped.
        with mock.patch.dict(os.environ, {"HINDSIGHT_RECONCILE_MAX_TURNS": "2"}):
            reconcile_tail.reconcile(self._config(), hook_input=hook)

        # Inline landed the most-recent 2 turns ...
        blob = self.daemon.content_blob()
        self.assertIn("user turn 5", blob)
        self.assertIn("user turn 4", blob)
        # ... and the older remainder is ENQUEUED (not lost).
        self.assertEqual(len(self._pending_entries()), 1)

        # A subsequent boot drains the remainder → older turns land too.
        from drain_pending import drain
        drain(self._config())
        blob2 = self.daemon.content_blob()
        for i in range(6):
            self.assertIn(f"user turn {i}", blob2)

    # -- Test 9 (seam): build_retain_payload is network- and mission-write-free -
    def test_build_retain_payload_is_write_free(self):
        session = "sessF"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 2, session_prefix=session)
        msgs = retain.read_transcript(tpath)

        def _boom(*a, **kw):
            raise AssertionError("build_retain_payload must not touch the network")

        with mock.patch.object(HindsightClient, "retain", _boom), \
             mock.patch.object(HindsightClient, "set_bank_mission", _boom):
            built = retain.build_retain_payload(
                self._config(), session, msgs, msgs,
                bank_id="test-bank", api_url="http://fake", api_token=None,
            )
        self.assertIsNotNone(built)
        self.assertTrue(built["document_id"].startswith(f"{session}-r"))
        self.assertEqual(built["last_uuid"], f"{session}-a1")
        # No POST reached the daemon.
        self.assertEqual(self.daemon.posts, [])


class TestWatermark(DurabilityTestBase):
    # -- Test 6: monotonicity + uuid-not-found branch --------------------------
    def test_watermark_never_regresses_and_handles_stale_anchor(self):
        session = "wm1"
        ordered = ["e0", "e1", "e2", "e3"]
        watermark.commit(session, "e2", "doc-e2", ordered_uuids=ordered)
        self.assertEqual(watermark.load(session)["last_uuid"], "e2")

        # Backward move refused (e1 is before e2).
        watermark.commit(session, "e1", "doc-e1", ordered_uuids=ordered)
        self.assertEqual(watermark.load(session)["last_uuid"], "e2")

        # Forward move accepted.
        watermark.commit(session, "e3", "doc-e3", ordered_uuids=ordered)
        self.assertEqual(watermark.load(session)["last_uuid"], "e3")

        # uuid-not-found branch: the stored anchor was compacted away — accept
        # the incoming commit rather than crash/mis-compare.
        compacted_order = ["c0", "c1"]
        got = watermark.commit(session, "c1", "doc-c1", ordered_uuids=compacted_order)
        self.assertIsNotNone(got)
        self.assertEqual(watermark.load(session)["last_uuid"], "c1")

    def test_watermark_ignores_empty_uuid(self):
        self.assertIsNone(watermark.commit("wm2", "", "doc", ordered_uuids=[]))
        self.assertIsNone(watermark.load("wm2"))


def _stdin(obj):
    import io
    return io.StringIO(json.dumps(obj))


if __name__ == "__main__":
    unittest.main()
