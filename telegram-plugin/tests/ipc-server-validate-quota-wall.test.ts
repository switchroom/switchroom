/**
 * Validation contract for the `quota_wall_detected` IPC verb — the signal the
 * autoaccept-poll wedge-watchdog sends when it sees claude's /rate-limit-options
 * weekly-quota menu, asking the gateway to trigger account failover.
 *
 * A rogue process on the same UDS must not be able to inject a malformed
 * payload: agentName is required + name-shaped, resetAt (optional) must be a
 * finite number.
 */
import { describe, it, expect } from "vitest";
import { validateClientMessage } from "../gateway/ipc-server.js";

describe("validateClientMessage — quota_wall_detected", () => {
  it("accepts a well-formed signal (with resetAt)", () => {
    expect(
      validateClientMessage({ type: "quota_wall_detected", agentName: "finn", resetAt: 1_780_000_000_000 }),
    ).toBe(true);
  });

  it("accepts a well-formed signal WITHOUT resetAt (optional)", () => {
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "finn" })).toBe(true);
  });

  it("rejects a missing / non-string / malformed agentName", () => {
    expect(validateClientMessage({ type: "quota_wall_detected" })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: 123 })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "" })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "../etc" })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "Finn UPPER" })).toBe(false);
  });

  it("rejects a non-finite / non-number resetAt", () => {
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "finn", resetAt: "soon" })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "finn", resetAt: NaN })).toBe(false);
    expect(validateClientMessage({ type: "quota_wall_detected", agentName: "finn", resetAt: Infinity })).toBe(false);
  });
});
