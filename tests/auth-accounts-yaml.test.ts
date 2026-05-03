import { describe, it, expect } from "vitest";
import {
  appendAccountToAgent,
  getAccountsForAgent,
  removeAccountFromAgent,
} from "../src/cli/auth-accounts-yaml.js";

const baseYaml = `
version: 1
telegram:
  bot_token: vault:telegram/bot
agents:
  foo:
    topic_name: Foo
  bar:
    topic_name: Bar
    auth:
      accounts: [personal]
`;

describe("appendAccountToAgent", () => {
  it("creates auth.accounts when absent", () => {
    const out = appendAccountToAgent(baseYaml, "foo", "work-pro");
    expect(getAccountsForAgent(out, "foo")).toEqual(["work-pro"]);
  });

  it("appends to existing list", () => {
    const out = appendAccountToAgent(baseYaml, "bar", "work-pro");
    expect(getAccountsForAgent(out, "bar")).toEqual(["personal", "work-pro"]);
  });

  it("is idempotent", () => {
    const once = appendAccountToAgent(baseYaml, "bar", "personal");
    expect(once).toBe(baseYaml);
  });

  it("throws when agent does not exist", () => {
    expect(() => appendAccountToAgent(baseYaml, "ghost", "x")).toThrow(/not declared/);
  });

  it("preserves comments and unrelated structure", () => {
    const yamlWithComment = `
# top-level comment
version: 1
telegram:
  bot_token: vault:telegram/bot   # the bot
agents:
  foo:
    topic_name: Foo
`;
    const out = appendAccountToAgent(yamlWithComment, "foo", "work-pro");
    expect(out).toContain("# top-level comment");
    expect(out).toContain("# the bot");
    expect(getAccountsForAgent(out, "foo")).toEqual(["work-pro"]);
  });
});

describe("removeAccountFromAgent", () => {
  it("removes a label from the list", () => {
    const yaml = `
agents:
  foo:
    topic_name: Foo
    auth:
      accounts: [a, b, c]
`;
    const out = removeAccountFromAgent(yaml, "foo", "b");
    expect(getAccountsForAgent(out, "foo")).toEqual(["a", "c"]);
  });

  it("no-op when label is absent", () => {
    const yaml = `
agents:
  foo:
    topic_name: Foo
    auth:
      accounts: [a]
`;
    expect(removeAccountFromAgent(yaml, "foo", "missing")).toBe(yaml);
  });

  it("prunes empty parents when last account removed", () => {
    const yaml = `
agents:
  foo:
    topic_name: Foo
    auth:
      accounts: [only]
`;
    const out = removeAccountFromAgent(yaml, "foo", "only");
    expect(out).not.toMatch(/auth:/);
    expect(out).not.toMatch(/accounts:/);
    expect(getAccountsForAgent(out, "foo")).toEqual([]);
  });

  it("no-op when agent does not exist", () => {
    const yaml = `agents:\n  foo:\n    topic_name: Foo\n`;
    expect(removeAccountFromAgent(yaml, "ghost", "x")).toBe(yaml);
  });
});

describe("getAccountsForAgent", () => {
  it("reads a present list", () => {
    expect(getAccountsForAgent(baseYaml, "bar")).toEqual(["personal"]);
  });
  it("returns [] when auth missing", () => {
    expect(getAccountsForAgent(baseYaml, "foo")).toEqual([]);
  });
  it("returns [] when agent missing", () => {
    expect(getAccountsForAgent(baseYaml, "ghost")).toEqual([]);
  });
});
