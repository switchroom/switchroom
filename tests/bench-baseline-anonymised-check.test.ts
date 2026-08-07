/**
 * Outcome tests for `scripts/check-bench-baseline-anonymised.mjs` (#4499).
 *
 * The gate exists to fail on the artefacts PR #4495 actually merged, so the
 * tests feed it that exact shape and assert it fires. A test that only fed it
 * clean input would pass against a `return []` implementation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs guard script, no types
import { checkCsv, checkJson, checkProse, checkTables, collectViolations } from "../scripts/check-bench-baseline-anonymised.mjs";

const repoRoot = join(import.meta.dirname, "..");
const BASELINE = "docs/baselines/hindsight-recall-2026-08-07";

interface Violation {
  file: string;
  detail: string;
}

/** A BenchResult-shaped document with the given bank id in every field. */
function resultWith(bank: string): string {
  return JSON.stringify({
    schema: 2,
    config: { banks: [bank], querySet: "generic-v1" },
    db: { bankRows: [{ bank, rows: 228952 }] },
    cells: [{ bank, rows: 228952, concurrency: 1 }],
    arms: [{ bank, method: "semantic", fact_type: "world" }],
  });
}

describe("check-bench-baseline-anonymised — JSON artefacts", () => {
  it("fails on a real bank id, naming every field that carries it", () => {
    const v = checkJson("x.json", resultWith("klanker")) as Violation[];
    const fields = v.map((x) => x.detail.split(" ")[0]);
    expect(fields).toEqual(["config.banks[]", "db.bankRows[].bank", "cells[].bank", "arms[].bank"]);
  });

  it("passes on pseudonyms", () => {
    expect(checkJson("x.json", resultWith("bank-01"))).toEqual([]);
  });

  it("fails on a bank id no blocklist has ever seen — the check-no-pii-secrets gap", () => {
    // This is the property that matters: a brand-new agent added to the fleet
    // tomorrow is caught, because the rule whitelists a SHAPE, not names.
    const v = checkJson("x.json", resultWith("a-brand-new-agent-2031")) as Violation[];
    expect(v.length).toBe(4);
  });

  it("rejects near-miss pseudonyms rather than waving them through", () => {
    for (const bad of ["bank-1", "bank-", "Bank-01", "bank-01-real", "bankname"]) {
      expect(checkJson("x.json", resultWith(bad)), bad).not.toEqual([]);
    }
  });

  it("ignores JSON under docs/baselines that is not a BenchResult", () => {
    expect(checkJson("other.json", JSON.stringify({ hello: "klanker" }))).toEqual([]);
  });

  it("reports unparseable JSON rather than skipping it silently", () => {
    const v = checkJson("x.json", "{not json") as Violation[];
    expect(v[0]?.detail).toContain("not parseable JSON");
  });
});

describe("check-bench-baseline-anonymised — CSV artefacts", () => {
  const header = "label,bank,rows,concurrency\n";

  it("fails on a real bank id in the bank column", () => {
    const v = checkCsv("x.csv", `${header}"idle-A",klanker,228952,1\n`) as Violation[];
    expect(v).toHaveLength(1);
    expect(v[0]?.detail).toContain('bank column = "klanker"');
  });

  it("passes on pseudonyms", () => {
    expect(checkCsv("x.csv", `${header}"idle-A",bank-01,228952,1\n`)).toEqual([]);
  });

  it("ignores a CSV with no bank column", () => {
    expect(checkCsv("x.csv", "a,b\n1,2\n")).toEqual([]);
  });
});

describe("check-bench-baseline-anonymised — prose", () => {
  it("fails on a per-cell citation", () => {
    const v = checkProse("d.md", "the `klanker`@c1 cell recorded 40 errors") as Violation[];
    expect(v[0]?.detail).toContain("klanker");
  });

  it("fails on a roster listing", () => {
    const v = checkProse("d.md", "| banks swept | `klanker` (230,020 rows), `gymbro` (17,977) |") as Violation[];
    expect(v.map((x) => x.detail).join(" ")).toContain("klanker");
  });

  it("fails on a bank column in a markdown table", () => {
    const md = ["| bank | rows | c=1 |", "|---|---:|---:|", "| `klanker` | 230,020 | **1886** |"].join("\n");
    const v = checkTables("d.md", md) as Violation[];
    expect(v).toHaveLength(1);
    expect(v[0]?.detail).toContain('bank column = "klanker"');
  });

  it("does NOT fire on a config table that has no bank column", () => {
    // The regression that made the first draft of this gate useless: matching
    // "backticked token beside a number" flagged every settings table.
    const md = ["| | |", "|---|---|", "| `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` | 150 |", "| `shared_buffers` | 6144 MB |"].join("\n");
    expect(checkTables("d.md", md)).toEqual([]);
  });

  it("passes a bank table full of pseudonyms", () => {
    const md = ["| bank | rows |", "|---|---:|", "| `bank-01` | 230,020 |", "| `bank-14` | 12 |"].join("\n");
    expect(checkTables("d.md", md)).toEqual([]);
  });
});

describe("check-bench-baseline-anonymised — the committed tree", () => {
  it("passes on the repo as it stands", () => {
    expect(collectViolations()).toEqual([]);
  });

  it("every committed baseline artefact is genuinely pseudonymised", () => {
    // Belt-and-braces on the artefacts themselves, independent of the gate's
    // own logic: no committed baseline file may contain a `"bank":` value that
    // is not a pseudonym.
    const idleA = readFileSync(join(repoRoot, BASELINE, "idle-a.json"), "utf8");
    const banks = [...idleA.matchAll(/"bank":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(banks.length).toBeGreaterThan(10);
    for (const b of banks) expect(b).toMatch(/^bank-\d{2,}$/);
  });
});
