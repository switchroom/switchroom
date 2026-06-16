/**
 * Unit tests for the outbound topic router (supergroup-mode helper).
 *
 * Two axes:
 *   1. For each event class, does the router pick the right topic?
 *   2. Does it fall back gracefully when the agent isn't in
 *      supergroup-owned mode (no default_topic_id)?
 */

import { describe, expect, it } from "vitest";
import {
  resolveOutboundTopic,
  topicForRecipient,
  validateCronTopicAliases,
  type OutboundEvent,
  type TopicRouterConfig,
} from "./topic-router.js";

const SG_CONFIG: TopicRouterConfig = {
  default_topic_id: 1,
  topic_aliases: {
    general: 1,
    planning: 17,
    cron: 23,
    admin: 31,
    alerts: 41,
  },
};

const SG_NO_ALIASES: TopicRouterConfig = {
  default_topic_id: 1,
  topic_aliases: {},
};

const NOT_SG: TopicRouterConfig | undefined = undefined;

describe("resolveOutboundTopic — follow-the-conversation events", () => {
  it("reply: passes through originThreadId in supergroup mode", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "reply",
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("reply: passes through originThreadId outside supergroup mode (today's behavior)", () => {
    const out = resolveOutboundTopic(NOT_SG, {
      kind: "reply",
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("reply: returns undefined when origin thread is undefined (DM)", () => {
    const out = resolveOutboundTopic(NOT_SG, {
      kind: "reply",
      originThreadId: undefined,
    });
    expect(out).toBeUndefined();
  });

  it("subagent-progress: passes through parentThreadId", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "subagent-progress",
      parentThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("command-query: passes through originThreadId", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "command-query",
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });
});

describe("resolveOutboundTopic — vault & permission turn-vs-background split", () => {
  it("vault turn-initiated: follows origin thread", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "vault",
      turnInitiated: true,
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("vault turn-initiated: falls back to default_topic_id when origin is undefined", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "vault",
      turnInitiated: true,
      originThreadId: undefined,
    });
    expect(out).toBe(1);
  });

  it("vault background: lands in admin alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "vault",
      turnInitiated: false,
      originThreadId: undefined,
    });
    expect(out).toBe(31);
  });

  it("vault background: admin alias undefined → falls back to default_topic_id", () => {
    const out = resolveOutboundTopic(SG_NO_ALIASES, {
      kind: "vault",
      turnInitiated: false,
      originThreadId: undefined,
    });
    expect(out).toBe(1);
  });

  it("vault background outside supergroup mode: returns undefined (caller fallback)", () => {
    const out = resolveOutboundTopic(NOT_SG, {
      kind: "vault",
      turnInitiated: false,
      originThreadId: undefined,
    });
    expect(out).toBeUndefined();
  });

  it("permission turn-initiated: same as vault — follows origin thread", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "permission",
      turnInitiated: true,
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("permission background: lands in admin alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "permission",
      turnInitiated: false,
      originThreadId: undefined,
    });
    expect(out).toBe(31);
  });
});

describe("resolveOutboundTopic — hostd approval", () => {
  it("prefers originating turn's thread (operator-initiated)", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "hostd-approval",
      originThreadId: 17,
    });
    expect(out).toBe(17);
  });

  it("falls back to admin alias when no origin thread", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "hostd-approval",
      originThreadId: undefined,
    });
    expect(out).toBe(31);
  });

  it("falls back to default_topic_id when admin alias undefined", () => {
    const out = resolveOutboundTopic(SG_NO_ALIASES, {
      kind: "hostd-approval",
      originThreadId: undefined,
    });
    expect(out).toBe(1);
  });
});

describe("resolveOutboundTopic — cron per-entry topic", () => {
  it("resolves string alias to numeric ID", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "cron",
      entryTopic: "planning",
    });
    expect(out).toBe(17);
  });

  it("passes through a numeric topic ID", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "cron",
      entryTopic: 23,
    });
    expect(out).toBe(23);
  });

  it("falls back to default_topic_id when no entryTopic", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "cron",
      entryTopic: undefined,
    });
    expect(out).toBe(1);
  });

  it("falls back to default_topic_id when alias is unknown (defensive)", () => {
    const out = resolveOutboundTopic(SG_CONFIG, {
      kind: "cron",
      entryTopic: "nonexistent",
    });
    expect(out).toBe(1);
  });

  it("returns undefined outside supergroup mode (caller uses fleet topic_id)", () => {
    const out = resolveOutboundTopic(NOT_SG, {
      kind: "cron",
      entryTopic: undefined,
    });
    expect(out).toBeUndefined();
  });
});

describe("resolveOutboundTopic — ops-lane events (boot, compact-watchdog, command-*)", () => {
  it("boot: lands in alerts alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, { kind: "boot" });
    expect(out).toBe(41);
  });

  it("boot: falls back to default_topic_id when alerts alias undefined", () => {
    const out = resolveOutboundTopic(SG_NO_ALIASES, { kind: "boot" });
    expect(out).toBe(1);
  });

  it("boot: returns undefined outside supergroup mode", () => {
    const out = resolveOutboundTopic(NOT_SG, { kind: "boot" });
    expect(out).toBeUndefined();
  });

  it("compact-watchdog: lands in alerts alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, { kind: "compact-watchdog" });
    expect(out).toBe(41);
  });

  it("linear-auth: lands in alerts alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, { kind: "linear-auth" });
    expect(out).toBe(41);
  });

  it("linear-auth: undefined in fleet mode (no default_topic_id)", () => {
    const out = resolveOutboundTopic({}, { kind: "linear-auth" });
    expect(out).toBeUndefined();
  });

  it("command-mutation: lands in admin alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, { kind: "command-mutation" });
    expect(out).toBe(31);
  });

  it("command-heavy: lands in admin alias", () => {
    const out = resolveOutboundTopic(SG_CONFIG, { kind: "command-heavy" });
    expect(out).toBe(31);
  });

  it("command-heavy: falls back to default_topic_id when admin alias undefined", () => {
    const out = resolveOutboundTopic(SG_NO_ALIASES, { kind: "command-heavy" });
    expect(out).toBe(1);
  });
});

describe("validateCronTopicAliases", () => {
  it("returns empty on a clean schedule", () => {
    const errors = validateCronTopicAliases(SG_CONFIG, [
      { cron: "0 8 * * *", topic: "planning" },
      { cron: "30 9 * * *", topic: 23 },
      { cron: "0 12 * * *" }, // no topic — default fallback
    ]);
    expect(errors).toEqual([]);
  });

  it("flags an unknown alias", () => {
    const errors = validateCronTopicAliases(SG_CONFIG, [
      { cron: "0 8 * * *", topic: "nonexistent" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nonexistent");
    expect(errors[0]).toContain("0 8 * * *");
  });

  it("flags only the unknown aliases (mixed schedule)", () => {
    const errors = validateCronTopicAliases(SG_CONFIG, [
      { cron: "0 8 * * *", topic: "planning" },
      { cron: "30 9 * * *", topic: "typo_here" },
      { cron: "0 12 * * *", topic: 999 }, // numeric always OK
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("typo_here");
  });

  it("returns empty when no aliases configured and no string topics used", () => {
    const errors = validateCronTopicAliases(SG_NO_ALIASES, [
      { cron: "0 8 * * *", topic: 17 },
    ]);
    expect(errors).toEqual([]);
  });

  it("returns empty when config is undefined and schedule has no topics", () => {
    const errors = validateCronTopicAliases(undefined, [
      { cron: "0 8 * * *" },
    ]);
    expect(errors).toEqual([]);
  });

  it("flags every string topic when config is undefined (no aliases defined)", () => {
    const errors = validateCronTopicAliases(undefined, [
      { cron: "0 8 * * *", topic: "planning" },
    ]);
    expect(errors).toHaveLength(1);
  });
});

// The marko brevo wedge (2026-06-02): approval/permission cards fan out to the
// operator's allowFrom (DMs), but the resolved topic is only valid in the
// agent's supergroup. Attaching it to a DM → 400 "message thread not found" →
// card never arrives → auto-deny → the agent wedges on the open prompt.
describe("topicForRecipient — only the owning supergroup gets the thread id", () => {
  const SUPERGROUP = "-1001234567890";
  const DM = "12345";
  const TOPIC = 3;

  it("attaches the topic when the recipient IS the agent's supergroup", () => {
    expect(topicForRecipient({ recipientChatId: SUPERGROUP, resolvedTopic: TOPIC, supergroupChatId: SUPERGROUP })).toBe(TOPIC);
  });
  it("drops the topic for an operator DM recipient (the wedge fix)", () => {
    expect(topicForRecipient({ recipientChatId: DM, resolvedTopic: TOPIC, supergroupChatId: SUPERGROUP })).toBeUndefined();
  });
  it("drops the topic for a different supergroup than the owning one", () => {
    expect(topicForRecipient({ recipientChatId: "-1009876543210", resolvedTopic: TOPIC, supergroupChatId: SUPERGROUP })).toBeUndefined();
  });
  it("returns undefined when there is no resolved topic", () => {
    expect(topicForRecipient({ recipientChatId: SUPERGROUP, resolvedTopic: undefined, supergroupChatId: SUPERGROUP })).toBeUndefined();
  });
  it("returns undefined when the agent isn't in supergroup mode (no supergroup chat id)", () => {
    expect(topicForRecipient({ recipientChatId: DM, resolvedTopic: TOPIC, supergroupChatId: undefined })).toBeUndefined();
  });
  it("matches string and numeric chat ids equivalently", () => {
    expect(topicForRecipient({ recipientChatId: -1001234567890, resolvedTopic: TOPIC, supergroupChatId: "-1001234567890" })).toBe(TOPIC);
  });
});
