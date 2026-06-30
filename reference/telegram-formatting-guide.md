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
(Bot API 10.1). Format to make the message **scannable and easy to read**, not
decorated. These are communication tools — use them with judgment. Most short replies
need none of them.

### Mechanical rules (always)
- Separate paragraphs with a blank line (`\n\n`). A single newline collapses onto the
  same line and reads as a wall of text.
- Keep paragraphs short — 1 to 4 lines. Break before the reader has to work for it.
- Hard cap is 32768 characters. Long before that, ask whether a wall of text is the
  right answer at all.

### The toolkit, and when to reach for each
- **Bold** — the one key fact or the answer. Not every noun. If everything is bold,
  nothing is.
- *Italic* — light emphasis, asides, labels.
- `code spans` — every identifier: filenames, commands, config keys, agent / account /
  slot names, error codes. Tap-to-copy, and visually distinct from prose.
- Code fences — multi-line output: diffs, logs, command blocks, JSON. Add a language
  hint (` ```diff `, ` ```json `) when it sharpens the render.
- Bulleted list — 3+ parallel items the reader will scan or compare. Never for a single
  thought or a flowing narrative.
- Numbered list — ordered steps or ranked items.
- Task lists (`- [x]` / `- [ ]`) — progress on a checklist of steps the reader is
  tracking. Renders as real checkboxes; reserve for genuine done/not-done state.
- Tables — 2-D data only (rows × columns): per-account usage, status fields. Render as
  real tables (up to 20 columns). Overkill for a flat list.
- Headings (`#`) — only in a long, multi-section answer. Clutter on a short reply.
- Blockquotes (`>`) — quoted text or indented continuation. Telegram drops leading
  spaces, so use `>`, never literal indentation.
- `==highlight==` — a single word or value the reader's eye must land on. Stronger
  than bold; use at most once per message.
- Dividers (`---`) — between genuinely separate sections. Heavy; use sparingly.

Tables, headings, dividers, task lists, lists, blockquotes and `==highlight==` all
render as rich blocks (Bot API 10.1) — reach for whichever cuts the reader's scanning
effort. The ONE exception: sub/superscript (`H~2~O`, `x^2^`) falls back to literal
text, so don't use it.

### The why
Structure exists for the reader, not the writer. A two-item bullet list is worse than a
sentence. A heading on a three-line reply is noise. Reach for structure only when it
**reduces the reader's effort** — parallel options, scannable data, ordered steps — and
stay in prose when the thought is connected. When in doubt: shorter and plainer wins.

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
| Underline | `__text__` | Bot API 10.1 GFM extension. Use sparingly — reads like a link. |
| Strikethrough | `~~text~~` | Retractions, "was X now Y". |
| Spoiler | `\|\|text\|\|` | Hidden until tapped — surprises, long-answer punchlines. |
| Highlight / marked | `==text==` | The `=` is an `escapeMarkdown` special, so dynamic text won't trigger it by accident. |
| Inline code | `` `text` `` | Identifiers, tap-to-copy. Content is literal — no escaping inside. |
| Subscript | `~text~` (single tilde) | **Falls back to literal text** in rich messages (Bot API 10.1) — the only GFM construct that doesn't render. Avoid. |
| Superscript | `^text^` | **Falls back to literal text** in rich messages — avoid (use words, e.g. "squared"). |
| Custom emoji | Telegram premium custom-emoji entity | Premium-only; renders as a normal emoji for non-premium viewers. Don't rely on it conveying meaning. |
| Inline math | `$ … $` | LaTeX-style inline math (Bot API 10.1). |
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
- **Pull-quote / expandable blockquote** — `**> …`** (Bot API 10.1 expandable
  blockquote). A long quote the reader can collapse/expand.
- **Section heading** — `#` … `######`. Only in a genuinely long, multi-section answer.
- **Preformatted block** — a code fence with no language, for fixed-width non-code
  (ASCII tables, aligned columns).
- **Details / collapsible** — Bot API 10.1 collapsible section. For optional depth the
  reader can expand (full logs under a one-line summary).
- **Collage / slideshow** — multiple images grouped in one message (album / media
  group). Send via the attachment path, not markdown.
- **Divider** — `---` (thematic break). Heavy horizontal rule between genuinely
  separate sections. Use sparingly.
- **Footnotes** — GFM `[^1]` reference + `[^1]: …` definition.

> Reach for the exotic spans (spoiler, highlight, math, custom emoji) only when they
> genuinely serve the reader. The floor card's "why" applies: structure for the reader,
> not the writer. Note sub/superscript is the one exception — it does NOT render (falls
> back to literal text), so don't use it.

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
