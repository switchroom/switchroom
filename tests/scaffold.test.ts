import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, installHindsightPlugin } from "../src/agents/scaffold.js";
import { renderTemplate } from "../src/agents/templates.js";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    template: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("scaffoldAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the correct directory structure", () => {
    const config = makeAgentConfig({ topic_name: "Health" });
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".claude"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "skills"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", ".env"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", "access.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "start.sh"))).toBe(true);
  });

  it("renders CLAUDE.md with agent name and soul", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational, direct",
        boundaries: "not a doctor",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    expect(claudeMd).toContain("health-coach");
    expect(claudeMd).toContain("Coach");
    expect(claudeMd).toContain("motivational");
    expect(claudeMd).toContain("not a doctor");
  });

  it("generates start.sh with correct env vars", () => {
    const config = makeAgentConfig({ topic_id: 42 });
    const result = scaffoldAgent("my-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("#!/bin/bash");
    // start.sh must source nvm so systemd user services find node on PATH
    expect(startSh).toContain('NVM_DIR="$HOME/.nvm"');
    expect(startSh).toContain("$NVM_DIR/nvm.sh");
    expect(startSh).toContain(`CLAUDE_CONFIG_DIR="${result.agentDir}/.claude"`);
    expect(startSh).toContain(`TELEGRAM_STATE_DIR="${result.agentDir}/telegram"`);
    expect(startSh).toContain("exec claude --channels plugin:telegram@claude-plugins-official");
    expect(startSh).not.toContain("TELEGRAM_TOPIC_ID");
    // CLERK_AGENT_NAME is the canonical "which agent am I" identifier the
    // telegram-plugin reads to detect self-restart commands. Must be set.
    expect(startSh).toContain('CLERK_AGENT_NAME="my-agent"');
    expect(startSh).not.toContain("CLERK_SOCKET_PATH");
    expect(startSh).not.toContain("--dangerously-skip-permissions");
    // Must NOT use $(node -v) since node isn't on PATH under systemd user units
    expect(startSh).not.toContain("$(node -v)");
  });

  it("generates telegram .env with bot token", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("bot-agent", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-DEF");
  });

  it("generates access.json with group config", () => {
    const config = makeAgentConfig({ topic_id: 99 });
    const result = scaffoldAgent("filtered", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );

    expect(access.dmPolicy).toBe("allowlist");
    expect(Array.isArray(access.allowFrom)).toBe(true);
    expect(access.groups).toBeDefined();
    expect(access.groups["-1001234567890"]).toBeDefined();
    expect(access.groups["-1001234567890"].requireMention).toBe(false);
  });

  it("generates settings.json with tool permissions", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar", "notion"], deny: ["bash"] },
    });
    const result = scaffoldAgent("tools-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Always pre-approves the clerk MCP wildcards alongside user-listed tools
    expect(settings.permissions.allow).toContain("calendar");
    expect(settings.permissions.allow).toContain("notion");
    expect(settings.permissions.allow).toContain("mcp__clerk__*");
    expect(settings.permissions.deny).toEqual(["bash"]);
    expect(settings.permissions.defaultMode).toBeUndefined();
  });

  it("expands tools.allow: [all] into the full built-in tool list", () => {
    // Claude Code rejects the literal string "all" in permissions.allow.
    // When users write `tools.allow: [all]` in clerk.yaml, the scaffold
    // expands it to the full set of built-in Claude Code tools so the
    // agent never blocks on a runtime permission prompt.
    const config = makeAgentConfig({
      tools: { allow: ["all"], deny: [] },
    });
    const result = scaffoldAgent("all-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Critical built-ins must be present
    for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Glob", "Grep"]) {
      expect(settings.permissions.allow).toContain(t);
    }
    // Backstop defaultMode is also set
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    // No literal "all" leaks through
    expect(settings.permissions.allow).not.toContain("all");
  });

  it("pre-approves clerk-telegram MCP tool names when use_clerk_plugin is true", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar"], deny: [] },
      use_clerk_plugin: true,
    });
    const result = scaffoldAgent("fork-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("calendar");
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram");
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__reply");
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__react");
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__edit_message");
  });

  it("writes project-level .mcp.json when use_clerk_plugin is true", () => {
    const agentConfig = makeAgentConfig({ use_clerk_plugin: true });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "fork-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "fork-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
      undefined,
      "/fake/clerk.yaml",
    );

    const mcpJsonPath = join(result.agentDir, ".mcp.json");
    expect(existsSync(mcpJsonPath)).toBe(true);

    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(mcpJson.mcpServers).toBeDefined();
    expect(mcpJson.mcpServers["clerk-telegram"]).toBeDefined();
    expect(mcpJson.mcpServers["clerk-telegram"].command).toBe("bun");
    expect(mcpJson.mcpServers["clerk-telegram"].env.TELEGRAM_STATE_DIR).toBe(
      join(result.agentDir, "telegram"),
    );
    expect(mcpJson.mcpServers["clerk-telegram"].env.CLERK_CONFIG).toBe(
      "/fake/clerk.yaml",
    );
    expect(mcpJson.mcpServers["clerk-telegram"].env.CLERK_CLI_PATH).toBeDefined();
  });

  it("does not write .mcp.json when use_clerk_plugin is false", () => {
    const config = makeAgentConfig({ use_clerk_plugin: false });
    const result = scaffoldAgent("plain-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(false);
  });

  it("is idempotent — running twice does not overwrite existing files", () => {
    const config = makeAgentConfig({
      soul: { name: "Coach", style: "direct" },
    });

    // First scaffold
    const result1 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result1.created.length).toBeGreaterThan(0);
    expect(result1.skipped.length).toBe(0);

    // Modify a file to verify it won't be overwritten
    const claudePath = join(result1.agentDir, "CLAUDE.md");
    writeFileSync(claudePath, "# Custom content\n", "utf-8");

    // Second scaffold
    const result2 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result2.created.length).toBe(0);
    expect(result2.skipped.length).toBeGreaterThan(0);

    // Verify file was not overwritten
    const content = readFileSync(claudePath, "utf-8");
    expect(content).toBe("# Custom content\n");
  });

  it("includes --dangerously-skip-permissions when dangerous_mode is true", () => {
    const config = makeAgentConfig({ dangerous_mode: true });
    const result = scaffoldAgent("dangerous-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("--dangerously-skip-permissions");
  });

  it("does not include --dangerously-skip-permissions when dangerous_mode is false", () => {
    const config = makeAgentConfig({ dangerous_mode: false });
    const result = scaffoldAgent("safe-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).not.toContain("--dangerously-skip-permissions");
  });

  it("includes skipDangerousModePermissionPrompt when skip_permission_prompt is true", () => {
    const config = makeAgentConfig({ skip_permission_prompt: true });
    const result = scaffoldAgent("skip-prompt-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  });

  it("does not include skipDangerousModePermissionPrompt by default", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("default-prompt-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  it("does not include clerk-telegram MCP server in settings.json", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("plugin-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Each agent uses the official plugin:telegram@claude-plugins-official
    // No shared MCP server for Telegram
    expect(settings.mcpServers?.["clerk-telegram"]).toBeUndefined();
  });

  it("writes comment in .env when bot token is unresolvable vault reference", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    // With no CLERK_VAULT_PASSPHRASE or TELEGRAM_BOT_TOKEN set, should write comment
    const origPassphrase = process.env.CLERK_VAULT_PASSPHRASE;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.CLERK_VAULT_PASSPHRASE;
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("vault-agent", config, tmpDir, vaultTelegramConfig);
      const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

      expect(envContent).toContain("# Set your bot token");
    } finally {
      if (origPassphrase !== undefined) process.env.CLERK_VAULT_PASSPHRASE = origPassphrase;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    }
  });

  it("uses per-agent bot token when provided", () => {
    const config = makeAgentConfig({ bot_token: "999888:AGENT-SPECIFIC" });
    const result = scaffoldAgent("agent-token", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=999888:AGENT-SPECIFIC");
  });

  it("falls back to global bot token when no per-agent token", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("global-token", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-DEF");
  });

  it("creates plugin directories during scaffolding", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("plugin-dir-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".claude", "plugins", "marketplaces"))).toBe(true);
  });

  it("returns correct agentDir path", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("path-check", config, tmpDir, telegramConfig);

    expect(result.agentDir).toBe(join(tmpDir, "path-check"));
  });

  it("injects Hindsight MCP config when memory backend is hindsight", () => {
    const agentConfig = makeAgentConfig();
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "ollama", docker_service: true },
      },
      agents: { "memory-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );

    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers.hindsight).toBeDefined();
    expect(settings.mcpServers.hindsight.url).toBe("http://localhost:8888/mcp/");
    expect(settings.mcpServers.hindsight.type).toBe("http");
  });

  it("respects memory.config.url override for Hindsight MCP", () => {
    const agentConfig = makeAgentConfig();
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: {
          provider: "ollama",
          docker_service: true,
          url: "http://localhost:18888/mcp/",
        },
      },
      agents: { "memory-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );

    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers.hindsight.url).toBe("http://localhost:18888/mcp/");
  });
});

describe("reconcileAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-reconcile-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildClerkConfig(
    agentConfig: AgentConfig,
    memory?: ClerkConfig["memory"],
  ): ClerkConfig {
    return {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory,
      agents: { "test-agent": agentConfig },
    } as ClerkConfig;
  }

  it("throws when the agent directory does not exist", () => {
    const agentConfig = makeAgentConfig();
    expect(() =>
      reconcileAgent(
        "missing-agent",
        agentConfig,
        tmpDir,
        telegramConfig,
        buildClerkConfig(agentConfig),
      ),
    ).toThrow(/Agent directory does not exist/);
  });

  it("adds Hindsight MCP entry to settings.json after enabling memory backend", () => {
    // Step 1: scaffold an agent without memory
    const agentConfig = makeAgentConfig();
    const initialConfig = buildClerkConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.mcpServers?.hindsight).toBeUndefined();

    // Step 2: turn on hindsight in clerk.yaml and reconcile
    const updatedConfig = buildClerkConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: {
        provider: "openai",
        docker_service: true,
        url: "http://localhost:18888/mcp/",
      },
    });

    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
    );

    expect(result.changes).toContain(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.mcpServers.hindsight).toBeDefined();
    expect(after.mcpServers.hindsight.url).toBe("http://localhost:18888/mcp/");
    expect(after.permissions.allow).toContain("mcp__hindsight__*");
  });

  it("rewrites .mcp.json for use_clerk_plugin agents to include hindsight", () => {
    const agentConfig = makeAgentConfig({ use_clerk_plugin: true });
    const initialConfig = buildClerkConfig(agentConfig);
    scaffoldAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      initialConfig,
      undefined,
      "/tmp/clerk.yaml",
    );

    const mcpJsonPath = join(tmpDir, "test-agent", ".mcp.json");
    const before = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(before.mcpServers["clerk-telegram"]).toBeDefined();
    expect(before.mcpServers.hindsight).toBeUndefined();

    const updatedConfig = buildClerkConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: {
        provider: "openai",
        docker_service: true,
        url: "http://localhost:18888/mcp/",
      },
    });

    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
      "/tmp/clerk.yaml",
    );

    expect(result.changes).toContain(mcpJsonPath);
    const after = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(after.mcpServers["clerk-telegram"]).toBeDefined();
    expect(after.mcpServers.hindsight).toBeDefined();
    expect(after.mcpServers.hindsight.url).toBe("http://localhost:18888/mcp/");
  });

  it("does not touch CLAUDE.md, SOUL.md, or telegram user-content files", () => {
    // start.sh is intentionally NOT in this list — it's purely
    // template-driven (no user content) and reconcile re-renders it
    // so config changes (like enabling Hindsight or switching ports)
    // propagate without forcing a full re-scaffold.
    const agentConfig = makeAgentConfig();
    const initialConfig = buildClerkConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const userEditedFiles = [
      join(tmpDir, "test-agent", "CLAUDE.md"),
      join(tmpDir, "test-agent", "SOUL.md"),
      join(tmpDir, "test-agent", "telegram", ".env"),
      join(tmpDir, "test-agent", "telegram", "access.json"),
    ];

    // Hand-edit each file with a marker the user "wrote"
    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        writeFileSync(f, readFileSync(f, "utf-8") + "\n# USER EDIT\n", "utf-8");
      }
    }

    const updatedConfig = buildClerkConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, updatedConfig);

    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        expect(readFileSync(f, "utf-8")).toContain("# USER EDIT");
      }
    }
  });

  it("re-renders start.sh when config drives template changes (Hindsight enable)", () => {
    const agentConfig = makeAgentConfig();
    const initialConfig = buildClerkConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const before = readFileSync(startShPath, "utf-8");
    expect(before).not.toContain("HINDSIGHT_API_URL");

    // Enable Hindsight via clerk.yaml and reconcile
    const withMemory = buildClerkConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const after = readFileSync(startShPath, "utf-8");
    expect(after).toContain("HINDSIGHT_API_URL=\"http://127.0.0.1:18888\"");
    expect(after).toContain("--plugin-dir");
    expect(after).toContain(".claude/plugins/hindsight-memory");
  });

  it("returns no changes when settings already match", () => {
    const agentConfig = makeAgentConfig();
    const config = buildClerkConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);

    // First reconcile may apply scaffold->reconcile drift (e.g. clerk-mcp entry)
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);
    // Second should be a no-op
    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      config,
    );
    expect(result.changes).toEqual([]);
  });

  it("removes hindsight MCP entry when backend is disabled", () => {
    const agentConfig = makeAgentConfig();
    const withMemory = buildClerkConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const beforeReconcile = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(beforeReconcile.permissions.allow).toContain("mcp__hindsight__*");

    // Reconcile against a config with backend=none
    const withoutMemory = buildClerkConfig(agentConfig, {
      backend: "none",
      shared_collection: "shared",
    });
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, withoutMemory);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions.allow).not.toContain("mcp__hindsight__*");
    expect(after.mcpServers.hindsight).toBeUndefined();
  });
});

describe("installHindsightPlugin", () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-plugin-"));
    agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when memory backend is not hindsight", () => {
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "none", shared_collection: "shared" },
      agents: { agent: { template: "default", topic_name: "x", schedule: [] } },
    } as ClerkConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("returns null when agent has memory.auto_recall: false", () => {
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: {
        agent: {
          template: "default",
          topic_name: "x",
          schedule: [],
          memory: { collection: "general", auto_recall: false, isolation: "default" },
        },
      },
    } as ClerkConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("copies the vendored plugin tree and returns metadata when configured", () => {
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: {
        agent: {
          template: "default",
          topic_name: "x",
          schedule: [],
          memory: { collection: "general", auto_recall: true, isolation: "default" },
        },
      },
    } as ClerkConfig;
    const result = installHindsightPlugin("agent", agentDir, config);
    expect(result).not.toBeNull();
    expect(result!.pluginDir).toBe(join(agentDir, ".claude", "plugins", "hindsight-memory"));
    expect(result!.bankId).toBe("general");
    expect(result!.apiBaseUrl).toBe("http://127.0.0.1:18888");
    // Plugin manifest copied
    expect(existsSync(join(result!.pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    // Hook script copied
    expect(existsSync(join(result!.pluginDir, "scripts", "recall.py"))).toBe(true);
    expect(existsSync(join(result!.pluginDir, "scripts", "retain.py"))).toBe(true);
    expect(existsSync(join(result!.pluginDir, "hooks", "hooks.json"))).toBe(true);
  });

  it("falls back to agent name when no explicit collection is set", () => {
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: { coach: { template: "default", topic_name: "x", schedule: [] } },
    } as ClerkConfig;
    mkdirSync(join(tmpDir, "coach", ".claude"), { recursive: true });
    const result = installHindsightPlugin("coach", join(tmpDir, "coach"), config);
    expect(result).not.toBeNull();
    expect(result!.bankId).toBe("coach");
  });

  it("strips the /mcp/ suffix from memory.config.url to get the REST base", () => {
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://localhost:18888/mcp/" },
      },
      agents: { agent: { template: "default", topic_name: "x", schedule: [] } },
    } as ClerkConfig;
    const result = installHindsightPlugin("agent", agentDir, config);
    expect(result).not.toBeNull();
    expect(result!.apiBaseUrl).toBe("http://localhost:18888");
  });
});

describe("scaffoldAgent with global defaults cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-defaults-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies defaults.tools.allow to agents that leave tools unset", () => {
    const agentConfig = makeAgentConfig();
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep", "Edit"] },
      },
      agents: { "def-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "def-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Defaults flow through to permissions.allow
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("Edit");
    // Clerk-MCP wildcards still pre-approved
    expect(settings.permissions.allow).toContain("mcp__clerk__*");
  });

  it("unions defaults.tools.allow with per-agent tools.allow", () => {
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Read"], deny: [] },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep"] },
      },
      agents: { "union-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Union contains all three
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("Bash");
    // Read appears once (deduped)
    const reads = (settings.permissions.allow as string[]).filter((t) => t === "Read");
    expect(reads.length).toBe(1);
  });

  it("propagates defaults.use_clerk_plugin to scaffold path", () => {
    // When the default is set globally, an agent that doesn't mention
    // use_clerk_plugin still gets .mcp.json written and the
    // mcp__clerk-telegram__* tools pre-approved.
    const agentConfig = makeAgentConfig();
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { use_clerk_plugin: true },
      agents: { "plugin-default-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "plugin-default-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
      undefined,
      "/tmp/clerk.yaml",
    );

    // .mcp.json was written (the use_clerk_plugin scaffold branch)
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__reply");
  });

  it("per-agent mcp_servers override defaults.mcp_servers by key", () => {
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        linear: { type: "http", url: "https://agent.linear.example" },
      },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        mcp_servers: {
          linear: { type: "http", url: "https://default.linear.example" },
          github: { type: "http", url: "https://default.github.example" },
        },
      },
      agents: { "mcp-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "mcp-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Agent's linear entry wins
    expect(settings.mcpServers.linear.url).toBe("https://agent.linear.example");
    // Default's github entry flows through
    expect(settings.mcpServers.github.url).toBe("https://default.github.example");
  });

  it("reconcile respects defaults cascade too", () => {
    // Scaffold with defaults.tools.allow, then reconcile after changing
    // clerk.yaml defaults — the merged allow-list should update without
    // touching the per-agent config.
    const agentConfig = makeAgentConfig();
    const initial: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { tools: { allow: ["Read"] } },
      agents: { "rec-agent": agentConfig },
    } as ClerkConfig;
    scaffoldAgent("rec-agent", agentConfig, tmpDir, telegramConfig, initial);

    const settingsPath = join(tmpDir, "rec-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.permissions.allow).toContain("Read");
    expect(before.permissions.allow).not.toContain("Grep");

    // Update defaults and reconcile
    const updated: ClerkConfig = {
      ...initial,
      defaults: { tools: { allow: ["Read", "Grep", "Edit"] } },
    } as ClerkConfig;
    reconcileAgent("rec-agent", agentConfig, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions.allow).toContain("Read");
    expect(after.permissions.allow).toContain("Grep");
    expect(after.permissions.allow).toContain("Edit");
  });

  it("is a no-op when clerk.yaml has no defaults block (backcompat)", () => {
    // The refactor moved scaffold through mergeAgentConfig. This test
    // asserts that omitting `defaults` produces the same settings.json
    // as the pre-refactor code path would have.
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Edit"], deny: [] },
      use_clerk_plugin: true,
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "nodef-agent": agentConfig },
      // defaults intentionally omitted
    } as ClerkConfig;

    const result = scaffoldAgent(
      "nodef-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
      undefined,
      "/tmp/clerk.yaml",
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__reply");
    expect(settings.permissions.allow).toContain("mcp__clerk__*");
  });
});

describe("scaffoldAgent disables Claude Code auto-memory when Hindsight is on", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-automem-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets settings.json autoMemoryEnabled: false when Hindsight is enabled", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "general", auto_recall: true, isolation: "default" },
    });
    const config: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, config);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.autoMemoryEnabled).toBe(false);
    // Plugin tree was copied into the agent
    expect(existsSync(join(result.agentDir, ".claude", "plugins", "hindsight-memory", "scripts", "recall.py"))).toBe(true);
  });

  it("reconcile removes autoMemoryEnabled when memory backend is disabled", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "general", auto_recall: true, isolation: "default" },
    });
    const withMemory: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as ClerkConfig;
    scaffoldAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const withoutMemory: ClerkConfig = {
      ...withMemory,
      memory: { backend: "none", shared_collection: "shared" },
    } as ClerkConfig;
    reconcileAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, withoutMemory);

    const afterSettings = JSON.parse(
      readFileSync(join(tmpDir, "hindsight_agent", ".claude", "settings.json"), "utf-8"),
    );
    expect(afterSettings.autoMemoryEnabled).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-tpl-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders Handlebars variables", () => {
    const tplPath = join(tmpDir, "test.hbs");
    writeFileSync(tplPath, "Hello {{name}}, you are {{role}}.", "utf-8");

    const result = renderTemplate(tplPath, { name: "Alice", role: "admin" });
    expect(result).toBe("Hello Alice, you are admin.");
  });

  it("handles conditional blocks", () => {
    const tplPath = join(tmpDir, "cond.hbs");
    writeFileSync(tplPath, "{{#if active}}ON{{else}}OFF{{/if}}", "utf-8");

    expect(renderTemplate(tplPath, { active: true })).toBe("ON");
    expect(renderTemplate(tplPath, { active: false })).toBe("OFF");
  });

  it("handles each loops", () => {
    const tplPath = join(tmpDir, "loop.hbs");
    writeFileSync(tplPath, "{{#each items}}{{this}} {{/each}}", "utf-8");

    const result = renderTemplate(tplPath, { items: ["a", "b", "c"] });
    expect(result).toBe("a b c ");
  });
});
