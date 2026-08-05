"""Per-turn operator-correction tag on auto-retained turns (switchroom PR4 4a).

When switchroom's self-improve gate (``src/self-improve/gate.ts``) fires on an
``operator-correction`` signal, the Stop hook drops a per-turn sentinel into the
shared agent state dir. This hook — a SEPARATE process — reads-and-clears that
sentinel and stamps ``self-improve:correction`` on the turn's retain, so PR5's
failure-synthesis cron can recall correction turns cheaply by tag filter.

This module asserts the OUTCOMES at the retain seam:

  1. read-and-clear is read-ONCE: a present sentinel yields the tag and is then
     gone; a second read yields nothing.
  2. the tag reaches the wire payload when (and ONLY when) it is threaded in —
     a mutation that stamped it unconditionally, or never, fails here.
  3. the tag is STABLE and therefore DOES move the consolidation scope to its
     own ``[["self-improve:correction"]]`` partition — the opposite of the
     forced-volatile ``source:transcript`` tag — and it matches NO volatile
     scope pattern (in particular not ``^source:``). Absent tag ⇒ scope stays
     the byte-identical ``"shared"``.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import tempfile
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import (  # noqa: E402
    DEFAULTS,
    DEFAULT_VOLATILE_SCOPE_PATTERNS,
    compute_observation_scopes,
)
from retain import (  # noqa: E402
    SELF_IMPROVE_CORRECTION_PENDING_FILE,
    SELF_IMPROVE_CORRECTION_TAG,
    build_retain_payload,
    read_and_clear_correction_pending,
)

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


def _build(extra_tags=None, **cfg_over):
    msgs = [
        {"role": "user", "content": "why did you include drafts?", "uuid": "u1"},
        {"role": "assistant", "content": "Fixed the digest filter.", "uuid": "a1"},
    ]
    built = build_retain_payload(
        _cfg(**cfg_over),
        SESSION_ID,
        msgs,
        msgs,
        bank_id="bank",
        api_url="http://x",
        api_token=None,
        extra_tags=extra_tags,
    )
    assert built is not None
    return built["payload"]


class ReadAndClearIsReadOnce(unittest.TestCase):
    def test_present_sentinel_yields_the_tag_and_is_cleared(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, SELF_IMPROVE_CORRECTION_PENDING_FILE)
            with open(path, "w") as f:
                f.write("2026-08-06T00:00:00Z")
            self.assertTrue(os.path.exists(path))

            first = read_and_clear_correction_pending(d)
            self.assertEqual(first, [SELF_IMPROVE_CORRECTION_TAG])
            # Cleared as a side effect — read-once.
            self.assertFalse(os.path.exists(path))

            # A second read finds nothing: exactly one retain carries the tag.
            second = read_and_clear_correction_pending(d)
            self.assertEqual(second, [])

    def test_absent_sentinel_yields_no_tag(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_and_clear_correction_pending(d), [])

    def test_never_raises_on_a_bad_state_dir(self):
        # A nonexistent dir must degrade to "no tag", never raise.
        self.assertEqual(
            read_and_clear_correction_pending("/nonexistent/does/not/exist"),
            [],
        )


class CorrectionTagReachesTheWire(unittest.TestCase):
    def test_tag_on_payload_when_threaded_in(self):
        tags = _build(extra_tags=[SELF_IMPROVE_CORRECTION_TAG])["tags"]
        self.assertIn(SELF_IMPROVE_CORRECTION_TAG, tags)
        # It composes — it does not clobber the session / provenance tags.
        self.assertIn(SESSION_ID, tags)
        self.assertIn(PROVENANCE_TAG, tags)

    def test_tag_absent_when_not_threaded_in(self):
        # Mutation guard: the tag is DATA carried by extra_tags, not unconditional
        # behaviour. A normal turn carries no correction tag.
        for extra in (None, []):
            tags = _build(extra_tags=extra)["tags"]
            self.assertNotIn(SELF_IMPROVE_CORRECTION_TAG, tags)

    def test_no_duplicate_when_already_present(self):
        tags = _build(
            extra_tags=[SELF_IMPROVE_CORRECTION_TAG, SELF_IMPROVE_CORRECTION_TAG]
        )["tags"]
        self.assertEqual(tags.count(SELF_IMPROVE_CORRECTION_TAG), 1)


class CorrectionTagScopeContract(unittest.TestCase):
    """The tag is STABLE — it SHOULD partition scope, and matches no volatile pat."""

    def test_tag_matches_no_volatile_scope_pattern(self):
        import re

        for pat in DEFAULT_VOLATILE_SCOPE_PATTERNS:
            self.assertIsNone(
                re.search(pat, SELF_IMPROVE_CORRECTION_TAG),
                f"correction tag must be STABLE but matched volatile pattern {pat!r}",
            )

    def test_correction_turn_lands_in_its_own_scope(self):
        scope = _build(extra_tags=[SELF_IMPROVE_CORRECTION_TAG])["observation_scopes"]
        self.assertEqual(scope, [[SELF_IMPROVE_CORRECTION_TAG]])

    def test_normal_turn_scope_stays_shared_and_byte_identical(self):
        with_none = _build(extra_tags=None)["observation_scopes"]
        with_empty = _build(extra_tags=[])["observation_scopes"]
        self.assertEqual(with_none, "shared")
        self.assertEqual(with_empty, "shared")

    def test_compute_scope_directly_partitions_on_the_stable_tag(self):
        # Guards the guard: prove the [[tag]] result is caused by the tag being
        # stable, straight through compute_observation_scopes.
        scope, err = compute_observation_scopes(
            [SESSION_ID, PROVENANCE_TAG, SELF_IMPROVE_CORRECTION_TAG], _cfg()
        )
        self.assertIsNone(err)
        self.assertEqual(scope, [[SELF_IMPROVE_CORRECTION_TAG]])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
