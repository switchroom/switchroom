"""Switchroom #3619 — unit tests for the degraded-recall disclosure.

Measured 2026-07-26 across `recall_log.jsonl` fleet-wide: of 1280 rows carrying
`bank_timings`, 1148 (89.7%) had the agent's OWN bank time out, and only 28 of
those still returned any memories. That ran for weeks without anyone noticing,
because a degraded recall and an empty-but-healthy recall were byte-identical
from the agent's side: both emit nothing. The agent then answers from no
context while its CLAUDE.md tells it recall "auto-fires on every inbound
message", so it asserts "no prior context" rather than "I could not check".

`degraded_recall_notice` closes that. These tests pin the behaviour that makes
it trustworthy rather than noisy:

  * It FIRES when the agent's own bank timed out or hard-errored.
  * It does NOT fire for a side-bank-only failure — a shared profile bank
    timing out does not mean the agent lost its own memory, and a notice that
    cries wolf gets ignored exactly when it matters.
  * It does NOT fire on a healthy-but-empty bank (the "you genuinely have no
    relevant memories" turn), which is the whole distinction being drawn.
  * The own bank is matched by `bank_id`, NEVER by position — fan-out
    completion order is not the source of `bank_timings` order and a
    positional match would silently report the wrong bank's health.
  * It is emitted OUTSIDE the cached context: `_combine_context` puts it
    first, and the cached `context_message` must never contain it, or a later
    healthy cache hit replays a stale "recall was DEGRADED" notice.

Stdlib-only, no network, no server.
"""

import io
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from recall import (  # noqa: E402
    _combine_context,
    degraded_recall_notice,
)

OWN = "overlord"
SIDE = "ken-profile"


def timing(bank_id, *, timed_out=False, errored=False, elapsed_ms=120):
    """A `bank_timings` entry in the exact shape recall.py appends at
    recall.py:1809 (parallel path) and recall.py:1851 (serial path)."""
    return {
        "bank_id": bank_id,
        "elapsed_ms": elapsed_ms,
        "timed_out": timed_out,
        "errored": errored,
    }


class TestDegradedNoticeFires(unittest.TestCase):
    def test_fires_when_own_bank_times_out(self):
        notice = degraded_recall_notice(
            OWN, [timing(OWN, timed_out=True, elapsed_ms=8003)]
        )
        self.assertIn("DEGRADED", notice)
        self.assertIn("timed out", notice)
        # The bank must be named — a generic notice gives the operator nothing
        # to grep for when three agents share a topic.
        self.assertIn(OWN, notice)

    def test_fires_when_own_bank_hard_errors(self):
        notice = degraded_recall_notice(OWN, [timing(OWN, errored=True)])
        self.assertIn("DEGRADED", notice)
        self.assertIn("was unreachable", notice)
        self.assertNotIn("timed out", notice)

    def test_fires_even_when_side_bank_returned_results(self):
        """The masking case that hid this for weeks: the own bank times out,
        the smaller shared bank answers, so the turn LOOKS like a successful
        recall (non-zero result_count) while the agent's own memory is gone."""
        notice = degraded_recall_notice(
            OWN,
            [timing(OWN, timed_out=True, elapsed_ms=8001), timing(SIDE, elapsed_ms=940)],
        )
        self.assertIn("DEGRADED", notice)

    def test_tells_the_agent_to_treat_absence_as_unknown(self):
        """The notice exists to change the agent's BEHAVIOUR on a degraded
        turn. If it stops saying so, it is decoration."""
        notice = degraded_recall_notice(OWN, [timing(OWN, timed_out=True)])
        self.assertIn("UNKNOWN", notice)

    def test_is_a_single_short_line(self):
        """Fires on an already-starved turn; a verbose block would spend the
        very budget the degradation is starving."""
        notice = degraded_recall_notice(OWN, [timing(OWN, timed_out=True)])
        self.assertNotIn("\n", notice)
        self.assertLess(len(notice), 500)


class TestDegradedNoticeSilent(unittest.TestCase):
    def test_silent_when_own_bank_healthy_but_empty(self):
        """The distinction the whole feature draws: a healthy bank with nothing
        relevant must stay silent, or the notice fires on ordinary turns and
        gets tuned out."""
        self.assertEqual(degraded_recall_notice(OWN, [timing(OWN)]), "")

    def test_silent_when_only_a_side_bank_fails(self):
        self.assertEqual(
            degraded_recall_notice(
                OWN, [timing(OWN, elapsed_ms=310), timing(SIDE, timed_out=True)]
            ),
            "",
        )

    def test_silent_when_only_a_side_bank_hard_errors(self):
        self.assertEqual(
            degraded_recall_notice(OWN, [timing(OWN), timing(SIDE, errored=True)]),
            "",
        )

    def test_silent_on_empty_or_missing_timings(self):
        # Cache-hit and trivial-skip turns take an early return with no
        # fan-out; nothing was attempted, so nothing is degraded.
        self.assertEqual(degraded_recall_notice(OWN, []), "")
        self.assertEqual(degraded_recall_notice(OWN, None), "")
        self.assertEqual(degraded_recall_notice("", [timing(OWN, timed_out=True)]), "")

    def test_silent_when_own_bank_absent_from_timings(self):
        self.assertEqual(
            degraded_recall_notice(OWN, [timing(SIDE, timed_out=True)]), ""
        )

    def test_tolerates_malformed_timing_entries(self):
        """`bank_timings` is telemetry read back into a decision; a stray
        non-dict must not take the whole hook down with a TypeError — the hook
        failing is strictly worse than the notice not firing."""
        self.assertEqual(
            degraded_recall_notice(OWN, ["junk", None, timing(OWN)]), ""
        )
        self.assertIn(
            "DEGRADED",
            degraded_recall_notice(OWN, ["junk", timing(OWN, timed_out=True)]),
        )


class TestOwnBankMatchedById(unittest.TestCase):
    def test_matches_own_bank_by_id_not_position(self):
        """Own-bank-first is the CONSTRUCTION order of bank_specs
        (recall.py:1716), not a guarantee a future refactor preserves. A
        positional [0] match here would report the side bank's health as the
        agent's own — silently, and in the direction of a false all-clear."""
        timings = [timing(SIDE, elapsed_ms=900), timing(OWN, timed_out=True)]
        notice = degraded_recall_notice(OWN, timings)
        self.assertIn("DEGRADED", notice)
        self.assertIn(OWN, notice)
        self.assertNotIn(SIDE, notice)

    def test_a_healthy_own_bank_listed_second_stays_silent(self):
        timings = [timing(SIDE, timed_out=True), timing(OWN, elapsed_ms=400)]
        self.assertEqual(degraded_recall_notice(OWN, timings), "")


class TestNoticeIsNotCached(unittest.TestCase):
    """The notice is per-turn state. `_combine_context`'s contract (recall.py
    :1289) is that transient blocks are appended at EMIT time and kept out of
    the string that reaches `_cache_store` / LAST_RECALL_STATE."""

    def test_combine_puts_the_notice_first(self):
        notice = degraded_recall_notice(OWN, [timing(OWN, timed_out=True)])
        context = "## Relevant memories\n- something"
        combined = _combine_context(_combine_context(notice, context), "")
        # First, because it changes how everything after it should be read.
        self.assertTrue(combined.startswith(notice))
        self.assertIn(context, combined)

    def test_combine_with_notice_and_nudge_keeps_both(self):
        notice = degraded_recall_notice(OWN, [timing(OWN, timed_out=True)])
        context = "## Relevant memories\n- something"
        nudge = "[Hindsight] consider create_directive"
        combined = _combine_context(_combine_context(notice, context), nudge)
        self.assertTrue(combined.startswith(notice))
        self.assertIn(context, combined)
        self.assertTrue(combined.endswith(nudge))

    def test_healthy_turn_combines_to_exactly_the_context(self):
        """No notice ⇒ emitted context is byte-identical to the cached one, so
        a healthy turn is unchanged by this feature."""
        notice = degraded_recall_notice(OWN, [timing(OWN)])
        context = "## Relevant memories\n- something"
        self.assertEqual(_combine_context(_combine_context(notice, context), ""), context)

    def test_cached_context_source_excludes_the_notice(self):
        """Regression guard on the actual defect this could reintroduce:
        if `degraded_block` were folded into `context_message`, that string is
        what gets written to the cache (recall.py `_cache_store(cache_key,
        context_message)`) and to LAST_RECALL_STATE — so the next HEALTHY turn
        served from cache would replay "recall was DEGRADED" and the agent
        would hedge for no reason."""
        source = os.path.join(SCRIPTS_DIR, "recall.py")
        with open(source, "r", encoding="utf-8") as fh:
            body = fh.read()
        # The composition of context_message must not reference degraded_block.
        # Anchor on the assignment itself and the cache write, so a mutation
        # that ADDS degraded_block to `parts` fails on the assertion below
        # rather than on a missing anchor.
        start_anchor = 'context_message = "\\n\\n".join(parts)'
        end_anchor = "_cache_store(cache_key, context_message)"
        self.assertIn(start_anchor, body, "context_message composition not found")
        self.assertIn(end_anchor, body, "recall cache write not found")
        # Walk back to the start of the `parts` accumulation.
        start = body.rindex("parts = []", 0, body.index(start_anchor))
        end = body.index(end_anchor)
        self.assertNotIn(
            "degraded_block",
            body[start:end],
            "degraded_block must not reach context_message: that string is "
            "cached and would replay a stale DEGRADED notice on a healthy hit",
        )
        # And it must still reach the emitted additionalContext — the final
        # emit site, which is the one after the cache write.
        emit_at = body.index('"additionalContext"', end)
        self.assertIn("degraded_block", body[emit_at : emit_at + 400])


def _memory(text, mem_id):
    return {"text": text, "type": "fact", "mentioned_at": "2026-01-01", "id": mem_id}


class _Client:
    """Fake HindsightClient with per-bank results / exceptions."""

    def __init__(self, bank_results=None, bank_errors=None):
        self._bank_results = bank_results or {}
        self._bank_errors = bank_errors or {}

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        exc = self._bank_errors.get(bank_id)
        if exc is not None:
            raise exc
        return {"results": list(self._bank_results.get(bank_id, []))}


class TestEndToEndEmit(unittest.TestCase):
    """Drive `recall.main()` end to end. The unit tests above pin the helper;
    these pin that the notice actually REACHES `additionalContext`, which is
    the only thing the agent ever sees."""

    OWN = "test-bank"
    SIDE = "shared-bank"

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-degraded-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _run(self, client, config_extra=None):
        hook_input = {
            "prompt": "what did we decide about the auth flow",
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": self.OWN,
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
        }
        if config_extra:
            config.update(config_extra)
        stdout = io.StringIO()
        stderr = io.StringIO()
        self._cached = []
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch.object(
            recall, "_cache_ttl_secs", return_value=300
        ), patch.object(recall, "_cache_lookup", return_value=None), patch.object(
            recall,
            "_cache_store",
            side_effect=lambda key, value: self._cached.append(value),
        ), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()
        raw = stdout.getvalue()
        if not raw.strip():
            return None
        return json.loads(raw)["hookSpecificOutput"]["additionalContext"]

    def test_masking_case_notice_rides_above_the_side_bank_memories(self):
        """The exact shape that hid the outage: own bank times out, the smaller
        shared bank answers, so the turn looks successful. The agent must still
        be told its own memory is missing."""
        client = _Client(
            bank_results={self.SIDE: [_memory("ken prefers TypeScript", "m1")]},
            bank_errors={self.OWN: socket.timeout("timed out")},
        )
        ctx = self._run(client, {"recallAdditionalBanks": [self.SIDE]})
        self.assertIsNotNone(ctx)
        self.assertTrue(ctx.startswith("[Hindsight] Memory recall was DEGRADED"))
        self.assertIn(self.OWN, ctx)
        # The side bank's memories are still delivered — the notice qualifies
        # them, it does not suppress them.
        self.assertIn("ken prefers TypeScript", ctx)

    def test_notice_is_not_written_to_the_recall_cache(self):
        """The cache write must carry the memories WITHOUT the notice, or the
        next healthy turn served from cache replays a stale DEGRADED line."""
        client = _Client(
            bank_results={self.SIDE: [_memory("ken prefers TypeScript", "m1")]},
            bank_errors={self.OWN: socket.timeout("timed out")},
        )
        self._run(client, {"recallAdditionalBanks": [self.SIDE]})
        self.assertEqual(len(self._cached), 1)
        self.assertNotIn("DEGRADED", self._cached[0])
        self.assertIn("ken prefers TypeScript", self._cached[0])

    def test_healthy_turn_emits_no_notice(self):
        client = _Client(bank_results={self.OWN: [_memory("something", "m1")]})
        ctx = self._run(client)
        self.assertIsNotNone(ctx)
        self.assertNotIn("DEGRADED", ctx)

    def test_side_bank_only_timeout_emits_no_notice(self):
        client = _Client(
            bank_results={self.OWN: [_memory("something", "m1")]},
            bank_errors={self.SIDE: socket.timeout("timed out")},
        )
        ctx = self._run(client, {"recallAdditionalBanks": [self.SIDE]})
        self.assertIsNotNone(ctx)
        self.assertNotIn("DEGRADED", ctx)

    def test_total_failure_emits_the_notice_alone(self):
        client = _Client(bank_errors={self.OWN: socket.timeout("timed out")})
        ctx = self._run(client)
        self.assertIsNotNone(ctx)
        self.assertIn("DEGRADED", ctx)
        self.assertNotIn("<hindsight_memories>", ctx)


if __name__ == "__main__":
    unittest.main()
