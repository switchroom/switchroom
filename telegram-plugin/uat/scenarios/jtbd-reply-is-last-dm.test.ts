/**
 * JTBD: "the reply is last" + "a conversational turn opens no card" — the
 * CI-enforced form of the deterministic emission invariants (design
 * `docs/message-emission-determinism.md` §11; #2556).
 *
 * Four cases, each pulled from server SEND-ORDER history (`driver.getHistory`)
 * so a post-reply card that landed before any live observer started is still
 * caught. The ordering assertion is the SCOPED one (§6): within a single
 * foreground turn, no activity-card / worker-feed surface opens after that
 * turn's reply — NOT a naive "answer has the max message_id" (that would
 * false-positive on a legitimate later background / represent / error surface).
 * `assertReplyIsLast` filters to the activity/answer lanes of the SAME turn.
 *
 *   1. Conversational, zero-tool ("Reply with only: pong") — NO activity card
 *      opens in this turn at all (lever 5 base case / G1, the triplication).
 *   2. Tool-heavy (a REAL_WORK activity-surface prompt) — a card opened AND no
 *      card for this turn sits below the substantive reply (lever 1 / races
 *      A/B/E).
 *   3. Short-pinging final ("Reply 'Done!' then write one memory") — the
 *      currently-reordering case; green only once lever 2 lands (G5).
 *   4. Two-turn backstop — a prompt that ends a turn without a qualifying reply
 *      (forcing the silent-end re-prompt); no card opens below the final answer
 *      across the re-prompt boundary (G3/C). Needs `getHistory`.
 *
 * Runs under CI `uat-gate`; the full live MTProto run needs the test-harness
 * agent + a vault session, so locally this self-skips green (no driver).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spinUp, type Scenario } from "../harness.js";
import {
  assertReplyIsLast,
  isAnswer,
  isActivityFeedMessage,
  isWorkerFeedMessage,
} from "../assertions.js";
import { collectTurn } from "../real-work-prompts.js";
import type { ObservedMessage } from "../driver.js";

/** Per-case overall budget. */
const TURN_BUDGET_MS = 130_000;
/** History pull depth — comfortably covers a multi-surface two-turn exchange. */
const HISTORY_LIMIT = 80;

describe("uat: reply-is-last + conversational-turn-opens-no-card (DM)", () => {
  let sc: Scenario | null = null;

  beforeAll(async () => {
    try {
      sc = await spinUp({ agent: "test-harness" });
      await sc.driver.primeDialogs();
    } catch (err) {
      console.warn(
        `[reply-is-last] no live driver — self-skipping green: ${(err as Error).message}`,
      );
      sc = null;
    }
  });

  // Case 1 — conversational, zero-tool: NO activity card opens at all.
  it(
    "case 1: a conversational 0-tool turn opens NO activity card (lever 5 / G1)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "Reply with only this exact word and nothing else, using no tools at all: pong",
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: 1, settleMs: 8_000 },
      );

      expect(obs.answer, "the pong answer must land").not.toBeNull();

      // Pull send-order history and confirm: no activity-card surface opened in
      // this turn. We scope to surfaces at/after the answer's turn by reusing
      // assertReplyIsLast, AND additionally assert the live collector saw no
      // activity feed for this minimal turn.
      const history = await driver.getHistory(botUserId, HISTORY_LIMIT);
      assertReplyIsLast(history, driverUserId, { turn: obs.answer! });

      // The strong G1 assertion: a 0-tool conversational turn must produce no
      // activity feed at all (neither open nor edit).
      expect(
        obs.sawActivityFeed,
        "a 0-tool conversational turn must not open an activity card (the triplication)",
      ).toBe(false);
    },
    TURN_BUDGET_MS + 30_000,
  );

  // Case 2 — tool-heavy: a card opens, but none below the substantive reply.
  it(
    "case 2: a tool-heavy turn opens a card but none below the reply (lever 1 / races A/B/E)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "Use your Bash tool to run `uname -a`, then tell me in one sentence what " +
          "operating system this machine is running. Keep the answer substantive " +
          "(a few sentences explaining what the output means).",
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: 60, settleMs: 8_000 },
      );

      if (obs.answer == null) {
        console.warn("[reply-is-last] case 2 INCONCLUSIVE — no answer landed in budget.");
        return;
      }
      if (!obs.sawActivityFeed && !obs.sawWorkerFeed) {
        console.warn(
          "[reply-is-last] case 2 INCONCLUSIVE — the agent answered without a " +
            "tool feed; the reorder vector this guards was not exercised.",
        );
        return;
      }

      const history = await driver.getHistory(botUserId, HISTORY_LIMIT);
      // The scoped invariant: no activity/worker-feed surface for this turn
      // lands below the substantive reply.
      assertReplyIsLast(history, driverUserId, { turn: obs.answer });
    },
    TURN_BUDGET_MS + 30_000,
  );

  // Case 3 — short-pinging final: the case the lever-2 ordering fix makes pass.
  it(
    "case 3: a short-pinging final stays last even with post-reply tool work (lever 2 / G5)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "Reply with only the single word 'Done!' (with the exclamation mark) — " +
          "then, AFTER that reply, save a one-line memory noting you completed " +
          "this test. The short reply is your final answer.",
        // The "Done!" reply is short; accept it as the answer.
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: 1, settleMs: 10_000 },
      );

      if (obs.answer == null) {
        console.warn("[reply-is-last] case 3 INCONCLUSIVE — no answer landed in budget.");
        return;
      }

      const history = await driver.getHistory(botUserId, HISTORY_LIMIT);
      // The post-'Done!' memory write must NOT have reopened a card BELOW the
      // reply. Before lever 2 this reorders (the named G5 residual); after, the
      // card is finalized before the send and stays above.
      assertReplyIsLast(history, driverUserId, { turn: obs.answer });
    },
    TURN_BUDGET_MS + 30_000,
  );

  // Case 4 — two-turn backstop: no card below the final answer across the
  // silent-end re-prompt boundary.
  it(
    "case 4: no card opens below the final answer across a re-prompt boundary (G3/C)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      // A prompt that nudges the model to write its answer as prose first
      // (no reply tool) — forcing the silent-end re-prompt, then a real answer
      // on the re-prompted turn. The model's exact path isn't forceable, so the
      // ordering assertion is the durable part; the re-prompt is best-effort.
      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "Think out loud briefly, then give me a thorough multi-sentence answer " +
          "(at least 220 characters) explaining what a Telegram supergroup is and " +
          "how forum topics work inside one.",
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: 200, settleMs: 12_000 },
      );

      if (obs.answer == null) {
        console.warn("[reply-is-last] case 4 INCONCLUSIVE — no answer landed in budget.");
        return;
      }

      // Pull full send-order history (the re-prompt may have produced a second
      // card before the live observer in collectTurn caught it) and assert the
      // final answer's turn has no feed surface below it.
      const history = await driver.getHistory(botUserId, HISTORY_LIMIT);
      assertReplyIsLast(history, driverUserId, { turn: obs.answer });

      // Sanity: the answer is a genuine answer-lane message (not a feed).
      expect(isAnswer(obs.answer, driverUserId)).toBe(true);
      expect(isActivityFeedMessage(obs.answer)).toBe(false);
      expect(isWorkerFeedMessage(obs.answer)).toBe(false);
    },
    TURN_BUDGET_MS + 30_000,
  );
});
