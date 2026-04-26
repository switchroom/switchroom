import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTurnUsages,
  summarizeCache,
  formatCacheStatsText,
  type TurnUsage,
} from "../src/agents/perf.js";

/**
 * Cache telemetry parser + summarizer. Fixture-driven: write a tiny
 * JSONL with mixed line types (assistant w/ usage, user, attachment,
 * malformed, assistant w/ split cache_creation, assistant w/ flat
 * cache_creation_input_tokens) and assert the math at every layer.
 */

function makeJsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("readTurnUsages", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "perf-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] for missing file", () => {
    expect(readTurnUsages(join(tmp, "missing.jsonl"), 20)).toEqual([]);
  });

  it("returns [] for lastN <= 0", () => {
    const path = join(tmp, "empty.jsonl");
    writeFileSync(path, "");
    expect(readTurnUsages(path, 0)).toEqual([]);
    expect(readTurnUsages(path, -1)).toEqual([]);
  });

  it("parses flat cache_creation_input_tokens shape", () => {
    const path = join(tmp, "flat.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "assistant",
          timestamp: "2026-04-26T08:00:00Z",
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 8000,
              cache_creation_input_tokens: 2000,
            },
          },
        },
      ]),
    );
    const turns = readTurnUsages(path, 20);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      cacheRead: 8000,
      cacheCreate: 2000,
      ephemeral1h: 0,
      ephemeral5m: 0,
      input: 100,
      output: 50,
    });
    expect(turns[0].ts).toBe(Date.parse("2026-04-26T08:00:00Z"));
  });

  it("parses split cache_creation { ephemeral_1h, ephemeral_5m }", () => {
    const path = join(tmp, "split.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 300, // flat, authoritative
              cache_creation: {
                ephemeral_1h_input_tokens: 200,
                ephemeral_5m_input_tokens: 100,
              },
            },
          },
        },
      ]),
    );
    const [turn] = readTurnUsages(path, 20);
    expect(turn.cacheCreate).toBe(300); // flat wins
    expect(turn.ephemeral1h).toBe(200);
    expect(turn.ephemeral5m).toBe(100);
  });

  it("falls back to split sum when only the split is present", () => {
    const path = join(tmp, "splitonly.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation: {
                ephemeral_1h_input_tokens: 700,
                ephemeral_5m_input_tokens: 300,
              },
            },
          },
        },
      ]),
    );
    const [turn] = readTurnUsages(path, 20);
    expect(turn.cacheCreate).toBe(1000);
    expect(turn.ephemeral1h).toBe(700);
    expect(turn.ephemeral5m).toBe(300);
  });

  it("skips malformed JSON, user lines, and attachment-only lines", () => {
    const path = join(tmp, "mixed.jsonl");
    writeFileSync(
      path,
      [
        // Valid assistant w/ usage
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 5,
              output_tokens: 5,
              cache_read_input_tokens: 1000,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        // user line — skipped
        JSON.stringify({ type: "user", message: { content: "hello" } }),
        // assistant w/ no usage — skipped
        JSON.stringify({ type: "assistant", message: { content: "ok" } }),
        // assistant w/ usage but all zeros (looks like an attachment) — skipped
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        // malformed JSON — skipped
        "{not json at all",
        // empty line — skipped
        "",
        // Another valid one
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 10,
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 500,
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const turns = readTurnUsages(path, 20);
    expect(turns).toHaveLength(2);
    expect(turns[0].cacheRead).toBe(1000);
    expect(turns[1].cacheRead).toBe(2000);
  });

  it("respects lastN — only the most recent N turns are returned, in order", () => {
    const path = join(tmp, "many.jsonl");
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        type: "assistant",
        timestamp: `2026-04-26T08:${String(i).padStart(2, "0")}:00Z`,
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: i * 10,
            cache_creation_input_tokens: 100,
          },
        },
      });
    }
    writeFileSync(path, makeJsonl(rows));
    const turns = readTurnUsages(path, 5);
    expect(turns).toHaveLength(5);
    // Last 5: indices 45,46,47,48,49 — chronological order preserved
    expect(turns.map((t) => t.cacheRead)).toEqual([450, 460, 470, 480, 490]);
  });
});

describe("summarizeCache", () => {
  it("returns zeroed stats for empty input", () => {
    const s = summarizeCache([]);
    expect(s).toEqual({
      turnsAnalyzed: 0,
      hitRate: 0,
      avgCreatePerTurn: 0,
      avgReadPerTurn: 0,
      ttl1hShare: 0,
      firstTurnTs: null,
      lastTurnTs: null,
    });
  });

  it("computes hit rate, averages, ttl share, and window", () => {
    const turns: TurnUsage[] = [
      {
        cacheRead: 9000,
        cacheCreate: 1000,
        ephemeral1h: 800,
        ephemeral5m: 200,
        input: 0,
        output: 0,
        ts: 1_700_000_000_000,
      },
      {
        cacheRead: 8000,
        cacheCreate: 2000,
        ephemeral1h: 1600,
        ephemeral5m: 400,
        input: 0,
        output: 0,
        ts: 1_700_000_060_000,
      },
    ];
    const s = summarizeCache(turns);
    expect(s.turnsAnalyzed).toBe(2);
    // (9000+8000) / (9000+8000+1000+2000) = 17000/20000
    expect(s.hitRate).toBeCloseTo(0.85, 5);
    expect(s.avgCreatePerTurn).toBe(1500);
    expect(s.avgReadPerTurn).toBe(8500);
    // 2400 / (2400+600) = 0.8
    expect(s.ttl1hShare).toBeCloseTo(0.8, 5);
    expect(s.firstTurnTs).toBe(1_700_000_000_000);
    expect(s.lastTurnTs).toBe(1_700_000_060_000);
  });

  it("treats no cache activity as hitRate 0 (not NaN)", () => {
    const turns: TurnUsage[] = [
      {
        cacheRead: 0,
        cacheCreate: 0,
        ephemeral1h: 0,
        ephemeral5m: 0,
        input: 100,
        output: 50,
        ts: 0,
      },
    ];
    const s = summarizeCache(turns);
    expect(s.hitRate).toBe(0);
    expect(s.ttl1hShare).toBe(0);
  });
});

describe("formatCacheStatsText", () => {
  it("emits stable key:value lines", () => {
    const turns: TurnUsage[] = [
      {
        cacheRead: 9000,
        cacheCreate: 1000,
        ephemeral1h: 900,
        ephemeral5m: 100,
        input: 50,
        output: 25,
        ts: Date.parse("2026-04-26T08:00:00Z"),
      },
    ];
    const text = formatCacheStatsText("klanker", summarizeCache(turns));
    expect(text).toMatch(/^agent: klanker$/m);
    expect(text).toMatch(/^turns_analyzed: 1$/m);
    expect(text).toMatch(/^cache_hit_rate: 0\.900$/m);
    expect(text).toMatch(/^avg_create_per_turn: 1000$/m);
    expect(text).toMatch(/^avg_read_per_turn: 9000$/m);
    expect(text).toMatch(/^ttl_1h_share: 0\.900$/m);
    expect(text).toMatch(/^window: 2026-04-26T08:00:00Z \.\. 2026-04-26T08:00:00Z$/m);
  });
});
