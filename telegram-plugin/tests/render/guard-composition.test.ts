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
    // `file_name_here` (2 intra-word `_` → can pair), `~$5M … ~$10M`
    // (digit-adjacent tildes AND a two-dollar currency span) — three guards fire.
    const src = "the file_name_here budget trims ~$5M, down from ~$10M last year";
    const out = guardAccidentalFormatting(src);
    // Emphasis: the intra-word underscores are escaped (no `_…_` pair).
    expect(out).toContain("file\\_name\\_here");
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
    const src = "2026. was the year the file_name_here convention changed";
    const out = guardAccidentalFormatting(src);
    expect(out).toContain("2026\\. was");
    expect(out).toContain("file\\_name\\_here");
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
    const src = "file_name_here ~$5M and ~$10M with x==y and a==b, >2x, 2026. done";
    const once = guardAccidentalFormatting(src);
    expect(guardAccidentalFormatting(once)).toBe(once);
    // No doubled backslashes anywhere.
    expect(once).not.toMatch(/\\\\/);
  });

  it("passes a markdown link with a `_`/`~`/`==`-laden URL through UNMODIFIED (finding 1)", () => {
    const src = "see [docs](https://x.io/a_b_c?p==1&q~2) and [more](https://y.io/foo_bar)";
    // Every trigger char in the URL is structural → the whole body is verbatim.
    expect(guardAccidentalFormatting(src)).toBe(src);
  });

  it("passes a bare autolinked URL through UNMODIFIED (finding 1)", () => {
    const src = "read https://en.wikipedia.org/wiki/Foo_Bar_Baz today";
    expect(guardAccidentalFormatting(src)).toBe(src);
  });

  it("guards the link LABEL but protects the destination (finding 1)", () => {
    const out = guardAccidentalFormatting("[a_b_c](https://x.io/p_q_r) spent $5 and $9");
    // Label prose escaped; URL verbatim; prose dollars still escaped.
    expect(out).toContain("[a\\_b\\_c]");
    expect(out).toContain("(https://x.io/p_q_r)");
    expect(out).not.toMatch(/(?<!\\)\$/);
  });

  it("passes a GFM table with empty cells through UNMODIFIED (finding 3)", () => {
    // A real table (has a delimiter row) — its structural pipes/empty cells and
    // any `_`/`$` inside cells must survive. `|a||b|` = a real empty cell.
    const src = ["| A | B | C |", "| --- | --- | --- |", "|a||b||c|", "| x_y | $5 | ~3 |"].join("\n");
    expect(guardAccidentalFormatting(src)).toBe(src);
  });

  it("STILL guards a genuine accidental `a||b` in prose (not a table)", () => {
    // Two word-flanked `||` in PROSE (no delimiter row) → armed spoiler guard.
    const out = guardAccidentalFormatting("logic is a||b and c||d here");
    expect(out).toContain("a\\|\\|b");
    expect(out).toContain("c\\|\\|d");
  });

  // FINDING 2 (documented non-issue): switchroom's IR renderer emits code
  // blocks ONLY as backtick FENCES (render.ts renderCodeBlock), never as
  // 4-space-indented CommonMark code. So renderer output reaching richMessage()
  // never contains an indented code block. The emphasis/inline-pairs/dollar
  // guards therefore do NOT special-case a 4-space indent (only line-start does,
  // for its own blockquote/list heuristics). This test PINS that current
  // behaviour: a 4-space-indented prose line is treated as ordinary prose and
  // its currency `$` is guarded like any other. (If a future change ever routes
  // raw indented code blocks to the wire, revisit — see guards-integration-note.)
  it("treats a 4-space-indented line as prose (finding 2 — renderer emits fences, not indented code)", () => {
    const out = guardAccidentalFormatting("    spend was $5 and $10 total");
    expect(out).toContain("\\$5");
    expect(out).toContain("\\$10");
  });

  it("richMessage() applies the composed guard on the wire body exactly once", () => {
    const src = "file_name spend ~$5M vs ~$10M, x==y";
    const wire = richMessage(src);
    expect(wire.markdown).toBe(guardAccidentalFormatting(src));
    // And re-wrapping (streaming re-render) is byte-stable.
    expect(richMessage(wire.markdown).markdown).toBe(wire.markdown);
  });

  // ── Wire-verified NATIVE constructs survive the FULL pipeline ────────────
  // Raw sendRichMessage probes (2026-08-13) proved Telegram's rich markdown
  // path natively renders `<details>`, `$…$` inline math, and footnotes. The
  // pre-fix pipeline destroyed all three (details → the unsupported `**>`
  // marker, `$x^2+y^2$` → `\$x^2+y^2\$`, `[^n1]` deleted) — each assertion
  // below FAILS on that pipeline.
  describe("native constructs pass through the full composed guard", () => {
    it("<details open><summary> block survives byte-identical", () => {
      const src = "<details open><summary>S</summary>\n\nbody\n\n</details>";
      expect(guardAccidentalFormatting(src)).toBe(src);
      expect(richMessage(src).markdown).toBe(src);
    });

    it("compact $math$ span survives byte-identical", () => {
      const src = "inline $x^2+y^2$ done";
      expect(guardAccidentalFormatting(src)).toBe(src);
    });

    it("footnote reference + definition survive byte-identical", () => {
      const src = "claim[^n1]\n\n[^n1]: body";
      expect(guardAccidentalFormatting(src)).toBe(src);
    });

    it("`**>` is never emitted for any input the pipeline repairs", () => {
      const out = guardAccidentalFormatting(
        "<details><summary>T</summary>\nbody\n</details>",
      );
      expect(out).not.toContain("**>");
    });
  });

  // ── Guard-interaction cases for the now-passing-through constructs ───────
  // Removing the old token conversions changes what the sibling guards see (a
  // surviving `$`, a surviving `<`). These prove the emphasis / heading /
  // block-construct / inline-pair / dollar guards do not mangle the natives,
  // while their own repairs still fire in the SAME message.
  describe("native constructs vs sibling guards (interaction)", () => {
    it("math span is exempt while surrounding currency is still broken apart", () => {
      const src = "sum $x^2+y^2$ costs $5 and $10 total";
      const out = guardAccidentalFormatting(src);
      // The math span reaches the wire byte-identical…
      expect(out).toContain("$x^2+y^2$");
      // …while the accidental currency pair is still defused (#3252).
      expect(out).toContain("\$5");
      expect(out).toContain("\$10");
    });

    it("currency-shaped adjacent amounts are NOT mistaken for math", () => {
      // `$5M-$10M` has a whitespace-free `$…$` pair (`$5M-$`) — the currency
      // shape must keep it guardable, else #3252 regresses.
      const out = guardAccidentalFormatting("range is $5M-$10M this year");
      expect(out).not.toMatch(/(?<!\\)\$/);
    });

    it("math span interior is protected from the emphasis and caret guards", () => {
      // `a_b*c` inside math would trip the intra-word `_`/`*` escapes, and
      // `^2y^` is an alphanumeric caret pair the token guard would strip —
      // both must stay verbatim inside the protected span. The `_`/`*`
      // OUTSIDE the span are still guarded — note the protected span's
      // delimiters do NOT count toward the 2+ pairing threshold, so the
      // prose needs its own pairable signals (`2*3 and 4*5`).
      const src = "$a_b*c$ and file_name_here times 2*3 and 4*5";
      const out = guardAccidentalFormatting(src);
      expect(out).toContain("$a_b*c$");
      expect(out).toContain("file\\_name\\_here");
      expect(out).toContain("2\\*3");
      expect(out).toContain("4\\*5");
      expect(guardAccidentalFormatting("inline $x^2y^2$ done")).toBe(
        "inline $x^2y^2$ done",
      );
    });

    it("<details> lines are invisible to the line-start and heading guards", () => {
      // A details block whose body carries genuine accidental signals: the
      // guards must fire on the BODY prose without touching the tags.
      const src =
        "<details open><summary>Stats</summary>\n\n>2x growth and #1 priority\n\n</details>";
      const out = guardAccidentalFormatting(src);
      expect(out).toContain("<details open><summary>Stats</summary>");
      expect(out).toContain("</details>");
      // Line-start `>2x` and glued `#1` are still repaired inside the body.
      expect(out).toContain("\>2x");
      expect(out).toContain("\#1");
    });

    it("footnote markers survive alongside a firing dollar guard", () => {
      const src = "cost[^1] was $5 then $9\n\n[^1]: the note";
      const out = guardAccidentalFormatting(src);
      expect(out).toContain("cost[^1]");
      expect(out).toContain("[^1]: the note");
      expect(out).toContain("\$5");
      expect(out).toContain("\$9");
    });

    it("the whole composition stays idempotent with natives present", () => {
      const src =
        "claim[^1] and $x^2+y^2$ in <details><summary>T</summary>\nb\n</details> with $5 and $10\n\n[^1]: n";
      const once = guardAccidentalFormatting(src);
      expect(guardAccidentalFormatting(once)).toBe(once);
    });
  });
});
