/**
 * Tests for the code_repos schema extension in switchroom.yaml.
 */

import { describe, it, expect } from "vitest";
import { SwitchroomConfigSchema, CodeRepoEntrySchema } from "../src/config/schema.js";

describe("CodeRepoEntrySchema", () => {
  it("accepts a minimal entry with name and source", () => {
    const entry = CodeRepoEntrySchema.parse({
      name: "switchroom",
      source: "~/code/switchroom",
    });
    expect(entry.name).toBe("switchroom");
    expect(entry.source).toBe("~/code/switchroom");
    expect(entry.concurrency).toBeUndefined();
  });

  it("accepts entry with explicit concurrency", () => {
    const entry = CodeRepoEntrySchema.parse({
      name: "myrepo",
      source: "/home/user/repos/myrepo",
      concurrency: 3,
    });
    expect(entry.concurrency).toBe(3);
  });

  it("rejects concurrency of 0", () => {
    expect(() =>
      CodeRepoEntrySchema.parse({ name: "r", source: "/r", concurrency: 0 }),
    ).toThrow();
  });

  it("rejects negative concurrency", () => {
    expect(() =>
      CodeRepoEntrySchema.parse({ name: "r", source: "/r", concurrency: -1 }),
    ).toThrow();
  });
});

describe("SwitchroomConfigSchema — code_repos", () => {
  const baseConfig = {
    switchroom: { version: 1 as const },
    telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
    agents: {
      klanker: {
        topic_name: "Klanker",
      },
    },
  };

  it("parses agent with code_repos list", () => {
    const config = SwitchroomConfigSchema.parse({
      ...baseConfig,
      agents: {
        klanker: {
          topic_name: "Klanker",
          code_repos: [
            { name: "switchroom", source: "~/code/switchroom", concurrency: 5 },
          ],
        },
      },
    });
    const repos = config.agents["klanker"].code_repos;
    expect(repos).toHaveLength(1);
    expect(repos?.[0].name).toBe("switchroom");
    expect(repos?.[0].concurrency).toBe(5);
  });

  it("parses agent without code_repos (omitted = undefined)", () => {
    const config = SwitchroomConfigSchema.parse(baseConfig);
    expect(config.agents["klanker"].code_repos).toBeUndefined();
  });

  it("accepts multiple repos for an agent", () => {
    const config = SwitchroomConfigSchema.parse({
      ...baseConfig,
      agents: {
        klanker: {
          topic_name: "Klanker",
          code_repos: [
            { name: "switchroom", source: "~/code/switchroom" },
            { name: "myapp", source: "/home/user/myapp", concurrency: 2 },
          ],
        },
      },
    });
    expect(config.agents["klanker"].code_repos).toHaveLength(2);
  });
});
