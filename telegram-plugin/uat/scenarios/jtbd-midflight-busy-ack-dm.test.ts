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
 * Negative case: a mid-turn ping sent IMMEDIATELY (step age < the 12s
 * threshold) gets NO busy-ack card — an ack that fires when the agent
 * was seconds from answering is the job spec's explicit Bad bullet.
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

// The gateway constant is 12s (BUSY_ACK_STEP_AGE_THRESHOLD_MS). Wait a
// comfortable margin past it before pinging so the step has proven long.
const STEP_WARMUP_MS = 18_000;

// Latency promise: user-visible ack within seconds of the ping. The card
// is posted synchronously by the gateway (no model), so 10s is generous —
// it covers mtcute polling jitter only.
const ACK_SLA_MS = 10_000;

// The blocking sleep. Long enough that the warmup + ping + ack all land
// while the step is still open; short enough to keep wall-clock sane.
const SLEEP_SECS = 60;

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
        // that isn't the busy-ack or the SLEEP_DONE completion counts.
        const answer = await sc.expectMessage(
          (m: ObservedMessage) =>
            m.fromBot &&
            !m.edited &&
            m.messageId !== ack.messageId &&
            !BUSY_ACK_RE.test(m.text) &&
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
    "negative: a ping while the step is still young (< threshold) gets no busy-ack card",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM(
          `For a latency test, run this exact command in the FOREGROUND ` +
            `with your Bash tool (do NOT use run_in_background): ` +
            `\`sleep 25 && echo done\`. When it completes, reply with ` +
            `exactly: SHORT_SLEEP_DONE. Do not send any message before it completes.`,
        );

        // Give the agent a beat to enter the Bash step, but ping while
        // the step is still well under the 12s threshold.
        await new Promise((r) => setTimeout(r, 4_000));
        await sc.sendDM("Still with me?");

        // Watch the window where a premature ack would land. No message
        // matching the busy-ack shape may appear.
        let prematureAck: ObservedMessage | null = null;
        try {
          prematureAck = await sc.expectMessage(
            (m: ObservedMessage) => m.fromBot && !m.edited && BUSY_ACK_RE.test(m.text),
            { from: "bot", timeout: 12_000 },
          );
        } catch {
          // timeout = the correct outcome (no premature ack)
        }
        expect(
          prematureAck,
          `a busy-ack fired for a young step (${JSON.stringify(
            prematureAck?.text.slice(0, 120),
          )}) — the agent was seconds from answering; the threshold gate ` +
            `is not holding.`,
        ).toBeNull();
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
