/**
 * Live worker-activity feed in a SUPERGROUP (#2000 + #2098 routing) — UAT.
 *
 * Channel twin of `jtbd-worker-activity-feed-dm`. A background sub-agent
 * (Agent/Task `run_in_background:true`) dispatched from a supergroup must
 * surface its live `🛠 Worker · …` feed message IN the supergroup — not the
 * operator DM (the pre-v0.14.32 "always route to DM" bug). Proves the
 * background-worker status surface has DM/channel parity.
 *
 * Asserts: (1) a worker-feed message appears IN the supergroup, from the bot;
 * (2) it edits in place while work is in flight; (3) it finalizes to the
 * terminal recap; (4) no raw Markdown leaks (#94-class guard).
 *
 * Self-skips when no test supergroup is wired. Uses the General topic (mtcute
 * here has no forum-topic create API). Same paced-narration dispatch as the
 * DM version so the worker's jsonl ticks under the test-harness 5s stall floor.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Do ten steps, ONE AT A TIME, k = 1 through 10. Before each step ` +
  `write a brief one-sentence narration of what you are about to do, ` +
  `then run \`sleep 2\` via the Bash tool, then run \`echo step-k\` via ` +
  `the Bash tool (substitute the real number for k). Run every sleep and ` +
  `every echo as its OWN separate Bash call — never batch or chain them ` +
  `with && — and narrate before each so progress surfaces incrementally. ` +
  `Do not stop early; complete all ten steps." After dispatching, send a ` +
  `brief reply saying you've kicked off the background worker so I can ` +
  `watch its progress.`;

const WORKER_FEED_RE = /🛠\s*Worker|running\s*·|finished\s*·/i;
const WORKER_DONE_RE = /finished\s*·\s*(completed|failed)/i;

describe("uat: live worker-activity feed in a supergroup (#2000 channel parity)", () => {
  it(
    "surfaces a background worker as a live, editing message IN the supergroup",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[worker-feed channel UAT] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[worker-feed channel UAT] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }
        await sc.driver.sendText(SUPERGROUP_ID, BG_DISPATCH_PROMPT);

        // Parent ack in the supergroup so we know the parent turn closed.
        const ack = await expectMessage(sc.driver, SUPERGROUP_ID, /.+/, {
          timeout: 45_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(`[worker-feed channel UAT] parent ack: ${JSON.stringify(ack.text)}`);

        // The worker-feed message — must land IN the supergroup.
        const feed = await expectMessage(sc.driver, SUPERGROUP_ID, WORKER_FEED_RE, {
          timeout: 75_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(
          `[worker-feed channel UAT] first feed paint (id=${feed.messageId}, chat=${feed.chatId}): ${JSON.stringify(feed.text)}`,
        );
        expect(feed.chatId).toBe(SUPERGROUP_ID); // parity proof: in the channel, not the DM
        expect(feed.fromBot).toBe(true);
        expect(feed.messageId).toBeGreaterThan(0);

        // Live edit: re-fetch the SAME message after the throttle.
        const before = feed.text;
        await new Promise((r) => setTimeout(r, 12_000));
        const mid = await sc.driver.getMessage(SUPERGROUP_ID, feed.messageId);
        console.log(
          `[worker-feed channel UAT] after 12s (id=${feed.messageId}): ${JSON.stringify(mid?.text ?? null)}`,
        );
        expect(mid, "worker-feed message vanished mid-flight").not.toBeNull();

        // Terminal recap — poll the same message until done/failed.
        let doneText: string | null = null;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const m = await sc.driver.getMessage(SUPERGROUP_ID, feed.messageId);
          if (m != null && WORKER_DONE_RE.test(m.text)) {
            doneText = m.text;
            break;
          }
          await new Promise((r) => setTimeout(r, 5_000));
        }
        console.log(
          `[worker-feed channel UAT] terminal (id=${feed.messageId}): ${JSON.stringify(doneText)}`,
        );
        expect(doneText, "worker-feed never reached a terminal recap").not.toBeNull();
        expect(doneText!).toMatch(/tools?|tool ·/i);
        expect(doneText).not.toBe(before);
        // #94-class regression guard: no raw Markdown in the native card.
        expect(doneText!, "raw ** leaked into the card").not.toMatch(/\*\*/);
        expect(doneText!, "raw backtick leaked into the card").not.toContain("`");
        expect(doneText!, "raw --- rule leaked into the card").not.toMatch(/(^|\n)\s*-{3,}\s*(\n|$)/);
      } finally {
        await sc.tearDown();
      }
    },
    240_000,
  );
});
