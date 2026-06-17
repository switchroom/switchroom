---
job: survive reboots and real life
outcome: Agents come back cleanly after crashes, power loss, context exhaustion, and transient failures. Work resumes. The user is told when something went wrong, never left in silence.
stakes: Long-running agents live on real machines. If the product can't handle the machine misbehaving, the user can't rely on it for anything that matters.
serves: always-available
invariants: [on-leash, chat-is-the-single-source-of-truth]
---

# Job Spec: survive reboots and real life

## The job

Agents are long-running processes that live on real machines. Machines
reboot, power drops, networks flap, disks fill, sessions run out of
context. The user hires this job so they don't have to babysit the fleet
to keep it alive. Surviving means two things: the agent comes back on its
own after a reboot, crash, or upgrade — and it is honest about what
happened. If a turn was interrupted, memory was lost, context was
compacted, or a tool call failed mid-way, the user hears about it in plain
language, at the point it affects them. Silent recovery is worse than a
visible failure: coming back in a different state without saying so is the
bug, not the resilience.

## Good / bad

**Good looks like**

- After a machine reboot, the fleet comes back on its own. The user never
  has to kick anything.
- After a crash, the agent is respawned and the user is told, with enough
  detail to know whether the in-flight work survived.
- An interrupted turn either resumes or is explicitly named as lost — never
  dropped on the floor in silence.
- Context exhaustion reads as a named event the user understands, not a
  mysterious refusal.
- Transient failures (network, tool, upstream) retry sensibly; the user
  doesn't see flakes they don't need to. Persistent named failures
  (credentials, quota, crashes) surface as plain-language alerts.
- Scheduled work survives a reboot: jobs that were due either fire on
  return or are explicitly skipped, never silently dropped.
- The user can ask "is everything healthy?" and get a real answer, not a
  green tick over a dead process.

**Bad looks like — never ship this**

- Silent death: a process that's gone but still appears addressable.
- Silent resurrection: an agent that came back in a different state than it
  went down in, without saying so.
- Endless retry loops with no surfacing — the user thinks it's working and
  it's actually stuck.
- Dropping in-flight work when a process dies, with no mention of what was
  lost.
- Eating a crash to look stable. Real failures need real messages.
- Scheduled jobs that quietly stop firing after a reboot because something
  didn't come back up.
- Recovery that requires the user to read logs. Logs are a debugging aid,
  not a user experience.

## Prove it

Named by job × surface, pointing at real scenarios.

- **Always-on after reboot (DM)** — `jtbd-always-on-after-restart-dm`.
  *Watch:* the first message after a restart is answered with no manual
  intervention. *Invariant:* a reboot never leaves an agent un-addressable
  or silently dead.
- **Message lands during the boot window (DM + channel)** —
  `jtbd-message-during-restart-dm` / `-channel`. *Watch:* a message sent
  while the agent is still coming up is still answered. *Invariant:* a
  restart never swallows an inbound silently.
- **Interrupted turn resumes (DM)** — `jtbd-interrupted-turn-resumes-dm`.
  *Watch:* a turn cut off by a restart is resumed and the resume turn
  completes. *Invariant:* in-flight work is resumed or named-as-lost, never
  dropped in silence.
- **Memory survives a restart (DM)** — `jtbd-memory-survives-restart-dm`.
  *Watch:* the agent comes back knowing what it knew before. *Invariant:*
  the agent never resurrects amnesiac without saying so.
- **Self-heals after a dependency bounce** —
  `tests/gateway-supervisor-backoff.test.ts`. *Watch:* a transient
  dependency failure backs off and retries until it returns, never giving
  up forever. *Invariant:* a transient failure self-heals; it does not
  turn into a dead fleet awaiting a human.
- **Crash/restart cause is captured for the return greeting** —
  `tests/lifecycle-restart-reason.test.ts`. *Watch:* every restart
  initiator records why, so the comeback message can speak it. *Invariant:*
  a restart is never silent about what happened.

**Fuzz corpus:** vary failure kind (reboot × crash × context-exhaustion ×
network flap × upgrade-mid-session) × timing (idle vs mid-turn vs during
boot window) × surface (DM vs forum channel) × scheduled-job-due-during-
outage. The invariants must hold across the corpus: always comes back,
never silently, work resumed or named-as-lost.

## Verdict

- **Done when:** after any reboot, crash, or transient failure, the agent
  comes back on its own and the user is told in plain language what
  happened to their in-flight work — proven by the scenarios above, never
  recovered in silence.

## Production-readiness

- *Reliability:* no failure mode leaves an agent gone-but-addressable;
  transient dependency failures self-heal with bounded backoff, never a
  permanent give-up.
- *Availability:* the fleet returns after a host reboot without operator
  action; scheduled work due during the outage is deterministically fired
  or skipped, never silently dropped.
- *Honesty:* every persistent named failure (credentials, quota, crash) is
  surfaced to the user, not just logged to stderr.
