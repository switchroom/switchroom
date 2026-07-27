import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  evaluateAll,
  evaluateRecallCandidateFloor,
  evaluateRecallInjectedScore,
  evaluateRecallLatency,
  evaluateRecallOwnBankTimeout,
  evaluateRecallZeroMemory,
} from "./evaluate.js";
import {
  probeRecallLogs,
  readRecallLogTail,
  recallLogPath,
  summarizeRecallRows,
  withinWindow,
  RECALL_MAX_ROW_AGE_MS,
  type RecallLogRow,
} from "./recall-log.js";
import { RECALL_MIN_SAMPLES } from "./thresholds.js";
import type { Sample } from "./types.js";

/**
 * These tests assert OUTCOMES, not code paths.
 *
 * The bar: feed the reducer a log shaped like the incident that went
 * undetected for six weeks — 86 % own-bank timeouts, 47 % zero-memory turns, a
 * collapsed candidate pool, near-zero injected scores, p95 pinned to the
 * deadline — and require every signal to reach **page**, not merely "breach"
 * or "not ok". A test that only proved the function returns a Verdict would
 * have passed against the code as it stood before this change, when the
 * signals did not exist at all.
 *
 * The numbers below are the real fleet measurement taken on 2026-07-27 across
 * 2109 rows / 12 agents, not invented values.
 */

const NOW = Date.parse("2026-07-27T07:00:00Z");
const HEALTHY_SCORE = 0.31;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-recall-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RowOpts {
  ts?: number;
  ownTimedOut?: boolean;
  ownErrored?: boolean;
  resultCount?: number;
  preCap?: number;
  overlapDropped?: number;
  score?: number | null;
  elapsedMs?: number;
  error?: string | null;
}

/** A row shaped exactly like the live logs (verified against overlord's file). */
function row(o: RowOpts = {}): RecallLogRow {
  return {
    ts: new Date(o.ts ?? NOW - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    bank_id: "overlord",
    result_count: o.resultCount ?? 6,
    total_elapsed_ms: o.elapsedMs ?? 1200,
    deadline_hit: Boolean(o.ownTimedOut),
    pre_cap_count: o.preCap ?? 26,
    overlap_dropped: o.overlapDropped ?? 7,
    injected_score_max: o.score === undefined ? HEALTHY_SCORE : o.score,
    cache_hit: false,
    error: o.error ?? null,
    bank_timings: [
      {
        bank_id: "overlord",
        elapsed_ms: o.elapsedMs ?? 1200,
        timed_out: Boolean(o.ownTimedOut),
        errored: Boolean(o.ownErrored),
      },
      { bank_id: "ken-profile", elapsed_ms: 531, timed_out: false, errored: false },
    ],
  };
}

/**
 * The observed incident: of 100 rows, 86 own-bank timeouts, 47 zero-memory
 * turns, candidate pool collapsed to ~0, injected score p50 ~0.001, and
 * latency pinned to the 8 s deadline.
 */
function incidentRows(n = 100): RecallLogRow[] {
  const out: RecallLogRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      row({
        ts: NOW - (n - i) * 60_000,
        ownTimedOut: i < 86,
        resultCount: i < 47 ? 0 : 6,
        preCap: 0,
        overlapDropped: 0,
        score: 0.0011,
        elapsedMs: i < 86 ? 8023 : 900,
        error: i < 86 ? "ReadTimeout: HTTPConnectionPool(host='127.0.0.1', port=4010)" : null,
      }),
    );
  }
  return out;
}

/** A fleet in the state everyone believed it was in. */
function healthyRows(n = 100): RecallLogRow[] {
  const out: RecallLogRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      row({
        ts: NOW - (n - i) * 60_000,
        resultCount: i < 10 ? 0 : 6,
        preCap: 30,
        overlapDropped: 4,
        score: HEALTHY_SCORE,
        elapsedMs: 1100,
      }),
    );
  }
  return out;
}

function ringOf(rows: RecallLogRow[]): Sample[] {
  return [
    {
      ts: NOW,
      retainOk: 0,
      retainFail: 0,
      pending: 0,
      dead: 0,
      evicted: 0,
      drops: 0,
      restartCount: 0,
      startedAt: "2026-07-27T00:00:00Z",
      health: "healthy",
      recall: summarizeRecallRows(rows),
    },
  ];
}

describe("summarizeRecallRows", () => {
  it("measures the incident's rates against per-SLI denominators", () => {
    const s = summarizeRecallRows(incidentRows());
    expect(s.rows).toBe(100);
    expect(s.ownBankDegraded / s.timeoutConsidered).toBeCloseTo(0.86, 5);
    expect(s.zeroResult / s.zeroConsidered).toBeCloseTo(0.47, 5);
    expect(s.poolMedian).toBe(0);
    expect(s.scoreP50).toBeCloseTo(0.0011, 6);
    expect(s.elapsedP95Ms).toBe(8023);
  });

  it("adds the overlap-gate drops back into the candidate pool", () => {
    // Scoring pre_cap_count alone would read 1 here and page for an "empty
    // index", pointing at the wrong fix when the gate is simply aggressive.
    const s = summarizeRecallRows([row({ preCap: 1, overlapDropped: 40 })]);
    expect(s.poolMedian).toBe(41);
  });

  it("excludes cache hits from every denominator", () => {
    const hit: RecallLogRow = {
      ts: new Date(NOW - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      bank_id: "overlord",
      result_count: undefined,
      cache_hit: true,
      bank_timings: [],
      injected_score_max: null,
      total_elapsed_ms: undefined,
    };
    const s = summarizeRecallRows([...healthyRows(10), hit, hit, hit]);
    expect(s.rows).toBe(10);
    expect(s.zeroConsidered).toBe(10);
    expect(s.timeoutConsidered).toBe(10);
  });

  it("counts a row-carrying field only for its own SLI", () => {
    // Topic-filtered rows carry result_count but no bank_timings. A shared
    // denominator would dilute the timeout rate by these rows.
    const partial: RecallLogRow = { ts: "2026-07-27T06:59:00Z", bank_id: "x", result_count: 0 };
    const s = summarizeRecallRows([...incidentRows(100), partial, partial]);
    expect(s.timeoutConsidered).toBe(100);
    expect(s.zeroConsidered).toBe(102);
  });

  it("surfaces the modal error string, and nothing when rows predate the field", () => {
    expect(summarizeRecallRows(incidentRows()).topError).toBe(
      "ReadTimeout: HTTPConnectionPool(host='127.0.0.1', port=4010)",
    );
    expect(summarizeRecallRows(incidentRows()).errorRows).toBe(86);
    const legacy = incidentRows().map((r) => {
      const { error: _drop, ...rest } = r;
      return rest;
    });
    expect(summarizeRecallRows(legacy).topError).toBeNull();
    expect(summarizeRecallRows(legacy).errorRows).toBe(0);
  });
});

describe("recall signals fire at PAGE level on the real incident", () => {
  const ring = ringOf(incidentRows());

  it("own-bank timeout: 86% pages", () => {
    const v = evaluateRecallOwnBankTimeout(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.rate).toBeCloseTo(0.86, 5);
  });

  it("zero-memory: 47% pages", () => {
    const v = evaluateRecallZeroMemory(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("candidate floor pages — the signal that sees a fast, successful, empty recall", () => {
    const v = evaluateRecallCandidateFloor(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("injected score pages — the other signal for that same failure shape", () => {
    const v = evaluateRecallInjectedScore(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("latency pages at a p95 pinned to the deadline", () => {
    const v = evaluateRecallLatency(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("puts the reason, not just the rate, into the operator DM", () => {
    expect(evaluateRecallOwnBankTimeout(ring).detail).toContain("ReadTimeout");
  });
});

describe("recall signals stay silent on a healthy fleet", () => {
  const ring = ringOf(healthyRows());

  it("no recall signal breaches", () => {
    for (const v of evaluateAll(ring)) {
      if (!v.signal.startsWith("recall-")) continue;
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=ok`);
    }
  });
});

describe("the fast-empty failure shape specifically", () => {
  it("pages on pool+score while timeout, zero-memory and latency all read clean", () => {
    // Every bank answered, quickly, with a non-empty result — the exact shape
    // `doctor-recall-health.ts` cannot see, and the reason the candidate-floor
    // and injected-score signals exist.
    const rows: RecallLogRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(
        row({
          ts: NOW - (100 - i) * 60_000,
          ownTimedOut: false,
          resultCount: 6,
          preCap: 2,
          overlapDropped: 0,
          score: 0.002,
          elapsedMs: 700,
        }),
      );
    }
    const ring = ringOf(rows);
    expect(evaluateRecallOwnBankTimeout(ring).state).toBe("ok");
    expect(evaluateRecallZeroMemory(ring).state).toBe("ok");
    expect(evaluateRecallLatency(ring).state).toBe("ok");
    expect(evaluateRecallCandidateFloor(ring).severity).toBe("page");
    expect(evaluateRecallInjectedScore(ring).severity).toBe("page");
  });
});

describe("fail-closed reduction", () => {
  it("reports no-data rather than ok below the sample floor", () => {
    const ring = ringOf(incidentRows(RECALL_MIN_SAMPLES - 1));
    for (const v of [
      evaluateRecallOwnBankTimeout(ring),
      evaluateRecallZeroMemory(ring),
      evaluateRecallCandidateFloor(ring),
      evaluateRecallInjectedScore(ring),
      evaluateRecallLatency(ring),
    ]) {
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=no-data`);
    }
  });

  it("reports no-data, not ok, when no recall telemetry was collected at all", () => {
    const ring = ringOf([]);
    ring[0]!.recall = null;
    expect(evaluateRecallOwnBankTimeout(ring).state).toBe("no-data");
    expect(evaluateRecallCandidateFloor(ring).state).toBe("no-data");
  });
});

describe("withinWindow", () => {
  it("drops rows older than the age cap so a frozen log cannot page forever", () => {
    const stale = row({ ts: NOW - RECALL_MAX_ROW_AGE_MS - 60_000 });
    const fresh = row({ ts: NOW - 60_000 });
    expect(withinWindow([stale, fresh], NOW)).toEqual([fresh]);
  });

  it("keeps a row whose ts is unparseable (a torn write, not an old row)", () => {
    const torn = { ...row(), ts: "not-a-date" };
    expect(withinWindow([torn], NOW)).toHaveLength(1);
  });

  it("drops future-dated rows", () => {
    expect(withinWindow([row({ ts: NOW + 3_600_000 })], NOW)).toHaveLength(0);
  });
});

describe("readRecallLogTail / probeRecallLogs", () => {
  function writeLog(agent: string, rows: RecallLogRow[]): void {
    const p = recallLogPath(join(dir, agent));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  it("returns only the trailing window", () => {
    writeLog("a", incidentRows(50));
    expect(readRecallLogTail(recallLogPath(join(dir, "a")), 10)).toHaveLength(10);
  });

  it("skips a torn final line instead of failing the whole read", () => {
    const p = recallLogPath(join(dir, "a"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(row())}\n{"ts":"2026-07-27T06:5`);
    expect(readRecallLogTail(p)).toHaveLength(1);
  });

  it("returns [] for an absent log rather than throwing", () => {
    expect(readRecallLogTail(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("pages across a whole fleet read from disk", () => {
    writeLog("alpha", incidentRows(60));
    writeLog("beta", incidentRows(60));
    mkdirSync(join(dir, "gamma"), { recursive: true }); // agent with no log yet
    const stats = probeRecallLogs(dir, NOW);
    expect(stats.agents).toBe(2);
    expect(stats.rows).toBe(120);

    const ring = ringOf([]);
    ring[0]!.recall = stats;
    expect(evaluateRecallOwnBankTimeout(ring).severity).toBe("page");
    expect(evaluateRecallCandidateFloor(ring).severity).toBe("page");
    expect(evaluateRecallInjectedScore(ring).severity).toBe("page");
  });

  it("throws when the agents dir itself is unreadable — a blind probe is not a clean bill", () => {
    expect(() => probeRecallLogs(join(dir, "missing"), NOW)).toThrow();
  });
});
