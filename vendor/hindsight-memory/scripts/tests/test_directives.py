"""Tests for lib/directives.py (active-directives fetch + format).

Stdlib-only (unittest) — matches the rest of the hindsight-memory scripts,
which deliberately avoid third-party dependencies so the hooks run on a
bare Python install.

Run from the repo root:
    python -m unittest discover -s vendor/hindsight-memory/scripts/tests -v
"""

import os
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import patch

# Ensure the scripts dir is importable so `lib.*` resolves.
SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.directives import (  # noqa: E402
    DIRECTIVES_CACHE_TTL_SECONDS,
    MAX_DIRECTIVES,
    _cache_name,
    count_omitted_directives,
    fetch_active_directives,
    fetch_active_directives_cached,
    format_active_directives_block,
    injected_directive_ids,
    invalidate_directives_cache,
    parse_active_directives_block,
    rule_already_captured,
)
from lib.state import read_state, write_state  # noqa: E402


class _StubClient:
    """Minimal HindsightClient stand-in for tests.

    Captures the args list_directives was called with and returns either
    a canned response or raises a configured exception.
    """

    def __init__(self, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.calls = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        self.calls.append({"bank_id": bank_id, "active_only": active_only, "timeout": timeout})
        if self._exc is not None:
            raise self._exc
        return self._response


def _directive(name, content, priority=5, tags=None):
    """Build a synthetic directive dict matching the API shape."""
    return {
        "id": f"id-{name}",
        "bank_id": "test-bank",
        "name": name,
        "content": content,
        "priority": priority,
        "is_active": True,
        "tags": tags or [],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


class FetchActiveDirectivesTests(unittest.TestCase):
    def test_returns_priority_sorted_descending(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("low", "low content", priority=1),
                    _directive("high", "high content", priority=10),
                    _directive("mid", "mid content", priority=5),
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual([d["name"] for d in result], ["high", "mid", "low"])

    def test_passes_active_only_true(self):
        client = _StubClient(response={"items": []})
        fetch_active_directives(client, "test-bank")
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(client.calls[0]["active_only"])
        self.assertEqual(client.calls[0]["bank_id"], "test-bank")

    def test_empty_items_returns_empty_list(self):
        client = _StubClient(response={"items": []})
        self.assertEqual(fetch_active_directives(client, "test-bank"), [])

    def test_http_failure_returns_empty_and_warns(self):
        client = _StubClient(exc=RuntimeError("HTTP 503 from /directives"))
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        err_output = fake_err.getvalue()
        self.assertIn("list_directives failed", err_output)
        self.assertIn("test-bank", err_output)

    def test_timeout_exception_returns_empty_no_raise(self):
        client = _StubClient(exc=TimeoutError("timed out"))
        with patch("sys.stderr", new=StringIO()):
            # Must not raise.
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])

    def test_non_dict_response_returns_empty_and_warns(self):
        client = _StubClient(response=["not", "a", "dict"])
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        self.assertIn("non-dict", fake_err.getvalue())

    def test_missing_items_key_returns_empty_quietly(self):
        # Banks-with-no-directives is a normal state, not a warn-worthy event.
        client = _StubClient(response={"unrelated": "shape"})
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        self.assertEqual(fake_err.getvalue(), "")

    def test_malformed_directive_entries_filtered(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("ok", "real content", priority=5),
                    "not-a-dict",
                    None,
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "ok")

    def test_missing_priority_treated_as_zero(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("has-priority", "content", priority=3),
                    {"name": "no-priority", "content": "content"},
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual([d["name"] for d in result], ["has-priority", "no-priority"])

    def test_uses_short_timeout(self):
        # The recall hook is on the UserPromptSubmit critical path —
        # directive fetch must not block it.
        client = _StubClient(response={"items": []})
        fetch_active_directives(client, "test-bank")
        self.assertLessEqual(client.calls[0]["timeout"], 5)


class FormatActiveDirectivesBlockTests(unittest.TestCase):
    def test_returns_none_for_empty_list(self):
        self.assertIsNone(format_active_directives_block([]))

    def test_formats_multiple_directives(self):
        directives = [
            _directive("trailer", "End every response with: [VERIFIED]", priority=10),
            _directive("greeting", "Open with the user's first name.", priority=8),
        ]
        out = format_active_directives_block(directives)
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("<active_directives>"))
        self.assertTrue(out.endswith("</active_directives>"))
        self.assertIn("HARD RULES", out)
        self.assertIn("1. [P10] trailer: End every response with: [VERIFIED]", out)
        self.assertIn("2. [P8] greeting: Open with the user's first name.", out)

    def test_content_is_verbatim(self):
        directives = [_directive("verbatim", "Line one.\nLine two.\nLine three.", priority=5)]
        out = format_active_directives_block(directives)
        self.assertIn("Line one.\nLine two.\nLine three.", out)

    def test_truncates_at_cap_with_footer(self):
        # MAX_DIRECTIVES + 5 synthetic directives — should truncate to
        # MAX_DIRECTIVES with a "(+N more, omitted)" footer.
        total = MAX_DIRECTIVES + 5
        directives = [
            _directive(f"d{i}", f"content {i}", priority=total - i) for i in range(total)
        ]
        out = format_active_directives_block(directives)
        self.assertIn(f"1. [P{total}] d0", out)
        self.assertIn(f"{MAX_DIRECTIVES}. [P", out)
        # The first item past the cap must NOT appear.
        self.assertNotIn(f"{MAX_DIRECTIVES + 1}. [P", out)
        # Footer with the right omitted count.
        self.assertIn("(+5 more, omitted)", out)

    def test_cap_is_30_and_clears_the_observed_fleet_maximum(self):
        """The cap must clear the busiest real bank (24 active directives).

        Regression: at MAX_DIRECTIVES=15 a 24-directive bank had 9 of its
        rules dropped from every turn's prompt. This asserts the OUTCOME —
        all 24 directives are rendered, and no truncation footer/warning is
        produced — not merely that the constant changed.
        """
        self.assertEqual(MAX_DIRECTIVES, 30)
        directives = [
            _directive(f"d{i}", f"content {i}", priority=24 - i) for i in range(24)
        ]
        with patch("sys.stderr", new=StringIO()) as fake_err:
            out = format_active_directives_block(directives)
        for i in range(24):
            self.assertIn(f"d{i}: content {i}", out)
        self.assertIn("24. [P", out)
        self.assertNotIn("more, omitted", out)
        self.assertEqual(fake_err.getvalue(), "")

    def test_truncation_emits_a_stderr_breadcrumb_naming_the_dropped_count(self):
        """Truncation writes a `[Hindsight]` line to stderr naming total, cap
        and dropped count, alongside the in-prompt "(+N more, omitted)" footer.

        Scope note (2026-07-25 review finding 2): this asserts ONLY that the
        line is written to stderr. It does NOT — and cannot — show that an
        operator ever sees it; hook stderr is swallowed by Claude Code on a
        zero exit (zero `[Hindsight]` lines across all 12 live containers).
        The operator-visible signals are the `directives_omitted` recall_log
        field and `switchroom doctor`'s directive-count row, tested elsewhere.
        """
        total = MAX_DIRECTIVES + 4
        directives = [
            _directive(f"d{i}", f"c{i}", priority=total - i) for i in range(total)
        ]
        with patch("sys.stderr", new=StringIO()) as fake_err:
            out = format_active_directives_block(directives)
        err = fake_err.getvalue()
        self.assertNotEqual(err, "", "truncation must write a stderr breadcrumb")
        self.assertIn("[Hindsight]", err)
        self.assertIn(str(total), err)
        self.assertIn(f"MAX_DIRECTIVES={MAX_DIRECTIVES}", err)
        self.assertIn("4", err)  # the dropped count
        # The in-prompt footer is still emitted (agent-facing signal).
        self.assertIn("(+4 more, omitted)", out)

    def test_overflow_footer_is_loud_and_operator_directed(self):
        """memory-RFC P7 — the in-prompt overflow notice must be LOUD and tell
        the agent to surface the drop to the operator this turn.

        The pre-P7 block emitted only the quiet `(+N more, omitted)`
        parenthetical, which reaches the agent but neither states that explicit
        instructions were dropped nor directs the agent to relay it. This
        asserts the OUTCOME of the loud in-turn channel: the rendered block, on
        overflow, names the dropped count, the total, the cap, states the loss
        in unmistakable terms, and instructs the agent to tell the operator.
        A test that only checked `(+N more, omitted)` would still pass on the
        pre-P7 code, so it would not guard this change; these assertions fail
        without it.
        """
        total = MAX_DIRECTIVES + 3
        directives = [
            _directive(f"d{i}", f"c{i}", priority=total - i) for i in range(total)
        ]
        with patch("sys.stderr", new=StringIO()):
            out = format_active_directives_block(directives)
        # A loud, explicitly-labelled overflow banner (not a lone parenthetical).
        self.assertIn("DIRECTIVE OVERFLOW", out)
        # Names the loss in unmistakable terms, with count/total/cap.
        self.assertIn("DROPPED", out)
        self.assertIn("3 of", out)  # omitted of total
        self.assertIn(str(total), out)
        self.assertIn(f"MAX_DIRECTIVES={MAX_DIRECTIVES}", out)
        # Directs the agent to surface it to the OPERATOR this turn — the
        # in-turn operator-visible channel P7 adds.
        self.assertIn("operator", out.lower())
        self.assertIn("ACTION", out)
        # The literal marker is retained for the recall_log/doctor cross-checks
        # and the dedup parser.
        self.assertIn("(+3 more, omitted)", out)

    def test_no_overflow_banner_when_under_cap(self):
        """The loud banner must appear ONLY on overflow — an under-cap block is
        unchanged and carries neither the banner nor the action directive."""
        directives = [_directive(f"d{i}", f"c{i}", priority=5 - i) for i in range(3)]
        with patch("sys.stderr", new=StringIO()) as fake_err:
            out = format_active_directives_block(directives)
        self.assertNotIn("DIRECTIVE OVERFLOW", out)
        self.assertNotIn("ACTION", out)
        self.assertNotIn("more, omitted", out)
        self.assertEqual(fake_err.getvalue(), "")

    def test_max_directives_is_unchanged_by_p7(self):
        """P7 is the loud-channel PR only. Raising MAX_DIRECTIVES is a separate,
        later change (RFC §5 P7: order is non-negotiable). Pin the constant so a
        cap bump cannot ride in on this change unnoticed."""
        self.assertEqual(MAX_DIRECTIVES, 30)

    def test_count_omitted_directives_matches_the_rendered_footer(self):
        """The recall_log's `directives_omitted` number must equal what the
        block actually dropped — it is the operator-visible record of it."""
        total = MAX_DIRECTIVES + 4
        directives = [
            _directive(f"d{i}", f"c{i}", priority=total - i) for i in range(total)
        ]
        with patch("sys.stderr", new=StringIO()):
            out = format_active_directives_block(directives)
        self.assertEqual(count_omitted_directives(directives), 4)
        self.assertIn("(+4 more, omitted)", out)
        # Under cap → nothing omitted, and no footer to disagree with.
        under = directives[:2]
        self.assertEqual(count_omitted_directives(under), 0)
        self.assertNotIn("more, omitted", format_active_directives_block(under))
        # Honours a custom cap the same way the formatter does.
        self.assertEqual(count_omitted_directives(directives, max_directives=5), total - 5)

    def test_injected_directive_ids_matches_the_rendered_block(self):
        """Memory-redesign step 1 (E-45 recommendation (b)): the id list
        `recall.py` puts on the recall_log row must name exactly the
        directives `format_active_directives_block` actually rendered —
        not the full fetched set, and in the same priority order."""
        total = MAX_DIRECTIVES + 4
        directives = [
            _directive(f"d{i}", f"c{i}", priority=total - i) for i in range(total)
        ]
        with patch("sys.stderr", new=StringIO()):
            out = format_active_directives_block(directives)
        ids = injected_directive_ids(directives)
        self.assertEqual(len(ids), MAX_DIRECTIVES)
        # Real, concrete values — the head-slice in priority order, not a
        # placeholder or a count.
        self.assertEqual(ids, [f"id-d{i}" for i in range(MAX_DIRECTIVES)])
        # Every injected id is actually present in the rendered block...
        for i in range(MAX_DIRECTIVES):
            self.assertIn(f"d{i}: c{i}", out)
        # ...and the omitted tail's ids are excluded.
        for i in range(MAX_DIRECTIVES, total):
            self.assertNotIn(f"id-d{i}", ids)
            self.assertNotIn(f"d{i}: c{i}", out)

    def test_injected_directive_ids_under_cap_returns_all(self):
        directives = [_directive(f"d{i}", f"c{i}", priority=5 - i) for i in range(3)]
        self.assertEqual(injected_directive_ids(directives), ["id-d0", "id-d1", "id-d2"])

    def test_injected_directive_ids_empty_list(self):
        self.assertEqual(injected_directive_ids([]), [])

    def test_injected_directive_ids_skips_malformed_entries(self):
        directives = [
            _directive("good", "content", priority=9),
            {"priority": 5},  # no id — must not crash or contribute a None
            "not-a-dict",
        ]
        self.assertEqual(injected_directive_ids(directives), ["id-good"])

    def test_injected_directive_ids_honours_custom_cap(self):
        directives = [_directive(f"d{i}", f"c{i}", priority=10 - i) for i in range(5)]
        self.assertEqual(
            injected_directive_ids(directives, max_directives=2), ["id-d0", "id-d1"]
        )

    def test_no_warning_when_nothing_is_truncated(self):
        directives = [_directive("only", "single", priority=5)]
        with patch("sys.stderr", new=StringIO()) as fake_err:
            format_active_directives_block(directives)
        self.assertEqual(fake_err.getvalue(), "")

    def test_no_footer_when_under_cap(self):
        directives = [_directive("only", "single", priority=5)]
        out = format_active_directives_block(directives)
        self.assertNotIn("more, omitted", out)

    def test_handles_missing_name_and_content(self):
        directives = [{"priority": 7}]
        out = format_active_directives_block(directives)
        self.assertIn("[P7] (unnamed):", out)

    def test_custom_cap_respected(self):
        directives = [_directive(f"d{i}", f"c{i}", priority=10) for i in range(5)]
        with patch("sys.stderr", new=StringIO()):
            out = format_active_directives_block(directives, max_directives=2)
        self.assertIn("1. [P10] d0", out)
        self.assertIn("2. [P10] d1", out)
        self.assertNotIn("3. [P10] d2", out)
        self.assertIn("(+3 more, omitted)", out)


class TestDirectiveDedup(unittest.TestCase):
    """#2903 Fix 6.2 — parse a rendered <active_directives> block back to
    content strings, and detect whether a restated rule is already covered."""

    def _block(self, *contents):
        directives = [
            {"name": f"d{i}", "content": c, "priority": 10 - i}
            for i, c in enumerate(contents)
        ]
        return format_active_directives_block(directives)

    def test_roundtrip_parse(self):
        block = self._block(
            "Always use British spelling in replies.",
            "Show all times in UTC.",
        )
        parsed = parse_active_directives_block(block)
        self.assertEqual(
            parsed,
            ["Always use British spelling in replies.", "Show all times in UTC."],
        )

    def test_parse_absent_block_is_empty(self):
        self.assertEqual(parse_active_directives_block("no block here"), [])
        self.assertEqual(parse_active_directives_block(None), [])

    def test_captured_when_restated_rule_overlaps_existing(self):
        contents = parse_active_directives_block(
            self._block("Always use British spelling in all replies.")
        )
        self.assertTrue(
            rule_already_captured("From now on, always use British spelling please.", contents)
        )

    def test_not_captured_for_unrelated_rule(self):
        contents = parse_active_directives_block(self._block("Always show times in UTC."))
        self.assertFalse(
            rule_already_captured("From now on, always use British spelling.", contents)
        )

    def test_not_captured_against_empty_directives(self):
        self.assertFalse(rule_already_captured("Always use British spelling.", []))

    def test_empty_rule_is_not_captured(self):
        self.assertFalse(rule_already_captured("", ["Always use British spelling."]))

    # --- #2912: length-aware guard for terse rules -----------------------

    def test_terse_new_rule_not_swallowed_by_long_directive(self):
        # A genuinely-new terse rule whose few significant tokens all appear
        # inside a much longer, unrelated directive must NOT be deduped — the
        # verifier should still re-prompt. Rule tokens {tabs, indentation} are
        # both present in the long directive, so forward coverage is 1.0, but
        # they are incidental overlap inside a broader rule.
        contents = parse_active_directives_block(
            self._block(
                "Always use spaces not tabs for indentation and trim "
                "trailing whitespace on every saved source file."
            )
        )
        self.assertFalse(rule_already_captured("Use tabs for indentation.", contents))

    def test_terse_rule_restating_equally_terse_directive_is_captured(self):
        # Two comparably terse rules about the same thing → real duplicate.
        contents = parse_active_directives_block(self._block("Use British spelling."))
        self.assertTrue(rule_already_captured("Always use British spelling.", contents))

    def test_long_rule_boundary_unchanged_at_0_6(self):
        # Long rules (>= _SHORT_RULE_TOKEN_LIMIT significant tokens) keep the
        # plain forward-coverage 0.6 behavior — the guard does not engage.
        directive = "capital python numeric boolean spelling timezone"
        # Rule shares 3 of its 5 significant tokens (0.6 exactly) → captured.
        self.assertTrue(
            rule_already_captured(
                "capital python numeric quarterly monthly", [directive]
            )
        )
        # Rule shares 2 of 5 (0.4 < 0.6) → not captured.
        self.assertFalse(
            rule_already_captured(
                "capital python quarterly monthly weekly", [directive]
            )
        )


class _CountingClient:
    """List-directives stub that can vary its behaviour per call.

    ``responses`` / ``excs`` are per-call sequences (last value repeats). Counts
    total calls so a test can assert cache hits saved the HTTP round-trip.
    """

    def __init__(self, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.calls = 0

    def list_directives(self, bank_id, active_only=True, timeout=2):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._response


class DirectivesCacheTests(unittest.TestCase):
    """A4 — directives-list cache: hit/miss, TTL expiry, invalidation on write,
    corrupted-cache fallback. State is isolated to a temp CLAUDE_PLUGIN_DATA."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"CLAUDE_PLUGIN_DATA": self._tmp.name})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _resp(self, *names):
        return {"items": [_directive(n, f"content {n}", priority=5) for n in names]}

    def test_cache_hit_skips_second_http_call(self):
        # Acceptance (a): two consecutive recalls with no write → exactly one
        # list_directives call; both return the same content.
        client = _CountingClient(response=self._resp("alpha"))
        first = fetch_active_directives_cached(client, "bank1", now=1000.0)
        second = fetch_active_directives_cached(client, "bank1", now=1000.5)
        self.assertEqual(client.calls, 1)
        self.assertEqual([d["name"] for d in first], ["alpha"])
        self.assertEqual([d["name"] for d in second], ["alpha"])

    def test_cache_miss_when_no_prior_entry(self):
        client = _CountingClient(response=self._resp("alpha"))
        result = fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)
        self.assertEqual([d["name"] for d in result], ["alpha"])
        # Cache file was written.
        cached = read_state(_cache_name("bank1"), None)
        self.assertIsInstance(cached, dict)
        self.assertEqual(cached["ts"], 1000.0)

    def test_ttl_expiry_refetches(self):
        client = _CountingClient(response=self._resp("alpha"))
        fetch_active_directives_cached(client, "bank1", ttl_seconds=120, now=1000.0)
        # Just inside TTL → hit.
        fetch_active_directives_cached(client, "bank1", ttl_seconds=120, now=1000.0 + 119)
        self.assertEqual(client.calls, 1)
        # Just past TTL → miss → refetch.
        fetch_active_directives_cached(client, "bank1", ttl_seconds=120, now=1000.0 + 121)
        self.assertEqual(client.calls, 2)

    def test_ttl_zero_disables_cache(self):
        # Rollback lever: TTL=0 → live fetch every time, nothing written.
        client = _CountingClient(response=self._resp("alpha"))
        fetch_active_directives_cached(client, "bank1", ttl_seconds=0, now=1000.0)
        fetch_active_directives_cached(client, "bank1", ttl_seconds=0, now=1000.1)
        self.assertEqual(client.calls, 2)
        self.assertIsNone(read_state(_cache_name("bank1"), None))

    def test_invalidation_forces_refetch(self):
        # Acceptance (a) in-session: a directive write invalidates the cache, so
        # the next recall re-fetches (fresh directive becomes visible).
        client = _CountingClient(response=self._resp("alpha"))
        fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)
        invalidate_directives_cache()  # bank-agnostic sweep (Stop-hook path)
        fetch_active_directives_cached(client, "bank1", now=1000.1)
        self.assertEqual(client.calls, 2)

    def test_invalidation_specific_bank_only(self):
        client = _CountingClient(response=self._resp("alpha"))
        fetch_active_directives_cached(client, "bankA", now=1000.0)
        fetch_active_directives_cached(client, "bankB", now=1000.0)
        self.assertEqual(client.calls, 2)
        invalidate_directives_cache("bankA")
        # bankA re-fetches, bankB still served from cache.
        fetch_active_directives_cached(client, "bankA", now=1000.1)
        self.assertEqual(client.calls, 3)
        fetch_active_directives_cached(client, "bankB", now=1000.1)
        self.assertEqual(client.calls, 3)

    def test_corrupted_cache_falls_back_to_live(self):
        # A non-JSON cache file → read_state returns default → live fetch.
        from lib.state import _state_file  # noqa: PLC0415

        path = _state_file(_cache_name("bank1"))
        with open(path, "w") as f:
            f.write("{ this is not valid json ]")
        client = _CountingClient(response=self._resp("alpha"))
        result = fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)
        self.assertEqual([d["name"] for d in result], ["alpha"])

    def test_wrong_shape_cache_falls_back_to_live(self):
        # Valid JSON but missing the ts/directives envelope → treated as a miss.
        write_state(_cache_name("bank1"), {"directives": [{"name": "stale"}]})
        client = _CountingClient(response=self._resp("fresh"))
        result = fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)
        self.assertEqual([d["name"] for d in result], ["fresh"])

    def test_bool_timestamp_rejected_as_corrupt(self):
        # bool is an int subclass — guard must not accept True as a timestamp.
        write_state(_cache_name("bank1"), {"ts": True, "directives": []})
        client = _CountingClient(response=self._resp("fresh"))
        fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)

    def test_failed_fetch_not_cached(self):
        # A transient fetch FAILURE must not poison the cache with [] — the next
        # call must retry live rather than serving a cached empty list.
        failing = _CountingClient(exc=RuntimeError("HTTP 503"))
        with patch("sys.stderr", new=StringIO()):
            first = fetch_active_directives_cached(failing, "bank1", now=1000.0)
        self.assertEqual(first, [])
        self.assertIsNone(read_state(_cache_name("bank1"), None))
        # A subsequent successful fetch is served live and then cached.
        ok = _CountingClient(response=self._resp("alpha"))
        result = fetch_active_directives_cached(ok, "bank1", now=1000.1)
        self.assertEqual(ok.calls, 1)
        self.assertEqual([d["name"] for d in result], ["alpha"])

    def test_empty_bank_is_cached(self):
        # A genuinely empty bank (items: []) is a successful fetch → cacheable,
        # so a directive-free agent also saves the round-trip.
        client = _CountingClient(response={"items": []})
        fetch_active_directives_cached(client, "bank1", now=1000.0)
        fetch_active_directives_cached(client, "bank1", now=1000.1)
        self.assertEqual(client.calls, 1)

    def test_bank_id_mismatch_falls_back_to_live(self):
        # _safe_filename can collapse two bank ids onto one cache file; an
        # envelope whose embedded bank_id != the requested one must be rejected
        # (a live fetch) rather than serving another bank's directives.
        write_state(
            _cache_name("bank1"),
            {"ts": 1000.0, "bank_id": "a-DIFFERENT-bank", "directives": [{"name": "leaked"}]},
        )
        client = _CountingClient(response=self._resp("mine"))
        result = fetch_active_directives_cached(client, "bank1", now=1000.0)
        self.assertEqual(client.calls, 1)
        self.assertEqual([d["name"] for d in result], ["mine"])

    def test_future_timestamp_treated_as_expired(self):
        # A stored ts in the future (wall-clock step-back) → negative age → NOT
        # served as fresh; the cache re-fetches instead of pinning stale.
        client = _CountingClient(response=self._resp("alpha"))
        fetch_active_directives_cached(client, "bank1", ttl_seconds=120, now=5000.0)
        self.assertEqual(client.calls, 1)
        # Clock steps back well before the cached ts → age is negative.
        fetch_active_directives_cached(client, "bank1", ttl_seconds=120, now=1000.0)
        self.assertEqual(client.calls, 2)

    def test_default_ttl_constant(self):
        self.assertEqual(DIRECTIVES_CACHE_TTL_SECONDS, 120)


if __name__ == "__main__":
    unittest.main()
