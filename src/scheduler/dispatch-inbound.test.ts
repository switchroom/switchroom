/**
 * Unit tests for `dispatchAsInbound` — the Phase 1 cron-fire synthesis
 * primitive. Pure function: builds an `InboundMessage` from a
 * `SchedulerEntry` and hands it to a dispatcher. Phase 1 ships only
 * this primitive; nothing calls it yet.
 *
 * The wire-shape source of truth is `validateGatewayMessage` in
 * `telegram-plugin/bridge/ipc-client.ts` — the same validator the
 * bridge uses to accept gateway→client messages on the live socket.
 * Importing it here means the test fails the moment the bridge stops
 * accepting our shape, not weeks later when an agent silently drops
 * cron fires in production.
 *
 * (The handoff brief pointed at `validateClientMessage` in
 * `gateway/ipc-server.ts:104-167`; that's the *client→gateway*
 * validator, which doesn't recognise `type: "inbound"`. The
 * gateway→client direction has its own validator and that's the one
 * the bridge actually applies — so we exercise it here instead.)
 */

import { describe, it, expect } from "vitest";
import { validateGatewayMessage } from "../../telegram-plugin/bridge/ipc-client.js";
import {
  dispatchAsInbound,
  type InboundDispatcher,
  type InboundMessageWire,
  type SchedulerEntry,
} from "./dispatch.js";

const sampleEntry: SchedulerEntry = {
  agent: "klanker",
  scheduleIndex: 2,
  cron: "0 8 * * 1-5",
  prompt: "Morning briefing — calendar, blockers, top priorities",
  promptKey: "abcdef012345",
};

function captureDispatcher(
  responses: { delivered: boolean } = { delivered: true },
): InboundDispatcher & {
  calls: Array<{ agentName: string; msg: InboundMessageWire }>;
} {
  const calls: Array<{ agentName: string; msg: InboundMessageWire }> = [];
  return {
    calls,
    sendToAgent(agentName, msg) {
      calls.push({ agentName, msg });
      return responses.delivered;
    },
  };
}

describe("dispatchAsInbound", () => {
  it("synthesises an InboundMessage tagged with meta.source='cron'", () => {
    const dispatcher = captureDispatcher();
    const result = dispatchAsInbound(
      sampleEntry,
      { chatId: "-1001234567890", now: () => 1_700_000_000_000 },
      dispatcher,
    );

    expect(result.delivered).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
    const { agentName, msg } = dispatcher.calls[0]!;
    expect(agentName).toBe("klanker");
    expect(msg.type).toBe("inbound");
    expect(msg.chatId).toBe("-1001234567890");
    expect(msg.text).toBe(sampleEntry.prompt);
    expect(msg.user).toBe("cron");
    expect(msg.userId).toBe(0);
    expect(msg.ts).toBe(1_700_000_000_000);
    expect(msg.messageId).toBe(1_700_000_000_000);
    expect(msg.meta.source).toBe("cron");
    expect(msg.meta.schedule_index).toBe("2");
    expect(msg.meta.prompt_key).toBe("abcdef012345");
  });

  it("forwards the synthesised message verbatim in the result", () => {
    const dispatcher = captureDispatcher();
    const result = dispatchAsInbound(
      sampleEntry,
      { chatId: "c", now: () => 42 },
      dispatcher,
    );
    expect(result.message).toEqual(dispatcher.calls[0]!.msg);
  });

  it("propagates threadId when given, omits the field when absent", () => {
    const withThread = captureDispatcher();
    dispatchAsInbound(
      sampleEntry,
      { chatId: "c", threadId: 7, now: () => 1 },
      withThread,
    );
    expect(withThread.calls[0]!.msg.threadId).toBe(7);

    const withoutThread = captureDispatcher();
    dispatchAsInbound(sampleEntry, { chatId: "c", now: () => 1 }, withoutThread);
    expect("threadId" in withoutThread.calls[0]!.msg).toBe(false);
  });

  it("returns delivered=false when no agent client is registered", () => {
    const dispatcher = captureDispatcher({ delivered: false });
    const result = dispatchAsInbound(
      sampleEntry,
      { chatId: "c", now: () => 1 },
      dispatcher,
    );
    expect(result.delivered).toBe(false);
    // The dispatcher is still called — Phase 2 in-agent cron will
    // decide separately whether an undelivered fire goes to a queue
    // or dead-letters into scheduler.jsonl.
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("defaults `ts` and `messageId` to Date.now() when no clock is injected", () => {
    const dispatcher = captureDispatcher();
    const before = Date.now();
    dispatchAsInbound(sampleEntry, { chatId: "c" }, dispatcher);
    const after = Date.now();
    const ts = dispatcher.calls[0]!.msg.ts;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(dispatcher.calls[0]!.msg.messageId).toBe(ts);
  });

  it("survives a JSON wire round-trip with meta intact", () => {
    const dispatcher = captureDispatcher();
    dispatchAsInbound(
      sampleEntry,
      { chatId: "-100", threadId: 12, now: () => 1_700_000_000_000 },
      dispatcher,
    );
    const original = dispatcher.calls[0]!.msg;
    const wire = JSON.stringify(original) + "\n";
    const parsed = JSON.parse(wire.trim()) as InboundMessageWire;
    expect(parsed).toEqual(original);
    expect(parsed.meta.source).toBe("cron");
    expect(parsed.meta.schedule_index).toBe("2");
    expect(parsed.meta.prompt_key).toBe("abcdef012345");
  });

  it("validates against the bridge's validateGatewayMessage", () => {
    const dispatcher = captureDispatcher();
    dispatchAsInbound(
      sampleEntry,
      { chatId: "-100", now: () => 1_700_000_000_000 },
      dispatcher,
    );
    const wire = JSON.parse(JSON.stringify(dispatcher.calls[0]!.msg));
    expect(validateGatewayMessage(wire)).toBe(true);
  });

  // #2793 part B — a boot-replay stamps meta.replay_fire_ms so the gateway
  // routes it through the durable inbound spool (accept vs consume ledgered
  // separately) and spoolId derives a stable dedup key from the replayed
  // fire. A live tick leaves it unset and keeps the fire-and-forget path.
  it("emits meta.replay_fire_ms when replayFireMs is set (boot-replay)", () => {
    const dispatcher = captureDispatcher();
    const result = dispatchAsInbound(
      sampleEntry,
      { chatId: "-100", now: () => 1_700_000_000_000, replayFireMs: 1_699_999_980_000 },
      dispatcher,
    );
    expect(result.message.meta.replay_fire_ms).toBe("1699999980000");
    // still a valid wire message (meta is Record<string,string>).
    const wire = JSON.parse(JSON.stringify(dispatcher.calls[0]!.msg));
    expect(validateGatewayMessage(wire)).toBe(true);
  });

  it("omits replay_fire_ms for a live tick (byte-identical to today)", () => {
    const dispatcher = captureDispatcher();
    const result = dispatchAsInbound(
      sampleEntry,
      { chatId: "-100", now: () => 1_700_000_000_000 },
      dispatcher,
    );
    expect(result.message.meta.replay_fire_ms).toBeUndefined();
  });
});
