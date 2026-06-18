/**
 * Regression tests for the enable/disable planners.
 *
 * The bug these pin: `auth microsoft enable` used to write ONLY the ACL
 * (`microsoft_accounts.<acct>.enabled_for[]`) and not the per-agent selector
 * (`agents.<agent>.microsoft_workspace.account`). The broker needs both, so
 * the operator hit ACCOUNT_NOT_FOUND even after enable + restart. The planner
 * must now write both halves.
 */

import { describe, expect, it } from "vitest";

import { planMicrosoftEnable, planMicrosoftDisable } from "./microsoft-enable-plan.js";
import { getEnabledAgentsForMicrosoftAccount } from "./microsoft-accounts-yaml.js";
import { getAgentWorkspaceAccount } from "../config/agent-workspace-account.js";

const FIXTURE = `version: "v1"
agents:
  marko: {}
  lawgpt:
    microsoft_workspace:
      account: someone-else@outlook.com
  ziggy:
    microsoft_workspace:
      account: lisa@hotmail.com
`;

const ACCT = "lisa@hotmail.com";

describe("planMicrosoftEnable", () => {
  it("writes BOTH the ACL and the selector for an agent with no selector", () => {
    const { text, newlyEnabled, selectorSet, selectorConflict } = planMicrosoftEnable(
      FIXTURE,
      ACCT,
      ["marko"],
    );
    // ACL half
    expect(getEnabledAgentsForMicrosoftAccount(text, ACCT)).toContain("marko");
    expect(newlyEnabled).toEqual(["marko"]);
    // Selector half — the regression: this used to be missing.
    expect(getAgentWorkspaceAccount(text, "microsoft", "marko")).toBe(ACCT);
    expect(selectorSet).toEqual(["marko"]);
    expect(selectorConflict).toEqual([]);
  });

  it("does NOT override a selector pointing at a different account; reports a conflict", () => {
    const { text, selectorSet, selectorConflict, newlyEnabled } = planMicrosoftEnable(
      FIXTURE,
      ACCT,
      ["lawgpt"],
    );
    // ACL is still added...
    expect(getEnabledAgentsForMicrosoftAccount(text, ACCT)).toContain("lawgpt");
    expect(newlyEnabled).toEqual(["lawgpt"]);
    // ...but the existing selector is left untouched and flagged.
    expect(getAgentWorkspaceAccount(text, "microsoft", "lawgpt")).toBe(
      "someone-else@outlook.com",
    );
    expect(selectorSet).toEqual([]);
    expect(selectorConflict).toEqual([
      { agent: "lawgpt", current: "someone-else@outlook.com" },
    ]);
  });

  it("is a no-op for an agent already fully wired (ACL + matching selector)", () => {
    // First fully enable marko, then re-run — should be byte-equal.
    const first = planMicrosoftEnable(FIXTURE, ACCT, ["marko"]).text;
    const { text, newlyEnabled, selectorSet } = planMicrosoftEnable(first, ACCT, ["marko"]);
    expect(text).toBe(first);
    expect(newlyEnabled).toEqual([]);
    expect(selectorSet).toEqual([]);
  });

  it("leaves a matching selector untouched (ziggy already pins this account)", () => {
    const { selectorSet, selectorConflict } = planMicrosoftEnable(FIXTURE, ACCT, ["ziggy"]);
    expect(selectorSet).toEqual([]);
    expect(selectorConflict).toEqual([]);
  });

  it("handles multiple agents in one call", () => {
    const { text, selectorSet } = planMicrosoftEnable(FIXTURE, ACCT, ["marko", "ziggy"]);
    expect(getEnabledAgentsForMicrosoftAccount(text, ACCT)).toEqual(
      expect.arrayContaining(["marko", "ziggy"]),
    );
    // marko needed a selector; ziggy already had a matching one.
    expect(selectorSet).toEqual(["marko"]);
  });
});

describe("planMicrosoftDisable", () => {
  it("drops the ACL AND clears the selector when it pointed at this account", () => {
    const enabled = planMicrosoftEnable(FIXTURE, ACCT, ["marko"]).text;
    const { text, removed, selectorCleared } = planMicrosoftDisable(enabled, ACCT, ["marko"]);
    expect(removed).toEqual(["marko"]);
    expect(getEnabledAgentsForMicrosoftAccount(text, ACCT) ?? []).not.toContain("marko");
    expect(getAgentWorkspaceAccount(text, "microsoft", "marko")).toBeNull();
    expect(selectorCleared).toEqual(["marko"]);
  });

  it("does NOT clear a selector pinned to a DIFFERENT account", () => {
    // lawgpt is enabled_for ACCT (via the ACL) but its selector points at
    // someone-else@outlook.com (enable reported it as a conflict, left it).
    // Disabling ACCT from lawgpt drops the ACL but MUST leave the unrelated
    // selector intact — only a selector matching the disabled account is cleared.
    const enabled = planMicrosoftEnable(FIXTURE, ACCT, ["lawgpt"]).text;
    expect(getAgentWorkspaceAccount(enabled, "microsoft", "lawgpt")).toBe(
      "someone-else@outlook.com",
    );
    const { text, removed, selectorCleared } = planMicrosoftDisable(enabled, ACCT, ["lawgpt"]);
    expect(removed).toEqual(["lawgpt"]);
    expect(selectorCleared).toEqual([]); // the negative the guard protects
    expect(getAgentWorkspaceAccount(text, "microsoft", "lawgpt")).toBe(
      "someone-else@outlook.com",
    );
  });

  it("DOES clear a selector that matched the disabled account", () => {
    const enabled = planMicrosoftEnable(FIXTURE, ACCT, ["ziggy"]).text;
    const { selectorCleared } = planMicrosoftDisable(enabled, ACCT, ["ziggy"]);
    expect(selectorCleared).toEqual(["ziggy"]);
  });
});
