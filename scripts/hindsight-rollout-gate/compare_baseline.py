#!/usr/bin/env python3
"""Hindsight rollout gate — live-before vs live-after comparator.

Diffs a post-upgrade `canned_recall.py` capture against a pre-upgrade capture,
per (bank, query): Jaccard over memory_ids, result_count delta, latency delta.

WHY THIS IS NOT THE ORIGINAL SCRIPT
-----------------------------------
The original compared "the frozen WP0 baseline" against whatever it was handed
and flagged Jaccard < 0.8. WP6 (switchroom#4533) ran the control that decides
whether that number means anything: the SAME code (0.8.6) against a fresh
restore of the live instance's own dump. Result: 30/30 cells flagged at
0.36-0.75. Identical code, healthy data, fully red board.

So the 0.8 floor is only meaningful **live-before vs live-after on the same
running instance, with the pre-capture taken minutes beforehand**. Everything
else it measures is physical/statistics drift. The original script could not
tell the two situations apart because the artifact recorded neither which
instance it came from nor how stale it was.

This version therefore does three things the original did not:

1. **Refuses a comparison it cannot justify.** Instance identity and capture
   freshness are checked, not assumed, and a violation exits 2 (GATE MISUSE) -
   a distinct code from 1 (cells failed), so a runbook can tell "the gate says
   no" apart from "you used the gate wrong".

2. **Classifies declared expected shifts** from `expected_shifts.json` instead
   of failing them - while still PRINTING every one with its measured value in
   its own report section, and reporting when a declared shift did not occur.
   An expected shift that silently disappears from the output is how a real
   regression hides.

3. **Is testable.** `evaluate()` is a pure function over two capture dicts;
   `tests/test_compare_baseline.py` drives it against known-good and known-bad
   inputs. A gate nobody has tested against a known-bad input is not a gate.

Exit codes:
  0  gate PASS   (no failures; expected shifts may be present and are listed)
  1  gate FAIL   (at least one failing cell)
  2  GATE MISUSE (the two captures are not validly comparable - not a verdict
                  about the upgrade)

Usage:
  compare_baseline.py --baseline pre.json --post post.json
  compare_baseline.py --baseline pre.json --post post.json --json report.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

JACCARD_FLOOR = 0.8
COUNT_TOLERANCE = 0.25
# "Minutes, not days" (stage-4 validation, switchroom#4525). Four hours is a
# generous maintenance window, not a licence to reuse yesterday's capture.
DEFAULT_MAX_BASELINE_AGE_HOURS = 4.0

DEFAULT_SHIFTS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "expected_shifts.json"
)

OK = "ok"
EXPECTED_SHIFT = "expected-shift"
SHIFT_NOT_OBSERVED = "expected-shift-not-observed"
FAIL = "FAIL"


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except ValueError:
        return None


def load_shifts(path):
    if not path:
        return []
    with open(path) as fh:
        return json.load(fh).get("shifts", [])


def _shift_applies(shift, bank, qid, base_ver, post_ver):
    if shift.get("query_id") != qid:
        return False
    banks = shift.get("banks", "*")
    if banks != "*" and bank not in banks:
        return False
    fv, tv = shift.get("from_api_version"), shift.get("to_api_version")
    if fv is not None and base_ver != fv:
        return False
    if tv is not None and post_ver != tv:
        return False
    return True


def check_comparability(base, post, max_age_hours, allow_cross_instance, allow_stale):
    """Return (errors, warnings, baseline_age_hours).

    A non-empty ``errors`` means: refuse to render a verdict at all. These are
    statements about the INPUTS, not about the upgrade.
    """
    errors, warnings = [], []

    bi = base.get("instance") or {}
    pi = post.get("instance") or {}

    # --- phase ordering -----------------------------------------------------
    bp, pp = base.get("phase"), post.get("phase")
    if bp is not None and bp != "pre":
        errors.append(f"--baseline is a '{bp}' capture, expected 'pre'")
    if pp is not None and pp != "post":
        errors.append(f"--post is a '{pp}' capture, expected 'post'")
    if bp is None or pp is None:
        warnings.append(
            "one or both captures predate schema_version 2 and carry no phase "
            "marker; pre/post ordering could not be checked"
        )

    # --- pinned recency anchor ---------------------------------------------
    ba, pa = base.get("query_timestamp_anchor"), post.get("query_timestamp_anchor")
    if ba != pa:
        errors.append(
            f"query_timestamp anchors differ ({ba} vs {pa}) - recency scoring "
            "keys off this, so the two runs are not comparable at all"
        )

    # --- instance identity --------------------------------------------------
    bdb, pdb = bi.get("db_system_identifier"), pi.get("db_system_identifier")
    burl, purl = bi.get("api_url"), pi.get("api_url")
    bid, pid = bi.get("instance_id"), pi.get("instance_id")

    identity_msgs = []
    if bdb and pdb and bdb != pdb:
        identity_msgs.append(
            f"database cluster identity differs ({bdb} vs {pdb}) - these are "
            "DIFFERENT instances (e.g. one is a restore of the other's dump). "
            "This is exactly the comparison WP6 proved meaningless."
        )
    if burl and purl and burl != purl:
        identity_msgs.append(f"api_url differs ({burl} vs {purl})")
    if bid and pid and bid != pid:
        identity_msgs.append(f"instance_id differs ({bid} vs {pid})")

    if identity_msgs:
        if allow_cross_instance:
            warnings.extend("OVERRIDDEN: " + m for m in identity_msgs)
            warnings.append(
                "--allow-cross-instance was passed: the Jaccard numbers below "
                "are ADVISORY ONLY and must not be used as a rollout gate."
            )
        else:
            errors.extend(identity_msgs)

    if not (bdb and pdb):
        warnings.append(
            "cluster identity missing on at least one capture "
            f"(baseline={bdb!r}, post={pdb!r}); identity was only checked "
            "api_url-deep, which does NOT catch a repoint to different data"
        )

    if bi.get("banks_fingerprint") != pi.get("banks_fingerprint"):
        warnings.append(
            "bank inventory changed between captures "
            f"({bi.get('banks_fingerprint')} vs {pi.get('banks_fingerprint')})"
        )

    # --- freshness ----------------------------------------------------------
    bt, pt = parse_ts(base.get("generated_at")), parse_ts(post.get("generated_at"))
    age_hours = None
    if bt and pt:
        age_hours = (pt - bt).total_seconds() / 3600.0
        if age_hours < 0:
            errors.append(
                f"baseline was captured AFTER the post run ({bt} > {pt}) - "
                "the two files are the wrong way round"
            )
        elif age_hours > max_age_hours:
            msg = (
                f"baseline is {age_hours:.1f}h older than the post run "
                f"(bound {max_age_hours:.1f}h). A stale baseline absorbs hours "
                "of organic ingest and false-alarms on its own. Re-capture the "
                "baseline immediately before the window."
            )
            if allow_stale:
                warnings.append("OVERRIDDEN: " + msg)
                warnings.append(
                    "--allow-stale-baseline was passed: results are ADVISORY "
                    "ONLY and must not be used as a rollout gate."
                )
            else:
                errors.append(msg)
    else:
        warnings.append("capture timestamps missing; freshness not checked")

    return errors, warnings, age_hours


def evaluate(base, post, shifts, jaccard_floor=JACCARD_FLOOR,
             count_tolerance=COUNT_TOLERANCE):
    """Pure: classify every cell. No I/O, no exits - this is what the tests drive."""
    base_ver = (base.get("instance") or {}).get("api_version")
    post_ver = (post.get("instance") or {}).get("api_version")

    cells = []
    matched_shifts = set()
    for bank, qmap in sorted(base.get("results", {}).items()):
        for qid, b in sorted(qmap.items()):
            cell = {"bank": bank, "query_id": qid}
            p = post.get("results", {}).get(bank, {}).get(qid)
            if p is None:
                cell.update(status=FAIL, detail="missing from post capture")
                cells.append(cell)
                continue
            if b.get("error") or p.get("error"):
                cell.update(
                    status=FAIL,
                    detail=f"error base={b.get('error')} post={p.get('error')}",
                )
                cells.append(cell)
                continue

            a, c = set(b.get("memory_ids") or []), set(p.get("memory_ids") or [])
            j = len(a & c) / len(a | c) if (a | c) else 1.0
            nb, np_ = b.get("result_count", 0), p.get("result_count", 0)
            dn = (np_ - nb) / nb if nb else 0.0
            cell.update(
                jaccard=round(j, 3),
                count_base=nb,
                count_post=np_,
                count_delta=round(dn, 4),
                latency_base_ms=b.get("elapsed_ms"),
                latency_post_ms=p.get("elapsed_ms"),
            )

            count_bad = abs(dn) > count_tolerance
            shift = next(
                (s for s in shifts if _shift_applies(s, bank, qid, base_ver, post_ver)),
                None,
            )
            if shift is not None:
                matched_shifts.add(id(shift))
                lo, hi = shift.get("jaccard_min", 0.0), shift.get("jaccard_max", 1.0)
                cell["declared_shift"] = {
                    "band": [lo, hi],
                    "reason": shift.get("reason"),
                    "issue": shift.get("issue"),
                }
                if j > hi:
                    # The declared shift did NOT happen. Not a failure, but it
                    # must be visible: a declaration that stops matching
                    # reality is a stale declaration.
                    cell["status"] = SHIFT_NOT_OBSERVED
                    cell["detail"] = (
                        f"jaccard {j:.3f} is ABOVE the declared band "
                        f"[{lo}, {hi}] - the expected shift did not occur"
                    )
                elif j < lo:
                    cell["status"] = FAIL
                    cell["detail"] = (
                        f"jaccard {j:.3f} is BELOW the declared band "
                        f"[{lo}, {hi}] - worse than the declared expectation"
                    )
                elif count_bad:
                    cell["status"] = FAIL
                    cell["detail"] = (
                        f"jaccard within declared band but result_count moved "
                        f"{dn:+.0%} (>{count_tolerance:.0%}); the declared "
                        "shift is count-neutral, so this is not it"
                    )
                else:
                    cell["status"] = EXPECTED_SHIFT
                    cell["detail"] = f"within declared band [{lo}, {hi}]"
            else:
                bad = j < jaccard_floor or count_bad
                cell["status"] = FAIL if bad else OK
                if bad:
                    why = []
                    if j < jaccard_floor:
                        why.append(f"jaccard {j:.3f} < {jaccard_floor}")
                    if count_bad:
                        why.append(f"result_count {dn:+.0%} > {count_tolerance:.0%}")
                    cell["detail"] = "; ".join(why)
            cells.append(cell)

    # Cells present in post but absent from baseline - a silently added query
    # would otherwise never be looked at.
    for bank, qmap in sorted(post.get("results", {}).items()):
        for qid in sorted(qmap):
            if qid not in base.get("results", {}).get(bank, {}):
                cells.append(
                    {
                        "bank": bank,
                        "query_id": qid,
                        "status": FAIL,
                        "detail": "present in post capture but missing from baseline",
                    }
                )

    unmatched = [
        {
            "query_id": s.get("query_id"),
            "from_api_version": s.get("from_api_version"),
            "to_api_version": s.get("to_api_version"),
        }
        for s in shifts
        if id(s) not in matched_shifts
    ]

    counts = {
        OK: sum(1 for c in cells if c["status"] == OK),
        EXPECTED_SHIFT: sum(1 for c in cells if c["status"] == EXPECTED_SHIFT),
        SHIFT_NOT_OBSERVED: sum(1 for c in cells if c["status"] == SHIFT_NOT_OBSERVED),
        FAIL: sum(1 for c in cells if c["status"] == FAIL),
    }
    return {
        "cells": cells,
        "counts": counts,
        "total_cells": len(cells),
        "unmatched_declarations": unmatched,
        "base_api_version": base_ver,
        "post_api_version": post_ver,
        "passed": counts[FAIL] == 0,
    }


def render(report, errors, warnings, age_hours, advisory):
    out = []
    if errors:
        out.append("GATE MISUSE - refusing to render a verdict:")
        out.extend(f"  ERROR  {e}" for e in errors)
        out.append("")
        out.append(
            "  These are not findings about the upgrade. Fix the inputs "
            "(re-capture the baseline live against the same instance, "
            "immediately before the window) and re-run."
        )
        return "\n".join(out)

    for w in warnings:
        out.append(f"WARNING  {w}")
    if warnings:
        out.append("")

    out.append(
        f"api_version {report['base_api_version']} -> {report['post_api_version']}"
        + (f"   baseline age {age_hours:.2f}h" if age_hours is not None else "")
    )
    out.append("")
    for c in report["cells"]:
        if "jaccard" in c:
            line = (
                f"{c['status']:28} {c['bank']:16} {c['query_id']:20} "
                f"jaccard={c['jaccard']:.3f} "
                f"n {c['count_base']}->{c['count_post']} "
                f"({c['count_delta']:+.0%}) "
                f"lat {c['latency_base_ms']}->{c['latency_post_ms']}ms"
            )
        else:
            line = f"{c['status']:28} {c['bank']:16} {c['query_id']:20}"
        if c.get("detail") and c["status"] != OK:
            line += f"   [{c['detail']}]"
        out.append(line)

    # Declared shifts ALWAYS get their own section, with their measured value.
    declared = [c for c in report["cells"] if "declared_shift" in c]
    out.append("")
    if declared:
        out.append("Declared expected-shift cells (reported, never silenced):")
        for c in declared:
            lo, hi = c["declared_shift"]["band"]
            out.append(
                f"  {c['bank']:16} {c['query_id']:20} measured={c['jaccard']:.3f} "
                f"declared=[{lo}, {hi}] -> {c['status']}"
            )
            out.append(f"      {c['declared_shift']['issue']}: "
                       f"{(c['declared_shift']['reason'] or '')[:140]}")
    else:
        out.append("Declared expected-shift cells: none applied to this comparison.")

    if report["unmatched_declarations"]:
        out.append("")
        out.append(
            "NOTE: declarations that matched no cell in this comparison "
            "(stale, or out of version scope):"
        )
        for u in report["unmatched_declarations"]:
            out.append(
                f"  {u['query_id']} ({u['from_api_version']} -> "
                f"{u['to_api_version']})"
            )

    ct = report["counts"]
    out.append("")
    out.append(
        f"{report['total_cells']} cells: {ct[OK]} ok, "
        f"{ct[EXPECTED_SHIFT]} expected-shift, "
        f"{ct[SHIFT_NOT_OBSERVED]} expected-shift-not-observed, "
        f"{ct[FAIL]} FAIL"
    )
    verdict = "PASS" if report["passed"] else "FAIL"
    if advisory:
        verdict += " (ADVISORY ONLY - overrides in effect, not a valid gate)"
    out.append(f"GATE {verdict}")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True, help="the 'pre' capture")
    ap.add_argument("--post", required=True, help="the 'post' capture")
    ap.add_argument("--expected-shifts", default=DEFAULT_SHIFTS_PATH)
    ap.add_argument("--no-expected-shifts", action="store_true")
    ap.add_argument("--jaccard-floor", type=float, default=JACCARD_FLOOR)
    ap.add_argument("--count-tolerance", type=float, default=COUNT_TOLERANCE)
    ap.add_argument(
        "--max-baseline-age-hours", type=float, default=DEFAULT_MAX_BASELINE_AGE_HOURS
    )
    ap.add_argument(
        "--allow-cross-instance",
        action="store_true",
        help="Downgrade an instance-identity mismatch to a warning. Output "
        "becomes advisory and is NOT a valid gate.",
    )
    ap.add_argument(
        "--allow-stale-baseline",
        action="store_true",
        help="Downgrade a stale baseline to a warning. Output becomes "
        "advisory and is NOT a valid gate.",
    )
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args(argv)

    with open(args.baseline) as fh:
        base = json.load(fh)
    with open(args.post) as fh:
        post = json.load(fh)

    shifts = [] if args.no_expected_shifts else load_shifts(args.expected_shifts)

    errors, warnings, age_hours = check_comparability(
        base,
        post,
        args.max_baseline_age_hours,
        args.allow_cross_instance,
        args.allow_stale_baseline,
    )
    advisory = args.allow_cross_instance or args.allow_stale_baseline

    if errors:
        print(render({}, errors, warnings, age_hours, advisory))
        return 2

    report = evaluate(
        base, post, shifts, args.jaccard_floor, args.count_tolerance
    )
    print(render(report, [], warnings, age_hours, advisory))

    if args.json_out:
        payload = dict(report)
        payload["warnings"] = warnings
        payload["baseline_age_hours"] = age_hours
        payload["advisory_only"] = advisory
        with open(args.json_out, "w") as fh:
            fh.write(json.dumps(payload, indent=2) + "\n")

    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
