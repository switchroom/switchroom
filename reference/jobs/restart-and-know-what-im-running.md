---
job: know what I'm running after a restart, without asking
outcome: After any restart, the user is told what config is live. Model, tools, skills, memory backend, auth state. No need to ask.
stakes: If the user has to probe to find out what they're talking to, they don't know what they're talking to. Agents drift silently, bad configs ship unnoticed, and trust leaks away a turn at a time.
serves: hold-the-leash
invariants: [chat-is-the-single-source-of-truth]
---

# Job Spec: know what I'm running after a restart, without asking

## The job

The user comes back to the chat after a restart — a reboot, a crash and
respawn, or a config change they reloaded. The agent on the other end might
not be the same agent it was five minutes ago. The job is to surface that up
front, every time, so the user starts the next turn with a clear picture of
what's running: which model, which tools, which skills, which memory backend,
and whether auth is healthy. Enough to notice a change; little enough that it
doesn't become wallpaper. The worst outcome is a silent respawn that comes
back subtly different — the user ends up arguing with a stranger who looks
like their agent.

## Good / bad

**Good looks like**

- After any restart, the user sees a short, honest summary of what's live,
  in the chat, without asking. A status, not a wall of logs.
- The user can tell at a glance if the model, tools, skills, or memory
  backend changed since last time. A change is obvious, not buried.
- Auth state is part of the picture. A login that can't authenticate right
  now is said plainly, not discovered mid-task.
- A restart with no config change still gets a light acknowledgement, so the
  user knows it actually completed.
- The shape is consistent restart to restart — crash, reboot, reconfigure
  all land the same way — so the user's eye learns where to look.
- Several specialists restarted at once each report their own state in their
  own place, never collapsed into one summary.

**Bad looks like — never ship this**

- A silent respawn: the agent comes back and the user has to guess whether
  it's the same agent with the same config.
- A boot banner that dumps every setting. The user stops reading and misses
  the one thing that mattered.
- The live config living only in a dashboard the user never opens. If it
  isn't in the chat, it isn't in the user's life.
- Reporting "ready" while auth is broken. A success message hiding a dead
  login is a trap.
- Lying by omission: tools silently disabled and quietly dropped from the
  summary instead of named.
- A cosmetic summary that looks identical regardless of the real config. The
  user learns to distrust it.

## Prove it

- **First message after restart (DM)** — `jtbd-always-on-after-restart-dm`.
  *Watch:* the first inbound after a restart is answered promptly, not after
  a multi-minute blank window. *Invariant:* a restart never swallows the
  return — the user always learns the agent is back, in the chat.
- **What's live, on demand (DM)** — `jtbd-whoami-dm`. *Watch:* the
  user can read the live sandbox — tier, model, tools, powers — without SSH
  or a dashboard. *Invariant:* the surfaced config is resolved from the live
  agent, never an echoed stub.
- **Config survives the restart (DM)** — `jtbd-memory-survives-restart-dm`.
  *Watch:* the memory backend that was attached before the restart is still
  attached and recalling after it. *Invariant:* a restart never silently
  drops a backend the user was relying on.
- **Restart summary names the change (DM)** — *(coverage gap: no runnable
  scenario yet)*. *Watch:* after a model/tool/skill change + reload, the
  return summary reflects the new state, and an unchanged restart still gives
  a light "I'm back". *Invariant:* the summary tracks the real config, never
  the old state and never a fixed cosmetic banner.

**Fuzz corpus:** vary restart cause (reboot × crash × reconfigure) × what
changed (model × tools × skills × memory backend × auth health × nothing) ×
fleet size (one agent vs several at once). The summary must track the real
config and land in the chat across the corpus, never a stale or cosmetic one.

## Verdict

- **Done when:** after any restart the user knows what's running — model,
  tools, skills, memory, auth — from the chat alone, and any change is
  obvious, proven by the scenarios above.

## Production-readiness

- *Reliability:* no restart returns silent; the first post-restart inbound is
  always answered, never stranded in a blank window.
- *Honesty:* a broken-auth or tool-disabled state is surfaced, never masked
  by a "ready" message.
