"""Oversized retain content must be bounded and split before it is POSTed.

These tests assert the OUTCOME of the fix, not that a function runs: each one
fails against the pre-fix code, where ``client.retain()`` posted a single item
of unbounded length. The bug being fixed is that the daemon runs one
sequential extraction LLM call per 3000 chars, so a 744k-char retain is ~249
sequential calls and can never complete inside any client deadline — the
memory is permanently unsaveable.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lib import client as client_mod  # noqa: E402
from lib import pending  # noqa: E402
from lib import retain_split  # noqa: E402
from lib.client import HindsightClient  # noqa: E402
from lib.retain_split import (  # noqa: E402
    part_document_id,
    part_metadata,
    retain_content_limit,
    split_retain_content,
)


def _json_transcript(n_messages: int, chars_each: int) -> str:
    return json.dumps(
        [
            {"role": "user" if i % 2 == 0 else "assistant",
             "content": [{"type": "text", "text": "x" * chars_each}]}
            for i in range(n_messages)
        ],
        indent=None,
        ensure_ascii=False,
    )


def _text_transcript(n_blocks: int, chars_each: int) -> str:
    return "\n\n".join(
        f"[role: user]\n{'y' * chars_each}\n[user:end]" for _ in range(n_blocks)
    )


class TestDerivedLimit(unittest.TestCase):
    def tearDown(self):
        for key in (
            "HINDSIGHT_RETAIN_MAX_CONTENT_CHARS",
            "HINDSIGHT_RETAIN_CHUNK_SIZE",
            "HINDSIGHT_RETAIN_CHUNK_LATENCY_S",
            "HINDSIGHT_RETAIN_CLIENT_DEADLINE_S",
        ):
            os.environ.pop(key, None)

    def test_limit_is_chunk_size_times_chunks_that_fit_the_deadline(self):
        # chunk_size * floor(deadline / latency) = 3000 * floor(280/18.4) = 45000
        self.assertEqual(retain_content_limit(), 45000)

    def test_limit_is_derived_from_chunk_size_not_a_constant(self):
        os.environ["HINDSIGHT_RETAIN_CHUNK_SIZE"] = "1000"
        self.assertEqual(retain_content_limit(), 15000)

    def test_limit_tracks_the_client_deadline(self):
        os.environ["HINDSIGHT_RETAIN_CLIENT_DEADLINE_S"] = "92"
        # floor(92 / 18.4) = 5 chunks
        self.assertEqual(retain_content_limit(), 15000)

    def test_limit_never_falls_below_one_chunk(self):
        os.environ["HINDSIGHT_RETAIN_CLIENT_DEADLINE_S"] = "1"
        self.assertEqual(retain_content_limit(), 3000)

    def test_garbage_env_falls_back_to_the_derived_default(self):
        os.environ["HINDSIGHT_RETAIN_CHUNK_LATENCY_S"] = "not-a-number"
        self.assertEqual(retain_content_limit(), 45000)


class TestSplitBounds(unittest.TestCase):
    def test_content_within_the_limit_is_untouched(self):
        content = _json_transcript(3, 100)
        self.assertEqual(split_retain_content(content), [content])

    def test_every_part_of_an_oversized_json_transcript_is_within_the_limit(self):
        content = _json_transcript(40, 5000)  # ~200k chars
        self.assertGreater(len(content), 45000)
        parts = split_retain_content(content)
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertLessEqual(len(part), 45000)

    def test_every_part_of_an_oversized_text_transcript_is_within_the_limit(self):
        content = _text_transcript(60, 4000)  # ~240k chars
        parts = split_retain_content(content, 45000)
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertLessEqual(len(part), 45000)

    def test_worst_case_backlog_entry_is_bounded(self):
        # The largest entry measured in the 2026-07-25 fleet backlog.
        content = _json_transcript(200, 3700)
        self.assertGreater(len(content), 744000)
        parts = split_retain_content(content)
        self.assertTrue(all(len(p) <= 45000 for p in parts))
        # ~249 sequential extraction calls become bounded batches of <=15.
        self.assertGreaterEqual(len(parts), 16)

    def test_single_oversized_message_is_split_not_dropped(self):
        content = _json_transcript(1, 300000)
        parts = split_retain_content(content)
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertLessEqual(len(part), 45000)

    def test_single_unbreakable_line_still_respects_the_bound(self):
        # No structural boundary anywhere: the bound must still hold.
        parts = split_retain_content("z" * 500000, 45000)
        self.assertTrue(all(len(p) <= 45000 for p in parts))
        self.assertEqual("".join(parts), "z" * 500000)


class TestSplitPreservesStructure(unittest.TestCase):
    def test_json_parts_are_each_a_valid_json_transcript(self):
        content = _json_transcript(40, 5000)
        for part in split_retain_content(content):
            decoded = json.loads(part)
            self.assertIsInstance(decoded, list)
            self.assertTrue(decoded)
            for message in decoded:
                self.assertIn("role", message)
                self.assertIn("content", message)

    def test_json_split_loses_no_message_and_keeps_order(self):
        content = _json_transcript(40, 5000)
        original = json.loads(content)
        rejoined = []
        for part in split_retain_content(content):
            rejoined.extend(json.loads(part))
        self.assertEqual([m["role"] for m in rejoined], [m["role"] for m in original])
        self.assertEqual(
            "".join(b["text"] for m in rejoined for b in m["content"]),
            "".join(b["text"] for m in original for b in m["content"]),
        )

    def test_a_split_message_keeps_its_role_on_every_fragment(self):
        content = json.dumps(
            [{"role": "assistant", "content": [{"type": "text", "text": "q" * 300000}]}],
            indent=None,
            ensure_ascii=False,
        )
        for part in split_retain_content(content):
            for message in json.loads(part):
                self.assertEqual(message["role"], "assistant")

    def test_text_parts_keep_whole_role_blocks(self):
        content = _text_transcript(60, 4000)
        for part in split_retain_content(content, 45000):
            self.assertTrue(part.startswith("[role: user]"))
            self.assertTrue(part.endswith("[user:end]"))
            self.assertEqual(part.count("[role: user]"), part.count("[user:end]"))

    def test_an_oversized_text_block_is_rewrapped_with_its_role_markers(self):
        content = _text_transcript(1, 200000)
        parts = split_retain_content(content, 45000)
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertTrue(part.startswith("[role: user]\n"))
            self.assertTrue(part.endswith("\n[user:end]"))

    def test_split_is_deterministic(self):
        content = _json_transcript(40, 5000)
        self.assertEqual(split_retain_content(content), split_retain_content(content))


class TestPartIdentity(unittest.TestCase):
    def test_unsplit_document_id_and_metadata_are_unchanged(self):
        self.assertEqual(part_document_id("sess-rA-B", 0, 1), "sess-rA-B")
        self.assertEqual(part_metadata({"session_id": "s"}, 0, 1), {"session_id": "s"})

    def test_part_ids_are_unique_so_parts_cannot_overwrite_each_other(self):
        ids = [part_document_id("sess-rA-B", i, 5) for i in range(5)]
        self.assertEqual(len(set(ids)), 5)

    def test_part_ids_keep_the_session_prefix(self):
        self.assertTrue(part_document_id("sess123-rA-B", 2, 5).startswith("sess123"))

    def test_part_metadata_records_provenance_without_mutating_the_input(self):
        original = {"session_id": "s"}
        meta = part_metadata(original, 2, 5)
        self.assertEqual(meta["retain_part_index"], "3")
        self.assertEqual(meta["retain_part_count"], "5")
        self.assertEqual(original, {"session_id": "s"})


class _RecordingClient(HindsightClient):
    """Client that records POSTs instead of issuing them."""

    def __init__(self, *a, fail_on=None, **kw):
        super().__init__(*a, **kw)
        self.posts = []
        self.fail_on = fail_on

    def _request(self, method, path, body=None, timeout=None):
        if self.fail_on is not None and len(self.posts) == self.fail_on:
            self.posts.append((path, body, timeout))
            raise RuntimeError("upstream boom")
        self.posts.append((path, body, timeout))
        return {"ok": True}


class TestClientEnforcesTheBound(unittest.TestCase):
    def setUp(self):
        self.client = _RecordingClient("http://hindsight.invalid")

    def test_oversized_retain_is_never_posted_as_one_item(self):
        # The bug: pre-fix this was a single POST of 200k chars, which the
        # daemon turns into ~67 sequential LLM calls and no deadline covers.
        self.client.retain("bank", _json_transcript(40, 5000), document_id="doc")
        self.assertGreater(len(self.client.posts), 1)
        for _path, body, _timeout in self.client.posts:
            self.assertEqual(len(body["items"]), 1)
            self.assertLessEqual(len(body["items"][0]["content"]), 45000)

    def test_small_retain_still_posts_exactly_once_with_the_original_id(self):
        self.client.retain("bank", "small transcript", document_id="doc")
        self.assertEqual(len(self.client.posts), 1)
        self.assertEqual(self.client.posts[0][1]["items"][0]["document_id"], "doc")
        self.assertNotIn("retain_part_index", self.client.posts[0][1]["items"][0]["metadata"])

    def test_each_part_gets_a_distinct_document_id(self):
        self.client.retain("bank", _json_transcript(40, 5000), document_id="doc")
        ids = [b["items"][0]["document_id"] for _p, b, _t in self.client.posts]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertTrue(all(i.startswith("doc-p") for i in ids))

    def test_every_part_carries_the_callers_commit_before_ack_and_context(self):
        self.client.retain(
            "bank",
            _json_transcript(40, 5000),
            document_id="doc",
            context="claude-code",
            tags=["t"],
            async_processing=False,
            timeout=280,
        )
        for _path, body, timeout in self.client.posts:
            self.assertIs(body["async"], False)
            self.assertEqual(body["items"][0]["context"], "claude-code")
            self.assertEqual(body["items"][0]["tags"], ["t"])
            # Each part gets a positive request deadline, clamped to what is
            # left of the caller's 280s wall budget (never more than it).
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 280)

    def test_a_failing_part_raises_so_the_caller_still_enqueues_and_retries(self):
        client = _RecordingClient("http://hindsight.invalid", fail_on=2)
        with self.assertRaises(RuntimeError):
            client.retain("bank", _json_transcript(40, 5000), document_id="doc")
        self.assertEqual(len(client.posts), 3)  # stops at the failure

    def test_retry_after_partial_failure_reposts_identical_part_ids(self):
        content = _json_transcript(40, 5000)
        first = _RecordingClient("http://hindsight.invalid", fail_on=2)
        with self.assertRaises(RuntimeError):
            first.retain("bank", content, document_id="doc")
        second = _RecordingClient("http://hindsight.invalid")
        second.retain("bank", content, document_id="doc")
        committed = [b["items"][0]["document_id"] for _p, b, _t in first.posts[:2]]
        retried = [b["items"][0]["document_id"] for _p, b, _t in second.posts[:2]]
        # Identical ids ⇒ the daemon upserts the already-committed parts
        # instead of double-storing them.
        self.assertEqual(committed, retried)

    def test_split_count_is_reported_on_the_response(self):
        response = self.client.retain("bank", _json_transcript(40, 5000), document_id="doc")
        self.assertEqual(response["split_parts"], len(self.client.posts))

    def test_limit_is_read_at_call_time_from_the_environment(self):
        os.environ["HINDSIGHT_RETAIN_MAX_CONTENT_CHARS"] = "6000"
        try:
            self.client.retain("bank", _json_transcript(10, 1000), document_id="doc")
        finally:
            os.environ.pop("HINDSIGHT_RETAIN_MAX_CONTENT_CHARS", None)
        self.assertGreater(len(self.client.posts), 1)
        for _p, body, _t in self.client.posts:
            self.assertLessEqual(len(body["items"][0]["content"]), 6000)


class TestRetainRespectsTheCallersWallBudget(unittest.TestCase):
    """Splitting must not turn one bounded POST into N of them.

    The Stop hook passes ``timeout=15`` because it has a hook budget. Posting
    17 parts at 15s each would stall the session for over four minutes — a
    worse bug than the one being fixed. Fails against the first cut of the fix,
    which passed the caller's timeout to every part with no overall bound.
    """

    def test_total_wall_time_is_bounded_by_the_callers_timeout(self):
        class _SlowClient(_RecordingClient):
            def _request(self, method, path, body=None, timeout=None):
                self.clock[0] += 9.0  # each part burns 9s
                return super()._request(method, path, body, timeout)

        client = _SlowClient("http://hindsight.invalid")
        client.clock = [0.0]
        real_monotonic = client_mod.time.monotonic
        client_mod.time.monotonic = lambda: client.clock[0]
        try:
            with self.assertRaises(TimeoutError):
                client.retain("bank", _json_transcript(40, 20000), timeout=15)
        finally:
            client_mod.time.monotonic = real_monotonic
        # 15s budget, 9s per part: part 1 runs, part 2 starts (6s left), part 3
        # must not. Bounded — not all 40-message-worth of parts.
        self.assertEqual(len(client.posts), 2)

    def test_parts_that_fit_the_budget_all_post(self):
        client = _RecordingClient("http://hindsight.invalid")
        content = _json_transcript(40, 20000)
        result = client.retain("bank", content, timeout=280)
        self.assertGreater(len(client.posts), 1)
        self.assertEqual(result["split_parts"], len(client.posts))


class TestEnqueueQueuesBoundedEntries(unittest.TestCase):
    """An oversized entry can never be drained, so it must never be queued.

    drain_pending marks an entry ``.dead`` after MAX_ATTEMPTS failures. A
    queued 744k-char payload fails every attempt by construction, so queuing it
    whole is a scheduled data loss. Fails against pre-fix pending.enqueue,
    which wrote one entry of whatever size it was handed.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._prev = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._prev
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _payload(self, content):
        return {
            "api_url": "http://hindsight.invalid",
            "bank_id": "bank",
            "document_id": "sess-r1-2",
            "content": content,
            "metadata": {"source": "test"},
        }

    def test_small_payload_still_queues_exactly_one_unchanged_entry(self):
        pending.enqueue(self._payload("short content"), RuntimeError("boom"))
        entries = pending.iter_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0][1]["content"], "short content")
        self.assertEqual(entries[0][1]["document_id"], "sess-r1-2")

    def test_oversized_payload_is_queued_as_multiple_bounded_entries(self):
        content = _json_transcript(40, 20000)
        pending.enqueue(self._payload(content), RuntimeError("boom"))
        entries = pending.iter_entries()
        limit = retain_content_limit()
        self.assertGreater(len(entries), 1)
        for _path, entry in entries:
            self.assertLessEqual(len(entry["content"]), limit)

    def test_queued_parts_have_distinct_deterministic_ids(self):
        content = _json_transcript(40, 20000)
        pending.enqueue(self._payload(content), RuntimeError("boom"))
        ids = [e["document_id"] for _p, e in pending.iter_entries()]
        self.assertEqual(len(ids), len(set(ids)))
        total = len(ids)
        self.assertEqual(
            sorted(ids),
            sorted(part_document_id("sess-r1-2", i, total) for i in range(total)),
        )

    def test_queue_cap_is_still_respected_when_splitting(self):
        """A memory needing more parts than the cap is REFUSED, not partly kept.

        This asserted "queue the 2 parts that fit" before the rebase onto
        #3599. That answer stopped being available: #3599 replaced the
        "refuse at MAX_ENTRIES" branch with ``_evict_to_fit``, so writing
        part 20 of 20 under a 2-entry cap now sheds parts 1-18 of the SAME
        memory along with everything else already queued, and leaves a
        meaningless tail fragment behind. Refusing matches #3599's own
        byte-cap guard: one memory must never cost the whole queue.
        """
        content = _json_transcript(40, 20000)
        original = pending.MAX_ENTRIES
        pending.MAX_ENTRIES = 2
        try:
            with redirect_stderr(io.StringIO()) as err:
                got = pending.enqueue(self._payload(content), RuntimeError("boom"))
        finally:
            pending.MAX_ENTRIES = original
        self.assertIsNone(got)
        self.assertEqual(len(pending.iter_entries()), 0)
        self.assertIn("more than the whole", err.getvalue())


class TestModuleIsPure(unittest.TestCase):
    def test_splitter_imports_nothing_nondeterministic_or_networked(self):
        # The split must be a pure function of (content, limit): a clock or an
        # RNG in here would make retry ids diverge and turn every retry into a
        # duplicate document instead of an upsert.
        import ast

        with open(retain_split.__file__, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertEqual(imported, {"__future__", "json", "os", "typing"})


if __name__ == "__main__":
    unittest.main()
