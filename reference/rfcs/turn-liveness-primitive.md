---
artifact: Turn-liveness primitive — one role-keyed liveness/completion floor across every loop role
backs: chat-is-the-single-source-of-truth
status: design v1 — refines conversational-pacing.md's "Safety net" layer (does not replace the five-beat model)
---

# Turn-liveness primitive: design contract

> Refines, does not replace, `reference/rfcs/conversational-pacing.md`.
> The three-layer model (Ambient reaction / Conversational five-beat /
> Safety net) stands. This RFC re-founds the **Safety-net layer** as a
> single primitive keyed on **loop role** and hung off **CLI-native loop
> boundaries**, so coverage is *by construction* instead of *by
> enumeration*, and adds the missing **mid-turn text floor** the
> 300s-only safety net never had.

Closes the recurring failure in issue **#2527**: a user messages an
agent, sees an ambient ack (👀 / typing), the agent works for minutes or
ends the turn, and **no text ever arrives**. The ack reads as *done*.
Reproduced in both a DM and a forum supergroup, v0.15.56.

## Why this kept happening: coverage by enumeration

The machinery already exists and is *mostly correct*. It keeps failing
because liveness/completion is **enumerated per turn-type and per
surface** rather than derived from the loop. Verified evidence:

1. **No mid-turn text floor for a busy-but-silent turn.** `silence-poke.ts`
   *defers* its 300s fallback while `isLegitimatelyWorking(key)` is true
   (`silence-poke.ts:457`), on the rationale (`:434-438`) that *"the live
   activity feed renders that work."* But the activity feed only exists for
   **background sub-agents**. A **foreground** turn doing 6 minutes of
   silent `Bash`/`Read`/restart calls has no feed, so the user sees only
   the 👀. This is the documented #2527 evidence (the operator sent
   "Status?" twice into the silence).

2. **Terminal coverage is `Stop`-only.** The silent-end ladder
   (`hooks/silent-end-interrupt-stop.mjs` → `silent-end.ts` →
   `recordUndeliveredTurnEnd`) hangs off the `Stop` hook alone.
   `SubagentStop` and `StopFailure` are wired **nowhere**
   (`buildSettingsHooksBlock`, `scaffold.ts:4246`, emits only `Stop`).
   Sub-agents, nested sub-agents, background/research workers (all
   `SubagentStop`) and crashes/limits (`StopFailure`) get **no** terminal
   guarantee. *This is the literal whack-a-mole the operator described:
   "foreground works, then sub-agents don't, then research workers, then
   nested."*

3. **The "done" emoji is painted unconditionally.** `gateway.ts:11459`
   `finalizeStatusReaction(chatId, threadId, 'done')` paints 👍 at every
   turn_end, *then* `:11510` handles the undelivered case. A user turn that
   ended undelivered still shows 👍, the operator's "thumbs up so it feels
   like you are done" report.

4. **Surface forks.** `maybeEarlyAckReaction` hard-gates
   `chatType !== 'private'` (`gateway.ts:11966`): the instant ack is
   DM-only; supergroups get a different path. The fix for one surface never
   covers the other. #2527 reproduced in both.

5. **The role question is answered by three different predicates.**
   "Is this turn intentionally/ system-silent?" is keyed on `chatId == null`
   (`turn-flush-safety.ts:192`), on `envelope.source === 'cron'`
   (`silent-end-scan.mjs:235`), and on `NO_REPLY`/`HEARTBEAT_OK` regexes
   (three separate recognizers in `turn-flush-safety.ts`). They compose only
   by luck.

## Principles (the spine)

1. **Code owns the visible lifecycle; the model owns the words.**
   Reliability never depends on the model remembering to signal. (v0.15.56
   leaned on prompt discipline and broke twice in one session.)
2. **One discriminator: the loop role.** Every turn is exactly one of
   `user` | `sub-agent` | `system` (cron/scheduled/wake). The role is
   stamped **once at enqueue** and read everywhere. No `chatType` branch, no
   re-derivation. New *agent types* are not new roles: a research worker
   and a nested sub-agent are both `sub-agent`.
3. **Coverage by construction off CLI-native boundaries.** The primitive
   hangs off boundaries the `claude` CLI emits for *every* turn regardless
   of shape, so a turn type nobody has built yet is covered the day it
   ships. The boundaries (from the hooks reference, cadences are *once per
   session*, *once per turn*, and *every tool call in the loop*):

   | Need | CLI-native boundary | Fires for |
   |---|---|---|
   | Mid-turn liveness heartbeat | `PostToolUse` / `PostToolBatch` | every tool call, every role |
   | Main-turn terminal | `Stop` (→ gateway `turn_end`) | once per main turn |
   | Sub-agent terminal | `SubagentStop` | every sub-agent incl. nested + background |
   | Crash / limit terminal | `StopFailure` | turn ended by API error |
   | Turn start / role stamp | `UserPromptSubmit` + enqueue envelope | every turn |

4. **Two-part invariant.** A turn that received a user inbound and set an
   ambient ack must (i) **surface mid-turn liveness** if it works silently
   past a short threshold, and (ii) **terminate with a visible artifact or
   an explicit silent-marker**, never just an emoji.
5. **Emoji is liveness only, never a stand-in for an answer.** A user turn
   with real content always owes *text*. The only carve-out: a purely social
   turn ("thanks") may resolve on a terminal emoji alone.
6. **One send path.** Every framework-emitted message (mid-turn floor,
   silent-end fallback, turn-flush) goes through the *same*
   redact → voice-scrub → markdown→HTML → chunk(4000) → outbound-dedup →
   `retryWithThreadFallback` pipeline as a model reply. A framework message
   can never be malformed, mis-escaped, double-sent, or mis-threaded.
7. **Surface parity by construction.** The substantive guarantees (the
   mid-turn floor and the role-aware terminal reaction) are keyed on
   `statusKey(chatId, threadId)` + loop role (already thread-shaped, identical
   for a DM `threadId=null` and a forum topic), never on chat type. The fired
   floor beat routes to the originating thread. (The sub-second early-ack 👀
   stays DM-only by design (see the consolidation table) because group
   pre-acking can react to a message the full gate would drop; the parity that
   matters rides the floor + terminal, proven by the fuzzed invariant's
   DM-vs-topic equivalence and the `-dm`/`-channel` UAT twins.)

## The three roles × terminal rules

| Role | Stamped from | Mid-turn floor | Terminal rule |
|---|---|---|---|
| `user` | human inbound (Telegram) | **yes** — fires on silent work | **never silent**: substantive reply, else ladder (re-prompt→emit); 👍 only on a delivered answer |
| `sub-agent` | `SubagentStart`/sidechain | no (parent carries the user-facing beat) | completion **surfaces to the parent/feed** (✅/⚠️); never owes a direct Telegram reply |
| `system` | enqueue `source` (cron/wake/handback) | no | **may stay silent**; speaks only if it called `reply`; opts out with `NO_REPLY` — never a scattered carve-out |

## Mid-turn text floor: the primary #2527 fix

A new pure decision unit (`turn-liveness-floor.ts`, mirroring
`turn-flush-safety.ts`'s pure-function shape) drives one **code-owned,
edit-in-place** interim message when, for a `user` turn:

- the turn has been open ≥ **`FLOOR_THRESHOLD_MS`** (default **45s**), AND
- **zero substantive outbound** has landed in the thread so far
  (`finalAnswerDelivered` is the existing signal), AND
- the turn is **legitimately working** (an in-flight tool / dispatched
  sub-agent), so we fire *because* it's busy-silent, not despite it. (This
  is the exact inversion of the bug at `silence-poke.ts:457`, where busy =
  suppress.)

Properties:

- **Honest, model-free, claude-native.** The text is built from the
  *longest in-flight tool label* / sub-agent task description the gateway
  already snapshots (`silence-poke.ts:468-477`), e.g. *"Still on it,
  restarting the container (1m so far)."* No model call (no `claude -p`),
  no generic "working…".
- **One beat, then back off.** Fires once, edits in place on later updates,
  **never re-notifies** (`disable_notification: true`). The existing 300s
  hard fallback remains the genuine-wedge unwedge above it.
- **"Status?" short-circuit.** A user inbound *during* a silent working
  stretch fires the floor immediately (the user is explicitly asking, the
  #2527 "Status?"×2 scenario).
- **Kill-switch** `SWITCHROOM_TG_LIVENESS_FLOOR=0`; whole primitive behind
  the same flag, default-on with revert.

## Terminal reaction honesty: the "thumbs-up" fix

`gateway.ts:11459` is gated on the **role + delivery**: a `user` turn ending
with `finalAnswerDelivered === false` finalizes to a **non-`done`** terminal
(it is a failure state, with the silent-end fallback text carrying the
apology), so 👍 never reads over an undelivered answer. `system`/`sub-agent`
turns and `NO_REPLY`/`HEARTBEAT_OK` turns finalize 👍 exactly as today.
Their silence is legitimate.

## Consolidation plan

| Module | Fate | Note |
|---|---|---|
| `final-answer-detect.ts` | **keep** | `isSubstantiveFinalReply` already exists; the terminal-classifier migration (use it at the *terminal* gate) is **staged** — see below. |
| `silent-end.ts` + `silent-end-interrupt-stop.mjs` + `silent-end-scan.mjs` | **keep** | race-free transcript scan is the main-turn terminal arm. Predicate copy stays TS/mjs-locked (T14 fixture). |
| `turn-flush-safety.ts` | **keep** | deterministic-emit arm; its marker recognizers are an accepted "intentionally silent" denylist. |
| `status-reactions.ts` | **keep** | liveness-only controller. Stays the single terminal reaction owner. |
| `silence-poke.ts` | **rework** | keep the 300s clock; add the short-threshold **text floor** above it. |
| `maybeEarlyAckReaction` (gateway) | **keep (documented)** | stays DM-only *by design*: pre-acking a group message risks reacting to one the full gate (requireMention/topic) would drop. Parity is carried by the surface-agnostic floor + terminal, not by this sub-second 👀. A surface-agnostic `maybePokeFloorForMidTurnInbound` adds the "Status?" short-circuit for both surfaces. |
| `gateway.ts` turn_end (11455-11543) | **rework** | role-aware 👍 gate; route every emit through the one send path. |
| turn atom (`gateway.ts:10287`) | **rework** | stamp `role` once at enqueue — the single discriminator. |
| PR **#2528** (8 StreamingEvents) | **absorb** | telemetry *of* the primitive; collapse the DM-only/group-only split into one `surface`-tagged event. |
| `telegram-plugin/hooks/hooks.json` | **annotate** | header noting `scaffold.ts:buildSettingsHooksBlock` is authoritative for fleet agents (this file is the vendored-plugin path only). Real `SubagentStop`/`StopFailure` wiring lands there when staged. |

## This PR vs staged follow-ons (honest scoping)

**Ships in this PR** (closes the documented #2527 evidence; additive,
flag-gated, fuzz-proven): the **role discriminator**, the **mid-turn text
floor** (+ "Status?" short-circuit), the **role-aware terminal reaction
gate**, **surface de-fork**, the **one-send-path** unification for
framework emits, and the **absorbed telemetry**.

> **Why the floor on the *main* turn is the coverage-by-construction win
> the operator actually asked for:** user-facing liveness hangs off the
> *main turn's* silence, and the main turn stays "legitimately working"
> while **any** sub-agent (foreground / background / nested / research)
> runs. So the user gets liveness for sub-agent shapes nobody enumerated,
> without any per-sub-agent wiring. New shapes are covered for free.

**Staged (own canary, not blind in an autonomous pass):**

- **Terminal-classifier migration** — moving the terminal gate from
  `isFinalAnswerReply` to `isSubstantiveFinalReply`. The gateway *already*
  resets `finalAnswerDelivered=false` on post-ack tool work
  (`gateway.ts:10529-10565`), so the "On it" latch is partially mitigated
  today; tightening the classifier fleet-wide risks spurious re-prompts on
  genuinely short answers (`final-answer-detect.ts:106-111`) and needs its
  own dedup-guarded rollout.
- **Real `SubagentStop` / `StopFailure` hooks** in `buildSettingsHooksBlock`
  — sub-agent completion currently reaches the gateway via the *synthesized*
  `sub_agent_turn_end` (`session-tail.ts:406`), which already feeds the
  feed; upstream `SubagentStop` firing is **unverified in this repo** and
  must be confirmed before it becomes the terminal of record.

## Risks & mitigations

- *Floor noise on a normal 90s turn.* → fire only on `user` + busy + zero
  substantive outbound + past threshold; edit-in-place, never re-notify;
  kill-switch.
- *`isLegitimatelyWorking` is global, not per-key* (`gateway.ts:5267`). A
  multi-topic agent could defer/fire across topics. Accepted residual today;
  flagged because the floor makes it user-visible: the floor keys its
  *emit* on the per-turn `statusKey`, only the work-signal is global.
- *Framework-authored floor/fallback text* must carry `parse_mode`
  consistently and not be voice-scrub/em-dash-mangled. It rides the one
  send path and is covered by the format tests.
- *Reaction must always reach a terminal* on every turn_end branch: the
  role-aware gate preserves "some terminal state on every exit."

## Proof: fuzz the invariant, don't enumerate scenarios

The anti-whack-a-mole proof is a **property/invariant test** over the
turn-shape space, not a growing scenario list:

> *For any turn that received a user inbound and set an ambient ack, the
> terminal state has ≥1 visible artifact OR an explicit silent-marker; and
> any user turn that works silently past the floor threshold emits exactly
> one mid-turn liveness artifact.*

Fuzz corpus: message timing × turn length × tool churn × sub-agent fan-out ×
**nesting** × restart-mid-turn × surface (DM vs forum topic) × role. Plus
scenario UATs with `-dm`/`-channel` twins asserting a **text** message (not
just a reaction) lands in the originating thread within the floor threshold
and at terminal.

## Verdict

Done when the user always knows the agent heard them, can tell working from
stuck, and never sees an ambient ack masquerade as a completed answer, in a
DM and a supergroup topic alike, proven by a turn-shape-fuzzed invariant
across all three loop roles, with the safety net hung off CLI-native loop
boundaries so the next un-built agent type is covered for free.
