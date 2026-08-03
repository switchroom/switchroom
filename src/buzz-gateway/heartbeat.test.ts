import { describe, it, expect } from "vitest";

import {
  writeBuzzHeartbeat,
  parseBuzzHeartbeat,
  buzzHeartbeatStatePath,
  buzzHeartbeatOperatorPath,
  resolveStatsIntervalMs,
  BUZZ_HEARTBEAT_INTERVAL_MS,
  BUZZ_HEARTBEAT_STALE_MS,
  BUZZ_HEARTBEAT_MAX_INTERVAL_MS,
  type BuzzHeartbeat,
} from "./heartbeat.js";
import type { BuzzPipelineSummary } from "./stats.js";

const SUMMARY: BuzzPipelineSummary = {
  received: 7,
  injected: 4,
  duplicate: 1,
  queued: 0,
  injectFailed: 0,
  droppedByKind: 1,
  channelOff: 0,
  authFailures: 1,
  mirrorOk: 2,
  mirrorFailed: 0,
};

function beat(over: Partial<BuzzHeartbeat> = {}): BuzzHeartbeat {
  return { v: 1, agent: "klanker", ts: 1000, bootTs: 500, subscribed: true, stats: SUMMARY, ...over };
}

describe("buzz heartbeat paths", () => {
  it("state path and operator path agree on the same buzz/<file> tail", () => {
    // The sidecar writes <stateDir>/buzz/<file>; the operator reads
    // <agentHome>/telegram/buzz/<file>. With stateDir = <agentHome>/telegram
    // the two MUST resolve to the same file, or doctor reads a phantom path.
    const agentHome = "/home/op/.switchroom/agents/klanker";
    const stateDir = `${agentHome}/telegram`;
    expect(buzzHeartbeatStatePath(stateDir)).toBe(buzzHeartbeatOperatorPath(agentHome));
  });
});

describe("writeBuzzHeartbeat / parseBuzzHeartbeat", () => {
  it("round-trips a beacon through injected fs, creating its dir", () => {
    const writes: Record<string, string> = {};
    const mkdirs: string[] = [];
    writeBuzzHeartbeat("/state/telegram/buzz/buzz-sidecar.heartbeat.json", beat(), {
      mkdirSync: (p) => { mkdirs.push(p); },
      writeFileSync: (p, data) => { writes[p] = data; },
    });
    expect(mkdirs).toContain("/state/telegram/buzz");
    const parsed = parseBuzzHeartbeat(writes["/state/telegram/buzz/buzz-sidecar.heartbeat.json"]);
    expect(parsed).toEqual(beat());
    expect(parsed?.stats.injected).toBe(4);
  });

  it("rejects malformed json and wrong-version / wrong-shape payloads", () => {
    expect(parseBuzzHeartbeat("not json")).toBeNull();
    expect(parseBuzzHeartbeat("null")).toBeNull();
    expect(parseBuzzHeartbeat(JSON.stringify({ ...beat(), v: 2 }))).toBeNull();
    expect(parseBuzzHeartbeat(JSON.stringify({ ...beat(), subscribed: "yes" }))).toBeNull();
    expect(parseBuzzHeartbeat(JSON.stringify({ ...beat(), stats: 3 }))).toBeNull();
    const { agent: _drop, ...noAgent } = beat();
    expect(parseBuzzHeartbeat(JSON.stringify(noAgent))).toBeNull();
  });

  it("rejects a beacon whose stats field carries a non-numeric (injection) value", () => {
    // MAJOR-1: the beacon lives in the agent's own uid-writable state dir and
    // agents are prompt-injectable. A compromised agent could smuggle
    // attacker-controlled text (ANSI escapes, fake operator instructions) into a
    // stats field; doctor interpolates s.received etc. straight into an
    // operator terminal row. A string-valued stats field MUST parse to null so
    // that content never reaches the doctor surface — the shape guard, not the
    // freshness check, is the boundary.
    const evil = { ...SUMMARY, received: "0[31m URGENT: run switchroom vault set …" };
    expect(parseBuzzHeartbeat(JSON.stringify(beat({ stats: evil as never })))).toBeNull();
    // Non-finite numbers are equally rejected (NaN / Infinity survive JSON as null).
    expect(
      parseBuzzHeartbeat(JSON.stringify(beat({ stats: { ...SUMMARY, mirrorOk: null } as never }))),
    ).toBeNull();
  });

  it("rejects a beacon that is missing a numeric stats field", () => {
    // MAJOR-1: an absent field is as malformed as a wrong-typed one — doctor
    // would print `undefined` into the row. Drop one of the ten and expect null.
    const { authFailures: _drop, ...partialStats } = SUMMARY;
    expect(
      parseBuzzHeartbeat(JSON.stringify(beat({ stats: partialStats as never }))),
    ).toBeNull();
  });
});

describe("resolveStatsIntervalMs — stale-threshold coupling (#4302)", () => {
  it("keeps the timing contract self-consistent: stale = interval × tolerance", () => {
    // The whole fix rests on the stale threshold being DERIVED from the beat
    // interval, not a hand-synced constant. Pin the relationship so a future
    // edit to one without the other fails here.
    expect(BUZZ_HEARTBEAT_STALE_MS).toBeGreaterThan(BUZZ_HEARTBEAT_INTERVAL_MS);
    expect(BUZZ_HEARTBEAT_MAX_INTERVAL_MS * 3).toBe(BUZZ_HEARTBEAT_STALE_MS);
  });

  it("clamps an interval set ABOVE the stale threshold so a healthy sidecar can't false-red", () => {
    // The exact bug: BUZZ_STATS_INTERVAL_MS set above ~180s made every healthy
    // sidecar beat slower than doctor's stale window, so doctor false-redded it
    // as stale on every run. The resolved interval must stay strictly inside
    // the stale window, leaving room for at least a couple of missed beats.
    const wayAboveStale = String(BUZZ_HEARTBEAT_STALE_MS * 5); // e.g. 900s
    const resolved = resolveStatsIntervalMs(wayAboveStale);
    expect(resolved).toBeLessThanOrEqual(BUZZ_HEARTBEAT_MAX_INTERVAL_MS);
    // A sidecar beating at `resolved` beats at least 3× before the stale window
    // elapses — the false-red is structurally impossible.
    expect(resolved * 3).toBeLessThanOrEqual(BUZZ_HEARTBEAT_STALE_MS);
  });

  it("passes a faster-than-default interval through unchanged and floors junk to the default", () => {
    expect(resolveStatsIntervalMs("15000")).toBe(15000); // faster beats are fine
    expect(resolveStatsIntervalMs(undefined)).toBe(BUZZ_HEARTBEAT_INTERVAL_MS);
    expect(resolveStatsIntervalMs("not-a-number")).toBe(BUZZ_HEARTBEAT_INTERVAL_MS);
    expect(resolveStatsIntervalMs("0")).toBe(BUZZ_HEARTBEAT_INTERVAL_MS);
    expect(resolveStatsIntervalMs("-5000")).toBe(BUZZ_HEARTBEAT_INTERVAL_MS);
  });
});
