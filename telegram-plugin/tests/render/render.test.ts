import { describe, it, expect } from "vitest";
import { parse } from "../../render/parse.js";
import {
  render,
  renderSafe,
  SUPPORTED_INLINE,
  SUPPORTED_BLOCK,
} from "../../render/render.js";
import { RICH_MESSAGE_MAX_CHARS } from "../../format.js";
import type { Document, TableNode } from "../../render/ir.js";

/** Round-trip helper: parse markdown -> IR -> render -> re-parse, and assert
 *  the RE-PARSED IR is structurally equivalent to the original (ignoring
 *  source offsets, which legitimately differ after re-rendering). */
function assertRoundTripsStructurally(md: string) {
  const doc = parse(md);
  const out = render(doc);
  const reparsed = parse(out);
  expect(stripPositions(reparsed)).toEqual(stripPositions(doc));
}

function stripPositions(node: any): any {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node && typeof node === "object") {
    const { start, end, ...rest } = node;
    const out: any = {};
    for (const [k, v] of Object.entries(rest)) out[k] = stripPositions(v);
    return out;
  }
  return node;
}

describe("render: inline palette", () => {
  it("bold", () => {
    expect(render(parse("**hi**"))).toBe("**hi**");
  });
  it("italic", () => {
    expect(render(parse("*hi*"))).toBe("*hi*");
  });
  it("strike", () => {
    expect(render(parse("~~hi~~"))).toBe("~~hi~~");
  });
  it("inline code", () => {
    expect(render(parse("`hi`"))).toBe("`hi`");
  });
  it("link", () => {
    expect(render(parse("[label](https://example.com)"))).toBe(
      "[label](https://example.com)",
    );
  });
  it("escapes a `)` in a link href so the URL is not truncated (F3)", () => {
    // An angle-bracket destination is the only way to smuggle an UNBALANCED
    // `)` into an href via the parser (a bare `)` would otherwise close the
    // destination). CommonMark strips the angle brackets → href holds the `)`.
    const doc = parse("[wiki](<https://example.com/a)b>)");
    const link = (doc.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(link.href).toBe("https://example.com/a)b"); // parser captured the full URL

    const out = render(doc);
    // The `)` is backslash-escaped so it can no longer terminate the `(...)`
    // destination early — a valid Bot API 10.1 link, not a broken one.
    expect(out).toContain("a\\)b");
    // And it round-trips: re-parsing recovers the SAME href, not a truncated
    // `https://example.com/a` with stray `b)` prose spilled after it.
    const reparsed = parse(out);
    const reLink = (reparsed.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(reLink.href).toBe("https://example.com/a)b");
  });
  it("round-trips a balanced-paren href (Wikipedia disambiguation) without leaking a backslash", () => {
    // A bare destination with BALANCED parens is legal CommonMark; the parser
    // captures the whole URL including the inner `(...)`. Escaping only `)`
    // (the old fix) would unbalance the parens and leak a literal backslash
    // into the decoded href. Escaping both parens keeps it balanced.
    const src = "[w](https://en.wikipedia.org/wiki/Foo_(disambiguation))";
    const doc = parse(src);
    const link = (doc.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(link.href).toBe("https://en.wikipedia.org/wiki/Foo_(disambiguation)");

    const out = render(doc);
    const reparsed = parse(out);
    const reLink = (reparsed.blocks[0] as any).children.find((c: any) => c.type === "link");
    // Re-parsed href is byte-for-byte the original — no truncation, no stray `\`.
    expect(reLink.href).toBe("https://en.wikipedia.org/wiki/Foo_(disambiguation)");
    expect(reLink.href).not.toContain("\\");
  });
  it("round-trips an href with multiple balanced paren groups", () => {
    const src = "[m](https://example.com/a(b)c(d))";
    const doc = parse(src);
    const link = (doc.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(link.href).toBe("https://example.com/a(b)c(d)");

    const out = render(doc);
    const reparsed = parse(out);
    const reLink = (reparsed.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(reLink.href).toBe("https://example.com/a(b)c(d)");
    expect(reLink.href).not.toContain("\\");
  });
  it("round-trips an href with a lone unbalanced `)` without leaking a backslash", () => {
    // Angle-bracket destination smuggles a lone `)` past the parser.
    const doc = parse("[x](<https://example.com/a)b>)");
    const link = (doc.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(link.href).toBe("https://example.com/a)b");

    const out = render(doc);
    const reparsed = parse(out);
    const reLink = (reparsed.blocks[0] as any).children.find((c: any) => c.type === "link");
    expect(reLink.href).toBe("https://example.com/a)b");
    expect(reLink.href).not.toContain("\\");
  });
  it("underline", () => {
    expect(render(parse("__hi__"))).toBe("__hi__");
  });
  it("spoiler round-trips through the `||…||` delimiter", () => {
    expect(render(parse("a ||hidden|| b"))).toBe("a ||hidden|| b");
  });
  it("highlight round-trips through the `==…==` delimiter", () => {
    expect(render(parse("a ==marked== b"))).toBe("a ==marked== b");
  });
  it("underline vs bold stay distinct through a round trip", () => {
    assertRoundTripsStructurally("__under__ and **bold**");
  });
  it("nested inline spans", () => {
    assertRoundTripsStructurally("**bold *and italic* text**");
  });
  it("nested bold inside underline", () => {
    assertRoundTripsStructurally("__a **b** c__");
  });
  it("escapes markdown-special characters in plain text", () => {
    const out = render(parse("cost is 5 dollars"));
    expect(out).toBe("cost is 5 dollars");
  });
  it("re-escapes literal specials so they don't re-trigger formatting", () => {
    // A literal asterisk in prose (escaped in the source) must still be a
    // literal asterisk after a render round trip, not accidentally start
    // emphasis.
    const doc = parse("a \\* literal star");
    const out = render(doc);
    expect(parse(out).blocks[0]).toMatchObject({ type: "paragraph" });
    const reparsedText = (parse(out).blocks[0] as any).children
      .map((c: any) => c.text ?? "")
      .join("");
    expect(reparsedText).toContain("*");
  });
});

describe("render: line-leading issue refs are not headings (#3304 regression)", () => {
  it("multi-line message whose first line starts with #3304 stays a paragraph", () => {
    const md = "#3304 is merged. The regression suite is green.\n\nNext up: the follow-up PR.";
    const doc = parse(md);
    // Spec-correct parse: `#` without a following space is NOT an ATX heading.
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);

    const out = render(doc);
    // The line-leading `#` must be escaped so Telegram's non-spec rich parser
    // cannot promote the line to a heading...
    expect(out.startsWith("\\#3304 is merged.")).toBe(true);
    expect(out).not.toMatch(/^#{1,6} /m);
    // ...and the escape resolves back to the literal "#3304" on re-parse
    // (what the reader sees), with no heading node anywhere.
    const reparsed = parse(out);
    expect(reparsed.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect((reparsed.blocks[0] as any).children[0].text).toContain("#3304 is merged.");
  });

  it("issue ref at line start mid-message is escaped too", () => {
    const md = "Shipped today:\n#123 closes the loop on retries.";
    const out = render(parse(md));
    expect(out).toContain("\n\\#123 closes the loop");
    const reparsed = parse(out);
    expect(reparsed.blocks.every((b) => b.type !== "heading")).toBe(true);
  });

  it("a genuine `# Heading` still renders as a heading", () => {
    const md = "# Release notes\n\n#456 fixed the flake.";
    const out = render(parse(md));
    expect(out.startsWith("# Release notes")).toBe(true);
    expect(out).toContain("\\#456 fixed the flake.");
    const reparsed = parse(out);
    expect(reparsed.blocks[0].type).toBe("heading");
  });

  it("mid-line `#` is left alone", () => {
    const md = "merged in PR #789 yesterday";
    expect(render(parse(md))).toBe(md);
  });
});

describe("render: block palette", () => {
  it("heading levels 1-6", () => {
    for (let level = 1; level <= 6; level++) {
      const md = `${"#".repeat(level)} Title`;
      expect(render(parse(md))).toBe(md);
    }
  });
  it("plain blockquote", () => {
    expect(render(parse("> quoted line"))).toBe("> quoted line");
  });
  it("expandable IR flag renders as a PLAIN quote — the retired `**>` marker is never emitted", () => {
    // `**>` is MarkdownV2-only syntax; the rich markdown path renders it as
    // LITERAL `**>` text (wire-proved 2026-08-13 via raw sendRichMessage
    // probes), so the renderer degrades an expandable node to a plain quote.
    const doc: Document = {
      blocks: [
        {
          type: "blockquote",
          expandable: true,
          start: 0,
          end: 0,
          children: [
            {
              type: "paragraph",
              start: 0,
              end: 0,
              children: [{ type: "plain", text: "hidden gem", start: 0, end: 0 }],
            },
          ],
        },
      ],
    };
    expect(render(doc)).toBe("> hidden gem");
    expect(render(doc)).not.toContain("**>");
  });
  it("multi-line expandable blockquote renders every line with a plain > marker", () => {
    const doc: Document = {
      blocks: [
        {
          type: "blockquote",
          expandable: true,
          start: 0,
          end: 0,
          children: [
            {
              type: "paragraph",
              start: 0,
              end: 0,
              children: [{ type: "plain", text: "line one", start: 0, end: 0 }],
            },
            {
              type: "paragraph",
              start: 0,
              end: 0,
              children: [{ type: "plain", text: "line two", start: 0, end: 0 }],
            },
          ],
        },
      ],
    };
    const out = render(doc);
    expect(out).not.toContain("**>");
    const lines = out.split("\n");
    expect(lines[0]).toBe("> line one");
    for (const line of lines.slice(1)) {
      expect(line.startsWith("> ") || line === ">").toBe(true);
    }
  });
  it("fenced code block with language", () => {
    const md = "```bash\necho hi\n```";
    expect(render(parse(md))).toBe(md);
  });
  it("widens the fence when the content itself contains backticks", () => {
    const doc: Document = {
      blocks: [
        {
          type: "code-block",
          text: "```\nnested fence\n```",
          language: null,
          start: 0,
          end: 0,
        },
      ],
    };
    const out = render(doc);
    // Must not accidentally close early — the emitted fence must be a longer
    // backtick run than any run inside the content.
    const openFenceMatch = out.match(/^`+/);
    expect(openFenceMatch).not.toBeNull();
    expect(openFenceMatch![0].length).toBeGreaterThan(3);
    // Re-parsing the rendered form must recover a single code-block with the
    // exact original text.
    const reparsed = parse(out);
    expect(reparsed.blocks).toHaveLength(1);
    expect(reparsed.blocks[0]).toMatchObject({
      type: "code-block",
      text: "```\nnested fence\n```",
    });
  });
  it("unordered list", () => {
    assertRoundTripsStructurally("- first\n- second\n- third");
  });
  it("ordered list preserves start number", () => {
    assertRoundTripsStructurally("5. five\n6. six");
  });
  it("task list item checked state", () => {
    assertRoundTripsStructurally("- [x] done\n- [ ] not done");
  });
  it("nested list round-trips structurally", () => {
    assertRoundTripsStructurally("- a\n  - nested1\n  - nested2\n- b");
  });
  it("tight 3-level nested list stays tight — no injected blank lines (regression)", () => {
    // Regression: `renderListItem` used to join an item's paragraph and its
    // nested sub-list with a blank line (renderBlocks' `\n\n`), turning a tight
    // nested list into `- a\n\n  - b\n\n    - c\n- d`. Tight lists must stay
    // tight: exact-string round trip, no blank line injected anywhere.
    const md = "- a\n  - b\n    - c\n- d";
    expect(render(parse(md))).toBe(md);
  });
  it("loose list keeps its blank lines between top-level items (tight/loose distinction)", () => {
    // The fix must NOT hardcode single-newline everywhere: a genuinely loose
    // list (blank line between items in the source) round-trips WITH the blank
    // lines preserved.
    const md = "- a\n\n- b\n\n- c";
    expect(render(parse(md))).toBe(md);
  });
  it("loose item with a trailing paragraph keeps its internal blank line", () => {
    const md = "- a\n\n  more about a\n\n- b";
    expect(render(parse(md))).toBe(md);
  });
  it("thematic break", () => {
    expect(render(parse("---"))).toBe("---");
  });
  it("GFM table with mixed alignment", () => {
    const md = [
      "| Left | Center | Right |",
      "| :--- | :---: | ---: |",
      "| a | b | c |",
      "| d | e | f |",
    ].join("\n");
    assertRoundTripsStructurally(md);
  });
  it("table cell content survives round trip", () => {
    const md = ["| Col |", "| --- |", "| **bold** cell |"].join("\n");
    const out = render(parse(md));
    expect(out).toContain("**bold** cell");
  });
  it("neutralizes a `|` inside a code span in a table cell so the row survives (F4)", () => {
    // Source pipe inside the code span is `\|`-escaped so the INPUT is a valid
    // GFM table; the parser folds it to a code node whose text is `a|b`.
    const md = ["| Col |", "| --- |", "| `a\\|b` |"].join("\n");
    const doc = parse(md);
    const srcCell = (doc.blocks[0] as TableNode).rows[0].cells[0].children.find(
      (c: any) => c.type === "code",
    ) as any;
    expect(srcCell.text).toBe("a|b"); // parser captured the literal pipe

    const out = render(doc);
    // The `|` is re-escaped inside the code span so it can't be read as a
    // column separator and tear the row — valid Bot API 10.1 GFM output.
    expect(out).toContain("`a\\|b`");
    // Every rendered table line stays a structurally-valid row (`|`-delimited,
    // balanced) — a torn row would start with `|` but not end with one.
    for (const line of out.split("\n")) {
      if (line.trimStart().startsWith("|")) {
        expect(line.trimEnd().endsWith("|")).toBe(true);
      }
    }
    // And it round-trips: the re-parsed table still has ONE body cell whose
    // code text is `a|b`, not a torn row with an unterminated code span.
    const reparsed = parse(out);
    const reRow = (reparsed.blocks[0] as TableNode).rows[0];
    expect(reRow.cells).toHaveLength(1);
    const reCell = reRow.cells[0].children.find((c: any) => c.type === "code") as any;
    expect(reCell.text).toBe("a|b");
  });
});

describe("render: full document", () => {
  it("multiple blocks are separated by a blank line", () => {
    const doc = parse("# Title\n\nSome text.\n\n- one\n- two");
    const out = render(doc);
    expect(out).toBe("# Title\n\nSome text.\n\n- one\n- two");
  });

  it("round trips the parser's own torture-set style sample", () => {
    const md = [
      "# Report",
      "",
      "A **bold** claim with *italic* support and `a code span`, plus a " +
        "[link](https://example.com) and ~~a retraction~~.",
      "",
      "> a quoted aside",
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      "| latency | 12ms |",
      "",
      "```json\n{\"ok\":true}\n```",
      "",
      "1. step one",
      "2. step two",
    ].join("\n");
    assertRoundTripsStructurally(md);
  });
});

describe("render: construct allowlist", () => {
  it("SUPPORTED_INLINE + SUPPORTED_BLOCK cover every IR node type the parser can emit", () => {
    // Every construct that appears in this mixed document must be in the
    // allowlist — otherwise the renderer's exhaustiveness `default` would have
    // escaped it to literal text (the gap-#2 safety net) rather than emitting
    // native markup.
    const md = [
      "# H",
      "",
      "__u__ **b** *i* ~~s~~ `c` ||sp|| ==hi== [l](https://e.com)",
      "",
      "> quote",
      "",
      "```ts\nx\n```",
      "",
      "- a\n- b",
      "",
      "---",
      "",
      "| A |\n| --- |\n| 1 |",
    ].join("\n");
    const doc = parse(md);
    const inlineTypes = new Set<string>();
    const blockTypes = new Set<string>();
    const walkI = (n: any) => {
      inlineTypes.add(n.type);
      (n.children ?? []).forEach(walkI);
    };
    const walkB = (n: any) => {
      blockTypes.add(n.type);
      switch (n.type) {
        case "paragraph":
        case "heading":
          n.children.forEach(walkI);
          break;
        case "blockquote":
          n.children.forEach(walkB);
          break;
        case "list":
          n.items.forEach((it: any) => it.children.forEach(walkB));
          break;
        case "table":
          [n.header, ...n.rows].forEach((r: any) =>
            r.cells.forEach((c: any) => c.children.forEach(walkI)),
          );
          break;
        // code-block, thematic-break: leaf blocks, no children to walk.
      }
    };
    doc.blocks.forEach(walkB);
    for (const t of blockTypes) expect(SUPPORTED_BLOCK).toContain(t as any);
    for (const t of inlineTypes) expect(SUPPORTED_INLINE).toContain(t as any);
  });
});

describe("renderSafe: degradation tracking", () => {
  it("reports no degradations for a clean under-cap document", () => {
    const result = renderSafe(parse("**hi**"), "**hi**", RICH_MESSAGE_MAX_CHARS);
    expect(result.degradations).toEqual([]);
  });

  it("degrades a MALFORMED table to a code fence and records `table-malformed`", () => {
    // A structurally-broken table (header has 1 column, a body row has 2).
    // mdast normalises real tables, so synthesise the broken IR directly.
    const src = "| A |\n| --- |\n| 1 | 2 |";
    const bad: Document = {
      blocks: [
        {
          type: "table",
          start: 0,
          end: src.length,
          align: [],
          header: { cells: [{ children: [], start: 0, end: 1 }], start: 0, end: 1 },
          rows: [
            {
              cells: [
                { children: [], start: 0, end: 1 },
                { children: [], start: 0, end: 1 },
              ],
              start: 0,
              end: 2,
            },
          ],
        } as TableNode,
      ],
    };
    const result = renderSafe(bad, src, RICH_MESSAGE_MAX_CHARS);
    expect(result.mode).toBe("markdown");
    expect(result.degradations).toHaveLength(1);
    expect(result.degradations[0]).toMatchObject({
      construct: "table",
      reason: "table-malformed",
    });
    // Content preserved as a preformatted code fence (not broken pipes).
    expect(result.text).toContain(src);
    expect(result.text.startsWith("```")).toBe(true);
  });

  it("records an `oversize` degradation when an atomic block is swapped to plain source", () => {
    const smallPara = "Summary line.";
    const hugeRow = "| " + "x".repeat(200) + " |";
    const rows = Array.from({ length: 50 }, () => hugeRow).join("\n");
    const md = `${smallPara}\n\n| Col |\n| --- |\n${rows}`;
    const result = renderSafe(parse(md), md, 500);
    // At least one degradation with an oversize/document reason is recorded.
    expect(result.degradations.length).toBeGreaterThan(0);
    expect(
      result.degradations.some((d) => d.reason === "oversize" || d.reason === "document-oversize"),
    ).toBe(true);
  });

  it("records a `document-oversize` degradation on whole-doc plain fallback", () => {
    const hugeRow = "| " + "x".repeat(2000) + " |";
    const rows = Array.from({ length: 100 }, () => hugeRow).join("\n");
    const md = `| Col |\n| --- |\n${rows}`;
    const result = renderSafe(parse(md), md, 50);
    expect(result.mode).toBe("plain");
    expect(result.degradations.some((d) => d.reason === "document-oversize")).toBe(true);
  });
});

describe("renderSafe: oversized-content fallback", () => {
  it("returns markdown mode unchanged when under the cap", () => {
    const doc = parse("**hi**");
    const result = renderSafe(doc, "**hi**", RICH_MESSAGE_MAX_CHARS);
    expect(result.mode).toBe("markdown");
    expect(result.text).toBe("**hi**");
  });

  it("swaps only the oversized atomic block to plain source text", () => {
    // One small paragraph + one giant table (an atomic, non-bisectable
    // construct). The cap is set low enough that only the table trips it.
    const smallPara = "Summary line.";
    const hugeRow = "| " + "x".repeat(200) + " |";
    const rows = Array.from({ length: 50 }, () => hugeRow).join("\n");
    const md = `${smallPara}\n\n| Col |\n| --- |\n${rows}`;
    const doc = parse(md);
    const maxLen = 500; // full doc exceeds this; the table alone also does
    const result = renderSafe(doc, md, maxLen);

    // Either the table got swapped to plain (raw slice) while the small
    // paragraph stayed rich, or (if that still didn't fit) the WHOLE
    // document fell back to plain — both are acceptable per the "never
    // truncate mid-tag" contract. What must NEVER happen: a truncated /
    // broken markdown table (an unterminated row).
    expect(result.text.length).toBeGreaterThan(0);
    // No dangling unterminated fence or half-row: every line that starts
    // with "|" must also end with "|" (a torn row would violate this).
    for (const line of result.text.split("\n")) {
      if (line.trimStart().startsWith("|")) {
        expect(line.trimEnd().endsWith("|")).toBe(true);
      }
    }
  });

  it("falls back to plain text for the whole document when nothing fits", () => {
    const hugeRow = "| " + "x".repeat(2000) + " |";
    const rows = Array.from({ length: 100 }, () => hugeRow).join("\n");
    const md = `| Col |\n| --- |\n${rows}`;
    const doc = parse(md);
    const result = renderSafe(doc, md, 50); // impossibly small cap
    expect(result.mode).toBe("plain");
    expect(result.text).toBe(md);
  });

  it("never emits a body with an unbalanced code fence", () => {
    const bigCode = "```\n" + "line of code\n".repeat(500) + "```";
    const doc = parse(bigCode);
    const result = renderSafe(doc, bigCode, 200);
    const fenceCount = (result.text.match(/```/g) ?? []).length;
    // A well-formed body has an even number of ``` delimiters (or zero, if
    // it fell back to plain text where the fence markers are inert text).
    if (result.mode === "markdown") {
      expect(fenceCount % 2).toBe(0);
    }
  });
});
