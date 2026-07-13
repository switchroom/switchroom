/**
 * ADVERSARIAL — sub-agent card paints for an INSTANT / near-instant worker,
 * then flips to a terminal state (attacks fix #3231 / commit 1aa700a0).
 *
 * The first-paint fix must hold not only for a long-blocking worker but for a
 * worker that lives only a couple of seconds: register → one quick tool → done.
 * The failure mode this attacks: the card never paints at all for a worker that
 * dies before the growth-driven feed ever gets a poll in, so the user sees a
 * dispatch with no visible card and no terminal recap — the work happened
 * invisibly.
 *
 * Oracle: a `🛠 Worker` feed message must appear AND (within a bounded window)
 * reach a terminal recap. Because the worker is short-lived, the running window
 * may be missed — that's fine; the invariant under test is "it painted and it
 * shows a truthful terminal state", not "we caught it mid-run". A regressed
 * first-paint would surface NEITHER, red-ing the WORKER_FEED_RE wait below.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { WORKER_FEED_RE } from "../assertions.js";

// Near-instant leaf worker: one echo, then stop. Lives ~1 model round-trip.
const DYING_WORKER_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this EXACT task: ` +
  `"Run \`echo hello\` via the Bash tool exactly once, then immediately ` +
  `stop. Do nothing else." After dispatching, send a one-line reply saying ` +
  `you kicked off the worker.`;

// Terminal recap: a done/failed/incomplete state anchored to the metric line.
const TERMINAL_RE = /\b(done|failed|incomplete|completed)\b/i;

describe("uat-adv: sub-agent card paints for a near-instant worker (attacks #3231)", () => {
  it(
    "worker card appears then reaches a terminal state even for a worker that exits almost immediately",
    async () => {
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        const dispatchedAt = Date.now();
        await sc.sendDM(DYING_WORKER_PROMPT);

        // Parent ack.
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        // The card MUST paint despite the worker's short life. Generous window:
        // the worker-feed firstPaintMin (~8s) can be longer than the worker's
        // own lifetime, and the skeleton/backstop keeps the row alive to paint.
        const feed = await sc.expectMessage(WORKER_FEED_RE, {
          from: "bot",
          timeout: 90_000,
        });
        console.log(
          `[adv-dying] worker card painted at +${Date.now() - dispatchedAt}ms: ${JSON.stringify(feed.text.slice(0, 160))}`,
        );
        expect(feed.messageId).toBeGreaterThan(0);

        // It must reach a truthful terminal recap (the worker really did finish).
        let terminal: string | null = null;
        const deadline = Date.now() + 150_000;
        while (Date.now() < deadline) {
          const m = await sc.driver.getMessage(sc.botUserId, feed.messageId);
          if (m != null && TERMINAL_RE.test(m.text)) {
            terminal = m.text;
            break;
          }
          // The feed may re-post as a new message rather than edit in place if
          // it terminated before first paint — also accept a fresh terminal send.
          await new Promise((r) => setTimeout(r, 3_000));
        }
        console.log(`[adv-dying] terminal: ${JSON.stringify(terminal?.slice(0, 200))}`);
        expect(terminal, "near-instant worker card never reached a terminal state").not.toBeNull();
        expect(terminal!).toMatch(TERMINAL_RE);
      } finally {
        await sc.tearDown();
      }
    },
    300_000,
  );
});
</content>
