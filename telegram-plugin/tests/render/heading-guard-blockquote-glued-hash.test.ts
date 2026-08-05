import { describe, it, expect } from "vitest";
import { guardAccidentalHeading } from "../../render/line-start-guard.js";
import { guardAccidentalFormatting } from "../../rich-send.js";

// Characterization test for #3464 — glued `#` AFTER a blockquote/list marker.
//
// ── The observation (#3464, follow-up from #3463 review) ─────────────────────
// `guardAccidentalHeading` is `^`-anchored (`ACCIDENTAL_HEADING = /^([ \t]{0,3})
// (#{1,6})(?=[^\s#])/`), so a `#` glued after a blockquote or list marker on the
// same line — `> #3460`, `- #3460`, `1. #3460` — is NOT matched, and the seam
// leaves it untouched. On the RENDERER path this position is incidentally
// escaped, because render.ts:escapeLineLeadingHash runs on the paragraph's
// rendered text BEFORE renderBlockquote/renderList prepend the `> `/`- ` marker.
// On the renderer-BYPASS seam (cards / banners / status / approval sends), no
// such belt runs, so the glued `#` reaches Telegram unescaped.
//
// ── Live UAT confirmed the promotion → these pins are now FLIPPED (#3464) ─────
// The question was a fact we could NOT determine from the byte stream: does
// Telegram's non-spec Bot API rich parser actually promote a space-less `#` to a
// heading when it sits AFTER a `>`/list marker, the way it demonstrably does at
// a bare line start (`#3460` → giant heading, #3306/#3463)?
//   - CommonMark treats `> #3460` as a blockquote whose content is the paragraph
//     `#3460` (no ATX heading — no space after `#`); `> # Heading` (WITH space)
//     is a real nested heading. Telegram's promotion of the SPACE-LESS form is
//     the documented non-spec deviation.
// Issue #3464 said: "Verify against Telegram live-UAT whether the non-spec
// heading promotion actually fires inside blockquotes/lists before adding
// escaping (avoid stray backslashes if it does not)." That live UAT has now run
// and CONFIRMED the promotion fires in the nested position — a `#` glued after a
// `>`/list marker is promoted to a heading exactly as at a bare line start. So
// `guardAccidentalHeading` now escapes it (via `ACCIDENTAL_HEADING_AFTER_MARKER`
// in line-start-guard.ts), and the previously-pinned "left untouched"
// expectations are flipped to assert the escaped outcome. A real nested heading
// (`> # Heading`, space AFTER the `#`) and a bare `#` remain untouched (below).

describe("guardAccidentalHeading — glued `#` after a blockquote/list marker IS escaped (#3464, live-UAT confirmed)", () => {
  it("escapes `> #3460` (glued hash after a blockquote marker)", () => {
    expect(guardAccidentalHeading("> #3460 done")).toBe("> \\#3460 done");
  });

  it("escapes `- #3460` (glued hash after an unordered-list marker)", () => {
    expect(guardAccidentalHeading("- #3460 done")).toBe("- \\#3460 done");
  });

  it("escapes `* #3460` (glued hash after a `*` bullet)", () => {
    expect(guardAccidentalHeading("* #3460 x")).toBe("* \\#3460 x");
  });

  it("escapes `1. #3460` (glued hash after an ordered-list marker)", () => {
    expect(guardAccidentalHeading("1. #3460 x")).toBe("1. \\#3460 x");
  });

  it("still escapes the SAME `#3460` at a bare line start (the original confirmed case)", () => {
    expect(guardAccidentalHeading("#3460 done")).toBe("\\#3460 done");
  });
});

describe("guardAccidentalHeading — a real nested heading (space form) must stay untouched (#3464)", () => {
  it("leaves `> # Heading` untouched (intended heading inside a blockquote)", () => {
    expect(guardAccidentalHeading("> # Heading")).toBe("> # Heading");
  });

  it("leaves `- # Heading` untouched (intended heading inside a list item)", () => {
    expect(guardAccidentalHeading("- # Heading")).toBe("- # Heading");
  });
});

describe("guardAccidentalFormatting (universal seam) — glued `#` after a marker IS escaped end-to-end (#3464)", () => {
  it("escapes `> #3460` through the full composition", () => {
    expect(guardAccidentalFormatting("> #3460 done")).toBe("> \\#3460 done");
  });

  it("escapes `- #3460` through the full composition", () => {
    expect(guardAccidentalFormatting("- #3460 done")).toBe("- \\#3460 done");
  });

  it("still escapes a bare line-leading `#3460` at the seam (control)", () => {
    expect(guardAccidentalFormatting("#3460 done")).toBe("\\#3460 done");
  });
});

describe("guardAccidentalHeading (#3464) — every list/blockquote marker shape + nesting is escaped", () => {
  it("escapes `- #4382's x` (apostrophe-suffixed hash after a `-` bullet)", () => {
    expect(guardAccidentalHeading("- #4382's x")).toBe("- \\#4382's x");
  });

  it("escapes `* #x` (after a `*` bullet)", () => {
    expect(guardAccidentalHeading("* #x")).toBe("* \\#x");
  });

  it("escapes `+ #x` (after a `+` bullet)", () => {
    expect(guardAccidentalHeading("+ #x")).toBe("+ \\#x");
  });

  it("escapes `1. #x` (after a `.`-delimited ordered marker)", () => {
    expect(guardAccidentalHeading("1. #x")).toBe("1. \\#x");
  });

  it("escapes `1) #x` (after a `)`-delimited ordered marker)", () => {
    expect(guardAccidentalHeading("1) #x")).toBe("1) \\#x");
  });

  it("escapes `> #x` (after a blockquote marker)", () => {
    expect(guardAccidentalHeading("> #x")).toBe("> \\#x");
  });

  it("escapes nested `- > #x` (a bullet then a blockquote marker)", () => {
    expect(guardAccidentalHeading("- > #x")).toBe("- > \\#x");
  });
});

describe("guardAccidentalHeading (#3464) — invariants that must stay untouched", () => {
  it("leaves `- # Heading` (real nested heading, space after `#`)", () => {
    expect(guardAccidentalHeading("- # Heading")).toBe("- # Heading");
  });

  it("leaves `# Heading` (real bare heading, space after `#`)", () => {
    expect(guardAccidentalHeading("# Heading")).toBe("# Heading");
  });

  it("still escapes bare `#4382 done` (unchanged from before this PR)", () => {
    expect(guardAccidentalHeading("#4382 done")).toBe("\\#4382 done");
  });
});

describe("guardAccidentalFormatting (#3464) — `*`-bullet marker survives emphasis AND the glued `#` is escaped (blocker 1, end-to-end)", () => {
  // The composed pipeline (rich-send.ts) runs guardAccidentalEmphasis BEFORE
  // guardAccidentalHeading. If the emphasis arm escaped the leading `* ` bullet,
  // the LITERAL `*` marker the heading guard needs would be gone and the glued
  // `#` would NOT be escaped. These tests exercise the REAL ordering — the unit
  // tests above call the heading guard in isolation and cannot catch that.
  it("escapes `* #3460 x` end-to-end (marker preserved, `#` escaped)", () => {
    expect(guardAccidentalFormatting("* #3460 x")).toBe("* \\#3460 x");
  });

  it("escapes `* #x` end-to-end", () => {
    expect(guardAccidentalFormatting("* #x")).toBe("* \\#x");
  });

  it("escapes `- #3460 x` end-to-end (regression guard — `-` marker never touched)", () => {
    expect(guardAccidentalFormatting("- #3460 x")).toBe("- \\#3460 x");
  });

  it("escapes `> #x` end-to-end", () => {
    expect(guardAccidentalFormatting("> #x")).toBe("> \\#x");
  });

  it("leaves a plain `*`-bullet list unchanged end-to-end (no glued `#`)", () => {
    const s = "* bullet a\n* bullet b";
    expect(guardAccidentalFormatting(s)).toBe(s);
  });

  it("leaves a mixed `*`/`-` bullet list unchanged end-to-end", () => {
    const s = "* one\n- two\n* three";
    expect(guardAccidentalFormatting(s)).toBe(s);
  });
});

describe("guardAccidentalHeading (#3464) — idempotence (double-apply is byte-identical)", () => {
  for (const input of [
    "- #4382 done",
    "> #x",
    "- > #x",
    "1. #x",
    "#4382 done",
  ]) {
    it(`is idempotent on ${JSON.stringify(input)}`, () => {
      const once = guardAccidentalHeading(input);
      expect(guardAccidentalHeading(once)).toBe(once);
      expect(once).not.toContain("\\\\#");
    });
  }
});
