"""RFC phase4 P3 — unit + end-to-end tests for the operator-profile capture nudge.

Ken's first stated want is "save memories about him". Auto-retain stores
transcript facts, but nothing gives a DETERMINISTIC signal that a durable
*profile fact* about the operator himself just went by — so profile capture is
left to model discretion (the same per-agent lottery Stage A measured for
directives). P3 mirrors the shipped directive-capture nudge (recall.py #2848):
a POSITIVE regex detects a first-person durable self-statement, a NEGATIVE
regex scrubs the two false-positive shapes (questions, attributions to others)
BEFORE the positive match, and on a hit the UserPromptSubmit hook appends a
terse advisory telling the model to persist it with an explicit retain tagged
`profile:ken` into the agent's OWN bank. Pure regex — no model callsite.

These tests pin (all OUTCOME assertions):
  * True positives — the RFC's listed profile shapes fire.
  * True negatives — questions and third-/second-party attributions do NOT
    fire (the negative-lookaround guard scrubs them first).
  * The advisory carries the `profile:ken` tag instruction and targets the
    agent's OWN bank (not a shared / cross-agent person bank).
  * End-to-end through recall.main(): the advisory reaches the emitted
    additionalContext, the recall_log row carries `profile_nudge: true`, and
    the config knob OFF (`profileCaptureNudge: false`) suppresses both.

Stdlib-only; runs under `python3 -m unittest discover tests/`. The end-to-end
harness mirrors test_recall_envelope_strip_telemetry.py.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from recall import (  # noqa: E402
    _PROFILE_CAPTURE_NUDGE,
    _combine_context,
    _is_trivial_stateless,
    looks_like_profile_statement,
)


# First-person durable self-statements that MUST fire the nudge. Drawn from the
# RFC P3 shapes ("I prefer …", "my … is …", "I always …", "remind me that I …")
# plus the conservative identity/situation set.
PROFILE_STATEMENTS = [
    # --- stated preferences ---
    "I prefer dark roast coffee",
    "I'd prefer British spelling in my docs",
    "my preference is tabs over spaces",
    # --- durable self-facts: "my <ATTRIBUTE> is/are …" (tight allow-list) ---
    "my timezone is Australia/Melbourne",
    "my email is ken@example.com",
    "my sister is Lisa",
    "my kids are at school during the day",
    "my name's Ken",  # contraction form
    # --- identity / situation ---
    "I live in Melbourne",
    "I work at Anthropic",
    "I'm allergic to peanuts",
    "I'm based in Australia",
    # --- durable identity: diet / abstention / "I'm a <noun>" ---
    "I'm a vegetarian",
    "I don't eat meat",
    "call me Ken",
    # --- tastes (durable like/dislike framing) ---
    "I hate em-dashes",
    # --- durable habits ---
    "I always take my coffee black",
    "I usually work late on Thursdays",
    "I never eat red meat",
    # --- explicit memory framing about the operator himself ---
    "remind me that I have a standing 9am standup",
    "remember that I hate em-dashes",
]

# Questions and attributions that MUST NOT fire — the negative-lookaround guard
# scrubs these BEFORE the positive match. A false positive here is nudge noise.
NON_PROFILE = [
    # --- questions about the operator (not statements of a durable fact) ---
    "do I prefer tea or coffee?",
    "what's my timezone?",
    "where is my email address stored?",
    "how do I fix this bug",
    "should I always run the tests first?",
    "what do I usually do here",
    "remind me what my calendar looks like",
    # --- attributions to a third / second party ---
    "you said I prefer tea",
    "she claims my code is broken",
    "he thinks I always overcomplicate things",
    "they told me my access was revoked",
    # --- neither: no first-person durable self-fact ---
    "the project timezone is UTC",
    "please run the tests",
    "what time is it",
    # --- discourse-marker "my <X> is" — not a durable profile fact. The
    #     positive arm uses a TIGHT identity allow-list, so a free noun never
    #     reaches the matcher; these confirm that. ---
    "my guess is the cache is stale",
    "my point is that we should ship it",
    "my concern is the timeout",
    # --- transient dev state "my <transient> is/are …". These are the exact
    #     over-fires the free-`\w+` arm produced; the allow-list must NOT fire
    #     on them (RFC favour-false-negatives constraint on this agent). ---
    "my container is down",
    "my build is failing",
    "my code is broken",
    "my PR is ready",
    "my worktree is dirty",
    "my server is down",
    "my deploy is stuck",
    "my tests are green",
    "my branch is merged",
    # --- pleasantry embedding a bare always/never after "I" ---
    "I always appreciate your help",
    "I never enjoy waiting, but thanks",
    # --- "I'm a <hedge>" is a transient mood, not an "I'm a <noun>" identity ---
    "I'm a bit tired",
    "I'm a little confused about the config",
    "I'm a big fan of shipping fast",
    # --- "call me <phrasing>" as a request, not a name form ---
    "call me back later",
    "call me when the build finishes",
    # --- the <channel …> envelope wrapper on its own must never trigger ---
    '<channel user="ken" chat_id="123">',
]


class TestProfileDetection(unittest.TestCase):
    def test_profile_statements_fire_the_nudge(self):
        for p in PROFILE_STATEMENTS:
            with self.subTest(prompt=p):
                self.assertTrue(
                    looks_like_profile_statement(p),
                    f"expected profile detection for {p!r}",
                )

    def test_questions_and_attributions_do_not_fire(self):
        for p in NON_PROFILE:
            with self.subTest(prompt=p):
                self.assertFalse(
                    looks_like_profile_statement(p),
                    f"FALSE POSITIVE: profile nudge would fire for {p!r}",
                )

    def test_empty_and_non_string_are_false(self):
        for bad in ("", "   ", None, 123, [], {}):
            with self.subTest(value=bad):
                self.assertFalse(looks_like_profile_statement(bad))

    def test_attribution_scrub_does_not_mask_a_real_self_fact(self):
        # A message that opens with an attributed clause AND then states the
        # operator's own durable fact must still fire — the negative guard
        # scrubs only the attributed span (through end-of-sentence).
        self.assertTrue(
            looks_like_profile_statement(
                "she thinks I'm wrong. my timezone is Melbourne"
            )
        )

    def test_attribution_scrub_stops_at_a_comma(self):
        # The attributed span must stop at a comma, not run to end-of-sentence:
        # a real self-fact trailing the attributed clause in the SAME sentence
        # must still reach the positive matcher (MINOR: greedy [^.?!]* → [^.?!,]*).
        self.assertTrue(
            looks_like_profile_statement(
                "she said the deploy failed, my timezone is Melbourne"
            )
        )


class TestProfileNudgeString(unittest.TestCase):
    def test_nudge_carries_the_profile_ken_tag_instruction(self):
        self.assertIn("profile:ken", _PROFILE_CAPTURE_NUDGE)
        self.assertIn("retain", _PROFILE_CAPTURE_NUDGE)
        self.assertIn("profile_capture_check", _PROFILE_CAPTURE_NUDGE)

    def test_nudge_targets_the_agents_own_bank_not_a_shared_one(self):
        # Constraint 2 forbids a cross-agent person bank — the advisory must
        # route to the agent's OWN bank and say so explicitly.
        self.assertIn("OWN bank", _PROFILE_CAPTURE_NUDGE)
        self.assertIn("shared", _PROFILE_CAPTURE_NUDGE)

    def test_combine_appends_nudge_after_recall_block(self):
        base = "<hindsight_memories>\n…\n</hindsight_memories>"
        out = _combine_context(base, _PROFILE_CAPTURE_NUDGE)
        self.assertTrue(out.startswith(base))
        self.assertTrue(out.endswith(_PROFILE_CAPTURE_NUDGE))


class TestTrivialSkipUnaffected(unittest.TestCase):
    """A profile statement carries personal/stateful signal and must never be
    trivial-stateless-skipped; greetings still are."""

    def test_profile_statements_are_never_trivial_skipped(self):
        for p in PROFILE_STATEMENTS:
            with self.subTest(prompt=p):
                self.assertFalse(
                    _is_trivial_stateless("", p),
                    f"profile statement {p!r} was trivial-skipped",
                )


# --- End-to-end harness (mirrors test_recall_envelope_strip_telemetry.py) ---


class _RecordingClient:
    def __init__(self, memories=None, directives=None):
        self._memories = memories if memories is not None else []
        self._directives = directives if directives is not None else []
        self.queries = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        self.queries.append(query)
        return {"results": list(self._memories)}


def _run_main_with(client, prompt, config_extra=None):
    hook_input = {
        "prompt": prompt,
        "session_id": "test-session",
        "transcript_path": "",
        "cwd": "/tmp",
    }
    config = {
        "autoRecall": True,
        "bankId": "test-bank",
        "recallMaxTokens": 1024,
        "recallBudget": "mid",
        "recallContextTurns": 1,
        "recallMaxQueryChars": 800,
        "recallPromptPreamble": "",
    }
    if config_extra:
        config.update(config_extra)

    stdout = io.StringIO()
    stderr = io.StringIO()
    with patch.object(recall, "load_config", return_value=config), patch.object(
        recall, "get_api_url", return_value="http://localhost:18888"
    ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
        recall, "ensure_bank_mission", return_value=None
    ), patch.object(recall, "write_state", return_value=None), patch(
        "sys.stdin", new=io.StringIO(json.dumps(hook_input))
    ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
        recall.main()

    raw = stdout.getvalue()
    if not raw.strip():
        return None, raw
    parsed = json.loads(raw)
    return parsed["hookSpecificOutput"]["additionalContext"], raw


# A profile-only prompt: matches the profile regex but NOT the directive regex,
# so these end-to-end assertions isolate the profile nudge cleanly.
PROFILE_PROMPT = "my timezone is Australia/Melbourne"


class _LogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="profile-nudge-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _read_log(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


class ProfileNudgeEndToEnd(_LogTestBase):
    def test_advisory_reaches_context_and_row_records_it(self):
        client = _RecordingClient(memories=[{"text": "m", "type": "fact",
                                             "mentioned_at": "2026-01-01", "id": "m1"}])
        ctx, _raw = _run_main_with(client, prompt=PROFILE_PROMPT)
        # The profile advisory is injected into the turn context, tagged and
        # own-bank-scoped.
        self.assertIsNotNone(ctx)
        self.assertIn("profile:ken", ctx)
        self.assertIn("OWN bank", ctx)
        # The recall_log row carries the firing-rate boolean.
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]["profile_nudge"])

    def test_knob_off_suppresses_nudge_and_row_is_false(self):
        client = _RecordingClient(memories=[{"text": "m", "type": "fact",
                                             "mentioned_at": "2026-01-01", "id": "m1"}])
        ctx, _raw = _run_main_with(
            client, prompt=PROFILE_PROMPT,
            config_extra={"profileCaptureNudge": False},
        )
        # Nudge suppressed: the advisory is absent from context (memories may
        # still be injected, but never the profile block).
        if ctx is not None:
            self.assertNotIn("profile:ken", ctx)
            self.assertNotIn("profile_capture_check", ctx)
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["profile_nudge"])

    def test_non_profile_prompt_does_not_fire(self):
        client = _RecordingClient(memories=[{"text": "m", "type": "fact",
                                             "mentioned_at": "2026-01-01", "id": "m1"}])
        ctx, _raw = _run_main_with(client, prompt="please run the tests")
        if ctx is not None:
            self.assertNotIn("profile:ken", ctx)
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["profile_nudge"])


if __name__ == "__main__":
    unittest.main()
