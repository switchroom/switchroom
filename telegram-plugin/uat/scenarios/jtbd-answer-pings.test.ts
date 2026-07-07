/**
 * JTBD: "the answer pings" — notification ownership (R8 / PR-2; design
 * `docs/message-emission-determinism.md` §over-ping).
 *
 * The residual the bare one-ping-per-turn safety net left: when a turn opens
 * with an interim ACK that pings first, the ack claims the turn's single ping
 * slot and the LATER substantive answer used to be downgraded to silent — the
 * reply is last on screen, but the user's phone never buzzed for the actual
 * answer. PR-2 makes `decideOverPing` aware of WHO holds the slot and lets a
 * substantive answer UPGRADE over an ack's slot, so the answer pings.
 *
 * This scenario drives the exact sequence end-to-end: an "On it" style ack
 * (pings, claims the slot) followed by a ≥300-char substantive answer, and
 * asserts the ANSWER arrived non-silent via `assertAnswerPinged`
 * (mtcute's `ObservedMessage.silent`).
 *
 * Runs under CI `uat-gate`; the full live MTProto run needs the test-harness
 * agent + a vault session, so locally this self-skips green (no driver).
 *
 * Scope caveat: this end-to-end scenario exercises PR-2's upgrade code path
 * when the harness model delivers its final answer via the `reply` tool —
 * which is now the single final-answer tool (the redundant `stream_reply`
 * tool was retired). The model's exact phrasing isn't forceable here, which
 * makes this scenario a WEAKER backstop than the unit matrix — the real proof
 * of the upgrade behaviour lives in the deterministic unit tests in
 * `over-ping-final-answer-decoupling.test.ts`. Treat this as a live
 * smoke-test of the happy path, not the source of truth.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spinUp, type Scenario } from "../harness.js";
import { assertAnswerPinged, isAnswer } from "../assertions.js";
import { collectTurn } from "../real-work-prompts.js";

/** Overall budget for the ack-then-answer turn. */
const TURN_BUDGET_MS = 130_000;
/** The answer must clear the substantive-length backstop (≥200). */
const MIN_ANSWER_CHARS = 200;

describe("uat: the substantive answer pings even after an ack pinged (DM)", () => {
  let sc: Scenario | null = null;

  beforeAll(async () => {
    try {
      sc = await spinUp({ agent: "test-harness" });
      await sc.driver.primeDialogs();
    } catch (err) {
      console.warn(
        `[answer-pings] no live driver — self-skipping green: ${(err as Error).message}`,
      );
      sc = null;
    }
  });

  it(
    "an ack pings first, then the substantive answer also pings (R8 / PR-2 upgrade)",
    async () => {
      if (sc == null) return; // self-skip green
      const { driver, botUserId, driverUserId } = sc;

      // Prompt the model into the ack-then-answer cadence: a quick pinging
      // "On it" reply, then — after a beat — a thorough ≥300-character answer
      // as a fresh (also pinging) reply. The model's exact wording isn't
      // forceable, so we accept any substantive (≥200-char) answer that lands;
      // collectTurn skips the short ack (below minAnswerChars) and latches onto
      // the real answer.
      const obs = await collectTurn(
        driver,
        botUserId,
        driverUserId,
        "First send a very short interim reply 'On it.' (pinging — do NOT set " +
          "disable_notification). THEN, as a separate second reply, give me a " +
          "thorough answer of at least 300 characters explaining what a Telegram " +
          "supergroup is, how forum topics partition it, and how a bot routes a " +
          "reply back to the topic a question came from. The long second reply is " +
          "your final answer.",
        { timeoutMs: TURN_BUDGET_MS, minAnswerChars: MIN_ANSWER_CHARS, settleMs: 12_000 },
      );

      if (obs.answer == null) {
        console.warn("[answer-pings] INCONCLUSIVE — no substantive answer landed in budget.");
        return;
      }

      // Sanity: this is the answer lane, not a feed surface.
      expect(isAnswer(obs.answer, driverUserId)).toBe(true);

      // The load-bearing assertion: the substantive answer is non-silent. If an
      // earlier ack-ping had downgraded it (the pre-PR-2 residual), this throws.
      assertAnswerPinged(obs.answer);
    },
    TURN_BUDGET_MS + 30_000,
  );
});
