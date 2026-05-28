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
