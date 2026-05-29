---
job: know what my agent is actually doing
outcome: At any moment during a turn, the user can see what the agent is up to and why, without asking.
stakes: If the user can't see it, they can't trust it. If they can't trust it, they stop using the product.
---

# The job

A user sends a non-trivial message. The agent is off doing something:
reading files, running tools, maybe handing off to sub-agents. The user
wants to know whether it's going somewhere useful, whether it's stuck,
or whether it's doing something unexpected.

Most agent products give them nothing. Message goes in, eventually a
message comes back, the middle is a black box. The job is to fix that.

The right fix is **not a separate "progress surface" running in
parallel to the conversation.** Earlier versions of this doc prescribed
that — a pinned two-zone status card that owned ambient, structured,
and narrative signals at once. We retired the card in #1122 (PR3)
after a long incident pattern where the card was either redundant (the
user could see the answer faster than the card refreshed), confusing
(the card appeared after the final answer due to send ordering), or
empty (the card was the safety net for a model that doesn't know how
to say "still working"). The card was doing one useful job: covering
for the model when it failed to communicate. Build the model to
communicate; let the framework be the safety net, not the headline.

The shape now is three layers, in priority order:

## 1. Ambient — the reaction lifecycle

The status reaction on the user's *own* inbound message is the
always-on liveness signal. It fires within ~800ms of the message
arriving (👀 received, sub-second), reflects current turn activity through
working states (🤔 thinking, ✍ tool, 👨‍💻 coding, ⚡ web lookup),
and resolves on turn end (👍). It's free, glanceable, lives on the
user's message (not competing with the conversation), and never
disappears mid-turn. This is the primary signal that "the agent is
alive."

The reaction is a **reflective state machine**, not a linear ratchet
(#1713). Working states cycle freely and bidirectionally — the same
state can re-enter multiple times within one turn, no state is
"higher" than another, and mid-turn replies (ack or final answer)
are non-events for the reaction. Only turn completion finalizes the
reaction to 👍. Sending a message is not a state transition; the
reaction reflects what the agent is doing, not what just landed in
the chat.

😱 is the non-terminal error reaction: recovery to a working state
from 😱 is allowed; only turn completion ends the controller. A stall
escalates the reaction (😨) so the user can tell idle from stuck at a
glance. The reaction is also where time-to-ack is measured — see the
`inbound_ack` event in `docs/posthog.md`.

See the ambient layer design contract at
`reference/conversational-pacing.md`.

## 2. Conversational — the chat itself is the artifact

The agent's replies *are* the structured + narrative signal. A
competent chat partner does this naturally:

- **Soft commit** when work will take >15s: *"let me check, back in a
  few."* Sent via `reply`, no progress widget needed.
- **Mid-turn updates at meaningful punctuation**, not on a cadence:
  finished a hard step, hit a blocker, pivoting, dispatching a
  sub-agent, found something worth surfacing. Each is a real `reply`,
  silent (`disable_notification: true`) so the device only pings on
  the final answer.
- **Sub-agent narration** in chat: *"spinning up @reviewer to look at
  this"* → *"@reviewer says: ship it, one nit on the logging."* Fleet
  visibility is a story the conversation tells.
- **The final answer** as a fresh `reply` (pings once).

A user scrolling back a week later reads a real conversation, not a
deleted card. Power users who want the technical receipt can pull the
runtime metrics JSONL or use a future `/lasttrace` command — the
escape hatch, not the headline.

The prompt that teaches this rhythm lives at
`profiles/_shared/telegram-style.md.hbs`.

## 3. Safety net — the 300s framework fallback

The model is the chat partner; the framework catches it only when it
falls *completely* silent. One clock, one threshold:

- **300s silence → framework fallback.** The gateway itself sends a
  user-visible *"still working… (no update from agent in N min)"* or
  *"still thinking…"* **and** unwedges the turn (clears the turn state,
  drains buffered inbound). Fires at most once per turn. Pings once.

That's the whole net. The earlier model-targeted nudge ladder (an ack
poke at 10s, soft at 75s, firm at 180s) and the 60s user-visible
awareness ping were **retired** — the live-updating reply/draft now
carries the acknowledgement and progress beats natively (the user
watches the message compose itself), so a timer-fired nudge on top of
it was redundant noise. What the draft genuinely *can't* do is break a
turn that wedged with no output at all; that's the one job the 300s
fallback keeps.

The full design contract lives at
`reference/conversational-pacing.md`. Kill switch:
`SWITCHROOM_DISABLE_SILENCE_POKE=1`.

## Signs it's working

- The user gets an ambient signal that the agent heard them, effectively
  instantly. No silent gap between "I sent it" and "something's happening."
- The ambient signal distinguishes phases at a glance — acknowledged,
  thinking/working, actively editing code.
- Fast replies don't pay structured-progress overhead. The answer
  itself is the signal — no widgets, no pinned status, just the reply.
- The user can tell running from stuck at a glance. A stuck agent
  visibly escalates (reaction → 😨; framework fallback at 5min).
- A user who scrolls back after the fact reads a real conversation,
  with the agent's narration of meaningful punctuation points
  preserved. The work leaves a receipt — *in the chat*.
- When the agent pivots, hits a wall, or finishes a chunk, the user
  hears about it in plain language as a real reply.
- Sub-agent dispatches and reports are narrated in chat, in the same
  thread as the parent's work. No separate surface to hunt for.
- When a turn fails (crash, out of context, whatever), the user gets a
  real message explaining what happened. Failure modes are never silent.
- When the agent comes back up after a restart, the user knows it came
  back and what it came back as.
- **The user never feels the need to ask "status?", "what are you
  doing?", "still there?", "any update?". If they do, the product is
  failing at its core job.** Any time this happens it is a
  product-defect signal, not a feature request — and it's now the
  literal primary lagging KPI for this JTBD (see `inbound_status_query`
  event in `docs/posthog.md`).

## Anti-patterns: don't build this

- **A separate progress surface running parallel to the conversation.**
  This was the v2 status card. Retired in #1122. It always devolved
  into either redundant noise (it duplicates the chat) or implicit
  safety-net (it covers for the model not chatting). Make the model
  chat.
- **Narrating every tool call as a new chat message.** Tool churn isn't
  information the user can act on. Silence during tool-calling is fine
  — the reaction signals alive. Mid-turn updates are for meaningful
  punctuation, not cadence.
- **Mid-turn updates that ping the device.** Cheap to turn off
  (`disable_notification: true`). Doing it wrong creates notification
  fatigue, which trains users to mute the bot.
- **Collapsing "acknowledged," "thinking/working," and "actively
  editing" into a single undifferentiated ambient signal.** Lose the
  phase signal and the reaction becomes useless.
- **Hiding progress behind a command or a button.** If the user has to
  ask, the product has already failed. The chat itself is the surface.
- **Showing raw debug output (JSON, stack traces, prompt text) in place
  of a human-readable message.** Developer-facing, not user-facing.
- **Sub-agent work happening on a surface the parent never references.**
  Hide-and-seek with your own work. Narrate dispatches in chat.
- **Silent failure of any kind.** If the agent got stuck, hit a limit,
  crashed, or restarted, *say something*. The framework fallback at
  5min is the last-resort floor, but the model should beat it.

## UAT prompts

For agents building or evaluating switchroom. Fire each, watch the
experience, not just the reply.

- **Long, multi-step work.** Ask for something that will take many tool
  calls over 30+ seconds. The user should hear at least one soft-commit
  / mid-turn update. The status reaction escalates. No silence-poke
  fallback fires (`silence_fallback_sent` event in PostHog should be
  rare).
- **Short one-shot.** Ask a trivial question. The reply arrives as a
  plain answer — no soft-commit ceremony, no widgets. The ambient
  reaction alone carries the "I'm on it" beat. TTFO is well under 30s.
- **Delegated work.** Ask for something that should route to a
  sub-agent. The parent agent narrates the dispatch in chat
  ("spinning up @reviewer") and summarises when the child reports back.
- **Parallel work in one chat.** Fire two tasks close together in
  different contexts. Each should get its own legible thread of replies.
- **Genuine stall.** Force a long stall with no output at all.
  Reaction escalates to 😨. At 300s the framework fallback fires a
  user-visible message and unwedges the turn. (A turn that's visibly
  composing a draft should never reach this — any outbound, including
  the draft's first edit, resets the clock.)
- **Failure path.** Force a recoverable failure (e.g. running out of
  context). The user should get a real explanation in a `reply` with
  `accent: 'issue'`, not silence.
- **Restart mid-conversation.** Restart the agent while the user is
  active. The wake-audit / pending-turn protocol kicks in — the user
  gets a real message describing what was interrupted.
- **Course correction mid-task.** Send a follow-up that changes
  direction. The next reply should explicitly acknowledge the steer
  ("↪️ Treating as steer on the prior task") rather than continuing
  silently.
- **Status-ask rate.** Over a sample of real sessions, count how often
  the user types "status?", "still there?", or anything similar. Target:
  <0.5% of inbound. Non-zero rate is a debug-worthy signal. The
  `inbound_status_query` event in PostHog measures this directly.
- **Background dispatch + continue.** Spawn a background sub-agent,
  then send a different request. The background agent narrates
  completion in chat when it finishes — no separate surface needed.
- **Soft-commit threshold.** Ask for something that obviously will take
  >15s. The first reply should be a one-liner ("on it, back in a few")
  not the immediate answer attempt.
- **Framework-fallback rarity.** Force a long tool-churn period. The
  live-updating draft should keep the user oriented the whole time, so
  the 300s framework fallback should *not* fire (`silence_fallback_sent`
  stays near zero). A fallback firing on a turn that was visibly
  composing is the regression signal.
