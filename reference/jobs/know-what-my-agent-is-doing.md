---
job: know what my agent is actually doing
outcome: At any moment during a turn, the user can see what the agent is up to and why, without asking.
stakes: If the user can't see it, they can't trust it. If they can't trust it, they stop using the product.
serves: hold-the-leash
invariants: [chat-is-the-single-source-of-truth]
---

# Job Spec: know what my agent is actually doing

> A durable Job Spec. The *how* (the ambient reaction state machine, the
> conversational pacing rhythm, the worker-activity feed, the silence
> fallback) lives in the design artifact `reference/rfcs/conversational-pacing.md`
> and the prompt at `profiles/_shared/telegram-style.md.hbs`. That
> implementation churns; this job does not.

## The job

A user sends a non-trivial message and the agent goes off to work: reading,
running tools, maybe handing off to sub-agents. The user wants to know
whether it's going somewhere useful, whether it's stuck, or whether it's
doing something unexpected. Most agent products give them a black box:
message in, eventually a message out, nothing in the middle. The job is to
close that gap so the user never has to ask.

> [!IMPORTANT]
> We used to do this with a pinned, parallel progress card. We retired it
> (#1122): a surface running beside the conversation always devolved into
> redundant noise or a crutch for a model that wouldn't just talk. The job
> underneath was unchanged. The signal now lives in the conversation itself.

## Good / bad

**Good looks like**

- The user gets an ambient signal that the agent heard them, effectively
  instantly. No silent gap between "I sent it" and "something's happening".
- That signal distinguishes phases at a glance: acknowledged, thinking or
  working, actively editing. It stays present from receipt to turn end and
  never disappears mid-turn.
- A trivial ask just gets the answer. No progress ceremony, no widgets. The
  reply is the signal.
- The user can tell running from stuck at a glance. A stuck agent visibly
  escalates rather than going quiet.
- Pivots, blockers, finishing a chunk, dispatching a sub-agent: each is
  narrated in plain language, as it happens, in the conversation.
- Sub-agent and background work is visible in the same thread. No separate
  surface to hunt for. True in a DM and in a forum channel alike.
- When a worker card and the agent card are both live, "is this my agent or a
  background worker?" is answerable from the cards' SHAPE, at phone-glance
  distance, without reading them. The worker card is structurally subordinate:
  a `└─ ` on line 1, its whole block indented under the agent card, and a
  high-contrast `WORKER` type label. Two same-shaped cards differing only by an
  emoji and one word is the failure (#3820) — worse when the parent narrates
  the task it delegated, so the two step trails read as duplicates.
- Failures, limits, crashes, and restarts are always spoken. The user is
  told what happened and what resumes. A worker orphaned by a restart is
  narrated in the worker feed — re-dispatched or named as lost — not silently
  absent from the thread it was running in.
- Scrolling back a week later reads as a real conversation, not a deleted
  widget.
- When work outlives the visible feed — fast turns scroll it away, background
  workers stack up, a long turn runs past the fold — the framework silently pins
  the status message that is *already* in the chat (the per-turn status message,
  the `🛠 Worker` background-worker message) so in-flight work stays in view, and
  auto-unpins it when that work completes. The pin is silent (no device buzz) and
  carries no new content: it re-surfaces a message the conversation already owns.
  This is the one sanctioned pin (see `invariants.md`
  § `chat-is-the-single-source-of-truth`).
- **The restart rule (#3001): a status pin is a claim on unfinished work, and
  a restart resets it.** Any progress/worker pin (the per-turn status pin, the
  `🛠 Worker` pin) whose work did not finish is unpinned on the next gateway
  boot — the boot sweep reads the durable pin store and unpins every
  work-scoped claim from the dead session, retrying a failed unpin on later
  boots (capped) rather than forfeiting it. Mid-session the same guarantee
  holds within the reaper interval: a worker pin whose worker is already
  terminal in the registry (a missed completion event) or whose claim outlives
  a generous TTL is unpinned without waiting for a restart. A stale pin glued
  to the top of the chat for hours is exactly the "can't tell working from
  stuck" failure this job exists to prevent.
- **Agents can no longer hand-pin.** The `pin_message` MCP tool was retired
  (#4452): the ONE sanctioned pin is the framework's own auto-pin of the
  status/activity card and the 🛠 Worker card, which the boot sweep reaps as a
  work-scoped claim on restart. A message the USER deliberately pinned is never
  recorded in the durable store, so the sweep — which only ever unpins the
  message ids it recorded — leaves it untouched. Legacy `tool:` rows written by
  an older build before the tool's removal still carry their TTL and drain on
  expiry, so no already-placed pin is stranded.

**Bad looks like: never ship this**

- A separate progress surface running parallel to the chat. This was the
  retired card. It duplicates the conversation or covers for a model that
  won't talk. Make the model talk. (Silently pinning a status message *already
  rendered in the feed* is the sanctioned exception above — the line is
  rendering a new parallel surface, not pinning one the chat already holds.)
- A bespoke card/widget rendered solely to be pinned, or a pin that buzzes the
  device. That is the retired card wearing a pin, not the sanctioned exception.
- Narrating every tool call as its own message. Tool churn isn't something
  the user can act on. Silence during tool-calling is fine; the ambient
  signal carries "alive".
- Mid-turn updates that buzz the device. Notification fatigue trains users
  to mute the bot.
- One undifferentiated "working" signal that loses the phase distinction.
- Hiding progress behind a command or a button the user has to invoke. If
  they have to ask, the product already failed.
- Showing raw debug output (JSON, stack traces, prompt text) in place of a
  human-readable message.
- Sub-agent work on a surface the parent turn never references.
- Any silent failure: stuck, rate-limited, crashed, or restarted with no
  word.

## Prove it

Named by job × surface, pointing at real scenarios in
`telegram-plugin/uat/scenarios/`.

- **Instant ack + trivial ask (DM)** — `jtbd-fast-ack-dm`,
  `jtbd-fast-trivial-dm`. *Watch:* ambient ack within ~1s; the trivial reply
  carries no progress ceremony. *Invariant:* every inbound gets an ambient
  ack before the answer; trivial turns add no widgets.
- **Long multi-step work (DM)** — `jtbd-soft-commit-dm`, `fuzz-real-work-dm`.
  *Watch:* at least one plain-language soft-commit or mid-turn update; the
  framework fallback does not fire on a visibly-progressing turn.
  *Invariant:* meaningful punctuation is narrated; the fallback never fires
  while the turn is visibly progressing.
- **Phase-distinct liveness (DM)** — `jtbd-reflective-status-reaction-dm`.
  *Watch:* acknowledged vs working vs coding are visibly different; the
  signal only resolves on turn end. *Invariant:* a liveness signal is
  present from receipt to terminal state, reflective not ratcheted.
- **Sub-agent + background, in-thread (DM + channel)** —
  `jtbd-subagent-handback-dm`, `jtbd-foreground-subagent-activity-dm` /
  `-channel`, `bg-sub-agent-dispatch-dm`, `jtbd-worker-activity-feed-dm` /
  `-channel`. *Watch:* dispatch and report land in the same thread;
  background completion surfaces without a separate surface. *Invariant:* no
  agent work happens on a surface the parent never references; holds in DM
  and channel.
- **Genuine stall / silent end (DM)** — `midturn-silent-dm`,
  `silent-end-recovery-dm`. *Watch:* a fully silent wedge is broken by a
  user-visible message and the turn is unwedged. *Invariant:* a turn never
  ends or stalls in silence; the fallback fires at most once per turn.
- **Busy-but-silent turn + false-done (DM + channel, #2527)** — the fuzzed
  invariant `telegram-plugin/tests/turn-liveness-invariant.test.ts` (2000 turn
  shapes × both surfaces) plus the pure decisions in `turn-liveness-floor.ts`.
  *Watch:* a `user` turn that works silently past the floor threshold emits
  exactly one mid-turn liveness beat; a turn that ends undelivered never paints
  👍. *Invariant:* identical floor + terminal outcome in a DM and a forum topic
  (surface parity by construction), keyed on loop role not chat type. Live
  wired-host twin (follow-on): `jtbd-liveness-floor-dm` / `-channel` with
  `SWITCHROOM_SILENCE_FLOOR_MS` lowered so the beat lands within test
  wall-clock. Design: `reference/rfcs/turn-liveness-primitive.md`.
- **Deterministic card climb on a silent tool (DM + channel)** —
  `jtbd-liveness-climb-dm`, `jtbd-liveness-climb-channel`. *Watch:* a 40s
  silent `Bash` call (no tool label, no narration) edits the SAME activity
  card ≥4 times with a non-decreasing `Working · Ns` elapsed; a mid-turn ping
  never fires. *Invariant:* dead air between visible updates never exceeds
  the Phase-1 bound (~6-12s); a frozen/repeated elapsed value across all
  edits is a hard failure — the exact pre-fix freeze. Design:
  `reference/rfcs/deterministic-turn-liveness.md` Phase 1 + Phase 4a.
- **Narration survives the climb (DM + channel)** — `jtbd-liveness-narration-dm`,
  `jtbd-liveness-narration-channel`. *Watch:* when the model DOES narrate
  mid-turn, its own words land on the card (not overwritten by the climb) and
  a mid-turn ping never fires. *Invariant:* the climb only fills gaps the
  model leaves; narration is unregressed.
- **Dark-turn fallback fires exactly once (DM + channel)** —
  `silent-end-recovery-dm`, `silent-end-recovery-channel`. *Watch:* a turn
  that ends without a delivered reply gets exactly one fallback message on
  the real surface (not a stubbed decision). *Invariant:* the `exhausted`
  latch gives fire-once; asserted transport-side, in a DM and a supergroup
  alike. Design: `reference/rfcs/deterministic-turn-liveness.md` Phase 2.
- **Dead-air bound across turn shapes, live-transport scaffold (DM)** —
  `fuzz-liveness-climb-dm` (`uat-fuzz`, non-required). *Watch:* a handful of
  hand-picked silent-tool shapes never exceed the dead-air bound and never
  buzz mid-turn. *Scope note:* the full randomized message-timing × tool-churn
  × sub-agent-fan-out × surface corpus lives at the decision layer
  (`turn-liveness-invariant.test.ts`, 2000 shapes, every CI run); a
  same-breadth LIVE corpus is not yet authored (quota + wall-clock cost) —
  tracked as a follow-up in `reference/rfcs/deterministic-turn-liveness.md`
  Known gaps.
- **Restart mid-conversation (DM + channel)** —
  `jtbd-message-during-restart-dm` / `-channel`,
  `jtbd-always-on-after-restart-dm`, `jtbd-interrupted-turn-resumes-dm`.
  *Watch:* the user is told what was interrupted and the work resumes.
  *Invariant:* a restart never swallows an in-flight turn or an inbound
  silently.
- **Worker-pin lifecycle + restart reset (DM, #3001)** —
  `jtbd-worker-pin-lifecycle-dm`. *Watch:* the `🛠 Worker` message is silently
  pinned while a background dispatch runs and unpinned after it completes;
  with a forced gateway restart mid-dispatch, the orphaned worker pin is
  unpinned by the next boot's sweep. Observers must filter pin/unpin service
  events (`observePins`), not message edits — the card EDITS in place while
  pinned. *Invariant:* the restart rule — no work-scoped pin survives its
  work's death; a worker pin never outlives its worker by more than the
  reaper interval (mid-session) or one boot (restart). Decision-layer twins:
  `telegram-plugin/tests/worker-pin-reaper.test.ts`,
  `status-pin-store.test.ts` (tool-pin TTL rows + retry-safe boot sweep),
  `activity-card-store.test.ts` (retry-safe unpin retention).
- **Status-ask rate (DM)** — `jtbd-status-query-dm`, `fuzz-status-ask-dm`.
  *Watch:* the user rarely needs to ask; when they do, it's answered as a
  real question. *Invariant:* status-ask rate is the lagging KPI for this
  job (`inbound_status_query` in `docs/posthog.md`); non-zero is a defect
  signal, not a feature request.

**Fuzz corpus:** vary message timing × turn length × tool churn × sub-agent
fan-out × restart-mid-turn × surface (DM vs forum channel). The invariants
above must hold across the corpus: always an ambient ack, never silent,
never a parallel surface, fallback at most once and never on a
visibly-progressing turn.

## Verdict

- **Done when:** the user always knows the agent heard them, can tell
  working from stuck, and never needs to ask "what are you doing?", proven
  across DM and channel by the scenarios above.

## Production-readiness

- *Latency:* the ambient ack lands within ~1s (p95) of the inbound arriving.
- *Reliability:* no terminal state (success, failure, crash, restart) leaves
  the user in silence; the silence fallback is the floor, bounded to one
  fire per turn.
- *Surface parity:* every signal is proven in both DM and forum channel.
  Channel-routing bugs hid for months while UAT was DM-only.

## Related

- [`steer-or-queue-mid-flight`](steer-or-queue-mid-flight.md) — acting on the
  agent once you can see what it's doing; includes the mid-flight busy ack
  (a quick question asked while the agent is stuck inside one long tool
  call gets a silent ack naming the blocking activity within seconds,
  proven by `jtbd-midflight-busy-ack-dm`).
- [`track-plan-quota-live`](track-plan-quota-live.md) — the other
  answered-in-the-chat, never-a-dashboard signal.
- [`see-my-whole-fleet-from-one-screen`](see-my-whole-fleet-from-one-screen.md) —
  the operator counterpart, and why it must never become this principal surface.

---

> **Implementation:** `reference/rfcs/conversational-pacing.md` (the design
> artifact, `serves:` this job) and `profiles/_shared/telegram-style.md.hbs`
> (the prompt). Those churn; this job outlives them.
