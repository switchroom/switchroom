import { describe, it, expect } from "vitest";
import { guardUnsupportedTokens } from "../../render/unsupported-token-guard.js";
import { richMessage } from "../../rich-send.js";

describe("guardUnsupportedTokens — deterministic send-time repair", () => {
  it("folds <details><summary> into a Telegram expandable blockquote", () => {
    const input =
      "Here is the trace:\n<details><summary>Stack trace</summary>\nline 1\nline 2\n</details>\ndone";
    const out = guardUnsupportedTokens(input);
    // Anti-tautology: the raw HTML tags MUST be gone from the wire body.
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("</details>");
    expect(out).not.toContain("<summary>");
    // Summary becomes the expandable-blockquote first line (`**> ` marker).
    expect(out).toContain("**> Stack trace");
    // Body lines become plain `> ` continuation lines.
    expect(out).toContain("> line 1");
    expect(out).toContain("> line 2");
  });

  it("folds a <details> without a <summary> into an expandable blockquote", () => {
    const out = guardUnsupportedTokens("<details>hidden body text</details>");
    expect(out).not.toContain("<details");
    expect(out).toContain("**> hidden body text");
  });

  it("strips caret highlight / superscript pairs to their inner text", () => {
    expect(guardUnsupportedTokens("energy is x^2^ joules")).toBe(
      "energy is x2 joules",
    );
    expect(guardUnsupportedTokens("a ^highlighted^ word")).toBe(
      "a highlighted word",
    );
  });

  it("removes footnote reference markers but keeps definition lines", () => {
    expect(guardUnsupportedTokens("see the note[^1] here")).toBe(
      "see the note here",
    );
    // A `[^1]:` definition line is left intact (the negative lookahead).
    expect(guardUnsupportedTokens("[^1]: the definition")).toBe(
      "[^1]: the definition",
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

  it("repairs alphanumeric footnote markers, not just numeric", () => {
    // POLISH-4: widened from digits-only so `[^note]`/`[^ref]` no longer ship
    // as literal bracket noise. Each would survive UNTOUCHED on origin/main.
    expect(guardUnsupportedTokens("see the note[^note] here")).toBe(
      "see the note here",
    );
    expect(guardUnsupportedTokens("as shown[^ref] above")).toBe(
      "as shown above",
    );
    expect(guardUnsupportedTokens("point[^fn1] made")).toBe("point made");
    // A single-letter id is a footnote too.
    expect(guardUnsupportedTokens("claim[^a] holds")).toBe("claim holds");
    // Definition lines with an alphanumeric id are still left intact (`(?!:)`).
    expect(guardUnsupportedTokens("[^note]: the definition")).toBe(
      "[^note]: the definition",
    );
  });

  it("leaves regex-literal negated char classes intact", () => {
    // Real negated char classes contain punctuation / ranges / escapes, so the
    // alphanumeric-only id requirement excludes them — these stay verbatim.
    expect(guardUnsupportedTokens("use [^/] to match")).toBe(
      "use [^/] to match",
    );
    expect(guardUnsupportedTokens("strip [^a-z] chars")).toBe(
      "strip [^a-z] chars",
    );
    expect(guardUnsupportedTokens('match [^"] here')).toBe('match [^"] here');
    // Accepted tradeoff (task POLISH-4): a PURE-alphanumeric negated class in
    // BARE prose like `array[^index]` is now treated as a footnote and stripped.
    // This is rare — regex/index literals in real prose live in code spans,
    // which splitProtectedSegments masks (see code-span test below).
    expect(guardUnsupportedTokens("array[^index] lookup")).toBe("array lookup");
    // …but inside a code span the same literal is untouched.
    expect(guardUnsupportedTokens("`array[^index]` lookup")).toBe(
      "`array[^index]` lookup",
    );
  });

  it("repairs a real numeric footnote marker", () => {
    expect(guardUnsupportedTokens("see the note[^1] here")).toBe(
      "see the note here",
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

  it("OUTCOME: the composed richMessage wire body has unsupported tokens repaired", () => {
    // End-to-end through the real send-path composition. This is the
    // anti-tautology anchor: without guardUnsupportedTokens wired into
    // guardAccidentalFormatting, the raw `<details>` / `^` / `[^1]` tokens would
    // reach the wire and this assertion would FAIL.
    const { markdown } = richMessage(
      "note[^1]\n<details><summary>More</summary>\ndetail line\n</details>\nx^2^",
    );
    expect(markdown).not.toContain("<details>");
    expect(markdown).not.toContain("[^1]");
    expect(markdown).toContain("**> More");
    expect(markdown).toContain("> detail line");
    expect(markdown).toContain("x2");
  });
});
