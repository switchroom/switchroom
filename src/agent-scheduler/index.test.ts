/**
 * Unit tests for the in-agent scheduler sibling. Drives the cron-fire
 * path with fakes for cron + dispatcher + audit sink, asserting:
 *   - the dispatcher receives a correctly-shaped InboundMessageWire
 *   - audit rows mirror the host scheduler's DispatchResult shape
 *     (Phase 3 audit-parity check depends on this)
 *   - delivered=false maps to exit_code=-1, dispatcher errors are
 *     caught and audited (the cron loop must never crash on a fire)
 *   - resolveChannelTarget reads the config cascade correctly
 */

import { describe, it, expect } from "vitest";
import { InMemoryAuditSink } from "../scheduler/audit.js";
import type {
  InboundDispatcher,
  InboundMessageWire,
  SchedulerEntry,
} from "../scheduler/dispatch.js";
import {
  registerAgentSchedule,
  resolveChannelTarget,
  resolveEntryThreadId,
  type CronLib,
} from "./index.js";

function fakeCron(): CronLib & { fire: (idx: number) => Promise<void>; tasks: Array<() => void | Promise<void>>; stops: number } {
  const handlers: Array<() => void | Promise<void>> = [];
  let stops = 0;
  return {
    schedule(_expr, h) {
      handlers.push(h);
      return { stop: () => { stops += 1; } };
    },
    async fire(idx) {
      const h = handlers[idx];
      if (!h) throw new Error(`no handler at idx=${idx}`);
      await h();
    },
    get tasks() { return handlers; },
    get stops() { return stops; },
  };
}

function captureDispatcher(opts: { delivered?: boolean; throwOnce?: Error } = {}): InboundDispatcher & {
  calls: Array<{ agent: string; msg: InboundMessageWire }>;
} {
  let firstCall = true;
  const calls: Array<{ agent: string; msg: InboundMessageWire }> = [];
  return {
    calls,
    sendToAgent(agent, msg) {
      if (firstCall && opts.throwOnce) {
        firstCall = false;
        throw opts.throwOnce;
      }
      firstCall = false;
      calls.push({ agent, msg });
      return opts.delivered ?? true;
    },
  };
}

const sampleEntries: SchedulerEntry[] = [
  {
    agent: "klanker",
    scheduleIndex: 0,
    cron: "0 8 * * 1-5",
    prompt: "Morning briefing",
    promptKey: "abc123",
  },
  {
    agent: "klanker",
    scheduleIndex: 1,
    cron: "0 20 * * 0",
    prompt: "Weekly review",
    promptKey: "def456",
  },
];

describe("registerAgentSchedule", () => {
  it("registers one cron task per entry and returns stop handles", () => {
    const cron = fakeCron();
    const sink = new InMemoryAuditSink();
    const dispatcher = captureDispatcher();
    const tasks = registerAgentSchedule({
      entries: sampleEntries,
      channel: { chatId: "-100", threadId: 7 },
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 1_700_000_000_000,
    });
    expect(tasks).toHaveLength(2);
    expect(cron.tasks).toHaveLength(2);
    tasks[0]!.task.stop();
    tasks[1]!.task.stop();
    expect(cron.stops).toBe(2);
  });

  it("on fire, sends inject_inbound carrying meta.source='cron' and audits exit_code=0", async () => {
    const cron = fakeCron();
    const sink = new InMemoryAuditSink();
    const dispatcher = captureDispatcher({ delivered: true });
    registerAgentSchedule({
      entries: sampleEntries,
      channel: { chatId: "-100", threadId: 7 },
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 1_700_000_000_000,
    });

    await cron.fire(0);

    expect(dispatcher.calls).toHaveLength(1);
    const sent = dispatcher.calls[0]!;
    expect(sent.agent).toBe("klanker");
    expect(sent.msg.type).toBe("inbound");
    expect(sent.msg.chatId).toBe("-100");
    expect(sent.msg.threadId).toBe(7);
    expect(sent.msg.text).toBe("Morning briefing");
    expect(sent.msg.meta.source).toBe("cron");
    expect(sent.msg.meta.schedule_index).toBe("0");
    expect(sent.msg.meta.prompt_key).toBe("abc123");

    expect(sink.fires).toHaveLength(1);
    const audit = sink.fires[0]!;
    expect(audit.agent).toBe("klanker");
    expect(audit.scheduleIndex).toBe(0);
    expect(audit.promptKey).toBe("abc123");
    expect(audit.exitCode).toBe(0);
    expect(audit.outputSummary).toContain("delivered");
    expect(audit.startedAt).toBe(1_700_000_000_000);
    expect(audit.finishedAt).toBe(1_700_000_000_000);
  });

  it("when the dispatcher reports undelivered, audits exit_code=-1 with a 'no agent client' summary", async () => {
    const cron = fakeCron();
    const sink = new InMemoryAuditSink();
    const dispatcher = captureDispatcher({ delivered: false });
    registerAgentSchedule({
      entries: sampleEntries,
      channel: { chatId: "-100" },
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 1,
    });

    await cron.fire(1);

    expect(sink.fires).toHaveLength(1);
    expect(sink.fires[0]!.exitCode).toBe(-1);
    expect(sink.fires[0]!.outputSummary).toContain("no agent client");
    expect(sink.fires[0]!.scheduleIndex).toBe(1);
    expect(sink.fires[0]!.promptKey).toBe("def456");
  });

  it("when the dispatcher throws, the audit row carries the error and the cron loop survives", async () => {
    const cron = fakeCron();
    const sink = new InMemoryAuditSink();
    const dispatcher = captureDispatcher({ throwOnce: new Error("EPIPE") });
    registerAgentSchedule({
      entries: sampleEntries,
      channel: { chatId: "-100" },
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 7,
    });

    // First fire throws; second should still succeed.
    await cron.fire(0);
    await cron.fire(0);

    expect(sink.fires).toHaveLength(2);
    expect(sink.fires[0]!.exitCode).toBe(-1);
    expect(sink.fires[0]!.outputSummary).toContain("EPIPE");
    expect(sink.fires[1]!.exitCode).toBe(0);
  });

  it("omits threadId when the channel target has no topic (e.g. DM-style chat)", async () => {
    const cron = fakeCron();
    const sink = new InMemoryAuditSink();
    const dispatcher = captureDispatcher();
    registerAgentSchedule({
      entries: [sampleEntries[0]!],
      channel: { chatId: "-100" },
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 1,
    });
    await cron.fire(0);
    const sent = dispatcher.calls[0]!;
    expect("threadId" in sent.msg).toBe(false);
  });
});

describe("resolveChannelTarget", () => {
  it("reads forum_chat_id from telegram + topic_id from the agent block", () => {
    const config = {
      telegram: { forum_chat_id: "-1001234567890" },
      agents: { klanker: { topic_id: 42 } },
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    expect(resolveChannelTarget(config, "klanker")).toEqual({
      chatId: "-1001234567890",
      threadId: 42,
    });
  });

  it("returns null when forum_chat_id is missing", () => {
    const config = {
      telegram: undefined,
      agents: { klanker: { topic_id: 42 } },
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    expect(resolveChannelTarget(config, "klanker")).toBeNull();
  });

  it("returns chatId without threadId when the agent has no topic_id", () => {
    const config = {
      telegram: { forum_chat_id: "-100" },
      agents: { klanker: {} },
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    const result = resolveChannelTarget(config, "klanker");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("-100");
    expect("threadId" in result!).toBe(false);
  });

  it("returns chatId without threadId when the agent is missing entirely", () => {
    const config = {
      telegram: { forum_chat_id: "-100" },
      agents: {},
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    expect(resolveChannelTarget(config, "ghost")).toEqual({ chatId: "-100" });
  });

  // ─── PR4b-cron: supergroup-mode override paths ──────────────────────────
  it("uses the per-agent supergroup chat_id when set (overrides fleet forum_chat_id)", () => {
    const config = {
      telegram: { forum_chat_id: "-1001111111111" },  // fleet, ignored
      agents: {
        klanker: {
          channels: {
            telegram: {
              chat_id: "-1002222222222",
              default_topic_id: 1,
              topic_aliases: { planning: 17, admin: 31 },
            },
          },
        },
      },
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    const target = resolveChannelTarget(config, "klanker");
    expect(target).not.toBeNull();
    expect(target!.chatId).toBe("-1002222222222");
    expect(target!.threadId).toBe(1);
    expect(target!.routerConfig).toEqual({
      default_topic_id: 1,
      topic_aliases: { planning: 17, admin: 31 },
    });
  });

  it("falls back to fleet forum_chat_id when channels.telegram.chat_id is absent", () => {
    const config = {
      telegram: { forum_chat_id: "-1001111111111" },
      agents: {
        klanker: {
          topic_id: 42,
          channels: { telegram: { /* no chat_id */ } },
        },
      },
    } as unknown as Parameters<typeof resolveChannelTarget>[0];
    const target = resolveChannelTarget(config, "klanker");
    expect(target).toEqual({
      chatId: "-1001111111111",
      threadId: 42,
    });
    expect("routerConfig" in target!).toBe(false);
  });
});

describe("resolveEntryThreadId", () => {
  function makeEntry(topic?: string | number) {
    return {
      agent: "klanker",
      scheduleIndex: 0,
      cron: "0 8 * * *",
      prompt: "test",
      promptKey: "abc",
      ...(topic !== undefined ? { topic } : {}),
    };
  }
  const SG_CHANNEL = {
    chatId: "-1002222222222",
    threadId: 1,
    routerConfig: {
      default_topic_id: 1,
      topic_aliases: { planning: 17, admin: 31 },
    },
  };
  const FLEET_CHANNEL = {
    chatId: "-1001111111111",
    threadId: 42,
  };

  it("resolves a string alias against routerConfig.topic_aliases", () => {
    expect(resolveEntryThreadId(makeEntry("planning"), SG_CHANNEL)).toBe(17);
    expect(resolveEntryThreadId(makeEntry("admin"), SG_CHANNEL)).toBe(31);
  });

  it("passes through a numeric topic ID unchanged", () => {
    expect(resolveEntryThreadId(makeEntry(99), SG_CHANNEL)).toBe(99);
  });

  it("falls back to default_topic_id when entry has no topic (supergroup mode)", () => {
    expect(resolveEntryThreadId(makeEntry(), SG_CHANNEL)).toBe(1);
  });

  it("falls back to default_topic_id when alias is unknown (supergroup mode)", () => {
    // Defensive fallback — loader-time validation should reject
    // unknown aliases, but the helper handles config drift.
    expect(resolveEntryThreadId(makeEntry("nonexistent"), SG_CHANNEL)).toBe(1);
  });

  it("returns fleet channel.threadId when no routerConfig (fleet mode)", () => {
    expect(resolveEntryThreadId(makeEntry(), FLEET_CHANNEL)).toBe(42);
    // Even with a per-entry topic set, fleet agents have no aliases
    // to resolve against — return the fleet threadId unchanged.
    expect(resolveEntryThreadId(makeEntry("planning"), FLEET_CHANNEL)).toBe(42);
  });

  it("returns undefined when no routerConfig AND no channel threadId (DM agent)", () => {
    const dmChannel = { chatId: "12345" };
    expect(resolveEntryThreadId(makeEntry(), dmChannel)).toBeUndefined();
  });
});
