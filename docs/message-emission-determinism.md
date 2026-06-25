# Deterministic message emission — design notes

> **Status: research / design (2026-06-25).** Ground-truth map of every way
> the switchroom telegram-plugin emits a message to a chat, why message
> appearance / ordering / notification are currently heuristic rather than
> deterministic, and a proposed direction toward a single emission authority.
> **No code change ships with this document.**
>
> **Validation status (closed):** the file:line citations and predicates below
> were gathered by a five-way code investigation against `origin/main`
> @ `fd1e89c` (post-#2553 `544c0c9d`; current HEAD `f734c580` / #2554 is a
> compose-memory change that does not touch `telegram-plugin/` —
> `git diff --stat fd1e89c f734c580 -- telegram-plugin/` is empty, so citations
> hold). All **12 load-bearing claims were independently fact-validated against
> the code and HOLD** (zero wrong; the genuinely-runtime items are fenced in §10
> as needing runtime confirmation, not asserted as static fact). The design was
> then **adversarially reviewed**; §9 and §10 were reworked in response — see the
> §9 preamble on the `finalAnswerDelivered` flag split, which is the single most
> important correction.
>
> Companion / prior art: `docs/streaming-deterministic.md` (the `reply` vs
> `stream_reply` analysis), `reference/rfcs/conversational-pacing.md` (the
> current pacing design), `docs/status-ask-cause-classes.md` (the retired
> silence-poke ladder). Related shipped fix: **#2141** (`feed-reopen-gate.ts`,
> keep the activity feed alive when an ack-first turn keeps working) — load
> bearing for §9.

---

## 1. The problem: "deterministic UX control of switchroom agents"

A user sends one message. In the worst case the framework can emit **a dozen
or more** outbound surfaces in response — an early reaction, an evolving
activity card, a worker feed, silent anchors, the final reply, a terminal
reaction, plus any cross-turn card or notice that thresholds that turn. The
**agent explicitly asks for almost none of them.**

The concrete user-visible failures that motivated this note:

1. **Triplication.** One conversational message produced three near-identical
   bubbles: a `🤖 Agent · done · 0 tools` activity card echoing the agent's
   narration, the actual reply, and a *second* activity card. A purely
   conversational, zero-tool turn should not produce an activity card at all.
2. **"Reply isn't always last."** Sometimes a status / thinking card lands on
   screen *below* the final reply. The desired invariant — correctly scoped in
   §6/§9 — is: **within a single foreground turn, no activity-card surface
   opens after that turn's final reply.**

Both are symptoms of one root cause: **there is no single authority that
decides what reaches the chat.** Emission is spread across ~100 call sites
governed by ~8 independent dedup / cooldown / threshold guards. Each guard is
locally reasonable; together they produce globally non-deterministic UX.

---

## 2. The emission model today

### 2.1 Scale and split

~100 `sendMessage` / `editMessageText` / `setMessageReaction` sites, ~95 in
`telegram-plugin/gateway/gateway.ts`, the rest in standalone renderer modules
the gateway wires (`stream-controller.ts`, `worker-activity-feed.ts`,
`issues-card.ts`, `slot-banner-driver.ts`, `boot-card.ts`, `auth-code-redact.ts`).

The load-bearing distinction for "deterministic control" is
**agent-invoked vs framework-auto-fired**:

- **Agent-invoked** (explicit tool/command intent — directly controllable):
  `reply`, `stream_reply`, `edit_message`, `react`, `progress_update`,
  `ask_user`, the three vault cards, permission cards (via a gated tool call),
  operator slash-command acks, operator button-callback edits.
- **Framework-auto-fired** (no agent tool-intent — fires on its own): *the
  bulk* — boot card, issues card, slot banner, worker-activity feed, the
  activity summary, the answer/stream lane, all status reactions except the
  `react` tool, idle-clear, proactive-compact, silence-poke heartbeats,
  obligation / silent-end re-delivery, the turn-flush backstop, the four DM
  watchers (fleet / credits / quota), the operator-event / error-envelope
  family, pairing, queued-status, cron `send_outbound`, restart-queued,
  auth-code-redact, config-finalize edits.

**The dominant message volume — and crucially the notification decision and
the duplicate-prevention — is framework-owned and threshold/race-driven.** Note
that several of these surfaces are **cross-turn** (obligation represent, the
four watchers, idle-clear, error envelopes) — they have no turn to attach to.
This matters for §9.

### 2.2 Worst-case fan-out (one inbound → N outbound)

Bounded in practice by eight independent guards: the reaction
debounce/coalesce (3.5 s, single-instance-per-key), the over-ping
one-ping-per-turn slot (`over-ping-safety-net.ts`), `progress_update`'s 5/turn
cap, the single-flight `activityInFlight`, the #546/#646 outbound-dedup
windows, the silent-reply anchor merge, and per-source cooldown latches. A
*normal* multi-step turn realistically yields: 1 early reaction + 1 evolving
stream/activity message (edited in place) + 1–2 silent anchor bubbles + 1
pinged final + 1 terminal reaction. Absent the guards the worst case is
unbounded — i.e. determinism is currently an *emergent property of eight
separate guards*, not a designed invariant.

---

## 3. The activity-card lifecycle (state machine)

All cites `telegram-plugin/gateway/gateway.ts` unless noted.

**Per-turn state**, reset every turn (`:10548-10555`): `activityMessageId`
(card msg id; `null` = not yet sent), `activityPendingRender` /
`activityLastSentRender` (the dedup pair), `activityEverOpened` (sticky),
`mirrorLines` (step lines), `pendingNarrative` (one-step lookahead). **The card
is keyed per-turn, never per-chat.**

- **OPEN** — first `sendMessage`, only when `activityMessageId == null`
  (`drainActivitySummary`, `:10292-10303`). The drain runs whenever
  `activityPendingRender !== activityLastSentRender` (`:10274`). Three
  producers can trigger it: **(A) narrative SHOW** (`showNarrativeStep`,
  `:10195-10202`) — text alone, **no tool and no time threshold**; **(B) tool
  label** (`:10861-10863`); **(C) liveness timer** (`feedHeartbeatTick`,
  `:10360-10373`) — only after `mirrorLines` empty AND age ≥
  `FEED_LIVENESS_OPEN_MS` (12 000 ms, `:1728`), and gated off once
  `finalAnswerDelivered` (`:10350`). **The single `sendMessage` lives in
  `drainActivitySummary`; producers B and C reach an OPEN *through* it.**
- **RENDER/EDIT** — once open, `editMessageText` in place (`:10305-10309`),
  driven by new tool labels, narrative SHOWs, and the 6 s heartbeat
  (`FEED_HEARTBEAT_TICK_MS`, `:1715`). No-op edits suppressed by the
  `pending !== lastSent` guard plus swallowing "message is not modified"
  (`:10314`).
- **CLOSE** — `clearActivitySummary` (`:10418`). Default
  (`CLEAR_STATUS_ON_COMPLETION=false`) **edits the card in place** to a
  terminal `done` render (`:10455`) or deletes (`:10429`) — never sends a new
  message. Called at first-reply handoff (`:10742`, gated on
  `finalAnswerDelivered`) and idempotently at `turn_end` (`:11208`).

**Two cards, not one edited card:** because the card is per-turn keyed and
`activityMessageId` resets to `null` each turn (`:10548`). A second logical
turn (e.g. the Stop-hook re-prompt) starts fresh and its first SHOW fires a
**new** `sendMessage` (`:10292`) — a second card message, not an edit of the
first. There is no cross-turn message-identity reuse.

**The 0-tool determinism gap:** there is **no guard that suppresses the
activity card on a conversational turn with zero tool calls.** The
narrative-SHOW open path (A) has no tool-count and no elapsed check; the
liveness timer (C) *widens* 0-tool card creation rather than restricting it
(it exists precisely to open cards on no-tool "pure thinking" turns,
`:1718-1722`). Kill switches exist for the timer
(`SWITCHROOM_FEED_LIVENESS_OPEN=0`), heartbeat (`SWITCHROOM_FEED_HEARTBEAT=0`),
and reopen (`SWITCHROOM_FEED_REOPEN_AFTER_ACK=0`) — but **none gate path (A)**,
the one that produced the triplication.

---

## 4. The narration → feed pipeline

How plain assistant text (written *outside* any tool call) becomes a `✓ …`
step inside the activity card. (Module note: `session-tail.ts`,
`narrative-dedup.ts`, `final-answer-detect.ts`, `tool-activity-summary.ts` live
at `telegram-plugin/<name>`; `feed-reopen-gate.ts` / `represent-guard.ts` are
under `telegram-plugin/gateway/`.)

1. **JSONL text block → `text` event.** `session-tail.ts` tails the per-session
   JSONL; `projectAssistantTextBlocks` emits one event per `text` block,
   dropping only `text.trim().length === 0` (`session-tail.ts:236`). **There is
   no shape predicate distinguishing "working narration" from "final answer."**
2. **`text` event → staged narrative.** `case 'text'`
   (`gateway.ts:10868-10901`) → `stagePendingNarrative(turn, ev.text)`
   (`:10901`), a one-step lookahead held in `turn.pendingNarrative`.
3. **Resolve.** Exactly one of: `resolvePendingNarrativeOnTool` (`:10212-10227`)
   — SUPPRESS only if the next tool is reply/stream_reply AND
   `isDraftOfReply(pending, text)`; `flushPendingNarrativeAtTurnEnd`
   (`:10247-10253`) — the trailing-block case; or a subsequent stage flushing
   the prior block as SHOWN.
4. **SHOW → feed step.** `showNarrativeStep` (`:10195-10203`) clips via
   `clipNarrative` (first line, ≤120 chars, `tool-activity-summary.ts:228-233`)
   and `appendActivityLabel`s onto `mirrorLines` — the same path a tool label
   takes.

**Narration is deduped against reply text**, but only via similarity:
`isDraftOfReply` (`narrative-dedup.ts:64/67`) is true at longest-common-**prefix**
ratio ≥ `DRAFT_SUPPRESS_THRESHOLD = 0.8` (not Levenshtein, not substring). So
narrate-"X"-then-reply-"X" suppresses the duplicate. **But** the guard at
`flushPendingNarrativeAtTurnEnd` (`:10251`) requires `lastReplyText.length > 0`;
when the agent **never calls reply**, `lastReplyText === ""`, the precondition
fails, the guard is skipped, and the trailing final-answer prose is
**unconditionally shown as a feed step**. Thinking blocks are clean — they
become `{kind:'thinking'}` (`session-tail.ts:290`), never a `text` event.

**Conclusion:** trailing final-answer narration is **not structurally
distinguishable** from genuine progress narration; the only suppression
compares against an outgoing reply that, by definition, does not exist when the
answer was written as prose instead of sent via the reply tool. (This
undecidability is why §9 reframes the "0-tool / trailing-prose" lever.)

---

## 5. Reply delivery, the backstop, and represent

- **Reply path.** `reply` → `executeReply` (`:7547-8405`); `stream_reply` →
  `executeStreamReply` (`:8406`). Thread resolved by origin precedence
  (`:7762-7790`). Outbound recorded via `recordOutbound` (`:8295`), the only
  writer of `role='assistant'` history rows (progress-card edits excluded,
  `:1487`). On a final answer: `finalAnswerDelivered=true` (`:8348`/`:8730`),
  terminal reaction released, obligation closed (`:8362`).
- **The Stop-hook backstop RE-PROMPTS, never flushes.**
  `hooks/silent-end-interrupt-stop.mjs` scans the current turn's JSONL for a
  qualifying reply; if none, it exits `{decision:"block", reason:"…send your
  final answer now…"}` (`:191`) — re-prompting the *same* turn. It has **no
  `sendMessage`** and never materializes the agent's prose. Budget
  `MAX_RETRIES=2` (`:66`); after exhaustion the gateway sends a **fixed
  generic** `SILENT_END_FALLBACK_TEXT` (`gateway.ts:187`, sent `:11870`), never
  the agent's prose. **The turn-pacing warning that a "backstop flushes unsent
  text after a delay" is false for content on current main** (fact-validated) —
  the only framework-originated message is that canned fallback, and only after
  re-prompt exhaustion, so it cannot race ahead of the model's own reply.
- **The `obligation_represent` duplicate bug is FIXED on main** (fact-validated
  via `git merge-base --is-ancestor`, both commits return 0). The
  satisfied-check `shouldSuppressRepresent` (`represent-guard.ts:63-71`, wired
  `:5978`) suppresses a re-fire iff a real `recordOutbound` row landed since
  `lastRepresentedAt`. `tests/represent-guard.test.ts:27-36` pins the exact
  10605→10608→dup-10609 case as suppressed.
- **Residual duplicate vectors** (narrow): (a) a crash between reply-sent and
  obligation-close, where a restart's hydrate + sweep re-presents an
  answered-but-unclosed obligation **once** (the represent-guard only protects
  the 2nd+ represent); (b) the *intended* cross-turn dedup carve-out for
  genuinely repeated answers in different turns.

---

## 6. Ordering & "reply is last"

On-screen order = **send order / message_id**; an edit never reorders. So
"status below reply" can only mean a **new `sendMessage`** with a higher
message_id than the reply. The activity card is one message edited in place;
`clearActivitySummary` is edit/delete-only. The single activity `sendMessage`
lives in `drainActivitySummary` (`:10292`), reachable from any of the three
producers (§3). **The reorder risk is exclusively a card OPEN firing after the
reply send.**

In `executeReply` the reply chunks are sent first (`:8113/8123/8135/8275`),
then `finalAnswerDelivered=true` (`:8348`); `clearActivitySummary` is **not**
called inside `executeReply` (`:7547-8405`) — it trails on the `tool_use` event
(`:10742`). Between "reply sent" and "card cleared," any code that drains while
`activityMessageId == null` opens a fresh card **below** the reply.

**Enumerated post-reply reorder races:**

| # | Path | file:line | New msg (reorders) vs edit |
|---|------|-----------|----------------------------|
| A | Feed-reopen-after-ack: a tool_label after a **short pinging** final classified as an ack → `decideFeedReopen` resets `activityMessageId=null` **and `finalAnswerDelivered=false`** → next drain opens below | `:10814-10833`, `feed-reopen-gate.ts:150-162` (reset `:157`) | **NEW → reorders** |
| B | Liveness-open heartbeat after reopen (A) cleared `finalAnswerDelivered` | `:10350-10373` | **NEW → reorders** (only reachable once A reset the flag) |
| C | Second turn (Stop-hook backstop): a no-qualifying-reply turn → re-prompt → new turn whose fresh card opens below the prior reply | hook `:34-49,110-169`; `:10884`, `:11481` | **NEW → reorders** |
| D | `obligation_represent` re-delivery of a stale unanswered obligation (cross-turn) | `:5960-6004`, guards `:5961/:6018` | **NEW → reorders** (guarded) |
| E | Trailing narrative flush (`showNarrativeStep`), **not gated on `finalAnswerDelivered`** | `:10195-10202`, `:10901`, `:11199` | edit if id still set; **NEW if already cleared** |
| F | turn_end finalize | `:11208` | edit/delete only — never reorders |

**Existing guarantee is partial and edit-only.** The substantive-vs-ack split
(`final-answer-detect.ts:113-117`, `FINAL_ANSWER_MIN_CHARS=200`, `:47`) drops
post-answer tool labels for a **substantive** final (`done:true` OR ≥200
chars) → reply stays last. **The named residual** (`:106-111`): a final that is
**both short (<200) AND pinging** is indistinguishable from an ack → it
**reopens** the feed below itself (race A). That is the deterministic source of
"reply, then a status card after it."

**Scoping the invariant (corrected after adversarial review).** "Reply is last"
is **not** correct as an absolute — legitimate surfaces *should* land after a
reply: a background **worker-completion** card, a cross-turn
**obligation_represent** nudge, an **error envelope** or **quota watcher**. The
enforceable, correct invariant is: **within a single foreground turn, no
activity-card / answer-lane surface opens after that turn's final reply.**
Background and cross-turn surfaces are explicitly out of scope.

**Agent vs framework control:** calling `reply` last does **not** guarantee
last-on-screen. Of the six races only E (and the agent's own tool ordering) is
agent-influenced; A, B, C, D are framework auto-emissions / synthesized turns
the model cannot see or sequence. **The scoped invariant must be a
framework-guaranteed property, not an agent behaviour.**

---

## 7. Determinism gaps — consolidated catalog

| # | Gap | Where | Effect |
|---|-----|-------|--------|
| G1 | Activity card opens on **text alone**, no tool-count / conversational guard | `:10195-10202`, `:10292` | 0-tool turns get a full card (triplication) |
| G2 | Trailing final-answer prose **indistinguishable** from progress narration; suppression only vs an outgoing reply that doesn't exist | `:10251`, `session-tail.ts:236` | Final answer leaks as a `✓` feed step when written as prose |
| G3 | Card is **per-turn keyed**; a second turn (backstop) opens a new card, no cross-turn identity reuse | `:10548`, `:10292` | Two cards across one logical exchange |
| G4 | **No sticky "final delivered" latch** for ordering; the open path can fire post-reply, and the only existing flag (`finalAnswerDelivered`) is **cleared by reopen** mid-turn | races A/B/E, §6; `feed-reopen-gate.ts:157` | Status lands below the reply; ordering gates get no-op'd |
| G5 | The "reply last" guarantee covers only **substantive** finals; short-pinging finals reopen the feed | `final-answer-detect.ts:106-111` | Terse replies get a card after them |
| G6 | Determinism is an **emergent property of ~8 independent guards**, not one authority; notification (over-ping downgrade) and dedup are framework-owned and threshold/race-driven | §2.2 | No single place to reason about or enforce UX |

---

## 8. The two observed symptoms, root-caused

- **Triplication** = G1 + G2 + G3. Conversational turn, no tools; the agent
  wrote a final answer as prose (no reply tool), so it leaked as a card step
  (G2) on the text-alone open path (G1); the Stop-hook re-prompt created a
  second turn → a second card (G3); plus the eventual real reply. Three
  bubbles.
- **Reply-not-last** = G4 + G5. A short pinging final reopened the feed below
  itself (G5) because no sticky latch blocks a post-final card open and the
  mutable flag was cleared by reopen (G4).

Note both are **trigger/lifecycle** problems, independent of the #2553 render
unification (which changed only *how* a card renders, not *when* it emits).

---

## 9. Proposed direction (design, not yet built)

> **Adversarial-review correction — read first.** `finalAnswerDelivered` is
> **not** a stable "turn is done" signal: the ack-reopen path deliberately
> **resets it to false mid-turn** (`feed-reopen-gate.ts:157`, applied
> `gateway.ts:10833`) so an "On it…" ack can keep a live feed (shipped fix
> #2141). Any ordering gate keyed on `finalAnswerDelivered` is therefore a
> **no-op on exactly the ack-first turn** where the reorder originates.
> **Precondition for every lever below:** introduce a **sticky
> `finalAnswerEverDelivered` latch** (set once a *substantive* final is sent,
> never cleared by reopen — mirroring `activityEverOpened` at `:10553`),
> distinct from the existing mutable `finalAnswerDelivered` that reopen toggles
> for feed-liveness. Ordering keys on the sticky latch; feed-liveness keeps the
> mutable flag.

With that split in place, the deterministic levers:

1. **Hard "no card OPEN after substantive final" gate** — in the
   `drainActivitySummary` open branch (`:10292`) and the liveness path
   (`:10360`), refuse a `sendMessage` (allow only edits of an existing id) once
   **`finalAnswerEverDelivered`** (the sticky latch, *not* the mutable flag).
   Closes G1's post-reply case and races A/B/E for substantive finals.
2. **Finalize/close the card before the reply send — but only for a
   *substantive* final** (`isSubstantiveFinalReply`, `final-answer-detect.ts:113`).
   Move a finalize into `executeReply` ahead of the chunk send so the card gets
   a lower message_id. For **acks, do nothing** (let reopen own the card) —
   finalizing an ack early would close → reopen → emit *more* messages, the
   opposite of the goal.
3. **~~Treat any reply-tool call as final-delivered for open-suppression.~~
   DROPPED.** This reverts shipped fix #2141 — it reintroduces the visible
   silence of an ack-then-work turn (reply "On it, checking…" then go quiet for
   all post-ack tool work). Solve G5 instead via lever 2's ordering (when a
   reopened feed *finalizes*, route the finalize to land below the reply),
   keeping reopen intact.
4. **Suppress the second-turn card-open** when a substantive outbound already
   landed this exchange (races C/D) — kills cross-turn "card below an earlier
   reply." Keys on the sticky latch + the represent-guard's existing
   delivered-since check.
5. **A conversational-0-tool guard for G1's base case** — do not OPEN a card
   for a turn with zero tool calls unless the liveness timer's genuine
   thinking-gap condition is met. **Do *not* attempt to "never SHOW trailing
   final-answer prose" (G2):** that distinction is **undecidable at emission
   time** (§4 — the only signal is similarity to a reply that doesn't exist in
   the forgot-the-tool case). The correct fix for the leak is to make the
   **silent-end re-prompt reliable** (it already owns the forgot-the-tool case,
   `final-answer-detect.ts`), not to guess at the feed layer.

**The deeper architectural move** (beyond point fixes) is consolidating the
guards into one **emission authority / sequencer** — but it must be
**per-chat, foreground-lane-scoped**, *not* per-turn. Cross-turn surfaces
(`obligation_represent` keyed on `originTurnId` and fired from
`obligationSweep`; the free-running heartbeat `setInterval` at `:10389`;
idle-clear; the four watchers; error envelopes) have **no turn to post to** —
a per-turn sequencer would leave them out-of-band and the "single authority"
claim would be false. A per-chat authority must enumerate which cross-turn
surfaces post *intents* to it (represent, watchers, error envelopes) vs which
stay out-of-band, and must serialize against the `chat-lock` and the
deliver-before-drain gate (#2137) without deadlocking. The point fixes are the
incremental path; the authority is the durable target.

---

## 10. Risks & assumptions

> **R0 (central — from adversarial review): `finalAnswerDelivered` is mutable.**
> Reopen clears it mid-turn (`feed-reopen-gate.ts:157`). Three of the §9 levers
> key their correctness on it and **partially cancel** until the sticky-latch
> split (§9 preamble) lands. This split is a *precondition*, not an option.

- **R1 — closing the card before the reply may lose in-progress detail** if a
  turn does useful work after a *mid-turn* reply. Mitigated by gating lever 2 on
  `isSubstantiveFinalReply` (acks don't finalize), but confirm
  `isFinalAnswerReply` never fires mid-turn with more work to come.
- **R2 — the "no OPEN after final" gate could hide legitimate post-answer
  activity** (a long cleanup tool the user should see). Decide: is silent
  post-substantive-answer work acceptable, or does it need its own surface?
- **R3 — DROPPED lever 3 was the right call** (it reverted #2141). The residual:
  G5 (short-ping reopen) is now solved only by lever 2's ordering, which must
  actually land the reopened-feed finalize below the reply — verify that path.
- **R4 — the conversational-0-tool guard (lever 5) must not suppress a card on
  a turn that *starts* conversational then dispatches tools.** Ordering of the
  first tool vs the guard check.
- **R5 — the represent restart residual (§5a) is real but unquantified.** How
  reachable is the crash-between-send-and-close window in practice? Runtime,
  not static.
- **R6 — a per-chat emission authority is a large refactor** touching ~100
  sites and 8 guards with hard-won correctness (#546 dedup, over-ping, 429
  cooldown). The real blocker is the **per-turn-vs-cross-turn scoping**
  (§9) — name it before scoping the work.
- **R7 — every file:line here is from a code read, not a runtime trace.**
  Behaviour under real concurrency (the #546 re-send race, the 429 cooldown
  interplay, the detached heartbeat `setInterval` vs the gate) needs
  runtime/UAT confirmation.
- **R8 (added) — notification / over-ping ordering.** The over-ping
  one-ping-per-turn slot (`over-ping-safety-net.ts:23`) is per-turn and
  framework-owned. If lever 2 changes which message is last-sent, or reopen
  creates a second card, the *activity send* may consume the turn's single ping
  and the **reply downgrades to silent** — "reply is last" but the phone never
  buzzed is a worse failure. Ensure the **final reply, not a card, owns the
  turn's one ping.**
- **R9 (added) — supergroup / multi-agent singleton turn.** One `claude` CLI
  owns a whole supergroup; `currentTurn` is a per-supergroup-sequential
  singleton (`:10548`) and cross-topic inbound is held by the #2137
  deliver-before-drain gate. The authority must serialize against that gate and
  the `chat-lock` **without deadlocking**.

---

## 11. Test strategy — make the invariants CI-enforced (MTProto / mtcute)

The UAT harness (`telegram-plugin/uat/`) drives a real Telegram client against
a live bot. It already classifies surfaces: `isActivityFeedMessage`
(`uat/assertions.ts:60-67`), `isWorkerFeedMessage` (`:36-38`), and an `isAnswer`
predicate (sender≠driver, not edited, not a feed message, non-empty).

**Harness gap (fact-validated):** the driver exposes only the live new+edit
stream (`driver.ts:277`) and single-message `getMessage` (`:582`) — **no full
ordered history pull** (`getHistory` is only a `:273` "Phase 3" comment). Add
`driver.getHistory(chatId, limit)` wrapping mtcute `getHistory` (server
send-order). `collectTurn` already keeps collecting for `settleMs` (~6000 ms)
**after** the answer — the window to catch a post-reply card.

**New scenario `uat/scenarios/jtbd-reply-is-last-dm.test.ts`**, four cases. The
assertion is the **scoped** invariant from §6, not a naive "highest
message_id" — it must filter to the **activity/answer lanes of the same
foreground turn**, so a legitimate later background/worker/represent/error
surface does not flag:

1. **Conversational, zero-tool** ("Reply with only: pong") — assert no
   activity-card surface opens in this turn at all. Guards G1.
2. **Tool-heavy** (a `REAL_WORK_CASES` prompt, `requireSurface:"activity"`) —
   assert a card opened AND no card message for this turn has `messageId >
   answer.messageId`. Guards races A/B/E.
3. **Short-pinging final** ("Reply 'Done!' then write one memory") — the
   currently-reordering case; **expected to fail today**, green only once lever
   2 lands. Guards G5.
4. **Two-turn backstop** — a prompt that ends a turn without a qualifying reply
   (forcing the re-prompt); assert no card opens below the final answer across
   the re-prompt boundary. Needs `getHistory`. Guards G3/C.

Plus a reusable `assertReplyIsLast(history, driverUserId, {lane, turn})` helper
in `uat/assertions.ts` that **filters to the activity/answer lanes and the same
turn** (reuses existing predicates; only `getHistory` is genuinely new). A
naive cross-surface "answer has max message_id" assertion would be flaky
against legitimate late background/error/represent surfaces — do not write it.

This converts the **scoped** invariants ("no card after a turn's substantive
reply"; "no card on a 0-tool turn") from hopes into CI-enforced properties.

---

## 12. Appendix — file:line index (fact-validated against `origin/main`)

- Card open (only reorder vector): `gateway.ts:10292-10303`
- Card edit / finalize (no reorder): `:10305-10309`, `:10418-10465` (delete
  `:10429`, edit `:10455`); clear sites `:10742`, `:11208`, `:22695`
- Narrative SHOW (ungated, G1/E): `:10195-10202`, `:10901`, `:11199`
- Narrative stage/resolve/flush gate (G2): `:10212-10253`, operative predicate
  `:10251`
- Projection empty-drop: `session-tail.ts:236`; thinking boundary `:290`
- Narrative dedup kernel: `narrative-dedup.ts:64` (`DRAFT_SUPPRESS_THRESHOLD
  =0.8`), fn `:67`, prefix loop `:52`
- Reply send → finalAnswerDelivered: `:8113-8275` → `:8348`/`:8730`; obligation
  close `:8362`; recordOutbound `:8295`; `executeReply` span `:7547-8405`
- Liveness/heartbeat: `:10347-10389`; `FEED_LIVENESS_OPEN_MS=12000` `:1728`;
  `FEED_HEARTBEAT_TICK_MS=6000` `:1715`; post-final gate `:10350`
- Feed-reopen-after-ack (race A): `:10814-10833`; `feed-reopen-gate.ts:150-162`,
  flag reset `:157`
- Substantive-vs-ack + named residual (G5): `final-answer-detect.ts:113-117`,
  `:106-111`, `FINAL_ANSWER_MIN_CHARS=200` `:47`
- Stop-hook backstop (re-prompt only): `hooks/silent-end-interrupt-stop.mjs`
  `decision:'block'` `:191`, `MAX_RETRIES=2` `:66`; `SILENT_END_FALLBACK_TEXT`
  `gateway.ts:187`, sent `:11870`; `recordUndeliveredTurnEnd` `:11854`
- obligation_represent + guard (fixed): `:5960-6004`,
  `represent-guard.ts:63-71`, wired `:5978`; tests
  `tests/represent-guard.test.ts:27-36`
- Over-ping one-ping-per-turn (R8): `over-ping-safety-net.ts:23`
- UAT harness: `uat/harness.ts:140`, `uat/driver.ts:277/582` (no `getHistory`,
  `:273`), `uat/assertions.ts:36-67`, `uat/real-work-prompts.ts:179`
