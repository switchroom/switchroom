import { describe, it, expect } from "vitest";
import { guardAccidentalFormatting } from "../../rich-send.js";

// Composed-seam rich-corpus regression (#3465).
//
// The individual guards (heading / block-construct / emphasis / inline-pair /
// dollar) each have focused tests, and guard-composition.test.ts proves pairs
// of guards don't interfere. What was MISSING is a single assertion that a
// FULL, representative rich-formatting corpus — every construct Ken's
// rich-formatting directive relies on, together in one message — survives the
// REAL universal wire seam `guardAccidentalFormatting` (rich-send.ts)
// BYTE-IDENTICAL. That is the property the whole conservative-guard family
// exists to protect: intended formatting must NEVER be restricted or corrupted.
// This test pins it against regression from any future guard that over-reaches.
//
// The corpus deliberately contains NO line-leading glued-`#` (e.g. `#3460`), so
// under the current guards it must be left completely untouched. The second
// suite proves that untouched-ness is the guards being CORRECT, not the guards
// being disabled: a line-leading `#3460` in the same corpus position IS escaped.

/** One representative message carrying, together: `**bold**`, `_italic_`,
 *  `~~strike~~`, inline `code`, a fenced block, a `[link](url#frag)`, a `>`
 *  blockquote, an unordered list, an ordered list, and real `# `/`## ` headings.
 *  Every construct is in its INTENDED, well-formed shape — none matches a guard's
 *  accidental-signal — so the whole thing is expected to pass through verbatim. */
const RICH_CORPUS = [
  "# Release notes",
  "## Highlights",
  "Shipped **bold wins** and some _italic nuance_ this cycle.",
  "The old flag is ~~deprecated~~ now.",
  "Call `guardAccidentalFormatting` at the seam.",
  "",
  "```ts",
  "const x = renderRich(markdown)",
  "return x",
  "```",
  "",
  "See the [rendering guide](https://ex.com/a#frag) for details.",
  "",
  "> This is a genuine blockquote from the design note.",
  "",
  "Unordered:",
  "- first point",
  "- second point",
  "",
  "Ordered:",
  "1. plan",
  "2. build",
  "3. ship",
].join("\n");

describe("guardAccidentalFormatting — full rich corpus passes the seam byte-identical (#3465)", () => {
  it("leaves a complete intended-formatting corpus completely untouched", () => {
    expect(guardAccidentalFormatting(RICH_CORPUS)).toBe(RICH_CORPUS);
  });

  it("is idempotent on the rich corpus (seam re-application is a strict no-op)", () => {
    const once = guardAccidentalFormatting(RICH_CORPUS);
    expect(guardAccidentalFormatting(once)).toBe(once);
  });
});

describe("guardAccidentalFormatting — the untouched result is the guard working, not disabled (#3465)", () => {
  it("STILL escapes a line-leading `#3460` present in the same corpus", () => {
    // Inject an accidental Telegram-only heading (`#3460`, glued to a digit, no
    // space) into the corpus. The seam MUST escape it — proving the byte-identical
    // pass above is the guard correctly finding no accidental signal, not the
    // guard being a no-op / kill-switched.
    const corpusWithGluedHash = RICH_CORPUS + "\n#3460 is the tracking issue";
    const out = guardAccidentalFormatting(corpusWithGluedHash);
    // The rest of the corpus is unchanged; only the glued hash is escaped.
    expect(out).toBe(RICH_CORPUS + "\n\\#3460 is the tracking issue");
    // And the reader-visible text (backslash consumed by Telegram) is intact.
    expect(out.replace(/\\#/g, "#")).toBe(corpusWithGluedHash);
  });
});
