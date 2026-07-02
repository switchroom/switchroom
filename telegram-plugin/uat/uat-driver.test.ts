import { describe, expect, it } from "bun:test";
import { decodeRichMessage } from "./driver.js";

/**
 * Direct unit tests for `decodeRichMessage` — the Bot API 10.1 rich-message
 * decoder in the MTProto UAT driver. These are HOSTED (no live Telegram, no
 * driver session): they feed hand-built Instant-View page trees whose shapes
 * are grounded 1:1 against `@mtcute/tl@223.0.0` (the TL layer mtcute 0.30
 * ships) and assert the flat `{ text, entities }` the decoder produces.
 *
 * They are the CI-verifiable floor under the live render scenario
 * (`scenarios/jtbd-rich-formatting-render-dm.test.ts`), which can only run on
 * the gated uat-host. If Telegram's real GFM parser ever emits a shape these
 * fixtures don't model, the live scenario catches it; these tests pin the
 * decoder's behavior for the shapes we DO model so a decoder regression reds
 * in ordinary CI without needing the runner.
 *
 * TL shape sources (all from `@mtcute/tl@223.0.0` index.d.ts):
 *   RichText:  textPlain{text:string} · textConcat{texts:RichText[]} ·
 *              textBold/Italic/Underline/Strike/Fixed{text:RichText} ·
 *              textUrl{text:RichText,url:string} · textEmail{text,email} ·
 *              textMarked{text:RichText}  (no textSpoiler exists → spoiler)
 *   PageBlock: pageBlockParagraph{text} · pageBlockPreformatted{text,language}
 *              · pageBlockHeader/Subheader{text} · pageBlockBlockquote/
 *              Pullquote{text,caption} · pageBlockList{items:PageListItem[]} ·
 *              pageBlockOrderedList{items:PageListOrderedItem[]} ·
 *              pageBlockTable{title,rows:PageTableRow[]} · pageBlockDivider
 *   Items:     pageListItemText{text} · pageListItemBlocks{blocks} ·
 *              pageListOrderedItemText{num,text} ·
 *              pageListOrderedItemBlocks{num,blocks}
 *   Table:     pageTableRow{cells:PageTableCell[]} ·
 *              pageTableCell{header?,text?:RichText}
 */

// ── RichText builders (grounded shapes) ─────────────────────────────────────
const plain = (text: string) => ({ _: "textPlain", text });
const concat = (...texts: unknown[]) => ({ _: "textConcat", texts });
const bold = (text: unknown) => ({ _: "textBold", text });
const italic = (text: unknown) => ({ _: "textItalic", text });
const underline = (text: unknown) => ({ _: "textUnderline", text });
const strike = (text: unknown) => ({ _: "textStrike", text });
const fixed = (text: unknown) => ({ _: "textFixed", text });
const marked = (text: unknown) => ({ _: "textMarked", text }); // → spoiler
const url = (text: unknown, u: string) => ({ _: "textUrl", text, url: u });
const email = (text: unknown, e: string) => ({ _: "textEmail", text, email: e });

// ── PageBlock builders ──────────────────────────────────────────────────────
const para = (text: unknown) => ({ _: "pageBlockParagraph", text });
const pre = (text: unknown, language = "") => ({
  _: "pageBlockPreformatted",
  text,
  language,
});
const header = (text: unknown) => ({ _: "pageBlockHeader", text });
const subheader = (text: unknown) => ({ _: "pageBlockSubheader", text });
const blockquote = (text: unknown, caption: unknown = { _: "textEmpty" }) => ({
  _: "pageBlockBlockquote",
  text,
  caption,
});
const list = (...items: unknown[]) => ({ _: "pageBlockList", items });
const orderedList = (...items: unknown[]) => ({
  _: "pageBlockOrderedList",
  items,
});
const table = (title: unknown, rows: unknown[]) => ({
  _: "pageBlockTable",
  title,
  rows,
});
const divider = () => ({ _: "pageBlockDivider" });

const itemText = (text: unknown) => ({ _: "pageListItemText", text });
const ordItemText = (num: string, text: unknown) => ({
  _: "pageListOrderedItemText",
  num,
  text,
});
const row = (...cells: unknown[]) => ({ _: "pageTableRow", cells });
const cell = (text: unknown, header = false) => ({
  _: "pageTableCell",
  ...(header ? { header: true } : {}),
  text,
});

const rich = (...blocks: unknown[]) => ({ _: "richMessage", blocks });

// A convenience matcher — find the single entity of a kind.
const entOf = (
  r: { entities: Array<{ kind: string }> },
  kind: string,
) => r.entities.filter((e) => e.kind === kind);

describe("decodeRichMessage — non-rich guards", () => {
  it("returns null for a non-richMessage value", () => {
    expect(decodeRichMessage(undefined)).toBeNull();
    expect(decodeRichMessage(null)).toBeNull();
    expect(decodeRichMessage({ _: "message", blocks: [] })).toBeNull();
    expect(decodeRichMessage({ _: "richMessage" })).toBeNull(); // no blocks[]
  });

  it("decodes an empty block list to empty output", () => {
    expect(decodeRichMessage(rich())).toEqual({ text: "", entities: [] });
  });
});

describe("decodeRichMessage — inline RichText marks (existing coverage)", () => {
  it("bold / italic / code with exact spans", () => {
    const r = decodeRichMessage(
      rich(
        para(
          concat(
            plain("a "),
            bold(plain("bold")),
            plain(" "),
            italic(plain("it")),
            plain(" "),
            fixed(plain("code")),
          ),
        ),
      ),
    )!;
    expect(r.text).toBe("a bold it code");
    expect(entOf(r, "bold")[0]).toMatchObject({ offset: 2, length: 4, text: "bold" });
    expect(entOf(r, "italic")[0]).toMatchObject({ text: "it" });
    expect(entOf(r, "code")[0]).toMatchObject({ text: "code" });
  });

  it("text_link carries the destination url; email classified", () => {
    const r = decodeRichMessage(
      rich(
        para(
          concat(
            url(plain("repo"), "https://example.com/x"),
            plain(" "),
            email(plain("a@b.com"), "a@b.com"),
          ),
        ),
      ),
    )!;
    expect(entOf(r, "text_link")[0]).toMatchObject({
      text: "repo",
      url: "https://example.com/x",
    });
    expect(entOf(r, "email")[0]).toMatchObject({ text: "a@b.com" });
  });

  it("pageBlockPreformatted → a single pre entity with language", () => {
    const r = decodeRichMessage(rich(pre(plain('echo "hi"'), "bash")))!;
    expect(r.text).toBe('echo "hi"');
    expect(entOf(r, "pre")[0]).toMatchObject({
      offset: 0,
      length: 9,
      language: "bash",
    });
  });
});

describe("decodeRichMessage — strikethrough / underline / spoiler marks", () => {
  it("textStrike → strikethrough, textUnderline → underline", () => {
    const r = decodeRichMessage(
      rich(para(concat(strike(plain("gone")), plain(" "), underline(plain("keep"))))),
    )!;
    expect(r.text).toBe("gone keep");
    expect(entOf(r, "strikethrough")[0]).toMatchObject({ text: "gone", offset: 0 });
    expect(entOf(r, "underline")[0]).toMatchObject({ text: "keep", offset: 5 });
  });

  it("textMarked → spoiler (TL 223 has no textSpoiler)", () => {
    const r = decodeRichMessage(rich(para(concat(plain("psst "), marked(plain("secret"))))))!;
    expect(r.text).toBe("psst secret");
    expect(entOf(r, "spoiler")[0]).toMatchObject({ text: "secret", offset: 5 });
  });
});

describe("decodeRichMessage — headings", () => {
  it("pageBlockHeader / Subheader render as bold over the line", () => {
    const r = decodeRichMessage(
      rich(header(plain("Title")), subheader(plain("Sub")), para(plain("body"))),
    )!;
    expect(r.text).toBe("Title\nSub\nbody");
    const bolds = entOf(r, "bold");
    expect(bolds.map((e) => e.text).sort()).toEqual(["Sub", "Title"]);
    expect(bolds.find((e) => e.text === "Title")).toMatchObject({ offset: 0, length: 5 });
  });
});

describe("decodeRichMessage — blockquotes", () => {
  it("pageBlockBlockquote → blockquote entity over the body", () => {
    const r = decodeRichMessage(rich(blockquote(plain("quoted line"))))!;
    expect(r.text).toBe("quoted line");
    expect(entOf(r, "blockquote")[0]).toMatchObject({
      offset: 0,
      length: 11,
      text: "quoted line",
    });
  });

  it("blockquote caption follows on its own line, unstyled", () => {
    const r = decodeRichMessage(rich(blockquote(plain("body"), plain("— src"))))!;
    expect(r.text).toBe("body\n— src");
    expect(entOf(r, "blockquote")[0]).toMatchObject({ text: "body" });
    // caption is not part of the blockquote span
    expect(entOf(r, "blockquote")[0].length).toBe(4);
  });
});

describe("decodeRichMessage — lists", () => {
  it("unordered list → bulleted lines, inline marks preserved", () => {
    const r = decodeRichMessage(
      rich(list(itemText(plain("first")), itemText(bold(plain("second"))))),
    )!;
    expect(r.text).toBe("• first\n• second");
    expect(entOf(r, "bold")[0]).toMatchObject({ text: "second" });
  });

  it("ordered list → numbered lines using the wire .num label", () => {
    const r = decodeRichMessage(
      rich(
        orderedList(
          ordItemText("1", plain("alpha")),
          ordItemText("2", plain("beta")),
        ),
      ),
    )!;
    expect(r.text).toBe("1. alpha\n2. beta");
  });
});

describe("decodeRichMessage — tables", () => {
  it("table rows join with ' | ', header cells emit bold", () => {
    const r = decodeRichMessage(
      rich(
        table({ _: "textEmpty" }, [
          row(cell(plain("H1"), true), cell(plain("H2"), true)),
          row(cell(plain("a")), cell(plain("b"))),
        ]),
      ),
    )!;
    expect(r.text).toBe("H1 | H2\na | b");
    const bolds = entOf(r, "bold").map((e) => e.text).sort();
    expect(bolds).toEqual(["H1", "H2"]);
    // body cells are not bold
    expect(entOf(r, "bold").some((e) => e.text === "a")).toBe(false);
  });

  it("table title renders on its own line above the rows", () => {
    const r = decodeRichMessage(
      rich(table(plain("Scores"), [row(cell(plain("x")), cell(plain("y")))])),
    )!;
    expect(r.text).toBe("Scores\nx | y");
  });
});

describe("decodeRichMessage — divider", () => {
  it("pageBlockDivider → a literal rule line, no entity", () => {
    const r = decodeRichMessage(rich(para(plain("above")), divider(), para(plain("below"))))!;
    expect(r.text).toBe("above\n———\nbelow");
    expect(r.entities).toEqual([]);
  });
});

describe("decodeRichMessage — full torture tree (offsets stay UTF-16 correct)", () => {
  it("mixed blocks decode with coherent offsets across the whole body", () => {
    const r = decodeRichMessage(
      rich(
        header(plain("Report")),
        para(
          concat(
            bold(plain("bold")),
            plain(" "),
            italic(plain("it")),
            plain(" "),
            strike(plain("old")),
            plain(" "),
            marked(plain("spoil")),
          ),
        ),
        blockquote(plain("a wise quote")),
        list(itemText(plain("one")), itemText(plain("two"))),
        orderedList(ordItemText("1", plain("step"))),
        divider(),
        pre(plain("code()"), "js"),
      ),
    )!;
    // Every entity's recorded text must equal the slice at its offset —
    // the invariant that proves offset bookkeeping is coherent.
    for (const e of r.entities) {
      expect(r.text.slice(e.offset, e.offset + e.length)).toBe(e.text);
    }
    // Sanity on the kinds present.
    const kinds = new Set(r.entities.map((e) => e.kind));
    for (const k of ["bold", "italic", "strikethrough", "spoiler", "blockquote", "pre"]) {
      expect(kinds.has(k)).toBe(true);
    }
  });
});
