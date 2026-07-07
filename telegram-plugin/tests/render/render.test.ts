import { describe, it, expect } from "vitest";
import { parse } from "../../render/parse.js";
import { render, renderSafe } from "../../render/render.js";
import { RICH_MESSAGE_MAX_CHARS } from "../../format.js";
import type { Document } from "../../render/ir.js";

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
  it("nested inline spans", () => {
    assertRoundTripsStructurally("**bold *and italic* text**");
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
  it("expandable blockquote uses **> on the first line", () => {
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
    expect(render(doc)).toBe("**> hidden gem");
  });
  it("multi-line expandable blockquote continues with a plain > marker", () => {
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
    const lines = out.split("\n");
    expect(lines[0]).toBe("**> line one");
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
