import { describe, it, expect } from "vitest";
import { SwitchroomConfigSchema } from "../src/config/schema.js";

describe("SwitchroomConfigSchema", () => {
  it("parses a full valid config", () => {
    const config = {
      switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
      telegram: {
        bot_token: "vault:telegram-bot-token",
        forum_chat_id: "-1001234567890",
      },
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "ollama", model: "nomic-embed-text" },
      },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: {
        "health-coach": {
          extends: "health-coach",
          topic_name: "Health",
          topic_emoji: "🏋️",
          soul: {
            name: "Coach",
            style: "motivational, direct",
            boundaries: "not a doctor",
          },
          tools: {
            allow: ["calendar", "notion"],
            deny: ["bash", "edit"],
          },
          memory: {
            collection: "health",
            auto_recall: true,
            isolation: "default",
          },
          schedule: [
            { cron: "0 8 * * *", prompt: "Morning check-in" },
          ],
        },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(result.switchroom.version).toBe(1);
    expect(result.agents["health-coach"].topic_name).toBe("Health");
    expect(result.agents["health-coach"].tools?.allow).toEqual([
      "calendar",
      "notion",
    ]);
    expect(result.agents["health-coach"].memory?.collection).toBe("health");
    expect(result.agents["health-coach"].schedule).toHaveLength(1);
  });

  it("parses a minimal config with defaults", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: {
        bot_token: "123:ABC",
        forum_chat_id: "-100123",
      },
      agents: {
        assistant: {
          topic_name: "General",
        },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(result.switchroom.agents_dir).toBe("~/.switchroom/agents");
    // `extends` is optional (no zod default) so that the merge cascade
    // in src/config/merge.ts can distinguish "unset" from "explicitly
    // chose 'default'". Consumers fall back to DEFAULT_PROFILE when it
    // remains unset after merging defaults → profile → agent.
    expect(result.agents.assistant.extends).toBeUndefined();
    expect(result.agents.assistant.schedule).toEqual([]);
  });

  it("rejects invalid version", () => {
    const config = {
      switchroom: { version: 2 },
      telegram: { bot_token: "x", forum_chat_id: "y" },
      agents: {},
    };

    expect(() => SwitchroomConfigSchema.parse(config)).toThrow();
  });

  it("rejects missing telegram config", () => {
    const config = {
      switchroom: { version: 1 },
      agents: {
        test: { topic_name: "Test" },
      },
    };

    expect(() => SwitchroomConfigSchema.parse(config)).toThrow();
  });

  it("rejects missing topic_name on agent", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "y" },
      agents: {
        test: { extends: "default" },
      },
    };

    expect(() => SwitchroomConfigSchema.parse(config)).toThrow();
  });

  it("accepts strict memory isolation", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "y" },
      agents: {
        private: {
          topic_name: "Private",
          memory: {
            collection: "private",
            isolation: "strict",
          },
        },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(result.agents.private.memory?.isolation).toBe("strict");
  });

  it("rejects invalid memory isolation value", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "y" },
      agents: {
        test: {
          topic_name: "Test",
          memory: { collection: "test", isolation: "invalid" },
        },
      },
    };

    expect(() => SwitchroomConfigSchema.parse(config)).toThrow();
  });

  it("handles multiple agents", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "y" },
      agents: {
        health: { topic_name: "Health", extends: "health-coach" },
        exec: { topic_name: "Executive", extends: "executive-assistant" },
        general: { topic_name: "General" },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(Object.keys(result.agents)).toHaveLength(3);
  });

  it("accepts vault references in bot_token", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: {
        bot_token: "vault:my-telegram-token",
        forum_chat_id: "-100123",
      },
      agents: {
        test: { topic_name: "Test" },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(result.telegram.bot_token).toBe("vault:my-telegram-token");
  });

  it("accepts per-agent bot_token", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: {
        bot_token: "vault:default-token",
        forum_chat_id: "-100123",
      },
      agents: {
        coach: {
          topic_name: "Fitness",
          bot_token: "vault:coach-bot-token",
        },
        assistant: {
          topic_name: "General",
          // No per-agent token — falls back to global
        },
      },
    };

    const result = SwitchroomConfigSchema.parse(config);
    expect(result.agents.coach.bot_token).toBe("vault:coach-bot-token");
    expect(result.agents.assistant.bot_token).toBeUndefined();
  });
});
