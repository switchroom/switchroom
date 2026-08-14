// Outcome tests for the content-loss regressions found in the raw-HTML
// dialect fold (#4691, merged as fa9018a7, unreleased).
//
// Every assertion here FAILS on fa9018a7. They drive the real `renderOutbound`
// (`parse` -> `renderSafe`), i.e. exactly what the live send path calls, so
// they assert the WIRE OUTCOME rather than an internal code path.
//
// The through-line: fa9018a7's degrade bucket DELETED any token it could not
// fold or pass through. That is safe for markup but catastrophic for prose —
// `<service>/<key>`, `<agent>` and "the `<b>` tag" are pervasive in this
// project's own agent output, and they were silently vanishing from replies.
// The discriminator is now MATCHING, not the tag name: a balanced pair is
// markup (drop it, keep the content), an unmatched marker is prose (keep it,
// HTML-entity-escaped so the wire cannot read it as a tag).

import { describe, it, expect } from "vitest";
import { renderOutbound } from "../../render/rich-render.js";
import { parse } from "../../render/parse.js";
import { escapeLinkHref } from "../../format.js";

const render = (src: string): string => renderOutbound(src).text;

describe("BLOCKER: angle-bracket placeholders in prose survive (#4691 regression)", () => {
  it("keeps a `<service>/<key>` convention line intact", () => {
    // fa9018a7: "Use the / convention."
    expect(render("Use the <service>/<key> convention.")).toBe(
      "Use the &lt;service&gt;/&lt;key&gt; convention.",
    );
  });

  it("keeps a trailing `<key>` placeholder on a command line", () => {
    // fa9018a7: "run switchroom vault get "
    expect(render("run switchroom vault get <key>")).toBe(
      "run switchroom vault get &lt;key&gt;",
    );
  });

  it("keeps an `<agent>` path segment", () => {
    // fa9018a7: "logs live at /host-home/.switchroom/logs//"
    expect(render("logs live at /host-home/.switchroom/logs/<agent>/")).toBe(
      "logs live at /host-home/.switchroom/logs/&lt;agent&gt;/",
    );
  });

  it("keeps a tag NAMED in prose when nothing closes it", () => {
    // fa9018a7: "The  tag is bold and  is italic"
    expect(render("The <b> tag is bold and <i> is italic")).toBe(
      "The &lt;b&gt; tag is bold and &lt;i&gt; is italic",
    );
  });

  it("never emits a bare `<` for a token it kept as prose", () => {
    // The escape is what makes keeping the token safe: Rich HTML documents
    // `&lt;`/`&gt;`/`&amp;` as supported named entities, so this cannot trip
    // `unsupported start tag` the way a bare `<service>` would.
    const out = render("Use <service>/<key> and <agent>.");
    expect(out).not.toMatch(/<[A-Za-z/]/);
    expect(out).toBe("Use &lt;service&gt;/&lt;key&gt; and &lt;agent&gt;.");
  });

  it("does not double-escape when its own output is re-parsed", () => {
    // Re-parsing decodes `&lt;` back to a text-node `<`, which never reaches
    // the fold at all (the documented residual in html-fold.ts's header), so
    // the second pass is NOT byte-idempotent. What must never happen is a
    // compounding `&amp;lt;` that the reader actually sees.
    const once = render("Use the <service>/<key> convention.");
    expect(once).toBe("Use the &lt;service&gt;/&lt;key&gt; convention.");
    expect(render(once)).not.toContain("&amp;");
  });

  it("still DROPS the markup of a balanced unknown pair (content kept)", () => {
    // The other half of the discriminator: a matched pair really is markup.
    expect(render("<marquee>scrolling</marquee>")).toBe("scrolling");
    expect(render(`<span data-x="1">t</span>`)).toBe("t");
  });
});

describe("MAJOR 1: `<pre>` folds to a fenced block, not a broken code span", () => {
  it("renders `<pre><code>` as a real fence", () => {
    // fa9018a7: "`const a = 1;\nconst b = 2;`" — a backtick span wrapping a
    // newline, which Telegram will not parse, so the reader sees literal
    // backticks around broken text.
    expect(render("<pre><code>const a = 1;\nconst b = 2;</code></pre>")).toBe(
      "```\nconst a = 1;\nconst b = 2;\n```",
    );
  });

  it("never emits a code span containing a newline", () => {
    const out = render("<pre><code>a\nb</code></pre>");
    expect(out).not.toMatch(/(^|[^`])`[^`]*\n[^`]*`/);
  });

  it("carries the `class=\"language-…\"` hint into the fence info string", () => {
    expect(
      render(`<pre><code class="language-python">print(1)</code></pre>`),
    ).toBe("```python\nprint(1)\n```");
  });

  it("handles a bare `<pre>` with no inner `<code>`", () => {
    expect(render("<pre>one\ntwo</pre>")).toBe("```\none\ntwo\n```");
  });

  it("leaves no stray leading or trailing newline around the fence", () => {
    // The layout newlines a `<pre>` block carries are not content.
    expect(render("<pre>\nbody\n</pre>")).toBe("```\nbody\n```");
    expect(render("<pre>\nbody\n</pre>")).not.toMatch(/^\n|\n$/);
  });

  it("degrades to an inline code span where a fence cannot survive", () => {
    // A fence inside a `#` line or a table cell would end the block/row.
    expect(render("# a <pre>x</pre> b")).toBe("# a `x` b");
    expect(render("| h |\n| --- |\n| <pre>x</pre> |")).toContain("| `x` |");
  });
});

describe("MAJOR 2: structural tags do not glue their content together", () => {
  it("separates list items instead of emitting `onetwo`", () => {
    expect(render("<ul><li>one</li><li>two</li></ul>")).toBe("one  \ntwo");
  });

  it("separates paragraphs instead of emitting `para onepara two`", () => {
    expect(render("<p>para one</p><p>para two</p>")).toBe(
      "para one  \npara two",
    );
  });

  it("separates table cells", () => {
    expect(render("<table><tr><td>a</td><td>b</td></tr></table>")).toBe(
      "a  \nb",
    );
  });

  it("leaves no separator hanging at the edges of the block", () => {
    const out = render("<div>only</div>");
    expect(out).toBe("only");
  });

  it("still renders a markup-only block to nothing", () => {
    // Regression guard for the separator: an empty structural block must not
    // become a whitespace-only paragraph and a spurious `\n\n`.
    expect(render("a\n\n<div></div>\n\nb")).toBe("a\n\nb");
    expect(render("a\n\n<!-- c -->\n\nb")).toBe("a\n\nb");
  });

  it("uses a space, not a newline, inside a table cell", () => {
    // A newline in a cell ends the row.
    const out = render("| h |\n| --- |\n| <p>x</p><p>y</p> |");
    expect(out).toContain("| x y |");
  });
});

describe("MAJOR 3: the passthrough bucket is balance-checked", () => {
  it("does not ship an unmatched `<u>` raw", () => {
    // fa9018a7 emitted this verbatim -> `unclosed start tag` 400 -> the
    // fallback resends the WHOLE message as plain text. One stray marker in
    // relayed content was a denial-of-formatting on the agent's reply.
    expect(render("hello <u>world")).toBe("hello &lt;u&gt;world");
  });

  it("does not ship a stray close marker raw", () => {
    expect(render("</details>")).toBe("&lt;/details&gt;");
  });

  it("keeps the balanced inner pair and escapes only the unmatched outer", () => {
    expect(render("<u><u>x</u>")).toBe("&lt;u&gt;<u>x</u>");
  });

  it("still passes a BALANCED allowlist tag through raw", () => {
    for (const src of [
      "<u>under</u>",
      "H<sub>2</sub>O",
      "x<sup>2</sup>",
      "<aside><cite>note</cite></aside>",
    ]) {
      expect(render(src)).toBe(src);
    }
  });

  it("passes a `<details>` block through even though it spans mdast blocks", () => {
    // The balance check MUST be document-level: micromark splits this into
    // three separate `html` nodes, so a per-node check would wrongly call the
    // open and close markers unmatched and escape them.
    const src = "<details open><summary>S</summary>\n\nbody\n\n</details>";
    expect(render(src)).toBe(src);
  });

  it("does not let a tag inside a code fence balance a prose marker", () => {
    // Tags in a fence are not markup and must not satisfy anything outside it.
    const out = render("```\n</u>\n```\n\nhello <u>world");
    expect(out).toContain("```\n</u>\n```");
    expect(out).toContain("hello &lt;u&gt;world");
  });
});

describe("MAJOR 4: the fence comment's claimed safety property (pinned)", () => {
  it("PINS the lazy-continuation counterexample the comment gets wrong", () => {
    // The `**>` rewrite tracks TOP-LEVEL fences only, so the `> ``` ` opener
    // here is invisible to it and the column-0 `**> lazy` line is rewritten,
    // eating the `**`. CommonMark forbids lazy continuation into fenced code,
    // so that line should CLOSE the blockquote and stay literal.
    //
    // This is PRE-EXISTING and identical before #4691 — NOT a regression — and
    // fixing it needs real container tracking, not a wider fence regex. Pinned
    // so any future container-aware rewrite has to decide it deliberately;
    // `FENCE_DELIM_RE`'s doc comment now describes this instead of claiming
    // the case cannot happen.
    expect(render("> ```\n**> lazy\n> ```")).toBe("> ```\n> lazy\n> ```");
  });
});

describe("nits: breaks, nested links, and href hygiene", () => {
  it("does not break a heading block with `<br>`", () => {
    // fa9018a7: "# a  \nb" — the hard break ends the heading and orphans `b`.
    expect(render("# a<br>b")).toBe("# a b");
    expect(parse("# a<br>b").blocks).toHaveLength(1);
  });

  it("keeps a `<br>` a real break in ordinary prose", () => {
    expect(render("one<br>two")).toBe("one  \ntwo");
    // Two explicit breaks are the author's, not synthesized separators — they
    // must not be collapsed by the separator normalizer.
    expect(render("a<br><br>b")).toBe("a  \n  \nb");
  });

  it("does not silently drop a nested `<a>`'s href", () => {
    // fa9018a7: "[out in](https://o.example)" — the inner URL vanished.
    const out = render(
      '<a href="https://o.example">out <a href="https://i.example">in</a></a>',
    );
    expect(out).toContain("i.example");
  });

  it("percent-encodes whitespace in a link destination", () => {
    // A bare destination ends at the first whitespace character, so a raw
    // space turned the rest of the URL into a title and a raw newline
    // terminated the link outright.
    expect(render('<a href="https://ex.com/a b">x</a>')).toBe(
      "[x](https://ex.com/a%20b)",
    );
    expect(render('<a href="https://ex.com/a\nb">x</a>')).toBe(
      "[x](https://ex.com/a%0Ab)",
    );
  });

  it("escapeLinkHref still balances parens and is a no-op for clean URLs", () => {
    expect(escapeLinkHref("https://e.com/a_(b)")).toBe(
      "https://e.com/a_\\(b\\)",
    );
    expect(escapeLinkHref("https://e.com/plain?a=1&b=2")).toBe(
      "https://e.com/plain?a=1&b=2",
    );
  });
});
