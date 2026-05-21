---
artefact: Telegram conversational pacing + silence-poke safety net
serves: `know-what-my-agent-is-doing.md`
status: design v1 — supersedes the pinned progress card (#1122)
---

# Conversational pacing — design contract

Switchroom's turn UX is built around the premise that **the chat
itself is the artifact.** Framework UI elements (cards, pinned
widgets, status bars) cover for the model's failure to communicate.
Build the model to communicate; let the framework be the safety net,
not the headline. This doc is the design contract for the
implementation shipped in #1122 PRs 1–4.

## Three layers

| Layer | Purpose | Owns | Implementation |
|---|---|---|---|
| Ambient | "Is it alive?" — glance-level liveness | The 👀→🤔→🔥→👍 status reaction on the user's inbound message | `telegram-plugin/status-reactions.ts` |
| Conversational | "What is it doing? What did it find?" — meaningful state changes | The agent's own `reply` calls, paced by the conversational-pacing prompt | `profiles/_shared/telegram-style.md.hbs` + `disable_notification` parameter |
| Safety net | "Why has it gone quiet?" — framework backstop when the model fails to chat | The silence-poke subsystem: 75s/180s/300s ladder | `telegram-plugin/silence-poke.ts` |

These are priorities. Ambient is always on. Conversational does the
heavy lifting. Safety net only fires when the model isn't doing its
job.

## Conversational rhythm (the prompt teaches this)

- **Soft commit** if the work will take >15s: one short `reply` to set
  expectation, *"let me check, back in a few."* Skip for fast turns.
- **Mid-turn updates** at *meaningful punctuation*, not on a cadence.
  Finished a hard step, hit a blocker, pivoting, dispatching a
  sub-agent, found something worth surfacing now. Each is a fresh
  `reply` with `disable_notification: true` — silent on the device.
- **Sub-agent narration** in chat at dispatch *and* on reply:
  *"spinning up @reviewer to look at this"* → *"@reviewer says: ship
  it."*
- **Final answer** as a fresh `reply` (omit `disable_notification` or
  pass false — pings the device once).
- **No periodic "still working" replies** to fill silence. The reaction
  signals alive. Cadence-driven updates train users to ignore the bot.

## Silence-poke ladder

The framework backstops the model. State per-turn:
`{ turnStartedAt, lastOutboundAt, pokesFired, pokeArmed, ackPokeFired,
subagentDispatchActive, lastThinkingAt, fallbackFired,
lastPokeFiredAt }`. Polled every 5s.

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
| **TTFO p95** | `turn_ended.ttfo_ms` for `outbound_count > 0` | <30s | Soft commits should land fast |
| **Silence-poke success rate** | `silence_poke_succeeded / silence_poke_fired` | >80% | Below = prompt-engineering broken |
| **Framework fallback rate** | `silence_fallback_sent / turn_ended` | <5 per 1000 | Above = model is failing, fundamentally |

A `Switchroom Runtime` PostHog dashboard tracks all five. Wire-up
documented in `docs/posthog.md`.

## Anti-patterns (don't reintroduce)

- A separate pinned UI element that mirrors the conversation. Strong
  pull, but always devolves into either redundant noise or implicit
  safety-net. Use the chat.
- Narrating every tool call as a `reply`. The reaction handles
  liveness; the chat is for *information*. If a tool call doesn't
  produce information the user can act on, it shouldn't produce a
  message.
- Mid-turn updates that ping. `disable_notification: true` is free; use it.
- Cadence-based "still working" updates. The model decides when to
  speak based on punctuation, not on a timer.
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
