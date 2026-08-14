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
//     raw source slice, rather than being dropped. The ONE deliberate
//     exception is raw-HTML MARKUP: an unrecognised tag has its angle-bracket
//     token dropped while its content is kept and rendered (see the raw-HTML
//     note below and `html-fold.ts`). Content is never lost; unguaranteeable
//     markup is.
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
//   The IR carries `expandable: boolean` for the LEGACY switchroom `**> `
//   expandable-quote encoding. `**>` was believed to be the Bot API 10.1
//   expandable-blockquote marker; wire probes (2026-08-13) proved it is
//   MarkdownV2-only syntax that the rich markdown path renders as LITERAL
//   `**>` text, so `render.ts` no longer emits it — an expandable node renders
//   as a plain `> ` quote. Recognition here is kept as INPUT REPAIR: agent
//   output (and Hindsight memories) trained on the old floor card still
//   contains `**> ` quotes, and without this rewrite such a line would reach
//   the wire as a broken literal-`**>` paragraph. micromark does NOT
//   understand `**> ` as a blockquote — the leading `**` makes the line a
//   paragraph with an unclosed strong-emphasis run — so this module
//   pre-transforms each
//   `**>` marker into a plain `  >` marker of IDENTICAL length (`**` → two
//   spaces) before handing the text to mdast. Length preservation keeps every
//   UTF-16 source offset (and therefore the never-lose-text round-trip
//   invariant against the ORIGINAL source) exactly intact — only the two
//   marker characters differ, and they are never part of quoted content. The
//   set of line-start offsets that carried the marker is threaded into
//   `foldBlock` so the matching blockquote nodes get `expandable: true`.
//
//   The rewrite is FENCE-AWARE. Every other fold reads the ORIGINAL `markdown`
//   through `slice()`, so the rewritten bytes never escape — except for the
//   `code` fold, which must use mdast's `node.value` (the dedented, fence-
//   stripped content, which offsets alone cannot reconstruct without
//   re-implementing micromark's fence parser). That made a fenced block
//   containing a line starting `**>` ship silently corrupted as `  >` —
//   anyone documenting the legacy syntax got their code altered. Skipping
//   fenced regions in the pre-pass fixes it at the one place the rewrite is
//   decided, keeps `code.value` trustworthy for every consumer, and preserves
//   the length invariant trivially (a skipped line is copied verbatim).
//
// Raw HTML handling:
//   mdast `html` nodes (inline `<b>`/`<a href>` runs and whole HTML blocks)
//   used to fall through to `plain`, which the renderer `escapeMarkdown`s —
//   escaping `=` and shipping `<a href\="…">`. They now go through
//   `html-fold.ts`'s three-bucket policy: fold to the native IR construct,
//   pass through raw (wire-verified allowlist), or drop the markup and keep
//   the content. See that module's header for the rationale.

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
import {
  HTML_FOLD_TAGS,
  escapeHtmlLiteral,
  hrefOf,
  isBlockLevelTag,
  isPassthroughTag,
  isVoidTag,
  languageOf,
  matchedTagOffsets,
  tokenizeHtml,
  type HtmlFoldTarget,
  type HtmlTagInfo,
} from "./html-fold.js";

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

/** The LEGACY switchroom expandable-blockquote marker: `**>` at the very
 *  start of a line (column 0). The render path no longer emits it (it is
 *  MarkdownV2-only syntax, not rich markdown — see `render.ts`
 *  renderBlockquote), but it is still RECOGNISED on input so a legacy `**> `
 *  line is repaired into a real blockquote instead of shipping as literal
 *  `**>` text. Matching only at column 0 keeps
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

/** A top-level fenced-code delimiter: 3+ backticks or tildes, indented 0–3
 *  spaces. Deeper indentation is not a fence, and a fence nested inside a
 *  blockquote / list item is prefixed by its container's markup, so this only
 *  ever tracks TOP-LEVEL fences.
 *
 *  KNOWN LIMITATION (pre-existing, not a safety property): tracking only
 *  top-level fences does NOT establish that every column-0 `**>` line outside
 *  one is a real blockquote candidate. Counterexample:
 *
 *      > ```
 *      **> lazy
 *      > ```
 *
 *  The `> ``` ` opener is inside a blockquote so it never matches here; the
 *  column-0 `**> lazy` line is rewritten to `  > lazy` and the `**` is eaten.
 *  CommonMark forbids lazy continuation into fenced code, so that line should
 *  CLOSE the blockquote and stay literal. Fixing it needs real container
 *  tracking (blockquote/list prefixes), not a wider fence regex. The case is
 *  pinned by a test in `tests/render/html-dialect.test.ts` so any future
 *  container-aware rewrite has to decide it deliberately. */
const FENCE_DELIM_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Pre-transform expandable-blockquote markers so mdast can parse them as
 *  ordinary blockquotes, WITHOUT shifting any source offset. Each line that
 *  opens with `**>` — and is NOT inside a fenced code block — has its two `*`
 *  characters replaced by two spaces (`**>` → `  >`), which micromark reads as
 *  a normal (optionally 1–3-space-indented) blockquote line. Returns the
 *  rewritten text plus the set of line-start offsets that carried the marker —
 *  `foldBlock` uses that set to flip `expandable: true` on the produced
 *  blockquote nodes.
 *
 *  Fence tracking mirrors CommonMark: an opener is 3+ backticks/tildes at
 *  0–3 spaces of indent; the block closes on a delimiter of the SAME character
 *  that is at least as long and carries nothing but whitespace after it, or at
 *  end of document. Inside such a block every line is copied verbatim, so a
 *  documented `**> …` example survives byte-identical into `code.value`. */
function markExpandableQuotes(markdown: string): {
  text: string;
  expandableLineStarts: Set<number>;
} {
  const expandableLineStarts = new Set<number>();
  let out = "";
  let offset = 0;
  /** The open fence's delimiter run, or null outside a fenced block. */
  let openFence: string | null = null;
  // Split keeping the trailing newline on each line so offsets are exact.
  for (const line of markdown.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    const fence = FENCE_DELIM_RE.exec(body)?.[1] ?? null;
    if (openFence !== null) {
      // Inside a fence: copy verbatim, and close on a matching delimiter.
      out += line;
      if (
        fence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        body.slice(body.indexOf(fence) + fence.length).trim() === ""
      ) {
        openFence = null;
      }
      offset += line.length;
      continue;
    }
    if (fence !== null) {
      // A backtick info string may not contain a backtick; such a line is not
      // a fence opener at all (CommonMark), so only treat it as one when the
      // rest of the line is clean.
      const rest = body.slice(body.indexOf(fence) + fence.length);
      if (!(fence[0] === "`" && rest.includes("`"))) {
        openFence = fence;
        out += line;
        offset += line.length;
        continue;
      }
    }
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

function foldInline(node: PhrasingContent, source: string, ctx: FoldCtx): Inline {
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
        children: foldInlineChildren(node, source, ctx),
        ...p,
      };
    }
    case "emphasis":
      return { type: "italic", children: foldInlineChildren(node, source, ctx), ...pos(node) };
    case "delete":
      return { type: "strike", children: foldInlineChildren(node, source, ctx), ...pos(node) };
    case "inlineCode":
      return { type: "code", text: node.value, ...pos(node) };
    case "link":
      return {
        type: "link",
        href: node.url,
        children: foldInlineChildren(node, source, ctx),
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
    // GFM footnote reference marker (`[^1]`): natively supported by Telegram's
    // rich markdown path (wire-verified 2026-08-13 — renders as the full
    // superscript + anchor + reference_link machinery). The source bytes ARE
    // the wire syntax, so fold to a `raw` node the renderer emits verbatim;
    // a `plain` node would be escapeMarkdown'd (`\[^1\]`) and break the
    // construct on the wire.
    case "footnoteReference":
      return { type: "raw", text: slice(source, node), ...pos(node) };
    // Not in the palette (break, non-`tg:` image, html, …): keep the raw
    // source text so no content is lost.
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

// ---------------------------------------------------------------------------
// Raw-HTML tag folding (see html-fold.ts for the policy and its rationale)
// ---------------------------------------------------------------------------

/** One element of the stream the HTML matcher walks: either a classified HTML
 *  token or an already-folded IR inline. */
type HtmlFoldItem =
  | { kind: "tag"; tag: HtmlTagInfo; start: number; end: number }
  | { kind: "inline"; node: Inline };

/** Index of the token that closes `name`, honouring same-name nesting, or -1. */
function findClosingTag(items: HtmlFoldItem[], from: number, name: string): number {
  let depth = 0;
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "tag" || it.tag.name !== name) continue;
    if (it.tag.kind === "open") depth++;
    else if (it.tag.kind === "close") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Flatten a folded run to literal text, or null when any child carries
 *  structure a code span cannot represent. Used for `<code>`. Deliberately
 *  accepts ONLY `plain`: an inner `code` node's own backticks are not in its
 *  `text`, so folding it in would silently DELETE them
 *  (`<code>a `b` c</code>` -> `` `a b c` ``), and a `raw` node's wire bytes
 *  would be swallowed into a literal span. Both degrade to the children
 *  instead, which preserves every byte. */
function inlineLiteralText(nodes: Inline[]): string | null {
  let out = "";
  for (const n of nodes) {
    if (n.type !== "plain") return null;
    out += n.text;
  }
  return out;
}

/** Where a folded run is being emitted. `noBreaks` marks a container whose
 *  content must stay on ONE line — a heading or a table cell — so a `<br>` or
 *  a structural separator has to degrade to a space instead of a line break,
 *  and a `<pre>` to an inline code span instead of a fence. Without this a
 *  `# a<br>b` heading emitted `# a  \nb`, which ends the heading block and
 *  drops `b` out of it. */
interface FoldCtx {
  noBreaks?: boolean;
  /** Source offsets of every HTML token the DOCUMENT-level pass found a
   *  partner for (`matchedTagOffsets`). A token missing from this set is
   *  unmatched — prose, not markup. Empty means "no HTML in this document",
   *  in which case nothing consults it. */
  matched: ReadonlySet<number>;
}

/** Separator nodes this module synthesized while degrading structural markup.
 *  Tracked by identity so `normalizeSeparators` can collapse and trim OUR
 *  separators without touching a hard break the author actually wrote with
 *  `<br>` (`a<br><br>b` must keep both). */
const structuralSeparators = new WeakSet<Inline>();

/** The whitespace a degraded block-level tag leaves behind. A GFM HARD break
 *  (two spaces + newline), not a bare `\n`: the renderer runs AFTER
 *  `normalizeParagraphBreaks`, so a lone `\n` would never be promoted and
 *  Telegram collapses it to a space. */
function mkSeparator(ctx: FoldCtx, start: number, end: number): Inline {
  const node: Inline = {
    type: "raw",
    text: ctx.noBreaks === true ? " " : "  \n",
    start,
    end,
  };
  structuralSeparators.add(node);
  return node;
}

/** Drop leading/trailing synthesized separators and collapse runs of them, so
 *  a degrade never contributes stray whitespace at the edges of a block
 *  (`<div></div>` must still render to nothing, and a `<pre>` fence must not
 *  leave a dangling newline). */
function normalizeSeparators(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (!structuralSeparators.has(node)) {
      out.push(node);
      continue;
    }
    if (out.length === 0) continue;
    if (structuralSeparators.has(out[out.length - 1])) continue;
    out.push(node);
  }
  while (out.length > 0 && structuralSeparators.has(out[out.length - 1])) out.pop();
  return out;
}

/** An unmatched marker or unclassifiable token kept as LITERAL text, with its
 *  angle brackets HTML-entity-escaped so the wire sees prose, not a tag. */
function literalTag(tag: HtmlTagInfo, start: number, end: number): Inline {
  return { type: "plain", text: escapeHtmlLiteral(tag.raw), start, end };
}

/**
 * Apply the HTML dialect policy over a mixed tag/inline stream.
 *
 * `active` carries the constructs already open in an ANCESTOR fold. Markdown
 * cannot nest same-kind emphasis — `**a **b** c**` is asterisk soup on the
 * reader's screen, not nested bold — so an emphasis tag whose target is
 * already active degrades to its children. Combined with the single-child
 * unwrap in `buildFoldedTag`, `<b>a <b>b</b> c</b>` and `<b>**already**</b>`
 * both come out as ONE bold run. A nested `<a>` is NOT unwrapped that way: its
 * href is content, so it degrades to escaped literal markup instead of being
 * silently deleted.
 *
 * See `html-fold.ts` for the bucket policy and the matched-vs-unmatched
 * discriminator this implements.
 */
function foldHtmlItems(
  items: HtmlFoldItem[],
  active: ReadonlySet<HtmlFoldTarget>,
  ctx: FoldCtx,
): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "inline") {
      out.push(it.node);
      i++;
      continue;
    }
    const tag = it.tag;

    // A comment renders nothing anywhere: dropping it loses no content.
    if (tag.kind === "comment") {
      i++;
      continue;
    }

    // `<br>` / `<br/>` — a real line break (a space where breaks are illegal).
    if (HTML_FOLD_TAGS[tag.name] === "break" && tag.kind !== "close") {
      out.push(
        ctx.noBreaks === true
          ? { type: "raw", text: " ", start: it.start, end: it.end }
          : { type: "raw", text: "  \n", start: it.start, end: it.end },
      );
      i++;
      continue;
    }

    // Void / self-closing tags delimit no content, so dropping their markup
    // cannot lose text. Block-level ones still leave a separator.
    if (tag.kind === "selfclose" || (tag.kind === "open" && isVoidTag(tag.name))) {
      if (isPassthroughTag(tag)) {
        out.push({ type: "raw", text: tag.raw, start: it.start, end: it.end });
      } else if (isBlockLevelTag(tag.name)) {
        out.push(mkSeparator(ctx, it.start, it.end));
      }
      i++;
      continue;
    }

    // Bucket 2: the wire-verified allowlist, now BALANCE-CHECKED. Emitting an
    // unmatched `<u>` raw is precisely the `unclosed start tag` 400 the fold
    // policy exists to prevent — and the fallback resends the whole message as
    // PLAIN TEXT, so one stray marker in relayed content degrades the entire
    // reply. The check is document-level because a `<details>` open and close
    // legitimately land in different mdast blocks.
    if (isPassthroughTag(tag) && (tag.kind === "open" || tag.kind === "close")) {
      out.push(
        ctx.matched.has(it.start)
          ? { type: "raw", text: tag.raw, start: it.start, end: it.end }
          : literalTag(tag, it.start, it.end),
      );
      i++;
      continue;
    }

    // Everything else must be BALANCED to count as markup.
    if (tag.kind === "open") {
      const close = findClosingTag(items, i + 1, tag.name);
      const closeItem = close >= 0 ? items[close] : undefined;
      if (closeItem !== undefined && closeItem.kind === "tag") {
        out.push(
          ...foldMatchedTag(tag, closeItem, items.slice(i + 1, close), active, ctx, {
            start: it.start,
            end: closeItem.end,
          }),
        );
        i = close + 1;
        continue;
      }
    }

    // Matched somewhere ELSE in the document (a `<div>` whose `</div>` is a
    // separate mdast block) — markup, so drop it, but leave a separator for a
    // block-level name so the neighbouring blocks do not glue.
    if (ctx.matched.has(it.start) && tag.kind !== "other") {
      if (isBlockLevelTag(tag.name)) out.push(mkSeparator(ctx, it.start, it.end));
      i++;
      continue;
    }

    // Unmatched open, stray close, or an unclassifiable token: PROSE.
    out.push(literalTag(tag, it.start, it.end));
    i++;
  }
  return normalizeSeparators(out);
}

/** Emit a tag whose closing partner was found. */
function foldMatchedTag(
  tag: HtmlTagInfo,
  closeTag: HtmlFoldItem & { kind: "tag" },
  innerItems: HtmlFoldItem[],
  active: ReadonlySet<HtmlFoldTarget>,
  ctx: FoldCtx,
  span: Pos,
): Inline[] {
  const target = HTML_FOLD_TAGS[tag.name];

  // `<pre>` — the one BLOCK-level fold (see html-fold.ts).
  if (target === "pre") {
    const folded = buildPreBlock(innerItems, ctx, span);
    if (folded !== null) return folded;
  }

  if (target !== undefined && target !== "break" && target !== "pre") {
    const nested = new Set(active);
    nested.add(target);
    const inner = foldHtmlItems(innerItems, nested, ctx);
    // A LINK cannot nest in markdown, and its href is content — degrading to
    // the children would silently delete the inner URL. Keep the markup as
    // escaped literal text instead.
    if (active.has(target)) {
      return target === "link"
        ? [
            literalTag(tag, span.start, span.start + tag.raw.length),
            ...inner,
            literalTag(closeTag.tag, closeTag.start, closeTag.end),
          ]
        : inner;
    }
    const folded = buildFoldedTag(target, tag, inner, span.start, span.end);
    // A tag we cannot represent faithfully (an `<a>` with no href, a `<code>`
    // wrapping structure) degrades to its CONTENT — nothing is lost.
    return folded !== null ? [folded] : inner;
  }

  // Unknown but BALANCED: markup dropped, content kept. A block-level name
  // leaves a separator so its neighbours cannot glue together.
  const inner = foldHtmlItems(innerItems, active, ctx);
  if (!isBlockLevelTag(tag.name)) return inner;
  return [
    mkSeparator(ctx, span.start, span.start + tag.raw.length),
    ...inner,
    mkSeparator(ctx, closeTag.start, closeTag.end),
  ];
}

/** Build the fenced-code equivalent of a matched `<pre>…</pre>`, or null when
 *  the content is not literal text a fence can carry (in which case the caller
 *  falls back to the ordinary degrade). An optional single `<code …>` wrapper
 *  is unwrapped, and its `class="language-…"` becomes the fence info string —
 *  exactly the shape Telegram's own Rich HTML reference documents. */
function buildPreBlock(
  innerItems: HtmlFoldItem[],
  ctx: FoldCtx,
  span: Pos,
): Inline[] | null {
  let body = innerItems;
  let language: string | null = null;
  const first = body[0];
  const last = body[body.length - 1];
  if (
    body.length >= 2 &&
    first?.kind === "tag" &&
    first.tag.kind === "open" &&
    first.tag.name === "code" &&
    last?.kind === "tag" &&
    last.tag.kind === "close" &&
    last.tag.name === "code"
  ) {
    language = languageOf(first.tag);
    body = body.slice(1, -1);
  }
  let text = "";
  for (const item of body) {
    if (item.kind !== "inline" || item.node.type !== "plain") return null;
    text += item.node.text;
  }
  // `<pre>` content routinely starts on the line after the tag and ends on the
  // line before the close; those layout newlines are not content.
  text = text.replace(/^\r?\n/, "").replace(/[ \t]*\r?\n[ \t]*$/, "");
  // A fence cannot survive inside a heading or a table cell — degrade to an
  // inline code span there, with the newlines flattened.
  if (ctx.noBreaks === true) {
    return [{ type: "code", text: text.replace(/\s*\r?\n\s*/g, " "), ...span }];
  }
  const fence = "```";
  return [
    mkSeparator(ctx, span.start, span.start),
    {
      type: "raw",
      text: `${fence}${language ?? ""}\n${text}\n${fence}`,
      ...span,
    },
    mkSeparator(ctx, span.end, span.end),
  ];
}

function buildFoldedTag(
  target: HtmlFoldTarget,
  tag: HtmlTagInfo,
  children: Inline[],
  start: number,
  end: number,
): Inline | null {
  switch (target) {
    case "bold":
    case "italic":
    case "strike":
      // Already exactly that construct (`<b>**already**</b>`) — re-wrapping
      // would emit `****already****`, which reads as literal asterisks.
      if (children.length === 1 && children[0].type === target) return children[0];
      return { type: target, children, start, end };
    case "code": {
      const text = inlineLiteralText(children);
      return text === null ? null : { type: "code", text, start, end };
    }
    case "link": {
      const href = hrefOf(tag);
      return href === null ? null : { type: "link", href, children, start, end };
    }
    default:
      return null;
  }
}

/** Turn a raw HTML string into fold items: tokens stay tokens, the text
 *  between them becomes `plain` inlines (with spoiler/highlight recognition,
 *  matching how prose is treated everywhere else). */
function htmlStringToItems(raw: string, base: number, source: string): HtmlFoldItem[] {
  return tokenizeHtml(raw, base).flatMap<HtmlFoldItem>((piece) =>
    piece.kind === "tag"
      ? [{ kind: "tag", tag: piece.tag, start: piece.start, end: piece.end }]
      : expandPlainNode(mkPlain(piece.text, piece.start, piece.end), source).map(
          (node) => ({ kind: "inline", node }) as HtmlFoldItem,
        ),
  );
}

/** Fold a run of mdast phrasing children into IR inlines, then run the
 *  post-parse spoiler/highlight recognition over the produced `plain` nodes,
 *  then apply the raw-HTML tag policy across the whole run (open/close markers
 *  are SIBLING mdast `html` nodes, never a parent, so matching has to happen
 *  at this level). */
function buildInlines(
  children: ReadonlyArray<MdastNode>,
  source: string,
  ctx: FoldCtx,
): Inline[] {
  const items: HtmlFoldItem[] = [];
  let sawHtml = false;
  for (const child of children) {
    if ((child as PhrasingContent).type === "html") {
      sawHtml = true;
      const p = pos(child);
      items.push(...htmlStringToItems(slice(source, child), p.start, source));
      continue;
    }
    const folded = foldInline(child as PhrasingContent, source, ctx);
    const expanded = folded.type === "plain" ? expandPlainNode(folded, source) : [folded];
    for (const node of expanded) items.push({ kind: "inline", node });
  }
  if (!sawHtml) return items.map((it) => (it as { node: Inline }).node);
  return foldHtmlItems(items, new Set(), ctx);
}

function foldInlineChildren(
  node: MdastParent,
  source: string,
  ctx: FoldCtx,
): Inline[] {
  return buildInlines(node.children, source, ctx);
}

function foldTableRow(
  row: Extract<RootContent, { type: "tableRow" }>,
  source: string,
  ctx: FoldCtx,
): TableRow {
  const cells: TableCell[] = row.children.map((cell) => ({
    // A table cell is one line on the wire — a `<br>` or a structural degrade
    // inside it must not emit a newline (it would end the row).
    children: buildInlines(cell.children, source, { ...ctx, noBreaks: true }),
    ...pos(cell),
  }));
  return { cells, ...pos(row) };
}

/** True for a block that would render to the empty string. Only the raw-HTML
 *  fold can produce one — a block that is nothing but markup we dropped
 *  (`<!-- comment -->`, `<hr/>`, `<div></div>` on their own line). Left in,
 *  each would contribute a spurious `\n\n` separator to the rendered document,
 *  so they are filtered out at the point blocks are collected. */
function isEmptyBlock(block: Block): boolean {
  return block.type === "paragraph" && block.children.length === 0;
}

/** Fold a run of mdast block nodes, dropping any that render to nothing. */
function foldBlocks(
  nodes: ReadonlyArray<RootContent>,
  source: string,
  expandableLineStarts: Set<number>,
  ctx: FoldCtx,
): Block[] {
  return nodes
    .map((n) => foldBlock(n, source, expandableLineStarts, ctx))
    .filter((b) => !isEmptyBlock(b));
}

function foldBlock(
  node: RootContent,
  source: string,
  expandableLineStarts: Set<number>,
  ctx: FoldCtx,
): Block {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: foldInlineChildren(node, source, ctx), ...pos(node) };
    case "heading":
      return {
        type: "heading",
        level: node.depth,
        // A heading is a single `#…` LINE: an embedded newline would end the
        // block and orphan the rest of the text (`# a<br>b`).
        children: foldInlineChildren(node, source, { ...ctx, noBreaks: true }),
        ...pos(node),
      };
    case "blockquote": {
      const p = pos(node);
      // A blockquote is expandable when its FIRST line carried the `**>`
      // marker in the original source (recorded by markExpandableQuotes).
      const expandable = expandableLineStarts.has(lineStart(source, p.start));
      return {
        type: "blockquote",
        children: foldBlocks(node.children, source, expandableLineStarts, ctx),
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
        children: foldBlocks(li.children, source, expandableLineStarts, ctx),
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
        header: foldTableRow(headerRow, source, ctx),
        rows: bodyRows.map((r) => foldTableRow(r, source, ctx)),
        align: (node.align ?? []).map(foldAlign),
        ...pos(node),
      };
    }
    // GFM footnote DEFINITION (`[^1]: body`): natively supported on the wire
    // (2026-08-13 probe — pairs with the reference marker into footer/anchor
    // nodes). Emit the raw source slice VERBATIM via a `raw` inline: a `plain`
    // fold would escapeMarkdown the `[`/`]` (`\[^1\]: body`) and orphan the
    // reference.
    case "footnoteDefinition":
      return {
        type: "paragraph",
        children: [{ type: "raw", text: slice(source, node), ...pos(node) }],
        ...pos(node),
      };
    // A raw HTML BLOCK (`<details>…`, `<div>…`, a bare `<b>alone</b>` line).
    // mdast hands the whole block over as one opaque string, so tokenize it
    // and run the same three-bucket policy the inline path uses: the
    // wire-verified allowlist passes through raw (which is also what stops
    // `escapeMarkdown` mangling `<details open="x">` into `open\="x"`),
    // markdown-equivalent tags fold, everything else drops its markup and
    // keeps its content.
    case "html": {
      const p = pos(node);
      return {
        type: "paragraph",
        children: foldHtmlItems(
          htmlStringToItems(slice(source, node), p.start, source),
          new Set(),
          ctx,
        ),
        ...p,
      };
    }
    // Not in the palette (definition, …): degrade to a paragraph
    // carrying the raw source slice so no content is dropped.
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
    blocks: foldBlocks(tree.children, markdown, expandableLineStarts, {
      matched: matchedTagOffsets(collectHtmlTokens(tree.children, markdown)),
    }),
  };
}

/** Every HTML token in the tree, in document order, for the balance pass.
 *  Walks mdast `html` nodes only — a tag inside a code fence or a code span is
 *  not markup and must not balance anything. */
function collectHtmlTokens(
  nodes: ReadonlyArray<MdastNode>,
  source: string,
): { tag: HtmlTagInfo; start: number }[] {
  const out: { tag: HtmlTagInfo; start: number }[] = [];
  const walk = (list: ReadonlyArray<MdastNode>): void => {
    for (const node of list) {
      if (node.type === "html") {
        const p = pos(node);
        for (const piece of tokenizeHtml(slice(source, node), p.start)) {
          if (piece.kind === "tag") out.push({ tag: piece.tag, start: piece.start });
        }
        continue;
      }
      const children = (node as MdastParent).children;
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(nodes);
  return out;
}
