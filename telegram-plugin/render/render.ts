// IR -> Telegram rich-markdown renderer. (The render/ir.ts + render/parse.ts
// files were originally named for an "HTML render engine"; that name is
// historical — the actual wire format is GFM markdown, NOT HTML. See the note
// below and the refreshed header in render/ir.ts.)
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
// documented in the formatting guide (spoiler via `||…||`, GFM pipe tables,
// `<details>` collapsibles passed through as HTML, etc). NOTE: `**> ` is NOT
// part of that contract — it is MarkdownV2-only syntax the rich path renders
// as literal text (wire-verified 2026-08-13); this renderer no longer emits
// it anywhere (see renderBlockquote).
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

import {
  escapeMarkdown,
  codeSpanSafe,
  codeFenceFor,
  escapeLinkHref,
  RICH_MESSAGE_MAX_CHARS,
} from "../format.js";
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

/** Rendering context threaded through the inline walk. `inTableCell` is set
 *  while rendering the inline content of a GFM table cell, where a literal `|`
 *  — even inside an inline-code span — would be read as a column separator and
 *  tear the row (F4). Plain-text `|` is already neutralised by `escapeMarkdown`
 *  (`|` is one of its specials); the only gap is the code span, whose content
 *  is otherwise verbatim, so we backslash-escape `|` there in the table
 *  context. GFM strips the `\` and keeps the pipe literal inside the span. */
interface InlineCtx {
  inTableCell?: boolean;
}

/** Collapse any whitespace run containing a newline down to a single space.
 *  Used for a `tg-entity` label: `![` … `]` must stay on ONE line or the
 *  construct is not an entity any more. mdast decodes a soft line break inside
 *  the alt text to a literal `\n`, which is exactly the case this flattens. */
function collapseLabelBreaks(label: string): string {
  return label.replace(/[ \t]*\r?\n[ \t\r\n]*/g, " ");
}

function renderInline(node: Inline, ctx: InlineCtx = {}): string {
  switch (node.type) {
    case "plain":
      return escapeMarkdown(node.text);
    case "bold":
      return `**${renderInlineChildren(node.children, ctx)}**`;
    case "italic":
      return `*${renderInlineChildren(node.children, ctx)}*`;
    case "underline":
      // The wire renders `__…__` as BOLD, not underline — Telegram's
      // rich-message markdown has no underline token (live-verified; see
      // reference/telegram-formatting-guide.md). We preserve the author's `__`
      // bytes faithfully rather than rewriting them to `**`; the IR keeps
      // underline as a distinct node, but it is NOT a distinct wire style.
      return `__${renderInlineChildren(node.children, ctx)}__`;
    case "strike":
      return `~~${renderInlineChildren(node.children, ctx)}~~`;
    case "spoiler":
      return `||${renderInlineChildren(node.children, ctx)}||`;
    case "highlight":
      return `==${renderInlineChildren(node.children, ctx)}==`;
    case "code": {
      const safe = codeSpanSafe(node.text);
      // In a table cell, an unescaped `|` inside the span closes the cell early
      // and corrupts the row; `\|` survives (GFM keeps the pipe literal in the
      // span and drops the backslash). Elsewhere the span content is verbatim.
      return `\`${ctx.inTableCell ? safe.replace(/\|/g, "\\|") : safe}\``;
    }
    case "link":
      // Escape the href so a literal `)` in the URL can't terminate the
      // destination early and break the link (F3).
      return `[${renderInlineChildren(node.children, ctx)}](${escapeLinkHref(node.href)})`;
    case "tg-entity":
      // `![label](tg://time?unix=…&format=…)` / `![](tg://emoji?id=…)`.
      // The label is PROSE (the alternative text Telegram shows when it can't
      // render the entity), so it is escaped exactly like a `plain` node —
      // without that, a label containing `]` or a formatting delimiter
      // (`![see [22:45]](tg://time?…)`) closes the label early and smuggles
      // raw bracket syntax past the renderer. A newline inside the label would
      // split the construct across lines, so runs of whitespace spanning one
      // are collapsed to a single space first. The href gets the same
      // `escapeLinkHref` treatment a link's does (a no-op for the paren-free
      // `tg:` URLs in practice, load-bearing if one ever carries a `)`).
      return `![${escapeMarkdown(collapseLabelBreaks(node.label))}](${escapeLinkHref(node.href)})`;
    case "raw":
      // Verbatim wire passthrough — the source bytes ARE the wire syntax
      // (footnote reference markers `[^1]` / definition lines `[^1]: …`,
      // which Telegram's rich parser renders natively; escapeMarkdown would
      // escape their `[`/`]` and break the construct — the exact bug this
      // node type exists to prevent).
      return node.text;
    default: {
      // Exhaustiveness guard — the IR union is closed; a new variant must be
      // handled above rather than silently dropped.
      const _exhaustive: never = node;
      return escapeMarkdown((_exhaustive as Inline & { text?: string }).text ?? "");
    }
  }
}

function renderInlineChildren(children: Inline[], ctx: InlineCtx = {}): string {
  return children.map((child) => renderInline(child, ctx)).join("");
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
  // Always a plain `> ` blockquote — including for `expandable: true` nodes.
  //
  // This renderer USED to emit `**> ` on the first line of an expandable
  // quote, believing it to be the Bot API 10.1 expandable-blockquote marker.
  // That belief was falsified by raw sendRichMessage wire probes (2026-08-13):
  // `**>` is MarkdownV2 syntax; the rich markdown path renders it as a LITERAL
  // `**> …` paragraph followed by a detached plain quote. The `expandable`
  // flag is retained on the IR (parse.ts still repairs legacy `**>` input into
  // a real blockquote instead of letting the literal `**>` reach the wire),
  // but it is NOT a distinct wire style — the faithful degradation is a plain
  // quote, which shows the full content. An author who wants a genuine
  // collapsible writes `<details><summary>…</summary>…</details>`, which the
  // rich path renders natively (typed `details` node, wire-verified) and which
  // passes through this pipeline verbatim.
  return prefixLines(inner, "> ");
}

function renderCodeBlock(node: CodeBlockNode): string {
  const lang = node.language ?? "";
  // Fenced code content is verbatim per the formatting guide; the only hazard
  // is an embedded ``` closing the fence early. Width comes from the shared
  // rule (`codeFenceFor`, format.ts) — one backtick longer than the longest
  // run in the body — which the `<pre>` fold and `degradeToCodeFence` use too.
  const fence = codeFenceFor(node.text);
  return `${fence}${lang}\n${node.text}\n${fence}`;
}

function renderListItem(item: ListItem, ordered: boolean, index: number): string {
  const checkbox =
    item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
  const marker = ordered ? `${index}. ` : "- ";
  // Tight item (spread=false): join the item's block children with a single
  // newline so a paragraph and its nested sub-list stay adjacent — no spurious
  // blank line injected before the sub-list. Loose item (spread=true): keep the
  // blank-line separation the source author intended.
  const body = renderBlocksJoined(item.children, item.spread ? "\n\n" : "\n");
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
  // Loose list (spread=true): a blank line between top-level items, as the
  // source author wrote them. Tight list (spread=false, the common case and
  // all nested sub-lists): siblings on adjacent lines, single newline.
  const sep = node.spread ? "\n\n" : "\n";
  return node.items
    .map((item, i) => renderListItem(item, node.ordered, start + i))
    .join(sep);
}

/** Render a single cell's inline content for a table (no line breaks — GFM
 *  table cells can't contain them; pipes are escaped defensively). */
function renderTableCell(cells: TableRow["cells"][number]): string {
  return renderInlineChildren(cells.children, { inTableCell: true }).replace(/\n+/g, " ");
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

/**
 * Escape a line-leading `#` in rendered PROSE so Telegram cannot promote the
 * line to a heading (#3304 regression).
 *
 * Per CommonMark/GFM, `#` opens an ATX heading only when followed by a space,
 * another `#`, or end-of-line — so micromark correctly parses `#3304 is
 * merged.` as a plain paragraph, and this renderer re-emits it verbatim
 * (`escapeMarkdown` deliberately leaves `#` alone). But Telegram's Bot API
 * 10.1 server-side rich-markdown parser is NON-spec here: any line-leading
 * `#` run is read as a heading, so an issue reference opening a line renders
 * the whole paragraph as huge heading text. Backslash-escaping the first `#`
 * of each such line keeps it literal on Telegram while remaining a no-op
 * visually (Telegram honours backslash escapes, same mechanism the link-href
 * `)` escape relies on).
 *
 * Applied ONLY to paragraph output (including paragraphs nested in
 * blockquotes / list items via their renderBlock recursion), never to
 * heading, code-block, or table nodes — so a genuine `# Title` heading node
 * still renders as `# Title`.
 */
function escapeLineLeadingHash(text: string): string {
  return text.replace(/^([ \t]{0,3})#/gm, "$1\\#");
}

function renderBlock(node: Block): string {
  switch (node.type) {
    case "paragraph":
      return escapeLineLeadingHash(renderInlineChildren(node.children));
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

/** Join a run of blocks with an explicit separator. Blockquote children and
 *  the top-level document use a blank line (`\n\n`); tight list items pass a
 *  single newline so a nested sub-list stays adjacent to its item's paragraph
 *  (see `renderListItem`). */
function renderBlocksJoined(blocks: Block[], sep: string): string {
  return blocks.map(renderBlock).join(sep);
}

function renderBlocks(blocks: Block[]): string {
  return renderBlocksJoined(blocks, "\n\n");
}

/** Render a full IR `Document` to Bot API 10.1 rich GFM markdown. */
export function render(doc: Document): string {
  return renderBlocks(doc.blocks);
}

// ---------------------------------------------------------------------------
// Construct allowlist (gap #2: escape/degrade anything unsupported)
// ---------------------------------------------------------------------------

// The IR node types this renderer emits NATIVE Telegram markup for. The IR
// union is closed and TypeScript's exhaustiveness `default` branches in
// `renderInline` / `renderBlock` already escape any unknown variant to literal
// text rather than emitting a broken tag — so the allowlist is enforced at
// COMPILE time. These runtime constants make the allowlist inspectable (and
// unit-testable: a test asserts every IR `type` appears here, so adding an IR
// node without teaching the renderer to render it fails the build), which is
// the concrete "construct-allowlist validator" that pairs with the expandable-
// blockquote / spoiler / underline additions.
export const SUPPORTED_INLINE = [
  "plain",
  "bold",
  "italic",
  // "underline" parses `__…__` into a distinct node and round-trips it, but the
  // wire renders it as BOLD (no underline token on this path). Kept for faithful
  // `__` byte round-trip, NOT because it is a distinct rendered style.
  "underline",
  "strike",
  "spoiler",
  "highlight",
  "code",
  "link",
  // `![…](tg://time?…)` / `![…](tg://emoji?id=…)` — the two inline `tg:`
  // entities in Telegram's Rich Markdown grammar. Emitted verbatim (label and
  // href re-escaped); any OTHER image url stays a `plain` node.
  "tg-entity",
  // Verbatim passthrough for constructs whose SOURCE bytes are the wire syntax
  // (footnote markers/definitions). Never escaped, never rewritten.
  "raw",
] as const;

export const SUPPORTED_BLOCK = [
  "paragraph",
  "heading",
  "blockquote",
  "code-block",
  "list",
  "thematic-break",
  "table",
] as const;

// ---------------------------------------------------------------------------
// Oversized / malformed-content safe fallback
// ---------------------------------------------------------------------------

/** Which construct degraded. `document` = the whole message fell back to
 *  plain text. */
export type DegradationConstruct = "table" | "code-block" | "blockquote" | "document";

/** Why a construct could not be emitted as a proper rich construct.
 *   - `table-malformed`    : the table's structure is not renderable as a rich
 *                            GFM table (e.g. no columns, ragged rows); emitted
 *                            as a preformatted code fence instead.
 *   - `oversize`           : a single atomic block alone exceeds the wire cap;
 *                            emitted as plain source text.
 *   - `document-oversize`  : the whole document still exceeds the cap after
 *                            per-block substitution; sent as plain text with no
 *                            rich wrapper. */
export type DegradationReason = "table-malformed" | "oversize" | "document-oversize";

/** A tracked degradation — WHY a construct fell back from its native rich form
 *  to a plain/code rendering. Returned on `RenderResult` so the caller can log
 *  / surface it instead of the fallback happening silently. */
export interface Degradation {
  construct: DegradationConstruct;
  reason: DegradationReason;
  /** Human-readable detail for logs / telemetry. */
  detail: string;
}

export interface RenderResult {
  /** The rendered text to send. */
  text: string;
  /** "markdown": send as rich `{ markdown }`. "plain": send as a literal
   *  string with no rich wrapper (structure stripped, content preserved). */
  mode: "markdown" | "plain";
  /** Constructs that could not be emitted in their native rich form, each with
   *  a tracked reason. Empty when everything rendered natively. Never silently
   *  degrade — a caller can log/telemeter these. */
  degradations: Degradation[];
}

/**
 * Classify a table that cannot render as a proper rich GFM table. Returns a
 * human-readable reason string, or null when the table is well-formed.
 *
 * mdast normally normalises tables, but a table folded from degraded/adversarial
 * source (or a future IR producer) can still be structurally unrenderable — no
 * header columns, or body rows whose cell count doesn't match the header. Such a
 * table would emit pipes that Telegram renders as broken/literal text, so we
 * catch it here and fall back to a preformatted code fence (content preserved,
 * degradation tracked) rather than shipping a broken row.
 */
function tableDegradationReason(node: TableNode): string | null {
  const cols = node.header.cells.length;
  if (cols === 0) return "table has no header columns";
  for (let i = 0; i < node.rows.length; i++) {
    const n = node.rows[i].cells.length;
    if (n !== cols) {
      return `row ${i + 1} has ${n} cell(s), expected ${cols} to match the header`;
    }
  }
  return null;
}

/** Wrap a block's raw source text in a widened preformatted code fence — the
 *  degraded rendering for a malformed table (content verbatim, no broken
 *  markup). Fence-widening is the shared `codeFenceFor` rule. */
function degradeToCodeFence(source: string, node: Block): string {
  const raw = source.slice(node.start, node.end);
  const fence = codeFenceFor(raw);
  return `${fence}\n${raw}\n${fence}`;
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
  const degradations: Degradation[] = [];

  // Per-block render, degrading a MALFORMED table (any size) to a preformatted
  // code fence up front so a structurally-unrenderable table never ships as
  // broken pipes — and the reason is recorded, not swallowed.
  const rendered = doc.blocks.map((block) => {
    if (block.type === "table") {
      const reason = tableDegradationReason(block);
      if (reason != null) {
        degradations.push({ construct: "table", reason: "table-malformed", detail: reason });
        return { block, text: degradeToCodeFence(source, block) };
      }
    }
    return { block, text: renderBlock(block) };
  });

  const full = rendered.map((r) => r.text).join("\n\n");
  if (full.length <= maxLen) {
    return { text: full, mode: "markdown", degradations };
  }

  // Oversized: swap any atomic block whose OWN rendered form alone exceeds the
  // cap for its raw plain-text source (a construct that can't be safely
  // bisected), recording an `oversize` degradation for each.
  const swapped = rendered.map(({ block, text }) => {
    if (isAtomicBlock(block) && text.length > maxLen) {
      degradations.push({
        construct: block.type as DegradationConstruct,
        reason: "oversize",
        detail: `${block.type} of ${text.length} chars exceeds the ${maxLen}-char cap; sent as plain source text`,
      });
      return escapeMarkdown(plainSlice(source, block));
    }
    return text;
  });
  const patched = swapped.join("\n\n");
  if (patched.length <= maxLen) {
    return { text: patched, mode: "markdown", degradations };
  }

  // Still oversized (or a giant atomic block never fit even as plain text) —
  // fall all the way back to plain text for the whole document. Never
  // truncate here; that is the length-based chunker's job downstream.
  degradations.push({
    construct: "document",
    reason: "document-oversize",
    detail: `rendered document of ${patched.length} chars exceeds the ${maxLen}-char cap; sent as plain text without the rich wrapper`,
  });
  return { text: source, mode: "plain", degradations };
}
