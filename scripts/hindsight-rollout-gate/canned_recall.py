#!/usr/bin/env python3
"""Hindsight rollout gate — canned recall result-set capture.

Runs a FIXED set of recall queries against a FIXED set of banks through the
Hindsight HTTP API and records, per (bank, query): result_count, the ordered
memory_ids, and server round-trip latency.

Originally WP0 (switchroom#4527) of the Hindsight 0.8.6 -> 0.9.0 bump. Reworked
after WP6 (switchroom#4533) proved the original capture/compare pair produced a
fully-red board on healthy data — see README.md "Why this is shaped like this".

WHAT CHANGED, AND WHY IT MATTERS
--------------------------------
The capture now records an INSTANCE IDENTITY block and a capture timestamp, so
`compare_baseline.py` can *check* rather than *assume* that the two runs it is
handed came from the same live instance minutes apart. WP6's control experiment
compared a live instance against a fresh restore of that instance's own dump,
with byte-identical code on both sides, and scored 0.36-0.75 Jaccard on 30/30
cells. Nothing was wrong with the data; the comparison was simply not a valid
one, and nothing in the artifact recorded enough to notice.

The identity components, and what each is for:

  * ``api_url``           - normalised endpoint. Catches "baseline came from the
                            staging container, post came from prod".
  * ``db_system_identifier`` - Postgres cluster identity, read read-only from
                            ``pg_controldata``. This is the strong one: it is
                            INVARIANT across an application-image upgrade (same
                            data directory) and DIFFERENT on any ``pg_restore``
                            into a fresh cluster. It is exactly the signal that
                            would have caught WP6's comparison B.
  * ``instance_id``       - optional operator label, for deployments where the
                            two above are not enough.

Recorded but deliberately NOT part of identity: ``api_version`` (it is supposed
to change across the upgrade - that is the point) and the bank fingerprint
(a bank added between capture and compare is a comparability note, not a
different instance).

Determinism notes (why the knobs below are pinned):
  * query_timestamp is PINNED. Recall's recency scoring and relative temporal
    parsing anchor on it; leaving it to "now" would make the two runs
    incomparable by construction. Both runs of a gate MUST use the same anchor;
    the comparator hard-refuses if they differ.
  * budget / max_tokens / types / tags are pinned to the recall hook's
    effective production shape so the captured sets exercise the same
    retrieval stages the fleet actually uses.
  * Residual, unavoidable: the banks keep ingesting between the two captures,
    so some drift is organic, not a regression. That residual is bounded by
    keeping the two captures MINUTES apart, not days - which is why
    ``compare_baseline.py`` enforces a freshness bound.

Read-only: recall does not mutate memories, and the db-identity probe is
``pg_controldata``, which only reads the control file.

Usage:
  canned_recall.py --out pre.json --phase pre  [--api-url URL]
"""

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

# Pinned query-time anchor. Both captures of a single gate run MUST share it.
# The driver (`rollout_gate.sh`) passes the pre-capture's anchor through to the
# post-capture so this cannot drift by accident.
QUERY_TIMESTAMP = "2026-08-08T00:00:00"

# The busy banks the soak measures (plan Sec.10 WP0: overlord, klanker, finn).
# switchroom-dev was rejected as a bank: 13 nodes, not representative of a
# production retrieval path.
BANKS = ["overlord", "klanker", "finn"]

# Ten canned queries, chosen to cover every retrieval stage the bump can
# plausibly perturb (patch blocks 520/616 BM25, 2999 rerank, 4109 temporal,
# entity resolution) rather than ten variations of one stage.
QUERIES = [
    # 1-3: BM25 / compound-token path (patch 520 keeps compound tokens
    # intact; 616 is the regconfig fallback). Identifier-shaped queries are
    # the ones that go wrong first if tokenization drifts.
    ("bm25-config-key", "HINDSIGHT_API_TEXT_SEARCH_EXTENSION pg_search"),
    ("bm25-identifier", "recall_log.jsonl cache_hit total_elapsed_ms"),
    ("bm25-errorcode", "SQLSTATE 42704 regconfig fallback"),
    # 4-5: semantic / natural-language path (no rare literals to latch onto).
    ("semantic-decision", "what did we decide about upgrading the memory server"),
    ("semantic-howto", "how do I restart a container and check that it came back healthy"),
    # 6: temporal expression - exercises the query analyzer / temporal
    # extraction path touched by patch 4109 and env R3. THIS IS THE DECLARED
    # EXPECTED-SHIFT CELL for 0.8.6 -> 0.9.0; see expected_shifts.json.
    ("temporal-relative", "what did we work on last week"),
    # 7: entity-resolution path (proper nouns -> entities trgm).
    ("entity-person", "Ken Thompson preference"),
    # 8: mixed rare-token + prose, the common real shape.
    ("mixed-paradedb", "ParadeDB BM25 index on memory_units text search"),
    # 9: identity/persona - hits each bank's densest own-content region.
    ("persona-role", "who am I and what is my role here"),
    # 10: operational prose, long-tail recall.
    ("ops-procedure", "rollout procedure and what to check before deploying"),
]

BUDGET = "mid"
MAX_TOKENS = 4096
TYPES = None  # server default: world + experience

# Read-only probe for the Postgres cluster identity behind the API. Hindsight
# embeds its own pg0 instance in the API container, so this reaches it through
# the docker socket. Override with --db-identity-cmd for any other topology;
# whatever it is, it MUST be read-only and print a single stable token.
DEFAULT_DB_IDENTITY_CMD = (
    "docker exec switchroom-hindsight sh -c "
    "'/home/hindsight/.pg0/installation/*/bin/pg_controldata "
    "-D /home/hindsight/.pg0/instances/hindsight/data' "
    "| sed -n 's/^Database system identifier: *//p'"
)


def _get_json(url, timeout=15):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def normalise_api_url(url):
    """Strip trailing slash so 'http://h:1/' and 'http://h:1' are one instance."""
    return url.rstrip("/")


def probe_db_identity(cmd, timeout=30):
    """Run the read-only cluster-identity probe. Returns (value, error)."""
    if not cmd:
        return None, "disabled"
    try:
        p = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if p.returncode != 0:
        return None, f"exit {p.returncode}: {(p.stderr or '').strip()[:200]}"
    val = (p.stdout or "").strip()
    if not val:
        return None, "probe produced no output"
    # Guard against a probe that accidentally prints a whole file.
    if len(val) > 200 or "\n" in val:
        return None, "probe output is not a single token"
    return val, None


def capture_instance(api_url, instance_id, db_identity_cmd):
    """Everything needed to decide, later, WHETHER two captures are comparable."""
    inst = {
        "api_url": normalise_api_url(api_url),
        "instance_id": instance_id,
        "db_system_identifier": None,
        "db_identity_error": None,
        # Recorded for the report, NOT identity - api_version is expected to
        # change across the very upgrade this gate measures.
        "api_version": None,
        "features": None,
        "health": None,
        "banks_fingerprint": None,
        "banks_seen": None,
    }
    inst["db_system_identifier"], inst["db_identity_error"] = probe_db_identity(
        db_identity_cmd
    )
    base = normalise_api_url(api_url)
    try:
        v = _get_json(f"{base}/version")
        inst["api_version"] = v.get("api_version")
        inst["features"] = v.get("features")
    except Exception as e:  # noqa: BLE001 - best effort, recorded not raised
        inst["api_version"] = f"ERROR {type(e).__name__}"
    try:
        inst["health"] = _get_json(f"{base}/health").get("status")
    except Exception as e:  # noqa: BLE001
        inst["health"] = f"ERROR {type(e).__name__}"
    try:
        banks = sorted(
            b.get("bank_id") for b in _get_json(f"{base}/v1/default/banks")["banks"]
        )
        inst["banks_seen"] = banks
        inst["banks_fingerprint"] = hashlib.sha256(
            "\n".join(banks).encode()
        ).hexdigest()[:16]
    except Exception as e:  # noqa: BLE001
        inst["banks_fingerprint"] = f"ERROR {type(e).__name__}"
    return inst


def recall(api_url, bank, query, query_timestamp, timeout=60):
    url = f"{normalise_api_url(api_url)}/v1/default/banks/{bank}/memories/recall"
    body = {
        "query": query,
        "budget": BUDGET,
        "max_tokens": MAX_TOKENS,
        "query_timestamp": query_timestamp,
    }
    if TYPES:
        body["types"] = TYPES
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    mems = payload.get("memories") or payload.get("results") or []
    ids = [m.get("id") or m.get("memory_id") for m in mems]
    return {
        "result_count": len(ids),
        "memory_ids": ids,
        "elapsed_ms": elapsed_ms,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-url", default=os.environ.get("HINDSIGHT_API_URL"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--banks", default=",".join(BANKS))
    ap.add_argument(
        "--phase",
        choices=["pre", "post"],
        required=True,
        help="pre = baseline captured immediately BEFORE the maintenance "
        "window; post = the run captured after it. Recorded in the artifact "
        "so the comparator can refuse a pre/pre or post/pre mix-up.",
    )
    ap.add_argument(
        "--query-timestamp",
        default=QUERY_TIMESTAMP,
        help="Pinned recency anchor. Both captures of a gate run must match.",
    )
    ap.add_argument(
        "--instance-id",
        default=os.environ.get("HINDSIGHT_INSTANCE_ID"),
        help="Optional operator label for this instance (e.g. 'prod').",
    )
    ap.add_argument(
        "--db-identity-cmd",
        default=os.environ.get("HINDSIGHT_DB_IDENTITY_CMD", DEFAULT_DB_IDENTITY_CMD),
        help="Read-only shell command printing a stable cluster identity.",
    )
    ap.add_argument(
        "--no-db-identity",
        action="store_true",
        help="Skip the cluster-identity probe. The comparator will then only "
        "be able to check identity URL-deep, and says so loudly.",
    )
    args = ap.parse_args()
    if not args.api_url:
        raise SystemExit("HINDSIGHT_API_URL not set and --api-url not given")

    banks = [b.strip() for b in args.banks.split(",") if b.strip()]
    instance = capture_instance(
        args.api_url,
        args.instance_id,
        None if args.no_db_identity else args.db_identity_cmd,
    )
    if instance["db_system_identifier"] is None:
        print(
            "WARNING: cluster identity unavailable "
            f"({instance['db_identity_error']}). This capture can only be "
            "identity-checked by api_url. See README 'Instance identity'.",
            flush=True,
        )
    else:
        print(
            f"instance: {instance['api_url']} "
            f"db={instance['db_system_identifier']} "
            f"api_version={instance['api_version']}",
            flush=True,
        )

    out = {
        "schema_version": 2,
        "phase": args.phase,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "query_timestamp_anchor": args.query_timestamp,
        "budget": BUDGET,
        "max_tokens": MAX_TOKENS,
        "instance": instance,
        "banks": banks,
        "queries": [{"id": qid, "query": q} for qid, q in QUERIES],
        "results": {},
    }
    for bank in banks:
        out["results"][bank] = {}
        for qid, q in QUERIES:
            try:
                r = recall(args.api_url, bank, q, args.query_timestamp)
            except Exception as e:  # capture, don't abort the sweep
                r = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
            r["query"] = q
            out["results"][bank][qid] = r
            n = r.get("result_count", "ERR")
            print(f"{bank:16} {qid:20} n={n} {r.get('elapsed_ms','')}ms", flush=True)

    with open(args.out, "w") as fh:
        fh.write(json.dumps(out, indent=2) + "\n")
    print(f"\nwrote {args.out} (phase={args.phase})")
    if args.phase == "pre":
        print(
            "\nNEXT: perform the upgrade, then within the freshness bound run\n"
            f"  {os.path.basename(__file__)} --phase post --out post.json "
            f"--query-timestamp {shlex.quote(args.query_timestamp)}\n"
            "  compare_baseline.py --baseline "
            f"{shlex.quote(args.out)} --post post.json"
        )


if __name__ == "__main__":
    main()
