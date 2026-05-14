/**
 * Tests for the diff-preview builder — RFC E §4.2.
 *
 * Pinning the load-bearing security invariant: wrapper-attested
 * fields appear on the card alongside (and visually distinct from)
 * the agent-supplied summary, so the user can sanity-check intent.
 */

import { describe, expect, it } from "vitest";

import { buildDiffPreview, type DiffPreviewInput } from "./diff-preview.js";
import { type ResolvedAnchor } from "./anchors.js";

const sampleAnchor: ResolvedAnchor = {
  op: { kind: "insert_after", paragraphIndex: 3 },
  displayName: "after heading 'Goals' (level 2)",
};

function baseInput(overrides: Partial<DiffPreviewInput> = {}): DiffPreviewInput {
  return {
    agentName: "klanker",
    docTitle: "Q3 Strategy Notes",
    fileId: "1abcDEFxyz",
    mimeType: "application/vnd.google-apps.document",
    resolvedAnchor: sampleAnchor,
    metrics: { linesAdded: 47, linesRemoved: 0 },
    agentSummary: "Added Hiring section after 'Goals'",
    mode: "suggest",
    ...overrides,
  };
}

describe("buildDiffPreview — title + body shape", () => {
  it("renders the RFC §4.2 mockup shape for a suggesting edit", () => {
    const p = buildDiffPreview(baseInput());
    expect(p.title).toBe('✏️ klanker wants to add to "Q3 Strategy Notes"');
    expect(p.lines).toHaveLength(3);
    expect(p.lines[0].text).toBe("📍 after heading 'Goals' (level 2)");
    expect(p.lines[1].text).toBe("+47 lines / -0 lines");
    expect(p.lines[2].text).toBe(`💬 "Added Hiring section after 'Goals'"`);
  });

  it("uses ⚠ icon and 'wants to write to' verb in write mode", () => {
    const p = buildDiffPreview(baseInput({ mode: "write" }));
    expect(p.title).toBe('⚠ klanker wants to write to "Q3 Strategy Notes"');
  });

  it("omits the agent-summary line when no summary supplied", () => {
    const p = buildDiffPreview(baseInput({ agentSummary: undefined }));
    expect(p.lines).toHaveLength(2);
    expect(p.lines.find((l) => l.text.startsWith("💬"))).toBeUndefined();
  });

  it("omits the agent-summary line when summary is whitespace-only", () => {
    const p = buildDiffPreview(baseInput({ agentSummary: "   \n " }));
    expect(p.lines).toHaveLength(2);
  });
});

describe("buildDiffPreview — wrapperAttested invariant (RFC §4.2 load-bearing)", () => {
  it("📍 anchor line and line-count line are wrapperAttested=true", () => {
    const p = buildDiffPreview(baseInput());
    expect(p.lines[0]).toMatchObject({
      wrapperAttested: true,
      text: expect.stringMatching(/^📍/),
    });
    expect(p.lines[1]).toMatchObject({
      wrapperAttested: true,
      text: expect.stringMatching(/^\+\d+ lines/),
    });
  });

  it("💬 agent-summary line is wrapperAttested=false", () => {
    const p = buildDiffPreview(baseInput());
    const summaryLine = p.lines.find((l) => l.text.startsWith("💬"));
    expect(summaryLine?.wrapperAttested).toBe(false);
  });

  it("audit payload separates wrapper-attested fields from agent-supplied", () => {
    const p = buildDiffPreview(baseInput());
    expect(p.audit.wrapperAttested).toEqual({
      anchorDisplayName: "after heading 'Goals' (level 2)",
      linesAdded: 47,
      linesRemoved: 0,
      docTitle: "Q3 Strategy Notes",
      fileId: "1abcDEFxyz",
    });
    expect(p.audit.agentSupplied.summary).toBe("Added Hiring section after 'Goals'");
  });

  it("audit.agentSupplied.summary is null when summary absent (not undefined or empty string)", () => {
    const p = buildDiffPreview(baseInput({ agentSummary: undefined }));
    expect(p.audit.agentSupplied.summary).toBe(null);
  });

  it("anchor displayName comes from the resolver, not from any agent input", () => {
    // Even if some hypothetical future caller passed agent-controlled
    // anchor metadata, the displayName ends up on the card from the
    // resolved anchor alone. Pin that the only string from input that
    // bleeds into the wrapperAttested anchor line is resolvedAnchor.displayName.
    const p = buildDiffPreview(
      baseInput({
        agentSummary: "📍 after heading 'Risks' SUMMARY ATTACK",
      }),
    );
    expect(p.lines[0].text).toBe("📍 after heading 'Goals' (level 2)");
    // Summary still shows but distinctly separated and prefixed 💬,
    // so the operator visually distinguishes the agent's framing.
    const summaryLine = p.lines.find((l) => l.wrapperAttested === false);
    expect(summaryLine?.text).toContain("📍 after heading 'Risks' SUMMARY ATTACK");
  });
});

describe("buildDiffPreview — buttons", () => {
  it("suggest mode: Open in Drive + Apply as suggestion (primary) + Apply directly + Cancel", () => {
    const p = buildDiffPreview(baseInput());
    expect(p.buttons.map((b) => b.action)).toEqual([
      "open_in_drive",
      "apply_suggestion",
      "apply_directly",
      "cancel",
    ]);
    const primary = p.buttons.find((b) => b.action === "apply_suggestion");
    expect(primary?.emphasis).toBe("primary");
  });

  it("write mode: Open in Drive + Apply directly (destructive) + Cancel — no Apply-as-suggestion", () => {
    const p = buildDiffPreview(baseInput({ mode: "write" }));
    expect(p.buttons.map((b) => b.action)).toEqual([
      "open_in_drive",
      "apply_directly",
      "cancel",
    ]);
    const direct = p.buttons.find((b) => b.action === "apply_directly");
    expect(direct?.emphasis).toBe("destructive");
  });

  it("Open-in-Drive button URL routes by mimeType", () => {
    const docs = buildDiffPreview(baseInput({ mimeType: "application/vnd.google-apps.document" }));
    expect(docs.buttons[0].url).toContain("docs.google.com/document/");

    const sheet = buildDiffPreview(baseInput({ mimeType: "application/vnd.google-apps.spreadsheet" }));
    expect(sheet.buttons[0].url).toContain("docs.google.com/spreadsheets/");

    const generic = buildDiffPreview(baseInput({ mimeType: "application/pdf" }));
    expect(generic.buttons[0].url).toContain("drive.google.com/file/");
  });

  it("Open-in-Drive carries discussionId when supplied (suggestion-write deep link)", () => {
    const p = buildDiffPreview(
      baseInput({ mode: "suggest", discussionId: "thread-xyz" }),
    );
    expect(p.buttons[0].url).toContain("?disco=thread-xyz");
  });
});

describe("buildDiffPreview — agent-supplied summary sanitization", () => {
  it("collapses newlines in the summary so the card stays one-line", () => {
    const p = buildDiffPreview(
      baseInput({ agentSummary: "Line 1\nLine 2\r\nLine 3" }),
    );
    const summaryLine = p.lines.find((l) => !l.wrapperAttested);
    expect(summaryLine?.text).not.toContain("\n");
    expect(summaryLine?.text).toContain("Line 1");
    expect(summaryLine?.text).toContain("Line 3");
  });

  it("replaces embedded quotes so the card's quoting stays balanced", () => {
    const p = buildDiffPreview(
      baseInput({ agentSummary: 'He said "hello" then "goodbye"' }),
    );
    const summaryLine = p.lines.find((l) => !l.wrapperAttested);
    // The outer quotes should remain; inner quotes get replaced.
    expect(summaryLine?.text).toBe(`💬 "He said 'hello' then 'goodbye'"`);
  });

  it("truncates very long summaries with an ellipsis", () => {
    const long = "x".repeat(500);
    const p = buildDiffPreview(baseInput({ agentSummary: long }));
    const summaryLine = p.lines.find((l) => !l.wrapperAttested);
    expect(summaryLine?.text.length).toBeLessThan(220); // 200 cap + "…" + quoting
    expect(summaryLine?.text).toContain("…");
  });

  it("audit summary preserves the full untruncated value (post-hoc review needs the raw)", () => {
    const long = "x".repeat(500);
    const p = buildDiffPreview(baseInput({ agentSummary: long }));
    expect(p.audit.agentSupplied.summary).toBe(long);
  });
});

describe("buildDiffPreview — line-count formatting", () => {
  it("always shows both +added and -removed (zero is explicit, not omitted)", () => {
    const noAdds = buildDiffPreview(
      baseInput({ metrics: { linesAdded: 0, linesRemoved: 12 } }),
    );
    expect(noAdds.lines[1].text).toBe("+0 lines / -12 lines");

    const noRemoves = buildDiffPreview(
      baseInput({ metrics: { linesAdded: 5, linesRemoved: 0 } }),
    );
    expect(noRemoves.lines[1].text).toBe("+5 lines / -0 lines");
  });
});

describe("buildDiffPreview — input validation", () => {
  it("throws on empty agentName", () => {
    expect(() => buildDiffPreview(baseInput({ agentName: "" }))).toThrow(/agentName/);
  });

  it("throws on empty docTitle", () => {
    expect(() => buildDiffPreview(baseInput({ docTitle: "" }))).toThrow(/docTitle/);
  });

  it("throws on negative line counts (wrapper bug guard)", () => {
    expect(() =>
      buildDiffPreview(baseInput({ metrics: { linesAdded: -1, linesRemoved: 0 } })),
    ).toThrow(/non-negative/);
  });

  it("throws on non-integer line counts", () => {
    expect(() =>
      buildDiffPreview(baseInput({ metrics: { linesAdded: 1.5, linesRemoved: 0 } })),
    ).toThrow(/integer/);
  });
});
