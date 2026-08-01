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
 *      (robustApiCall) — never a raw bot.api call — and, since #4065, replies
 *      with the outcome so hostd can tell an applied edit from an edit into a
 *      deleted card. Its body lives in gateway/rollout-status-edit.ts.
 *   4. NEITHER handler pins a message — this is in-chat narration, not the
 *      retired pinned card (chat-is-the-single-source-of-truth).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const gw = readFileSync(new URL("../gateway/gateway.ts", import.meta.url), "utf8");
const ipcServer = readFileSync(new URL("../gateway/ipc-server.ts", import.meta.url), "utf8");
const editModule = readFileSync(
  new URL("../gateway/rollout-status-edit.ts", import.meta.url),
  "utf8",
);

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
  it("does NOT pin the message and renders NO inline-keyboard card (narration, not the retired card)", () => {
    expect(handler).not.toMatch(/pinChatMessage/);
    expect(handler).not.toMatch(/reply_markup/);
    expect(handler).not.toMatch(/InlineKeyboard/);
  });
});

describe("onRolloutStatusEdit — gateway handler invariants", () => {
  // #4065 moved the handler BODY into gateway/rollout-status-edit.ts (which has
  // its own behavioural suite, rollout-status-edit.test.ts). gateway.ts keeps
  // only the wiring, so the invariants are pinned across both files.
  const start = gw.indexOf("onRolloutStatusEdit(client: IpcClient, msg: RolloutStatusEditMessage)");
  const next = gw.indexOf("onInjectInbound(", start);
  const handler = gw.slice(start, next > start ? next : start + 2000);

  it("the handler exists", () => {
    expect(start).toBeGreaterThan(0);
  });
  it("delegates to the extracted edit handler", () => {
    expect(handler).toMatch(/handleRolloutStatusEdit\(/);
    expect(gw).toMatch(
      /import \{ handleRolloutStatusEdit \} from '\.\/rollout-status-edit\.js'/,
    );
  });
  it("fences the agent (agentName must match this gateway's own)", () => {
    expect(handler).toMatch(/selfAgentName: process\.env\.SWITCHROOM_AGENT_NAME/);
    expect(editModule).toMatch(/msg\.agentName !== self/);
  });
  it("edits the OPERATOR chat in place via the wrapped retry path", () => {
    expect(handler).toMatch(/loadAccess\(\)\.allowFrom\[0\]/);
    expect(handler).toMatch(/robustApiCall\(/);
    expect(handler).toMatch(/bot\.api\.editMessageText\(chatId, messageId/);
  });
  // Routing through robustApiCall is necessary but NOT sufficient, and pinning
  // only that enshrines the bug it hides: the retry policy's benign-400 swallow
  // resolves `400 "message to edit not found"` instead of throwing, and this
  // handler reads success from the absence of a throw. Both opt-outs are what
  // make the wrapped path safe here, so both are pinned. The BEHAVIOUR lives in
  // tests/rollout-status-edit-retry-policy.test.ts (real retry policy, real
  // GrammyError, asserts the re-post); this is the structural backstop.
  it("opts out of BOTH inertness layers — send-gate shed and benign-400 swallow", () => {
    expect(handler).toMatch(/priorityClass: 'critical'/);
    expect(handler).toMatch(/rethrowBenign400: true/);
  });
  it("reports the edit outcome back to hostd (#4065 — no more edit-into-void)", () => {
    expect(editModule).toMatch(/rollout_status_edited/);
    expect(editModule).toMatch(/gone: cls === 'gone'/);
  });
  it("does NOT pin (edits an ordinary message)", () => {
    expect(handler).not.toMatch(/pinChatMessage/);
    expect(editModule).not.toMatch(/pinChatMessage/);
  });
});
