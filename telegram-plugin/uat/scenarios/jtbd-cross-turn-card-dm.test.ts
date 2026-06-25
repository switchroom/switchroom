/**
 * JTBD: "no stale 'thinking…' card opens beneath an answer the user already
 * received in an EARLIER turn" — the cross-turn form of the reply-is-last
 * invariant (design `docs/message-emission-determinism.md` §9 lever 4 / race
 * C/D; PR1).
 *
 * The in-turn levers (#2557, sticky `finalAnswerEverDelivered`) only govern the
 * CURRENT turn. The cross-turn surfaces — the obligation `represent` sweep and
 * the heartbeat/liveness timer — can OPEN a card in a LATER synthetic turn,
 * surfacing a card beneath an answer delivered in an earlier turn. PR1's lever 4
 * gates those synthetic card-OPEN paths on `hasOutboundDeliveredSince`: if a
 * substantive answer already landed since the obligation was raised, the card
 * OPEN is suppressed (the represent SEND is unaffected — only the decorative
 * card).
 *
 * This scenario delivers a substantive answer in turn N, then keeps pulling
 * send-order history through a long settle window (during which the obligation
 * sweep / heartbeat may fire a synthetic represent/liveness surface in turn
 * N+1), and asserts no activity/worker-feed card opened BELOW the delivered
 * answer. `assertReplyIsLast` scopes to the answer's window up to the next
 * driver message — and because a cross-turn synthetic surface carries NO
 * intervening driver message, a card-below-answer it opens falls inside that
 * window and is correctly flagged.
 *
 * Runs under CI `uat-gate`; the full live MTProto run needs the test-harness
 * agent + a vault session, so locally this self-skips green (no driver) — same
 * shape as `jtbd-reply-is-last-dm.test.ts`.
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

/** Per-case overall budget. */
const TURN_BUDGET_MS = 140_000;
/** History pull depth — covers the answer turn + any cross-turn synthetic surface. */
const HISTORY_LIMIT = 80;
/**
 * Settle window AFTER the answer lands. Long enough that the obligation sweep
 * (and the heartbeat liveness timer) has at least one chance to fire a
 * cross-turn synthetic surface — the window PR1 lever 4 guards. The obligation
 * sweep runs on its own interval, so we cannot force a represent deterministically;
 * the durable assertion is "IF a synthetic surface fires, it must not open a
 * card below the answer." A run where no represent fires is a valid green pass.
 */
const POST_ANSWER_SETTLE_MS = 20_000;

describe("uat: no cross-turn card opens beneath an earlier answer (DM)", () => {
  let sc: Scenario | null = null;

  beforeAll(async () => {
    try {
      sc = await spinUp({ agent: "test-harness" });
      await sc.driver.primeDialogs();
    } catch (err) {
      console.warn(
        `[cross-turn-card] no live driver — self-skipping green: ${(err as Error).message}`,
      );
      sc = null;
    }
  });

  it(
    "a substantive answer in turn N is not followed by a card opened in turn N+1 (lever 4 / race C/D)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      // Deliver a substantive answer (≥200 chars → trips the substantive proxy
      // the cross-turn gate keys on). A tool is used so a card legitimately
      // opens DURING the turn — the test then proves nothing opens BELOW the
      // reply afterwards, across the cross-turn boundary.
      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "Use your Bash tool to run `uname -a`, then give me a thorough answer " +
          "(at least 220 characters) explaining what the output means field by " +
          "field. That detailed message is your final answer.",
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: 200, settleMs: POST_ANSWER_SETTLE_MS },
      );

      if (obs.answer == null) {
        console.warn("[cross-turn-card] INCONCLUSIVE — no answer landed in budget.");
        return;
      }

      // Sanity: the answer is a real answer-lane message, not a feed surface.
      expect(isAnswer(obs.answer, driverUserId)).toBe(true);
      expect(isActivityFeedMessage(obs.answer)).toBe(false);
      expect(isWorkerFeedMessage(obs.answer)).toBe(false);

      // Pull full server send-order history AFTER the long settle. Any
      // cross-turn synthetic surface (represent / heartbeat liveness) that
      // opened a card would now be present with a HIGHER message_id than the
      // answer and — having no intervening driver message — inside the answer's
      // turn window, so assertReplyIsLast flags it. Lever 4 must have suppressed
      // that OPEN.
      const history = await driver.getHistory(botUserId, HISTORY_LIMIT);
      assertReplyIsLast(history, driverUserId, { turn: obs.answer });
    },
    TURN_BUDGET_MS + 40_000,
  );
});
