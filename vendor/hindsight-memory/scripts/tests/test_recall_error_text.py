"""Switchroom structural fix #7 — the `error` STRING on a recall_log row.

Every failure channel on a `recall_log.jsonl` row used to be a boolean:
`deadline_hit`, `bank_errored`, and per-bank `timed_out` / `errored`. They say
THAT something broke and never WHICH thing, so a log full of `errored: true`
cannot distinguish a connection refused from a 500 from a bad bank id from an
auth failure — four different fixes, one indistinguishable row.

That gap is not cosmetic here. `recall.py` deliberately exits 0 on a bank
failure (blocking the user's prompt would be worse) and Claude Code swallows
hook stderr on a zero exit, so the `[Hindsight] Recall failed: …` line that
carries the reason reaches nobody. The JSONL row is the ONLY place the reason
can survive, and until now it did not carry one.

These tests pin the behaviour the watchdog and an operator's `jq` depend on:

  * `error_text` is type-PREFIXED, because the message alone is frequently
    generic or empty and the exception class is the diagnostic part.
  * It is BOUNDED, because rows are trimmed by line count and one
    traceback-shaped message would evict real history.
  * It collapses whitespace to one line, so the JSONL stays greppable.
  * `recall_error_summary` reports the OWN bank's failure in preference to a
    side bank's — same rule as `degraded_recall_notice`, because a shared
    profile bank timing out does not mean the agent lost its memory.
  * A side-bank failure is NAMED, never reported as if it were the own bank's.
  * A healthy row gets `None`, not `""` — an empty string would count as a
    failure under a truthiness test somewhere downstream.

Stdlib-only, no network, no server.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from recall import (  # noqa: E402
    ERROR_TEXT_MAX_CHARS,
    error_text,
    recall_error_summary,
)

OWN = "overlord"
SIDE = "ken-profile"


def timing(bank_id, *, timed_out=False, errored=False, error=None, elapsed_ms=120):
    """A `bank_timings` entry in the shape recall.py now appends."""
    return {
        "bank_id": bank_id,
        "elapsed_ms": elapsed_ms,
        "timed_out": timed_out,
        "errored": errored,
        "error": error,
    }


class ErrorTextTests(unittest.TestCase):
    def test_prefixes_the_exception_type(self):
        # The observed fleet failure renders as its class plus its message;
        # `TimeoutError` alone is what tells an operator this is the 8s bank
        # deadline rather than a 500.
        self.assertEqual(
            error_text(TimeoutError("read timed out")),
            "TimeoutError: read timed out",
        )

    def test_survives_an_exception_with_no_message(self):
        # The class is the ONLY information here — dropping it would log an
        # empty string and lose the row entirely.
        self.assertEqual(error_text(ConnectionRefusedError()), "ConnectionRefusedError:")

    def test_passes_a_plain_string_through(self):
        self.assertEqual(error_text("bank not found"), "bank not found")

    def test_none_for_no_failure(self):
        self.assertIsNone(error_text(None))

    def test_empty_string_becomes_none_not_empty(self):
        # "" would be falsey but PRESENT, which reads as a failure with no
        # reason to anything that tests for the key.
        self.assertIsNone(error_text(""))
        self.assertIsNone(error_text("   \n  "))

    def test_collapses_newlines_so_the_jsonl_stays_greppable(self):
        self.assertEqual(error_text("line one\n  line two\ttab"), "line one line two tab")

    def test_bounded(self):
        got = error_text("x" * 5000)
        self.assertEqual(len(got), ERROR_TEXT_MAX_CHARS)


class RecallErrorSummaryTests(unittest.TestCase):
    def test_none_when_every_bank_answered(self):
        self.assertIsNone(
            recall_error_summary(OWN, [timing(OWN), timing(SIDE)], directives_timed_out=False)
        )

    def test_reports_the_own_bank_failure(self):
        got = recall_error_summary(
            OWN,
            [timing(OWN, timed_out=True, error="TimeoutError: read timed out"), timing(SIDE)],
        )
        self.assertEqual(got, "TimeoutError: read timed out")

    def test_prefers_the_own_bank_over_a_simultaneous_side_failure(self):
        got = recall_error_summary(
            OWN,
            [
                timing(SIDE, errored=True, error="HTTPError: 500"),
                timing(OWN, timed_out=True, error="TimeoutError: own"),
            ],
        )
        self.assertEqual(got, "TimeoutError: own")

    def test_matches_the_own_bank_by_id_not_by_position(self):
        # Fan-out completion order is not stable; a positional match would
        # attribute the side bank's failure to the agent's own memory.
        got = recall_error_summary(
            OWN, [timing(SIDE, errored=True, error="HTTPError: 500"), timing(OWN)]
        )
        self.assertIn(SIDE, got)
        self.assertIn("additional bank", got)

    def test_reports_directive_timeout_when_no_bank_failed(self):
        got = recall_error_summary(OWN, [timing(OWN), timing(SIDE)], directives_timed_out=True)
        self.assertEqual(got, "directives fetch timed out")

    def test_tolerates_an_empty_or_missing_timing_list(self):
        self.assertIsNone(recall_error_summary(OWN, []))
        self.assertIsNone(recall_error_summary(OWN, None))

    def test_tolerates_legacy_rows_without_the_error_key(self):
        # Rows written before this field shipped are still in the append-only
        # log and must not raise here.
        legacy = {"bank_id": OWN, "elapsed_ms": 8017, "timed_out": True, "errored": False}
        self.assertIsNone(recall_error_summary(OWN, [legacy]))

    def test_ignores_non_dict_entries(self):
        self.assertIsNone(recall_error_summary(OWN, ["garbage", None]))


if __name__ == "__main__":
    unittest.main()
