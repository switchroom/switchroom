// Markdown -> typed IR parser for the Telegram HTML render engine.
//
// Uses `mdast-util-from-markdown` (micromark under the hood) with the GFM
// syntax + mdast extensions to obtain an mdast tree, then folds that tree into
// the IR defined in `ir.ts`. This is Increment 1: parser + IR only. There is
// no renderer and no chunker yet, and nothing here is wired into the live send
// path.
//
// Design rules honored here:
//   - Every emitted node copies UTF-16 source offsets straight off mdast
//     `position.start.offset` / `position.end.offset`, so
//     `source.slice(node.start, node.end)` round-trips to the source text.
//   - Never lose text. Any mdast node type outside the supported palette
//     degrades to a `plain` inline (or a paragraph wrapping one) carrying the
//     raw source slice, rather than being dropped.
//
// Spoiler handling (IR has a `spoiler` node, mdast/GFM has no spoiler concept):
//   Increment 1 does NOT emit `spoiler` nodes. GFM has no spoiler syntax, and
//   introducing the switchroom `||…||` convention means teaching micromark a
//   custom inline extension — out of scope for the parser+IR increment. The IR
//   type stays in place; a later increment adds a micromark inline extension
//   (or a post-parse pass over `plain` text) that recognises the spoiler
//   delimiter and emits `SpoilerNode`. Until then spoiler delimiters fold into
//   `plain`/`emphasis` text like any other characters.
//
// Blockquote expandable handling:
//   The IR carries `expandable: boolean` for Telegram's `<blockquote
//   expandable>`. GFM blockquotes have no expandable marker, so Increment 1
//   always sets `expandable = false`. TODO(next increment): recognise the
//   `‖…‖` / expandable source convention and set the flag.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type {
  Node as MdastNode,
  Parent as MdastParent,
  RootContent,
  PhrasingContent,
  AlignType,
} from "mdast";

import type {
  Block,
  Document,
  Inline,
  ListItem,
  Pos,
  TableCell,
  TableRow,
} from "./ir.js";

/** Copy UTF-16 offsets off an mdast node. Falls back to 0-length when a
 *  synthesized node lacks a position (from-markdown always sets one, but the
 *  mdast types make `position` optional). */
function pos(node: MdastNode): Pos {
  const p = node.position;
  return {
    start: p?.start?.offset ?? 0,
    end: p?.end?.offset ?? 0,
  };
}

/** Raw source text a node spans — used for the never-lose-text fallback. */
function slice(source: string, node: MdastNode): string {
  const { start, end } = pos(node);
  return source.slice(start, end);
}

/** mdast `AlignType` (null | 'left' | 'right' | 'center') passes through
 *  unchanged; the IR uses the same union. */
function foldAlign(a: AlignType | undefined): "left" | "center" | "right" | null {
  return a ?? null;
}

function foldInline(node: PhrasingContent, source: string): Inline {
  switch (node.type) {
    case "text":
      return { type: "plain", text: node.value, ...pos(node) };
    case "strong":
      return { type: "bold", children: foldInlineChildren(node, source), ...pos(node) };
    case "emphasis":
      return { type: "italic", children: foldInlineChildren(node, source), ...pos(node) };
    case "delete":
      return { type: "strike", children: foldInlineChildren(node, source), ...pos(node) };
    case "inlineCode":
      return { type: "code", text: node.value, ...pos(node) };
    case "link":
      return {
        type: "link",
        href: node.url,
        children: foldInlineChildren(node, source),
        ...pos(node),
      };
    // Not in the palette (break, image, html, footnoteReference, …): keep the
    // raw source text so no content is lost.
    default:
      return { type: "plain", text: slice(source, node), ...pos(node) };
  }
}

function foldInlineChildren(node: MdastParent, source: string): Inline[] {
  return node.children.map((c) => foldInline(c as PhrasingContent, source));
}

function foldTableRow(
  row: Extract<RootContent, { type: "tableRow" }>,
  source: string,
): TableRow {
  const cells: TableCell[] = row.children.map((cell) => ({
    children: cell.children.map((c) => foldInline(c as PhrasingContent, source)),
    ...pos(cell),
  }));
  return { cells, ...pos(row) };
}

function foldBlock(node: RootContent, source: string): Block {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: foldInlineChildren(node, source), ...pos(node) };
    case "heading":
      return {
        type: "heading",
        level: node.depth,
        children: foldInlineChildren(node, source),
        ...pos(node),
      };
    case "blockquote":
      return {
        type: "blockquote",
        children: node.children.map((c) => foldBlock(c, source)),
        // GFM has no expandable marker — always false in Increment 1.
        expandable: false,
        ...pos(node),
      };
    case "code":
      return {
        type: "code-block",
        text: node.value,
        language: node.lang ?? null,
        ...pos(node),
      };
    case "list": {
      const items: ListItem[] = node.children.map((li) => ({
        children: li.children.map((c) => foldBlock(c, source)),
        checked: li.checked ?? null,
        ...pos(li),
      }));
      return {
        type: "list",
        ordered: node.ordered ?? false,
        startNumber: node.ordered ? node.start ?? 1 : null,
        items,
        ...pos(node),
      };
    }
    case "thematicBreak":
      return { type: "thematic-break", ...pos(node) };
    case "table": {
      const rows = node.children;
      const [headerRow, ...bodyRows] = rows;
      return {
        type: "table",
        header: foldTableRow(headerRow, source),
        rows: bodyRows.map((r) => foldTableRow(r, source)),
        align: (node.align ?? []).map(foldAlign),
        ...pos(node),
      };
    }
    // Not in the palette (html, definition, footnoteDefinition, …): degrade to
    // a paragraph carrying the raw source slice so no content is dropped.
    default:
      return {
        type: "paragraph",
        children: [{ type: "plain", text: slice(source, node), ...pos(node) }],
        ...pos(node),
      };
  }
}

/** Parse a markdown string into the typed IR Document. */
export function parse(markdown: string): Document {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return {
    blocks: tree.children.map((child) => foldBlock(child, markdown)),
  };
}
