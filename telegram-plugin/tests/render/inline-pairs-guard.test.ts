import { describe, it, expect } from "vitest";
import { guardAccidentalInlinePairs } from "../../render/inline-pairs-guard.js";

// Strip defusing backslashes so we can assert the reader-visible text is
// byte-identical to the original prose (the backslash is consumed by Telegram's
// parser; copy-paste yields the clean glyph).
function copyText(s: string): string {
  return s.replace(/\\([~=|])/g, "$1");
}

describe("guardAccidentalInlinePairs — NO false positives on INTENDED formatting", () => {
  // These are the hard constraint: the agent uses these DELIBERATELY. They must
  // pass through byte-for-byte untouched.
  it("leaves intended `~~strike~~` (word content) untouched", () => {
    const s = "the ~~deprecated~~ flag is gone";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves intended single-tilde `~struck~` (word content) untouched", () => {
    const s = "mark it ~struck~ for now";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves intended `==mark==` highlight untouched", () => {
    const s = "please ==highlight this== part";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves two intended `==mark==` highlights untouched", () => {
    const s = "==first== and also ==second== matter";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves intended `||spoiler||` untouched", () => {
    const s = "the twist is ||he was dead|| all along";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves two intended `||spoiler||` spans untouched", () => {
    const s = "reveal ||one|| then ||two|| slowly";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves intended `code` spans untouched (even with operators inside)", () => {
    const s = "run `x==y` and `a||b` and `~10` in the shell";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves a single intended strike of a number `~~2024~~` untouched (below threshold)", () => {
    const s = "the ~~2024~~ figure was revised";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves a lone comparison `x==y` untouched (cannot form a pair)", () => {
    const s = "the check is x==y in the loop";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves a lone approximation `~10` untouched (cannot form a pair)", () => {
    const s = "roughly ~10 items remain";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("leaves space-flanked `a == b == c` untouched (cannot open a span)", () => {
    const s = "assert a == b == c holds";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });

  it("is a strict no-op for text with none of the trigger chars", () => {
    const s = "a perfectly ordinary sentence with no specials";
    expect(guardAccidentalInlinePairs(s)).toBe(s);
  });
});

describe("guardAccidentalInlinePairs — neutralises ACCIDENTAL pairs", () => {
  it("breaks an accidental strikethrough from two approximation tildes", () => {
    const s = "trims to ~10 units, down from ~20 last week";
    const out = guardAccidentalInlinePairs(s);
    // No unescaped digit-adjacent tilde survives to open a `~…~` span.
    expect(out).not.toMatch(/(?<!\\)~(?=\$?\.?\d)/);
    expect(out).toContain("\\~10");
    expect(out).toContain("\\~20");
    // Reader-visible prose unchanged once the defuser is stripped.
    expect(copyText(out)).toBe(s);
  });

  it("breaks an accidental strike from currency-approx tildes (`~$5M` / `~$9M`)", () => {
    const s = "budget is ~$5M now, was ~$9M before";
    const out = guardAccidentalInlinePairs(s);
    expect(out).not.toMatch(/(?<!\\)~(?=\$?\.?\d)/);
    expect(copyText(out)).toBe(s);
  });

  it("breaks the inner tilde of a `~~10 ... ~~20` double-open accidental pair", () => {
    const s = "about ~~10 to ~~20 percent";
    const out = guardAccidentalInlinePairs(s);
    expect(out).not.toMatch(/(?<!\\)~(?=\$?\.?\d)/);
    expect(copyText(out)).toBe(s);
  });

  it("breaks an accidental highlight from two `==` comparison operators", () => {
    const s = "check x==y and then p==q in the guard";
    const out = guardAccidentalInlinePairs(s);
    expect(out).not.toMatch(/(?<=\w)==(?=\w)/);
    expect(out).toContain("x\\=\\=y");
    expect(out).toContain("p\\=\\=q");
    expect(copyText(out)).toBe(s);
  });

  it("breaks an accidental spoiler from two `||` logical-or operators", () => {
    const s = "when a||b and c||d both hold";
    const out = guardAccidentalInlinePairs(s);
    expect(out).not.toMatch(/(?<=\w)\|\|(?=\w)/);
    expect(out).toContain("a\\|\\|b");
    expect(out).toContain("c\\|\\|d");
    expect(copyText(out)).toBe(s);
  });

  it("never escapes operators INSIDE a code span while fixing prose ones", () => {
    const s = "prose x==y and p==q but code `m==n` stays";
    const out = guardAccidentalInlinePairs(s);
    // Prose operators neutralised…
    expect(out).toContain("x\\=\\=y");
    expect(out).toContain("p\\=\\=q");
    // …code span verbatim.
    expect(out).toContain("`m==n`");
  });
});

describe("guardAccidentalInlinePairs — idempotency", () => {
  it("guarding already-guarded tilde text is a strict no-op", () => {
    const once = guardAccidentalInlinePairs("trims to ~10 units, down from ~20 last week");
    expect(guardAccidentalInlinePairs(once)).toBe(once);
    expect(once).not.toContain("\\\\~"); // never a doubled backslash
  });

  it("guarding already-guarded `==`/`||` text is a strict no-op", () => {
    const once = guardAccidentalInlinePairs("check x==y and p==q; also a||b and c||d");
    expect(guardAccidentalInlinePairs(once)).toBe(once);
  });
});
