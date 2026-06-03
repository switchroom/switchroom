/**
 * Foreground sub-agent live activity nesting in a SUPERGROUP (#2032 + #2099) — UAT.
 *
 * Channel twin of `jtbd-foreground-subagent-activity-dm`. A FOREGROUND
 * sub-agent (Agent/Task `run_in_background:false`) dispatched from a supergroup
 * — after an ack-first "On it" reply — must nest its live steps into the
 * parent's activity-summary feed IN the supergroup. Proves the foreground
 * sub-agent status surface has DM/channel parity (and exercises #2099's
 * tool-step nesting + #2032's render-regardless-of-replyCalled in a channel).
 *
 * Asserts the load-bearing proof: an activity-summary feed message carrying the
 * nested "↳" marker appears IN the supergroup AFTER the ack, then the turn
 * completes cleanly. Self-skips when no test supergroup is wired. Uses the
 * General topic (mtcute here has no forum-topic create API). NOT a draft —
 * the activity-summary feed is a real sendMessage/editMessageText, so mtcute
 * can observe it.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const FG_DISPATCH_PROMPT =
  `First, immediately send me a one-line acknowledgement that you're starting ` +
  `(just "On it — running a check now."). Then use the Agent tool with ` +
  `subagent_type "general-purpose" and run_in_background: false (a FOREGROUND ` +
  `sub-agent) with this exact task: "Do eight steps, ONE AT A TIME, k = 1 ` +
  `through 8. Before each step write a brief one-sentence narration of what ` +
  `you are about to do, then run \`sleep 2\` via the Bash tool, then run ` +
  `\`echo step-k\` via the Bash tool (substitute the real number for k). Run ` +
  `every sleep and every echo as its OWN separate Bash call — never batch or ` +
  `chain them with && — and narrate before each so progress surfaces ` +
  `incrementally. Do not stop early; complete all eight steps, then return a ` +
  `one-line summary." Wait for the foreground sub-agent to finish, then send ` +
  `me a brief reply telling me it's done.`;

const NESTED_RE = /↳/;

describe("uat: foreground sub-agent activity nesting in a supergroup (#2032/#2099 channel parity)", () => {
  it(
    "surfaces nested foreground activity in the feed IN the supergroup, after the ack",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[fg-activity channel UAT] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[fg-activity channel UAT] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }
        await sc.driver.sendText(SUPERGROUP_ID, FG_DISPATCH_PROMPT);

        // Ack-first reply in the supergroup — sets replyCalled=true before the
        // foreground sub-agent runs (the condition that broke #2027).
        const ack = await expectMessage(sc.driver, SUPERGROUP_ID, /.+/, {
          timeout: 60_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(`[fg-activity channel UAT] ack-first reply: ${JSON.stringify(ack.text)}`);

        // The activity-summary feed carrying the NESTED foreground narrative —
        // must land IN the supergroup. Its presence after the ack is the proof.
        const feed = await expectMessage(sc.driver, SUPERGROUP_ID, NESTED_RE, {
          timeout: 90_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(
          `[fg-activity channel UAT] nested feed paint (id=${feed.messageId}, chat=${feed.chatId}): ${JSON.stringify(feed.text)}`,
        );
        expect(feed.chatId).toBe(SUPERGROUP_ID); // parity proof: nested feed in the channel
        expect(feed.fromBot).toBe(true);
        expect(feed.text).toMatch(NESTED_RE);

        // Live edit: re-fetch the SAME message after a few sub-agent steps.
        const before = feed.text;
        await new Promise((r) => setTimeout(r, 10_000));
        const mid = await sc.driver.getMessage(SUPERGROUP_ID, feed.messageId);
        console.log(
          `[fg-activity channel UAT] same feed after 10s (id=${feed.messageId}): ${JSON.stringify(mid?.text ?? null)}`,
        );

        // Final answer — parent resumes after the foreground sub-agent returns.
        const done = await expectMessage(sc.driver, SUPERGROUP_ID, /done|complete|finished|step-8|wrapped/i, {
          timeout: 120_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(`[fg-activity channel UAT] final answer: ${JSON.stringify(done.text)}`);
        expect(done.text.length).toBeGreaterThan(0);
        if (mid?.text != null) {
          console.log(`[fg-activity channel UAT] body moved in-flight: ${mid.text !== before}`);
        }
      } finally {
        await sc.tearDown();
      }
    },
    300_000,
  );
});
