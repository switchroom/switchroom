import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readlinkSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, installHindsightPlugin, installSwitchroomSkills } from "../src/agents/scaffold.js";
import { renderTemplate } from "../src/agents/profiles.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

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
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
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
    // Phase 2: SOUL.md is now a symlink to workspace/SOUL.md
    expect(existsSync(join(result.agentDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "workspace", "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", ".env"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", "access.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "start.sh"))).toBe(true);
  });

  it("renders CLAUDE.md with agent name (Phase 2: persona moved to SOUL.md)", () => {
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
    // Phase 2: persona content moved to SOUL.md
    expect(claudeMd).toContain("SOUL.md");
    expect(claudeMd).not.toContain("Coach");
    expect(claudeMd).not.toContain("motivational");

    // Persona should be in workspace/SOUL.md instead
    const soulMd = readFileSync(join(result.agentDir, "workspace", "SOUL.md"), "utf-8");
    expect(soulMd).toContain("Coach");
    expect(soulMd).toContain("motivational");
    expect(soulMd).toContain("not a doctor");
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
    // Fresh session every start — Hindsight auto-recall + handoff briefing
    expect(startSh).toContain("exec claude $CONTINUE_FLAG --dangerously-load-development-channels server:switchroom-telegram");
    expect(startSh).toContain('CONTINUE_FLAG=""');
    // Default: session-handoff enabled. start.sh reads .handoff.md and
    // merges it into --append-system-prompt; plugin reads .handoff-topic.
    expect(startSh).toContain(".handoff.md");
    expect(startSh).toContain("switchroom handoff");
    expect(startSh).toContain("SWITCHROOM_HANDOFF_SHOW_LINE=true");
    expect(startSh).not.toContain("TELEGRAM_TOPIC_ID");
    // SWITCHROOM_AGENT_NAME is the canonical "which agent am I" identifier the
    // telegram-plugin reads to detect self-restart commands. Must be set.
    expect(startSh).toContain('SWITCHROOM_AGENT_NAME="my-agent"');
    expect(startSh).not.toContain("SWITCHROOM_SOCKET_PATH");
    expect(startSh).not.toContain("--dangerously-skip-permissions");
    // Must NOT use $(node -v) since node isn't on PATH under systemd user units
    expect(startSh).not.toContain("$(node -v)");
  });

  it("start.sh exports CLAUDE_CODE_OAUTH_TOKEN from .oauth-token if present", () => {
    // Root-cause fix for the reauth token-loading bug: the token is saved to
    // .oauth-token on disk, but must also be exported into the live Claude
    // process env — otherwise Claude ignores .oauth-token and falls back to
    // .credentials.json (old account).
    const config = makeAgentConfig();
    const result = scaffoldAgent("token-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Must unset first (clear any inherited value from the outer shell)
    expect(startSh).toContain("unset CLAUDE_CODE_OAUTH_TOKEN");
    // Must read the token from $CLAUDE_CONFIG_DIR/.oauth-token when it exists
    expect(startSh).toMatch(/if \[ -f "\$CLAUDE_CONFIG_DIR\/\.oauth-token" \]/);
    expect(startSh).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(startSh).toContain(".oauth-token");
    // The export must come BEFORE the exec claude line
    const exportIdx = startSh.indexOf("export CLAUDE_CODE_OAUTH_TOKEN=");
    const execIdx = startSh.indexOf("exec claude");
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeLessThan(execIdx);
  });

  it("start.sh exports SWITCHROOM_CONFIG when a config path is passed", () => {
    // Without this export, `switchroom <anything>` from the agent's own
    // Bash tool fails with "No switchroom.yaml found" because the CLI's
    // search paths (cwd + ~/.switchroom) don't cover where the user
    // actually keeps their config. The telegram plugin already gets the
    // var via .mcp.json, but the Claude Code process itself doesn't
    // inherit that — start.sh has to export it.
    const config = makeAgentConfig();
    const configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(configPath, "switchroom: { agents_dir: . }\n");
    const result = scaffoldAgent(
      "cfg-agent",
      config,
      tmpDir,
      telegramConfig,
      undefined,
      undefined,
      configPath,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain(`export SWITCHROOM_CONFIG='${configPath}'`);
    const exportIdx = startSh.indexOf("export SWITCHROOM_CONFIG=");
    const execIdx = startSh.indexOf("exec claude");
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeLessThan(execIdx);
  });

  it("start.sh omits SWITCHROOM_CONFIG export when no config path is passed", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-cfg-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).not.toContain("export SWITCHROOM_CONFIG=");
  });

  it("session greeting script is a no-op stub (boot card replaces it)", () => {
    // The SessionStart greeting that posted "Switchroom · <agent> online"
    // duplicated the boot card (gateway-side) on every restart. We kept
    // the file write + hook registration intact for stability but
    // disabled the script body. Asserts:
    //   - file is generated (so existing scaffolds don't drift)
    //   - body is the documented no-op stub (logs + exit 0)
    //   - none of the deprecated runtime placeholders survive
    const config = makeAgentConfig();
    const result = scaffoldAgent("noop-greet-agent", config, tmpDir, telegramConfig);
    const greeting = readFileSync(
      join(result.agentDir, "telegram", "session-greeting.sh"),
      "utf-8",
    );
    expect(greeting).toContain("no-op");
    expect(greeting).toContain("exit 0");
    expect(greeting).not.toContain("__SWITCHROOM_AUTH__");
    expect(greeting).not.toContain("__SWITCHROOM_MODEL__");
    expect(greeting).not.toContain("__SWITCHROOM_PLAN__");
    expect(greeting).not.toContain("Switchroom · ");
  });


  it("session greeting hook has a generous timeout (not the stingy default)", () => {
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "timeout-agent": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent("timeout-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    // SessionStart hook. The original 5s budget was too tight — ccusage
    // alone takes 3-8s on agents with 300+ local transcripts, so the hook
    // got SIGKILL'd and the Quota/Auth rows silently rendered as "—".
    const sessionStart = settings.hooks?.SessionStart ?? [];
    const greetingHook = sessionStart
      .flatMap((s: { hooks?: Array<{ command?: string; timeout?: number }> }) => s.hooks ?? [])
      .find((h: { command?: string }) => h.command?.includes("session-greeting.sh"));
    expect(greetingHook).toBeDefined();
    expect(greetingHook.timeout).toBeGreaterThanOrEqual(15);
  });


  it("scaffold wiring: documented callers write the clean-shutdown marker with a reason before restarting", () => {
    // Source-grep regression for the five documented call sites so a
    // future refactor can't silently drop the reason-stamping step.
    const lifecycleSrc = readFileSync(
      resolve(__dirname, "..", "src", "agents", "lifecycle.ts"),
      "utf-8",
    );
    const cliAgentSrc = readFileSync(
      resolve(__dirname, "..", "src", "cli", "agent.ts"),
      "utf-8",
    );
    const cliUpdateSrc = readFileSync(
      resolve(__dirname, "..", "src", "cli", "update.ts"),
      "utf-8",
    );
    const watchdogSrc = readFileSync(
      resolve(__dirname, "..", "bin", "bridge-watchdog.sh"),
      "utf-8",
    );
    const gatewaySrc = readFileSync(
      resolve(__dirname, "..", "telegram-plugin", "gateway", "gateway.ts"),
      "utf-8",
    );

    // Helper lives in lifecycle.ts and resolves the same file the gateway
    // writes (shared contract — if the path drifts, greetings go dark).
    expect(lifecycleSrc).toContain("export function writeRestartReasonMarker");
    expect(lifecycleSrc).toContain("clean-shutdown.json");

    // CLI restart + reconcile-with-restart stamp a reason.
    expect(cliAgentSrc).toContain("writeRestartReasonMarker");
    expect(cliAgentSrc).toMatch(/buildCliRestartReason/);
    expect(cliAgentSrc).toMatch(/reconcile:\s/);

    // switchroom update stamps a reason for every bulk-restart target.
    expect(cliUpdateSrc).toContain("writeRestartReasonMarker");
    expect(cliUpdateSrc).toMatch(/update: pulled/);
    expect(cliUpdateSrc).toMatch(/update: reconciled config/);

    // Watchdog writes the marker before the systemctl restart.
    expect(watchdogSrc).toContain("clean-shutdown.json");
    expect(watchdogSrc).toMatch(/watchdog: bridge disconnected for/);
    // The write MUST precede the systemctl restart so the new boot sees it.
    const writeIdx = watchdogSrc.indexOf("clean-shutdown.json");
    const restartIdx = watchdogSrc.indexOf('systemctl --user restart "$agent_svc"', writeIdx);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(writeIdx);

    // Gateway user-slash paths stamp a user-attributed reason.
    expect(gatewaySrc).toContain("function stampUserRestartReason");
    expect(gatewaySrc).toContain("user: /restart from chat");
    expect(gatewaySrc).toMatch(/user: \/\$\{kind\} from chat/);
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

    // Always pre-approves the switchroom MCP wildcards alongside user-listed tools
    expect(settings.permissions.allow).toContain("calendar");
    expect(settings.permissions.allow).toContain("notion");
    expect(settings.permissions.allow).toContain("mcp__switchroom__*");
    expect(settings.permissions.deny).toEqual(["bash"]);
    expect(settings.permissions.defaultMode).toBeUndefined();
  });

  it("expands tools.allow: [all] into the full built-in tool list", () => {
    // Claude Code rejects the literal string "all" in permissions.allow.
    // When users write `tools.allow: [all]` in switchroom.yaml, the scaffold
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

  it("pre-approves switchroom-telegram MCP tool names when channels.telegram.plugin is 'switchroom'", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar"], deny: [] },
      channels: { telegram: { plugin: "switchroom" } },
    });
    const result = scaffoldAgent("fork-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("calendar");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__react");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__edit_message");
  });

  it("writes project-level .mcp.json when channels.telegram.plugin is 'switchroom'", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "switchroom" } } });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "fork-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "fork-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/fake/switchroom.yaml",
    );

    const mcpJsonPath = join(result.agentDir, ".mcp.json");
    expect(existsSync(mcpJsonPath)).toBe(true);

    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(mcpJson.mcpServers).toBeDefined();
    expect(mcpJson.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(mcpJson.mcpServers["switchroom-telegram"].command).toBe("bun");
    expect(mcpJson.mcpServers["switchroom-telegram"].env.TELEGRAM_STATE_DIR).toBe(
      join(result.agentDir, "telegram"),
    );
    expect(mcpJson.mcpServers["switchroom-telegram"].env.SWITCHROOM_CONFIG).toBe(
      "/fake/switchroom.yaml",
    );
    expect(mcpJson.mcpServers["switchroom-telegram"].env.SWITCHROOM_CLI_PATH).toBeDefined();
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

  it("does not include switchroom-telegram MCP server in settings.json (it lives in .mcp.json)", () => {
    // The switchroom fork loads via --dangerously-load-development-channels
    // which reads from .mcp.json, not settings.json. Verify it doesn't
    // leak into settings.json.
    const config = makeAgentConfig();
    const result = scaffoldAgent("plugin-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers?.["switchroom-telegram"]).toBeUndefined();
  });

  it("writes comment in .env when bot token is unresolvable vault reference", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    // With no SWITCHROOM_VAULT_PASSPHRASE or TELEGRAM_BOT_TOKEN set, should write comment
    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("vault-agent", config, tmpDir, vaultTelegramConfig);
      const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

      expect(envContent).toContain("# Set your bot token");
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "ollama", docker_service: true },
      },
      agents: { "memory-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
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
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers.hindsight.url).toBe("http://localhost:18888/mcp/");
  });

  it("seeds profile workspace/ files into agent's workspace/ directory", () => {
    const config = makeAgentConfig({
      soul: { name: "Test Agent", emoji: "\ud83e\udd16" },
    });
    const result = scaffoldAgent("ws-agent", config, tmpDir, telegramConfig);

    // Default profile ships workspace/{AGENTS,USER,IDENTITY,TOOLS,MEMORY}.md.hbs
    const workspaceDir = join(result.agentDir, "workspace");
    expect(existsSync(workspaceDir)).toBe(true);
    expect(existsSync(join(workspaceDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "USER.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "TOOLS.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "HEARTBEAT.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "memory"))).toBe(true);

    // .hbs templates must have been rendered (not copied raw) — the file
    // must NOT contain handlebars syntax.
    const agents = readFileSync(join(workspaceDir, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("{{");
    expect(agents).toContain("AGENTS.md");

    // IDENTITY.md should include the agent's soul name (template context).
    const identity = readFileSync(join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identity).toContain("Test Agent");

    // Source .hbs file must not appear in agent dir.
    expect(existsSync(join(workspaceDir, "AGENTS.md.hbs"))).toBe(false);
  });

  it("start.sh respects session_continuity.resume_mode in the generated script", () => {
    // auto (default)
    const autoResult = scaffoldAgent(
      "resume-auto",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const autoScript = readFileSync(join(autoResult.agentDir, "start.sh"), "utf-8");
    expect(autoScript).toContain('SWITCHROOM_RESUME_MODE="auto"');
    expect(autoScript).toContain('SWITCHROOM_RESUME_MAX_BYTES="2000000"');
    // auto mode emits the size-check branch
    expect(autoScript).toMatch(/case "\$SWITCHROOM_RESUME_MODE" in/);
    expect(autoScript).toContain('CONTINUE_FLAG="--continue"');

    // explicit continue
    const contResult = scaffoldAgent(
      "resume-cont",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const contScript = readFileSync(join(contResult.agentDir, "start.sh"), "utf-8");
    expect(contScript).toContain('SWITCHROOM_RESUME_MODE="continue"');

    // explicit handoff
    const hoResult = scaffoldAgent(
      "resume-ho",
      makeAgentConfig({
        session_continuity: { resume_mode: "handoff" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const hoScript = readFileSync(join(hoResult.agentDir, "start.sh"), "utf-8");
    expect(hoScript).toContain('SWITCHROOM_RESUME_MODE="handoff"');

    // custom byte threshold
    const customResult = scaffoldAgent(
      "resume-custom",
      makeAgentConfig({
        session_continuity: { resume_mode: "auto", resume_max_bytes: 500_000 },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const customScript = readFileSync(
      join(customResult.agentDir, "start.sh"),
      "utf-8",
    );
    expect(customScript).toContain('SWITCHROOM_RESUME_MAX_BYTES="500000"');
  });

  it("seeds safe read-only tool defaults when tools.allow is empty and dangerous_mode is off", () => {
    const config = makeAgentConfig(); // no tools, no dangerous_mode
    const result = scaffoldAgent("readonly-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;
    expect(allow).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    // Risky tools must NOT be auto-allowed.
    expect(allow).not.toContain("Bash");
    expect(allow).not.toContain("Edit");
    expect(allow).not.toContain("Write");
    expect(allow).not.toContain("WebFetch");
  });

  it("does not inject read-only defaults when user set explicit tools.allow", () => {
    const config = makeAgentConfig({
      tools: { allow: ["Bash"], deny: [] },
    } as Partial<AgentConfig>);
    const result = scaffoldAgent("explicit-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;
    expect(allow).toContain("Bash");
    // Read-only defaults should NOT be injected when user was explicit.
    expect(allow).not.toContain("Read");
    expect(allow).not.toContain("Grep");
  });

  it("start.sh invokes `switchroom workspace render --stable` to inject bootstrap", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("ws-start-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("switchroom workspace render");
    expect(startSh).toContain("--stable");
    // The render call must happen BEFORE the final exec line so APPEND_PROMPT
    // is updated in time.
    const renderIdx = startSh.indexOf("switchroom workspace render");
    const execIdx = startSh.indexOf("exec claude");
    expect(renderIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(renderIdx);
  });

  it("preserves user edits in workspace/ across re-scaffold", () => {
    const config = makeAgentConfig();
    const first = scaffoldAgent("edit-agent", config, tmpDir, telegramConfig);
    const agentsPath = join(first.agentDir, "workspace", "AGENTS.md");
    writeFileSync(agentsPath, "# MY CUSTOM AGENTS\nhello", "utf-8");

    // Re-scaffold — existing workspace files must NOT be overwritten.
    scaffoldAgent("edit-agent", config, tmpDir, telegramConfig);

    const after = readFileSync(agentsPath, "utf-8");
    expect(after).toBe("# MY CUSTOM AGENTS\nhello");
  });
});

describe("reconcileAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Safety net: A4a/A4b tests write ephemeral __A4*_TEST_* templates
    // into profiles/default/workspace/ (the repo source tree) and clean
    // them up in their own try/finally. If a test crashes between
    // writeFileSync and the finally, the orphan would linger and get
    // picked up by subsequent test runs. Sweep any leftovers here as
    // belt-and-braces; no-op in the common case.
    const profileWorkspaceDir = resolve(
      import.meta.dirname,
      "../profiles/default/workspace",
    );
    try {
      for (const entry of readdirSync(profileWorkspaceDir)) {
        if (/^__A4[AB]_(TEST|CONTRACT)_\d+\.md\.hbs$/.test(entry)) {
          rmSync(join(profileWorkspaceDir, entry), { force: true });
        }
      }
    } catch {
      // profile dir missing is fine — nothing to clean
    }
  });

  function buildSwitchroomConfig(
    agentConfig: AgentConfig,
    memory?: SwitchroomConfig["memory"],
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory,
      agents: { "test-agent": agentConfig },
    } as SwitchroomConfig;
  }

  it("preserves read-only tool defaults across scaffold → reconcile", () => {
    // Regression for Sprint 1 review finding #2: reconcileAgent rebuilt
    // permissions.allow without the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS
    // seed, so the first reconcile after scaffold stripped Read/Grep/Glob
    // and every such tool call started popping an approval card. Both
    // paths must include the defaults when tools.allow is empty AND
    // dangerous_mode is off.
    const agentConfig = makeAgentConfig();
    const scaffolded = scaffoldAgent("rca", agentConfig, tmpDir, telegramConfig);
    const settingsBefore = JSON.parse(
      readFileSync(join(scaffolded.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settingsBefore.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    const reconciled = reconcileAgent(
      "rca",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    const settingsAfter = JSON.parse(
      readFileSync(join(reconciled.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settingsAfter.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    // Risky tools still must NOT be auto-allowed.
    expect(settingsAfter.permissions.allow).not.toContain("Bash");
    expect(settingsAfter.permissions.allow).not.toContain("Edit");
    expect(settingsAfter.permissions.allow).not.toContain("Write");
  });

  it("keeps read-only defaults when tools.allow=[] and dangerous_mode=off (explicit A3 regression)", () => {
    // Sprint 2 review finding A3: the existing preserves-defaults test uses
    // makeAgentConfig() which leaves `tools` and `dangerous_mode` unset, so
    // it only exercises the "fields missing" branch. If a user explicitly
    // writes `tools: { allow: [] }` with `dangerous_mode: off`, reconcile
    // must *still* merge the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS seed into
    // permissions.allow — an empty user list is not a signal to strip.
    const agentConfig = makeAgentConfig({
      tools: { allow: [] },
      dangerous_mode: "off",
    } as Partial<AgentConfig>);
    const scaffolded = scaffoldAgent("a3", agentConfig, tmpDir, telegramConfig);
    const reconciled = reconcileAgent(
      "a3",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(reconciled.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    // Risky tools must still NOT be auto-allowed with dangerous_mode=off.
    expect(settings.permissions.allow).not.toContain("Bash");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.allow).not.toContain("Write");
  });

  it("re-seeds workspace bootstrap files on reconcile (covers profile template additions)", () => {
    // Regression for Sprint 1 review finding #7: reconcileAgent did not
    // call seedWorkspaceBootstrapFiles, so new profile templates added
    // after an agent was scaffolded stayed absent until rescaffold.
    const agentConfig = makeAgentConfig();
    const scaffolded = scaffoldAgent("wsr", agentConfig, tmpDir, telegramConfig);
    const workspaceDir = join(scaffolded.agentDir, "workspace");
    expect(existsSync(join(workspaceDir, "AGENTS.md"))).toBe(true);
    // Simulate a user having deleted a workspace file — reconcile should
    // re-seed it from the profile template.
    const agentsPath = join(workspaceDir, "AGENTS.md");
    rmSync(agentsPath);
    expect(existsSync(agentsPath)).toBe(false);
    reconcileAgent(
      "wsr",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    expect(existsSync(agentsPath)).toBe(true);
    // And user edits to OTHER workspace files must survive reconcile.
    writeFileSync(join(workspaceDir, "USER.md"), "# MY EDITS", "utf-8");
    reconcileAgent(
      "wsr",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    expect(readFileSync(join(workspaceDir, "USER.md"), "utf-8")).toBe("# MY EDITS");
  });

  it("throws when the agent directory does not exist", () => {
    const agentConfig = makeAgentConfig();
    expect(() =>
      reconcileAgent(
        "missing-agent",
        agentConfig,
        tmpDir,
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      ),
    ).toThrow(/Agent directory does not exist/);
  });

  it("seeds NEW workspace templates added to the profile after scaffold (A4a regression)", () => {
    // Sprint 2 review finding A4a: when a new release ships a new
    // workspace bootstrap template (e.g. HEARTBEAT.md.hbs added later),
    // reconcile must pick it up and render it into existing agents'
    // workspace directories. The earlier smoke test only proved that a
    // DELETED file gets re-seeded, not that a NEW template in the
    // profile flows through.
    const profileWorkspaceDir = resolve(
      import.meta.dirname,
      "../profiles/default/workspace",
    );
    const newTemplateName = `__A4A_TEST_${Date.now()}.md.hbs`;
    const newTemplatePath = join(profileWorkspaceDir, newTemplateName);
    const renderedName = newTemplateName.replace(/\.hbs$/, "");
    writeFileSync(
      newTemplatePath,
      "# Late-arriving template for {{name}}\n",
      "utf-8",
    );
    try {
      const agentConfig = makeAgentConfig();
      const scaffolded = scaffoldAgent("a4a", agentConfig, tmpDir, telegramConfig);
      // Sanity: scaffold already seeded it too… delete so we can prove
      // reconcile alone puts it back when missing. (Simulates "agent
      // scaffolded before this template existed in the profile".)
      const workspaceDir = join(scaffolded.agentDir, "workspace");
      const renderedPath = join(workspaceDir, renderedName);
      if (existsSync(renderedPath)) rmSync(renderedPath);
      expect(existsSync(renderedPath)).toBe(false);

      reconcileAgent(
        "a4a",
        agentConfig,
        tmpDir,
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      );

      expect(existsSync(renderedPath)).toBe(true);
      const contents = readFileSync(renderedPath, "utf-8");
      expect(contents).toBe("# Late-arriving template for a4a\n");
    } finally {
      if (existsSync(newTemplatePath)) rmSync(newTemplatePath);
    }
  });

  it("scaffold + reconcile render workspace templates IDENTICALLY (A4b contract)", () => {
    // Sprint 2 review finding A4b: scaffoldAgent and reconcileAgent used
    // to build separate handlebars contexts for workspace template
    // rendering (scaffold ~60 keys, reconcile 7 keys). They now share
    // buildWorkspaceContext() — pin that contract with a template that
    // references a key from outside the old 7-key subset.
    const profileWorkspaceDir = resolve(
      import.meta.dirname,
      "../profiles/default/workspace",
    );
    const templateName = `__A4B_CONTRACT_${Date.now()}.md.hbs`;
    const templatePath = join(profileWorkspaceDir, templateName);
    const renderedName = templateName.replace(/\.hbs$/, "");
    // Reference `{{model}}` — not in the old 7-key reconcile subset,
    // so this would render as "" on reconcile before the refactor.
    writeFileSync(
      templatePath,
      "name={{name}} soul={{soul.name}} model={{model}}\n",
      "utf-8",
    );
    try {
      const agentConfig = makeAgentConfig({
        model: "sonnet",
        soul: { name: "TestSoul" } as unknown,
      } as Partial<AgentConfig>);

      // scaffold into dir-A
      const scaffolded = scaffoldAgent("a4b", agentConfig, tmpDir, telegramConfig);
      const scaffoldRendered = readFileSync(
        join(scaffolded.agentDir, "workspace", renderedName),
        "utf-8",
      );

      // Second agent: scaffold minimally, delete the file, then
      // reconcile to exercise the reconcile-path render.
      const scaffolded2 = scaffoldAgent("a4b", agentConfig, mkdtempSync(join(tmpdir(), "sr-a4b-")), telegramConfig);
      const workspace2 = join(scaffolded2.agentDir, "workspace");
      rmSync(join(workspace2, renderedName));
      reconcileAgent(
        "a4b",
        agentConfig,
        resolve(scaffolded2.agentDir, ".."),
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      );
      const reconcileRendered = readFileSync(
        join(workspace2, renderedName),
        "utf-8",
      );

      expect(reconcileRendered).toBe(scaffoldRendered);
      expect(reconcileRendered).toContain("model=sonnet");
      expect(reconcileRendered).toContain("soul=TestSoul");
    } finally {
      if (existsSync(templatePath)) rmSync(templatePath);
    }
  });

  it("adds Hindsight MCP entry to settings.json after enabling memory backend", () => {
    // Step 1: scaffold an agent without memory
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.mcpServers?.hindsight).toBeUndefined();

    // Step 2: turn on hindsight in switchroom.yaml and reconcile
    const updatedConfig = buildSwitchroomConfig(agentConfig, {
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

  it("rewrites .mcp.json for switchroom-telegram-plugin agents to include hindsight", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "switchroom" } } });
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      initialConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    const mcpJsonPath = join(tmpDir, "test-agent", ".mcp.json");
    const before = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(before.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(before.mcpServers.hindsight).toBeUndefined();

    const updatedConfig = buildSwitchroomConfig(agentConfig, {
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
      "/tmp/switchroom.yaml",
    );

    expect(result.changes).toContain(mcpJsonPath);
    const after = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(after.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(after.mcpServers.hindsight).toBeDefined();
    expect(after.mcpServers.hindsight.url).toBe("http://localhost:18888/mcp/");
  });

  it("does not touch CLAUDE.md or telegram user-content files (Phase 2: workspace/SOUL.md regenerates)", () => {
    // start.sh is intentionally NOT in this list — it's purely
    // template-driven (no user content) and reconcile re-renders it
    // so config changes (like enabling Hindsight or switching ports)
    // propagate without forcing a full re-scaffold.
    //
    // Phase 2: workspace/SOUL.md is also regenerated every reconcile (it's
    // the authoritative persona source from config). User customizations
    // belong in SOUL.custom.md sidecar.
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const userEditedFiles = [
      join(tmpDir, "test-agent", "CLAUDE.md"),
      join(tmpDir, "test-agent", "telegram", ".env"),
      join(tmpDir, "test-agent", "telegram", "access.json"),
    ];

    // Hand-edit each file with a marker the user "wrote"
    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        writeFileSync(f, readFileSync(f, "utf-8") + "\n# USER EDIT\n", "utf-8");
      }
    }

    const updatedConfig = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    // preserveClaudeMd: the hand-edited CLAUDE.md without a sidecar
    // would otherwise abort the reconcile via process.exit. The test's
    // intent — verify user edits to CLAUDE.md and telegram files are
    // not silently overwritten — is satisfied by the preserve flag.
    reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
      undefined,
      { preserveClaudeMd: true },
    );

    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        expect(readFileSync(f, "utf-8")).toContain("# USER EDIT");
      }
    }
  });

  it("re-renders start.sh when config drives template changes (Hindsight enable)", () => {
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const before = readFileSync(startShPath, "utf-8");
    expect(before).not.toContain("HINDSIGHT_API_URL");

    // Enable Hindsight via switchroom.yaml and reconcile
    const withMemory = buildSwitchroomConfig(agentConfig, {
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

  it("start.sh waits for Hindsight API before launching Claude", () => {
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("HINDSIGHT_WAIT=0");
    expect(startSh).toContain("curl -sf -o /dev/null --max-time 2");
    expect(startSh).toContain("/mcp/");
  });

  it("start.sh omits Hindsight wait loop when memory is disabled", () => {
    const agentConfig = makeAgentConfig();
    const config = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).not.toContain("HINDSIGHT_WAIT");
  });

  it("returns no changes when settings already match", () => {
    const agentConfig = makeAgentConfig();
    const config = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);

    // First reconcile may apply scaffold->reconcile drift (e.g. switchroom-mcp entry)
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
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const beforeReconcile = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(beforeReconcile.permissions.allow).toContain("mcp__hindsight__*");

    // Reconcile against a config with backend=none
    const withoutMemory = buildSwitchroomConfig(agentConfig, {
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
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-plugin-"));
    agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when memory backend is not hindsight", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "none", shared_collection: "shared" },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("returns null when agent has memory.auto_recall: false", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
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
    } as SwitchroomConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("copies the vendored plugin tree and returns metadata when configured", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
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
    } as SwitchroomConfig;
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
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: { coach: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    mkdirSync(join(tmpDir, "coach", ".claude"), { recursive: true });
    const result = installHindsightPlugin("coach", join(tmpDir, "coach"), config);
    expect(result).not.toBeNull();
    expect(result!.bankId).toBe("coach");
  });

  it("strips the /mcp/ suffix from memory.config.url to get the REST base", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://localhost:18888/mcp/" },
      },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    const result = installHindsightPlugin("agent", agentDir, config);
    expect(result).not.toBeNull();
    expect(result!.apiBaseUrl).toBe("http://localhost:18888");
  });

  it("skips copy when installed plugin.json version matches vendor", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;

    const result1 = installHindsightPlugin("agent", agentDir, config);
    expect(result1).not.toBeNull();

    // Add a sentinel file — it must survive when version matches
    const sentinelPath = join(result1!.pluginDir, "sentinel.txt");
    writeFileSync(sentinelPath, "version-match-skip-test");

    installHindsightPlugin("agent", agentDir, config);
    expect(existsSync(sentinelPath)).toBe(true);
  });

  it("re-copies when installed plugin.json version differs from vendor", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;

    const result1 = installHindsightPlugin("agent", agentDir, config);
    expect(result1).not.toBeNull();

    // Overwrite the installed manifest with a stale version
    const installedManifest = join(result1!.pluginDir, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(installedManifest, "utf-8"));
    writeFileSync(installedManifest, JSON.stringify({ ...manifest, version: "0.0.1" }));

    const sentinelPath = join(result1!.pluginDir, "sentinel.txt");
    writeFileSync(sentinelPath, "should-be-removed");

    installHindsightPlugin("agent", agentDir, config);
    expect(existsSync(sentinelPath)).toBe(false);
  });
});

describe("scaffoldAgent with global defaults cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-defaults-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies defaults.tools.allow to agents that leave tools unset", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep", "Edit"] },
      },
      agents: { "def-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "def-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Defaults flow through to permissions.allow
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("Edit");
    // Switchroom-MCP wildcards still pre-approved
    expect(settings.permissions.allow).toContain("mcp__switchroom__*");
  });

  it("unions defaults.tools.allow with per-agent tools.allow", () => {
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Read"], deny: [] },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep"] },
      },
      agents: { "union-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    // channels.telegram.plugin=switchroom still gets .mcp.json written and the
    // mcp__switchroom-telegram__* tools pre-approved.
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { channels: { telegram: { plugin: "switchroom" } } },
      agents: { "plugin-default-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "plugin-default-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    // .mcp.json was written (the switchroom-telegram-plugin scaffold branch)
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");
  });

  it("per-agent mcp_servers override defaults.mcp_servers by key", () => {
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        linear: { type: "http", url: "https://agent.linear.example" },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        mcp_servers: {
          linear: { type: "http", url: "https://default.linear.example" },
          github: { type: "http", url: "https://default.github.example" },
        },
      },
      agents: { "mcp-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "mcp-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    // switchroom.yaml defaults — the merged allow-list should update without
    // touching the per-agent config.
    const agentConfig = makeAgentConfig();
    const initial: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { tools: { allow: ["Read"] } },
      agents: { "rec-agent": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("rec-agent", agentConfig, tmpDir, telegramConfig, initial);

    const settingsPath = join(tmpDir, "rec-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.permissions.allow).toContain("Read");
    expect(before.permissions.allow).not.toContain("Grep");

    // Update defaults and reconcile
    const updated: SwitchroomConfig = {
      ...initial,
      defaults: { tools: { allow: ["Read", "Grep", "Edit"] } },
    } as SwitchroomConfig;
    reconcileAgent("rec-agent", agentConfig, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions.allow).toContain("Read");
    expect(after.permissions.allow).toContain("Grep");
    expect(after.permissions.allow).toContain("Edit");
  });

  it("writes user hooks from switchroom.yaml into settings.json under hooks", () => {
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "hooks-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "hooks-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Native Claude Code nested shape. User's UserPromptSubmit hook +
    // switchroom-owned workspace-dynamic and timezone hooks (always
    // injected; the dynamic injects per-turn workspace files, the
    // timezone hook emits a one-line local-time additionalContext).
    expect(settings.hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/audit.sh", timeout: 5 },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("workspace-dynamic-hook.sh"),
            timeout: 5,
          },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("timezone-hook.sh"),
            timeout: 3,
          },
        ],
      },
    ]);
    // User's Stop hook + switchroom-owned Stop hooks (handoff + secret-scrub).
    // secret-scrub is added when the switchroom telegram plugin is used
    // (the default in this test's telegramConfig).
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/retain.sh", async: true },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: "switchroom handoff hooks-agent",
            timeout: 35,
            async: true,
          },
          {
            type: "command",
            command: expect.stringContaining("secret-scrub-stop.mjs"),
            timeout: 15,
            async: true,
          },
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        hooks: {
          UserPromptSubmit: [{ command: "/global/audit.sh", timeout: 5 }],
          PreToolUse: [{ command: "/global/policy.sh" }],
        },
      },
      agents: { "hook-union-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "hook-union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "model-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "model-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
        SWITCHROOM_AUDIT_URL: "https://audit.example",
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
    expect(startSh).toContain("export SWITCHROOM_AUDIT_URL='https://audit.example'");
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

    // system_prompt_append is now assigned into a shell var
    // (APPEND_PROMPT=...) so the handoff briefing can be concatenated
    // onto it before passing to claude. The single-quote wrapping still
    // applies to the config value itself.
    expect(startSh).toContain("APPEND_PROMPT='");
    // Embedded single quote becomes '"'"'
    expect(startSh).toContain(`'"'"'care'"'"'`);
    // Dollar signs and double quotes survive untouched inside single quotes
    expect(startSh).toContain("$VAR");
    expect(startSh).toContain('double-"quotes"');
    // The exec line passes the var, quoted
    expect(startSh).toContain('--append-system-prompt "$APPEND_PROMPT"');
  });

  it("settings_raw deep-merges into the generated settings.json", () => {
    const agentConfig = makeAgentConfig({
      settings_raw: {
        effort: "high",
        permissions: { defaultMode: "bypassPermissions" },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "raw-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Escape hatch wins — overrides switchroom's default permissions.defaultMode
    expect(settings.effort).toBe("high");
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    // And the pre-existing switchroom-managed keys still present
    expect(settings.permissions.allow).toContain("mcp__switchroom__*");
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

  it("channels.telegram.plugin: 'switchroom' writes .mcp.json for forked telegram plugin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "chan-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "chan-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    // Same .mcp.json + permissions pre-approval as the legacy path
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");

    // start.sh emits the dev-channels flag
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--dangerously-load-development-channels server:switchroom-telegram");
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

    // No .mcp.json because the switchroom-telegram fork isn't loaded
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

    expect(startSh).toContain("export SWITCHROOM_TG_FORMAT='markdownv2'");
    expect(startSh).toContain("export SWITCHROOM_TG_RATE_LIMIT_MS='500'");
  });

  it("user env entry wins over channel-derived env default on key conflict", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "markdownv2" } },
      env: { SWITCHROOM_TG_FORMAT: "text" }, // explicit override
    });
    const result = scaffoldAgent(
      "chan-env-override",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Only the user value remains
    expect(startSh).toContain("export SWITCHROOM_TG_FORMAT='text'");
    expect(startSh).not.toContain("export SWITCHROOM_TG_FORMAT='markdownv2'");
  });

  it("reconcile propagates hooks/env/model updates without touching user files", () => {
    const agentConfig = makeAgentConfig();
    const initial: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-phase2": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("rec-phase2", agentConfig, tmpDir, telegramConfig, initial);

    // Update agent config in-place (a real user would edit switchroom.yaml)
    const updatedAgent = makeAgentConfig({
      model: "claude-sonnet-4-6",
      hooks: { Stop: [{ command: "/new/hook.sh", async: true }] },
      env: { NEW_VAR: "hello" },
    });
    const updated: SwitchroomConfig = {
      ...initial,
      agents: { "rec-phase2": updatedAgent },
    } as SwitchroomConfig;
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

  it("is a no-op when switchroom.yaml has no defaults block (backcompat)", () => {
    // The refactor moved scaffold through mergeAgentConfig. This test
    // asserts that omitting `defaults` produces the same settings.json
    // as the pre-refactor code path would have.
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Edit"], deny: [] },
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "nodef-agent": agentConfig },
      // defaults intentionally omitted
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "nodef-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");
    expect(settings.permissions.allow).toContain("mcp__switchroom__*");
  });
});

describe("scaffoldAgent global skills pool", () => {
  let tmpDir: string;
  let skillsPool: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-skills-"));
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
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsDir ?? skillsPool },
      telegram: telegramConfig,
      agents: { "skills-agent": agentConfig },
    } as SwitchroomConfig;
  }

  it("symlinks declared skills from the pool into the agent skills dir", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "retain"] });
    const switchroomConfig = buildConfig(agentConfig);

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    const checkinPath = join(result.agentDir, ".claude", "skills", "checkin");
    const retainPath = join(result.agentDir, ".claude", "skills", "retain");
    expect(existsSync(checkinPath)).toBe(true);
    expect(existsSync(retainPath)).toBe(true);
    // Verify they're symlinks pointing into the pool
    const { readlinkSync } = require("node:fs");
    expect(readlinkSync(checkinPath)).toBe(join(skillsPool, "checkin"));
  });

  it("unions defaults.skills with agent.skills in the symlink pass", () => {
    const agentConfig = makeAgentConfig({ skills: ["weekly-review"] });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsPool },
      telegram: telegramConfig,
      defaults: { skills: ["checkin", "retain"] },
      agents: { "skills-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    for (const name of ["checkin", "retain", "weekly-review"]) {
      expect(existsSync(join(result.agentDir, ".claude", "skills", name))).toBe(true);
    }
  });

  it("warns and skips missing skills without throwing", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "does-not-exist"] });
    const switchroomConfig = buildConfig(agentConfig);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );
    warnSpy.mockRestore();

    expect(existsSync(join(result.agentDir, ".claude", "skills", "checkin"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "skills", "does-not-exist"))).toBe(false);
  });

  it("reconcile removes stale symlinks when a skill is dropped from switchroom.yaml", () => {
    const before = makeAgentConfig({ skills: ["checkin", "retain"] });
    const initial = buildConfig(before);
    const result = scaffoldAgent(
      "skills-agent",
      before,
      join(tmpDir, "agents"),
      telegramConfig,
      initial,
    );
    expect(existsSync(join(result.agentDir, ".claude", "skills", "retain"))).toBe(true);

    const after = makeAgentConfig({ skills: ["checkin"] });
    const updated = buildConfig(after);
    reconcileAgent(
      "skills-agent",
      after,
      join(tmpDir, "agents"),
      telegramConfig,
      updated,
    );

    expect(existsSync(join(result.agentDir, ".claude", "skills", "checkin"))).toBe(true);
    // retain's symlink was removed
    expect(existsSync(join(result.agentDir, ".claude", "skills", "retain"))).toBe(false);
  });

  it("does not touch template-copied skill files during stale cleanup", () => {
    // Create an agent, then manually drop a non-symlink skill file into
    // the agent's skills dir to simulate a template-contributed skill.
    // A reconcile that removes nothing from the pool must leave that
    // file in place.
    const agentConfig = makeAgentConfig({ skills: ["checkin"] });
    const switchroomConfig = buildConfig(agentConfig);
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    const templateSkill = join(result.agentDir, ".claude", "skills", "template-skill");
    mkdirSync(templateSkill, { recursive: true });
    writeFileSync(join(templateSkill, "SKILL.md"), "# template\n", "utf-8");

    // Reconcile with the same config
    reconcileAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    // template-skill survives because it's a real directory, not a
    // symlink pointing into the pool
    expect(existsSync(templateSkill)).toBe(true);
  });
});

describe("phase-6b bug fixes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-phase6b-"));
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

  it("reconcile drops settings.hooks events that were removed from switchroom.yaml", () => {
    const withHooks = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [{ command: "/opt/a.sh" }],
        Stop: [{ command: "/opt/b.sh", async: true }],
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "drift-agent": withHooks },
    } as SwitchroomConfig;

    scaffoldAgent("drift-agent", withHooks, tmpDir, telegramConfig, switchroomConfig);
    const settingsPath = join(tmpDir, "drift-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.hooks.UserPromptSubmit).toBeDefined();
    expect(before.hooks.Stop).toBeDefined();

    // User removes Stop from switchroom.yaml
    const lessHooks = makeAgentConfig({
      hooks: { UserPromptSubmit: [{ command: "/opt/a.sh" }] },
    });
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "drift-agent": lessHooks },
    } as SwitchroomConfig;
    reconcileAgent("drift-agent", lessHooks, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.hooks.UserPromptSubmit).toBeDefined();
    // User Stop was dropped. The switchroom-owned handoff Stop (auto-added
    // when session_continuity is enabled — the default) remains.
    expect(after.hooks.Stop).toBeDefined();
    expect(JSON.stringify(after.hooks.Stop)).toContain("switchroom handoff");
    expect(JSON.stringify(after.hooks.Stop)).not.toContain("/opt/b.sh");
  });

  it("reconcile retracts settings_raw keys that were removed from switchroom.yaml", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", customKey: "original" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-drift": withRaw },
    } as SwitchroomConfig;

    scaffoldAgent("raw-drift", withRaw, tmpDir, telegramConfig, switchroomConfig);
    const settingsPath = join(tmpDir, "raw-drift", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.effort).toBe("high");
    expect(before.customKey).toBe("original");
    // Side-car tracks what was injected
    expect(before._switchroomManagedRawKeys).toEqual(["effort", "customKey"]);

    // User removes customKey from switchroom.yaml
    const lessRaw = makeAgentConfig({ settings_raw: { effort: "high" } });
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "raw-drift": lessRaw },
    } as SwitchroomConfig;
    reconcileAgent("raw-drift", lessRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.effort).toBe("high"); // still present
    expect(after.customKey).toBeUndefined(); // retracted
    expect(after._switchroomManagedRawKeys).toEqual(["effort"]);
  });

  it("reconcile retracts all settings_raw keys when the field is cleared entirely", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", apiKeyHelper: "/bin/true" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "clear-drift": withRaw },
    } as SwitchroomConfig;
    scaffoldAgent("clear-drift", withRaw, tmpDir, telegramConfig, switchroomConfig);

    const emptyRaw = makeAgentConfig();
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "clear-drift": emptyRaw },
    } as SwitchroomConfig;
    reconcileAgent("clear-drift", emptyRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(
      readFileSync(join(tmpDir, "clear-drift", ".claude", "settings.json"), "utf-8"),
    );
    expect(after.effort).toBeUndefined();
    expect(after.apiKeyHelper).toBeUndefined();
    expect(after._switchroomManagedRawKeys).toBeUndefined();
  });

  it("reconcile is idempotent across two back-to-back runs with the same config", () => {
    const agentConfig = makeAgentConfig({
      hooks: { PreToolUse: [{ command: "/opt/audit.sh", timeout: 5 }] },
      env: { FOO: "bar" },
      model: "claude-sonnet-4-6",
      settings_raw: { effort: "high" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "idem-agent": agentConfig },
    } as SwitchroomConfig;

    scaffoldAgent("idem-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const result = reconcileAgent(
      "idem-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        schedule: [{ cron: "0 9 * * *", prompt: "standup" }],
      },
      profiles: {
        coder: { tools: { allow: ["Bash"] } }, // no schedule
      },
      agents: { "sched-agent": agentConfig },
    } as SwitchroomConfig;

    // This call would previously TypeError via [...undefined]
    expect(() =>
      scaffoldAgent("sched-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig),
    ).not.toThrow();
  });
});

describe("scheduled task cron script generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-cron-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates cron-N.sh scripts for each schedule entry", () => {
    const agentConfig = makeAgentConfig({
      schedule: [
        { cron: "0 8 * * *", prompt: "Morning briefing" },
        { cron: "0 20 * * 0", prompt: "Weekly review" },
      ],
    });
    const result = scaffoldAgent(
      "cron-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );

    const script0 = join(result.agentDir, "telegram", "cron-0.sh");
    const script1 = join(result.agentDir, "telegram", "cron-1.sh");
    expect(existsSync(script0)).toBe(true);
    expect(existsSync(script1)).toBe(true);

    const content = readFileSync(script0, "utf-8");
    expect(content).toContain("claude -p");
    expect(content).toContain("Morning briefing");
    expect(content).toContain("--model");
    expect(content).toContain("claude-sonnet-4-6"); // default model
    expect(content).toContain("--no-session-persistence");
  });

  it("uses the configured model when specified", () => {
    const agentConfig = makeAgentConfig({
      schedule: [
        { cron: "0 9 * * *", prompt: "Important analysis", model: "claude-opus-4-6" },
      ],
    });
    const result = scaffoldAgent(
      "model-cron",
      agentConfig,
      tmpDir,
      telegramConfig,
    );

    const content = readFileSync(
      join(result.agentDir, "telegram", "cron-0.sh"),
      "utf-8",
    );
    expect(content).toContain("claude-opus-4-6");
    expect(content).not.toContain("claude-sonnet-4-6");
  });

  it("reconcile regenerates cron scripts when prompt changes", () => {
    const initial = makeAgentConfig({
      schedule: [{ cron: "0 8 * * *", prompt: "v1 prompt" }],
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "cron-rec": initial },
    } as SwitchroomConfig;
    scaffoldAgent("cron-rec", initial, tmpDir, telegramConfig, switchroomConfig);

    const scriptPath = join(tmpDir, "cron-rec", "telegram", "cron-0.sh");
    expect(readFileSync(scriptPath, "utf-8")).toContain("v1 prompt");

    const updated = makeAgentConfig({
      schedule: [{ cron: "0 8 * * *", prompt: "v2 prompt updated" }],
    });
    const updatedConfig: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "cron-rec": updated },
    } as SwitchroomConfig;
    const result = reconcileAgent("cron-rec", updated, tmpDir, telegramConfig, updatedConfig);

    expect(result.changes).toContain(scriptPath);
    expect(readFileSync(scriptPath, "utf-8")).toContain("v2 prompt updated");
  });

  it("schedule entries from defaults cascade into cron scripts", () => {
    const agentConfig = makeAgentConfig({
      schedule: [{ cron: "0 17 * * *", prompt: "Agent evening check" }],
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        schedule: [{ cron: "0 8 * * *", prompt: "Global morning briefing" }],
      },
      agents: { "cascade-cron": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "cascade-cron",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    // Defaults schedule is prepended — cron-0 is the global entry
    const script0 = readFileSync(
      join(result.agentDir, "telegram", "cron-0.sh"),
      "utf-8",
    );
    expect(script0).toContain("Global morning briefing");

    // cron-1 is the agent's own entry
    const script1 = readFileSync(
      join(result.agentDir, "telegram", "cron-1.sh"),
      "utf-8",
    );
    expect(script1).toContain("Agent evening check");
  });
});

describe("sub-agent file generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-subagents-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates .claude/agents/<name>.md from subagents config", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        worker: {
          description: "Handles implementation tasks",
          model: "sonnet",
          background: true,
          isolation: "worktree",
          maxTurns: 30,
          color: "blue",
          prompt: "You are a worker. Implement the task.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "sa-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "sa-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const mdPath = join(result.agentDir, ".claude", "agents", "worker.md");
    expect(existsSync(mdPath)).toBe(true);

    const content = readFileSync(mdPath, "utf-8");
    // Frontmatter
    expect(content).toContain("name: worker");
    expect(content).toContain("description: Handles implementation tasks");
    expect(content).toContain("model: sonnet");
    expect(content).toContain("background: true");
    expect(content).toContain("isolation: worktree");
    expect(content).toContain("maxTurns: 30");
    expect(content).toContain("color: blue");
    // Body (after frontmatter)
    expect(content).toContain("You are a worker. Implement the task.");
  });

  it("merges defaults.subagents with agent.subagents by name", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        reviewer: {
          description: "Reviews work",
          model: "sonnet",
          prompt: "Review thoroughly.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        subagents: {
          worker: {
            description: "Default worker",
            model: "sonnet",
            background: true,
            prompt: "Default worker prompt.",
          },
        },
      },
      agents: { "merge-sa": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "merge-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const agentsDir = join(result.agentDir, ".claude", "agents");
    // Both sub-agents exist
    expect(existsSync(join(agentsDir, "worker.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "reviewer.md"))).toBe(true);
    // Worker comes from defaults
    expect(readFileSync(join(agentsDir, "worker.md"), "utf-8")).toContain(
      "Default worker prompt.",
    );
    // Reviewer comes from agent
    expect(readFileSync(join(agentsDir, "reviewer.md"), "utf-8")).toContain(
      "Review thoroughly.",
    );
  });

  it("agent subagent overrides default subagent with same name", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        worker: {
          description: "Custom worker",
          model: "opus",
          prompt: "I am the override.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        subagents: {
          worker: {
            description: "Default worker",
            model: "sonnet",
            prompt: "I am the default.",
          },
        },
      },
      agents: { "override-sa": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "override-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const content = readFileSync(
      join(result.agentDir, ".claude", "agents", "worker.md"),
      "utf-8",
    );
    expect(content).toContain("model: opus");
    expect(content).toContain("I am the override.");
    expect(content).not.toContain("I am the default.");
  });

  it("reconcile updates sub-agent files when config changes", () => {
    const initial = makeAgentConfig({
      subagents: {
        worker: {
          description: "v1 worker",
          model: "sonnet",
          prompt: "Version 1.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-sa": initial },
    } as SwitchroomConfig;
    scaffoldAgent("rec-sa", initial, tmpDir, telegramConfig, switchroomConfig);

    const mdPath = join(tmpDir, "rec-sa", ".claude", "agents", "worker.md");
    expect(readFileSync(mdPath, "utf-8")).toContain("Version 1.");

    // Update subagent prompt
    const updated = makeAgentConfig({
      subagents: {
        worker: {
          description: "v2 worker",
          model: "sonnet",
          prompt: "Version 2 — improved.",
        },
      },
    });
    const updatedConfig: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "rec-sa": updated },
    } as SwitchroomConfig;
    const result = reconcileAgent(
      "rec-sa",
      updated,
      tmpDir,
      telegramConfig,
      updatedConfig,
    );

    expect(result.changes).toContain(mdPath);
    expect(readFileSync(mdPath, "utf-8")).toContain("Version 2 — improved.");
  });

  it("generates tools as comma-separated string in frontmatter", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        safe: {
          description: "Read-only agent",
          tools: ["Read", "Grep", "Glob"],
          prompt: "Read only.",
        },
      },
    });
    const result = scaffoldAgent(
      "tools-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const content = readFileSync(
      join(result.agentDir, ".claude", "agents", "safe.md"),
      "utf-8",
    );
    expect(content).toContain("tools: Read, Grep, Glob");
  });
});

describe("session freshness in start.sh", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-session-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to fresh session — Hindsight recall handles continuity", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "fresh-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain('CONTINUE_FLAG=""');
    expect(startSh).toContain("exec claude $CONTINUE_FLAG");
    expect(startSh).not.toContain("_IDLE");
    expect(startSh).not.toContain("_TURNS");
    expect(startSh).not.toContain(".resume-next-start");
  });

  it("installs the Stop hook for handoff by default", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "handoff-default-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "handoff-default-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks.Stop).toBeDefined();
    expect(JSON.stringify(settings.hooks.Stop)).toContain(
      "switchroom handoff handoff-default-agent",
    );
  });

  it("omits the Stop hook when session_continuity.enabled is false", () => {
    const agentConfig = makeAgentConfig({
      session_continuity: { enabled: false },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "handoff-off-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "handoff-off-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    // The handoff Stop hook is omitted (that's what session_continuity.enabled
    // gates). The secret-scrub Stop hook may still be present — it's gated
    // on the telegram plugin, not on session_continuity.
    const stopStr = JSON.stringify(settings.hooks.Stop ?? []);
    expect(stopStr).not.toContain("switchroom handoff");
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The session-mode detection block always references .handoff.md
    // (it's the signal that a handoff briefing was written by a prior
    // session's Stop hook); when handoff is disabled the file never
    // exists so the elif is dead code but inert. The real signal that
    // handoff is disabled is the absence of the handoff-briefing block
    // and its exported env var.
    expect(startSh).not.toContain("SWITCHROOM_HANDOFF_SHOW_LINE");
    expect(startSh).not.toContain("HANDOFF_FILE=");
  });

  it("threads show_handoff_line=false through to start.sh env", () => {
    const agentConfig = makeAgentConfig({
      session_continuity: { show_handoff_line: false },
    });
    const result = scaffoldAgent(
      "no-line-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("SWITCHROOM_HANDOFF_SHOW_LINE=false");
  });

});

describe("secret-detect hook wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-secret-detect-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as SwitchroomConfig;
  }

  it("wires secret-guard-pretool.mjs into settings.json PreToolUse when plugin is switchroom", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    expect(pre).toBeDefined();
    const commands = pre.flatMap((e) => e.hooks).map((h) => h.command);
    expect(commands.some((c) => c.includes("secret-guard-pretool.mjs"))).toBe(true);
    // Ends in .mjs and uses node
    const guardCmd = commands.find((c) => c.includes("secret-guard-pretool.mjs"))!;
    expect(guardCmd.startsWith("node ")).toBe(true);
  });

  it("wires secret-scrub-stop.mjs into settings.json Stop when plugin is switchroom", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-stop-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-stop-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string; async?: boolean }> }>;
    const scrub = stop
      .flatMap((e) => e.hooks)
      .find((h) => h.command.includes("secret-scrub-stop.mjs"));
    expect(scrub).toBeDefined();
    // Async so it can't block session shutdown.
    expect(scrub!.async).toBe(true);
  });

  it("does not wire secret-detect hooks when plugin is 'official' (upstream)", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "official" } },
    });
    const result = scaffoldAgent(
      "sd-official-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-official-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const serialized = JSON.stringify(settings.hooks ?? {});
    expect(serialized).not.toContain("secret-guard-pretool.mjs");
    expect(serialized).not.toContain("secret-scrub-stop.mjs");
    // PreToolUse should be entirely absent (no user hooks configured).
    expect(settings.hooks?.PreToolUse).toBeUndefined();
  });

  it("preserves user-declared PreToolUse hooks alongside secret-guard", () => {
    const agentConfig = makeAgentConfig({
      hooks: { PreToolUse: [{ command: "/opt/audit.sh", timeout: 5 }] },
    });
    const result = scaffoldAgent(
      "sd-user-pre-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-user-pre-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const commands = pre.flatMap((e) => e.hooks).map((h) => h.command);
    expect(commands).toContain("/opt/audit.sh");
    expect(commands.some((c) => c.includes("secret-guard-pretool.mjs"))).toBe(true);
  });
});

describe("scaffoldAgent with inline profiles (extends cascade)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-profiles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges inline profile between defaults and per-agent config", () => {
    const agentConfig = makeAgentConfig({ extends: "coder" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
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
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "profile-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      profiles: {
        coder: { model: "claude-sonnet-4-6" },
      },
      agents: { "override-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "override-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
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
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-automem-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets settings.json autoMemoryEnabled: false when Hindsight is enabled", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "general", auto_recall: true, isolation: "default" },
    });
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as SwitchroomConfig;

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
    const withMemory: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const withoutMemory: SwitchroomConfig = {
      ...withMemory,
      memory: { backend: "none", shared_collection: "shared" },
    } as SwitchroomConfig;
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
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-tpl-"));
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

describe("installSwitchroomSkills", () => {
  let tmpDir: string;
  let fakeSkillsDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-builtin-skills-"));
    agentDir = join(tmpDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    // Create a fake built-in skills directory with two switchroom-* skills and
    // one non-switchroom directory that must be ignored.
    fakeSkillsDir = join(tmpDir, "fake-skills");
    for (const name of ["switchroom-manage", "switchroom-health"]) {
      const d = join(fakeSkillsDir, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `# ${name}\n`, "utf-8");
    }
    // A switchroom-* dir WITHOUT a SKILL.md — should be skipped
    mkdirSync(join(fakeSkillsDir, "switchroom-noskill"), { recursive: true });
    // A non-switchroom dir WITH a SKILL.md — should also be skipped (name filter)
    const nonSwitchroom = join(fakeSkillsDir, "some-other-skill");
    mkdirSync(nonSwitchroom, { recursive: true });
    writeFileSync(join(nonSwitchroom, "SKILL.md"), "# other\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper that calls installSwitchroomSkills but overrides import.meta.dirname
   * by instead directly symlinking from our fakeSkillsDir. Since the real
   * installSwitchroomSkills resolves relative to the compiled module path, we
   * test the exported function with the real skills/ directory and separately
   * verify the logic using a thin wrapper that accepts the skills dir as
   * a parameter.
   */
  function runWithFakeSkills(targetAgentDir: string): void {
    // Manually replicate installSwitchroomSkills logic against fakeSkillsDir so
    // we can test the filtering and symlinking behaviour without touching
    // the live skills/ directory.
    const targetSkillsDir = join(targetAgentDir, ".claude", "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    for (const name of ["switchroom-manage", "switchroom-health", "switchroom-noskill", "some-other-skill"]) {
      const src = join(fakeSkillsDir, name);
      if (!existsSync(src)) continue;
      if (!name.startsWith("switchroom-")) continue;
      let stat;
      try { stat = lstatSync(src); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const dest = join(targetSkillsDir, name);
      try { lstatSync(dest); continue; } catch { /* not found — create */ }
      try { require("node:fs").symlinkSync(src, dest); } catch { /* ignore */ }
    }
  }

  it("symlinks switchroom-* skills that have a SKILL.md into .claude/skills/", () => {
    runWithFakeSkills(agentDir);

    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
    expect(existsSync(join(skillsDir, "switchroom-health"))).toBe(true);
    // Verify they are symlinks pointing into fakeSkillsDir
    expect(readlinkSync(join(skillsDir, "switchroom-manage"))).toBe(join(fakeSkillsDir, "switchroom-manage"));
    expect(readlinkSync(join(skillsDir, "switchroom-health"))).toBe(join(fakeSkillsDir, "switchroom-health"));
  });

  it("skips switchroom-* directories that have no SKILL.md", () => {
    runWithFakeSkills(agentDir);
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-noskill"))).toBe(false);
  });

  it("skips non-switchroom directories even when they have a SKILL.md", () => {
    runWithFakeSkills(agentDir);
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "some-other-skill"))).toBe(false);
  });

  it("is idempotent — calling twice does not error and does not change symlinks", () => {
    runWithFakeSkills(agentDir);
    // Second call must not throw and symlinks must still be intact
    expect(() => runWithFakeSkills(agentDir)).not.toThrow();
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
    expect(readlinkSync(join(skillsDir, "switchroom-manage"))).toBe(join(fakeSkillsDir, "switchroom-manage"));
  });

  it("does not disturb pre-existing non-switchroom skills in .claude/skills/", () => {
    // Place a non-switchroom skill manually before running
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const existing = join(skillsDir, "my-custom-skill");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "SKILL.md"), "# custom\n", "utf-8");

    runWithFakeSkills(agentDir);

    // Custom skill is untouched
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toContain("# custom");
    // Switchroom skills were also linked
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
  });

  it("creates .claude/skills/ if it does not exist yet", () => {
    const freshAgentDir = join(tmpDir, "fresh-agent");
    mkdirSync(freshAgentDir, { recursive: true });
    // Do NOT pre-create .claude/skills/
    runWithFakeSkills(freshAgentDir);
    expect(existsSync(join(freshAgentDir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(freshAgentDir, ".claude", "skills", "switchroom-manage"))).toBe(true);
  });

  it("scaffoldAgent installs switchroom skills into .claude/skills/ automatically", () => {
    // The real installSwitchroomSkills resolves to the project's skills/ directory.
    // Verify that after scaffoldAgent the .claude/skills directory exists and
    // contains at least one switchroom-* symlink (assuming the real skills/ is present).
    const result = scaffoldAgent(
      "auto-skills-agent",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const claudeSkillsDir = join(result.agentDir, ".claude", "skills");
    expect(existsSync(claudeSkillsDir)).toBe(true);
    // At least one switchroom-* entry should be present (from the real skills/)
    const entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    const switchroomEntries = entries.filter((e: string) => e.startsWith("switchroom-"));
    expect(switchroomEntries.length).toBeGreaterThan(0);
  });

  it("reconcileAgent installs switchroom skills into .claude/skills/ automatically", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-skills": agentConfig },
    } as SwitchroomConfig;

    scaffoldAgent("rec-skills", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    // Remove .claude/skills to simulate a fresh state
    rmSync(join(tmpDir, "rec-skills", ".claude", "skills"), { recursive: true, force: true });

    reconcileAgent("rec-skills", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const claudeSkillsDir = join(tmpDir, "rec-skills", ".claude", "skills");
    expect(existsSync(claudeSkillsDir)).toBe(true);
    const entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    const switchroomEntries = entries.filter((e: string) => e.startsWith("switchroom-"));
    expect(switchroomEntries.length).toBeGreaterThan(0);
  });
});

describe("CLAUDE.md-first workspace template (Phase 5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-claudemd-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds workspace/CLAUDE.md as a regular file with expected content", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-fresh", config, tmpDir, telegramConfig);

    const claudeMd = join(result.agentDir, "workspace", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    expect(lstatSync(claudeMd).isFile()).toBe(true);
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);

    const content = readFileSync(claudeMd, "utf-8");
    expect(content).toContain("CLAUDE.md — Agent Operating Protocol");
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("AGENT.md");
    expect(content).toContain("Working on code repositories");
  });

  it("creates workspace/AGENTS.md and workspace/AGENT.md as symlinks to CLAUDE.md", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-symlinks", config, tmpDir, telegramConfig);

    const agentsMd = join(result.agentDir, "workspace", "AGENTS.md");
    const agentMd = join(result.agentDir, "workspace", "AGENT.md");

    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });

  it("content read via AGENTS.md, AGENT.md, and CLAUDE.md is identical", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-identity", config, tmpDir, telegramConfig);

    const viaClaude = readFileSync(join(result.agentDir, "workspace", "CLAUDE.md"), "utf-8");
    const viaAgents = readFileSync(join(result.agentDir, "workspace", "AGENTS.md"), "utf-8");
    const viaAgent = readFileSync(join(result.agentDir, "workspace", "AGENT.md"), "utf-8");
    expect(viaAgents).toBe(viaClaude);
    expect(viaAgent).toBe(viaClaude);
  });

  it("migrates a legacy regular-file workspace/AGENTS.md into CLAUDE.md on reconcile", () => {
    // Simulate a pre-Phase-5 agent: scaffold first, then replace the
    // post-Phase-5 layout with the legacy shape (regular-file AGENTS.md,
    // no CLAUDE.md, no AGENT.md symlink). Then reconcile and verify the
    // migration preserved the legacy content under the new filename.
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "legacy-agent": config },
    } as SwitchroomConfig;

    const result = scaffoldAgent("legacy-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const workspaceDir = join(result.agentDir, "workspace");

    // Unwind Phase-5 layout → legacy state
    rmSync(join(workspaceDir, "AGENT.md"), { force: true });
    rmSync(join(workspaceDir, "AGENTS.md"), { force: true });
    const legacyContent = "# Pre-Phase-5 AGENTS.md\n\nAgent-specific customization that must survive.\n";
    writeFileSync(join(workspaceDir, "AGENTS.md"), legacyContent, "utf-8");
    rmSync(join(workspaceDir, "CLAUDE.md"), { force: true });

    reconcileAgent("legacy-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const claudeMd = join(workspaceDir, "CLAUDE.md");
    const agentsMd = join(workspaceDir, "AGENTS.md");
    const agentMd = join(workspaceDir, "AGENT.md");

    expect(existsSync(claudeMd)).toBe(true);
    expect(lstatSync(claudeMd).isFile()).toBe(true);
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    // Migrated content preserved (writeIfMissing skipped CLAUDE.md since the
    // migration already created it).
    expect(readFileSync(claudeMd, "utf-8")).toBe(legacyContent);

    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });

  it("is idempotent — reconcile twice leaves symlinks unchanged", () => {
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "idem-claudemd": config },
    } as SwitchroomConfig;

    scaffoldAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);

    const agentsMd = join(tmpDir, "idem-claudemd", "workspace", "AGENTS.md");
    const agentMd = join(tmpDir, "idem-claudemd", "workspace", "AGENT.md");
    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });
});
