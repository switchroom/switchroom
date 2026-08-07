"""P4 keyword-arm latency bench (sandbox only, synthetic anonymised corpus).

Mirrors hindsight_api/engine/sql/postgresql.py build_bm25_arm() for the
`native` and `pg_search` text-search backends: a UNION ALL of one BM25 arm per
fact_type, each scoped by bank_id + fact_type, ORDER BY score DESC LIMIT n.
"""
import argparse, asyncio, json, random, statistics, sys, time

FACT_TYPES = ("world", "experience", "observation")


def arm(backend: str, fact_type: str, bank: str, q: str, limit: int) -> str:
    if backend == "pg_search":
        score = "paradedb.score(id)"
        filt = (
            "AND id @@@ paradedb.boolean(should => ARRAY["
            f"paradedb.match('text', $${q}$$), "
            f"paradedb.match('context', $${q}$$), "
            f"paradedb.match('text_signals', $${q}$$)])"
        )
        order = "paradedb.score(id) DESC"
    else:
        tsq = " | ".join(q.split())
        score = f"ts_rank_cd(search_vector, to_tsquery('english', $${tsq}$$))"
        filt = f"AND search_vector @@ to_tsquery('english', $${tsq}$$)"
        order = f"{score} DESC"
    return (
        f"(SELECT id, {score} AS bm25_score FROM memory_units"
        f" WHERE bank_id = $${bank}$$ AND fact_type = $${fact_type}$$ {filt}"
        f" ORDER BY {order} LIMIT {limit})"
    )


def keyword_half(backend: str, bank: str, q: str, limit: int) -> str:
    return " UNION ALL ".join(arm(backend, ft, bank, q, limit) for ft in FACT_TYPES)


def pctl(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    k = max(1, min(len(s), -(-len(s) * p // 100)))  # nearest-rank
    return s[k - 1]


async def worker(dsn, backend, bank, queries, limit, deadline, out, errs):
    import asyncpg
    conn = await asyncpg.connect(dsn)
    try:
        while time.monotonic() < deadline:
            q = random.choice(queries)
            t0 = time.perf_counter()
            try:
                await conn.fetch(keyword_half(backend, bank, q, limit))
            except Exception:
                errs.append(1)
                continue
            out.append((time.perf_counter() - t0) * 1000.0)
    finally:
        await conn.close()


async def cell(dsn, backend, bank, conc, queries, limit, seconds, warmup):
    lat, errs = [], []
    # warm-up
    wd = time.monotonic() + warmup
    await asyncio.gather(*[worker(dsn, backend, bank, queries, limit, wd, [], []) for _ in range(conc)])
    started = time.time()
    deadline = time.monotonic() + seconds
    await asyncio.gather(*[worker(dsn, backend, bank, queries, limit, deadline, lat, errs) for _ in range(conc)])
    return {
        "backend": backend, "bank": bank, "concurrency": conc,
        "samples": len(lat), "errors": len(errs),
        "p50": pctl(lat, 50), "p95": pctl(lat, 95), "p99": pctl(lat, 99),
        "max": max(lat) if lat else None,
        "mean": statistics.fmean(lat) if lat else None,
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--backends", default="native,pg_search")
    ap.add_argument("--banks", required=True)
    ap.add_argument("--conc", default="1,8,16")
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--warmup", type=float, default=3.0)
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--nqueries", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260807)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    random.seed(a.seed)
    # mid-frequency vocabulary slice: common enough to match, not so common the
    # whole corpus matches.
    queries = [" ".join(f"tk{random.randint(20, 4000):05d}" for _ in range(3)) for _ in range(a.nqueries)]

    cells = []
    for conc in [int(c) for c in a.conc.split(",")]:
        for bank in a.banks.split(","):
            # interleave backends within a cell so drift/contention hits both
            for backend in a.backends.split(","):
                r = await cell(a.dsn, backend, bank, conc, queries, a.limit, a.seconds, a.warmup)
                cells.append(r)
                print(json.dumps(r), flush=True)
    with open(a.out, "w") as f:
        json.dump({"cells": cells, "config": vars(a)}, f, indent=2)


asyncio.run(main())
