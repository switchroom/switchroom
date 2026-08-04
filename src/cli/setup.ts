import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, copyFileSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { DEFAULT_EXAMPLE, exampleNames, readEmbeddedExample } from "./embedded-examples.js";
import { execFileSync } from "node:child_process";
import { writeConfigFileSync } from "../util/atomic.js";
import { resolve, dirname } from "node:path";
import { loadConfig, resolveAgentsDir, resolvePath, findConfigFile, ConfigError } from "../config/loader.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { syncTopics } from "../telegram/topic-manager.js";
import { loadTopicState } from "../telegram/state.js";
import { createVault, openVault, setStringSecret, getStringSecret } from "../vault/vault.js";
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
import { detectGpuCapabilities } from "../setup/gpu-detect.js";
import { saveVoiceCapability } from "../setup/host-capabilities.js";
import {
  probeDockerAvailability,
  isHindsightRunning,
  isHindsightContainerExists,
  startHindsight,
  hindsightConsumerMirrorDir,
  stopHindsight,
  ensureHindsightConsumer,
  resolveHindsightCpAccessKey,
  HINDSIGHT_CONSUMER_NAME,
  HINDSIGHT_CP_NO_ACCESS_KEY_WARNING,
  HINDSIGHT_DEFAULT_API_PORT,
  pickHindsightPorts,
  preflightHindsightPorts,
  type LiteLLMHindsightConfig,
  type DockerProbe,
} from "../setup/hindsight.js";
import { getViaBrokerStructured, readVaultTokenFile } from "../vault/broker/client.js";
import {
  ask,
  askHidden,
  askYesNo,
  askChoice,
  waitForAction,
  spinner,
  isInteractive,
} from "../setup/prompt.js";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { insertVaultBrokerApprovalAuth } from "./setup-posture-rewrite.js";
import type { PostureRewriteResult } from "./setup-posture-rewrite.js";
import {
  isValidSupergroupChatId,
  setAgentSupergroupChatId,
} from "./supergroup-setup-yaml.js";
import { setSwitchroomTimezone } from "./timezone-setup-yaml.js";
import {
  waitForAgentContainerUp,
  verifyFleetContainers,
  dedupeFindings,
  hasFatal,
  SetupVerificationError,
  type VerifyFinding,
} from "../setup/verify.js";
import type { ContainerRow } from "./doctor-docker.js";
import { composeFilePath } from "../agents/lifecycle.js";
import { detectServerTimezone } from "../config/timezone.js";
import { isValidTimezone } from "../config/schema.js";

const STEP_PENDING = chalk.gray("○");
const STEP_ACTIVE = chalk.blue("->");
const STEP_DONE = chalk.green("OK");

function stepHeader(num: number, title: string, status: string): void {
  stepHeaderTo((line) => console.log(line), num, title, status);
}

/** stepHeader with an injectable sink (tests capture output). */
function stepHeaderTo(
  log: (line: string) => void,
  num: number,
  title: string,
  status: string,
): void {
  log(`\n${status} ${chalk.bold(`Step ${num}:`)} ${title}`);
}

/**
 * Atomically persist a mutated switchroom.yaml during the setup wizard.
 *
 * A crash / ENOSPC mid-write must never truncate the operator's config.
 * Uses the bind-mount-aware writeConfigFileSync (falls back to an in-place
 * fsync'd rewrite when a single-file bind mount rejects rename(2) with
 * EBUSY) and preserves the file's existing mode bits.
 */
function writeSwitchroomYaml(configPath: string, text: string): void {
  let mode = 0o644;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    /* default 0o644 */
  }
  writeConfigFileSync(configPath, text, mode);
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

        // ── Step 4: Supergroup mode (optional) ───────────────────
        // Per-agent bot DM-only is still the default. This optional step
        // lets ONE agent own a Telegram forum supergroup by writing
        // `agents.<name>.channels.telegram.chat_id`. Skipped by default
        // (one keystroke) so the zero-config DM path is untouched. The
        // fleet-wide `telegram.forum_chat_id` sentinel "0" below is the
        // legacy DM-only marker, unrelated to per-agent supergroup mode.
        await stepSupergroupMode(agentBots, switchroomConfigPath, nonInteractive);
        const forumChatId = "0";

        // ── Step 5: Create topics ────────────────────────────────
        await stepCreateTopics(config, botToken, nonInteractive);

        // ── Step 6: Memory backend ───────────────────────────────
        // The outcome is carried into step 13: what this run believes it
        // started is what step 13 holds it to (review H1/H2).
        const memoryOutcome = await stepMemoryBackend(
          config,
          nonInteractive,
          switchroomConfigPath,
        );

        // ── Step 7: Voice engine (GPU detection + verdict) ───────
        stepVoiceEngine();

        // ── Step 8: Scaffold agents ──────────────────────────────
        await stepScaffoldAgents(
          config,
          agentBots,
          userId,
          nonInteractive,
          switchroomConfigPath,
        );

        // ── Step 9: Vault auto-unlock at boot ────────────────────
        await stepAutoUnlock(config, switchroomConfigPath, nonInteractive);

        // ── Step 10: Dangerous mode ─────────────────────────────
        await stepDangerousMode(config, switchroomConfigPath, nonInteractive);

        // ── Step 11: Agent onboarding guidance ───────────────────
        await stepOnboardingGuidance(config, nonInteractive);

        // ── Step 12: Optional Google Workspace connection (RFC G §4.6) ─
        await stepGoogleWorkspace(config, nonInteractive);

        // ── Step 13: Verification ────────────────────────────────
        // Throws (→ exit 1) when the fleet is demonstrably broken.
        const setupCompletedProps = {
          agent_count: Object.keys(config.agents).length,
          interactive: !nonInteractive,
        };
        let verdict: "verified" | "pending";
        try {
          verdict = await stepVerification(
            config,
            nonInteractive,
            {},
            {
              hindsightExpected: memoryOutcome.hindsightExpected,
              memoryOptedOut: memoryOutcome.optedOut,
            },
          );
        } catch (verifyErr) {
          // L12: `setup_completed` used to be skipped entirely when
          // verification threw, so `verified: false` never recorded the one
          // population it exists to measure — the failed installs.
          await captureEvent("setup_completed", {
            ...setupCompletedProps,
            verified: false,
          });
          throw verifyErr;
        }

        await captureEvent("setup_completed", {
          ...setupCompletedProps,
          verified: verdict === "verified",
        });

        // The closing line must not claim more than the verification step
        // actually proved (install-path review H7).
        if (verdict === "verified") {
          console.log(
            chalk.bold.green("\n  Setup complete!") +
              chalk.gray(" Your agents are running.\n"),
          );
        } else {
          console.log(
            chalk.bold.yellow("\n  Setup finished — config written, fleet not started yet.") +
              chalk.gray(" Follow the steps above to bring it up.\n"),
          );
        }
      } catch (err) {
        await captureException(err, { action: "setup" });
        process.exit(reportSetupFailure(err));
      }
    });
}

/**
 * Print a setup failure and return the process exit code.
 *
 * Split out of the action so the exit contract is testable: EVERY failure
 * path — including a failed verification — must return non-zero, so a
 * scripted/CI install (`switchroom setup --non-interactive && ...`) stops
 * instead of sailing past a dead fleet (install-path review H7).
 */
export function reportSetupFailure(
  err: unknown,
  log: (line: string) => void = (line) => console.error(line),
): number {
  if (err instanceof SetupVerificationError) {
    // The per-check rows were already printed by the verification step;
    // keep the exit message short and point at doctor.
    log(
      chalk.red(
        "\nSetup did NOT complete: verification failed (see the rows above).",
      ),
    );
    log(chalk.gray("Diagnose with: switchroom doctor"));
    return 1;
  }
  if (err instanceof ConfigError) {
    log(chalk.red(`\nConfig error: ${err.message}`));
    if (err.details) {
      for (const d of err.details) log(chalk.gray(d));
    }
    return 1;
  }
  log(chalk.red(`\nSetup failed: ${err instanceof Error ? err.message : String(err)}`));
  return 1;
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

  // Mirror the loader's own resolution ($SWITCHROOM_CONFIG → cwd →
  // ~/.switchroom/switchroom.yaml) so re-running setup from any
  // directory finds an existing user-wide config instead of
  // bootstrapping a duplicate (install-validation 2026-05-17, R1 /
  // prior #30: setup only checked cwd, so an existing
  // ~/.switchroom/switchroom.yaml was invisible from any other cwd).
  let existingConfig: string | null = configPath ?? null;
  if (!existingConfig) {
    try {
      existingConfig = findConfigFile();
    } catch {
      existingConfig = null;
    }
  }

  if (existingConfig && existsSync(existingConfig)) {
    if (!nonInteractive) {
      const useExisting = await askYesNo(
        `  Found ${chalk.cyan(existingConfig)}. Use it?`,
        true,
      );
      if (!useExisting) {
        return await copyExampleConfig(nonInteractive);
      }
    }
    console.log(chalk.gray(`  Loading ${existingConfig}`));
    const config = loadConfig(existingConfig);
    console.log(
      chalk.green(`  ${STEP_DONE} Config loaded`) +
        chalk.gray(` (${Object.keys(config.agents).length} agents)`),
    );
    // Timezone safe-default for EXISTING configs (#2483 follow-up). A
    // config that was written before the timezone wizard step (or by hand
    // without a timezone entry) leaves every agent silently resolving to
    // UTC on cloud VMs. Offer the same detect-and-prompt step here so
    // re-running setup fixes the gap. Only runs when no explicit timezone
    // is set at either the global or defaults level.
    const hasExplicitTimezone =
      config.switchroom?.timezone !== undefined ||
      (config.defaults as Record<string, unknown> | undefined)?.timezone !== undefined;
    if (!hasExplicitTimezone) {
      await writeDetectedTimezone(resolve(existingConfig), nonInteractive);
    }
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
  return await copyExampleConfig(nonInteractive);
}

async function copyExampleConfig(
  nonInteractive: boolean,
): Promise<LoadedConfig> {
  let choice: string;

  if (nonInteractive) {
    choice = DEFAULT_EXAMPLE;
  } else {
    choice = await askChoice("  Which example config?", [
      "switchroom — Full example: one active agent + commented templates",
      "minimal — Minimal single-agent config",
    ]);
    choice = choice.split(" ")[0];
  }

  // From the EMBEDDED copy, not from disk. This used to be
  // `resolve(import.meta.dirname, "../../examples")`, which is `/examples`
  // inside a `bun build --compile` artifact — so `switchroom setup` on a
  // static-binary install (the advertised `curl | sh` path, and the very first
  // command a new user runs) died with "Example config not found: switchroom.yaml"
  // and there was no way forward. #4163.
  const exampleBody = readEmbeddedExample(choice);
  if (exampleBody === null) {
    throw new ConfigError(
      `Example config not found: ${choice}.yaml (available: ${exampleNames().join(", ")})`,
    );
  }

  // Bootstrap to the canonical user-wide path, NOT cwd. Every later
  // command (apply, agent ops, daemonized gateways) resolves config
  // via findConfigFile, which ranks ~/.switchroom/switchroom.yaml as
  // the user-wide default. Writing to cwd made the freshly
  // bootstrapped config invisible the moment the operator changed
  // directories (install-validation 2026-05-17, R1 / prior #30).
  // docs/install.md has always told users it lands here.
  const destFile = resolvePath("~/.switchroom/switchroom.yaml");

  mkdirSync(dirname(destFile), { recursive: true });
  writeFileSync(destFile, exampleBody, { encoding: "utf8" });
  console.log(chalk.green(`  Copied ${choice}.yaml -> ${destFile}`));
  console.log(
    chalk.yellow(`  Edit ${destFile} to customize, then re-run switchroom setup.`),
  );

  // Timezone safe-default (#2483). A fresh config never sets
  // `switchroom.timezone`, so `resolveTimezone()` falls through to
  // `detectServerTimezone()` → "UTC" on a bare cloud VM, and every
  // agent's per-turn time hint + cron evaluation silently runs hours
  // off. Make the choice explicit at install instead of leaving it to
  // the invisible fallback. NEVER persist "UTC" (the thing we're
  // avoiding) — only a confidently-real detected zone, else prompt
  // (interactive) or warn loudly (headless).
  await writeDetectedTimezone(destFile, nonInteractive);

  const config = loadConfig(destFile);
  console.log(
    chalk.green(`  ${STEP_DONE} Config loaded`) +
      chalk.gray(` (${Object.keys(config.agents).length} agents)`),
  );
  return { config, configPath: resolve(destFile) };
}

/**
 * Detect the host timezone and persist an explicit `switchroom.timezone`
 * into the freshly-bootstrapped config (#2483). Three branches:
 *
 *   - detected a REAL non-UTC zone  → write it (no prompt needed)
 *   - detected UTC + interactive    → prompt for the real zone, validate,
 *                                     write it; on empty/declined input,
 *                                     skip the write + warn once
 *   - detected UTC + headless       → skip the write, emit ONE loud
 *                                     stderr line, degrade to today's
 *                                     UTC-fallback behaviour (no hang)
 *
 * NEVER writes "UTC": that's the silent-wrong-time fallback this whole
 * step exists to avoid. The atomic read-mutate-write mirrors the
 * setAgentSupergroupChatId / setAuthActive pattern.
 *
 * Exported for tests; production callers reach it via copyExampleConfig.
 * `detect` and `prompt` are injectable so tests don't depend on the
 * host's /etc or a live TTY.
 */
export async function writeDetectedTimezone(
  destFile: string,
  nonInteractive: boolean,
  detect: () => string | undefined = detectServerTimezone,
  prompt: (question: string, defaultValue?: string) => Promise<string> = ask,
): Promise<void> {
  const detected = detect();

  if (detected !== undefined && detected !== "UTC" && isValidTimezone(detected)) {
    // A confidently-real host zone — persist it verbatim, visible/editable.
    const before = readFileSync(destFile, "utf-8");
    const after = setSwitchroomTimezone(before, detected);
    if (after !== before) writeSwitchroomYaml(destFile, after);
    console.log(
      chalk.green(`  Detected timezone ${detected} — wrote switchroom.timezone.`),
    );
    return;
  }

  // detected === undefined or "UTC" (or an unparseable detection we won't trust).
  if (nonInteractive) {
    console.error(
      chalk.yellow(
        "  ⚠ timezone unspecified — agents will use UTC; set switchroom.timezone " +
          "(e.g. \"Australia/Melbourne\") in switchroom.yaml or agents will run hours off.",
      ),
    );
    return;
  }

  // Interactive UTC case — likely a bare cloud VM. Ask for the real zone.
  const answer = await prompt(
    "  Timezone? [detected: UTC — likely wrong; e.g. Australia/Melbourne]",
    "",
  );
  const zone = answer.trim();
  if (zone.length === 0) {
    console.error(
      chalk.yellow(
        "  ⚠ No timezone set — agents will use UTC and run hours off. " +
          "Set switchroom.timezone in switchroom.yaml when you know your zone.",
      ),
    );
    return;
  }
  if (!isValidTimezone(zone) || zone === "UTC") {
    console.error(
      chalk.yellow(
        `  ⚠ "${zone}" is not a valid IANA zone (expected Region/City like ` +
          "\"Australia/Melbourne\"). Skipping — agents will use UTC. " +
          "Edit switchroom.timezone in switchroom.yaml by hand.",
      ),
    );
    return;
  }
  const before = readFileSync(destFile, "utf-8");
  const after = setSwitchroomTimezone(before, zone);
  if (after !== before) writeSwitchroomYaml(destFile, after);
  console.log(chalk.green(`  Wrote switchroom.timezone: ${zone}.`));
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

    // Distinct vault refs → resolved token, persisted after the loop.
    // The per-agent path used to validate tokens but never write them
    // to the vault (only the single-global path did), so a hand-written
    // `agents.<n>.bot_token: "vault:..."` resolved to nothing at
    // runtime (install-validation 2026-05-17).
    const vaultWrites = new Map<string, string>();

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
        if (rawToken.startsWith("vault:")) {
          vaultWrites.set(rawToken, token);
        }
      } catch (err) {
        spin.stop(chalk.red(`Failed for ${name}: ${(err as Error).message}`));
        throw err;
      }
    }

    // Persist every per-agent vault ref so the runtime can resolve it.
    if (vaultWrites.size > 0) {
      if (nonInteractive && !process.env.SWITCHROOM_VAULT_PASSPHRASE) {
        throw new Error(
          "SWITCHROOM_VAULT_PASSPHRASE must be set before running setup in non-interactive mode when config uses vault: refs.",
        );
      }
      for (const [ref, tok] of vaultWrites) {
        await storeTokenInVault(config, ref, tok);
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
    await storeTokenInVault(config, config.telegram.bot_token, token);
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

// `vaultRef` is the `vault:`-prefixed reference the resolved token
// should be persisted under (e.g. "vault:telegram-coach-bot-token").
// Previously this hardcoded the key from config.telegram.bot_token,
// which is wrong for per-agent bot tokens — the per-agent path never
// persisted them, so a hand-written `agents.<n>.bot_token:
// "vault:..."` ref was validated but never written to the vault and
// resolved to nothing at runtime (install-validation 2026-05-17).
async function storeTokenInVault(
  config: SwitchroomConfig,
  vaultRef: string,
  token: string,
): Promise<void> {
  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  const key = vaultRef.replace("vault:", "");

  if (!existsSync(vaultPath)) {
    console.log(chalk.gray("  Creating encrypted vault..."));
    let passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (!passphrase) {
      passphrase = await askHidden("  Vault passphrase (for encrypting secrets)");
      if (!passphrase) throw new Error("Vault passphrase is required");
    }
    createVault(passphrase, vaultPath);
    console.log(chalk.green(`  ${STEP_DONE} Vault created at ${vaultPath}`));

    setStringSecret(passphrase, vaultPath, key, token);
    console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault (${key})`));
  } else {
    let passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (!passphrase) {
      passphrase = await askHidden("  Vault passphrase");
    }
    if (passphrase) {
      try {
        setStringSecret(passphrase, vaultPath, key, token);
        console.log(chalk.green(`  ${STEP_DONE} Bot token stored in vault (${key})`));
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

// ─── Step 4: Supergroup mode (optional) ──────────────────────────────────────
//
// DM-only is the default and stays one keystroke away (the prompt defaults to
// "no"). This step exists for discoverability: an operator setting up should
// learn supergroup mode is available and be able to flip a single agent into
// it without hand-editing YAML or hunting through docs. It writes only
// `agents.<name>.channels.telegram.chat_id` — the schema smart-defaults
// `default_topic_id` to General — and points at docs/supergroup-mode.md
// for the richer knobs (default_topic_id, topic_aliases, ops-lane routing).
const SUPERGROUP_DOC = "docs/supergroup-mode.md";

async function stepSupergroupMode(
  agentBots: Record<string, BotTokenInfo>,
  configPath: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(4, "Supergroup mode (optional)", STEP_ACTIVE);

  if (nonInteractive) {
    console.log(
      chalk.gray(
        `  ${STEP_DONE} Skipped (DM-only default). To have one agent own a forum`,
      ),
    );
    console.log(chalk.gray(`     supergroup, see ${SUPERGROUP_DOC}.`));
    return;
  }

  console.log(
    chalk.gray(
      "  Most setups stay DM-only — each agent DMs you privately. Supergroup",
    ),
  );
  console.log(
    chalk.gray(
      "  mode instead has ONE agent own a Telegram forum supergroup and route",
    ),
  );
  console.log(
    chalk.gray("  its replies + automated events into per-topic threads. Opt-in."),
  );

  const want = await askYesNo(
    "  Configure an agent to own a forum supergroup now?",
    false,
  );
  if (!want) {
    console.log(
      chalk.gray(`  ${STEP_DONE} Staying DM-only. Enable later via ${SUPERGROUP_DOC}.`),
    );
    return;
  }

  const agentNames = Object.keys(agentBots);
  if (agentNames.length === 0) {
    console.log(
      chalk.yellow(`  No agents configured yet — skipping. See ${SUPERGROUP_DOC}.`),
    );
    return;
  }
  const agent =
    agentNames.length === 1
      ? agentNames[0]
      : await askChoice("  Which agent owns the supergroup?", agentNames);

  console.log(
    chalk.gray(
      "  First create the forum supergroup in Telegram (a group with Topics",
    ),
  );
  console.log(
    chalk.gray(
      "  enabled) and add the agent's bot as an admin. Its id is the digits in",
    ),
  );
  console.log(
    chalk.gray(
      "  a message link t.me/c/<id>/… written as a negative -100… number.",
    ),
  );

  const chatId = await ask(
    "  Supergroup chat_id (e.g. -1001234567890, or Enter to skip)",
  );
  if (!chatId) {
    console.log(
      chalk.gray(`  ${STEP_DONE} Skipped — no chat_id entered. See ${SUPERGROUP_DOC}.`),
    );
    return;
  }
  if (!isValidSupergroupChatId(chatId)) {
    console.log(
      chalk.yellow(
        `  "${chatId}" isn't a valid supergroup id (need a negative integer like`,
      ),
    );
    console.log(
      chalk.yellow(`  -1001234567890). Add it by hand later — ${SUPERGROUP_DOC}.`),
    );
    return;
  }

  try {
    const fs = await import("node:fs");
    const { atomicWriteFileSync } = await import("../util/atomic.js");
    const raw = fs.readFileSync(configPath, "utf-8");
    const after = setAgentSupergroupChatId(raw, agent, chatId);
    let mode = 0o644;
    try {
      mode = fs.statSync(configPath).mode & 0o777;
    } catch {
      /* default */
    }
    atomicWriteFileSync(configPath, after, mode);
    console.log(
      chalk.green(
        `  ${STEP_DONE} ${agent} now owns supergroup ${chatId} — replies + ops route to its topics.`,
      ),
    );
    console.log(
      chalk.gray(
        "     Fallback topic defaults to General (1). Add default_topic_id /",
      ),
    );
    console.log(
      chalk.gray(
        `     topic_aliases by hand — ${SUPERGROUP_DOC}. Run \`switchroom apply\` to activate.`,
      ),
    );
  } catch (err) {
    console.log(
      chalk.yellow(`  Could not write chat_id: ${(err as Error).message}`),
    );
    console.log(chalk.gray(`  Add it by hand — see ${SUPERGROUP_DOC}.`));
  }
}

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

async function resolveLiteLLMForHindsight(
  config: SwitchroomConfig,
): Promise<LiteLLMHindsightConfig | undefined> {
  const topLiteLLM = (config as { litellm?: { enabled?: boolean; base_url?: string } }).litellm;
  if (!topLiteLLM?.enabled || !topLiteLLM.base_url) return undefined;
  // Issue #1053: forward the agent's capability token so the broker's grant
  // path bypasses the peercred ACL. Without it a freshly-minted grant is
  // ignored and the `.catch(() => null)` silently swallows the DENIED,
  // leaving LiteLLM routing (ANTHROPIC_BASE_URL/headers) underived. Mirrors
  // the working `vault get` path in src/cli/vault.ts. Token stays undefined
  // when SWITCHROOM_AGENT_NAME is unset — identical to prior host-operator
  // peercred behavior.
  const agentSlug = process.env.SWITCHROOM_AGENT_NAME;
  const token = agentSlug ? readVaultTokenFile(agentSlug) ?? undefined : undefined;
  const result = await getViaBrokerStructured("litellm/hindsight/api-key", {
    ...(token ? { token } : {}),
  }).catch(() => null);
  if (!result || result.kind !== "ok" || result.entry.kind !== "string") return undefined;
  return {
    baseUrl: topLiteLLM.base_url,
    apiKey: result.entry.value,
    model: config.memory?.config?.llm_model,
  };
}

/** Injectable seams for the memory-backend step (tests: no docker needed). */
export interface MemoryBackendDeps {
  /** Docker probe passed to `isDockerAvailable` / container checks. */
  dockerProbe?: DockerProbe;
  /** Poll sleep while waiting for the container to report running. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to re-check `docker ps` after `startHindsight`. */
  readyRetries?: number;
  /**
   * The `docker run` seam. Injected so tests can exercise the
   * "start returned but the container is not there" path (review H2)
   * without docker.
   */
  startContainer?: typeof startHindsight;
}

/**
 * What step 6 actually left behind, so step 13 can hold it to account.
 *
 * `hindsightExpected` is true ONLY when this run believes a working
 * `switchroom-hindsight` container exists. Step 13 turns that into a hard
 * requirement (review H2): without it, every path where step 6 gave up
 * silently produced a wizard that ended with "Setup complete! Your agents
 * are running." over a dead memory backend.
 */
export interface MemoryBackendOutcome {
  hindsightExpected: boolean;
  /** True when the operator took the `none` opt-out (config or env). */
  optedOut: boolean;
}

/** True when memory is switched off by env or config — the H1 opt-out. */
export function isMemoryBackendDisabled(config: SwitchroomConfig): boolean {
  const memoryBackend = config.memory?.backend ?? "hindsight";
  return process.env.SWITCHROOM_MEMORY_BACKEND === "none" || memoryBackend === "none";
}

export async function stepMemoryBackend(
  config: SwitchroomConfig,
  nonInteractive: boolean,
  switchroomConfigPath: string,
  deps: MemoryBackendDeps = {},
): Promise<MemoryBackendOutcome> {
  stepHeader(6, "Memory backend", STEP_ACTIVE);

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Check if memory backend is configured and is hindsight
  if (isMemoryBackendDisabled(config)) {
    console.log(chalk.gray("  Memory backend disabled (set to 'none')."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return { hindsightExpected: false, optedOut: true };
  }

  // In non-interactive mode, default to hindsight unless env says otherwise
  let setupHindsight = true;
  if (!nonInteractive) {
    console.log(
      chalk.gray(
        "  Hindsight will use Anthropic OAuth via the auth-broker. The fleet's",
      ),
    );
    console.log(
      chalk.gray(
        "  active account (auth.active) is shared — no OpenAI API key is needed.",
      ),
    );
    setupHindsight = await askYesNo(
      "  Set up Hindsight memory? (recommended)",
      true,
    );
  }

  if (!setupHindsight) {
    console.log(chalk.gray("  Skipping Hindsight setup."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return { hindsightExpected: false, optedOut: false };
  }

  // Surface a one-liner if the legacy OpenAI key still exists in vault or env.
  // Pre-#1245 setups stored it under `hindsight-api-key`; pre-broker setups
  // also accepted HINDSIGHT_API_LLM_API_KEY. Neither is consulted any more.
  if (process.env.HINDSIGHT_API_LLM_API_KEY) {
    console.log(
      chalk.gray(
        "  Note: HINDSIGHT_API_LLM_API_KEY is set in your env but is no longer used. " +
          "You can remove it.",
      ),
    );
  }
  try {
    const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
    const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (passphrase && existsSync(vaultPath)) {
      const existing = getStringSecret(passphrase, vaultPath, "hindsight-api-key");
      if (existing) {
        console.log(
          chalk.gray(
            "  Note: legacy 'hindsight-api-key' is in your vault but is no longer used. " +
              "You can remove it with `switchroom vault rm hindsight-api-key`.",
          ),
        );
      }
    }
  } catch { /* vault unreachable; skip the courtesy note */ }

  // Register the hindsight consumer in switchroom.yaml so the auth-broker
  // binds a per-consumer UDS for it on next `switchroom apply`. Registered
  // UNPINNED (no `account:`): the consumer follows the fleet `auth.active`
  // with the same failover agents get. Operators who want quota isolation
  // can add an explicit `account:` pin afterwards.
  {
    try {
      const result = await ensureHindsightConsumer(switchroomConfigPath);
      if (result.added) {
        console.log(
          chalk.green(
            `  ${STEP_DONE} Registered auth.consumers[${HINDSIGHT_CONSUMER_NAME}] (follows the fleet active account)`,
          ),
        );
      } else {
        console.log(
          chalk.gray(
            `  auth.consumers[${HINDSIGHT_CONSUMER_NAME}] already present.`,
          ),
        );
      }
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Warning: could not write auth.consumers entry: ${(err as Error).message}`,
        ),
      );
    }
  }

  // Check Docker availability.
  //
  // Pre-H7 this printed a GREEN `OK Manual setup pending` and returned — so
  // a host with no Docker (where nothing in the fleet can run) still saw a
  // successful step and a "Setup complete!" at the end. Hindsight is the
  // default memory backend and it is a container; if Docker is absent the
  // step did not succeed, so say so and fail. (Compatible with the
  // hindsight-default-on direction in
  // docs/proposed/hindsight-litellm-integration-audit-2026-07-26.md item 5:
  // "a hard, named failure with a resume instruction". The opt-out below is
  // the documented escape hatch for a Docker-less machine.)
  // Review L8: `docker --version` only proves the CLI is on PATH. The far
  // more common macOS case is "installed but Docker Desktop isn't running",
  // where "Install Docker" is the wrong instruction. Name which one it is.
  const dockerState = probeDockerAvailability(deps.dockerProbe);
  if (dockerState !== "ok") {
    const noCli = dockerState === "no-cli";
    const headline = noCli
      ? "Docker is not installed (no `docker` command on PATH)."
      : "Docker is installed but its daemon is not responding.";
    const remedy = noCli
      ? "Install Docker (https://docs.docker.com/get-docker/), then re-run `switchroom setup`"
      : "Start Docker (on macOS: open Docker Desktop; on Linux: `sudo systemctl start docker`), " +
        "then re-run `switchroom setup`";
    console.log(chalk.red(`  x ${headline}`));
    console.log(
      chalk.gray(
        "  Hindsight memory runs as a Docker container (and so does every agent).",
      ),
    );
    console.log(
      chalk.gray(`  ${remedy} — or re-run with SWITCHROOM_MEMORY_BACKEND=none to skip memory setup.`),
    );
    throw new Error(
      `Memory backend setup failed: ${headline} ${remedy}, or set ` +
        "SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  // Check if already running
  if (isHindsightRunning(deps.dockerProbe)) {
    console.log(chalk.green(`  ${STEP_DONE} Hindsight container already running (switchroom-hindsight)`));
    return { hindsightExpected: true, optedOut: false };
  }

  // Check if container exists but is stopped
  if (isHindsightContainerExists(deps.dockerProbe)) {
    console.log(chalk.gray("  Found stopped switchroom-hindsight container, removing..."));
    stopHindsight();
  }

  // Pick + preflight host ports through the SAME guard `switchroom memory`
  // uses, so a fresh install never hands an occupied host port to
  // `docker run` (the 2026-07 crash-loop: hindsight died on `[Errno 98]
  // address already in use` while fleet memory was silently down). Upstream
  // default 18888/19999 first, fall back to a free pair if occupied.
  //
  // Review H2: each `return` below used to leave the step "successful" with
  // no memory backend running — and step 13 had nothing to catch it, so the
  // wizard still printed "Setup complete! Your agents are running." They are
  // throws now, in the same shape as the Docker-absent failure above:
  // a named error with a resume instruction.
  let ports: { apiPort: number; uiPort: number };
  try {
    ports = await pickHindsightPorts();
  } catch (err) {
    console.log(chalk.red(`  ${(err as Error).message}`));
    throw new Error(
      `Memory backend setup failed: could not allocate Hindsight ports: ${
        (err as Error).message
      }. Free a port and re-run \`switchroom setup\`, or set ` +
        "SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }
  if (ports.apiPort !== HINDSIGHT_DEFAULT_API_PORT) {
    console.log(
      chalk.yellow(
        `  Port ${HINDSIGHT_DEFAULT_API_PORT} is already in use; ` +
          `using ${ports.apiPort}/${ports.uiPort} instead.`,
      ),
    );
  }

  // Preflight: NEVER hand an occupied host port to `docker run`. If the
  // chosen port is occupied, re-pick from scratch; if still occupied, abort
  // loudly rather than crash-looping.
  let conflict = await preflightHindsightPorts(ports);
  if (conflict) {
    const heldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
    console.log(
      chalk.yellow(
        `  Chosen Hindsight port ${conflict.port} is occupied${heldBy}; ` +
          `selecting a free port instead of crash-looping.`,
      ),
    );
    try {
      ports = await pickHindsightPorts();
    } catch (err) {
      console.log(chalk.red(`  ${(err as Error).message}`));
      throw new Error(
        `Memory backend setup failed: could not allocate Hindsight ports after ` +
          `reassignment: ${(err as Error).message}. Free a port and re-run ` +
          "`switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
      );
    }
    conflict = await preflightHindsightPorts(ports);
    if (conflict) {
      const stillHeldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
      const msg =
        `Refusing to start Hindsight: port ${conflict.port} is still ` +
        `occupied${stillHeldBy} after reassignment.`;
      console.log(chalk.red(`  ${msg}`));
      throw new Error(
        `Memory backend setup failed: ${msg} Free it and re-run ` +
          "`switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
      );
    }
    console.log(
      chalk.green(`  Reassigned Hindsight to port ${ports.apiPort}/${ports.uiPort}.`),
    );
  }

  // Start the container in broker-fed mode (no API key).
  const spin = spinner("Starting Hindsight Docker container...");
  try {
    const litellmCfg = await resolveLiteLLMForHindsight(config);
    const cpAccessKey = await resolveHindsightCpAccessKey(config);
    if (!cpAccessKey) {
      console.log(chalk.yellow(`  ! ${HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}`));
    }
    const startContainer = deps.startContainer ?? startHindsight;
    startContainer(
      ports,
      litellmCfg,
      undefined,
      config.hindsight?.llm,
      hindsightConsumerMirrorDir(config),
      // gpu: omitted ⇒ hindsightGpuEnabled() reads the persisted verdict.
      undefined,
      // perf: omitted ⇒ the managed defaults, same as before.
      undefined,
      // Resolved `hindsight.cp_access_key` — absent ⇒ loginless dashboard,
      // pinned to loopback by hindsightCpAuthEnvPairs.
      cpAccessKey,
    );
    if (litellmCfg) {
      console.log(chalk.gray("  LiteLLM routing enabled (--network host, ANTHROPIC_BASE_URL set)."));
    }
  } catch (err) {
    spin.stop(chalk.red(`Failed to start Hindsight: ${(err as Error).message}`));
    console.log(
      chalk.gray(
        "  Make sure `switchroom apply` has run so the auth-broker " +
          `consumer socket volume (auth-broker-${HINDSIGHT_CONSUMER_NAME}-sock) exists.`,
      ),
    );
    throw new Error(
      `Memory backend setup failed: ${(err as Error).message}. Fix the cause and ` +
        "re-run `switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  // `docker run -d` returning is not evidence the container survived. Re-check
  // a few times before deciding (a container that dies during startup drops
  // out of `docker ps` within a second or two). Deliberately OUTSIDE the try
  // above so this verdict is not re-wrapped as a start error.
  let running = isHindsightRunning(deps.dockerProbe);
  const retries = deps.readyRetries ?? HINDSIGHT_READY_RETRIES;
  for (let i = 0; !running && i < retries; i++) {
    await sleep(HINDSIGHT_READY_INTERVAL_MS);
    running = isHindsightRunning(deps.dockerProbe);
  }

  if (!running) {
    // H2: this was a yellow "Container started but may still be
    // initializing" that the wizard then reported as overall success.
    spin.stop(chalk.red("Hindsight container did not stay running after start"));
    throw new Error(
      "Memory backend setup failed: switchroom-hindsight did not stay running " +
        "after start. Check `docker logs switchroom-hindsight --tail 50`, then " +
        "re-run `switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  spin.stop(chalk.green(`${STEP_DONE} Hindsight container started (switchroom-hindsight)`));
  console.log(chalk.gray(`  API: http://localhost:${ports.apiPort}/mcp`));
  console.log(chalk.gray(`  UI:  http://localhost:${ports.uiPort}`));

  return { hindsightExpected: true, optedOut: false };
}

/** Re-checks of `docker ps` after `startHindsight` before calling it dead. */
const HINDSIGHT_READY_RETRIES = 5;
/** Gap between those re-checks. */
const HINDSIGHT_READY_INTERVAL_MS = 1_000;

// ─── Step 7: Voice engine (GPU detection + verdict) ──────────────────────────

/**
 * Detect the host's GPU capabilities, derive the local-vs-cloud voice-engine
 * verdict, persist it to `~/.switchroom/host-capabilities.json`, and print
 * the decision inline (principles.md #1 — the user learns the decision and
 * its *why* at setup, not from docs).
 *
 * Switchroom runs voice on LOCAL GPU models by default WHEN a GPU is usable
 * from a container, falling back to cloud providers otherwise. PR-B2 reads
 * the persisted verdict to decide whether to emit the GPU voice sidecar.
 * This step is the same in interactive and non-interactive mode — detection
 * needs no prompt; it's a pure host probe.
 *
 * Detection failures must never break setup: a probe error degrades to the
 * cloud verdict (the safe, always-available default).
 */
export function stepVoiceEngine(): void {
  stepHeader(7, "Voice engine", STEP_ACTIVE);

  let caps;
  try {
    caps = detectGpuCapabilities();
  } catch (err) {
    // A probe that threw (unexpected — the probes are defensive) must not
    // sink setup. Fall back to the cloud verdict and say so.
    console.log(
      chalk.yellow(
        `  Could not probe GPU (${err instanceof Error ? err.message : String(err)}) — ` +
          "assuming no GPU; voice will use cloud providers if you enable it.",
      ),
    );
    caps = {
      gpuPresent: false,
      containerToolkit: false,
      engine: "cloud" as const,
      reason:
        "No GPU detected — voice will use cloud providers if you enable it.",
    };
  }

  // Persist the verdict so update / doctor / compose-gen (PR-B2) re-read it
  // without re-probing every boot. A write failure is non-fatal — re-detect
  // is always possible.
  try {
    saveVoiceCapability(caps);
  } catch (err) {
    console.log(
      chalk.yellow(
        `  Detected the verdict but could not persist host-capabilities.json: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  // Inline decision messaging — the three branches from the verdict.
  if (caps.engine === "local") {
    console.log(chalk.green(`  ${STEP_DONE} ${caps.reason}`));
  } else if (caps.gpuPresent) {
    // GPU present but toolkit missing — actionable, so warn (yellow) with
    // the install hint that `reason` already carries.
    console.log(chalk.yellow(`  ${caps.reason}`));
  } else {
    console.log(chalk.gray(`  ${STEP_DONE} ${caps.reason}`));
  }
}

// ─── Step 8: Scaffold Agents ─────────────────────────────────────────────────

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
  stepHeader(8, "Scaffold agents", STEP_ACTIVE);

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

  // Persona seed. SOUL.md is user-owned: seeded once here from these
  // answers (or the profile default when skipped), then never
  // overwritten by update/reconcile. Answers are folded into the
  // in-memory agent config so scaffoldAgent's seed render picks them
  // up; we deliberately do NOT write them back to switchroom.yaml —
  // post-seed the file is the source of truth, not config. Skipped
  // wholesale in non-interactive mode (profile default persona).
  if (!nonInteractive && isInteractive()) {
    console.log(
      chalk.gray(
        "\n  Persona — give each agent a voice. Press Enter to skip any " +
          "line and use the profile default. You can edit SOUL.md freely " +
          "afterwards; updates never overwrite it.",
      ),
    );
    for (const name of agentNames) {
      const agentConfig = config.agents[name];
      console.log(
        `\n  ${chalk.bold(name)} ${chalk.gray(
          `(${agentConfig.extends ?? "default"})`,
        )}`,
      );
      const personaName = await ask("    Name");
      const style = await ask("    Style in a sentence");
      const boundaries = await ask("    Anything it must never do");
      const soul: Record<string, string> = {};
      if (personaName) soul.name = personaName;
      if (style) soul.style = style;
      if (boundaries) soul.boundaries = boundaries;
      if (Object.keys(soul).length > 0) {
        // Cast mirrors src/config/merge.ts: AgentSoulSchema nominally
        // requires name+style, but a partial persona is valid here —
        // SOUL.md.hbs renders missing fields via {{#if}}.
        agentConfig.soul = {
          ...(agentConfig.soul ?? {}),
          ...soul,
        } as AgentConfig["soul"];
      }
    }
  }

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
  if (scaffolded > 0) {
    console.log(
      chalk.gray(
        "  Each agent's persona lives in its SOUL.md and is yours to edit " +
          "— `switchroom soul path <agent>` shows where. `switchroom " +
          "update` never overwrites it; `switchroom soul reset <agent>` " +
          "re-seeds from the profile (backing the old one up first).",
      ),
    );
  }

  // RFC H §4.6: first-run defaults `auth.active` to "default" so the
  // first OAuth flow (run as `switchroom auth add default --from-oauth`)
  // lands the fleet on a working account without any per-agent `auth:`
  // block. Idempotent — does nothing when `auth.active` is already set.
  if (switchroomConfigPath && !config.auth?.active) {
    try {
      await ensureAuthActiveDefault(switchroomConfigPath);
      console.log(
        chalk.gray(
          "  Set auth.active: default — run `switchroom auth add default --via-claude` to log in",
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
 * Set `auth.active: default` in switchroom.yaml when unset. Atomic
 * write via the shared util. Idempotent — does nothing when
 * `auth.active` is already set.
 *
 * The YAML mutation itself lives in src/cli/auth-active-yaml.ts so
 * `switchroom auth use|rotate` can share it (caught during the
 * 2026-05-15 RFC H redeploy: `auth use` updated broker state but
 * never wrote the YAML, leaving doctor red).
 */
async function ensureAuthActiveDefault(configPath: string): Promise<void> {
  const fs = await import("node:fs");
  const { parseDocument, isMap } = await import("yaml");
  const { atomicWriteFileSync } = await import("../util/atomic.js");
  const { setAuthActive } = await import("./auth-active-yaml.js");
  const raw = fs.readFileSync(configPath, "utf-8");
  // Guard: only seed "default" when auth.active is unset (setAuthActive
  // would otherwise overwrite an operator-pinned active).
  const doc = parseDocument(raw);
  const root = doc.contents;
  if (!isMap(root)) return;
  const existing = root.get("auth", true);
  if (isMap(existing) && existing.has("active")) return;
  const after = setAuthActive(raw, "default");
  if (after === raw) return;
  let mode = 0o644;
  try { mode = fs.statSync(configPath).mode & 0o777; } catch { /* default */ }
  atomicWriteFileSync(configPath, after, mode);
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
  stepHeader(9, "Vault auto-unlock at boot", STEP_ACTIVE);

  const envPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (nonInteractive && !(envPass && envPass.length > 0)) {
    // Unattended install that did NOT supply the passphrase signal:
    // leave auto-unlock unconfigured — do not weaken an install that
    // didn't opt into unattended operation. With the passphrase
    // present we proceed: an always-on fleet MUST survive a broker
    // recreate (routine `switchroom apply`) with no human in the
    // loop. Previously this ALWAYS skipped non-interactively, so the
    // canonical unattended install could never auto-unlock — every
    // `apply` then bricked vault-ref agents (install-validation
    // 2026-05-17 / RFC J Phase 1).
    console.log(chalk.gray("  Skipping (non-interactive, no SWITCHROOM_VAULT_PASSPHRASE)."));
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
  if (!nonInteractive) {
    const enable = await askYesNo("  Enable vault auto-unlock at boot?", true);
    if (!enable) {
      console.log(chalk.gray("  Skipped. Run later with: switchroom vault broker enable-auto-unlock"));
      return;
    }
  } else {
    // Non-interactive + passphrase present (guarded at the top): the
    // operator opted into unattended operation, so auto-unlock is the
    // correct default — proceed without prompting (RFC J Phase 1).
    console.log(chalk.gray("  Enabling (non-interactive, SWITCHROOM_VAULT_PASSPHRASE present)."));
  }

  // $SWITCHROOM_VAULT_PASSPHRASE is the unattended signal (same source
  // setup/gateway use); else masked prompt. Handed to AES-GCM, not
  // echoed.
  let passphrase: string;
  if (envPass && envPass.length > 0) {
    passphrase = envPass;
  } else {
    try {
      passphrase = await promptPassphrase();
    } catch (err) {
      console.log(chalk.yellow(`  Skipped: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
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

  if (nonInteractive) {
    // The approval-posture choice below is interactive-only. A
    // non-interactive install keeps the default (passphrase /
    // two-factor) posture — auto-unlock is now configured, which was
    // the goal of this step.
    return;
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
    // Persist to the canonical config path that stepConfigFile resolved
    // (~/.switchroom/switchroom.yaml, or an explicit --config) — the same
    // file every other setup step writes. The previous code resolved the
    // path from process.cwd(), so running setup from any directory other
    // than the config dir silently dropped this single-factor posture
    // choice with no error (2026-07-11 review, HIGH). Fail loud if the
    // canonical config is missing or unwritable rather than no-op.
    const kind = persistApprovalAuthTelegramId(switchroomConfigPath);
    if (kind === "rewritten") {
      console.log(
        chalk.green(`  ${STEP_DONE} Set vault.broker.approvalAuth: telegram-id in ${switchroomConfigPath}`),
      );
    } else if (kind === "already-set") {
      console.log(chalk.gray("  approvalAuth already set — leaving it alone."));
    } else {
      console.log(
        chalk.yellow(
          "  Could not locate vault.broker block — add `approvalAuth: telegram-id` under `vault.broker:` manually.",
        ),
      );
    }
  } else {
    console.log(chalk.green(`  ${STEP_DONE} Keeping default passphrase posture (two-factor)`));
  }
}

// ─── Step 9: Dangerous Mode ─────────────────────────────────────────────────

/**
 * Insert `vault.broker.approvalAuth: telegram-id` into the canonical
 * config at `configPath`, failing loud if that file is missing/unwritable.
 *
 * Extracted from stepAutoUnlock so the persistence (and its fail-loud
 * contract) can be exercised in unit tests without the interactive vault
 * flow. Returns the underlying rewrite kind so the caller can render the
 * right message (`not-found` is a loud manual-edit hint, not a silent
 * no-op). A missing config throws — the operator's posture choice must
 * never be silently discarded (2026-07-11 review, HIGH).
 */
export function persistApprovalAuthTelegramId(
  configPath: string,
): PostureRewriteResult["kind"] {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Cannot persist vault.broker.approvalAuth: config not found at ${configPath}`,
    );
  }
  const content = readFileSync(configPath, "utf-8");
  // YAML-aware rewrite scoped to vault.broker — a plain regex could land
  // the posture key under an unrelated top-level `broker:` block.
  const result = insertVaultBrokerApprovalAuth(content, "telegram-id");
  if (result.kind === "rewritten") {
    // Atomic (tmp + rename, bind-mount-aware) so a crash / ENOSPC
    // mid-write can never truncate the operator's canonical config.
    writeSwitchroomYaml(configPath, result.content);
  }
  return result.kind;
}

/**
 * Write `dangerous_mode: true` into every agent block of the canonical
 * config at `configPath` (and mirror it into the in-memory `config`).
 *
 * Extracted from stepDangerousMode for the same reason: the write must
 * target the SAME canonical config the rest of setup resolves, not
 * process.cwd(), and must fail loud rather than no-op when that file is
 * missing (2026-07-11 review, HIGH). Throws if `configPath` doesn't exist.
 */
export function persistDangerousMode(
  config: SwitchroomConfig,
  configPath: string,
): void {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Cannot persist dangerous_mode: config not found at ${configPath}`,
    );
  }
  let content = readFileSync(configPath, "utf-8");
  const agentNames = Object.keys(config.agents);

  for (const name of agentNames) {
    // Add dangerous_mode to each agent block. (Prior versions also added
    // skip_permission_prompt: true here — dropped as of the dead-settings
    // cleanup since it's now a no-op; autoaccept handles the boot prompt.)
    const agentPattern = new RegExp(`(^  ${name}:\\s*\\n)`, "m");
    if (agentPattern.test(content)) {
      // Match this agent's block up to the next 2-space top-level key OR
      // end of input. The end-of-input arm was `\Z`, which in JS regex is
      // a literal `Z` (JS has no `\Z` anchor) — so the LAST agent's block
      // never matched and its dangerous_mode was silently dropped from the
      // file (2026-07-11 review, LOW). `(?![\s\S])` is a true end-of-string
      // assertion that works under the `m` flag.
      const blockPattern = new RegExp(
        `^  ${name}:[\\s\\S]*?(?=^  [a-z]|(?![\\s\\S]))`,
        "m",
      );
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

  // Atomic (tmp + rename, bind-mount-aware) so a crash / ENOSPC
  // mid-write can never truncate the operator's canonical config.
  writeSwitchroomYaml(configPath, content);
}

async function stepDangerousMode(
  config: SwitchroomConfig,
  switchroomConfigPath: string,
  nonInteractive: boolean,
): Promise<void> {
  stepHeader(10, "Auto-approve mode", STEP_ACTIVE);

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
    // Persist to the canonical config stepConfigFile resolved, NOT
    // process.cwd(). Running setup outside the config dir previously
    // wrote this choice to a stray cwd file — or nowhere — with no error
    // (2026-07-11 review, HIGH). persistDangerousMode fails loud if the
    // canonical config is missing/unwritable.
    persistDangerousMode(config, switchroomConfigPath);
    console.log(chalk.green(`  ${STEP_DONE} Enabled dangerous_mode for all agents in ${switchroomConfigPath}`));
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
  stepHeader(11, "Agent onboarding", STEP_ACTIVE);

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
  stepHeader(12, "Optional: Google Workspace", STEP_ACTIVE);

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

  // RFC G Phase 3b.6 — surfaces the post-3b two-step shape per RFC
  // G v3 §4.6. Pre-3b.6 this was `switchroom drive connect <agent>`;
  // post-3b.3 + 3b.2c the `auth google account add <email>` verb
  // mints credentials in the broker, then `auth google enable
  // <email> <agent>` writes the per-agent ACL.
  //
  // `account add` runs the full desktop-loopback OAuth flow end-to-end
  // (mints + validates the refresh token, registers with the auth-broker);
  // `enable` then writes the per-agent ACL. `drive connect <agent>` is the
  // older single-agent onramp, kept as an alternative.
  const accountAddCmd = `switchroom auth google account add <your-google-account-email>`;
  const enableCmd = `switchroom auth google enable <your-google-account-email> ${firstName}`;
  const fallbackCmd = `switchroom drive connect ${firstName}`;

  if (wantConnect) {
    console.log(chalk.green(`  ${STEP_DONE} Ready to connect`));
    console.log();
    console.log(chalk.gray("  After setup completes:"));
    console.log();
    console.log(
      chalk.gray(`    Step 1 — register the Google account with the auth-broker:`),
    );
    console.log(chalk.cyan(`      ${accountAddCmd}`));
    console.log();
    console.log(chalk.gray(`    Step 2 — enable the account on ${chalk.bold(firstName)}:`));
    console.log(chalk.cyan(`      ${enableCmd}`));
    console.log();
    console.log(
      chalk.gray(`    (\`account add\` runs the OAuth flow in your browser. Older`),
    );
    console.log(
      chalk.gray(`     single-agent alternative: ${fallbackCmd})`),
    );
  } else {
    console.log(chalk.gray(`  ${STEP_DONE} Skipped — connect later with:`));
    console.log(chalk.cyan(`    ${accountAddCmd}`));
    console.log(chalk.cyan(`    ${enableCmd}`));
    console.log(
      chalk.gray(`  (or the v0.6.0 fallback: ${fallbackCmd})`),
    );
  }
}

// ─── Step 13: Verification ───────────────────────────────────────────────────

/**
 * Injectable seams for the verification step. Tests drive the whole step
 * without docker, without a `switchroom` binary on PATH, and without
 * wall-clock waits.
 */
export interface VerificationDeps {
  /** `docker ps -a` rows; null when docker is unreachable. */
  listContainers?: () => ContainerRow[] | null;
  /** Poll sleep — no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs `switchroom agent start <name>`; throws on failure. */
  startAgent?: (name: string) => void;
  /** Interactive "start it now?" prompt. */
  confirmStart?: (names: string[]) => Promise<boolean>;
  /**
   * Whether `switchroom apply` has generated the compose file yet. When it
   * has not, there is nothing to start and we must not offer to (H3c).
   */
  composeFileExists?: () => boolean;
  /** Output sink (defaults to console.log). */
  log?: (line: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
  stableSamples?: number;
  /** Forwarded to `verifyFleetContainers` (M4). */
  confirmSamples?: number;
  confirmIntervalMs?: number;
}

/** What step 6 left behind; step 13 holds the run to it (H1/H2). */
export interface VerificationExpectations {
  hindsightExpected?: boolean;
  /** Memory opted out ⇒ this run did not require docker (H1). */
  memoryOptedOut?: boolean;
}

/** Lines of captured child output to quote back on a failed start. */
const START_OUTPUT_TAIL_LINES = 12;

function defaultStartAgent(name: string): void {
  // Keep shelling out to the `switchroom` CLI (not lifecycle.startAgent
  // directly) so the operator gets the same reconcile-then-start path
  // `switchroom agent start` performs.
  //
  // Review H3(b): with `stdio: "inherit"` the only failure this could ever
  // observe was ENOENT, and the child's own diagnosis was not available to
  // put in the finding. Capture it instead, echo it, and quote the tail in
  // the thrown error so the verification row names the REAL reason (missing
  // compose file, quarantined agent, preflight error, docker error) rather
  // than degrading into a 45s "did not come up" timeout.
  let out = "";
  try {
    out = execFileSync("switchroom", ["agent", "start", name], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (out.trim()) process.stdout.write(out);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const combined = [e.stdout?.toString() ?? "", e.stderr?.toString() ?? ""]
      .join("\n")
      .trim();
    if (combined) process.stderr.write(`${combined}\n`);
    const tail = combined
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-START_OUTPUT_TAIL_LINES)
      .join(" / ");
    const base = e.message ?? String(err);
    throw new Error(tail ? `${base}: ${tail}` : base);
  }
}

/**
 * Final step: prove something, or fail loudly.
 *
 * Pre-H7 this printed four manual instructions and an unconditional green
 * `OK Verification steps ready`, and swallowed an `agent start` failure in a
 * bare `catch {}` — so the wizard reported success on a host where nothing
 * was running. Now:
 *
 *   - a start we attempted must produce a container that comes up AND stays
 *     up (`waitForAgentContainerUp`), otherwise the step fails;
 *   - the fleet's container runtime is checked with doctor's own
 *     `checkContainerRuntimeHealth` (crash-loop / stuck-Created signature),
 *     confirmed across samples so a `restart: always` bounce is not a FAIL;
 *   - docker being unreachable is a failure — unless this run took the
 *     documented `SWITCHROOM_MEMORY_BACKEND=none` opt-out and therefore
 *     never needed docker, in which case it is honest PENDING (review H1);
 *   - "not up yet" (the normal state on a first install, where `setup` runs
 *     before `apply`) is reported as PENDING in yellow — never as a green OK.
 *
 * Ordering constraint (review H3c): `setup` runs BEFORE `apply`, so on a
 * first install there is no compose file and NOTHING can be started. We
 * detect that up front and skip the "start it now?" offer entirely rather
 * than starting, timing out, and turning a first install into exit 1.
 *
 * Throws `SetupVerificationError` on any fatal finding; the wizard's action
 * handler turns that into a non-zero exit so scripted installs stop here.
 */
export async function stepVerification(
  config: SwitchroomConfig,
  nonInteractive: boolean,
  deps: VerificationDeps = {},
  expect: VerificationExpectations = {},
): Promise<"verified" | "pending"> {
  const log = deps.log ?? ((line: string) => console.log(line));
  stepHeaderTo(log, 13, "Verification", STEP_ACTIVE);

  const agentNames = Object.keys(config.agents);
  const firstName = agentNames[0];
  const firstAgent = firstName ? config.agents[firstName] : undefined;

  const findings: VerifyFinding[] = [];
  let applyPending = false;

  // ── Optionally start the agents, and hold that start to account ────────
  if (!nonInteractive && agentNames.length > 0) {
    const composeExists =
      (deps.composeFileExists ?? (() => existsSync(composeFilePath())))();

    if (!composeExists) {
      // H3c — FRESH-INSTALL PATH. No compose file means `switchroom apply`
      // has not run, so `agent start` cannot possibly work. Offering to
      // start here (and then failing) turned a normal first install into a
      // 45s wait and a false FAIL. Say what is missing and move on; the
      // fleet check below reports PENDING and the checklist tells them to
      // run `apply`.
      applyPending = true;
      log(
        chalk.gray(
          "  Not started: `switchroom apply` has not generated the compose file yet.",
        ),
      );
    } else {
      // L11: verification requires ALL configured agents to be up before it
      // says "verified", so offer to start all of them — starting only the
      // first guaranteed a pending verdict (and a false `verified: false`
      // telemetry row) on any 2+ agent config.
      const confirm =
        deps.confirmStart ??
        ((names: string[]) =>
          askYesNo(
            names.length === 1
              ? `\n  Start ${chalk.cyan(names[0])} now?`
              : `\n  Start ${chalk.cyan(names.join(", "))} now?`,
            false,
          ));
      const startNow = await confirm(agentNames);
      if (startNow) {
        const start = deps.startAgent ?? defaultStartAgent;
        const awaiting: string[] = [];
        for (const name of agentNames) {
          try {
            log(chalk.gray(`  Starting ${name}...`));
            start(name);
            awaiting.push(name);
          } catch (err) {
            findings.push({
              name: `${name}: agent start`,
              status: "fail",
              detail: `\`switchroom agent start ${name}\` failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              fix: `Fix the cause above, then \`switchroom agent start ${name}\`.`,
            });
          }
        }
        if (awaiting.length > 0) {
          log(chalk.gray(`  Waiting for ${awaiting.join(", ")} to come up...`));
          // Concurrently: the stability window is wall-clock, so waiting on
          // N agents in series would multiply the wizard's wait by N. They
          // all read the same `docker ps`.
          findings.push(
            ...(await Promise.all(
              awaiting.map((name) =>
                waitForAgentContainerUp(name, deps, {
                  timeoutMs: deps.timeoutMs,
                  intervalMs: deps.intervalMs,
                  stableSamples: deps.stableSamples,
                }),
              ),
            )),
          );
        }
      }
    }
  }

  // ── Fleet runtime health (doctor's own check) ──────────────────────────
  findings.push(
    ...(await verifyFleetContainers(config, deps, {
      // H1: honour the documented Docker-less escape hatch end to end. Step
      // 6 short-circuits on it; step 13 used to call this unconditionally
      // and exit 1 on the very path the docs call the way through.
      dockerRequired: !expect.memoryOptedOut,
      hindsightExpected: expect.hindsightExpected ?? false,
      confirmSamples: deps.confirmSamples,
      confirmIntervalMs: deps.confirmIntervalMs,
    })),
  );

  // L9: one row per underlying fact — the agent poller and the fleet check
  // both report a docker-less host.
  const shown = dedupeFindings(findings);

  for (const f of shown) {
    if (f.status === "ok") {
      log(chalk.green(`  ${STEP_DONE} ${f.name}: ${f.detail}`));
    } else if (f.status === "pending") {
      log(chalk.yellow(`  .. ${f.name}: ${f.detail}`));
    } else {
      log(chalk.red(`  x  ${f.name}: ${f.detail}`));
    }
    if (f.fix && f.status !== "ok") log(chalk.gray(`     ${f.fix}`));
  }

  if (hasFatal(shown)) {
    log(chalk.red("\n  Verification FAILED — your fleet is not healthy."));
    throw new SetupVerificationError(shown);
  }

  // Only reached when nothing is broken. Still honest about what was NOT
  // proven: a pending fleet gets the checklist, not a success claim.
  if (shown.some((f) => f.status === "pending")) {
    log(chalk.yellow("\n  Setup wrote your config, but the fleet is not verified yet."));
    log(chalk.gray("  Finish with:"));
    // L10: build the list, then number it — the old hard-coded "1. 2. 5."
    // printed a gap on a zero-agent config.
    const steps = [
      "switchroom apply",
      "docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d",
    ];
    if (firstName) {
      steps.push(`switchroom agent list   # ${firstName} should be running`);
      if (firstAgent) {
        steps.push(`Send a message in the "${firstAgent.topic_name}" topic`);
      }
    }
    steps.push("switchroom doctor");
    steps.forEach((s, i) => log(chalk.gray(`    ${i + 1}. ${s}`)));
    if (applyPending) {
      log(
        chalk.gray(
          "  (Nothing was started: setup runs before `apply` by design.)",
        ),
      );
    }
    return "pending";
  }

  log(chalk.green(`  ${STEP_DONE} Verified: the fleet is running`));
  if (firstAgent) {
    log(
      chalk.gray(
        `  Try it: send a message in the "${firstAgent.topic_name}" topic ` +
          "(auth: `switchroom auth list`, health: `switchroom doctor`).",
      ),
    );
  }
  return "verified";
}
