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
   * Cross-scenario isolation: BEFORE this scenario sends its first inbound,
   * wait until the SHARED bot DM chat has gone quiet — no new bot message or
   * edit for {@link QUIESCE_QUIET_WINDOW_MS} — so a prior scenario's still-
   * running background worker (Agent tool `run_in_background` / async bash)
   * has finished editing the chat and released the single shared agent's
   * turn budget. Without this, a leftover worker keeps live-editing the
   * shared chat into the next scenario's observation window, latches a
   * foreign anchor and starves the agent so the next scenario's own
   * turn/pending-progress edit never fires. The UAT runner has NO sudo /
   * docker / CLI, so an agent restart cannot be issued from here — this
   * driver-only quiesce is the runner-feasible isolation mechanism. Bounded
   * by {@link QUIESCE_MAX_MS}: if the chat never settles it proceeds anyway
   * (degrading to the pre-existing shared-chat behaviour, never hanging the
   * suite). Default false — only worker-spawning scenarios opt in.
   */
  quiesceBeforeStart?: boolean;
}

export const DEFAULT_SETTLE_MS = 8_000;

/** A quiet window with no bot message/edit that declares the shared chat idle. */
const QUIESCE_QUIET_WINDOW_MS = 15_000;
/** Hard cap on the quiesce wait — a slow prior worker can run ~5min; then proceed anyway. */
const QUIESCE_MAX_MS = 360_000;

/**
 * Block until the shared bot DM chat has produced no bot message or edit for
 * {@link QUIESCE_QUIET_WINDOW_MS}, or {@link QUIESCE_MAX_MS} elapses. Reuses
 * `expectMessage` (which observes fresh sends AND edits): each iteration
 * waits one quiet-window for ANY bot activity — a returned message means the
 * chat is still active (a prior worker editing), a timeout means the window
 * passed silently → the chat is idle and the next scenario can start clean.
 * Driver-only, so it works on the privilege-less UAT runner.
 */
async function quiesceChat(
  driver: Driver,
  botUserId: number,
  driverUserId: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < QUIESCE_MAX_MS) {
    try {
      await expectMessage(driver, botUserId, () => true, {
        timeout: QUIESCE_QUIET_WINDOW_MS,
        senderFilter: { notUserId: driverUserId },
      });
      // Bot activity within the window → prior worker still editing; keep waiting.
    } catch {
      // No activity for a full quiet window → the shared chat is idle.
      return;
    }
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

  // Cross-scenario isolation: for worker-spawning scenarios, wait until the
  // shared bot DM chat is idle (a prior scenario's background worker has
  // finished editing) before returning, so this scenario sends into an
  // unsaturated agent. Driver-only — the UAT runner has no sudo/docker/CLI to
  // restart the agent, so this is the runner-feasible reap.
  if (opts.quiesceBeforeStart) {
    await quiesceChat(driver, botUserId, driverUserId);
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
    },
  };

  return scenario;
}

function fail(msg: string): never {
  throw new Error(`[uat/harness] ${msg}`);
}
