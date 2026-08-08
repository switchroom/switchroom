#!/usr/bin/env python3
"""WP0 (issue #4527) — Hindsight 0.8.6 -> 0.9.0 soak measurement.

Counts cache-miss recalls and computes median / p90 latency per busy agent
from each agent's recall_log.jsonl, over a window that starts at the
2026-08-07 pg_search cutover.

Re-run this VERBATIM post-flight (with --since set to the 0.9.0 rollout
timestamp) so the post-bump number is produced by the same code path as the
frozen baseline rather than a hand-rolled approximation.

Usage:
  soak_measure.py [--since ISO8601Z] [--until ISO8601Z]
                  [--agents overlord,klanker,finn] [--json OUT.json]

Read-only. Touches nothing but the log files.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

# 2026-08-07 pg_search cutover. Corroborated by
# /host-home/.switchroom/backups/switchroom.yaml.bak-pg_search-20260807T205206
# (local AEST = UTC+10 -> 2026-08-07T10:52:06Z).
CUTOVER = "2026-08-07T10:52:06Z"

# Default is the host path as seen from the root-tier debugging agent's
# container. Override with --agents-dir / HINDSIGHT_AGENTS_DIR when running
# from the host itself (~/.switchroom/agents) or any other layout.
AGENTS_DIR = os.environ.get("HINDSIGHT_AGENTS_DIR", "/host-home/.switchroom/agents")
LOG_REL = ".claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl"


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def pct(sorted_vals, q):
    """Nearest-rank percentile (deterministic, no interpolation)."""
    if not sorted_vals:
        return None
    k = max(0, min(len(sorted_vals) - 1, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def median(sorted_vals):
    n = len(sorted_vals)
    if n == 0:
        return None
    if n % 2:
        return float(sorted_vals[n // 2])
    return (sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2.0


def measure(agent, since, until, log_path=None, agents_dir=None):
    path = log_path or os.path.join(agents_dir or AGENTS_DIR, agent, LOG_REL)
    out = {
        "agent": agent,
        "log_path": path,
        "rows_total": 0,
        "rows_in_window": 0,
        "cache_miss": 0,
        "cache_hit": 0,
        "errored": 0,
        "malformed": 0,
        "days_covered": [],
        "first_ts": None,
        "last_ts": None,
    }
    if not os.path.exists(path):
        out["error"] = "log not found"
        return out

    total_ms, dur_ms, res_counts = [], [], []
    days = set()
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            out["rows_total"] += 1
            try:
                r = json.loads(line)
            except Exception:
                out["malformed"] += 1
                continue
            ts = parse_ts(r.get("ts"))
            if ts is None or ts < since or ts > until:
                continue
            out["rows_in_window"] += 1
            if out["first_ts"] is None:
                out["first_ts"] = r.get("ts")
            out["last_ts"] = r.get("ts")
            if r.get("cache_hit"):
                out["cache_hit"] += 1
                continue
            out["cache_miss"] += 1
            days.add(ts.date().isoformat())
            if r.get("error"):
                out["errored"] += 1
            t = r.get("total_elapsed_ms")
            if isinstance(t, (int, float)):
                total_ms.append(t)
            d = r.get("duration_ms")
            if isinstance(d, (int, float)):
                dur_ms.append(d)
            c = r.get("result_count")
            if isinstance(c, (int, float)):
                res_counts.append(c)

    total_ms.sort()
    dur_ms.sort()
    res_counts.sort()
    out["days_covered"] = sorted(days)
    out["total_elapsed_ms"] = {
        "n": len(total_ms),
        "median": median(total_ms),
        "p90": pct(total_ms, 0.90),
        "p95": pct(total_ms, 0.95),
        "min": total_ms[0] if total_ms else None,
        "max": total_ms[-1] if total_ms else None,
    }
    out["duration_ms"] = {
        "n": len(dur_ms),
        "median": median(dur_ms),
        "p90": pct(dur_ms, 0.90),
    }
    out["result_count"] = {
        "n": len(res_counts),
        "median": median(res_counts),
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=CUTOVER)
    ap.add_argument("--until", default=None)
    ap.add_argument("--agents", default="overlord,klanker,finn")
    ap.add_argument("--threshold", type=int, default=300)
    ap.add_argument("--agents-dir", default=AGENTS_DIR)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args()

    since = parse_ts(args.since)
    until = parse_ts(args.until) if args.until else datetime.now(timezone.utc)
    if since is None:
        sys.exit("bad --since")

    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_until": until.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "threshold_cache_miss_recalls": args.threshold,
        "agents": [measure(a, since, until, agents_dir=args.agents_dir) for a in agents],
    }
    report["threshold_met_all"] = all(
        a["cache_miss"] >= args.threshold for a in report["agents"]
    )

    w = 3600.0 * 24
    for a in report["agents"]:
        f, l = parse_ts(a.get("first_ts")), parse_ts(a.get("last_ts"))
        elapsed_days = (until - since).total_seconds() / w
        a["rate_cache_miss_per_day"] = (
            round(a["cache_miss"] / elapsed_days, 1) if elapsed_days > 0 else None
        )
        a["threshold_met"] = a["cache_miss"] >= args.threshold
        a["active_span_hours"] = (
            round((l - f).total_seconds() / 3600.0, 1) if f and l else None
        )

    txt = json.dumps(report, indent=2)
    print(txt)
    if args.json_out:
        with open(args.json_out, "w") as fh:
            fh.write(txt + "\n")


if __name__ == "__main__":
    main()
