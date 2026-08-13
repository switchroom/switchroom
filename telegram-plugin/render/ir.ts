// Typed intermediate representation (IR) for the Telegram rich-markdown render
// engine. (Historical note: this file and render.ts were named for an "HTML
// render engine" during Increment 1, before the Bot API 10.1 migration (#2669)
// made GFM `{ markdown }` the live send path. There is NO HTML anywhere on the
// outbound path today — the renderer in render.ts emits raw GFM markdown for
// the `markdown` field of `InputRichMessageMarkdown`.)
//
// This is the parser <-> renderer contract. `parse()` (parse.ts) folds an
// mdast tree into this shape; `render.ts` walks it and emits Telegram
// rich-message GFM markdown.
//
// Every node carries `{ start, end }` UTF-16 source offsets copied verbatim
// from mdast `position.start.offset` / `position.end.offset`. They are UTF-16
// code-unit indices into the original markdown string, so
// `source.slice(node.start, node.end)` round-trips to the node's source text.
//
// IR node -> emitted GFM markdown (see render.ts `renderInline`/block render):
//
//   Inline
//     plain     -> raw text (escapeMarkdown'd)
//     bold      -> `**…**`
//     italic    -> `*…*`
//     underline -> `__…__`  — NOTE: the wire renders `__…__` as BOLD, not
//                  underline. Telegram's rich-message markdown has no underline
//                  token (live-verified, see reference/telegram-formatting-guide.md).
//                  The node preserves the author's `__` bytes faithfully; it is
//                  a distinct IR node but NOT a distinct wire style.
//     strike    -> `~~…~~`
//     spoiler   -> `||…||`
//     highlight -> `==…==`  (Bot API 10.1 marked entity)
//     code      -> `` `…` ``
//     link      -> `[…](…)`
//     tg-entity -> `![…](tg://…)`  (Bot API date_time / custom-emoji entity)
//
//   Block
//     paragraph      -> children joined; blocks separated by "\n\n"
//     heading        -> `#`…`######` line
//     blockquote     -> `> …` (expandable === true -> `**> …` expandable blockquote)
//     code-block     -> ```` ```lang … ``` ````
//     list           -> line-per-item with `-`/`1.` markers
//     thematic-break -> `---` thematic break
//     table          -> GFM pipe table

export interface Pos {
  /** UTF-16 code-unit offset of the node's first char (mdast position.start.offset). */
  start: number;
  /** UTF-16 code-unit offset just past the node's last char (mdast position.end.offset). */
  end: number;
}

// ---------------------------------------------------------------------------
// Inline nodes
// ---------------------------------------------------------------------------

export interface PlainNode extends Pos {
  type: "plain";
  text: string;
}

export interface BoldNode extends Pos {
  type: "bold";
  children: Inline[];
}

export interface ItalicNode extends Pos {
  type: "italic";
  children: Inline[];
}

/** A `__…__` double-underscore run. `parse.ts` keeps it as a distinct node
 *  (separate from `**…**` bold) by looking at the source delimiter, even though
 *  GFM/micromark folds both into a single `strong` mdast node. NOTE: on the
 *  Telegram wire this renders as BOLD, not a distinct underline style — Bot API
 *  10.1 rich markdown has no underline entity here, so the round-trip is faithful
 *  but the delivered text is bold. Kept distinct only to preserve authoring intent. */
export interface UnderlineNode extends Pos {
  type: "underline";
  children: Inline[];
}

export interface StrikeNode extends Pos {
  type: "strike";
  children: Inline[];
}

/** Telegram spoiler (<tg-spoiler>…</tg-spoiler>), markdown `||…||`. GFM has no
 *  spoiler syntax, so `parse.ts` recognises the `||…||` delimiter in a
 *  post-parse pass over `plain` text. */
export interface SpoilerNode extends Pos {
  type: "spoiler";
  children: Inline[];
}

/** Telegram highlight / marked text (<mark>…</mark>), markdown `==…==` (Bot API
 *  10.1). Like spoiler, recognised by `parse.ts` in a post-parse pass over
 *  `plain` text (GFM has no highlight syntax). */
export interface HighlightNode extends Pos {
  type: "highlight";
  children: Inline[];
}

export interface CodeNode extends Pos {
  type: "code";
  text: string;
}

export interface LinkNode extends Pos {
  type: "link";
  href: string;
  children: Inline[];
}

/** A Telegram rich-markdown INLINE entity written in mdast IMAGE position.
 *  The "Rich Markdown style" grammar (https://core.telegram.org/bots/api,
 *  quoted in `reference/telegram-formatting-guide.md`) lists exactly two:
 *
 *    ![](tg://emoji?id=5368324170671202286)                  custom emoji
 *    ![22:45 tomorrow](tg://time?unix=1647531900&format=wDT) date_time
 *
 *  (the `date_time` MessageEntity is Bot API 9.5, March 1 2026; the rich-message
 *  `RichTextDateTime` class is 10.1, June 11 2026 — both in the Bot API
 *  changelog.) `parse.ts` folds ONLY those two `tg:` hrefs into this node;
 *  every other image url keeps the historical demote-to-`plain` fallback,
 *  because an http(s) `![](…)` is a Telegram MEDIA block — "Media can be
 *  specified only as a separate block" (same doc) — not an inline entity, and
 *  switchroom does not emit media blocks.
 *
 *  `label` is the DECODED alternative text (mdast `image.alt`, empty for the
 *  emoji form); `href` is the `tg:` URL. Both are re-escaped on render, same
 *  as `LinkNode`. */
export interface TgEntityNode extends Pos {
  type: "tg-entity";
  label: string;
  href: string;
}

export type Inline =
  | PlainNode
  | BoldNode
  | ItalicNode
  | UnderlineNode
  | StrikeNode
  | SpoilerNode
  | HighlightNode
  | CodeNode
  | LinkNode
  | TgEntityNode;

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

export interface ParagraphNode extends Pos {
  type: "paragraph";
  children: Inline[];
}

export interface HeadingNode extends Pos {
  type: "heading";
  /** 1..6 */
  level: number;
  children: Inline[];
}

export interface BlockquoteNode extends Pos {
  type: "blockquote";
  children: Block[];
  /** Telegram <blockquote expandable>. Always false in Increment 1 — see parse.ts. */
  expandable: boolean;
}

export interface CodeBlockNode extends Pos {
  type: "code-block";
  text: string;
  language: string | null;
}

export interface ListNode extends Pos {
  type: "list";
  ordered: boolean;
  // NOTE: the spec names this ordinal `start`, but every node already carries
  // `start`/`end` UTF-16 offsets (load-bearing for round-trip slicing). To
  // avoid the collision the ordered-list ordinal is `startNumber` here; its
  // semantics match the spec's `list.start` exactly (mdast `list.start`).
  /** First number of an ordered list (mdast `start`); null for unordered. */
  startNumber: number | null;
  /** Loose vs tight (mdast `list.spread`). A LOOSE list separates its items
   *  with a blank line in the source; a TIGHT list keeps them on adjacent
   *  lines. The renderer preserves this: loose lists join items with a blank
   *  line, tight lists (including nested sub-lists) stay on single newlines so
   *  no spurious blank line is injected between a tight item and its sub-list. */
  spread: boolean;
  items: ListItem[];
}

export interface ThematicBreakNode extends Pos {
  type: "thematic-break";
}

export interface TableNode extends Pos {
  type: "table";
  header: TableRow;
  rows: TableRow[];
  /** Per-column alignment, parallel to the cells. */
  align: ("left" | "center" | "right" | null)[];
}

export type Block =
  | ParagraphNode
  | HeadingNode
  | BlockquoteNode
  | CodeBlockNode
  | ListNode
  | ThematicBreakNode
  | TableNode;

// ---------------------------------------------------------------------------
// Composite / container shapes
// ---------------------------------------------------------------------------

export interface ListItem extends Pos {
  children: Block[];
  /** GFM task-list state: true (checked), false (unchecked), null (not a task item). */
  checked: boolean | null;
  /** Loose vs tight at the ITEM level (mdast `listItem.spread`): whether this
   *  item's own block children are separated by a blank line in the source.
   *  A tight item (spread=false) — e.g. a paragraph followed by a nested
   *  sub-list — keeps its children on single newlines, so no blank line is
   *  injected before the sub-list. */
  spread: boolean;
}

export interface TableRow extends Pos {
  cells: TableCell[];
}

export interface TableCell extends Pos {
  children: Inline[];
}

export interface Document {
  blocks: Block[];
}
