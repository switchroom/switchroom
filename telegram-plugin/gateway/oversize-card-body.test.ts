/**
 * Tests for the shared truncateRawToFit helper (#1767).
 *
 * Covers:
 *   - No-op when the rendered body already fits.
 *   - Binary-search shrinks the raw slice; result fits under `cap`.
 *   - Line-snap when newlines exist; sentinel appended.
 *   - Char-truncation fallback when a single unbroken line exceeds
 *     the budget (no `\n` to snap to).
 *   - Defensive hard-cut when even the framing-alone overflows.
 */

import { describe, it, expect } from "vitest";
import { truncateRawToFit } from "./oversize-card-body.js";

const SENTINEL = "\n[… truncated]";

function frame(escapeMultiplier: number) {
  // Render closure that mimics a `<pre>`-wrapped HTML-escaped body
  // where every `&` inflates `escapeMultiplier`-fold.
  return (raw: string) => {
    const inflated = raw.replace(/&/g, "&".repeat(escapeMultiplier));
    return `<b>Hdr</b>\n<pre>${inflated}</pre>`;
  };
}

describe("truncateRawToFit", () => {
  it("returns the full body unchanged when it fits under cap", () => {
    const raw = "small content";
    const { body, truncated } = truncateRawToFit({
      raw,
      render: (s) => `<pre>${s}</pre>`,
      cap: 100,
      sentinel: SENTINEL,
    });
    expect(truncated).toBe(false);
    expect(body).toBe("<pre>small content</pre>");
  });

  it("shrinks raw via binary-search until the rendered body fits the cap (5x escape inflation)", () => {
    const raw = "&".repeat(2000); // 2000 chars raw, 10000 after 5x inflate
    const { body, truncated } = truncateRawToFit({
      raw,
      render: frame(5),
      cap: 1000,
      sentinel: SENTINEL,
    });
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(1000);
    expect(body).toContain("truncated");
  });

  it("snaps to the last newline within the chosen raw prefix (no mid-line cut)", () => {
    const raw = ["line-a", "line-b", "line-c", "line-d", "line-e"]
      .map((l) => l.repeat(50))
      .join("\n");
    const { body, truncated } = truncateRawToFit({
      raw,
      render: (s) => `<pre>${s}</pre>`,
      cap: 600,
      sentinel: SENTINEL,
    });
    expect(truncated).toBe(true);
    // The portion before the sentinel must end at a complete line —
    // no partial `line-?` suffix mid-word.
    const beforeSentinel = body.slice(
      0,
      body.length - SENTINEL.length - "</pre>".length,
    );
    // Every line in the source repeated its label 50x — assert the
    // tail of the kept content ends with a full repeated block, not
    // a chopped one. Easiest check: the body must not end mid-word
    // like `line-` (the dash followed by no letter).
    expect(beforeSentinel).not.toMatch(/line-$/);
  });

  it("falls through to char-truncation when a single unbroken line exceeds cap", () => {
    const raw = "x".repeat(5000); // no newlines at all
    const { body, truncated } = truncateRawToFit({
      raw,
      render: (s) => `<pre>${s}</pre>`,
      cap: 500,
      sentinel: SENTINEL,
    });
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(500);
    // Some of the line content survives — the helper shouldn't
    // collapse to "<pre>" + sentinel only.
    expect(body).toMatch(/x{100,}/);
    expect(body).toContain("truncated");
  });

  it("when caller passes already-escaped raw + identity render on a single long line, char-truncation still bounds output (call-site contract is documented)", () => {
    // #1767 review: documents the load-bearing contract — the helper's
    // `raw` field is per-doc spec pre-escape text. The drive-write
    // call site violates that contract (passes escaped card text with
    // identity render) which is SAFE only because intake clipping in
    // buildDiffPreview keeps inputs short enough that the char-
    // truncation fallback never fires. This test pins the worst-case
    // behavior: even with entity-laden raw, the output respects the
    // cap (it may bisect an entity visually, but length is bounded).
    const raw = "&amp;".repeat(2000); // 10000 chars, no newlines
    const { body, truncated } = truncateRawToFit({
      raw,
      render: (s) => s, // identity render — call-site contract violation
      cap: 500,
      sentinel: SENTINEL,
    });
    expect(truncated).toBe(true);
    // Length is bounded — the load-bearing safety property.
    expect(body.length).toBeLessThanOrEqual(500);
  });

  it("hard-cuts at hardLimit when framing alone overflows (defensive)", () => {
    // Framing-alone is 5000 chars (way past cap), and the renderer
    // ignores its input — so no slice of raw can ever fit. The
    // helper should hard-cut to hardLimit rather than loop forever.
    const huge = "Z".repeat(5000);
    const { body, truncated } = truncateRawToFit({
      raw: "ignored",
      render: () => huge,
      cap: 1000,
      sentinel: SENTINEL,
      hardLimit: 1100,
    });
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(1100);
  });
});
