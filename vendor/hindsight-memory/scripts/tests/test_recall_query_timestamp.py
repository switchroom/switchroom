"""Switchroom P2 (memory-redesign RFC §5) — pass a `query_timestamp` anchor
from the recall hook when the inbound prompt is time-relative.

`query_timestamp` is an ISO 8601 datetime naming when the query is being asked
(https://hindsight.vectorize.io/developer/api/recall). The engine uses it to
resolve relative temporal expressions in the query ("last week", "yesterday",
"on the 12th") and to anchor recency scoring. A REST probe on the live engine
(2026-08-17) confirmed the field is ACCEPTED and HONOURED by the recall body:
a malformed value 400s ("Invalid query_timestamp format. Expected ISO format")
and a different anchor changes the returned result ordering — so it is neither
ignored nor rejected.

The guarantees under test are OUTCOMES on the wire body and the recall_log
row, never a branch taken:

  1. The date parser maps representative temporal phrases to a deterministic
     anchor (the injected `now`, ISO 8601) and returns None for text with no
     temporal phrase — a pure, IO-free, model-free regex.
  2. Absent a temporal phrase the field is NEVER added to the recall body, so
     the wire body is byte-identical to a pre-P2 client.
  3. Present a temporal phrase, the exact anchor reaches the wire.
  4. The recall_log row carries `query_timestamp` (the ISO value when it fired,
     null otherwise) so its firing rate is measurable from day one.
  5. The `recallQueryTimestamp: false` gate suppresses the field even on a
     temporal prompt (the rollback lever).

Stdlib-only (unittest + mock); runs under ``python3 -m unittest discover
tests/``. Wire-body harness mirrors ``test_observation_scopes.py``; the
end-to-end harness mirrors ``test_recall_min_score.py``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from recall import detect_query_timestamp  # noqa: E402
from lib.client import HindsightClient  # noqa: E402

# A fixed anchor so every parser assertion is byte-exact and clock-independent.
FIXED_NOW = datetime(2026, 8, 17, 12, 0, 0, tzinfo=timezone.utc)
FIXED_ISO = FIXED_NOW.isoformat()

OWN = "test-bank"


class DetectQueryTimestampParser(unittest.TestCase):
    """The deterministic temporal-expression parser (pure function)."""

    # Representative phrases across the families the regex covers. Each MUST
    # map to the injected anchor — the value is always "now" by the field's
    # documented semantics (the engine resolves the phrase against the anchor).
    TEMPORAL = [
        "what did we work on last week",
        "remind me what happened yesterday",
        "did we ship it this month",
        "what's on for next week",
        "what did I say a couple of days ago",
        "we discussed this 3 weeks ago",
        "what did we decide on the 12th",
        "the incident on tuesday",
        "what did we do last tuesday",
        "the plan from last night",
        "back in june we agreed something",
        "the deploy earlier today",
        "the other day you mentioned a bug",
        "the release two months ago",
    ]

    # Ordinary sentences whose tokens brush temporal words but carry no
    # actual temporal expression — the negative guard must keep the field off.
    NON_TEMPORAL = [
        "how do I restart the hindsight container",
        "explain the recall cache key",
        "may I ask about the auth flow",  # bare "may" (modal), not a month
        "the friday deploy script is broken",  # bare weekday, no preposition
        "august is a bank name here",  # bare month, no preposition
        "summarise the current architecture",
        "what is 2 plus 2",
    ]

    def test_temporal_phrases_map_to_the_injected_anchor(self):
        for phrase in self.TEMPORAL:
            with self.subTest(phrase=phrase):
                self.assertEqual(
                    detect_query_timestamp(phrase, now=FIXED_NOW),
                    FIXED_ISO,
                    f"expected anchor for temporal phrase: {phrase!r}",
                )

    def test_non_temporal_text_returns_none(self):
        for phrase in self.NON_TEMPORAL:
            with self.subTest(phrase=phrase):
                self.assertIsNone(
                    detect_query_timestamp(phrase, now=FIXED_NOW),
                    f"unexpected anchor for non-temporal phrase: {phrase!r}",
                )

    def test_empty_and_non_string_return_none(self):
        self.assertIsNone(detect_query_timestamp("", now=FIXED_NOW))
        self.assertIsNone(detect_query_timestamp("   ", now=FIXED_NOW))
        self.assertIsNone(detect_query_timestamp(None, now=FIXED_NOW))
        self.assertIsNone(detect_query_timestamp(42, now=FIXED_NOW))

    def test_default_anchor_is_local_wall_clock_not_utc(self):
        # No injected now → real clock. The anchor must carry the PROCESS-LOCAL
        # offset (datetime.now().astimezone()), never a hardcoded UTC. A
        # UTC-stamped anchor tells the engine the operator is in UTC and
        # resolves "yesterday"/"last week"/"on the 12th" against the wrong
        # calendar day for a Melbourne query — the exact off-by-one P2 serves.
        out = detect_query_timestamp("what did we do yesterday")
        self.assertIsNotNone(out)
        parsed = datetime.fromisoformat(out)
        self.assertIsNotNone(parsed.tzinfo, "anchor must be timezone-aware")
        # The offset is the process-local one, whatever the CI TZ — not an
        # assumed UTC. In the Melbourne container this is +10/+11, never +00:00.
        self.assertEqual(
            parsed.utcoffset(),
            datetime.now().astimezone().utcoffset(),
            "anchor offset must be the process-local offset, not UTC",
        )

    def test_injected_local_instant_keeps_the_local_day_not_the_utc_day(self):
        # Pin a Melbourne-morning instant (UTC+10) whose UTC calendar day is
        # the PREVIOUS day. The returned anchor must keep the LOCAL day (17th),
        # because that is the operator's real "today"; a UTC conversion would
        # slip it to the 16th and mis-resolve every relative phrase by a day.
        aest = timezone(timedelta(hours=10))
        local_now = datetime(2026, 8, 17, 9, 0, 0, tzinfo=aest)
        # Guard the fixture itself: local and UTC really are different days.
        self.assertEqual(local_now.date().isoformat(), "2026-08-17")
        self.assertEqual(
            local_now.astimezone(timezone.utc).date().isoformat(), "2026-08-16"
        )
        out = detect_query_timestamp("what did we do yesterday", now=local_now)
        parsed = datetime.fromisoformat(out)
        self.assertEqual(parsed.date().isoformat(), "2026-08-17")
        self.assertEqual(parsed.utcoffset(), timedelta(hours=10))

    def test_parser_is_pure_and_deterministic(self):
        # Same input + same now → identical output, every call.
        a = detect_query_timestamp("what did we work on last week", now=FIXED_NOW)
        b = detect_query_timestamp("what did we work on last week", now=FIXED_NOW)
        self.assertEqual(a, b)


class _RecordingClient(HindsightClient):
    """Captures request bodies instead of putting them on a socket."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.bodies = []

    def _request(self, method, path, body=None, timeout=30):
        self.bodies.append(body)
        return {"results": []}


class WireBody(unittest.TestCase):
    """What actually goes on the recall wire — the additive-field invariant."""

    def setUp(self):
        self.client = _RecordingClient("http://hindsight.invalid")

    def test_unset_omits_the_key_entirely(self):
        self.client.recall("bank", "a query")
        # Not present-and-null — ABSENT. A pre-P2 body simply had no such key,
        # so the engine's own current-time anchor stands.
        self.assertNotIn("query_timestamp", self.client.bodies[0])

    def test_explicit_none_omits_the_key_entirely(self):
        self.client.recall("bank", "a query", query_timestamp=None)
        self.assertNotIn("query_timestamp", self.client.bodies[0])

    def test_unset_body_is_identical_to_a_pre_field_body(self):
        # The literal body a pre-P2 client would have posted.
        expected = {"query": "a query", "max_tokens": 1024, "budget": "mid"}
        self.client.recall("bank", "a query")
        self.assertEqual(self.client.bodies[0], expected)

    def test_set_reaches_the_wire_verbatim(self):
        self.client.recall("bank", "a query", query_timestamp=FIXED_ISO)
        self.assertEqual(self.client.bodies[0]["query_timestamp"], FIXED_ISO)


class _E2EClient:
    """Fake client that records the query_timestamp kwarg each bank sees."""

    def __init__(self):
        self.recall_kwargs = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        self.recall_kwargs.append(kwargs.get("query_timestamp"))
        return {"results": []}


class _StrictSignatureClient:
    """A pre-P2 client: recall() takes the exact old keyword set, with NO
    query_timestamp and NO **kwargs. Handing it the kwarg would TypeError on
    bind (before the body), so `calls` only increments on a clean pre-P2 call.
    """

    def __init__(self):
        self.calls = 0

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(
        self,
        bank_id,
        query,
        max_tokens=1024,
        budget="mid",
        types=None,
        tags=None,
        tags_match=None,
        tag_groups=None,
        prefer_observations=None,
        timeout=10,
    ):
        self.calls += 1
        return {"results": []}


class RecallLogRow(unittest.TestCase):
    """Drives recall.main() end to end with an isolated recall log."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-qts-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _log_row(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        self.assertTrue(rows, "no recall_log row was written")
        return rows[-1]

    def _run(self, prompt, client, config_extra=None, cache_hit_context=None):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": OWN,
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
        }
        if config_extra:
            config.update(config_extra)
        # Cache-hit path: a positive TTL plus a lookup that returns context
        # makes run_recall take the early cache-hit branch (no bank runs).
        cache_ttl = 300 if cache_hit_context is not None else 0
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch.object(
            recall, "_cache_ttl_secs", return_value=cache_ttl
        ), patch.object(
            recall, "_cache_lookup", return_value=cache_hit_context
        ), patch.object(recall, "_cache_store", return_value=None), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()

    def test_temporal_prompt_logs_and_sends_an_anchor(self):
        client = _E2EClient()
        self._run("what did we work on last week", client)
        row = self._log_row()
        self.assertIn("query_timestamp", row)
        self.assertIsNotNone(row["query_timestamp"], "temporal turn must log an anchor")
        # And the same anchor reached the bank on the wire.
        self.assertEqual(client.recall_kwargs, [row["query_timestamp"]])
        # It is a parseable, tz-aware ISO string (engine 400s otherwise).
        parsed = datetime.fromisoformat(row["query_timestamp"])
        self.assertIsNotNone(parsed.tzinfo)

    def test_non_temporal_prompt_logs_null_and_sends_nothing(self):
        client = _E2EClient()
        self._run("how do I restart the hindsight container", client)
        row = self._log_row()
        self.assertIn("query_timestamp", row)
        self.assertIsNone(row["query_timestamp"])
        # No anchor on the wire — byte-identical to pre-P2 behaviour.
        self.assertEqual(client.recall_kwargs, [None])

    def test_gate_off_suppresses_the_field_on_a_temporal_prompt(self):
        client = _E2EClient()
        self._run(
            "what did we work on last week",
            client,
            config_extra={"recallQueryTimestamp": False},
        )
        row = self._log_row()
        self.assertIsNone(row["query_timestamp"], "gate off must not send an anchor")
        self.assertEqual(client.recall_kwargs, [None])

    def test_narrow_client_signature_is_safe_on_a_non_temporal_turn(self):
        # Nit #3 — the conditional-passing guarantee. A client whose recall()
        # has the pre-P2 signature (no query_timestamp, no **kwargs) must NOT
        # be handed the kwarg on a non-temporal turn. If it were (unconditional
        # `=None`), binding would TypeError BEFORE the body runs, so `.calls`
        # would stay 0 and the turn would degrade. calls==1 proves recall was
        # entered cleanly with a byte-identical pre-P2 call.
        client = _StrictSignatureClient()
        self._run("how do I restart the hindsight container", client)
        row = self._log_row()
        self.assertEqual(client.calls, 1, "narrow-signature recall must run, not TypeError")
        self.assertIsNone(row["query_timestamp"])

    def test_cache_hit_row_carries_the_field(self):
        # Nit #4 — the cache-hit log site (no bank runs) must still carry
        # query_timestamp for a uniformly queryable schema and firing-rate
        # measurement. A temporal prompt on a cache hit logs the anchor.
        client = _E2EClient()
        self._run(
            "what did we work on last week",
            client,
            cache_hit_context="<hindsight_memories>cached</hindsight_memories>",
        )
        # No bank ran on the hit — the anchor was computed but never sent.
        self.assertEqual(client.recall_kwargs, [])
        row = self._log_row()
        self.assertIn("query_timestamp", row)
        self.assertIsNotNone(row["query_timestamp"], "cache-hit temporal turn must log the anchor")

    def test_cache_hit_row_logs_null_on_a_non_temporal_turn(self):
        # Nit #4 companion — cache-hit + no temporal phrase → null field, not
        # a missing key (schema uniformity).
        client = _E2EClient()
        self._run(
            "how do I restart the hindsight container",
            client,
            cache_hit_context="<hindsight_memories>cached</hindsight_memories>",
        )
        self.assertEqual(client.recall_kwargs, [])
        row = self._log_row()
        self.assertIn("query_timestamp", row)
        self.assertIsNone(row["query_timestamp"])


if __name__ == "__main__":
    unittest.main()
