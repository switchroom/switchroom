// Typed intermediate representation (IR) for the Telegram HTML render engine.
//
// This is the parser <-> renderer contract. `parse()` (parse.ts) folds an
// mdast tree into this shape; a later increment's renderer walks it and emits
// Telegram Bot API HTML. Increment 1 lands ONLY the parser + this IR — there
// is no renderer yet.
//
// Every node carries `{ start, end }` UTF-16 source offsets copied verbatim
// from mdast `position.start.offset` / `position.end.offset`. They are UTF-16
// code-unit indices into the original markdown string, so
// `source.slice(node.start, node.end)` round-trips to the node's source text.
//
// Telegram HTML tag mapping (for the next increment — NOT implemented here):
//
//   Inline
//     plain     -> (raw text, HTML-escaped)
//     bold      -> <b>…</b>                 (markdown `**…**`)
//     italic    -> <i>…</i>                 (markdown `*…*`)
//     underline -> <u>…</u>                 (markdown `__…__`, Bot API 10.1)
//     strike    -> <s>…</s>                 (markdown `~~…~~`)
//     spoiler   -> <tg-spoiler>…</tg-spoiler> (markdown `||…||`)
//     highlight -> <mark>…</mark>           (markdown `==…==`, Bot API 10.1)
//     code      -> <code>…</code>
//     link      -> <a href="…">…</a>
//
//   Block
//     paragraph      -> children joined; blocks separated by "\n\n"
//     heading        -> <b>…</b> (Telegram HTML has no <h1>…<h6>; bold + newlines)
//     blockquote     -> <blockquote>…</blockquote>
//                       (expandable === true -> <blockquote expandable>)
//     code-block     -> <pre><code class="language-…">…</code></pre>
//     list           -> rendered line-per-item with "•"/"1." bullets
//                       (Telegram HTML has no <ul>/<ol>)
//     thematic-break -> a horizontal-rule text line (e.g. "───")
//     table          -> monospaced <pre> table (Telegram HTML has no <table>)

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

/** Telegram underline (<u>…</u>). In Bot API 10.1 rich markdown the `__…__`
 *  double-underscore run is UNDERLINE — distinct from `**…**` bold, even though
 *  GFM/micromark folds both into a single `strong` mdast node. `parse.ts`
 *  disambiguates the two by looking at the run's source delimiter. */
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

export type Inline =
  | PlainNode
  | BoldNode
  | ItalicNode
  | UnderlineNode
  | StrikeNode
  | SpoilerNode
  | HighlightNode
  | CodeNode
  | LinkNode;

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
