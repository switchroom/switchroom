/**
 * Wire-level regression test for the chunk-boundary cap bug
 * (fix/rich-render-chunk-boundary-cap).
 *
 * With the rich renderer enabled (the default — escape hatch, not opt-in), a
 * near-cap body full of escapable chars
 * (`_ * |`) makes `renderSafe` degrade the whole document to plain (its escaped
 * rich form exceeds RICH_MESSAGE_MAX_CHARS). BEFORE the fix, the stream
 * controller shipped that ~32k plain body through the plain `sendMessage`
 * endpoint in ONE call — Telegram's plain endpoint caps at 4096, so the send
 * is rejected (`message is too long`) and the streamed answer is dropped.
 *
 * AFTER the fix, `renderOutboundChunks` re-splits at safe boundaries so every
 * emitted send fits its own wire cap: rich pieces <= 32768, plain pieces
 * <= 4096, and no fenced block is bisected.
 */
import { describe, it, expect } from "vitest";
import { createStreamController } from "../stream-controller.js";
import { createFakeBotApi } from "./fake-bot-api.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";

const PLAIN_CAP = 4096; // Telegram's legacy plain-text sendMessage cap (format.ts:29).

function fenceCount(s: string): number {
  return (s.match(/^```/gm) ?? []).length;
}

describe("stream-controller enforces the wire cap on the post-escape body", () => {
  it("REGRESSION: near-cap escapable first send never exceeds the plain wire cap", async () => {
    const bot = createFakeBotApi({ startMessageId: 1000 });
    const unit = "a_b*c|d ";
    const body = unit.repeat(Math.floor((RICH_MESSAGE_MAX_CHARS - 20) / unit.length));

    const stream = createStreamController({
      bot: bot as unknown as Parameters<typeof createStreamController>[0]["bot"],
      chatId: "c1",
      throttleMs: 0,
    });
    await stream.update(body);
    await stream.finalize();

    expect(bot.state.sent.length).toBeGreaterThan(0);
    for (const s of bot.state.sent) {
      // Every send fits the rich cap...
      expect(s.text.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS);
      // ...and a PLAIN send (rich !== true) additionally fits the 4096 plain
      // endpoint cap — the invariant HEAD violated (one ~32k plain send).
      if (!s.rich) expect(s.text.length).toBeLessThanOrEqual(PLAIN_CAP);
      // No send bisects a fenced block.
      expect(fenceCount(s.text) % 2).toBe(0);
    }
  }, 30000);

  it("BLOCKER: multi-update oversize stream emits tails ONCE, not per edit tick", async () => {
    // Reproduces the duplicate-flood blocker: an oversize body splits into N
    // pieces. The FIRST flush (send path) emits the anchor + (N-1) tail
    // messages. Every SUBSEQUENT throttled flush routes through the EDIT
    // callback. The pre-fix code re-sent all (N-1) tails as brand-new messages
    // on each edit tick, so `sent.length` grew by (N-1) every update. After the
    // fix, tails are parked once and edited in place — `sent.length` is flat.
    const bot = createFakeBotApi({ startMessageId: 3000 });
    const unit = "a_b*c|d ";
    // Near-cap body that degrades to plain and splits into several pieces.
    const base = unit.repeat(Math.floor((RICH_MESSAGE_MAX_CHARS - 20) / unit.length));
    // Distinct short prefix per flush so the HEAD piece actually changes —
    // an unchanged head yields a not-modified edit, which short-circuits before
    // the tail loop and would hide the duplicate-resend bug.
    const bodyFor = (i: number) => `v${i} ${base}`;

    const stream = createStreamController({
      bot: bot as unknown as Parameters<typeof createStreamController>[0]["bot"],
      chatId: "c1",
      throttleMs: 0,
    });

    // First flush → send path: anchor + tails, emitted exactly once.
    await stream.update(bodyFor(1));
    const afterFirst = bot.state.sent.length;
    expect(afterFirst).toBeGreaterThan(1); // genuinely multi-piece

    // Drive several more oversize updates — each routes through the EDIT
    // callback. The count must NOT grow: tails are edited in place, not resent.
    await stream.update(bodyFor(2));
    expect(bot.state.sent.length).toBe(afterFirst);
    await stream.update(bodyFor(3));
    expect(bot.state.sent.length).toBe(afterFirst);
    await stream.update(bodyFor(4));
    expect(bot.state.sent.length).toBe(afterFirst);
    await stream.finalize();

    // Final: exactly the anchor + tail set, no duplicates across the lifetime.
    expect(bot.state.sent.length).toBe(afterFirst);
    const ids = bot.state.sent.map((s) => s.message_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate message ids

    // Every currently-visible message fits its wire cap and (for plain) 4096.
    for (const s of bot.state.sent) {
      const cur = bot.textOf(s.message_id) ?? "";
      expect(cur.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS);
      if (!s.rich) expect(cur.length).toBeLessThanOrEqual(PLAIN_CAP);
    }
  }, 30000);

  it("kill-switch (=0) leaves the single-send path byte-for-byte untouched", async () => {
    process.env.SWITCHROOM_RICH_RENDER = "0";
    try {
      const bot = createFakeBotApi({ startMessageId: 2000 });
      const stream = createStreamController({
        bot: bot as unknown as Parameters<typeof createStreamController>[0]["bot"],
        chatId: "c1",
        throttleMs: 0,
      });
      await stream.update("**hi** _there_");
      await stream.finalize();
      expect(bot.state.sent).toHaveLength(1);
      expect(bot.state.sent[0].rich).toBe(true);
      expect(bot.state.sent[0].text).toBe("**hi** _there_");
    } finally {
      delete process.env.SWITCHROOM_RICH_RENDER;
    }
  });
});
