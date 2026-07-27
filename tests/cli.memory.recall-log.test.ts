import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecallLog, formatRecallLogView } from "../src/cli/memory.js";

describe("readRecallLog", () => {
  let agentDir: string;
  let logPath: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "recall-log-"));
    const stateDir = join(
      agentDir,
      ".claude",
      "plugins",
      "data",
      "hindsight-memory-inline",
      "state",
    );
    mkdirSync(stateDir, { recursive: true });
    logPath = join(stateDir, "recall_log.jsonl");
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns empty array when the log file doesn't exist", () => {
    expect(readRecallLog(agentDir, 10)).toEqual([]);
  });

  it("returns empty array for an unrelated agent path", () => {
    expect(readRecallLog("/nonexistent/path", 10)).toEqual([]);
  });

  it("parses well-formed JSONL lines", () => {
    const lines = [
      { ts: "2026-04-30T10:00:00Z", bank_id: "coach", result_count: 12, capped: false },
      { ts: "2026-04-30T10:01:00Z", bank_id: "coach", result_count: 12, capped: true, pre_cap_count: 18 },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const out = readRecallLog(agentDir, 10);
    expect(out).toHaveLength(2);
    expect(out[0].bank_id).toBe("coach");
    expect(out[1].capped).toBe(true);
    expect(out[1].pre_cap_count).toBe(18);
  });

  it("tails the last N entries when limit is below the line count", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ ts: `2026-04-30T${String(i).padStart(2, "0")}:00:00Z`, result_count: i }));
    }
    writeFileSync(logPath, lines.join("\n") + "\n");

    const out = readRecallLog(agentDir, 5);
    expect(out).toHaveLength(5);
    expect(out[0].result_count).toBe(45);
    expect(out[4].result_count).toBe(49);
  });

  it("skips malformed lines silently (telemetry is best-effort)", () => {
    writeFileSync(
      logPath,
      [
        JSON.stringify({ ts: "ok", result_count: 1 }),
        "{this is not json",
        JSON.stringify({ ts: "ok2", result_count: 2 }),
      ].join("\n") + "\n",
    );

    const out = readRecallLog(agentDir, 10);
    expect(out).toHaveLength(2);
    expect(out[0].ts).toBe("ok");
    expect(out[1].ts).toBe("ok2");
  });

  it("ignores blank lines", () => {
    writeFileSync(
      logPath,
      `\n${JSON.stringify({ ts: "x" })}\n\n\n${JSON.stringify({ ts: "y" })}\n`,
    );

    const out = readRecallLog(agentDir, 10);
    expect(out).toHaveLength(2);
  });
});

// --- 2026-07-25 re-review M2: directives_omitted must be operator-visible ---
//
// `src/cli/doctor-memory.ts` and the vendored plugin's
// scripts/lib/directives.py both describe the recall_log's
// `directives_omitted` field as an operator-visible signal, but the human view
// of `switchroom memory recall-log` never printed it — it was reachable only
// via `--json`. A dropped directive is invisible to the agent by construction,
// so this is the operator's only channel for "a rule stopped being enforced".
describe("formatRecallLogView — directives_omitted", () => {
  // Strip ANSI colour so assertions are about content, not chalk's TTY mode.
  const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  const strip = (s: string) => s.replace(ANSI, "");

  it("reads directives_omitted off the log through the typed interface", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-log-omitted-"));
    const stateDir = join(
      dir, ".claude", "plugins", "data", "hindsight-memory-inline", "state",
    );
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "recall_log.jsonl"),
      JSON.stringify({ ts: "2026-07-25T10:00:00Z", result_count: 5, directives_omitted: 4 }) + "\n",
    );
    try {
      expect(readRecallLog(dir, 10)[0].directives_omitted).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a +Nomitted marker per row and rolls the count into the summary", () => {
    const out = formatRecallLogView("clerk", [
      { ts: "2026-07-25T10:00:00Z", result_count: 5, directives_omitted: 4 },
      { ts: "2026-07-25T10:01:00Z", result_count: 6, directives_omitted: 0 },
    ]).map(strip);

    expect(out.join("\n")).toContain("+4omitted");
    // Only the turn that actually dropped directives counts.
    expect(out[1]).toContain("directives_omitted_turns=1");
    // A zero-omission row carries no marker.
    expect(out[3]).not.toContain("omitted");
  });

  it("stays silent when nothing was omitted (no noise on the healthy path)", () => {
    const out = formatRecallLogView("clerk", [
      { ts: "2026-07-25T10:00:00Z", result_count: 5, directives_omitted: 0 },
      { ts: "2026-07-25T10:01:00Z", result_count: 6 },
    ]).map(strip);
    expect(out.join("\n")).not.toContain("omitted");
  });
});

// Switchroom #3541 — recall QUALITY telemetry. Every pre-existing field on a
// recall_log row measures VOLUME. With the lexical overlap gate removed
// outright, precision rests entirely on the engine's `scores.final` plus the
// max_memories head-slice — so a rollout that fed each agent `max_memories`
// mediocre memories per turn would raise `avg`/`max` and fill `result_count`
// to the cap, i.e. read as unambiguous success. These assert the score range
// actually reaches the operator.
describe("formatRecallLogView — injected relevance scores", () => {
  const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  const strip = (s: string) => s.replace(ANSI, "");

  it("prints the per-row min/median/max and a mean-of-medians summary", () => {
    const out = formatRecallLogView("clerk", [
      {
        ts: "2026-07-25T10:00:00Z",
        result_count: 3,
        injected_score_min: 0.8,
        injected_score_median: 0.85,
        injected_score_max: 0.9,
      },
      {
        ts: "2026-07-25T10:01:00Z",
        result_count: 3,
        injected_score_min: 0.1,
        injected_score_median: 0.15,
        injected_score_max: 0.2,
      },
    ]).map(strip);

    expect(out[2]).toContain("score=0.80/0.85/0.90");
    expect(out[3]).toContain("score=0.10/0.15/0.20");
    // Mean of the two medians: (0.85 + 0.15) / 2 = 0.5.
    expect(out[1]).toContain("avg_score=0.5");
  });

  it("distinguishes a full-but-weak turn from a full-and-strong one", () => {
    const weak = formatRecallLogView("clerk", [
      { ts: "t", result_count: 8, injected_score_min: 0.02, injected_score_median: 0.05, injected_score_max: 0.09 },
    ]).map(strip);
    const strong = formatRecallLogView("clerk", [
      { ts: "t", result_count: 8, injected_score_min: 0.70, injected_score_median: 0.80, injected_score_max: 0.95 },
    ]).map(strip);

    // Identical volume — the old summary line could not tell these apart.
    expect(weak[1]).toContain("avg=8 max=8");
    expect(strong[1]).toContain("avg=8 max=8");
    // The quality number does.
    expect(weak[1]).toContain("avg_score=0.05");
    expect(strong[1]).toContain("avg_score=0.8");
  });

  it("renders an em dash rather than 0 when no row carries a score", () => {
    const out = formatRecallLogView("clerk", [
      { ts: "2026-07-25T10:00:00Z", result_count: 2 },
      { ts: "2026-07-25T10:01:00Z", cache_hit: true, injected_score_median: null },
    ]).map(strip);
    expect(out[1]).toContain("avg_score=—");
    expect(out.join("\n")).not.toContain("score=0.00");
  });
});
