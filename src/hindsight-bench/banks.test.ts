import { describe, it, expect } from "vitest";
import { BankSelectionError, parseConcurrency, selectBanks } from "./banks.js";

/** The live distribution measured 2026-08-07 — four orders of magnitude. */
const LIVE = [
  { bank: "overlord", rows: 228761 },
  { bank: "fable", rows: 41230 },
  { bank: "clerk", rows: 9877 },
  { bank: "scout", rows: 1204 },
  { bank: "ledger", rows: 311 },
  { bank: "tinker", rows: 44 },
  { bank: "probe", rows: 12 },
  { bank: "empty", rows: 0 },
];

describe("selectBanks", () => {
  it("all returns every non-empty bank, largest first", () => {
    expect(selectBanks(LIVE, "all")).toEqual(["overlord", "fable", "clerk", "scout", "ledger", "tinker", "probe"]);
  });

  it("top:n returns the n largest", () => {
    expect(selectBanks(LIVE, "top:3")).toEqual(["overlord", "fable", "clerk"]);
  });

  it("spread:n always includes the largest AND the smallest bank", () => {
    const picked = selectBanks(LIVE, "spread:5");
    expect(picked).toHaveLength(5);
    expect(picked).toContain("overlord");
    expect(picked).toContain("probe");
  });

  it("spread:n samples multiple decades, not just the top one", () => {
    // The failure this guards: a 'size sweep' that measures 228k/41k/10k/1.2k
    // and calls the resulting flat line evidence of size-independence.
    const picked = selectBanks(LIVE, "spread:5");
    const rows = picked.map((b) => (LIVE.find((l) => l.bank === b) as { rows: number }).rows);
    const decades = new Set(rows.map((r) => Math.floor(Math.log10(r))));
    expect(decades.size).toBeGreaterThanOrEqual(4);
  });

  it("spread never repeats a bank", () => {
    const picked = selectBanks(LIVE, "spread:6");
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("spread degrades to every bank when fewer exist than requested", () => {
    expect(selectBanks(LIVE, "spread:50")).toHaveLength(7);
  });

  it("excludes zero-row banks from all/top/spread", () => {
    for (const spec of ["all", "top:8", "spread:8"]) {
      expect(selectBanks(LIVE, spec)).not.toContain("empty");
    }
  });

  it("honours an explicit comma list verbatim, including an empty bank", () => {
    expect(selectBanks(LIVE, "empty, probe ,overlord")).toEqual(["empty", "probe", "overlord"]);
  });

  it("throws with the known bank list when a name is unknown", () => {
    expect(() => selectBanks(LIVE, "nope")).toThrow(BankSelectionError);
    expect(() => selectBanks(LIVE, "nope")).toThrow(/overlord/);
  });

  it("throws rather than silently selecting nothing", () => {
    expect(() => selectBanks(LIVE, " , ")).toThrow(BankSelectionError);
  });
});

describe("parseConcurrency", () => {
  it("parses, dedupes and sorts ascending", () => {
    expect(parseConcurrency("16, 4,1,4")).toEqual([1, 4, 16]);
  });

  it("rejects non-positive and non-integer levels", () => {
    expect(() => parseConcurrency("1,0")).toThrow(BankSelectionError);
    expect(() => parseConcurrency("1,-2")).toThrow(BankSelectionError);
    expect(() => parseConcurrency("1,2.5")).toThrow(BankSelectionError);
    expect(() => parseConcurrency("1,eight")).toThrow(BankSelectionError);
  });
});
