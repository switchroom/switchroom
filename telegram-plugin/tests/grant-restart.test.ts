/**
 * Tests for grantRestartDecision — the gating for the "make a just-persisted
 * grant LIVE" self-restart (item ② config-edit-takes-effect). Pins: kill-switch,
 * self-agent-only (never a peer/fleet bounce), and turn-deferred-vs-now.
 */

import { describe, it, expect } from "vitest";
import { grantRestartDecision } from "../gateway/grant-restart.js";

const base = { killSwitch: undefined, selfAgent: "clerk", agentName: "clerk", turnInFlight: true };

describe("grantRestartDecision", () => {
  it("defers to turn-complete when a turn is in flight (marker-safe)", () => {
    expect(grantRestartDecision({ ...base, turnInFlight: true })).toBe("deferred");
  });

  it("fires now when no turn is in flight", () => {
    expect(grantRestartDecision({ ...base, turnInFlight: false })).toBe("now");
  });

  it("is disabled by the kill-switch (SWITCHROOM_AUTORESTART_ON_GRANT=0)", () => {
    expect(grantRestartDecision({ ...base, killSwitch: "0" })).toBe("disabled");
  });

  it("default-on for any non-'0' kill-switch value", () => {
    expect(grantRestartDecision({ ...base, killSwitch: "" })).toBe("deferred");
    expect(grantRestartDecision({ ...base, killSwitch: "1" })).toBe("deferred");
  });

  it("NEVER restarts a peer — self-agent only", () => {
    // edit targets a different agent than the gateway's own identity
    expect(grantRestartDecision({ ...base, selfAgent: "clerk", agentName: "gymbro" })).toBe("disabled");
  });

  it("is disabled when self identity is unknown", () => {
    expect(grantRestartDecision({ ...base, selfAgent: undefined })).toBe("disabled");
  });
});
