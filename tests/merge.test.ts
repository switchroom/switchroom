import { describe, it, expect } from "vitest";
import { mergeAgentConfig } from "../src/config/merge.js";
import type { AgentConfig, AgentDefaults } from "../src/config/schema.js";

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  // Intentionally omit `template` — AgentSchema.template is now optional
  // (no zod default) so the cascade can fill it in. Tests that want to
  // pin a template set it via overrides explicitly.
  return {
    topic_name: "T",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("mergeAgentConfig", () => {
  it("returns the agent unchanged when defaults are undefined", () => {
    const agent = baseAgent({ model: "opus" });
    const result = mergeAgentConfig(undefined, agent);
    expect(result).toEqual(agent);
  });

  it("does not mutate either input", () => {
    const defaults: AgentDefaults = { model: "sonnet", tools: { allow: ["Read"] } };
    const agent = baseAgent({ tools: { allow: ["Bash"], deny: [] } });
    const defaultsSnap = JSON.parse(JSON.stringify(defaults));
    const agentSnap = JSON.parse(JSON.stringify(agent));
    mergeAgentConfig(defaults, agent);
    expect(defaults).toEqual(defaultsSnap);
    expect(agent).toEqual(agentSnap);
  });

  it("fills in scalars when the agent has none", () => {
    const defaults: AgentDefaults = {
      model: "sonnet",
      dangerous_mode: false,
      use_clerk_plugin: true,
    };
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.model).toBe("sonnet");
    expect(result.dangerous_mode).toBe(false);
    expect(result.use_clerk_plugin).toBe(true);
  });

  it("preserves agent scalars over defaults (agent wins)", () => {
    const defaults: AgentDefaults = { model: "sonnet", use_clerk_plugin: true };
    const agent = baseAgent({ model: "opus", use_clerk_plugin: false });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.model).toBe("opus");
    expect(result.use_clerk_plugin).toBe(false);
  });

  it("fills in template from defaults when agent leaves it unset", () => {
    const defaults: AgentDefaults = { template: "coding" };
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.template).toBe("coding");
  });

  it("respects an explicit agent template 'default' even with a non-default global", () => {
    // Regression: AgentSchema.template used to have a zod default of
    // "default" which made this case ambiguous (we couldn't tell if the
    // user wrote `template: default` or left it unset). Phase-1 cleanup
    // dropped the zod default; consumers fall back to DEFAULT_TEMPLATE
    // if the merge still leaves it undefined.
    const defaults: AgentDefaults = { template: "coding" };
    const result = mergeAgentConfig(defaults, baseAgent({ template: "default" }));
    expect(result.template).toBe("default");
  });

  it("preserves non-default agent template against a defaults.template", () => {
    const defaults: AgentDefaults = { template: "coding" };
    const result = mergeAgentConfig(defaults, baseAgent({ template: "health-coach" }));
    expect(result.template).toBe("health-coach");
  });

  it("unions tools.allow preserving order (defaults first, dedup)", () => {
    const defaults: AgentDefaults = { tools: { allow: ["Read", "Grep", "Edit"] } };
    const agent = baseAgent({ tools: { allow: ["Edit", "Bash"], deny: [] } });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.tools?.allow).toEqual(["Read", "Grep", "Edit", "Bash"]);
  });

  it("unions tools.deny", () => {
    const defaults: AgentDefaults = { tools: { deny: ["WebFetch"] } };
    const agent = baseAgent({ tools: { allow: [], deny: ["Bash"] } });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.tools?.deny).toEqual(["WebFetch", "Bash"]);
  });

  it("leaves tools undefined when neither side sets them", () => {
    const result = mergeAgentConfig({ model: "opus" }, baseAgent());
    expect(result.tools).toBeUndefined();
  });

  it("per-key merges mcp_servers with agent winning on conflict", () => {
    const defaults: AgentDefaults = {
      mcp_servers: {
        linear: { type: "http", url: "https://linear.app/mcp" },
        github: { type: "http", url: "https://globals.example" },
      },
    };
    const agent = baseAgent({
      mcp_servers: {
        github: { type: "http", url: "https://agent.example" },
        notion: { type: "http", url: "https://notion.so/mcp" },
      },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(Object.keys(result.mcp_servers ?? {}).sort()).toEqual([
      "github",
      "linear",
      "notion",
    ]);
    // Agent's github entry wins over defaults
    expect((result.mcp_servers?.github as { url: string }).url).toBe("https://agent.example");
    // Defaults' linear entry flows through
    expect((result.mcp_servers?.linear as { url: string }).url).toBe(
      "https://linear.app/mcp",
    );
  });

  it("shallow-merges soul field-by-field", () => {
    const defaults: AgentDefaults = {
      soul: { style: "warm, concise", boundaries: "no medical advice" },
    };
    const agent = baseAgent({
      soul: { name: "Coach", style: "direct" },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.soul).toEqual({
      name: "Coach",
      style: "direct", // agent wins
      boundaries: "no medical advice", // default fills
    });
  });

  it("shallow-merges memory field-by-field", () => {
    const defaults: AgentDefaults = {
      memory: { auto_recall: true, isolation: "default" },
    };
    const agent = baseAgent({
      memory: { collection: "coach", isolation: "strict" },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.memory).toEqual({
      collection: "coach",
      auto_recall: true,
      isolation: "strict", // agent wins
    });
  });

  it("prepends defaults.schedule to agent.schedule", () => {
    const defaults: AgentDefaults = {
      schedule: [{ cron: "0 8 * * *", prompt: "Morning check-in" }],
    };
    const agent = baseAgent({
      schedule: [{ cron: "0 17 * * *", prompt: "Evening review" }],
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.schedule).toEqual([
      { cron: "0 8 * * *", prompt: "Morning check-in" },
      { cron: "0 17 * * *", prompt: "Evening review" },
    ]);
  });

  it("leaves agent.schedule untouched when defaults has no schedule", () => {
    const agent = baseAgent({
      schedule: [{ cron: "0 9 * * *", prompt: "Standup" }],
    });
    const result = mergeAgentConfig({ model: "opus" }, agent);
    expect(result.schedule).toEqual([{ cron: "0 9 * * *", prompt: "Standup" }]);
  });
});
