---
artifact: Telegram-native rich formatting engine (markdown IR → renderer → rich-send)
serves: feel-like-a-colleague
advances-outcome: standing-team
status: Draft — corrects the record; Phase 1 (parser + IR) already shipped
---

# RFC: Telegram-native rich formatting engine

**Status:** Draft — corrects the record; Phase 1 (parser + IR) already shipped
**Author:** (agent-authored, operator-directed)
**Targets:** `origin/main` @ HEAD (post-#2928)
**Job spec:** [`feel-like-a-colleague`](../jobs/feel-like-a-colleague.md) — an
agent that emits broken tables, truncated blockquotes, or raw markup reads like
a chatbot, not a colleague. Correct rendering of structured output (tables,
collapsible detail, code) is table stakes for the "specialists who feel like a
team" promise.
**Compliance:** touches no invariant. Pure output-formatting; no model call, no
egress, no new auth surface.

---

## Why this document exists

PR [#2928](https://github.com/switchroom/switchroom/pull/2928) (branch
`feat/telegram-html-render`, merged 2026-07-07) shipped Phase 1 of this engine —
the markdown parser and the typed IR — and cited **"RFC §10 increment 1"** as
its spec. **That RFC never existed.** There is no
`docs/telegram-native-formatting-rfc.md`, no "§10", and no equivalent design
record anywhere in `main`, the feature branch, or git history. The 50-odd RFCs
under `reference/rfcs/` do not include one for this engine.

So Phase 1 shipped against a phantom spec, and — worse — the phantom spec it
*imagined* was wrong about the output contract. This RFC is the design record
that should have existed first. It does two jobs:

1. **Establishes the real architecture** the engine actually plugs into.
2. **Corrects the wrong assumption** baked into `ir.ts`'s own doc comments: the
   renderer must emit **GFM markdown**, not Telegram Bot API **HTML**.

Phase 1's *code* is fine and lands cleanly at the IR layer under this corrected
architecture. Only the "for the next increment" HTML sketch in its comments is
superseded — see [§4](#4-the-html-assumption-was-wrong).

---

## 1. The real send contract

Every outbound message in the plugin goes through
[`telegram-plugin/rich-send.ts`](../../telegram-plugin/rich-send.ts) (PR #2669,
merged 2026-07-05). It sends via `sendRichMessage` / `editMessageText` with a
single-field input object:

```ts
export interface InputRichMessageMarkdown {
  markdown: string
}
```

The wire payload is **raw GFM markdown**, Telegram Bot API 10.1's native
rich-message mode — **not HTML**, not `parse_mode: HTML`, not manually escaped
entity spans. Telegram parses the markdown server-side; a malformed construct
comes back as a `400 … can't parse markdown` (deliberately not swallowed).

The full markdown vocabulary this mode accepts is documented in
[`reference/telegram-formatting-guide.md`](../telegram-formatting-guide.md). The
constructs this engine cares about:

| Construct | Markdown the renderer must emit |
| --- | --- |
| Bold / italic / strike / spoiler / code / link | `**b**`, `_i_`, `~~s~~`, `\|\|spoiler\|\|`, `` `code` ``, `[t](url)` |
| Heading | bold line (Telegram has no `<h1>`–`<h6>`) |
| Blockquote | `> …` line-prefixed |
| **Expandable** blockquote | ~~`**> …`~~ CORRECTED 2026-08-13: `**>` is MarkdownV2-only syntax; the rich markdown path renders it as literal text (wire-probed). The renderer emits a plain `> …` quote for legacy expandable input; a real collapsible is `<details><summary>…</summary>…</details>`, which passes through natively. |
| Code block | fenced ```` ``` ```` with optional language |
| List | `- item` / `1. item` |
| Table | GFM pipe table (`\| col \| col \|` + `\| --- \| --- \|` separator row) |

A live UAT scenario,
[`telegram-plugin/uat/scenarios/jtbd-rich-formatting-render-dm.test.ts`](../../telegram-plugin/uat/scenarios/jtbd-rich-formatting-render-dm.test.ts),
already confirms production Telegram renders these markdown constructs
correctly. (It previously claimed the same for `**>` expandable blockquotes;
raw wire probes on 2026-08-13 disproved that — the scenario's decode step only
asserted a `blockquote` entity, which the plain `>` continuation lines produced
on their own while the `**>` opener came back as literal paragraph text.) The
renderer's target is defined by what real probes prove, not by a hypothetical
HTML mapping.

---

## 2. Architecture

Three stages, one direction:

```
source markdown ─► parse.ts ─► typed IR (ir.ts) ─► renderer ─► rich-send.ts { markdown }
                   [Phase 1]     [Phase 1]          [Phase 2]    [shipped, #2669]
```

- **`telegram-plugin/render/parse.ts`** — folds an mdast tree into the IR. Ships
  in Phase 1 (#2928).
- **`telegram-plugin/render/ir.ts`** — the typed intermediate representation:
  inline nodes (plain/bold/italic/strike/spoiler/code/link) and block nodes
  (paragraph, heading, blockquote with an `expandable: boolean` flag, code
  block, list, thematic break, table). Every node carries `{ start, end }`
  UTF-16 source offsets that round-trip to the original markdown. Ships in
  Phase 1 (#2928).
- **The renderer** — Phase 2, not yet built. Walks the IR and emits a **GFM
  markdown string** matching the vocabulary in §1. This is the piece that
  `ir.ts`'s comments mis-specced as an HTML emitter.
- **`telegram-plugin/rich-send.ts`** — wraps the renderer's markdown string in
  `{ markdown }` and sends it. Already shipped, unchanged by this work.

The IR is the parser↔renderer contract. It is deliberately
**output-format-agnostic** at the type level — it models *document structure*
(a table is a table, a blockquote is expandable-or-not), not a target syntax.
That is exactly why Phase 1's IR survives this correction untouched: nothing in
the IR *types* commits to HTML. Only the prose comment describing the future
renderer did.

### Note on chunking / no streaming

Switchroom has **no streaming/ticker reply path**. Final replies are sent whole
through the reply tool; a reply longer than the char cap is chunked. The
renderer therefore produces one complete markdown string per logical message; it
does not emit incremental fragments and must not assume a streaming consumer.
Oversize handling is [§5](#5-oversize--fallback), not a streaming concern.

---

## 3. Phase 1 status (already shipped, #2928)

| Layer | Status | Notes |
| --- | --- | --- |
| `parse.ts` — mdast → IR | ✅ shipped (#2928) | matches this architecture |
| `ir.ts` — typed IR (tables, expandable blockquotes, lists, code blocks) | ✅ shipped (#2928) | types are format-agnostic; land cleanly here |
| IR doc comments' HTML mapping | ⚠️ superseded | wrong target format — see §4 |
| renderer (IR → markdown) | ⛔ Phase 2, not built | separate build agent, in parallel |

Phase 1 is **correct at the IR layer** under this RFC. No rework of `parse.ts`
or the IR types is required. The only Phase-1 artifact this RFC overrides is a
block of comments.

---

## 4. The HTML assumption was wrong

`ir.ts`'s header comment describes the engine as "the Telegram **HTML** render
engine" and sketches a tag mapping "for the next increment" —
`bold -> <b>…</b>`, `blockquote expandable -> <blockquote expandable>`,
`table -> monospaced <pre>`, and so on. **That mapping is superseded by this
RFC and must not be implemented.**

The send path (`rich-send.ts`, §1) takes `{ markdown }`, not HTML. Emitting HTML
would either be double-escaped as literal text or rejected as unparseable
markdown. The correct renderer emits the **markdown** column of the §1 table.

Concretely, the corrections:

| `ir.ts` comment says (HTML) | This RFC (markdown) |
| --- | --- |
| `bold -> <b>…</b>` | `bold -> **…**` |
| `italic -> <i>…</i>` | `italic -> _…_` |
| `strike -> <s>…</s>` | `strike -> ~~…~~` |
| `spoiler -> <tg-spoiler>…</tg-spoiler>` | `spoiler -> \|\|…\|\|` |
| `code -> <code>…</code>` | `` code -> `…` `` |
| `link -> <a href>…</a>` | `link -> [text](url)` |
| `blockquote -> <blockquote>` | `blockquote -> > …` (line-prefixed) |
| `expandable -> <blockquote expandable>` | ~~`expandable -> **> …`~~ CORRECTED 2026-08-13: renders as a plain `> …` quote (`**>` is not rich-markdown syntax — wire-probed literal text) |
| `code-block -> <pre><code class=…>` | fenced ```` ``` ```` + language |
| `table -> monospaced <pre>` | GFM pipe table (Telegram renders it natively) |

A Phase-2 follow-up should also refresh `ir.ts`'s header comment to say
"markdown render engine" and delete/replace the HTML sketch, so the source
stops advertising a contract the code doesn't honor. (Comment-only; out of
scope for this doc-only PR, flagged for the renderer PR.)

---

## 5. Oversize / fallback

Telegram caps rich-message length. When rendered markdown exceeds the cap the
renderer must split **on construct boundaries** — between blocks, list items, or
table-with-its-own-header — never mid-construct. A table split across two
messages must repeat its header row in the second; a blockquote must not be cut
so that its opening `>` lines land in one message and the rest in another.
(An earlier revision of this rule referenced the `**>` expandable opener; that
marker is retired — wire probes 2026-08-13 showed `**>` is MarkdownV2-only and
renders as literal text on the rich path, so the renderer no longer emits it.)

**Hard rule: never truncate mid-construct.** If a single logical construct is
itself larger than the cap and cannot be safely split (e.g. one enormous table
row, one oversized code block), the renderer **falls back cleanly to plain
text** for that content — strips the markup and sends the raw text — rather than
emit a half-open construct that Telegram will 400 on or render as garbage. A
correct-but-plain message always beats a broken rich one.

This mirrors `rich-send.ts`'s existing posture: a malformed-markdown 400 is a
bug to prevent, not to swallow. The fallback path exists so the renderer never
hands the send path something that will 400.

---

## 6. Acceptance criteria

Established with the product owner. Phase 2 ships when:

1. **Correct tables and collapsible blocks.** The renderer produces correct GFM
   markdown for tables and expandable/collapsible blocks from the IR, verified
   against live Telegram render (the `jtbd-rich-formatting-render-dm` UAT is the
   arbiter).
2. **Clean oversize fallback.** Any rich content too large to split without
   breaking a construct falls back to plain text. Nothing is ever truncated
   mid-tag / mid-construct.
3. **Suite stays green.** The existing formatting test suite (~3,200 lines) stays
   fully green — no regressions.
4. **Off by default.** Ships behind a flag, **gated OFF by default**, enabled
   per-agent later.

---

## 6a. Live-wire construct verification (2026-07, default-on gate)

Before flipping `SWITCHROOM_RICH_RENDER` default-on, every "soft" construct was
proven directly against the Bot API `sendRichMessage` endpoint — the actual wire
path — and the returned `rich_message` structure (Telegram's own parse) was
inspected, not eyeballed. Ground truth:

| Construct | Markdown emitted | Telegram entity returned | Verdict |
| --- | --- | --- | --- |
| Bold | `**b**` | `bold` | ✅ ships |
| Italic | `_i_` | `italic` | ✅ ships |
| Strikethrough | `~~s~~` | `strikethrough` | ✅ ships |
| Inline code | `` `c` `` | `code` | ✅ ships |
| Link | `[t](url)` | `url` (text-link) | ✅ ships |
| **Spoiler** | `\|\|s\|\|` | `spoiler` | ✅ ships — **live-confirmed** (supersedes the earlier UAT "soft" note, which was an MTProto-decoder limitation in the test harness, not a wire failure) |
| **Highlight** | `==h==` | `marked` | ✅ ships — live-confirmed |
| **Underline** | `__u__` | `bold` ❌ | **EXCLUDED** — Telegram's rich-message markdown parser reads `__…__` identically to `**…**`; there is no markdown token for underline on this path. `__u__` degrades to a clean **bold** entity (not broken markup), so no code change is needed, but underline is not a distinctly-supported construct. Documented in `reference/telegram-formatting-guide.md`. |
| 3-level nested list | tight `-`/indent | nested `list`/`paragraph` blocks, no injected blank lines | ✅ ships (tight-list spacing fixed, PR #2936) |
| Table | GFM pipe table | `table` with per-column `align` | ✅ ships |
| Blockquote | `> …` | `blockquote` | ✅ ships |

**Exclusion:** underline. Everything else in the palette renders as its intended
Telegram entity on the live wire.

---

## 7. Rollout

- **Ship dark.** Phase 2 lands behind a per-agent flag, default off. Merging the
  renderer changes no agent's behavior until an operator opts an agent in.
- **Staggered, one agent first.** Enable on a single canary agent, confirm live
  render quality (tables, expandable blocks, code) and no reply-latency
  regression, then roll out per-agent on the operator's cadence. No fleet-wide
  flip.
- **No streaming assumptions.** Rollout changes only which agents render rich;
  the whole-reply/chunked send model (§2) is unchanged.

**Rollout completed (2026-07-12).** After the §6a live-wire verification, the
canary/staggered rollout above ran its course and `SWITCHROOM_RICH_RENDER`
flipped to **ON by default** — an escape hatch, not an opt-in feature,
following the repo's default-on kill-switch convention (same shape as the
send gate's `SWITCHROOM_TELEGRAM_SEND_GATE`, #3153). `SWITCHROOM_RICH_RENDER=0`
(or `false`/`off`/`no`) per agent disables it without a rebuild. The
degrade-to-plain safety path (`renderSafe`) is unchanged and remains the
failure fallback.

---

## 8. Out of scope

- The Phase-2 renderer implementation itself (separate build agent, in
  parallel). This RFC is the contract, not the code.
- Any change to `rich-send.ts`, the `{ markdown }` wire format, or the send
  path — all already shipped and correct (#2669).
- Any streaming/incremental reply path — none exists and none is proposed.
</content>
</invoke>
