/**
 * Tests for `mergeAgentConfig` — focused on the `release` block cascade.
 *
 * The release block uses REPLACE semantics (no field-merge between
 * defaults and agent) so a pinned agent does not silently inherit a
 * channel from the fleet defaults, and vice versa.
 */

import { describe, expect, it } from "vitest";
import { mergeAgentConfig } from "./merge.js";
import type { AgentConfig, AgentDefaults } from "./schema.js";

function baseAgent(extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    topic_name: "Test",
    ...extra,
  } as AgentConfig;
}

describe("mergeAgentConfig — release cascade", () => {
  it("inherits root release.channel when agent has none", () => {
    const defaults = { release: { channel: "latest" } } as AgentDefaults;
    const agent = baseAgent();
    const result = mergeAgentConfig(defaults, agent);
    expect(result.release).toEqual({ channel: "latest" });
  });

  it("REPLACES root entirely when agent provides a pin (no field merge)", () => {
    const defaults = { release: { channel: "latest" } } as AgentDefaults;
    const agent = baseAgent({
      release: { pin: "sha-abc1234" },
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.release).toEqual({ pin: "sha-abc1234" });
    expect(result.release?.channel).toBeUndefined();
  });

  it("uses agent release when defaults absent", () => {
    const agent = baseAgent({
      release: { channel: "dev" },
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(undefined, agent);
    expect(result.release).toEqual({ channel: "dev" });
  });

  it("leaves release undefined when neither layer sets it", () => {
    const result = mergeAgentConfig({} as AgentDefaults, baseAgent());
    expect(result.release).toBeUndefined();
  });
});

describe("mergeAgentConfig — memory.file cascade (fleet-default hindsight-native)", () => {
  it("an agent inherits defaults.memory.file:false when it sets no memory.file", () => {
    const defaults = { memory: { file: false } } as AgentDefaults;
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.memory?.file).toBe(false);
  });

  it("a per-agent memory.file:true opts back in over the fleet default", () => {
    const defaults = { memory: { file: false } } as AgentDefaults;
    const agent = baseAgent({ memory: { collection: "x", file: true } } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.memory?.file).toBe(true);
  });
});

describe("mergeAgentConfig — allowed_tools / disallowed_tools cascade", () => {
  it("cascades defaults.allowed_tools when the agent sets none (the silent-no-op bug)", () => {
    const defaults = {
      allowed_tools: ["mcp__perplexity", "mcp__perplexity__*"],
    } as AgentDefaults;
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.allowed_tools).toEqual([
      "mcp__perplexity",
      "mcp__perplexity__*",
    ]);
  });

  it("unions defaults + agent allowed_tools (defaults first, agent extends)", () => {
    const defaults = {
      allowed_tools: ["mcp__perplexity__*"],
    } as AgentDefaults;
    const agent = baseAgent({
      allowed_tools: ["Bash(git *)"],
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.allowed_tools).toEqual([
      "mcp__perplexity__*",
      "Bash(git *)",
    ]);
  });

  it("dedups overlapping entries preserving first-seen (defaults) order", () => {
    const defaults = {
      allowed_tools: ["mcp__perplexity__*", "Edit"],
    } as AgentDefaults;
    const agent = baseAgent({
      allowed_tools: ["Edit", "Bash(npm *)"],
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.allowed_tools).toEqual([
      "mcp__perplexity__*",
      "Edit",
      "Bash(npm *)",
    ]);
  });

  it("uses agent allowed_tools when defaults absent", () => {
    const agent = baseAgent({
      allowed_tools: ["mcp__webkite__*"],
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(undefined, agent);
    expect(result.allowed_tools).toEqual(["mcp__webkite__*"]);
  });

  it("leaves allowed_tools undefined when neither layer sets it", () => {
    const result = mergeAgentConfig({} as AgentDefaults, baseAgent());
    expect(result.allowed_tools).toBeUndefined();
  });

  it("cascades disallowed_tools the same way", () => {
    const defaults = {
      disallowed_tools: ["WebFetch"],
    } as AgentDefaults;
    const agent = baseAgent({
      disallowed_tools: ["Bash(rm *)"],
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.disallowed_tools).toEqual(["WebFetch", "Bash(rm *)"]);
  });
});

describe("mergeAgentConfig — secrets (operator standing grant) cascade", () => {
  it("unions defaults + agent secrets (defaults first, dedup)", () => {
    const defaults = { secrets: ["shared/key"] } as AgentDefaults;
    const agent = baseAgent({
      secrets: ["microsoft/token", "shared/key"],
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    expect(result.secrets).toEqual(["shared/key", "microsoft/token"]);
  });

  it("uses agent secrets when defaults absent", () => {
    const agent = baseAgent({ secrets: ["compass/creds"] } as Partial<AgentConfig>);
    const result = mergeAgentConfig({} as AgentDefaults, agent);
    expect(result.secrets).toEqual(["compass/creds"]);
  });

  it("leaves secrets undefined when neither layer sets it", () => {
    const result = mergeAgentConfig({} as AgentDefaults, baseAgent({}));
    expect(result.secrets).toBeUndefined();
  });
});

describe("mergeAgentConfig — litellm one-level deep merge", () => {
  it("deep-merges scalar fields, agent overriding wins per field", () => {
    const defaults = {
      litellm: {
        enabled: false,
        base_url: "http://127.0.0.1:4010",
        small_fast_model: "claude-haiku-4-5-20251001",
      },
    } as AgentDefaults;
    const agent = baseAgent({
      litellm: { enabled: true },
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    // enabled overridden by agent; base_url + small_fast_model inherited.
    expect(result.litellm).toEqual({
      enabled: true,
      base_url: "http://127.0.0.1:4010",
      small_fast_model: "claude-haiku-4-5-20251001",
    });
  });

  it("merges tags per-key (agent adds without dropping defaults)", () => {
    const defaults = {
      litellm: { enabled: true, tags: { env: "fleet", region: "au" } },
    } as AgentDefaults;
    const agent = baseAgent({
      litellm: { tags: { region: "us", team: "core" } },
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig(defaults, agent);
    // region overridden by agent; env kept from defaults; team added.
    expect(result.litellm?.tags).toEqual({
      env: "fleet",
      region: "us",
      team: "core",
    });
    expect(result.litellm?.enabled).toBe(true);
  });

  it("uses agent litellm when defaults absent", () => {
    const agent = baseAgent({
      litellm: { enabled: true, base_url: "http://h:1" },
    } as Partial<AgentConfig>);
    const result = mergeAgentConfig({} as AgentDefaults, agent);
    expect(result.litellm).toEqual({ enabled: true, base_url: "http://h:1" });
  });

  it("inherits defaults litellm when agent has none", () => {
    const defaults = {
      litellm: { enabled: true, base_url: "http://h:2" },
    } as AgentDefaults;
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.litellm).toEqual({ enabled: true, base_url: "http://h:2" });
  });

  it("leaves litellm undefined when neither layer sets it", () => {
    const result = mergeAgentConfig({} as AgentDefaults, baseAgent({}));
    expect(result.litellm).toBeUndefined();
  });
});
