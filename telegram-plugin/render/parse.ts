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
// Underline vs bold (`__…__` vs `**…**`):
//   Telegram's Bot API 10.1 rich markdown reads a `__…__` double-underscore run
//   as UNDERLINE and a `**…**` run as BOLD. GFM/micromark folds BOTH into one
//   `strong` mdast node with no record of which delimiter was used. This module
//   disambiguates by reading the run's source delimiter off its UTF-16 offsets
//   (`source.slice(start, start+2)`): `__` → `underline`, anything else →
//   `bold`. A single `_…_` / `*…*` run stays `italic` (emphasis) either way.
//
// Spoiler + highlight handling (`||…||`, `==…==`):
//   The IR carries `spoiler` and `highlight` nodes but GFM/micromark has no
//   syntax for either — both delimiters fold into ordinary `plain` text. Rather
//   than teach micromark two custom inline extensions, this module recognises
//   them in a POST-PARSE pass over the folded `plain` nodes (`expandPlainNode`),
//   splitting a `||secret||` / `==marked==` run into the matching
//   `SpoilerNode` / `HighlightNode`. Recognition is per-`plain`-node: the
//   delimited content must be a single contiguous plain-text run on one line
//   (formatting INSIDE a spoiler — `||**bold**||` — is left as literal
//   delimiters, since `**bold**` is already its own mdast node). A delimiter
//   that does not form a closed, non-empty, single-line pair stays literal
//   plain text and is re-escaped on render. This faithfully mirrors Telegram's
//   own reading of the delimiters.
//
// Blockquote expandable handling:
//   The IR carries `expandable: boolean` for Telegram's expandable blockquote
//   (Bot API 10.1). GFM has no expandable marker; the switchroom render path
//   emits `**> ` on the FIRST line of an expandable quote (`render.ts` /
//   `reference/telegram-formatting-guide.md`). micromark does NOT understand
//   `**> ` as a blockquote — the leading `**` makes the line a paragraph with
//   an unclosed strong-emphasis run — so this module pre-transforms each
//   `**>` marker into a plain `  >` marker of IDENTICAL length (`**` → two
//   spaces) before handing the text to mdast. Length preservation keeps every
//   UTF-16 source offset (and therefore the never-lose-text round-trip
//   invariant against the ORIGINAL source) exactly intact — only the two
//   marker characters differ, and they are never part of quoted content. The
//   set of line-start offsets that carried the marker is threaded into
//   `foldBlock` so the matching blockquote nodes get `expandable: true`.

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
  PlainNode,
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

/** The Bot API 10.1 expandable-blockquote marker: `**>` at the very start of
 *  a line (column 0). This is exactly what the render path emits
 *  (`render.ts` writes `**> ` on the first line of an expandable quote; see
 *  `reference/telegram-formatting-guide.md`). Matching only at column 0 keeps
 *  the length-preserving rewrite (`**` → two spaces) inside CommonMark's
 *  3-space blockquote-indent budget — allowing leading indent here would push
 *  the rewritten `  >` past 3 spaces and turn it into an indented code block. */
const EXPANDABLE_MARKER_RE = /^\*\*>/;

/** The `tg:` hrefs Telegram's "Rich Markdown style" grammar accepts in IMAGE
 *  position — `![label](tg://…)`. Exactly two are documented
 *  (https://core.telegram.org/bots/api): `tg://emoji?id=…` (custom emoji) and
 *  `tg://time?unix=…[&format=…]` (the `date_time` entity). Deliberately an
 *  ALLOWLIST rather than a bare `tg:` scheme test: an undocumented `tg://…` in
 *  image position is not known-good syntax, and demoting it to literal text
 *  (the historical behaviour) is safer than shipping a construct Telegram may
 *  parse-reject. */
const TG_INLINE_ENTITY_HREFS = ["tg://emoji", "tg://time"] as const;

/** True when an mdast `image` url is one of the documented inline `tg:`
 *  entities. Scheme/host comparison is case-insensitive (URLs are), but the
 *  ORIGINAL href is what gets re-emitted — we never rewrite the author's bytes. */
function isTgInlineEntityHref(href: string): boolean {
  const h = href.toLowerCase();
  return TG_INLINE_ENTITY_HREFS.some((base) => h === base || h.startsWith(`${base}?`));
}

/** Pre-transform expandable-blockquote markers so mdast can parse them as
 *  ordinary blockquotes, WITHOUT shifting any source offset. Each line that
 *  opens with `**>` has its two `*` characters replaced by two spaces
 *  (`**>` → `  >`), which micromark reads as a normal (optionally
 *  1–3-space-indented) blockquote line. Returns the rewritten text plus the
 *  set of line-start offsets that carried the marker — `foldBlock` uses that
 *  set to flip `expandable: true` on the produced blockquote nodes. */
function markExpandableQuotes(markdown: string): {
  text: string;
  expandableLineStarts: Set<number>;
} {
  const expandableLineStarts = new Set<number>();
  let out = "";
  let offset = 0;
  // Split keeping the trailing newline on each line so offsets are exact.
  for (const line of markdown.split(/(?<=\n)/)) {
    if (EXPANDABLE_MARKER_RE.test(line)) {
      expandableLineStarts.add(offset);
      // Replace the leading two `*` chars with two spaces; the `>` and
      // everything after it are untouched (`**> x` -> `  > x`), a valid
      // 2-space-indented blockquote that mdast parses normally.
      out += "  " + line.slice(2);
    } else {
      out += line;
    }
    offset += line.length;
  }
  return { text: out, expandableLineStarts };
}

/** Offset of the start of the line containing `offset` in `source`. */
function lineStart(source: string, offset: number): number {
  let i = offset;
  while (i > 0 && source[i - 1] !== "\n") i--;
  return i;
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
    case "strong": {
      // GFM folds both `**…**` (bold) and `__…__` (underline) into one `strong`
      // node. Recover the intended construct from the source delimiter.
      const p = pos(node);
      const underline = source.slice(p.start, p.start + 2) === "__";
      return {
        type: underline ? "underline" : "bold",
        children: foldInlineChildren(node, source),
        ...p,
      };
    }
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
    case "image": {
      // GFM's image syntax doubles as Telegram's INLINE-entity syntax:
      // `![22:45 tomorrow](tg://time?unix=…&format=…)` (date_time) and
      // `![](tg://emoji?id=…)` (custom emoji). Fold those two into a
      // `tg-entity` node so the renderer re-emits the construct verbatim
      // instead of escaping the brackets to literal text. Every OTHER image
      // url — notably the http(s) MEDIA forms, which Telegram accepts only as
      // a SEPARATE block — falls through to the demote-to-`plain` default
      // below, unchanged.
      if (isTgInlineEntityHref(node.url)) {
        return { type: "tg-entity", label: node.alt ?? "", href: node.url, ...pos(node) };
      }
      return { type: "plain", text: slice(source, node), ...pos(node) };
    }
    // Not in the palette (break, non-`tg:` image, html, footnoteReference, …):
    // keep the raw source text so no content is lost.
    default:
      return { type: "plain", text: slice(source, node), ...pos(node) };
  }
}

// ---------------------------------------------------------------------------
// Post-parse inline-marker recognition (spoiler `||…||`, highlight `==…==`)
// ---------------------------------------------------------------------------

/** The post-parse inline delimiters GFM/micromark doesn't natively model. Each
 *  matches a CLOSED, NON-EMPTY, single-line delimited run inside `plain` text.
 *  `delim` is the delimiter length (both are 2 chars). */
const INLINE_MARKER_SPECS: ReadonlyArray<{
  type: "spoiler" | "highlight";
  re: RegExp;
  delim: number;
}> = [
  { type: "spoiler", re: /\|\|([^|\n]+)\|\|/, delim: 2 },
  { type: "highlight", re: /==([^=\n]+)==/, delim: 2 },
];

function mkPlain(text: string, start: number, end: number): PlainNode {
  return { type: "plain", text, start, end };
}

/** Split a single `plain` node's text into `plain` / `spoiler` / `highlight`
 *  nodes by recognising `||…||` and `==…==` runs. Offsets are exact when the
 *  node's source slice equals its decoded text (the common no-escape case);
 *  otherwise every produced piece inherits the original node's span (still a
 *  valid in-bounds offset, just not byte-slice-exact). Recurses so a marker
 *  nested in plain text after another marker is also recognised. */
function expandPlainNode(node: PlainNode, source: string): Inline[] {
  const text = node.text;
  if (text.length === 0) return [node];
  const exact = source.slice(node.start, node.end) === text;
  const abs = (k: number): number => (exact ? node.start + k : node.start);
  const absEnd = (k: number): number => (exact ? node.start + k : node.end);

  // Earliest marker match across all delimiter kinds.
  let best:
    | { idx: number; full: number; inner: string; type: "spoiler" | "highlight"; delim: number }
    | null = null;
  for (const spec of INLINE_MARKER_SPECS) {
    const m = spec.re.exec(text);
    if (m != null && m[1].length > 0 && (best === null || m.index < best.idx)) {
      best = { idx: m.index, full: m[0].length, inner: m[1], type: spec.type, delim: spec.delim };
    }
  }
  if (best === null) return [node];

  const out: Inline[] = [];
  if (best.idx > 0) out.push(mkPlain(text.slice(0, best.idx), abs(0), abs(best.idx)));

  const innerStart = abs(best.idx + best.delim);
  const innerEnd = absEnd(best.idx + best.delim + best.inner.length);
  const innerPlain = mkPlain(best.inner, innerStart, innerEnd);
  out.push({
    type: best.type,
    children: expandPlainNode(innerPlain, source),
    start: abs(best.idx),
    end: absEnd(best.idx + best.full),
  });

  const rest = text.slice(best.idx + best.full);
  if (rest.length > 0) {
    out.push(...expandPlainNode(mkPlain(rest, abs(best.idx + best.full), node.end), source));
  }
  return out;
}

/** Fold a run of mdast phrasing children into IR inlines, then run the
 *  post-parse spoiler/highlight recognition over the produced `plain` nodes. */
function buildInlines(children: ReadonlyArray<MdastNode>, source: string): Inline[] {
  return children
    .map((c) => foldInline(c as PhrasingContent, source))
    .flatMap((n) => (n.type === "plain" ? expandPlainNode(n, source) : [n]));
}

function foldInlineChildren(node: MdastParent, source: string): Inline[] {
  return buildInlines(node.children, source);
}

function foldTableRow(
  row: Extract<RootContent, { type: "tableRow" }>,
  source: string,
): TableRow {
  const cells: TableCell[] = row.children.map((cell) => ({
    children: buildInlines(cell.children, source),
    ...pos(cell),
  }));
  return { cells, ...pos(row) };
}

function foldBlock(
  node: RootContent,
  source: string,
  expandableLineStarts: Set<number>,
): Block {
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
    case "blockquote": {
      const p = pos(node);
      // A blockquote is expandable when its FIRST line carried the `**>`
      // marker in the original source (recorded by markExpandableQuotes).
      const expandable = expandableLineStarts.has(lineStart(source, p.start));
      return {
        type: "blockquote",
        children: node.children.map((c) => foldBlock(c, source, expandableLineStarts)),
        expandable,
        ...p,
      };
    }
    case "code":
      return {
        type: "code-block",
        text: node.value,
        language: node.lang ?? null,
        ...pos(node),
      };
    case "list": {
      const items: ListItem[] = node.children.map((li) => ({
        children: li.children.map((c) => foldBlock(c, source, expandableLineStarts)),
        checked: li.checked ?? null,
        // mdast `listItem.spread`: whether this item's block children are
        // separated by a blank line. Tight (false) keeps a paragraph and its
        // nested sub-list adjacent so no blank line is injected on render.
        spread: li.spread ?? false,
        ...pos(li),
      }));
      return {
        type: "list",
        ordered: node.ordered ?? false,
        startNumber: node.ordered ? node.start ?? 1 : null,
        // mdast `list.spread`: loose (true) vs tight (false) at the list level.
        spread: node.spread ?? false,
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
  // Rewrite expandable-blockquote markers (`**>` → `  >`) so micromark parses
  // them as ordinary blockquotes. The rewrite is length-preserving, so mdast's
  // offsets are valid against BOTH the rewritten and the original text — we
  // parse the rewritten text but fold against the ORIGINAL `markdown`, keeping
  // every source slice byte-identical to the caller's input.
  const { text: rewritten, expandableLineStarts } = markExpandableQuotes(markdown);
  const tree = fromMarkdown(rewritten, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return {
    blocks: tree.children.map((child) =>
      foldBlock(child, markdown, expandableLineStarts),
    ),
  };
}
