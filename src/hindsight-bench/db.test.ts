import { describe, it, expect } from "vitest";
import { SqlError, assertReadOnlyOrWritesAllowed, readDbState, resetStats, sql, type Runner } from "./db.js";

/** A runner that replies with canned stdout per call, recording every invocation. */
function fakeRunner(replies: string[]): { run: Runner; calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let i = 0;
  const run: Runner = (_cmd, args, stdin) => {
    calls.push({ args, stdin });
    return { status: 0, stdout: replies[i++] ?? "", stderr: "" };
  };
  return { run, calls };
}

const SETTINGS_ROW = [
  String(6144 * 1024 * 1024),
  String(8192 * 1024 * 1024),
  "40",
  "5430000000",
  "3100000000",
  "2330000000",
  "",
  "0.994",
  "PostgreSQL 18.0 on x86_64",
].join("|");

describe("sql", () => {
  it("sends the script on stdin, not as an argv-embedded statement", () => {
    const { run, calls } = fakeRunner(["a\nb"]);
    expect(sql("SELECT 1;", { run })).toEqual(["a", "b"]);
    expect(calls[0]?.stdin).toBe("SELECT 1;");
    expect(calls[0]?.args.join(" ")).not.toContain("SELECT 1");
  });

  it("clamps the session read-only unless explicitly writable", () => {
    const { run, calls } = fakeRunner(["", ""]);
    sql("SELECT 1;", { run });
    expect(calls[0]?.args.join(" ")).toContain("default_transaction_read_only=on");
    sql("SELECT 1;", { run, writable: true });
    expect(calls[1]?.args.join(" ")).toContain("default_transaction_read_only=off");
  });

  it("throws rather than returning empty rows on a non-zero exit", () => {
    const run: Runner = () => ({ status: 3, stdout: "", stderr: "no psql in container" });
    expect(() => sql("SELECT 1;", { run })).toThrow(SqlError);
    expect(() => sql("SELECT 1;", { run })).toThrow(/no psql in container/);
  });

  it("targets the requested container", () => {
    const { run, calls } = fakeRunner([""]);
    sql("SELECT 1;", { run, container: "other-box" });
    expect(calls[0]?.args).toContain("other-box");
  });
});

describe("assertReadOnlyOrWritesAllowed (AC5)", () => {
  it("passes when the clamp is declared AND the probe write was rejected", () => {
    const { run } = fakeRunner(["DO\non|f"]);
    expect(() => assertReadOnlyOrWritesAllowed(false, { run })).not.toThrow();
  });

  it("reads the verdict past psql's DO command tag", () => {
    // Regression: `-tA` prints `DO` for the DO block, so rows[0] is the tag.
    const { run } = fakeRunner(["DO\non|f"]);
    expect(() => assertReadOnlyOrWritesAllowed(false, { run })).not.toThrow();
  });

  it("REFUSES when the session merely claims read-only but the write landed", () => {
    // The failure a `SHOW transaction_read_only` check would miss entirely.
    const { run } = fakeRunner(["DO\non|t"]);
    expect(() => assertReadOnlyOrWritesAllowed(false, { run })).toThrow(/WRITABLE/);
  });

  it("REFUSES when the clamp is not in effect", () => {
    const { run } = fakeRunner(["DO\noff|t"]);
    expect(() => assertReadOnlyOrWritesAllowed(false, { run })).toThrow(SqlError);
  });

  it("REFUSES on an unparseable verdict rather than assuming safety", () => {
    const { run } = fakeRunner([""]);
    expect(() => assertReadOnlyOrWritesAllowed(false, { run })).toThrow(SqlError);
  });

  it("permits a writable session only under --allow-writes", () => {
    const { run } = fakeRunner(["DO\noff|t"]);
    expect(() => assertReadOnlyOrWritesAllowed(true, { run })).not.toThrow();
  });
});

describe("resetStats", () => {
  it("is never issued read-only and never issued implicitly", () => {
    const { run, calls } = fakeRunner([""]);
    resetStats({ run });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toContain("pg_stat_reset()");
    expect(calls[0]?.args.join(" ")).toContain("default_transaction_read_only=off");
  });
});

describe("readDbState", () => {
  const replies = [
    SETTINGS_ROW,
    "overlord|228761\nprobe|12\n|7",
    "idx_memory_units_bank_type|900000000|1204\nmemory_units_pkey|30000000|0",
  ];

  it("parses settings, banks and indexes into a self-describing block", () => {
    const { run } = fakeRunner(replies);
    const db = readDbState({ run });
    expect(db.sharedBuffersBytes).toBe(6144 * 1024 * 1024);
    expect(db.hnswEfSearch).toBe(40);
    expect(db.memoryUnitsIndexBytes).toBe(2330000000);
    expect(db.bankRows).toEqual([
      { bank: "overlord", rows: 228761 },
      { bank: "probe", rows: 12 },
    ]);
    expect(db.largestIndexes[0]).toEqual({ name: "idx_memory_units_bank_type", bytes: 900000000, scans: 1204 });
  });

  it("records a never-reset stats epoch as null rather than a bogus date", () => {
    const { run } = fakeRunner(replies);
    expect(readDbState({ run }).statsResetAt).toBeNull();
  });

  it("keeps version() intact even though it contains no delimiter risk", () => {
    const { run } = fakeRunner(replies);
    expect(readDbState({ run }).serverVersion).toBe("PostgreSQL 18.0 on x86_64");
  });

  it("treats an absent hnsw.ef_search GUC as null, not 0", () => {
    const row = SETTINGS_ROW.split("|");
    row[2] = "";
    const { run } = fakeRunner([row.join("|"), "", ""]);
    expect(readDbState({ run }).hnswEfSearch).toBeNull();
  });

  it("throws on a truncated settings row rather than emitting NaN fields", () => {
    const { run } = fakeRunner(["1|2|3"]);
    expect(() => readDbState({ run })).toThrow(/settings row shape/);
  });
});
