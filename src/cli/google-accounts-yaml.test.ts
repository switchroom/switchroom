/**
 * Tests for google-accounts-yaml — pure string-in / string-out helpers
 * for the top-level `google_accounts:` block (RFC G §4.4).
 *
 * Mirrors the test pattern in `tests/auth-accounts-yaml.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  disableAgentsOnGoogleAccount,
  enableAgentsOnGoogleAccount,
  getEnabledAgentsForGoogleAccount,
  listGoogleAccounts,
  removeGoogleAccountEntry,
} from "./google-accounts-yaml.js";

const baseYaml = `# top of file
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: klanker
`;

const yamlWithOneAccount = `${baseYaml}google_accounts:
  alice@example.com:
    enabled_for:
      - klanker
`;

describe("enableAgentsOnGoogleAccount", () => {
  it("creates the entry when google_accounts is missing entirely", () => {
    const out = enableAgentsOnGoogleAccount(baseYaml, "alice@example.com", ["klanker"]);
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual(["klanker"]);
  });

  it("appends to existing enabled_for list", () => {
    const out = enableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", ["gymbro"]);
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual([
      "klanker",
      "gymbro",
    ]);
  });

  it("idempotent — re-adding an existing agent is a no-op (returns input verbatim)", () => {
    const out = enableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", ["klanker"]);
    expect(out).toBe(yamlWithOneAccount);
  });

  it("partial overlap — only adds the new agents, skips existing", () => {
    const out = enableAgentsOnGoogleAccount(
      yamlWithOneAccount,
      "alice@example.com",
      ["klanker", "gymbro", "coderev"],
    );
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual([
      "klanker",
      "gymbro",
      "coderev",
    ]);
  });

  it("creates a second account alongside an existing one", () => {
    const out = enableAgentsOnGoogleAccount(
      yamlWithOneAccount,
      "work@bigcorp.com",
      ["coderev"],
    );
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual(["klanker"]);
    expect(getEnabledAgentsForGoogleAccount(out, "work@bigcorp.com")).toEqual(["coderev"]);
  });

  it("preserves a top-of-file comment", () => {
    const out = enableAgentsOnGoogleAccount(baseYaml, "alice@example.com", ["klanker"]);
    expect(out.startsWith("# top of file")).toBe(true);
  });
});

describe("disableAgentsOnGoogleAccount", () => {
  it("removes a single agent from enabled_for", () => {
    const yaml = enableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", [
      "gymbro",
    ]);
    const out = disableAgentsOnGoogleAccount(yaml, "alice@example.com", ["klanker"]);
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual(["gymbro"]);
  });

  it("removes multiple agents in one call", () => {
    let yaml = enableAgentsOnGoogleAccount(baseYaml, "alice@example.com", [
      "klanker",
      "gymbro",
      "coderev",
    ]);
    yaml = disableAgentsOnGoogleAccount(yaml, "alice@example.com", ["klanker", "coderev"]);
    expect(getEnabledAgentsForGoogleAccount(yaml, "alice@example.com")).toEqual(["gymbro"]);
  });

  it("leaves enabled_for as an empty array when last agent is removed (dormant state)", () => {
    const out = disableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", ["klanker"]);
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toEqual([]);
  });

  it("no-op when account is not in google_accounts at all", () => {
    expect(disableAgentsOnGoogleAccount(baseYaml, "alice@example.com", ["klanker"])).toBe(baseYaml);
  });

  it("no-op when none of the named agents are enabled", () => {
    expect(disableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", ["nope"])).toBe(
      yamlWithOneAccount,
    );
  });
});

describe("getEnabledAgentsForGoogleAccount", () => {
  it("returns null for an account not in YAML at all (vs empty array for dormant)", () => {
    expect(getEnabledAgentsForGoogleAccount(baseYaml, "alice@example.com")).toBe(null);
  });

  it("returns [] for an account with empty enabled_for (dormant)", () => {
    const yaml = disableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", [
      "klanker",
    ]);
    expect(getEnabledAgentsForGoogleAccount(yaml, "alice@example.com")).toEqual([]);
  });

  it("returns the agents in YAML-source order", () => {
    const yaml = enableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", [
      "gymbro",
      "coderev",
    ]);
    expect(getEnabledAgentsForGoogleAccount(yaml, "alice@example.com")).toEqual([
      "klanker",
      "gymbro",
      "coderev",
    ]);
  });
});

describe("listGoogleAccounts", () => {
  it("returns [] when google_accounts block is absent", () => {
    expect(listGoogleAccounts(baseYaml)).toEqual([]);
  });

  it("returns one entry when one account is configured", () => {
    expect(listGoogleAccounts(yamlWithOneAccount)).toEqual([
      { account: "alice@example.com", enabled_for: ["klanker"] },
    ]);
  });

  it("returns entries in YAML-source order", () => {
    let yaml = enableAgentsOnGoogleAccount(yamlWithOneAccount, "work@bigcorp.com", ["coderev"]);
    yaml = enableAgentsOnGoogleAccount(yaml, "personal@gmail.com", ["gymbro"]);
    const list = listGoogleAccounts(yaml);
    expect(list.map((e) => e.account)).toEqual([
      "alice@example.com",
      "work@bigcorp.com",
      "personal@gmail.com",
    ]);
  });

  it("includes dormant accounts (empty enabled_for)", () => {
    const yaml = disableAgentsOnGoogleAccount(yamlWithOneAccount, "alice@example.com", [
      "klanker",
    ]);
    expect(listGoogleAccounts(yaml)).toEqual([
      { account: "alice@example.com", enabled_for: [] },
    ]);
  });
});

describe("removeGoogleAccountEntry", () => {
  it("drops the entry entirely", () => {
    const out = removeGoogleAccountEntry(yamlWithOneAccount, "alice@example.com");
    expect(getEnabledAgentsForGoogleAccount(out, "alice@example.com")).toBe(null);
  });

  it("prunes the empty parent map when removing the last account", () => {
    const out = removeGoogleAccountEntry(yamlWithOneAccount, "alice@example.com");
    expect(out).not.toContain("google_accounts");
  });

  it("leaves the parent map intact when other accounts remain", () => {
    const yaml = enableAgentsOnGoogleAccount(yamlWithOneAccount, "work@bigcorp.com", ["coderev"]);
    const out = removeGoogleAccountEntry(yaml, "alice@example.com");
    expect(listGoogleAccounts(out)).toEqual([
      { account: "work@bigcorp.com", enabled_for: ["coderev"] },
    ]);
  });

  it("no-op when account is not present (returns input verbatim)", () => {
    expect(removeGoogleAccountEntry(baseYaml, "alice@example.com")).toBe(baseYaml);
  });
});
