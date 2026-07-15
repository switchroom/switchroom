import { describe, it, expect } from "vitest";
import { guardAccidentalBlockConstructs } from "../../render/line-start-guard.js";

/** Strip the defusing backslashes so we can assert the reader-visible text is
 *  byte-identical to the original prose (Telegram consumes the `\`). */
function copyText(s: string): string {
  return s.replace(/\\([>.)])/g, "$1");
}

describe("guardAccidentalBlockConstructs (#3252) — INTENDED formatting is never touched", () => {
  // ── Headings: deferred entirely, must pass through untouched ──
  it("leaves an intended `# ` heading untouched (deferred family)", () => {
    const s = "# Project status\nAll green.";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `## `/`### ` sub-headings untouched", () => {
    const s = "## Section\n### Subsection\nbody";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `#1` (no space, not a GFM heading) untouched — Telegram renders it literally", () => {
    const s = "#1 priority is latency";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `# of items` untouched — deferred (indistinguishable from a heading)", () => {
    const s = "# of items in the cart";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Intended blockquotes: `> ` with a space, never touched ──
  it("leaves an intended `> quoted` blockquote untouched", () => {
    const s = "> This is a real quote\n> spanning two lines";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `> 50% of users` untouched — spaced form is a valid/intended blockquote", () => {
    const s = "> 50% of users prefer dark mode";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Bullet lists: deferred entirely, never touched ──
  it("leaves `- ` bullets untouched (deferred family)", () => {
    const s = "- first item\n- second item\n- 5 apples";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `* ` and `+ ` bullets untouched", () => {
    const s = "* star bullet\n+ plus bullet";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `- 5 degrees` untouched — ambiguous with a bullet, deferred", () => {
    const s = "- 5 degrees below freezing";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Ordered lists: small numbers are real lists, never touched ──
  it("leaves a real `1.`/`2.`/`3.` numbered list untouched", () => {
    const s = "1. First we plan\n2. Then we build\n3. Finally we ship";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a 2–3 digit list marker (`42.`, `100.`) untouched — deferred", () => {
    const s = "42. answer\n100. century";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a decimal `3.14` untouched (no space after dot => not a list)", () => {
    const s = "3.14 is pi and 2.71 is e";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Non-triggering prose ──
  it("is a strict no-op for ordinary prose with no line-start triggers", () => {
    const s = "just a normal sentence about the weather today";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });
});

describe("guardAccidentalBlockConstructs (#3252) — accidental constructs ARE escaped", () => {
  it("escapes a line-start `>2x` comparison (accidental blockquote)", () => {
    const out = guardAccidentalBlockConstructs(">2x faster than before");
    expect(out).toBe("\\>2x faster than before");
    expect(copyText(out)).toBe(">2x faster than before");
  });

  it("escapes a line-start `>50%` comparison", () => {
    const out = guardAccidentalBlockConstructs(">50% of the budget");
    expect(out).toBe("\\>50% of the budget");
  });

  it("escapes a line-start `>=3` comparison", () => {
    const out = guardAccidentalBlockConstructs(">=3 retries required");
    expect(out).toBe("\\>=3 retries required");
  });

  it("escapes an accidental blockquote only on the offending line, mid-paragraph", () => {
    const s = "Latency improved.\n>2x faster now\nShipping today.";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe("Latency improved.\n\\>2x faster now\nShipping today.");
  });

  it("escapes a 4+ digit year promoted to an ordered-list item (`2026. was`)", () => {
    const out = guardAccidentalBlockConstructs("2026. was a great year for the team");
    expect(out).toBe("2026\\. was a great year for the team");
    expect(copyText(out)).toBe("2026. was a great year for the team");
  });

  it("escapes a `1999) ` year with the paren delimiter", () => {
    const out = guardAccidentalBlockConstructs("1999) marked the dot-com peak");
    expect(out).toBe("1999\\) marked the dot-com peak");
  });

  it("escapes the accidental ordered-list line only, inside a paragraph", () => {
    const s = "Consider the timeline.\n2026. was pivotal\nThat is all.";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe("Consider the timeline.\n2026\\. was pivotal\nThat is all.");
  });
});

describe("guardAccidentalBlockConstructs (#3252) — code / indent safety", () => {
  it("never touches a `>` at the start of a FENCED code block line", () => {
    const s = "```\n>2x in shell\n2026. code year\n```";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("never touches a `>` inside an inline code span", () => {
    const s = "use `>2x` in the expression";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("does not treat a prose `>` that begins mid-line (after a code span) as a line start", () => {
    // The `>5` is NOT at a real line start (an inline code span precedes it on
    // the same line), so it must be left alone.
    const s = "the value `x` >5 always";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a 4-space indented (code) line untouched", () => {
    const s = "    >2x indented code\n    2026. also code";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("still escapes a construct indented 1–3 spaces (valid block context)", () => {
    const out = guardAccidentalBlockConstructs("  >2x slightly indented");
    expect(out).toBe("  \\>2x slightly indented");
  });
});

describe("guardAccidentalBlockConstructs (#3252) — idempotency & no-op signal", () => {
  it("is idempotent: guarding already-guarded text is a strict no-op", () => {
    const once = guardAccidentalBlockConstructs(">2x and\n2026. year");
    expect(guardAccidentalBlockConstructs(once)).toBe(once);
    expect(once).not.toContain("\\\\"); // never a doubled backslash
  });

  it("short-circuits to a strict no-op when there is no `>` and no 4+ digit marker", () => {
    const s = "1. a\n2. b\n- c\n# d\n> e";
    // All intended constructs; contains `>` so it runs, but produces no change.
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });
});
