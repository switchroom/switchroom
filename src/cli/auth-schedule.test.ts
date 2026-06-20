// Unit tests for the pure helpers behind `switchroom auth schedule`. Broker IO
// is NOT mocked — we test the model/classify/format helpers directly with the
// broker response shapes as plain typed args (mirrors auth-google.test.ts).
// The load-bearing assertion is classifyState: the 5h-vs-weekly distinction.

import { describe, it, expect } from "vitest";
import { _testing, type WindowSnapshot, type ScheduleRow } from "./auth-schedule.js";
import type { ListStateData, ProbeQuotaData } from "../auth/broker/client.js";

const {
  resolveWindow,
  classifyState,
  buildScheduleRows,
  formatDuration,
  formatResetDay,
  formatFiveHourCell,
  formatWeeklyCell,
  formatStateCell,
  formatScheduleRows,
} = _testing;

const NOW = new Date("2026-06-07T06:00:00.000Z"); // Sunday
const WEEKLY_RESET = new Date("2026-06-14T01:00:00.000Z"); // Sun (next week)
const FIVE_RESET = new Date("2026-06-07T07:10:00.000Z"); // ~1h out

const NONE: WindowSnapshot = {
  fiveHourPct: null,
  fiveHourResetAt: null,
  weeklyPct: null,
  weeklyResetAt: null,
  source: "none",
  overageServeBlocking: false,
};

describe("formatDuration", () => {
  it("formats days/hours/minutes and collapses to now", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5)).toBe("now");
    expect(formatDuration(4 * 60_000)).toBe("4m");
    expect(formatDuration(2 * 3_600_000 + 18 * 60_000)).toBe("2h 18m");
    expect(formatDuration(5 * 86_400_000 + 3 * 3_600_000)).toBe("5d 3h");
  });
});

describe("formatResetDay (deterministic across host tz)", () => {
  it("renders weekday + 24h time in the requested zone", () => {
    expect(formatResetDay(WEEKLY_RESET, "UTC")).toBe("Sun 01:00");
    // Melbourne is UTC+10 → 01:00 UTC = 11:00 local, still Sunday.
    expect(formatResetDay(WEEKLY_RESET, "Australia/Melbourne")).toBe("Sun 11:00");
    // A Mon 19:00 UTC weekly anchor lands Tuesday morning in Melbourne (UTC+10).
    expect(formatResetDay(new Date("2026-06-08T19:00:00Z"), "Australia/Melbourne")).toBe("Tue 05:00");
  });
});

describe("classifyState — the 5h-vs-weekly distinction", () => {
  const win = (over: Partial<typeof NONE>) => ({ ...NONE, ...over });

  it("not exhausted with data → healthy", () => {
    expect(
      classifyState({ exhausted: false, exhaustedUntil: null, window: win({ weeklyPct: 8 }), now: NOW }),
    ).toBe("healthy");
  });

  it("not exhausted, no data, no ledger → unprobed", () => {
    expect(
      classifyState({ exhausted: false, exhaustedUntil: null, window: NONE, now: NOW }),
    ).toBe("unprobed");
  });

  it("exhausted with until ≈ WEEKLY reset → weekly-walled (precise match)", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: WEEKLY_RESET,
        window: win({ weeklyResetAt: WEEKLY_RESET, fiveHourResetAt: FIVE_RESET }),
        now: NOW,
      }),
    ).toBe("weekly-walled");
  });

  it("exhausted with until ≈ 5h reset → 5h-walled (precise match)", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: FIVE_RESET,
        window: win({ weeklyResetAt: WEEKLY_RESET, fiveHourResetAt: FIVE_RESET }),
        now: NOW,
      }),
    ).toBe("5h-walled");
  });

  it("exhausted, no window data, reset ~2.5h out → 5h-walled (heuristic)", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: new Date("2026-06-07T08:30:00Z"),
        window: NONE,
        now: NOW,
      }),
    ).toBe("5h-walled");
  });

  it("exhausted, no window data, reset ~2d out → weekly-walled (heuristic)", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: new Date("2026-06-09T05:00:00Z"),
        window: NONE,
        now: NOW,
      }),
    ).toBe("weekly-walled");
  });

  it("maxed weekly (>=99.5%) → weekly-walled even when exhausted_until is the sooner 5h reset", () => {
    // The real-world case: the 5h window resets in ~27m, but weekly is 100% till Tue.
    const fiveSoon = new Date("2026-06-07T06:27:00Z");
    const weeklyTue = new Date("2026-06-09T19:00:00Z");
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: fiveSoon,
        window: win({ fiveHourPct: 0, fiveHourResetAt: fiveSoon, weeklyPct: 100, weeklyResetAt: weeklyTue, source: "live" }),
        now: NOW,
      }),
    ).toBe("weekly-walled");
  });

  it("exhausted_until already in the past → healthy", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: new Date("2026-06-07T05:00:00Z"),
        window: NONE,
        now: NOW,
      }),
    ).toBe("healthy");
  });

  it("overageServeBlocking (out_of_credits) → out-of-credits, WINS over healthy util", () => {
    // 0% util would otherwise classify healthy; the dead-credits signal wins.
    expect(
      classifyState({
        exhausted: false,
        exhaustedUntil: null,
        window: win({ fiveHourPct: 0, weeklyPct: 0, overageServeBlocking: true }),
        now: NOW,
      }),
    ).toBe("out-of-credits");
  });

  it("overageServeBlocking wins over a maxed weekly window too", () => {
    expect(
      classifyState({
        exhausted: true,
        exhaustedUntil: WEEKLY_RESET,
        window: win({ weeklyPct: 100, weeklyResetAt: WEEKLY_RESET, overageServeBlocking: true }),
        now: NOW,
      }),
    ).toBe("out-of-credits");
  });

  it("org_level_disabled at 75% (overageServeBlocking false) → unchanged (healthy)", () => {
    // The benign reason never sets overageServeBlocking, so util governs as before.
    expect(
      classifyState({
        exhausted: false,
        exhaustedUntil: null,
        window: win({ fiveHourPct: 75, weeklyPct: 40, overageServeBlocking: false }),
        now: NOW,
      }),
    ).toBe("healthy");
  });
});

describe("resolveWindow — live preferred, cached fallback, ISO→Date", () => {
  const account = {
    label: "default",
    exhausted: false,
    last_quota: {
      fiveHourUtilizationPct: 40,
      sevenDayUtilizationPct: 8,
      fiveHourResetAt: "2026-06-07T07:10:00.000Z",
      sevenDayResetAt: "2026-06-14T01:00:00.000Z",
      representativeClaim: "five_hour",
      overageStatus: null,
      overageDisabledReason: null,
      capturedAt: 1,
    },
  };

  it("prefers a live ok probe and keeps Date reset fields", () => {
    const probe: ProbeQuotaData = {
      results: [
        {
          label: "default",
          result: {
            ok: true,
            data: {
              fiveHourUtilizationPct: 41,
              sevenDayUtilizationPct: 9,
              fiveHourResetAt: FIVE_RESET,
              sevenDayResetAt: WEEKLY_RESET,
              representativeClaim: "five_hour",
              overageStatus: null,
              overageDisabledReason: null,
            },
          },
        },
      ],
    };
    const w = resolveWindow(account as never, probe);
    expect(w.source).toBe("live");
    expect(w.weeklyPct).toBe(9);
    expect(w.weeklyResetAt?.getTime()).toBe(WEEKLY_RESET.getTime());
  });

  it("falls back to cached snapshot (ISO strings → Date) when probe is ok:false", () => {
    const probe: ProbeQuotaData = {
      results: [{ label: "default", result: { ok: false, reason: "HTTP 429" } }],
    };
    const w = resolveWindow(account as never, probe);
    expect(w.source).toBe("cached");
    expect(w.weeklyPct).toBe(8);
    expect(w.weeklyResetAt instanceof Date).toBe(true);
    expect(w.weeklyResetAt?.toISOString()).toBe("2026-06-14T01:00:00.000Z");
  });

  it("returns source=none when no probe and no cache", () => {
    const w = resolveWindow({ label: "x", exhausted: false } as never, undefined);
    expect(w).toEqual(NONE);
  });

  it("propagates a serve-blocking overage reason from a live probe", () => {
    const probe: ProbeQuotaData = {
      results: [
        {
          label: "default",
          result: {
            ok: true,
            data: {
              fiveHourUtilizationPct: 0,
              sevenDayUtilizationPct: 0,
              fiveHourResetAt: null,
              sevenDayResetAt: null,
              representativeClaim: null,
              overageStatus: "rejected",
              overageDisabledReason: "out_of_credits",
            },
          },
        },
      ],
    };
    expect(resolveWindow(account as never, probe).overageServeBlocking).toBe(true);
  });

  it("does NOT flag a benign org_level_disabled reason from the cached snapshot", () => {
    const benign = {
      ...account,
      last_quota: { ...account.last_quota, overageStatus: "rejected", overageDisabledReason: "org_level_disabled" },
    };
    const w = resolveWindow(benign as never, undefined);
    expect(w.source).toBe("cached");
    expect(w.overageServeBlocking).toBe(false);
  });
});

function makeState(): ListStateData {
  return {
    active: "default",
    fallback_order: ["default", "secondary"],
    accounts: [
      {
        label: "default",
        exhausted: false,
        last_quota: {
          fiveHourUtilizationPct: 40,
          sevenDayUtilizationPct: 8,
          fiveHourResetAt: "2026-06-07T07:10:00.000Z",
          sevenDayResetAt: "2026-06-14T01:00:00.000Z",
          representativeClaim: "five_hour",
          overageStatus: null,
          overageDisabledReason: null,
          capturedAt: 1,
        },
      },
      { label: "secondary", exhausted: true, exhausted_until: Date.parse("2026-06-07T08:30:00Z") },
      { label: "bob@example.com", exhausted: true, exhausted_until: Date.parse("2026-06-09T05:00:00Z") },
    ],
    agents: [],
    consumers: [],
  } as ListStateData;
}

describe("buildScheduleRows", () => {
  const rows = buildScheduleRows(makeState(), undefined, NOW);

  it("marks active + fallback ranks + excluded", () => {
    expect(rows[0]).toMatchObject({ label: "default", isActive: true, fallbackRank: 1 });
    expect(rows[1]).toMatchObject({ label: "secondary", isActive: false, fallbackRank: 2 });
    expect(rows[2]).toMatchObject({ label: "bob@example.com", isActive: false, fallbackRank: null });
  });

  it("classifies each account's window state from the ledger", () => {
    expect(rows[0].state).toBe("healthy"); // active, cached, not exhausted
    expect(rows[1].state).toBe("5h-walled"); // ~2.5h out
    expect(rows[2].state).toBe("weekly-walled"); // ~2d out
  });
});

describe("formatStateCell horizon", () => {
  it("weekly-walled shows the WEEKLY reset horizon, not the sooner 5h reset", () => {
    const row: ScheduleRow = {
      label: "x",
      isActive: false,
      fallbackRank: 2,
      window: {
        fiveHourPct: 0,
        fiveHourResetAt: new Date("2026-06-07T06:27:00Z"),
        weeklyPct: 100,
        weeklyResetAt: new Date("2026-06-09T19:00:00Z"),
        source: "live",
        overageServeBlocking: false,
      },
      exhausted: true,
      exhaustedUntil: new Date("2026-06-07T06:27:00Z"),
      state: "weekly-walled",
    };
    const cell = formatStateCell(row, NOW);
    expect(cell).toContain("weekly-walled");
    expect(cell).toContain("2d"); // ~2d to Tuesday, NOT the 27m 5h reset
    expect(cell).not.toContain("27m");
  });

  it("renders the out-of-credits state (no countdown horizon)", () => {
    const row: ScheduleRow = {
      label: "x",
      isActive: false,
      fallbackRank: 2,
      window: { ...NONE, fiveHourPct: 0, weeklyPct: 0, source: "live", overageServeBlocking: true },
      exhausted: false,
      exhaustedUntil: null,
      state: "out-of-credits",
    };
    expect(formatStateCell(row, NOW)).toBe("out-of-credits");
  });
});

describe("cell formatters", () => {
  it("em-dash on missing data; otherwise pct + day", () => {
    expect(formatFiveHourCell(NONE, NOW)).toBe("—");
    expect(formatWeeklyCell(NONE, NOW)).toBe("—");
    const w = { ...NONE, fiveHourPct: 40, fiveHourResetAt: FIVE_RESET, weeklyPct: 8, weeklyResetAt: WEEKLY_RESET, source: "live" as const, overageServeBlocking: false };
    expect(formatFiveHourCell(w, NOW)).toBe("40% · 1h 10m");
    expect(formatWeeklyCell(w, NOW, "UTC")).toBe("8% · Sun 01:00 (6d 19h)");
  });
});

describe("formatScheduleRows (no-color)", () => {
  const lines = formatScheduleRows(buildScheduleRows(makeState(), undefined, NOW), NOW, {
    color: false,
    tz: "Australia/Melbourne",
  });

  it("emits a header + one line per account, no ANSI", () => {
    expect(lines).toHaveLength(4); // header + 3 accounts
    expect(lines[0]).toContain("ACCOUNT");
    expect(lines[0]).toContain("WEEKLY WINDOW");
    for (const l of lines) expect(l).not.toMatch(/\[/); // no escape codes
  });

  it("active row shows the ● glyph, pool, and weekly reset day", () => {
    expect(lines[1]).toContain("●");
    expect(lines[1]).toContain("active #1");
    expect(lines[1]).toContain("Sun 11:00"); // a Sunday weekly anchor, Melbourne
    expect(lines[1]).toContain("healthy");
  });

  it("walled rows surface which window walled them", () => {
    expect(lines[2]).toContain("5h-walled");
    expect(lines[3]).toContain("weekly-walled");
    expect(lines[3]).toContain("excluded");
  });
});
