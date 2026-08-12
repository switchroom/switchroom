import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsTooLargeError, ProbeError, probeMetrics, probeSpool } from "./probe.js";
import { evaluateFailureRate } from "./evaluate.js";
import { METRICS_MAX_BYTES } from "./thresholds.js";
import type { Sample } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-probe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hindsight(agent: string): string {
  const d = join(dir, agent, "home", ".hindsight");
  mkdirSync(d, { recursive: true });
  return d;
}

function queue(agent: string, files: Record<string, string>): void {
  const d = join(hindsight(agent), "pending-retains");
  mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
}

describe("probeSpool — what counts as a queued entry", () => {
  it("counts *.json as pending and *.json.dead as dead, and nothing else", () => {
    queue("alpha", {
      "1-a-x.json": "{}",
      "2-b-y.json": "{}",
      "3-c-z.json.dead": "{}",
      // A torn tmp+rename leaves these behind (8 live on the fleet today).
      // They are not queue entries and must not inflate the depth signal.
      "4-d-w.json.tmp": "{}",
      "README": "not an entry",
    });
    expect(probeSpool(dir)).toEqual({ pending: 2, dead: 1, evicted: 0, drops: 0, duplicates: 0, agents: 1 });
  });

  it("sums across agents and ignores dirs with no spool at all", () => {
    queue("alpha", { "a.json": "{}" });
    queue("beta", { "b.json": "{}", "c.json.dead": "{}" });
    mkdirSync(join(dir, "gamma", "home"), { recursive: true }); // never spooled
    const s = probeSpool(dir);
    expect(s.pending).toBe(2);
    expect(s.dead).toBe(1);
    expect(s.agents).toBe(2);
  });

  it("THROWS when the agents dir is unreadable — blindness is a signal, not a zero", () => {
    expect(() => probeSpool(join(dir, "nope"))).toThrow(ProbeError);
  });
});

describe("probeSpool — #3599's loss channels are siblings, not queue entries", () => {
  it("counts pending-evicted/ separately and never as queue depth", () => {
    queue("alpha", { "a.json": "{}" });
    const ev = join(hindsight("alpha"), "pending-evicted");
    mkdirSync(ev, { recursive: true });
    writeFileSync(join(ev, "e1.json"), "{}");
    writeFileSync(join(ev, "e2.json"), "{}");
    const s = probeSpool(dir);
    expect(s.evicted).toBe(2);
    expect(s.pending).toBe(1); // NOT 3
  });

  it("counts pending-dead/ so relocating markers cannot zero the loss signal", () => {
    queue("alpha", { "a.json": "{}" });
    const dd = join(hindsight("alpha"), "pending-dead");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "d1.json.dead"), "{}");
    writeFileSync(join(dd, "d2.json.dead"), "{}");
    const s = probeSpool(dir);
    expect(s.dead).toBe(2);
    expect(s.pending).toBe(1); // NOT 3
  });

  it("counts pending-duplicate/ separately as duplicates, NOT as a loss channel (#3896)", () => {
    queue("alpha", { "a.json": "{}" });
    const dup = join(hindsight("alpha"), "pending-duplicate");
    mkdirSync(dup, { recursive: true });
    writeFileSync(join(dup, "q1.json"), "{}");
    writeFileSync(join(dup, "q2.json"), "{}");
    writeFileSync(join(dup, "q3.json"), "{}");
    const s = probeSpool(dir);
    expect(s.duplicates).toBe(3);
    // The surviving copy stays queued; collapsing must not touch any loss
    // channel or the live depth.
    expect(s.pending).toBe(1);
    expect(s.dead).toBe(0);
    expect(s.evicted).toBe(0);
    expect(s.drops).toBe(0);
  });

  it("counts dead in BOTH locations while legacy in-queue markers survive", () => {
    // A fleet mid-migration has markers in the old and the new place at once.
    // Counting only one would under-report the loss channel.
    queue("alpha", { "a.json": "{}", "legacy.json.dead": "{}" });
    const dd = join(hindsight("alpha"), "pending-dead");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "moved.json.dead"), "{}");
    expect(probeSpool(dir).dead).toBe(2);
  });

  it("sums the record_drop ledger count", () => {
    queue("alpha", {});
    writeFileSync(
      join(hindsight("alpha"), "pending-drops.json"),
      JSON.stringify({ schema: 1, count: 7, last_dropped_at: "2026-07-26T00:00:00Z" }),
    );
    queue("beta", {});
    writeFileSync(join(hindsight("beta"), "pending-drops.json"), JSON.stringify({ count: 3 }));
    expect(probeSpool(dir).drops).toBe(10);
  });

  it("reads 0 from a torn, foreign-shaped or absurdly large ledger rather than inventing a loss", () => {
    queue("torn", {});
    writeFileSync(join(hindsight("torn"), "pending-drops.json"), '{"count": 4');
    queue("foreign", {});
    writeFileSync(join(hindsight("foreign"), "pending-drops.json"), '"just a string"');
    queue("negative", {});
    writeFileSync(join(hindsight("negative"), "pending-drops.json"), '{"count": -5}');
    queue("huge", {});
    writeFileSync(
      join(hindsight("huge"), "pending-drops.json"),
      `{"count": 9, "junk": "${"x".repeat(70_000)}"}`,
    );
    // `retain-loss` fires on ANY rise, so a garbage read that produced a
    // number would page the operator about a memory that was never lost.
    expect(probeSpool(dir).drops).toBe(0);
  });

  it("still sees the loss channels when the queue dir itself has been removed", () => {
    // An operator clearing `pending-retains` must not silently zero the
    // eviction/drop history — a decrease is treated as a re-baseline by
    // `evaluateRetainLoss`, so hiding it here would lose the incident.
    const h = hindsight("alpha"); // no pending-retains dir at all
    mkdirSync(join(h, "pending-evicted"), { recursive: true });
    writeFileSync(join(h, "pending-evicted", "e1.json"), "{}");
    writeFileSync(join(h, "pending-drops.json"), JSON.stringify({ count: 2 }));
    const s = probeSpool(dir);
    expect(s.evicted).toBe(1);
    expect(s.drops).toBe(2);
    expect(s.agents).toBe(0); // no readable queue dir
  });
});

describe("an over-cap /metrics body degrades instead of blinding the tick", () => {
  const EXPOSITION = [
    "# TYPE hindsight_operation_operations_total counter",
    'hindsight_operation_operations_total{operation="retain",source="api",success="true"} 100.0',
    'hindsight_operation_operations_total{operation="retain",source="api",success="false"} 3.0',
    "",
  ].join("\n");

  function respond(body: string): typeof fetch {
    return (async () =>
      new Response(new TextEncoder().encode(body), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
  }

  it("reads a normal body into retain counters", async () => {
    const m = await probeMetrics("http://x/metrics", respond(EXPOSITION));
    expect(m.retain).toEqual({ ok: 100, fail: 3 });
  });

  it("throws MetricsTooLargeError — not a bare ProbeError — past the cap", async () => {
    const huge = `${EXPOSITION}# ${"x".repeat(METRICS_MAX_BYTES)}\n`;
    await expect(probeMetrics("http://x/metrics", respond(huge))).rejects.toBeInstanceOf(
      MetricsTooLargeError,
    );
  });

  it("still throws a plain ProbeError on a non-200, which DOES blind the tick", async () => {
    const bad = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const err = await probeMetrics("http://x/metrics", bad).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect(err).not.toBeInstanceOf(MetricsTooLargeError);
  });
});

describe("evaluateFailureRate with missing retain counters", () => {
  function tick(ts: number, counts: { retainOk?: number; retainFail?: number }): Sample {
    return {
      ts,
      ...counts,
      pending: 0,
      dead: 0,
      evicted: 0,
      drops: 0,
      restartCount: 0,
      startedAt: "2026-07-27T00:00:00Z",
      health: "healthy",
    };
  }

  it("reports no-data, never ok, when NO tick carried counters", () => {
    // The whole point of MetricsTooLargeError degrading rather than throwing:
    // the retain signal must go inert, not clean. An `ok` here would report a
    // healthy retain path that was never actually measured.
    const v = evaluateFailureRate([tick(0, {}), tick(60_000, {}), tick(120_000, {})]);
    expect(v.state).toBe("no-data");
  });

  it("scores the intervals it HAS and ignores the gap, without diluting the rate", () => {
    // 0 → 1: 100 ok / 100 fail (a 50% storm). 1 → 2: no counters. 2 → 3: the
    // counters resume at the same values, so the only measurable interval is
    // the storm. Zero-filling the gap would halve the rate to 25% and pass.
    const ring = [
      tick(0, { retainOk: 0, retainFail: 0 }),
      tick(60_000, { retainOk: 100, retainFail: 100 }),
      tick(120_000, {}),
      tick(180_000, { retainOk: 100, retainFail: 100 }),
    ];
    const v = evaluateFailureRate(ring);
    expect(v.state).toBe("breach");
    expect((v.measured as { rate: number }).rate).toBeCloseTo(0.5, 6);
  });
});

// ── the per-bank consolidation and HNSW probes ──────────────────────────

import { probeBankConsolidation, probeVectorIndexes } from "./probe.js";
import type { Runner } from "./probe.js";

/** A runner that answers every `docker exec` with one canned stdout. */
function psql(stdout: string, status = 0): Runner {
  return () => ({ status, stdout, stderr: "" });
}

describe("probeBankConsolidation", () => {
  it("parses the live incident output into streaks and per-bank depth", () => {
    const out = probeBankConsolidation(
      "c",
      psql("S|overlord|consolidation|103|668|9412\nP|overlord|38130\nP|carrie|45\nP|klanker|0\n"),
    );
    expect(out).toEqual({
      streaks: [
        {
          bank: "overlord",
          operationType: "consolidation",
          streak: 103,
          newestFailureAgeS: 668,
          lastCompletedAgeS: 9412,
        },
      ],
      pending: [
        { bank: "overlord", pending: 38130 },
        { bank: "carrie", pending: 45 },
        { bank: "klanker", pending: 0 },
      ],
    });
  });

  it("returns null — not an empty, healthy-looking block — when psql fails", () => {
    expect(probeBankConsolidation("c", psql("", 1))).toBeNull();
  });

  it("returns null when NOTHING parsed: a live fleet always has ≥1 bank", () => {
    // The dangerous shape: the query changed shape / the container answered
    // with a banner. `{streaks: [], pending: []}` would evaluate as a clean
    // pass on both signals for ever.
    expect(probeBankConsolidation("c", psql("psql: could not connect\n"))).toBeNull();
  });

  it("skips a malformed row but keeps the rows it understood", () => {
    const out = probeBankConsolidation(
      "c",
      psql("S|weird|bank|with|pipes|x|9|1|2\nS|overlord|consolidation|7|30|61\nP|overlord|12\n"),
    );
    expect(out?.streaks).toEqual([
      {
        bank: "overlord",
        operationType: "consolidation",
        streak: 7,
        newestFailureAgeS: 30,
        lastCompletedAgeS: 61,
      },
    ]);
    expect(out?.pending).toEqual([{ bank: "overlord", pending: 12 }]);
  });

  it("carries an EMPTY last-completed field through as null — never completed", () => {
    // A pair whose very first op failed has no completion to age from. Null is
    // a real state and a different one from "unreadable": the evaluator treats
    // it as no success ever, which is a breach, so it must not be conflated
    // with the absent field an older state file carries.
    const out = probeBankConsolidation("c", psql("S|newbank|graph_maintenance|4|900|\nP|newbank|3\n"));
    expect(out?.streaks).toEqual([
      {
        bank: "newbank",
        operationType: "graph_maintenance",
        streak: 4,
        newestFailureAgeS: 900,
        lastCompletedAgeS: null,
      },
    ]);
  });

  it("parses the live 2026-08-12 sparse shape, last success 220h back", () => {
    const out = probeBankConsolidation(
      "c",
      psql("S|overlord|graph_maintenance|19|133977|791908\nP|overlord|0\n"),
    );
    expect(out?.streaks).toEqual([
      {
        bank: "overlord",
        operationType: "graph_maintenance",
        streak: 19,
        newestFailureAgeS: 133_977,
        lastCompletedAgeS: 791_908,
      },
    ]);
  });

  it("ABSTAINS on a garbled last-completed field — keeps the streak, drops the field", () => {
    // A dropped streak row reads as HEALTH, which is the exact failure this
    // whole change exists to remove. The unreadable field is discarded; the
    // streak and its failure age, which parsed fine, are not. Absent ≠ null:
    // the evaluator must not read a garbled field as "never completed".
    for (const garbage of ["NaN", "-1", "yesterday"]) {
      expect(
        probeBankConsolidation("c", psql(`S|b|graph_maintenance|9|900|${garbage}\nP|b|4\n`))?.streaks,
      ).toEqual([{ bank: "b", operationType: "graph_maintenance", streak: 9, newestFailureAgeS: 900 }]);
    }
  });

  it("accepts the pre-#4618 FIVE-field row as unknown, not as 'never'", () => {
    // A stale container or a rolled-back query still emits the old shape.
    // Dropping those rows would blind every signal on the block.
    expect(probeBankConsolidation("c", psql("S|b|consolidation|7|30\nP|b|4\n"))?.streaks).toEqual([
      { bank: "b", operationType: "consolidation", streak: 7, newestFailureAgeS: 30 },
    ]);
  });

  it("pins the arity at BOTH ends — a 7-field row is a row we did not understand", () => {
    // Open-ended `>= 5` would silently accept a row whose bank id contains a
    // `|`, mis-assigning every field after it. Seven fields is not a shape
    // this query can emit, so it is a parse failure, not a longer row.
    expect(
      probeBankConsolidation("c", psql("S|b|consolidation|7|30|60|99\nP|b|4\n"))?.streaks,
    ).toEqual([]);
    // Four fields likewise: too short to carry a failure age at all.
    expect(probeBankConsolidation("c", psql("S|b|consolidation|7\nP|b|4\n"))?.streaks).toEqual([]);
  });

  it("rejects a negative or non-numeric count rather than trusting it", () => {
    expect(probeBankConsolidation("c", psql("S|b|consolidation|-1|30|60\nP|b|4\n"))?.streaks).toEqual([]);
    expect(probeBankConsolidation("c", psql("S|b|consolidation|NaN|30|60\nP|b|4\n"))?.streaks).toEqual([]);
  });
});

// ── the retention floor on the streak scan (#4620) ──────────────────────

import { spawnSync } from "node:child_process";
import { BANK_CONSOLIDATION_SH, RETENTION_DAYS_SH, bankConsolidationQuery } from "./probe.js";

describe("the streak scan's retention floor", () => {
  /** Run the real derivation under `sh` and read back the days it resolved. */
  const resolve = (env: Record<string, string>): string =>
    spawnSync("sh", ["-c", `${RETENTION_DAYS_SH}\nprintf '%s' "$RD"`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    }).stdout;

  it("derives the horizon from the pruner's own knob, not from a constant here", () => {
    // Unset is the fleet's actual state, and 30 is what
    // `docker/hindsight-maintenance.sh:63` then prunes at.
    expect(resolve({})).toBe("30");
    // The case the review note flagged: an operator who tunes the knob down
    // must move the floor with it, or completions in the 7–30 day band are
    // already deleted while failures in that band still count.
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "7" })).toBe("7");
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "90" })).toBe("90");
  });

  it("refuses anything that is not a plain number — the value is spliced into SQL", () => {
    for (const bad of ["", "abc", "30x", "-5", "7 OR 1=1", "$(id)", "1;DROP TABLE async_operations"]) {
      expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: bad })).toBe("30");
    }
  });

  it("clamps 0 to one day — a floor of now() would delete this signal", () => {
    // RETENTION_DAYS=0 prunes every completion on sight. Flooring at now()
    // would empty the candidate list and report health for ever.
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "0" })).toBe("1");
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "1" })).toBe("1");
  });

  it("clamps an absurdly large horizon — make_interval takes an int, not a bigint", () => {
    // All-digits is not enough. `make_interval(days => 3000000000)` raises
    // `function make_interval(days => bigint) does not exist` (verified on
    // pg16), psql exits non-zero, and BOTH bank signals degrade to `no-data`
    // off one knob typo.
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "3000000000" })).toBe("30");
    // A value too large for the shell to compare at all takes the same branch.
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "9".repeat(40) })).toBe("30");
    // The boundary itself: a century is allowed, a century and a day is not.
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "36500" })).toBe("36500");
    expect(resolve({ SWITCHROOM_HINDSIGHT_RETENTION_DAYS: "36501" })).toBe("30");
  });

  it("the shipped statement floors the failure scan with the resolved horizon", () => {
    // The unbounded scan is what #4620 is about: it must not survive as the
    // bound, and the floor must be the shell-resolved value rather than a
    // literal baked in here.
    expect(BANK_CONSOLIDATION_SH).toContain("now() - make_interval(days => $RD)");
    expect(BANK_CONSOLIDATION_SH).toMatch(/created_at > greatest\(\(SELECT max\(b\.created_at\)/);
    expect(BANK_CONSOLIDATION_SH).not.toMatch(/created_at > coalesce\(/);
    // No `-infinity` sentinel: `greatest` ignores NULLs, so one inside the
    // `greatest` would be INERT while reading as though it widened the window
    // for a never-completed pair. Verified on pg16 —
    // `greatest(coalesce(NULL::timestamptz,'-infinity'), now()-interval '30 days')`
    // is `IS NOT DISTINCT FROM` the same expression without the coalesce. This
    // asserts it does not come back as documentation-by-dead-code. (The
    // OUTCOME of all of this is asserted against a real PostgreSQL in
    // streak-retention-floor.pg.test.ts.)
    expect(bankConsolidationQuery("$RD")).not.toContain("-infinity");
  });
});

describe("probeVectorIndexes", () => {
  const notice = (probed: number, bad: string[]) =>
    `NOTICE:  VECIDX|${probed}|${bad.length}|${bad.map((b) => b + ";").join("")}\n`;

  it("parses the measured healthy sweep", () => {
    expect(probeVectorIndexes("c", psql(notice(89, [])))).toEqual({ probed: 89, corrupt: [] });
  });

  it("parses a corrupt index, preserving the name and the error", () => {
    const out = probeVectorIndexes(
      "c",
      psql(notice(88, ["idx_mu_emb_obsv_81cef5f6a42e4b4d=different vector dimensions 384 and 0"])),
    );
    expect(out?.probed).toBe(88);
    expect(out?.corrupt).toEqual(["idx_mu_emb_obsv_81cef5f6a42e4b4d=different vector dimensions 384 and 0"]);
  });

  it("keeps an error that contains a pipe — the tail is re-joined, not truncated", () => {
    const out = probeVectorIndexes("c", psql(notice(88, ["idx_a=bad tuple a|b"])));
    expect(out?.corrupt).toEqual(["idx_a=bad tuple a|b"]);
  });

  it("returns null — never `ok` — when the count and the parsed list disagree", () => {
    // Fail-closed: if we cannot read the answer we say so. `{probed, corrupt: []}`
    // here would report a corrupt fleet as clean.
    expect(probeVectorIndexes("c", psql("NOTICE:  VECIDX|88|2|idx_a=boom;\n"))).toBeNull();
  });

  it("returns null when the NOTICE never arrived", () => {
    expect(probeVectorIndexes("c", psql("\n"))).toBeNull();
    expect(probeVectorIndexes("c", psql(notice(89, []), 1))).toBeNull();
  });

  it("actually asks the database — the generated SQL carries the count(nn) shape", () => {
    // The elision guard from probe.ts: aggregate over `*` and the planner
    // drops the correlated subquery, so the sweep touches no index and passes
    // on a corrupt one. Assert the shipped statement over the wire.
    let sql = "";
    probeVectorIndexes("c", (_cmd, args) => {
      sql = args[args.length - 1] ?? "";
      return { status: 0, stdout: notice(1, []), stderr: "" };
    });
    expect(sql).toContain("count(nn)");
    expect(sql).not.toContain("count(*)");
    expect(sql).toContain("pg_get_expr(i.indpred, i.indrelid)");
    expect(sql).toContain("amname = 'hnsw'");
  });

  it("clamps the sample size to a positive integer before splicing it", () => {
    let sql = "";
    const cap: Runner = (_c, args) => {
      sql = args[args.length - 1] ?? "";
      return { status: 0, stdout: notice(1, []), stderr: "" };
    };
    probeVectorIndexes("c", cap, 3.9);
    expect(sql).toContain("r.tbl, r.pred, 3)");
    probeVectorIndexes("c", cap, -5);
    expect(sql).toContain("r.tbl, r.pred, 1)");
  });
});
