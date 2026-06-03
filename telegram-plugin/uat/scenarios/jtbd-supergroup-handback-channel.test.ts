/**
 * JTBD scenario — background-worker HANDBACK lands in the supergroup (#2098).
 *
 * This is the live validation of the headline channel fix: when a background
 * sub-agent (Task/Agent `run_in_background:true`) dispatched from a supergroup
 * finishes, the agent's in-voice "here's what the worker found" handback (beat
 * 4) must land IN the supergroup — not the operator DM (the pre-#2098 bug,
 * where the synthesized handback inbound was thread-blind and the reply fell
 * back to the chat's last-seen topic / owner DM).
 *
 * Mechanism exercised: dispatch a bg worker that returns a unique token →
 * onFinish → buildSubagentHandbackInbound (now carrying the origin topic) →
 * the parent relays the token. We assert the token appears in a BOT message
 * IN the supergroup. Pre-#2098 that handback would not have been threaded to
 * the supergroup; post-#2098 it is.
 *
 * Best-effort + model-dependent: the agent must actually background the task
 * (not inline it) and relay the worker's token. The prompt is explicit. Self-
 * skips when no test supergroup is wired. Uses the General topic (mtcute here
 * has no forum-topic create API); topic-among-many routing is pinned by the
 * #2098 unit thread-assertions.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

/** Worker dispatch + run + onFinish + handback relay — generous budget. */
const HANDBACK_TIMEOUT_MS = 150_000;

describe("uat: supergroup background-worker handback (#2098)", () => {
  it("a dispatched background worker's result is handed back IN the supergroup", async () => {
    if (!Number.isFinite(SUPERGROUP_ID)) {
      console.warn("[uat] SWITCHROOM_UAT_CHAT_ID unset — skipping handback channel scenario");
      return;
    }
    const sc = await spinUp({ agent: AGENT, settleMs: 0 });
    try {
      await sc.driver.primeDialogs();
      if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
        console.warn(`[uat] supergroup ${SUPERGROUP_ID} not resolvable — skipping handback channel scenario`);
        return;
      }

      // Unique token the worker must echo back, so the handback relay is
      // unambiguous and can't latch onto unrelated chatter.
      const token = `HBK${Date.now().toString(36).toUpperCase()}`;
      await sc.driver.sendText(
        SUPERGROUP_ID,
        `Dispatch a BACKGROUND worker (a Task with run_in_background:true) that ` +
          `runs a shell sleep of about 8 seconds and then returns exactly the ` +
          `token ${token}. Do NOT do it inline — it must be a background Task so ` +
          `you can acknowledge first. Acknowledge now, and when the worker reports ` +
          `back, relay its token (${token}) here in this group.`,
      );

      // The handback relay — a bot message in the supergroup carrying the
      // worker's token. (The interim "on it" ack may arrive first; we wait
      // for the message that actually carries the token, which is the
      // post-handback relay.)
      const relay = await expectMessage(
        sc.driver,
        SUPERGROUP_ID,
        (m) => m.text.includes(token),
        { timeout: HANDBACK_TIMEOUT_MS, senderFilter: { notUserId: sc.driverUserId } },
      );

      expect(relay.chatId).toBe(SUPERGROUP_ID);
      expect(relay.fromBot).toBe(true);
    } finally {
      await sc.tearDown();
    }
  }, HANDBACK_TIMEOUT_MS + 30_000);
});
