/**
 * Tests for microsoft-accounts-yaml — RFC #1873 PR 2.
 *
 * Mirrors `google-accounts-yaml.test.ts` structure: string-in / string-out
 * pure-module test. Validates dormant-on-empty per RFC #1873 §6.1.
 */

import { describe, expect, it } from "vitest";

import {
  disableAgentsOnMicrosoftAccount,
  enableAgentsOnMicrosoftAccount,
  getEnabledAgentsForMicrosoftAccount,
  listMicrosoftAccounts,
  removeMicrosoftAccountEntry,
} from "./microsoft-accounts-yaml.js";

const STARTER = `version: "v1"
auth:
  active: ken
agents:
  clerk: {}
`;

describe("enableAgentsOnMicrosoftAccount", () => {
  it("adds agents to a fresh entry, creating the parent map", () => {
    const out = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    expect(out).toContain("microsoft_accounts:");
    expect(out).toContain("ken@outlook.com:");
    expect(out).toContain("enabled_for:");
    expect(out).toContain("- clerk");
  });

  it("is idempotent (adding the same agent twice is a no-op)", () => {
    const once = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    const twice = enableAgentsOnMicrosoftAccount(once, "ken@outlook.com", ["clerk"]);
    expect(twice).toBe(once);
  });

  it("returns the input verbatim when no agents would be added", () => {
    const once = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    const verbatim = enableAgentsOnMicrosoftAccount(once, "ken@outlook.com", []);
    expect(verbatim).toBe(once);
  });

  it("appends new agents preserving existing order", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk", "lawgpt"]);
    yaml = enableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["finn"]);
    const agents = getEnabledAgentsForMicrosoftAccount(yaml, "ken@outlook.com");
    expect(agents).toEqual(["clerk", "lawgpt", "finn"]);
  });

  it("preserves comments in unrelated parts of the file", () => {
    const yaml = `# top-level comment
version: "v1"
agents:
  # clerk is the exec assistant
  clerk: {}
`;
    const out = enableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["clerk"]);
    expect(out).toContain("# top-level comment");
    expect(out).toContain("# clerk is the exec assistant");
  });
});

describe("disableAgentsOnMicrosoftAccount", () => {
  it("removes named agents, keeps others", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk", "lawgpt"]);
    yaml = disableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["clerk"]);
    const agents = getEnabledAgentsForMicrosoftAccount(yaml, "ken@outlook.com");
    expect(agents).toEqual(["lawgpt"]);
  });

  it("leaves enabled_for as empty array (dormant) when all agents removed", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    yaml = disableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["clerk"]);
    // Dormant — entry stays per RFC #1873 §6.1
    const agents = getEnabledAgentsForMicrosoftAccount(yaml, "ken@outlook.com");
    expect(agents).toEqual([]);
  });

  it("returns input verbatim when account not present", () => {
    const out = disableAgentsOnMicrosoftAccount(STARTER, "ghost@outlook.com", ["clerk"]);
    expect(out).toBe(STARTER);
  });

  it("returns input verbatim when no named agents are in the list", () => {
    const yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    const out = disableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["nonexistent"]);
    expect(out).toBe(yaml);
  });
});

describe("getEnabledAgentsForMicrosoftAccount", () => {
  it("returns null when account is absent (vs empty array = dormant)", () => {
    expect(getEnabledAgentsForMicrosoftAccount(STARTER, "ken@outlook.com")).toBeNull();
  });

  it("returns [] when entry exists with empty enabled_for (dormant)", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    yaml = disableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["clerk"]);
    expect(getEnabledAgentsForMicrosoftAccount(yaml, "ken@outlook.com")).toEqual([]);
  });
});

describe("listMicrosoftAccounts", () => {
  it("returns [] when no microsoft_accounts block exists", () => {
    expect(listMicrosoftAccounts(STARTER)).toEqual([]);
  });

  it("lists all accounts in source order", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    yaml = enableAgentsOnMicrosoftAccount(yaml, "ken@contoso.com", ["lawgpt"]);
    const list = listMicrosoftAccounts(yaml);
    expect(list).toEqual([
      { account: "ken@outlook.com", enabled_for: ["clerk"] },
      { account: "ken@contoso.com", enabled_for: ["lawgpt"] },
    ]);
  });

  it("includes dormant accounts (empty enabled_for) in the list", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    yaml = disableAgentsOnMicrosoftAccount(yaml, "ken@outlook.com", ["clerk"]);
    expect(listMicrosoftAccounts(yaml)).toEqual([
      { account: "ken@outlook.com", enabled_for: [] },
    ]);
  });
});

describe("removeMicrosoftAccountEntry", () => {
  it("removes a configured account", () => {
    const yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    const out = removeMicrosoftAccountEntry(yaml, "ken@outlook.com");
    expect(out).not.toContain("ken@outlook.com");
    expect(out).not.toContain("microsoft_accounts:");
  });

  it("prunes the empty parent map when removing the last entry", () => {
    const yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    const out = removeMicrosoftAccountEntry(yaml, "ken@outlook.com");
    expect(out).not.toContain("microsoft_accounts");
  });

  it("keeps the parent map when other accounts remain", () => {
    let yaml = enableAgentsOnMicrosoftAccount(STARTER, "ken@outlook.com", ["clerk"]);
    yaml = enableAgentsOnMicrosoftAccount(yaml, "ken@contoso.com", ["lawgpt"]);
    const out = removeMicrosoftAccountEntry(yaml, "ken@outlook.com");
    expect(out).toContain("microsoft_accounts");
    expect(out).toContain("ken@contoso.com");
    expect(out).not.toContain("ken@outlook.com");
  });

  it("returns input verbatim when account is absent", () => {
    expect(removeMicrosoftAccountEntry(STARTER, "ghost@outlook.com")).toBe(STARTER);
  });
});
