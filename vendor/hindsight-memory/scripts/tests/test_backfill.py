"""Switchroom #3244 Part 2 — backfill outcome tests.

Stdlib-only (`python3 -m unittest discover tests/`). Every test drives the real
``backfill_transcripts`` code against a FAKE in-process daemon (no network, no
LLM) and asserts OUTCOMES — content landed in the bank / dedup to one document /
zero writes in dry-run / pacing spacing observed via a fake clock / resume
skips committed sessions — not merely that a code path ran.

Covers design-20260715.md §4 tests 4 (backfill dedup + pacing), 5
(resumability), 8 (dedups against pre-existing docs + total-loss posted in
full), 9 (dry-run ZERO writes incl. no mission PATCH).
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import backfill_transcripts as bf  # noqa: E402
from lib import watermark  # noqa: E402
from lib.client import HindsightClient  # noqa: E402


class FakeDaemon:
    """Records retained documents by document_id with UPSERT semantics (the
    confirmed daemon contract: same document_id ⇒ one row, full-replace)."""

    def __init__(self):
        self.docs = {}                 # document_id -> {content, ...}
        self.posts = []                # [(document_id, async_processing)]
        self.mission_patches = []      # set_bank_mission calls (must stay empty)
        self.fail = False
        self.max_inflight_seen = 0
        self._inflight = 0

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True):
        self._inflight += 1
        self.max_inflight_seen = max(self.max_inflight_seen, self._inflight)
        try:
            self.posts.append((document_id, async_processing))
            if self.fail:
                raise RuntimeError("simulated daemon failure")
            self.docs[document_id] = {"content": content, "metadata": metadata}
            return {"ok": True}
        finally:
            self._inflight -= 1

    def set_bank_mission(self, *a, **kw):
        self.mission_patches.append((a, kw))
        return {"ok": True}

    def content_blob(self):
        return "\n".join(d["content"] for d in self.docs.values())


def _write_transcript(path, n_turns, session_prefix="u"):
    lines = []
    for i in range(n_turns):
        lines.append(json.dumps({"role": "user", "content": f"user turn {i}", "uuid": f"{session_prefix}-u{i}"}))
        lines.append(json.dumps({"role": "assistant", "content": f"assistant turn {i}", "uuid": f"{session_prefix}-a{i}"}))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


class BackfillTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-3244-bf-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        self.agents_root = os.path.join(self.tmp, "agents")
        for d in (self.plugin_root, self.home, self.data, self.agents_root):
            os.makedirs(d)

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
            "HINDSIGHT_BACKFILL_PROGRESS": os.path.join(self.home, ".hindsight", "backfill-progress.json"),
            "HINDSIGHT_BACKFILL_LOCK": os.path.join(self.home, ".hindsight", "backfill.lock"),
            "HINDSIGHT_AGENTS_DIR": self.agents_root,
            "HINDSIGHT_BACKFILL_DELAY_MS": "0",   # tests inject their own delay
            "HINDSIGHT_BACKFILL_MIN_IDLE_S": "0",  # freshly-written fixtures aren't "active"
        }, clear=False)
        self.env.start()
        for k in list(os.environ):
            if k.startswith("HINDSIGHT_") and k not in (
                "HINDSIGHT_PENDING_DIR", "HINDSIGHT_RETAINED_DIR", "HINDSIGHT_INFLIGHT_LOCK",
                "HINDSIGHT_BACKFILL_PROGRESS", "HINDSIGHT_BACKFILL_LOCK", "HINDSIGHT_AGENTS_DIR",
                "HINDSIGHT_BACKFILL_DELAY_MS", "HINDSIGHT_BACKFILL_MIN_IDLE_S",
            ):
                os.environ.pop(k, None)

        self.daemon = FakeDaemon()
        self.sleeps = []
        self._patches = [
            mock.patch.object(HindsightClient, "retain", self._fake_retain),
            mock.patch.object(HindsightClient, "set_bank_mission", self._fake_mission),
            mock.patch("backfill_transcripts.get_api_url", return_value="http://fake"),
            mock.patch("backfill_transcripts._SLEEP", self._fake_sleep),
        ]
        for p in self._patches:
            p.start()

    def _fake_retain(self, *a, **kw):
        return self.daemon.retain(*a, **kw)

    def _fake_mission(self, *a, **kw):
        return self.daemon.set_bank_mission(*a, **kw)

    def _fake_sleep(self, secs):
        self.sleeps.append(secs)

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _config(self):
        from lib.config import load_config
        return load_config()

    def _transcript(self, agent, session, n_turns):
        path = os.path.join(self.agents_root, agent, ".claude", "projects", "proj", f"{session}.jsonl")
        _write_transcript(path, n_turns, session_prefix=session)
        return path


class TestBackfill(BackfillTestBase):
    # -- Recovers a total-loss session --------------------------------------
    def test_recovers_total_loss_session(self):
        self._transcript("clerk", "sess-lost", 4)
        report = bf.Backfill(self._config(), commit=True, delay_ms=0).run()

        blob = self.daemon.content_blob()
        for i in range(4):
            self.assertIn(f"user turn {i}", blob)
        self.assertEqual(report["rollup"]["sessions_total_loss"], 1)
        self.assertGreater(report["rollup"]["posts_ok"], 0)
        # Every durability POST is commit-before-ack.
        self.assertTrue(self.daemon.posts)
        self.assertTrue(all(async_flag is False for _, async_flag in self.daemon.posts))

    # -- Dedups against a pre-existing document with the same deterministic id
    def test_dedups_against_preexisting_document_id(self):
        path = self._transcript("clerk", "sess-dup", 3)
        # Pre-seed the daemon with the EXACT deterministic ids the backfill will
        # derive (as a prior live/backfill run would have written them).
        from retain import read_transcript
        msgs = read_transcript(path)
        slices = bf.chunk_by_human_turns(msgs, bf._slice_turns())
        seeded_ids = []
        for sl in slices:
            built = bf.build_retain_payload(
                self._config(), "sess-dup", sl, msgs, bank_id="test-bank",
                api_url="http://fake", api_token=None,
            )
            self.daemon.docs[built["document_id"]] = {"content": "STALE", "metadata": {}}
            seeded_ids.append(built["document_id"])
        self.assertTrue(seeded_ids)
        before = len(self.daemon.docs)

        bf.Backfill(self._config(), commit=True, delay_ms=0).run()

        # UPSERT: re-posting the same ids overwrites; document count unchanged
        # (no duplicates), and content now reflects the recovered turns.
        self.assertEqual(len(self.daemon.docs), before)
        for did in seeded_ids:
            self.assertNotEqual(self.daemon.docs[did]["content"], "STALE")

    # -- Dry-run performs ZERO writes (no retain POST, no mission PATCH) -----
    def test_dry_run_is_zero_write(self):
        self._transcript("clerk", "sess-dry", 5)
        report = bf.Backfill(self._config(), commit=False, delay_ms=0).run()

        # Report still lists the gap it WOULD recover ...
        self.assertEqual(report["rollup"]["sessions_total_loss"], 1)
        self.assertGreater(report["rollup"]["turns_recovered"], 0)
        # ... but not a single write reached the daemon.
        self.assertEqual(self.daemon.posts, [])
        self.assertEqual(self.daemon.mission_patches, [])
        # No progress recorded, no watermark advanced.
        self.assertFalse(os.path.exists(os.environ["HINDSIGHT_BACKFILL_PROGRESS"]))
        self.assertIsNone(watermark.load("sess-dry"))

    # -- Pacing: serial (one in flight) and spaced by the configured delay ---
    def test_pacing_is_serial_and_spaced(self):
        # Two sessions, several slices each (slice_turns=1 → one POST per turn).
        self._transcript("clerk", "sess-p1", 3)
        self._transcript("clerk", "sess-p2", 2)
        bf.Backfill(self._config(), commit=True, delay_ms=1500, slice_turns=1).run()

        # 5 POSTs total; never more than one in flight (serial worker).
        self.assertEqual(len(self.daemon.posts), 5)
        self.assertEqual(self.daemon.max_inflight_seen, 1)
        # Each POST after the first is preceded by the configured 1.5s delay.
        spaced = [s for s in self.sleeps if abs(s - 1.5) < 1e-9]
        self.assertEqual(len(spaced), 4)  # 5 posts → 4 inter-post gaps

    # -- Resumability: interrupt after N sessions, re-run skips committed -----
    def test_resumes_and_skips_committed_sessions(self):
        for i in range(4):
            self._transcript("clerk", f"sess-r{i}", 2)

        # First run: raise after the 2nd session's POST completes.
        real_post = bf.Backfill._post_slice
        state = {"posts": 0}

        def _interrupting_post(self, bank_id, built):
            # Raise at the START of the 3rd POST so sessions 1 and 2 are fully
            # committed AND recorded done before the interruption.
            state["posts"] += 1
            if state["posts"] > 2:
                raise KeyboardInterrupt("simulated interruption after 2 sessions")
            return real_post(self, bank_id, built)

        with mock.patch.object(bf.Backfill, "_post_slice", _interrupting_post):
            with self.assertRaises(KeyboardInterrupt):
                bf.Backfill(self._config(), commit=True, delay_ms=0, slice_turns=40).run()

        # Two sessions were committed + recorded done before the interruption.
        prog = bf.Progress(os.environ["HINDSIGHT_BACKFILL_PROGRESS"])
        done_first = [s for s in ("sess-r0", "sess-r1", "sess-r2", "sess-r3")
                      if prog.is_done("clerk", s)]
        self.assertEqual(len(done_first), 2)
        posts_after_first = len(self.daemon.posts)

        # Re-run to completion: the already-done sessions must be SKIPPED (no
        # re-POST), the remaining ones completed, zero duplicates.
        report = bf.Backfill(self._config(), commit=True, delay_ms=0, slice_turns=40).run()
        self.assertEqual(report["rollup"]["sessions_already_done"], 2)

        prog2 = bf.Progress(os.environ["HINDSIGHT_BACKFILL_PROGRESS"])
        for s in ("sess-r0", "sess-r1", "sess-r2", "sess-r3"):
            self.assertTrue(prog2.is_done("clerk", s))
        # Only the two remaining sessions were posted on the re-run.
        self.assertEqual(len(self.daemon.posts) - posts_after_first, 2)
        # All four sessions' content landed, one document per session (no dupes).
        self.assertEqual(len(self.daemon.docs), 4)

    # -- Partial (live-watermarked) sessions are skipped for review ----------
    def test_partial_session_skipped_for_review(self):
        path = self._transcript("clerk", "sess-partial", 3)
        # A live watermark means the live path already retained part of it.
        watermark.commit("sess-partial", "sess-partial-a1", "sess-partial-r...",
                         transcript_path=path, ordered_uuids=["sess-partial-u0"])

        report = bf.Backfill(self._config(), commit=True, delay_ms=0).run()

        self.assertEqual(report["rollup"]["sessions_partial_skipped"], 1)
        self.assertEqual(report["rollup"]["sessions_total_loss"], 0)
        # Conservative: nothing posted for the partial session.
        self.assertEqual(self.daemon.posts, [])

    # -- --agent restricts scope --------------------------------------------
    def test_agent_filter_restricts_scope(self):
        self._transcript("clerk", "sess-a", 2)
        self._transcript("scout", "sess-b", 2)
        report = bf.Backfill(self._config(), commit=True, delay_ms=0).run(agent_filter={"clerk"})
        self.assertIn("clerk", report["agents"])
        self.assertNotIn("scout", report["agents"])

    # -- F3: the total-loss GATE is load-bearing (live doc, no watermark) -----
    def test_total_loss_gate_prevents_live_vs_backfill_duplication(self):
        # A session the LIVE path retained (a sliding-window doc in the bank) but
        # whose watermark IS present. Backfill must NOT re-post it — the ids do
        # NOT converge with the live path's, so a re-post would DUPLICATE the
        # turns under different ids the daemon can't upsert away. The guard here
        # is the classification gate, not id-convergence.
        path = self._transcript("clerk", "sess-live", 5)
        # Seed a live-path doc under a DIFFERENT (sliding-window-shaped) id.
        live_id = "sess-live-r-live-sliding-window"
        self.daemon.docs[live_id] = {"content": "live user turn 3\nlive user turn 4", "metadata": {}}
        # The live path also wrote a watermark (the normal, healthy case).
        watermark.commit("sess-live", "sess-live-a4", live_id,
                         transcript_path=path, ordered_uuids=["sess-live-u4"])
        before = len(self.daemon.docs)

        report = bf.Backfill(self._config(), commit=True, delay_ms=0).run()

        # Gate held: classified partial (watermark present) → skipped, zero posts,
        # no second doc for the same turns.
        self.assertEqual(report["rollup"]["sessions_partial_skipped"], 1)
        self.assertEqual(self.daemon.posts, [])
        self.assertEqual(len(self.daemon.docs), before)

        # Prove the gate is load-bearing: with the watermark REMOVED (the F3
        # watermark-write-failure shape) the same session WOULD be reclassified
        # total-loss and re-posted, creating additional docs beyond the live one.
        os.remove(os.path.join(os.environ["HINDSIGHT_RETAINED_DIR"], "sess-live.json"))
        bf.Backfill(self._config(), commit=True, delay_ms=0,
                    progress=bf.Progress(os.path.join(self.home, ".hindsight", "prog2.json"))).run()
        self.assertGreater(len(self.daemon.docs), before)  # gate removed ⇒ duplication

    # -- F1: a dynamic-bank agent is refused, never written to a guessed bank -
    def test_dynamic_bank_agent_refused(self):
        self._transcript("clerk", "sess-dyn", 3)
        cfg = self._config()
        cfg["dynamicBankId"] = True
        cfg["dynamicBankGranularity"] = ["agent", "project"]

        report = bf.Backfill(cfg, commit=True, delay_ms=0).run(agent_filter={"clerk"})

        self.assertTrue(report["agents"]["clerk"]["dynamic_bank_skipped"])
        self.assertEqual(report["rollup"]["dynamic_bank_agents_skipped"], 1)
        # Nothing written to any guessed bank.
        self.assertEqual(self.daemon.posts, [])
        self.assertEqual(report["rollup"]["posts_ok"], 0)

    # -- F2: resuming with a different --slice-turns is refused --------------
    def test_slice_turns_mismatch_refused_on_resume(self):
        self._transcript("clerk", "sess-st", 3)
        # First commit run pins slice_turns=40.
        bf.Backfill(self._config(), commit=True, delay_ms=0, slice_turns=40).run()
        # A resume with a different slice size must refuse (would orphan run-1's
        # slices as duplicates under new ids).
        with self.assertRaises(ValueError):
            bf.Backfill(self._config(), commit=True, delay_ms=0, slice_turns=10).run()

    # -- F3: an active / recently-written session is skipped -----------------
    def test_active_session_skipped(self):
        path = self._transcript("clerk", "sess-hot", 3)
        # Fresh mtime (now) with a 1h idle threshold → classified active.
        report = bf.Backfill(self._config(), commit=True, delay_ms=0, min_idle_s=3600).run()
        self.assertEqual(report["rollup"]["sessions_active_skipped"], 1)
        self.assertEqual(report["rollup"]["sessions_total_loss"], 0)
        self.assertEqual(self.daemon.posts, [])
        # Backdate the transcript → now idle → recovered.
        old = time.time() - 7200
        os.utime(path, (old, old))
        report2 = bf.Backfill(self._config(), commit=True, delay_ms=0, min_idle_s=3600).run()
        self.assertEqual(report2["rollup"]["sessions_total_loss"], 1)


if __name__ == "__main__":
    unittest.main()
