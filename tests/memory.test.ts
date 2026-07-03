import { describe, it, expect, vi } from "vitest";
import {
  generateHindsightMcpConfig,
  generateDockerComposeSnippet,
  getCollectionForAgent,
  isStrictIsolation,
} from "../src/memory/hindsight.js";
import { reflectAcrossAgents } from "../src/memory/search.js";
import {
  getHindsightMcpUrl,
  generateHindsightComposeSnippet,
} from "../src/setup/hindsight.js";
import type { SwitchroomConfig, MemoryBackendConfig } from "../src/config/schema.js";

function makeMemoryConfig(
  overrides: Partial<MemoryBackendConfig> = {},
): MemoryBackendConfig {
  return {
    backend: "hindsight",
    shared_collection: "shared",
    config: {
      provider: "ollama",
      docker_service: true,
    },
    ...overrides,
  };
}

function makeSwitchroomConfig(
  agents: Record<string, any> = {},
  memory?: Partial<MemoryBackendConfig>,
): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: { bot_token: "test-token", forum_chat_id: "-100123" },
    memory: makeMemoryConfig(memory),
    agents,
  } as SwitchroomConfig;
}

describe("generateHindsightMcpConfig", () => {
  it("generates HTTP URL config for Hindsight MCP endpoint", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig);

    expect(result.url).toBe("http://localhost:8888/mcp/");
    expect(result.command).toBeUndefined();
    expect(result.args).toBeUndefined();
  });

  it("generates HTTP URL config regardless of docker_service setting", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: false },
    });
    const result = generateHindsightMcpConfig("local-col", memConfig);

    expect(result.url).toBe("http://localhost:8888/mcp/");
  });
});

describe("generateDockerComposeSnippet", () => {
  it("generates valid YAML snippet with provider and model", () => {
    const memConfig = makeMemoryConfig({
      config: {
        provider: "openai",
        model: "text-embedding-3-small",
        docker_service: true,
      },
    });
    const yaml = generateDockerComposeSnippet(memConfig);

    expect(yaml).toContain("image: ghcr.io/vectorize-io/hindsight:latest");
    expect(yaml).toContain("LLM_PROVIDER=openai");
    expect(yaml).toContain("EMBEDDING_MODEL=text-embedding-3-small");
    expect(yaml).toContain("hindsight-data:/home/hindsight/.pg0");
    expect(yaml).toContain("restart: always");
  });

  it("omits EMBEDDING_MODEL when model is not set", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: true },
    });
    const yaml = generateDockerComposeSnippet(memConfig);

    expect(yaml).toContain("LLM_PROVIDER=ollama");
    expect(yaml).not.toContain("EMBEDDING_MODEL");
  });
});

describe("getCollectionForAgent", () => {
  it("returns explicit collection name from agent config", () => {
    const config = makeSwitchroomConfig({
      coach: {
        extends: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "health-data", auto_recall: true, isolation: "default" },
      },
    });

    expect(getCollectionForAgent("coach", config)).toBe("health-data");
  });

  it("defaults to agent name when no collection is specified", () => {
    const config = makeSwitchroomConfig({
      coach: {
        extends: "default",
        topic_name: "Coach",
        schedule: [],
      },
    });

    expect(getCollectionForAgent("coach", config)).toBe("coach");
  });

  it("defaults to agent name when memory config is absent", () => {
    const config = makeSwitchroomConfig({
      writer: {
        extends: "default",
        topic_name: "Writer",
        schedule: [],
      },
    });

    expect(getCollectionForAgent("writer", config)).toBe("writer");
  });
});

describe("isStrictIsolation", () => {
  it("returns true for strict isolation", () => {
    const config = makeSwitchroomConfig({
      journal: {
        extends: "default",
        topic_name: "Journal",
        schedule: [],
        memory: { collection: "journal", auto_recall: true, isolation: "strict" },
      },
    });

    expect(isStrictIsolation("journal", config)).toBe(true);
  });

  it("returns false for default isolation", () => {
    const config = makeSwitchroomConfig({
      coach: {
        extends: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "coach", auto_recall: true, isolation: "default" },
      },
    });

    expect(isStrictIsolation("coach", config)).toBe(false);
  });

  it("returns false when memory config is absent", () => {
    const config = makeSwitchroomConfig({
      bot: {
        extends: "default",
        topic_name: "Bot",
        schedule: [],
      },
    });

    expect(isStrictIsolation("bot", config)).toBe(false);
  });
});

describe("reflectAcrossAgents", () => {
  it("excludes strict agents from reflection", () => {
    const config = makeSwitchroomConfig({
      coach: {
        extends: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "coach-data", auto_recall: true, isolation: "default" },
      },
      journal: {
        extends: "default",
        topic_name: "Journal",
        schedule: [],
        memory: { collection: "journal-private", auto_recall: true, isolation: "strict" },
      },
      planner: {
        extends: "default",
        topic_name: "Planner",
        schedule: [],
        memory: { collection: "planner", auto_recall: true, isolation: "default" },
      },
    });

    const result = reflectAcrossAgents(config);

    expect(result.eligible).toHaveLength(2);
    expect(result.eligible.map((e) => e.agent)).toEqual(["coach", "planner"]);

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].agent).toBe("journal");
    expect(result.excluded[0].collection).toBe("journal-private");

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toBe("hindsight reflect --collection 'coach-data'");
    expect(result.commands[1]).toBe("hindsight reflect --collection 'planner'");
  });

  it("returns empty eligible when all agents are strict", () => {
    const config = makeSwitchroomConfig({
      secret: {
        extends: "default",
        topic_name: "Secret",
        schedule: [],
        memory: { collection: "secret", auto_recall: true, isolation: "strict" },
      },
    });

    const result = reflectAcrossAgents(config);
    expect(result.eligible).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.commands).toHaveLength(0);
  });
});

describe("getHindsightMcpUrl", () => {
  it("returns HTTP URL for Hindsight MCP endpoint", () => {
    const result = getHindsightMcpUrl();

    expect(result.url).toBe("http://localhost:8888/mcp/");
  });
});

describe("generateHindsightComposeSnippet (broker-fed, #1245)", () => {
  it("generates a snippet that uses the switchroom-hindsight image", () => {
    const snippet = generateHindsightComposeSnippet();

    expect(snippet).toContain("switchroom-hindsight");
    expect(snippet).toContain("image: ghcr.io/switchroom/switchroom-hindsight:latest");
    expect(snippet).toContain("switchroom-hindsight-data:/home/hindsight/.pg0");
    expect(snippet).toContain("restart: always");
    // Upstream image is NOT used — switchroom-hindsight extends it with
    // claude-agent-sdk + the claude CLI for the claude-code provider.
    expect(snippet).not.toContain("ghcr.io/vectorize-io/hindsight:latest");
  });

  it("pins HINDSIGHT_API_LLM_PROVIDER=claude-code (subscription-honest)", () => {
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
    // No legacy API key / OpenAI provider variant is configurable.
    expect(snippet).not.toContain("LLM_PROVIDER=openai");
    expect(snippet).not.toContain("HINDSIGHT_API_LLM_API_KEY");
  });

  it("pins HINDSIGHT_API_LLM_MODEL to the switchroom-default sonnet", () => {
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("HINDSIGHT_API_LLM_MODEL=claude-sonnet-5");
  });

  it("sets HINDSIGHT_API_MCP_STATELESS=true (immune to hindsight bounces)", () => {
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("HINDSIGHT_API_MCP_STATELESS=true");
  });

  it("bind-mounts the auth-broker consumer socket volume + tmpfs for creds", () => {
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("auth-broker-hindsight-sock:/run/switchroom/auth-broker");
    expect(snippet).toContain("tmpfs:");
    expect(snippet).toContain("/run/claude-creds:rw,mode=0700");
    // The named volume MUST be declared external so it can be shared
    // with the main switchroom compose project (where the broker chowns
    // and binds the per-consumer socket inside it).
    expect(snippet).toMatch(/auth-broker-hindsight-sock:\s*\n\s+external:\s+true/);
  });

  it("always sets HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE (caps unbounded growth)", () => {
    // Mitigation for vectorize-io/hindsight#1284 — same intent as before.
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000");
    expect(snippet).toContain("environment:");
  });
});
