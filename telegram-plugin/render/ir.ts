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
//     plain   -> (raw text, HTML-escaped)
//     bold    -> <b>…</b>
//     italic  -> <i>…</i>
//     strike  -> <s>…</s>
//     spoiler -> <tg-spoiler>…</tg-spoiler>
//     code    -> <code>…</code>
//     link    -> <a href="…">…</a>
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

export interface StrikeNode extends Pos {
  type: "strike";
  children: Inline[];
}

export interface SpoilerNode extends Pos {
  type: "spoiler";
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
  | StrikeNode
  | SpoilerNode
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
