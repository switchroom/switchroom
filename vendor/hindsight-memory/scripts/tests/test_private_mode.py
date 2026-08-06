"""Switchroom /private-mode — retain-side enforcement tests (privacy PR1).

The Telegram gateway's ``/private`` / ``/public`` commands pause/resume
auto-retain by maintaining a shared interval file,
``${TELEGRAM_STATE_DIR}/privacy-state.json``::

    {"version": 1, "intervals": [
        {"start": "<iso>", "end": "<iso>"},   # a CLOSED private window
        {"start": "<iso>", "end": null}       # the OPEN window = private NOW
    ]}

This suite is the enforcement half — the privacy GUARANTEE — and must be
CI-provable on its own. Every test is written to FAIL on a broken
implementation (privacy check missing, mis-ordered, or force-path unguarded).

Stdlib-only; runs under ``python3 -m unittest discover`` from ``scripts/``.
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import retain  # noqa: E402
from retain import (  # noqa: E402
    _has_open_interval,
    exclude_private_ranges,
    read_privacy_state,
    run_retain,
)
from subagent_retain import run_subagent_retain  # noqa: E402


def _write_state(state_dir: str, intervals: list) -> None:
    with open(os.path.join(state_dir, "privacy-state.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "intervals": intervals}, f)


def _msg(role: str, text: str, ts: str | None = None) -> dict:
    m = {"role": role, "content": text}
    if ts is not None:
        m["timestamp"] = ts
    return m


# Reusable timestamps (UTC, the gateway's ...Z form).
T00 = "2026-08-06T02:00:00.000Z"  # public (before any interval)
T01 = "2026-08-06T02:01:00.000Z"  # inside a private window
T02 = "2026-08-06T02:02:00.000Z"  # inside a private window
T03 = "2026-08-06T02:03:00.000Z"  # public (after a closed window)
T04 = "2026-08-06T02:04:00.000Z"  # public (after a closed window)


class ReadPrivacyState(unittest.TestCase):
    """read_privacy_state is best-effort and never raises, and — review MAJOR 1
    — distinguishes an ABSENT file (public) from a PRESENT-but-corrupt one
    (fail toward privacy)."""

    def test_missing_file_is_public(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_privacy_state(d), [])
            # An absent file is genuinely public — not private-now.
            self.assertFalse(_has_open_interval(read_privacy_state(d)))

    def test_no_intervals_key_is_public(self):
        # Valid JSON object without an intervals key = public (not corrupt).
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "privacy-state.json"), "w") as f:
                f.write('{"version": 1}')
            self.assertEqual(read_privacy_state(d), [])
            self.assertFalse(_has_open_interval(read_privacy_state(d)))

    def test_corrupt_file_fails_toward_privacy(self):
        # MAJOR 1: a file that EXISTS but cannot be parsed (e.g. a Stop hook
        # firing during a non-atomic gateway rewrite) must NOT silently read as
        # public — that would leak the just-completed private turn. It fails
        # TOWARD privacy: private-now, and redaction drops everything.
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "privacy-state.json"), "w") as f:
                f.write("{ not json")
            state = read_privacy_state(d)
            self.assertNotEqual(state, [], "corrupt file must not read as public []")
            self.assertTrue(_has_open_interval(state))
            self.assertEqual(
                exclude_private_ranges([_msg("user", "x", T00)], state), []
            )

    def test_intervals_not_a_list_fails_toward_privacy(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "privacy-state.json"), "w") as f:
                f.write('{"version": 1, "intervals": "nope"}')
            self.assertTrue(_has_open_interval(read_privacy_state(d)))

    def test_reads_intervals(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": T02}])
            self.assertEqual(read_privacy_state(d), [{"start": T01, "end": T02}])


class ExcludePrivateRanges(unittest.TestCase):
    """The pure redaction function."""

    def test_no_intervals_keeps_all(self):
        msgs = [_msg("user", "a", T00), _msg("assistant", "b", T01)]
        self.assertEqual(exclude_private_ranges(msgs, []), msgs)

    def test_open_interval_drops_from_start_onward(self):
        msgs = [
            _msg("user", "keep", T00),
            _msg("user", "drop1", T01),
            _msg("user", "drop2", T02),
        ]
        kept = exclude_private_ranges(msgs, [{"start": T01, "end": None}])
        self.assertEqual([m["content"] for m in kept], ["keep"])

    def test_closed_interval_drops_only_inside(self):
        msgs = [
            _msg("user", "keep_before", T00),
            _msg("user", "drop_inside", T01),
            _msg("user", "keep_after", T03),
        ]
        kept = exclude_private_ranges(msgs, [{"start": T01, "end": T02}])
        self.assertEqual(
            [m["content"] for m in kept], ["keep_before", "keep_after"]
        )

    def test_missing_timestamp_dropped_only_when_open(self):
        no_ts = _msg("user", "no_ts")
        # Closed interval only -> a placeless message is KEPT.
        self.assertIn(
            no_ts, exclude_private_ranges([no_ts], [{"start": T01, "end": T02}])
        )
        # An OPEN interval exists -> conservative drop.
        self.assertEqual(
            exclude_private_ranges([no_ts], [{"start": T01, "end": None}]), []
        )

    def test_malformed_end_guard_and_redaction_agree(self):
        # Review MINOR: a present-but-unparseable `end` must be interpreted the
        # SAME way by the guard (_has_open_interval) and the redactor
        # (exclude_private_ranges) — both treat it as OPEN [start, ∞). Previously
        # the guard read it as closed (end is not None) while the redactor
        # degraded it to unbounded-open, silently deleting all public memory from
        # `start` onward with no skip and no log.
        intervals = [{"start": T01, "end": "GARBAGE"}]
        self.assertTrue(_has_open_interval(intervals))  # guard sees OPEN
        msgs = [
            _msg("user", "keep_before", T00),
            _msg("user", "drop_at_start", T01),
            _msg("user", "drop_after", T03),
        ]
        kept = exclude_private_ranges(msgs, intervals)
        # Redactor also sees OPEN [T01, ∞): before T01 kept, T01+ dropped.
        self.assertEqual([m["content"] for m in kept], ["keep_before"])

    def test_unparseable_start_fails_toward_privacy(self):
        # A present-but-unparseable start can't be placed -> drop everything.
        intervals = [{"start": "GARBAGE", "end": None}]
        self.assertTrue(_has_open_interval(intervals))
        self.assertEqual(
            exclude_private_ranges([_msg("user", "x", T00)], intervals), []
        )


# --- run_retain wiring: network-layer stubs so we can inspect the payload -----


def _base_config(**over) -> dict:
    cfg = {
        "autoRetain": True,
        "retainMode": "chunked",
        "retainEveryNTurns": 1,
        "retainOverlapTurns": 50,  # window wide enough to keep all public turns
        "retainRoles": ["user", "assistant"],
        "retainToolCalls": True,
        "retainTags": [],
    }
    cfg.update(over)
    return cfg


class _FakeClient:
    def __init__(self, *a, **k):
        pass

    def retain(self, **kwargs):  # noqa: D401
        _FakeClient.captured = kwargs
        return {}


def _run_retain_capturing_payload(state_dir, messages, *, force, config=None):
    """Run run_retain with the network layer stubbed; return the retain content
    string that was actually built and POSTed (or None if none was)."""
    _FakeClient.captured = None
    cm = mock.MagicMock()
    cm.__enter__.return_value = True
    cm.__exit__.return_value = False
    hook_input = {"session_id": "s1", "transcript_path": "/x.jsonl"}
    with mock.patch.dict(os.environ, {"TELEGRAM_STATE_DIR": state_dir}), \
            mock.patch("retain.load_config", return_value=config or _base_config()), \
            mock.patch("retain.read_transcript", return_value=list(messages)), \
            mock.patch("retain.get_api_url", return_value="http://localhost:1"), \
            mock.patch("retain.HindsightClient", _FakeClient), \
            mock.patch("retain.ensure_bank_mission"), \
            mock.patch("retain.derive_bank_id", return_value="bank"), \
            mock.patch("retain.track_retention", return_value=(0, False)), \
            mock.patch("retain.increment_turn_count", return_value=1), \
            mock.patch("retain.inflight_lock", return_value=cm), \
            mock.patch("retain.watermark") as wm:
        wm.commit.return_value = None
        result = run_retain(hook_input, force=force)
    captured = _FakeClient.captured
    return result, (captured["content"] if captured else None)


class EnvPinCannotOverridePrivacy(unittest.TestCase):
    """A HINDSIGHT_AUTO_RETAIN=true env pin (autoRetain forced TRUE) must NOT be
    able to override an OPEN private interval. The privacy check runs BEFORE
    load_config(), so the pin never gets a say."""

    def test_env_pin_open_interval_skips_private_mode(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": None}])
            hook_input = {"session_id": "s1", "transcript_path": "/x.jsonl"}
            with mock.patch.dict(
                os.environ,
                {"TELEGRAM_STATE_DIR": d, "HINDSIGHT_AUTO_RETAIN": "true"},
            ), mock.patch(
                "retain.load_config", return_value=_base_config(autoRetain=True)
            ), mock.patch("retain.read_transcript") as read_t:
                result = run_retain(hook_input, force=False)
        # Skipped for privacy specifically...
        self.assertEqual(result.get("reason"), "private-mode")
        # ...and BEFORE the transcript was ever read (early, pre-load_config).
        read_t.assert_not_called()


class PrivacyRunsBeforeAutoRetainGate(unittest.TestCase):
    """Ordering: even when autoRetain is FALSE, an open interval yields the
    private-mode reason — proving the privacy check runs before (and independent
    of) the autoRetain gate, not after it."""

    def test_open_interval_reports_private_mode_not_autoretain_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": None}])
            hook_input = {"session_id": "s1", "transcript_path": "/x.jsonl"}
            with mock.patch.dict(os.environ, {"TELEGRAM_STATE_DIR": d}), \
                    mock.patch(
                        "retain.load_config",
                        return_value=_base_config(autoRetain=False),
                    ):
                result = run_retain(hook_input, force=False)
        self.assertEqual(result.get("reason"), "private-mode")


class ForcePathExcludesOpenRange(unittest.TestCase):
    """The assertion the old fire-skipping design could NOT pass: a FORCED
    SessionEnd sweep is exempt from the early-skip (it must flush the public
    portion), so the private turns must be excluded from the built payload
    instead of the whole fire being skipped."""

    def test_force_sweep_omits_open_range_messages(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": None}])
            messages = [
                _msg("user", "PUBLIC_BEFORE_TOKEN", T00),
                _msg("assistant", "ok public", T00),
                _msg("user", "PRIVATE_SECRET_TOKEN", T01),
                _msg("assistant", "PRIVATE_REPLY_TOKEN", T02),
            ]
            result, content = _run_retain_capturing_payload(
                d, messages, force=True
            )
        self.assertIsNotNone(content, "force sweep should still POST the public portion")
        self.assertIn("PUBLIC_BEFORE_TOKEN", content)
        self.assertNotIn("PRIVATE_SECRET_TOKEN", content)
        self.assertNotIn("PRIVATE_REPLY_TOKEN", content)


class ChunkedExcludesClosedRange(unittest.TestCase):
    """A normal (non-forced) chunked retain AFTER a CLOSED private window must
    exclude the messages that fell inside that window, even though they are
    inside the sliding window."""

    def test_closed_range_messages_absent_from_window(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": T02}])
            messages = [
                _msg("user", "PUBLIC_OLD_TOKEN", T00),
                _msg("user", "PRIVATE_MID_TOKEN", T01),
                _msg("assistant", "PRIVATE_MID_REPLY", T02),
                _msg("user", "PUBLIC_NEW_TOKEN", T03),
                _msg("assistant", "PUBLIC_NEW_REPLY", T04),
            ]
            result, content = _run_retain_capturing_payload(
                d, messages, force=False
            )
        self.assertIsNotNone(content)
        self.assertIn("PUBLIC_OLD_TOKEN", content)
        self.assertIn("PUBLIC_NEW_TOKEN", content)
        self.assertNotIn("PRIVATE_MID_TOKEN", content)
        self.assertNotIn("PRIVATE_MID_REPLY", content)


class CorruptStateFailsTowardPrivacy(unittest.TestCase):
    """Review MAJOR 1 at the run_retain level: a present-but-corrupt state file
    mid-session skips the (non-forced) retain toward privacy, while a genuinely
    ABSENT file retains normally."""

    def test_corrupt_file_skips_non_forced_retain(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "privacy-state.json"), "w") as f:
                f.write("{ truncated mid-rewrite")
            hook_input = {"session_id": "s1", "transcript_path": "/x.jsonl"}
            with mock.patch.dict(os.environ, {"TELEGRAM_STATE_DIR": d}), \
                    mock.patch("retain.load_config", return_value=_base_config()), \
                    mock.patch("retain.read_transcript") as read_t:
                result = run_retain(hook_input, force=False)
        self.assertEqual(result.get("reason"), "private-mode")
        read_t.assert_not_called()  # early skip, before the transcript is read

    def test_absent_file_retains_normally(self):
        # No privacy-state.json in the dir -> genuinely public -> full retain.
        with tempfile.TemporaryDirectory() as d:
            messages = [
                _msg("user", "PUBLIC_A_TOKEN", T00),
                _msg("assistant", "PUBLIC_B_TOKEN", T01),
            ]
            result, content = _run_retain_capturing_payload(
                d, messages, force=False
            )
        self.assertIsNotNone(content, "absent file must retain normally")
        self.assertIn("PUBLIC_A_TOKEN", content)
        self.assertIn("PUBLIC_B_TOKEN", content)


def _run_subagent_capturing_window(state_dir, messages):
    """Run run_subagent_retain with the network layer stubbed; return the
    messages_to_retain slice that build_retain_payload was handed (the window
    that would be formatted + POSTed)."""
    captured = {}

    def _capture(config, session_id, messages_to_retain, all_messages, **kw):
        captured["window"] = list(messages_to_retain)
        return None  # short-circuit before the POST; we only need the window

    hook_input = {"session_id": "s1", "agent_id": "a1"}
    with mock.patch.dict(os.environ, {"TELEGRAM_STATE_DIR": state_dir}), \
            mock.patch("subagent_retain.load_config", return_value=_base_config()), \
            mock.patch(
                "subagent_retain.resolve_sidechain_transcript",
                return_value="/x.jsonl",
            ), \
            mock.patch("subagent_retain.read_transcript", return_value=list(messages)), \
            mock.patch(
                "subagent_retain.passes_volume_gate", return_value=(True, 3, 9999)
            ), \
            mock.patch("subagent_retain.get_api_url", return_value="http://localhost:1"), \
            mock.patch("subagent_retain.HindsightClient", _FakeClient), \
            mock.patch("subagent_retain.ensure_bank_mission"), \
            mock.patch("subagent_retain.derive_bank_id", return_value="bank"), \
            mock.patch("subagent_retain.build_retain_payload", side_effect=_capture):
        run_subagent_retain(hook_input)
    window = captured.get("window", [])
    texts = [m.get("content") for m in window if isinstance(m, dict)]
    return "\n".join(t for t in texts if isinstance(t, str))


class SubagentExcludesClosedRange(unittest.TestCase):
    """Review MAJOR 2: a backgrounded sub-agent dispatched under /private that
    finishes AFTER /public closed the interval must still have its private-window
    material redacted — the open-interval early-skip alone doesn't catch it."""

    def test_closed_range_absent_from_subagent_window(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": T02}])  # now CLOSED
            messages = [
                _msg("user", "SUB_PUBLIC_BEFORE", T00),
                _msg("user", "SUB_PRIVATE_MID", T01),
                _msg("assistant", "SUB_PRIVATE_REPLY", T02),
                _msg("user", "SUB_PUBLIC_AFTER", T03),
                _msg("assistant", "SUB_PUBLIC_DONE", T04),
            ]
            window = _run_subagent_capturing_window(d, messages)
        self.assertIn("SUB_PUBLIC_AFTER", window)
        self.assertNotIn("SUB_PRIVATE_MID", window)
        self.assertNotIn("SUB_PRIVATE_REPLY", window)


class SubagentHonorsPrivacy(unittest.TestCase):
    """Subagents have no toggle of their own; they honor the parent session's
    privacy state file. An open interval skips the sidechain retain."""

    def test_subagent_open_interval_skips_private_mode(self):
        with tempfile.TemporaryDirectory() as d:
            _write_state(d, [{"start": T01, "end": None}])
            hook_input = {"session_id": "s1", "agent_id": "a1"}
            with mock.patch.dict(os.environ, {"TELEGRAM_STATE_DIR": d}), \
                    mock.patch("subagent_retain.load_config") as lc, \
                    mock.patch("subagent_retain.read_transcript") as read_t:
                result = run_subagent_retain(hook_input)
        self.assertEqual(result.get("reason"), "private-mode")
        # Early skip runs before load_config() and before any transcript read.
        lc.assert_not_called()
        read_t.assert_not_called()


if __name__ == "__main__":
    unittest.main()
