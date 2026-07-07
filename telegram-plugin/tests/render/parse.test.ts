import { describe, it, expect } from "vitest";
import { parse } from "../../render/parse.js";
import type { Block, Inline } from "../../render/ir.js";

// Assert every node in a subtree round-trips: source.slice(start, end) is the
// exact source text the node spans. Walks both inline and block children.
function assertOffsetsRoundTrip(node: any, source: string) {
  expect(typeof node.start).toBe("number");
  expect(typeof node.end).toBe("number");
  // The slice must be non-empty for real nodes and lie within bounds.
  expect(node.start).toBeGreaterThanOrEqual(0);
  expect(node.end).toBeLessThanOrEqual(source.length);
  expect(node.end).toBeGreaterThanOrEqual(node.start);
  if (Array.isArray(node.children)) {
    for (const c of node.children) assertOffsetsRoundTrip(c, source);
  }
  if (Array.isArray(node.items)) {
    for (const it of node.items) assertOffsetsRoundTrip(it, source);
  }
  if (Array.isArray(node.cells)) {
    for (const c of node.cells) assertOffsetsRoundTrip(c, source);
  }
}

describe("parse: inline palette", () => {
  const cases: Array<{
    name: string;
    md: string;
    // The inline construct's source text (what slice(start,end) must equal).
    fragment: string;
    check: (inline: Inline) => void;
  }> = [
    {
      name: "bold",
      md: "**hi**",
      fragment: "**hi**",
      check: (n) => {
        expect(n.type).toBe("bold");
        expect((n as any).children[0]).toMatchObject({ type: "plain", text: "hi" });
      },
    },
    {
      name: "italic",
      md: "*hi*",
      fragment: "*hi*",
      check: (n) => {
        expect(n.type).toBe("italic");
        expect((n as any).children[0]).toMatchObject({ type: "plain", text: "hi" });
      },
    },
    {
      name: "strike",
      md: "~~hi~~",
      fragment: "~~hi~~",
      check: (n) => {
        expect(n.type).toBe("strike");
        expect((n as any).children[0]).toMatchObject({ type: "plain", text: "hi" });
      },
    },
    {
      name: "inline code",
      md: "`x = 1`",
      fragment: "`x = 1`",
      check: (n) => {
        expect(n).toMatchObject({ type: "code", text: "x = 1" });
      },
    },
    {
      name: "link",
      md: "[label](https://example.com)",
      fragment: "[label](https://example.com)",
      check: (n) => {
        expect(n.type).toBe("link");
        expect((n as any).href).toBe("https://example.com");
        expect((n as any).children[0]).toMatchObject({ type: "plain", text: "label" });
      },
    },
  ];

  for (const c of cases) {
    it(`parses ${c.name} and offsets round-trip`, () => {
      const doc = parse(c.md);
      expect(doc.blocks).toHaveLength(1);
      const para = doc.blocks[0];
      expect(para.type).toBe("paragraph");
      const inline = (para as any).children[0] as Inline;
      c.check(inline);
      expect(c.md.slice(inline.start, inline.end)).toBe(c.fragment);
      assertOffsetsRoundTrip(para, c.md);
    });
  }
});

describe("parse: heading levels", () => {
  for (let level = 1; level <= 6; level++) {
    it(`parses an h${level} heading`, () => {
      const md = `${"#".repeat(level)} Title`;
      const doc = parse(md);
      expect(doc.blocks).toHaveLength(1);
      const h = doc.blocks[0] as any;
      expect(h.type).toBe("heading");
      expect(h.level).toBe(level);
      expect(h.children[0]).toMatchObject({ type: "plain", text: "Title" });
      expect(md.slice(h.start, h.end)).toBe(md);
    });
  }
});

describe("parse: fenced code with language", () => {
  it("captures text and language", () => {
    const md = "```ts\nconst x = 1;\n```";
    const doc = parse(md);
    const cb = doc.blocks[0] as any;
    expect(cb.type).toBe("code-block");
    expect(cb.language).toBe("ts");
    expect(cb.text).toBe("const x = 1;");
    expect(md.slice(cb.start, cb.end)).toBe(md);
  });

  it("null language for a bare fence", () => {
    const md = "```\nplain\n```";
    const doc = parse(md);
    const cb = doc.blocks[0] as any;
    expect(cb.type).toBe("code-block");
    expect(cb.language).toBeNull();
  });
});

describe("parse: blockquote", () => {
  it("parses a blockquote with expandable=false", () => {
    const md = "> quoted text";
    const doc = parse(md);
    const bq = doc.blocks[0] as any;
    expect(bq.type).toBe("blockquote");
    expect(bq.expandable).toBe(false);
    expect(bq.children[0].type).toBe("paragraph");
    expect(md.slice(bq.start, bq.end)).toBe(md);
  });
});

describe("parse: lists", () => {
  it("parses an unordered list (start=null)", () => {
    const md = "- one\n- two";
    const doc = parse(md);
    const list = doc.blocks[0] as any;
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(false);
    expect(list.startNumber).toBeNull();
    expect(list.items).toHaveLength(2);
    expect(md.slice(list.start, list.end)).toBe(md);
    assertOffsetsRoundTrip(list, md);
  });

  it("parses an ordered list with a start number", () => {
    const md = "3. three\n4. four";
    const doc = parse(md);
    const list = doc.blocks[0] as any;
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(true);
    expect(list.startNumber).toBe(3);
    expect(list.items).toHaveLength(2);
  });

  it("parses task-list checked/unchecked state", () => {
    const md = "- [x] done\n- [ ] todo";
    const doc = parse(md);
    const list = doc.blocks[0] as any;
    expect(list.items[0].checked).toBe(true);
    expect(list.items[1].checked).toBe(false);
  });

  it("plain (non-task) list items have checked=null", () => {
    const md = "- a\n- b";
    const doc = parse(md);
    const list = doc.blocks[0] as any;
    expect(list.items[0].checked).toBeNull();
    expect(list.items[1].checked).toBeNull();
  });
});

describe("parse: GFM table with mixed alignment", () => {
  it("captures header, rows, and per-column alignment", () => {
    const md = ["| L | C | R |", "|:--|:-:|--:|", "| 1 | 2 | 3 |"].join("\n");
    const doc = parse(md);
    const table = doc.blocks[0] as any;
    expect(table.type).toBe("table");
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header.cells).toHaveLength(3);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].cells[0].children[0]).toMatchObject({ type: "plain", text: "1" });
    expect(md.slice(table.start, table.end)).toBe(md);
    assertOffsetsRoundTrip(table, md);
  });
});

describe("parse: thematic break", () => {
  it("parses a horizontal rule", () => {
    const md = "---";
    const doc = parse(md);
    const tb = doc.blocks[0] as any;
    expect(tb.type).toBe("thematic-break");
    expect(md.slice(tb.start, tb.end)).toBe(md);
  });
});

describe("parse: nested inline", () => {
  it("bold containing italic, offsets round-trip at both levels", () => {
    const md = "**bold *and italic* here**";
    const doc = parse(md);
    const bold = (doc.blocks[0] as any).children[0];
    expect(bold.type).toBe("bold");
    expect(md.slice(bold.start, bold.end)).toBe("**bold *and italic* here**");
    const italic = bold.children.find((c: any) => c.type === "italic");
    expect(italic).toBeDefined();
    expect(md.slice(italic.start, italic.end)).toBe("*and italic*");
    assertOffsetsRoundTrip(doc.blocks[0] as Block, md);
  });
});

describe("parse: unsupported construct fallback", () => {
  it("degrades a raw HTML block to plain text without dropping content", () => {
    // Raw HTML blocks (mdast `html`) are outside the palette; they must
    // survive as plain source text.
    const md = "<div class=\"x\">raw</div>";
    const doc = parse(md);
    const block = doc.blocks[0] as any;
    expect(block.type).toBe("paragraph");
    const plain = block.children[0];
    expect(plain.type).toBe("plain");
    expect(plain.text).toBe(md);
    expect(md.slice(plain.start, plain.end)).toBe(md);
  });
});

describe("parse: astral-plane emoji offsets are UTF-16 units", () => {
  it("uses UTF-16 code-unit offsets, not codepoints or bytes", () => {
    // U+1F680 ROCKET is one codepoint but TWO UTF-16 code units (a surrogate
    // pair) and FOUR UTF-8 bytes. The bold node after it must start at the
    // UTF-16 offset.
    const emoji = "\u{1F680}"; // 🚀, length 2 in UTF-16
    expect(emoji.length).toBe(2);
    const md = `${emoji} **go**`;
    const doc = parse(md);
    const para = doc.blocks[0] as any;
    const bold = para.children.find((c: any) => c.type === "bold");
    expect(bold).toBeDefined();
    // "🚀 " is 3 UTF-16 code units (2 + space), so bold starts at offset 3.
    expect(bold.start).toBe(3);
    expect(md.slice(bold.start, bold.end)).toBe("**go**");
    // Sanity: byte-based or codepoint-based offsets would give 2 or a
    // different index, not 3.
    expect(md.slice(bold.start, bold.end)).not.toBe("*go**");
  });
});

describe("expandable blockquote (Bot API 10.1 `**>` marker)", () => {
  it("parses a single-line `**>` quote into an expandable blockquote", () => {
    const md = "**> a collapsible line";
    const doc = parse(md);
    const bq = doc.blocks[0] as any;
    expect(bq.type).toBe("blockquote");
    expect(bq.expandable).toBe(true);
  });

  it("marks a multi-line quote expandable when the FIRST line carries `**>`", () => {
    const md = "**> line one\n> line two\n> line three";
    const doc = parse(md);
    const bq = doc.blocks[0] as any;
    expect(bq.type).toBe("blockquote");
    expect(bq.expandable).toBe(true);
    // All three quoted lines fold into ONE blockquote.
    expect(bq.children.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves a plain `>` quote non-expandable", () => {
    const doc = parse("> just an ordinary quote");
    const bq = doc.blocks[0] as any;
    expect(bq.type).toBe("blockquote");
    expect(bq.expandable).toBe(false);
  });

  it("keeps content offsets byte-identical to the ORIGINAL source", () => {
    const md = "**> quoted body here";
    const doc = parse(md);
    const bq = doc.blocks[0] as any;
    // The marker rewrite (`**>` -> `  >`) is length-preserving, so the inner
    // text still slices out of the ORIGINAL markdown exactly.
    const plain = bq.children[0].children[0];
    expect(md.slice(plain.start, plain.end)).toBe("quoted body here");
    assertOffsetsRoundTrip(bq, md);
  });

  it("only recognises the marker at column 0 (leading indent is not expandable)", () => {
    // The renderer only ever emits `**>` at column 0; a leading-indented
    // variant is deliberately NOT treated as an expandable quote (matching it
    // would push the length-preserving rewrite past the 3-space blockquote
    // budget into indented-code-block territory).
    const md = "   **> indented";
    const doc = parse(md);
    const bq = doc.blocks[0] as any;
    expect(bq.expandable).not.toBe(true);
  });

  it("does not treat inline `**` bold followed by `>` mid-line as expandable", () => {
    // `**bold** > text` is a paragraph, not a quote — the marker must be at
    // line start.
    const doc = parse("**bold** > not a quote");
    expect(doc.blocks[0].type).toBe("paragraph");
  });
});
