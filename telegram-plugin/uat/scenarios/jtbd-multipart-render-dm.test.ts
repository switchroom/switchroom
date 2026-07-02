/**
 * JTBD scenario — a reply too long for one rich message renders correctly
 * across BOTH chunks.
 *
 * Serves the same trust contract as `jtbd-rich-formatting-render-dm.test.ts`
 * (`reference/jobs/know-what-my-agent-is-doing.md`): what the agent posts must
 * render on the user's phone. That sibling proves single-message render
 * fidelity. THIS scenario proves the MULTI-PART path: when a reply exceeds the
 * Bot API 10.1 rich-message wire cap (`RICH_MESSAGE_MAX_CHARS` = 32768,
 * `telegram-plugin/format.ts`), the gateway splits it into ordered chunks
 * (`splitMarkdownChunks`) — and each chunk must still be a self-contained,
 * correctly-parsed rich message. A split that bisects a formatting construct
 * (an unterminated bold, a half-open code fence) produces a chunk Telegram
 * renders wrong; this closes that loop against Telegram's REAL renderer via
 * the mtcute driver, the same way the single-message scenario does.
 *
 * NOTE: switchroom has NO streaming-edit reply path — a long reply is sent as
 * discrete chunk messages, not progressive edits. This scenario asserts on
 * those discrete parts. It is deliberately NOT a streaming test.
 *
 * ## What it asserts
 *
 *   1. TWO distinct bot messages arrive (the reply chunked — not one).
 *   2. The FIRST part carries the head marker and renders a formatting entity
 *      (bold) — formatting survived in chunk 1.
 *   3. The LAST part carries the tail marker and renders a formatting entity
 *      (bold) — formatting survived across the split into chunk 2.
 *   4. Neither part decoded as the `\x01` unsupported-media sentinel.
 *
 * ## Self-skip
 *
 * Same gating as every scenario here: needs the driver session
 * (`TELEGRAM_UAT_DRIVER_SESSION`, gated to the CI uat-host). Self-skips green
 * when creds are absent; the `uat-gate` sentinel owns the real run.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";
import { RICH_MESSAGE_MAX_CHARS } from "../../format.js";

const AGENT = "test-harness";

const HAS_DRIVER_CREDS =
  (process.env.TELEGRAM_UAT_DRIVER_SESSION ?? "").length > 0 &&
  (process.env.TELEGRAM_API_HASH ?? "").length > 0 &&
  Number.isFinite(Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10)) &&
  (process.env.TELEGRAM_TEST_BOT_USERNAME ?? "").length > 0;

// Head + tail markers, uppercase+digit so a voice/dash scrub leaves them
// intact. HEAD must land in chunk 1, TAIL in the final chunk.
const HEAD = "MULTIHEAD3";
const TAIL = "MULTITAIL9";

// We need the composed reply to exceed the 32768-char cap so the gateway
// chunks it. Asking a model to emit ~40k literal chars is flaky (it'll
// summarize or truncate). Instead we ask it to REPEAT a fixed, cheap-to-
// generate padding block a deterministic number of times — a task an agent
// reliably obeys because it's mechanical, not generative.
const PAD_LINE = "The quick brown fox jumps over the lazy dog. ";
// Overshoot the cap by a comfortable margin so a slightly-short reply still
// splits: (cap / line) rounded up, times a 1.3 safety factor.
const REPEATS = Math.ceil((RICH_MESSAGE_MAX_CHARS / PAD_LINE.length) * 1.3);

const PROMPT = [
  `I need a LONG reply to test message chunking. Do EXACTLY this, nothing else:`,
  ``,
  `1. Start your reply with: ${HEAD}: **head bold marker**`,
  `2. Then output this exact sentence ${REPEATS} times, each on its own line:`,
  `   "${PAD_LINE.trim()}"`,
  `3. End your reply with: ${TAIL}: **tail bold marker**`,
  ``,
  `Do not summarize or shorten. Emit all ${REPEATS} repetitions verbatim.`,
].join("\n");

function kinds(msg: ObservedMessage): Set<string> {
  return new Set(msg.entities.map((e) => e.kind));
}

(HAS_DRIVER_CREDS ? describe : describe.skip)(
  "uat: a long reply chunks over the wire cap and both parts render",
  () => {
    it(
      "first + last chunk each decode to real text with formatting intact",
      async () => {
        const sc = await spinUp({ agent: AGENT });
        try {
          await sc.sendDM(PROMPT);

          // Chunk 1: the part carrying the HEAD marker.
          const first = await sc.expectMessage(
            (m: ObservedMessage) => m.text.includes(HEAD) || m.text === "\x01",
            { from: "bot", timeout: 120_000 },
          );
          // Chunk 2 (final): the part carrying the TAIL marker. This is a
          // DIFFERENT message than `first` — if the reply hadn't chunked,
          // TAIL would be in the same message and this poll would time out,
          // failing loudly (which is the correct signal: no split happened).
          const last = await sc.expectMessage(
            (m: ObservedMessage) =>
              (m.text.includes(TAIL) || m.text === "\x01") &&
              m.messageId !== first.messageId,
            { from: "bot", timeout: 120_000 },
          );

          // (4) Neither part is the unsupported-media sentinel.
          expect(
            first.text,
            "first chunk decoded as \\x01 sentinel — rich decode failed",
          ).not.toBe("\x01");
          expect(
            last.text,
            "last chunk decoded as \\x01 sentinel — rich decode failed",
          ).not.toBe("\x01");

          // (1) They are genuinely two distinct messages.
          expect(
            last.messageId,
            "TAIL marker landed in the SAME message as HEAD — the reply did " +
              "not chunk (was it under the 32768-char cap?)",
          ).not.toBe(first.messageId);

          // (2) Head marker + a bold entity present in chunk 1.
          expect(first.text).toContain(HEAD);
          expect(
            kinds(first).has("bold"),
            "no bold entity in the first chunk — formatting stripped on the " +
              "wire for chunk 1",
          ).toBe(true);

          // (3) Tail marker + a bold entity present in the final chunk — the
          // load-bearing assertion: formatting survived the split boundary.
          expect(last.text).toContain(TAIL);
          expect(
            kinds(last).has("bold"),
            "no bold entity in the last chunk — a split boundary corrupted " +
              "the formatting of chunk 2",
          ).toBe(true);

          console.info(
            `[uat] multipart render: first msg=${first.messageId} ` +
              `(${first.text.length} chars, kinds=${[...kinds(first)].join(",")}) ` +
              `last msg=${last.messageId} ` +
              `(${last.text.length} chars, kinds=${[...kinds(last)].join(",")})`,
          );
        } finally {
          await sc.tearDown();
        }
      },
      180_000,
    );
  },
);
