/**
 * Validation contract for the `send_outbound` IPC verb (#2307 Tier-0 action
 * tier) — the MODEL-FREE outbound the agent-scheduler sends for a `kind: action`
 * telegram-message. A rogue process on the same UDS must not inject a malformed
 * payload: agentName required + name-shaped, chatId + text required non-empty,
 * threadId (optional) an integer, parseMode (optional) html|text.
 */
import { describe, it, expect } from "vitest";
import { validateClientMessage } from "../gateway/ipc-server.js";

const base = { type: "send_outbound", agentName: "clerk", chatId: "12345", text: "Daily heartbeat" };

describe("validateClientMessage — send_outbound", () => {
  it("accepts a well-formed minimal message", () => {
    expect(validateClientMessage(base)).toBe(true);
  });

  it("accepts threadId + parseMode", () => {
    expect(validateClientMessage({ ...base, threadId: 7, parseMode: "html" })).toBe(true);
    expect(validateClientMessage({ ...base, threadId: 1, parseMode: "text" })).toBe(true);
  });

  it("rejects a missing / non-string / malformed agentName", () => {
    expect(validateClientMessage({ ...base, agentName: undefined })).toBe(false);
    expect(validateClientMessage({ ...base, agentName: 123 })).toBe(false);
    expect(validateClientMessage({ ...base, agentName: "" })).toBe(false);
    expect(validateClientMessage({ ...base, agentName: "../etc" })).toBe(false);
    expect(validateClientMessage({ ...base, agentName: "Clerk UPPER" })).toBe(false);
  });

  it("rejects a missing / empty chatId", () => {
    expect(validateClientMessage({ ...base, chatId: undefined })).toBe(false);
    expect(validateClientMessage({ ...base, chatId: "" })).toBe(false);
    expect(validateClientMessage({ ...base, chatId: 123 })).toBe(false);
  });

  it("rejects a missing / empty / over-long text", () => {
    expect(validateClientMessage({ ...base, text: undefined })).toBe(false);
    expect(validateClientMessage({ ...base, text: "" })).toBe(false);
    expect(validateClientMessage({ ...base, text: 5 })).toBe(false);
    expect(validateClientMessage({ ...base, text: "x".repeat(4096) })).toBe(true); // at the cap
    expect(validateClientMessage({ ...base, text: "x".repeat(4097) })).toBe(false); // over Telegram's limit
  });

  it("rejects a non-integer threadId", () => {
    expect(validateClientMessage({ ...base, threadId: 1.5 })).toBe(false);
    expect(validateClientMessage({ ...base, threadId: "1" })).toBe(false);
  });

  it("rejects an unknown parseMode", () => {
    expect(validateClientMessage({ ...base, parseMode: "markdown" })).toBe(false);
    expect(validateClientMessage({ ...base, parseMode: 1 })).toBe(false);
  });
});
