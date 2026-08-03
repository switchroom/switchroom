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
});
