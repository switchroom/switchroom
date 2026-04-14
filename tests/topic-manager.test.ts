import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTopicState, saveTopicState, type TopicState } from "../src/telegram/state.js";
import {
  syncTopics,
  listTopics,
  resolveTopicId,
  resolveBotToken,
  TopicSyncError,
} from "../src/telegram/topic-manager.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

function makeConfig(agents: Record<string, { topic_name: string; topic_emoji?: string; topic_id?: number }>): SwitchroomConfig {
  const agentsMap: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(agents)) {
    agentsMap[name] = {
      extends: "default",
      topic_name: cfg.topic_name,
      topic_emoji: cfg.topic_emoji,
      topic_id: cfg.topic_id,
      schedule: [],
    };
  }

  return {
    switchroom: { version: 1 as const, agents_dir: "~/.switchroom/agents" },
    telegram: {
      bot_token: "123:FAKE_TOKEN",
      forum_chat_id: "-1001234567890",
    },
    agents: agentsMap,
  } as SwitchroomConfig;
}

describe("TopicState", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    statePath = join(tmpDir, "topics.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty state when file does not exist", () => {
    const state = loadTopicState(statePath);
    expect(state).toEqual({ topics: {} });
  });

  it("round-trips state through save/load", () => {
    const state: TopicState = {
      topics: {
        health: {
          topic_id: 42,
          topic_name: "Health",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        finance: {
          topic_id: 99,
          topic_name: "Finance",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      },
    };

    saveTopicState(state, statePath);
    const loaded = loadTopicState(statePath);

    expect(loaded).toEqual(state);
  });

  it("creates parent directories when saving", () => {
    const deepPath = join(tmpDir, "a", "b", "c", "topics.json");
    const state: TopicState = {
      topics: {
        test: { topic_id: 1, topic_name: "Test", created_at: "2026-01-01T00:00:00.000Z" },
      },
    };

    saveTopicState(state, deepPath);
    const loaded = loadTopicState(deepPath);
    expect(loaded.topics.test.topic_id).toBe(1);
  });

  it("returns empty state for corrupted JSON", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(statePath, "NOT VALID JSON", "utf-8");

    const state = loadTopicState(statePath);
    expect(state).toEqual({ topics: {} });
  });
});

describe("resolveBotToken", () => {
  const originalEnv = process.env.TELEGRAM_BOT_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = originalEnv;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("returns literal token from config", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(resolveBotToken("123:ABC")).toBe("123:ABC");
  });

  it("returns env var when config is a vault reference", () => {
    process.env.TELEGRAM_BOT_TOKEN = "ENV_TOKEN";
    expect(resolveBotToken("vault:my-secret")).toBe("ENV_TOKEN");
  });

  it("returns null when vault reference and no env var", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(resolveBotToken("vault:my-secret")).toBeNull();
  });

  it("prefers env var over literal config token", () => {
    process.env.TELEGRAM_BOT_TOKEN = "ENV_TOKEN";
    expect(resolveBotToken("123:ABC")).toBe("ENV_TOKEN");
  });
});

describe("listTopics", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    statePath = join(tmpDir, "topics.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists agents with their topic mappings", () => {
    const config = makeConfig({
      health: { topic_name: "Health" },
      finance: { topic_name: "Finance" },
    });

    saveTopicState(
      {
        topics: {
          health: { topic_id: 42, topic_name: "Health", created_at: "2026-01-01T00:00:00.000Z" },
        },
      },
      statePath
    );

    const results = listTopics(config, statePath);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ agent: "health", topic_name: "Health", topic_id: 42 });
    expect(results[1]).toEqual({ agent: "finance", topic_name: "Finance", topic_id: null });
  });

  it("uses topic_id from config if not in state", () => {
    const config = makeConfig({
      health: { topic_name: "Health", topic_id: 99 },
    });

    const results = listTopics(config, statePath);
    expect(results[0].topic_id).toBe(99);
  });
});

describe("resolveTopicId", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    statePath = join(tmpDir, "topics.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns topic_id when found", () => {
    saveTopicState(
      {
        topics: {
          health: { topic_id: 42, topic_name: "Health", created_at: "2026-01-01T00:00:00.000Z" },
        },
      },
      statePath
    );

    expect(resolveTopicId("health", statePath)).toBe(42);
  });

  it("returns null when agent not found", () => {
    expect(resolveTopicId("nonexistent", statePath)).toBeNull();
  });
});

describe("syncTopics", () => {
  let tmpDir: string;
  let statePath: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    statePath = join(tmpDir, "topics.json");
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = originalEnv;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("creates topics via Bot API for new agents", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      callCount++;
      const body = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_thread_id: 100 + callCount,
            name: body.name,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const config = makeConfig({
      health: { topic_name: "Health" },
      finance: { topic_name: "Finance" },
    });

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      agent: "health",
      topic_name: "Health",
      topic_id: 101,
      status: "created",
    });
    expect(results[1]).toMatchObject({
      agent: "finance",
      topic_name: "Finance",
      topic_id: 102,
      status: "created",
    });

    // Verify state was saved
    const state = loadTopicState(statePath);
    expect(state.topics.health.topic_id).toBe(101);
    expect(state.topics.finance.topic_id).toBe(102);
  });

  it("skips agents that already exist in state (idempotency)", async () => {
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_thread_id: 200, name: body.name },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    // Pre-seed state with health agent
    saveTopicState(
      {
        topics: {
          health: { topic_id: 42, topic_name: "Health", created_at: "2026-01-01T00:00:00.000Z" },
        },
      },
      statePath
    );

    const config = makeConfig({
      health: { topic_name: "Health" },
      finance: { topic_name: "Finance" },
    });

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      agent: "health",
      topic_id: 42,
      status: "existing",
    });
    expect(results[1]).toMatchObject({
      agent: "finance",
      topic_id: 200,
      status: "created",
    });

    // fetch should only be called once (for finance)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("records agents with hardcoded topic_id as existing", async () => {
    globalThis.fetch = vi.fn() as any;

    const config = makeConfig({
      health: { topic_name: "Health", topic_id: 55 },
    });

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      agent: "health",
      topic_id: 55,
      status: "existing",
    });

    // No API call needed
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throws TopicSyncError when bot is not admin", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights to manage topic",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const config = makeConfig({
      health: { topic_name: "Health" },
    });

    await expect(syncTopics(config, statePath)).rejects.toThrow(TopicSyncError);
    await expect(syncTopics(config, statePath)).rejects.toThrow(/not an admin/);
  });

  it("throws TopicSyncError when chat is not a forum", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: the group chat is not a forum",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const config = makeConfig({
      health: { topic_name: "Health" },
    });

    await expect(syncTopics(config, statePath)).rejects.toThrow(TopicSyncError);
    await expect(syncTopics(config, statePath)).rejects.toThrow(/not a forum/);
  });

  it("throws TopicSyncError on rate limit", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const config = makeConfig({
      health: { topic_name: "Health" },
    });

    await expect(syncTopics(config, statePath)).rejects.toThrow(TopicSyncError);
    await expect(syncTopics(config, statePath)).rejects.toThrow(/Rate limited/);
  });

  it("throws when bot token cannot be resolved", async () => {
    const config = makeConfig({ health: { topic_name: "Health" } });
    config.telegram.bot_token = "vault:my-secret";
    delete process.env.TELEGRAM_BOT_TOKEN;

    await expect(syncTopics(config, statePath)).rejects.toThrow(TopicSyncError);
    await expect(syncTopics(config, statePath)).rejects.toThrow(/Cannot resolve bot token/);
  });

  it("passes icon_custom_emoji_id when topic_emoji is set", async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_thread_id: 300, name: capturedBody.name },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const config = makeConfig({
      health: { topic_name: "Health", topic_emoji: "5368324170671202286" },
    });

    await syncTopics(config, statePath);

    expect(capturedBody.icon_custom_emoji_id).toBe("5368324170671202286");
  });
});
