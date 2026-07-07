// IR -> Telegram rich-markdown renderer for the Telegram HTML render engine
// (name kept for continuity with render/ir.ts + render/parse.ts; the actual
// wire format is GFM markdown, NOT HTML — see the note below).
//
// Increment 2 of the render pipeline: takes the typed IR produced by
// `parse.ts` (per `ir.ts`) and emits a string suitable for the `markdown`
// field of `InputRichMessageMarkdown` (`telegram-plugin/rich-send.ts`).
//
// IMPORTANT — why this emits markdown, not HTML:
// `ir.ts`'s block-type doc comment (written during Increment 1) sketches an
// HTML tag mapping "for the next increment." That comment predates the Bot
// API 10.1 migration (#2669, `telegram-plugin/rich-send.ts`) becoming the
// live send path: `sendRichMessage` / `editMessageText` are called with
// `{ markdown: string }` — raw GFM markdown — not with `{ text, parse_mode:
// "HTML" }`. There is no HTML anywhere on the current outbound path (see
// `reference/telegram-formatting-guide.md`). This renderer therefore targets
// the ACTUAL contract: GFM markdown with the Bot API 10.1 extensions
// documented in the formatting guide (expandable blockquote via `**> `,
// spoiler via `||…||`, GFM pipe tables, etc). This module is NOT wired into
// the live send path yet — that is a later increment, per the RFC's phased
// rollout (rich rendering stays gated off by default until then).
//
// Round-trip note: `parse.ts` folds inline text (`PlainNode.text`,
// `CodeNode.text`, `code-block` `text`, link `href`) into DECODED strings —
// entity references and escapes are already resolved by mdast. Rendering
// back to markdown therefore re-escapes GFM-special characters in prose
// context with `escapeMarkdown` (same helper `format.ts` uses for
// dynamic-content interpolation) and re-defuses embedded backticks in code
// spans with `codeSpanSafe`, so the emitted markdown parses back to
// equivalent entities rather than accidentally re-triggering formatting or
// breaking out of a code span.

import { escapeMarkdown, codeSpanSafe, RICH_MESSAGE_MAX_CHARS } from "../format.js";
import type {
  Block,
  BlockquoteNode,
  CodeBlockNode,
  Document,
  Inline,
  ListItem,
  ListNode,
  TableNode,
  TableRow,
} from "./ir.js";

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(node: Inline): string {
  switch (node.type) {
    case "plain":
      return escapeMarkdown(node.text);
    case "bold":
      return `**${renderInlineChildren(node.children)}**`;
    case "italic":
      return `*${renderInlineChildren(node.children)}*`;
    case "strike":
      return `~~${renderInlineChildren(node.children)}~~`;
    case "spoiler":
      return `||${renderInlineChildren(node.children)}||`;
    case "code":
      return `\`${codeSpanSafe(node.text)}\``;
    case "link":
      return `[${renderInlineChildren(node.children)}](${node.href})`;
    default: {
      // Exhaustiveness guard — the IR union is closed; a new variant must be
      // handled above rather than silently dropped.
      const _exhaustive: never = node;
      return escapeMarkdown((_exhaustive as Inline & { text?: string }).text ?? "");
    }
  }
}

function renderInlineChildren(children: Inline[]): string {
  return children.map(renderInline).join("");
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/** Prefix every line of `text` with `prefix` (used for blockquote nesting). */
function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

function renderBlockquote(node: BlockquoteNode): string {
  const inner = renderBlocks(node.children);
  // Bot API 10.1 expandable blockquote: `**> ` on the first quoted line.
  // Plain blockquote: `> ` on every line.
  if (node.expandable) {
    const lines = inner.split("\n");
    return lines
      .map((line, i) => {
        const marker = i === 0 ? "**> " : "> ";
        return line.length > 0 ? `${marker}${line}` : marker.trimEnd();
      })
      .join("\n");
  }
  return prefixLines(inner, "> ");
}

function renderCodeBlock(node: CodeBlockNode): string {
  const lang = node.language ?? "";
  // Fenced code content is verbatim per the formatting guide; the only
  // hazard is an embedded ``` closing the fence early. Widen the fence to a
  // run of backticks one longer than the longest run already present in the
  // content, mirroring the guide's `preBlock` defusal strategy.
  const longestRun = Math.max(
    0,
    ...(node.text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${node.text}\n${fence}`;
}

function renderListItem(item: ListItem, ordered: boolean, index: number): string {
  const checkbox =
    item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
  const marker = ordered ? `${index}. ` : "- ";
  const body = renderBlocks(item.children);
  const lines = body.split("\n");
  const first = `${marker}${checkbox}${lines[0] ?? ""}`;
  const contIndent = " ".repeat(marker.length);
  const rest = lines
    .slice(1)
    .map((line) => (line.length > 0 ? `${contIndent}${line}` : line));
  return [first, ...rest].join("\n");
}

function renderList(node: ListNode): string {
  const start = node.startNumber ?? 1;
  return node.items
    .map((item, i) => renderListItem(item, node.ordered, start + i))
    .join("\n");
}

/** Render a single cell's inline content for a table (no line breaks — GFM
 *  table cells can't contain them; pipes are escaped defensively). */
function renderTableCell(cells: TableRow["cells"][number]): string {
  return renderInlineChildren(cells.children).replace(/\n+/g, " ");
}

function alignSeparator(align: TableNode["align"][number]): string {
  switch (align) {
    case "left":
      return ":---";
    case "right":
      return "---:";
    case "center":
      return ":---:";
    default:
      return "---";
  }
}

function renderTable(node: TableNode): string {
  const headerCells = node.header.cells.map(renderTableCell);
  const colCount = headerCells.length;
  const align = node.align.length > 0 ? node.align : new Array(colCount).fill(null);
  const headerLine = `| ${headerCells.join(" | ")} |`;
  const sepLine = `| ${align
    .slice(0, colCount)
    .map(alignSeparator)
    .join(" | ")} |`;
  const bodyLines = node.rows.map(
    (row) => `| ${row.cells.map(renderTableCell).join(" | ")} |`,
  );
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function renderBlock(node: Block): string {
  switch (node.type) {
    case "paragraph":
      return renderInlineChildren(node.children);
    case "heading":
      return `${"#".repeat(node.level)} ${renderInlineChildren(node.children)}`;
    case "blockquote":
      return renderBlockquote(node);
    case "code-block":
      return renderCodeBlock(node);
    case "list":
      return renderList(node);
    case "thematic-break":
      return "---";
    case "table":
      return renderTable(node);
    default: {
      const _exhaustive: never = node;
      return escapeMarkdown((_exhaustive as Block & { text?: string }).text ?? "");
    }
  }
}

function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join("\n\n");
}

/** Render a full IR `Document` to Bot API 10.1 rich GFM markdown. */
export function render(doc: Document): string {
  return renderBlocks(doc.blocks);
}

// ---------------------------------------------------------------------------
// Oversized-content safe fallback
// ---------------------------------------------------------------------------

export interface RenderResult {
  /** The rendered text to send. */
  text: string;
  /** "markdown": send as rich `{ markdown }`. "plain": send as a literal
   *  string with no rich wrapper (structure stripped, content preserved). */
  mode: "markdown" | "plain";
}

/**
 * A block is "atomic" for chunking purposes when splitting it mid-construct
 * would break the wire format — an unterminated fence, a half table row, or
 * a blockquote whose closing marker got separated from its opener. These are
 * exactly the constructs `splitMarkdownChunks` (format.ts) already knows how
 * to avoid bisecting for a MULTI-block body, but a SINGLE such block that by
 * itself exceeds the cap has nowhere left to cut without breaking mid-tag —
 * that's the case this module must catch before send.
 */
function isAtomicBlock(node: Block): boolean {
  return (
    node.type === "code-block" ||
    node.type === "table" ||
    node.type === "blockquote"
  );
}

/** Render `node`'s raw source text as a plain literal (escaped so none of
 *  the source's own markdown-special characters accidentally re-trigger
 *  formatting when sent WITHOUT the rich wrapper — a plain send has no
 *  parser, but downstream literal display should still show the author's
 *  intended characters, not stray backslashes, so we use the raw slice
 *  as-is: a plain send does not interpret markdown at all). */
function plainSlice(source: string, node: Block): string {
  return source.slice(node.start, node.end);
}

/**
 * Render `doc` to Bot API 10.1 rich markdown, honoring the wire cap
 * (`RICH_MESSAGE_MAX_CHARS` by default). Behaviour:
 *
 *   1. If the full rendered markdown fits under `maxLen`, return it as-is
 *      (`mode: "markdown"`).
 *   2. Otherwise, any individual ATOMIC block (table / code-block /
 *      blockquote — constructs that cannot be safely bisected without
 *      producing a broken tag/fence/row) whose OWN rendered form alone
 *      exceeds `maxLen` is replaced by its raw plain-text source slice
 *      instead of being emitted as rich markdown that a later chunker would
 *      have to cut mid-construct.
 *   3. If the document *still* exceeds `maxLen` after that per-block
 *      substitution (i.e. the oversized content isn't isolated to one
 *      swappable block, or the whole document is one giant atomic
 *      construct), the ENTIRE document falls back to plain text — the raw
 *      source, verbatim, sent with no rich wrapper at all. This never
 *      truncates: the caller's ordinary length-based chunker
 *      (`splitMarkdownChunks` and `hardSliceToCap`) is what applies size
 *      limits to plain text before send; this function's only job is to
 *      guarantee it is never handed a rich-markdown body with a mid-tag cut.
 */
export function renderSafe(
  doc: Document,
  source: string,
  maxLen: number = RICH_MESSAGE_MAX_CHARS,
): RenderResult {
  const full = render(doc);
  if (full.length <= maxLen) {
    return { text: full, mode: "markdown" };
  }

  const rendered = doc.blocks.map((block) => ({
    block,
    text: renderBlock(block),
  }));

  const swapped = rendered.map(({ block, text }) => {
    if (isAtomicBlock(block) && text.length > maxLen) {
      return escapeMarkdown(plainSlice(source, block));
    }
    return text;
  });
  const patched = swapped.join("\n\n");
  if (patched.length <= maxLen) {
    return { text: patched, mode: "markdown" };
  }

  // Still oversized (or a giant atomic block never fit even as plain text) —
  // fall all the way back to plain text for the whole document. Never
  // truncate here; that is the length-based chunker's job downstream.
  return { text: source, mode: "plain" };
}
