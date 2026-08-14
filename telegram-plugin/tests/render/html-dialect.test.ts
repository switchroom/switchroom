// Outcome tests for the three v0.21.9 outbound-render residuals:
//
//   1. `markExpandableQuotes` rewrote `**>` lines INSIDE fenced code blocks,
//      corrupting documented examples into `  >` on the wire.
//   2. `escapeMarkdown` ran over raw-HTML `plain` nodes and escaped `=`, so
//      `<a href="…">` shipped as `<a href\="…">` — an unreadable attribute.
//   3. Raw HTML tags reached the wire byte-verbatim with nothing establishing
//      that Telegram's rich parser accepts them.
//
// Every assertion here FAILS on the v0.21.9 pipeline. They drive the real
// `renderOutbound` (`parse` -> `renderSafe`), i.e. exactly what the live send
// path calls, so they assert the wire OUTCOME, not an internal code path.

import { describe, it, expect } from "vitest";
import { renderOutbound } from "../../render/rich-render.js";
import { parse } from "../../render/parse.js";
import { classifyHtmlTag, hrefOf } from "../../render/html-fold.js";

describe("fenced code blocks are immune to the `**>` input repair (defect 1)", () => {
  it("keeps a `**>` line inside a fence byte-identical", () => {
    // The exact corruption: on v0.21.9 this came back as "```md\n  > tap…".
    const src = "```md\n**> tap to expand\n> body\n```";
    expect(renderOutbound(src).text).toBe(src);
    const code = parse(src).blocks[0] as { type: string; text: string };
    expect(code.type).toBe("code-block");
    expect(code.text).toBe("**> tap to expand\n> body");
  });

  it("keeps a `**>` line inside a TILDE fence byte-identical", () => {
    const src = "~~~\n**> quoted\n~~~";
    const code = parse(src).blocks[0] as { type: string; text: string };
    expect(code.type).toBe("code-block");
    expect(code.text).toBe("**> quoted");
  });

  it("still repairs a `**>` quote OUTSIDE the fence in the same document", () => {
    const src = "```\n**> literal\n```\n\n**> repaired";
    const out = renderOutbound(src).text;
    expect(out).toContain("```\n**> literal\n```");
    expect(out).toContain("> repaired");
    // The repaired quote is a real quote, not a literal `**>` paragraph.
    expect(out.split("\n\n").at(-1)).toBe("> repaired");
  });

  it("does not lose the repair after a CLOSED fence earlier in the body", () => {
    // Guards the fence tracker's close detection: a stuck-open scanner would
    // silently stop repairing every legacy quote after the first fence.
    const src = "```js\nconst a = 1;\n```\n\n**> still repaired";
    expect(renderOutbound(src).text.endsWith("> still repaired")).toBe(true);
  });

  it("treats an UNCLOSED fence as running to end of document", () => {
    const src = "```\n**> never repaired";
    const code = parse(src).blocks[0] as { type: string; text: string };
    expect(code.type).toBe("code-block");
    expect(code.text).toBe("**> never repaired");
  });

  it("keeps a fence's `**>` content intact through an inline code round-trip", () => {
    // A wider fence in the source must not change the content bytes.
    const src = "````\n```\n**> nested\n```\n````";
    const code = parse(src).blocks[0] as { type: string; text: string };
    expect(code.text).toBe("```\n**> nested\n```");
  });
});

describe("raw HTML links fold to native markdown links (defect 2)", () => {
  it("`<a href>` becomes a working link with no escaped `=`", () => {
    const out = renderOutbound(
      `<a href="https://example.com">label</a>`,
    ).text;
    expect(out).toBe("[label](https://example.com)");
    expect(out).not.toContain("\\=");
  });

  it("an `<a href>` embedded in prose keeps its surroundings", () => {
    const out = renderOutbound(
      `see <a href="https://example.com/a_b">the docs</a> now`,
    ).text;
    expect(out).toBe("see [the docs](https://example.com/a_b) now");
    expect(out).not.toContain("\\=");
  });

  it("accepts a single-quoted href", () => {
    expect(renderOutbound(`<a href='https://e.com'>x</a>`).text).toBe(
      "[x](https://e.com)",
    );
  });

  it("reads an unquoted href value (tokenizer level)", () => {
    // Exercised directly: an UNQUOTED href never reaches the fold through
    // micromark — GFM's autolink-literal extension consumes
    // `https://e.com>x` before the tag can become an mdast `html` node (a
    // documented upstream limitation, not something this layer can reach).
    // The attribute reader still handles the form for the block-HTML path.
    expect(hrefOf(classifyHtmlTag(`<a href=https://e.com>`))).toBe(
      "https://e.com",
    );
    expect(hrefOf(classifyHtmlTag(`<a href="https://e.com/a(b)">`))).toBe(
      "https://e.com/a(b)",
    );
    expect(hrefOf(classifyHtmlTag(`<a name="x">`))).toBeNull();
  });

  it("an `<a>` with no href degrades to its label, not to broken markup", () => {
    expect(renderOutbound(`<a name="anchor">label</a>`).text).toBe("label");
  });

  it("a wire-verified allowlist tag keeps its `=` attribute unescaped", () => {
    // `<details open="open">` on v0.21.9 shipped as `open\="open"`.
    const src = `<details open="open"><summary>S</summary>body</details>`;
    expect(renderOutbound(src).text).toBe(src);
  });
});

describe("markdown-equivalent HTML tags fold to native constructs (defect 3)", () => {
  it("folds bold / italic / strike / code", () => {
    expect(renderOutbound("<b>bold</b>").text).toBe("**bold**");
    expect(renderOutbound("<strong>bold</strong>").text).toBe("**bold**");
    expect(renderOutbound("<i>it</i>").text).toBe("*it*");
    expect(renderOutbound("<em>it</em>").text).toBe("*it*");
    expect(renderOutbound("<s>gone</s>").text).toBe("~~gone~~");
    expect(renderOutbound("<del>gone</del>").text).toBe("~~gone~~");
    expect(renderOutbound("<code>x_y</code>").text).toBe("`x_y`");
  });

  it("folds a tag mid-sentence without disturbing the prose", () => {
    expect(renderOutbound("the <b>only</b> way").text).toBe("the **only** way");
  });

  it("folds nested tags", () => {
    expect(renderOutbound("<b>bold <i>and italic</i></b>").text).toBe(
      "**bold *and italic***",
    );
  });

  it("handles same-name nesting without closing on the inner tag", () => {
    // Depth tracking matters: matching the FIRST `</b>` would leave a dangling
    // ` c` outside the bold run. The inner bold collapses into the outer one
    // (see the asterisk-soup test below) so every byte lands inside `**…**`.
    expect(renderOutbound("<b>a <b>b</b> c</b>").text).toBe("**a b c**");
  });

  it("passes the wire-verified allowlist through raw", () => {
    for (const src of [
      "<u>under</u>",
      "H<sub>2</sub>O",
      "x<sup>2</sup>",
      "<aside><cite>note</cite></aside>",
    ]) {
      expect(renderOutbound(src).text).toBe(src);
    }
  });

  it("drops the markup of an unrecognised tag but keeps its content", () => {
    // Never ship a construct we cannot guarantee: an unknown tag risks the
    // `unsupported start tag` 400 whose fallback resends PLAIN text, showing
    // the reader literal markup.
    expect(renderOutbound(`<marquee>scrolling</marquee>`).text).toBe("scrolling");
    expect(renderOutbound(`<div class="x">body</div>`).text).toBe("body");
    expect(renderOutbound(`<span data-x="1">t</span>`).text).toBe("t");
  });

  it("drops an HTML comment entirely", () => {
    expect(renderOutbound("before <!-- hidden --> after").text).toBe(
      "before  after",
    );
  });

  it("drops an unmatched open or close marker but keeps the text", () => {
    expect(renderOutbound("<b>dangling").text).toBe("dangling");
    expect(renderOutbound("dangling</b>").text).toBe("dangling");
  });

  it("turns `<br>` into a GFM HARD break rather than deleting it", () => {
    // A bare `\n` would be collapsed to a space by Telegram — the renderer
    // runs after `normalizeParagraphBreaks`, so nothing downstream promotes
    // it. Two trailing spaces are the GFM hard-break syntax.
    expect(renderOutbound("one<br>two").text).toBe("one  \ntwo");
    expect(renderOutbound("one<br/>two").text).toBe("one  \ntwo");
  });

  it("folds a block-level HTML line (not just inline runs)", () => {
    // A paragraph that is entirely a tag is a mdast `html` BLOCK, a different
    // fold path from an inline `html` phrasing node.
    expect(renderOutbound("para\n\n<b>alone</b>\n\nmore").text).toBe(
      "para\n\n**alone**\n\nmore",
    );
  });

  it("escapes prose around a folded tag as prose (no smuggled formatting)", () => {
    // Text between tags is still ordinary prose and must be escaped, or a
    // `[`/`*` in it could re-trigger formatting downstream.
    expect(renderOutbound("<b>a [b] c</b>").text).toBe("**a \\[b\\] c**");
  });

  it("never emits nested same-kind emphasis (asterisk soup)", () => {
    // `**a **b** c**` renders as literal asterisks on the reader's screen.
    expect(renderOutbound("<b>**already**</b>").text).toBe("**already**");
    expect(renderOutbound("<b>a <b>b</b> c</b>").text).toBe("**a b c**");
    expect(renderOutbound("<i>*x*</i>").text).toBe("*x*");
    // DIFFERENT kinds still nest, as markdown allows.
    expect(renderOutbound("<b><i>bi</i></b>").text).toBe("***bi***");
  });

  it("never swallows an inner code span's backticks into `<code>`", () => {
    // Folding the inner `code` node's text would DELETE its backticks
    // (`a b c`). Degrade to the children instead — every byte survives.
    expect(renderOutbound("<code>a `b` c</code>").text).toBe("a `b` c");
    expect(renderOutbound("<code><u>x</u></code>").text).toBe("<u>x</u>");
  });

  it("does not leave a blank-line hole where a dropped block used to be", () => {
    // A block that is nothing but dropped markup must not contribute an empty
    // paragraph and a spurious `\n\n` separator.
    expect(renderOutbound("a\n\n<!-- c -->\n\nb").text).toBe("a\n\nb");
    expect(renderOutbound("a\n\n<div></div>\n\nb").text).toBe("a\n\nb");
  });

  it("does not treat `a < b` as a tag", () => {
    expect(renderOutbound("if a < b then c").text).toBe("if a < b then c");
  });

  it("leaves an autolink alone", () => {
    expect(renderOutbound("<https://example.com>").text).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  it("leaves tags inside a fenced code block completely untouched", () => {
    const src = '```html\n<a href="https://e.com">x</a>\n<b>y</b>\n```';
    expect(renderOutbound(src).text).toBe(src);
  });

  it("leaves tags inside an inline code span untouched", () => {
    expect(renderOutbound("use `<b>bold</b>` here").text).toBe(
      "use `<b>bold</b>` here",
    );
  });
});

describe("the blank-line-separated expandable shape (majority corpus shape)", () => {
  // `**> header`, a BLANK line, then the `> …` body. Existing coverage only
  // pinned the contiguous and lone-marker variants; this shape is what the
  // corpus actually carries, and nothing locked it in.
  const src = "**> tap to expand\n\n> line one\n> line two";

  it("emits no `**>` marker anywhere", () => {
    expect(renderOutbound(src).text).not.toContain("**>");
  });

  it("renders the header and the body as quotes, content intact", () => {
    const out = renderOutbound(src).text;
    expect(out).toBe("> tap to expand\n\n> line one\n> line two");
  });

  it("marks the header blockquote expandable and leaves the body plain", () => {
    const blocks = parse(src).blocks as Array<{
      type: string;
      expandable?: boolean;
    }>;
    expect(blocks.map((b) => b.type)).toEqual(["blockquote", "blockquote"]);
    expect(blocks[0].expandable).toBe(true);
    expect(blocks[1].expandable).toBe(false);
  });

  it("survives a body carrying formatting and a link", () => {
    const rich =
      "**> tap to expand\n\n> **bold** body\n> see [docs](https://e.com)";
    const out = renderOutbound(rich).text;
    expect(out).not.toContain("**>");
    expect(out).toContain("> **bold** body");
    expect(out).toContain("> see [docs](https://e.com)");
  });

  it("is idempotent — re-rendering the output does not re-quote it", () => {
    const once = renderOutbound(src).text;
    expect(renderOutbound(once).text).toBe(once);
  });
});
