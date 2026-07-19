"""Switchroom hindsight-leverage E2 / PR9 (#398) — lesson/anti-pattern tagging
at retain time + recall-side demotion via the PR5 score-penalty weight map.

Two halves, both asserted on OUTCOMES:

  * retain: ``detect_lesson_tags`` tags the intended transcript shapes (explicit
    lesson / anti-pattern markers), stays silent on ordinary transcripts, and is
    fully togglable via config; ``build_retain_payload`` merges the tags onto the
    retain without clobbering configured ``retainTags``.
  * recall: ``_effective_tag_weights`` composes the built-in lesson/anti-pattern
    demotion weights under ``recallTagWeights`` so that, after
    ``_apply_tag_weights`` + ``_sort_by_final_score``, a lesson-tagged memory
    ranks BELOW an equal-score untagged one yet is NEVER hard-dropped — and the
    operator override / rollback levers work.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import DEFAULTS  # noqa: E402
from retain import build_retain_payload, detect_lesson_tags  # noqa: E402
from recall import (  # noqa: E402
    _apply_tag_weights,
    _effective_tag_weights,
    _sort_by_final_score,
)


def _cfg(**over):
    """A config dict seeded with the real lesson defaults, plus overrides."""
    c = {
        "lessonTagging": DEFAULTS["lessonTagging"],
        "lessonTagMarkers": DEFAULTS["lessonTagMarkers"],
        "lessonDemotion": DEFAULTS["lessonDemotion"],
        "lessonDemotionWeights": DEFAULTS["lessonDemotionWeights"],
        "recallTagWeights": {},
    }
    c.update(over)
    return c


def _mem(text, final, tags=None):
    return {"text": text, "tags": tags or [], "scores": {"final": final}}


class DetectLessonTags(unittest.TestCase):
    def test_lesson_marker_tags_lesson(self):
        t = "The lesson learned here is to always dispatch before narrating."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["lesson"])

    def test_note_to_self_tags_lesson(self):
        t = "Note to self: run the scoped suite before pushing next time."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["lesson"])

    def test_anti_pattern_marker_tags_anti_pattern(self):
        t = "anti-pattern: announcing a dispatch without invoking the Agent tool."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["anti-pattern"])

    def test_what_not_to_do_tags_anti_pattern(self):
        t = "Here is what not to do: reply 'dispatching' and never dispatch."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["anti-pattern"])

    def test_both_markers_yield_both_tags_sorted(self):
        t = "Lesson learned from this anti-pattern: verify before asserting."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["anti-pattern", "lesson"])

    def test_case_insensitive(self):
        t = "LESSON LEARNED: read the ground truth."
        self.assertEqual(detect_lesson_tags(t, _cfg()), ["lesson"])

    def test_ordinary_transcript_untagged(self):
        t = "User asked to refactor the auth module. Assistant edited login.ts."
        self.assertEqual(detect_lesson_tags(t, _cfg()), [])

    def test_bare_word_lesson_does_not_overtag(self):
        # A passing mention of "lesson" without an explicit marker must NOT tag.
        t = "The history lesson from yesterday's chat was interesting."
        self.assertEqual(detect_lesson_tags(t, _cfg()), [])

    def test_disabled_is_noop(self):
        t = "lesson learned: always branch off fresh main."
        self.assertEqual(detect_lesson_tags(t, _cfg(lessonTagging=False)), [])

    def test_empty_or_bad_inputs(self):
        self.assertEqual(detect_lesson_tags("", _cfg()), [])
        self.assertEqual(detect_lesson_tags(None, _cfg()), [])
        self.assertEqual(detect_lesson_tags("lesson learned", _cfg(lessonTagMarkers={})), [])

    def test_custom_markers_override(self):
        cfg = _cfg(lessonTagMarkers={"gotcha": ["heads up:"]})
        self.assertEqual(detect_lesson_tags("Heads up: the port shifts.", cfg), ["gotcha"])


class BuildRetainPayloadTagMerge(unittest.TestCase):
    def _payload_tags(self, transcript_text, **cfg_over):
        cfg = _cfg(
            retainRoles=["user", "assistant"],
            retainToolCalls=True,
            retainContext="claude-code",
            retainMetadata={},
            retainTags=["{session_id}"],
            **cfg_over,
        )
        msgs = [
            {"role": "user", "content": "how do I dispatch?", "uuid": "u1"},
            {"role": "assistant", "content": transcript_text, "uuid": "a1"},
        ]
        built = build_retain_payload(
            cfg,
            "sess-123",
            msgs,
            msgs,
            bank_id="bank",
            api_url="http://x",
            api_token=None,
        )
        self.assertIsNotNone(built)
        return built["payload"]["tags"]

    def test_lesson_tag_appended_alongside_configured_tags(self):
        tags = self._payload_tags("anti-pattern: narrate without executing")
        self.assertIn("sess-123", tags)          # configured retainTag survives
        self.assertIn("anti-pattern", tags)      # detected tag added

    def test_no_lesson_tag_on_ordinary_transcript(self):
        tags = self._payload_tags("Edited the login handler and ran tests.")
        self.assertEqual(tags, ["sess-123"])

    def test_tagging_disabled_leaves_only_configured(self):
        tags = self._payload_tags("lesson learned: pull before branching",
                                   lessonTagging=False)
        self.assertEqual(tags, ["sess-123"])


class EffectiveTagWeights(unittest.TestCase):
    def test_builtins_present_by_default(self):
        w = _effective_tag_weights(_cfg())
        self.assertEqual(w["lesson"], 0.85)
        self.assertEqual(w["anti-pattern"], 0.5)

    def test_recall_tag_weights_compose_and_override(self):
        # sidechain seed composes; an explicit lesson override wins over builtin.
        w = _effective_tag_weights(
            _cfg(recallTagWeights={"sidechain": 0.8, "lesson": 0.95})
        )
        self.assertEqual(w["sidechain"], 0.8)
        self.assertEqual(w["lesson"], 0.95)          # operator override wins
        self.assertEqual(w["anti-pattern"], 0.5)     # builtin retained

    def test_rollback_drops_builtins(self):
        w = _effective_tag_weights(
            _cfg(lessonDemotion=False, recallTagWeights={"sidechain": 0.8})
        )
        self.assertEqual(w, {"sidechain": 0.8})
        self.assertNotIn("lesson", w)


class RecallDemotionOutcome(unittest.TestCase):
    """End-to-end recall outcome: tag → weight → sort."""

    def test_lesson_ranks_below_equal_score_untagged(self):
        neutral = _mem("clean session fact", 0.50, [])
        lesson = _mem("lesson transcript", 0.50, ["lesson"])
        results = [lesson, neutral]  # lesson first pre-weight
        w = _effective_tag_weights(_cfg())
        _apply_tag_weights(results, w)
        _sort_by_final_score(results)
        self.assertEqual(results[0]["text"], "clean session fact")
        self.assertEqual(results[1]["text"], "lesson transcript")

    def test_anti_pattern_never_dropped_when_only_hit(self):
        only = _mem("the only relevant fact", 0.42, ["anti-pattern"])
        results = [only]
        w = _effective_tag_weights(_cfg())
        _apply_tag_weights(results, w)
        _sort_by_final_score(results)
        self.assertEqual(len(results), 1)  # re-rank, never a hard drop
        self.assertAlmostEqual(results[0]["scores"]["final"], 0.42 * 0.5)

    def test_operator_override_changes_ordering(self):
        # With lesson override to 1.0 (no penalty), the lesson memory keeps parity.
        a = _mem("neutral", 0.50, [])
        b = _mem("lesson", 0.50, ["lesson"])
        results = [b, a]
        w = _effective_tag_weights(_cfg(recallTagWeights={"lesson": 1.0}))
        _apply_tag_weights(results, w)
        _sort_by_final_score(results)
        # Stable sort keeps pre-sort order on the tie → lesson stays first.
        self.assertEqual(results[0]["text"], "lesson")


if __name__ == "__main__":
    unittest.main()
