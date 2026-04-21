---
job: run a fleet of specialists, not one generalist
outcome: The user talks to the right agent for the right job, each one with its own persona, scope, memory, and boundaries. The fleet feels like a workforce, not a chatbot.
stakes: A single generalist agent dilutes every conversation. Context bleeds, tone is wrong for the task, memory gets muddy. Specialists are the product.
---

# The job

One bot that knows everything is a demo. A fleet of agents, each shaped for
a specific part of the user's life, is a workforce. Health coach in the
morning, coding assistant for the afternoon, executive assistant for the
inbox, each with its own voice, its own history, its own sense of what's
in-scope. The user picks the one they need and doesn't have to re-explain
themselves.

The job of the product is to make running multiple agents genuinely easy.
Not "spin up another container and remember the URL." The user should add
an agent the way they add a contact. The fleet should behave as a fleet:
consistent lifecycle, consistent interaction surface, consistent safety
posture. The thing that varies is the specialist, not the plumbing.

Specialists are not personas on top of one model. They have their own
memory, their own skills, their own tools, their own topic. A health
coach should not see the user's code review history. A coding agent should
not be second-guessing the user's sleep data. Separation is the point.

## Signs it's working

- The user has multiple agents running at once and it's obvious which one
  is which, by voice and by scope.
- Each agent has memory that's its own. What the user told the health
  coach is not leaking into the coding agent.
- The user never has to prefix a message with "as my coding agent" to get
  the right behaviour. Addressing the right agent does that.
- Tools and skills are scoped per agent. The wrong agent doesn't have the
  wrong power.
- When a new agent joins the fleet, it feels like a peer, not a bolt-on.
  It participates in the same lifecycle, the same safety rules, the same
  interaction surface.
- Removing an agent is clean. Its memory, its state, its scheduled work
  all go with it, with no orphaned processes or dangling config.
- The user can describe what each of their agents is for in one sentence.
  If they can't, the fleet is too blurry.

## Anti-patterns: don't build this

- One agent pretending to be multiple by switching tone on command.
  Personas without separation of memory and scope are cosplay.
- Shared memory across all agents. Every specialist should have its own
  view of the user.
- A fleet where only one agent has real capabilities and the rest are
  stubs. The user notices immediately.
- Different agents with different mental models of the interaction
  surface. If one streams and one doesn't, if one uses attachments and
  one throws them away, the fleet feels broken.
- Making adding an agent a project. If it takes more than a few minutes
  of light config, users won't grow the fleet.
- Letting one agent reach across and act on another agent's state
  without the user explicitly setting that up.
- A fleet-management story that lives in docs but not in the product.
  The user should be able to see the fleet, not just read about how
  it works.

## UAT prompts

- **Two specialists, one morning.** Interact with two agents back to back,
  each in their domain. Voice, scope, and memory should feel distinct.
- **Memory isolation.** Tell one agent something personal, ask the other
  about it. It should not know.
- **Scope enforcement.** Ask a specialist something clearly outside its
  remit. It should redirect, not attempt.
- **Add an agent.** Stand up a new specialist from scratch. The flow
  should feel lightweight, not like a migration.
- **Remove an agent.** Retire one. Its artefacts, memory, and schedules
  should all go. No ghosts.
- **Parallel work.** Have two agents doing real work at the same time.
  Neither should degrade the other's experience.
- **Cross-agent handoff.** Need a thing that crosses two specialists. The
  user should be able to route it without the agents silently reaching
  into each other.
