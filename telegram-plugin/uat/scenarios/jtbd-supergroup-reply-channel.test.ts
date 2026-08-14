/**
 * JTBD scenario — supergroup channel operation (the base channel proof).
 *
 * Every other UAT scenario is `-dm`: the entire status / reply path has
 * only ever been exercised in a 1:1 DM. The operator's hard requirement
 * is "status must work in DMs AND channels" (Telegram supergroups with
 * forum topics). This is the first real-Telegram proof that the agent
 * operates inside a supergroup at all — the prerequisite for asserting
 * *where* status lands (worker feed, handback) in the topic-routing
 * scenarios.
 *
 * Setup: `test-harness` is supergroup-owned on `SWITCHROOM_UAT_CHAT_ID`
 * (its bot is a group admin). See `uat/SETUP.md §2`. The scenario
 * self-skips when that env var is unset so CI / fresh dev hosts without
 * a wired test supergroup stay green.
 *
 * What it proves:
 *   - the agent replies INSIDE the supergroup (chatId === supergroup),
 *     not the operator DM (the v0.14.32+ "route to where the Task was
 *     dispatched from" contract at the conversation level);
 *   - the reply is the bot's, addressed to the General topic the prompt
 *     landed in (default_topic_id routing).
 *
 * mtcute caveat: this version of mtcute exposes no forum-topic create /
 * enumerate API, so the scenario uses the supergroup's General topic.
 * Fine-grained "correct topic among many" routing is pinned by the
 * gateway unit thread-assertions (PR #2098); this asserts the live
 * DM-vs-channel boundary mtcute CAN observe (a real chat message, not a
 * draft — see `feedback_mtcute_cannot_observe_drafts`).
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";

/** Bot API marked id of the test supergroup, e.g. -1006666666666. */
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

/** A supergroup turn is a full inbound→claude→outbound round-trip; give
 *  it the same generous budget as the cold-start DM scenarios. */
const REPLY_TIMEOUT_MS = 90_000;

describe("uat: supergroup channel reply", () => {
  it("agent replies inside the supergroup (not the DM)", async () => {
    if (!Number.isFinite(SUPERGROUP_ID)) {
      console.warn(
        "[uat] SWITCHROOM_UAT_CHAT_ID unset — skipping supergroup scenario " +
          "(wire test-harness to a supergroup per uat/SETUP.md §2)",
      );
      return;
    }

    // settleMs:0 — single scenario, no prior turn to drain.
    const sc = await spinUp({ agent: AGENT, settleMs: 0 });
    try {
      // The driver runs on MemoryStorage (empty cache); prime the dialog
      // list so the supergroup's marked id is resolvable (it has no
      // username). Requires the driver account to be a group member.
      await sc.driver.primeDialogs();

      // Non-intrusive postability check (sends nothing). Skips — rather
      // than reds — when the chat isn't a resolvable forum supergroup the
      // driver is in (e.g. still a BASIC group, or not a member). The
      // wiring is an operator setup step (uat/SETUP.md §2), and the
      // topic-routing logic is pinned by the unit thread-assertions (#2098).
      if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
        console.warn(
          `[uat] supergroup ${SUPERGROUP_ID} not resolvable — skipping. Ensure ` +
            `it's a forum supergroup (Topics enabled) and the driver is a member.`,
        );
        return;
      }

      // Unique nonce so the matcher can't latch onto an unrelated message
      // already in the group.
      const nonce = `sgproof-${Date.now().toString(36)}`;
      await sc.driver.sendText(
        SUPERGROUP_ID,
        `You're being tested in a group. Reply in this group with exactly this token and nothing else: ${nonce}`,
      );

      const reply = await expectMessage(
        sc.driver,
        SUPERGROUP_ID,
        (m) => m.text.includes(nonce),
        {
          timeout: REPLY_TIMEOUT_MS,
          // "from the bot" — anyone but the driver account.
          senderFilter: { notUserId: sc.driverUserId },
        },
      );

      // The reply landed IN the supergroup, from the bot — not the DM.
      expect(reply.chatId).toBe(SUPERGROUP_ID);
      expect(reply.fromBot).toBe(true);
    } finally {
      await sc.tearDown();
    }
  }, REPLY_TIMEOUT_MS + 30_000);
});
