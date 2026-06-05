/**
 * Cross-surface ordering stress — a DM question and a supergroup question
 * back-to-back, assert each answer lands in ITS OWN surface (DM answer in the
 * DM, channel answer in the channel) with no cross-contamination.
 *
 * One Claude CLI serves both the DM and the supergroup through a singleton
 * currentTurn; a late or mis-attributed reply can leak across surfaces (a DM
 * answer posted into the channel, or vice versa) — the cross-surface twin of
 * the multi-topic bleed. This is the "handling messages in multiple channels"
 * concern at the DM-vs-channel axis. Self-skips green without a resolvable
 * SWITCHROOM_UAT_CHAT_ID supergroup (uat/** is non-gating).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spinUp, type Scenario } from "../harness.js";
import { isWorkerFeedMessage, isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

interface Hit { chatId: number; text: string; messageId: number; }

function isAnswer(m: ObservedMessage, driverUserId: number): boolean {
  return m.senderUserId !== driverUserId && !m.edited
    && !isWorkerFeedMessage(m) && !isActivityFeedMessage(m) && m.text.trim().length > 0;
}

describe("uat: cross-surface ordering — DM Q + channel Q, no surface bleed", () => {
  let sc: Scenario | null = null;
  let postable = false;

  beforeAll(async () => {
    if (!Number.isFinite(SUPERGROUP_ID)) {
      console.warn("[uat] SWITCHROOM_UAT_CHAT_ID unset — skipping cross-surface ordering");
      return;
    }
    sc = await spinUp({ agent: "test-harness" });
    await sc.driver.primeDialogs();
    postable = await sc.driver.canResolve(SUPERGROUP_ID);
    if (!postable) console.warn(`[uat] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
  });

  it("DM answer stays in the DM and channel answer stays in the channel (no leak)", async () => {
    if (sc == null || !postable) return; // self-skip green
    const { driver, driverUserId, botUserId } = sc;
    await driver.primeDialogs();

    const dmIter = driver.observeMessages(botUserId)[Symbol.asyncIterator]();
    const sgIter = driver.observeMessages(SUPERGROUP_ID)[Symbol.asyncIterator]();

    // Distinct answers per surface: DM → 14, channel → 42.
    await driver.sendText(botUserId, "Reply with only the number and nothing else: what is 7 + 7?");
    await driver.sendText(SUPERGROUP_ID, "Reply with only the number and nothing else: what is 40 + 2?");

    let dmHit: Hit | undefined;
    let sgHit: Hit | undefined;
    const strays: Hit[] = []; // an expected-answer token observed in the WRONG surface

    const deadline = Date.now() + 120_000;
    const pump = async (iter: AsyncIterator<ObservedMessage>, chatId: number) => {
      while (Date.now() < deadline && !(dmHit && sgHit)) {
        const next = await Promise.race([
          iter.next(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
          ),
        ]);
        if (next.done || next.value == null) break;
        const m = next.value as ObservedMessage;
        if (!isAnswer(m, driverUserId)) continue;
        const hit: Hit = { chatId: m.chatId, text: m.text, messageId: m.messageId };
        const has14 = /(^|\D)14(\D|$)/.test(m.text);
        const has42 = /(^|\D)42(\D|$)/.test(m.text);
        if (chatId === botUserId) {
          if (has14 && dmHit == null) dmHit = hit;
          if (has42) strays.push(hit); // channel answer leaked into the DM
        } else {
          if (has42 && sgHit == null) sgHit = hit;
          if (has14) strays.push(hit); // DM answer leaked into the channel
        }
      }
    };
    await Promise.all([pump(dmIter, botUserId), pump(sgIter, SUPERGROUP_ID)]);
    void dmIter.return?.();
    void sgIter.return?.();

    console.log(
      `[cross-surface] dm(7+7=14)=${dmHit ? `msg=${dmHit.messageId}` : "MISSING"} ` +
        `channel(40+2=42)=${sgHit ? `msg=${sgHit.messageId}` : "MISSING"} strays=${strays.length}`,
    );

    // Invariant 1: both answered.
    expect(dmHit, "DM question (7+7=14) was never answered in the DM").toBeDefined();
    expect(sgHit, "channel question (40+2=42) was never answered in the channel").toBeDefined();
    // Invariant 2: no answer leaked to the wrong surface.
    expect(strays, `an answer leaked across surfaces: ${JSON.stringify(strays)}`).toHaveLength(0);
    // Invariant 3 (belt+braces): the right answer is in the right chat.
    expect(dmHit!.chatId).toBe(botUserId);
    expect(sgHit!.chatId).toBe(SUPERGROUP_ID);
  }, 150_000);
});
