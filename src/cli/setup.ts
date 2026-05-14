import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveAgentsDir, resolvePath, ConfigError } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { syncTopics } from "../telegram/topic-manager.js";
import { loadTopicState } from "../telegram/state.js";
import { createVault, openVault, setStringSecret } from "../vault/vault.js";
import {
  applyAutoUnlock,
  autoUnlockSupported,
  encryptCredential,
  EncryptFailedError,
} from "./vault-auto-unlock.js";
import { promptPassphrase } from "./vault-broker.js";
import { getAuthStatus } from "../auth/manager.js";
import {
  validateBotToken,
  pollForDmStart,
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
import { insertVaultBrokerApprovalAuth } from "./setup-posture-rewrite.js";

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

        // ── Step 4: (group/forum setup retired in v0.7) ──────────
        // Per-agent bot DM-only is the default. Sentinel "0" lands in
        // scaffolded access.json wherever a forum chat ID was previously
        // stored; the schema still requires `telegram.forum_chat_id`,
        // and existing configs that set a real one continue to work.
        const forumChatId = "0";

        // ── Step 5: Create topics ────────────────────────────────
        await stepCreateTopics(config, botToken, nonInteractive);

        // ── Step 6: Memory backend ───────────────────────────────
        await stepMemoryBackend(config, nonInteractive);

        // ── Step 7: Scaffold agents ──────────────────────────────
        await stepScaffoldAgents(
          config,
          agentBots,
          userId,
          nonInteractive,
          switchroomConfigPath,
        );

        // ── Step 8: Vault auto-unlock at boot ────────────────────
        await stepAutoUnlock(config, switchroomConfigPath, nonInteractive);

        // ── Step 9: Dangerous mode ──────────────────────────────
        await stepDangerousMode(config, nonInteractive);

        // ── Step 10: Agent onboarding guidance ───────────────────
        await stepOnboardingGuidance(config, nonInteractive);

        // ── Step 11: Optional Google Workspace connection (RFC G §4.6) ─
        await stepGoogleWorkspace(config, nonInteractive);

        // ── Step 12: Verification ────────────────────────────────
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

  // No config found. Bootstrap from the bundled example. In interactive
  // mode this prompts for which example; in non-interactive it picks
  // the default ("switchroom") deterministically. The previous
  // behaviour — throwing ConfigError in non-interactive mode — made it
  // impossible to drive `switchroom setup --non-interactive` from a
  // fresh install, which was a P0 blocker for any scripted/CI install
  // (the same code path that works interactively works fine
  // non-interactively; nothing about the bootstrap requires a TTY).
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

  // Store in vault when the config references one. This works in both
  // modes — interactive prompts for the vault passphrase if env-var
  // isn't set, non-interactive requires SWITCHROOM_VAULT_PASSPHRASE.
  // Previously this was gated behind `!nonInteractive`, which meant
  // scripted/CI installs with `vault:`-prefixed config never created
  // the vault — `switchroom apply` then refused to run with
  // "vault.enc is missing" (install-validation finding #16).
  if (config.telegram.bot_token.startsWith("vault:")) {
    if (nonInteractive && !process.env.SWITCHROOM_VAULT_PASSPHRASE) {
      throw new Error(
        "SWITCHROOM_VAULT_PASSPHRASE must be set before running setup in non-interactive mode when config uses vault: refs.",
      );
    }
    await storeTokenInVault(config, token);
  }

  process.env.TELEGRAM_BOT_TOKEN = token;

  // All agents share the same bot
  for (const name of agentNames) {
    agentBots[name] = { token, username: botInfo.username };
  }

  return { botToken: token, botUsername: botInfo.username, agentBots };
}

export async function resolveOrPromptToken(
  rawToken: string,
  label: string,
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<string> {
  // Resolution precedence (install-validation finding #31):
  //
  //   1. Agent-scoped env var: TELEGRAM_BOT_TOKEN_<LABEL>
  //   2. Vault ref in config (if rawToken starts with `vault:`)
  //   3. Literal config value (if rawToken is a plain token)
  //   4. Global TELEGRAM_BOT_TOKEN env var (LAST RESORT)
  //   5. Interactive prompt
  //
  // Why the global env is last for vault-ref configs: a multi-bot
  // fleet declares `agents.<n>.bot_token: "vault:<key-per-agent>"`,
  // and an operator running `TELEGRAM_BOT_TOKEN=… switchroom setup`
  // would (pre-fix) get every agent stamped with the same global
  // token — multiple gateways then poll the same bot and Telegram
  // returns 409 conflicts. Resolving the per-agent vault ref first
  // makes the per-agent declaration win, as the operator intended.
  //
  // Plain (non-vault) literal tokens in config still defer to the
  // global env for backwards compat — single-bot fleets that used
  // `TELEGRAM_BOT_TOKEN=… switchroom setup` as a one-shot override
  // keep working.

  // 1. Agent-scoped env var.
  const labelEnvKey = `TELEGRAM_BOT_TOKEN_${label.toUpperCase().replace(/-/g, "_")}`;
  let token: string | undefined = process.env[labelEnvKey];

  // 2. Vault ref takes priority over global env when present.
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

  // 3. Plain literal config value.
  if (!token && !rawToken.startsWith("vault:")) {
    token = rawToken;
  }

  // 4. Global env var (backwards-compat fallback).
  if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

  // 5. Interactive prompt.
  if (!token) {
    if (nonInteractive) {
      throw new Error(
        `No bot token found for ${label}. Set ${labelEnvKey} or TELEGRAM_BOT_TOKEN, ` +
          `or store the token in the vault under the key referenced by ` +
          `agents.${label}.bot_token (run with SWITCHROOM_VAULT_PASSPHRASE).`,
      );
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

// ─── Step 4: retired in v0.7 ─────────────────────────────────────────────────
// Forum/group setup prompts were removed when per-agent bot DM-only became
// the default. Existing configs with a real `telegram.forum_chat_id` keep
// working; new setups land sentinel "0" via `stepScaffoldAgents` below.

// ─── Step 5: Create Topics ───────────────────────────────────────────────────

async function stepCreateTopics(
  config: SwitchroomConfig,
  botToken: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(5, "Create topics", STEP_ACTIVE);

  // DM-only sentinel (v0.7+) — per-agent DM-pair is the default, the
  // forum_chat_id field stays for schema compat with legacy installs.
  // Don't actually call the Telegram API for a fake chat id; it'll
  // return "Forum chat not found" and look like a real failure to a
  // new user. (Install-validation finding #15.)
  if (config.telegram.forum_chat_id === "0") {
    console.log(
      chalk.gray(
        `  ${STEP_DONE} Skipped (DM-only mode — forum_chat_id is sentinel "0")`,
      ),
    );
    return;
  }

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
  nonInteractive: boolean,
  switchroomConfigPath?: string,
): Promise<void> {
  // Forum chat IDs are no longer collected by the wizard. Write sentinel
  // "0" (matches the user-id sentinel pattern at `stepDmPairing`) so
  // `writeAccessJson` lands a deterministic value and the still-required
  // `telegram.forum_chat_id` schema field remains honest.
  const forumChatId = "0";
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
  let scaffoldFailed = 0;
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
      scaffoldFailed++;
    }
  }

  // v0.7: agent containers come up via docker-compose. The compose
  // file is regenerated + brought up by `switchroom apply`. We don't
  // run that automatically from the setup wizard — the operator may
  // want to inspect switchroom.yaml first.
  //
  // #12: don't paint a green checkmark on a step that failed. If any
  // agent scaffold threw, surface it as a hard failure so the final
  // "Setup complete!" line never lies about reality.
  const summary = `${scaffolded} agent(s) scaffolded` + (
    scaffoldFailed > 0 ? `, ${scaffoldFailed} failed` : ""
  );
  if (scaffoldFailed > 0) {
    console.log(chalk.red(`  x ${summary}`));
    throw new Error(
      `${scaffoldFailed} agent scaffold(s) failed during setup — see errors above.`,
    );
  }
  console.log(chalk.green(`  ${STEP_DONE} ${summary}`));

  // RFC H §4.6: first-run defaults `auth.active` to "default" so the
  // first OAuth flow (run as `switchroom auth add default --from-oauth`)
  // lands the fleet on a working account without any per-agent `auth:`
  // block. Idempotent — does nothing when `auth.active` is already set.
  if (switchroomConfigPath && !config.auth?.active) {
    try {
      await ensureAuthActiveDefault(switchroomConfigPath);
      console.log(
        chalk.gray(
          "  Set auth.active: default — run `switchroom auth add default --from-oauth` to log in",
        ),
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          `  ⚠ Could not set auth.active default: ${(err as Error).message}`,
        ),
      );
    }
  }

  console.log(
    chalk.gray(
      "  Next: switchroom apply  (regenerates docker-compose.yml + brings agents up)",
    ),
  );
}

/**
 * Set `auth.active: default` in switchroom.yaml when unset. Pure-YAML
 * edit (preserves comments via `yaml` library's Document model).
 * Atomic write via the shared util. Idempotent.
 */
async function ensureAuthActiveDefault(configPath: string): Promise<void> {
  const fs = await import("node:fs");
  const { parseDocument, isMap } = await import("yaml");
  const { atomicWriteFileSync } = await import("../util/atomic.js");
  const raw = fs.readFileSync(configPath, "utf-8");
  const doc = parseDocument(raw);
  const root = doc.contents;
  if (!isMap(root)) return;
  const existing = root.get("auth", true);
  if (isMap(existing) && existing.has("active")) return;
  doc.setIn(["auth", "active"], "default");
  const out = String(doc);
  const tail = out.endsWith("\n") ? out : out + "\n";
  let mode = 0o644;
  try { mode = fs.statSync(configPath).mode & 0o777; } catch { /* default */ }
  atomicWriteFileSync(configPath, tail, mode);
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

  if (!autoUnlockSupported()) {
    console.log(chalk.gray("  Skipping (no /etc/machine-id on this host)."));
    return;
  }

  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  if (!existsSync(vaultPath)) {
    console.log(chalk.gray("  Skipping (vault not created yet)."));
    return;
  }

  const credPathRaw =
    config.vault?.broker?.autoUnlockCredentialPath ??
    "~/.switchroom/vault-auto-unlock";
  const credPath = resolvePath(credPathRaw);
  if (config.vault?.broker?.autoUnlock === true && existsSync(credPath)) {
    console.log(chalk.green(`  ${STEP_DONE} Already configured (${credPath})`));
    return;
  }

  console.log(chalk.gray("  Without this, vault must be unlocked manually after every reboot."));
  console.log(chalk.gray("  Encrypted with a key derived from this machine's id — disk theft is safe; the same user on this box is not."));
  const enable = await askYesNo("  Enable vault auto-unlock at boot?", true);
  if (!enable) {
    console.log(chalk.gray("  Skipped. Run later with: switchroom vault broker enable-auto-unlock"));
    return;
  }

  // Masked passphrase prompt — handing it to AES-GCM, not echoing.
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

    try {
      encryptCredential(passphrase, credPath);
    } catch (err) {
      if (err instanceof EncryptFailedError) {
        console.log(chalk.yellow(`  Could not write auto-unlock blob: ${err.message}`));
        console.log(chalk.gray("  Retry later with: switchroom vault broker enable-auto-unlock"));
        return;
      }
      throw err;
    }
    console.log(chalk.green(`  ${STEP_DONE} Auto-unlock blob written to ${credPath}`));
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
    console.log(chalk.gray("  Retry with: switchroom apply && docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml restart vault-broker"));
  }

  // Posture prompt: passphrase (two-factor, default) vs telegram-id
  // (single-factor smoother UX). Only offered when auto-unlock is in
  // place — telegram-id requires the broker to be unlocked already.
  console.log("");
  console.log(chalk.gray("  Approve vault grants with the passphrase each time (more secure)"));
  console.log(chalk.gray("  or trust your Telegram account alone (smoother UX)?"));
  const PASSPHRASE_CHOICE = "passphrase — prompt for vault passphrase on every Approve (two-factor)";
  const TELEGRAM_ID_CHOICE = "telegram-id — Approve tap mints immediately, no passphrase prompt (single-factor)";
  const choice = await askChoice("  Approval posture", [PASSPHRASE_CHOICE, TELEGRAM_ID_CHOICE]);
  if (choice === TELEGRAM_ID_CHOICE) {
    try {
      const yamlPath = existsSync(resolve(process.cwd(), "switchroom.yaml"))
        ? resolve(process.cwd(), "switchroom.yaml")
        : resolve(process.cwd(), "switchroom.yml");
      if (existsSync(yamlPath)) {
        const content = readFileSync(yamlPath, "utf-8");
        // Use a YAML-aware rewrite scoped to vault.broker — the previous
        // regex matched any top-level `broker:` and could land the
        // posture key under the wrong block.
        const result = insertVaultBrokerApprovalAuth(content, "telegram-id");
        if (result.kind === "rewritten") {
          writeFileSync(yamlPath, result.content, "utf-8");
          console.log(
            chalk.green(`  ${STEP_DONE} Set vault.broker.approvalAuth: telegram-id in ${yamlPath}`),
          );
        } else if (result.kind === "already-set") {
          console.log(chalk.gray("  approvalAuth already set — leaving it alone."));
        } else {
          console.log(
            chalk.yellow(
              "  Could not locate vault.broker block — add `approvalAuth: telegram-id` under `vault.broker:` manually.",
            ),
          );
        }
      }
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Could not write approvalAuth: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  } else {
    console.log(chalk.green(`  ${STEP_DONE} Keeping default passphrase posture (two-factor)`));
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
          // Add dangerous_mode to each agent block. (Prior versions also added
          // skip_permission_prompt: true here — dropped as of the dead-settings
          // cleanup since it's now a no-op; autoaccept handles the boot prompt.)
          const agentPattern = new RegExp(`(^  ${name}:\\s*\\n)`, "m");
          if (agentPattern.test(content)) {
            const blockPattern = new RegExp(`^  ${name}:[\\s\\S]*?(?=^  [a-z]|\\Z)`, "m");
            const blockMatch = content.match(blockPattern);
            if (blockMatch && !blockMatch[0].includes("dangerous_mode")) {
              content = content.replace(
                agentPattern,
                `$1    dangerous_mode: true\n`,
              );
            }
          }

          // Also update the in-memory config
          config.agents[name].dangerous_mode = true;
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

// ─── Step 11: Optional Google Workspace connection (RFC G §4.6) ────────────

/**
 * Inline opt-in for Google Workspace connect, offered after the first
 * agent + bot are working. Default Y (advertised, not opt-out). Per
 * RFC G §4.6 + the principles.md "defaults test" — opinionated default,
 * easy decline.
 *
 * Phase 4 (this step) prompts and surfaces the connect command. Phase
 * 3b will swap the surfaced command from `switchroom drive connect
 * <agent>` to `switchroom auth google connect <agent>` (the wizard
 * alias added in 3b that does account add + enable in one shot).
 *
 * This step never runs the connect flow inline — connect needs an
 * OAuth tap that breaks the linear setup script. Instead it prints
 * the next-step command and continues. Operators can run it
 * immediately after setup completes if they tapped Y, or any time
 * later if they tapped N.
 */
async function stepGoogleWorkspace(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(11, "Optional: Google Workspace", STEP_ACTIVE);

  if (nonInteractive) {
    console.log(chalk.gray("  Skipping in non-interactive mode."));
    return;
  }

  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    console.log(chalk.gray("  Skipping (no agents to connect)."));
    return;
  }
  const firstName = agentNames[0];

  console.log(
    chalk.gray(
      `  Your agent (${chalk.cyan(firstName)}) can read and (with approval)`,
    ),
  );
  console.log(
    chalk.gray(
      "  write to your Google Drive, Docs, Sheets, and Calendar.",
    ),
  );
  console.log(
    chalk.gray(
      "  Tools appear as approval-gated requests in Telegram.",
    ),
  );

  const wantConnect = await askYesNo(
    `\n  ${chalk.bold("Connect Google Workspace now?")}`,
    true,
  );

  // The verb that completes the flow. Today (pre-Phase-3b) it's the
  // shipped `drive connect`. Phase 3b will introduce
  // `auth google connect <agent>` as the wizard alias and swap this
  // string. Both end up at the same OAuth flow.
  const connectCmd = `switchroom drive connect ${firstName}`;

  if (wantConnect) {
    console.log(
      chalk.green(`  ${STEP_DONE} Ready to connect`),
    );
    console.log();
    console.log(
      chalk.gray("  After setup completes, run:"),
    );
    console.log(
      chalk.cyan(`    ${connectCmd}`),
    );
    console.log(
      chalk.gray(
        "  to start the OAuth flow (device-code on headless hosts, browser otherwise).",
      ),
    );
  } else {
    console.log(
      chalk.gray(`  ${STEP_DONE} Skipped — connect later with:`),
    );
    console.log(
      chalk.cyan(`    ${connectCmd}`),
    );
  }
}

// ─── Step 12: Verification ───────────────────────────────────────────────────

async function stepVerification(
  config: SwitchroomConfig,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(12, "Verification", STEP_ACTIVE);

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
