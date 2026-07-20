/**
 * Truth-pass pin (#3252 formatting-truth follow-up): the REAL wire outcome for
 * a `__…__` run.
 *
 * The parser folds `__x__` into a distinct `underline` IR node and the renderer
 * round-trips it back to `__x__` (asserted in parse.test.ts / render.test.ts).
 * But Telegram's rich-message markdown has NO underline token: the wire renders
 * `__x__` identically to `**x__` — i.e. as BOLD (live-verified 2026-07, see
 * reference/telegram-formatting-guide.md).
 *
 * Decision (documented in the fmt-audit BUILD-LOG): we keep the underline node
 * and faithfully preserve the author's `__` bytes rather than rewriting them to
 * `**` — full removal would invert several green tests and change wire bytes for
 * zero wire-visible benefit (both render as bold). This test pins the honest
 * contract: `__x__` emits `__x__`, which the wire treats as bold, NOT a distinct
 * underline style.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../render/parse.js";
import { render } from "../../render/render.js";

describe("underline: real wire outcome for `__…__`", () => {
  it("round-trips `__x__` to `__x__` on the wire (which Telegram renders as BOLD)", () => {
    // The emitted bytes preserve the author's `__` delimiters verbatim.
    expect(render(parse("__x__"))).toBe("__x__");
  });

  it("does NOT rewrite `__x__` to `**x**` (author bytes preserved, not normalised to bold syntax)", () => {
    expect(render(parse("__underlined__"))).not.toContain("**");
    expect(render(parse("__underlined__"))).toBe("__underlined__");
  });
});
