import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveAgentsDir, resolvePath, ConfigError } from "../config/loader.js";
import type { ClerkConfig } from "../config/schema.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { installAllUnits } from "../agents/systemd.js";
import { syncTopics } from "../telegram/topic-manager.js";
import { loadTopicState } from "../telegram/state.js";
import { createVault, setSecret } from "../vault/vault.js";
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
  copyOnboardingState,
  copyExistingCredentials,
  writeAccessJson,
  writeAgentEnv,
} from "../setup/onboarding.js";
import {
  ask,
  askYesNo,
  askChoice,
  waitForAction,
  spinner,
  isInteractive,
} from "../setup/prompt.js";

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
    .action(async (opts) => {
      const parentOpts = program.opts();
      const nonInteractive =
        opts.nonInteractive === true || !process.stdin.isTTY;

      console.log(
        chalk.bold("\n  clerk setup\n") +
          chalk.gray(
            "  Interactive onboarding wizard. Sets up everything in one command.\n",
          ),
      );

      if (nonInteractive) {
        console.log(chalk.yellow("  Running in non-interactive mode.\n"));
      }

      try {
        // ── Step 1: Config file ──────────────────────────────────
        const config = await stepConfigFile(parentOpts.config, nonInteractive);

        // ── Step 2: Bot token ────────────────────────────────────
        const { botToken, botUsername } = await stepBotToken(
          config,
          nonInteractive,
        );

        // ── Step 3: DM pairing ───────────────────────────────────
        const { userId } = await stepDmPairing(
          botToken,
          botUsername,
          nonInteractive,
          opts.userId,
        );

        // ── Step 4: Group setup ──────────────────────────────────
        const forumChatId = await stepGroupSetup(
          config,
          botToken,
          botUsername,
          nonInteractive,
        );

        // ── Step 5: Create topics ────────────────────────────────
        await stepCreateTopics(config, botToken, nonInteractive);

        // ── Step 6: Scaffold agents ──────────────────────────────
        await stepScaffoldAgents(
          config,
          botToken,
          userId,
          forumChatId,
          nonInteractive,
        );

        // ── Step 7: Agent onboarding guidance ────────────────────
        await stepOnboardingGuidance(config, nonInteractive);

        // ── Step 8: Verification ─────────────────────────────────
        await stepVerification(config, nonInteractive);

        console.log(
          chalk.bold.green("\n  Setup complete!") +
            chalk.gray(" Your agents are ready.\n"),
        );
      } catch (err) {
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

async function stepConfigFile(
  configPath: string | undefined,
  nonInteractive: boolean,
): Promise<ClerkConfig> {
  stepHeader(1, "Config file", STEP_ACTIVE);

  const cwd = process.cwd();
  const existingConfig =
    configPath ??
    (existsSync(resolve(cwd, "clerk.yaml"))
      ? resolve(cwd, "clerk.yaml")
      : existsSync(resolve(cwd, "clerk.yml"))
        ? resolve(cwd, "clerk.yml")
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
    return config;
  }

  if (nonInteractive) {
    throw new ConfigError("No clerk.yaml found and running in non-interactive mode");
  }

  return await copyExampleConfig(cwd, nonInteractive);
}

async function copyExampleConfig(
  cwd: string,
  nonInteractive: boolean,
): Promise<ClerkConfig> {
  const examplesDir = resolve(import.meta.dirname, "../../examples");
  let choice: string;

  if (nonInteractive) {
    choice = "clerk";
  } else {
    choice = await askChoice("  Which example config?", [
      "clerk — Full example with 4 agents",
      "minimal — Minimal single-agent config",
    ]);
    choice = choice.split(" ")[0];
  }

  const srcFile = resolve(examplesDir, `${choice}.yaml`);
  const destFile = resolve(cwd, "clerk.yaml");

  if (!existsSync(srcFile)) {
    throw new ConfigError(`Example config not found: ${choice}.yaml`);
  }

  copyFileSync(srcFile, destFile);
  console.log(chalk.green(`  Copied ${choice}.yaml -> clerk.yaml`));
  console.log(
    chalk.yellow("  Edit clerk.yaml to customize, then re-run clerk setup."),
  );

  const config = loadConfig(destFile);
  console.log(
    chalk.green(`  ${STEP_DONE} Config loaded`) +
      chalk.gray(` (${Object.keys(config.agents).length} agents)`),
  );
  return config;
}

// ─── Step 2: Bot Token ───────────────────────────────────────────────────────

async function stepBotToken(
  config: ClerkConfig,
  nonInteractive: boolean,
): Promise<{ botToken: string; botUsername: string }> {
  stepHeader(2, "Bot token", STEP_ACTIVE);

  let token: string | undefined;

  // Check env var first
  token = process.env.TELEGRAM_BOT_TOKEN;

  // Check if config has a non-vault token
  if (!token && !config.telegram.bot_token.startsWith("vault:")) {
    token = config.telegram.bot_token;
  }

  // Try vault resolution
  if (!token && config.telegram.bot_token.startsWith("vault:")) {
    const passphrase = process.env.CLERK_VAULT_PASSPHRASE;
    if (passphrase) {
      try {
        const { openVault } = await import("../vault/vault.js");
        const vaultPath = resolvePath(
          config.vault?.path ?? "~/.clerk/vault.enc",
        );
        if (existsSync(vaultPath)) {
          const secrets = openVault(passphrase, vaultPath);
          const key = config.telegram.bot_token.replace("vault:", "");
          if (secrets[key]) {
            token = secrets[key];
          }
        }
      } catch {
        // Vault not available
      }
    }
  }

  if (!token) {
    if (nonInteractive) {
      throw new Error(
        "No bot token found. Set TELEGRAM_BOT_TOKEN environment variable.",
      );
    }

    token = await ask(
      "  Paste your Telegram bot token (from @BotFather)",
    );
    if (!token) {
      throw new Error("Bot token is required");
    }
  }

  // Validate
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
    const vaultPath = resolvePath(
      config.vault?.path ?? "~/.clerk/vault.enc",
    );

    if (!existsSync(vaultPath)) {
      console.log(chalk.gray("  Creating encrypted vault..."));
      let passphrase = process.env.CLERK_VAULT_PASSPHRASE;
      if (!passphrase) {
        passphrase = await ask("  Vault passphrase (for encrypting secrets)");
        if (!passphrase) {
          throw new Error("Vault passphrase is required");
        }
      }
      createVault(passphrase, vaultPath);
      console.log(chalk.green(`  ${STEP_DONE} Vault created at ${vaultPath}`));

      const key = config.telegram.bot_token.replace("vault:", "");
      setSecret(passphrase, vaultPath, key, token);
      console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault`));
    } else {
      let passphrase = process.env.CLERK_VAULT_PASSPHRASE;
      if (!passphrase) {
        passphrase = await ask("  Vault passphrase");
      }
      if (passphrase) {
        try {
          const key = config.telegram.bot_token.replace("vault:", "");
          setSecret(passphrase, vaultPath, key, token);
          console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault`));
        } catch (err) {
          console.log(
            chalk.yellow(
              `  Warning: Could not store in vault: ${(err as Error).message}`,
            ),
          );
        }
      }
    }
  }

  // Set env for downstream steps
  process.env.TELEGRAM_BOT_TOKEN = token;

  return { botToken: token, botUsername: botInfo.username };
}

// ─── Step 3: DM Pairing ─────────────────────────────────────────────────────

async function stepDmPairing(
  botToken: string,
  botUsername: string,
  nonInteractive: boolean,
  userIdFlag?: string,
): Promise<{ userId: string; chatId: number }> {
  stepHeader(3, "DM pairing", STEP_ACTIVE);

  if (nonInteractive) {
    const userId = userIdFlag ?? process.env.USER_ID;
    if (!userId) {
      console.log(
        chalk.yellow(
          "  Skipping DM pairing. Set USER_ID env var or --user-id flag.",
        ),
      );
      console.log(
        chalk.gray(`  Action required: DM /start to t.me/${botUsername}`),
      );
      return { userId: "0", chatId: 0 };
    }
    console.log(chalk.green(`  ${STEP_DONE} Using user ID: ${userId}`));
    return { userId, chatId: 0 };
  }

  console.log(
    chalk.cyan(
      `  DM /start to your bot: ${chalk.underline(`t.me/${botUsername}`)}`,
    ),
  );

  const spin = spinner("Waiting for /start DM (up to 2 minutes)...");
  try {
    const result = await pollForDmStart(botToken, 120_000);
    spin.stop(
      chalk.green(
        `${STEP_DONE} Paired with user: ${result.username} (ID: ${result.userId})`,
      ),
    );
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
  config: ClerkConfig,
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
      "No forum_chat_id configured. Set it in clerk.yaml before running setup.",
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

    // Update clerk.yaml with the detected chat ID
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
    resolve(process.cwd(), "clerk.yaml"),
    resolve(process.cwd(), "clerk.yml"),
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
  config: ClerkConfig,
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
        chalk.gray("  You can run 'clerk topics sync' later to retry."),
      );
    }
  }
}

// ─── Step 6: Scaffold Agents ─────────────────────────────────────────────────

async function stepScaffoldAgents(
  config: ClerkConfig,
  botToken: string,
  userId: string,
  forumChatId: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(6, "Scaffold agents", STEP_ACTIVE);

  const agentsDir = resolveAgentsDir(config);
  const agentNames = Object.keys(config.agents);

  // Find existing Claude onboarding state
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    console.log(
      chalk.gray(`  Found existing Claude config: ${existingClaudeJson}`),
    );
  }

  // Load topic state for topic IDs
  const topicState = loadTopicState();

  let scaffolded = 0;
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    try {
      const result = scaffoldAgent(
        name,
        agentConfig,
        agentsDir,
        config.telegram,
        config,
      );

      // Copy onboarding state if available
      if (existingClaudeJson) {
        copyOnboardingState(existingClaudeJson, result.agentDir);
      }

      // Copy credentials if available
      copyExistingCredentials(result.agentDir);

      // Write access.json with user ID
      if (userId && userId !== "0") {
        const topicId = topicState.topics[name]?.topic_id ?? agentConfig.topic_id;
        writeAccessJson(result.agentDir, userId, forumChatId, topicId);
      }

      // Write .env with bot token
      writeAgentEnv(result.agentDir, botToken);

      const detail =
        result.created.length > 0
          ? `${result.created.length} files created`
          : "up to date";
      console.log(
        `  ${chalk.green("+")} ${chalk.bold(name)}` +
          chalk.gray(` (${agentConfig.template}) - ${detail}`),
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
      chalk.gray("  You can run 'clerk systemd install' later to retry."),
    );
  }
}

// ─── Step 7: Agent Onboarding Guidance ───────────────────────────────────────

async function stepOnboardingGuidance(
  config: ClerkConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(7, "Agent onboarding", STEP_ACTIVE);

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
      console.log(chalk.gray(`      clerk agent start ${name}`));
      console.log(chalk.gray(`      clerk agent attach ${name}`));
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

// ─── Step 8: Verification ────────────────────────────────────────────────────

async function stepVerification(
  config: ClerkConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(8, "Verification", STEP_ACTIVE);

  const agentNames = Object.keys(config.agents);
  const firstName = agentNames[0];
  const firstAgent = config.agents[firstName];

  console.log(chalk.gray("  To verify your setup:"));
  console.log(chalk.gray(`    1. Start an agent:  clerk agent start ${firstName}`));
  console.log(chalk.gray(`    2. Check status:    clerk agent list`));
  console.log(
    chalk.gray(
      `    3. Send a message in the "${firstAgent.topic_name}" topic`,
    ),
  );
  console.log(chalk.gray("    4. Check auth:      clerk auth status"));

  if (!nonInteractive) {
    const startNow = await askYesNo(
      `\n  Start ${chalk.cyan(firstName)} now?`,
      false,
    );
    if (startNow) {
      try {
        const { execSync } = await import("node:child_process");
        console.log(chalk.gray(`  Starting ${firstName}...`));
        execSync(`clerk agent start ${firstName}`, { stdio: "inherit" });
        console.log(chalk.green(`  ${STEP_DONE} Agent started`));
      } catch {
        console.log(
          chalk.yellow(
            `  Could not start automatically. Run: clerk agent start ${firstName}`,
          ),
        );
      }
    }
  }

  console.log(chalk.green(`  ${STEP_DONE} Verification steps ready`));
}
