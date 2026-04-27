/**
 * Tests for vault-broker schema additions (PR 1).
 *
 * Covers:
 *   - ScheduleEntrySchema.secrets: valid values, regex rejection, default []
 *   - VaultConfigSchema.broker: default population when omitted
 */

import { describe, expect, it } from "vitest";
import { ScheduleEntrySchema, VaultConfigSchema } from "./schema.js";

describe("ScheduleEntrySchema.secrets", () => {
  it("accepts a list of valid vault key names", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["openai_api_key", "polygon_api_key"],
    });
    expect(result.secrets).toEqual(["openai_api_key", "polygon_api_key"]);
  });

  it("accepts key names with hyphens", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["my-key", "another-key-123"],
    });
    expect(result.secrets).toEqual(["my-key", "another-key-123"]);
  });

  it("defaults to [] when secrets field is omitted", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
    });
    expect(result.secrets).toEqual([]);
  });

  it("defaults to [] when secrets is explicitly []", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: [],
    });
    expect(result.secrets).toEqual([]);
  });

  it("rejects key names containing spaces", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Send a brief.",
        secrets: ["bad space"],
      }),
    ).toThrow();
  });

  it("rejects key names containing shell-special characters", () => {
    const badNames = ["foo$bar", "foo;bar", "foo.bar", "foo@bar"];
    for (const name of badNames) {
      expect(() =>
        ScheduleEntrySchema.parse({
          cron: "0 8 * * *",
          prompt: "Send a brief.",
          secrets: [name],
        }),
        `expected "${name}" to be rejected`,
      ).toThrow();
    }
  });

  it("accepts namespaced key names with forward slashes", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["microsoft/ken-tokens", "openai/api-key"],
    });
    expect(result.secrets).toEqual(["microsoft/ken-tokens", "openai/api-key"]);
  });
});

describe("VaultConfigSchema.broker", () => {
  it("populates broker defaults when vault.broker is omitted", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("populates broker defaults when vault block is empty", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker).toEqual({
      socket: "~/.switchroom/vault-broker.sock",
      enabled: true,
    });
  });

  it("accepts an explicit broker socket override", () => {
    const result = VaultConfigSchema.parse({
      broker: { socket: "/run/my-broker.sock" },
    });
    expect(result.broker.socket).toBe("/run/my-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("accepts broker.enabled: false", () => {
    const result = VaultConfigSchema.parse({
      broker: { enabled: false },
    });
    expect(result.broker.enabled).toBe(false);
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
  });

  it("preserves existing vault.path alongside broker defaults", () => {
    const result = VaultConfigSchema.parse({
      path: "/custom/vault.enc",
    });
    expect(result.path).toBe("/custom/vault.enc");
    expect(result.broker.enabled).toBe(true);
  });
});
