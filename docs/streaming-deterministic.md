# Deterministic MCP-level streaming — design notes

> **⚠️ Historical research notes.** This document captures the H1–H5
> failure-mode analysis and the Opt-1…Opt-6 design space that informed the
> streaming work in early April 2026. The recommendation (Opt-1: deprecate
> `reply`, force `stream_reply`) was **not** taken in that form. Instead,
> `reply` and `stream_reply` are both still exposed, and the model is steered
> to `stream_reply` for any multi-tool turn via the per-agent CLAUDE.md
> ("`stream_reply` is the HARD DEFAULT for any turn that will use more than
> one tool call").
>
> Subsequent fixes (commits `5c398f7`, `2777b23`, `0796d68`, `c869f44`) hardened
> the actual streaming pipeline: chunk-split tag integrity for `tg-spoiler` /
> `tg-emoji` / attribute-bearing tags, PTY-suppression for `stream_reply`
> (eliminating duplicate-message + visibly-escaped-HTML symptoms),
> spinner-verb and TUI-hint suppression in the activity lane, and per-chat
> outbound ordering with parseMode rotation. Those changes are covered by
> regression tests in `telegram-plugin/tests/{telegram-format,stream-reply-handler,pty-tail}.test.ts`.
>
> Read this document for the *analysis* and the *option-space*, not as a
> roadmap. The Phase 0 metrics (`streaming-metrics.ts` + `streaming-report.ts`)
> are still gated by `CLERK_STREAMING_METRICS=1` and remain useful for ad-hoc
> investigation.

Status: research (April 2026). Architectural changes did not ship as
proposed; see header note above.
Companion instrumentation: `telegram-plugin/streaming-metrics.ts` +
`telegram-plugin/streaming-report.ts`. Gated by `CLERK_STREAMING_METRICS=1`.

The question we are trying to answer: **why does the user "rarely see streaming
happen" on Telegram, and what is the smallest change that makes streaming
model-independent?**

---

## 1. Current failure modes (H1–H5, re-validated from code)

### H1 — model rarely calls `stream_reply`, defaults to `reply`

**Confirmed.** The two tools are presented as peers in
`telegram-plugin/server.ts:840-898`. The `reply` description (line 842) is
short and unconditional. The `stream_reply` description (line 877) is a long
recipe that ends *"Use this instead of `reply` when you want to show
progressive updates"* — i.e. the model is told to use it only in a conditional
case that it gets to judge for itself.

Profile guidance at `profiles/default/CLAUDE.md.hbs:28-33` reinforces the
same conditional: *"For long tasks, prefer `mcp__clerk-telegram__stream_reply`
over `reply`… For short, single-shot answers, just use `reply`."* The model's
"long task" heuristic is noisy. In practice it calls `reply` for almost
everything unless the task visibly spans many tool calls.

Net effect: `stream_reply_called` / (`stream_reply_called` + `reply_called`)
in production is low. H1 evidence will show this directly.

### H2 — V1Extractor silently fails on TUI layout changes

**Confirmed — structurally fragile.** `pty-tail.ts:111-216` implements
`V1Extractor`: it scans from the bottom of an xterm buffer for the literal
substrings `clerk-telegram - reply` / `clerk-telegram - stream_reply`
(line 122-124), then hunts for a `text: "` literal (line 167), then
hand-walks JSON escapes until an unescaped `"` (lines 180-201). The
continuation-line heuristic is a column-count rule (`leadingSpaces < 4`,
line 158) which depends on Ink's rendering width and the terminal size
passed by `script -qfc`.

Every single one of these anchors is a private implementation detail of the
Claude Code TUI. There is no test harness that runs against a live TUI —
`pty-tail.test.ts` fixtures capture today's Ink output, not tomorrow's.
When Claude Code renames the tool label, changes indent, or swaps Ink for
another renderer, the extractor returns `null` silently and PTY-driven
previews just stop — no error surfaces to Telegram. H2 is not a *current*
bug; it is a *pending* bug waiting for an upstream UI change.

### H3 — `currentSessionChatId` null when PTY partial fires → buffer overwritten

**Confirmed but race is mitigated.** `server.ts:1746-1750` (pre-instrument
numbering — see file for current location): if `currentSessionChatId ==
null`, the partial is stashed in the single-slot variable `pendingPtyPartial`
at `server.ts:1735`. Multiple partials that arrive before the next
`enqueue` event each overwrite that slot, so only the *most recent* pre-
enqueue partial is flushed at `server.ts:1837-1841`.

Whether this matters depends on how often PTY output beats the session-
tail-derived `enqueue` event to `currentSessionChatId`. The
bufferedWithoutChatId metric in the new instrumentation directly measures
this. Prior diagnosis claimed this was a dominant failure mode; based on
the code path, it only loses *intermediate* frames, not the final text —
the last partial before enqueue always survives, and once the chatId is
set, subsequent partials stream normally. So H3 is real but lower-severity
than H1.

### H4 — `suppressPtyPreview` is turn-wide, kills PTY previews after first `reply`

**Confirmed, and deliberately so.** `server.ts:1113` sets
`suppressPtyPreview.add(replySKey)` at the very top of every `reply`
handler invocation. The comment at `server.ts:1229-1232` explicitly
documents this: *"do NOT delete suppressPtyPreview here. If we release the
lock between the reply completing and turn_end clearing state, the PTY
tail can sneak in another partial of the same text and create a duplicate
preview message. turn_end clears it instead."* The suppress set is only
drained at `server.ts:2082` inside `turn_end`.

Consequence: in a turn where the model calls `reply` followed by any
further work that extends the TUI buffer (e.g. a post-reply meta-summary,
or a second `reply` for chunks 2+), PTY partials get dropped for the rest
of that turn. The H4 count in the report tells us whether this is a common
shape.

### H5 — throttle asymmetry hides streaming on short replies

**Confirmed, and this is the main user-visible cause.** Draft stream
throttle is 600 ms (server.ts:1403, 1838), fired only after the first
update lands — `createDraftStream` at `draft-stream.ts:167-182` schedules
the *next* flush with `delay = max(0, throttleMs - sinceLast)`. If the
model emits the whole reply in one generation pass (sub-600-ms), the
extractor sees exactly one stable terminal state, emits one partial, the
preview renders once, and the canonical `reply` lands shortly after. Edit-
in-place swap from preview → final happens at `server.ts:1175-1179`.

To the user, a single message appears — no "streaming feel" — because the
text never actually changed between the preview and the final. Streaming
is only visible when generation takes noticeably longer than 600 ms *and*
the model is writing to a tool whose `text:` parameter grows over time (a
`reply` tool call in particular). Evidence: `draft_edit count per turn`
histogram — most turns should have 0 or 1 edits.

---

## 2. Why model-dependence is the root cause

The preview pipeline has two completely separate triggers:

1. **Model-driven:** the model calls `stream_reply(text, done=false)`
   repeatedly. This is the *designed* path — but the model only uses it
   when the tool description (`server.ts:877`) and the CLAUDE.md profile
   (`profiles/default/CLAUDE.md.hbs:28`) convince it to. Both leave the
   decision to the model's judgement of task length, which is noisy.

2. **PTY-extraction-driven:** the plugin tails the daemon's PTY log,
   re-renders into a headless xterm, scans for the reply-tool-call
   region, and streams the growing `text:` parameter. This path is
   model-independent *in principle* but chain-depends on upstream TUI
   rendering (H2), ordering vs session-tail enqueue (H3), and the
   suppression interplay with the model's choice to call `reply` (H4).

Both paths fail gracefully to "one shot message at turn end." The user's
experience of "rarely see streaming" is the cumulative product of: the
model picking `reply`, the model generating in <600ms, the PTY extractor
fragility, and the turn-wide suppression. Any fix that leaves the choice
in the model's hands inherits those failure modes.

**The root cause is not a bug. It is that the streaming contract has no
single, authoritative source of truth.** The deterministic solutions below
all reduce to: *"pick one source, make it unconditional, and delete the
other paths (or demote them to fallbacks)."*

---

## 3. Options for deterministic streaming

### Opt-1 — Deprecate `reply`, force `stream_reply`

**Mechanism.** Remove the `reply` tool from the MCP tool list. Rename
`stream_reply` to `reply` with the same external behavior (first call
sends, subsequent calls edit, `done=true` locks). If the model forgets
`done=true`, the plugin auto-finalizes on `turn_end`.

- **Model-independence:** 8/10. The model still has to pass `text`, but
  there is no alternative tool to get wrong.
- **Plugin LOC:** ~50 lines (delete `reply` switch case, rename,
  auto-finalize in turn_end).
- **UX change:** None for users. Model output unchanged semantically —
  still one message per turn, still edit-in-place.
- **Claude Code friendliness:** High. Pure MCP surface change.
- **Failure modes:** The model still has to call the tool at all. Turns
  that end *without* a reply tool call already hit the orphaned-reply
  backstop (`server.ts:1968+`). Tool count shrinks by one, reducing
  schema ambiguity — a small positive.

### Opt-2 — Proactive PTY-driven preview every turn

**Mechanism.** Lean harder on the PTY tail. Every turn, unconditionally
open a draft-stream preview as soon as the model starts emitting *any*
`reply` / `stream_reply` tool-call prefix in the TUI — before the tool
actually fires. Let the model's subsequent `reply` call edit-in-place
over the live preview (already implemented at `server.ts:1170-1199`).

- **Model-independence:** 9/10 — once the TUI renders the tool call,
  streaming is inevitable regardless of which tool name the model picked.
- **Plugin LOC:** ~0–20 lines (path already works; just keeps the door
  open longer / removes some suppression guards).
- **UX change:** None.
- **Claude Code friendliness:** Medium. Doubles down on V1Extractor
  fragility (H2). The moment Claude Code changes its Ink renderer, all
  streaming breaks.
- **Failure modes:** H2 upstream-UI breakage, H4 turn-wide suppression
  requires redesign (not a trivial widening).

### Opt-3 — Intercept `reply` in plugin, re-route through DraftStream

**Mechanism.** Keep `reply` in the tool list, but internally the handler
always goes through `createDraftStream`: send a placeholder
`"…working…"` immediately, then edit with the full text. For a short
reply the user sees placeholder → full in ~1 edit cycle (< 1 s); for a
long reply the handler can chunk in stages.

- **Model-independence:** 10/10 for the streaming-visual-cue dimension
  (something always appears within the throttle window). The actual
  *content* still arrives only at `reply` call time.
- **Plugin LOC:** ~80 lines (new handler path; removes the preview-
  edit-in-place branch since there is no preview to reconcile with).
- **UX change:** Users see a transient placeholder message on every
  turn before the real content. Small positive: feels responsive.
- **Claude Code friendliness:** High. No dependency on TUI internals.
- **Failure modes:** Doesn't solve "show me what's happening *during*
  generation" — it just fakes the first frame. Compatible with keeping
  Opt-2 as an additional inside-generation stream source.

### Opt-4 — Session-tail-JSONL-driven streaming

**Mechanism.** Claude Code writes the full assistant message to the
session JSONL once per turn (no intra-turn deltas — confirmed by
`session-tail.ts` events and `server.ts:1886-1943` handling). That path
is *not* streamable. Claude Code 2.x, however, does stream to the JSONL
in some configurations (tool_use blocks appear incrementally). If we
watch for incremental `text` content-block growth, we could drive
previews from the JSONL instead of the PTY buffer.

- **Model-independence:** 7/10 — still model-dependent on whether the
  assistant emits a top-level text block vs calling `reply` directly
  (different shapes in JSONL).
- **Plugin LOC:** ~150 lines (re-architect `session-tail.ts` to watch
  partial lines, assemble streaming text blocks).
- **UX change:** None.
- **Claude Code friendliness:** Medium. JSONL schema is less volatile
  than Ink rendering, but it's still not a promised stable interface.
- **Failure modes:** Claude Code writes JSONL lines whole, not
  progressively. Verified by inspection — so this option likely needs
  Anthropic-side changes to be viable.

### Opt-5 — Append-system-prompt enforcement

**Mechanism.** Inject system-prompt text that commands the model to
always call `stream_reply` with progressive updates.

- **Model-independence:** 3/10 — models drift from system directives
  over time and across models.
- **Plugin LOC:** ~5 lines.
- **Rejected.** Hard-coded prompt engineering for a structural problem
  is exactly the failure mode we're trying to leave behind.

### Opt-6 — Decoupled status indicator (separate from the canonical reply)

**Mechanism.** Send a *separate* status message per turn ("🤔 thinking"
→ "🔥 calling tool X" → "💬 writing reply"), driven entirely by session-
tail events. The canonical reply is unchanged. This is partially
implemented already (`status-reactions.ts`) as an emoji reaction on the
user's own message — Opt-6 promotes it to a full text message.

- **Model-independence:** 10/10.
- **Plugin LOC:** ~100 lines.
- **UX change:** Chat feels chattier — two messages per turn. Users may
  dislike clutter. Can be gated by config.
- **Claude Code friendliness:** High.
- **Failure modes:** Adds message noise. Doesn't actually stream the
  reply text; only the *metadata* about what's happening.

---

## 4. Recommendation

**Ship Opt-1 first, then stack Opt-3 as a follow-up.**

- Opt-1 is the smallest, safest, most reversible change that eliminates
  the dominant failure mode (H1: model picks wrong tool). It also shrinks
  the MCP surface area — fewer tools, less schema ambiguity for the model
  on every single turn. The tool list should present one canonical
  reply-text tool.
- Opt-3 layered on top of Opt-1 gives every turn a guaranteed first
  frame (the placeholder) and removes the 600-ms threshold below which
  streaming is invisible (H5). Together they make streaming feel like
  it's always happening, which is the actual user goal.
- Keep the PTY tail (Opt-2 path) as a *fallback* for intra-generation
  deltas but stop relying on it as the primary mechanism. When (not if)
  V1Extractor breaks, streaming degrades to Opt-1+Opt-3 behavior, which
  is still better than current.

**Single riskiest assumption.** That renaming `stream_reply` → `reply`
does not regress any existing model behavior around expectation of
send-once semantics. Specifically: models trained on tool-use patterns
may assume `reply(text, done=true)` is idempotent (call it once per
turn), and may forget to pass `done=true` on the final call causing the
turn to end without the message being finalized. The `turn_end` auto-
finalize is the escape hatch — but it adds a ~100 ms tail that the
previous `reply` path didn't have.

---

## 5. Migration / rollout

**Phase 0 — instrumentation (this branch).**
Ship `streaming-metrics.ts` + `streaming-report.ts`. Set
`CLERK_STREAMING_METRICS=1` on one production agent for 48 h. Baseline
metrics required before any architectural change:
- H1 ratio: `stream_reply_called / (stream_reply_called + reply_called)`
  per turn. Expected < 0.1.
- H3 count: `pty_partial_received` with `bufferedWithoutChatId=true`
  per turn. Expected > 0 occasionally.
- H4 count: `pty_partial_received` with `suppressed=true` after first
  `reply_called` in turn. Expected > 0 on turns with post-reply work.
- H5 evidence: `draft_edit` count per turn histogram. Expected mode = 0
  or 1.

**Phase 1 — Opt-1.**
Feature flag: `CLERK_STREAMING_V2=1`. When set, remove `reply` from the
tool list and rename `stream_reply` → `reply`. Leave the old `reply`
handler code live but unreachable. Auto-finalize on `turn_end` when the
model forgets `done=true`.

Definition of done for Phase 1:
- 48 h production run with flag on.
- `draft_edit` count per turn histogram mode ≥ 1 (up from 0/1).
- Zero regressions in orphaned-reply backstop rate
  (`server.ts:1968+`) — if this rises, the auto-finalize is under-
  firing.

**Phase 2 — Opt-3.**
Behind same flag. Reply handler always sends placeholder before the
real text. Definition of done:
- Mean `first pty_partial → turn_end` latency no worse than Phase 1.
- User-reported "streaming feel" qualitative check.

**Phase 3 — cleanup.**
Delete the old `reply` code path. Remove the PTY tail's primary role
(leave it as a debug/fallback source gated by its own flag).

**Rollback.** Unset `CLERK_STREAMING_V2`. Old code path is still live
through Phase 2. No data migration required.

## Coverage

Phase 1 coverage audit (v8 provider, `vitest run --coverage`). Command:

```
npx vitest run --coverage \
  --coverage.include='src/agents/handoff-summarizer.ts' \
  --coverage.include='telegram-plugin/handoff-continuity.ts' \
  --coverage.include='telegram-plugin/steering.ts' \
  --coverage.include='telegram-plugin/streaming-metrics.ts' \
  --coverage.include='telegram-plugin/context-exhaustion.ts' \
  --exclude='**/pty-tail.test.ts' --exclude='**/merge.test.ts'
```

| Module | % Lines | % Branch | Uncovered critical paths |
|---|---|---|---|
| `telegram-plugin/context-exhaustion.ts` | 100.0 | 100.0 | — |
| `telegram-plugin/steering.ts` | 100.0 | 100.0 | — |
| `telegram-plugin/handoff-continuity.ts` | 95.45 | 93.54 | catch branch of `readFileSync` (lines 39-40) and of `unlinkSync` race (line 62) — both defensive, require injected fs failure to exercise |
| `telegram-plugin/streaming-metrics.ts` | 82.35 | 85.71 | lines 91-93: `performance.now` fallback to `process.hrtime`. UNCOVERED: would require deleting `globalThis.performance` at test time; fallback is pure defensive code for non-Node/Bun hosts. Not exercised in CI. |
| `src/agents/handoff-summarizer.ts` | 84.44 | 77.65 | lines 373-374, 389-390: stdin streaming fallback for when the Anthropic client is not injected, plus the top-level `main()` wrapper. UNCOVERED: exercised manually via the `clerk handoff` CLI end-to-end during session-handoff development. |

All five modules meet or exceed the 80% line-coverage bar. Remaining
gaps are defensive fallbacks and the top-level CLI entrypoint —
cheaper to manually exercise than to mock out.

