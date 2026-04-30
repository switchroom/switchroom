import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecallLog } from "../src/cli/memory.js";

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
