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
