/**
 * Wire-level regression test for the chunk-boundary cap bug
 * (fix/rich-render-chunk-boundary-cap).
 *
 * With `SWITCHROOM_RICH_RENDER` on, a near-cap body full of escapable chars
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
import { describe, it, expect, afterEach } from "vitest";
import { createStreamController } from "../stream-controller.js";
import { createFakeBotApi } from "./fake-bot-api.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";

const PLAIN_CAP = 4096; // Telegram's legacy plain-text sendMessage cap (format.ts:29).

function fenceCount(s: string): number {
  return (s.match(/^```/gm) ?? []).length;
}

describe("stream-controller enforces the wire cap on the post-escape body", () => {
  afterEach(() => {
    delete process.env.SWITCHROOM_RICH_RENDER;
  });

  it("REGRESSION: near-cap escapable first send never exceeds the plain wire cap", async () => {
    process.env.SWITCHROOM_RICH_RENDER = "1";
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

  it("flag OFF leaves the single-send path untouched", async () => {
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
  });
});
