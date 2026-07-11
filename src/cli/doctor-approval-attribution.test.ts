/**
 * doctor-approval-attribution — WS10-F5 part 1 (#1420). Pins the detection
 * contract for approval-attribution anomalies over approval_decisions rows.
 */

import { describe, it, expect } from "vitest";

import {
  detectAttributionAnomalies,
  runApprovalAttributionChecks,
  type DecisionRow,
} from "./doctor-approval-attribution.js";
import { canonicalizeApproverSet } from "../vault/approvals/canonical.js";

function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "d1",
    granted_by_user_id: 111,
    approver_set_canonical: canonicalizeApproverSet(["111", "222"]),
    decision: "allow_always",
    origin: "operator",
    revoked_at: null,
    ...over,
  };
}

describe("detectAttributionAnomalies", () => {
  it("ok when every active grant's granter is in its own approver set", () => {
    const r = detectAttributionAnomalies([
      row({ id: "a", granted_by_user_id: 111 }),
      row({ id: "b", granted_by_user_id: 222 }),
    ]);
    const own = r.find((c) => c.name.includes("granter in own approver set"));
    expect(own?.status).toBe("ok");
  });

  it("FAILS when a grant's granter is NOT in its own recorded approver set", () => {
    // uid 999 was never on the allowlist that authorized this row → could not
    // have come through the gateway's allowFrom gate → forged/bypass.
    const r = detectAttributionAnomalies([
      row({ id: "good", granted_by_user_id: 111 }),
      row({
        id: "forged",
        granted_by_user_id: 999,
        approver_set_canonical: canonicalizeApproverSet(["111", "222"]),
        origin: "agent",
      }),
    ]);
    const own = r.find((c) => c.name.includes("granter in own approver set"));
    expect(own?.status).toBe("fail");
    expect(own?.detail).toContain("forged");
    expect(own?.detail).toContain("uid=999");
  });

  it("ignores revoked and non-allow decisions", () => {
    const r = detectAttributionAnomalies([
      row({ id: "revoked", granted_by_user_id: 999, revoked_at: 1700000000 }),
      row({ id: "denied", granted_by_user_id: 999, decision: "deny" }),
    ]);
    expect(
      r.find((c) => c.name.includes("granter in own approver set"))?.status,
    ).toBe("ok");
  });

  it("warns (not fails) when the granter left the LIVE allowlist but was valid at grant time", () => {
    const r = detectAttributionAnomalies(
      [row({ id: "stale", granted_by_user_id: 222 })], // 222 in own set…
      ["111"], // …but no longer a live operator
    );
    expect(
      r.find((c) => c.name.includes("granter in own approver set"))?.status,
    ).toBe("ok");
    const stale = r.find((c) => c.name.includes("still on live allowlist"));
    expect(stale?.status).toBe("warn");
    expect(stale?.detail).toContain("uid=222");
  });
});

describe("runApprovalAttributionChecks", () => {
  it("skips cleanly when the decisions DB can't be read", () => {
    const r = runApprovalAttributionChecks({ loadDecisions: () => null });
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("skip");
  });

  it("runs the detector against injected rows", () => {
    const r = runApprovalAttributionChecks({
      loadDecisions: () => [row({ granted_by_user_id: 999 })],
    });
    expect(
      r.find((c) => c.name.includes("granter in own approver set"))?.status,
    ).toBe("fail");
  });
});
