---
job: steer or queue while the agent is mid-flight
outcome: The user can correct an in-flight task or file a new independent one, and in both cases the agent treats the message correctly and the user knows which happened.
stakes: If the agent misreads a correction as a new task, work gets dropped. If it misreads a new task as a correction, the wrong thing gets changed. Either failure is invisible until it hurts.
---

# The job

The user is half-watching the agent do something. Two things can happen:
they realise the agent is going the wrong way and want to redirect it,
or they have a new, unrelated thing they want done. Both are common,
both are urgent, both need to work. The job is to make both distinguishable,
to the user and to the agent.

Steering is amend-in-place. The current task continues, with the new
information incorporated. Queuing is a new task. The current task finishes
on its own terms, and the new one picks up after. These are different
operations with different outcomes, and the user needs to know which
one they got.

Ambiguous input should not silently pick one and hope. Either the product
decides clearly and tells the user, or it asks. The worst outcome is the
user thinking they steered when they actually queued, or vice versa.

## Signs it's working

- The user can send a follow-up while a task is in flight and have the
  agent pick it up as a steer.
- The user can mark a follow-up as a new task and have it queued
  cleanly, with the current task untouched.
- Whichever the agent picked is visible to the user, not inferred.
- A steer that changes direction is reflected in the visible progress,
  not pretended away.
- A queued task waits politely and then runs, without bleeding context
  from the one before it.
- When the input is genuinely ambiguous, the agent makes a reasonable
  call and says which call it made. The user can correct on the next
  message.
- Nothing the user said gets lost. Not to a race, not to an ambiguity,
  not to a restart.

## Anti-patterns: don't build this

- Silent classification. The agent decides "steer or queue" and never
  says which, leaving the user to guess.
- Always treating follow-ups as the same kind. One-size-fits-both loses
  one of the two jobs.
- Interrupting the current task at an unsafe point for a steer.
  Mid-tool-call is not "amend time."
- Queued tasks that inherit the wrong context from the previous task.
- Dropping a message because a turn was in flight. The user said
  something, it should count.
- A steer that silently restarts the task from scratch when the user
  wanted an amendment.
- Treating "I changed my mind" as "I have a new request" or vice versa,
  with no way for the user to correct the classification.

## UAT prompts

- **Mid-task correction.** Start a long task, send a follow-up that
  changes direction. The agent should visibly incorporate the change.
- **Mid-task new request.** Start a long task, send a follow-up that's
  clearly unrelated. It should queue behind the current task, not
  derail it.
- **Ambiguous follow-up.** Send something that could read either way.
  The agent should pick one and say so, so the user can correct.
- **Queue isolation.** Queue a task after another. The second should
  not pick up hallucinated context from the first.
- **Rapid-fire follow-ups.** Send several messages while one task is
  running. None should be lost.
- **Unsafe interrupt point.** Send a steer while the agent is mid-tool-call.
  The amendment should take effect at a safe boundary, not corrupt
  the tool call.
- **User overrides classification.** Correct the agent after it
  classified a message wrongly. The correction should stick for that
  message and be reflected in the outcome.
