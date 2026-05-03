/**
 * Tests for `switchroom telegram` (#597).
 *
 * Covers:
 *   - YAML editor (setTelegramFeature, removeTelegramFeature) preserves
 *     other keys / comments and nests under the canonical
 *     channels.telegram.* path.
 *   - CLI integration: status output, dry-run diff, and write path.
 */

import { describe, it, expect } from "vitest";
import { setTelegramFeature, removeTelegramFeature } from "../src/cli/telegram-yaml.js";

describe("telegram-yaml: setTelegramFeature", () => {
  it("creates the channels.telegram path under an existing agent", () => {
    const before = [
      "switchroom: { agents_dir: '~/.switchroom/agents' }",
      "agents:",
      "  gymbro:",
      "    topic_name: 'Gymbro'",
      "",
    ].join("\n");
    const after = setTelegramFeature(before, "gymbro", "telegraph", {
      enabled: true,
      threshold: 2500,
    });
    expect(after).toContain("channels:");
    expect(after).toContain("telegram:");
    expect(after).toContain("telegraph:");
    expect(after).toContain("enabled: true");
    expect(after).toContain("threshold: 2500");
    // Original keys are preserved.
    expect(after).toContain("topic_name: 'Gymbro'");
    expect(after).toContain("switchroom:");
  });

  it("preserves comments outside the edited path", () => {
    const before = [
      "# Top-level header comment",
      "agents:",
      "  gymbro:",
      "    # comment inside the agent",
      "    topic_name: G",
      "",
    ].join("\n");
    const after = setTelegramFeature(before, "gymbro", "telegraph", { enabled: true });
    expect(after).toContain("# Top-level header comment");
    expect(after).toContain("# comment inside the agent");
  });

  it("overwrites an existing feature value rather than duplicating", () => {
    const before = [
      "agents:",
      "  gymbro:",
      "    topic_name: G",
      "    channels:",
      "      telegram:",
      "        telegraph:",
      "          enabled: false",
      "          threshold: 1000",
      "",
    ].join("\n");
    const after = setTelegramFeature(before, "gymbro", "telegraph", {
      enabled: true,
      threshold: 5000,
    });
    expect(after.match(/telegraph:/g)?.length).toBe(1);
    expect(after).toContain("enabled: true");
    expect(after).toContain("threshold: 5000");
    expect(after).not.toContain("threshold: 1000");
  });

  it("throws when the agent isn't declared in switchroom.yaml", () => {
    const before = "agents:\n  gymbro:\n    topic_name: G\n";
    expect(() =>
      setTelegramFeature(before, "ghost", "telegraph", { enabled: true }),
    ).toThrow(/not declared/);
  });

  it("supports voice_in feature key", () => {
    const before = "agents:\n  gymbro:\n    topic_name: G\n";
    const after = setTelegramFeature(before, "gymbro", "voice_in", {
      enabled: true,
      provider: "openai",
    });
    expect(after).toContain("voice_in:");
    expect(after).toContain("provider: openai");
  });

  it("supports webhook_sources feature key (array value)", () => {
    const before = "agents:\n  gymbro:\n    topic_name: G\n";
    const after = setTelegramFeature(before, "gymbro", "webhook_sources", ["github"]);
    expect(after).toContain("webhook_sources:");
    expect(after).toContain("- github");
  });
});

describe("telegram-yaml: removeTelegramFeature", () => {
  it("removes the feature key and prunes empty parents", () => {
    const before = [
      "agents:",
      "  gymbro:",
      "    topic_name: G",
      "    channels:",
      "      telegram:",
      "        telegraph:",
      "          enabled: true",
      "",
    ].join("\n");
    const after = removeTelegramFeature(before, "gymbro", "telegraph");
    expect(after).not.toContain("telegraph:");
    // The empty channels.telegram and channels were pruned, since they
    // held only the now-removed feature.
    expect(after).not.toContain("channels:");
    expect(after).not.toContain("telegram:");
    // Agent itself + sibling keys stay.
    expect(after).toContain("topic_name: G");
  });

  it("does NOT prune channels.telegram when other features are still set", () => {
    const before = [
      "agents:",
      "  gymbro:",
      "    topic_name: G",
      "    channels:",
      "      telegram:",
      "        telegraph:",
      "          enabled: true",
      "        voice_in:",
      "          enabled: true",
      "",
    ].join("\n");
    const after = removeTelegramFeature(before, "gymbro", "telegraph");
    expect(after).not.toContain("telegraph:");
    expect(after).toContain("voice_in:");
    expect(after).toContain("telegram:");
  });

  it("is a no-op when the path doesn't exist", () => {
    const before = "agents:\n  gymbro:\n    topic_name: G\n";
    const after = removeTelegramFeature(before, "gymbro", "telegraph");
    expect(after).toBe(before);
  });

  it("is a no-op when the agent doesn't exist (no throw)", () => {
    const before = "agents:\n  gymbro:\n    topic_name: G\n";
    const after = removeTelegramFeature(before, "ghost", "telegraph");
    expect(after).toBe(before);
  });
});

// ─── #597 phase 2: webhook source array helpers ─────────────────────────────

import { addWebhookSource, removeWebhookSource } from "../src/cli/telegram-yaml.js";

describe("telegram-yaml: addWebhookSource (#597 phase 2)", () => {
  it("creates the webhook_sources array on first source", () => {
    const before = "agents:\n  klanker:\n    topic_name: K\n";
    const after = addWebhookSource(before, "klanker", "github");
    expect(after).toContain("channels:");
    expect(after).toContain("telegram:");
    expect(after).toContain("webhook_sources:");
    expect(after).toContain("github");
  });

  it("appends a new source to an existing array (preserves prior sources)", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        webhook_sources:",
      "          - generic",
      "",
    ].join("\n");
    const after = addWebhookSource(before, "klanker", "github");
    expect(after).toContain("- generic");
    expect(after).toContain("- github");
  });

  it("is idempotent — appending an already-present source returns the YAML unchanged", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        webhook_sources:",
      "          - github",
      "",
    ].join("\n");
    const after = addWebhookSource(before, "klanker", "github");
    expect(after).toBe(before);
  });

  it("throws when the agent isn't declared in switchroom.yaml", () => {
    const before = "agents:\n  klanker:\n    topic_name: K\n";
    expect(() => addWebhookSource(before, "ghost", "github")).toThrow(/not declared/);
  });
});

describe("telegram-yaml: removeWebhookSource (#597 phase 2)", () => {
  it("removes one source while preserving siblings", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        webhook_sources:",
      "          - generic",
      "          - github",
      "",
    ].join("\n");
    const after = removeWebhookSource(before, "klanker", "github");
    expect(after).toContain("- generic");
    expect(after).not.toContain("- github");
  });

  it("prunes empty webhook_sources + parent maps when the last source is removed", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        webhook_sources:",
      "          - github",
      "",
    ].join("\n");
    const after = removeWebhookSource(before, "klanker", "github");
    expect(after).not.toContain("webhook_sources");
    expect(after).not.toContain("telegram:");
    expect(after).not.toContain("channels:");
  });

  it("preserves sibling features when pruning (only the empty webhook_sources goes)", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        telegraph:",
      "          enabled: true",
      "        webhook_sources:",
      "          - github",
      "",
    ].join("\n");
    const after = removeWebhookSource(before, "klanker", "github");
    expect(after).not.toContain("webhook_sources");
    expect(after).toContain("telegraph:");
    expect(after).toContain("enabled: true");
  });

  it("is a no-op when the source isn't present", () => {
    const before = [
      "agents:",
      "  klanker:",
      "    channels:",
      "      telegram:",
      "        webhook_sources:",
      "          - generic",
      "",
    ].join("\n");
    const after = removeWebhookSource(before, "klanker", "github");
    expect(after).toBe(before);
  });

  it("is a no-op when the agent doesn't exist (no throw)", () => {
    const before = "agents:\n  klanker:\n    topic_name: K\n";
    const after = removeWebhookSource(before, "ghost", "github");
    expect(after).toBe(before);
  });
});
