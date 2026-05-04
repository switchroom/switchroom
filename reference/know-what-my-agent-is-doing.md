---
job: know what my agent is actually doing
outcome: At any moment during a turn, the user can see what the agent is up to and why, without asking.
stakes: If the user can't see it, they can't trust it. If they can't trust it, they stop using the product.
---

# The job

A user sends a non-trivial message. The agent is off doing something: reading
files, running tools, maybe handing off to sub-agents. The user wants to
know whether it's going somewhere useful, whether it's stuck, or whether
it's doing something unexpected.

Most agent products give them nothing. Message goes in, eventually a
message comes back, the middle is a black box. The job is to fix that.

The right fix is not a single progress surface, it's a set of
complementary signals. Ambient for "is it alive," structured for "what is
it doing," narrative for "what does it think it's doing and why." Whoever
is building or extending this product should think in those terms, not in
a specific UI.

## Signs it's working

- The user gets an ambient signal that the agent heard them, effectively
  instantly. No silent gap between "I sent it" and "something's happening."
- The ambient signal distinguishes phases at a glance — acknowledged,
  thinking/working, actively editing code. A glance is enough to know
  which phase; the user never has to open a structured surface just to
  answer "what kind of work is happening right now."
- Fast replies don't pay structured-progress overhead. If the agent can
  answer before the user would reasonably start wondering, the answer
  itself is the signal — no progress card, no pinned status, just the
  reply with the ambient reaction carrying the "I'm on it" beat.
- The user can tell running from stuck at a glance. A stuck agent visibly
  escalates, it doesn't just sit there.
- A user who scrolls back after the fact can reconstruct roughly what the
  agent did and in what order. The work leaves a receipt.
- When the agent pivots, hits a wall, or finishes a chunk, the user hears
  about it in plain language, not by inferring it from the absence of
  updates.
- Sub-agent work is visible in the same place as parent work — including
  background sub-agents that outlive the turn that spawned them. The user
  never has to hunt for it, and never loses sight of a background member
  just because the parent turn replied (the #64 fix).
- When a turn fails (crash, out of context, whatever), the user gets a
  real message explaining what happened. Failure modes are never silent.
- When the agent comes back up after a restart, the user knows it came
  back and what it came back as.
- The user never feels the need to ask "status?", "what are you doing?",
  "still there?", "any update?". If they do, the product is failing at
  its core job. Any time this happens it is a product-defect signal, not
  a feature request, and it should be captured as one.

## Status card v2

The current Telegram implementation of these signals is the two-zone
pinned status card. See `reference/status-card-design.md` for the spec.

The card maps directly onto the three signal types named above:

- **Header line** carries the ambient signal — one glance tells the user
  whether the turn is acknowledged, working, paused on a background
  sub-agent, stalled, or done.
- **Parent zone** carries the structured signal — the parent turn's tool
  ring buffer and current step, in a stable shape the user can scan.
- **Fleet zone** carries the narrative signal — one row per sub-agent,
  each with its own short label of what that member thinks it's doing.

Background sub-agents stay pinned to the originating turn's card after
the parent replies, so the user never loses the thread when a member
outlives the turn that spawned it.

## Anti-patterns: don't build this

- One progress surface trying to carry every kind of signal. Ambient,
  structured, and narrative information have different weights. Collapse
  them and you lose signal on all three.
- Narrating every tool call as a new chat message. A wall of bot receipts
  buries the actual conversation.
- Spinning up a structured progress surface for a reply that finishes in
  a couple of seconds. A card that appears and disappears before the
  user's eyes settle on it is pure noise — worse than nothing. Structured
  progress is for turns that actually earn it.
- Collapsing "acknowledged," "thinking/working," and "actively editing"
  into a single undifferentiated ambient signal. If the glance looks the
  same across phases, the glance carries no information and the user is
  forced to open a structured surface to learn what's happening.
- Hiding progress behind a command or a button. If the user has to ask
  what their agent is doing, the product has already failed. A user
  typing "status?" mid-turn is a fail state, not a feature to support.
- Showing raw debug output (JSON, stack traces, prompt text) in place of
  a human-readable step. That's developer-facing, not user-facing.
- Treating model thinking as "not a step." If seconds are ticking by,
  the user needs to know time is moving.
- Overwriting the in-flight status view with the final answer, so the
  record of what happened disappears.
- Sub-agent work happening on a surface the parent never references.
  Hide-and-seek with your own work.
- Silent failure of any kind. If the agent got stuck, hit a limit,
  crashed, or restarted, say something.

## UAT prompts

For agents building or evaluating switchroom. Fire each, watch the
experience, not just the reply.

- **Long, multi-step work.** Ask for something that will take many tool
  calls over 30+ seconds. The user should never wonder if it's alive or
  what stage it's at.
- **Short one-shot.** Ask a trivial question. The reply arrives as a
  plain answer — no structured progress surface appears at all. The
  ambient reaction alone carries the "I'm on it" beat until the answer
  lands. A progress card flashing up and vanishing on a fast reply is a
  failure, not a feature.
- **Delegated work.** Ask for something that should route to a sub-agent.
  The user should see sub-agent progress in the same place as the parent,
  not have to go find it.
- **Parallel work in one chat.** Fire two tasks close together in
  different contexts. Each should have its own legible thread of progress.
- **Genuine stall.** Force a long stall. The experience should
  visibly change so the user knows to intervene, rather than sit and
  wonder.
- **Failure path.** Force a recoverable failure (e.g. running out of
  context). The user should get a real explanation and a sensible next
  step, not silence.
- **Restart mid-conversation.** Restart the agent while the user is
  active. The user should know the agent went down and came back, and
  roughly what it came back as.
- **Course correction mid-task.** Send a follow-up that changes the
  direction. The progress the user sees should reflect the pivot, not
  pretend nothing changed.
- **Status-ask rate.** Over a sample of real sessions, count how often
  the user types "status?", "what are you doing?", "still there?", or
  anything similar. Trend should be near zero. Any non-zero rate is a
  debug-worthy signal that the progress surfaces failed that session.
- **Background dispatch + continue.** Send a request that spawns a
  background sub-agent, then immediately send a different request. The
  original card must keep updating with the background member's progress
  after the second turn replies and unpins its own card.
- **Heavy fleet.** Send a request that spawns 6+ sub-agents in parallel.
  Header counters tick. Fleet zone caps at 5 rows + `N more`. No
  `<blockquote>` 400 in the gateway log (verify via `tg-post` from #659).
- **Stuck detection.** Pause a sub-agent. Within 90s the row glyph flips
  to ⚠ and the label shows `idle <duration>`. If it's the only running
  member, header escalates to ⚠ Stalled.
- **Done semantics.** Parent reply lands but a background sub-agent is
  still running. Header MUST be ⏸ Background, never ✅ Done. After the
  background sub-agent completes, header flips to ✅ Done.
