---
name: telegram-formatting
description: >
  Use when composing a rich or long Telegram reply and you want the full
  formatting palette with exact syntax — expandable blockquotes, spoilers,
  highlight, code-fence language hints, GFM tables, nested lists — plus the
  escaping rules and the framework's send-time chunking/normalizer behaviour.
  Load it when a message genuinely needs structure, NOT for everyday short
  replies (plain prose already wins there). Teaches judgment first: which
  construct helps the reader vs when plain text is better. Do NOT use for
  deciding whether to reply, or for non-Telegram output.
---

# Telegram formatting — the full palette

Every outbound Switchroom message renders as raw GFM markdown over Telegram
Bot API 10.1 rich messages (`telegram-plugin/rich-send.ts` `richMessage(md)` →
`{ markdown }` → `sendRichMessage` / `editMessageText({ markdown })`). No HTML,
no `parse_mode`. This skill is the depth reference behind the boot-injected
floor card: the full construct vocabulary, correct syntax, escaping, and the
send-time behaviour you can rely on.

## Judgment first — reach for structure only when it helps the reader

The floor card's stance is the law here too: **structure exists for the reader,
not the writer.** Loading this skill does not mean "use everything below." Match
the construct to the message.

- **Short answers (a line or two): plain prose, no formatting.** "on it,
  pulling the logs now" is already perfect. No bold, no bullets, no headings.
  Most replies live here — don't dress them up.
- **Default: light structure.** Bold ONLY the one key fact or answer, never
  more. A list only for 3+ genuinely parallel items the reader will scan or
  compare; two items or a flowing thought stay prose. `code spans` for
  identifiers (filenames, commands, config keys, error codes) — tap-to-copy.
- **Long / multi-section answers may add the rich constructs below** — tables,
  headings, blockquotes, expandable blocks, fences — but only when they cut the
  reader's effort. If the structure doesn't reduce scanning effort, drop it. A
  two-item bullet list is worse than a sentence; a heading on a three-line reply
  is noise. When in doubt, shorter and plainer wins.

Over-bolded messages (most of the text bold, whole paragraphs/lists bolded) get
their bold stripped at send time — so bold sparingly and deliberately.

## Full rich vocabulary

### Inline spans

| Effect | Markdown | When / notes |
| --- | --- | --- |
| Bold | `**text**` | The one key fact or answer, not decoration. |
| Italic | `*text*` or `_text_` | Light emphasis, labels, asides. |
| Strikethrough | `~~text~~` | Retractions, "was X now Y". |
| Spoiler | `\|\|text\|\|` | Only for an opt-in surprise or a reveal the reader chose to wait for (a punchline they want suspended) — NEVER to hide an answer someone is asking for or anxious about; when in doubt, show it plainly. Surfaces as a `spoiler` entity on the wire (live-verified 2026-07). |
| Highlight / marked | `==text==` | Surfaces as a `marked` entity on the wire (live-verified 2026-07). `=` is an `escapeMarkdown` special, so dynamic text won't trigger it by accident. |
| Inline code | `` `text` `` | Identifiers, tap-to-copy. Content is literal — no escaping inside. |
| Link | `[label](https://…)` | Standard GFM link. |

**Do NOT rely on these — they don't render as intended:**

- **Underline** — there is NO underline token on this path. `__text__` renders
  as **bold** (Telegram's rich-message markdown parser reads a `__…__` run
  identically to `**…**`, live-verified against the Bot API 2026-07). Use `**`
  for bold and don't reach for underline.
- **Subscript** `~text~` (single tilde) and **superscript** `^text^` fall back
  to literal text in rich messages — avoid (write "squared", not `x^2^`).
- **Custom emoji** (premium custom-emoji entity) renders as a normal emoji for
  non-premium viewers — don't rely on it to carry meaning.

(Inline math `$…$`, HTML `<details>`/collapsible, and footnotes `[^1]` are NOT
supported on this path — do not emit them; they degrade to literal or neutralised
text.)

### Block types

- **Code fence** — ` ```lang ` … ` ``` `. Multi-line literal output (diffs,
  logs, JSON, command blocks). The language hint (`diff`, `json`, `bash`, …)
  sharpens syntax rendering — use it. Content inside is verbatim, never escape
  it; the only hazard is an embedded ` ``` ` closing the block early, which the
  framework defuses (`preBlock` in `shared/bot-runtime.ts`).
- **Preformatted block** — a code fence with NO language, for fixed-width
  non-code (ASCII tables, aligned columns).
- **Bulleted list** — `- item` (also `*` / `+`). 3+ parallel items only.
- **Numbered list** — `1. item`. Ordered steps or ranked items.
- **Nested lists** — indent sub-items; tight (no blank lines) vs loose (blank
  lines between items) both render. 3-level nesting is live-verified.
- **Task list** — `- [ ] todo` / `- [x] done`.
- **Table** — GFM pipe table (`| col | col |` + `| --- | --- |` separator),
  optional per-column alignment (`:---`, `:---:`, `---:`). 2-D data ONLY (rows ×
  columns) — not a substitute for prose. Chunk-safe: `splitMarkdownChunks` never
  bisects a row.
- **Blockquote** — `> quoted`. Quoted text or an indented continuation; the
  right way to indent, because Telegram drops leading whitespace.
- **Expandable blockquote** — `**> …` (Bot API 10.1). A long quote/aside the
  reader can collapse and expand. The flagship rich construct — use it for a
  long quotation, a stack trace, or a detailed aside you don't want dominating
  the message. First line carries the `**> ` marker; continuation lines use `> `.
- **Section heading** — `#` … `######`. Only in a genuinely long, multi-section
  answer. Never on a short reply.
- **Divider** — `---` (thematic break). Heavy horizontal rule between genuinely
  separate sections. Use sparingly.
- **Collage / album** — multiple images grouped in one message (media group).
  Send via the attachment path, not markdown.

## Escaping rules

Dynamic content (filenames, ids, arbitrary user text) interpolated into a
hand-built markdown card MUST be escaped so it renders LITERALLY instead of
being parsed as formatting. Use `escapeMarkdown(value)` from
`telegram-plugin/format.ts`.

`escapeMarkdown` escapes exactly the characters that trigger INLINE formatting:
backslash, `` ` ``, `*`, `_`, `~`, `=`, `[`, `]`, `|` — the set `` \`*_~=[]| ``.
The backslash is escaped first so it never double-escapes a following special.
It deliberately does **not** escape `.` `-` `+` `#` `(` `)` `{` `}` `!` `>`:
those are only meaningful at line-start or in link/structure context, and
escaping them mid-word would litter filenames (`foo.ts`), versions (`v1.2-rc`),
and URLs with visible backslashes.

- **Bold/italic a dynamic value:** `` `**${escapeMarkdown(value)}**` ``.
- **Code-span a dynamic value:** `` `\`${value}\`` `` — code spans need NO
  escaping (backtick content is already literal). This is the preferred, safest
  way to render any identifier.

## Send-time behaviour you can rely on

- **Chunking.** Hard cap is `RICH_MESSAGE_MAX_CHARS = 32768` (32768 accepted,
  32769 rejected — the single constant, never re-derive it). A longer body is
  split by `splitMarkdownChunks(text, 32768)` in `format.ts`: it cuts at the
  largest safe boundary (blank line → newline → space), **never bisects a fenced
  code block** (`backOffOpenFence`) and **never bisects a table row**
  (`backOffTableRow`). A single indivisible region larger than the cap is
  emitted whole and re-split / hard-sliced at send time rather than hanging.
  Long before 32768, ask whether a wall of text is the right answer at all.
- **Typography normalizer (deterministic, every message).** Block spacing (one
  blank line between distinct blocks), em/en dashes, and `•` bullet markers are
  rewritten at send time. A LONE `\n` between two prose paragraphs is promoted
  to a real visual break; runs of 3+ newlines collapse to `\n\n`; lists, tables,
  code, and existing `\n\n` gaps are left exactly as written. Don't hand-tune
  spacing or fight the normalizer — write the content, the gateway makes the
  typography consistent.

## The one rule that outranks everything here

You loaded this skill to format a rich message well — but the best formatting is
still the least that serves the reader. Use the palette to make a genuinely
complex answer scannable, never to decorate a simple one.
