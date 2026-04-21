---
job: survive reboots and real life
outcome: Agents come back cleanly after crashes, power loss, context exhaustion, and transient failures. Work resumes. The user is told when something went wrong, never left in silence.
stakes: Long-running agents live on real machines. If the product can't handle the machine misbehaving, the user can't rely on it for anything that matters.
---

# The job

Agents are long-running processes. Machines reboot, power drops, networks
flap, disks fill, sessions run out of context. The job is to make all of
that survivable. Not glamorous, just expected. The user should not have
to babysit their fleet to keep it alive.

Surviving means two things. First, the agent comes back. After a reboot,
after a crash, after an upgrade, the process is running again without
the user poking it. Second, the agent is honest about what happened. If
a turn was interrupted, if memory was lost, if context was compacted, if
a tool call failed mid-way, the user hears about it in plain language,
at the point it affects them.

Silent recovery is worse than a visible failure. The user needs to know
what changed, what didn't, and what to re-ask. "It just kept working"
is only acceptable if it actually did. If it didn't, pretending it did
is the bug.

## Signs it's working

- After a machine reboot, the fleet comes back on its own. The user
  doesn't have to kick anything.
- After an agent crash, the process is respawned and the user is told,
  with enough detail to know whether the in-flight work survived.
- Context exhaustion is handled as a named event, not a mysterious
  refusal. The user understands what happened.
- Transient failures (network, tool, upstream) retry sensibly. The user
  doesn't see flakes they don't need to.
- Persistent failures surface. The user is told when a retry loop has
  stopped trying.
- Scheduled work survives a reboot. Jobs that should have fired either
  fire on return or are explicitly skipped, not silently dropped.
- The user can ask "is everything healthy?" and get a real answer.

## Anti-patterns: don't build this

- Silent death. An agent process that's gone but still appears to be
  addressable.
- Silent resurrection. An agent that came back in a different state
  than it went down in, without saying so.
- Endless retry loops with no surfacing. The user thinks it's working,
  it's actually stuck.
- Dropping in-flight work on the floor when a process dies, with no
  mention of what was lost.
- Eating a crash to look stable. Real failures need real messages.
- Scheduled jobs that quietly stop firing after a reboot because
  something didn't come back up.
- Recovery that requires the user to read logs. Logs are a debugging
  aid, not a user experience.

## UAT prompts

- **Cold reboot.** Reboot the machine mid-conversation. When it comes
  back, the user should know the agent came back and what state it's in.
- **Kill the process.** Force-kill an agent mid-turn. The user should
  see a real message about what happened and what to do next.
- **Context exhaustion.** Push a conversation until context runs out.
  The agent should handle it gracefully and the user should understand
  the transition.
- **Network flap.** Drop connectivity mid-tool-call. Recovery should be
  transparent for transient issues and honest for persistent ones.
- **Scheduled-job survival.** Have a scheduled task due to fire during a
  reboot. Its behaviour on return should be deterministic and documented.
- **Upgrade mid-session.** Upgrade the product while an agent is
  running. The user should know what changed when the agent returns.
- **Health check.** Ask the fleet how it's doing. The answer should be
  informative, not a green tick that hides a dead process.
