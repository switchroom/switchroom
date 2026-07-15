import { describe, it, expect } from "vitest";
import { guardAccidentalEmphasis } from "../../render/emphasis-guard.js";

// Any U+1D400–U+1D7FF codepoint would be a mathematical-alphanumeric glyph; the
// source never emits them — kept as a canary that the guard adds none.
const MATH_GLYPH = /[\u{1D400}-\u{1D7FF}]/u;

/** Strip defusing backslashes so we can assert the reader-visible/copy text is
 *  byte-identical to the original prose. */
function copyText(s: string): string {
  return s.replace(/\\([_*])/g, "$1");
}

describe("guardAccidentalEmphasis (#3252) — accidental emphasis IS neutralised", () => {
  it("escapes intra-word underscores in a snake_case identifier", () => {
    const out = guardAccidentalEmphasis("the var is file_name_here in scope");
    // No unescaped intra-word `_` remains to pair into an italic span.
    expect(out).toContain("file\\_name\\_here");
    expect(copyText(out)).toBe("the var is file_name_here in scope");
  });

  it("escapes intra-word asterisks in inline multiplication `a*b*c`", () => {
    const out = guardAccidentalEmphasis("compute a*b*c for the product");
    expect(out).toContain("a\\*b\\*c");
    expect(copyText(out)).toBe("compute a*b*c for the product");
  });

  it("escapes a digit-flanked `2*3` multiplication", () => {
    const out = guardAccidentalEmphasis("the area is 2*3 units");
    expect(out).toContain("2\\*3");
  });

  it("escapes a mixed digit/letter intra-word underscore `v2_final`", () => {
    const out = guardAccidentalEmphasis("ship v2_final today");
    expect(out).toContain("v2\\_final");
  });

  it("adds no math-italic glyphs", () => {
    expect(guardAccidentalEmphasis("file_name_here and a*b")).not.toMatch(MATH_GLYPH);
  });
});

describe("guardAccidentalEmphasis (#3252) — intended emphasis is LEFT UNTOUCHED (the critical no-false-positive cases)", () => {
  it("leaves `**bold**` verbatim", () => {
    const s = "this is **bold** text";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves `*italic*` verbatim", () => {
    const s = "this is *italic* text";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves `_italic_` verbatim", () => {
    const s = "this is _italic_ text";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a multi-word `*italic phrase*` verbatim (boundary-flanked delimiters)", () => {
    const s = "please read *the whole thing* carefully";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves `**bold**` and `_italic_` mixed in one line verbatim", () => {
    const s = "**Header** then _emphasis_ and more **bold**";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves an intended italic that WRAPS a glob (`*.ts is a glob*`) verbatim", () => {
    // The opening `*` is boundary-flanked (space before, `.` after) → not
    // intra-word → deliberately left alone so the intended italic survives.
    const s = "note: *.ts is a glob* pattern";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a leading-underscore identifier `_private` verbatim (indistinguishable from italic)", () => {
    const s = "the _private field and _internal state";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves space-flanked operators (`3 * 4`) verbatim — GFM cannot emphasise them", () => {
    const s = "the product 3 * 4 equals 12";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a bare trailing glob (`rm *`) verbatim", () => {
    const s = "run rm * to clear the dir";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a lone glob (`*.ts`) verbatim", () => {
    const s = "match *.ts files only";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});

describe("guardAccidentalEmphasis (#3252) — code-span awareness", () => {
  it("never touches intra-word `_`/`*` inside a code span", () => {
    const s = "the identifier `file_name_here` and math `a*b*c` are code";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("escapes prose but leaves an adjacent code span verbatim", () => {
    const out = guardAccidentalEmphasis("prose file_name but code `file_name`");
    expect(out).toContain("file\\_name but code `file_name`");
  });

  it("never touches intra-word delimiters inside a fenced code block", () => {
    const s = "```\nfoo_bar = a*b*c\n```\ntail";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});

describe("guardAccidentalEmphasis (#3252) — no-op & idempotency", () => {
  it("is a strict no-op when there is no `_` or `*` at all", () => {
    const s = "a plain sentence with no delimiters at all";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("is a strict no-op when the only `_`/`*` are intended emphasis", () => {
    const s = "**bold** and _italic_ only";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("is idempotent: guarding already-guarded text is a strict no-op", () => {
    const once = guardAccidentalEmphasis("file_name_here and a*b");
    expect(guardAccidentalEmphasis(once)).toBe(once);
    expect(once).not.toContain("\\\\_"); // never a doubled backslash
    expect(once).not.toContain("\\\\*");
  });

  it("does not double-escape a pre-escaped `\\_` intra-word delimiter", () => {
    const s = "file\\_name here";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});
