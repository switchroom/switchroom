import { describe, it, expect } from "vitest";
import { guardDollarMath } from "../../render/dollar-math-guard.js";
import { renderOutbound } from "../../render/rich-render.js";

// Any U+1D400–U+1D7FF codepoint = a mathematical-alphanumeric (math-italic /
// math-bold) glyph — what a math renderer produces from a `$…$` span.
const MATH_GLYPH = /[\u{1D400}-\u{1D7FF}]/u;

/** Strip zero-width chars + defusing backslashes so we can assert the amount
 *  the reader copies is byte-identical to the original ASCII currency token. */
function copyText(s: string): string {
  return s.replace(/[​⁠﻿]/g, "").replace(/\\\$/g, "$");
}

describe("guardDollarMath (#3252)", () => {
  const OFFENDING =
    "acquisition ceiling is ~$0.5-0.9M but nearly all in small dealers ... is ~$150-450k";

  it("neutralises the two-dollar-amount currency string so no `$…$` span can form", () => {
    const out = guardDollarMath(OFFENDING);
    // Both currency dollars are backslash-escaped → no unescaped `$` remains to
    // open/close a math span.
    expect(out).not.toMatch(/(?<!\\)\$/);
    expect(out).toContain("\\$0.5-0.9M");
    expect(out).toContain("\\$150-450k");
  });

  it("carries no math-italic glyphs (switchroom never emits U+1D400-range)", () => {
    expect(guardDollarMath(OFFENDING)).not.toMatch(MATH_GLYPH);
    // …nor does the raw source; the guard is what keeps the WIRE bytes clean.
    expect(OFFENDING).not.toMatch(MATH_GLYPH);
  });

  it("preserves the visible amounts: stripping the defuser yields the original", () => {
    expect(copyText(guardDollarMath(OFFENDING))).toBe(OFFENDING);
  });

  it("is a strict no-op for a single `$digit` prose token", () => {
    const s = "grab a $5 coffee on the way";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("is a strict no-op when there is no `$digit` at all", () => {
    const s = "the cost is unknown but the $ sign appears twice: $ and $";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("never touches `$` inside a code span", () => {
    const s = "shell math `$x = $y` is fine and `$z = $w` too";
    // Two code spans, each with 2 `$digit`? No — non-digit. Use digits to prove
    // code is skipped even when it WOULD otherwise trigger.
    const withDigits = "compute `$1 + $2` and also `$3 + $4` inline";
    expect(guardDollarMath(s)).toBe(s);
    expect(guardDollarMath(withDigits)).toBe(withDigits);
  });

  it("escapes prose dollars but leaves an adjacent code span verbatim", () => {
    const s = "prices $10 and $20 — the var is `$PRICE = $10`";
    const out = guardDollarMath(s);
    // Prose amounts escaped:
    expect(out).toContain("\\$10 and \\$20");
    // Code span verbatim (its `$10` NOT escaped):
    expect(out).toContain("`$PRICE = $10`");
  });
});

describe("renderOutbound integration (#3252)", () => {
  const OFFENDING =
    "acquisition ceiling is ~$0.5-0.9M but nearly all in small dealers ... is ~$150-450k";

  it("the live rich path emits no `$…$` math pair and no math glyphs", () => {
    const r = renderOutbound(OFFENDING);
    expect(r.mode).toBe("markdown");
    expect(r.text).not.toMatch(MATH_GLYPH);
    expect(r.text).not.toMatch(/(?<!\\)\$/); // no unescaped dollar survives
    // Reader-visible amounts intact (renderer also escapes `~`→`\~`, invisible).
    expect(copyText(r.text).replace(/\\~/g, "~")).toBe(OFFENDING);
  });

  it("a single-amount reply is left with its dollar untouched by the guard", () => {
    const r = renderOutbound("the retainer is $2500 per month");
    expect(r.text).toContain("$2500");
    expect(r.text).not.toContain("\\$2500");
  });
});
