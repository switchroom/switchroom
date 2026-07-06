---
artifact: Deterministic turn liveness — the framework owns "alive", the model owns "what"
backs: chat-is-the-single-source-of-truth
serves: jobs/know-what-my-agent-is-doing.md
status: design v1 — regression fix; re-founds turn-liveness-primitive.md's mid-turn floor as a climbing card edit, not a one-shot text send
---

# Deterministic turn liveness: the framework owns "alive", the model owns "what"

> Serves `reference/jobs/know-what-my-agent-is-doing.md` (outcome: *at any
> moment during a turn, the user can see what the agent is up to and why,
> without asking*). Refines `reference/rfcs/turn-liveness-primitive.md`
> (the mid-turn floor it defined) and stays inside
> `reference/rfcs/conversational-pacing.md`'s three-layer model. Crosses
> no invariant: no parallel surface, no bespoke card, no mid-turn device
> buzz (`invariants.md` § `chat-is-the-single-source-of-truth`).

The mid-turn liveness guarantee that `turn-liveness-primitive.md` promised
is, in the current tree, **not delivered**. Two independently-reasonable
PRs six days apart left the busy-but-silent foreground turn — the exact
`#2527` shape that motivated the primitive — with a frozen activity card
and no deterministic text. The floor still *decides* to fire; its delivery
path returns `null`. This RFC re-founds the floor on the one signal the
model can never supply during a blocked tool call — **wall-clock elapsed,
edited into the card the chat already owns** — and walls it behind
outcome-based tests so the guarantee can't silently erode again.

## Design principle (the headline)

**The framework deterministically guarantees ALIVE and FOR HOW LONG; the
model supplies WHAT.**

When the model narrates, its words ride the card and that *is* the "what".
When the model is silent — blocked mid-tool, emitting nothing — the card
must not freeze and must not go dark. It degrades, deterministically, to
`Working · Ns` and keeps climbing. The boundary is explicit: the visible
floor state is never a frozen card and never silence; it is at worst an
honest elapsed clock the model didn't decorate.

This is the same spine as `turn-liveness-primitive.md` principle 1 ("code
owns the visible lifecycle; the model owns the words"). What changed is the
*delivery mechanism*: the primitive assumed a code-owned one-shot **text
send** (`turn-liveness-floor.ts`, `FLOOR_THRESHOLD_MS` 45s). That send is
now muted by construction (see Motivation). The deliverable that survived
the pacing rules is a **card edit**, not a text ping — and the card is
already open and already carries model narration. We climb *that*.

## Motivation

### The incident

Observed: an activity card opened at `04:21:23`, then received **zero
edits for ~50s** while a single `Bash` ran to completion. The tool
surfaced **no activity label** (suppressed/unlabelled), so the labelled
branch's climb (#2143) never engaged — a labelled step would have climbed;
the freeze reproduces specifically on the 0-label path. No text, no
climb, no reaction change beyond the ambient "stuck" flip. The user's only
signal that anything was alive was a 👀 that reads, after 50s, as *done*.
This is the black box the job spec exists to close ("the user can tell
running from stuck at a glance… a stuck agent visibly escalates rather
than going quiet").

### The archaeology (how a delivered guarantee became a no-op)

| Date | PR / commit | Change | Effect on the silent-tool floor |
|---|---|---|---|
| 2026-06-04 | **#2143** | Activity-feed heartbeat climb for **labelled** steps | Climb exists — but only on the labelled branch |
| 2026-06-23 | **#2527** (via #2530) | Built `turn-liveness-floor.ts`: code-owned fire-once **45s** mid-turn floor for the busy-but-silent foreground turn | The guarantee, as designed |
| 2026-06-29 | **#2649** | ~1.2s **early card open** | Introduced the freeze (see below) |
| 2026-06-29 | **#2667** (`e0556c0c`) | `formatFrameworkFallbackText` returns `null` for **all** stall variants (`silence-poke.ts:398-424`) | Muted the 45s floor text **and** the 300s fallback text — 6 days after the floor shipped |

**The freeze (#2649).** Once the card is open
(`activityMessageId != null`), `shouldEarlyOpenLiveness`
(`feed-open-gate.ts:130`) refuses to act, and the 0-label branch of
`feedHeartbeatTick` (`gateway.ts:12326-12329`) only delegates to
`openLivenessFeedIfDue`. Open + zero labels ⇒ **the card never edits**
during a silent long tool. The comment at `gateway.ts:1913` claiming the
heartbeat "maintains/climbs" is **incomplete/overclaimed** — true for the
labelled path only, not for this one.

**The mute (#2667).** `formatFrameworkFallbackText` now returns `null` for
every stall variant, so `gateway.ts:6202` skips the send on `null`. The
rationale was legitimate and is upheld here: a *repeating cadence* "still
working" ping is banned by `conversational-pacing.md` (Anti-patterns:
"Cadence-based 'still working' updates"; job spec Bad: "Mid-turn updates
that buzz the device… notification fatigue"). But nothing deterministic
replaced the **mid-turn** floors: the 45s and 300s stall texts were muted,
and the mid-turn guarantee silently shifted to *"the model will narrate"* —
and the model, blocked inside a tool, narrates nothing. (The *terminal*
dark-turn case is different: a shipped deterministic guard exists there —
the silent-end fallback at `gateway.ts:13879-13906` — see Phase 2, whose
job is to prove and harden it, not invent it.)

**Why narration can't cover this.** Narration already reaches the card
mid-turn — this is **not new work** and we keep it exactly as-is:
session-tail tails the session `.jsonl`, assistant text is flushed at
tool-dispatch boundaries → gateway `case 'text'` → `stagePendingNarrative`
→ `showNarrativeStep` → `appendActivityLabel(turn.mirrorLines,
clipNarrative(text))`. Narration and tool labels interleave
chronologically in the one card — correct, keep it. But narration can
**never** cover a long-tool gap: the model is blocked mid-tool and emits
nothing across the gap. Only a wall-clock timer can. The one deterministic
signal today during a silent tool is the ambient reaction flip 🥱@30s /
😨@90s (`status-reactions.ts:391-404`) — a *"stuck"* signal, the wrong
shape for *"working"*.

### Why the tests missed it

- `tests/feed-heartbeat-liveness-open.test.ts` is **structural** — it greps
  source strings — and its stated property *"already open returns early (no
  double-open)"* **enshrines the freeze as correct**. The test passes
  *because* the card doesn't edit.
- `tests/turn-liveness-invariant.test.ts` stubs the send
  (`onMidTurnFloor: ctx => floors.push(ctx)`). It proves the floor
  *decides* to fire; it never proves a byte reaches Telegram. Decision ≠
  delivery, and the gap between them is exactly where #2667's `null` lives.

No test exercises the transport. The one test that touches this surface
asserts the bug.

## Design

Four mechanism phases plus an erosion guard. Phase 1 is the keystone; the
rest settle the machinery around it and wall the guarantee.

### Phase 1 — deterministic card climb (keystone)

Give the 0-label branch of `feedHeartbeatTick` the **same climbing-elapsed
EDIT path** the labelled branch already uses (~`gateway.ts:12336-12350`):
when the card is open **and** `mirrorLines` is empty, take the same
`cardDrainGate` / `mayDrain` / `openOrEditCard('liveness')` gate sequence,
editing no more often than `FEED_HEARTBEAT_MIN_STALE_MS` apart. One
deliberate difference: the **render** is not identical —
`composeTurnActivity` on empty `mirrorLines` may return `null`, so the
0-label climb must use the `renderActivityFeedWithNested(['Working…'])`
fallback that `openLivenessFeedIfDue` already uses
(`gateway.ts:12170-12174`). The visible edit is the elapsed clock —
`Working · Ns` — climbing on each tick.

- **Model-independent.** It fires off the heartbeat tick, not off any
  model emission, so a blocked tool call cannot starve it.
- **Bound on visible dead-air: ~6–12s** (one to two `FEED_HEARTBEAT_MIN_STALE_MS`
  windows), versus the observed ~50s freeze.
- **Not a new surface, not a buzz.** It edits the card the chat already
  owns (`openOrEditCard`), and card edits do not notify. This is squarely
  the pacing model's Ambient layer and crosses no invariant: no parallel
  surface (`chat-is-the-single-source-of-truth`), no device buzz (job spec
  Bad list).
- **Interleaves with narration.** The moment the model emits text, the
  narrative append lands on the same card chronologically (unchanged path
  above). The climb fills only the gaps the model leaves; it never
  overwrites narration.
- **Fix the overclaiming comment** at `gateway.ts:1913` to describe what
  the path actually does now (climbing on both branches).

This is the floor `turn-liveness-primitive.md` intended, relocated from a
one-shot text send to a card edit — which is the only delivery shape that
survives the pacing rules (no ping) *and* the freeze (edits an open card).

### Phase 2 — dark-turn guard: audit and harden the shipped path

Phase 1 covers the turn that has an open card. A turn that **ends having
delivered no reply** is the dark-turn case — and here a deterministic
guard **already exists and ships today**: on `turn_end` with
`finalAnswerDelivered === false`, `recordUndeliveredTurnEnd()`
(`gateway.ts:13879-13906`) drives the Stop-hook re-prompt
(`silent-end-interrupt-stop.mjs`), and when the re-prompt ladder is
exhausted the gateway sends `SILENT_END_FALLBACK_TEXT` (`gateway.ts:233`:
*"⚠️ The agent finished working but didn't send a reply…"*), with an
`exhausted` latch giving fire-once. Phase 2 is **not** a new mechanism —
a fresh guard would double-fire on every genuine dark turn. It is an
audit-and-harden of that path:

- **Prove delivery, not decision.** Put the existing silent-end fallback
  behind the Phase-4 outcome wall: a dark turn on the real surface must
  yield exactly one delivered fallback message (transport-level assertion,
  not a stubbed callback — the same decision-vs-delivery lesson as the
  muted 45s floor).
- **Harden the text.** Include the turn's elapsed in
  `SILENT_END_FALLBACK_TEXT` so the message is honest about how long the
  user waited; verify the `exhausted` latch under the fuzz corpus (at most
  one fire per turn).
- **Inherit the legitimate-silence exclusions by construction.** The code
  already treats silent ends as first-class: `NO_REPLY` / `HEARTBEAT_OK` /
  handback-ack / system / cron turns return before the fallback
  (`gateway.ts:1824-1826`, `:3183-3184`, `:13804-13805`, `:13875-13877`).
  By riding the existing `recordUndeliveredTurnEnd` gating — never a fresh
  predicate — the guard cannot spam legitimately-silent turns.
- **Boundary with the orphaned-reply backstop.** That backstop
  (`context-exhaustion.ts`, 30s) requires `capturedText > 0` — it recovers
  a reply the model *composed but failed to deliver*. The dark turn has no
  captured text, so the two paths are complementary by the `capturedText`
  predicate; the audit asserts they cannot double-fire on one turn.
- The fallback stays honest, model-free, one-shot on a terminal condition —
  the *unwedge* shape `conversational-pacing.md` sanctions, never the
  banned cadence ping — routed through the one send path per
  `turn-liveness-primitive.md` principle 6.

### Phase 3 — settle the half-dead machinery

The #2527 45s floor (`turn-liveness-floor.ts`) still *decides* to fire and
still calls a send path that #2667 turned into a `null` no-op
(`gateway.ts:6202`). That is an already-inert path whose presence implies
a guarantee that isn't there — the exact trap the archaeology above
documents; removing it is cleanup plus documentation, not a behaviour
change.

Decide explicitly and document it: **the climbing card (Phase 1) IS the
mid-turn floor.** Therefore:

- Remove the vestigial `onMidTurnFloor` **text-send** path for the
  busy-but-silent case; the climb replaces it.
- **Keep** the approval-blocked case — the loud *"waiting for your
  approval"* re-ping is a genuine, honest, non-cadence message
  (`conversational-pacing.md` § Silence-poke fallback names it as one of
  the two surviving honest cases), and the card climb does not replace an
  approval prompt.
- Leave a one-line comment at the removed site pointing at Phase 1, so no
  future reader re-adds a text floor believing none exists.

No inert code may imply an absent guarantee. Either the machinery delivers
or it is removed with a pointer to what does.

### Phase 4 — outcome-based test wall

Structural source-greps are retired as *sole* coverage for liveness. The
wall is behavioural, on the real surface.

**(a) UAT scenarios** (harness `spinUp` / `ObservedMessage` shape, modelled
on `uat/scenarios/jtbd-liveness-feed-open-dm.test.ts`), each with a `-dm`
and a `-channel` twin (surface parity is a production-readiness bar in the
job spec):

- **40s silent tool** → card **edited ≥4 times**, elapsed **climbing**;
  hard-fail on a freeze (zero edits across the gap).
- **Narrated work** → the model's words appear on the card mid-turn
  (narration path intact, not regressed by the climb).
- **Dark turn** → the existing silent-end fallback (Phase 2) delivers
  exactly one message on the real surface.
- Across all: **no mid-turn notification ping** is emitted.

**(b) Transport-boundary regression test.** Spy on
`bot.api.editMessageText` / `robustApiCall` with fake timers; assert the
card is actually edited during a silent tool. **This test must FAIL on
today's code** (that is its acceptance criterion — it pins the exact
decision-vs-delivery gap the current `onMidTurnFloor` stub hid).

**(c) Fuzz invariant** across turn shapes (message timing × turn length ×
tool churn × sub-agent fan-out × surface × role, per the primitive's
corpus): the **visible-update gap never exceeds the Phase-1 bound**; the
dark-turn guard fires **at most once**; **zero** device buzz mid-turn.

**(d) Policy.** Structural source-grep tests are no longer acceptable as
the *sole* coverage for any liveness guarantee. The enshrining test
`tests/feed-heartbeat-liveness-open.test.ts` is **replaced** — its
"already open returns early" property is inverted to "already open ⇒ climbs
on tick".

### Phase 5 — erosion guard

- Add the Phase-4 scenarios to the job spec's **Prove it** list (the
  busy-but-silent + dark-turn bullets), so the guarantee has a named,
  surface-paired scenario the way every other liveness guarantee does.
- Any PR that touches the liveness surface (`feedHeartbeatTick`,
  `feed-open-gate.ts`, `silence-poke.ts`, `turn-liveness-floor.ts`, the
  card edit path) **must declare its deterministic-guarantee delta** in the
  PR body: what the framework still guarantees to deliver without the model,
  after this change. #2667 muted a guarantee as a side effect of a
  legitimate anti-nag change precisely because no one had to state the
  delta.

## Alternatives considered

- **Revert #2667 (bring back the framework fallback text).** Rejected. It
  reinstates the repeating-cadence "still working" ping that
  `conversational-pacing.md` bans (Anti-patterns) and the job spec's Bad
  list calls out as notification fatigue. #2667's rationale was correct;
  the fix is to replace the muted guarantee with a *card edit* (no ping),
  not to un-mute a *text ping*.
- **Narration-first precedence ladder** (prefer model text, fall back to
  the climb only when narration is absent, with the climb yielding to
  incoming words). Rejected. The chronological interleave we already have
  is better UX than a precedence ladder, and — decisively — narration can
  **never** cover a long-tool gap (the model is blocked and emits nothing).
  A ladder that "falls back when narration is absent" is just the climb
  with extra state; the climb interleaving chronologically already yields
  to words the instant they arrive.
- **Pinned parallel status card / bespoke widget.** Banned. `#1122` and
  `invariants.md` § `chat-is-the-single-source-of-truth` retired the
  parallel progress surface as a line, not a tradeoff. The Phase-1 climb
  edits the *existing* card in the *existing* feed — it renders no new
  parallel surface and no new pinned content.

## Compatibility & rollout

- **Additive and gated.** The climb rides the existing card and the
  existing heartbeat tick; no schema or transport change. Its kill switch
  is the heartbeat's own gate — `SWITCHROOM_FEED_HEARTBEAT=0`
  (`FEED_HEARTBEAT_ENABLED`) — default-on with a clean revert. (The
  `SWITCHROOM_TG_LIVENESS_FLOOR` flag from `turn-liveness-primitive.md`
  gates the separate one-shot floor path, not this climb.)
- **PR sequencing (as shipped):**
  1. **Phase 1 + Phase 4b (transport regression test) + 4d
     (enshrining-test inversion)** in one PR — the fix and the test that
     proves it (transport regression test fails on base, passes on the
     branch). Never land the mechanism without the outcome test in the
     same PR. The Phase 4a DM/channel UAT twins and the 4c fuzz invariant
     did **not** ship in this PR — they follow as a tracked subsequent PR
     via the UAT harness; channel-path climb parity is unverified until
     then.
  2. **Phase 2** (silent-end fallback audit + hardening) as a second PR —
     narrower blast radius, its own UAT.
  3. **Phase 3 + Phase 5** as docs/cleanup — remove the vestigial send,
     document the boundary, update the job spec Prove-it and the PR-delta
     policy. Not landed with PRs 1–2; the vestigial 45s path stays
     in-tree until this PR.

### Known gaps (out of scope, not closed by this RFC)

1. ~~**Restart mid-turn.**~~ **Closed** by a follow-up PR
   (`telegram-plugin/gateway/activity-card-store.ts` + gateway wiring in
   `telegram-plugin/gateway/gateway.ts`). Deterministic guarantee added: no
   card orphaned by a gateway restart stays visually frozen (or pinned) —
   it is finalized with one honest edit, and unpinned, on the very next
   boot. The minimal card handle (chatId, threadId, activityMessageId,
   startedAt, pinned) is persisted to `TELEGRAM_STATE_DIR/activity-cards-
   pending.json` the moment a card OPENs and cleared the moment it closes
   normally — mirroring `status-pin-store.ts`'s durable-snapshot shape
   byte-for-byte. On boot, after winning the startup mutex (same ordering
   constraint as `statusPinBootCleanup`), a one-shot, model-free reaper
   reads any leftover record, deletes it from disk BEFORE attempting its
   edit/unpin (the idempotency guard — a second boot performs zero edits
   and zero unpins), and finalizes the orphaned card with a single
   `editMessageText` (never a new message — no ping) plus an
   `unpinChatMessage` for cards that were pinned on open. The resumed turn
   (if any) is NOT made to resume climbing the old card — it opens its own
   fresh card; honest finalization, not resumption, was the goal. Scoped
   out: the standalone worker-activity-feed's `messageId` (a separate,
   lower-traffic surface — `WorkerActivityFeed` doesn't carry per-turn
   liveness semantics the same way, and folding it in would double this
   PR's surface area for a rarer failure mode); left for a follow-up if it
   proves to matter in practice.
2. ~~**Worktree-isolated sub-agents.**~~ **Closed** by a follow-up PR
   (`telegram-plugin/subagent-watcher.ts` `extraWatchCwdsProvider` +
   `telegram-plugin/gateway/gateway.ts` wiring against
   `src/worktree/registry.ts`'s `listRecords()`). Deterministic guarantee
   added: sub-agent activity in a worktree-isolated cwd this agent itself
   claimed surfaces in the worker feed / `subagentActivityAt` exactly like
   a same-cwd sub-agent — the watcher now watches the project-dir slug for
   every worktree path owned by this agent (`ownerAgent` match against
   `SWITCHROOM_AGENT_NAME`), re-derived fresh on every rescan tick, in
   addition to `agentCwd`. Genuinely foreign project dirs (not a slug the
   agent's own `agentCwd` or a worktree it owns maps to) are still
   skipped — the #1116 protection is preserved, not widened to a wildcard
   watch.

Gap 1 is pre-existing and orthogonal to the climb, named here so the
guarantee is not read as broader than delivered. It needs its own
follow-up (persist/rehydrate or boot-time reaping of orphaned cards).
- **Fleet restart discipline.** No fleet restart until the operator
  confirms; stagger restarts across agents (a card-edit-path change is
  visible on the very next turn, so a bad edit should not hit the whole
  fleet at once).

## Test plan

The Phase-4 wall is the test plan: UAT scenarios on the real surface (DM +
channel twins), the transport-boundary regression test that must fail on
base, the fuzzed gap/guard/buzz invariant, and the replacement of the
enshrining structural test. Acceptance: on a 40s silent Bash the card
climbs (≥4 edits, no freeze), narrated work still shows words mid-turn, the
dark turn is broken exactly once, and no mid-turn ping fires — in a DM and
a forum topic alike.

## Open questions

- **Climb cadence — resolved in PR 1.** One `FEED_HEARTBEAT_MIN_STALE_MS`
  window (6s, equal to the tick, with an explicit min-stale guard); the
  visible bound is ~6–12s between edits. Coarser clock rounding remains a
  polish call.
- **Elapsed origin — resolved in PR 1.** Turn-start: the climb renders
  `Date.now() - turn.startedAt`.
- **Dark-turn guard vs `SubagentStop`/`StopFailure`.** The primitive staged
  real `SubagentStop`/`StopFailure` wiring. Should the dark-turn guard hang
  off those terminal boundaries once they land, or stay on the existing
  turn-terminal path? Ship on the existing path; revisit when the staged
  hooks are verified in-repo.

## Verdict

Done when a busy-but-silent turn's card visibly climbs within the Phase-1
bound instead of freezing, a dark turn is broken by exactly one message, no
mid-turn update ever buzzes, and the guarantee is proven by an
outcome-based test that fails on today's code — in a DM and a forum topic
alike. The framework owns *alive* and *for how long*; the model owns *what*;
neither can silently stop delivering its half again.
