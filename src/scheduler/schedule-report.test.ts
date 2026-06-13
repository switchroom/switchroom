import { describe, expect, it } from "vitest";
import {
  formatScheduleReport,
  parseScheduleJsonl,
  summarizeScheduleReport,
  type ScheduleReportRow,
} from "./schedule-report.js";

const rows: ScheduleReportRow[] = [
  { tier: "poll", exitCode: 0, startedAt: 100 },
  { tier: "poll", exitCode: 0, startedAt: 200 },
  { tier: "poll", exitCode: -3, startedAt: 250 }, // poll error
  { tier: "action", exitCode: 0, startedAt: 260 }, // model-free action (cost 0)
  { tier: "action", exitCode: -4, startedAt: 270 }, // action error
  { tier: "cheap", exitCode: 0, modelUsed: "claude-sonnet-4-6", startedAt: 300 },
  { tier: "main", exitCode: 0, startedAt: 400 },
  { tier: "main", exitCode: -2, startedAt: 450 }, // deferred
  { exitCode: 0, startedAt: 500 }, // legacy untiered → main
];

describe("summarizeScheduleReport", () => {
  it("counts by tier, errors, deferred, cost-weight", () => {
    const s = summarizeScheduleReport(rows);
    expect(s).toMatchObject({
      total: 9,
      pollFires: 3,
      actionFires: 2,
      cheapFires: 1,
      mainFires: 3, // 2 main + 1 legacy untiered
      errors: 2, // the -3 poll error + the -4 action error (deferred -2 excluded)
      deferred: 1,
      costWeight: 0 * 3 + 0 * 2 + 1 * 1 + 5 * 3, // actions are free = 16
    });
    expect(s.byModel).toEqual({ "claude-sonnet-4-6": 1 });
  });

  it("respects --since", () => {
    const s = summarizeScheduleReport(rows, { sinceMs: 400 });
    expect(s.total).toBe(3); // startedAt 400, 450, 500
    expect(s.pollFires).toBe(0);
  });

  it("empty → all zero", () => {
    expect(summarizeScheduleReport([])).toMatchObject({ total: 0, pollFires: 0, costWeight: 0 });
  });
});

describe("parseScheduleJsonl", () => {
  it("parses rows and skips blank/malformed lines", () => {
    const blob = [
      JSON.stringify({ tier: "poll", exitCode: 0 }),
      "",
      "{not json",
      JSON.stringify({ tier: "main", exitCode: 0 }),
      JSON.stringify({ noExitCode: true }),
    ].join("\n");
    expect(parseScheduleJsonl(blob)).toHaveLength(2);
  });
});

describe("formatScheduleReport", () => {
  it("shows the model-free % (poll + action)", () => {
    const out = formatScheduleReport("marko", summarizeScheduleReport(rows));
    expect(out).toContain("marko");
    expect(out).toContain("56% model-free"); // (3 poll + 2 action) / 9
  });
});
