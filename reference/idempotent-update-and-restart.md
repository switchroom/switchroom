---
job: update switchroom and trust that everything is actually running the new version, no manual checks
outcome: After `switchroom update` finishes, the entire stack — runtime, CLI, gateway, agents, MCP servers, memory backend, vault broker — is at the version switchroom declared and tested as a unit. After any restart, the agent comes back with fresh code, fresh MCP servers, fresh settings, and intact context (recent messages, memory, today's plan). The user does not lose their thread.
stakes: If `update` quietly leaves stale processes running, the user thinks they're talking to a new agent and they're talking to last week's. Bugs come back from the dead. New features advertised in the changelog don't actually load. The user loses faith that the version reported by the CLI matches reality. Updates become a thing to dread.
---

# The job

The user runs `switchroom update`. Maybe they're picking up a bug fix.
Maybe a dependency security advisory landed. Maybe a new feature shipped.
The job is for the next agent reply to be backed by the new version of
*everything* — without the user having to know which processes survive a
restart, which dependencies are pinned where, or which systemd unit
secretly held a stale handle.

The same is true for restarts. When a unit restarts, the agent should
come back as a fresh process with current settings, not a zombie of
whatever was running last week. And it should come back knowing what was
happening before — recent messages, the user's current goal, today's
calendar — not as an amnesiac who needs to be re-briefed.

The pattern is: **switchroom is a release**, not a moving target. A
version of switchroom pins a tested matrix of bun, node, claude CLI,
playwright/mcp, hindsight, vault broker, and every other moving piece.
`update` brings every piece to its declared version, in lockstep. No
piece moves on its own.

## Signs it's working

- `switchroom update` finishes; the user sends a message; the agent's
  next reply is backed by the new code without further intervention.
  No manual `systemctl restart`, no `bun install`, no "have you tried
  restarting claude?" exchange.
- The version reported by the CLI matches the version actually loaded
  into every running process. `switchroom doctor` confirms with a
  green check.
- A user can re-run `switchroom update` and `switchroom agent restart`
  any number of times, in any order, and end up in the same valid
  state every time. No accumulating side effects. No "if you did X,
  now you have to do Y to fix it."
- After a restart, the agent's first response demonstrates it knows
  what was happening — references the user's last message, today's
  calendar, an in-flight task — without being prompted.
- After a restart, every MCP server that the agent's `settings.json`
  declares is actually loaded. The user can ask the agent to use a
  newly-added tool and it works on the first try.
- A claimed switchroom version corresponds to a known-good combination
  of dependencies. Bumping switchroom to a new version brings every
  dependency to its tested combination, atomically.
- Drift between declared and installed versions is surfaced loudly. If
  someone manually upgrades claude CLI or bun outside `switchroom
  update`, `switchroom doctor` flags it before it causes a confusing
  bug.

## Signs it's not

- The user runs `update`, sees the CLI report a new version, sends a
  message, and gets behaviour that matches the old version. Bug fixes
  apparently didn't ship. New tools don't appear in the agent's
  toolbox. The "version" the CLI reports has decoupled from what's
  actually running.
- A restart "succeeds" (systemd reports active) but the underlying
  agent process didn't actually exit. PIDs from before the restart
  are still alive. Settings changes don't take effect until the user
  manually kills the process.
- `update` overwrites a runtime version (e.g. claude CLI) by silently
  pulling `@latest` from a registry, picking up whatever shipped
  today regardless of whether the rest of the stack has been tested
  with that version.
- The user has to keep a mental model of which dependency goes through
  which channel. "claude is a global bun package, but bun itself I
  installed via curl, and the vault broker is a separate systemd unit
  that update doesn't touch."
- A second `update` or `restart` after the first exposes new failure
  modes — implies the first run left the system in an in-between
  state.
- After restart, the agent comes back with no awareness of what was
  happening. The user has to re-explain what they were working on.
  Recent context is lost.
- After restart, MCP servers that should be loaded silently fail to
  start (npx download stalls, server crashes during init), and the
  agent doesn't know its own toolbox is incomplete.

## What the user needs from the surface

- One command (`switchroom update`) that does the right thing for the
  whole stack. Not a runbook of three commands and two README links.
- A clear failure mode if the update can't finish cleanly. "Stopped at
  step X because Y failed; nothing was applied" beats "applied half,
  please figure out the rest yourself".
- A way to see what's pinned for the current switchroom version, and
  what's actually installed, and any drift. So the user can tell at a
  glance whether they should run `update` or whether they're already
  on the latest tested combination.
- Continuity that doesn't depend on the underlying claude session
  surviving across restarts. Resume should be a feature of the
  switchroom layer (memory + handoff briefing + recent-message
  replay), not a side effect of `claude --continue` happening to
  succeed.
- An escape hatch for opting out of automatic resume — useful when the
  user explicitly wants a clean slate, or when the prior session got
  into a confused state.

## Worked examples

### Update lands a security patch

The user reads about a CVE in a transitive dependency. They run
`switchroom update`. The CLI reports the new switchroom version, runs
`bun upgrade`, bumps claude CLI to the pinned version, reinstalls the
plugin, restarts the vault broker, and rolls each agent — gateway and
claude process both bouncing. After it finishes, every running process
is on the new version. The user sends "ping" and the agent replies
within seconds, demonstrating it picked up the change without being
asked. `switchroom doctor` reports no drift.

### A restart in the middle of a busy thread

The user has been mid-conversation about a legal letter, with several
attachments shared. The agent restarts (systemd reschedule, host
reboot, manual `agent restart`). The agent's first reply after coming
back acknowledges where the thread was — references the legal letter,
the deadline, what was already drafted — without the user having to
paste it all back in.

### A new MCP server is added

The user enables a new MCP server in `switchroom.yaml` and runs
`switchroom agent reconcile`. The reconcile re-renders the agent's
`settings.json` and restarts the agent. After restart, the agent has
the new MCP's tools available and the user can use them on the first
try. The user does not need to know which child process holds the MCP
client connection or whether claude reads `settings.json` at boot vs
on demand.

### Stale dependency exposed at update time

The user installed claude CLI manually six months ago and forgot. They
run `switchroom update`. Switchroom detects the installed claude
version is ahead of the pinned version for this switchroom release,
flags the drift, and either re-pins to the tested version or refuses
to proceed pending user confirmation. Either way the user knows
*before* sending their next message — not after the agent gives a
weird answer that turns out to be a bug fixed in the pinned version.
