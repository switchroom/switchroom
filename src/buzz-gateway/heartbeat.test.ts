import { describe, it, expect } from "vitest";

import {
  writeBuzzHeartbeat,
  parseBuzzHeartbeat,
  buzzHeartbeatStatePath,
  buzzHeartbeatOperatorPath,
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
