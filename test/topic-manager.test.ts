import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadTopicState, saveTopicState, type TopicState } from "../src/telegram/state.js";
import { syncTopics, findOrphanedTopics } from "../src/telegram/topic-manager.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-test-topics");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function makeConfig(agents: Record<string, { topic_name: string; topic_id?: number }>): SwitchroomConfig {
  const agentEntries: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(agents)) {
    agentEntries[name] = {
      extends: "default",
      topic_name: cfg.topic_name,
      topic_id: cfg.topic_id,
      tools: { allow: [], deny: [] },
      schedule: [],
    };
  }

  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: { bot_token: "fake-token", forum_chat_id: "-100123" },
    agents: agentEntries,
  } as SwitchroomConfig;
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Topic state persistence ────────────────────────────────────────────────

describe("topic state", () => {
  it("returns empty state for missing file", () => {
    const state = loadTopicState(join(TEST_DIR, "nonexistent.json"));
    expect(state.topics).toEqual({});
  });

  it("round-trips state", () => {
    const statePath = join(TEST_DIR, "topics.json");
    const state: TopicState = {
      topics: {
        "agent-a": { topic_id: 42, topic_name: "Alpha", created_at: "2025-01-01T00:00:00.000Z" },
      },
    };

    saveTopicState(state, statePath);
    const loaded = loadTopicState(statePath);

    expect(loaded.topics["agent-a"].topic_id).toBe(42);
    expect(loaded.topics["agent-a"].topic_name).toBe("Alpha");
  });
});

// ─── syncTopics idempotency ─────────────────────────────────────────────────

describe("syncTopics idempotency", () => {
  it("does not recreate topics that exist in state", async () => {
    const statePath = join(TEST_DIR, "topics.json");

    // Pre-populate state with existing topics
    const existingState: TopicState = {
      topics: {
        alpha: { topic_id: 100, topic_name: "Alpha Channel", created_at: "2025-01-01T00:00:00.000Z" },
        beta: { topic_id: 200, topic_name: "Beta Channel", created_at: "2025-01-01T00:00:00.000Z" },
      },
    };
    saveTopicState(existingState, statePath);

    const config = makeConfig({
      alpha: { topic_name: "Alpha Channel" },
      beta: { topic_name: "Beta Channel" },
    });

    // Mock fetch — should NOT be called since both topics exist in state
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Set env so bot token resolves
    process.env.TELEGRAM_BOT_TOKEN = "fake-token";

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("existing");
    expect(results[0].topic_id).toBe(100);
    expect(results[1].status).toBe("existing");
    expect(results[1].topic_id).toBe(200);

    // fetch should not have been called — no new topics to create
    expect(fetchSpy).not.toHaveBeenCalled();

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("skips existing topics and only creates new ones", async () => {
    const statePath = join(TEST_DIR, "topics.json");

    // Pre-populate state with one existing topic
    const existingState: TopicState = {
      topics: {
        alpha: { topic_id: 100, topic_name: "Alpha Channel", created_at: "2025-01-01T00:00:00.000Z" },
      },
    };
    saveTopicState(existingState, statePath);

    const config = makeConfig({
      alpha: { topic_name: "Alpha Channel" },
      beta: { topic_name: "Beta Channel" },
    });

    // Mock fetch for the new topic creation
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_thread_id: 300, name: "Beta Channel" },
        }),
        { status: 200 }
      )
    );

    process.env.TELEGRAM_BOT_TOKEN = "fake-token";

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(2);

    const alphaResult = results.find((r) => r.agent === "alpha")!;
    expect(alphaResult.status).toBe("existing");
    expect(alphaResult.topic_id).toBe(100);

    const betaResult = results.find((r) => r.agent === "beta")!;
    expect(betaResult.status).toBe("created");
    expect(betaResult.topic_id).toBe(300);

    // fetch called exactly once for the new topic
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("uses hardcoded topic_id from config without calling API", async () => {
    const statePath = join(TEST_DIR, "topics.json");

    const config = makeConfig({
      alpha: { topic_name: "Alpha Channel", topic_id: 555 },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.TELEGRAM_BOT_TOKEN = "fake-token";

    const results = await syncTopics(config, statePath);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("existing");
    expect(results[0].topic_id).toBe(555);
    expect(fetchSpy).not.toHaveBeenCalled();

    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});

// ─── findOrphanedTopics ─────────────────────────────────────────────────────

describe("findOrphanedTopics", () => {
  it("finds topics in state that are not in config", () => {
    const statePath = join(TEST_DIR, "topics.json");

    const state: TopicState = {
      topics: {
        alpha: { topic_id: 100, topic_name: "Alpha", created_at: "2025-01-01T00:00:00.000Z" },
        removed: { topic_id: 200, topic_name: "Removed Agent", created_at: "2025-01-01T00:00:00.000Z" },
        beta: { topic_id: 300, topic_name: "Beta", created_at: "2025-01-01T00:00:00.000Z" },
      },
    };
    saveTopicState(state, statePath);

    // Config only has alpha and beta — "removed" is orphaned
    const config = makeConfig({
      alpha: { topic_name: "Alpha" },
      beta: { topic_name: "Beta" },
    });

    const orphans = findOrphanedTopics(config, statePath);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].agent).toBe("removed");
    expect(orphans[0].topic_id).toBe(200);
  });

  it("returns empty when all state topics are in config", () => {
    const statePath = join(TEST_DIR, "topics.json");

    const state: TopicState = {
      topics: {
        alpha: { topic_id: 100, topic_name: "Alpha", created_at: "2025-01-01T00:00:00.000Z" },
      },
    };
    saveTopicState(state, statePath);

    const config = makeConfig({
      alpha: { topic_name: "Alpha" },
    });

    const orphans = findOrphanedTopics(config, statePath);
    expect(orphans).toHaveLength(0);
  });
});
