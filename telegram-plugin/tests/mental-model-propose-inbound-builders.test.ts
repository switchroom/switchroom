import { describe, it, expect } from "vitest";
import {
  buildMentalModelProposeAppliedInbound,
  buildMentalModelProposeDeniedInbound,
  buildMentalModelProposeFailedInbound,
} from "../gateway/mental-model-propose-inbound-builders.js";

/**
 * The synthetic-inbound shapes are load-bearing: the bridge keys on
 * `meta.source` to render `<channel source="...">` and resume the agent's turn.
 * A drifted source string or dropped meta field silently breaks the wake-up.
 */

const ctx = {
  agent: "coach",
  name: "training-plan-state",
  chat_id: "555",
  threadId: 99,
};

describe("mental-model proposal synthetic inbounds", () => {
  it("applied inbound carries source + forensic meta and threads the topic", () => {
    const m = buildMentalModelProposeAppliedInbound({
      ctx,
      stageId: "st1",
      operatorId: "op-7",
      nowMs: 1234,
    });
    expect(m.type).toBe("inbound");
    expect(m.chatId).toBe("555");
    expect(m.threadId).toBe(99);
    expect(m.meta.source).toBe("mental_model_proposal_applied");
    expect(m.meta.agent).toBe("coach");
    expect(m.meta.name).toBe("training-plan-state");
    expect(m.meta.stage_id).toBe("st1");
    expect(m.meta.operator_id).toBe("op-7");
    expect(m.meta.message_thread_id).toBe("99");
    expect(m.text).toContain("approved");
    expect(m.text).toContain("training-plan-state");
  });

  it("denied inbound tells the agent NOTHING was written", () => {
    const m = buildMentalModelProposeDeniedInbound({
      ctx: { agent: "coach", name: "plan", chat_id: "1" },
      stageId: "st2",
      operatorId: "op-1",
      nowMs: 5,
    });
    expect(m.meta.source).toBe("mental_model_proposal_denied");
    expect(m.threadId).toBeUndefined();
    expect(m.meta.message_thread_id).toBeUndefined();
    expect(m.text).toContain("denied");
    expect(m.text.toUpperCase()).toContain("NOTHING");
  });

  it("failed inbound is honest that the model did NOT land", () => {
    const m = buildMentalModelProposeFailedInbound({
      ctx: { agent: "coach", name: "plan", chat_id: "1" },
      stageId: "st3",
      operatorId: "op-1",
      reason: "hostd down",
      nowMs: 5,
    });
    expect(m.meta.source).toBe("mental_model_proposal_failed");
    expect(m.text).toContain("hostd down");
    expect(m.text).toContain("NOT");
  });
});
