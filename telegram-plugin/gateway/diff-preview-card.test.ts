/**
 * Tests for the Telegram diff-preview card renderer — RFC E §4.2.
 */

import { describe, expect, it } from "vitest";
import { InlineKeyboard } from "grammy";

import { buildDiffPreview } from "../../src/drive/diff-preview.js";
import type { DiffPreviewInput } from "../../src/drive/diff-preview.js";
import { buildDiffPreviewCard } from "./diff-preview-card.js";

/** Pull row-major button shape out of grammy's InlineKeyboard. */
function rows(kb: InlineKeyboard): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
  return kb.inline_keyboard.map((row) =>
    row.map((b) => ({
      text: b.text,
      ...("callback_data" in b ? { callback_data: b.callback_data } : {}),
      ...("url" in b ? { url: b.url } : {}),
    })),
  );
}

function baseInput(overrides: Partial<DiffPreviewInput> = {}): DiffPreviewInput {
  return {
    agentName: "klanker",
    docTitle: "Q3 Strategy Notes",
    fileId: "DOC1",
    mimeType: "application/vnd.google-apps.document",
    resolvedAnchor: {
      op: { kind: "insert_after", paragraphIndex: 4 },
      displayName: "after heading 'Goals' (level 2)",
    },
    metrics: { linesAdded: 47, linesRemoved: 0 },
    mode: "suggest",
    ...overrides,
  };
}

describe("buildDiffPreviewCard — suggest mode (default)", () => {
  it("emits the wrapper-attested body + all four buttons in the RFC layout", () => {
    const preview = buildDiffPreview(baseInput({ agentSummary: "Added Hiring section" }));
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
      writeRequestId: "11223344112233441122334411223344",
    });

    // Body: title bold + all preview lines.
    expect(card.text).toContain("<b>");
    expect(card.text).toContain("klanker");
    expect(card.text).toContain("Q3 Strategy Notes");
    expect(card.text).toContain("📍 after heading 'Goals' (level 2)");
    expect(card.text).toContain("+47");
    expect(card.text).toContain("💬");
    expect(card.text).toContain("Added Hiring section");

    const r = rows(card.reply_markup);
    // Row 1: [Open in Drive] [Apply as suggestion]
    expect(r[0]?.[0]?.text).toBe("📖 Open in Drive");
    expect(r[0]?.[0]?.url).toBe("https://docs.google.com/document/d/DOC1/edit");
    expect(r[0]?.[1]?.text).toBe("✅ Apply as suggestion");
    expect(r[0]?.[1]?.callback_data).toBe("apv:aabbccddaabbccddaabbccddaabbccdd:once");
    // Row 2: [Apply directly] [Cancel]
    expect(r[1]?.[0]?.text).toBe("⚠ Apply directly");
    expect(r[1]?.[0]?.callback_data).toBe("apv:11223344112233441122334411223344:once");
    expect(r[1]?.[1]?.text).toBe("🚫 Cancel");
    expect(r[1]?.[1]?.callback_data).toBe("apv:aabbccddaabbccddaabbccddaabbccdd:deny");
  });

  it("hides 'Apply directly' when writeRequestId is undefined", () => {
    const preview = buildDiffPreview(baseInput());
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
    });
    const flat = rows(card.reply_markup).flat();
    expect(flat.find((b) => b.text === "⚠ Apply directly")).toBeUndefined();
    // The other three buttons still present.
    expect(flat.find((b) => b.text === "📖 Open in Drive")).toBeDefined();
    expect(flat.find((b) => b.text === "✅ Apply as suggestion")).toBeDefined();
    expect(flat.find((b) => b.text === "🚫 Cancel")).toBeDefined();
  });
});

describe("buildDiffPreviewCard — write mode (opt-in via expand)", () => {
  it("only emits Apply-directly + Open-in-Drive + Cancel (no suggest button)", () => {
    const preview = buildDiffPreview(baseInput({ mode: "write" }));
    const card = buildDiffPreviewCard({
      preview,
      // In write-mode the suggest id is still needed for the Cancel
      // callback's deny channel — semantically Cancel is "don't grant
      // either scope" but reusing the suggest id keeps the existing
      // approval-callback handler stateless.
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
      writeRequestId: "11223344112233441122334411223344",
    });

    const r = rows(card.reply_markup);
    const flat = r.flat();
    expect(flat.find((b) => b.text === "✅ Apply as suggestion")).toBeUndefined();
    const directly = flat.find((b) => b.text === "⚠ Apply directly");
    expect(directly).toBeDefined();
    expect(directly?.callback_data).toBe("apv:11223344112233441122334411223344:once");
    // Title icon swaps to ⚠.
    expect(card.text).toContain("⚠");
  });
});

describe("buildDiffPreviewCard — input validation", () => {
  it("throws on a malformed suggestRequestId", () => {
    const preview = buildDiffPreview(baseInput());
    expect(() =>
      buildDiffPreviewCard({ preview, suggestRequestId: "not-hex" }),
    ).toThrow(/32 hex chars/);
  });

  it("throws on a malformed writeRequestId", () => {
    const preview = buildDiffPreview(baseInput());
    expect(() =>
      buildDiffPreviewCard({
        preview,
        suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
        writeRequestId: "ABCDEF01", // wrong case
      }),
    ).toThrow(/32 hex chars/);
  });
});

describe("buildDiffPreviewCard — fragility guards", () => {
  it("drops the Open-in-Drive button when fileId is the 'pending-create' sentinel", () => {
    // create_doc prep emits "pending-create" as a placeholder fileId
    // (the doc doesn't exist yet). The renderer must NOT emit a Drive
    // URL pointing at a nonexistent doc.
    const preview = buildDiffPreview(
      baseInput({ fileId: "pending-create" }),
    );
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
    });
    const flat = rows(card.reply_markup).flat();
    expect(flat.find((b) => b.text === "📖 Open in Drive")).toBeUndefined();
    // Apply buttons still present — the doc creation flow is still actionable.
    expect(flat.find((b) => b.text === "✅ Apply as suggestion")).toBeDefined();
  });

  it("HTML-escapes title + lines (no markup injection from doc names)", () => {
    const preview = buildDiffPreview(
      baseInput({ docTitle: "<script>alert(1)</script>" }),
    );
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
    });
    expect(card.text).not.toContain("<script>");
    expect(card.text).toContain("&lt;script&gt;");
  });

  it("HTML-escapes the agent-supplied summary", () => {
    const preview = buildDiffPreview(
      baseInput({ agentSummary: "Hi <b>bold</b> & <i>tags</i>" }),
    );
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
    });
    expect(card.text).not.toMatch(/💬.*<b>/);
    expect(card.text).toContain("&lt;b&gt;");
  });
});

describe("buildDiffPreviewCard — audit fidelity", () => {
  it("preview audit row matches what the user sees on the card", () => {
    const input = baseInput({ agentSummary: "Added the Hiring section" });
    const preview = buildDiffPreview(input);
    const card = buildDiffPreviewCard({
      preview,
      suggestRequestId: "aabbccddaabbccddaabbccddaabbccdd",
      writeRequestId: "11223344112233441122334411223344",
    });
    // The audit row captures both wrapper truth + agent framing,
    // exactly as surfaced on the card.
    expect(preview.audit.wrapperAttested.anchorDisplayName).toBe(
      "after heading 'Goals' (level 2)",
    );
    expect(preview.audit.wrapperAttested.linesAdded).toBe(47);
    expect(preview.audit.agentSupplied.summary).toBe("Added the Hiring section");
    // Card body contains both.
    expect(card.text).toContain("after heading 'Goals' (level 2)");
    expect(card.text).toContain("Added the Hiring section");
  });
});
