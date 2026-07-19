import { describe, expect, it, vi } from "vitest";
import {
  addUtcDays,
  fetchAndSummarizeExternalSpend,
  formatUsd,
  isExternalModel,
  normalizeSpendLogRows,
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

describe("normalizeSpendLogRows", () => {
  it("accepts array or {data}", () => {
    expect(normalizeSpendLogRows([{ startTime: "x" }])).toHaveLength(1);
    expect(normalizeSpendLogRows({ data: [{ startTime: "x" }] })).toHaveLength(1);
    expect(normalizeSpendLogRows({})).toEqual([]);
  });
});

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

  it("summarizes OK body", async () => {
    const body = [
      {
        startTime: "2026-07-19",
        models: { "openrouter/openai/gpt-oss-20b": 1.5, "claude-sonnet-5": 9 },
      },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain("start_date=2026-07-13");
      expect(String(url)).toContain("end_date=2026-07-20");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const s = await fetchAndSummarizeExternalSpend({
      adminKey: "sk-x",
      baseUrl: "http://litellm.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(s?.day24hUsd).toBeCloseTo(1.5, 5);
    expect(s?.top[0]?.label).toBe("gpt-oss-20b");
  });
});
