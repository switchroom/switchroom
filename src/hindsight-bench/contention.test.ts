import { describe, it, expect } from "vitest";
import {
  CONTENTION_APP_NAME,
  ContentionError,
  DEFAULT_CONTENTION,
  SCRATCH_TABLE,
  contentionSql,
  countContentionBackends,
  noContention,
  startContention,
} from "./contention.js";
import type { Runner } from "./db.js";

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

describe("contentionSql — the churn statement must actually parse", () => {
  it("puts the table alias BEFORE the TABLESAMPLE clause", () => {
    // `FROM memory_units TABLESAMPLE SYSTEM (n) m` is a PostgreSQL syntax
    // error. That ordering shipped, every load backend died on connect, the
    // stderr was discarded, and the harness measured an idle system while
    // reporting "8 backend(s)". This test pins the ordering that parses.
    const s = contentionSql("read", 25, 60);
    expect(s).toMatch(/FROM\s+memory_units\s+m\s+TABLESAMPLE\s+SYSTEM\s*\(25\)/);
    expect(s).not.toMatch(/TABLESAMPLE\s+SYSTEM\s*\([\d.]+\)\s*m\b/);
  });

  it("references the aliased relation in the aggregate it forces", () => {
    // `sum(length(m.text))` only resolves if `m` is bound; a mismatch here is
    // the same class of silent-death bug.
    expect(contentionSql("read", 2, 60)).toContain("sum(length(m.text))");
  });
});

describe("countContentionBackends", () => {
  it("counts only backends carrying the harness's application_name", () => {
    const seen: string[] = [];
    const run: Runner = (_c, _a, stdin) => {
      seen.push(stdin ?? "");
      return { status: 0, stdout: "3\n", stderr: "" };
    };
    expect(countContentionBackends({ run })).toBe(3);
    expect(seen[0]).toContain(`application_name = '${CONTENTION_APP_NAME}'`);
  });

  it("reads an unparseable answer as zero load, never as success", () => {
    const run: Runner = () => ({ status: 0, stdout: "", stderr: "" });
    expect(countContentionBackends({ run })).toBe(0);
  });
});

describe("startContention liveness gate", () => {
  it("REFUSES to return a handle when no backend ever attaches", async () => {
    // The whole point: a run that silently measures an idle system is worse
    // than a run that fails, because its table is published as evidence.
    const run: Runner = () => ({ status: 0, stdout: "0\n", stderr: "" });
    await expect(
      startContention({ profile: "read", workers: 2, scanPct: 2, maxSeconds: 30, container: "nope", run }),
    ).rejects.toThrow(ContentionError);
  }, 20000);

  it("reports the OBSERVED backend count, not the requested worker count", async () => {
    const run: Runner = () => ({ status: 0, stdout: "1\n", stderr: "" });
    const h = await startContention({
      profile: "read",
      workers: 8,
      scanPct: 2,
      maxSeconds: 30,
      container: "nope",
      run,
    });
    expect(h.workers).toBe(8);
    expect(h.liveBackends).toBe(1);
    h.stop();
  }, 20000);

  it("an off profile is inert and claims no load", () => {
    expect(noContention()).toMatchObject({ profile: "off", workers: 0, liveBackends: 0 });
  });
});
