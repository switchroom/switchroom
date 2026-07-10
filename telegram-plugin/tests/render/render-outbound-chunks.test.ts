/**
 * Regression tests for the chunk-boundary cap bug (fix/rich-render-chunk-boundary-cap).
 *
 * THE BUG: the outbound safe renderer (`renderSafe`) re-escapes GFM-special
 * characters, which GROWS a body. A raw chunk sized just under the wire cap can
 * escape PAST it. `renderSafe`'s only oversize recourse is to degrade the WHOLE
 * document to `mode:"plain"` (raw source, no rich wrapper) — it never re-splits
 * a multi-block body. The send path then ships that plain body through the
 * 4096-char plain `sendMessage` endpoint, so a ~32k plain body is rejected by
 * Telegram (`message is too long`) and the answer is dropped.
 *
 * `renderOutboundChunks` closes the gap: every returned piece fits its own wire
 * cap (rich `<= maxLen`, plain `<= plainMax`) and is cut only at
 * `splitMarkdownChunks`' safe boundaries (never bisecting a fence / table row).
 */
import { describe, it, expect } from "vitest";
import { renderOutboundChunks, PLAIN_TEXT_MAX_CHARS } from "../../render/rich-render.js";
import { RICH_MESSAGE_MAX_CHARS } from "../../format.js";

const ON = { SWITCHROOM_RICH_RENDER: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

/** Count fenced-code delimiter lines (```) in a body. A piece that bisects a
 *  fenced block has an ODD count. */
function fenceCount(s: string): number {
  return (s.match(/^```/gm) ?? []).length;
}

describe("renderOutboundChunks", () => {
  it("flag OFF is a single passthrough piece (byte-for-byte)", () => {
    const raw = "**bold** and _italic_ | a | table |";
    const pieces = renderOutboundChunks(raw, OFF);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].text).toBe(raw);
    expect(pieces[0].mode).toBe("markdown");
  });

  it("flag ON, body that fits is a single piece (common case)", () => {
    const pieces = renderOutboundChunks("just some plain prose", ON);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].text.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS);
  });

  it("REGRESSION: a near-cap escapable body splits into cap-respecting pieces", () => {
    // Prose whose escaping (`_ * |` each gain a leading `\`) grows it past the
    // cap. Use small caps so the test is fast; the invariant is cap-agnostic.
    const maxLen = 200;
    const plainMax = 80;
    const unit = "a_b*c|d ";
    const raw = unit.repeat(40); // 320 raw chars, ~1.5x after escaping
    const pieces = renderOutboundChunks(raw, ON, maxLen, plainMax);

    // The whole body did NOT fit as one message — it was re-split.
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      if (p.mode === "plain") {
        // A plain piece rides the plain `sendMessage` endpoint — must fit its cap.
        expect(p.text.length).toBeLessThanOrEqual(plainMax);
      } else {
        expect(p.text.length).toBeLessThanOrEqual(maxLen);
      }
    }
  });

  it("REGRESSION: never bisects a fenced code block when splitting", () => {
    const maxLen = 300;
    const plainMax = 250; // >= the fence size, so a fence never needs a hard slice.
    // A fenced block big enough that a naive length cut would land inside it,
    // wrapped in prose so the whole document overflows and must be re-split.
    const fence = "```\n" + "code line here\n".repeat(8) + "```";
    const prose = "word ".repeat(40);
    const raw = `${prose}\n\n${fence}\n\n${prose}`;
    const pieces = renderOutboundChunks(raw, ON, maxLen, plainMax);

    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      // Every emitted piece has BALANCED fence delimiters — no piece opens a
      // fence it doesn't close (which would swallow the next piece's text).
      expect(fenceCount(p.text) % 2).toBe(0);
      const cap = p.mode === "plain" ? plainMax : maxLen;
      expect(p.text.length).toBeLessThanOrEqual(cap);
    }
  });

  it("REAL-CAP: a ~32k escapable body never yields an over-4096 plain piece", () => {
    // The production failure: raw just under RICH_MESSAGE_MAX_CHARS, escaping
    // pushes the rendered form over it. On the buggy path this became ONE
    // ~32k plain body sent through the 4096 plain endpoint. Here every plain
    // piece is <= 4096 and every rich piece <= 32768.
    const unit = "a_b*c|d ";
    const raw = unit.repeat(Math.floor((RICH_MESSAGE_MAX_CHARS - 20) / unit.length));
    const pieces = renderOutboundChunks(raw, ON);
    for (const p of pieces) {
      const cap = p.mode === "plain" ? PLAIN_TEXT_MAX_CHARS : RICH_MESSAGE_MAX_CHARS;
      expect(p.text.length).toBeLessThanOrEqual(cap);
    }
  }, 30000);
});
