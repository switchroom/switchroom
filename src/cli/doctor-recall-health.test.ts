/**
 * Regression guard for the 2026-07 silent auto-recall degradation.
 *
 * The bug: on the busiest banks the agent's OWN bank hit its per-request
 * timeout on ~90% of fires, so agents ran with no memory — and every surface
 * stayed green for weeks. These tests assert the OUTCOME (a red doctor row on
 * fleet-shaped degraded telemetry), not merely that the classifier is callable.
 *
 * The fixtures below are shaped from the real 2026-07-26 `recall_log.jsonl`
 * snapshot, so `classifyRecallHealth` fed the actual production rows of that
 * week must fail. Before this check existed, nothing did.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  RECALL_HEALTH_MAX_TAIL_BYTES,
  RECALL_HEALTH_MIN_SAMPLE,
  RECALL_HEALTH_WINDOW_ROWS,
  RECALL_OWN_BANK_TIMEOUT_FAIL_RATE,
  RECALL_OWN_BANK_TIMEOUT_WARN_RATE,
  type RecallLogRow,
  checkAgentRecallHealth,
  classifyRecallHealth,
  readRecallLogTail,
  recallLogPath,
  summarizeRecallRows,
} from "./doctor-recall-health.js";

/** A healthy row: own bank answered inside budget. */
function healthyRow(bank: string, elapsedMs = 3000): RecallLogRow {
  return {
    bank_id: bank,
    result_count: 6,
    total_elapsed_ms: elapsedMs,
    deadline_hit: false,
    bank_timings: [
      { bank_id: bank, elapsed_ms: elapsedMs - 5, timed_out: false, errored: false },
      { bank_id: "ken-profile", elapsed_ms: 1400, timed_out: false, errored: false },
    ],
  };
}

/**
 * A degraded row in the exact shape the outage produced: own bank abandoned at
 * the 8s per-bank timeout, side bank fine. Note `result_count` is non-zero —
 * this is the masking case that made the outage look survivable in
 * result-count-only telemetry.
 */
function ownBankTimedOutRow(bank: string, resultCount = 0): RecallLogRow {
  return {
    bank_id: bank,
    result_count: resultCount,
    total_elapsed_ms: 8023,
    deadline_hit: true,
    bank_timings: [
      { bank_id: bank, elapsed_ms: 8018, timed_out: true, errored: false },
      { bank_id: "ken-profile", elapsed_ms: 4584, timed_out: false, errored: false },
    ],
  };
}

function ownBankErroredRow(bank: string): RecallLogRow {
  return {
    bank_id: bank,
    result_count: 0,
    total_elapsed_ms: 15,
    deadline_hit: false,
    bank_timings: [{ bank_id: bank, elapsed_ms: 12, timed_out: false, errored: true }],
  };
}

describe("summarizeRecallRows", () => {
  it("attributes a timeout to the OWN bank only, not to side banks", () => {
    // A side bank timing out while the own bank answers is NOT degradation:
    // the agent still got its own memory. If this were counted, the check
    // would cry wolf on every shared-profile-bank hiccup.
    const rows: RecallLogRow[] = [
      {
        bank_id: "overlord",
        result_count: 4,
        total_elapsed_ms: 8030,
        bank_timings: [
          { bank_id: "overlord", elapsed_ms: 4721, timed_out: false, errored: false },
          { bank_id: "ken-profile", elapsed_ms: 8030, timed_out: true, errored: false },
        ],
      },
    ];
    const stats = summarizeRecallRows(rows);
    expect(stats.considered).toBe(1);
    expect(stats.ownBankTimeouts).toBe(0);
  });

  it("identifies the own bank by id, not by position in bank_timings", () => {
    // recall.py emits the own bank first today. Matching on position would
    // make this check silently stop working if that ever changed — the exact
    // class of latent no-op that let the original bug hide.
    const rows: RecallLogRow[] = [
      {
        bank_id: "overlord",
        result_count: 0,
        bank_timings: [
          { bank_id: "ken-profile", elapsed_ms: 1400, timed_out: false, errored: false },
          { bank_id: "overlord", elapsed_ms: 8018, timed_out: true, errored: false },
        ],
      },
    ];
    expect(summarizeRecallRows(rows).ownBankTimeouts).toBe(1);
  });

  it("ignores legacy rows that predate the bank_timings field", () => {
    const rows: RecallLogRow[] = [
      { bank_id: "overlord", result_count: 0 },
      healthyRow("overlord"),
    ];
    expect(summarizeRecallRows(rows).considered).toBe(1);
  });

  it("computes the median of reported elapsed times", () => {
    const rows = [
      healthyRow("a", 1000),
      healthyRow("a", 3000),
      healthyRow("a", 9000),
    ];
    expect(summarizeRecallRows(rows).medianElapsedMs).toBe(3000);
  });
});

describe("classifyRecallHealth — the 2026-07 outage must go red", () => {
  it("FAILS on overlord's real degradation rate (96.8% own-bank timeouts)", () => {
    // The precise production shape: 269 of 278 fires lost the own bank.
    // This is the assertion that would have fired in the outage's first week.
    const rows = [
      ...Array.from({ length: 269 }, () => ownBankTimedOutRow("overlord")),
      ...Array.from({ length: 9 }, () => healthyRow("overlord")),
    ];
    const result = classifyRecallHealth("overlord", summarizeRecallRows(rows));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("own bank");
    expect(result.fix).toBeTruthy();
  });

  it("FAILS even when degraded recalls still return results from side banks", () => {
    // The masking case. Result-count-based telemetry rates this fleet as
    // "returning memories" while every one of those memories came from the
    // shared profile bank and none from the agent's own history.
    const rows = Array.from({ length: 100 }, () => ownBankTimedOutRow("klanker", 6));
    const result = classifyRecallHealth("klanker", summarizeRecallRows(rows));
    expect(result.status).toBe("fail");
  });

  it("FAILS on hard own-bank errors, not just timeouts", () => {
    const rows = Array.from({ length: 50 }, () => ownBankErroredRow("carrie"));
    expect(classifyRecallHealth("carrie", summarizeRecallRows(rows)).status).toBe("fail");
  });

  it("is OK on a healthy fleet", () => {
    const rows = Array.from({ length: 100 }, () => healthyRow("finn"));
    const result = classifyRecallHealth("finn", summarizeRecallRows(rows));
    expect(result.status).toBe("ok");
    expect(result.fix).toBeUndefined();
  });

  it("does not treat a genuinely empty match as degradation", () => {
    // Zero results with a healthy own bank is normal: the bank simply had
    // nothing relevant. Scoring on result_count alone would red the whole
    // fleet permanently and train operators to ignore the row.
    const rows = Array.from({ length: 100 }, () => ({
      ...healthyRow("gymbro"),
      result_count: 0,
    }));
    expect(classifyRecallHealth("gymbro", summarizeRecallRows(rows)).status).toBe("ok");
  });

  it("warns between the warn and fail thresholds", () => {
    const total = 100;
    const bad = Math.round(
      total * ((RECALL_OWN_BANK_TIMEOUT_WARN_RATE + RECALL_OWN_BANK_TIMEOUT_FAIL_RATE) / 2),
    );
    const rows = [
      ...Array.from({ length: bad }, () => ownBankTimedOutRow("marko")),
      ...Array.from({ length: total - bad }, () => healthyRow("marko")),
    ];
    expect(classifyRecallHealth("marko", summarizeRecallRows(rows)).status).toBe("warn");
  });

  it("scores exactly at the fail threshold as fail (boundary is inclusive)", () => {
    const total = 100;
    const bad = total * RECALL_OWN_BANK_TIMEOUT_FAIL_RATE;
    const rows = [
      ...Array.from({ length: bad }, () => ownBankTimedOutRow("reggie")),
      ...Array.from({ length: total - bad }, () => healthyRow("reggie")),
    ];
    expect(classifyRecallHealth("reggie", summarizeRecallRows(rows)).status).toBe("fail");
  });

  it("does not score below the sample floor, but still reports the counts", () => {
    const rows = Array.from({ length: RECALL_HEALTH_MIN_SAMPLE - 1 }, () =>
      ownBankTimedOutRow("ziggy"),
    );
    const result = classifyRecallHealth("ziggy", summarizeRecallRows(rows));
    expect(result.status).toBe("ok");
    // Honest, not silent: an operator can still see it is 100% degraded.
    expect(result.detail).toContain("not scored");
    expect(result.detail).toContain("own bank");
  });

  it("reports an idle agent as ok with an explicit no-telemetry detail", () => {
    const result = classifyRecallHealth("newbie", summarizeRecallRows([]));
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("no recall telemetry");
  });

  it("does not call an agent idle when its rows merely predate bank_timings", () => {
    // Review finding (#3626). kdogg on the 2026-07-26 host has 12 real recall
    // rows, none carrying `bank_timings`. Both that and a never-run agent land
    // on considered === 0, and both used to report "agent idle, or plugin not
    // yet fired" — false for kdogg, and it sends the operator hunting a dead
    // plugin that is in fact running fine.
    const legacyRows = Array.from({ length: 12 }, () => ({
      bank_id: "kdogg",
      result_count: 3,
      total_elapsed_ms: 620,
    }));
    const stats = summarizeRecallRows(legacyRows);
    expect(stats.considered).toBe(0);
    expect(stats.rowsSeen).toBe(12);

    const result = classifyRecallHealth("kdogg", stats);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("12 recall rows");
    expect(result.detail).toContain("bank_timings");
    // The load-bearing assertion: it must NOT claim the agent is idle.
    expect(result.detail).not.toContain("agent idle");
  });
});

describe("readRecallLogTail", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "recall-health-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns [] for a missing log rather than throwing", () => {
    withTmp((dir) => {
      expect(readRecallLogTail(join(dir, "nope.jsonl"))).toEqual([]);
    });
  });

  it("reads only the trailing window, so old healthy history cannot mask a live regression", () => {
    withTmp((dir) => {
      const p = join(dir, "recall_log.jsonl");
      const old = Array.from({ length: 500 }, () => JSON.stringify(healthyRow("overlord")));
      const recent = Array.from({ length: RECALL_HEALTH_WINDOW_ROWS }, () =>
        JSON.stringify(ownBankTimedOutRow("overlord")),
      );
      writeFileSync(p, [...old, ...recent].join("\n") + "\n");

      const rows = readRecallLogTail(p);
      expect(rows).toHaveLength(RECALL_HEALTH_WINDOW_ROWS);
      // The whole point: averaged over all 700 rows this would be 29% and the
      // window keeps it at 100%, i.e. the check tracks NOW, not history.
      expect(classifyRecallHealth("overlord", summarizeRecallRows(rows)).status).toBe("fail");
    });
  });

  it("reads a bounded tail, not the whole unbounded log", () => {
    withTmp((dir) => {
      const p = join(dir, "recall_log.jsonl");
      // `recall_log.jsonl` is append-only and never rotated. Pad it past the
      // byte cap with rows that would classify HEALTHY, then append a window
      // of degraded rows. If the reader ever slurps the whole file, the padding
      // is cheap to produce but expensive to read — and, more testably, the
      // padded rows would dilute the window.
      const filler = JSON.stringify(healthyRow("overlord"));
      const fillerCount = Math.ceil(
        (RECALL_HEALTH_MAX_TAIL_BYTES * 2) / (filler.length + 1),
      );
      const lines = Array.from({ length: fillerCount }, () => filler);
      for (let i = 0; i < RECALL_HEALTH_WINDOW_ROWS; i++) {
        lines.push(JSON.stringify(ownBankTimedOutRow("overlord")));
      }
      writeFileSync(p, lines.join("\n") + "\n");
      expect(statSync(p).size).toBeGreaterThan(RECALL_HEALTH_MAX_TAIL_BYTES);

      const rows = readRecallLogTail(p);
      expect(rows).toHaveLength(RECALL_HEALTH_WINDOW_ROWS);
      expect(classifyRecallHealth("overlord", summarizeRecallRows(rows)).status).toBe("fail");
    });
  });

  it("drops the partial row a byte-offset read starts on", () => {
    withTmp((dir) => {
      const p = join(dir, "recall_log.jsonl");
      // Every row here is degraded. If the mid-row fragment at the read
      // boundary were kept it would fail to parse and be silently dropped, so
      // the count is the observable: exactly the rows that fully fit, never a
      // fragment counted as a row.
      const row = JSON.stringify(ownBankTimedOutRow("overlord"));
      const count = Math.ceil((RECALL_HEALTH_MAX_TAIL_BYTES * 1.5) / (row.length + 1));
      writeFileSync(p, Array.from({ length: count }, () => row).join("\n") + "\n");

      const rows = readRecallLogTail(p, 100_000);
      expect(rows.length).toBeGreaterThan(0);
      // Bounded by the byte cap, not by the file's true row count.
      expect(rows.length).toBeLessThan(count);
      expect(rows.every((r) => r.bank_id === "overlord")).toBe(true);
    });
  });

  it("skips a torn final line instead of failing the check", () => {
    withTmp((dir) => {
      const p = join(dir, "recall_log.jsonl");
      writeFileSync(
        p,
        [JSON.stringify(healthyRow("a")), '{"bank_id":"a","bank_tim'].join("\n"),
      );
      expect(readRecallLogTail(p)).toHaveLength(1);
    });
  });
});

describe("checkAgentRecallHealth", () => {
  it("reads the log from the agent's host-side scaffold path", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-agent-"));
    try {
      const p = recallLogPath(dir);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        Array.from({ length: 60 }, () => JSON.stringify(ownBankTimedOutRow("overlord"))).join(
          "\n",
        ),
      );
      const result = checkAgentRecallHealth("overlord", dir);
      expect(result.status).toBe("fail");
      expect(result.name).toBe("overlord auto-recall");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is ok (not a crash) when the agent has never run", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-agent-empty-"));
    try {
      expect(checkAgentRecallHealth("ghost", dir).status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
