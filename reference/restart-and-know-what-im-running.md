---
job: know what I'm running after a restart, without asking
outcome: After any restart, the user is told what config is live. Model, tools, skills, memory backend, auth state. No need to ask.
stakes: If the user has to probe to find out what they're talking to, they don't know what they're talking to. Agents drift silently, bad configs ship unnoticed, and trust leaks away a turn at a time.
---

# The job

The user comes back to the chat after a restart. Maybe the machine rebooted,
maybe the agent crashed and respawned, maybe the user pushed a config change
and reloaded. Whatever the trigger, the agent on the other end might not be
the same agent it was five minutes ago. The job is to surface that up front,
every time, so the user starts the next turn with a clear picture of what's
running.

This is not a verbose boot banner. It's a short, honest summary at the point
the user returns. What model, what tools are enabled, what skills are loaded,
which memory backend is attached, whether auth is healthy. Enough for the
user to notice when something changed. Little enough that it doesn't become
wallpaper the user learns to scroll past.

Silent restarts are the worst outcome. An agent that comes back as something
subtly different, with no hint, leads to the user arguing with a stranger
who looks like their agent. Name the change, or there was no point in the
ceremony of a restart.

## Signs it's working

- After any restart, the user sees what's running without asking. A brief
  status, not a wall of logs.
- The user can tell if the model changed, the tools changed, skills were
  added or removed, or memory is attached.
- Auth state is part of the picture. If the agent can't authenticate right
  now, the user is told, not left to discover it mid-task.
- The summary is in the chat, not hidden in a log or a dashboard. It lands
  where the user already is.
- If nothing changed, the user still gets a light acknowledgement that the
  agent is back, so they know the restart actually completed.
- The format is consistent restart to restart, so the user's eye learns
  where to look.
- When something did change, the change is obvious, not buried.

## Anti-patterns: don't build this

- Silent respawn. Agent comes back and the user has to guess whether it's
  the same agent with the same config.
- A boot banner that dumps every setting. The user stops reading, then
  misses the one thing that mattered.
- Config summaries that live in a dashboard the user never opens. If it
  isn't in the chat, it isn't in the user's life.
- Reporting success when auth is broken. A "ready" message that hides a
  dead login is a trap.
- Different restart surfaces for different causes. A crash, a reboot, a
  reconfigure should all land in the same shape.
- Lying by omission. If tools were silently disabled, the summary should
  say so, not quietly drop them.
- Cosmetic summaries that always look the same regardless of the actual
  config. The user learns to distrust it.

## UAT prompts

- **Cold reboot.** Reboot the machine. When the agent is back, the user
  should see a clear summary of what's live without asking.
- **Config change restart.** Change the model or tools, reload the agent.
  The summary should reflect the change, not the old state.
- **Skill added or removed.** Add a skill, restart. The skill should
  appear in the summary. Remove it, restart, it should disappear.
- **Auth failure on restart.** Start the agent with broken auth. The
  surfaced state should say so clearly, not claim ready.
- **Nothing changed.** Restart with no config changes. The user should
  still get a lightweight acknowledgement the agent is back.
- **Multiple agents restarted.** Bring several specialists back at once.
  Each should report its own state in its own place, not collapse into
  one summary.
- **Memory backend swap.** Change the memory backend, restart. The user
  should see which backend is now attached.
- **Tool scope change.** Narrow or widen a tool allowlist, restart. The
  user should be able to tell what the agent can and can't do now.
