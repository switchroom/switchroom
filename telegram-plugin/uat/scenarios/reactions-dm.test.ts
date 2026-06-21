/**
 * Reaction lifecycle scenario — driver DMs the test bot, bot reacts
 * to the inbound message through the lifecycle and lands a terminal
 * emoji once the reply ships.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 * Goal context: cause class CC-1 / CC-6 in
 * `docs/status-ask-cause-classes.md` (the L1 ambient layer should
 * deliver a definitively-done terminal emoji within a few seconds
 * of the bot's final reply — otherwise the user looks at their
 * inbound, sees it still wearing 🤔, and asks "you done?").
 *
 * What we assert (in priority order):
 *
 *  1. Within the turn, the bot places AT LEAST ONE reaction on the
 *     inbound message (the L1 "I'm alive" signal). We poll via
 *     `driver.pollReactions()` rather than subscribing to push
 *     events — Telegram does not deliver `updateMessageReactions`
 *     push events to the human account when a bot sets a reaction
 *     in a DM (fixes #2502).
 *  2. By the time the bot has sent a final reply (+ a short tail
 *     for Telegram to apply the terminal-emoji replace), the reaction
 *     on the inbound message is in the `done` set (`👍 / 💯 / 🎉`).
 *
 * Polling strategy:
 *   - Poll every `POLL_INTERVAL_MS` until a terminal-done emoji
 *     appears OR the bot has replied AND `TAIL_AFTER_REPLY_MS` has
 *     elapsed. Bail immediately on reply-timeout so CI doesn't burn
 *     the full 90s safety ceiling.
 *   - After the reply arrives, keep polling through the tail window
 *     so the terminal emoji (👍) has time to replace the working
 *     emoji (👀/🤔). In practice the replace happens within 1-2s
 *     of the reply on a healthy bot; the 8s ceiling absorbs jitter.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const TERMINAL_DONE_EMOJI = new Set(["👍", "💯", "🎉"]);
const POLL_INTERVAL_MS = 1_000;
const TAIL_AFTER_REPLY_MS = 8_000;

const INBOUND = (): string => `uat-reactions ${new Date().toISOString()}`;

describe("uat: reaction lifecycle on driver DM", () => {
  it(
    "driver sees an alive reaction, then a terminal-done emoji by reply tail",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const sent = await sc.sendDM(INBOUND());

        // Poll the reaction state on the sent message. We use polling
        // rather than `observeReactions` because Telegram does not
        // deliver `updateMessageReactions` push updates to user accounts
        // when a bot sets a reaction in a DM — see module docblock.
        const reactionHistory: string[][] = [];
        let replyReceived = false;
        let replyReceivedAt = 0;

        // Wait for the bot's reply (any content). We start polling
        // concurrently so we capture intermediate reactions during
        // the turn.
        let replyTimedOut = false;
        const replyPromise = sc
          .expectMessage(/\S/, { from: "bot", timeout: 60_000 })
          .then((reply) => {
            expect(reply.text.length).toBeGreaterThan(0);
            replyReceived = true;
            replyReceivedAt = Date.now();
            return reply;
          })
          .catch((err: unknown) => {
            // expectMessage timeout → mark so the poll loop exits immediately
            // instead of burning the full 90s safety ceiling on CI failure.
            replyTimedOut = true;
            throw err;
          });

        // Polling loop: sample reactions while waiting for the reply,
        // then continue for TAIL_AFTER_REPLY_MS after the reply lands.
        const poll = async (): Promise<void> => {
          const deadline = Date.now() + 90_000; // safety ceiling
          while (Date.now() < deadline) {
            // Bail early if the reply timed out — no point polling further.
            if (replyTimedOut) break;
            const emojis = await sc.driver.pollReactions(
              sc.botUserId,
              sent.messageId,
            );
            if (emojis.length > 0) {
              reactionHistory.push([...emojis]);
            }
            if (
              replyReceived &&
              Date.now() - replyReceivedAt >= TAIL_AFTER_REPLY_MS
            ) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        };

        // Run both concurrently; wait for both to settle.
        await Promise.all([replyPromise, poll()]);

        // L1 alive signal: at least one non-empty reaction set was
        // observed during the turn.
        const allSeen = reactionHistory.flat();
        const uniqueSeen = [...new Set(allSeen)];
        expect(
          reactionHistory.length,
          `expected at least one reaction poll to show a reaction during the ` +
            `turn, but all ${reactionHistory.length > 0 ? "polls returned nothing with emojis" : "polls returned empty"}. ` +
            `History snapshots: ${reactionHistory.map((s) => `[${s.join(",")}]`).join(" ") || "(none)"}`,
        ).toBeGreaterThan(0);

        // L1 terminal: the LAST non-empty snapshot should contain a
        // terminal-done emoji. `setMessageReaction` replaces atomically,
        // so the last snapshot holds whatever is currently on the message.
        const lastSnapshot = reactionHistory[reactionHistory.length - 1];
        // The bot uses setMessageReaction (replace, not append) — exactly one
        // emoji should be set at any time. Assert the invariant so we catch
        // accidental multi-emoji states, then check the terminal-done value.
        expect(
          lastSnapshot.length,
          `expected exactly 1 reaction in the final snapshot, got [${lastSnapshot.join(",")}]. ` +
            `All snapshots: ${reactionHistory.map((s) => `[${s.join(",")}]`).join(" ")}`,
        ).toBe(1);
        const lastEmoji = lastSnapshot[0];
        expect(
          TERMINAL_DONE_EMOJI.has(lastEmoji),
          `expected last reaction to be one of ${[
            ...TERMINAL_DONE_EMOJI,
          ].join(", ")}, got ${lastEmoji}. ` +
            `All snapshots: ${reactionHistory.map((s) => `[${s.join(",")}]`).join(" ")}. ` +
            `Unique emojis seen: ${uniqueSeen.join(", ") || "(none)"}`,
        ).toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    90_000,
  );
});
