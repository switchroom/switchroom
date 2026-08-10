import { describe, expect, it, vi } from "vitest";
import {
  addUtcDays,
  fetchAndSummarizeExternalSpend,
  formatUsd,
  isExternalModel,
  normalizeDailyActivityRows,
  shortModelLabel,
  summarizeExternalSpend,
  utcDateString,
  type LiteLLMDaySpendRow,
} from "./external-spend.js";

const NOW = new Date("2026-07-19T15:30:00.000Z");

describe("isExternalModel", () => {
  it("includes openrouter/sr/cash needles and excludes Claude", () => {
    expect(isExternalModel("openrouter/openai/gpt-oss-20b")).toBe(true);
    expect(isExternalModel("sr-grok-4.5")).toBe(true);
    expect(isExternalModel("gpt-oss-20b")).toBe(true);
    expect(isExternalModel("claude-sonnet-5")).toBe(false);
    expect(isExternalModel("openrouter/anthropic/claude-3.5-sonnet")).toBe(false);
    expect(isExternalModel("anthropic/claude-fable-5")).toBe(false);
  });
});

describe("shortModelLabel / formatUsd / dates", () => {
  it("shortens labels and formats money", () => {
    expect(shortModelLabel("openrouter/openai/gpt-oss-20b")).toBe("gpt-oss-20b");
    expect(shortModelLabel("sr-grok-4.5")).toBe("grok-4.5");
    expect(formatUsd(8.066)).toBe("$8.07");
    expect(formatUsd(-1)).toBe("$0.00");
  });
  it("UTC calendar helpers", () => {
    expect(utcDateString(NOW)).toBe("2026-07-19");
    expect(addUtcDays("2026-07-19", -6)).toBe("2026-07-13");
    expect(addUtcDays("2026-07-19", 1)).toBe("2026-07-20");
  });
});

describe("summarizeExternalSpend", () => {
  const rows: LiteLLMDaySpendRow[] = [
    {
      startTime: "2026-07-19",
      spend: 50,
      models: {
        "claude-sonnet-5": 40,
        "openrouter/openai/gpt-oss-20b": 6.1,
        "sr-grok-4.5": 1.18,
        "gemini-3.1-flash-lite": 0.79,
      },
    },
    {
      startTime: "2026-07-18",
      models: { "openrouter/openai/gpt-oss-20b": 10 },
    },
    {
      startTime: "2026-07-12",
      models: { "openrouter/openai/gpt-oss-20b": 100 },
    },
    {
      startTime: "2026-07-13",
      models: { "sr-deepseek-r1": 2 },
    },
  ];

  it("sums UTC today + 7d external only; top-3 from 7d", () => {
    const s = summarizeExternalSpend(rows, NOW);
    expect(s.day24hUsd).toBeCloseTo(8.07, 5);
    expect(s.day7dUsd).toBeCloseTo(20.07, 5);
    expect(s.top.map((t) => t.label)).toEqual([
      "gpt-oss-20b",
      "deepseek-r1",
      "grok-4.5",
    ]);
  });
});

describe("normalizeDailyActivityRows", () => {
  it("collapses breakdown.models[].metrics.spend into a flat day row", () => {
    const rows = normalizeDailyActivityRows({
      results: [
        {
          date: "2026-07-19",
          breakdown: {
            models: {
              "openrouter/openai/gpt-oss-20b": { metrics: { spend: 1.5 } },
              "claude-sonnet-5": { metrics: { spend: 9 } },
            },
          },
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startTime).toBe("2026-07-19");
    expect(rows[0]?.models).toEqual({
      "openrouter/openai/gpt-oss-20b": 1.5,
      "claude-sonnet-5": 9,
    });
  });

  it("tolerates missing/partial fields without throwing", () => {
    expect(normalizeDailyActivityRows({})).toEqual([]);
    expect(normalizeDailyActivityRows(null)).toEqual([]);
    // day with no breakdown → empty models map, not a crash.
    const rows = normalizeDailyActivityRows({ results: [{ date: "2026-07-19" }] });
    expect(rows[0]?.models).toEqual({});
  });
});

// Builds a healthy `/user/daily/activity` page envelope for the fetch tests.
function dailyActivityPage(
  results: Array<{ date: string; models: Record<string, number> }>,
  hasMore = false,
): unknown {
  return {
    results: results.map((r) => ({
      date: r.date,
      breakdown: {
        models: Object.fromEntries(
          Object.entries(r.models).map(([name, spend]) => [name, { metrics: { spend } }]),
        ),
      },
    })),
    metadata: { page: 1, total_pages: hasMore ? 2 : 1, has_more: hasMore },
  };
}

describe("fetchAndSummarizeExternalSpend", () => {
  it("returns null on 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const s = await fetchAndSummarizeExternalSpend({
      adminKey: "sk-x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(s).toBeNull();
  });

  // OUTCOME GUARD: locks the migration off the deprecated O(rows) endpoint.
  // The old code hit `/spend/logs` and read a FLAT `models[name]` number, so
  // it would (a) call the wrong URL and (b) parse this nested
  // `breakdown.models[].metrics.spend` body as zeros. Both assertions fail
  // on the pre-migration implementation.
  it("reads the pre-aggregated /user/daily/activity endpoint, not /spend/logs", async () => {
    const body = dailyActivityPage([
      {
        date: "2026-07-19",
        models: { "openrouter/openai/gpt-oss-20b": 1.5, "claude-sonnet-5": 9 },
      },
    ]);
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const s = await fetchAndSummarizeExternalSpend({
      adminKey: "sk-x",
      baseUrl: "http://litellm.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(calledUrl).toContain("/user/daily/activity");
    expect(calledUrl).not.toContain("/spend/logs");
    expect(calledUrl).toContain("start_date=2026-07-13");
    expect(calledUrl).toContain("end_date=2026-07-19");
    expect(calledUrl).toContain("timezone=0");
    // Nested spend correctly extracted; Claude passthrough excluded.
    expect(s?.day24hUsd).toBeCloseTo(1.5, 5);
    expect(s?.top[0]?.label).toBe("gpt-oss-20b");
  });

  // OUTCOME GUARD: pagination. The daily table paginates over raw rows, so a
  // large fleet spills a UTC day across pages; the fetch must walk `has_more`
  // and MERGE every page's per-model spend. The single-request old path could
  // never satisfy this.
  it("walks pagination and merges per-model spend across pages", async () => {
    const page1 = dailyActivityPage(
      [{ date: "2026-07-19", models: { "openrouter/openai/gpt-oss-20b": 4 } }],
      true,
    );
    const page2 = dailyActivityPage(
      [
        { date: "2026-07-19", models: { "openrouter/openai/gpt-oss-20b": 2 } },
        { date: "2026-07-18", models: { "sr-grok-4.5": 3 } },
      ],
      false,
    );
    const pages = [page1, page2];
    const seenPages: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      seenPages.push(u.match(/page=(\d+)/)?.[1] ?? "?");
      const idx = u.includes("page=2") ? 1 : 0;
      return new Response(JSON.stringify(pages[idx]), { status: 200 });
    });
    const s = await fetchAndSummarizeExternalSpend({
      adminKey: "sk-x",
      baseUrl: "http://litellm.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(seenPages).toEqual(["1", "2"]);
    // gpt-oss split 4 + 2 across pages → 6 today; grok 3 in-window (7d).
    expect(s?.day24hUsd).toBeCloseTo(6, 5);
    expect(s?.day7dUsd).toBeCloseTo(9, 5);
    expect(s?.top[0]?.label).toBe("gpt-oss-20b");
    expect(s?.top[0]?.usd).toBeCloseTo(6, 5);
  });
});
