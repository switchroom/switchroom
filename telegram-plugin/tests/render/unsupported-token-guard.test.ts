import { describe, it, expect } from "vitest";
import { guardUnsupportedTokens } from "../../render/unsupported-token-guard.js";
import { richMessage } from "../../rich-send.js";

describe("guardUnsupportedTokens — deterministic send-time repair", () => {
  // ── Natively-supported constructs pass through BYTE-IDENTICAL ────────────
  // Wire-verified 2026-08-13: raw sendRichMessage probes showed `<details>`,
  // footnotes, `<sub>`/`<sup>`/`<u>`, `<aside>`, `tg://time` and task lists
  // all parse into real typed nodes on Telegram's rich markdown path. An
  // earlier revision of this guard "repaired" `<details>` into a `**> `
  // expandable blockquote (MarkdownV2-only syntax that renders as LITERAL
  // `**>` text on this path) and deleted footnote markers — both conversions
  // destroyed supported constructs and are deleted. These tests would FAIL on
  // the old guard.
  it("passes a <details><summary> block through untouched (native construct)", () => {
    const input =
      "Here is the trace:\n<details open><summary>Stack trace</summary>\n\nline 1\nline 2\n\n</details>\ndone";
    expect(guardUnsupportedTokens(input)).toBe(input);
  });

  it("passes a <details> without a <summary> through untouched", () => {
    const input = "<details>hidden body text</details>";
    expect(guardUnsupportedTokens(input)).toBe(input);
  });

  it("never converts <details> into the retired `**>` marker", () => {
    const out = guardUnsupportedTokens(
      "<details><summary>More</summary>\nbody\n</details>",
    );
    expect(out).not.toContain("**>");
    expect(out).toContain("<details>");
  });

  it("keeps footnote reference markers AND definition lines (native construct)", () => {
    expect(guardUnsupportedTokens("see the note[^1] here")).toBe(
      "see the note[^1] here",
    );
    expect(guardUnsupportedTokens("[^1]: the definition")).toBe(
      "[^1]: the definition",
    );
    // Alphanumeric ids too — the pair renders as real footnote machinery.
    expect(guardUnsupportedTokens("claim[^note] holds\n\n[^note]: body")).toBe(
      "claim[^note] holds\n\n[^note]: body",
    );
  });

  it("passes <sub>/<sup>/<u>/<aside> HTML tags through untouched", () => {
    const input =
      "H<sub>2</sub>O and x<sup>2</sup> and <u>under</u>\n<aside>pull\n<cite>credit</cite></aside>";
    expect(guardUnsupportedTokens(input)).toBe(input);
  });

  // ── The one genuinely-unsupported token: caret pairs ─────────────────────
  it("strips caret highlight / superscript pairs to their inner text", () => {
    expect(guardUnsupportedTokens("energy is x^2^ joules")).toBe(
      "energy is x2 joules",
    );
    expect(guardUnsupportedTokens("a ^highlighted^ word")).toBe(
      "a highlighted word",
    );
  });

  it("leaves unpaired carets scattered across prose intact (no interior space)", () => {
    // Two separate literal carets across words are NOT a highlight pair —
    // stripping both and joining the words would corrupt the prose.
    expect(guardUnsupportedTokens("the exponent a^n plus b^m here")).toBe(
      "the exponent a^n plus b^m here",
    );
    expect(guardUnsupportedTokens("score^total and rank^final done")).toBe(
      "score^total and rank^final done",
    );
    // But a genuine adjacent highlight/superscript is still repaired.
    expect(guardUnsupportedTokens("value ^highlight^ here")).toBe(
      "value highlight here",
    );
  });

  it("leaves whitespace-free multi-caret math expressions intact (no false superscript pairing)", () => {
    // Review MED-LOW: the caret pair must NOT span two independent exponents.
    // A permissive inner run would pair `^2+b^` in `a^2+b^2=c^2` and strip the
    // carets, mangling the math. The alphanumeric-only inner run breaks the run
    // at `+`/`=`/`-`, so each is left as a literal caret expression.
    expect(guardUnsupportedTokens("a^2+b^2=c^2")).toBe("a^2+b^2=c^2");
    expect(guardUnsupportedTokens("2^8")).toBe("2^8");
    expect(guardUnsupportedTokens("x^n")).toBe("x^n");
    expect(guardUnsupportedTokens("compute a^2-b^2 now")).toBe("compute a^2-b^2 now");
    // And a real single superscript token is still repaired.
    expect(guardUnsupportedTokens("x^2^ metres")).toBe("x2 metres");
  });

  it("never strips carets inside a $…$ math span (protected segment)", () => {
    // `$x^2y^2$` contains an alphanumeric-only caret pair (`^2y^`) that the
    // caret regex WOULD strip in bare prose — but the compact math span is a
    // protected segment (code-segments.ts), so the wire bytes survive intact
    // for Telegram to typeset as a mathematical_expression node.
    const math = "inline $x^2y^2$ done";
    expect(guardUnsupportedTokens(math)).toBe(math);
  });

  it("leaves regex-literal negated char classes intact", () => {
    // The guard no longer touches `[^…]` at all (footnotes are supported),
    // so every negated-char-class shape survives verbatim.
    expect(guardUnsupportedTokens("use [^/] to match")).toBe(
      "use [^/] to match",
    );
    expect(guardUnsupportedTokens("strip [^a-z] chars")).toBe(
      "strip [^a-z] chars",
    );
    expect(guardUnsupportedTokens('match [^"] here')).toBe('match [^"] here');
    expect(guardUnsupportedTokens("array[^index] lookup")).toBe(
      "array[^index] lookup",
    );
    expect(guardUnsupportedTokens("`array[^index]` lookup")).toBe(
      "`array[^index]` lookup",
    );
  });

  it("is a strict no-op for clean markdown (no target tokens)", () => {
    const clean =
      "**Answer:** the `config.yaml` file. See [docs](https://example.com/x).";
    expect(guardUnsupportedTokens(clean)).toBe(clean);
  });

  it("never touches carets inside code spans / fenced blocks", () => {
    const code = "run `git rev-parse HEAD^` then\n```bash\necho x^2^\n```";
    // Carets inside the code span and fence survive verbatim.
    expect(guardUnsupportedTokens(code)).toBe(code);
  });

  it("leaves `$` untouched (currency is owned by guardDollarMath)", () => {
    const money = "it costs $5 and $10";
    expect(guardUnsupportedTokens(money)).toBe(money);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const input = "<details><summary>T</summary>b</details> and x^2^ and n[^3]";
    const once = guardUnsupportedTokens(input);
    expect(guardUnsupportedTokens(once)).toBe(once);
  });

  it("OUTCOME: the composed richMessage wire body preserves supported constructs and repairs carets", () => {
    // End-to-end through the real send-path composition (the FULL
    // guardAccidentalFormatting pipeline). This is the anti-tautology anchor:
    // on the pre-fix pipeline, `<details>` was folded into the unsupported
    // `**>` marker and `[^1]` was deleted — every assertion below would FAIL.
    const { markdown } = richMessage(
      "note[^1]\n<details><summary>More</summary>\ndetail line\n</details>\nx^2^\n\n[^1]: the note",
    );
    expect(markdown).toContain("<details><summary>More</summary>");
    expect(markdown).toContain("</details>");
    expect(markdown).toContain("note[^1]");
    expect(markdown).toContain("[^1]: the note");
    expect(markdown).not.toContain("**>");
    expect(markdown).toContain("x2"); // caret pair repaired
  });
});
