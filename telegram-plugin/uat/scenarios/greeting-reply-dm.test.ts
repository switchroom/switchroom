/**
 * Greeting reply scenario — driver DMs the test bot a bare "hi", bot
 * MUST reply (not NO_REPLY).
 *
 * Regression gate for the v0.13.61 turn-pacing v3 over-correction: the
 * "don't ack" directive made the model classify a bare greeting as
 * "not substantive" and end the turn with NO_REPLY, leaving the user
 * staring at silence. v4 (this fix) re-asserts "always reply to a
 * direct message; a greeting gets a greeting."
 *
 * Runs against real Telegram. Same env requirements as
 * smoke-dm-reply.test.ts. Invoke via `bun run test:uat greeting`.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

describe("uat: greeting gets a reply (v4 turn-pacing regression gate)", () => {
  it(
    "driver DMs a bare 'hi' and the bot replies within 60s (not NO_REPLY)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });

      try {
        const started = Date.now();
        await sc.sendDM("hi");

        // A greeting should come back fast — well under the silence-poke
        // soft window. 60s budget tolerates a cold turn but a NO_REPLY
        // (the bug) would blow past it via the 300s framework fallback.
        const reply = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 60_000,
        });
        const elapsed = Date.now() - started;

        expect(reply.text.length).toBeGreaterThan(0);
        expect(reply.senderUserId).toBe(sc.botUserId);
        // The bug path replies only after the 300s framework fallback.
        // A real greeting reply lands fast; assert it beat the fallback.
        expect(elapsed).toBeLessThan(60_000);
      } finally {
        await sc.tearDown();
      }
    },
    90_000,
  );
});
