/**
 * Phase 2 — Creation orchestrator.
 *
 * Sequences scaffold → systemd install → auth-session start in one call.
 * Does NOT block waiting for the OAuth browser dance; the caller relays
 * the loginUrl to the user (via Telegram or terminal stub) and then
 * calls completeCreation() with the code the user pastes back.
 *
 * Public surface:
 *   createAgent(opts)          → Promise<CreationResult>
 *   completeCreation(name, code) → Promise<CompletionResult>
 */

import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { resolveAgentsDir, loadConfig } from "../config/loader.js";
import { scaffoldAgent } from "./scaffold.js";
import { listAvailableProfiles } from "./profiles.js";
import { startAgent } from "./lifecycle.js";
import { startAuthSession, submitAuthCode } from "../auth/manager.js";
import type { AuthCodeOutcome } from "../auth/manager.js";
import {
  generateUnit,
  generateGatewayUnit,
  installUnit,
  uninstallUnit,
  installScheduleTimers,
  enableScheduleTimers,
  daemonReload,
  resolveGatewayUnitName,
} from "./systemd.js";
import {
  writeAgentEntryToConfig,
  updateAgentExtendsInConfig,
  removeAgentFromConfig,
  synthesizeTopicName,
} from "../cli/agent.js";
import { validateBotToken } from "../setup/telegram-api.js";
import { writeAgentEnv } from "../setup/onboarding.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateAgentOpts {
  /** Agent name (slug, e.g. "gymbro"). */
  name: string;
  /** Profile to extend (e.g. "health-coach"). Must exist in profiles/ dir. */
  profile: string;
  /** BotFather token for the new agent's Telegram bot. */
  telegramBotToken: string;
  /**
   * Admin chat ID to relay OAuth URL to (reserved for Phase 3 foreman bot).
   * Not used in Phase 2 — included for forward-compatibility.
   */
  adminChatId?: string;
  /** Handle of the admin bot (reserved for Phase 3). */
  adminBotHandle?: string;
  /**
   * Path to switchroom.yaml. Defaults to cwd/switchroom.yaml.
   * Override in tests.
   */
  configPath?: string;
  /**
   * If true and any step after disk writes fails, remove the scaffold dir.
   * Default: false (leave artefacts for retry).
   */
  rollbackOnFail?: boolean;
}

export interface CreationResult {
  /** OAuth URL to open in a browser. */
  loginUrl?: string;
  /** tmux session name — pass to completeCreation for retry/cancel. */
  sessionName: string;
  /** Absolute path to the scaffolded agent directory. */
  agentDir: string;
}

export interface CompletionResult {
  /** Structured outcome from submitAuthCode. */
  outcome: AuthCodeOutcome;
  /** True if the agent was successfully started after auth. */
  started: boolean;
  /** Instructions for the caller to display. */
  instructions: string[];
}

// ─── createAgent ─────────────────────────────────────────────────────────────

/**
 * Scaffold, systemd-install, and start an OAuth session for a new agent.
 *
 * Steps (in order):
 *   1. Validate profile against filesystem.
 *   2. Validate bot token via Telegram getMe — FAIL FAST before any disk writes.
 *   3. Write agent entry to switchroom.yaml if missing.
 *   4. scaffoldAgent().
 *   5. Install systemd units.
 *   6. Write telegram/.env with the bot token.
 *   7. startAuthSession() — returns loginUrl + sessionName.
 *
 * Side-effects are tracked in a rollback stack. When rollbackOnFail=true and
 * any step throws, all previously-applied side-effects are unwound in reverse
 * order:
 *   - agentDir removed (rmSync)
 *   - systemd units uninstalled (uninstallUnit)
 *   - switchroom.yaml entry removed (removeAgentFromConfig)
 * This prevents a failed bootstrap from leaving the user in a "stuck" state
 * where a second run hits the "already configured" guard.
 */
/** Regex that agent names must match — mirrors the yaml schema constraint. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export async function createAgent(
  opts: CreateAgentOpts,
): Promise<CreationResult> {
  const {
    name,
    profile,
    telegramBotToken,
    configPath: configPathOpt,
    rollbackOnFail = false,
  } = opts;

  // ── Step 0: Validate name slug (before any disk writes) ───────────────────
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid agent name: "${name}". ` +
        `Names must match ^[a-z0-9][a-z0-9_-]{0,62}$ (lowercase alphanumeric, hyphens, underscores; max 63 chars).`,
    );
  }

  // ── Step 1: Validate profile ──────────────────────────────────────────────
  const available = listAvailableProfiles();
  if (!available.includes(profile)) {
    throw new Error(
      `Unknown profile: "${profile}". Valid profiles: ${available.join(", ")}`,
    );
  }

  // ── Step 2: Validate bot token (BEFORE any disk writes) ──────────────────
  await validateBotToken(telegramBotToken).catch((err: Error) => {
    throw new Error(
      `Bot token rejected by Telegram — check the token and try again. ` +
        `(${err.message})`,
    );
  });

  // ── Step 3: Determine configPath and ensure agent in yaml ─────────────────
  const configPath =
    configPathOpt ??
    (() => {
      // Fallback: try cwd/switchroom.yaml
      const cwd = process.cwd();
      const candidates = [
        resolve(cwd, "switchroom.yaml"),
        resolve(cwd, "switchroom.yml"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      throw new Error(
        "switchroom.yaml not found. Pass configPath or run from the project root.",
      );
    })();

  // Rollback stack — each entry is a best-effort undo for one side-effect.
  // Unwound in reverse order on failure when rollbackOnFail=true.
  const rollbackStack: Array<() => void> = [];

  /**
   * Run `fn`. If it throws and rollbackOnFail=true, unwind the rollback stack
   * in reverse order, then re-throw the original error.
   */
  async function withRollback<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (rollbackOnFail) {
        for (let i = rollbackStack.length - 1; i >= 0; i--) {
          try { rollbackStack[i](); } catch { /* best effort */ }
        }
      }
      throw err;
    }
  }

  let config = loadConfig(configPath);
  const existingEntry = config.agents[name];

  if (!existingEntry) {
    // Fresh agent: write entry to yaml.
    writeAgentEntryToConfig(configPath, name, profile);
    rollbackStack.push(() => removeAgentFromConfig(configPath, name));
    config = loadConfig(configPath);
  } else {
    // Agent already in yaml — reconcile extends.
    const existingExtends = existingEntry.extends;
    if (!existingExtends) {
      updateAgentExtendsInConfig(configPath, name, profile);
      config = loadConfig(configPath);
    } else if (existingExtends !== profile) {
      throw new Error(
        `Agent "${name}" is already configured with profile "${existingExtends}". ` +
          `Remove the existing entry from switchroom.yaml or drop --profile.`,
      );
    }
  }

  const agentConfig = config.agents[name];
  if (!agentConfig) {
    throw new Error(
      `Internal: wrote agent "${name}" to yaml but reload didn't pick it up.`,
    );
  }

  const agentsDir = resolveAgentsDir(config);
  const agentDir = resolve(agentsDir, name);

  // ── Step 4: Scaffold ──────────────────────────────────────────────────────
  await withRollback(() => {
    scaffoldAgent(name, agentConfig, agentsDir, config.telegram, config, undefined, configPath);
    // Push agentDir removal onto stack after scaffold succeeds.
    rollbackStack.push(() => rmSync(agentDir, { recursive: true, force: true }));
  });

  // ── Step 5: Install systemd units ─────────────────────────────────────────
  const useAutoaccept = agentConfig.channels?.telegram?.plugin === "switchroom";
  const gwName = resolveGatewayUnitName(config, name);

  await withRollback(() => {
    const unitContent = generateUnit(name, agentDir, useAutoaccept, gwName);
    installUnit(name, unitContent);
    rollbackStack.push(() => uninstallUnit(name));

    if (useAutoaccept && gwName) {
      const stateDir = resolve(agentDir, "telegram");
      const gatewayContent = generateGatewayUnit(stateDir, name);
      installUnit(gwName, gatewayContent);
      rollbackStack.push(() => uninstallUnit(gwName));
    }
  });

  // Install schedule timers if any.
  const schedule = agentConfig.schedule ?? [];
  if (schedule.length > 0) {
    await withRollback(() => {
      installScheduleTimers(name, agentDir, schedule);
      // Push timer rollback BEFORE enabling so partial installs are also cleaned up.
      rollbackStack.push(() => {
        // Uninstall timers by passing an empty schedule (removes all timer units).
        try { installScheduleTimers(name, agentDir, []); } catch { /* best effort */ }
      });
      daemonReload();
      enableScheduleTimers(name, schedule.length);
    });
  }

  // ── Step 6: Write bot token to telegram/.env ──────────────────────────────
  await withRollback(() => {
    writeAgentEnv(agentDir, telegramBotToken);
  });

  // ── Step 7: Start OAuth session ───────────────────────────────────────────
  const authResult = await withRollback(() =>
    startAuthSession(name, agentDir, { force: false }),
  );

  return {
    loginUrl: authResult.loginUrl,
    sessionName: authResult.sessionName,
    agentDir,
  };
}

// ─── completeCreation ─────────────────────────────────────────────────────────

/**
 * Complete agent creation after the user has obtained the OAuth code from their
 * browser. Wraps Phase 1's submitAuthCode + agent start.
 *
 * Returns a CompletionResult with the structured outcome. If outcome.kind ===
 * 'success', the agent is started and `started` will be true. For any other
 * outcome, started is false and the caller should surface the error and offer
 * a retry (call createAgent again to restart the auth session).
 */
export async function completeCreation(
  name: string,
  code: string,
  opts: {
    configPath?: string;
    /** Poll timeout override (ms). Defaults to submitAuthCode's own default. */
    pollTimeoutMs?: number;
  } = {},
): Promise<CompletionResult> {
  // Validate name slug before any work.
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid agent name: "${name}". ` +
        `Names must match ^[a-z0-9][a-z0-9_-]{0,62}$ (lowercase alphanumeric, hyphens, underscores; max 63 chars).`,
    );
  }

  const configPath =
    opts.configPath ??
    (() => {
      const cwd = process.cwd();
      const candidates = [resolve(cwd, "switchroom.yaml"), resolve(cwd, "switchroom.yml")];
      for (const c of candidates) if (existsSync(c)) return c;
      throw new Error("switchroom.yaml not found. Pass configPath option.");
    })();

  const config = loadConfig(configPath);
  const agentsDir = resolveAgentsDir(config);
  const agentDir = resolve(agentsDir, name);

  if (!existsSync(agentDir)) {
    throw new Error(
      `Agent dir not found: ${agentDir}. Run createAgent first.`,
    );
  }

  // Submit the OAuth code using Phase 1's submitAuthCode.
  const authCodeResult = submitAuthCode(
    name,
    agentDir,
    code,
    undefined, // slot
    opts.pollTimeoutMs ? { pollTimeoutMs: opts.pollTimeoutMs } : {},
  );

  const outcome = authCodeResult.outcome ?? { kind: "timeout" as const };

  if (outcome.kind !== "success") {
    return {
      outcome,
      started: false,
      instructions: authCodeResult.instructions,
    };
  }

  // Auth succeeded — start the agent.
  let started = false;
  try {
    startAgent(name);
    started = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome,
      started: false,
      instructions: [
        ...authCodeResult.instructions,
        `Warning: Could not start agent "${name}" automatically: ${message}`,
        `Start manually with: switchroom agent start ${name}`,
      ],
    };
  }

  return {
    outcome,
    started,
    instructions: [
      ...authCodeResult.instructions,
      `Agent "${name}" started successfully.`,
    ],
  };
}
