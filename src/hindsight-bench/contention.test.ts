import { describe, it, expect } from "vitest";
import { CONTENTION_APP_NAME, DEFAULT_CONTENTION, SCRATCH_TABLE, contentionSql, noContention } from "./contention.js";

describe("contentionSql", () => {
  it("always carries an absolute deadline (the orphan backstop)", () => {
    for (const profile of ["read", "write"] as const) {
      const s = contentionSql(profile, 2, 900);
      expect(s).toContain("clock_timestamp() + interval '900 seconds'");
      expect(s).toContain("WHILE clock_timestamp() < deadline");
    }
  });

  it("clamps a hostile or absurd deadline instead of emitting it", () => {
    expect(contentionSql("read", 2, 10 ** 9)).toContain("interval '3600 seconds'");
    expect(contentionSql("read", 2, 0)).toContain("interval '1 seconds'");
    expect(contentionSql("read", 2, NaN)).toContain(`interval '${DEFAULT_CONTENTION.maxSeconds} seconds'`);
  });

  it("clamps the sample percentage into a legal TABLESAMPLE range", () => {
    expect(contentionSql("read", 500, 60)).toContain("TABLESAMPLE SYSTEM (100)");
    expect(contentionSql("read", 0, 60)).toContain("TABLESAMPLE SYSTEM (0.1)");
    expect(contentionSql("read", NaN, 60)).toContain(`TABLESAMPLE SYSTEM (${DEFAULT_CONTENTION.scanPct})`);
  });

  it("read profile issues no write statement at all", () => {
    const s = contentionSql("read", 2, 60);
    expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/);
  });

  it("write profile NEVER names a bank table as a write target", () => {
    // The single most important guard in this file: the harness measures a read
    // path and must not be able to mutate the memory bank, even by typo.
    const s = contentionSql("write", 2, 60);
    for (const stmt of s.split("\n").filter((l) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/.test(l))) {
      expect(stmt).toContain(SCRATCH_TABLE);
      expect(stmt).not.toMatch(/memory_units|reflections|entities|memory_bank/);
    }
  });

  it("write profile keeps the cache churn as well as the write storm", () => {
    const s = contentionSql("write", 2, 60);
    expect(s).toContain("TABLESAMPLE SYSTEM");
    expect(s).toContain(`INSERT INTO ${SCRATCH_TABLE}`);
  });

  it("churn scans tuples rather than an aggregate the planner can elide", () => {
    // count(*) over a TABLESAMPLE can be answered without visiting the tuples,
    // which would make the generator look busy while evicting nothing.
    const s = contentionSql("read", 2, 60);
    expect(s).toContain("sum(length(m.text))");
    expect(s).not.toContain("count(*)");
  });
});

describe("noContention", () => {
  it("is inert and its stop is safe to call repeatedly", () => {
    const h = noContention();
    expect(h.profile).toBe("off");
    expect(h.workers).toBe(0);
    expect(() => {
      h.stop();
      h.stop();
    }).not.toThrow();
  });
});

describe("application_name", () => {
  it("is a dedicated tag so the terminate sweep cannot hit real traffic", () => {
    expect(CONTENTION_APP_NAME).toBe("hindsight-bench-contention");
    expect(CONTENTION_APP_NAME).not.toMatch(/hindsight-api|psql|^$/);
  });
});

describe("defaults", () => {
  it("are conservative — this runs against the live fleet", () => {
    expect(DEFAULT_CONTENTION.workers).toBeLessThanOrEqual(2);
    expect(DEFAULT_CONTENTION.scanPct).toBeLessThanOrEqual(5);
    expect(DEFAULT_CONTENTION.maxSeconds).toBeLessThanOrEqual(3600);
  });
});
