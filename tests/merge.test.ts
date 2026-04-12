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

  // --- Phase 2: hooks / env / system_prompt_append ---

  it("concatenates hooks per event (defaults first, agent extends)", () => {
    const defaults: AgentDefaults = {
      hooks: {
        UserPromptSubmit: [{ command: "/opt/audit.sh", timeout: 5 }],
        Stop: [{ command: "/opt/log-stop.sh", async: true }],
      },
    };
    const agent = baseAgent({
      hooks: {
        UserPromptSubmit: [{ command: "/opt/agent-specific.sh" }],
      },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(result.hooks?.UserPromptSubmit?.[0].command).toBe("/opt/audit.sh");
    expect(result.hooks?.UserPromptSubmit?.[1].command).toBe("/opt/agent-specific.sh");
    // Defaults-only event flows through unchanged
    expect(result.hooks?.Stop).toHaveLength(1);
    expect(result.hooks?.Stop?.[0].command).toBe("/opt/log-stop.sh");
  });

  it("returns an untouched agent when neither side has hooks", () => {
    const result = mergeAgentConfig({ model: "opus" }, baseAgent());
    expect(result.hooks).toBeUndefined();
  });

  it("per-key merges env with agent winning on conflict", () => {
    const defaults: AgentDefaults = {
      env: { CLERK_AUDIT_URL: "https://audit.example", LOG_LEVEL: "info" },
    };
    const agent = baseAgent({
      env: { LOG_LEVEL: "debug", AGENT_ID: "coach" },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.env).toEqual({
      CLERK_AUDIT_URL: "https://audit.example",
      LOG_LEVEL: "debug", // agent wins
      AGENT_ID: "coach",
    });
  });

  it("concatenates system_prompt_append with defaults first", () => {
    const defaults: AgentDefaults = {
      system_prompt_append: "Always respond concisely.",
    };
    const agent = baseAgent({
      system_prompt_append: "You are a health coach.",
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.system_prompt_append).toBe(
      "Always respond concisely.\n\nYou are a health coach.",
    );
  });

  it("uses only the defined side of system_prompt_append when the other is missing", () => {
    const dOnly = mergeAgentConfig(
      { system_prompt_append: "Global only" },
      baseAgent(),
    );
    expect(dOnly.system_prompt_append).toBe("Global only");

    const aOnly = mergeAgentConfig(
      {},
      baseAgent({ system_prompt_append: "Agent only" }),
    );
    expect(aOnly.system_prompt_append).toBe("Agent only");
  });
});

describe("translateHooksToClaudeShape", () => {
  // Local import to keep the describe block self-contained; see merge.ts
  // for the source implementation.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { translateHooksToClaudeShape } = require("../src/config/merge.js");

  it("wraps flat hook entries in Claude Code's nested shape", () => {
    const out = translateHooksToClaudeShape({
      UserPromptSubmit: [{ command: "/opt/recall.sh", timeout: 12 }],
      Stop: [{ command: "/opt/retain.sh", async: true }],
    });
    expect(out).toEqual({
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "/opt/recall.sh", timeout: 12 },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: "/opt/retain.sh", async: true },
          ],
        },
      ],
    });
  });

  it("returns undefined on empty or missing input", () => {
    expect(translateHooksToClaudeShape(undefined)).toBeUndefined();
    expect(translateHooksToClaudeShape({})).toBeUndefined();
    expect(translateHooksToClaudeShape({ Stop: [] })).toBeUndefined();
  });

  it("preserves optional fields and omits unset ones", () => {
    const out = translateHooksToClaudeShape({
      PreToolUse: [
        {
          command: "/opt/audit.sh",
          env: { AUDIT_URL: "https://audit.example" },
          matcher: { tool: "Bash" },
        },
      ],
    });
    expect(out?.PreToolUse).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "/opt/audit.sh",
            env: { AUDIT_URL: "https://audit.example" },
            matcher: { tool: "Bash" },
          },
        ],
      },
    ]);
  });
});
