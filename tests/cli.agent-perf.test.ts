import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCacheTelemetry } from "../src/agents/status.js";

/**
 * End-to-end check on the production cache-telemetry adapter:
 * `readCacheTelemetry(agentDir)` walks `<agentDir>/.claude/projects/.../*.jsonl`
 * via findLatestSessionJsonl, parses the usage blocks, and returns the
 * CacheTelemetry struct that the status command and the perf command
 * both depend on. This is the integration seam between the JSONL
 * walker and the cache parser; the unit tests in perf.test.ts cover
 * the parser in isolation.
 */

function makeJsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("readCacheTelemetry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-perf-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no .claude/projects exist", () => {
    expect(readCacheTelemetry(tmp)).toBeNull();
  });

  it("returns null when projects dir has no JSONLs", () => {
    mkdirSync(join(tmp, ".claude", "projects", "foo"), { recursive: true });
    expect(readCacheTelemetry(tmp)).toBeNull();
  });

  it("returns null when JSONL exists but yields no analyzable turns", () => {
    const dir = join(tmp, ".claude", "projects", "foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      makeJsonl([{ type: "user", message: { content: "hi" } }]),
    );
    expect(readCacheTelemetry(tmp)).toBeNull();
  });

  it("returns CacheTelemetry derived from the latest JSONL", () => {
    const dir = join(tmp, ".claude", "projects", "foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      makeJsonl([
        {
          type: "assistant",
          timestamp: "2026-04-26T08:00:00Z",
          message: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 9000,
              cache_creation_input_tokens: 1000,
              cache_creation: {
                ephemeral_1h_input_tokens: 900,
                ephemeral_5m_input_tokens: 100,
              },
            },
          },
        },
        {
          type: "assistant",
          timestamp: "2026-04-26T08:01:00Z",
          message: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 7000,
              cache_creation_input_tokens: 3000,
              cache_creation: {
                ephemeral_1h_input_tokens: 2700,
                ephemeral_5m_input_tokens: 300,
              },
            },
          },
        },
      ]),
    );
    const t = readCacheTelemetry(tmp);
    expect(t).not.toBeNull();
    expect(t!.turnsAnalyzed).toBe(2);
    expect(t!.hitRate).toBeCloseTo(16000 / 20000, 5);
    expect(t!.avgCreate).toBe(2000);
    expect(t!.ttl1hShare).toBeCloseTo(3600 / 4000, 5);
    expect(t!.firstTurnIso).toBe("2026-04-26T08:00:00Z");
    expect(t!.lastTurnIso).toBe("2026-04-26T08:01:00Z");
  });
});
