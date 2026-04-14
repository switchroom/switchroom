import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectInFlight,
  waitUntilIdle,
  decideRestart,
} from "../src/agents/in-flight.js";

function writeTaskFile(
  agentDir: string,
  sessionId: string,
  name: string,
  mtimeMs: number,
): void {
  const dir = join(agentDir, ".claude", "tasks", sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "{}");
  const ts = mtimeMs / 1000;
  utimesSync(file, ts, ts);
}

function writeJsonl(
  agentDir: string,
  relPath: string,
  mtimeMs: number,
): void {
  const full = join(agentDir, ".claude", "projects", relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "{}\n");
  const ts = mtimeMs / 1000;
  utimesSync(full, ts, ts);
}

describe("detectInFlight", () => {
  let agentDir: string;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "switchroom-inflight-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("reports idle when no .claude dir exists at all", () => {
    const r = detectInFlight({ agentDir, now: () => NOW });
    expect(r.busy).toBe(false);
    expect(r.activeSessions).toBe(0);
    expect(r.activeSubagents).toBe(0);
  });

  it("reports idle when task files are stale", () => {
    writeTaskFile(agentDir, "sessA", "1.json", NOW - 60_000);
    writeTaskFile(agentDir, "sessA", "2.json", NOW - 120_000);
    const r = detectInFlight({
      agentDir,
      now: () => NOW,
      recencyMs: 30_000,
    });
    expect(r.busy).toBe(false);
    // Even though not busy, lastActivityMs is surfaced.
    expect(r.lastActivityMs).toBe(NOW - 60_000);
  });

  it("reports busy when a task file was recently modified", () => {
    writeTaskFile(agentDir, "abc12345", "5.json", NOW - 2_000);
    const r = detectInFlight({
      agentDir,
      now: () => NOW,
      recencyMs: 30_000,
    });
    expect(r.busy).toBe(true);
    expect(r.activeSessions).toBe(1);
    expect(r.details.some((d) => d.includes("abc12345"))).toBe(true);
  });

  it("counts distinct active sessions", () => {
    writeTaskFile(agentDir, "sess1", "1.json", NOW - 1_000);
    writeTaskFile(agentDir, "sess2", "1.json", NOW - 1_000);
    writeTaskFile(agentDir, "sess3", "1.json", NOW - 999_999);
    const r = detectInFlight({
      agentDir,
      now: () => NOW,
      recencyMs: 30_000,
    });
    expect(r.activeSessions).toBe(2);
  });

  it("detects running sub-agent transcripts", () => {
    writeJsonl(
      agentDir,
      "slug/sess/subagents/agent-abc.jsonl",
      NOW - 5_000,
    );
    const r = detectInFlight({
      agentDir,
      now: () => NOW,
      recencyMs: 30_000,
    });
    expect(r.busy).toBe(true);
    expect(r.activeSubagents).toBe(1);
    expect(r.details.some((d) => d.includes("sub-agent"))).toBe(true);
  });

  it("detects a main transcript being appended to", () => {
    writeJsonl(agentDir, "slug/sess-main.jsonl", NOW - 5_000);
    const r = detectInFlight({
      agentDir,
      now: () => NOW,
      recencyMs: 30_000,
    });
    expect(r.busy).toBe(true);
    // Main transcript activity shouldn't be counted as a sub-agent.
    expect(r.activeSubagents).toBe(0);
    expect(r.details.some((d) => d.includes("main transcript"))).toBe(true);
  });
});

describe("waitUntilIdle", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "switchroom-wait-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns immediately when already idle", async () => {
    const sleeps: number[] = [];
    const r = await waitUntilIdle({
      agentDir,
      timeoutMs: 10_000,
      pollMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.busy).toBe(false);
    expect(sleeps.length).toBe(0);
  });

  it("polls until activity ages out, then returns idle", async () => {
    const start = 1_700_000_000_000;
    // A stale-ish file — on the first poll it will be "recent", then
    // we advance the clock past the recency window.
    writeTaskFile(agentDir, "s1", "1.json", start - 5_000);

    let t = start;
    const sleeps: number[] = [];

    const r = await waitUntilIdle({
      agentDir,
      timeoutMs: 60_000,
      pollMs: 1_000,
      recencyMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        // Advance virtual clock so the file ages out past recencyMs.
        t += 20_000;
      },
    });
    expect(r.busy).toBe(false);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("stops polling when timeout is reached and reports still busy", async () => {
    const start = 1_700_000_000_000;
    writeTaskFile(agentDir, "s1", "1.json", start - 1_000);

    let t = start;
    let polls = 0;

    const r = await waitUntilIdle({
      agentDir,
      timeoutMs: 5_000,
      pollMs: 1_000,
      recencyMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        polls += 1;
        t += ms;
      },
    });
    expect(r.busy).toBe(true);
    // Polls should be bounded by timeoutMs/pollMs.
    expect(polls).toBeLessThanOrEqual(6);
  });
});

describe("decideRestart", () => {
  const idle = {
    busy: false,
    activeSessions: 0,
    activeSubagents: 0,
    lastActivityMs: 0,
    details: [],
  };
  const busy = {
    busy: true,
    activeSessions: 1,
    activeSubagents: 0,
    lastActivityMs: Date.now(),
    details: ["session abc task 1.json"],
  };

  it("proceeds when no in-flight work is detected", () => {
    expect(decideRestart({ force: false, wait: false, activity: idle }))
      .toEqual({ kind: "proceed" });
  });

  it("proceeds when --force is set even if busy", () => {
    expect(decideRestart({ force: true, wait: false, activity: busy }))
      .toEqual({ kind: "proceed" });
  });

  it("returns wait when busy and --wait is set", () => {
    expect(decideRestart({ force: false, wait: true, activity: busy }))
      .toEqual({ kind: "wait" });
  });

  it("returns prompt when busy and no flags", () => {
    expect(decideRestart({ force: false, wait: false, activity: busy }))
      .toEqual({ kind: "prompt" });
  });
});
