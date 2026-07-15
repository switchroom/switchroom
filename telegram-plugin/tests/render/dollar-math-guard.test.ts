import { describe, it, expect } from "vitest";
import { guardDollarMath } from "../../render/dollar-math-guard.js";
import { richMessage } from "../../rich-send.js";
import { computeReplyChunks } from "../../gateway/outbound-send-path.js";
import { RICH_MESSAGE_MAX_CHARS } from "../../format.js";

// Any U+1D400–U+1D7FF codepoint = a mathematical-alphanumeric (math-italic /
// math-bold) glyph — what a math renderer produces from a `$…$` span.
const MATH_GLYPH = /[\u{1D400}-\u{1D7FF}]/u;

/** Strip zero-width chars + defusing backslashes so we can assert the amount
 *  the reader copies is byte-identical to the original ASCII currency token.
 *  The wire body now flows through the composed richMessage guard, so besides
 *  the dollar defuser (`\$`) it may also carry the inline-pairs defuser (`\~`)
 *  for approximation tildes (`~$0.5M`) — strip both so the round-trip holds. */
function copyText(s: string): string {
  return s.replace(/[​⁠﻿]/g, "").replace(/\\([$~])/g, "$1");
}

describe("guardDollarMath (#3252)", () => {
  const OFFENDING =
    "acquisition ceiling is ~$0.5-0.9M but nearly all in small dealers ... is ~$150-450k";

  it("neutralises the two-dollar-amount currency string so no `$…$` span can form", () => {
    const out = guardDollarMath(OFFENDING);
    // Both currency dollars are backslash-escaped → no unescaped `$` remains to
    // open/close a math span.
    expect(out).not.toMatch(/(?<!\\)\$/);
    expect(out).toContain("\\$0.5-0.9M");
    expect(out).toContain("\\$150-450k");
  });

  it("carries no math-italic glyphs (switchroom never emits U+1D400-range)", () => {
    expect(guardDollarMath(OFFENDING)).not.toMatch(MATH_GLYPH);
    // …nor does the raw source; the guard is what keeps the WIRE bytes clean.
    expect(OFFENDING).not.toMatch(MATH_GLYPH);
  });

  it("preserves the visible amounts: stripping the defuser yields the original", () => {
    expect(copyText(guardDollarMath(OFFENDING))).toBe(OFFENDING);
  });

  it("is a strict no-op for a single `$digit` prose token", () => {
    const s = "grab a $5 coffee on the way";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("is a strict no-op when there is no `$digit` at all", () => {
    const s = "the cost is unknown but the $ sign appears twice: $ and $";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("never touches `$` inside a code span", () => {
    const s = "shell math `$x = $y` is fine and `$z = $w` too";
    // Two code spans, each with 2 `$digit`? No — non-digit. Use digits to prove
    // code is skipped even when it WOULD otherwise trigger.
    const withDigits = "compute `$1 + $2` and also `$3 + $4` inline";
    expect(guardDollarMath(s)).toBe(s);
    expect(guardDollarMath(withDigits)).toBe(withDigits);
  });

  it("escapes prose dollars but leaves an adjacent code span verbatim", () => {
    const s = "prices $10 and $20 — the var is `$PRICE = $10`";
    const out = guardDollarMath(s);
    // Prose amounts escaped:
    expect(out).toContain("\\$10 and \\$20");
    // Code span verbatim (its `$10` NOT escaped):
    expect(out).toContain("`$PRICE = $10`");
  });

  // ── F3: widened detection (trailing `$`, `$.50`, `$ ` with a bare gap) ────
  it("escapes a mix of leading- and trailing-`$` amounts (`$50 or 50$`)", () => {
    const out = guardDollarMath("It costs $50 or 50$ depending on the vendor");
    // Both dollars gone from the unescaped set → no `$…$` pair can form.
    expect(out).not.toMatch(/(?<!\\)\$/);
    expect(out).toContain("\\$50 or 50\\$");
  });

  it("escapes when one dollar is bare (`$10 today (down from $ yesterday)`)", () => {
    const out = guardDollarMath("$10 today (down from $ yesterday)");
    expect(out).not.toMatch(/(?<!\\)\$/);
  });

  it("escapes a `$.50` amount whose `$` is not digit-adjacent by one char", () => {
    const out = guardDollarMath("$.50 here and $5 there");
    expect(out).not.toMatch(/(?<!\\)\$/);
    expect(out).toContain("\\$.50 here and \\$5 there");
  });

  it("leaves two non-currency `$` (shell-var prose) untouched — no false positive", () => {
    const s = "use $foo and $bar as the two variables";
    expect(guardDollarMath(s)).toBe(s);
  });

  // ── F5: idempotent — running the guard twice never doubles the backslash ──
  it("is idempotent: guarding already-guarded text is a strict no-op", () => {
    const once = guardDollarMath(OFFENDING);
    expect(guardDollarMath(once)).toBe(once);
    expect(once).not.toContain("\\\\$"); // never a doubled `\\$`
  });
});

// F1/F2 regression: exercise the ACTUAL reply pipe. The `reply` tool's final
// answer flows executeReply → computeReplyChunks → sendReplyChunks →
// richMessage(chunk). `richMessage` is the single wire seam the guard now lives
// in; these assertions FAIL against the pre-fix code (bare `{ markdown }` wrap,
// no guard) and pass after. We drive the real `computeReplyChunks` output
// through the real `richMessage`, not `guardDollarMath` in isolation.
describe("reply-path integration (#3252 F1/F2)", () => {
  const OFFENDING =
    "acquisition ceiling is ~$0.5-0.9M but nearly all in small dealers ... is ~$150-450k";

  it("richMessage() escapes the `$…$` pair on the markdown wire body", () => {
    const wire = richMessage(OFFENDING);
    // The bytes handed to sendRichMessage/editMessageText carry no unescaped `$`.
    expect(wire.markdown).not.toMatch(/(?<!\\)\$/);
    expect(wire.markdown).not.toMatch(MATH_GLYPH);
    // Reader-visible amounts intact once the defuser is stripped.
    expect(copyText(wire.markdown)).toBe(OFFENDING);
  });

  it("the full computeReplyChunks → richMessage reply pipe emits no unescaped `$`", () => {
    // Exactly what executeReply feeds sendReplyChunks for a non-literal reply.
    const chunks = computeReplyChunks({
      effectiveText: OFFENDING,
      literalText: false,
      limit: RICH_MESSAGE_MAX_CHARS,
      chunkMode: "newline",
    });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const wire = richMessage(chunk); // sendReplyChunks wraps each chunk this way
      expect(wire.markdown).not.toMatch(/(?<!\\)\$/);
      expect(wire.markdown).not.toMatch(MATH_GLYPH);
    }
  });

  it("a single-amount reply is left with its dollar untouched on the wire", () => {
    const wire = richMessage("the retainer is $2500 per month");
    expect(wire.markdown).toContain("$2500");
    expect(wire.markdown).not.toContain("\\$2500");
  });
});
