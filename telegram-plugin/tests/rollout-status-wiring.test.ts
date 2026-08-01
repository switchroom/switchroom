/**
 * #2726 — structural wiring guard for the rollout status IPC verbs. The
 * gateway handlers live in the createIpcServer({...}) IIFE block, which can't
 * be imported in a unit test (same constraint as the send_outbound /
 * inject_inbound wiring tests), so the load-bearing invariants are pinned by
 * reading the source:
 *   1. ipc-server routes rollout_status_post → onRolloutStatusPost and
 *      rollout_status_edit → onRolloutStatusEdit, with validator arms.
 *   2. the POST handler fences agent (agentName === self), posts to the
 *      OPERATOR chat (allowFrom[0]) as an ORDINARY message (no pin, no
 *      inline_keyboard card), and replies with the message_id.
 *   3. the EDIT handler edits in place via the wrapped retry path
 *      (swallowingApiCall) — fire-and-forget, never a raw bot.api call.
 *   4. NEITHER handler pins a message — this is in-chat narration, not the
 *      retired pinned card (chat-is-the-single-source-of-truth).
 *   5. (#4048) the POST handler may attach a tap-to-restart inline keyboard,
 *      but ONLY the one hostd forwarded on the message (msg.inlineKeyboard) —
 *      it never invents a pinned card. The keyboard is an ordinary message's
 *      reply_markup, still narration, still un-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const gw = readFileSync(new URL("../gateway/gateway.ts", import.meta.url), "utf8");
const ipcServer = readFileSync(new URL("../gateway/ipc-server.ts", import.meta.url), "utf8");

describe("rollout_status_* — ipc-server routing", () => {
  it("validates + dispatches rollout_status_post", () => {
    expect(ipcServer).toMatch(/case "rollout_status_post": \{/); // validator arm
    expect(ipcServer).toMatch(/onRolloutStatusPost\(client, msg as RolloutStatusPostMessage\)/);
  });
  it("validates + dispatches rollout_status_edit", () => {
    expect(ipcServer).toMatch(/case "rollout_status_edit": \{/);
    expect(ipcServer).toMatch(/onRolloutStatusEdit\(client, msg as RolloutStatusEditMessage\)/);
  });
});

describe("onRolloutStatusPost — gateway handler invariants", () => {
  const start = gw.indexOf("async onRolloutStatusPost(client: IpcClient, msg: RolloutStatusPostMessage)");
  const next = gw.indexOf("onRolloutStatusEdit(", start);
  const handler = gw.slice(start, next > start ? next : start + 2600);

  it("the handler exists", () => {
    expect(start).toBeGreaterThan(0);
  });
  it("fences the agent (agentName must match this gateway's own)", () => {
    expect(handler).toMatch(/msg\.agentName !== self/);
  });
  it("posts to the OPERATOR chat (allowFrom[0])", () => {
    expect(handler).toMatch(/loadAccess\(\)\.allowFrom\[0\]/);
  });
  it("posts through the wrapped retry path, NOT a raw bot.api", () => {
    expect(handler).toMatch(/robustApiCall\(/);
    expect(handler).toMatch(/bot\.api\.sendRichMessage\(operator/);
  });
  it("replies with the message_id so hostd can EDIT it later", () => {
    expect(handler).toMatch(/rollout_status_posted/);
    expect(handler).toMatch(/messageId/);
  });
  it("does NOT pin the message (narration, not the retired pinned card)", () => {
    expect(handler).not.toMatch(/pinChatMessage/);
  });
  it("#4048 — attaches a tap-to-restart keyboard ONLY when hostd forwarded one", () => {
    // The keyboard is the ensure-banks recovery card. It rides on the message
    // hostd sent (msg.inlineKeyboard) — the gateway never fabricates one, and
    // absent it the post stays a plain progress line.
    expect(handler).toMatch(/msg\.inlineKeyboard/);
    expect(handler).toMatch(/reply_markup:\s*\{\s*inline_keyboard:\s*msg\.inlineKeyboard\s*\}/);
  });
});

describe("onRolloutStatusEdit — gateway handler invariants", () => {
  const start = gw.indexOf("onRolloutStatusEdit(_client: IpcClient, msg: RolloutStatusEditMessage)");
  const next = gw.indexOf("onInjectInbound(", start);
  const handler = gw.slice(start, next > start ? next : start + 2000);

  it("the handler exists", () => {
    expect(start).toBeGreaterThan(0);
  });
  it("fences the agent", () => {
    expect(handler).toMatch(/msg\.agentName !== self/);
  });
  it("edits in place via the wrapped retry path (fire-and-forget)", () => {
    expect(handler).toMatch(/swallowingApiCall\(/);
    expect(handler).toMatch(/bot\.api\.editMessageText\(operator, msg\.messageId/);
  });
  it("does NOT pin (edits an ordinary message)", () => {
    expect(handler).not.toMatch(/pinChatMessage/);
  });
});
