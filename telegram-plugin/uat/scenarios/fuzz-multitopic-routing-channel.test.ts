/**
 * Multi-topic routing stress (channel) — two questions in TWO forum topics
 * back-to-back, assert each answer lands in ITS OWN topic with no cross-bleed.
 *
 * This exercises live the failure class behind #2137 ("two questions in two
 * forum topics → both answers in one topic, the other unanswered") and the
 * #2166 late-reply topic recovery — the exact "handling messages in multiple
 * channels" concern. One Claude CLI owns every topic via a singleton
 * currentTurn, so a late/misrouted reply can land in the wrong topic.
 *
 * The test supergroup has General (message_thread_id omitted → observed
 * threadId undefined) plus a real topic (thread=5). mtcute sends into a topic
 * via messageThreadId→replyTo and reads each observed message's threadId, so we
 * can prove WHICH topic each answer landed in. Self-skips green without
 * SWITCHROOM_UAT_CHAT_ID or an unresolvable supergroup (uat/** is non-gating).
 *
 * mtcute caveat: it can't enumerate topics, so the topic id is pinned (5, the
 * active non-General topic in the test supergroup). If that topic is ever
 * deleted the send 400s and the test skips with a clear message.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spinUp, type Scenario } from "../harness.js";
import { isWorkerFeedMessage, isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);
const TOPIC_THREAD = 5; // a real non-General topic in the test supergroup

interface Hit {
  text: string;
  threadId: number | undefined;
  messageId: number;
  at: number;
}

describe("uat: multi-topic routing — two topics back-to-back, no answer bleed", () => {
  let sc: Scenario | null = null;
  let postable = false;

  beforeAll(async () => {
    if (!Number.isFinite(SUPERGROUP_ID)) {
      console.warn("[uat] SWITCHROOM_UAT_CHAT_ID unset — skipping multi-topic routing");
      return;
    }
    sc = await spinUp({ agent: "test-harness" });
    await sc.driver.primeDialogs();
    postable = await sc.driver.canResolve(SUPERGROUP_ID);
    if (!postable) console.warn(`[uat] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
  });

  it("topic-5 Q and General Q are each answered IN THEIR OWN topic (no swap, no drop)", async () => {
    if (sc == null || !postable) return; // self-skip green
    const driver = sc.driver;
    const driverUserId = sc.driverUserId;
    await driver.primeDialogs();

    // Distinct, unambiguous answers so we can tell the two replies apart by
    // content and check the topic each landed in. 7+7=14 (topic 5), 40+2=42
    // (General) — no digit overlap, no accidental substring match.
    const iter = driver.observeMessages(SUPERGROUP_ID)[Symbol.asyncIterator]();
    let topic5: Hit | undefined;
    let general: Hit | undefined;

    try {
      await driver.sendText(
        SUPERGROUP_ID,
        "Reply with only the number and nothing else: what is 7 + 7?",
        { messageThreadId: TOPIC_THREAD },
      );
    } catch (err) {
      console.warn(`[uat] could not post to topic ${TOPIC_THREAD} (${(err as Error).message}) — skipping`);
      return;
    }
    // Back-to-back (the #2137 bleed trigger): General question immediately after.
    await driver.sendText(
      SUPERGROUP_ID,
      "Reply with only the number and nothing else: what is 40 + 2?",
    );

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !(topic5 && general)) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (next.done || next.value == null) break;
      const m = next.value as ObservedMessage;
      if (m.senderUserId === driverUserId) continue; // our own sends
      if (isWorkerFeedMessage(m) || isActivityFeedMessage(m)) continue; // status surfaces, not answers
      const hit: Hit = { text: m.text, threadId: m.threadId, messageId: m.messageId, at: Date.now() };
      if (topic5 == null && /(^|\D)14(\D|$)/.test(m.text)) topic5 = hit;
      if (general == null && /(^|\D)42(\D|$)/.test(m.text)) general = hit;
    }
    void iter.return?.();

    console.log(
      `[multitopic] topic5(7+7=14)=${topic5 ? `thread=${topic5.threadId ?? "-"} msg=${topic5.messageId}` : "MISSING"} ` +
        `general(40+2=42)=${general ? `thread=${general.threadId ?? "-"} msg=${general.messageId}` : "MISSING"}`,
    );

    // Invariant 1: BOTH questions were answered (no drop — the #2137 "other
    // topic unanswered" half).
    expect(topic5, "topic-5 question (7+7=14) was never answered").toBeDefined();
    expect(general, "General question (40+2=42) was never answered").toBeDefined();

    // Invariant 2: each answer landed in ITS OWN topic (no bleed/swap). The
    // topic-5 answer carries threadId=5; the General answer omits the thread.
    expect(topic5!.threadId).toBe(TOPIC_THREAD);
    expect(general!.threadId).toBeUndefined();
  }, 150_000);

  it("a SLOW topic-5 turn whose answer lands LATE (after a fast General turn) still routes to topic-5", async () => {
    if (sc == null || !postable) return; // self-skip green
    const { driver, driverUserId } = sc;
    await driver.primeDialogs();

    // The #2137 trigger: topic-5 turn is still working when General's turn
    // arrives, so the singleton currentTurn flips to General. The slow topic-5
    // answer then lands AFTER General's — it must STILL route to topic-5 (via
    // origin_turn_id / the #2166 late-reply recovery), not bleed into General.
    const iter = driver.observeMessages(SUPERGROUP_ID)[Symbol.asyncIterator]();
    let slowHit: Hit | undefined; // topic-5, distinctive token
    let fastHit: Hit | undefined; // General, the number 42

    try {
      await driver.sendText(
        SUPERGROUP_ID,
        "Do this slowly, ONE step at a time with a brief note on each (I want to see you work): run uname -a, then nproc, " +
          "then lscpu, then cat /proc/cpuinfo | grep -c processor, then free -h, then df -h. After all six, tell me how many " +
          "CPU cores this machine has and end your reply with the exact token CORESDONE on its own line.",
        { messageThreadId: TOPIC_THREAD },
      );
    } catch (err) {
      console.warn(`[uat] could not post to topic ${TOPIC_THREAD} (${(err as Error).message}) — skipping`);
      return;
    }
    // Let the slow turn get underway, then fire the fast General question while
    // it's still working. Use an unusual WORD token (not a number) so the slow
    // turn's tool output (which prints numbers like "42Gi") can't false-match.
    await new Promise((r) => setTimeout(r, 3000));
    await driver.sendText(SUPERGROUP_ID, "Reply with only this exact word and nothing else: ZUCCHINI.");

    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline && !(slowHit && fastHit)) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (next.done || next.value == null) break;
      const m = next.value as ObservedMessage;
      if (m.senderUserId === driverUserId) continue;
      if (isWorkerFeedMessage(m) || isActivityFeedMessage(m)) continue;
      const hit: Hit = { text: m.text, threadId: m.threadId, messageId: m.messageId, at: Date.now() };
      if (slowHit == null && /CORESDONE/i.test(m.text)) slowHit = hit;
      if (fastHit == null && /ZUCCHINI/i.test(m.text)) fastHit = hit;
    }
    void iter.return?.();

    console.log(
      `[multitopic-late] slow(CORESDONE)=${slowHit ? `thread=${slowHit.threadId ?? "-"} msg=${slowHit.messageId}` : "MISSING"} ` +
        `fast(ZUCCHINI)=${fastHit ? `thread=${fastHit.threadId ?? "-"} msg=${fastHit.messageId}` : "MISSING"} ` +
        `slowArrivedAfterFast=${slowHit && fastHit ? slowHit.at > fastHit.at : "n/a"}`,
    );

    expect(slowHit, "slow topic-5 answer (CORESDONE) never arrived").toBeDefined();
    expect(fastHit, "fast General answer (42) never arrived").toBeDefined();
    // Honest about whether the LATE-after-flip stress was actually exercised:
    // it only is if the slow topic-5 answer landed AFTER the fast General one.
    if (slowHit!.at <= fastHit!.at) {
      console.warn(
        "[multitopic-late] topic-5 answered BEFORE General — the late-after-flip case " +
          "was not exercised this run (routing still asserted below).",
      );
    }
    // The crux: the slow answer routed to topic-5, NOT bled into General — and
    // this holds whether or not it arrived late (the stronger claim is when late).
    expect(slowHit!.threadId).toBe(TOPIC_THREAD);
    expect(fastHit!.threadId).toBeUndefined();
  }, 160_000);
});
