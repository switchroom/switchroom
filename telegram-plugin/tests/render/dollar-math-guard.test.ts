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

describe("guardDollarMath — link / table awareness (findings 1 & 3)", () => {
  it("does NOT escape a `$` inside a markdown link destination", () => {
    // Two dollars + a digit-adjacent one would normally arm the guard, but both
    // live in URL query strings → structural → left verbatim.
    const s = "buy [x](https://x.io?price=$5) or [y](https://y.io?price=$9)";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("does NOT escape `$` inside a real table's cells", () => {
    const s = ["| Item | Cost |", "| --- | --- |", "| a | $5 |", "| b | $9 |"].join("\n");
    expect(guardDollarMath(s)).toBe(s);
  });

  it("STILL escapes two currency dollars in ordinary prose", () => {
    const out = guardDollarMath("spend was $5 today and $9 tomorrow");
    expect(out).not.toMatch(/(?<!\\)\$/);
  });
});

describe("guardDollarMath — intentional math spans are exempt (wire-verified 2026-08-13)", () => {
  it("never escapes a compact `$…$` math span", () => {
    // Telegram renders `$x^2+y^2$` as a native mathematical_expression node;
    // escaping it destroys a SUPPORTED construct. On the pre-fix guard this
    // input came back as `inline \$x^2+y^2\$ done`.
    const s = "inline $x^2+y^2$ done";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("math span dollars do not count toward the 2+ arming threshold", () => {
    // Only ONE prose `$` outside the math span → can never pair → untouched.
    const s = "solve $x^2+y^2$ for the $BUDGET case";
    expect(guardDollarMath(s)).toBe(s);
  });

  it("still escapes currency in the SAME message as an exempt math span", () => {
    const out = guardDollarMath("sum $x^2+y^2$ costs $5 and $10");
    expect(out).toContain("$x^2+y^2$");
    expect(out).toContain("\\$5");
    expect(out).toContain("\\$10");
  });

  it("a currency-shaped compact pair (`$5M-$10M`) is NOT treated as math", () => {
    // The `$5M-$` inner run is digits/magnitude punctuation only — two
    // adjacent amounts, the exact #3252 accident. Must still be escaped.
    const out = guardDollarMath("the range is $5M-$10M this year");
    expect(out).not.toMatch(/(?<!\\)\$/);
  });

  it("spaced `$…$` spans are NOT exempt (indistinguishable from currency prose)", () => {
    // Documented residual: `$a + b$` cannot be told apart from two stray
    // currency signs, so when a currency signal arms the guard it is escaped
    // (renders as literal text — legible, not broken).
    const out = guardDollarMath("we know $a + b$ plus $5 fees");
    expect(out).not.toMatch(/(?<!\\)\$/);
  });

  it("is idempotent with a math span present", () => {
    const once = guardDollarMath("sum $x^2+y^2$ costs $5 and $10");
    expect(guardDollarMath(once)).toBe(once);
  });
});
