---
artefact: Telegram conversational pacing + silence-poke safety net
serves: `know-what-my-agent-is-doing.md`
status: design v2 — the five-beat human-feel model (supersedes v1's card-era pacing)
---

# Conversational pacing — design contract

Switchroom's turn UX is built around one premise: **messaging an agent
should feel like messaging a capable human.** The chat itself is the
artifact — framework UI elements (cards, pinned widgets, status bars)
only paper over the model failing to communicate. Build the model to
communicate like a person; let the framework carry ambient liveness
and the safety net, not the headline.

This is **design v2.** v1 (#1122) retired the pinned progress card and
declared "the chat is the artifact" — correct — but kept a *card-era*
pacing instinct ("don't fill silence", "the reaction signals alive",
"silence is valid"). That was right *while the card existed* — the
card carried progress, so a status `reply` was redundant. With no
card, the same instinct is just a black box. v2 re-founds pacing on
the five beats below and removes the contradiction.

## Three layers

| Layer | Purpose | Owns | Implementation |
|---|---|---|---|
| Ambient | "Is it alive?" — glance-level liveness | The 👀→🤔→✍→👍 status reaction on the user's inbound message **and** a continuous `typing…` chat-action held for the whole turn | `telegram-plugin/status-reactions.ts` + `gateway.ts:startTurnTypingLoop` (started at turn-start, stopped by `purgeReactionTracking`) |
| Conversational | "What is it doing? What did it find?" — meaningful state changes | The agent's own `reply` calls, paced by the five beats | `profiles/_shared/telegram-style.md.hbs` + the append-prompt block in `scaffold.ts` + `disable_notification` parameter |
| Safety net | "Why has it gone quiet?" — framework backstop when the model fails to chat | The silence-poke subsystem: 75s/180s/300s ladder | `telegram-plugin/silence-poke.ts` |

These are priorities. Ambient is always on. Conversational does the
heavy lifting. Safety net only fires when the model isn't doing its
job.

## The five beats (the prompt teaches this)

Messaging an agent should feel like messaging a capable colleague. The
model — not a framework widget — carries this, via its own `reply`
calls, in five beats:

1. **Acknowledge first.** Unless the whole reply is a single short
   sentence to send immediately (*"what's 2+2"*), the first action on
   any turn is a short `reply` in persona voice — *"on it — checking
   now"* — before the work starts. The gate is answer length, **not**
   whether tools are involved: a turn that is pure reasoning but will
   run to a paragraph still acks first. Skipped only for the immediate
   one-sentence answer.
2. **Go quiet and work.** Heads-down is correct. No narration of
   individual tool calls. Ambient liveness — the status reaction and
   the typing indicator — covers "still alive"; the model does not.
3. **Surface meaningful progress** at genuine inflection points — a
   hard step done, a blocker, a pivot, a sub-agent dispatched, a
   notably slow wait, a finding worth knowing now. A fresh `reply`,
   `disable_notification: true`. **Human-style prose, never raw tool
   narration** — *"the migration's running — slow one"*, not *"calling
   Bash"* or *"Read(config.ts)"*.
4. **Hand back delegations with synthesis.** When a sub-agent reports
   back, the main agent re-enters in its own voice — what the
   sub-agent found, and the next step — *"reviewer flagged the auth
   gap; fixing it now"*. The sub-agent's raw report is never the
   user-facing reply. A foreground sub-agent's result lands in the
   parent's own turn (a PostToolUse hook nudges the synthesis); a
   *background* worker finishes after the turn ends, so the gateway
   wakes the agent with a `<channel source="subagent_handback">` turn
   carrying the result. Either way the model owns the prose — the
   framework only delivers the cue.
5. **Deliver the answer** as a fresh `reply` (omit
   `disable_notification` — pings the device once).

The single guardrail is **anti-spam, not pro-silence**: no reply per
tool call, no cadence timer, no repeating yourself. Responsive and
human, never a flood. Going quiet *during* focused work (beat 2) is
correct; going quiet *instead of* acknowledging (beat 1) or *instead
of* a real milestone (beats 3–4) is the black box this prevents.

## Silence-poke ladder

The framework backstops the model. State per-turn:
`{ turnStartedAt, lastOutboundAt, pokesFired, pokeArmed, ackPokeFired,
subagentDispatchActive, lastThinkingAt, fallbackFired,
lastPokeFiredAt, inFlightTools }`. Polled every 5s.

| Threshold | Action | Wire |
|---|---|---|
| 10s | **Ack poke** armed — *only* when nothing has been sent this turn yet (`lastOutboundAt == null`). Nudges the model to send its own short verbal acknowledgement. One-shot per turn (`ackPokeFired`). | Same mechanism as soft/firm |
| 75s | Soft poke armed. `<system-reminder>` block appended to next tool result. | `silence-poke.ts → consumeArmedPoke()` drained at `gateway.ts:onToolCall` chokepoint |
| 180s | Firm poke armed (stronger wording). | Same mechanism |
| 300s | Framework fallback: gateway sends a user-visible *"still working… (no update from agent in N min)"* or *"still thinking…"*. Pings. | `silencePoke.startTimer.onFrameworkFallback` callback |

**Ack budget (10s).** A person answers in a beat; the framework
enforces that baseline. The ack poke measures *"have you said
anything at all this turn"* (`lastOutboundAt == null`) — distinct
from soft/firm, which measure silence-*since-last-outbound*. It sits
**outside** the `pokesFired` ladder: a turn that still never acks
escalates soft → firm → fallback on exactly the same schedule. The
framework owns the *beat*; the model authors the words (see the
"Open with an acknowledgement" bullet in
`profiles/_shared/telegram-style.md.hbs`). Ack-poke *success* is not
metered — the `silence_poke_fired level=ack` rate is the signal:
how often the model had to be nudged.

**Subagent-dispatch override:** when the session stream emits a
`tool_use` for `Task` or `Agent`, the soft threshold extends to 300s
for that turn (a parent narrating "spinning up @reviewer" then waiting
shouldn't get poked at 75s — the wait is legitimate). The flag
persists until `endTurn` so subsequent narration outbound messages
don't reset the extended threshold.

**Thinking detection:** session stream `kind: 'thinking'` events
update `lastThinkingAt`. If the framework fallback fires within 30s
of a thinking event, wording switches to *"still thinking…"*.

**Wording is load-bearing.** Exact strings live in
`silence-poke.ts:formatPokeText`. Two principles:
1. The soft poke text says "skip the update if you're about to
   finish within seconds" — without it, the model will dutifully send
   "still working" 5 seconds before the answer lands.
2. The framework fallback parenthetical *"(no update from agent in N
   min)"* is honest — distinguishes from "the agent said something"
   so users learn to trust real agent messages. N is derived from
   `ctx.silenceMs`, not hard-coded.

**Kill switch:** `SWITCHROOM_DISABLE_SILENCE_POKE=1` disables the
whole subsystem. The conversational-pacing prompt still applies; only
the safety net is off. Useful for testing the prompt in isolation.

## KPIs

Primary signals for whether the design is working, all measured via
the runtime-metrics events documented in `docs/posthog.md`:

| KPI | Source events | Target | What it means |
|---|---|---|---|
| **Status-query rate** (primary lagging) | `inbound_status_query` | <0.5% of inbound | Every fire = JTBD failure |
| **Outbound silence p95** (primary leading) | `turn_ended.longest_silent_gap_ms` for `duration_ms > 30000` | <120s | Above this, users start asking |
| **TTFO p95** | `turn_ended.ttfo_ms` for `outbound_count > 0` | <30s | The opening ack (beat 1) should land fast |
| **Silence-poke success rate** | `silence_poke_succeeded / silence_poke_fired` | >80% | Below = prompt-engineering broken |
| **Framework fallback rate** | `silence_fallback_sent / turn_ended` | <5 per 1000 | Above = model is failing, fundamentally |

A `Switchroom Runtime` PostHog dashboard tracks all five. Wire-up
documented in `docs/posthog.md`.

## Anti-patterns (don't reintroduce)

- A separate pinned UI element that mirrors the conversation. Strong
  pull, but always devolves into either redundant noise or implicit
  safety-net. Use the chat.
- Narrating every tool call as a `reply`, **or** narrating with raw
  tool names. Beat 3 is human-style prose at real inflection points —
  not a message per call, and never *"calling Grep"* / *"Read(x)"*.
  Ambient liveness handles "alive"; the chat is for *information*.
- Mid-turn updates that ping. `disable_notification: true` is free; use it.
- Cadence-based "still working" updates. The model speaks at genuine
  punctuation (beats 3–4), not on a timer.
- Forwarding a sub-agent's raw report as the user-facing reply. The
  main agent always re-enters in its own voice with synthesis (beat 4).
- Periodic emoji decoration of replies. The reaction lifecycle is the
  emoji surface. Replies are prose.

## Open follow-ups (post-#1122)

- The status-reaction lifecycle could simplify from 4 intermediate
  states (`thinking/tool/code/done`) to 2 (`alive / done`) since the
  intermediate phases are now less load-bearing — but the cost of
  keeping the full lifecycle is essentially zero. Defer.
- A `/lasttrace` Telegram command for power users who want the
  technical receipt (tool calls, durations) on demand. Hindsight
  already captures the data; the command is purely a surfacing.
- `switchroom debug turn` extension that dumps silence-poke fires and
  their text alongside the existing turn dump. Useful for tuning the
  prompt.

These are nice-to-have. The core redesign is complete.
