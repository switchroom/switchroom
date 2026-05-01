import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveAgentsDir, resolvePath, ConfigError } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { installAllUnits, installForemanUnit } from "../agents/systemd.js";
import { syncTopics } from "../telegram/topic-manager.js";
import { loadTopicState } from "../telegram/state.js";
import { createVault, openVault, setStringSecret } from "../vault/vault.js";
import {
  applyAutoUnlock,
  detectSystemdCreds,
  encryptCredential,
  EncryptCancelledError,
  EncryptFailedError,
} from "./vault-auto-unlock.js";
import { promptPassphrase } from "./vault-broker.js";
import { getAuthStatus } from "../auth/manager.js";
import {
  validateBotToken,
  pollForDmStart,
  pollForGroupJoin,
  validateGroupAdmin,
  validateGroupForum,
} from "../setup/telegram-api.js";
import {
  findExistingClaudeJson,
  writeAccessJson,
  writeAgentEnv,
  saveUserConfig,
} from "../setup/onboarding.js";
import {
  isDockerAvailable,
  isHindsightRunning,
  isHindsightContainerExists,
  startHindsight,
  stopHindsight,
} from "../setup/hindsight.js";
import {
  ask,
  askYesNo,
  askChoice,
  waitForAction,
  spinner,
  isInteractive,
} from "../setup/prompt.js";
import { captureEvent, captureException } from "../analytics/posthog.js";

const STEP_PENDING = chalk.gray("○");
const STEP_ACTIVE = chalk.blue("->");
const STEP_DONE = chalk.green("OK");

function stepHeader(num: number, title: string, status: string): void {
  console.log(`\n${status} ${chalk.bold(`Step ${num}:`)} ${title}`);
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Interactive setup wizard — guides you through the entire onboarding flow",
    )
    .option("--non-interactive", "Run without prompts (use env vars and flags)")
    .option("--user-id <id>", "Telegram user ID (non-interactive mode)")
    .option("--foreman", "Set up the foreman admin bot only (skip agent setup)")
    .action(async (opts) => {
      // ── --foreman shortcut ────────────────────────────────────────
      if (opts.foreman) {
        await runForemanSetup(opts);
        return;
      }

      const parentOpts = program.opts();
      const nonInteractive =
        opts.nonInteractive === true || !process.stdin.isTTY;

      console.log(
        chalk.bold("\n  switchroom setup\n") +
          chalk.gray(
            "  Interactive onboarding wizard. Sets up everything in one command.\n",
          ),
      );

      if (nonInteractive) {
        console.log(chalk.yellow("  Running in non-interactive mode.\n"));
      }

      try {
        // ── Step 1: Config file ──────────────────────────────────
        const { config, configPath: switchroomConfigPath } = await stepConfigFile(
          parentOpts.config,
          nonInteractive,
        );

        // ── Step 2: Bot tokens ───────────────────────────────────
        const { botToken, botUsername, agentBots } = await stepBotToken(
          config,
          nonInteractive,
        );

        // ── Step 3: DM pairing ───────────────────────────────────
        const { userId } = await stepDmPairing(
          agentBots,
          nonInteractive,
          opts.userId,
        );

        // Persist user config for later scaffold runs
        if (userId && userId !== "0") {
          saveUserConfig(userId);
        }

        // ── Step 4: Group setup ──────────────────────────────────
        const forumChatId = await stepGroupSetup(
          config,
          botToken,
          botUsername,
          nonInteractive,
        );

        // ── Step 5: Create topics ────────────────────────────────
        await stepCreateTopics(config, botToken, nonInteractive);

        // ── Step 6: Memory backend ───────────────────────────────
        await stepMemoryBackend(config, nonInteractive);

        // ── Step 7: Scaffold agents ──────────────────────────────
        await stepScaffoldAgents(
          config,
          agentBots,
          userId,
          forumChatId,
          nonInteractive,
          switchroomConfigPath,
        );

        // ── Step 8: Vault auto-unlock at boot ────────────────────
        await stepAutoUnlock(config, switchroomConfigPath, nonInteractive);

        // ── Step 9: Dangerous mode ──────────────────────────────
        await stepDangerousMode(config, nonInteractive);

        // ── Step 10: Agent onboarding guidance ───────────────────
        await stepOnboardingGuidance(config, nonInteractive);

        // ── Step 11: Verification ────────────────────────────────
        await stepVerification(config, nonInteractive);

        await captureEvent("setup_completed", {
          agent_count: Object.keys(config.agents).length,
          interactive: !nonInteractive,
        });

        console.log(
          chalk.bold.green("\n  Setup complete!") +
            chalk.gray(" Your agents are ready.\n"),
        );
      } catch (err) {
        await captureException(err, { action: "setup" });
        if (err instanceof ConfigError) {
          console.error(chalk.red(`\nConfig error: ${err.message}`));
          if (err.details) {
            for (const d of err.details) {
              console.error(chalk.gray(d));
            }
          }
          process.exit(1);
        }
        console.error(chalk.red(`\nSetup failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

// ─── Step 1: Config File ─────────────────────────────────────────────────────

interface LoadedConfig {
  config: SwitchroomConfig;
  configPath: string;
}

async function stepConfigFile(
  configPath: string | undefined,
  nonInteractive: boolean,
): Promise<LoadedConfig> {
  stepHeader(1, "Config file", STEP_ACTIVE);

  const cwd = process.cwd();
  const existingConfig =
    configPath ??
    (existsSync(resolve(cwd, "switchroom.yaml"))
      ? resolve(cwd, "switchroom.yaml")
      : existsSync(resolve(cwd, "switchroom.yml"))
        ? resolve(cwd, "switchroom.yml")
        : null);

  if (existingConfig && existsSync(existingConfig)) {
    if (!nonInteractive) {
      const useExisting = await askYesNo(
        `  Found ${chalk.cyan(existingConfig)}. Use it?`,
        true,
      );
      if (!useExisting) {
        return await copyExampleConfig(cwd, nonInteractive);
      }
    }
    console.log(chalk.gray(`  Loading ${existingConfig}`));
    const config = loadConfig(existingConfig);
    console.log(
      chalk.green(`  ${STEP_DONE} Config loaded`) +
        chalk.gray(` (${Object.keys(config.agents).length} agents)`),
    );
    return { config, configPath: resolve(existingConfig) };
  }

  if (nonInteractive) {
    throw new ConfigError("No switchroom.yaml found and running in non-interactive mode");
  }

  return await copyExampleConfig(cwd, nonInteractive);
}

async function copyExampleConfig(
  cwd: string,
  nonInteractive: boolean,
): Promise<LoadedConfig> {
  const examplesDir = resolve(import.meta.dirname, "../../examples");
  let choice: string;

  if (nonInteractive) {
    choice = "switchroom";
  } else {
    choice = await askChoice("  Which example config?", [
      "switchroom — Full example with 4 agents",
      "minimal — Minimal single-agent config",
    ]);
    choice = choice.split(" ")[0];
  }

  const srcFile = resolve(examplesDir, `${choice}.yaml`);
  const destFile = resolve(cwd, "switchroom.yaml");

  if (!existsSync(srcFile)) {
    throw new ConfigError(`Example config not found: ${choice}.yaml`);
  }

  copyFileSync(srcFile, destFile);
  console.log(chalk.green(`  Copied ${choice}.yaml -> switchroom.yaml`));
  console.log(
    chalk.yellow("  Edit switchroom.yaml to customize, then re-run switchroom setup."),
  );

  const config = loadConfig(destFile);
  console.log(
    chalk.green(`  ${STEP_DONE} Config loaded`) +
      chalk.gray(` (${Object.keys(config.agents).length} agents)`),
  );
  return { config, configPath: resolve(destFile) };
}

// ─── Step 2: Bot Tokens ─────────────────────────────────────────────────────

interface BotTokenInfo {
  token: string;
  username: string;
}

async function stepBotToken(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<{ botToken: string; botUsername: string; agentBots: Record<string, BotTokenInfo> }> {
  stepHeader(2, "Bot tokens", STEP_ACTIVE);

  const agentNames = Object.keys(config.agents);
  const agentBots: Record<string, BotTokenInfo> = {};

  // Check if any agents have per-agent bot tokens
  const hasPerAgentTokens = agentNames.some((name) => config.agents[name].bot_token);

  if (hasPerAgentTokens) {
    console.log(chalk.gray("  Per-agent bot tokens detected. Each agent gets its own bot."));
    console.log(chalk.gray("  Tip: Create bots via @BotFather — one per agent."));
    console.log(
      chalk.yellow(
        "  IMPORTANT: Disable privacy mode on each bot BEFORE adding it to the group.",
      ),
    );
    console.log(
      chalk.yellow(
        "  In BotFather: /mybots -> select bot -> Bot Settings -> Group Privacy -> Turn off\n",
      ),
    );

    for (const name of agentNames) {
      const agentConfig = config.agents[name];
      const rawToken = agentConfig.bot_token ?? config.telegram.bot_token;
      const token = await resolveOrPromptToken(
        rawToken,
        `${name}`,
        config,
        nonInteractive,
      );

      const spin = spinner(`Validating ${name} bot token...`);
      try {
        const botInfo = await validateBotToken(token);
        spin.stop(chalk.green(`${STEP_DONE} ${name}: @${botInfo.username}`));
        agentBots[name] = { token, username: botInfo.username };
      } catch (err) {
        spin.stop(chalk.red(`Failed for ${name}: ${(err as Error).message}`));
        throw err;
      }
    }

    // Use the first agent's bot as the "primary" for group/topic operations
    const firstAgent = agentNames[0];
    const primaryBot = agentBots[firstAgent];
    process.env.TELEGRAM_BOT_TOKEN = primaryBot.token;

    return { botToken: primaryBot.token, botUsername: primaryBot.username, agentBots };
  }

  // Single global bot token (fallback for all agents)
  const token = await resolveOrPromptToken(
    config.telegram.bot_token,
    "global",
    config,
    nonInteractive,
  );

  const spin = spinner("Validating bot token...");
  let botInfo;
  try {
    botInfo = await validateBotToken(token);
    spin.stop(chalk.green(`${STEP_DONE} Bot validated: @${botInfo.username}`));
  } catch (err) {
    spin.stop(chalk.red(`Failed: ${(err as Error).message}`));
    throw err;
  }

  // Store in vault if interactive
  if (!nonInteractive && config.telegram.bot_token.startsWith("vault:")) {
    await storeTokenInVault(config, token);
  }

  process.env.TELEGRAM_BOT_TOKEN = token;

  // All agents share the same bot
  for (const name of agentNames) {
    agentBots[name] = { token, username: botInfo.username };
  }

  return { botToken: token, botUsername: botInfo.username, agentBots };
}

async function resolveOrPromptToken(
  rawToken: string,
  label: string,
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<string> {
  // Check env var first
  let token: string | undefined = process.env[`TELEGRAM_BOT_TOKEN_${label.toUpperCase().replace(/-/g, "_")}`];
  if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

  // Check if config has a non-vault token
  if (!token && !rawToken.startsWith("vault:")) {
    token = rawToken;
  }

  // Try vault resolution
  if (!token && rawToken.startsWith("vault:")) {
    const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (passphrase) {
      try {
        const { openVault } = await import("../vault/vault.js");
        const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
        if (existsSync(vaultPath)) {
          const secrets = openVault(passphrase, vaultPath);
          const key = rawToken.replace("vault:", "");
          const entry = secrets[key];
          if (entry && entry.kind === "string") token = entry.value;
        }
      } catch { /* Vault not available */ }
    }
  }

  if (!token) {
    if (nonInteractive) {
      throw new Error(`No bot token found for ${label}. Set TELEGRAM_BOT_TOKEN environment variable.`);
    }
    token = await ask(`  Paste bot token for ${label} (from @BotFather)`);
    if (!token) throw new Error(`Bot token for ${label} is required`);
  }

  return token;
}

async function storeTokenInVault(config: SwitchroomConfig, token: string): Promise<void> {
  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");

  if (!existsSync(vaultPath)) {
    console.log(chalk.gray("  Creating encrypted vault..."));
    let passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (!passphrase) {
      passphrase = await ask("  Vault passphrase (for encrypting secrets)");
      if (!passphrase) throw new Error("Vault passphrase is required");
    }
    createVault(passphrase, vaultPath);
    console.log(chalk.green(`  ${STEP_DONE} Vault created at ${vaultPath}`));

    const key = config.telegram.bot_token.replace("vault:", "");
    setStringSecret(passphrase, vaultPath, key, token);
    console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault`));
  } else {
    let passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (!passphrase) {
      passphrase = await ask("  Vault passphrase");
    }
    if (passphrase) {
      try {
        const key = config.telegram.bot_token.replace("vault:", "");
        setStringSecret(passphrase, vaultPath, key, token);
        console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault`));
      } catch (err) {
        console.log(chalk.yellow(`  Warning: Could not store in vault: ${(err as Error).message}`));
      }
    }
  }
}

// ─── Step 3: DM Pairing ─────────────────────────────────────────────────────

async function stepDmPairing(
  agentBots: Record<string, BotTokenInfo>,
  nonInteractive: boolean,
  userIdFlag?: string,
): Promise<{ userId: string; chatId: number }> {
  stepHeader(3, "DM pairing", STEP_ACTIVE);

  const botEntries = Object.entries(agentBots);
  // Deduplicate by token — if all agents share one bot, only pair once
  const uniqueBots = new Map<string, { names: string[]; username: string; token: string }>();
  for (const [name, info] of botEntries) {
    const existing = uniqueBots.get(info.token);
    if (existing) {
      existing.names.push(name);
    } else {
      uniqueBots.set(info.token, { names: [name], username: info.username, token: info.token });
    }
  }

  if (nonInteractive) {
    const userId = userIdFlag ?? process.env.USER_ID;
    if (!userId) {
      console.log(
        chalk.yellow("  Skipping DM pairing. Set USER_ID env var or --user-id flag."),
      );
      for (const bot of uniqueBots.values()) {
        console.log(chalk.gray(`  Action required: DM /start to t.me/${bot.username}`));
      }
      return { userId: "0", chatId: 0 };
    }
    console.log(chalk.green(`  ${STEP_DONE} Using user ID: ${userId}`));
    return { userId, chatId: 0 };
  }

  // Prompt user to DM /start to each unique bot
  for (const bot of uniqueBots.values()) {
    const label = bot.names.length === 1 ? bot.names[0] : bot.names.join(", ");
    console.log(
      chalk.cyan(
        `  DM /start to @${bot.username} (${label}): ${chalk.underline(`t.me/${bot.username}`)}`,
      ),
    );
  }

  // Poll the first bot for the /start message to get user ID
  const firstBot = uniqueBots.values().next().value!;
  const spin = spinner("Waiting for /start DM (up to 2 minutes)...");
  try {
    const result = await pollForDmStart(firstBot.token, 120_000);
    spin.stop(
      chalk.green(
        `${STEP_DONE} Paired with user: ${result.username} (ID: ${result.userId})`,
      ),
    );

    if (uniqueBots.size > 1) {
      console.log(
        chalk.yellow(
          `  Make sure to also DM /start to the other bots listed above.`,
        ),
      );
    }

    return { userId: String(result.userId), chatId: result.chatId };
  } catch (err) {
    spin.stop(chalk.red(`Timed out`));
    console.log(
      chalk.yellow(
        "  You can continue setup and pair later. Enter your user ID manually:",
      ),
    );
    const manualId = await ask("  Telegram user ID (or press Enter to skip)");
    return { userId: manualId || "0", chatId: 0 };
  }
}

// ─── Step 4: Group Setup ─────────────────────────────────────────────────────

async function stepGroupSetup(
  config: SwitchroomConfig,
  botToken: string,
  botUsername: string,
  nonInteractive: boolean,
): Promise<string> {
  stepHeader(4, "Group setup", STEP_ACTIVE);

  const configChatId = config.telegram.forum_chat_id;
  const isPlaceholder =
    configChatId === "-1001234567890" || configChatId === "";

  // If config already has a real chat ID, validate it
  if (!isPlaceholder) {
    if (!nonInteractive) {
      const useExisting = await askYesNo(
        `  Use group ${chalk.cyan(configChatId)} from config?`,
        true,
      );
      if (!useExisting) {
        return await detectGroup(botToken, botUsername, nonInteractive);
      }
    }

    // Validate the group
    const spin = spinner("Validating group...");
    try {
      const isForum = await validateGroupForum(botToken, configChatId);
      if (!isForum) {
        spin.stop(chalk.yellow("Warning: Group does not have topics enabled"));
      } else {
        const isAdmin = await validateGroupAdmin(botToken, configChatId);
        if (!isAdmin) {
          spin.stop(
            chalk.yellow("Warning: Bot is not an admin in the group"),
          );
        } else {
          spin.stop(chalk.green(`${STEP_DONE} Group validated (forum, bot is admin)`));
        }
      }
    } catch (err) {
      spin.stop(
        chalk.yellow(`Warning: Could not validate group: ${(err as Error).message}`),
      );
    }

    return configChatId;
  }

  if (nonInteractive) {
    throw new Error(
      "No forum_chat_id configured. Set it in switchroom.yaml before running setup.",
    );
  }

  return await detectGroup(botToken, botUsername, nonInteractive);
}

async function detectGroup(
  botToken: string,
  botUsername: string,
  nonInteractive: boolean,
): Promise<string> {
  console.log(
    chalk.yellow.bold(
      "\n  IMPORTANT: Disable privacy mode BEFORE adding the bot to the group.",
    ),
  );
  console.log(
    chalk.yellow(
      "  In BotFather: /mybots -> select bot -> Bot Settings -> Group Privacy -> Turn off",
    ),
  );
  console.log(
    chalk.yellow(
      "  If you already added the bot, remove it from the group and re-add after disabling privacy.\n",
    ),
  );
  console.log(
    chalk.cyan(
      `  Add @${botUsername} to your Telegram forum group as admin.`,
    ),
  );

  if (nonInteractive) {
    throw new Error("Cannot detect group in non-interactive mode");
  }

  const spin = spinner("Waiting for bot to be added to a group (up to 2 minutes)...");
  try {
    const result = await pollForGroupJoin(botToken, 120_000);
    spin.stop(
      chalk.green(
        `${STEP_DONE} Detected group: ${result.title} (ID: ${result.chatId})`,
      ),
    );

    // Update switchroom.yaml with the detected chat ID
    const chatIdStr = String(result.chatId);
    updateConfigChatId(chatIdStr);

    return chatIdStr;
  } catch (err) {
    spin.stop(chalk.red("Timed out"));
    const manualId = await ask(
      "  Enter forum group chat ID manually (e.g., -100123456789)",
    );
    if (manualId) {
      updateConfigChatId(manualId);
      return manualId;
    }
    throw new Error("Forum chat ID is required");
  }
}

function updateConfigChatId(chatId: string): void {
  const configPaths = [
    resolve(process.cwd(), "switchroom.yaml"),
    resolve(process.cwd(), "switchroom.yml"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      let content = readFileSync(configPath, "utf-8");
      // Replace the placeholder or existing forum_chat_id
      content = content.replace(
        /forum_chat_id:\s*["']?-?\d+["']?/,
        `forum_chat_id: "${chatId}"`,
      );
      writeFileSync(configPath, content, "utf-8");
      console.log(chalk.gray(`  Updated forum_chat_id in ${configPath}`));
      break;
    }
  }
}

// ─── Step 5: Create Topics ───────────────────────────────────────────────────

async function stepCreateTopics(
  config: SwitchroomConfig,
  botToken: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(5, "Create topics", STEP_ACTIVE);

  const spin = spinner("Syncing forum topics...");
  try {
    const results = await syncTopics(config);
    spin.stop("");

    for (const r of results) {
      const statusIcon =
        r.status === "created" ? chalk.green("+") : chalk.gray("=");
      console.log(
        `  ${statusIcon} ${chalk.bold(r.agent)} -> ${r.topic_name} (thread ${r.topic_id})`,
      );
    }

    console.log(
      chalk.green(`  ${STEP_DONE} ${results.length} topics synced`),
    );
  } catch (err) {
    spin.stop("");
    console.log(
      chalk.yellow(
        `  Warning: Topic sync failed: ${(err as Error).message}`,
      ),
    );
    if (!nonInteractive) {
      console.log(
        chalk.gray("  You can run 'switchroom topics sync' later to retry."),
      );
    }
  }
}

// ─── Step 6: Memory Backend ─────────────────────────────────────────────────

async function stepMemoryBackend(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(6, "Memory backend", STEP_ACTIVE);

  // Check if memory backend is configured and is hindsight
  const memoryBackend = config.memory?.backend ?? "hindsight";
  const envBackend = process.env.SWITCHROOM_MEMORY_BACKEND;

  if (envBackend === "none" || memoryBackend === "none") {
    console.log(chalk.gray("  Memory backend disabled (set to 'none')."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return;
  }

  // In non-interactive mode, default to hindsight unless env says otherwise
  let setupHindsight = true;
  if (!nonInteractive) {
    setupHindsight = await askYesNo(
      "  Set up Hindsight memory? (recommended)",
      true,
    );
  }

  if (!setupHindsight) {
    console.log(chalk.gray("  Skipping Hindsight setup."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return;
  }

  // Check Docker availability
  if (!isDockerAvailable()) {
    console.log(
      chalk.yellow("  Docker is not available on this system."),
    );
    console.log(chalk.gray("  To set up Hindsight manually:"));
    console.log(chalk.gray("    1. Install Docker: https://docs.docker.com/get-docker/"));
    console.log(chalk.gray("    2. Run: docker run -d --name switchroom-hindsight \\"));
    console.log(chalk.gray("         --restart unless-stopped \\"));
    console.log(chalk.gray("         -v switchroom-hindsight-data:/home/hindsight/.pg0 \\"));
    console.log(chalk.gray("         ghcr.io/vectorize-io/hindsight:latest"));
    console.log(chalk.gray("    3. Re-run: switchroom setup"));
    console.log(chalk.green(`  ${STEP_DONE} Manual setup instructions shown`));
    return;
  }

  // Check if already running
  if (isHindsightRunning()) {
    console.log(chalk.green(`  ${STEP_DONE} Hindsight container already running (switchroom-hindsight)`));
    return;
  }

  // Check if container exists but is stopped
  if (isHindsightContainerExists()) {
    console.log(chalk.gray("  Found stopped switchroom-hindsight container, removing..."));
    stopHindsight();
  }

  // Ask for OpenAI API key for Hindsight LLM features
  let hindsightApiKey: string | undefined;
  if (!nonInteractive) {
    const apiKeyInput = await ask(
      "  Enter your OpenAI API key for Hindsight memory (or press Enter to skip)",
    );
    if (apiKeyInput) {
      hindsightApiKey = apiKeyInput;
      // Store in vault
      const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
      try {
        let passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
        if (!passphrase) {
          passphrase = await ask("  Vault passphrase");
        }
        if (passphrase) {
          if (!existsSync(vaultPath)) {
            createVault(passphrase, vaultPath);
          }
          setStringSecret(passphrase, vaultPath, "hindsight-api-key", apiKeyInput);
          console.log(chalk.green(`  ${STEP_DONE} API key stored in vault as 'hindsight-api-key'`));
        }
      } catch (err) {
        console.log(chalk.yellow(`  Warning: Could not store in vault: ${(err as Error).message}`));
      }
    } else {
      console.log(chalk.yellow("  Skipped. Memory features will be limited without an LLM API key."));
    }
  } else {
    hindsightApiKey = process.env.HINDSIGHT_API_LLM_API_KEY;
  }

  // Start the container
  const spin = spinner("Starting Hindsight Docker container...");
  try {
    startHindsight("openai", hindsightApiKey);

    // Verify it started
    if (isHindsightRunning()) {
      spin.stop(chalk.green(`${STEP_DONE} Hindsight container started (switchroom-hindsight)`));
      console.log(chalk.gray("  API: http://localhost:8888/mcp"));
      console.log(chalk.gray("  UI:  http://localhost:9999"));
    } else {
      spin.stop(chalk.yellow("Container started but may still be initializing"));
    }
  } catch (err) {
    spin.stop(chalk.red(`Failed to start Hindsight: ${(err as Error).message}`));
    console.log(chalk.gray("  You can start it manually:"));
    console.log(chalk.gray("    docker run -d --name switchroom-hindsight \\"));
    console.log(chalk.gray("      --restart unless-stopped \\"));
    console.log(chalk.gray("      -p 8888:8888 -p 9999:9999 \\"));
    console.log(chalk.gray("      -v switchroom-hindsight-data:/home/hindsight/.pg0 \\"));
    console.log(chalk.gray("      ghcr.io/vectorize-io/hindsight:latest"));
  }
}

// ─── Step 7: Scaffold Agents ─────────────────────────────────────────────────

async function stepScaffoldAgents(
  config: SwitchroomConfig,
  agentBots: Record<string, BotTokenInfo>,
  userId: string,
  forumChatId: string,
  nonInteractive: boolean,
  switchroomConfigPath?: string,
): Promise<void> {
  stepHeader(7, "Scaffold agents", STEP_ACTIVE);

  const agentsDir = resolveAgentsDir(config);
  const agentNames = Object.keys(config.agents);

  // Find existing Claude onboarding state
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    console.log(
      chalk.gray(`  Found existing Claude config: ${existingClaudeJson}`),
    );
  } else if (!nonInteractive) {
    console.log(
      chalk.yellow(
        "  Claude Code has not been set up on this machine yet.\n" +
        "  Run `claude` in a terminal first to complete initial setup, then run `switchroom setup` again.\n" +
        "  Continuing with minimal config — agents will need onboarding via `switchroom agent attach <name>`."
      ),
    );
  }

  // Load topic state for topic IDs
  const topicState = loadTopicState();

  let scaffolded = 0;
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    const botInfo = agentBots[name];
    try {
      // scaffoldAgent now handles user ID loading, Claude config copy, and pre-trust internally
      const result = scaffoldAgent(
        name,
        agentConfig,
        agentsDir,
        config.telegram,
        config,
        userId !== "0" ? userId : undefined,
        switchroomConfigPath,
      );

      // Write access.json with user ID (overwrite with latest from setup)
      if (userId && userId !== "0") {
        writeAccessJson(result.agentDir, userId, forumChatId);
      }

      // Write .env with the agent's own bot token
      writeAgentEnv(result.agentDir, botInfo.token);

      const detail =
        result.created.length > 0
          ? `${result.created.length} files created`
          : "up to date";
      console.log(
        `  ${chalk.green("+")} ${chalk.bold(name)}` +
          chalk.gray(` (${agentConfig.extends ?? "default"}) @${botInfo.username} - ${detail}`),
      );
      scaffolded++;
    } catch (err) {
      console.error(
        chalk.red(`  x ${name}: ${(err as Error).message}`),
      );
    }
  }

  // Install systemd units
  console.log(chalk.gray("\n  Installing systemd units..."));
  try {
    installAllUnits(config);
    console.log(
      chalk.green(`  ${STEP_DONE} ${scaffolded} agents scaffolded, systemd units installed`),
    );
  } catch (err) {
    console.log(
      chalk.yellow(
        `  Warning: systemd install failed: ${(err as Error).message}`,
      ),
    );
    console.log(
      chalk.gray("  You can run 'switchroom systemd install' later to retry."),
    );
  }
}

// ─── Step 8: Vault Auto-Unlock ──────────────────────────────────────────────

/**
 * Offer to enable vault auto-unlock at boot. The "defaults test" in
 * reference/principles.md says the product should work on a fresh setup
 * with zero post-wizard config — and on Linux that means the vault
 * should unlock itself after every reboot, with no terminal session
 * required. We ask once here and run the same flow as
 * `switchroom vault broker enable-auto-unlock --apply` inline.
 *
 * Skip silently when:
 *   - non-interactive (CI / scripts shouldn't trigger sudo prompts)
 *   - non-Linux (systemd-creds is Linux-only)
 *   - systemd-creds binary is missing (older or stripped systemd)
 *   - the vault doesn't exist yet (no broker to auto-unlock)
 *   - auto-unlock is already configured AND the credential file is
 *     already on disk (idempotency)
 */
async function stepAutoUnlock(
  config: SwitchroomConfig,
  switchroomConfigPath: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(8, "Vault auto-unlock at boot", STEP_ACTIVE);

  if (nonInteractive) {
    console.log(chalk.gray("  Skipping in non-interactive mode."));
    return;
  }
  if (process.platform !== "linux") {
    console.log(chalk.gray("  Skipping (auto-unlock requires Linux + systemd-creds)."));
    return;
  }

  if (!detectSystemdCreds()) {
    console.log(chalk.gray("  Skipping (systemd-creds not on PATH)."));
    return;
  }

  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  if (!existsSync(vaultPath)) {
    console.log(chalk.gray("  Skipping (vault not created yet)."));
    return;
  }

  const credPathRaw =
    config.vault?.broker?.autoUnlockCredentialPath ??
    "~/.config/credstore.encrypted/vault-passphrase";
  const credPath = resolvePath(credPathRaw);
  if (config.vault?.broker?.autoUnlock === true && existsSync(credPath)) {
    console.log(chalk.green(`  ${STEP_DONE} Already configured (${credPath})`));
    return;
  }

  console.log(chalk.gray("  Without this, vault must be unlocked manually after every reboot."));
  const enable = await askYesNo("  Enable vault auto-unlock at boot?", true);
  if (!enable) {
    console.log(chalk.gray("  Skipped. Run later with: switchroom vault broker enable-auto-unlock"));
    return;
  }

  // Re-prompt with masked input. The wizard uses plain `ask()` for the
  // vault passphrase elsewhere, but we deliberately use the masked path
  // here because we're handing the value to systemd-creds, not echoing
  // it back to the user.
  let passphrase: string;
  try {
    passphrase = await promptPassphrase();
  } catch (err) {
    console.log(chalk.yellow(`  Skipped: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  try {
    try {
      openVault(passphrase, vaultPath);
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Skipped: passphrase verification failed (${err instanceof Error ? err.message : String(err)}).`,
        ),
      );
      console.log(chalk.gray("  Run later with: switchroom vault broker enable-auto-unlock"));
      return;
    }

    let scope: string;
    try {
      scope = await encryptCredential(passphrase, credPath);
    } catch (err) {
      if (err instanceof EncryptCancelledError) {
        console.log(chalk.gray("  Skipped (user declined sudo)."));
        return;
      }
      if (err instanceof EncryptFailedError) {
        console.log(chalk.yellow("  Could not encrypt credential. Continuing setup."));
        console.log(chalk.gray("  Retry later with: switchroom vault broker enable-auto-unlock"));
        return;
      }
      throw err;
    }
    console.log(chalk.green(`  ${STEP_DONE} Encrypted credential (scope: ${scope})`));
  } finally {
    passphrase = "";
  }

  try {
    await applyAutoUnlock({ configPath: switchroomConfigPath });
    console.log(chalk.green(`  ${STEP_DONE} Auto-unlock active`));
  } catch (err) {
    console.log(
      chalk.yellow(
        `  Credential is encrypted but apply step failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    console.log(chalk.gray("  Retry with: switchroom reconcile && systemctl --user restart switchroom-vault-broker.service"));
  }
}

// ─── Step 9: Dangerous Mode ─────────────────────────────────────────────────

async function stepDangerousMode(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(9, "Auto-approve mode", STEP_ACTIVE);

  let enableDangerous = false;

  if (nonInteractive) {
    enableDangerous = process.env.SWITCHROOM_DANGEROUS_MODE === "true" || process.env.SWITCHROOM_DANGEROUS_MODE === "1";
  } else {
    console.log(chalk.gray("  This skips permission prompts for all tool calls."));
    console.log(chalk.gray("  Recommended for headless agents. Tool approval can also be done via Telegram DM."));
    enableDangerous = await askYesNo(
      "  Enable auto-approve for all tool calls? (skips permission prompts)",
      false,
    );
  }

  if (enableDangerous) {
    const configPaths = [
      resolve(process.cwd(), "switchroom.yaml"),
      resolve(process.cwd(), "switchroom.yml"),
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        let content = readFileSync(configPath, "utf-8");
        const agentNames = Object.keys(config.agents);

        for (const name of agentNames) {
          // Add dangerous_mode and skip_permission_prompt to each agent block
          // Look for the agent's top-level key and add after it
          const agentPattern = new RegExp(`(^  ${name}:\\s*\\n)`, "m");
          if (agentPattern.test(content)) {
            // Check if dangerous_mode already exists for this agent
            const blockPattern = new RegExp(`^  ${name}:[\\s\\S]*?(?=^  [a-z]|\\Z)`, "m");
            const blockMatch = content.match(blockPattern);
            if (blockMatch && !blockMatch[0].includes("dangerous_mode")) {
              content = content.replace(
                agentPattern,
                `$1    dangerous_mode: true\n    skip_permission_prompt: true\n`,
              );
            }
          }

          // Also update the in-memory config
          config.agents[name].dangerous_mode = true;
          config.agents[name].skip_permission_prompt = true;
        }

        writeFileSync(configPath, content, "utf-8");
        console.log(chalk.green(`  ${STEP_DONE} Enabled dangerous_mode for all agents in ${configPath}`));
        break;
      }
    }
  } else {
    console.log(chalk.gray("  Skipped. Agents will prompt for tool approval."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
  }
}

// ─── Step 10: Agent Onboarding Guidance ──────────────────────────────────────

async function stepOnboardingGuidance(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(10, "Agent onboarding", STEP_ACTIVE);

  const agentsDir = resolveAgentsDir(config);
  const agentNames = Object.keys(config.agents);
  let allAuthenticated = true;

  for (const name of agentNames) {
    const agentDir = resolve(agentsDir, name);
    const status = getAuthStatus(name, agentDir);

    if (status.authenticated) {
      console.log(
        `  ${chalk.green("OK")} ${chalk.bold(name)}` +
          chalk.gray(
            ` - authenticated (expires: ${status.timeUntilExpiry ?? "unknown"})`,
          ),
      );
      console.log(
        chalk.yellow(
          "      Credentials copied from existing session - may need refresh",
        ),
      );
    } else {
      allAuthenticated = false;
      console.log(
        `  ${chalk.yellow("!!")} ${chalk.bold(name)} - needs onboarding`,
      );
      console.log(chalk.gray(`      switchroom agent start ${name}`));
      console.log(chalk.gray(`      switchroom agent attach ${name}`));
      console.log(
        chalk.gray(
          "      Complete onboarding (theme, login, trust), then Ctrl+B D",
        ),
      );
    }
  }

  if (allAuthenticated) {
    console.log(
      chalk.green(`\n  ${STEP_DONE} All agents have credentials`),
    );
  } else {
    console.log(
      chalk.yellow(
        "\n  Some agents need onboarding. Complete them one at a time.",
      ),
    );
    if (!nonInteractive) {
      await waitForAction(
        "  Complete agent onboarding, then press Enter to continue.",
      );
    }
  }
}

// ─── Step 11: Verification ───────────────────────────────────────────────────

async function stepVerification(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(11, "Verification", STEP_ACTIVE);

  const agentNames = Object.keys(config.agents);
  const firstName = agentNames[0];
  const firstAgent = config.agents[firstName];

  console.log(chalk.gray("  To verify your setup:"));
  console.log(chalk.gray(`    1. Start an agent:  switchroom agent start ${firstName}`));
  console.log(chalk.gray(`    2. Check status:    switchroom agent list`));
  console.log(
    chalk.gray(
      `    3. Send a message in the "${firstAgent.topic_name}" topic`,
    ),
  );
  console.log(chalk.gray("    4. Check auth:      switchroom auth status"));

  if (!nonInteractive) {
    const startNow = await askYesNo(
      `\n  Start ${chalk.cyan(firstName)} now?`,
      false,
    );
    if (startNow) {
      try {
        const { execFileSync } = await import("node:child_process");
        console.log(chalk.gray(`  Starting ${firstName}...`));
        execFileSync("switchroom", ["agent", "start", firstName], { stdio: "inherit" });
        console.log(chalk.green(`  ${STEP_DONE} Agent started`));
      } catch {
        console.log(
          chalk.yellow(
            `  Could not start automatically. Run: switchroom agent start ${firstName}`,
          ),
        );
      }
    }
  }

  console.log(chalk.green(`  ${STEP_DONE} Verification steps ready`));
}

// ─── Foreman setup (--foreman) ────────────────────────────────────────────

/**
 * Standalone foreman setup flow. Prompts for a bot token and user Telegram
 * ID, writes ~/.switchroom/foreman/.env + access.json, installs + enables
 * the switchroom-foreman.service unit.
 *
 * Invoked via: switchroom setup --foreman
 */
async function runForemanSetup(opts: { nonInteractive?: boolean; userId?: string }): Promise<void> {
  const { mkdirSync, writeFileSync, chmodSync, existsSync } = await import("node:fs");
  const { resolve: resolvePath, join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");

  const nonInteractive = opts.nonInteractive === true || !process.stdin.isTTY;

  console.log(
    chalk.bold("\n  switchroom setup --foreman\n") +
      chalk.gray("  Sets up the foreman admin bot and installs its systemd unit.\n"),
  );

  const foremanDir = join(homedir(), ".switchroom", "foreman");
  mkdirSync(foremanDir, { recursive: true });

  // ── Bot token ──────────────────────────────────────────────────────────
  let botToken: string | undefined = process.env.TELEGRAM_FOREMAN_BOT_TOKEN;

  if (!botToken) {
    if (nonInteractive) {
      console.error(
        chalk.red("  No bot token. Set TELEGRAM_FOREMAN_BOT_TOKEN env var."),
      );
      process.exit(1);
    }
    console.log(chalk.yellow(
      "  Token will be visible as you paste. " +
      "For production, use TELEGRAM_FOREMAN_BOT_TOKEN env var.",
    ));
    botToken = await ask(
      "  Paste foreman bot token from @BotFather",
    );
    if (!botToken) {
      console.error(chalk.red("  Bot token is required."));
      process.exit(1);
    }
  }

  // Validate token
  const spin = spinner("Validating foreman bot token...");
  let botUsername: string;
  try {
    const info = await validateBotToken(botToken);
    botUsername = info.username;
    spin.stop(chalk.green(`${STEP_DONE} Bot validated: @${botUsername}`));
  } catch (err) {
    spin.stop(chalk.red(`  Token invalid: ${(err as Error).message}`));
    process.exit(1);
  }

  // ── User Telegram ID ────────────────────────────────────────────────────
  let userId = opts.userId ?? process.env.TELEGRAM_USER_ID ?? process.env.USER_ID;

  if (!userId) {
    if (nonInteractive) {
      console.error(
        chalk.red("  No user ID. Set TELEGRAM_USER_ID env var or pass --user-id."),
      );
      process.exit(1);
    }
    console.log(chalk.cyan(`\n  DM /start to @${botUsername}: ${chalk.underline(`t.me/${botUsername}`)}`));
    const pollSpin = spinner("Waiting for /start DM (up to 2 minutes)...");
    try {
      const result = await pollForDmStart(botToken, 120_000);
      pollSpin.stop(
        chalk.green(`${STEP_DONE} Paired with user ID: ${result.userId}`),
      );
      userId = String(result.userId);
    } catch {
      pollSpin.stop(chalk.yellow("Timed out — enter user ID manually."));
      userId = await ask("  Your Telegram user ID (numeric)");
      if (!userId) {
        console.error(chalk.red("  User ID is required."));
        process.exit(1);
      }
    }
  }

  // ── Write config files ─────────────────────────────────────────────────
  const envFile = join(foremanDir, ".env");
  const force = process.env.SWITCHROOM_FOREMAN_FORCE === "1";

  if (existsSync(envFile) && !force) {
    if (nonInteractive) {
      console.error(
        chalk.red(`  ${envFile} already exists.`) +
          chalk.gray(
            "\n  Re-running setup rotates the bot token. To confirm, set SWITCHROOM_FOREMAN_FORCE=1.\n  To only update the allowlist, delete and recreate access.json directly.",
          ),
      );
      process.exit(1);
    }
    const confirm = await askYesNo(
      `\n  ${envFile} already exists. Overwrite bot token?`,
      false,
    );
    if (!confirm) {
      console.log(
        chalk.gray("  Keeping existing token. (Access list will still be updated.)"),
      );
    } else {
      writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${botToken}\n`, { mode: 0o600 });
      chmodSync(envFile, 0o600);
      console.log(chalk.green(`  ${STEP_DONE} Rewrote ${envFile}`));
    }
  } else {
    writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${botToken}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    console.log(chalk.green(`  ${STEP_DONE} Wrote ${envFile}`));
  }

  const accessFile = join(foremanDir, "access.json");
  writeFileSync(
    accessFile,
    JSON.stringify({ allowFrom: [userId] }, null, 2) + "\n",
    { mode: 0o644 },
  );
  console.log(chalk.green(`  ${STEP_DONE} Wrote ${accessFile}`));

  // ── Install systemd unit ───────────────────────────────────────────────
  console.log(chalk.gray("\n  Installing switchroom-foreman.service..."));
  try {
    installForemanUnit();
    console.log(chalk.green(`  ${STEP_DONE} switchroom-foreman.service installed and enabled`));
  } catch (err) {
    console.log(
      chalk.yellow(`  Warning: systemd install failed: ${(err as Error).message}`),
    );
    console.log(chalk.gray("  Start manually: systemctl --user start switchroom-foreman"));
  }

  // ── Offer to start now ─────────────────────────────────────────────────
  const startNow = nonInteractive
    ? false
    : await askYesNo("\n  Start foreman now?", true);

  if (startNow) {
    try {
      execFileSync("systemctl", ["--user", "start", "switchroom-foreman"], { stdio: "inherit" });
      console.log(chalk.green(`  ${STEP_DONE} Foreman started — DM @${botUsername} to verify`));
    } catch {
      console.log(
        chalk.yellow("  Could not start automatically. Run: systemctl --user start switchroom-foreman"),
      );
    }
  }

  console.log(
    chalk.bold.green("\n  Foreman setup complete!") +
      chalk.gray(` DM @${botUsername} and try /help.\n`),
  );
}
