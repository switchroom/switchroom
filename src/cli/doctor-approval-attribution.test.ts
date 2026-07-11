/**
 * doctor-approval-attribution — WS10-F5 part 1 (#1420). Pins the detection
 * contract for approval-attribution anomalies over approval_decisions rows.
 */

import { describe, it, expect } from "vitest";

import {
  detectAttributionAnomalies,
  loadLiveAllowFromAccessFiles,
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
  it("skips cleanly when the decisions DB can't be read", async () => {
    const r = await runApprovalAttributionChecks({ loadDecisions: () => null });
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("skip");
  });

  it("runs the detector against injected rows", async () => {
    const r = await runApprovalAttributionChecks({
      loadDecisions: () => [row({ granted_by_user_id: 999 })],
    });
    expect(
      r.find((c) => c.name.includes("granter in own approver set"))?.status,
    ).toBe("fail");
  });

  it("plumbs liveAllowFrom through to the stale-granter warn (doctor wiring contract)", async () => {
    // Mirrors the doctor.ts call site: a defined liveAllowFrom must activate
    // the stale-granter check. Regression guard for the check being wired
    // with no deps (liveAllowFrom undefined → the warn was dead code).
    const r = await runApprovalAttributionChecks({
      loadDecisions: () => [row({ granted_by_user_id: 222 })], // 222 in own set
      liveAllowFrom: ["111"], // …but not a live operator any more
    });
    expect(
      r.find((c) => c.name.includes("still on live allowlist"))?.status,
    ).toBe("warn");
  });
});

describe("loadLiveAllowFromAccessFiles", () => {
  const files: Record<string, string> = {
    "/a/one/telegram/access.json": JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["111", "222"],
    }),
    "/a/two/telegram/access.json": JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["222", 333], // numeric entry → coerced to string
    }),
    "/a/broken/telegram/access.json": "{not json",
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };

  it("unions allowFrom across every readable agent access.json", () => {
    const r = loadLiveAllowFromAccessFiles(
      ["one", "two", "broken", "missing"],
      "/a",
      read,
    );
    expect(r?.sort()).toEqual(["111", "222", "333"]);
  });

  it("returns undefined when NO access.json could be read (skip, not empty allowlist)", () => {
    // An empty-list return would mark EVERY granter stale — undefined must
    // disable the stale-granter check instead.
    expect(loadLiveAllowFromAccessFiles(["missing"], "/a", read)).toBeUndefined();
    expect(loadLiveAllowFromAccessFiles([], "/a", read)).toBeUndefined();
  });
});
