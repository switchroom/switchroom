"""Tests for the pending-retains persistent queue (#1071)."""

import contextlib
import io
import json
import os
import sys
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import lib.pending as pending_mod  # noqa: E402


class PendingQueueTest(unittest.TestCase):
    def setUp(self):
        # Use a temp dir scoped per-test so concurrent runs don't
        # collide. The module reads HINDSIGHT_PENDING_DIR on every call,
        # not at import time — no reload needed.
        import tempfile

        self._tmp = tempfile.mkdtemp(prefix="hindsight-pending-test-")
        self._dir = os.path.join(self._tmp, "pending-retains")
        os.environ["HINDSIGHT_PENDING_DIR"] = self._dir

    def tearDown(self):
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)
        os.environ.pop("HINDSIGHT_PENDING_DIR", None)

    def _sample_payload(self, document_id: str = "doc-1") -> dict:
        return {
            "api_url": "http://fake:9077",
            "api_token": None,
            "bank_id": "test-bank",
            # Distinct per document: the queue's dedupe key is
            # (bank_id, part_position, sha256(content)) since switchroom
            # #3688, so a shared body would collapse these into one entry.
            "content": f"user: hello\nassistant: hi ({document_id})",
            "document_id": document_id,
            "context": "claude-code",
            "metadata": {"session_id": "sess-1"},
            "tags": None,
        }

    def test_enqueue_creates_dir_with_mode_0700(self):
        self.assertFalse(os.path.isdir(self._dir))
        pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        self.assertTrue(os.path.isdir(self._dir))
        mode = os.stat(self._dir).st_mode & 0o777
        self.assertEqual(mode, 0o700)

    def test_enqueue_writes_payload_and_error_metadata(self):
        path = pending_mod.enqueue(self._sample_payload(), ValueError("nope"))
        self.assertIsNotNone(path)
        self.assertTrue(os.path.isfile(path))
        with open(path) as f:
            entry = json.load(f)
        self.assertEqual(entry["bank_id"], "test-bank")
        self.assertEqual(entry["content"], self._sample_payload()["content"])
        self.assertEqual(entry["document_id"], "doc-1")
        self.assertEqual(entry["error_class"], "ValueError")
        self.assertEqual(entry["error_message"], "nope")
        self.assertEqual(entry["attempt_count"], 1)
        self.assertIn("failed_at", entry)
        self.assertEqual(entry["schema"], pending_mod.SCHEMA)

    def test_enqueue_filename_is_unix_ms_key_uuid(self):
        """``<unix-ms>-<dupe-key>-<uuid>.json`` (switchroom #3596).

        The dedupe key moved INTO the name so a duplicate lookup is a
        listing prefix match with zero file reads. The leading millisecond
        timestamp is unchanged, so the lexicographic sort in
        ``_list_entries`` is still oldest-first.
        """
        path = pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        name = os.path.basename(path)
        self.assertTrue(name.endswith(".json"))
        head = name[: -len(".json")]
        ts_part, key_part, uuid_part = head.split("-")
        self.assertTrue(ts_part.isdigit())
        # Filename ts should be within 10 s of now
        now_ms = int(time.time() * 1000)
        self.assertLess(abs(now_ms - int(ts_part)), 10_000)
        self.assertEqual(len(uuid_part), 12)
        self.assertEqual(len(key_part), 16)
        self.assertRegex(key_part, r"^[0-9a-f]{16}$")

    def test_enqueue_atomic_no_tmp_left_behind(self):
        pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        names = sorted(os.listdir(self._dir))
        self.assertEqual(len(names), 1)
        self.assertFalse(any(n.endswith(".tmp") for n in names))

    def test_enqueue_evicts_oldest_when_full_instead_of_refusing(self):
        """switchroom #3596: a full queue sheds the OLDEST entry.

        This test previously asserted the opposite -- that ``enqueue()``
        returns ``None`` at ``MAX_ENTRIES`` -- which meant throwing away the
        turn that had just happened, the one most likely to still matter,
        while keeping a queue full of stale ones.
        """
        os.makedirs(self._dir, mode=0o700)
        oldest = os.path.join(self._dir, f"{0:013d}-aaaaaaaaaaaa.json")
        for i in range(pending_mod.MAX_ENTRIES):
            with open(os.path.join(self._dir, f"{i:013d}-aaaaaaaaaaaa.json"), "w") as f:
                json.dump({"placeholder": True}, f)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result = pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))

        self.assertIsNotNone(result, "the incoming entry must never be refused")
        self.assertTrue(os.path.exists(result))
        self.assertFalse(os.path.exists(oldest), "the oldest entry was evicted")
        # Cap still honoured: one in, one out.
        self.assertEqual(pending_mod.count(), pending_mod.MAX_ENTRIES)
        self.assertIn("evicted OLDEST", stderr.getvalue())

    def test_iter_entries_ordered_oldest_first(self):
        p1 = pending_mod.enqueue(self._sample_payload("doc-1"), RuntimeError("e1"))
        time.sleep(0.005)
        p2 = pending_mod.enqueue(self._sample_payload("doc-2"), RuntimeError("e2"))
        time.sleep(0.005)
        p3 = pending_mod.enqueue(self._sample_payload("doc-3"), RuntimeError("e3"))
        entries = pending_mod.iter_entries()
        paths = [e[0] for e in entries]
        self.assertEqual(paths, [p1, p2, p3])

    def test_iter_entries_skips_malformed(self):
        os.makedirs(self._dir, mode=0o700)
        # Good
        good = pending_mod.enqueue(self._sample_payload(), RuntimeError("ok"))
        # Bad (not JSON)
        with open(os.path.join(self._dir, f"{int(time.time() * 1000) + 1}-bad.json"), "w") as f:
            f.write("not json")
        entries = pending_mod.iter_entries()
        paths = [e[0] for e in entries]
        self.assertIn(good, paths)
        # The bad file is skipped, not raised
        self.assertEqual(len(entries), 1)

    def test_update_attempt_bumps_count_atomically(self):
        path = pending_mod.enqueue(self._sample_payload(), RuntimeError("first"))
        entries = pending_mod.iter_entries()
        _, entry = entries[0]
        self.assertEqual(entry["attempt_count"], 1)
        ok = pending_mod.update_attempt(path, entry, RuntimeError("second"))
        self.assertTrue(ok)
        with open(path) as f:
            reread = json.load(f)
        self.assertEqual(reread["attempt_count"], 2)
        self.assertEqual(reread["error_message"], "second")
        self.assertIn("last_attempt_at", reread)

    def test_mark_dead_renames_to_dot_dead(self):
        path = pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        entries = pending_mod.iter_entries()
        _, entry = entries[0]
        dead = pending_mod.mark_dead(path, entry)
        self.assertTrue(dead.endswith(".dead"))
        self.assertFalse(os.path.exists(path))
        self.assertTrue(os.path.isfile(dead))
        with open(dead) as f:
            reread = json.load(f)
        self.assertIn("dead_at", reread)
        # iter_entries no longer surfaces .dead files
        self.assertEqual(pending_mod.iter_entries(), [])

    def test_mark_dead_never_leaves_live_entry_with_dead_at(self):
        # Crash-window invariant (#1094 item 3): the dead_at stamp must
        # only ever land on <path>.dead, never on the live <path>.json.
        # The old two-step form wrote dead_at to the live path first;
        # simulate a crash *between* the two visible transitions by
        # stubbing the SECOND os.replace/os.rename so it raises, then
        # assert no live .json entry carries dead_at.
        path = pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        _, entry = pending_mod.iter_entries()[0]

        real_replace = os.replace
        calls = {"n": 0}

        def replace_fail_after_first(src, dst):
            # First replace = tmp -> dead_path (the marker). Let it run.
            # Any later mutation would be the pre-fix live-path write —
            # there is none in the new single-transition form, but if a
            # regression reintroduces it, blow up here.
            calls["n"] += 1
            if calls["n"] == 1:
                return real_replace(src, dst)
            raise OSError("simulated crash mid-mark_dead")

        with patch("os.replace", side_effect=replace_fail_after_first):
            pending_mod.mark_dead(path, entry)

        # No live .json entry may carry dead_at.
        for _p, e in pending_mod.iter_entries():
            self.assertNotIn(
                "dead_at", e, "a live queue entry must never carry dead_at"
            )
        # The .dead marker exists and carries dead_at.
        dead = path + ".dead"
        self.assertTrue(os.path.isfile(dead))
        with open(dead) as f:
            self.assertIn("dead_at", json.load(f))

    def test_mark_dead_no_tmp_left_behind(self):
        path = pending_mod.enqueue(self._sample_payload(), RuntimeError("boom"))
        _, entry = pending_mod.iter_entries()[0]
        pending_mod.mark_dead(path, entry)
        leftovers = [n for n in os.listdir(self._dir) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_count_safe_when_dir_missing(self):
        self.assertEqual(pending_mod.count(), 0)


if __name__ == "__main__":
    unittest.main()
