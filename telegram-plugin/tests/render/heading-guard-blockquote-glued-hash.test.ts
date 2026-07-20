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
// ── Why this test PINS the current behavior instead of changing it ───────────
// Whether this is a bug depends on a fact we CANNOT determine from the byte
// stream: does Telegram's non-spec Bot API rich parser actually promote a
// space-less `#` to a heading when it sits AFTER a `>`/list marker, the way it
// demonstrably does at a bare line start (`#3460` → giant heading, #3306/#3463)?
//   - CommonMark treats `> #3460` as a blockquote whose content is the paragraph
//     `#3460` (no ATX heading — no space after `#`); `> # Heading` (WITH space)
//     is a real nested heading. Telegram's promotion of the SPACE-LESS form is
//     the documented non-spec deviation — but only ever OBSERVED at a bare line
//     start, never confirmed inside a blockquote/list.
//   - There is no repo evidence (UAT fixture, doc note, or #3306/#3463 UAT
//     result) establishing that the promotion fires in this nested position.
//     The render.ts belt escaping it is a GENERIC side effect of a `^…#`
//     paragraph regex, not a confirmed-behavior signal.
// Issue #3464 itself says: "Verify against Telegram live-UAT whether the
// non-spec heading promotion actually fires inside blockquotes/lists before
// adding escaping (avoid stray backslashes if it does not)." That live UAT
// cannot run in vitest. Ken's hard constraint on this guard family is that a
// wrong "fix" adding stray backslashes would itself corrupt legitimate
// formatting — the exact thing to avoid. So this test DOCUMENTS the current,
// deliberately-conservative behavior; if live UAT later confirms Telegram DOES
// promote here, extend the guard and flip these expectations in the same PR.

describe("guardAccidentalHeading — glued `#` after a blockquote/list marker is NOT escaped (#3464, awaits live-UAT)", () => {
  it("leaves `> #3460` untouched (glued hash after a blockquote marker)", () => {
    expect(guardAccidentalHeading("> #3460 done")).toBe("> #3460 done");
  });

  it("leaves `- #3460` untouched (glued hash after an unordered-list marker)", () => {
    expect(guardAccidentalHeading("- #3460 done")).toBe("- #3460 done");
  });

  it("leaves `* #3460` untouched (glued hash after a `*` bullet)", () => {
    expect(guardAccidentalHeading("* #3460 x")).toBe("* #3460 x");
  });

  it("leaves `1. #3460` untouched (glued hash after an ordered-list marker)", () => {
    expect(guardAccidentalHeading("1. #3460 x")).toBe("1. #3460 x");
  });

  it("still escapes the SAME `#3460` at a bare line start (the confirmed case)", () => {
    // Proves the untouched results above are the `^`-anchor scope, not the guard
    // being disabled: at a real line start the accidental heading IS escaped.
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

describe("guardAccidentalFormatting (universal seam) — same conservative behavior end-to-end (#3464)", () => {
  it("leaves `> #3460` untouched through the full composition", () => {
    expect(guardAccidentalFormatting("> #3460 done")).toBe("> #3460 done");
  });

  it("leaves `- #3460` untouched through the full composition", () => {
    expect(guardAccidentalFormatting("- #3460 done")).toBe("- #3460 done");
  });

  it("still escapes a bare line-leading `#3460` at the seam (control)", () => {
    expect(guardAccidentalFormatting("#3460 done")).toBe("\\#3460 done");
  });
});
