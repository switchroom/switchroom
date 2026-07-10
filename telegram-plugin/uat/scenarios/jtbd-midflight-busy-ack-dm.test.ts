/**
 * JTBD scenario — mid-flight busy ack (#2995).
 *
 * Serves: `reference/jobs/steer-or-queue-mid-flight.md` — the third
 * mid-flight class (a quick question that neither steers nor queues
 * work of its own) and its latency promise: a mid-flight message
 * arriving while the agent sits inside ONE long blocking tool call
 * gets a visible, silent ack naming the blocking activity within
 * seconds — never minutes of dead air behind a `--watch`-style call.
 *
 * ## What the scenario drives
 *
 * 1. Prompt the agent into a deliberately slow BLOCKING foreground
 *    Bash (`sleep`) — explicitly instructed NOT to background it.
 * 2. Wait past the busy-ack step-age threshold (12s), then send a
 *    trivial mid-turn status question. It buffers (unmarked mid-turn
 *    follow-up = queue).
 * 3. Assert a bot message matching the deterministic busy-ack shape
 *    ("⏳ Queued — currently inside `…`") lands within ACK_SLA_MS of
 *    the ping, and is SILENT (disable_notification).
 * 4. Assert the real answer to the question arrives later (after the
 *    blocking step returns and the buffer flushes).
 * 5. Assert the busy-ack card was cleaned up (deleted) once the
 *    answer landed — never a dangling "Queued" line.
 *
 * Negative case: a ping during a SHORT blocking step (well under the 12s
 * threshold, and finished before the deferred re-check could ever see a
 * 12s-old step) gets NO busy-ack card at any point — an ack that fires
 * when the agent was seconds from answering is the job spec's explicit
 * Bad bullet. (A young-step ping during a LONG step DOES get a deferred
 * card once the step ages past the threshold — that is the re-check
 * behaviour, covered by the positive case's latency budget.)
 *
 * ## Conventions
 *
 * - mtcute harness (`spinUp`), skip discipline like siblings: env
 *   handled by load-env; the suite hard-fails without creds by design
 *   (CI path-gates it to the uat-host runner).
 * - `!m.edited` filters on every observation (PR #2991 lesson — the
 *   live draft/feed edits stream constantly; edits must never satisfy
 *   a fresh-message expectation).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";

// The gateway constant is 12s (BUSY_ACK_STEP_AGE_THRESHOLD_MS). The
// warmup is anchored to the SEND, not to observed tool start — the agent
// needs a few seconds to open the turn and enter the Bash step — so it
// carries a large margin: even if the tool starts ~15s after the send,
// the step is comfortably past the threshold when the ping lands.
const STEP_WARMUP_MS = 35_000;

// Latency promise: user-visible ack within seconds of the ping. The card
// is posted synchronously by the gateway (no model). When the ping lands
// past the threshold the card is immediate; if the step turns out to be
// just under, the deferred re-check posts it within (threshold − age).
// 10s + jitter headroom covers both.
const ACK_SLA_MS = 10_000;

// The blocking sleep. Long enough that warmup + ping + ack all land while
// the step is still open (even with a late tool start); short enough to
// keep wall-clock sane.
const SLEEP_SECS = 120;

const BUSY_ACK_RE = /⏳ Queued — currently inside `.+`.*I'll answer when this step finishes/s;

const SLOW_PROMPT =
  `For a latency test, run this exact command in the FOREGROUND with your ` +
  `Bash tool (do NOT use run_in_background, do NOT split it up): ` +
  `\`sleep ${SLEEP_SECS} && echo done\`. When it completes, reply with ` +
  `exactly: SLEEP_DONE. Do not send any message before it completes.`;

const PING = "Quick question while you work: are you still there? One word is fine.";

describe("uat: mid-flight busy ack during a long blocking tool call (#2995)", () => {
  it(
    "a mid-turn ping behind a long blocking Bash gets a silent Queued ack naming the activity, then the real answer, then cleanup",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM(SLOW_PROMPT);

        // Let the blocking step age past the busy-ack threshold.
        await new Promise((r) => setTimeout(r, STEP_WARMUP_MS));

        const pingAt = Date.now();
        await sc.sendDM(PING);

        // The deterministic busy-ack must land within the SLA, silent,
        // naming the blocking activity. `!m.edited` — feed/draft edits
        // must never satisfy this.
        const ack = await sc.expectMessage(
          (m: ObservedMessage) => m.fromBot && !m.edited && BUSY_ACK_RE.test(m.text),
          { from: "bot", timeout: ACK_SLA_MS + 5_000 },
        );
        const ackLatency = Date.now() - pingAt;
        expect(
          ackLatency,
          `busy-ack landed ${ackLatency}ms after the ping — the <10s ` +
            `latency promise for a mid-flight quick question is broken.`,
        ).toBeLessThan(ACK_SLA_MS + 5_000);
        expect(
          ack.silent,
          `busy-ack pinged the user's device (silent=false) — the card ` +
            `must carry disable_notification:true.`,
        ).toBe(true);
        // Names the blocking activity (the Bash sleep), not a generic line.
        expect(ack.text).toMatch(/`.*(Bash|sleep).*`/i);

        // The real answer to the ping arrives AFTER the blocking step
        // returns and the buffer flushes. Any fresh non-card bot message
        // that isn't the busy-ack or the SLEEP_DONE completion counts —
        // the SLEEP_DONE exclusion is explicit (it answers the FIRST
        // prompt, not the ping).
        const answer = await sc.expectMessage(
          (m: ObservedMessage) =>
            m.fromBot &&
            !m.edited &&
            m.messageId !== ack.messageId &&
            !BUSY_ACK_RE.test(m.text) &&
            !/SLEEP_DONE/i.test(m.text) &&
            m.text.trim().length > 0,
          { from: "bot", timeout: (SLEEP_SECS + 90) * 1000 },
        );
        expect(answer.text.trim().length).toBeGreaterThan(0);

        // Cleanup: once answers land and the turns wrap, the busy-ack
        // card is deleted (delete-on-answer lifecycle). Poll briefly —
        // the reap is fire-and-forget after the answer/turn-end.
        const cleanupDeadline = Date.now() + 60_000;
        let cardGone = false;
        while (Date.now() < cleanupDeadline) {
          const still = await sc.driver.getMessage(sc.botUserId, ack.messageId);
          if (still == null) {
            cardGone = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 3_000));
        }
        expect(
          cardGone,
          `busy-ack card (msg ${ack.messageId}) still present 60s after ` +
            `the answer — a stale "Queued" line is dangling in the chat.`,
        ).toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    // warmup + sleep + flush + answer + cleanup poll + settle headroom
    (STEP_WARMUP_MS + SLEEP_SECS * 1000 + 200_000),
  );

  it(
    "negative: a ping during a SHORT step (finishes under the threshold) never gets a busy-ack card",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        // An 8s sleep can NEVER age past the 12s threshold — neither the
        // direct evaluation nor the deferred re-check may produce a card
        // (the re-check re-reads live state and finds the step gone).
        await sc.sendDM(
          `For a latency test, run this exact command in the FOREGROUND ` +
            `with your Bash tool (do NOT use run_in_background): ` +
            `\`sleep 8 && echo done\`. When it completes, reply with ` +
            `exactly: SHORT_SLEEP_DONE. Do not send any message before it completes.`,
        );

        // Give the agent a beat to enter the Bash step, then ping while
        // the short step is (at most) a few seconds old.
        await new Promise((r) => setTimeout(r, 4_000));
        await sc.sendDM("Still with me?");

        // Watch through the step end + the widest possible re-check window
        // + the answer. No message matching the busy-ack shape may appear.
        let prematureAck: ObservedMessage | null = null;
        try {
          prematureAck = await sc.expectMessage(
            (m: ObservedMessage) => m.fromBot && !m.edited && BUSY_ACK_RE.test(m.text),
            { from: "bot", timeout: 45_000 },
          );
        } catch {
          // timeout = the correct outcome (no ack, ever)
        }
        expect(
          prematureAck,
          `a busy-ack fired for a step that never reached the threshold ` +
            `(${JSON.stringify(prematureAck?.text.slice(0, 120))}) — the ` +
            `agent was seconds from answering; the threshold/re-check ` +
            `gates are not holding.`,
        ).toBeNull();
      } finally {
        await sc.tearDown();
      }
    },
    150_000,
  );
});
