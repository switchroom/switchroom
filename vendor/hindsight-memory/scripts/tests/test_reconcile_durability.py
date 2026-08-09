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

import contextlib
import io
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
        # switchroom: the observation_scopes kwarg each POST carried.
        self.observation_scopes_seen = []
        self.posts = []         # [(document_id, async_processing)]
        self.fail = False
        self.drop_async = False

    def retain(self, bank_id, content, document_id="conversation", context=None,
               metadata=None, tags=None, timeout=15, async_processing=True,
               observation_scopes=None):
        self.observation_scopes_seen.append(observation_scopes)
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

    # -- Test 10: a bound (200-turn cap) ENQUEUES the remainder, no silent loss -
    def test_turn_cap_enqueues_remainder_never_truncates(self):
        # Regression for F1/F2 (reviewer reproduced silent loss): the older
        # remainder is delivered by the drain, which the daemon may 200-then-drop
        # on an async post; if the watermark had advanced past the remainder,
        # that drop would be permanent loss with no reconcile backstop. This test
        # sets drop_async=True on the drain path — it must still land durably
        # (drain now posts commit-before-ack) AND the watermark must NOT have
        # jumped past the un-confirmed remainder after the capped reconcile.
        session = "sessE"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 6, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # Cap the boot reconcile at 2 human turns; the other 4 must be deferred,
        # not dropped.
        with mock.patch.dict(os.environ, {"HINDSIGHT_RECONCILE_MAX_TURNS": "2"}):
            reconcile_tail.reconcile(self._config(), hook_input=hook)

        # Inline landed the most-recent 2 turns ...
        blob = self.daemon.content_blob()
        self.assertIn("user turn 5", blob)
        self.assertIn("user turn 4", blob)
        # ... the older remainder is ENQUEUED (not lost) ...
        self.assertEqual(len(self._pending_entries()), 1)
        # ... and the watermark did NOT advance past the un-confirmed remainder
        # (F2): it must not sit at the transcript end. With no prior watermark
        # and a split, no watermark is written at all.
        wm = watermark.load(session)
        self.assertTrue(wm is None or wm["last_uuid"] != f"{session}-a5")

        # An adversarial daemon that DROPS async extractions (the #3244 hazard):
        # the drain must still persist the remainder durably (commit-before-ack).
        self.daemon.drop_async = True
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


class TestSidechainSkip(DurabilityTestBase):
    """PR5 review finding 1: reconcile must NOT treat a sub-agent sidechain
    transcript as a pseudo-session. The recursive glob matches
    <session>/subagents/agent-<id>.jsonl; without the guard reconcile would
    retain it at boot with an untagged, disjoint-namespace document (permanent
    duplicate of subagent_retain.py's tagged retain, at full recall weight,
    bypassing the volume gate)."""

    def _write_sidechain(self, path, n_turns):
        lines = []
        for i in range(n_turns):
            lines.append(json.dumps({
                "type": "user", "isSidechain": True, "agentId": "af5",
                "uuid": f"su{i}", "message": {"role": "user", "content": f"sc turn {i}"},
            }))
            lines.append(json.dumps({
                "type": "assistant", "isSidechain": True, "agentId": "af5",
                "uuid": f"sa{i}", "message": {"role": "assistant", "content": f"sc did {i}"},
            }))
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    def test_reconcile_skips_sidechain_transcript(self):
        session = "sessX"
        # A real parent session with un-committed turns (must still reconcile).
        parent = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(parent, 4, session_prefix=session)
        # A sidechain under <session>/subagents/ that the recursive glob matches.
        sub_dir = os.path.join(self.transcripts, session, "subagents")
        os.makedirs(sub_dir)
        sc = os.path.join(sub_dir, "agent-af5.jsonl")
        self._write_sidechain(sc, 5)

        hook = {"session_id": session, "transcript_path": parent, "cwd": "/x"}
        summary = reconcile_tail.reconcile(self._config(), hook_input=hook)

        # The sidechain was recognised and skipped ...
        self.assertGreaterEqual(summary["skipped_sidechain"], 1)
        blob = self.daemon.content_blob()
        # ... none of its content was retained ...
        self.assertNotIn("sc turn", blob)
        self.assertNotIn("sc did", blob)
        # ... and no document carries the untagged agent-<id> namespace.
        self.assertFalse(any(did.startswith("agent-af5") for did in self.daemon.docs))
        # ... while the genuine parent session WAS reconciled.
        for i in range(4):
            self.assertIn(f"user turn {i}", blob)


class TestObservationScopes(DurabilityTestBase):
    """switchroom — the per-row observation scope on the LIVE retain paths.

    Asserts the OUTCOME on the wire: what scope the Stop hook, the boot
    reconciler, and the pending-queue drain actually POST with. Each of those
    is a separate hand-enumerated kwarg list, so each needs its own pin — a
    miss on any one silently drops that path back to per-tag scopes.
    """

    def _hook(self, session="scopesess", n=5):
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, n, session_prefix=session)
        return {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

    def _set_scope(self, value):
        os.environ["HINDSIGHT_OBSERVATION_SCOPES"] = value
        self.addCleanup(os.environ.pop, "HINDSIGHT_OBSERVATION_SCOPES", None)

    def _set_strategy(self, value):
        os.environ["HINDSIGHT_OBSERVATION_SCOPE_STRATEGY"] = value
        self.addCleanup(os.environ.pop, "HINDSIGHT_OBSERVATION_SCOPE_STRATEGY", None)

    # -- opt-out: byte-identical to pre-feature -----------------------------
    def test_opted_out_stop_retain_posts_no_scope(self):
        # observationScopeStrategy=combined restores the pre-feature body: no
        # scope on the wire so the engine default stands.
        self._set_strategy("combined")
        hook = self._hook("plainsess")
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s is None for s in self.daemon.observation_scopes_seen))

    # -- default ON: a curated scope reaches the Stop-hook POST --------------
    def test_default_stop_retain_posts_a_curated_scope(self):
        hook = self._hook("plainsess")
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s is not None for s in self.daemon.observation_scopes_seen))

    # -- Stop hook (retain.py) ----------------------------------------------
    def test_configured_stop_retain_posts_the_scope(self):
        self._set_scope("shared")
        hook = self._hook("livesess")
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s == "shared" for s in self.daemon.observation_scopes_seen))

    # -- boot reconciler (reconcile_tail.py) --------------------------------
    def test_configured_boot_reconcile_posts_the_scope(self):
        self._set_scope("shared")
        hook = self._hook("reconsess")
        reconcile_tail.reconcile(self._config(), hook_input=hook)
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s == "shared" for s in self.daemon.observation_scopes_seen))

    # -- durability: the scope survives the pending queue --------------------
    def test_scope_survives_failure_enqueue_and_drain(self):
        self._set_scope("shared")
        hook = self._hook("failsess")

        # The daemon refuses, so the Stop retain is ENQUEUED rather than landed.
        self.daemon.fail = True
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)):
            retain.main()
        entries = self._pending_entries()
        self.assertEqual(len(entries), 1)
        _path, entry = entries[0]
        # The queued entry carries the scope, so the drain does not have to
        # re-resolve config that may have changed since.
        self.assertEqual(entry["observation_scopes"], "shared")

        # Drain it hours later: it lands in the SAME scope.
        import drain_pending
        seen = []

        class _Client:
            def __init__(self, *a, **kw):
                pass

            def retain(self, **kwargs):
                seen.append(kwargs.get("observation_scopes"))
                return {"ok": True}

        with mock.patch.object(drain_pending, "HindsightClient", _Client):
            drain_pending._retry_one(entry, timeout=15)
        self.assertEqual(seen, ["shared"])

    # -- a typo must never destroy a memory ---------------------------------
    #
    # These are the regression tests for the worst bug the validation
    # introduced. `build_retain_payload` used to RAISE on an off-list value.
    # It is called from `run_retain`, which `retain.main` calls WITHOUT a
    # try/except before its `pending_enqueue` — so the raise unwound past the
    # enqueue: nothing POSTed, nothing queued, watermark not advanced, the turn
    # gone. `session_end.py` caught it but had no payload to queue, and
    # `session_start.py` swallowed the same raise into `debug_log` and aborted
    # the reconcile loop that would have re-derived it. Every producer lost its
    # memory outright, permanently and silently, for as long as the bad value
    # sat in the config — switchroom #3244's shape, which this feature cites.
    #
    # A misconfigured scope is recoverable. A deleted turn is not. So a bad
    # value degrades to the PRE-FEATURE behaviour (no field on the wire, the
    # engine's own default scope) and is shouted about on stderr.

    def test_a_typo_does_not_destroy_the_live_stop_retain(self):
        self._set_scope("shred")  # not "shared"
        hook = self._hook("typolivesess")
        err = io.StringIO()
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)), \
             contextlib.redirect_stderr(err):
            retain.main()

        # OUTCOME 1: the memory LANDED. Not "an exception was caught" — the
        # turns are in the bank.
        # (chunked mode with retainEveryNTurns=3 slices the last 3 turns)
        blob = self.daemon.content_blob()
        self.assertIn("user turn 4", blob)
        # OUTCOME 2: at the engine's own default scope (field omitted), which
        # is exactly what an unconfigured agent does.
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s is None for s in self.daemon.observation_scopes_seen))
        # OUTCOME 3: and it was loud. A silent downgrade would be the original
        # "typo ignored forever" defect.
        self.assertIn("shred", err.getvalue())
        self.assertIn("observation_scopes", err.getvalue())

    def test_a_typo_does_not_destroy_a_FAILED_stop_retain(self):
        # The reviewer's reproduction: with the raise in place this enqueued 0
        # entries and left the watermark unmoved, so the turn was lost for good.
        self._set_scope("shred")
        hook = self._hook("typofailsess")

        self.daemon.fail = True
        with mock.patch("retain.increment_turn_count", return_value=3), \
             mock.patch("sys.stdin", _stdin(hook)), \
             contextlib.redirect_stderr(io.StringIO()):
            retain.main()

        # OUTCOME: the payload was still built and still ENQUEUED, so the next
        # SessionStart drain replays it. This is the assertion that matters —
        # the memory has a durable on-disk copy.
        entries = self._pending_entries()
        self.assertEqual(len(entries), 1)
        _path, entry = entries[0]
        self.assertIn("user turn 4", entry["content"])
        self.assertIsNone(entry["observation_scopes"])

    def test_a_typo_does_not_destroy_the_boot_reconcile(self):
        # session_start.py swallows a reconcile raise into debug_log AND aborts
        # the loop on the first bad payload, so the recovery path that would
        # re-derive lost turns did nothing either.
        self._set_scope("shred")
        hook = self._hook("typoreconsess")
        with contextlib.redirect_stderr(io.StringIO()):
            reconcile_tail.reconcile(self._config(), hook_input=hook)
        blob = self.daemon.content_blob()
        self.assertIn("user turn 0", blob)
        self.assertTrue(self.daemon.observation_scopes_seen)
        self.assertTrue(all(s is None for s in self.daemon.observation_scopes_seen))


class TestDrainAdvancesWatermark(DurabilityTestBase):
    """switchroom #4571 — the drain must advance the transcript watermark for a
    reconcile-sourced slice it confirms durable, so reconcile stops re-deriving
    and re-enqueueing the identical tail on every boot (the recurring
    ``pending-retains`` spike). And it must NOT advance while an earlier sibling
    of the same session is still queued (the no-loss guard).
    """

    # -- the fix: an enqueued tail, once drained, advances the watermark --------
    def test_enqueued_tail_drained_advances_watermark_and_stops_reenqueue(self):
        # This test FAILS on HEAD: the drain never commits the watermark for an
        # enqueued reconcile slice, so `watermark.load` stays None after the
        # drain and the second reconcile re-enqueues the same tail.
        session = "drainA"
        tpath = os.path.join(self.transcripts, f"{session}.jsonl")
        _write_transcript(tpath, 3, session_prefix=session)
        hook = {"session_id": session, "transcript_path": tpath, "cwd": "/x"}

        # Force the out-of-lookback ENQUEUE path (no inline POST): lookback=0
        # makes every transcript "too old", so reconcile enqueues the full tail
        # and defers it to the drain — exactly the path that never committed.
        with mock.patch.dict(os.environ, {"HINDSIGHT_RECONCILE_LOOKBACK_H": "0"}):
            s1 = reconcile_tail.reconcile(self._config(), hook_input=hook)
        self.assertEqual(s1["enqueued"], 1)
        self.assertEqual(len(self._pending_entries()), 1)
        # Nothing posted inline, so the watermark is still unset.
        self.assertIsNone(watermark.load(session))

        # Drain against a healthy daemon: the tail lands durably AND (the fix)
        # the watermark advances to the transcript tail.
        from drain_pending import drain
        drain(self._config())
        self.assertEqual(len(self._pending_entries()), 0)
        wm = watermark.load(session)
        self.assertIsNotNone(
            wm,
            "drain must advance the watermark for a confirmed-durable reconcile "
            "tail (#4571) — without it, reconcile re-enqueues every boot",
        )
        self.assertEqual(wm["last_uuid"], f"{session}-a2")

        # Second reconcile pass (still out of lookback) is now skipped_clean:
        # the tail is watermarked, so it is NOT re-derived or re-enqueued.
        with mock.patch.dict(os.environ, {"HINDSIGHT_RECONCILE_LOOKBACK_H": "0"}):
            s2 = reconcile_tail.reconcile(self._config(), hook_input=hook)
        self.assertEqual(s2["skipped_clean"], 1)
        self.assertEqual(s2["enqueued"], 0)
        self.assertEqual(len(self._pending_entries()), 0)

    # -- the no-loss guard: an earlier sibling blocks the tail's advance --------
    def test_tail_drain_does_not_advance_while_earlier_sibling_queued(self):
        session = "drainB"
        ordered = [
            f"{session}-u0", f"{session}-a0", f"{session}-u1",
            f"{session}-a1", f"{session}-u2", f"{session}-a2",
        ]
        older_doc = f"{session}-r{session}-u0-{session}-a1"
        tail_doc = f"{session}-r{session}-u0-{session}-a2"

        from lib import pending

        def _payload(doc, content, last_uuid, is_tail):
            return {
                "api_url": "http://fake", "api_token": None, "bank_id": "test-bank",
                "content": content, "document_id": doc, "context": "claude-code",
                "metadata": {}, "tags": [], "observation_scopes": None,
                "reconcile_session_id": session,
                "reconcile_last_uuid": last_uuid,
                "reconcile_ordered_uuids": ordered,
                "reconcile_is_tail": is_tail,
            }

        # The earlier remainder (mid-transcript last_uuid) is enqueued FIRST so
        # it sorts ahead of the tail in the oldest-first drain order.
        pending.enqueue(
            _payload(older_doc, "older remainder turns", f"{session}-a1", False),
            RuntimeError("reconcile deferred"),
        )
        import time as _t
        _t.sleep(0.002)
        pending.enqueue(
            _payload(tail_doc, "tail turns", f"{session}-a2", True),
            RuntimeError("reconcile deferred"),
        )
        self.assertEqual(len(self._pending_entries()), 2)

        # Upstream: the tail commits, but the earlier remainder still fails, so
        # it stays queued through the whole drain run.
        posted = []

        def fake_retain(self_c, bank_id=None, content=None,
                        document_id="conversation", **kw):
            posted.append(document_id)
            if document_id == older_doc:
                raise RuntimeError("earlier remainder still failing upstream")
            return {"ok": True}

        from drain_pending import drain
        with mock.patch.object(HindsightClient, "retain", fake_retain):
            drain(self._config())

        # The tail POST succeeded and its entry was retired ...
        self.assertIn(tail_doc, posted)
        remaining = [e["document_id"] for _p, e in self._pending_entries()]
        self.assertNotIn(tail_doc, remaining)
        # ... but the watermark did NOT advance: an earlier, still-unconfirmed
        # sibling of the same session is queued, and advancing past it would
        # risk silent loss of the remainder (#4571 no-loss guard).
        self.assertIsNone(watermark.load(session))
        # The earlier remainder is still queued (its POST failed).
        self.assertIn(older_doc, remaining)


def _stdin(obj):
    import io
    return io.StringIO(json.dumps(obj))


if __name__ == "__main__":
    unittest.main()
