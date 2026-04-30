import { describe, it, expect } from "vitest";
import { validateClientMessage } from "../gateway/ipc-server.js";

/**
 * #430 Phase 2 — bridge anonymous refuse.
 *
 * The bridge defaults to SWITCHROOM_AGENT_NAME="default" if the env
 * var isn't set (legacy behaviour). That's how we got the
 * `registered agent=default` lines in every gateway log: any
 * non-switchroom claude session that loaded the telegram MCP plugin
 * would probe each agent's gateway socket and register as "default",
 * crosstalking into someone else's chat.
 *
 * The bridge now refuses to start without a real agent name. The
 * gateway's validator is the server-side defence: if anyone sends a
 * register message with agentName="default" — a stale older bridge,
 * a third-party tool, an attacker — we drop it.
 */

describe("validateClientMessage — register agentName='default' refused (#430)", () => {
  it("rejects register with agentName=default (legacy anonymous fallback)", () => {
    expect(
      validateClientMessage({
        type: "register",
        agentName: "default",
      }),
    ).toBe(false);
  });

  it("accepts register with a real agent name", () => {
    expect(
      validateClientMessage({
        type: "register",
        agentName: "klanker",
      }),
    ).toBe(true);
  });

  it("still rejects empty / missing agentName (existing contract)", () => {
    expect(validateClientMessage({ type: "register", agentName: "" })).toBe(false);
    expect(validateClientMessage({ type: "register" })).toBe(false);
  });

  it("rejects oversized agentName (existing contract preserved)", () => {
    expect(
      validateClientMessage({
        type: "register",
        agentName: "x".repeat(129),
      }),
    ).toBe(false);
  });

  it("accepts a real name even when 'default' appears as a substring", () => {
    // Sanity: we reject the literal string, not anything containing it.
    expect(
      validateClientMessage({
        type: "register",
        agentName: "default-finance-agent",
      }),
    ).toBe(true);
    expect(
      validateClientMessage({
        type: "register",
        agentName: "my-default",
      }),
    ).toBe(true);
  });

  it("validator rejection happens before handleRegister side effects", () => {
    // No state to inspect at this layer — the validator is pure. The
    // contract this test guards: validate() returning false means the
    // gateway's main loop logs "invalid IPC message shape from
    // client" and continues without dispatching to handleRegister.
    // See ipc-server.ts processBuffer for the early-return.
    expect(
      validateClientMessage({
        type: "register",
        agentName: "default",
      }),
    ).toBe(false);
  });
});
