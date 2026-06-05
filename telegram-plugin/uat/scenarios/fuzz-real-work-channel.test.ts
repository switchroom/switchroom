/**
 * Real-work UAT (channel) — the DM real-work suite, in a forum supergroup.
 * Proves the status surface (activity/worker feed) AND the answer land IN the
 * channel under genuine work — not leaked to the owner DM — and that a late
 * reply after a long tool turn doesn't escape the channel. Self-skips green when
 * SWITCHROOM_UAT_CHAT_ID is unset or the chat isn't a resolvable supergroup.
 *
 * mtcute has no forum-topic API, so this uses the supergroup's General topic: it
 * proves DM-vs-channel routing, not correct-topic-among-many (the gateway unit
 * thread-assertions pin that). See real-work-prompts.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spinUp, type Scenario } from "../harness.js";
import {
  REAL_WORK_CASES,
  collectTurn,
  analyzeTurn,
  summarizeTurn,
} from "../real-work-prompts.js";

const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

describe("uat: real-work channel — status + answer land in the supergroup", () => {
  let sc: Scenario | null = null;
  let postable = false;

  beforeAll(async () => {
    if (!Number.isFinite(SUPERGROUP_ID)) {
      console.warn("[uat] SWITCHROOM_UAT_CHAT_ID unset — skipping real-work channel suite");
      return;
    }
    sc = await spinUp({ agent: "test-harness" });
    await sc.driver.primeDialogs();
    postable = await sc.driver.canResolve(SUPERGROUP_ID);
    if (!postable) {
      console.warn(`[uat] supergroup ${SUPERGROUP_ID} not resolvable — skipping real-work channel suite`);
    }
  });

  for (const fc of REAL_WORK_CASES) {
    it(
      `[real-work-sg] ${fc.name} (${fc.kind}) — answer + surface land in the channel`,
      async () => {
        if (sc == null || !postable) return; // self-skip green
        await sc.driver.primeDialogs();
        const obs = await collectTurn(
          sc.driver,
          SUPERGROUP_ID,
          sc.driverUserId,
          fc.prompt,
          { timeoutMs: fc.timeoutMs, minAnswerChars: fc.minAnswerChars },
        );
        console.log(summarizeTurn(`sg:${fc.name}`, obs));
        if (obs.answer != null) {
          console.log(
            `[real-work-sg] ${fc.name} answer: ${JSON.stringify(obs.answer.text.slice(0, 180))}`,
          );
        }

        const { violations, warnings } = analyzeTurn(obs, {
          requireSurface: fc.requireSurface,
          chatId: SUPERGROUP_ID, // wrong-surface detector = leaked out of the channel
        });
        for (const w of warnings) {
          console.warn(`[real-work-sg] ${fc.name}: WARN ${w.code}: ${w.detail}`);
        }
        if (violations.length > 0) {
          throw new Error(
            `[real-work-sg] ${fc.name}: ${violations.length} invariant violation(s):\n` +
              violations.map((x) => `  - ${x.code}: ${x.detail}`).join("\n"),
          );
        }
        // Every observed bot message must be in the channel (the routing proof).
        for (const m of [...obs.botMessages, ...obs.edits]) {
          expect(m.chatId).toBe(SUPERGROUP_ID);
        }
        expect(obs.answer).not.toBeNull();
      },
      fc.timeoutMs + 45_000,
    );
  }
});
