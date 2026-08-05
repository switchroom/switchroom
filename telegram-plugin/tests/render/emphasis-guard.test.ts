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

  it("escapes digit-flanked `2*3*4` multiplication (2+ asterisks can pair)", () => {
    const out = guardAccidentalEmphasis("the area is 2*3*4 units");
    expect(out).toContain("2\\*3\\*4");
  });

  it("escapes a mixed digit/letter intra-word underscore run `v2_final_rc`", () => {
    const out = guardAccidentalEmphasis("ship v2_final_rc today");
    expect(out).toContain("v2\\_final\\_rc");
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

  it("leaves a lone glob (`*.ts`) verbatim", () => {
    const s = "match *.ts files only";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});

describe("guardAccidentalEmphasis (#3464) — boundary-flanked `*` (whitespace/boundary on BOTH sides) IS escaped", () => {
  // A `*` with whitespace or a string boundary on both immediate sides is
  // neither left- nor right-flanking under GFM — it can never open or close
  // emphasis, so escaping it is always safe and never touches an intended span.
  it("escapes a space-flanked operator `3 * 4` (flipped from the old leave-alone pin)", () => {
    const out = guardAccidentalEmphasis("the product 3 * 4 equals 12");
    expect(out).toBe("the product 3 \\* 4 equals 12");
    expect(copyText(out)).toBe("the product 3 * 4 equals 12");
  });

  it("escapes a bare trailing glob `rm *` (space before, EOL after — boundary both sides)", () => {
    // `run rm * to clear` — the `*` is whitespace-flanked on both sides.
    const out = guardAccidentalEmphasis("run rm * to clear the dir");
    expect(out).toBe("run rm \\* to clear the dir");
    expect(copyText(out)).toBe("run rm * to clear the dir");
  });

  it("escapes a single space-flanked `*` in `a * b`", () => {
    const out = guardAccidentalEmphasis("compute a * b now");
    expect(out).toBe("compute a \\* b now");
    expect(copyText(out)).toBe("compute a * b now");
  });

  it("escapes BOTH space-flanked `*` in `a * b * c`", () => {
    const out = guardAccidentalEmphasis("compute a * b * c now");
    expect(out).toBe("compute a \\* b \\* c now");
    expect(copyText(out)).toBe("compute a * b * c now");
  });

  it("escapes a `*` at the string end (` *`) — boundary on the trailing side", () => {
    const out = guardAccidentalEmphasis("clear with rm *");
    expect(out).toBe("clear with rm \\*");
  });

  it("PRESERVES a line-leading `* ` — it is a list BULLET, not an operator (#3464 blocker)", () => {
    // A line-leading `* ` cannot be disambiguated from a `*`-bullet, and Telegram
    // renders it as a bullet regardless — matching origin/main. Escaping it would
    // break `*`-bullets on every reply AND (since this arm runs before the
    // heading guard) disarm the glued-`#` fix for `* #4382`. So it stays verbatim.
    const s = "* is the multiply op";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("escapes a bare lone `*` (boundary on both sides, no trailing space → not a bullet)", () => {
    expect(guardAccidentalEmphasis("*")).toBe("\\*");
  });

  it("leaves `*italic*` untouched (delimiters word-adjacent on the inner side)", () => {
    const s = "this is *italic* text";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves `**bold**` untouched", () => {
    const s = "this is **bold** text";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves intra-word `x*y` behaviour to the intra-word arm (single `*`, not boundary-flanked)", () => {
    // A lone intra-word `*` (one asterisk total) stays byte-identical per the
    // pair threshold; the boundary arm does not match it (alnum on both sides).
    const s = "the value x*y here";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("is idempotent on a boundary-flanked escape (double-apply is byte-identical)", () => {
    const once = guardAccidentalEmphasis("a * b and c * d");
    expect(guardAccidentalEmphasis(once)).toBe(once);
    expect(once).not.toContain("\\\\*");
  });

  it("escapes a `*` alone on its own line (`\\n` counts as whitespace, no bullet)", () => {
    const out = guardAccidentalEmphasis("line one\n*\nline two");
    expect(out).toBe("line one\n\\*\nline two");
  });
});

describe("guardAccidentalEmphasis (#3464) — line-leading `*` BULLETS are preserved (blocker 2)", () => {
  it("leaves a multi-line `*`-bullet list unchanged", () => {
    const s = "* bullet a\n* bullet b";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a mixed `*`/`-` bullet list unchanged", () => {
    const s = "* one\n- two\n* three";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves `+ item` and `- item` bullets unchanged (they carry no `*`)", () => {
    expect(guardAccidentalEmphasis("+ item")).toBe("+ item");
    expect(guardAccidentalEmphasis("- item")).toBe("- item");
  });

  it("leaves an indented (≤3 space) `*` bullet unchanged", () => {
    const s = "  * indented bullet";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("STILL escapes a non-bullet `*` on a line that ALSO has a `*` bullet", () => {
    // Line 1 is a bullet (preserved); line 2 has a space-flanked operator (escaped).
    const out = guardAccidentalEmphasis("* bullet\ncompute a * b");
    expect(out).toBe("* bullet\ncompute a \\* b");
  });

  it("is a strict no-op for a pure `*`-bullet list (arm stays disarmed)", () => {
    const s = "* a\n* b\n* c";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});

describe("guardAccidentalEmphasis (#3252) — pair threshold (finding 4)", () => {
  // A single delimiter in the whole message can NEVER form an emphasis pair, so
  // a lone intra-word `_`/`*` is provably inert and is left byte-identical.
  it("leaves a LONE intra-word underscore `file_name` verbatim (can't pair)", () => {
    const s = "the var is file_name in scope";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("leaves a LONE intra-word asterisk `2*3` verbatim (can't pair)", () => {
    const s = "the area is 2*3 units";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("STILL escapes a lone intra-word `_` when a later `_italic_` gives it a pair", () => {
    // Three underscores total (one intra-word + an intended `_italic_`); Telegram
    // could mis-pair them, so the intra-word `_` MUST be escaped even though it is
    // the only intra-word one. Threshold 2 (total count) catches this correctly.
    const out = guardAccidentalEmphasis("the file_name and _italic_ here");
    expect(out).toContain("file\\_name");
    // The intended italic delimiters (boundary-flanked) are left untouched.
    expect(out).toContain("_italic_");
  });
});

describe("guardAccidentalEmphasis (#3252) — link / autolink awareness (finding 1)", () => {
  it("does NOT escape intra-word `_` inside a markdown link destination", () => {
    const s = "see [docs](https://x.io/a_b_c_d) for more";
    // URL underscores are structural → passed through UNMODIFIED.
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("does NOT escape `_` inside a bare autolinked URL", () => {
    const s = "read https://x.io/foo_bar_baz now";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("STILL guards the link LABEL prose while protecting the URL", () => {
    const out = guardAccidentalEmphasis("[file_name_here](https://x.io/a_b_c)");
    // Label (rendered prose) is escaped; the `(url)` destination is verbatim.
    expect(out).toContain("[file\\_name\\_here]");
    expect(out).toContain("(https://x.io/a_b_c)");
  });

  it("protects a link destination WITH a title", () => {
    const s = 'see [docs](https://x.io/a_b_c "the_title") now';
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });
});

describe("guardAccidentalEmphasis (#3252) — trailing-alnum emphasis closer (finding 5)", () => {
  // `*cat*s` / `_cat_s`: the closing delimiter is intra-word (t*s / t_s). Under
  // strict CommonMark it cannot close emphasis, but Telegram may be more liberal
  // (UAT-gated). Documented current behaviour: the intra-word closer is escaped
  // (2 asterisks/underscores total → armed). Copy-round-trips to the original.
  it("escapes the intra-word closer of `*cat*s`", () => {
    const out = guardAccidentalEmphasis("a *cat*s tail");
    expect(out).toContain("*cat\\*s");
    expect(copyText(out)).toBe("a *cat*s tail");
  });

  it("escapes the intra-word closer of `_cat_s`", () => {
    const out = guardAccidentalEmphasis("a _cat_s tail");
    expect(out).toContain("_cat\\_s");
    expect(copyText(out)).toBe("a _cat_s tail");
  });
});

describe("guardAccidentalEmphasis (#3252) — code-span awareness", () => {
  it("never touches intra-word `_`/`*` inside a code span", () => {
    const s = "the identifier `file_name_here` and math `a*b*c` are code";
    expect(guardAccidentalEmphasis(s)).toBe(s);
  });

  it("escapes prose but leaves an adjacent code span verbatim", () => {
    // Two intra-word underscores in prose (`file_name_here`) → armed; the code
    // span's `file_name` is verbatim and does NOT count toward the threshold.
    const out = guardAccidentalEmphasis("prose file_name_here but code `file_name`");
    expect(out).toContain("file\\_name\\_here but code `file_name`");
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
