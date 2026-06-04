import { describe, it, expect } from "vitest";
import { autoClassifyMidTurnInbound, type AutoClassifyInput } from "../gateway/auto-classify-mid-turn.js";

function base(over: Partial<AutoClassifyInput> = {}): AutoClassifyInput {
  return {
    isSteerPrefix: false,
    isQueuePrefix: false,
    priorTurnInFlight: true,
    isDm: false,
    incomingThreadId: 3,
    activeTurnThreadId: 3,
    msSinceLastAgentOutput: 2000,
    dmSteerWindowMs: 0, // DM auto-steer off by default
    topicSteerWindowMs: 8000,
    ...over,
  };
}

describe("autoClassifyMidTurnInbound", () => {
  it("explicit /steer prefix always wins", () => {
    const r = autoClassifyMidTurnInbound(base({ isSteerPrefix: true, incomingThreadId: 9, activeTurnThreadId: 3 }));
    expect(r.decision).toBe("steer");
    expect(r.reason).toBe("steer_prefix");
  });

  it("explicit /queue prefix always wins", () => {
    expect(autoClassifyMidTurnInbound(base({ isQueuePrefix: true })).decision).toBe("queue");
  });

  it("no turn in flight → queue (fresh turn, not our decision)", () => {
    const r = autoClassifyMidTurnInbound(base({ priorTurnInFlight: false }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("not_mid_turn");
  });

  // ── Supergroup: topic is the strong signal ──
  it("supergroup, DIFFERENT topic than the active turn → queue (cross_topic), regardless of recency", () => {
    const r = autoClassifyMidTurnInbound(base({ incomingThreadId: 5, activeTurnThreadId: 3, msSinceLastAgentOutput: 100 }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("cross_topic");
    expect(r.sameTopic).toBe(false);
  });

  it("supergroup, SAME topic + recent → steer", () => {
    const r = autoClassifyMidTurnInbound(base({ msSinceLastAgentOutput: 3000, topicSteerWindowMs: 8000 }));
    expect(r.decision).toBe("steer");
    expect(r.reason).toBe("same_topic_recent");
    expect(r.sameTopic).toBe(true);
  });

  it("supergroup, SAME topic but STALE (older than window) → queue", () => {
    const r = autoClassifyMidTurnInbound(base({ msSinceLastAgentOutput: 20000, topicSteerWindowMs: 8000 }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("same_topic_stale");
  });

  it("supergroup, no recency recorded (null) → queue (not treated as recent)", () => {
    const r = autoClassifyMidTurnInbound(base({ msSinceLastAgentOutput: null }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("same_topic_stale");
  });

  it("topicSteerWindowMs=0 (auto-steer off) → queue, still reports sameTopic", () => {
    const r = autoClassifyMidTurnInbound(base({ topicSteerWindowMs: 0, incomingThreadId: 3, activeTurnThreadId: 3 }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("topic_disabled");
    expect(r.sameTopic).toBe(true);
  });

  it("canonical thread compare: null/undefined/0 collapse to the same no-thread bucket", () => {
    expect(autoClassifyMidTurnInbound(base({ incomingThreadId: 0, activeTurnThreadId: null })).sameTopic).toBe(true);
    expect(autoClassifyMidTurnInbound(base({ incomingThreadId: undefined, activeTurnThreadId: 0 })).sameTopic).toBe(true);
    expect(autoClassifyMidTurnInbound(base({ incomingThreadId: 1, activeTurnThreadId: 0 })).sameTopic).toBe(false);
  });

  // ── DM: timing-only, off by default ──
  it("DM with dmSteerWindowMs=0 (default) → queue even if recent (DM auto-steer off)", () => {
    const r = autoClassifyMidTurnInbound(base({ isDm: true, incomingThreadId: null, activeTurnThreadId: null, msSinceLastAgentOutput: 500, dmSteerWindowMs: 0 }));
    expect(r.decision).toBe("queue");
    expect(r.reason).toBe("dm_disabled");
  });

  it("DM with dmSteerWindowMs>0 + recent → steer; stale → queue", () => {
    expect(autoClassifyMidTurnInbound(base({ isDm: true, incomingThreadId: null, activeTurnThreadId: null, msSinceLastAgentOutput: 5000, dmSteerWindowMs: 10000 })).decision).toBe("steer");
    expect(autoClassifyMidTurnInbound(base({ isDm: true, incomingThreadId: null, activeTurnThreadId: null, msSinceLastAgentOutput: 15000, dmSteerWindowMs: 10000 })).decision).toBe("queue");
  });
});
