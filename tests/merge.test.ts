import { describe, it, expect } from "vitest";
import {
  mergeAgentConfig,
  resolveAgentConfig,
  usesClerkTelegramPlugin,
  deepMergeJson,
  translateHooksToClaudeShape,
} from "../src/config/merge.js";
import type { AgentConfig, AgentDefaults, Profile } from "../src/config/schema.js";

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  // Intentionally omit `extends` — AgentSchema.extends is optional (no
  // zod default) so the cascade can fill it in. Tests that want to pin
  // an extends target set it via overrides explicitly.
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
    };
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.model).toBe("sonnet");
    expect(result.dangerous_mode).toBe(false);
  });

  it("preserves agent scalars over defaults (agent wins)", () => {
    const defaults: AgentDefaults = { model: "sonnet" };
    const agent = baseAgent({ model: "opus" });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.model).toBe("opus");
  });

  it("leaves agent.extends unchanged — the cascade resolves profiles separately", () => {
    // mergeAgentConfig() is the defaults → agent primitive; profile
    // resolution happens in resolveAgentConfig(). AgentDefaults does
    // not carry `extends`, so this field is purely agent-driven here.
    const agent = baseAgent({ extends: "coding" });
    const result = mergeAgentConfig({ model: "sonnet" }, agent);
    expect(result.extends).toBe("coding");
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

describe("mergeAgentConfig skills pool", () => {
  it("unions defaults.skills with agent.skills preserving order", () => {
    const defaults: AgentDefaults = { skills: ["checkin", "retain"] };
    const agent = baseAgent({ skills: ["checkin", "weekly-review"] });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.skills).toEqual(["checkin", "retain", "weekly-review"]);
  });

  it("flows defaults.skills when agent has none", () => {
    const result = mergeAgentConfig({ skills: ["a", "b"] }, baseAgent());
    expect(result.skills).toEqual(["a", "b"]);
  });

  it("leaves skills undefined when neither side sets it", () => {
    const result = mergeAgentConfig({ model: "opus" }, baseAgent());
    expect(result.skills).toBeUndefined();
  });
});

describe("mergeAgentConfig subagents", () => {
  it("per-key merges subagents with agent winning on name conflict", () => {
    const defaults: AgentDefaults = {
      subagents: {
        worker: { description: "default worker", model: "sonnet" },
        researcher: { description: "default researcher", model: "haiku" },
      },
    };
    const agent = baseAgent({
      subagents: {
        worker: { description: "custom worker", model: "opus" },
        reviewer: { description: "custom reviewer" },
      },
    });
    const result = mergeAgentConfig(defaults, agent);
    // Worker overridden by agent
    expect(result.subagents?.worker?.model).toBe("opus");
    // Researcher from defaults
    expect(result.subagents?.researcher?.model).toBe("haiku");
    // Reviewer from agent
    expect(result.subagents?.reviewer?.description).toBe("custom reviewer");
  });

  it("flows defaults.subagents when agent has none", () => {
    const result = mergeAgentConfig(
      { subagents: { w: { description: "d" } } },
      baseAgent(),
    );
    expect(result.subagents?.w?.description).toBe("d");
  });
});

describe("mergeAgentConfig session policy", () => {
  it("shallow-merges session fields with agent winning", () => {
    const defaults: AgentDefaults = {
      session: { max_idle: "2h", max_turns: 50 },
    };
    const agent = baseAgent({
      session: { max_turns: 20 },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.session?.max_idle).toBe("2h"); // from defaults
    expect(result.session?.max_turns).toBe(20); // agent wins
  });

  it("flows defaults.session when agent has none", () => {
    const result = mergeAgentConfig(
      { session: { max_idle: "1h" } },
      baseAgent(),
    );
    expect(result.session?.max_idle).toBe("1h");
  });
});

describe("mergeAgentConfig channels block", () => {
  it("flows defaults.channels.telegram.* to agents that leave them unset", () => {
    const defaults: AgentDefaults = {
      channels: { telegram: { plugin: "clerk", format: "html" } },
    };
    const result = mergeAgentConfig(defaults, baseAgent());
    expect(result.channels?.telegram?.plugin).toBe("clerk");
    expect(result.channels?.telegram?.format).toBe("html");
  });

  it("per-field merges channels.telegram with agent winning", () => {
    const defaults: AgentDefaults = {
      channels: { telegram: { plugin: "clerk", format: "html", rate_limit_ms: 1000 } },
    };
    const agent = baseAgent({
      channels: { telegram: { format: "markdownv2" } },
    });
    const result = mergeAgentConfig(defaults, agent);
    // plugin and rate_limit flow from defaults; format is overridden
    expect(result.channels?.telegram?.plugin).toBe("clerk");
    expect(result.channels?.telegram?.format).toBe("markdownv2");
    expect(result.channels?.telegram?.rate_limit_ms).toBe(1000);
  });

  it("leaves channels undefined when neither side sets it", () => {
    const result = mergeAgentConfig({ model: "opus" }, baseAgent());
    expect(result.channels).toBeUndefined();
  });
});

describe("usesClerkTelegramPlugin", () => {
  // usesClerkTelegramPlugin imported at top of file

  it("returns true when channels.telegram.plugin is 'clerk'", () => {
    const agent = baseAgent({
      channels: { telegram: { plugin: "clerk" } },
    });
    expect(usesClerkTelegramPlugin(agent)).toBe(true);
  });

  it("returns false when channels.telegram.plugin is 'official'", () => {
    const agent = baseAgent({
      channels: { telegram: { plugin: "official" } },
    });
    expect(usesClerkTelegramPlugin(agent)).toBe(false);
  });

  it("defaults to true (clerk fork) when channels field is unset", () => {
    expect(usesClerkTelegramPlugin(baseAgent())).toBe(true);
  });

  it("defaults to true (clerk fork) when channels.telegram.plugin is unset", () => {
    const agent = baseAgent({ channels: { telegram: { format: "html" } } });
    expect(usesClerkTelegramPlugin(agent)).toBe(true);
  });
});

describe("resolveAgentConfig", () => {
  it("layers defaults → inline profile → agent in that order", () => {
    const defaults: AgentDefaults = {
      model: "sonnet",
      tools: { allow: ["Read"] },
    };
    const profiles: Record<string, Profile> = {
      coding: {
        tools: { allow: ["Bash", "Edit"] },
        system_prompt_append: "You write code.",
      },
    };
    const agent = baseAgent({
      extends: "coding",
      tools: { allow: ["Grep"], deny: [] },
    });
    const result = resolveAgentConfig(defaults, profiles, agent);

    // tools unioned across all three layers, defaults first, then profile, then agent
    expect(result.tools?.allow).toEqual(["Read", "Bash", "Edit", "Grep"]);
    // Model flows from defaults through profile (profile doesn't set it) to result
    expect(result.model).toBe("sonnet");
    // System prompt flows from profile
    expect(result.system_prompt_append).toBe("You write code.");
  });

  it("ignores unknown profile names (filesystem fallback handles them)", () => {
    const agent = baseAgent({ extends: "does-not-exist" });
    const result = resolveAgentConfig(undefined, undefined, agent);
    // Merge didn't throw; agent.extends preserved so scaffold can still
    // try the filesystem profile path.
    expect(result.extends).toBe("does-not-exist");
  });

  it("no-ops when defaults+profiles+extends are all absent", () => {
    const agent = baseAgent({ model: "opus" });
    const result = resolveAgentConfig(undefined, undefined, agent);
    expect(result).toEqual(agent);
  });
});

describe("mergeAgentConfig escape hatches", () => {
  it("deep-merges settings_raw objects across defaults and agent", () => {
    const defaults: AgentDefaults = {
      settings_raw: {
        permissions: { defaultMode: "auto" },
        effort: "high",
      },
    };
    const agent = baseAgent({
      settings_raw: {
        permissions: { deny: ["Bash(rm -rf *)"] },
      },
    });
    const result = mergeAgentConfig(defaults, agent);
    expect(result.settings_raw).toEqual({
      permissions: {
        defaultMode: "auto", // from defaults
        deny: ["Bash(rm -rf *)"], // from agent
      },
      effort: "high", // from defaults
    });
  });

  it("agent settings_raw primitives override defaults", () => {
    const result = mergeAgentConfig(
      { settings_raw: { effort: "high" } },
      baseAgent({ settings_raw: { effort: "max" } }),
    );
    expect((result.settings_raw as { effort: string }).effort).toBe("max");
  });

  it("concatenates claude_md_raw with a blank line separator", () => {
    const result = mergeAgentConfig(
      { claude_md_raw: "Global note." },
      baseAgent({ claude_md_raw: "Agent note." }),
    );
    expect(result.claude_md_raw).toBe("Global note.\n\nAgent note.");
  });

  it("concatenates cli_args (defaults first, no dedup)", () => {
    const result = mergeAgentConfig(
      { cli_args: ["--effort", "high"] },
      baseAgent({ cli_args: ["--add-dir", "/extra"] }),
    );
    expect(result.cli_args).toEqual(["--effort", "high", "--add-dir", "/extra"]);
  });

  it("leaves escape hatches undefined when neither side sets them", () => {
    const result = mergeAgentConfig({ model: "opus" }, baseAgent());
    expect(result.settings_raw).toBeUndefined();
    expect(result.claude_md_raw).toBeUndefined();
    expect(result.cli_args).toBeUndefined();
  });
});

describe("deepMergeJson", () => {
  // deepMergeJson imported at top of file

  it("per-key merges nested objects recursively", () => {
    const out = deepMergeJson(
      { a: { b: 1, c: 2 }, d: 3 },
      { a: { c: 99, e: 5 }, f: 6 },
    );
    expect(out).toEqual({ a: { b: 1, c: 99, e: 5 }, d: 3, f: 6 });
  });

  it("replaces arrays rather than concatenating", () => {
    const out = deepMergeJson(
      { list: [1, 2, 3] },
      { list: [9] },
    );
    expect(out).toEqual({ list: [9] });
  });

  it("override primitives win", () => {
    expect(deepMergeJson(1, 2)).toBe(2);
    expect(deepMergeJson("a", "b")).toBe("b");
  });

  it("undefined override leaves base untouched", () => {
    expect(deepMergeJson({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("translateHooksToClaudeShape", () => {
  // Local import to keep the describe block self-contained; see merge.ts
  // for the source implementation.
  // translateHooksToClaudeShape imported at top of file

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
