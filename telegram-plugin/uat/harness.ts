/**
 * Scenario harness for UAT runs.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 *
 * `spinUp({ agent })` connects the mtcute driver and resolves the test
 * bot's user_id, returning a Scenario the test can interact with.
 *
 * **Runtime model — Phase 2a (DM focus):** the test-harness agent is
 * a standard switchroom agent the operator created once via
 * `switchroom agent add test-harness ...` (see uat/SETUP.md). The
 * harness does NOT spin the agent up per-scenario — it relies on the
 * agent being already running. Per-scenario state isolation rolls in
 * with Phase 2b once we move beyond DM smoke tests.
 *
 * Forum-topic routing, ephemeral STATE_DIR, child-process agents, and
 * the progress-card observers are deferred to Phase 2b (#866 v2) — the
 * epic's original plan was written before the Docker runtime landed
 * and would substantially re-invent the agent lifecycle.
 */

import { execSync } from "node:child_process";
import { Driver } from "./driver.js";
import {
  expectMessage,
  expectPinnedCard,
  expectReaction,
  waitForCardPhase,
  type PollOptions,
  type PinnedCardSnapshot,
} from "./assertions.js";
import type { ObservedMessage } from "./driver.js";
import { loadUatEnv } from "./load-env.js";

loadUatEnv();

export interface SpinUpOptions {
  /**
   * Agent name to run scenarios against, e.g. `"test-harness"`. The
   * agent must already be configured + running (Phase 2a: standard
   * runtime + persistent agent).
   */
  agent: string;
  /**
   * Bot username (with or without `@`) the harness should resolve to
   * a user_id. Defaults to `process.env.TELEGRAM_TEST_BOT_USERNAME`.
   */
  botUsername?: string;
  /**
   * Settle delay (ms) after the driver connects, before the scenario's
   * first send. Gives the previous scenario's turn time to finish its
   * outbound stream on the agent side. Without this the next inbound
   * lands while the gateway is still pinning/editing the prior turn's
   * card, the gateway reuses the existing pin via edit (instead of
   * pinning a new message), and observePins-based assertions miss the
   * event entirely. Default {@link DEFAULT_SETTLE_MS}; set to 0 for
   * single-scenario runs where the cooldown is dead time. Scenarios
   * that account for this in their outer `it()` budget should add the
   * settle on top of inner poll deadlines.
   */
  settleMs?: number;
  /**
   * Reap the agent's in-flight background workers in `tearDown` (durable
   * cross-scenario isolation). Set by scenarios that dispatch long-lived
   * background sub-agents (Agent tool `run_in_background`) or async
   * background bash: those workers keep editing the SHARED bot DM chat
   * long after the scenario's `it()` returns, bleeding into the next
   * scenario's observation window on the sequential (`maxForks:1`) UAT
   * run and starving the shared agent's turn budget. A marker-safe agent
   * restart in `tearDown` kills every leftover worker so the next
   * scenario starts from a clean agent. Best-effort: if NOPASSWD sudo /
   * the CLI isn't on the runner it no-ops (the pre-existing shared-agent
   * behaviour) rather than failing the scenario. Default false — only the
   * worker-spawning scenarios opt in, so the blast radius stays scoped and
   * non-worker scenarios keep the light disconnect-only tearDown.
   */
  reapOnTearDown?: boolean;
}

export const DEFAULT_SETTLE_MS = 8_000;

/** True iff NOPASSWD sudo is usable on this runner (uat-host has it; CI doesn't). */
function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Marker-safe restart of the test-harness agent to reap every leftover
 * background worker before the next scenario runs. Mirrors the proven
 * restart in `jtbd-always-on-after-restart-dm.test.ts` (restart blocks
 * ~30s as the gateway bridge reattaches, so execSync returning implies the
 * agent is back up). Best-effort — swallows all errors so a reap failure
 * never turns into a scenario failure.
 */
function reapAgentWorkers(name: string): void {
  if (!canShellSudo()) return;
  try {
    execSync(
      `sudo -n env PATH=$PATH HOME=$HOME switchroom agent restart ${name} --force`,
      { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 },
    );
  } catch {
    /* best-effort — degrade to the shared-agent behaviour, never fail here */
  }
}

export interface Scenario {
  /** mtcute driver, already connected. */
  driver: Driver;
  /** Test bot's Telegram user_id; doubles as the chat_id for DMs. */
  botUserId: number;
  /** Driver user account's Telegram user_id. */
  driverUserId: number;

  /** Sugar for `driver.sendText(botUserId, text)`. */
  sendDM: (text: string) => Promise<{ messageId: number }>;

  /**
   * Wait for the next message in the bot DM chat matching `match`.
   * `opts.from` filters by sender side: `"bot"` for replies from the
   * test bot, `"driver"` for the driver's own echoes (rare in
   * scenarios but useful for assertions on the outbound side).
   */
  expectMessage: (
    match: string | RegExp | ((m: ObservedMessage) => boolean),
    opts: PollOptions & { from?: "bot" | "driver" },
  ) => Promise<ObservedMessage>;

  // Phase 2b stubs — type-only so existing scenarios that reference
  // these helpers still typecheck after this PR. Implementations land
  // alongside `observeReactions` / `observePins` in #866 v2.
  expectReaction: (
    messageId: number,
    sequence: string[],
    opts: PollOptions,
  ) => ReturnType<typeof expectReaction>;
  expectPinnedCard: (opts: PollOptions) => ReturnType<typeof expectPinnedCard>;
  waitForCardPhase: (
    card: PinnedCardSnapshot,
    phase: "boot" | "working" | "done" | "error",
    opts: PollOptions,
  ) => ReturnType<typeof waitForCardPhase>;

  /** Disconnect the driver. The persistent test-harness agent keeps running. */
  tearDown: () => Promise<void>;
}

interface ResolvedConfig {
  apiId: number;
  apiHash: string;
  session: string;
  botUsername: string;
}

function resolveConfig(opts: SpinUpOptions): ResolvedConfig {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  if (!Number.isFinite(apiId)) {
    fail("TELEGRAM_API_ID is missing or not an integer — see uat/SETUP.md §3");
  }
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (apiHash.length === 0) {
    fail("TELEGRAM_API_HASH is empty — see uat/SETUP.md §3");
  }
  const session = process.env.TELEGRAM_UAT_DRIVER_SESSION ?? "";
  if (session.length === 0) {
    fail(
      "TELEGRAM_UAT_DRIVER_SESSION is empty — run `bun run uat:login` first " +
        "(see uat/SETUP.md §4)",
    );
  }
  const botUsername =
    opts.botUsername ?? process.env.TELEGRAM_TEST_BOT_USERNAME ?? "";
  if (botUsername.length === 0) {
    fail(
      "Bot username not provided — pass `botUsername` to spinUp() or set " +
        "TELEGRAM_TEST_BOT_USERNAME",
    );
  }
  return { apiId, apiHash, session, botUsername };
}

export async function spinUp(opts: SpinUpOptions): Promise<Scenario> {
  const cfg = resolveConfig(opts);

  const driver = new Driver({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    session: cfg.session,
  });

  await driver.connect();

  // Resolve both IDs eagerly so scenarios can rely on them being
  // populated by the time `spinUp` returns. Run in parallel — the
  // two calls don't interact.
  const [botUserId, driverUserId] = await Promise.all([
    driver.resolveBotUserId(cfg.botUsername),
    driver.getMyUserId(),
  ]);

  // Unpin FIRST, then settle. Order matters: the gateway is a logical
  // singleton for the chat's pinned card — on every turn it tries to
  // edit the existing pin rather than pin a fresh one, so observePins
  // (a transition listener) sees nothing on the next turn. Unpinning
  // forces the agent to issue a fresh `pin` event we can observe.
  // The settle delay then absorbs (a) the unpin's own propagation
  // round-trip and (b) any tail-end edits from the prior scenario's
  // turn still in flight. Doing unpin before settle keeps the gap a
  // single window of dead time rather than two stacked waits.
  await driver.unpinAllMessages(botUserId);
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const scenario: Scenario = {
    driver,
    botUserId,
    driverUserId,
    sendDM: (text) => driver.sendText(botUserId, text),
    expectMessage: (match, pollOpts) =>
      expectMessage(driver, botUserId, match, {
        ...pollOpts,
        senderFilter:
          pollOpts.from === "bot"
            ? { notUserId: driverUserId }
            : pollOpts.from === "driver"
              ? { userId: driverUserId }
              : undefined,
      }),
    expectReaction: (messageId, sequence, pollOpts) =>
      expectReaction(driver, botUserId, messageId, sequence, pollOpts),
    expectPinnedCard: (pollOpts) => expectPinnedCard(driver, botUserId, pollOpts),
    waitForCardPhase: (card, phase, pollOpts) =>
      waitForCardPhase(driver, card, phase, pollOpts),
    tearDown: async () => {
      await driver.disconnect().catch(() => {
        /* idempotent — log-and-move-on; the persistent agent is unaffected */
      });
      // Durable cross-scenario isolation: reap this scenario's leftover
      // background workers so they cannot bleed into the next scenario's
      // observation window on the shared bot DM chat. Opt-in — only
      // worker-spawning scenarios set `reapOnTearDown`. Best-effort.
      if (opts.reapOnTearDown) {
        reapAgentWorkers(opts.agent);
      }
    },
  };

  return scenario;
}

function fail(msg: string): never {
  throw new Error(`[uat/harness] ${msg}`);
}
