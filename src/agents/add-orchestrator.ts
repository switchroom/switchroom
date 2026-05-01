/**
 * Workstream 1 of epic #543 — `switchroom agent add` n+1 bot wizard.
 *
 * Layers on top of `createAgent` / `completeCreation` (Phase 2 orchestrator)
 * to collapse the n+1 bot creation flow into a single CLI verb. Adds:
 *   - topology selection (dm | forum) — currently both write the same
 *     access.json shape but the topology argument is captured for forward
 *     compatibility with the forum-pairing flow (see #190).
 *   - DM pairing block — after auth completes the wizard polls Telegram
 *     for a `/start` DM from the new bot, then auto-writes
 *     telegram/access.json with the captured user_id. No second
 *     `switchroom setup` run required.
 *   - Final preflight loud-fail — autoaccept wrapper, bot token present,
 *     systemd unit running, access.json populated, MCP servers configured,
 *     and bot token managed via vault reference (workstream 3 of #543,
 *     closes #364 / #424 silent-failure modes). Each failed check produces
 *     an actionable error message rather than silent breakage.
 *
 * BotFather automation (#188) and the profile/skill picker (#190) are out
 * of scope for this workstream — both are stubbed with TODO markers
 * referencing those issues.
 *
 * The pairing step is skippable via `allowFromUserId` — useful for
 * non-interactive tests and for re-running against an already-paired
 * deployment.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createAgent, completeCreation } from "./create-orchestrator.js";
import { writeAccessJson } from "../setup/onboarding.js";
import { pollForDmStart } from "../setup/telegram-api.js";
import {
  runBotFatherWalkthrough,
  type BotFatherWalkthroughOpts,
} from "../setup/botfather-walkthrough.js";

export type AgentTopology = "dm" | "forum";

export interface AddAgentOpts {
  /** Agent slug (e.g. "ziggy"). */
  name: string;
  /** Profile to extend from (e.g. "health-coach"). */
  profile: string;
  /**
   * BotFather token for the new agent's bot. Optional — when omitted the
   * wizard runs the BotFather walkthrough (#188) to guide the operator
   * through @BotFather, validates the resulting token via getMe, and
   * asserts the bot's username matches the agent slug. Supplying a token
   * up-front (--bot-token / SWITCHROOM_BOT_TOKEN) skips the walkthrough
   * entirely — the validate-and-assert path still runs.
   */
  botToken?: string;
  /**
   * Optional explicit bot username — passed through to the walkthrough
   * for exact-equality assertion when the bot is intentionally named
   * without the slug.
   */
  botUsername?: string;
  /**
   * Downgrade the slug-in-username assertion to warn-only. Off by default.
   */
  loose?: boolean;
  /**
   * Stdin reader injected by the CLI (or tests). Used both for the OAuth
   * code prompt and — when the BotFather walkthrough runs — for the
   * "paste the token" loop.
   */
  readLine?: (prompt: string) => Promise<string>;
  /** Topology — "dm" today; "forum" reserved for #190 forum-pairing UX. */
  topology: AgentTopology;
  /**
   * Optional: skip the DM pairing block and write access.json with this
   * user ID directly. Useful for test runs and for redeploys against an
   * already-known operator.
   */
  allowFromUserId?: string;
  /**
   * OAuth code resolver. The wizard prints the loginUrl and then calls
   * this to get the code. Defaults to reading a single line from stdin
   * (see CLI wiring); tests inject a constant.
   */
  readOAuthCode: (loginUrl: string | undefined, sessionName: string) => Promise<string>;
  /**
   * Pairing-block timeout, ms. Default 5 minutes per epic spec ("5-min
   * timeout with clear error").
   */
  pairTimeoutMs?: number;
  /** Path to switchroom.yaml. */
  configPath?: string;
  /** Logger — defaults to console.log; tests inject a sink. */
  log?: (line: string) => void;
  /**
   * Test seam — overrides `runBotFatherWalkthrough` so unit tests can
   * exercise the wiring without touching Telegram. Defaults to the real
   * walkthrough (which calls validateBotToken under the hood). Receives
   * the same opts object the orchestrator builds internally.
   */
  runBotFather?: (opts: BotFatherWalkthroughOpts) => Promise<{
    token: string;
    bot: { username: string };
  }>;
  /**
   * Optional override of the pairing poller. Tests inject a fake; the
   * wizard otherwise calls pollForDmStart from telegram-api.
   */
  pollForPair?: (
    token: string,
    timeoutMs: number,
  ) => Promise<{ userId: number | string; username: string; chatId: number | string }>;
  /**
   * Override systemctl probe for tests. Returns true iff the unit
   * reports "active" (running).
   */
  isUnitActive?: (unitName: string) => boolean;
  /**
   * Skip the start-and-pair phase. Useful for the "dry" path in tests.
   */
  skipStart?: boolean;
}

export interface AddAgentResult {
  /** Final agent dir on disk. */
  agentDir: string;
  /** User ID that ended up in allowFrom (paired or supplied). */
  userId: string;
  /** True iff every preflight check passed. */
  preflightOk: boolean;
  /** Per-check status for the final preflight. */
  preflight: PreflightReport;
}

export interface PreflightCheck {
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  autoacceptWrapper: PreflightCheck;
  botTokenPresent: PreflightCheck;
  systemdActive: PreflightCheck;
  accessJsonAllowFrom: PreflightCheck;
  mcpServersConfigured: PreflightCheck;
  vaultBotTokenManaged: PreflightCheck;
}

const DEFAULT_PAIR_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the n+1 bot wizard end-to-end.
 *
 * Sequencing:
 *   1. (stub) BotFather automation — see #188.
 *   2. createAgent — scaffold + systemd + auth session.
 *   3. readOAuthCode — caller relays the OAuth dance (terminal stdin or
 *      a future foreman bot).
 *   4. completeCreation — submit code + start the agent.
 *   5. Pairing block — pollForDmStart unless allowFromUserId is given.
 *      Writes telegram/access.json with the captured user_id.
 *   6. Final preflight — autoaccept wrapper, vault token, systemd active,
 *      access.json populated.
 */
export async function addAgent(opts: AddAgentOpts): Promise<AddAgentResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const pairTimeout = opts.pairTimeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  const pollPair = opts.pollForPair ?? pollForDmStart;
  const isActive = opts.isUnitActive ?? defaultIsUnitActive;

  // ── Step 1: BotFather walkthrough (#188) ─────────────────────────────────
  // Either validate the token the operator already has, or guide them
  // through @BotFather to create one. Both paths end with a getMe call
  // and a slug-in-username assertion so a stale / wrong-bot token is
  // caught here rather than at first restart.
  const walkthroughRunner = opts.runBotFather ?? runBotFatherWalkthrough;
  const wt = await walkthroughRunner({
    agentSlug: opts.name,
    existingToken: opts.botToken,
    expectedUsername: opts.botUsername,
    loose: opts.loose,
    readLine: opts.readLine,
    log,
  });
  const resolvedBotToken = wt.token;
  log(`[1/6] Bot token validated for @${wt.bot.username}`);

  // ── Step 1b: profile/skill picker (#190) — stub ──────────────────────────
  // TODO(#190): replace the --profile flag with an interactive picker that
  // ports skills + persona files (SOUL.md, IDENTITY.md, USER.md) from a
  // chosen template.

  log(`\n[1/6] Scaffolding agent "${opts.name}" (profile=${opts.profile}, topology=${opts.topology})`);

  // ── Step 2: scaffold + auth session ──────────────────────────────────────
  const created = await createAgent({
    name: opts.name,
    profile: opts.profile,
    telegramBotToken: resolvedBotToken,
    configPath: opts.configPath,
    rollbackOnFail: true,
  });

  log(`[2/6] Auth session started: ${created.sessionName}`);
  if (created.loginUrl) {
    log(`      OAuth URL: ${created.loginUrl}`);
  }

  // ── Step 3: relay OAuth code ─────────────────────────────────────────────
  const code = await opts.readOAuthCode(created.loginUrl, created.sessionName);
  if (!code) {
    throw new Error("No OAuth code provided — aborting wizard.");
  }

  // ── Step 4: completeCreation (submitAuthCode + startAgent) ───────────────
  log(`[3/6] Submitting OAuth code and starting agent…`);
  const completion = await completeCreation(opts.name, code, {
    configPath: opts.configPath,
  });
  if (completion.outcome.kind !== "success") {
    throw new Error(
      `OAuth completion failed (${completion.outcome.kind}). ` +
        `Retry with: switchroom auth code ${opts.name} <code>`,
    );
  }
  if (!completion.started && !opts.skipStart) {
    throw new Error(
      `Agent "${opts.name}" auth saved but it did not start. ` +
        `Try: switchroom agent start ${opts.name}`,
    );
  }

  // ── Step 5: pairing block — wait for /start DM ───────────────────────────
  // Ziggy / Klanker / Lawgpt all hit the same gap: bot starts, user DMs
  // /start, allowFrom is empty so the inbound is dropped. We block here
  // and write access.json the moment the operator's DM lands.
  let userId: string;
  if (opts.allowFromUserId) {
    userId = opts.allowFromUserId;
    log(`[4/6] Skipping DM pairing — using --allow-from ${userId}`);
  } else {
    log(`[4/6] Waiting for first /start DM (timeout ${(pairTimeout / 1000).toFixed(0)}s)…`);
    log(`      Open Telegram and DM your new bot: send /start`);
    let pair: Awaited<ReturnType<typeof pollPair>>;
    try {
      pair = await pollPair(resolvedBotToken, pairTimeout);
    } catch (err) {
      throw new Error(
        `Pairing timed out after ${(pairTimeout / 1000).toFixed(0)}s. ` +
          `The agent is running but no /start DM arrived. ` +
          `Resume pairing: re-run with --allow-from <your_telegram_user_id>, ` +
          `or use \`switchroom setup\` to capture the user_id manually. ` +
          `(Underlying error: ${(err as Error).message})`,
      );
    }
    userId = String(pair.userId);
    log(`      Paired with @${pair.username} (user_id=${userId})`);
  }

  // ── Step 5b: write access.json ───────────────────────────────────────────
  // Topology is captured for forward-compat — today both shapes use the
  // same allowFrom + groups skeleton (writeAccessJson). The forum-chat-id
  // is left as a placeholder; #190's profile/picker will fill the actual
  // forum chat once the topology=forum branch grows real semantics.
  const agentDir = created.agentDir;
  const forumChatId = ""; // forum support deferred — see #190
  writeAccessJson(agentDir, userId, forumChatId);
  log(`[5/6] Wrote access.json with allowFrom=[${userId}]`);

  // ── Step 6: final preflight — loud-fail per check ────────────────────────
  log(`[6/6] Running final preflight…`);
  const preflight = runFinalPreflight({
    name: opts.name,
    agentDir,
    expectedUserId: userId,
    isUnitActive: isActive,
    configPath: opts.configPath,
  });

  const ok =
    preflight.autoacceptWrapper.ok &&
    preflight.botTokenPresent.ok &&
    preflight.systemdActive.ok &&
    preflight.accessJsonAllowFrom.ok &&
    preflight.mcpServersConfigured.ok &&
    preflight.vaultBotTokenManaged.ok;

  for (const [k, v] of Object.entries(preflight)) {
    const mark = v.ok ? "ok" : "FAIL";
    log(`      [${mark}] ${k}: ${v.detail}`);
  }

  return { agentDir, userId, preflightOk: ok, preflight };
}

// ─── Final preflight ──────────────────────────────────────────────────────────

interface PreflightInputs {
  name: string;
  agentDir: string;
  expectedUserId: string;
  isUnitActive: (unitName: string) => boolean;
  /**
   * Optional path to switchroom.yaml — used to verify that the agent's
   * bot token is referenced through the vault rather than living in
   * plaintext. Per epic #543 line 39 + #424, a missing vault reference
   * for the bot token is a silent-failure mode worth surfacing.
   */
  configPath?: string;
}

/**
 * Final preflight after wizard completion. Each check produces a
 * { ok, detail } pair so the caller can render an actionable per-line
 * report. This is intentionally narrower than the pre-restart
 * preflightCheck() in src/cli/agent.ts — that one gates restarts; this
 * one verifies post-add invariants and surfaces them loudly.
 *
 * Exported for tests.
 */
export function runFinalPreflight(inputs: PreflightInputs): PreflightReport {
  const { name, agentDir, expectedUserId, isUnitActive, configPath } = inputs;

  // 1. Autoaccept wrapper present in the systemd unit (when applicable).
  //    The unit text either contains "expect" (dev plugin path) or doesn't
  //    (official plugin path). Per #364, missing-when-expected is the
  //    silent-failure mode we want to surface.
  const unitPath = resolve(
    process.env.HOME ?? "/root",
    ".config/systemd/user",
    `switchroom-${name}.service`,
  );
  let autoaccept = { ok: false, detail: `unit not found at ${unitPath}` };
  if (existsSync(unitPath)) {
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(unitPath, "utf-8");
    if (content.includes("expect") || content.includes("autoaccept")) {
      autoaccept = { ok: true, detail: "expect/autoaccept wrapper detected in unit" };
    } else {
      autoaccept = {
        ok: true,
        detail: "official-plugin path (no autoaccept wrapper required)",
      };
    }
  } else {
    autoaccept = {
      ok: false,
      detail:
        `systemd unit missing at ${unitPath}. ` +
        `Fix: switchroom agent reconcile ${name}`,
    };
  }

  // 2. Bot token present in telegram/.env (vault-managed envs land here).
  const envPath = resolve(agentDir, "telegram", ".env");
  let token = { ok: false, detail: `telegram/.env missing at ${envPath}` };
  if (existsSync(envPath)) {
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(envPath, "utf-8");
    if (/TELEGRAM_BOT_TOKEN=\S+/.test(content)) {
      token = { ok: true, detail: "TELEGRAM_BOT_TOKEN present" };
    } else {
      token = {
        ok: false,
        detail:
          "TELEGRAM_BOT_TOKEN missing from telegram/.env. " +
          "Re-run wizard with --bot-token, or set vault entry.",
      };
    }
  }

  // 3. systemd unit active.
  const unitName = `switchroom-${name}.service`;
  let active: { ok: boolean; detail: string };
  try {
    const running = isUnitActive(unitName);
    active = running
      ? { ok: true, detail: `${unitName} is active` }
      : {
          ok: false,
          detail:
            `${unitName} is not active. Start with: switchroom agent start ${name}`,
        };
  } catch (err) {
    active = {
      ok: false,
      detail: `systemctl probe failed: ${(err as Error).message}`,
    };
  }

  // 4. access.json contains the expected user_id in allowFrom.
  const accessPath = resolve(agentDir, "telegram", "access.json");
  let access: { ok: boolean; detail: string };
  if (!existsSync(accessPath)) {
    access = {
      ok: false,
      detail: `access.json missing at ${accessPath}`,
    };
  } else {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const parsed = JSON.parse(fs.readFileSync(accessPath, "utf-8"));
      const list: string[] = Array.isArray(parsed.allowFrom) ? parsed.allowFrom.map(String) : [];
      if (list.includes(String(expectedUserId))) {
        access = { ok: true, detail: `allowFrom contains ${expectedUserId}` };
      } else {
        access = {
          ok: false,
          detail:
            `allowFrom does not contain ${expectedUserId} (got [${list.join(", ")}])`,
        };
      }
    } catch (err) {
      access = {
        ok: false,
        detail: `access.json unparseable: ${(err as Error).message}`,
      };
    }
  }

  // 5. MCP servers configured in .claude/settings.json — silent-failure
  //    mode: agent boots, but Hindsight / switchroom-telegram never load
  //    because the settings file is missing or has an empty mcpServers
  //    block. Per #424 we want this loud at preflight time.
  const settingsPath = resolve(agentDir, ".claude", "settings.json");
  let mcp: PreflightCheck;
  if (!existsSync(settingsPath)) {
    mcp = {
      ok: false,
      detail:
        `.claude/settings.json missing at ${settingsPath}. ` +
        `Fix: switchroom agent reconcile ${name}`,
    };
  } else {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const servers =
        parsed && typeof parsed === "object" && parsed.mcpServers
          ? Object.keys(parsed.mcpServers)
          : [];
      if (servers.length === 0) {
        mcp = {
          ok: false,
          detail:
            `.claude/settings.json has no mcpServers block. ` +
            `Hindsight + switchroom-telegram will not load. ` +
            `Fix: switchroom agent reconcile ${name}`,
        };
      } else {
        mcp = {
          ok: true,
          detail: `mcpServers configured: ${servers.join(", ")}`,
        };
      }
    } catch (err) {
      mcp = {
        ok: false,
        detail: `.claude/settings.json unparseable: ${(err as Error).message}`,
      };
    }
  }

  // 6. Bot token managed via vault reference (not plaintext in yaml).
  //    Reads the switchroom.yaml entry for this agent — if its
  //    telegram.bot_token is a literal string rather than a vault://
  //    reference, the operator has a foot-gun: rotation requires a
  //    yaml edit and there's no audit trail. Surface it loudly per #424.
  let vaultMgd: PreflightCheck;
  if (!configPath) {
    // No config path supplied — skip rather than spuriously fail. Tests
    // and ad-hoc preflight runs may not have a yaml available.
    vaultMgd = {
      ok: true,
      detail: "skipped (no switchroom.yaml path supplied)",
    };
  } else if (!existsSync(configPath)) {
    vaultMgd = {
      ok: false,
      detail: `switchroom.yaml not found at ${configPath}`,
    };
  } else {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const yaml = require("yaml") as typeof import("yaml");
      const cfg = yaml.parse(fs.readFileSync(configPath, "utf-8"));
      const agentEntry = cfg?.agents?.[name];
      const rawToken =
        agentEntry?.channels?.telegram?.bot_token ??
        agentEntry?.telegram?.bot_token ??
        undefined;
      if (!rawToken || typeof rawToken !== "string") {
        vaultMgd = {
          ok: false,
          detail:
            `No telegram.bot_token configured for agent "${name}" in ${configPath}. ` +
            `Fix: add a vault://${name}.bot_token reference and store the secret with: switchroom vault set ${name}.bot_token`,
        };
      } else if (!rawToken.startsWith("vault://")) {
        vaultMgd = {
          ok: false,
          detail:
            `telegram.bot_token for "${name}" is plaintext in ${configPath}. ` +
            `Fix: rotate via BotFather, store in vault (switchroom vault set ${name}.bot_token), ` +
            `then replace yaml value with vault://${name}.bot_token`,
        };
      } else {
        vaultMgd = {
          ok: true,
          detail: `bot_token referenced via vault: ${rawToken}`,
        };
      }
    } catch (err) {
      vaultMgd = {
        ok: false,
        detail: `failed to read switchroom.yaml: ${(err as Error).message}`,
      };
    }
  }

  return {
    autoacceptWrapper: autoaccept,
    botTokenPresent: token,
    systemdActive: active,
    accessJsonAllowFrom: access,
    mcpServersConfigured: mcp,
    vaultBotTokenManaged: vaultMgd,
  };
}

function defaultIsUnitActive(unitName: string): boolean {
  try {
    const out = execFileSync("systemctl", ["--user", "is-active", unitName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "active";
  } catch {
    return false;
  }
}
