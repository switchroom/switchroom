---
job: steer or queue while the agent is mid-flight
outcome: The user can correct an in-flight task or file a new independent one, and in both cases the agent treats the message correctly and the user knows which happened.
stakes: If the agent misreads a correction as a new task, work gets dropped. If it misreads a new task as a correction, the wrong thing gets changed. Either failure is invisible until it hurts.
serves: hold-the-leash
invariants: [chat-is-the-single-source-of-truth]
---

# Job Spec: steer or queue while the agent is mid-flight

## The job

The user is half-watching the agent work. Two things can happen: they realise
it's going the wrong way and want to redirect it, or they have a new,
unrelated thing they want done. Both are common, both urgent, both must work.
The job is to make both distinguishable, to the user and to the agent.
Steering is amend-in-place: the current task continues with the new
information folded in. Queuing is a new task: the current one finishes on its
own terms, the new one picks up after, with no context bleeding between them.
Ambiguous input must not silently pick one and hope. The product decides
clearly and says which, or it asks.

> [!CAUTION]
> The worst outcome is the user thinking they steered when they actually
> queued, or the reverse.

> The default for an unmarked mid-turn follow-up was once *steer*; it is now
> *queue*. The job underneath is unchanged: both operations must work and the
> chosen one must be visible.

There is a third mid-flight class: a **quick question that neither steers
nor queues real work** — a status ping, "you there?", a yes/no. It queues
like any unmarked follow-up, but it carries a latency promise the other two
don't: when the running turn is stuck inside one long blocking tool call,
the user must get a visible, silent acknowledgement naming the blocking
activity **within seconds** — a deterministic framework card, not a model
turn — so the question never reads as ignored for the minutes a
`--watch`-style call can take. The ack states the classification ("Queued")
and what it's waiting behind; the real answer follows when the step
finishes.

## Good / bad

**Good looks like**

- A mid-flight follow-up can course-correct the current task, and the change
  shows up in the visible progress, not pretended away, not a silent restart
  from scratch.
- A mid-flight follow-up can be filed as a new task that waits politely, then
  runs, with the current task untouched and no context bleeding in from it.
- Whichever the agent picked, steer or queue, is stated by the agent in the
  chat, so the user reads it, never has to infer it.
- When the input is genuinely ambiguous, the agent makes a reasonable call
  and says which it made, so the user can correct on the next message.
- A mid-flight message during a long tool call gets a visible ack naming
  the blocking activity within seconds, silent (no device ping), and the
  ack is cleaned up once the real answer lands.
- A burst (a forward of several messages, or a long paste Telegram split)
  is treated as one thought with shared context, not answered fragment by
  fragment.
- Nothing the user said is lost: not to a race, not to ambiguity, not to a
  restart.

**Bad looks like: never ship this**

- Silent classification: the agent decides steer-or-queue and never says
  which, leaving the user to guess.
- One-size-fits-both, always treating follow-ups as the same kind, which
  loses one of the two jobs.
- A steer applied at an unsafe point (mid-tool-call), or one that silently
  restarts the task when the user wanted an amendment.
- A queued task that inherits hallucinated context from the task before it.
- Dropping a message because a turn was in flight. The user said something;
  it must count.
- An ack that fires when the agent was seconds from answering — a young
  tool step returns on its own; acking it is noise that trains the user to
  ignore the card.
- No way for the user to override a misclassification and have the correction
  stick.

## Prove it

- **Steer vs queue, classified and narrated (DM)** — `jtbd-rapid-followup-dm`.
  *Watch:* an unmarked follow-up runs as a fresh task; a marked steer folds
  into the in-flight task; the agent narrates which path it took. *Invariant:*
  the chosen classification is always visible in the chat, never inferred.
- **Interrupt-and-replace (DM)** — `jtbd-interrupt-marker-dm`. *Watch:* an
  interrupting follow-up stops the current task and the reply answers the new
  prompt, not the old one. *Invariant:* an interrupt lands at a safe boundary
  and never corrupts the in-flight work.
- **Burst is one thought (DM)** — `jtbd-forwarded-burst-dm`,
  `jtbd-album-coalescing-dm`. *Watch:* several messages sent in quick
  succession are answered as a single turn with shared context. *Invariant:*
  a burst is never fanned out into N racing turns.
- **Nothing dropped under rapid fire (DM)** — `inbound-no-drop-rapid-fire-dm`,
  `jtbd-rapid-followup-dm`. *Watch:* every message fired at the turn boundary
  gets its own reply. *Invariant:* no inbound is dropped to a race or a turn
  in flight.
- **Busy ack behind a long blocking tool call (DM)** —
  `jtbd-midflight-busy-ack-dm`. *Watch:* a mid-turn quick question sent
  while the agent sits inside a deliberately slow blocking Bash gets a
  silent "⏳ Queued — currently inside `<tool>`" ack within seconds, the
  real answer arrives after the step returns, and the ack card is deleted.
  *Invariant:* the ack is deterministic (model-free), says "Queued"
  (classification stays visible), and never fires for a young step.
- **Survives a restart mid-flight (DM)** — `jtbd-interrupted-turn-resumes-dm`.
  *Watch:* a task interrupted by a restart resumes and runs to completion, not
  silently dropped. *Invariant:* a restart never loses an in-flight task, a
  queued follow-up, **or in-flight sub-agent work** — dispatched workers that
  the restart killed are re-dispatched or named as lost on resume, never left
  silently dead under a parent that carried on.

**Fuzz corpus:** vary follow-up intent (steer × queue × interrupt ×
ambiguous) × timing (mid-tool-call × inside long single tool call × at turn boundary × rapid fire) × burst
shape (forward × split paste × album) × restart mid-flight × surface (DM vs
channel). The classification must stay visible and nothing the user said may
be lost, across the corpus.

## Verdict

- **Done when:** the user can steer or queue mid-flight, the agent treats
  each correctly, the user always reads which one happened, and nothing they
  said is lost. Proven by the scenarios above.

## Production-readiness

- *Reliability:* no inbound is dropped to a race, an ambiguity, or a restart;
  a queued or interrupted task survives a bounce.
- *Safety:* a steer or interrupt takes effect at a safe boundary, never
  corrupting an in-flight tool call.

## Related

- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) — seeing the
  in-flight work you're steering or queuing against.
- [`talk-to-agents-from-anywhere`](talk-to-agents-from-anywhere.md) —
  one-handed mid-flight correction from a phone.
- [`survive-reboots-and-real-life`](survive-reboots-and-real-life.md) — how a
  queued or interrupted task survives a restart.
