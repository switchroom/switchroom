import { describe, it, expect } from "vitest";
import { guardAccidentalHeading } from "../../render/line-start-guard.js";
import { guardAccidentalFormatting } from "../../rich-send.js";

// Accidental-heading guard (#3306 follow-up): Telegram's Bot API rich-markdown
// parser is NON-spec and promotes a line-leading `#{1,6}` run to a heading even
// WITHOUT the CommonMark-required trailing space, so `#3460 done` renders as a
// giant heading. The guard escapes ONLY the space-less, non-`#`-adjacent form
// and leaves genuine `# Title` / `## Sub` headings byte-for-byte untouched.
//
// The load-bearing assertions run against the REAL universal wire seam
// `guardAccidentalFormatting` (rich-send.ts) — the composed guard every
// `{ markdown }` send funnels through — not the renderer, so cards / banners /
// status / approval sends (which bypass the rich renderer) are proven covered.

/** Strip the defusing backslash so we can assert the reader-visible text is
 *  byte-identical to the original prose (Telegram consumes the `\`). */
function copyText(s: string): string {
  return s.replace(/\\#/g, "#");
}

describe("guardAccidentalHeading — accidental Telegram heading is escaped", () => {
  it("escapes ONLY the line-leading `#3460`, not the mid-line `#3462` after `PR `", () => {
    expect(guardAccidentalHeading("#3460 done and up as PR #3462")).toBe(
      "\\#3460 done and up as PR #3462",
    );
  });

  it("escapes `#foo` (no space, glued to a letter)", () => {
    expect(guardAccidentalHeading("#foo bar")).toBe("\\#foo bar");
  });

  it("escapes `###x` (multi-hash run, no space)", () => {
    expect(guardAccidentalHeading("###x")).toBe("\\###x");
  });

  it("reader-visible text is byte-identical after stripping the backslash", () => {
    const s = "#3460 done";
    expect(copyText(guardAccidentalHeading(s))).toBe(s);
  });
});

describe("guardAccidentalHeading — intended headings are NEVER touched", () => {
  it("leaves `# Real Heading` (space form) untouched", () => {
    const s = "# Real Heading";
    expect(guardAccidentalHeading(s)).toBe(s);
  });

  it("leaves `## Sub` untouched", () => {
    const s = "## Sub";
    expect(guardAccidentalHeading(s)).toBe(s);
  });

  it("leaves a bare `#` / `##` (end-of-line) untouched", () => {
    expect(guardAccidentalHeading("#")).toBe("#");
    expect(guardAccidentalHeading("##\nbody")).toBe("##\nbody");
  });

  it("leaves a multi-line mix intact: heading kept, glued ref escaped", () => {
    const s = "# Title\n#3460 is the issue";
    expect(guardAccidentalHeading(s)).toBe("# Title\n\\#3460 is the issue");
  });

  it("leaves a 4-space indented `#3460` (indented code) untouched", () => {
    const s = "    #3460 indented code";
    expect(guardAccidentalHeading(s)).toBe(s);
  });
});

describe("guardAccidentalHeading — code spans / fences are verbatim", () => {
  it("does not escape `#` inside an inline code span", () => {
    expect(guardAccidentalHeading("`#3460`")).toBe("`#3460`");
  });

  it("does not escape a line-leading `#3460` inside a fenced block", () => {
    const s = "```\n#3460 in code\n```";
    expect(guardAccidentalHeading(s)).toBe(s);
  });
});

describe("guardAccidentalHeading — idempotent + no-op", () => {
  it("running twice equals running once", () => {
    const once = guardAccidentalHeading("#3460 done");
    expect(guardAccidentalHeading(once)).toBe(once);
  });

  it("is a strict no-op on hash-free text", () => {
    const s = "no hashes here at all";
    expect(guardAccidentalHeading(s)).toBe(s);
  });
});

describe("guardAccidentalFormatting (universal seam) escapes accidental headings", () => {
  it("escapes the line-leading `#3460`, leaves the mid-line `#3462`", () => {
    expect(
      guardAccidentalFormatting("#3460 done and up as PR #3462"),
    ).toBe("\\#3460 done and up as PR #3462");
  });

  it("leaves `# Real Heading` untouched through the full composition", () => {
    expect(guardAccidentalFormatting("# Real Heading")).toBe("# Real Heading");
  });

  it("does not double-escape an already-escaped `\\#3460` (renderer belt + seam)", () => {
    // render.ts:escapeLineLeadingHash may already have escaped the `#`; the seam
    // must not turn `\#3460` into `\\#3460`.
    expect(guardAccidentalFormatting("\\#3460 done")).toBe("\\#3460 done");
  });

  it("is idempotent at the seam", () => {
    const once = guardAccidentalFormatting("#3460 done");
    expect(guardAccidentalFormatting(once)).toBe(once);
  });
});
