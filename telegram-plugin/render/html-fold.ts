// Raw-HTML dialect handling for the Bot API 10.1 rich-markdown render path.
//
// ── Why this module exists ────────────────────────────────────────────────
// Agents habitually emit raw HTML tags in prose (`<b>`, `<i>`, `<a href>`).
// Before this module those tags reached the wire byte-verbatim, which is two
// distinct hazards at once:
//
//   1. Nothing establishes that Telegram's rich markdown parser accepts them.
//      The wire-verified allowlist (raw `sendRichMessage` probes, 2026-08-13)
//      covers exactly `<u>`, `<sub>`, `<sup>`, `<details>`/`<summary>` and
//      `<aside>`/`<cite>`. `isParseEntitiesError` (`rich-send.ts`) matches
//      `unsupported start tag` / `unclosed start tag`, so the wire CAN 400 on
//      an unknown tag — and that fallback resends the body as PLAIN TEXT,
//      where the reader then sees literal `<b>` markup.
//   2. mdast `html` nodes degrade to `plain` in `parse.ts`, and `plain` is
//      `escapeMarkdown`'d on render. `escapeMarkdown` escapes `=`, so
//      `<a href="https://example.com">` shipped as `<a href\="…">` — an
//      attribute no parser can read.
//
// ── The policy (three buckets, degrade by TYPE, never silently) ───────────
//   • FOLD      — a tag with an exact native markdown equivalent is folded
//                 into the IR node for that construct, so it renders as the
//                 markdown the wire actually understands:
//                   <b>/<strong>       -> bold          **…**
//                   <i>/<em>           -> italic        *…*
//                   <s>/<del>/<strike> -> strike        ~~…~~
//                   <code>             -> code span     `…`
//                   <a href="URL">     -> link          [label](URL)
//                   <br>               -> a line break
//                   <pre>              -> fenced code block ```…```
//   • PASSTHROUGH — the wire-verified allowlist above is emitted RAW and
//                 UNESCAPED (an IR `raw` inline), which is also what stops
//                 `escapeMarkdown` from mangling their attributes. Requires a
//                 MATCHED close: an unbalanced `<u>` emitted raw is exactly
//                 the `unclosed start tag` 400 this module exists to prevent.
//   • DEGRADE   — everything else, split by whether the token delimits
//                 content. The discriminator is MATCHING, not the tag name:
//                   – A MATCHED pair (`<marquee>…</marquee>`, `<div>…</div>`)
//                     is markup wrapped around content. The markup is dropped
//                     and the content kept; a block-level name additionally
//                     leaves a hard line break, so `<li>one</li><li>two</li>`
//                     cannot glue into `onetwo`.
//                   – A comment, or a void / self-closing tag (`<hr/>`,
//                     `<img …/>`), delimits nothing. Markup dropped; a
//                     block-level one leaves the same separator.
//                   – An UNMATCHED open/close marker is not markup at all — it
//                     is PROSE. `<service>/<key>`, `<agent>`, "the `<b>` tag",
//                     `run switchroom vault get <key>` are pervasive in this
//                     project's own agent output, and DELETING them silently
//                     mangles the agent's own reply. Such a token is kept as
//                     LITERAL TEXT with `&`/`<`/`>` HTML-entity-escaped (see
//                     `escapeHtmlLiteral`). Bot API rich markdown "can contain
//                     arbitrary HTML … parsed as described in Rich HTML
//                     style", and Rich HTML documents `&lt;`, `&gt;` and
//                     `&amp;` among its supported named entities — so the
//                     entity form is the DOCUMENTED way to ship a literal
//                     angle bracket without tripping `unsupported start tag`.
//
// ── The invariant ─────────────────────────────────────────────────────────
// CONTENT is never lost. Only MARKUP is dropped, and only where dropping it
// loses no reader-visible text: a matched pair, a comment, a void tag.
// Anything not demonstrably markup survives to the wire as escaped literal
// text. (Known residual, NOT introduced by this module and not fixed here: a
// `<` in prose that mdast hands over as a TEXT node rather than an `html` node
// — the decoded `&lt;c&gt;`, or `response in <1s` — never reaches this module
// and still ships unescaped. That is a `plain`-node / `escapeMarkdown`
// concern.)
//
// This is a deterministic code-level guarantee, deliberately not a prompt
// instruction to the agents that emit the tags.

/** How a raw HTML token reads. `other` covers anything the tokenizer matched
 *  but could not classify (it degrades like an unknown tag). */
export type HtmlTagKind = "open" | "close" | "selfclose" | "comment" | "other";

export interface HtmlTagInfo {
  kind: HtmlTagKind;
  /** Lowercased tag name (`""` for a comment). */
  name: string;
  /** The raw source bytes of the token, verbatim. */
  raw: string;
  /** Raw attribute text between the tag name and the closing `>`. */
  attrs: string;
}

/** The IR construct a foldable tag maps onto. `pre` is BLOCK-level (a fenced
 *  code block); every other target is inline. */
export type HtmlFoldTarget =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "break"
  | "pre";

/** Tags with an exact native markdown equivalent on the Bot API 10.1 rich
 *  path. Folding them means the wire sees markdown it definitely parses
 *  instead of HTML it may reject. */
export const HTML_FOLD_TAGS: Readonly<Record<string, HtmlFoldTarget>> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  s: "strike",
  del: "strike",
  strike: "strike",
  code: "code",
  a: "link",
  br: "break",
  // `<pre>` is the one BLOCK-level fold. Telegram's own Rich HTML reference
  // pairs `<pre><code class="language-…">` with the ```` ```lang ```` fence,
  // so the fenced block is the exact native equivalent. Without it `<pre>`
  // dropped its markup and the inner `<code>` folded to an INLINE span
  // wrapping a newline — a construct Telegram will not parse, leaving the
  // reader literal backticks around broken text.
  pre: "pre",
};

/** HTML elements that carry no content of their own (void elements) plus the
 *  XHTML self-closing spelling. Dropping such a token's markup cannot lose
 *  text, so it degrades silently rather than surviving as literal prose.
 *  `br` is excluded — it FOLDS to a line break. */
export const HTML_VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Structural / block-level element names. A degrade of one of these leaves a
 *  hard line break behind so its neighbours do not glue together
 *  (`<ul><li>one</li><li>two</li></ul>` -> `onetwo` was the defect). The
 *  passthrough allowlist (`details`, `summary`, `aside`, `cite`) is
 *  deliberately absent — those never degrade. */
export const HTML_BLOCK_LEVEL_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "blockquote",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** True when a degraded token should leave a line break behind. */
export function isBlockLevelTag(name: string): boolean {
  return HTML_BLOCK_LEVEL_TAGS.has(name);
}

/** True for a tag that delimits no content of its own. */
export function isVoidTag(name: string): boolean {
  return HTML_VOID_TAGS.has(name);
}

/**
 * HTML-entity-escape a run of literal text so its angle brackets reach the
 * reader instead of being parsed as a tag (or 400ing as an unsupported one).
 *
 * Bot API rich markdown "can contain arbitrary HTML … parsed as described in
 * Rich HTML style", and Rich HTML's supported named entities are documented as
 * exactly `&lt; &gt; &amp; &quot; &apos; &nbsp; &hellip; &mdash; &ndash;
 * &lsquo; &rsquo; &ldquo; &rdquo;` (https://core.telegram.org/bots/api). Only
 * the first three are needed here. `&` is escaped FIRST so an already-entity
 * -looking run cannot be double-decoded.
 */
export function escapeHtmlLiteral(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The `class="language-xxx"` hint on a `<pre><code …>` block, or null. */
const LANGUAGE_CLASS_RE = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** Pull the fenced-block language out of a `<code class="language-python">`
 *  tag's attributes, or null. Telegram's reference spells the language hint
 *  exactly this way; anything else yields a plain fence. */
export function languageOf(tag: HtmlTagInfo): string | null {
  const m = LANGUAGE_CLASS_RE.exec(tag.attrs);
  if (m == null) return null;
  const cls = m[1] ?? m[2] ?? m[3] ?? "";
  const lang = cls
    .split(/\s+/)
    .map((c) => /^language-(.+)$/.exec(c)?.[1])
    .find((c): c is string => c != null && c.length > 0);
  // A fence info string cannot contain a backtick (it would close the fence).
  return lang != null && !lang.includes("`") ? lang : null;
}

/** Tags PROVEN on the wire by raw `sendRichMessage` probes (2026-08-13) to
 *  render as native typed nodes. These pass through raw and unescaped.
 *  Deliberately an allowlist: an unprobed tag is not known-good syntax. */
export const HTML_PASSTHROUGH_TAGS: ReadonlySet<string> = new Set([
  "u",
  "sub",
  "sup",
  "details",
  "summary",
  "aside",
  "cite",
]);

/** Matches one HTML comment or one start/end tag. Attribute values containing
 *  a raw `>` are not supported (they are invalid unquoted HTML and vanishingly
 *  rare in agent prose); such a token simply degrades. */
export const HTML_TOKEN_RE =
  /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?\/?>/g;

const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*?)?)(\/?)>$/;
const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** Classify a single raw HTML token. */
export function classifyHtmlTag(raw: string): HtmlTagInfo {
  if (raw.startsWith("<!--")) return { kind: "comment", name: "", raw, attrs: "" };
  const m = TAG_RE.exec(raw);
  if (m == null) return { kind: "other", name: "", raw, attrs: "" };
  const [, slash, name, attrs, selfClose] = m;
  const kind: HtmlTagKind =
    slash === "/" ? "close" : selfClose === "/" ? "selfclose" : "open";
  return { kind, name: name.toLowerCase(), raw, attrs: attrs ?? "" };
}

/** Pull the `href` value out of a tag's attribute text, or null when absent
 *  or empty. The ORIGINAL bytes are returned — never rewritten. */
export function hrefOf(tag: HtmlTagInfo): string | null {
  const m = HREF_RE.exec(tag.attrs);
  if (m == null) return null;
  const value = m[1] ?? m[2] ?? m[3] ?? "";
  return value.length > 0 ? value : null;
}

/** True when this tag is emitted raw and unescaped (wire-verified allowlist). */
export function isPassthroughTag(tag: HtmlTagInfo): boolean {
  return tag.name.length > 0 && HTML_PASSTHROUGH_TAGS.has(tag.name);
}

/**
 * Decide which HTML tokens in a DOCUMENT are balanced markup and which are
 * bare prose, given every token in document order.
 *
 * Matching cannot be decided inside a single mdast `html` node: micromark
 * splits `<details open>…\n\nbody\n\n</details>` into THREE nodes, so the open
 * and close markers arrive in different streams. A document-level pass is the
 * only place the question is answerable. Feeding it mdast `html` nodes (rather
 * than the raw source) also means tags inside a code fence or a code span are
 * never counted — they are not markup and must not balance anything.
 *
 * Standard HTML-ish matching: opens are pushed on a stack and a close pops to
 * the nearest same-named open, leaving anything above it unmatched. Void and
 * self-closing tags are balanced by definition and are not tracked.
 *
 * Returns the SOURCE OFFSETS of every token that has a partner; a token whose
 * offset is absent is unmatched — prose, per the module policy above.
 */
export function matchedTagOffsets(
  tokens: ReadonlyArray<{ tag: HtmlTagInfo; start: number }>,
): Set<number> {
  const matched = new Set<number>();
  const stack: { name: string; start: number }[] = [];
  for (const { tag, start } of tokens) {
    if (tag.kind === "open" && !isVoidTag(tag.name)) {
      stack.push({ name: tag.name, start });
      continue;
    }
    if (tag.kind !== "close") continue;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name !== tag.name) continue;
      matched.add(stack[i].start);
      matched.add(start);
      stack.length = i;
      break;
    }
  }
  return matched;
}

/** A piece of a raw-HTML string: either an HTML token or a run of text. */
export type HtmlPiece =
  | { kind: "tag"; tag: HtmlTagInfo; start: number; end: number }
  | { kind: "text"; text: string; start: number; end: number };

/**
 * Split a raw string into HTML tokens and the text runs between them.
 * `base` is the absolute source offset the string starts at, so every piece
 * carries usable UTF-16 offsets into the original markdown.
 */
export function tokenizeHtml(raw: string, base: number): HtmlPiece[] {
  const pieces: HtmlPiece[] = [];
  const re = new RegExp(HTML_TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) != null) {
    if (m.index > last) {
      pieces.push({
        kind: "text",
        text: raw.slice(last, m.index),
        start: base + last,
        end: base + m.index,
      });
    }
    pieces.push({
      kind: "tag",
      tag: classifyHtmlTag(m[0]),
      start: base + m.index,
      end: base + m.index + m[0].length,
    });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    pieces.push({
      kind: "text",
      text: raw.slice(last),
      start: base + last,
      end: base + raw.length,
    });
  }
  return pieces;
}
