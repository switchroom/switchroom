"""switchroom #3244 follow-up — log-driven recovery (``--from-logs``) tests.

Stdlib-only (``python3 -m unittest discover tests/``). Every test drives the
real ``backfill_transcripts`` ``--from-logs`` path against a FAKE in-process
daemon + FAKE per-agent registry.db + FAKE transcripts (no network, no LLM, no
real bank) and asserts OUTCOMES.

Covers the three design red-team must-fixes:
  1. BROAD candidate classifier — a genuinely-missing ``restart`` session is
     restored (would be dropped by the dead in-flight predicate).
  2. SESSION-LEVEL, scheme-agnostic membership — restore fires ONLY for a
     session with ZERO documents in the bank; a session with ANY document
     present is treated as ``present`` and skipped. Partial-within-a-populated-
     session recovery is out of scope (a legacy epoch-ms id can't be mapped to
     the turns it covers), so membership is decided at the session, not slice,
     level (BLOCKER-1 fix superseded the earlier slice-level design).
  3. Event-span CONTAINMENT join — picks the right transcript where a naive
     mtime-window would miss; ambiguous → refused, not guessed.
Plus: fail-closed on membership error, wrong/refused bank → zero writes,
dry-run → zero writes, pacing serialised via the fake clock.
"""

import json
import os
import shutil
import sqlite3
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

_REGISTRY_COLS = [
    "turn_key", "chat_id", "thread_id", "started_at", "ended_at", "ended_via",
    "last_assistant_msg_id", "last_assistant_done", "last_user_msg_id",
    "user_prompt_preview", "assistant_reply_preview", "tool_call_count",
    "created_at", "updated_at", "interrupt_reason", "resumed_at",
]


class FakeDaemon:
    """Upsert-by-document_id store + a session-substring document listing that
    mirrors the daemon's server-side ``q=`` filter."""

    def __init__(self):
        self.docs = {}
        self.posts = []
        # switchroom: the observation_scopes kwarg each POST carried.
        self.observation_scopes_seen = []
        self.max_inflight_seen = 0
        self._inflight = 0
        self.membership_error = False
        # #3291 partial-failure simulation: raise on the retain of the Nth
        # DISTINCT document_id seen (distinct index, POST order = slice order),
        # so a slice fails persistently (all bounded retries) without a fixed id.
        self.fail_distinct_indices = set()
        self._seen_doc_order = []

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True,
               observation_scopes=None):
        self.observation_scopes_seen.append(observation_scopes)
        if document_id not in self._seen_doc_order:
            self._seen_doc_order.append(document_id)
        distinct_idx = self._seen_doc_order.index(document_id)
        if distinct_idx in self.fail_distinct_indices:
            raise RuntimeError(f"simulated POST failure for slice #{distinct_idx}")
        self._inflight += 1
        self.max_inflight_seen = max(self.max_inflight_seen, self._inflight)
        try:
            self.posts.append((document_id, async_processing))
            self.docs[document_id] = {"content": content, "bank_id": bank_id}
            return {"ok": True}
        finally:
            self._inflight -= 1

    def list_session_document_ids(self, bank_id, session_id, page=200,
                                  max_pages=50, timeout=10):
        if self.membership_error:
            raise RuntimeError("simulated daemon membership failure")
        return {did for did, d in self.docs.items()
                if d.get("bank_id") == bank_id and session_id in did}

    def document_exists(self, bank_id, document_id, timeout=30):
        """Tri-state presence check (mirrors HindsightClient.document_exists):
        True when the slice doc is durable, False on a confirmed miss."""
        d = self.docs.get(document_id)
        return bool(d is not None and d.get("bank_id") == bank_id)


def _write_registry(path, rows, with_session_id=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cols = list(_REGISTRY_COLS)
    if with_session_id:
        cols.append("session_id")
    conn = sqlite3.connect(path)
    try:
        conn.execute(f"CREATE TABLE turns ({', '.join(c + ' TEXT' for c in cols)})")
        for row in rows:
            vals = [row.get(c) for c in cols]
            conn.execute(
                f"INSERT INTO turns ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                vals,
            )
        conn.commit()
    finally:
        conn.close()


def _write_transcript_ts(path, n_turns, session_prefix, base_ms, step_ms=1000, chat_id="123"):
    """Flat-format JSONL with per-line ``timestamp`` (ms) + ``chat_id`` so the
    containment join and read_transcript both work."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = []
    ts = base_ms
    for i in range(n_turns):
        lines.append(json.dumps({
            "role": "user", "content": f"user turn {i}",
            "uuid": f"{session_prefix}-u{i}", "timestamp": ts, "chat_id": chat_id,
        }))
        ts += step_ms
        lines.append(json.dumps({
            "role": "assistant", "content": f"assistant turn {i}",
            "uuid": f"{session_prefix}-a{i}", "timestamp": ts, "chat_id": chat_id,
        }))
        ts += step_ms
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return base_ms, ts  # (first_ms, last_ms)


class FromLogsTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-3244-fl-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        self.agents_root = os.path.join(self.tmp, "state", "agents")
        for d in (self.plugin_root, self.home, self.data, self.agents_root):
            os.makedirs(d)
        self.switchroom_yaml = os.path.join(self.tmp, "state", "switchroom.yaml")

        settings = {
            "autoRetain": True, "retainMode": "chunked", "retainEveryNTurns": 3,
            "retainOverlapTurns": 0, "bankId": "unused-in-from-logs",
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
            "HINDSIGHT_BACKFILL_DELAY_MS": "0",
            "HINDSIGHT_BACKFILL_MIN_IDLE_S": "0",
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
            mock.patch.object(HindsightClient, "list_session_document_ids", self._fake_membership),
            mock.patch.object(HindsightClient, "document_exists", self._fake_doc_exists),
            mock.patch("backfill_transcripts.get_api_url", return_value="http://fake"),
            mock.patch("backfill_transcripts._SLEEP", self._fake_sleep),
        ]
        for p in self._patches:
            p.start()

    def _fake_retain(self, *a, **kw):
        return self.daemon.retain(*a, **kw)

    def _fake_membership(self, *a, **kw):
        return self.daemon.list_session_document_ids(*a, **kw)

    def _fake_doc_exists(self, *a, **kw):
        return self.daemon.document_exists(*a, **kw)

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

    def _write_yaml(self, mapping):
        """mapping: {agent: collection_or_None}."""
        lines = ["agents:"]
        for agent, coll in mapping.items():
            lines.append(f"  {agent}:")
            lines.append("    purpose: test agent")
            if coll is not None:
                lines.append("    memory:")
                lines.append(f"      collection: {coll}")
        os.makedirs(os.path.dirname(self.switchroom_yaml), exist_ok=True)
        with open(self.switchroom_yaml, "w") as f:
            f.write("\n".join(lines) + "\n")

    def _write_settings(self, agent, bank_id):
        p = os.path.join(self.agents_root, agent, ".claude", "settings.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            json.dump({"mcpServers": {"hindsight": {"headers": {"X-Bank-Id": bank_id}}}}, f)

    def _transcript(self, agent, session, n_turns, base_ms, chat_id="123"):
        path = os.path.join(self.agents_root, agent, ".claude", "projects", "proj", f"{session}.jsonl")
        return path, _write_transcript_ts(path, n_turns, session, base_ms, chat_id=chat_id)

    def _registry(self, agent, rows, with_session_id=False):
        p = os.path.join(self.agents_root, agent, "telegram", "registry.db")
        _write_registry(p, rows, with_session_id=with_session_id)
        return p

    def _seed_legacy_doc(self, session, bank_id, epoch_ms=1783796975304):
        """Seed a doc under the LEGACY ``{session_id}-{epoch_ms}`` scheme — the
        one production banks actually use (NOT the -r{uuid} scheme the tool
        computes). Session-level membership must see this as PRESENT."""
        did = f"{session}-{epoch_ms}"
        self.daemon.docs[did] = {"content": "LEGACY-PRESENT", "bank_id": bank_id}
        return did

    def _run(self, agent, commit=True, **kw):
        return bf.Backfill(
            self._config(), commit=commit, delay_ms=kw.pop("delay_ms", 0),
            slice_turns=kw.pop("slice_turns", 1), from_logs=True,
            switchroom_yaml=self.switchroom_yaml, min_idle_s=kw.pop("min_idle_s", 0),
            **kw,
        ).run(agent_filter={agent})


class TestFromLogs(FromLogsTestBase):
    # --- BLOCKER-1: a session with LEGACY epoch-ms docs is PRESENT → zero
    #     restore. This FAILS on the pre-fix slice-level exact-id code (which
    #     computes -r{uuid} ids, never matches the legacy id, and re-posts every
    #     slice → duplicates the intact session). ------------------------------
    def test_legacy_scheme_docs_present_zero_restore(self):
        self._write_yaml({"clerk": None})  # bank = name "clerk"
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-legacy", 5, base)
        # The live path retained this session under the LEGACY {session}-{ms}
        # scheme — the only scheme deployed banks hold today.
        legacy_id = self._seed_legacy_doc("sess-legacy", "clerk")
        before = set(self.daemon.docs)
        self._registry("clerk", [{
            "turn_key": "123:_:t1", "chat_id": "123", "started_at": str(first + 500),
            "ended_at": str(last), "ended_via": "sigterm",
        }])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]

        # Behavioural gate first: NOT a single POST — the legacy-keyed session
        # is never duplicated. On the pre-fix slice-level code this is 5 posts.
        self.assertEqual(self.daemon.posts, [])
        self.assertEqual(set(self.daemon.docs), before)
        self.assertIn(legacy_id, self.daemon.docs)
        self.assertEqual(ar["sessions_has_documents"], 1)
        self.assertEqual(ar["sessions_total_loss"], 0)
        self.assertEqual(ar["sessions_restored"], 0)

    # --- must-fix #1: a genuinely-empty (total-loss) `restart` session IS
    #     restored (proves broad classifier + total-loss gate). ---------------
    def test_missing_restart_session_restored(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-restart", 3, base)
        # Empty bank → total loss. ended_via='restart' with NULL in-flight
        # columns (the dead-predicate shape) must still be recovered.
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "restart",
            "last_assistant_done": None, "tool_call_count": None,
        }])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertEqual(ar["sessions_total_loss"], 1)
        self.assertEqual(ar["sessions_restored"], 1)
        self.assertEqual(ar["slices_restored"], 3)
        self.assertEqual(len(self.daemon.posts), 3)
        self.assertTrue(all(async_flag is False for _, async_flag in self.daemon.posts))

    # --- mixed scheme fleet: legacy-present session skipped, empty session
    #     restored — one run, no cross-contamination. --------------------------
    def test_mixed_present_and_total_loss(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        pa, (fa, la) = self._transcript("clerk", "sess-has", 3, base)
        self._seed_legacy_doc("sess-has", "clerk")
        base_b = base + 10_000_000
        pb, (fb, lb) = self._transcript("clerk", "sess-empty", 3, base_b)
        self._registry("clerk", [
            {"turn_key": "123:_:a", "chat_id": "123", "started_at": str(fa + 100),
             "ended_at": str(la), "ended_via": "sigterm"},
            {"turn_key": "123:_:b", "chat_id": "123", "started_at": str(fb + 100),
             "ended_at": str(lb), "ended_via": "restart"},
        ])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertEqual(ar["sessions_has_documents"], 1)
        self.assertEqual(ar["sessions_restored"], 1)
        # Only the empty session's slices were posted.
        self.assertTrue(all("sess-empty" in did for did, _ in self.daemon.posts))
        self.assertEqual(len(self.daemon.posts), 3)

    # --- must-fix #3: span containment picks the right transcript -----------
    def test_span_containment_join_selects_correct_transcript(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        # Two sessions far apart in time. The incident turn's timestamp falls
        # INSIDE session A's span; a naive "nearest mtime" would pick B (written
        # last). Only A must be chosen.
        base_a = 1_700_000_000_000
        path_a, (fa, la) = self._transcript("clerk", "sess-A", 3, base_a)
        base_b = base_a + 10_000_000  # much later
        path_b, (fb, lb) = self._transcript("clerk", "sess-B", 3, base_b)
        # Make B the most-recently-written file (naive mtime target).
        os.utime(path_b, None)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(fa + 200),
            "ended_at": str(la), "ended_via": "sigterm",
        }])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        restored_sessions = [s["session"] for s in ar["sessions"]
                             if s.get("action") == "restored"]
        self.assertEqual(restored_sessions, ["sess-A"])
        # B was never a candidate → untouched.
        self.assertTrue(all("sess-B" not in did for did, _ in self.daemon.posts))

    # --- must-fix #3: ambiguous span → refused, not guessed -----------------
    def test_ambiguous_join_refused(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        # Two OVERLAPPING transcripts both containing the turn timestamp.
        p1, (f1, l1) = self._transcript("clerk", "sess-ov1", 5, base, chat_id="123")
        p2, (f2, l2) = self._transcript("clerk", "sess-ov2", 5, base, chat_id="123")
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(f1 + 500),
            "ended_at": str(l1), "ended_via": "sigterm",
        }])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertEqual(ar["ambiguous_turns"], 1)
        self.assertEqual(ar["candidate_sessions"], 0)
        self.assertEqual(self.daemon.posts, [])

    # --- membership query error → fail-closed → NOT restored ----------------
    def test_membership_error_fails_closed(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-err", 3, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "timeout",
        }])
        self.daemon.membership_error = True

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertEqual(ar["sessions_membership_error"], 1)
        self.assertEqual(ar["sessions_restored"], 0)
        self.assertEqual(self.daemon.posts, [])

    # --- wrong/mismatched bank → refused, zero writes -----------------------
    def test_bank_mismatch_refused(self):
        self._write_yaml({"clerk": "clerk"})       # yaml says bank "clerk"
        self._write_settings("clerk", "claude_code")  # header disagrees
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-x", 3, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "sigterm",
        }])

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertTrue(ar["bank_refused"])
        self.assertEqual(report["rollup"]["banks_refused"], 1)
        self.assertEqual(self.daemon.posts, [])

    def test_missing_yaml_row_refused(self):
        self._write_yaml({"someone-else": None})   # no clerk row
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-x", 3, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "sigterm",
        }])
        report = self._run("clerk")
        self.assertTrue(report["agents"]["clerk"]["bank_refused"])
        self.assertEqual(self.daemon.posts, [])

    # --- dry-run → zero writes ----------------------------------------------
    def test_dry_run_zero_writes(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-dry", 4, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "sigterm",
        }])

        report = self._run("clerk", commit=False)
        ar = report["agents"]["clerk"]
        # Reports the gap it WOULD fill ...
        self.assertEqual(ar["sessions_total_loss"], 1)
        self.assertEqual(ar["slices_restored"], 4)
        self.assertEqual(ar["turns_recovered"], 4)
        # ... but nothing was written.
        self.assertEqual(self.daemon.posts, [])
        self.assertFalse(os.path.exists(os.environ["HINDSIGHT_BACKFILL_PROGRESS"]))
        self.assertIsNone(watermark.load("sess-dry"))

    # --- pacing: membership GET + restore POSTs serialised + spaced ---------
    def test_pacing_serialised_and_spaced(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-pace", 3, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "sigterm",
        }])

        self._run("clerk", delay_ms=1500)
        # 3 restore POSTs, never more than one in flight.
        self.assertEqual(len(self.daemon.posts), 3)
        self.assertEqual(self.daemon.max_inflight_seen, 1)
        # 1 membership GET + 3 POSTs = 4 paced ops → 3 inter-op 1.5s gaps.
        spaced = [s for s in self.sleeps if abs(s - 1.5) < 1e-9]
        self.assertEqual(len(spaced), 3)

    # --- #3291: partial POST failure then re-run must GAP-COMPLETE, not skip --
    #     Run 1: slices 0..k-1 commit (async_processing=False ⇒ durable), slice k
    #     fails ⇒ session recorded ``failed``. Run 2 (the fix): the committed
    #     prefix must NOT classify the session ``present`` and skip it forever —
    #     it must recompute the deterministic slice ids and POST ONLY the missing
    #     slice(s). Pre-fix behaviour: run 2 sees the prefix via session
    #     membership → ``has_documents`` → skip → the tail is lost silently. -----
    def test_partial_post_failure_then_rerun_gap_completes(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        # 3 human turns, slice_turns=1 ⇒ 3 non-overlapping slices posted in order.
        path, (first, last) = self._transcript("clerk", "sess-partial", 3, base)
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": str(first + 100),
            "ended_at": str(last), "ended_via": "sigterm",
        }])

        # RUN 1 — the LAST slice (distinct index 2) fails every (bounded) attempt.
        self.daemon.fail_distinct_indices = {2}
        report1 = self._run("clerk")
        ar1 = report1["agents"]["clerk"]

        # Total-loss restore attempted all 3 slices; 2 committed, 1 failed.
        self.assertEqual(ar1["sessions_total_loss"], 1)
        self.assertEqual(ar1["sessions_restored"], 0)   # NOT fully restored
        self.assertEqual(ar1["posts_ok"], 2)
        self.assertEqual(ar1["posts_failed"], 1)
        entry1 = next(s for s in ar1["sessions"] if s["class"] == "total_loss")
        all_ids = entry1["document_ids"]
        self.assertEqual(len(all_ids), 3)
        committed_after_1 = set(self.daemon.docs)
        self.assertEqual(len(committed_after_1), 2)     # durable committed prefix
        missing = [d for d in all_ids if d not in committed_after_1]
        self.assertEqual(len(missing), 1)
        # Progress marked failed (NOT done) — the re-run must revisit it.
        with open(os.environ["HINDSIGHT_BACKFILL_PROGRESS"]) as f:
            prog = json.load(f)
        self.assertEqual(prog["clerk/sess-partial"]["status"], "failed")

        # RUN 2 — no injected failure this time. The fix must gap-complete.
        self.daemon.fail_distinct_indices = set()
        posts_before = len(self.daemon.posts)
        report2 = self._run("clerk")
        ar2 = report2["agents"]["clerk"]

        # It must NOT be skipped as an already-present session.
        self.assertEqual(ar2["sessions_has_documents"], 0)
        # Gap completion: exactly the missing slice posted, the 2 present skipped.
        self.assertEqual(ar2["sessions_gap_completed"], 1)
        self.assertEqual(ar2["slices_gap_filled"], 1)
        self.assertEqual(ar2["slices_gap_present"], 2)
        run2_posts = [did for did, _ in self.daemon.posts[posts_before:]]
        self.assertEqual(run2_posts, missing)           # ONLY the missing slice
        # All three slices are now durable — the session is fully recovered.
        self.assertEqual(set(self.daemon.docs), set(all_ids))
        with open(os.environ["HINDSIGHT_BACKFILL_PROGRESS"]) as f:
            prog2 = json.load(f)
        self.assertEqual(prog2["clerk/sess-partial"]["status"], "done")
        # Watermark advanced to the true tail slice on completion.
        self.assertIsNotNone(watermark.load("sess-partial"))

    # --- direct session_id join (migrated registry) -------------------------
    def test_direct_sessionid_join(self):
        self._write_yaml({"clerk": None})
        self._write_settings("clerk", "clerk")
        base = 1_700_000_000_000
        path, (first, last) = self._transcript("clerk", "sess-direct", 3, base)
        # started_at deliberately OUTSIDE the span → only the stamped session_id
        # can join it.
        self._registry("clerk", [{
            "turn_key": "123:_:t", "chat_id": "123", "started_at": "1",
            "ended_at": "2", "ended_via": "restart", "session_id": "sess-direct",
        }], with_session_id=True)

        report = self._run("clerk")
        ar = report["agents"]["clerk"]
        self.assertEqual(ar["sessions_restored"], 1)
        self.assertEqual(len(self.daemon.posts), 3)


if __name__ == "__main__":
    unittest.main()
