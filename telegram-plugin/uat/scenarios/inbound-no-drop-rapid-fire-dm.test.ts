/**
 * E2E regression — inbound is NEVER dropped under rapid fire (the drop-wedge).
 *
 * The bug: a Telegram inbound reaches claude as an MCP channel notification
 * the unmodified CLI appends to its composer and auto-submits only when the
 * composer is empty + idle. A message arriving the instant the prior turn
 * completes races that auto-submit and strands unsubmitted — claude never
 * starts the turn, the gateway sits "typing…", and the 300s silence-poke
 * DROPS the message. Observed recurring on `marko` (supergroup topics + DMs).
 *
 * This scenario drives the exact failure timing: it fires each message the
 * instant the prior reply lands (i.e. right at turn-completion, the strand
 * window) and asserts EVERY message gets its own unique token back. With the
 * deliver-until-acked queue (inbound-delivery-confirm.ts) a strand self-heals
 * via re-delivery; without it, a stranded message yields NO reply within the
 * timeout and this test fails on exactly the message that was swallowed.
 *
 * Each message carries a random token and the assertion matches THAT token,
 * so a reply to message N-1 can never be mistaken for message N's reply — the
 * test proves every distinct message was actually processed, not merely that
 * "some replies came back".
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

describe("uat: rapid-fire inbound — no message is ever dropped (drop-wedge)", () => {
  it(
    "every back-to-back message gets its own reply (delivery never strands)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const N = 8;
        const dropped: number[] = [];
        for (let i = 1; i <= N; i++) {
          const token = `acktok-${i}-${Math.random().toString(36).slice(2, 8)}`;
          await sc.sendDM(
            `Reply with exactly this token and nothing else: ${token}`,
          );
          try {
            const reply = await sc.expectMessage((m) => m.text.includes(token), {
              from: "bot",
              timeout: 75_000,
            });
            expect(reply.text).toContain(token);
          } catch {
            // The message stranded — no reply carrying its token arrived.
            dropped.push(i);
          }
          // Deliberately NO delay: fire the next message the instant this
          // reply lands, so it arrives in the turn-completion strand window.
        }
        expect(
          dropped,
          `messages dropped (no reply within timeout): ${dropped.join(", ")} of ${N}`,
        ).toEqual([]);
      } finally {
        await sc.tearDown();
      }
    },
    // N messages × (turn + up to one ~15-20s strand recovery) — generous.
    900_000,
  );
});
