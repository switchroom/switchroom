---
job: run a fleet of specialists, not one generalist
outcome: The user talks to the right agent for the right job, each one with its own persona, scope, memory, and boundaries. The fleet feels like a workforce, not a chatbot.
stakes: A single generalist agent dilutes every conversation. Context bleeds, tone is wrong for the task, memory gets muddy. Specialists are the product.
serves: standing-team
invariants: [no-self-escalation, single-tenant]
---

# Job Spec: run a fleet of specialists, not one generalist

## The job

One bot that knows everything is a demo. A fleet of agents, each shaped for
a specific part of the user's life, is a workforce: a health coach in the
morning, a coding assistant in the afternoon, an executive assistant for
the inbox, each with its own voice, its own history, its own sense of
what's in-scope. The user picks the one they need and doesn't re-explain
themselves. The product's job is to make running many agents genuinely
easy and to make the fleet behave *as* a fleet: one lifecycle, one
interaction surface, one safety posture. The thing that varies is the
specialist, not the plumbing. Specialists are not personas over one model.
Each has its own memory, skills, tools, and topic. The health coach never
sees the code-review history; the coding agent never second-guesses the
sleep data.

> [!IMPORTANT]
> Specialists are not personas over one model. Separation is the point.

## Good / bad

**Good looks like**

- The user runs several agents at once and it's obvious which is which, by
  voice and by scope, without a label.
- Each agent's memory is its own. What the user told one specialist does
  not surface in another.
- The user never prefixes "as my coding agent" to get the right behaviour.
  Addressing the right agent does that.
- Tools and credentials are scoped per agent; the wrong agent never holds
  the wrong power.
- A new agent joins as a peer: same lifecycle, same safety rules, same
  interaction surface as the ones already running.
- Two agents do real work in parallel and neither degrades the other's
  conversation.
- A cross-specialist need is routed by the user; agents don't silently
  reach into each other's state.

**Bad looks like: never ship this**

- One agent pretending to be several by switching tone on command. A
  persona without its own memory and scope is cosplay.
- Memory pooled across the fleet, so what the user told one specialist
  leaks into another.
- A fleet where one agent has real capabilities and the rest are stubs.
  The user notices immediately.
- Agents with different mental models of the interaction surface (one
  streams, one doesn't; one keeps attachments, one drops them). The fleet
  feels broken.
- Adding an agent being a project. If it takes more than a few minutes of
  light config, the user won't grow the fleet.
- One agent reaching across to act on another's state without the user
  setting that up.
- A fleet-management story that lives in docs but not in the product. The
  user should be able to see the fleet, not just read about it.

## Prove it

- **Memory isolation across the fleet** — `tests/memory.create-bank.test.ts`,
  `tests/memory.user-profile.test.ts`. *Watch:* each agent recalls only its
  own bank; one agent's facts never appear in another's recall. *Invariant:*
  no shared memory pool; each specialist has its own view of the user.
- **Distinct persona per agent** — `tests/scaffold.persona.test.ts`,
  `tests/reconcile.persona.test.ts`. *Watch:* two agents render different
  voices/scopes from the same scaffold. *Invariant:* persona and scope are
  per-agent and operator-authored, not switched on command.
- **Per-agent scoped capability** — `tests/scaffold.tool-search.test.ts`,
  `tests/doctor.user-declared-mcps.test.ts`. *Watch:* an agent has exactly
  the tools its config grants. *Invariant:* an agent cannot reach a tool or
  credential not declared for it (`no-self-escalation`).
- **Parallel work, no interference (DM + channel)** — `fuzz-real-work-dm`,
  `fuzz-real-work-channel`. *Watch:* a long turn completes cleanly; routing
  stays correct under load. *Invariant:* one agent's turn never corrupts
  another's conversation or routing.
- **Cross-specialist routing stays operator-driven** —
  *(coverage gap: no runnable scenario yet)*. *Watch:* a need spanning two
  agents is handed off by the user, not by one agent silently acting on
  another's state. *Invariant:* `no-self-escalation` holds across agents.

**Fuzz corpus:** vary number of agents × persona × concurrent turns ×
surface (DM vs forum channel) × overlapping topics; memory stays isolated,
scope stays enforced, and no agent acts on another's state.

## Verdict

- **Done when:** the user runs multiple specialists that are distinct in
  voice, scope, and memory, work in parallel without interfering, and never
  reach across into each other. Proven by the scenarios above.

## Production-readiness

- *Isolation:* each agent's memory, credentials, and tools are partitioned
  by construction; cross-agent access requires an explicit operator action.
- *Reliability:* concurrent agents do not degrade each other's turn under
  load.

## Related

- [`remember-across-sessions`](remember-across-sessions.md) — the per-agent
  memory bank that keeps specialists from bleeding into each other.
- [`share-auth-across-the-fleet`](share-auth-across-the-fleet.md) — one login
  fanned out to many specialists.
- [`see-my-whole-fleet-from-one-screen`](see-my-whole-fleet-from-one-screen.md) —
  the operator's view of the whole fleet at once.
