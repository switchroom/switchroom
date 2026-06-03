import { describe, it, expect } from "vitest";
import {
  isValidSupergroupChatId,
  setAgentSupergroupChatId,
} from "../src/cli/supergroup-setup-yaml.js";
import { parseDocument, parse } from "yaml";
import { SwitchroomConfigSchema } from "../src/config/schema.js";

describe("isValidSupergroupChatId", () => {
  it("accepts a negative-integer string", () => {
    expect(isValidSupergroupChatId("-1001234567890")).toBe(true);
    expect(isValidSupergroupChatId("-100")).toBe(true);
  });
  it("rejects positive, zero, non-numeric, and decorated forms", () => {
    for (const bad of ["1001234567890", "0", "-0x1", "-12.3", "", "abc", "-12 ", " -12"]) {
      expect(isValidSupergroupChatId(bad)).toBe(false);
    }
  });
});

const BASE = `switchroom:
  version: 1
telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "0"
agents:
  marko:
    topic_name: "Marko"
  clerk:
    topic_name: "Clerk"
`;

describe("setAgentSupergroupChatId", () => {
  it("writes channels.telegram.chat_id under the named agent", () => {
    const out = setAgentSupergroupChatId(BASE, "marko", "-1001234567890");
    const doc = parseDocument(out);
    expect(doc.getIn(["agents", "marko", "channels", "telegram", "chat_id"])).toBe(
      "-1001234567890",
    );
    // The other agent is untouched.
    expect(doc.getIn(["agents", "clerk", "channels"])).toBeUndefined();
    // The topic_name sibling survives.
    expect(doc.getIn(["agents", "marko", "topic_name"])).toBe("Marko");
  });

  it("is idempotent — same value returns the input verbatim", () => {
    const once = setAgentSupergroupChatId(BASE, "marko", "-100777");
    const twice = setAgentSupergroupChatId(once, "marko", "-100777");
    expect(twice).toBe(once);
  });

  it("preserves an existing channels.telegram sibling (e.g. default_topic_id)", () => {
    const withTelegram = `version: 1
telegram:
  bot_token: "vault:t"
  forum_chat_id: "0"
agents:
  marko:
    channels:
      telegram:
        default_topic_id: 7
`;
    const out = setAgentSupergroupChatId(withTelegram, "marko", "-100999");
    const doc = parseDocument(out);
    expect(doc.getIn(["agents", "marko", "channels", "telegram", "chat_id"])).toBe("-100999");
    expect(doc.getIn(["agents", "marko", "channels", "telegram", "default_topic_id"])).toBe(7);
  });

  it("coerces a bare/null `channels:` key to a fresh map", () => {
    const bareChannels = `version: 1
telegram:
  bot_token: "vault:t"
  forum_chat_id: "0"
agents:
  marko:
    channels:
`;
    const out = setAgentSupergroupChatId(bareChannels, "marko", "-100555");
    const doc = parseDocument(out);
    expect(doc.getIn(["agents", "marko", "channels", "telegram", "chat_id"])).toBe("-100555");
  });

  it("throws on a malformed chat_id (never writes a bad value)", () => {
    expect(() => setAgentSupergroupChatId(BASE, "marko", "1234")).toThrow(/negative integer/);
    expect(() => setAgentSupergroupChatId(BASE, "marko", "")).toThrow(/negative integer/);
  });

  it("throws when the agent isn't in the config", () => {
    expect(() => setAgentSupergroupChatId(BASE, "ghost", "-100123")).toThrow(/not found/);
  });

  it("produces a config the schema accepts + smart-defaults default_topic_id to General", () => {
    const out = setAgentSupergroupChatId(BASE, "marko", "-1001234567890");
    // The schema smart-defaults default_topic_id to General (1) when chat_id
    // is present — so the written config is valid with no other edits.
    const cfg = SwitchroomConfigSchema.parse(parse(out));
    expect(cfg.agents.marko.channels?.telegram?.chat_id).toBe("-1001234567890");
    expect(cfg.agents.marko.channels?.telegram?.default_topic_id).toBe(1);
  });
});
