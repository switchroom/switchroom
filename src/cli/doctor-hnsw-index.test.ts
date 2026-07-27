import { describe, expect, it } from "vitest";

import {
  HNSW_INDEX_MIN_ROWS,
  buildHnswIndexQuery,
  checkHnswPartialIndexes,
  parseHnswIndexOutput,
  type HnswIndexProbeResult,
} from "./doctor-hnsw-index.js";

/**
 * The defect these tests guard.
 *
 * Hindsight creates per-bank PARTIAL vector indexes exactly once, at bank
 * creation, behind `if created:` on an INSERT ... ON CONFLICT DO NOTHING. No
 * backfill, no reconciliation. A bank that missed that window never gets them
 * and nothing notices — recall keeps returning rows, just the wrong ones, from
 * a scan rather than a search. Measured on this fleet: recall@100 bounded at
 * <=4% across five banks for roughly three months.
 *
 * So the assertions are about the OUTCOME an operator needs — "does the check
 * name a real unindexed bank before recall degrades" — not about the query
 * string's shape.
 */

const row = (
  bankId: string,
  factType: string,
  rows: number,
  present: boolean,
  indexName = "idx_mu_emb_x_0123456789abcdef",
) => ({ bankId, factType, rows, indexName, present });

const probeOf = (rows: HnswIndexProbeResult["rows"]) => () => ({ ok: true, rows });

describe("index name derivation", () => {
  it("strips hyphens BEFORE truncating to 16, exactly as the engine does", () => {
    // engine/retain/bank_utils.py:_bank_index_name —
    //   uid = str(internal_id).replace("-", "")[:16]
    // Truncating the raw UUID text to 16 chars instead would keep two hyphens
    // and produce a different name, which would make this check report EVERY
    // bank as broken. Assert the order, in SQL, rather than trusting prose.
    const sql = buildHnswIndexQuery();
    expect(sql).toContain("substr(replace(b.internal_id::text, '-', ''), 1, 16)");
    // The wrong order would be substr(...) wrapped by replace(...).
    expect(sql).not.toMatch(/replace\(\s*substr/);
  });

  it("derives all three fact-type suffixes rather than hardcoding one", () => {
    const sql = buildHnswIndexQuery();
    for (const [ft, sfx] of [
      ["world", "worl"],
      ["experience", "expr"],
      ["observation", "obsv"],
    ]) {
      expect(sql).toContain(`WHEN '${ft}' THEN '${sfx}'`);
    }
  });

  it("requires the index to be indisvalid, not merely to exist", () => {
    // A CONCURRENTLY build that failed part-way leaves an INVALID index in
    // pg_class that the planner will not use. Accepting mere existence would
    // report that exact broken state as healthy.
    expect(buildHnswIndexQuery()).toContain("i.indisvalid");
  });

  it("filters by the configured floor", () => {
    expect(buildHnswIndexQuery(4242)).toContain("HAVING count(*) >= 4242");
  });

  it("counts only rows that actually have an embedding", () => {
    // A pair with 50k rows and no embeddings needs no vector index; counting
    // them would fire the row on banks that are fine.
    expect(buildHnswIndexQuery()).toContain("mu.embedding IS NOT NULL");
  });
});

describe("the floor", () => {
  it("fires below the planner flip point, not after recall has degraded", () => {
    // Measured: the planner stops preferring the per-bank partial index below
    // roughly 12,000 rows per (bank, fact_type). A floor at or above that
    // would only report a bank once its recall was ALREADY degraded.
    expect(HNSW_INDEX_MIN_ROWS).toBeLessThan(12_000);
  });

  it("catches gymbro/world on the day it crosses", () => {
    // The live unindexed pair, 8,128 rows on 2026-07-27 and rising. This is
    // the case the check exists for, so pin it: at 8,128 it is below the floor
    // and silent; the moment it reaches the floor it must FAIL by name.
    const below = checkHnswPartialIndexes({
      probe: probeOf([row("gymbro", "world", 8_128, false)]),
    });
    expect(below.status).toBe("ok");

    const crossed = checkHnswPartialIndexes({
      probe: probeOf([row("gymbro", "world", HNSW_INDEX_MIN_ROWS, false)]),
    });
    expect(crossed.status).toBe("fail");
    expect(crossed.detail).toContain("gymbro/world");
  });
});

describe("the doctor row", () => {
  it("FAILS and names every unindexed pair, with its row count and index name", () => {
    const r = checkHnswPartialIndexes({
      probe: probeOf([
        row("klanker", "world", 82_298, true),
        row("gymbro", "world", 14_000, false, "idx_mu_emb_worl_aabbccddeeff0011"),
        row("reggie", "observation", 11_000, false, "idx_mu_emb_obsv_1122334455667788"),
      ]),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("gymbro/world");
    expect(r.detail).toContain("reggie/observation");
    expect(r.detail).toContain("14,000");
    // Name the object so the operator can go look for it.
    expect(r.detail).toContain("idx_mu_emb_worl_aabbccddeeff0011");
    // An indexed bank must not be dragged into the failure.
    expect(r.detail).not.toContain("klanker");
  });

  it("passes when every pair above the floor is indexed", () => {
    const r = checkHnswPartialIndexes({
      probe: probeOf([
        row("klanker", "world", 82_298, true),
        row("overlord", "world", 84_426, true),
      ]),
    });
    expect(r.status).toBe("ok");
  });

  it("passes on a young fleet where nothing has reached the floor", () => {
    const r = checkHnswPartialIndexes({ probe: probeOf([]) });
    expect(r.status).toBe("ok");
  });

  it("SKIPS rather than FAILS when the database cannot be reached", () => {
    // A dockerless or remote-backend host has nothing to say here. Failing on
    // "couldn't look" is how a check earns a permanent place on the ignore
    // list.
    const r = checkHnswPartialIndexes({
      probe: () => ({ ok: false, rows: [], error: "container not running" }),
    });
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("container not running");
  });

  it("says the indexes are never backfilled, because that is why it is stuck", () => {
    // Without this the natural operator response is "run apply again", which
    // does nothing: the create is behind `if created:` on the bank INSERT.
    const r = checkHnswPartialIndexes({
      probe: probeOf([row("gymbro", "world", 14_000, false)]),
    });
    expect(r.fix).toContain("never backfills");
  });
});

describe("output parsing", () => {
  it("reads a real psql -At -F'|' line", () => {
    const got = parseHnswIndexOutput(
      "gymbro|world|8128|idx_mu_emb_worl_aabbccddeeff0011|f\n" +
        "klanker|world|82298|idx_mu_emb_worl_0011223344556677|t\n",
    );
    expect(got).toEqual([
      row("gymbro", "world", 8128, false, "idx_mu_emb_worl_aabbccddeeff0011"),
      row("klanker", "world", 82298, true, "idx_mu_emb_worl_0011223344556677"),
    ]);
  });

  it("distinguishes t from f rather than treating any value as present", () => {
    // Inverting or ignoring this flag is the difference between "all clear"
    // and "five banks are broken", and both readings parse cleanly.
    const [a, b] = parseHnswIndexOutput(
      "a|world|20000|idx_a|t\nb|world|20000|idx_b|f\n",
    );
    expect(a!.present).toBe(true);
    expect(b!.present).toBe(false);
  });

  it("accepts both boolean spellings psql can emit", () => {
    // An explicit ::text cast yields true/false; bare -At output yields t/f.
    // A live run against the fleet reported all 17 HEALTHY banks as unindexed
    // because the parser only knew `t` — silent, total, and it would have
    // shipped a check that cried wolf on every host.
    expect(parseHnswIndexOutput("a|world|20000|idx_a|true")[0]!.present).toBe(true);
    expect(parseHnswIndexOutput("a|world|20000|idx_a|t")[0]!.present).toBe(true);
    expect(parseHnswIndexOutput("a|world|20000|idx_a|false")[0]!.present).toBe(false);
    // Fail safe: an unrecognised value must report a problem, never clear one.
    expect(parseHnswIndexOutput("a|world|20000|idx_a|???")[0]!.present).toBe(false);
  });

  it("skips noise instead of throwing", () => {
    // docker exec can prepend warnings; a doctor check must never crash the
    // command it runs in.
    expect(
      parseHnswIndexOutput(
        "WARNING: something\n\ngymbro|world|8128|idx_x|f\nbad|line\n",
      ),
    ).toEqual([row("gymbro", "world", 8128, false, "idx_x")]);
  });
});
