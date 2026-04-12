import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, installHindsightPlugin } from "../src/agents/scaffold.js";
import { renderTemplate } from "../src/agents/profiles.js";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
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

  it("pre-approves clerk-telegram MCP tool names when channels.telegram.plugin is 'clerk'", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar"], deny: [] },
      channels: { telegram: { plugin: "clerk" } },
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

  it("writes project-level .mcp.json when channels.telegram.plugin is 'clerk'", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "clerk" } } });
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

  it("does not write .mcp.json when channels.telegram.plugin is 'official'", () => {
    const config = makeAgentConfig({ channels: { telegram: { plugin: "official" } } });
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

  it("rewrites .mcp.json for clerk-telegram-plugin agents to include hindsight", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "clerk" } } });
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
    // Hindsight vars are now POSIX-single-quoted for shell safety
    expect(after).toContain("HINDSIGHT_API_URL='http://127.0.0.1:18888'");
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
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
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
          extends: "default",
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
          extends: "default",
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
      agents: { coach: { extends: "default", topic_name: "x", schedule: [] } },
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
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
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

  it("propagates defaults.channels.telegram.plugin to scaffold path", () => {
    // When the default is set globally, an agent that doesn't mention
    // channels.telegram.plugin=clerk still gets .mcp.json written and the
    // mcp__clerk-telegram__* tools pre-approved.
    const agentConfig = makeAgentConfig();
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { channels: { telegram: { plugin: "clerk" } } },
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

    // .mcp.json was written (the clerk-telegram-plugin scaffold branch)
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

  it("writes user hooks from clerk.yaml into settings.json under hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [
          { command: "/opt/audit.sh", timeout: 5 },
        ],
        Stop: [
          { command: "/opt/retain.sh", async: true },
        ],
      },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "hooks-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "hooks-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Native Claude Code nested shape
    expect(settings.hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/audit.sh", timeout: 5 },
        ],
      },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/retain.sh", async: true },
        ],
      },
    ]);
  });

  it("unions defaults.hooks with per-agent hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [{ command: "/agent/recall.sh" }],
      },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        hooks: {
          UserPromptSubmit: [{ command: "/global/audit.sh", timeout: 5 }],
          PreToolUse: [{ command: "/global/policy.sh" }],
        },
      },
      agents: { "hook-union-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "hook-union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    const ups = settings.hooks.UserPromptSubmit[0].hooks as Array<{ command: string }>;
    expect(ups.map((h) => h.command)).toEqual([
      "/global/audit.sh",
      "/agent/recall.sh",
    ]);
    // PreToolUse from defaults-only flows through
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it("writes model override into settings.json when set", () => {
    const agentConfig = makeAgentConfig({ model: "claude-opus-4-6" });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "model-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "model-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.model).toBe("claude-opus-4-6");
    // And --model is appended to exec claude in start.sh
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--model 'claude-opus-4-6'");
  });

  it("exports user env vars in start.sh in declaration order", () => {
    const agentConfig = makeAgentConfig({
      env: {
        CLERK_AUDIT_URL: "https://audit.example",
        LOG_LEVEL: "debug",
      },
    });
    const result = scaffoldAgent(
      "env-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Env values are POSIX-single-quoted by scaffold so shell-sensitive
    // bytes survive. See scaffold.ts userEnvQuoted.
    expect(startSh).toContain("export CLERK_AUDIT_URL='https://audit.example'");
    expect(startSh).toContain("export LOG_LEVEL='debug'");
  });

  it("escapes system_prompt_append via POSIX single-quote wrapping", () => {
    const agentConfig = makeAgentConfig({
      system_prompt_append:
        "Always respond with 'care'. Never use double-\"quotes\". Or $VAR.",
    });
    const result = scaffoldAgent(
      "prompt-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // --append-system-prompt argument is single-quote-wrapped
    expect(startSh).toContain("--append-system-prompt '");
    // Embedded single quote becomes '"'"'
    expect(startSh).toContain(`'"'"'care'"'"'`);
    // Dollar signs and double quotes survive untouched inside single quotes
    expect(startSh).toContain("$VAR");
    expect(startSh).toContain('double-"quotes"');
  });

  it("settings_raw deep-merges into the generated settings.json", () => {
    const agentConfig = makeAgentConfig({
      settings_raw: {
        effort: "high",
        permissions: { defaultMode: "bypassPermissions" },
      },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "raw-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Escape hatch wins — overrides clerk's default permissions.defaultMode
    expect(settings.effort).toBe("high");
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    // And the pre-existing clerk-managed keys still present
    expect(settings.permissions.allow).toContain("mcp__clerk__*");
  });

  it("claude_md_raw is appended to CLAUDE.md on scaffold", () => {
    const agentConfig = makeAgentConfig({
      claude_md_raw: "## Custom addendum\n\nExtra user notes.",
    });
    const result = scaffoldAgent(
      "rawmd-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const md = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    expect(md).toContain("## Custom addendum");
    expect(md).toContain("Extra user notes.");
  });

  it("cli_args are appended to exec claude in start.sh, single-quoted", () => {
    const agentConfig = makeAgentConfig({
      cli_args: ["--effort", "high", "--add-dir", "/tmp/has space"],
    });
    const result = scaffoldAgent(
      "cliargs-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toMatch(/exec claude.*'--effort' 'high' '--add-dir' '\/tmp\/has space'/);
  });

  it("channels.telegram.plugin: 'clerk' writes .mcp.json for forked telegram plugin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "clerk" } },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "chan-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "chan-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
      undefined,
      "/tmp/clerk.yaml",
    );

    // Same .mcp.json + permissions pre-approval as the legacy path
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__clerk-telegram__reply");

    // start.sh emits the dev-channels flag
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--dangerously-load-development-channels server:clerk-telegram");
  });

  it("channels.telegram.plugin: 'official' keeps the upstream marketplace plugin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "official" } },
    });
    const result = scaffoldAgent(
      "official-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );

    // No .mcp.json because the clerk-telegram fork isn't loaded
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(false);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--channels plugin:telegram@claude-plugins-official");
  });

  it("channels.telegram.format and rate_limit_ms become env vars in start.sh", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "markdownv2", rate_limit_ms: 500 } },
    });
    const result = scaffoldAgent(
      "chan-env-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("export CLERK_TG_FORMAT='markdownv2'");
    expect(startSh).toContain("export CLERK_TG_RATE_LIMIT_MS='500'");
  });

  it("user env entry wins over channel-derived env default on key conflict", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "markdownv2" } },
      env: { CLERK_TG_FORMAT: "text" }, // explicit override
    });
    const result = scaffoldAgent(
      "chan-env-override",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Only the user value remains
    expect(startSh).toContain("export CLERK_TG_FORMAT='text'");
    expect(startSh).not.toContain("export CLERK_TG_FORMAT='markdownv2'");
  });

  it("reconcile propagates hooks/env/model updates without touching user files", () => {
    const agentConfig = makeAgentConfig();
    const initial: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-phase2": agentConfig },
    } as ClerkConfig;
    scaffoldAgent("rec-phase2", agentConfig, tmpDir, telegramConfig, initial);

    // Update agent config in-place (a real user would edit clerk.yaml)
    const updatedAgent = makeAgentConfig({
      model: "claude-sonnet-4-6",
      hooks: { Stop: [{ command: "/new/hook.sh", async: true }] },
      env: { NEW_VAR: "hello" },
    });
    const updated: ClerkConfig = {
      ...initial,
      agents: { "rec-phase2": updatedAgent },
    } as ClerkConfig;
    reconcileAgent("rec-phase2", updatedAgent, tmpDir, telegramConfig, updated);

    const settings = JSON.parse(
      readFileSync(join(tmpDir, "rec-phase2", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.model).toBe("claude-sonnet-4-6");
    expect(settings.hooks.Stop).toBeDefined();

    const startSh = readFileSync(join(tmpDir, "rec-phase2", "start.sh"), "utf-8");
    expect(startSh).toContain("export NEW_VAR='hello'");
    expect(startSh).toContain("--model 'claude-sonnet-4-6'");
  });

  it("is a no-op when clerk.yaml has no defaults block (backcompat)", () => {
    // The refactor moved scaffold through mergeAgentConfig. This test
    // asserts that omitting `defaults` produces the same settings.json
    // as the pre-refactor code path would have.
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Edit"], deny: [] },
      channels: { telegram: { plugin: "clerk" } },
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

describe("scaffoldAgent global skills pool", () => {
  let tmpDir: string;
  let skillsPool: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-skills-"));
    skillsPool = join(tmpDir, "skills-pool");

    // Populate a fake skills pool with three fake skills
    for (const name of ["checkin", "retain", "weekly-review"]) {
      const dir = join(skillsPool, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
    }
    // Ensure HOME expansion can't accidentally reach into the real user
    // pool — pin HOME to the tmpDir. Restore in afterEach.
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildConfig(
    agentConfig: AgentConfig,
    skillsDir?: string,
  ): ClerkConfig {
    return {
      clerk: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsDir ?? skillsPool },
      telegram: telegramConfig,
      agents: { "skills-agent": agentConfig },
    } as ClerkConfig;
  }

  it("symlinks declared skills from the pool into the agent skills dir", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "retain"] });
    const clerkConfig = buildConfig(agentConfig);

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      clerkConfig,
    );

    const checkinPath = join(result.agentDir, "skills", "checkin");
    const retainPath = join(result.agentDir, "skills", "retain");
    expect(existsSync(checkinPath)).toBe(true);
    expect(existsSync(retainPath)).toBe(true);
    // Verify they're symlinks pointing into the pool
    const { readlinkSync } = require("node:fs");
    expect(readlinkSync(checkinPath)).toBe(join(skillsPool, "checkin"));
  });

  it("unions defaults.skills with agent.skills in the symlink pass", () => {
    const agentConfig = makeAgentConfig({ skills: ["weekly-review"] });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsPool },
      telegram: telegramConfig,
      defaults: { skills: ["checkin", "retain"] },
      agents: { "skills-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      clerkConfig,
    );

    for (const name of ["checkin", "retain", "weekly-review"]) {
      expect(existsSync(join(result.agentDir, "skills", name))).toBe(true);
    }
  });

  it("warns and skips missing skills without throwing", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "does-not-exist"] });
    const clerkConfig = buildConfig(agentConfig);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      clerkConfig,
    );
    warnSpy.mockRestore();

    expect(existsSync(join(result.agentDir, "skills", "checkin"))).toBe(true);
    expect(existsSync(join(result.agentDir, "skills", "does-not-exist"))).toBe(false);
  });

  it("reconcile removes stale symlinks when a skill is dropped from clerk.yaml", () => {
    const before = makeAgentConfig({ skills: ["checkin", "retain"] });
    const initial = buildConfig(before);
    const result = scaffoldAgent(
      "skills-agent",
      before,
      join(tmpDir, "agents"),
      telegramConfig,
      initial,
    );
    expect(existsSync(join(result.agentDir, "skills", "retain"))).toBe(true);

    const after = makeAgentConfig({ skills: ["checkin"] });
    const updated = buildConfig(after);
    reconcileAgent(
      "skills-agent",
      after,
      join(tmpDir, "agents"),
      telegramConfig,
      updated,
    );

    expect(existsSync(join(result.agentDir, "skills", "checkin"))).toBe(true);
    // retain's symlink was removed
    expect(existsSync(join(result.agentDir, "skills", "retain"))).toBe(false);
  });

  it("does not touch template-copied skill files during stale cleanup", () => {
    // Create an agent, then manually drop a non-symlink skill file into
    // the agent's skills dir to simulate a template-contributed skill.
    // A reconcile that removes nothing from the pool must leave that
    // file in place.
    const agentConfig = makeAgentConfig({ skills: ["checkin"] });
    const clerkConfig = buildConfig(agentConfig);
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      clerkConfig,
    );

    const templateSkill = join(result.agentDir, "skills", "template-skill");
    mkdirSync(templateSkill, { recursive: true });
    writeFileSync(join(templateSkill, "SKILL.md"), "# template\n", "utf-8");

    // Reconcile with the same config
    reconcileAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      clerkConfig,
    );

    // template-skill survives because it's a real directory, not a
    // symlink pointing into the pool
    expect(existsSync(templateSkill)).toBe(true);
  });
});

describe("phase-6b bug fixes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-phase6b-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("env values with shell-sensitive bytes are POSIX-quoted in start.sh", () => {
    // Dollar sign, backtick, double quote, embedded single quote,
    // ampersand, and newline all need to survive shell parsing.
    const agentConfig = makeAgentConfig({
      env: {
        TRICKY: "a & b $HOME `pwd` \"q\" 'x' \n two",
      },
    });
    const result = scaffoldAgent(
      "env-adversarial",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // The whole value is inside POSIX single quotes; embedded single
    // quote becomes '"'"' (close-dq"'"dq-reopen).
    expect(startSh).toContain(
      `export TRICKY='a & b $HOME \`pwd\` "q" '"'"'x'"'"' \n two'`,
    );
  });

  it("cli_args with embedded single quote and dollar sign stay intact", () => {
    const agentConfig = makeAgentConfig({
      cli_args: ["--note", "can't stop $PATH"],
    });
    const result = scaffoldAgent(
      "cli-adversarial",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain(`'--note' 'can'"'"'t stop $PATH'`);
  });

  it("reconcile drops settings.hooks events that were removed from clerk.yaml", () => {
    const withHooks = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [{ command: "/opt/a.sh" }],
        Stop: [{ command: "/opt/b.sh", async: true }],
      },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "drift-agent": withHooks },
    } as ClerkConfig;

    scaffoldAgent("drift-agent", withHooks, tmpDir, telegramConfig, clerkConfig);
    const settingsPath = join(tmpDir, "drift-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.hooks.UserPromptSubmit).toBeDefined();
    expect(before.hooks.Stop).toBeDefined();

    // User removes Stop from clerk.yaml
    const lessHooks = makeAgentConfig({
      hooks: { UserPromptSubmit: [{ command: "/opt/a.sh" }] },
    });
    const updated: ClerkConfig = {
      ...clerkConfig,
      agents: { "drift-agent": lessHooks },
    } as ClerkConfig;
    reconcileAgent("drift-agent", lessHooks, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.hooks.UserPromptSubmit).toBeDefined();
    // Stop was dropped — the whole event is gone
    expect(after.hooks.Stop).toBeUndefined();
  });

  it("reconcile retracts settings_raw keys that were removed from clerk.yaml", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", customKey: "original" },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-drift": withRaw },
    } as ClerkConfig;

    scaffoldAgent("raw-drift", withRaw, tmpDir, telegramConfig, clerkConfig);
    const settingsPath = join(tmpDir, "raw-drift", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.effort).toBe("high");
    expect(before.customKey).toBe("original");
    // Side-car tracks what was injected
    expect(before._clerkManagedRawKeys).toEqual(["effort", "customKey"]);

    // User removes customKey from clerk.yaml
    const lessRaw = makeAgentConfig({ settings_raw: { effort: "high" } });
    const updated: ClerkConfig = {
      ...clerkConfig,
      agents: { "raw-drift": lessRaw },
    } as ClerkConfig;
    reconcileAgent("raw-drift", lessRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.effort).toBe("high"); // still present
    expect(after.customKey).toBeUndefined(); // retracted
    expect(after._clerkManagedRawKeys).toEqual(["effort"]);
  });

  it("reconcile retracts all settings_raw keys when the field is cleared entirely", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", apiKeyHelper: "/bin/true" },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "clear-drift": withRaw },
    } as ClerkConfig;
    scaffoldAgent("clear-drift", withRaw, tmpDir, telegramConfig, clerkConfig);

    const emptyRaw = makeAgentConfig();
    const updated: ClerkConfig = {
      ...clerkConfig,
      agents: { "clear-drift": emptyRaw },
    } as ClerkConfig;
    reconcileAgent("clear-drift", emptyRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(
      readFileSync(join(tmpDir, "clear-drift", ".claude", "settings.json"), "utf-8"),
    );
    expect(after.effort).toBeUndefined();
    expect(after.apiKeyHelper).toBeUndefined();
    expect(after._clerkManagedRawKeys).toBeUndefined();
  });

  it("reconcile is idempotent across two back-to-back runs with the same config", () => {
    const agentConfig = makeAgentConfig({
      hooks: { PreToolUse: [{ command: "/opt/audit.sh", timeout: 5 }] },
      env: { FOO: "bar" },
      model: "claude-sonnet-4-6",
      settings_raw: { effort: "high" },
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "idem-agent": agentConfig },
    } as ClerkConfig;

    scaffoldAgent("idem-agent", agentConfig, tmpDir, telegramConfig, clerkConfig);
    reconcileAgent("idem-agent", agentConfig, tmpDir, telegramConfig, clerkConfig);
    const result = reconcileAgent(
      "idem-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    // Second reconcile is a no-op — no files touched
    expect(result.changes).toEqual([]);
  });

  it("merge does not crash when defaults has schedule but agent does not (layered cast safety)", () => {
    // Regression for the `[...merged.schedule]` crash in mergeAgentConfig
    // when resolveAgentConfig's first layer (defaults → profile) runs
    // and the profile has no schedule field at all. Covered indirectly
    // by scaffolding an agent whose cascade exercises the path.
    const agentConfig = makeAgentConfig({ extends: "coder" });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        schedule: [{ cron: "0 9 * * *", prompt: "standup" }],
      },
      profiles: {
        coder: { tools: { allow: ["Bash"] } }, // no schedule
      },
      agents: { "sched-agent": agentConfig },
    } as ClerkConfig;

    // This call would previously TypeError via [...undefined]
    expect(() =>
      scaffoldAgent("sched-agent", agentConfig, tmpDir, telegramConfig, clerkConfig),
    ).not.toThrow();
  });
});

describe("scaffoldAgent with inline profiles (extends cascade)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-profiles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges inline profile between defaults and per-agent config", () => {
    const agentConfig = makeAgentConfig({ extends: "coder" });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read"] },
        model: "claude-sonnet-4-6",
      },
      profiles: {
        coder: {
          tools: { allow: ["Bash", "Edit"] },
          system_prompt_append: "You write code.",
        },
      },
      agents: { "profile-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "profile-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Tools unioned across defaults (Read) + profile (Bash, Edit)
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Edit");
    // Model from defaults flows through profile (which doesn't set it)
    expect(settings.model).toBe("claude-sonnet-4-6");

    // system_prompt_append from the profile landed in start.sh
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("You write code.");
  });

  it("per-agent fields still win over inline profile fields", () => {
    const agentConfig = makeAgentConfig({
      extends: "coder",
      model: "claude-opus-4-6",
    });
    const clerkConfig: ClerkConfig = {
      clerk: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      profiles: {
        coder: { model: "claude-sonnet-4-6" },
      },
      agents: { "override-agent": agentConfig },
    } as ClerkConfig;

    const result = scaffoldAgent(
      "override-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      clerkConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.model).toBe("claude-opus-4-6");
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
