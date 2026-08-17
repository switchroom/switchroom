import { describe, it, expect, vi } from "vitest";
import {
  generateHindsightMcpConfig,
  generateDockerComposeSnippet,
  getCollectionForAgent,
  isStrictIsolation,
  HINDSIGHT_SHIM_CLI_PATH,
  HINDSIGHT_SHIM_AGENT_HOME,
} from "../src/memory/hindsight.js";
import {
  DOCKER_SWITCHROOM_CLI_PATH,
  DOCKER_AGENT_HOME,
} from "../src/agents/scaffold.js";
import { getHindsightSettingsEntry } from "../src/memory/scaffold-integration.js";
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
  it("defaults to the lazy-connect stdio shim entry (startup-resilient)", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig);

    expect(result.type).toBe("stdio");
    expect(result.command).toBe(HINDSIGHT_SHIM_CLI_PATH);
    expect(result.args).toEqual(["hindsight-mcp-shim"]);
    // Sanitized MCP-spawn env: every shim input threaded explicitly.
    expect(result.env).toEqual({
      HINDSIGHT_MCP_URL: "http://127.0.0.1:18888/mcp/",
      HINDSIGHT_BANK_ID: "my-collection",
      HINDSIGHT_SHIM_CACHE_DIR: "/state/agent/home/.hindsight-shim",
      HOME: "/state/agent/home",
    });
    expect(result.url).toBeUndefined();
  });

  it("threads memory.config.url override into the shim env", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: false, url: "http://localhost:19000/mcp/" },
    });
    const result = generateHindsightMcpConfig("local-col", memConfig);

    expect(result.env?.HINDSIGHT_MCP_URL).toBe("http://localhost:19000/mcp/");
  });

  it("mcp_transport: 'http' escape hatch restores the direct HTTP entry", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: true, mcp_transport: "http" },
    });
    const result = generateHindsightMcpConfig("my-collection", memConfig);

    expect(result.type).toBe("http");
    expect(result.url).toBe("http://127.0.0.1:18888/mcp/");
    expect(result.headers).toEqual({ "X-Bank-Id": "my-collection" });
    expect(result.command).toBeUndefined();
    expect(result.args).toBeUndefined();
  });

  it("shim CLI path / HOME stay in lockstep with the scaffold docker constants", () => {
    // HINDSIGHT_SHIM_CLI_PATH is a deliberate local copy (import cycle) —
    // this pin is the drift guard the comment in hindsight.ts promises.
    expect(HINDSIGHT_SHIM_CLI_PATH).toBe(DOCKER_SWITCHROOM_CLI_PATH);
    expect(HINDSIGHT_SHIM_AGENT_HOME).toBe(DOCKER_AGENT_HOME);
  });

  it("threads reflect budget/max_tokens opts into the shim env (max_tokens as STRING)", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig, {
      reflectBudget: "high",
      reflectMaxTokens: 2048,
    });
    expect(result.env?.HINDSIGHT_SHIM_REFLECT_BUDGET).toBe("high");
    expect(result.env?.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS).toBe("2048");
  });

  it("omits the reflect env vars when the opts are unconfigured (minimal 4-key env)", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig, {});
    // The fleet default lives in the shim constant; an unconfigured agent
    // emits exactly the 4-key env, so the image-baked default reaches it with
    // no reconcile. This mirrors the toEqual contract above.
    expect(result.env).toEqual({
      HINDSIGHT_MCP_URL: "http://127.0.0.1:18888/mcp/",
      HINDSIGHT_BANK_ID: "my-collection",
      HINDSIGHT_SHIM_CACHE_DIR: "/state/agent/home/.hindsight-shim",
      HOME: "/state/agent/home",
    });
  });

  it("under mcp_transport: http, opts produce no env and leave headers unchanged", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: true, mcp_transport: "http" },
    });
    const result = generateHindsightMcpConfig("my-collection", memConfig, {
      reflectBudget: "high",
      reflectMaxTokens: 2048,
    });
    expect(result.type).toBe("http");
    expect(result.env).toBeUndefined();
    expect(result.headers).toEqual({ "X-Bank-Id": "my-collection" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("threads knowledgeExtraBanks into HINDSIGHT_KNOWLEDGE_EXTRA_BANKS (comma-joined)", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig, {
      knowledgeExtraBanks: ["switchroom-dev", "shared-repo-bank"],
    });
    expect(result.env?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBe(
      "switchroom-dev,shared-repo-bank",
    );
  });

  it("drops the agent's own bank and dupes from the grant set, emitting no key when nothing is left", () => {
    const memConfig = makeMemoryConfig();
    // Own bank + a dupe: after filtering, the grant set is empty, so the env
    // key is omitted entirely rather than emitted as "" (which would read as a
    // grant of the empty bank).
    const onlyOwn = generateHindsightMcpConfig("my-collection", memConfig, {
      knowledgeExtraBanks: ["my-collection", "my-collection"],
    });
    expect(onlyOwn.env?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBeUndefined();

    // Own bank mixed with a real grant: only the grant survives.
    const mixed = generateHindsightMcpConfig("my-collection", memConfig, {
      knowledgeExtraBanks: ["my-collection", "switchroom-dev", "switchroom-dev"],
    });
    expect(mixed.env?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBe("switchroom-dev");
  });

  it("omits the knowledge-banks env when the grant set is unset (minimal env)", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig, {});
    expect(result.env?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBeUndefined();
  });
});

describe("getHindsightSettingsEntry reflect cascade", () => {
  function configWith(opts: {
    defaults?: Record<string, unknown>;
    agents?: Record<string, any>;
  }): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
      telegram: { bot_token: "test-token", forum_chat_id: "-100123" },
      memory: makeMemoryConfig(),
      defaults: opts.defaults,
      agents: opts.agents ?? {},
    } as unknown as SwitchroomConfig;
  }

  function envOf(config: SwitchroomConfig, agent: string) {
    const entry = getHindsightSettingsEntry(agent, config);
    if (!entry) throw new Error("expected a hindsight entry");
    return (entry.value as { env?: Record<string, string> }).env;
  }

  it("cascades defaults.memory.reflect_budget to an agent with no override", () => {
    const config = configWith({
      defaults: { memory: { reflect_budget: "high" } },
      agents: { foo: {} },
    });
    // FAILS on origin/main: reflect_budget is stripped at parse and never
    // threaded into the shim env.
    expect(envOf(config, "foo")?.HINDSIGHT_SHIM_REFLECT_BUDGET).toBe("high");
  });

  it("lets a per-agent reflect_budget beat the fleet default", () => {
    const config = configWith({
      defaults: { memory: { reflect_budget: "high" } },
      agents: { foo: { memory: { reflect_budget: "low" } } },
    });
    expect(envOf(config, "foo")?.HINDSIGHT_SHIM_REFLECT_BUDGET).toBe("low");
  });

  it("omits the reflect env when nothing is configured", () => {
    const config = configWith({ agents: { foo: {} } });
    const env = envOf(config, "foo");
    expect(env?.HINDSIGHT_SHIM_REFLECT_BUDGET).toBeUndefined();
    expect(env?.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS).toBeUndefined();
  });

  it("cascades reflect_max_tokens (default, override, and absent)", () => {
    const inherited = configWith({
      defaults: { memory: { reflect_max_tokens: 2048 } },
      agents: { foo: {} },
    });
    expect(envOf(inherited, "foo")?.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS).toBe("2048");

    const overridden = configWith({
      defaults: { memory: { reflect_max_tokens: 2048 } },
      agents: { foo: { memory: { reflect_max_tokens: 512 } } },
    });
    expect(envOf(overridden, "foo")?.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS).toBe("512");

    const absent = configWith({ agents: { foo: {} } });
    expect(envOf(absent, "foo")?.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS).toBeUndefined();
  });

  it("threads memory.recall.additional_banks into the knowledge-page grant env", () => {
    // The SAME config that fans the recall hook out to a shared bank grants the
    // knowledge-page reads' bank_id selector for that bank (W-2, design-v2 §10).
    const config = configWith({
      agents: {
        foo: { memory: { recall: { additional_banks: ["switchroom-dev"] } } },
      },
    });
    expect(envOf(config, "foo")?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBe(
      "switchroom-dev",
    );
  });

  it("emits no knowledge-page grant env for an agent with no additional_banks", () => {
    const config = configWith({ agents: { foo: {} } });
    expect(envOf(config, "foo")?.HINDSIGHT_KNOWLEDGE_EXTRA_BANKS).toBeUndefined();
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

    expect(result.url).toBe("http://127.0.0.1:18888/mcp/");
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
    // ANTHROPIC_MODEL is what actually pins the claude-code provider's model.
    expect(snippet).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
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
