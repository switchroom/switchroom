#!/usr/bin/env python3
"""Derive the AGGREGATE shape of real recall traffic (#4479).

The query set is authored, not sampled, because this repository is public and
the banks are a live operator's private memory. But an authored set that does
not resemble real traffic tests the wrong thing, so the families and the length
distribution in `queryset/v1.yaml` are shaped by the statistics this script
produces, and its `provenance.shaped_by` block records them.

This script is what makes that provenance claim checkable rather than asserted.

**It cannot emit query text, because the source does not contain any.** The
hindsight-memory-inline plugin's `recall_log.jsonl` records `query_chars` (an
integer length) and never the query itself; the only free-form field it carries
is a bank id, which this script hashes. The output is counts, percentiles and
rates. Run it, paste the numbers into `provenance.shaped_by`, and commit the
numbers — never the log.

Usage::

    python3 evals/recall/derive_shape.py \\
        --glob '~/.switchroom/agents/*/.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl'

Default glob points at a local fleet install. On a machine with no such logs the
script exits 0 with `rows_observed: 0` rather than failing: shaping input is
nice to have, and CI must never depend on a file that cannot be committed.
"""

from __future__ import annotations

import argparse
import glob as globmod
import hashlib
import json
import statistics
import sys
from pathlib import Path

DEFAULT_GLOB = (
    "~/.switchroom/agents/*/.claude/plugins/data/"
    "hindsight-memory-inline/state/recall_log.jsonl"
)

# Fields worth reading. Anything not listed is ignored rather than aggregated,
# so a future field carrying text cannot silently start flowing into output.
NUMERIC_FIELDS = ("query_chars", "result_count", "pre_cap_count", "demoted_count")


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round(q * (len(ordered) - 1)))))
    return float(ordered[idx])


def derive(paths: list[Path]) -> dict:
    rows = 0
    malformed = 0
    chars: list[float] = []
    results: list[float] = []
    zero_result = 0
    capped = 0
    cache_hits = 0
    banks: set[str] = set()

    for path in paths:
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if not isinstance(row, dict):
                malformed += 1
                continue
            rows += 1
            if isinstance(row.get("query_chars"), (int, float)):
                chars.append(float(row["query_chars"]))
            count = row.get("result_count")
            if isinstance(count, (int, float)):
                results.append(float(count))
                if count == 0:
                    zero_result += 1
            if row.get("capped"):
                capped += 1
            if row.get("cache_hit"):
                cache_hits += 1
            bank = row.get("bank_id")
            if isinstance(bank, str) and bank:
                # Hashed: bank ids are the operator's agent names and this
                # output is meant to be pasteable into a public repo.
                banks.add(hashlib.sha256(bank.encode()).hexdigest()[:8])

    out: dict = {
        "rows_observed": rows,
        "malformed_lines": malformed,
        "distinct_banks": len(banks),
        "files_read": len(paths),
    }
    if rows:
        out.update(
            {
                "query_chars_p50": round(percentile(chars, 0.50)),
                "query_chars_p90": round(percentile(chars, 0.90)),
                "query_chars_max": round(max(chars)) if chars else 0,
                "query_chars_mean": round(statistics.fmean(chars), 1) if chars else 0.0,
                "result_count_p50": round(percentile(results, 0.50)),
                "final_zero_result_rate": round(zero_result / rows, 4),
                "capped_rate": round(capped / rows, 4),
                "cache_hit_rate": round(cache_hits / rows, 4),
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="aggregate-only shape statistics for real recall traffic"
    )
    parser.add_argument("--glob", default=DEFAULT_GLOB, help="recall_log.jsonl glob")
    args = parser.parse_args(argv)

    pattern = str(Path(args.glob).expanduser())
    paths = [Path(p) for p in sorted(globmod.glob(pattern))]
    stats = derive(paths)

    if not stats["rows_observed"]:
        print(
            f"no recall_log rows matched {pattern!r}; nothing to derive. "
            "This is not an error: the logs are local-only and never committed.",
            file=sys.stderr,
        )
    print(json.dumps(stats, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
