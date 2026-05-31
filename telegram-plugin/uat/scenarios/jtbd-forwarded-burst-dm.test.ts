/**
 * JTBD scenario — forwarded burst / split paste coalesces into ONE turn.
 *
 * Serves: `reference/steer-or-queue-mid-flight.md` — the "Forwarded
 * burst / split paste" UAT prompt. When several messages land in quick
 * succession from the same sender (a forward of 3-4 messages, or a long
 * paste Telegram split into chunks), inbound coalescing must merge them
 * into a SINGLE Claude turn with shared context — not reply to each
 * fragment in isolation.
 *
 * This is the end-to-end gate for the A1 coalescing work shipped in
 * v0.14.18 (#2007). The merge logic itself is covered by unit + fuzz
 * tests (`inbound-coalesce.test.ts`, `pending-inbound-buffer.test.ts`),
 * but only this scenario exercises the real inbound → gateway coalescer
 * → claude → outbound path over a live Telegram chat.
 *
 * ## How the signal is constructed
 *
 * Naively asking the agent to "combine facts from several messages"
 * does NOT distinguish coalesced from fanned-out: even when each
 * message becomes its own turn, every later turn carries the PRIOR
 * turns in its conversation history, so the model could still answer
 * from history. History bleed makes a content-combination assertion
 * useless as a coalescing probe.
 *
 * The distinguishing fact is whether a SINGLE turn saw all the parts in
 * ONE incoming message. So we anchor the instruction on "this single
 * message": three messages are fired near-simultaneously (so they land
 * inside the default 500ms coalesce window), each carrying a distinct
 * code token, and the instruction (in the last part) asks the agent to
 * echo every token it received *in this one incoming message*.
 *
 *   - Coalesced  → the merged turn's single message contains ALPHA,
 *     BRAVO and CHARLIE → the reply names all three.
 *   - Fanned out → the message carrying the instruction contains only
 *     its own token → the reply names just that one. (And the other
 *     two tokens arrive as their own separate turns.)
 *
 * Tokens are deliberately odd uppercase strings so a substring match is
 * unambiguous and won't collide with incidental words in the reply.
 *
 * Order-independence: the three sends are dispatched concurrently to
 * guarantee they share a coalesce window, which means Telegram may
 * deliver them in any order. We assert SET membership (all three
 * present), never order.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import { pollUntil } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";

// Distinctive code tokens — unlikely to appear incidentally in a reply.
const TOKENS = ["ALPHA", "BRAVO", "CHARLIE"] as const;

const BURST: string[] = [
  `BURST-PROBE part 1 of 3. Code token: ${TOKENS[0]}.`,
  `BURST-PROBE part 2 of 3. Code token: ${TOKENS[1]}.`,
  `BURST-PROBE part 3 of 3. Code token: ${TOKENS[2]}. ` +
    `Reply with ONLY the BURST-PROBE code tokens contained in THIS SINGLE ` +
    `incoming message, slash-separated. If this message contains just one ` +
    `token, reply with only that token.`,
];

// Generous budget: TTFO on the test-harness is ~7s warm; coalescing
// adds the (sub-second) window plus normal model latency.
const ANSWER_TIMEOUT_MS = 40_000;

function tokensIn(text: string): string[] {
  const upper = text.toUpperCase();
  return TOKENS.filter((t) => upper.includes(t));
}

describe("uat: forwarded burst / split paste coalesces into one turn", () => {
  it(
    "a 3-message burst is answered as ONE shared-context turn",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        // Start observing BEFORE the burst — observeMessages only sees
        // live updates, not history. Drain into a per-message-id map so
        // streamed edits collapse to the message's latest text.
        const latestById = new Map<number, ObservedMessage>();
        const stream = sc.driver.observeMessages(sc.botUserId);
        const consume = (async () => {
          for await (const m of stream) {
            if (m.senderUserId === sc.driverUserId) continue; // skip our own sends
            latestById.set(m.messageId, m);
          }
        })();

        // Fire all three concurrently so they share one coalesce window.
        // Concurrency (not serial awaits) is what keeps inter-arrival
        // under the 500ms default — three serial round-trips could blow
        // the window on a slow link.
        await Promise.all(BURST.map((t) => sc.sendDM(t)));

        // Wait until a single bot message names all three tokens — the
        // proof that one turn saw the whole burst in one incoming
        // message.
        const allThree = await pollUntil(
          () => {
            for (const m of latestById.values()) {
              if (tokensIn(m.text).length === TOKENS.length) return m;
            }
            return undefined;
          },
          { timeout: ANSWER_TIMEOUT_MS, interval: 500 },
        ).catch(() => undefined);

        // Close the observer stream.
        await stream[Symbol.asyncIterator]().return?.(undefined as never);
        await consume;

        const botMsgs = [...latestById.values()];
        const tokenBearing = botMsgs.filter((m) => tokensIn(m.text).length > 0);

        if (!allThree) {
          const seen = tokenBearing
            .map((m) => `#${m.messageId}=[${tokensIn(m.text).join(",")}]`)
            .join(" ");
          throw new Error(
            `[forwarded-burst] No single bot reply named all of ` +
              `${TOKENS.join("/")}. This is the coalescing regression: the ` +
              `burst fanned out into separate turns so no turn saw the full ` +
              `message. Token-bearing replies: ${seen || "(none)"}.`,
          );
        }

        expect(tokensIn(allThree.text).sort()).toEqual([...TOKENS].sort());

        // Forensic: a coalesced burst should produce ONE answer that
        // names the tokens. Several token-bearing replies hint at a
        // partial fan-out even though one of them happened to be
        // complete — worth a warning before it becomes a hard failure.
        if (tokenBearing.length > 1) {
          console.warn(
            `[forwarded-burst] ${tokenBearing.length} token-bearing replies ` +
              `observed (expected 1). Possible partial fan-out: ` +
              tokenBearing
                .map((m) => `#${m.messageId}=[${tokensIn(m.text).join(",")}]`)
                .join(" "),
          );
        } else {
          console.log(
            `[forwarded-burst] One shared-context reply named all tokens ` +
              `(#${allThree.messageId}). Coalescing healthy.`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    ANSWER_TIMEOUT_MS + 20_000,
  );
});
