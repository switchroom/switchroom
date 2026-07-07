---
artefact: Telegram conversational pacing + silence-poke safety net
serves: know-what-my-agent-is-doing
status: design v2 — the five-beat human-feel model (supersedes v1's card-era pacing)
---

# Conversational pacing — design contract

Switchroom's turn UX is built around one premise: **messaging an agent
should feel like messaging a capable human.** The chat itself is the
artifact. Framework UI elements (cards, pinned widgets, status bars)
only paper over the model failing to communicate. Build the model to
communicate like a person; let the framework carry ambient liveness
and the safety net, not the headline.

This is **design v2.** v1 (#1122) retired the pinned progress card and
declared "the chat is the artifact" (correct) but kept a *card-era*
pacing instinct ("don't fill silence", "the reaction signals alive",
"silence is valid"). That was right *while the card existed*. The
card carried progress, so a status `reply` was redundant. With no
card, the same instinct is just a black box. v2 re-founds pacing on
the five beats below and removes the contradiction.

## Three layers

| Layer | Purpose | Owns | Implementation |
|---|---|---|---|
| Ambient | "Is it alive?" — glance-level liveness | The 👀→🤔→✍→👍 status reaction on the user's inbound message **and** a continuous `typing…` chat-action held for the whole turn | `telegram-plugin/status-reactions.ts` + `gateway.ts:startTurnTypingLoop` (started at turn-start, stopped by `purgeReactionTracking`) |
| Conversational | "What is it doing? What did it find?" — meaningful state changes | The agent's own `reply` calls, paced by the five beats | `profiles/_shared/telegram-style.md.hbs` + the append-prompt block in `scaffold.ts` + `disable_notification` parameter |
| Safety net | "Is this turn dead?" — framework backstop that unwedges a genuinely stuck turn | The silence-poke subsystem: a single 300s fallback that sends one user-visible message **and** unwedges the turn | `telegram-plugin/silence-poke.ts` |

These are priorities. Ambient is always on. Conversational does the
heavy lifting. Safety net only fires when a turn is genuinely stuck.

> **What the safety net used to be (and why it shrank).** Earlier
> versions of this layer ran a model-targeted *nudge ladder*: an ack
> poke at 10s, a soft poke at 75s, a firm poke at 180s, each appended
> as a `<system-reminder>` to the next tool result, plus a 60s
> user-visible *awareness ping*. They were retired (the nudge-ladder
> retirement PR) for two reasons. (1) **They didn't work by their own
> KPI:** the `silence_poke_succeeded / silence_poke_fired` rate sat at
> 0–7% across the fleet against a >80% target. A `<system-reminder>`
> on a tool result can't reliably make the model stop and talk. (2)
> **The job moved.** The live-updating reply/draft (the thinking-lane
> draft that edits in place, see beat-1/beat-3 below and the
> `sendMessageDraft` transport) now carries the acknowledgement and
> progress beats natively. The user watches the message compose itself
> rather than waiting for a framework nudge to provoke one. A timer-
> fired "still working" nudge on top of that is the exact cadence-based
> update the Anti-patterns section bans. What remains is the one thing
> the draft genuinely can't do: break a turn that has wedged with no
> output at all. That's the 300s fallback.

## The five beats (the prompt teaches this)

Messaging an agent should feel like messaging a capable colleague. The
model carries this, not a framework widget, via its own `reply`
calls, in five beats:

1. **Acknowledge first.** Unless the whole reply is a single short
   sentence to send immediately (*"what's 2+2"*), the first action on
   any turn is a short `reply` in persona voice (*"on it, checking
   now"*) before the work starts. The gate is answer length, **not**
   whether tools are involved: a turn that is pure reasoning but will
   run to a paragraph still acks first. Skipped only for the immediate
   one-sentence answer.
2. **Go quiet and work.** Heads-down is correct. No narration of
   individual tool calls. Ambient liveness (the status reaction and
   the typing indicator) covers "still alive"; the model does not.
3. **Surface meaningful progress** at genuine inflection points: a
   hard step done, a blocker, a pivot, a sub-agent dispatched, a
   notably slow wait, a finding worth knowing now. A fresh `reply`,
   `disable_notification: true`. **Human-style prose, never raw tool
   narration.** *"the migration's running, slow one"*, not *"calling
   Bash"* or *"Read(config.ts)"*.
4. **Hand back delegations with synthesis.** When a sub-agent reports
   back, the main agent re-enters in its own voice: what the
   sub-agent found, and the next step. *"reviewer flagged the auth
   gap; fixing it now"*. The sub-agent's raw report is never the
   user-facing reply. A foreground sub-agent's result lands in the
   parent's own turn (a PostToolUse hook nudges the synthesis); a
   *background* worker finishes after the turn ends, so the gateway
   wakes the agent with a `<channel source="subagent_handback">` turn
   carrying the result. Either way the model owns the prose; the
   framework only delivers the cue.
5. **Deliver the answer** as a fresh `reply` (omit
   `disable_notification`, pings the device once).

The single guardrail is **anti-spam, not pro-silence**: no reply per
tool call, no cadence timer, no repeating yourself. Responsive and
human, never a flood. Going quiet *during* focused work (beat 2) is
correct; going quiet *instead of* acknowledging (beat 1) or *instead
of* a real milestone (beats 3–4) is the black box this prevents.

## Silence-poke fallback

The framework backstops the model with **one timer**, no ladder. State
per-turn: `{ turnStartedAt, lastOutboundAt, lastThinkingAt,
fallbackFired, inFlightTools }`. Polled every 5s.

| Threshold | Action | Wire |
|---|---|---|
| 300s | Framework fallback: gateway **unwedges the turn** (clears `activeTurnStartedAt`, nulls `currentTurn`, drains buffered inbound). The generic *"still working… (no update from agent in N min)"* / *"still thinking…"* stall message is **no longer sent** — it was a stop-gap from before the live-updating draft carried the progress beats natively, and is the exact cadence-based "still working" update the Anti-patterns section bans (retired in the stall-stop-gap PR). The fallback now sends a user-visible message in only two honest cases: an in-flight `update_apply` carries hostd's real phase/elapsed, or the turn is parked on an approval card (the loud *"waiting for your approval — tap Approve or Deny…"* re-ping). The `silence_poke_fire` event is still logged regardless, so observability + the wedge accounting are unchanged. | `silencePoke.startTimer.onFrameworkFallback` callback |

The fallback fires purely on the silence clock (`now -
(lastOutboundAt ?? turnStartedAt) >= 300s`) and once per turn
(`fallbackFired`). It is **not a nudge**: it does not append a
`<system-reminder>` hoping the model will speak; it speaks *for* the
framework (only when there's something honest to say, see the two
cases above) and breaks the wedge. That unwedge is the one job the
live-updating draft genuinely can't do (a turn that produced no
output at all has no draft to watch), which is why this single beat
survived the nudge-ladder retirement (see the blockquote under "Three
layers"). Any outbound, including the draft's first edit, resets the
clock, so a turn that's visibly composing never trips it.

**Thinking detection:** session stream `kind: 'thinking'` events
update `lastThinkingAt`. If the framework fallback fires within 30s
of a thinking event, wording switches to *"still thinking…"*.

**Tool-aware enrichment (#1292), retired with the stall notice.** The
gateway still tracks in-flight tools in `inFlightTools`
(`noteToolStart` / `noteToolEnd` / `noteToolLabel` off the session
stream) for metrics, but the *"running Grep \"foo\" for 4m"* enrichment
of the stall message is gone along with the stall message itself: a
timer-fired tool-narration ping is the same banned cadence-based update.
Tool churn never moved the 300s timing and still doesn't.

**Wording is load-bearing.** Exact strings live in
`silence-poke.ts:formatFrameworkFallbackText`, which now returns `null`
for every stall variant (the stop-gap is retired) and a string only for
the approval-blocked re-ping. The parenthetical *"(N min)"* on that
re-ping is honest. N is derived from `ctx.silenceMs`, not hard-coded.

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
| **Framework fallback rate** | `silence_fallback_sent / turn_ended` | <5 per 1000 | Above = model is failing, fundamentally |

A `Switchroom Runtime` PostHog dashboard tracks these four. Wire-up
documented in `docs/posthog.md`. (The retired
`silence_poke_succeeded / silence_poke_fired` ratio is gone. The
nudge ladder it measured no longer exists; the surviving fallback is
metered only by its *fire* rate, which is meant to stay near zero.)

## Anti-patterns (don't reintroduce)

- A separate pinned UI element that mirrors the conversation. Strong
  pull, but always devolves into either redundant noise or implicit
  safety-net. Use the chat.
- Narrating every tool call as a `reply`, **or** narrating with raw
  tool names. Beat 3 is human-style prose at real inflection points,
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
  intermediate phases are now less load-bearing, but the cost of
  keeping the full lifecycle is essentially zero. Defer.
- A `/lasttrace` Telegram command for power users who want the
  technical receipt (tool calls, durations) on demand. Hindsight
  already captures the data; the command is purely a surfacing.
- `switchroom debug turn` extension that dumps silence-poke fires and
  their text alongside the existing turn dump. Useful for tuning the
  prompt.

These are nice-to-have. The core redesign is complete.
