/**
 * Structural wiring guard for the model-free `send_outbound` verb (#2307).
 *
 * The gateway handler lives in the createIpcServer({...}) IIFE block, which
 * can't be imported in a unit test (same constraint as the inject_inbound /
 * linear-activity wiring tests), so the load-bearing invariants are pinned by
 * reading the source:
 *   1. ipc-server routes `send_outbound` → onSendOutbound.
 *   2. the gateway handler fences agent (agentName === self) AND chat
 *      (assertAllowedChat) before sending.
 *   3. it is MODEL-FREE: never markClaudeBusy / currentTurn / inject — a
 *      send_outbound must not wake a turn (the whole point of Tier-0).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const gw = readFileSync(new URL("../gateway/gateway.ts", import.meta.url), "utf8");
const ipcServer = readFileSync(new URL("../gateway/ipc-server.ts", import.meta.url), "utf8");

describe("send_outbound — ipc-server routing", () => {
  it("validates the verb and dispatches to onSendOutbound", () => {
    expect(ipcServer).toMatch(/case "send_outbound":/);
    expect(ipcServer).toMatch(/onSendOutbound\(client, msg as SendOutboundMessage\)/);
    // the validator has a dedicated arm.
    expect(ipcServer).toMatch(/case "send_outbound": \{/);
  });
});

describe("send_outbound — gateway handler invariants", () => {
  // Isolate the handler body for the assertions below.
  const start = gw.indexOf("onSendOutbound(_client: IpcClient, msg: SendOutboundMessage)");
  // Bound the slice at the START of the NEXT handler so the whole onSendOutbound
  // body is covered regardless of how it grows (no fixed char window to outgrow),
  // without bleeding into a sibling handler.
  const next = gw.indexOf("onQuotaWallDetected(", start);
  const handler = gw.slice(start, next > start ? next : start + 2600);

  it("the handler exists", () => {
    expect(start).toBeGreaterThan(0);
  });

  it("fences the agent (agentName must match this gateway's own)", () => {
    expect(handler).toMatch(/msg\.agentName !== self/);
  });

  it("fences the chat to the agent's own allowlist (assertAllowedChat)", () => {
    expect(handler).toMatch(/assertAllowedChat\(msg\.chatId\)/);
  });

  it("is MODEL-FREE — never wakes a turn (no markClaudeBusy / currentTurn / inject)", () => {
    expect(handler).not.toMatch(/markClaudeBusy/);
    expect(handler).not.toMatch(/currentTurn/);
    expect(handler).not.toMatch(/sendToAgent/);
    expect(handler).not.toMatch(/inject/i);
  });

  it("sends via the wrapped retry path (not a raw bot.api outside swallowingApiCall)", () => {
    expect(handler).toMatch(/swallowingApiCall\(/);
    expect(handler).toMatch(/bot\.api\.sendMessage\(msg\.chatId, msg\.text/);
    // General topic (thread 1) is stripped on send, per the outbound convention.
    expect(handler).toMatch(/threadId !== 1/);
  });
});
