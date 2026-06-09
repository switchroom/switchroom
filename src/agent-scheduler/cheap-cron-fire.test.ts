/**
 * Tier-0 / cheap-cron wiring in attemptFire — proves: a no-op poll fires
 * NO model (no dispatch, HEARTBEAT_OK), a hit escalates with the templated
 * diff + the routed session, and the flag-off path is byte-for-byte today.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditSink } from "../scheduler/audit.js";
import type { InboundDispatcher, InboundMessageWire, SchedulerEntry } from "../scheduler/dispatch.js";
import { createMemoryPollStateStore } from "../scheduler/poll-state.js";
import type { PollOutcome } from "../scheduler/poll-engine.js";
import type { PollSpec } from "../config/schema.js";
import { registerAgentSchedule, type CheapCronHooks, type CronLib } from "./index.js";

function fakeCron(): CronLib & { fire: (i: number) => Promise<void> } {
  const handlers: Array<() => void | Promise<void>> = [];
  return {
    schedule: (_e, h) => (handlers.push(h), { stop: () => {} }),
    fire: async (i) => { await handlers[i]!(); },
  };
}
function capture(): InboundDispatcher & { calls: Array<{ agent: string; msg: InboundMessageWire }> } {
  const calls: Array<{ agent: string; msg: InboundMessageWire }> = [];
  return { calls, sendToAgent: (agent, msg) => (calls.push({ agent, msg }), true) };
}

const POLL: PollSpec = {
  type: "http-diff",
  url: "https://api.brevo.com/v3/x",
  method: "GET",
  secrets: [],
  diff_jsonpath: "$.contacts[*].id",
  state_key: "cursor",
};
const pollEntry: SchedulerEntry = {
  agent: "marko",
  scheduleIndex: 0,
  cron: "*/15 * * * *",
  prompt: "New lead(s): {{diff}}. Email per the SOP.",
  promptKey: "p1",
  kind: "poll",
  poll: POLL,
};

function harness(outcome: PollOutcome, opts: { enabled?: boolean; seed?: Record<string, { value: string }> } = {}) {
  const cron = fakeCron();
  const dispatcher = capture();
  const sink = new InMemoryAuditSink();
  const pollState = createMemoryPollStateStore(opts.seed ?? {});
  const cheapCron: CheapCronHooks = {
    enabled: opts.enabled ?? true,
    pollState,
    runPoll: async () => outcome,
  };
  registerAgentSchedule({
    entries: [pollEntry],
    channel: { chatId: "123", threadId: undefined } as never,
    sink,
    cronLib: cron,
    dispatcher,
    now: () => 1000,
    cheapCron,
  });
  return { cron, dispatcher, sink, pollState };
}

describe("Tier-0 poll wiring", () => {
  it("no-op poll → NO dispatch, HEARTBEAT_OK audit (tier=poll, exit 0)", async () => {
    const h = harness({ hit: false, baseline: false, cursor: "5" }, { seed: { cursor: { value: "5" } } });
    await h.cron.fire(0);
    expect(h.dispatcher.calls).toHaveLength(0); // ← the savings: zero model fires
    expect(h.sink.fires[0]).toMatchObject({ exitCode: 0, tier: "poll" });
    expect(h.sink.fires[0]!.outputSummary).toMatch(/HEARTBEAT_OK/);
  });

  it("first run → baseline recorded, NO dispatch, no escalate", async () => {
    const h = harness({ hit: false, baseline: true, cursor: "9" });
    await h.cron.fire(0);
    expect(h.dispatcher.calls).toHaveLength(0);
    expect(h.pollState.get("cursor")?.value).toBe("9");
    expect(h.sink.fires[0]).toMatchObject({ tier: "poll", exitCode: 0 });
  });

  it("hit → write-ahead cursor + escalate with templated diff", async () => {
    const h = harness({ hit: true, baseline: false, cursor: "12", diff: "cursor 12 > 5 (2 item(s))" }, { seed: { cursor: { value: "5" } } });
    await h.cron.fire(0);
    expect(h.pollState.get("cursor")?.value).toBe("12"); // write-ahead advanced
    expect(h.pollState.get("cursor")?.pendingEscalation).toBeUndefined(); // cleared on deliver
    expect(h.dispatcher.calls).toHaveLength(1);
    expect(h.dispatcher.calls[0]!.msg.text).toBe("New lead(s): cursor 12 > 5 (2 item(s)). Email per the SOP.");
    // marko's escalation has no model/context → Tier 2 main session (no meta.session)
    expect(h.dispatcher.calls[0]!.msg.meta.session).toBeUndefined();
  });

  it("poll error → exit -3, NO escalation", async () => {
    const h = harness({ hit: false, baseline: false, error: "http 503" }, { seed: { cursor: { value: "5" } } });
    await h.cron.fire(0);
    expect(h.dispatcher.calls).toHaveLength(0);
    expect(h.sink.fires[0]).toMatchObject({ exitCode: -3, tier: "poll" });
  });

  it("flag OFF → poll ignored, fires as an ordinary main turn (back-compat)", async () => {
    const h = harness({ hit: false, baseline: false, cursor: "5" }, { enabled: false });
    await h.cron.fire(0);
    expect(h.dispatcher.calls).toHaveLength(1); // disabling never drops a cron
    expect(h.dispatcher.calls[0]!.msg.meta.session).toBeUndefined();
    expect(h.sink.fires[0]).toMatchObject({ tier: "main" });
  });
});

describe("Tier-1 cheap-session routing", () => {
  it("context:fresh prompt → dispatch carries meta.session=cron + meta.model", async () => {
    const cron = fakeCron();
    const dispatcher = capture();
    const sink = new InMemoryAuditSink();
    registerAgentSchedule({
      entries: [{ agent: "marko", scheduleIndex: 1, cron: "0 9 * * *", prompt: "summary", promptKey: "p2", context: "fresh" }],
      channel: { chatId: "123" } as never,
      sink,
      cronLib: cron,
      dispatcher,
      now: () => 1000,
      cheapCron: { enabled: true, pollState: createMemoryPollStateStore(), runPoll: async () => ({ hit: false, baseline: false }) },
    });
    await cron.fire(0);
    expect(dispatcher.calls[0]!.msg.meta.session).toBe("cron");
    expect(dispatcher.calls[0]!.msg.meta.model).toContain("sonnet");
    expect(sink.fires[0]).toMatchObject({ tier: "cheap" });
  });
});
