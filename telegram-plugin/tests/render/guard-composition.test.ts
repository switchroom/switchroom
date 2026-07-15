import { describe, it, expect } from "vitest";
import { guardAccidentalFormatting, richMessage } from "../../rich-send.js";

// Any U+1D400–U+1D7FF codepoint = a mathematical-alphanumeric glyph (what a
// `$…$` math span typesets to on the reader's screen).
const MATH_GLYPH = /[\u{1D400}-\u{1D7FF}]/u;

/** Strip the defusing backslashes so we can assert the reader-visible / copied
 *  text is byte-identical to the original ASCII. */
function copyText(s: string): string {
  return s.replace(/\\([$_*>.~=|])/g, "$1");
}

// The composed seam guard (#3252): guardAccidentalEmphasis →
// guardAccidentalBlockConstructs → guardAccidentalInlinePairs → guardDollarMath.
// These tests prove the guards COMPOSE without one guard's inserted backslash
// creating or destroying a signal for another — the interference question.
describe("guardAccidentalFormatting composition (#3252)", () => {
  it("neutralises a message that trips emphasis + dollar + tilde at once", () => {
    // `file_name` (intra-word `_`), `~$5M … ~$10M` (digit-adjacent tildes AND a
    // two-dollar currency span) — three guards fire on one body.
    const src = "the file_name budget trims ~$5M, down from ~$10M last year";
    const out = guardAccidentalFormatting(src);
    // Emphasis: the intra-word underscore is escaped (no `_…_` pair).
    expect(out).toContain("file\\_name");
    // Dollar: no unescaped `$` remains to open a math span.
    expect(out).not.toMatch(/(?<!\\)\$/);
    // Tilde: BOTH approximation tildes escaped so no `~…~` strikethrough forms.
    // This is the interference case — dollar runs last so its `\$` never hides
    // the digit-adjacent tildes from the inline-pairs guard.
    expect(out).not.toMatch(/(?<!\\)~/);
    expect(out).toContain("\\~\\$5M");
    expect(out).toContain("\\~\\$10M");
    // No math glyphs, and stripping the defusers yields the original prose.
    expect(out).not.toMatch(MATH_GLYPH);
    expect(copyText(out)).toBe(src);
  });

  it("handles a line-start blockquote + operator-mark + dollar body", () => {
    const src = ">2x growth means x==y and a==b while spend hit $40 and $80";
    const out = guardAccidentalFormatting(src);
    // Line-start `>2x` blockquote-promotion escaped.
    expect(out).toContain("\\>2x");
    // Both `==` operators neutralised (word-flanked → not intended ==mark==).
    expect(out).toContain("x\\=\\=y");
    expect(out).toContain("a\\=\\=b");
    // Dollars escaped.
    expect(out).not.toMatch(/(?<!\\)\$/);
    expect(copyText(out)).toBe(src);
  });

  it("leaves a 4-digit-year accidental ordered-list alone except the dot", () => {
    const src = "2026. was the year the file_name convention changed";
    const out = guardAccidentalFormatting(src);
    expect(out).toContain("2026\\. was");
    expect(out).toContain("file\\_name");
  });

  it("never touches DELIBERATE formatting: bold, italic, strike, code, blockquote", () => {
    const src =
      "**bold** and *italic* and _under_ and ~~strike~~ and `a_b*c` and\n> real quote";
    // No accidental signal anywhere → strict no-op.
    expect(guardAccidentalFormatting(src)).toBe(src);
  });

  it("never touches content inside code spans / fenced blocks", () => {
    const src =
      "prose $10 and $20 but the snippet `x==y && file_name ~5` stays verbatim";
    const out = guardAccidentalFormatting(src);
    expect(out).toContain("`x==y && file_name ~5`");
    // Prose dollars still escaped outside the code span.
    expect(out).not.toMatch(/(?<!\\)\$(?=\d)/);
  });

  it("is idempotent: composing already-composed text is a strict no-op", () => {
    const src = "file_name ~$5M and ~$10M with x==y and a==b, >2x, 2026. done";
    const once = guardAccidentalFormatting(src);
    expect(guardAccidentalFormatting(once)).toBe(once);
    // No doubled backslashes anywhere.
    expect(once).not.toMatch(/\\\\/);
  });

  it("richMessage() applies the composed guard on the wire body exactly once", () => {
    const src = "file_name spend ~$5M vs ~$10M, x==y";
    const wire = richMessage(src);
    expect(wire.markdown).toBe(guardAccidentalFormatting(src));
    // And re-wrapping (streaming re-render) is byte-stable.
    expect(richMessage(wire.markdown).markdown).toBe(wire.markdown);
  });
});
