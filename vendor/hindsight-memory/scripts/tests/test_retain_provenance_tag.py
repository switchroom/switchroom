"""Provenance on auto-retained transcript content (switchroom fix/retain-provenance).

The defect: the Stop-hook auto-retain posts the recent transcript window to
Hindsight, which extracts facts from it — including from the ASSISTANT's own
synthesis. Those fabrications land as ordinary memory units and recall back next
session as though a human had asserted them. Nothing on the stored unit said
"this came out of a transcript": ``tags`` held only the raw session UUID and the
only other signal, ``session_id``, lived in ``metadata`` — which Hindsight's
best-practices page states is NOT filterable, while tags ARE.

The fix stamps a stable, semantic ``source:transcript`` tag via switchroom's
``retainTags`` default, so recall/reflect can address it (tag filters, tag
weights). This module asserts the two OUTCOMES that matter at the retain seam:

  1. The tag actually reaches the wire payload, alongside the session tag and
     any detected lesson tags (i.e. it composes, it does not clobber).
  2. It does NOT change the observation consolidation scope. This is the
     non-obvious half: ``observationScopeStrategy: "curated"`` builds the scope
     from a retain's STABLE tags, so a permanently-stamped tag would flip every
     bank from the bank-wide ``"shared"`` scope to a ``[["source:transcript"]]``
     partition, isolating every new observation from every observation
     consolidated before the tag shipped. ``^source:`` is therefore excluded
     from the scope in ``DEFAULT_VOLATILE_SCOPE_PATTERNS`` — the tag is a
     recall-side filter handle, not a consolidation partition.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import (  # noqa: E402
    DEFAULTS,
    DEFAULT_VOLATILE_SCOPE_PATTERNS,
    compute_observation_scopes,
)
from retain import build_retain_payload  # noqa: E402

#: What switchroom's ``renderHindsightSettingsOverrides`` stamps into every
#: agent's deployed settings.json (src/memory/hindsight-retain-provenance.ts).
PROVENANCE_TAG = "source:transcript"
SESSION_ID = "4c386b32-ddfd-40d1-b557-da8135b294af"


def _cfg(**over):
    c = {
        "retainRoles": ["user", "assistant"],
        "retainToolCalls": True,
        "retainContext": "claude-code",
        "retainMetadata": {},
        "retainTags": ["{session_id}", PROVENANCE_TAG],
        "lessonTagging": DEFAULTS["lessonTagging"],
        "lessonTagMarkers": DEFAULTS["lessonTagMarkers"],
        "observationScopeStrategy": "curated",
    }
    c.update(over)
    return c


def _build(transcript_text="Edited the login handler and ran tests.", **cfg_over):
    msgs = [
        {"role": "user", "content": "what did we change?", "uuid": "u1"},
        {"role": "assistant", "content": transcript_text, "uuid": "a1"},
    ]
    built = build_retain_payload(
        _cfg(**cfg_over),
        SESSION_ID,
        msgs,
        msgs,
        bank_id="bank",
        api_url="http://x",
        api_token=None,
    )
    assert built is not None
    return built["payload"]


class ProvenanceTagReachesTheWire(unittest.TestCase):
    def test_tag_is_on_the_retain_payload(self):
        self.assertIn(PROVENANCE_TAG, _build()["tags"])

    def test_session_tag_still_templated_and_kept(self):
        tags = _build()["tags"]
        self.assertIn(SESSION_ID, tags)
        self.assertNotIn("{session_id}", tags)

    def test_composes_with_detected_lesson_tags(self):
        tags = _build("anti-pattern: narrate without executing")["tags"]
        self.assertIn(PROVENANCE_TAG, tags)
        self.assertIn("anti-pattern", tags)
        self.assertIn(SESSION_ID, tags)

    def test_absent_when_retain_tags_config_omits_it(self):
        # The tag is data, not hardcoded behaviour: retain.py has no knowledge
        # of it beyond honouring the configured retainTags. That keeps the
        # vendored plugin generic and the switchroom stamp the single source.
        tags = _build(retainTags=["{session_id}"])["tags"]
        self.assertNotIn(PROVENANCE_TAG, tags)


class ProvenanceTagIsScopeNeutral(unittest.TestCase):
    """The tag must not silently re-partition observation consolidation."""

    def test_curated_scope_stays_shared_with_the_provenance_tag(self):
        payload = _build()
        self.assertEqual(payload["observation_scopes"], "shared")

    def test_scope_is_byte_identical_to_a_bank_without_the_tag(self):
        with_tag = _build()["observation_scopes"]
        without = _build(retainTags=["{session_id}"])["observation_scopes"]
        self.assertEqual(with_tag, without)

    def test_a_stable_tag_that_is_not_excluded_would_have_changed_the_scope(self):
        # Guards the guard: proves the "shared" result above is caused by the
        # exclusion pattern and not by curated ignoring stable tags generally.
        scope, err = compute_observation_scopes(
            [SESSION_ID, "project:switchroom"], _cfg()
        )
        self.assertIsNone(err)
        self.assertEqual(scope, [["project:switchroom"]])

    def test_exclusion_pattern_is_present_and_matches_the_tag(self):
        self.assertIn(r"^source:", DEFAULT_VOLATILE_SCOPE_PATTERNS)
        scope, err = compute_observation_scopes([SESSION_ID, PROVENANCE_TAG], _cfg())
        self.assertIsNone(err)
        self.assertEqual(scope, "shared")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
