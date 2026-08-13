# Telegram formatting guide

Two tiers:

- **Floor card** — compact, boot-injected into every agent's system prompt
  (`--append-system-prompt`, cached, model-independent). This is the deterministic
  floor: every bot *knows* the toolkit and the craft, every session, with no model
  in the loop deciding whether to load it.
- **Depth reference** — this file in full, loaded on demand for edge cases
  (the rich extras, escaping rules, chunking behaviour).

The floor card teaches judgment, not a syntax menu. The model keeps its own call on
what a given message needs; the card guarantees it knows what's available and why
each tool exists.

> **Single source of truth for the floor card.** The "FLOOR CARD (boot-injected)"
> section below is kept VERBATIM in sync with the TypeScript constant
> `TELEGRAM_FORMATTING_FLOOR_CARD` in `src/agents/scaffold.ts`, which is the
> string actually injected into every agent's `--append-system-prompt`. This
> `reference/*.md` file is NOT shipped into the agent image, so it can't be
> imported at runtime — when you change the floor card, edit BOTH this section
> and the constant together. (The constant's doc comment points back here.)

---

## FLOOR CARD (boot-injected)

You're writing for a phone screen in Telegram. Every reply renders as rich Markdown
(Bot API 10.1). One shared spec, three tiers:

- **Short answers (a line or two): plain prose, no formatting.** "on it, pulling the
  logs now" is already perfect. No bold, no bullets, no headings.
- **Default: light structure.** Bold ONLY the one key fact or answer, never more.
  *Italic* for a light aside or a term of art — rarer than bold; if everything is
  emphasised, nothing is. ~~Strikethrough~~ only for a genuine retraction or a
  "was X, now Y" — never decoration. A
  list only for 3+ genuinely parallel items the reader will scan or compare; two items
  or a flowing thought stay prose. A numbered list ONLY when order carries meaning
  (steps to follow, a ranking); a nested sub-list only for a real hierarchy, one level
  deep. `code spans` for identifiers: filenames, commands,
  config keys, error codes (tap-to-copy). Wrap dynamic identifiers in backticks:
  code-span content is literal, so it never needs escaping. Links as `[label](url)`,
  never bare pasted URLs mid-prose.
- **Long answers may add the rich constructs, but only when they cut the reader's
  effort:** a GFM pipe table for real 2-D data (rows x columns); headings only in a
  multi-section answer; a `---` divider only between genuinely separate sections of a
  long answer (a heading usually does the job alone); `>` for quoted text; a spoiler
  `||text||` ONLY when the reader should opt in before seeing it (a punchline, a plot
  detail, a shock number) — never for emphasis; `==highlight==` to marker-pen the one
  decisive phrase inside a longer passage — rarer than bold, never stacked with it;
  fenced code blocks ALWAYS with a language
  hint (```diff, ```json, ```bash — bare fence only for non-code fixed-width output);
  and the flagship — the **collapsible `<details>` block**:
  `<details><summary>Title</summary>` + body + `</details>` for a long quote, stack
  trace, or detailed aside the reader opts into (add `open` to start expanded). Use it
  whenever a bulky supporting block would otherwise dominate the message. Never write
  `**> ` for a collapsible — that is MarkdownV2 syntax; this path renders it as
  literal `**>` text.

Also native on this path: inline math `$x^2+y^2$`, footnotes (`claim[^1]` +
`[^1]: note` at the end), task-list checkboxes `- [ ]`/`- [x]`, and the HTML tags
`<sub>`/`<sup>`/`<u>`. Renders wrong — never emit: `__x__` (renders as BOLD, not
underline — use `<u>`), or the caret/tilde shorthand `^sup^`/`~sub~` (literal noise —
use `<sup>`/`<sub>` or words).

The framework normalizes mechanics in code on every outbound message: block spacing,
em/en dashes, and `•` bullet markers are
rewritten deterministically; the unsupported caret `^highlight^` form is repaired
(`==highlight==` renders fine); accidental currency `$5M and $10M` pairs are kept out
of math mode; long messages are chunked safely at 32768 chars (fences and
table rows never bisected); over-bolded messages get their bold stripped. Don't
hand-tune spacing or fight it — write the content, the gateway makes typography
consistent. Long before the cap, ask whether a wall of text is the right answer at all.

Structure exists for the reader, not the writer: a two-item bullet list is worse than
a sentence, a heading on a three-line reply is noise. When in doubt, shorter and
plainer wins.

Every turn that answers a user message ends with a user-visible `reply`
— Telegram is all the user sees; your terminal output
never reaches them.

---

## DEPTH REFERENCE (on-demand)

Everything below is for edge cases the floor card doesn't cover: the full rich
vocabulary, the exact escaping rules, and the framework's send-time behaviour
(chunking + the paragraph-break normalizer). The render path for every outbound
message is `telegram-plugin/rich-send.ts` `richMessage(md)` → `{ markdown }` →
`sendRichMessage` / `editMessageText({ markdown })` — one path, raw GFM markdown,
Bot API 10.1 rich messages.

### Full rich vocabulary

**Inline spans**

| Effect | Markdown | Notes |
| --- | --- | --- |
| Bold | `**text**` | The one key fact, not decoration. |
| Italic | `*text*` or `_text_` | Light emphasis, labels, asides. |
| Underline | `<u>text</u>` | The HTML tag renders a native underline entity (wire-verified 2026-08-13). **The markdown form `__text__` renders as BOLD**, not underline — Telegram's rich-message markdown parser reads a `__…__` run identically to `**…**` (live-verified against the Bot API, 2026-07); never rely on it for underline. |
| Strikethrough | `~~text~~` | Retractions, "was X now Y". |
| Spoiler | `\|\|text\|\|` | Hidden until tapped — surprises, long-answer punchlines. Live-verified: surfaces as a `spoiler` entity on the wire (2026-07). |
| Highlight / marked | `==text==` | Live-verified: surfaces as a `marked` entity on the wire (2026-07). The `=` is an `escapeMarkdown` special, so dynamic text won't trigger it by accident. |
| Inline code | `` `text` `` | Identifiers, tap-to-copy. Content is literal — no escaping inside. |
| Subscript | `<sub>text</sub>` | The HTML tag renders a native subscript entity (wire-verified 2026-08-13). The tilde shorthand `~text~` (single tilde) **falls back to literal text** — avoid it. |
| Superscript | `<sup>text</sup>` | The HTML tag renders a native superscript entity (wire-verified 2026-08-13). The caret shorthand `^text^` **falls back to literal text** and is repaired at send time (carets stripped) — avoid it. |
| Inline math | `$x^2+y^2$` | Renders as a native `mathematical_expression` node (wire-verified 2026-08-13). A compact `$…$` span passes through the outbound guards verbatim; accidental currency pairs (`$5M and $10M`) are still broken apart by the dollar-math guard. |
| Footnote | `claim[^1]` + `[^1]: note` | Native footnote machinery — superscript marker, anchor, reference link, and footer (wire-verified 2026-08-13). Put definitions at the end of the message. |
| Date/time link | `[label](tg://time?unix=…)` | Renders a native `date_time` node (wire-verified 2026-08-13). |
| Custom emoji | Telegram premium custom-emoji entity | Premium-only; renders as a normal emoji for non-premium viewers. Don't rely on it conveying meaning. |
| Link | `[label](https://…)` | Standard GFM link. |

**Block types**

- **Code fence** — ` ```lang ` … ` ``` `. Multi-line literal output (diffs, logs, JSON,
  command blocks). The language hint (`diff`, `json`, `bash`, …) sharpens syntax
  rendering. Content inside is verbatim — never escape it; the only hazard is an
  embedded ` ``` ` closing the block early (see `preBlock` in `shared/bot-runtime.ts`,
  which defuses that).
- **Bulleted list** — `- item` (also `*` / `+`). 3+ parallel items only.
- **Numbered list** — `1. item`. Ordered steps or ranked items.
- **Table** — GFM pipe table (`| col | col |` + `| --- | --- |` separator). 2-D data
  only. Chunk-safe — `splitMarkdownChunks` never bisects a row.
- **Blockquote** — `> quoted`. Quoted text or indented continuation; the right way to
  indent because Telegram drops leading whitespace.
  - "Leading whitespace" means **Unicode** whitespace, not just ASCII. A leading
    U+00A0 run is trimmed too — #3662 shipped a three-U+00A0 card indent, the bytes
    reached the Bot API intact, and the card still rendered dead flat on a phone.
  - Where a blockquote is unusable (e.g. card lines joined by `stackCardLines`, which
    requires that no line be a GFM block-structure line), use **U+2800 BRAILLE PATTERN
    BLANK**: general category So, not Zs, so no whitespace-trimming rule can eat it,
    yet it renders as blank width. Live-verified on a phone 2026-07-26; see
    `WORKER_STEP_INDENT` in `telegram-plugin/status-no-truncate.ts`.
  - Do **not** reach for a leading `· ` as a pseudo-indent: Telegram promotes it to a
    real list bullet, which is a block-structure line.
- **Collapsible block** — `<details><summary>Title</summary>` + body + `</details>`.
  Renders a native typed `details` node the reader expands on tap (wire-verified
  2026-08-13); add `open` (`<details open>`) to start expanded. This replaces the
  retired `**> ` "expandable blockquote": `**>` is MarkdownV2-only syntax that this
  path renders as LITERAL `**>` text (wire-verified 2026-08-13). The renderer no
  longer emits `**>` anywhere; legacy `**> ` input is repaired into a plain `>`
  blockquote.
- **Pull-quote** — `<aside>…<cite>credit</cite></aside>`. Renders a native `pullquote`
  node with a credit line (wire-verified 2026-08-13).
- **Task list** — `- [ ] open` / `- [x] done`. Renders native checkbox list items
  (wire-verified 2026-08-13).
- **Section heading** — `#` … `######`. Only in a genuinely long, multi-section answer.
- **Preformatted block** — a code fence with no language, for fixed-width non-code
  (ASCII tables, aligned columns).
- **Collage / slideshow** — multiple images grouped in one message (album / media
  group). Send via the attachment path, not markdown.
- **Divider** — `---` (thematic break). Heavy horizontal rule between genuinely
  separate sections. Use sparingly.

> Reach for the exotic spans (spoiler, highlight, math, custom emoji) only when they
> genuinely serve the reader. The floor card's "why" applies: structure for the reader,
> not the writer. Two SHORTHAND forms do NOT render as intended and should be avoided:
> the caret/tilde **sub/superscript shorthand** (`^text^` / `~text~`) falls back to
> literal text, and **underline written as `__text__` renders as bold**. Use the HTML
> tags instead — `<sub>`, `<sup>`, `<u>` all render natively (wire-verified
> 2026-08-13). Spoiler (`||…||`) and highlight (`==…==`) DO render correctly on this
> path.

### Escaping rules

Dynamic content (filenames, ids, arbitrary user text) interpolated into a hand-built
markdown card must be escaped so it renders LITERALLY instead of being parsed as
formatting. Use `escapeMarkdown(value)` from `telegram-plugin/format.ts`.

`escapeMarkdown` escapes exactly the characters that trigger INLINE formatting in
rich markdown — backslash, `` ` ``, `*`, `_`, `~`, `=`, `[`, `]`, `|` — i.e. the set
`` \`*_~=[]| ``. The backslash is escaped first so it never double-escapes a following
special.

It deliberately does **not** escape `.` `-` `+` `#` `(` `)` `{` `}` `!` `>`: those are
only meaningful at line-start (headings, lists, quotes) or in link/structure context,
and escaping them mid-word would litter filenames (`foo.ts`), versions (`v1.2-rc`), and
URLs with visible backslashes.

Two consequences worth internalising:

- **Bold/italic a dynamic value:** `` `**${escapeMarkdown(value)}**` ``.
- **Code-span a dynamic value:** `` `\`${value}\`` `` — code spans need NO escaping,
  because backtick content is already literal. This is the preferred way to render any
  identifier safely.

(The legacy `escapeHtmlForTg` name in `shared/bot-runtime.ts` is the same
markdown-special escaper kept under the old name so callers don't churn — it is NOT
HTML escaping any more.)

### The 32768 chunking behaviour

The rich-message wire cap is `RICH_MESSAGE_MAX_CHARS = 32768` (empirically exact:
32768 accepted, 32769 → `RICH_MESSAGE_TEXT_TOO_LONG`). It is the single constant —
never re-derive it.

A body longer than the cap is split by `splitMarkdownChunks(text, maxLen = 32768)` in
`telegram-plugin/format.ts` before send:

- It cuts at the largest safe boundary `<= maxLen`, preferring a blank line, then a
  single newline, then a space.
- It **never bisects a fenced code block** — `backOffOpenFence` retreats the cut to
  before an open ` ``` ` so a chunk never carries an unbalanced fence (an unterminated
  fence would swallow the next chunk's text).
- It **never bisects a table row** — `backOffTableRow` retreats to the start of any
  line containing `|`, so a half-row never ships.
- A single indivisible region larger than the cap (e.g. a giant fence with no interior
  boundary) is emitted whole rather than looping forever — Telegram then rejects it,
  which is louder and more debuggable than a hang.

**Length-error recovery (send time).** If a single pre-computed chunk still exceeds the
cap (the indivisible-region case above), Telegram answers with
`RICH_MESSAGE_TEXT_TOO_LONG` / `MESSAGE_TOO_LONG`. This is classified as a LENGTH error
(`isMessageTooLongError` in `retry-api-call.ts`, `isLengthError` in `rich-send.ts`) —
distinct from a markdown-parse reject. The reply path re-splits the offending chunk and,
as a last resort, `hardSliceToCap` cuts it on raw character count so every delivered
piece is `<= 32768`. A length error is therefore never misclassified as a parse reject
(which would resend the same oversized body as plain text) or surfaced raw.

### The paragraph-break normalizer

GFM (the rich render path) treats a LONE `\n` as a *soft* break: two lines collapse
onto the same visual line. A model that separates paragraphs with a single newline
would produce a cramped wall of text. (The old markdown→HTML path rendered every `\n`
as a hard break, which masked the habit; the rich path no longer does.)

`normalizeParagraphBreaks(text)` in `telegram-plugin/format.ts` fixes this
deterministically, running on the outbound body right after `repairEscapedWhitespace`
on the `reply`, `stream_reply`, and (non-literal) `edit_message` paths. On
code-masked text it does exactly two things:

1. **Collapse runs of 3+ newlines down to exactly `\n\n`** — never collapses a genuine
   `\n\n` paragraph gap.
2. **Promote a LONE `\n` into a GFM hard break (`  \n`, two trailing spaces)** — but
   ONLY when it is a genuine prose paragraph break.

The promotion heuristic is deliberately CONSERVATIVE — it prefers a **false negative**
(leave a break un-promoted, two prose lines stay cramped) over a **false positive**
(double-space a tight list or table). A break is promoted only when ALL hold:

- The preceding line ends in sentence-terminal punctuation — `.`, `!`, `?`, `:`, or a
  closing `)` / `"` / `'` / `’` / `”` / `]` that itself follows such a terminator
  (e.g. `He said "go."`).
- The preceding line is NOT itself a marker line.
- The NEXT line starts with a non-marker character.

A "marker line" (never reflowed around) is a list item (`-`/`*`/`+`/`1.`/`1)`, incl.
indented), a table row (`|` or ` | `), a blockquote (`>`), an ATX heading (`#`), a code
fence delimiter, a thematic break (`---`/`***`/`___`), or a standalone masked code
block. Fenced code and inline code are masked out (shared `maskCodeRegions` masker, the
same one `repairEscapedWhitespace` uses) before any of this runs, so their interior
newlines are never touched.

Net effect: prose paragraphs separated by a single newline get a real visual break,
while lists, tables, code, and existing `\n\n` gaps are left exactly as the model wrote
them. When in doubt, the normalizer leaves the break alone.
