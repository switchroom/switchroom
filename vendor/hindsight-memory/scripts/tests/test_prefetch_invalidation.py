"""M4 prefetch-buffer MUTATION INVALIDATION — red-team-M3 R2 (BLOCKER).

The M4 prefetch buffer holds a RECALLED memories block captured at a prior
turn's Stop hook and consumed at the next UserPromptSubmit. If a mutation —
a rule/directive retire, or a retain that supersedes a fact — lands between
producing that buffer and consuming it, the pre-mutation snapshot can
resurrect the just-retired/just-changed content on a later turn. Worse,
``prefetch.run_prefetch`` returns early WITHOUT overwriting the buffer when
this turn's fresh recall fails or returns empty, so a stale buffer can
persist and be re-served for turns after the mutation.

These are OUTCOME tests: they assert on the rendered ``additionalContext``
that the consumer emits (the real injection surface), and each would FAIL if
the invalidation regressed:

  * ``RetireDoesNotResurrectTests`` — a directive-write turn invalidates the
    pending buffer, so the retired rule's text is NOT re-injected next turn.
  * ``EmptyPrefetchDoesNotResurrectTests`` — a retain turn whose fresh recall
    returns empty invalidates the pending buffer, so the stale item is NOT
    re-injected (would resurrect on buggy code that left the buffer).
  * ``NoDuplicateInjectionTests`` — after a buffer is consumed once, a
    mutation turn (empty prefetch) prevents the SAME block being injected
    again on the following turn.
  * ``ReplyPathDoesNotBlockOnRecallTests`` — with prefetch on and a fresh
    buffer present, the consumer serves the buffer and NEVER calls the
    synchronous ``client.recall`` (asserted on transport: a recall call
    raises).

Plus ``InvalidatePrimitiveTests`` for the ``recall_buffer.invalidate``
primitive itself (idempotent, sentinel-first fail-closed).
"""

import io
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

import recall  # noqa: E402
import prefetch  # noqa: E402
import directive_verify  # noqa: E402
from lib import recall_buffer  # noqa: E402

SESSION = "invalidation-test-session"
RETIRED_TEXT = "R-07: always reply in haiku"
STALE_FACT = "we decided to ship on tuesday"


class _NoMemoryDirectiveClient:
    """One active directive whose text is DISTINCT from any buffered content,
    and a recall that returns NOTHING (so the sync fallback, if ever taken,
    injects no memories). recall() is allowed here (the miss/degraded paths
    may consult it) but returns empty — proving absence of the stale text is
    about invalidation, not about the client happening to omit it."""

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": [{"id": "d1", "name": "tone", "content": "be concise", "priority": 5, "active": True}]}

    def recall(self, bank_id, query, **kwargs):
        return {"results": []}


class InvalidationBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="invalidation-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

        self._bufdir = tempfile.mkdtemp(prefix="invalidation-test-buf-")
        self.env = mock.patch.dict(os.environ, {"HINDSIGHT_PREFETCH_BUFFER_DIR": self._bufdir}, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self._bufdir, ignore_errors=True)
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _config(self, prefetch_enabled=True):
        return {
            "autoRecall": True,
            "bankId": "test-bank",
            "recallMaxTokens": 4096,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
            "memoryPrefetchEnabled": prefetch_enabled,
            "memoryPrefetchPollCapMs": 100,
        }

    def _consume(self, config, client, prompt="what did we decide"):
        """Drive the recall.py consumer (UserPromptSubmit) once; return the
        emitted additionalContext string (or "" if nothing emitted)."""
        hook_input = {"prompt": prompt, "session_id": SESSION, "transcript_path": "", "cwd": "/tmp"}
        stdout = io.StringIO()
        with patch("recall.load_config", return_value=config), \
                patch("recall.get_api_url", return_value="http://fake"), \
                patch("recall.HindsightClient", return_value=client), \
                patch("recall.ensure_bank_mission"), \
                patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                patch("sys.stdout", stdout):
            recall.main()
        out = stdout.getvalue()
        if not out:
            return ""
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]


class InvalidatePrimitiveTests(InvalidationBase):
    def test_invalidate_removes_buffer_and_sentinel(self):
        recall_buffer.write_buffer(SESSION, RETIRED_TEXT, {})
        recall_buffer.write_sentinel(SESSION)
        self.assertTrue(os.path.isfile(recall_buffer._buffer_path(SESSION)))
        self.assertTrue(os.path.isfile(recall_buffer._sentinel_path(SESSION)))

        recall_buffer.invalidate(SESSION)

        self.assertFalse(os.path.isfile(recall_buffer._buffer_path(SESSION)))
        self.assertFalse(os.path.isfile(recall_buffer._sentinel_path(SESSION)))
        # read_if_fresh must now report nothing fresh (fail-closed).
        payload, _ = recall_buffer.read_if_fresh(SESSION, last_consumed_token=None)
        self.assertIsNone(payload)

    def test_invalidate_is_idempotent_on_absent_files(self):
        # No buffer written — must not raise.
        recall_buffer.invalidate(SESSION)
        recall_buffer.invalidate(SESSION)

    def test_orphaned_payload_after_sentinel_first_delete_fails_closed(self):
        # Simulate a partial invalidation where only the sentinel unlink
        # landed (sentinel is deleted FIRST by design): an orphaned payload
        # must never read as fresh.
        recall_buffer.write_buffer(SESSION, RETIRED_TEXT, {})
        recall_buffer.write_sentinel(SESSION)
        os.remove(recall_buffer._sentinel_path(SESSION))
        payload, _ = recall_buffer.read_if_fresh(SESSION, last_consumed_token=None)
        self.assertIsNone(payload)


class RetireDoesNotResurrectTests(InvalidationBase):
    """Assertion (1): a directive retire invalidates the pending buffer so the
    retired item is NOT re-injected on the next turn."""

    def _retire_turn_messages(self):
        # A real turn transcript: the user retires a rule, the assistant issues
        # a delete_directive tool_use. This is what directive_verify inspects.
        return [
            {"role": "user", "content": "Retire the haiku rule R-07, it no longer applies."},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "t1", "name": "delete_directive", "input": {"id": "d-r07"}}
                ],
            },
        ]

    def test_directive_write_turn_invalidates_buffer_and_blocks_resurrection(self):
        config = self._config(prefetch_enabled=True)

        # Turn N Stop: prefetch buffered the rule text while it was still active.
        recall_buffer.write_buffer(SESSION, RETIRED_TEXT, {})
        recall_buffer.write_sentinel(SESSION)

        # Turn N+1: the retire lands. directive_verify's Stop-hook invalidation
        # detects the delete_directive write and drops the pending buffer.
        directive_verify.invalidate_prefetch_buffer_on_directive_write(
            self._retire_turn_messages(), config, SESSION
        )
        self.assertFalse(
            os.path.isfile(recall_buffer._sentinel_path(SESSION)),
            "directive-write turn must invalidate the pending prefetch buffer",
        )

        # Turn N+2 UserPromptSubmit: the consumer must NOT re-inject the retired
        # rule text. (With no fresh buffer it takes the sync/degraded path, which
        # here surfaces only the fresh directive block, not the retired text.)
        ctx = self._consume(config, _NoMemoryDirectiveClient())
        self.assertNotIn(
            "R-07", ctx,
            "retired rule text must not resurrect from a pre-retire prefetch buffer",
        )
        self.assertNotIn("haiku", ctx)

    def test_non_directive_turn_leaves_buffer_intact(self):
        # Guard against over-invalidation: an ordinary turn (no directive write)
        # must NOT drop the buffer, or every turn would lose the prefetch.
        config = self._config(prefetch_enabled=True)
        recall_buffer.write_buffer(SESSION, "- a normal prefetched memory", {})
        recall_buffer.write_sentinel(SESSION)
        directive_verify.invalidate_prefetch_buffer_on_directive_write(
            [
                {"role": "user", "content": "what's the weather"},
                {"role": "assistant", "content": "Sunny."},
            ],
            config,
            SESSION,
        )
        self.assertTrue(os.path.isfile(recall_buffer._sentinel_path(SESSION)))

    def test_flag_off_is_a_noop(self):
        # Kill switch: with prefetch off, the directive-write invalidation must
        # not touch the buffer module at all.
        config = self._config(prefetch_enabled=False)
        recall_buffer.write_buffer(SESSION, RETIRED_TEXT, {})
        recall_buffer.write_sentinel(SESSION)
        with patch("directive_verify.recall_buffer.invalidate",
                   side_effect=AssertionError("must not invalidate when prefetch is off")):
            directive_verify.invalidate_prefetch_buffer_on_directive_write(
                self._retire_turn_messages(), config, SESSION
            )
        self.assertTrue(os.path.isfile(recall_buffer._sentinel_path(SESSION)))


class EmptyPrefetchDoesNotResurrectTests(InvalidationBase):
    """Assertion (1) via the RETAIN mutation path: a retain turn whose fresh
    recall returns empty must invalidate the pending buffer so the stale item
    is NOT re-served. This FAILS on buggy code that returns early leaving the
    old buffer in place."""

    def test_retain_turn_with_empty_recall_invalidates_stale_buffer(self):
        config = self._config(prefetch_enabled=True)

        # Turn N Stop: a stale fact was buffered.
        recall_buffer.write_buffer(SESSION, STALE_FACT, {})
        recall_buffer.write_sentinel(SESSION)

        # Turn N+1 Stop: prefetch runs (a retain mutation), but this turn's
        # fresh recall returns NOTHING. run_prefetch must have already
        # invalidated the old buffer up front — so no stale buffer survives.
        empty_client = mock.Mock()
        empty_client.recall.return_value = {"results": []}
        hook_input = {
            "prompt": "and another thing",
            "session_id": SESSION,
            "transcript_path": "",  # _last_human_prompt degrades to "" -> we inject a query below
            "cwd": "/tmp",
        }
        with patch("prefetch.retain_module.run_retain", return_value={"status": "ok"}), \
                patch("prefetch.HindsightClient", return_value=empty_client), \
                patch("prefetch.get_api_url", return_value="http://fake"), \
                patch("prefetch._last_human_prompt", return_value="and another thing"):
            wrote = prefetch.run_prefetch(hook_input, config)

        self.assertFalse(wrote, "empty recall must not write a fresh buffer")
        self.assertFalse(
            os.path.isfile(recall_buffer._sentinel_path(SESSION)),
            "a mutation (retain) turn must invalidate the stale buffer even when the fresh recall is empty",
        )

        # Turn N+2 UserPromptSubmit: the stale fact must NOT re-inject.
        ctx = self._consume(config, _NoMemoryDirectiveClient())
        self.assertNotIn(
            STALE_FACT, ctx,
            "stale buffered fact must not resurrect after a mutation turn with an empty recall",
        )


class NoDuplicateInjectionTests(InvalidationBase):
    """Assertion (2): the same buffered block is not injected twice. After a
    turn consumes a buffer, a mutation turn (empty prefetch) prevents the SAME
    block from being re-served on the following turn."""

    def test_consumed_buffer_not_reinjected_after_mutation_turn(self):
        config = self._config(prefetch_enabled=True)
        marker = "- unique-fact-abc123 decided at standup"

        recall_buffer.write_buffer(SESSION, marker, {})
        recall_buffer.write_sentinel(SESSION)

        # Turn N+1: consumer injects the buffered block once.
        first = self._consume(config, _NoMemoryDirectiveClient())
        self.assertIn("unique-fact-abc123", first)

        # Turn N+1 Stop: a mutation turn whose recall returns empty -> the old
        # buffer is invalidated, nothing fresh written.
        empty_client = mock.Mock()
        empty_client.recall.return_value = {"results": []}
        hook_input = {"prompt": "next", "session_id": SESSION, "transcript_path": "", "cwd": "/tmp"}
        with patch("prefetch.retain_module.run_retain", return_value={"status": "ok"}), \
                patch("prefetch.HindsightClient", return_value=empty_client), \
                patch("prefetch.get_api_url", return_value="http://fake"), \
                patch("prefetch._last_human_prompt", return_value="next"):
            prefetch.run_prefetch(hook_input, config)

        # Turn N+2: the same block must NOT be injected a second time.
        second = self._consume(config, _NoMemoryDirectiveClient())
        self.assertNotIn(
            "unique-fact-abc123", second,
            "a consumed buffer must not be re-injected after a mutation invalidated it",
        )


class ReplyPathDoesNotBlockOnRecallTests(InvalidationBase):
    """Assertion (3): with prefetch on and a fresh buffer present, the reply
    path (UserPromptSubmit consumer) joins the buffer and NEVER blocks on a
    synchronous recall. Asserted on transport: client.recall raises if called."""

    def test_fresh_buffer_served_without_calling_recall(self):
        config = self._config(prefetch_enabled=True)
        recall_buffer.write_buffer(SESSION, "- a prefetched memory xyz", {})
        recall_buffer.write_sentinel(SESSION)

        class _ExplodingRecallClient:
            def list_directives(self, bank_id, active_only=True, timeout=2):
                return {"items": []}

            def recall(self, bank_id, query, **kwargs):
                raise AssertionError("reply path must not block on synchronous recall when a fresh buffer exists")

        ctx = self._consume(config, _ExplodingRecallClient())
        self.assertIn("a prefetched memory xyz", ctx)


if __name__ == "__main__":
    unittest.main()
