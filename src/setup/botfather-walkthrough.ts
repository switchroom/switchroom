/**
 * BotFather walkthrough — workstream 2 of epic #543, closes #188.
 *
 * Replaces the bare "paste token" step in the `switchroom agent add`
 * wizard with a guided @BotFather flow:
 *
 *   1. Detect: does the operator already have a token (env var / flag)?
 *      If yes — validate via getMe, optionally assert slug match, return.
 *   2. Otherwise — print a step-by-step walkthrough (open @BotFather,
 *      /newbot, pick name + username, copy token), wait for the operator
 *      to paste the token, validate it, and assert the bot's username
 *      contains the agent slug so a copy-paste mistake (e.g. clerk's token
 *      pasted while creating finn) doesn't quietly succeed.
 *
 * Stays flag-driven: in non-interactive mode (token supplied up-front via
 * --bot-token / SWITCHROOM_BOT_TOKEN) the walkthrough is skipped entirely
 * and we run the same validate-and-assert path. The interactive path is
 * only entered when no token is supplied AND a `readLine` is available.
 *
 * All I/O is injected:
 *   - log: where the step copy goes (defaults to console.log)
 *   - readLine: how we slurp the pasted token (defaults to stdin readline)
 *   - validate: getMe call (defaults to validateBotToken)
 * Tests inject all three.
 */

import {
  validateBotToken,
  assertBotUsernameMatchesAgent,
  type BotInfo,
} from "./telegram-api.js";

export interface BotFatherWalkthroughOpts {
  /** Agent slug — used to suggest a username and to validate the resolved bot. */
  agentSlug: string;
  /**
   * Optional: token already in hand (e.g. supplied via --bot-token or
   * SWITCHROOM_BOT_TOKEN). When present we skip the walkthrough copy and
   * go straight to validate + assert.
   */
  existingToken?: string;
  /**
   * Optional explicit bot username — when set, used for an exact-equality
   * assert against the bot's getMe username instead of the
   * "slug must appear in username" default. Mirrors the
   * assertBotUsernameMatchesAgent contract.
   */
  expectedUsername?: string;
  /**
   * If true the username assertion downgrades from throw to warn-only.
   * Useful when the operator deliberately names the bot without the slug
   * and hasn't yet declared bot_username in switchroom.yaml.
   */
  loose?: boolean;
  /**
   * Reader used for the interactive paste step. When omitted and no
   * existingToken is supplied, the walkthrough throws — non-interactive
   * runs must supply the token up-front.
   */
  readLine?: (prompt: string) => Promise<string>;
  /** Logger for walkthrough copy. Defaults to console.log. */
  log?: (line: string) => void;
  /** Logger for warnings (non-fatal hints). Defaults to console.warn. */
  warn?: (line: string) => void;
  /** Test seam — defaults to validateBotToken (real getMe call). */
  validate?: (token: string) => Promise<BotInfo>;
  /**
   * Maximum number of paste attempts before giving up. The wizard
   * re-prompts on validation failure to recover from copy-paste typos.
   * Default 3.
   */
  maxAttempts?: number;
}

export interface BotFatherWalkthroughResult {
  /** The validated bot token. */
  token: string;
  /** Bot info from getMe. */
  bot: BotInfo;
  /** True iff the walkthrough copy was printed (i.e. interactive path). */
  walkthroughShown: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Suggest a BotFather username for the agent slug. BotFather requires the
 * username to end in "bot" or "Bot" and to be 5-32 chars. We default to
 * `<slug>_bot` and let the operator customise — the only hard rule we
 * enforce later is that the slug appears in the username.
 */
export function suggestUsername(agentSlug: string): string {
  const cleaned = agentSlug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `${cleaned}_bot`;
}

/**
 * Run the walkthrough. Returns the validated token + bot info, or throws
 * with an actionable message.
 */
export async function runBotFatherWalkthrough(
  opts: BotFatherWalkthroughOpts,
): Promise<BotFatherWalkthroughResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const warn = opts.warn ?? ((s: string) => console.warn(s));
  const validate = opts.validate ?? validateBotToken;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // ── Fast path: token already in hand ─────────────────────────────────────
  if (opts.existingToken) {
    const bot = await validate(opts.existingToken);
    enforceUsername(bot.username, opts.agentSlug, opts.expectedUsername, opts.loose, warn);
    return { token: opts.existingToken, bot, walkthroughShown: false };
  }

  // ── Interactive path requires a reader ───────────────────────────────────
  if (!opts.readLine) {
    throw new Error(
      `No bot token supplied for agent "${opts.agentSlug}" and no interactive reader available. ` +
        `Re-run with --bot-token <token> or set SWITCHROOM_BOT_TOKEN.`,
    );
  }

  printWalkthrough(opts.agentSlug, log);

  // ── Paste loop with retry ────────────────────────────────────────────────
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await opts.readLine(
      attempt === 1
        ? "  Paste the bot token from BotFather: "
        : `  Paste the bot token (attempt ${attempt}/${maxAttempts}): `,
    );
    const token = raw.trim();
    if (!token) {
      lastErr = new Error("Empty token entered.");
      log(`  ! Token was empty — try again.`);
      continue;
    }
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      // Cheap structural sanity check — a real BotFather token is
      // <id>:<35-char-base64ish>. We don't reject on mismatch — Telegram
      // will be the source of truth via getMe — but we warn early so a
      // stray quote / partial paste is caught before the network call.
      log(`  ! That doesn't look like a BotFather token (expected <id>:<secret>). Trying anyway…`);
    }
    try {
      const bot = await validate(token);
      try {
        enforceUsername(bot.username, opts.agentSlug, opts.expectedUsername, opts.loose, warn);
      } catch (assertErr) {
        // Username mismatch is recoverable — most likely the operator
        // pasted a token from a different bot. Re-prompt rather than
        // hard-fail so they don't lose the rest of the wizard's progress.
        lastErr = assertErr as Error;
        log(`  ! ${lastErr.message}`);
        log(`  ! Paste the token for the bot you just created in @BotFather, or re-run with --loose.`);
        continue;
      }
      log(`  ok — bot @${bot.username} (${bot.first_name}) accepted.`);
      return { token, bot, walkthroughShown: true };
    } catch (err) {
      lastErr = err as Error;
      log(`  ! Telegram rejected the token: ${lastErr.message}`);
    }
  }

  throw new Error(
    `BotFather walkthrough failed after ${maxAttempts} attempts. ` +
      `Last error: ${lastErr?.message ?? "unknown"}. ` +
      `Re-run \`switchroom agent add\` once you have a working token, or pass --bot-token directly.`,
  );
}

/**
 * Print the step-by-step BotFather copy. Exported for tests + so the CLI
 * can reuse the same wording in --help / docs without duplicating it.
 */
export function printWalkthrough(agentSlug: string, log: (line: string) => void): void {
  const suggested = suggestUsername(agentSlug);
  log("");
  log("  No --bot-token supplied — let's create one with @BotFather.");
  log("");
  log("  Step 1. Open Telegram and DM @BotFather:");
  log("            https://t.me/BotFather");
  log("");
  log("  Step 2. Send /newbot and follow the prompts:");
  log(`            - Name (display): something like "${agentSlug}"`);
  log(`            - Username (must end in "bot"): try "${suggested}"`);
  log(`              (the username must contain "${agentSlug}" so the wizard can`);
  log(`               match it back to this agent — pick anything else and we'll`);
  log(`               re-prompt unless you pass --loose).`);
  log("");
  log("  Step 3. BotFather replies with a token of the form:");
  log("            123456789:AAH...redacted...");
  log("          Copy the whole thing.");
  log("");
  log("  Step 4. (Optional) /setprivacy → Disable, so the bot can read group");
  log("          messages if you ever move it to a forum topology.");
  log("");
}

function enforceUsername(
  username: string,
  agentSlug: string,
  expectedUsername: string | undefined,
  loose: boolean | undefined,
  warn: (line: string) => void,
): void {
  try {
    assertBotUsernameMatchesAgent(username, agentSlug, expectedUsername);
  } catch (err) {
    if (loose) {
      warn(`  warn: ${(err as Error).message}`);
      warn(`         Continuing because --loose was set.`);
      return;
    }
    throw err;
  }
}
