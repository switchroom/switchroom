/**
 * Live-wiring + boot recovery tests. All deps are faked — NO real vault
 * broker or network is touched (vault test-isolation discipline).
 */
import { describe, expect, it } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import { buildCheapCronHooks } from "./cheap-cron-wiring.js";
import { recoverPendingEscalations } from "./index.js";
import { createMemoryPollStateStore } from "../scheduler/poll-state.js";
import type { InboundDispatcher, InboundMessageWire, SchedulerEntry } from "../scheduler/dispatch.js";

const CONFIG = {
  cron: { egress: { allowed_hosts: ["api.brevo.com"], secret_bindings: { brevo_api_key: "api.brevo.com" } } },
} as unknown as SwitchroomConfig;

const ON = { SWITCHROOM_CHEAP_CRON: "1" } as NodeJS.ProcessEnv;
// Cheap-cron is on by default now; OFF is the explicit kill-switch value.
const OFF = { SWITCHROOM_CHEAP_CRON: "0" } as NodeJS.ProcessEnv;

function capture(): InboundDispatcher & { calls: Array<{ agent: string; msg: InboundMessageWire }> } {
  const calls: Array<{ agent: string; msg: InboundMessageWire }> = [];
  return { calls, sendToAgent: (agent, msg) => (calls.push({ agent, msg }), true) };
}

describe("buildCheapCronHooks", () => {
  it("flag OFF → undefined (no hooks, today's behaviour)", () => {
    expect(buildCheapCronHooks(CONFIG, OFF)).toBeUndefined();
  });

  it("flag ON → hooks whose http-diff runPoll respects the config egress allowlist", async () => {
    const hooks = buildCheapCronHooks(CONFIG, ON, {
      pollState: createMemoryPollStateStore(),
      resolveSecret: async () => "secret",
      lookup: async () => "8.8.8.8",
      fetchImpl: (async () => new Response(JSON.stringify({ contacts: [{ id: 7 }] }), { status: 200 })) as unknown as typeof fetch,
      now: () => 1000,
    });
    expect(hooks).toBeDefined();
    const out = await hooks!.runPoll(
      { type: "http-diff", url: "https://api.brevo.com/x", method: "GET", secrets: ["brevo_api_key"], diff_jsonpath: "$.contacts[*].id", state_key: "k" },
      "3",
    );
    expect(out).toMatchObject({ hit: true, cursor: "7" });
  });

  it("a poll to a non-allowlisted host is denied by the wired egress guard", async () => {
    const hooks = buildCheapCronHooks(CONFIG, ON, {
      pollState: createMemoryPollStateStore(),
      resolveSecret: async () => "secret",
      lookup: async () => "8.8.8.8",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const out = await hooks!.runPoll(
      { type: "http-diff", url: "https://evil.example/x", method: "GET", secrets: [], diff_jsonpath: "$.a", state_key: "k" },
      "1",
    );
    expect(out.error).toMatch(/egress denied/);
  });

  it("an unknown/future poll type → poll error, never a silent success", async () => {
    // http-diff is the only poll type today (telegram-reactions removed —
    // reaction_dispatch covers reactions). A poll type the engine doesn't
    // handle must record an error, never silently succeed.
    const hooks = buildCheapCronHooks(CONFIG, ON, { pollState: createMemoryPollStateStore() });
    const out = await hooks!.runPoll({ type: "future-type" } as never, undefined);
    expect(out.error).toMatch(/not yet wired/);
    expect(out.hit).toBe(false);
  });
});

describe("buildCheapCronHooks — runAction (#2307)", () => {
  it("telegram-message → posts the substituted text via postOutbound (model-free)", async () => {
    const posts: Array<{ threadId?: number; text: string; parseMode: string }> = [];
    const hooks = buildCheapCronHooks(CONFIG, ON, {
      pollState: createMemoryPollStateStore(),
      agentName: "clerk",
      now: () => Date.UTC(2026, 5, 13, 9, 5),
      postOutbound: (args) => (posts.push(args), true),
    });
    const out = await hooks!.runAction!(
      { type: "telegram-message", text: "Heartbeat {{date}} — {{agent}}", parse_mode: "html" },
      { threadId: 7 },
    );
    expect(out.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ threadId: 7, text: "Heartbeat 2026-06-13 — clerk", parseMode: "html" });
  });

  it("telegram-message with NO postOutbound wired → graceful not-delivered (no throw)", async () => {
    const hooks = buildCheapCronHooks(CONFIG, ON, { pollState: createMemoryPollStateStore() });
    const out = await hooks!.runAction!(
      { type: "telegram-message", text: "hi", parse_mode: "html" },
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not delivered/);
  });

  it("webhook → fires through the wired egress fence, no postOutbound needed", async () => {
    const fetched: string[] = [];
    const hooks = buildCheapCronHooks(CONFIG, ON, {
      pollState: createMemoryPollStateStore(),
      resolveSecret: async () => "tok",
      lookup: async () => "8.8.8.8",
      fetchImpl: (async (url: string) => (fetched.push(url), new Response("ok", { status: 200 }))) as unknown as typeof fetch,
    });
    const out = await hooks!.runAction!(
      { type: "webhook", url: "https://api.brevo.com/ping", method: "POST", secrets: [] },
      {},
    );
    expect(out.ok).toBe(true);
    expect(fetched).toEqual(["https://api.brevo.com/ping"]);
  });

  it("webhook to a non-allowlisted host is denied by the wired egress guard", async () => {
    const hooks = buildCheapCronHooks(CONFIG, ON, {
      pollState: createMemoryPollStateStore(),
      lookup: async () => "8.8.8.8",
      fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    const out = await hooks!.runAction!(
      { type: "webhook", url: "https://evil.example/x", method: "POST", secrets: [] },
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/egress denied/);
  });
});

describe("recoverPendingEscalations", () => {
  const pollEntry: SchedulerEntry = {
    agent: "marko",
    scheduleIndex: 0,
    cron: "*/15 * * * *",
    prompt: "New: {{diff}}",
    promptKey: "p1",
    kind: "poll",
    poll: { type: "http-diff", url: "https://api.brevo.com/x", method: "GET", secrets: [], diff_jsonpath: "$.a", state_key: "k" },
  };

  it("re-dispatches a dangling pendingEscalation once, clears it, and audits it", () => {
    const pollState = createMemoryPollStateStore({ k: { value: "9", pendingEscalation: "cursor 9 > 5 (1)" } });
    const dispatcher = capture();
    const fires: Array<{ tier?: string; outputSummary: string }> = [];
    const n = recoverPendingEscalations({
      entries: [pollEntry],
      pollState,
      dispatcher,
      channel: { chatId: "123" } as never,
      cheapCronEnabled: true,
      now: () => 1000,
      log: () => {},
      sink: { recordFire: (r) => fires.push(r) },
    });
    expect(n).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.msg.text).toBe("New: cursor 9 > 5 (1)");
    expect(pollState.get("k")?.pendingEscalation).toBeUndefined();
    // recovered hit is audited so `schedule report` counts it (reviewer note #1)
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ tier: "main", outputSummary: "recovered pending escalation (boot)" });
  });

  it("no dangling escalation → no dispatch", () => {
    const pollState = createMemoryPollStateStore({ k: { value: "9" } });
    const dispatcher = capture();
    expect(
      recoverPendingEscalations({ entries: [pollEntry], pollState, dispatcher, channel: { chatId: "1" } as never, cheapCronEnabled: true, now: () => 1, log: () => {} }),
    ).toBe(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("skips non-poll entries", () => {
    const pollState = createMemoryPollStateStore({ k: { value: "9", pendingEscalation: "x" } });
    const dispatcher = capture();
    const promptEntry: SchedulerEntry = { agent: "marko", scheduleIndex: 1, cron: "0 9 * * *", prompt: "hi", promptKey: "p2" };
    recoverPendingEscalations({ entries: [promptEntry], pollState, dispatcher, channel: { chatId: "1" } as never, cheapCronEnabled: true, now: () => 1, log: () => {} });
    expect(dispatcher.calls).toHaveLength(0);
  });
});
