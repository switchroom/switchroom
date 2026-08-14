"""Unit tests for Stage B token normalisation (text_normalize.py).

Every case here is a REGRESSION, not an illustration: each one was either
observed wrong in the production TTS corpus or is a contract the design
depends on. They assert the spoken OUTCOME (what the listener hears), never
merely that a code path ran — a test that would still pass with the rule
deleted is not a test.

Three properties are asserted over the whole rule set rather than case by
case, because they are what makes the module safe to extend:

  * idempotence — normalize(normalize(x)) == normalize(x)
  * no digit-glued-to-letter in the output (the shape that makes misaki
    spell garbage: "94g" → "ninety-four jee")
  * no private-use codepoint survives (the phonemizer would drop or spell it)

Run: python3 -m unittest discover -s docker/voice-sidecar -p 'test_*.py'
(needs num2words, which the sidecar image pins and CI installs).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

import text_normalize as tn
from text_normalize import SPAN_CLOSE as C
from text_normalize import SPAN_OPEN as O
from text_normalize import normalize

HERE = os.path.dirname(os.path.abspath(__file__))


class NormalizeCaseMixin:
    def assertSpoken(self, source: str, expected: str, idempotent: bool = True) -> None:  # noqa: N802
        got = normalize(source)
        self.assertEqual(got, expected, msg=f"input={source!r}")
        if idempotent:
            self.assertEqual(
                normalize(got), got, msg=f"not idempotent: input={source!r} once={got!r}"
            )


class UnitTests(NormalizeCaseMixin, unittest.TestCase):
    """The `m` split — the rule the two gateway passes contradicted."""

    def test_glued_m_is_minutes(self) -> None:
        self.assertSpoken("5m", "five minutes")
        self.assertSpoken("wait 10m", "wait ten minutes")
        self.assertSpoken("1m", "one minute")

    def test_spaced_m_is_metres(self) -> None:
        self.assertSpoken("16 m frontage", "sixteen metres frontage")
        self.assertSpoken("1 m high", "one metre high")

    def test_capital_m_is_never_a_unit(self) -> None:
        # Magnitude, not minutes — and definitely not metres.
        out = normalize("$1.6M budget")
        self.assertEqual(out, "one point six million dollars budget")
        self.assertNotIn("minute", out)
        self.assertNotIn("metre", out)
        # A spaced capital M is left entirely alone.
        self.assertSpoken("16 M spaced", "16 M spaced")

    def test_seconds_and_durations(self) -> None:
        self.assertSpoken("90s timeout", "ninety seconds timeout")
        self.assertSpoken("300s and 600s budgets", "three hundred seconds and six hundred seconds budgets")
        self.assertSpoken("0.17s", "zero point one seven seconds")
        self.assertSpoken("5 min", "five minutes")
        self.assertSpoken("250ms p99", "two hundred fifty milliseconds p99")

    def test_single_letter_units_are_lowercase_only(self) -> None:
        # "3D printer" / "5G network" must not become days/grams.
        self.assertSpoken("a 3D printer", "a 3D printer")
        self.assertSpoken("the 5G network", "the 5G network")

    def test_http_status_is_not_a_duration(self) -> None:
        out = normalize("we're seeing 404s from the API")
        self.assertIn("four oh fours", out)
        self.assertNotIn("second", out)
        self.assertNotIn("hundred", out)

    def test_decade_needs_a_cue(self) -> None:
        # A bare 90s in engineering chat is a timeout, not a decade.
        self.assertSpoken("back in the 90s", "back in the nineties")
        self.assertSpoken("1990s music", "nineteen nineties music")
        self.assertEqual(normalize("90s timeout"), "ninety seconds timeout")

    def test_no_digit_letter_shape_survives(self) -> None:
        for src in ("404s", "90s", "94g", "1990s", "3D", "5G"):
            out = normalize(f"we saw {src} here")
            self.assertFalse(
                re.search(r"\d[A-Za-z]", out) and src not in ("3D", "5G"),
                msg=f"{src!r} → {out!r} still has a digit glued to a letter",
            )


class NumberTests(NormalizeCaseMixin, unittest.TestCase):
    def test_currency_prefix_is_consumed(self) -> None:
        # "A$7.46" used to speak as "Aseven dollars forty-six" — the old rule
        # matched only the `$` and left the A welded to the spelled number.
        self.assertSpoken("A$7.46", "seven dollars forty-six")
        self.assertSpoken("US$5", "five dollars")
        self.assertSpoken("$1", "one dollar")
        self.assertSpoken("$1,234.50", "one thousand two hundred thirty-four dollars fifty")

    def test_currency_is_not_double_spoken(self) -> None:
        once = normalize("$7.46")
        self.assertEqual(once.count("dollar"), 1)
        self.assertEqual(normalize(once).count("dollar"), 1)

    def test_magnitude(self) -> None:
        self.assertSpoken("100k users", "one hundred thousand users")
        self.assertSpoken("2.5B rows", "two point five billion rows")

    def test_percent_and_ordinals(self) -> None:
        self.assertSpoken("5%", "five percent")
        self.assertSpoken("99.9% uptime", "ninety-nine point nine percent uptime")
        self.assertSpoken("the 21st", "the twenty-first")
        self.assertSpoken("the 22nd", "the twenty-second")
        # A wrong suffix is a typo; speaking it "correctly" invents a fix.
        self.assertSpoken("the 21th", "the 21th")

    def test_long_digit_runs_and_phone_numbers(self) -> None:
        self.assertSpoken("1234567 rows", "one two three four five six seven rows")
        self.assertSpoken(
            "call +61 412 345 678 now",
            "call plus six one four one two three four five six seven eight now",
        )
        # Ordinary spaced numbers are NOT a phone number.
        self.assertSpoken("300 600 900", "300 600 900")


class DateTimeTests(NormalizeCaseMixin, unittest.TestCase):
    def test_iso_date(self) -> None:
        self.assertSpoken("2026-08-14 release", "August fourteenth two thousand twenty-six release")

    def test_slash_date_needs_a_year(self) -> None:
        self.assertSpoken(
            "14/10/2005 birthday", "the fourteenth of October two thousand five birthday"
        )
        # Ambiguous D/M vs M/D — left as a slash on purpose.
        self.assertSpoken("05/08 is ambiguous", "05/08 is ambiguous")

    def test_month_abbrev_needs_an_adjacent_day(self) -> None:
        self.assertSpoken("Mar 14", "March fourteenth")
        self.assertSpoken("14 Mar", "the fourteenth of March")
        # No day number → not a date. "Mar" alone is more often a name.
        self.assertSpoken("Mar was quiet", "Mar was quiet")

    def test_clock(self) -> None:
        self.assertSpoken("meet at 14:30", "meet at fourteen thirty")
        self.assertSpoken("at 9:05am", "at nine oh five a m")
        self.assertSpoken("at 12:00", "at twelve o'clock")

    def test_ratios_are_not_clock_times(self) -> None:
        # The minute group needs two digits, so a ratio never matches — and
        # nothing invents a "to" the writer did not write.
        self.assertSpoken("the ratio is 16:1", "the ratio is 16:1")
        self.assertSpoken("3:2 odds", "3:2 odds")
        self.assertSpoken("183/183 done", "183/183 done")


class SymbolTests(NormalizeCaseMixin, unittest.TestCase):
    def test_hash_fires_regardless_of_preceding_char(self) -> None:
        self.assertSpoken("(#4661", "( hash 4661")
        self.assertSpoken("switchroom-config#4", "switchroom-config hash 4")
        self.assertSpoken("#4661", "hash 4661")

    def test_hash_range_fires_on_both_endpoints(self) -> None:
        out = normalize("#4661–#4664")
        self.assertEqual(out, "hash 4661 – hash 4664")
        self.assertEqual(out.count("hash"), 2)

    def test_at_and_ampersand_and_arrows(self) -> None:
        self.assertSpoken("ping @marko", "ping at marko")
        self.assertSpoken("cats & dogs", "cats and dogs")
        self.assertSpoken("R&D", "R and D")
        self.assertSpoken("build -> test -> ship", "build to test to ship")

    def test_slash_words_are_letters_only(self) -> None:
        self.assertSpoken("and/or", "and slash or")
        self.assertSpoken("this/that/other", "this slash that slash other")

    def test_tilde_and_multiplier_and_degrees(self) -> None:
        self.assertSpoken("~500 items", "about 500 items")
        self.assertSpoken("1920x1080", "one thousand nine hundred twenty by one thousand eighty")
        self.assertSpoken("3x faster", "three times faster")
        self.assertSpoken("21°C", "21 degrees Celsius")


class AcronymTests(NormalizeCaseMixin, unittest.TestCase):
    def test_known_acronyms_are_spelled(self) -> None:
        self.assertSpoken("open a PR", "open a P R")
        self.assertSpoken("the API is down", "the A P I is down")

    def test_unknown_all_caps_is_lowered(self) -> None:
        # misaki spells any all-caps word it does not know: MERGEABLE came
        # out "M-E-R-G-E-A-B-L-E" in the corpus.
        self.assertSpoken("it is MERGEABLE now", "it is mergeable now")

    def test_short_unknown_all_caps_is_left_alone(self) -> None:
        # CORS already phonemizes correctly as a word ("korz").
        self.assertSpoken("CORS is blocking it", "CORS is blocking it")


class IdentifierTests(NormalizeCaseMixin, unittest.TestCase):
    def test_snake_and_camel_lose_no_words(self) -> None:
        self.assertSpoken("voice_sidecar_dir", "voice sidecar dir")
        self.assertSpoken("the metadataCache", "the metadata Cache")

    def test_file_line_and_ip_and_version(self) -> None:
        self.assertSpoken("server.py:604", "server dot py, line six zero four")
        self.assertSpoken(
            "192.168.2.58", "one nine two dot one six eight dot two dot five eight"
        )
        self.assertSpoken("v0.21.9", "v zero point twenty-one point nine")

    def test_hex_hash_is_spelled(self) -> None:
        self.assertSpoken("commit 08262924abc", "commit 0 8 2 6 2 9 2 4 A B C")

    def test_url_says_the_domain(self) -> None:
        self.assertSpoken(
            "see https://github.com/switchroom/pull/4661", "see github dot com link"
        )
        self.assertSpoken("http://127.0.0.1:8126/healthz", "a link")


class VerbatimSpanTests(NormalizeCaseMixin, unittest.TestCase):
    def test_span_content_is_dispatched_not_prose_rewritten(self) -> None:
        self.assertSpoken(f"run {O}git fetch origin{C} first", "run git fetch origin first")
        self.assertSpoken(f"the {O}RECALL_MAX{C} knob", "the recall, max knob")

    def test_prose_rules_do_not_fire_inside_a_span(self) -> None:
        # "#4661" inside a span stays literal — no " hash ".
        # idempotent=False is the documented one-shot semantics of a span,
        # not a bug: the markers are consumed on the first pass (they must
        # never reach the phonemizer), so a second pass sees ordinary prose.
        # Production runs exactly one pass; see the module docstring.
        self.assertSpoken(f"see {O}#4661{C}", "see #4661", idempotent=False)
        self.assertSpoken(f"wait {O}90s{C}", "wait 90s", idempotent=False)

    def test_span_protection_is_one_shot_by_design(self) -> None:
        once = normalize(f"see {O}#4661{C}")
        self.assertEqual(once, "see #4661")
        # Second pass: no markers left, so it is ordinary prose again.
        self.assertEqual(normalize(once), "see hash 4661")

    def test_unbalanced_and_stray_and_nested_markers(self) -> None:
        self.assertSpoken(f"stray {C} closer", "stray closer")
        self.assertSpoken(f"unclosed {O} opener", "unclosed opener")
        self.assertSpoken(f"nested {O}a {O}b{C} tail", "nested a b tail")

    def test_user_typed_pua_is_dropped(self) -> None:
        self.assertSpoken(" typed pua", "typed pua")
        self.assertSpoken(" tail", "tail")

    def test_standalone_marker_is_stripped(self) -> None:
        # The cross-version degradation case: an old gateway emitting a
        # space-separated marker. It must not reach misaki (which phonemizes
        # a standalone U+E001 as a quote character).
        out = normalize(f"a {C} b")
        self.assertNotIn(O, out)
        self.assertNotIn(C, out)

    def test_no_pua_ever_survives(self) -> None:
        for src in (f"x{O}y", f"x{C}y", f"{O}{O}z{C}", "", ""):
            out = normalize(src)
            self.assertFalse(
                any(0xE000 <= ord(ch) <= 0xF8FF for ch in out),
                msg=f"{src!r} → {out!r} leaked a private-use codepoint",
            )


class MarkdownBeltTests(NormalizeCaseMixin, unittest.TestCase):
    """Stage A owns markdown, but /tts is a public boundary — a caller that
    never went through the gateway must not hear "asterisk asterisk"."""

    def test_emphasis_headings_and_lists(self) -> None:
        self.assertSpoken("**bold** and *italic*", "bold and italic")
        self.assertSpoken("# Heading", "Heading")
        self.assertSpoken("- item one", "item one")

    def test_no_markdown_metacharacter_survives(self) -> None:
        out = normalize("| a | b |\n|---|---|\n`code` ~~gone~~ __u__")
        for ch in "`*|~_":
            self.assertNotIn(ch, out)


class KillSwitchTests(unittest.TestCase):
    def test_disabled_is_byte_identical(self) -> None:
        src = "90s timeout #4661 $1.6M"
        os.environ["VOICE_TTS_NORMALIZE"] = "0"
        try:
            self.assertEqual(normalize(src), src)
            self.assertFalse(tn.normalize_enabled())
        finally:
            del os.environ["VOICE_TTS_NORMALIZE"]
        self.assertTrue(tn.normalize_enabled())
        self.assertNotEqual(normalize(src), src)

    def test_empty_and_whitespace_input(self) -> None:
        for src in ("", "   ", "\n\n"):
            self.assertEqual(normalize(src), src)


class OverrideTableTests(unittest.TestCase):
    def test_shipped_table_loads_clean(self) -> None:
        accepted, rejected = tn.load_overrides()
        self.assertEqual(rejected, [], msg="overrides.json has invalid entries")
        self.assertGreaterEqual(len(accepted), 1)

    def test_vocab_guard_rejects_out_of_vocab_phonemes(self) -> None:
        # The failure this guard exists for: kokoro-onnx's tokenizer drops an
        # unknown symbol SILENTLY, so the word disappears from the audio.
        path = os.path.join(HERE, "tests", "_tmp_overrides.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        doc = {
            "version": 1,
            "entries": [
                {"match": "Good", "phonemes": "ɡˈʊd"},
                {"match": "Bad", "phonemes": "ɡ☃d"},
                {"match": "NoPhonemes", "phonemes": ""},
                {"match": "BadCondition", "phonemes": "ɡˈʊd", "condition": "nope"},
                {"match": "Good", "phonemes": "ɡˈʊd"},
            ],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        try:
            accepted, rejected = tn.load_overrides(path, vocab=set("ɡˈʊd"))
            self.assertEqual([e.match for e in accepted], ["Good"])
            reasons = dict(rejected)
            self.assertIn("Bad", reasons)
            self.assertIn("out-of-vocab", reasons["Bad"])
            self.assertIn("NoPhonemes", reasons)
            self.assertIn("BadCondition", reasons)
            self.assertIn("unknown condition", reasons["BadCondition"])
            self.assertEqual(
                sum(1 for m, _ in rejected if m == "Good"), 1, "duplicate not rejected"
            )
        finally:
            os.unlink(path)

    def test_missing_and_malformed_table_degrade(self) -> None:
        accepted, rejected = tn.load_overrides("/nonexistent/overrides.json")
        self.assertEqual((accepted, rejected), ([], []))
        path = os.path.join(HERE, "tests", "_tmp_bad.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        try:
            accepted, rejected = tn.load_overrides(path)
            self.assertEqual(accepted, [])
            self.assertEqual(len(rejected), 1)
        finally:
            os.unlink(path)

    def test_apply_is_idempotent_and_markup_shaped(self) -> None:
        entries = [tn.Override("Postgres", "pˈOstɡɹɛs", True, None)]
        once = tn.apply_overrides("the postgres box", entries)
        self.assertEqual(once, "the [postgres](/pˈOstɡɹɛs/) box")
        self.assertEqual(tn.apply_overrides(once, entries), once)

    def test_condition_registry_is_data_not_code(self) -> None:
        # An entry may only name a REGISTERED predicate; overrides.json can
        # never introduce executable behaviour.
        self.assertEqual(tn._CONDITIONS, {})


class CorpusReplayRegressionTests(NormalizeCaseMixin, unittest.TestCase):
    """Every case here was found by replaying the production corpus.

    tools/replay_corpus.py runs the module over a captured corpus (kept out
    of the repo — it is real message text) and gates on the two contracts.
    Its first run over 1,679 messages found eight distinct defects that no
    hand-written case had: a crash, six idempotence breaches and a created
    digit-glued-to-letter token. Each is pinned below with the shape that
    produced it.
    """

    def test_four_digit_non_decade_before_s_does_not_crash(self) -> None:
        # "Subdivision Act 1988 s.35" — the decade branch accepted any 19xx
        # and then KeyError'd on '88'. A statute reference is also not a
        # measurement, so the citation guard leaves the whole thing alone.
        self.assertSpoken("Subdivision Act 1988 s.35", "Subdivision Act 1988 s.35")
        self.assertSpoken("under s.35(3)(c)", "under s.35(3)(c)")

    def test_decades_still_speak(self) -> None:
        self.assertSpoken("the 1990s", "the nineteen nineties")
        self.assertSpoken("back in the 2000s", "back in the two thousands")

    def test_hex_hash_is_not_eaten_by_the_unit_rule(self) -> None:
        # "1b8d00b" (a git short sha) contains "8d" — which used to become
        # "eight days", giving "1beight days00b".
        self.assertSpoken("commit 1b8d00b landed", "commit 1 B 8 D 0 0 B landed")
        self.assertSpoken("sha 2d8147d8f", "sha 2 D 8 1 4 7 D 8 F")

    def test_iso_timestamp_speaks_as_one_thing(self) -> None:
        # The date rule and the clock rule each matched half of this and left
        # the `T` welded between two words ("08Ttwelve thirty-nine").
        self.assertSpoken(
            "2026-08-08T12:39:00Z",
            "August eighth two thousand twenty-six at twelve thirty-nine U T C",
        )
        self.assertSpoken(
            "at 2026-08-08 09:05",
            "at August eighth two thousand twenty-six at nine oh five",
        )

    def test_identifier_exposed_by_expansion_is_resolved_in_one_pass(self) -> None:
        # Splitting the snake token used to expose a bare hash / a bare
        # file:line that only a SECOND pass would have spoken.
        self.assertSpoken("wf_2f0e6072-af3", "wf 2 F 0 E 6 0 7 2-af3")
        self.assertSpoken(
            "tui_gateway/methods_session.py:14",
            "tui gateway slash methods session dot py, line one four",
        )

    def test_slash_after_an_expanded_identifier_is_spoken(self) -> None:
        self.assertSpoken(
            "max_entries_to_build/merge", "max entries to build slash merge"
        )

    def test_edge_markers_do_not_hide_an_identifier(self) -> None:
        # A trailing `_`/`*` broke the pattern's word boundary on pass 1 and
        # was then swept away, exposing the token on pass 2.
        self.assertSpoken("HINDSIGHT_API_EMBEDDINGS_* keys", "hindsight A P I embeddings keys")
        self.assertSpoken("grep ^VOICE_ env", "grep ^voice env")
        self.assertSpoken("_resetForTests() leaks", "reset For Tests() leaks")

    def test_a_range_shares_its_unit(self) -> None:
        # "4-5 min" used to come out half-spoken as "4-five minutes".
        self.assertSpoken("4-5 min", "four to five minutes")
        self.assertSpoken("takes 10-15 min", "takes ten to fifteen minutes")

    def test_short_numbers_inside_an_identifier_are_counts(self) -> None:
        self.assertSpoken("Snapshot_10", "Snapshot ten")
        self.assertSpoken("run_2", "run two")


class PropertyTests(unittest.TestCase):
    """Properties over a broad input set, not one case at a time."""

    SAMPLES = [
        "Deployed 3 fixes in 90s; $1.6M ARR; see #4661 and server.py:604.",
        "Meeting at 14:30 on 2026-08-14 — bring the 16 m tape and 5m of cable.",
        "**bold** `code` | table | ~~strike~~ https://example.com/x?y=1#z",
        "MERGEABLE, CORS, YAML, PR, API, and a 404s spike from the gateway.",
        f"Run {O}git rebase --onto origin/main{C} then {O}RECALL_MAX=8{C}.",
        "A$7.46 + US$5 = 12.46 dollars, approx. 5% of 100k.",
        "call +61 412 345 678 or ping @marko re: and/or the v0.21.9 tag",
        " weird  pua  everywhere ",
        "the 90s, the 1990s, 90s timeout, '90s music",
        "voice_sidecar_dir / metadataCache / 08262924abc / 192.168.2.58:4010",
    ] + json.load(
        # The shipped replay fixture: synthetic messages in the SHAPES the
        # production corpus has (the corpus itself is real chat text and stays
        # out of the repo — point tools/replay_corpus.py at a capture for the
        # full run). Properties hold over both sets.
        open(os.path.join(HERE, "replay-fixture.json"), encoding="utf-8")
    )

    def test_idempotent(self) -> None:
        # Span-bearing samples are excluded: a verbatim span is consumed on
        # the first pass by design (see the module docstring and
        # VerbatimSpanTests.test_span_protection_is_one_shot_by_design).
        for src in self.SAMPLES:
            if O in src or C in src:
                continue
            once = normalize(src)
            self.assertEqual(normalize(once), once, msg=f"input={src!r}")

    def test_no_digit_glued_to_letter(self) -> None:
        for src in self.SAMPLES:
            out = normalize(src)
            self.assertIsNone(
                re.search(r"\d[A-Za-z]", out),
                msg=f"input={src!r} → {out!r} has a digit glued to a letter",
            )

    def test_no_private_use_codepoints(self) -> None:
        for src in self.SAMPLES:
            out = normalize(src)
            self.assertFalse(any(0xE000 <= ord(c) <= 0xF8FF for c in out), msg=repr(out))

    def test_no_null_or_placeholder_leak(self) -> None:
        for src in self.SAMPLES:
            self.assertNotIn("\x00", normalize(src))


class PerformanceTests(unittest.TestCase):
    def test_worst_case_message_is_well_under_budget(self) -> None:
        # The budget is p99 < 50ms for the worst realistic message; a
        # catastrophic-backtracking regression in any rule blows straight
        # through it rather than hiding behind a slow test.
        worst = (
            "Deployed #4661 at 14:30 on 2026-08-14: 90s timeout, $1.6M spend, "
            "16 m cable, voice_sidecar_dir, server.py:604, 192.168.2.58:4010, "
            "https://github.com/x/y, MERGEABLE, A$7.46, +61 412 345 678. "
        ) * 12
        timings = []
        for _ in range(30):
            started = time.perf_counter()
            normalize(worst)
            timings.append((time.perf_counter() - started) * 1000.0)
        timings.sort()
        p99 = timings[int(len(timings) * 0.99) - 1]
        self.assertLess(p99, 50.0, msg=f"p99={p99:.1f}ms over {len(worst)} chars")


if __name__ == "__main__":
    unittest.main()
