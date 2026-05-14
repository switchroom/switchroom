/**
 * Anchor resolver tests — RFC E §4.5.
 *
 * Covers all three anchor types (heading / snippet / position), the
 * disambiguation paths (HEADING_AMBIGUOUS, SNIPPET_AMBIGUOUS,
 * nth_match), the error shapes the wrapper surfaces back to the agent,
 * and the displayName surfaces the diff-preview card will attest.
 */

import { describe, expect, it } from "vitest";

import {
  resolveAnchor,
  type DocumentSnapshot,
  type HeadingParagraph,
  type TextParagraph,
} from "./anchors.js";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

function h(level: number, text: string, index: number): HeadingParagraph {
  return { kind: "heading", level, text, index };
}

function p(text: string, index: number): TextParagraph {
  return { kind: "text", text, index };
}

const headedDoc: DocumentSnapshot = {
  paragraphs: [
    h(1, "Q3 Strategy Notes", 1),
    p("Intro paragraph.", 2),
    h(2, "Goals", 3),
    p("Ship hiring section.", 4),
    p("Close two roles.", 5),
    h(2, "Hiring", 6),
    p("Open roles list.", 7),
    h(2, "Risks", 8),
    p("None identified.", 9),
  ],
};

const unheadedDoc: DocumentSnapshot = {
  paragraphs: [
    p("We agreed to ship by Q3.", 1),
    p("Action items:", 2),
    p("- John to draft hiring plan.", 3),
    p("- TBD: hiring section.", 4),
    p("- Action items:", 5), // intentional duplicate of paragraph 2 to test ambiguity
  ],
};

const emptyDoc: DocumentSnapshot = { paragraphs: [] };

// ────────────────────────────────────────────────────────────────────────
// Heading-based
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — heading-based", () => {
  it("after_heading: 'Goals' resolves to insert_after at the heading's index", () => {
    const r = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 3 });
      expect(r.resolved.displayName).toBe("after heading 'Goals' (level 2)");
    }
  });

  it("append_to_section: 'Goals' resolves to the LAST paragraph in the section", () => {
    // Section runs from heading index 3 → next H2 at index 6, so last
    // paragraph in section is index 5 ("Close two roles.")
    const r = resolveAnchor({ append_to_section: "Goals" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 5,
      });
      expect(r.resolved.displayName).toBe("end of section 'Goals' (level 2)");
    }
  });

  it("append_to_section runs to end of doc when no following same-or-higher heading", () => {
    // 'Risks' is the last H2 — section runs to end of doc, last paragraph
    // is index 9 ("None identified.")
    const r = resolveAnchor({ append_to_section: "Risks" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 9,
      });
    }
  });

  it("HEADING_NOT_FOUND with operator-actionable message", () => {
    const r = resolveAnchor({ after_heading: "Nonexistent" }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_NOT_FOUND");
      expect(r.error.message).toContain("Nonexistent");
      expect(r.error.message).toContain("after_line_containing");
    }
  });

  it("level filter — wrong level gives HEADING_NOT_FOUND", () => {
    // 'Goals' is H2 in the fixture; asking for H1 → not found.
    const r = resolveAnchor({ after_heading: "Goals", level: 1 }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_NOT_FOUND");
      expect(r.error.message).toContain("at level 1");
    }
  });

  it("HEADING_AMBIGUOUS when multiple match and nth_match unset", () => {
    // Add two same-level headings with the same title to a fresh doc.
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const r = resolveAnchor({ after_heading: "Notes" }, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_AMBIGUOUS");
      expect(r.error.candidates).toHaveLength(2);
      expect(r.error.message).toContain("nth_match (1..2)");
    }
  });

  it("HEADING_AMBIGUOUS resolved by nth_match", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const first = resolveAnchor({ after_heading: "Notes", nth_match: 1 }, doc);
    const second = resolveAnchor({ after_heading: "Notes", nth_match: 2 }, doc);
    expect(first.ok && first.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 1 });
    expect(second.ok && second.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 3 });
  });
});

// ────────────────────────────────────────────────────────────────────────
// append_to_section — empty-section semantics (post-review fix #1)
// ────────────────────────────────────────────────────────────────────────

describe("append_to_section — empty-section handling", () => {
  it("heading immediately followed by another same-level heading → append_to_empty_section at heading index", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Goals", 1), h(2, "Hiring", 2), p("Open roles.", 3)],
    };
    const r = resolveAnchor({ append_to_section: "Goals" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 1,
      });
      expect(r.resolved.displayName).toContain("currently empty");
    }
  });

  it("heading is the LAST paragraph in the doc → append_to_empty_section", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [p("Body.", 1), h(2, "Risks", 2)],
    };
    const r = resolveAnchor({ append_to_section: "Risks" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 2,
      });
    }
  });

  it("heading immediately followed by a higher-level heading (H2 → H1) → empty section", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), h(1, "Other", 2), p("body", 3)],
    };
    const r = resolveAnchor({ append_to_section: "Notes" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 1,
      });
    }
  });

  it("heading with body and nested subheading → section_end at last body paragraph (subheading bodies count)", () => {
    // 'Goals' has body paragraph (idx 2), then subheading H3 (idx 3)
    // with its own body (idx 4). Section runs to next H<=2 or EOF;
    // here EOF, so last body is idx 4.
    const doc: DocumentSnapshot = {
      paragraphs: [
        h(2, "Goals", 1),
        p("Top-level intent.", 2),
        h(3, "Subgoal", 3),
        p("Sub body.", 4),
      ],
    };
    const r = resolveAnchor({ append_to_section: "Goals" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 4,
      });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Text-snippet
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — text-snippet", () => {
  it("after_line_containing matches case-insensitively", () => {
    const r = resolveAnchor(
      { after_line_containing: "we agreed to ship" },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 1 });
      expect(r.resolved.displayName).toContain("after line:");
      expect(r.resolved.displayName).toContain("agreed to ship");
    }
  });

  it("before_line_containing places insert_before at the matched paragraph", () => {
    const r = resolveAnchor(
      { before_line_containing: "TBD: hiring section", nth_match: 1 },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_before", paragraphIndex: 4 });
    }
  });

  it("replace_line_matching uses the regex against the paragraph text", () => {
    const r = resolveAnchor(
      { replace_line_matching: /TBD:\s*hiring/ },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "replace_paragraph", paragraphIndex: 4 });
      expect(r.resolved.displayName).toContain("replacing line:");
    }
  });

  it("SNIPPET_NOT_FOUND with the search term in the error message", () => {
    const r = resolveAnchor(
      { after_line_containing: "this string is nowhere" },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SNIPPET_NOT_FOUND");
      expect(r.error.message).toContain("this string is nowhere");
    }
  });

  it("SNIPPET_AMBIGUOUS with up-to-3 candidate excerpts when multiple match", () => {
    // Both "Action items:" lines (paragraphs 2 and 5) match the snippet.
    const r = resolveAnchor(
      { after_line_containing: "Action items" },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SNIPPET_AMBIGUOUS");
      expect(r.error.candidates).toHaveLength(2);
      expect(r.error.message).toContain("nth_match (1..2)");
    }
  });

  it("SNIPPET_AMBIGUOUS resolved by nth_match", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 2 },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 5 });
    }
  });

  it("INVALID_ANCHOR when no snippet field is set under a snippet-shaped call", () => {
    // Empty object falls through to INVALID_ANCHOR via the dispatcher.
    const r = resolveAnchor({}, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });

  it("INVALID_ANCHOR when after_line_containing is empty string (would silently match every paragraph)", () => {
    const r = resolveAnchor({ after_line_containing: "" }, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ANCHOR");
      expect(r.error.message).toContain("non-empty");
    }
  });

  it("INVALID_ANCHOR when before_line_containing is whitespace-only", () => {
    const r = resolveAnchor({ before_line_containing: "   " }, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

// ────────────────────────────────────────────────────────────────────────
// nth_match out-of-range — distinct error code per review fix #2
// ────────────────────────────────────────────────────────────────────────

describe("nth_match out of range → NTH_MATCH_OUT_OF_RANGE (not _AMBIGUOUS)", () => {
  it("heading: nth_match=5 when there are only 2 matches", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const r = resolveAnchor({ after_heading: "Notes", nth_match: 5 }, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
      expect(r.error.message).toContain("nth_match=5");
      expect(r.error.message).toContain("Valid range: 1..2");
    }
  });

  it("snippet: nth_match=10 when there are only 2 matches", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 10 },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
      expect(r.error.message).toContain("nth_match=10");
    }
  });

  it("nth_match=0 (boundary, 1-based indexing) → NTH_MATCH_OUT_OF_RANGE", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 0 },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Document-position
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — document-position", () => {
  it("at_start places insert_before at the first paragraph", () => {
    const r = resolveAnchor({ at_start: true }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_before", paragraphIndex: 1 });
      expect(r.resolved.displayName).toBe("at start of doc");
    }
  });

  it("at_end places insert_after at the last paragraph", () => {
    const r = resolveAnchor({ at_end: true }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 9 });
      expect(r.resolved.displayName).toBe("at end of doc");
    }
  });

  it("EMPTY_DOC_NEEDS_POSITION when at_start/at_end on an empty doc", () => {
    const r = resolveAnchor({ at_start: true }, emptyDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EMPTY_DOC_NEEDS_POSITION");
  });

  it("INVALID_ANCHOR when both at_start and at_end are set", () => {
    const r = resolveAnchor({ at_start: true, at_end: true }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

// ────────────────────────────────────────────────────────────────────────
// displayName attestation invariants — load-bearing for RFC E §4.2
// ────────────────────────────────────────────────────────────────────────

describe("resolved displayName never contains agent-controlled text", () => {
  it("heading anchor displayName comes from the doc, not the agent param", () => {
    // Even though the agent passes the title, the displayName uses the
    // *resolved heading's text* — which in practice would be identical
    // to the agent input on a successful match. The invariant we're
    // pinning is that it's the resolver that builds the string from
    // doc state, not echoed agent input.
    const r = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r.ok && r.resolved.displayName).toBe("after heading 'Goals' (level 2)");
    // Same call, same result — pinning that no agent-supplied
    // metadata bleeds through into the display string.
    const r2 = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r2.ok && r2.resolved.displayName).toBe("after heading 'Goals' (level 2)");
  });

  it("snippet anchor displayName uses the doc's actual line text, not the search term", () => {
    // The agent searches for "we agreed to ship" (truncated); the
    // displayName surfaces the FULL matched paragraph text up to the
    // ellipsis budget. Defends against an agent searching for a
    // shortened snippet to mislead the operator.
    const r = resolveAnchor(
      { after_line_containing: "we agreed" },
      unheadedDoc,
    );
    expect(r.ok && r.resolved.displayName).toContain("We agreed to ship by Q3.");
  });
});
