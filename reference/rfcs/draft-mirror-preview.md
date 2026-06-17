# RFC: Draft-stream mirror preview (model narration, ephemeral) + reply as commit

**Status:** Implemented — flag retired
**Author:** (agent, on behalf of operator)
**Date:** 2026-05-28
**Touches:** `telegram-plugin/gateway/gateway.ts`, `telegram-plugin/answer-stream.ts`, `telegram-plugin/tool-activity-summary.ts`, `telegram-plugin/session-tail.ts`

> **Update (2026-05-29):** shipped as the real-time activity feed (#1982,
> driven by the PreToolUse `tool_label` sidecar — see the PIVOT below).
> The feed is now the **unconditional default**: the
> `SWITCHROOM_DRAFT_MIRROR` env flag and its kill-switch (Phasing /
> Kill-switch sections below) have been **removed**, and the legacy
> verb-count activity-summary lane ("Ran 5 commands", Phase 4) is
> **deleted**. The feed clears on first reply (hand-off) and at turn_end
> (no-reply safety net); it rides an edited message, not the compose-area
> draft, so it no longer contends with the answer-stream for the draft
> slot. The phasing/kill-switch text below is retained as historical
> design record only.

## Problem

During a turn, the user wants to see what the agent is doing — in the
agent's own voice, as it happens. Today there are **two fragmented,
loosely-coordinated preview surfaces**:

1. **answer-stream** (`assistant.text` → a *visible real message*,
   default-on since v0.13.44) — streams the model's prose, then
   retracts when `reply` fires.
2. **activity-summary** (`tool_use` → "Ran 5 commands" draft) —
   framework-authored tool counting, cleared on first reply.

These can both be live at once (separate message IDs), and the
activity-summary is framework-authored progress chrome — the model's
machinery, not its voice. Extended-thinking turns also read as dead
air at the *message* level (only the 🤔 reaction reflects them).

## PIVOT (2026-05-28, after the canary): render the tool_use stream, not prose

The original design below proposed streaming the model's interstitial
`assistant.text` prose into the draft. **The flag-on canary on
test-harness falsified that premise.** On a normal tool turn the model
emits *no* interstitial prose — it goes `thinking` (redacted, no text)
→ `tool_use` → `reply`. Routing `assistant.text` to the draft just
produced an empty preview.

The real human-friendly signal — verified against a live session JSONL
(1360 Bash calls etc.) — lives in **`tool_use.input`, authored by the
model**:

| Tool | Field | Example |
|---|---|---|
| Bash | `input.description` | "List workspace" (never `ls -la`) |
| Read/Edit/Write | `input.file_path` (basename) | "Reading gateway.ts" |
| Grep/Glob | `input.pattern` | |
| Task/Agent | `input.description` | the sub-agent's task |
| WebFetch | `input.url` (hostname) | "Reading example.com" |
| hindsight | (label) | "Searching memory" |

This is exactly why Claude Code's own UI reads friendly: the Bash tool
*requires* a plain-English `description`, and Read/Edit/Write carry the
filename. There is never a raw `grep`/`jq`/`ls` to surface.

**Revised design intent:** render each `tool_use` as a human-friendly,
present-tense line via `describeToolUse` (`tool-activity-summary.ts`) —
model-authored description, then a domain label, then a humanized name;
never raw shell/query syntax — and stream the latest line into the
**ephemeral compose-area draft**, clearing on `reply`. **Option A:
uniform across code + non-code agents** — a health coach sees
"Searching memory" / "Checking your calendar"; a code agent sees
"Editing gateway.ts" / the model's Bash description. The `reply` tool
stays the canonical, formatted, pinged, persistent answer.

`assistant.text` keeps its existing visible-answer-stream home (it
rarely fires, but when the model *does* narrate, those are its own
words → fine as a visible message). The draft-mirror no longer touches
that lane.

---

## Original design intent (superseded by the PIVOT above)

Mirror the **model's narration** — its summaries / descriptions /
thinking-style commentary — into the **ephemeral compose-area draft**,
like Claude Code's running narration. **Not** tool-call labels. The
draft clears when the final `reply` lands. The `reply` tool stays the
canonical, formatted, pinged, persistent answer.

### Vision evolution, not a reversal of #1122

This is the next step on the same trajectory, not a walk-back. The
arc:

1. **Card era** — a persistent pinned status surface. Retired in
   #1122: it failed three ways — redundant (user saw the answer before
   the card refreshed), confusing (card landed *after* the final
   answer due to send ordering), empty (it was the safety net for a
   model that wouldn't talk).
2. **Chat-is-the-artifact era** — the model narrates in its own voice
   via real replies; the framework provides ambient (reaction) +
   safety net. Sanctioned by `reference/jobs/know-what-my-agent-is-doing.md`
   layer 2.
3. **Live-narration-preview era (this RFC)** — the model's voice,
   streamed *as it forms*, in an ephemeral surface that leaves no
   residue. This couldn't exist safely until the reply-guarantee
   (turn-pacing v4 + silent-end) was solid; now it can.

The #1122 lesson is *carried forward*, not contradicted. An
**ephemeral draft of the model's own prose** structurally avoids the
three failure modes that killed the card:

- Can't be redundant — it clears the instant `reply` lands.
- Largely escapes the ordering trap — but not perfectly. The card's
  failure was a *persistent visible message* landing after the answer.
  The draft-clear is best-effort fire-and-forget
  (`answer-stream.ts:~282,598`), so a late draft-edit *can* land after
  the reply cleared it. The residue is a **stale ephemeral draft**
  (auto-expires in 30s), not a stale visible chat message — strictly
  less harmful than the card's failure, but the race exists. Mitigate
  by sequencing the clear after the reply send and accepting the 30s
  expiry as the floor.
- Can't be empty — if the model emits no prose, no draft is shown
  (the card was *forced* to render something).

And it stays inside the contract: per
`feedback_chat_is_artifact_ux_not_implementation`, streaming the
model's *own words* (framework-transported, ephemeral) is sanctioned;
only framework-authored chrome that *lingers* was ever the
anti-pattern. The draft mirror is the former, never the latter.

## The three layers (target state)

| Layer | Mechanism | Change |
|---|---|---|
| 1. Ambient | reaction lifecycle (👀→🤔→✍→👍) | **unchanged** |
| 2. Preview | model prose → ephemeral draft, clears on reply | **repurpose** |
| 3. Commit | `reply` tool — format/ping/dedup/history/persist | **unchanged** |

## What changes

1. **Route interstitial `assistant.text` to the draft, not a visible
   message.** The answer-stream's transport moves to `sendMessageDraft`
   for the live preview. v0.13.44 routed it to a *visible real message*
   as a safety move — because at the time the ephemeral draft could
   strand an answer the model never committed. That safety is now
   provided structurally by the reply-guarantee + the backstop in (4),
   so the preview can return to its natural ephemeral home while the
   answer's durability is owned by `reply`. Safe *only* with (4).

2. **Remove the tool-call mirror.** The activity-summary lane
   ("Ran 5 commands") is dropped from the preview — the operator does
   not want tool-call machinery mirrored. `tool-activity-summary.ts`
   and `drainActivitySummary`/`clearActivitySummary` are retired (or
   gated off by default). Tool activity still shows ambiently via the
   ✍ reaction.

3. **Thinking → a bare "thinking…" draft line** only when a `thinking`
   event arrives with no accompanying text yet. Two reasons we can't
   mirror the actual thoughts: the parser emits a bare
   `{ kind: 'thinking' }` and never extracts the block's text
   (`session-tail.ts:219`), and extended-thinking content is typically
   unavailable in the on-disk JSONL anyway. So we surface the *state*,
   not the text — enough to keep extended-thinking turns from reading
   as dead air at the message level, in the model's-state voice rather
   than a tool log. (If we later want real thinking text, that's a
   session-tail parser change AND depends on the content actually being
   present — out of scope here.)

4. **Keep the no-reply backstop — which is turn-flush, NOT
   materialize() (corrected after design review).** If a turn ends
   with the answer only in the ephemeral draft and the model never
   called `reply`, the answer must still reach the user as a real
   message. The mechanism is **`decideTurnFlush` → the turn-flush path
   sending `turn.capturedText` as a fresh `sendMessage`**
   (`gateway.ts:~7669`), NOT `answer-stream.materialize()`. In
   draft-only mode `materialize()` is gated on `streamMsgId != null`
   (`gateway.ts:~7436`), which is never set on the draft path
   (`answer-stream.ts:287-306` never assigns `streamMsgId`) — so that
   branch takes `retract()` and turn-flush is the actual backstop.
   **Phase 1 MUST verify turn-flush fires on a draft-only no-reply
   turn** (test: model emits answer as text, NO_REPLY → user gets a
   real message). If for any reason we prefer materialize() to own
   this, that is NEW code (make materialize fire when
   `streamMsgId == null`), not "keep existing." **This backstop is what
   prevents re-opening the v0.13.44 19%-framework-fallback hole — and
   it covers answer *delivery* only, not liveness *perception* (see
   Risks).** Non-negotiable.

## What the reply tool keeps owning (preview must NOT replicate)

From the delivery-semantics audit — the preview is silent + ephemeral
and touches none of these:

- `finalAnswerDelivered` / silent-end Stop-hook guarantee
- `firstPingAt` one-ping-per-turn safety net (preview is silent)
- `outboundDedup` window (restart + cross-lane overlap)
- SQLite history `recordOutbound` + quote-reply lookup
- 👍 `endStatusReaction`, signal/silence-poke turn-state
- Telegraph long-text offload, file/album sends

The preview MAY reuse the pure render helpers (`markdownToHtml`,
`scrubVoice`, chunking) for visual parity — they're stateless.

## Non-goals

- **Per-token streaming.** Requires `claude --print
  --output-format=stream-json` — shelved on a permission-plumbing hard
  blocker (`docs/stream-json-daemon-mode.md` §11.2) **and** a
  `claude -p` policy violation (programmatic usage, off subscription,
  per CLAUDE.md). The on-disk JSONL is whole-message; ~1 edit/sec is
  the ceiling. Out of scope.
- **Mirroring tool calls / results.** Explicitly excluded by the
  operator — the model's voice, not its machinery.

## Phasing

- **Phase 1** — route narration to the draft, gated behind
  `SWITCHROOM_DRAFT_MIRROR=1` (env, default off). Leave activity-summary
  in place (flag-off path unchanged). **Verify the turn-flush backstop
  fires on a draft-only no-reply turn** (item 4). UAT: greeting (no
  draft), tool-driven turn (prose draft → clears on reply), no-reply
  turn (turn-flush promotes to a real message).
- **Phase 2** — thinking-state draft line.
- **Phase 3** — flip `SWITCHROOM_DRAFT_MIRROR` default on after fleet
  canary, a measured framework-fallback rate at/under the v0.13.44
  baseline (<0.5%), AND an explicit **liveness-perception check** (see
  Risks) — operator confirms the draft is actually visible on their
  client(s), not just that delivery held.
- **Phase 4** — retire the activity-summary tool-count lane, **only
  after Phase 3 default-on has stuck**. Reason (design review): if
  activity-summary is deleted while the mirror is still flag-gated and
  Phase 3's gate fails, the `SWITCHROOM_DRAFT_MIRROR=0` kill-switch
  could not restore it. Retire last, when there's nothing to fall back
  to.

## Kill switch

`SWITCHROOM_DRAFT_MIRROR=0` reverts to today's visible-answer-stream +
activity-summary behavior. Mirrors the existing
`SWITCHROOM_VISIBLE_ANSWER_STREAM` pattern. Valid only while Phase 4
hasn't run — once activity-summary is retired, the kill-switch reverts
to visible-answer-stream alone (still a safe state; the activity-summary
tool-count lane is gone for good by then).

## Test plan

- Unit: answer-stream draft-transport path, materialize-on-no-reply,
  thinking-line gating, activity-summary retirement.
- UAT (mtcute, live test-harness): greeting (no draft), multi-tool
  turn (prose draft visible then cleared by reply), no-reply turn
  (draft promoted), extended-thinking turn (thinking… line, no dead
  air), long answer (reply chunking intact).
- Metric gate: framework-fallback rate ≤ v0.13.44 baseline before
  Phase 4 default-on.

## Risks

- **Re-opening the 19% hole (delivery)** — mitigated by the turn-flush
  backstop (4) + turn-pacing v4. The framework-fallback metric gate in
  Phase 3 is the hard check. NOTE: this guarantees the *answer is
  delivered*, not that the *liveness is perceived* — see next.
- **Liveness invisibility (perception) — the real open risk.** v0.13.44
  moved narration to a *visible message* precisely because the
  compose-area draft wasn't surfacing on the operator's client; that
  invisibility was the perceived dead-air behind the 19%
  framework-fallback. This RFC moves narration *back* to the draft.
  The delivery backstop does NOT cover this — if the draft is invisible
  on a given client, the user sees nothing until the `reply` lands,
  i.e. the same gap v0.13.44 closed, minus the lost-answer part. This
  is acceptable ONLY if (a) the reply reliably lands fast (turn-pacing
  v4) so the dead-air window is short, and (b) the draft is actually
  visible on the operator's real clients. **Phase 3 gate adds an
  explicit perception check** (operator confirms the draft renders on
  their client[s]) separate from the delivery metric. If the draft is
  invisible in practice, this whole direction is wrong and we stay on
  visible-answer-stream — surface that early, don't push to default-on.
- **Operator-divergence during rollout** — same `apply`-regenerates-
  settings concern as any scaffold change; ship via the normal
  release + fleet roll, not hot-patch, for the default flip.
