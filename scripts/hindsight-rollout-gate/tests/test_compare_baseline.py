"""Self-test for the Hindsight rollout gate comparator.

The failure this suite exists for: the previous gate reported RED on healthy
data (WP6, switchroom#4533 — same code, same data, 30/30 cells flagged at
0.36-0.75), and nobody noticed because the gate had never been run against a
known-good or a known-bad input. A gate that has not been shown to distinguish
the two is not a gate.

Every test drives the REAL `evaluate()` / `check_comparability()` / `main()` —
no mocks of the logic under test — and asserts OUTCOMES (verdict, exit code,
what appears in the rendered report), not that a code path ran.

Stdlib only: `python3 -m unittest discover -s tests -t .` from this script's
parent directory.
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import compare_baseline as cb  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SHIFTS_PATH = os.path.join(os.path.dirname(HERE), "expected_shifts.json")

BANKS = ["overlord", "klanker", "finn"]
QIDS = [
    "bm25-config-key",
    "bm25-identifier",
    "bm25-errorcode",
    "semantic-decision",
    "semantic-howto",
    "temporal-relative",
    "entity-person",
    "mixed-paradedb",
    "persona-role",
    "ops-procedure",
]

PROD_DB_ID = "7627286907797205078"
RESTORED_COPY_DB_ID = "7627286907799999999"


def ts(offset_hours=0.0):
    return (
        datetime(2026, 8, 11, 12, 0, 0, tzinfo=timezone.utc)
        + timedelta(hours=offset_hours)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


def ids(bank, qid, n=80, start=0):
    return [f"{bank}-{qid}-{i}" for i in range(start, start + n)]


def capture(
    phase,
    generated_at,
    api_version,
    db_id=PROD_DB_ID,
    api_url="http://127.0.0.1:18888",
    overrides=None,
    anchor="2026-08-08T00:00:00",
):
    """A full 30-cell capture. `overrides` maps (bank, qid) -> cell dict patch."""
    overrides = overrides or {}
    results = {}
    for bank in BANKS:
        results[bank] = {}
        for qid in QIDS:
            cell = {
                "result_count": 80,
                "memory_ids": ids(bank, qid),
                "elapsed_ms": 1800,
                "query": qid,
            }
            cell.update(overrides.get((bank, qid), {}))
            results[bank][qid] = cell
    return {
        "schema_version": 2,
        "phase": phase,
        "generated_at": generated_at,
        "query_timestamp_anchor": anchor,
        "instance": {
            "api_url": api_url,
            "instance_id": "prod",
            "db_system_identifier": db_id,
            "api_version": api_version,
            "banks_fingerprint": "abc123",
        },
        "banks": BANKS,
        "results": results,
    }


def jaccard_shifted(bank, qid, target, n=80):
    """A post-run id list whose Jaccard against the baseline is ~= target.

    |A n B| = n - k, |A u B| = n + k  ->  J = (n-k)/(n+k).
    """
    k = round(n * (1 - target) / (1 + target))
    return ids(bank, qid, n=n - k) + ids(bank, qid, n=k, start=1000)


def run_main(base, post, extra=None):
    """Drive the real CLI end to end. Returns (exit_code, stdout)."""
    with tempfile.TemporaryDirectory() as d:
        bp, pp = os.path.join(d, "pre.json"), os.path.join(d, "post.json")
        with open(bp, "w") as fh:
            json.dump(base, fh)
        with open(pp, "w") as fh:
            json.dump(post, fh)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cb.main(
                ["--baseline", bp, "--post", pp, "--expected-shifts", SHIFTS_PATH]
                + (extra or [])
            )
        return code, buf.getvalue()


class TestKnownGood(unittest.TestCase):
    """A healthy 0.8.6 -> 0.9.0 rollout must come back GREEN."""

    def test_healthy_rollout_passes_with_zero_failures(self):
        """The whole board healthy, temporal shifting exactly as declared."""
        base = capture("pre", ts(0), "0.8.6")
        post = capture(
            "post",
            ts(0.5),
            "0.9.0",
            overrides={
                (b, "temporal-relative"): {
                    "memory_ids": jaccard_shifted(b, "temporal-relative", 0.75)
                }
                for b in BANKS
            },
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 0, out)
        self.assertIn("GATE PASS", out)
        self.assertIn("27 ok, 3 expected-shift", out)
        self.assertIn("0 FAIL", out)

    def test_wp6_measured_reality_passes(self):
        """The real WP6 comparison-C numbers, live-before vs live-after.

        27/30 clean (two of them at 0.929/0.933, i.e. under organic drift but
        over the floor) and temporal-relative at overlord 0.793 / klanker 0.688
        / finn 0.782. This is the shape the WP7 window is expected to produce,
        and it must read as PASS with three declared expected shifts — not as
        a three-cell failure.
        """
        base = capture("pre", ts(0), "0.8.6")
        measured = {
            ("overlord", "temporal-relative"): 0.793,
            ("klanker", "temporal-relative"): 0.688,
            ("finn", "temporal-relative"): 0.782,
            ("overlord", "bm25-errorcode"): 0.933,
            ("klanker", "semantic-howto"): 0.929,
        }
        overrides = {
            (bank, qid): {"memory_ids": jaccard_shifted(bank, qid, j)}
            for (bank, qid), j in measured.items()
        }
        post = capture("post", ts(0.5), "0.9.0", overrides=overrides)
        code, out = run_main(base, post)
        self.assertEqual(code, 0, out)
        self.assertIn("GATE PASS", out)
        self.assertIn("27 ok, 3 expected-shift", out)
        self.assertIn("0 FAIL", out)
        # the two sub-floor-but-passing cells stay plain `ok`, not excused
        self.assertRegex(out, r"ok\s+overlord\s+bm25-errorcode\s+jaccard=0\.9")

    def test_declared_shift_is_always_reported_with_its_value(self):
        """An expected shift that vanishes from the output is how a regression hides."""
        base = capture("pre", ts(0), "0.8.6")
        overrides = {
            (b, "temporal-relative"): {"memory_ids": jaccard_shifted(b, "temporal-relative", 0.70)}
            for b in BANKS
        }
        post = capture("post", ts(0.5), "0.9.0", overrides=overrides)
        code, out = run_main(base, post)
        self.assertEqual(code, 0, out)
        self.assertIn("Declared expected-shift cells (reported, never silenced)", out)
        for bank in BANKS:
            self.assertRegex(out, rf"{bank}\s+temporal-relative\s+measured=0\.7")
        self.assertIn("switchroom#4533", out)


class TestKnownBad(unittest.TestCase):
    """Real regressions must come back RED."""

    def test_single_collapsed_cell_fails(self):
        base = capture("pre", ts(0), "0.8.6")
        post = capture(
            "post",
            ts(0.5),
            "0.9.0",
            overrides={
                ("klanker", "entity-person"): {
                    "memory_ids": jaccard_shifted("klanker", "entity-person", 0.40)
                }
            },
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 1, out)
        self.assertIn("GATE FAIL", out)
        self.assertRegex(out, r"FAIL\s+klanker\s+entity-person")

    def test_result_count_collapse_fails_even_at_high_jaccard(self):
        base = capture("pre", ts(0), "0.8.6")
        post = capture(
            "post",
            ts(0.5),
            "0.9.0",
            overrides={
                ("finn", "bm25-config-key"): {
                    "memory_ids": ids("finn", "bm25-config-key", n=40),
                    "result_count": 40,
                }
            },
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r"FAIL\s+finn\s+bm25-config-key")

    def test_error_in_post_capture_fails(self):
        base = capture("pre", ts(0), "0.8.6")
        post = capture(
            "post",
            ts(0.5),
            "0.9.0",
            overrides={("overlord", "persona-role"): {"error": "TimeoutError"}},
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 1, out)
        self.assertIn("TimeoutError", out)

    def test_declared_cell_below_its_band_still_fails(self):
        """The declaration is a BAND, not a licence to ignore the cell."""
        base = capture("pre", ts(0), "0.8.6")
        post = capture(
            "post",
            ts(0.5),
            "0.9.0",
            overrides={
                ("overlord", "temporal-relative"): {
                    "memory_ids": jaccard_shifted("overlord", "temporal-relative", 0.30)
                }
            },
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 1, out)
        self.assertIn("BELOW the declared band", out)

    def test_declared_shift_not_observed_is_reported_but_passes(self):
        """0.9.0 without the known temporal reshuffle is suspicious, not fatal."""
        base = capture("pre", ts(0), "0.8.6")
        post = capture("post", ts(0.5), "0.9.0")  # all cells identical
        code, out = run_main(base, post)
        self.assertEqual(code, 0, out)
        self.assertIn("expected-shift-not-observed", out)
        self.assertIn("the expected shift did not occur", out)

    def test_declaration_does_not_apply_outside_its_version_scope(self):
        """Self-retiring: past 0.9.0 the temporal cell is a plain cell again."""
        base = capture("pre", ts(0), "0.9.0")
        post = capture(
            "post",
            ts(0.5),
            "0.10.0",
            overrides={
                (b, "temporal-relative"): {
                    "memory_ids": jaccard_shifted(b, "temporal-relative", 0.70)
                }
                for b in BANKS
            },
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 1, out)
        self.assertIn("matched no cell", out)


class TestGateMisuse(unittest.TestCase):
    """The WP6 finding, encoded: an invalid comparison must not render a verdict."""

    def test_cross_instance_baseline_is_refused(self):
        """WP6 comparison B: live instance vs a fresh restore of its own dump.

        Same code, healthy data, 30/30 cells at 0.36-0.75. The old gate called
        that a failing upgrade. This one must call it what it is: not a valid
        comparison. Exit 2, not 1.
        """
        base = capture("pre", ts(0), "0.8.6", db_id=PROD_DB_ID)
        overrides = {
            (b, q): {"memory_ids": jaccard_shifted(b, q, 0.5)} for b in BANKS for q in QIDS
        }
        post = capture(
            "post",
            ts(0.5),
            "0.8.6",
            db_id=RESTORED_COPY_DB_ID,
            api_url="http://127.0.0.1:19999",
            overrides=overrides,
        )
        code, out = run_main(base, post)
        self.assertEqual(code, 2, out)
        self.assertIn("GATE MISUSE", out)
        self.assertIn("DIFFERENT instances", out)
        self.assertNotIn("GATE FAIL", out)

    def test_stale_baseline_is_refused(self):
        base = capture("pre", ts(-72), "0.8.6")
        post = capture("post", ts(0), "0.9.0")
        code, out = run_main(base, post)
        self.assertEqual(code, 2, out)
        self.assertIn("GATE MISUSE", out)
        self.assertIn("Re-capture the baseline", out)

    def test_stale_override_is_loud_and_marked_advisory(self):
        base = capture("pre", ts(-72), "0.8.6")
        post = capture("post", ts(0), "0.9.0")
        code, out = run_main(base, post, ["--allow-stale-baseline"])
        self.assertEqual(code, 0, out)
        self.assertIn("ADVISORY ONLY", out)

    def test_anchor_drift_is_refused(self):
        base = capture("pre", ts(0), "0.8.6", anchor="2026-08-08T00:00:00")
        post = capture("post", ts(0.5), "0.9.0", anchor="2026-08-11T00:00:00")
        code, out = run_main(base, post)
        self.assertEqual(code, 2, out)
        self.assertIn("anchors differ", out)

    def test_captures_the_wrong_way_round_are_refused(self):
        base = capture("post", ts(0), "0.9.0")
        post = capture("pre", ts(0.5), "0.8.6")
        code, out = run_main(base, post)
        self.assertEqual(code, 2, out)
        self.assertIn("expected 'pre'", out)

    def test_missing_cluster_identity_warns_but_proceeds(self):
        base = capture("pre", ts(0), "0.8.6", db_id=None)
        post = capture("post", ts(0.5), "0.9.0", db_id=None)
        code, out = run_main(base, post)
        self.assertEqual(code, 0, out)
        self.assertIn("cluster identity missing", out)
        self.assertIn("api_url-deep", out)


class TestExpectedShiftsFile(unittest.TestCase):
    def test_shipped_declarations_are_well_formed(self):
        shifts = cb.load_shifts(SHIFTS_PATH)
        self.assertTrue(shifts)
        for s in shifts:
            self.assertIn(s["query_id"], QIDS)
            self.assertLess(s["jaccard_min"], s["jaccard_max"])
            self.assertGreaterEqual(s["jaccard_min"], 0.0)
            self.assertLessEqual(s["jaccard_max"], 1.0)
            for field in ("reason", "evidence", "issue"):
                self.assertTrue(s.get(field), f"{s['query_id']} missing {field}")

    def test_temporal_band_covers_every_wp6_measurement(self):
        """The band must actually contain what WP6 measured: 0.688-0.793."""
        shift = next(
            s for s in cb.load_shifts(SHIFTS_PATH) if s["query_id"] == "temporal-relative"
        )
        for measured in (0.688, 0.716, 0.782, 0.793):
            self.assertGreaterEqual(measured, shift["jaccard_min"])
            self.assertLessEqual(measured, shift["jaccard_max"])
        # ...and must NOT be so wide it swallows the WP6 comparison-B artefact
        # range (0.36-0.75 was same-code drift; the low end must stay a FAIL).
        self.assertGreater(shift["jaccard_min"], 0.36)


if __name__ == "__main__":
    unittest.main()
