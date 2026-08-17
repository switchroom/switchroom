"""Memory v2 M5 — Surface B: orientation-at-boot (pure logic).

Unit tests for lib/orientation.py — the network-free half of the orientation
SessionStart hook. These pin the DETERMINISTIC mechanism (carve-M5 §0c/§5/§8):
every branch that decides inject / prefix-as-stale / degrade-to-cold / truncate
is asserted by OUTCOME, so reverting the corresponding rule turns a test RED.

Coverage:
  T1  render stays within the 2048-token TOTAL cap, even with a stale prefix,
      and emits a VISIBLE truncation marker when content is dropped.
  T3  staleness is PER-TIER (1.5×/3× of the resolved cadence), not a fixed 36h —
      parametrized over cadence 24 AND 48 so a hardcoded threshold fails.
  Truncation is rule-aware (whole markdown sections; hard-cut only when the
      first section alone overflows) and never exceeds the budget.
  Cold notice + stale prefix are visible one-liners (never stale-as-fresh).

Stdlib-only.
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib import orientation as orient  # noqa: E402


class TestEstimateTokens(unittest.TestCase):
    def test_empty_is_zero(self):
        self.assertEqual(orient.estimate_tokens(""), 0)

    def test_ceils_chars_over_four(self):
        # 7 chars / 4 = 1.75 -> ceil 2. A floor would under-count and let the
        # budget math overflow the cap.
        self.assertEqual(orient.estimate_tokens("abcdefg"), 2)


class TestClassifyStalenessPerTier(unittest.TestCase):
    """T3 — thresholds must scale with the agent's cadence tier, not a fixed 36h."""

    NOW = datetime(2026, 8, 17, 12, 0, 0, tzinfo=timezone.utc)

    def _at(self, hours_ago):
        return (self.NOW - timedelta(hours=hours_ago)).isoformat()

    def test_fresh_stale_degraded_boundaries_cadence_24(self):
        # cadence 24: stale at 36h (1.5x), degrade at 72h (3x).
        for hours, expected in [(0, "fresh"), (35, "fresh"), (36, "stale"),
                                (71, "stale"), (72, "degraded"), (999, "degraded")]:
            state, _ = orient.classify_staleness(self._at(hours), 24, now=self.NOW)
            self.assertEqual(state, expected, f"cadence24 @ {hours}h")

    def test_fresh_stale_degraded_boundaries_cadence_48(self):
        # cadence 48: stale at 72h (1.5x), degrade at 144h (3x). A FIXED 36h
        # threshold would wrongly call 40h "stale" here — this is the R4 guard.
        for hours, expected in [(0, "fresh"), (40, "fresh"), (71, "fresh"),
                                (72, "stale"), (143, "stale"), (144, "degraded")]:
            state, _ = orient.classify_staleness(self._at(hours), 48, now=self.NOW)
            self.assertEqual(state, expected, f"cadence48 @ {hours}h")

    def test_a_48h_tier_model_at_40h_is_NOT_stale(self):
        # Direct restatement of red-team R4: the staleness guard biting a day
        # early. 40h < 1.5*48 = 72h, so it is fresh.
        state, hours_ago = orient.classify_staleness(self._at(40), 48, now=self.NOW)
        self.assertEqual(state, "fresh")
        self.assertAlmostEqual(hours_ago, 40.0, places=1)

    def test_missing_timestamp_is_unknown(self):
        state, hours_ago = orient.classify_staleness(None, 48, now=self.NOW)
        self.assertEqual(state, "unknown")
        self.assertIsNone(hours_ago)

    def test_unparseable_timestamp_is_unknown(self):
        state, hours_ago = orient.classify_staleness("not-a-date", 48, now=self.NOW)
        self.assertEqual(state, "unknown")
        self.assertIsNone(hours_ago)

    def test_trailing_Z_is_parsed(self):
        state, _ = orient.classify_staleness(
            self._at(1).replace("+00:00", "Z"), 48, now=self.NOW
        )
        self.assertEqual(state, "fresh")

    def test_future_timestamp_clock_skew_is_fresh_not_negative(self):
        future = (self.NOW + timedelta(hours=5)).isoformat()
        state, hours_ago = orient.classify_staleness(future, 48, now=self.NOW)
        self.assertEqual(state, "fresh")
        self.assertEqual(hours_ago, 0.0)


class TestTruncateToBudget(unittest.TestCase):
    def test_under_budget_is_untouched(self):
        content = "# A\nshort body"
        body, truncated = orient.truncate_to_budget(content, 1000)
        self.assertEqual(body, content)
        self.assertFalse(truncated)

    def test_empty_returns_empty_not_truncated(self):
        self.assertEqual(orient.truncate_to_budget("   ", 1000), ("", False))

    def test_drops_whole_trailing_sections(self):
        # Two ~120-token sections, budget only fits one. The kept text must be a
        # WHOLE section (starts with its header), and truncated=True.
        sec_a = "# Keep\n" + ("alpha " * 120)
        sec_b = "# Drop\n" + ("bravo " * 120)
        body, truncated = orient.truncate_to_budget(sec_a + "\n" + sec_b, 150)
        self.assertTrue(truncated)
        self.assertIn("# Keep", body)
        self.assertNotIn("# Drop", body)
        self.assertLessEqual(orient.estimate_tokens(body), 150)

    def test_first_section_overflow_hard_cuts_on_word_boundary(self):
        # A single header-less blob bigger than budget must still yield content
        # (never empty), cut at whitespace (no mid-word slice), within budget.
        blob = "wordword " * 400
        body, truncated = orient.truncate_to_budget(blob, 50)
        self.assertTrue(truncated)
        self.assertTrue(body)
        self.assertLessEqual(orient.estimate_tokens(body), 50)
        self.assertFalse(body.endswith("wordwor"))  # not sliced mid-word


class TestRenderOrientation(unittest.TestCase):
    """T1 — rendered additionalContext obeys the 2048 TOTAL cap and is visible."""

    def _big_content(self):
        # ~2,400 tokens of content — larger than the 1800 content budget AND the
        # 2048 total cap, forcing truncation.
        return "# Section\n" + ("token " * 2400)

    def test_fresh_render_within_total_cap(self):
        rendered = orient.render_orientation(self._big_content(), "fresh", 3.0)
        self.assertLessEqual(
            orient.estimate_tokens(rendered), orient.ORIENTATION_TOTAL_TOKEN_CAP
        )
        self.assertIn(orient.TRUNCATION_MARKER, rendered)
        self.assertIn('<orientation source="memory">', rendered)
        self.assertIn("</orientation>", rendered)

    def test_stale_render_includes_prefix_and_still_within_cap(self):
        rendered = orient.render_orientation(self._big_content(), "stale", 90.0)
        self.assertLessEqual(
            orient.estimate_tokens(rendered), orient.ORIENTATION_TOTAL_TOKEN_CAP
        )
        # The stale prefix must be present AND the cap still held — the prefix
        # eats into the content budget, it does not blow the ceiling.
        self.assertIn("may be stale", rendered)
        self.assertIn("90h ago", rendered)

    def test_fresh_render_has_no_stale_prefix(self):
        rendered = orient.render_orientation("# S\nsmall body", "fresh", 1.0)
        self.assertNotIn("may be stale", rendered)

    def test_small_fresh_content_not_marked_truncated(self):
        rendered = orient.render_orientation("# S\nsmall body", "fresh", 1.0)
        self.assertNotIn(orient.TRUNCATION_MARKER, rendered)
        self.assertIn("small body", rendered)


class TestNotices(unittest.TestCase):
    def test_cold_notice_is_framed_and_mentions_refresh(self):
        notice = orient.cold_notice()
        self.assertIn('<orientation source="memory">', notice)
        self.assertIn("</orientation>", notice)
        self.assertIn("refresh", notice.lower())

    def test_stale_prefix_unknown_hours(self):
        self.assertIn("unknown", orient.stale_prefix(None))


if __name__ == "__main__":
    unittest.main()
