/**
 * Outcome tests for the bench-result anonymiser (#4499).
 *
 * The outcome under test is "no real bank name survives into a persisted
 * result file" — asserted by serialising the anonymised result and searching
 * the JSON text, which is exactly the artefact that got committed to a public
 * repo in #4495. A test that only checked `result.config.banks` would pass
 * while a name leaked through `cells[].bank`.
 */

import { describe, expect, it } from "vitest";
import { anonymiseResult, buildBankMap, PSEUDONYM_RE } from "./anonymise.js";
import { makeCell, makeConfig, makeDbState, makeResult } from "./fixtures.js";
import type { ArmTiming, BenchResult } from "./types.js";

/** A SYNTHETIC roster shaped like a real one: fourteen banks spanning four orders
 * of magnitude, size-ordered as the DB snapshot emits them. Deliberately invented —
 * writing the actual leaked names into a test would re-publish the very roster this
 * module exists to keep out of the repo. */
const SYNTHETIC_ROSTER: Array<{ bank: string; rows: number }> = [
  { bank: "nimbus", rows: 228952 },
  { bank: "quartz", rows: 90210 },
  { bank: "tundra", rows: 61234 },
  { bank: "vellum", rows: 51771 },
  { bank: "cobalt", rows: 40122 },
  { bank: "harrow", rows: 33110 },
  { bank: "pelter", rows: 17977 },
  { bank: "sable-2", rows: 9004 },
  { bank: "mordant", rows: 4210 },
  { bank: "kestrel", rows: 1493 },
  { bank: "ada-profile", rows: 890 },
  { bank: "bo-profile", rows: 157 },
  { bank: "wicket", rows: 40 },
  { bank: "fixture-dev", rows: 12 },
];

function realisticResult(): BenchResult {
  const swept = ["nimbus", "pelter", "kestrel", "bo-profile", "fixture-dev"];
  const arms: ArmTiming[] = swept.map((bank) => ({
    bank,
    method: "semantic",
    fact_type: "world",
    n: 5,
    p50: 100,
    p95: 200,
    max: 300,
  }));
  const rowsOf = (b: string): number => SYNTHETIC_ROSTER.find((r) => r.bank === b)?.rows ?? 0;
  return {
    ...makeResult(
      swept.flatMap((b) => [makeCell(b, rowsOf(b), 1, 1000), makeCell(b, rowsOf(b), 4, 2000)]),
      { banks: swept },
    ),
    config: makeConfig({ banks: swept }),
    db: makeDbState({ bankRows: SYNTHETIC_ROSTER }),
    arms,
  };
}

describe("anonymiseResult", () => {
  it("leaves no source bank name anywhere in the serialised result file", () => {
    const { result } = anonymiseResult(realisticResult());
    const json = JSON.stringify(result);
    for (const { bank } of SYNTHETIC_ROSTER) {
      expect(json, `"${bank}" survived into the persisted result`).not.toContain(bank);
    }
  });

  it("fails on the pre-fix input, proving the assertion has teeth", () => {
    // Same assertion against the UN-anonymised result: it must find the names.
    const json = JSON.stringify(realisticResult());
    expect(json).toContain("nimbus");
    expect(json).toContain("ada-profile");
    expect(json).toContain("bo-profile");
  });

  it("pseudonymises every bank-bearing field, not just config.banks", () => {
    const { result } = anonymiseResult(realisticResult());
    for (const b of result.config.banks) expect(b).toMatch(PSEUDONYM_RE);
    for (const r of result.db.bankRows) expect(r.bank).toMatch(PSEUDONYM_RE);
    for (const c of result.cells) expect(c.bank).toMatch(PSEUDONYM_RE);
    for (const a of result.arms ?? []) expect(a.bank).toMatch(PSEUDONYM_RE);
  });

  it("assigns ordinals by descending row count so the size axis is preserved", () => {
    const { result, mapping } = anonymiseResult(realisticResult());
    expect(mapping.get("nimbus")).toBe("bank-01");
    expect(mapping.get("fixture-dev")).toBe("bank-14");
    // bankRows must stay descending under the pseudonyms.
    const rows = result.db.bankRows.map((r) => r.rows);
    expect([...rows].sort((a, b) => b - a)).toEqual(rows);
  });

  it("preserves row counts and latencies untouched — the measurement survives", () => {
    const before = realisticResult();
    const { result } = anonymiseResult(before);
    expect(result.db.bankRows.map((r) => r.rows)).toEqual(before.db.bankRows.map((r) => r.rows));
    expect(result.cells.map((c) => c.rows)).toEqual(before.cells.map((c) => c.rows));
    expect(result.cells.map((c) => c.stats.p95)).toEqual(before.cells.map((c) => c.stats.p95));
  });

  it("gives the same bank the same pseudonym across two runs, so files still join", () => {
    const runA = anonymiseResult(realisticResult());
    // A later run: row counts drifted upward, ORDER unchanged.
    const drifted = realisticResult();
    drifted.db.bankRows = SYNTHETIC_ROSTER.map((r) => ({ ...r, rows: r.rows + 1171 }));
    const runB = anonymiseResult(drifted);
    expect([...runB.mapping.entries()]).toEqual([...runA.mapping.entries()]);
  });

  it("maps a bank that appears only in cells, so a gap cannot leak a name", () => {
    const r = realisticResult();
    // Simulate a bank measured but missing from the census.
    r.db.bankRows = SYNTHETIC_ROSTER.filter((x) => x.bank !== "kestrel");
    const { result } = anonymiseResult(r);
    expect(JSON.stringify(result)).not.toContain("kestrel");
  });

  it("is idempotent — re-anonymising an anonymised file changes nothing", () => {
    const once = anonymiseResult(realisticResult()).result;
    const twice = anonymiseResult(once).result;
    expect(twice).toEqual(once);
  });

  it("never returns the mapping inside the result", () => {
    const { result } = anonymiseResult(realisticResult());
    expect(JSON.stringify(result)).not.toContain("mapping");
  });
});

describe("buildBankMap", () => {
  it("zero-pads to at least two digits so pseudonyms sort lexically", () => {
    const map = buildBankMap(realisticResult());
    expect(map.get("quartz")).toBe("bank-02");
    expect([...map.values()].every((v) => PSEUDONYM_RE.test(v))).toBe(true);
  });

  it("widens the pad past 99 banks", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ bank: `b${i}`, rows: 1000 - i }));
    const r = { ...realisticResult(), db: makeDbState({ bankRows: many }), cells: [], arms: null };
    const map = buildBankMap(r);
    expect(map.get("b0")).toBe("bank-001");
    expect(map.get("b119")).toBe("bank-120");
  });
});
