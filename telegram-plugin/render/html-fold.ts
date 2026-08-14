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
//   • PASSTHROUGH — the wire-verified allowlist above is emitted RAW and
//                 UNESCAPED (an IR `raw` inline), which is also what stops
//                 `escapeMarkdown` from mangling their attributes.
//   • DEGRADE   — anything else (unknown tags, unmatched open/close markers,
//                 comments) has its MARKUP dropped while its CONTENT is kept
//                 and rendered normally. Never emit a construct the renderer
//                 cannot guarantee: shipping an unknown tag verbatim risks the
//                 400 -> plain-text fallback that shows the reader raw markup,
//                 which is strictly worse than showing them the text.
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

/** The IR construct a foldable tag maps onto. */
export type HtmlFoldTarget = "bold" | "italic" | "strike" | "code" | "link" | "break";

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
};

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
