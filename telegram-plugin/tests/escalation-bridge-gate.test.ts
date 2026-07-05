import { describe, it, expect } from "vitest";
import { shouldDeferEscalationForBridge } from "../gateway/escalation-bridge-gate.js";

// Executable verification of #2788 Gap A: the obligation sweep's escalate branch
// DIRECT-SENDS (bypassing the bridge), so during a transient bridge outage it
// could fire a false "I may have missed this" even though the real reply is just
// queued behind the flap. The gate defers the nudge while the bridge is down;
// obligations survive bridge death, so the deferral is safe and self-healing.

describe("shouldDeferEscalationForBridge — #2788 Gap A bridge-flap gate", () => {
  it("DEFERS escalation while the bridge is down (no false 'I may have missed this')", () => {
    expect(shouldDeferEscalationForBridge({ bridgeAlive: false })).toBe(true);
  });

  it("proceeds with escalation when the bridge is alive", () => {
    expect(shouldDeferEscalationForBridge({ bridgeAlive: true })).toBe(false);
  });

  it("models the gateway wiring: getClient(agent)?.isAlive() === true drives the gate", () => {
    // Bridge registered + alive → do not defer.
    const aliveClient = { isAlive: () => true };
    expect(
      shouldDeferEscalationForBridge({ bridgeAlive: aliveClient.isAlive() === true }),
    ).toBe(false);

    // Bridge registered but a stale/dead socket → defer.
    const deadClient = { isAlive: () => false };
    expect(
      shouldDeferEscalationForBridge({ bridgeAlive: deadClient.isAlive() === true }),
    ).toBe(true);

    // No client registered at all (getClient returns undefined) → defer.
    const noClient: { isAlive: () => boolean } | undefined = undefined;
    expect(
      shouldDeferEscalationForBridge({ bridgeAlive: noClient?.isAlive() === true }),
    ).toBe(true);
  });
});
