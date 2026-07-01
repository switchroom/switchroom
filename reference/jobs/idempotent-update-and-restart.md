---
job: update switchroom and trust that everything is actually running the new version, no manual checks
outcome: After running `switchroom update`, the entire stack (CLI, agent containers, broker, kernel, scheduler, hostd, MCP servers, bundled skills, memory backend) is at the version switchroom declared and tested as a unit. After any restart, the agent comes back with fresh code, fresh MCP servers, fresh settings, and intact context. The user does not lose their thread.
stakes: If `update` quietly leaves stale processes running, the user thinks they're talking to a new agent and they're talking to last week's. Bugs come back from the dead. New features advertised in the changelog don't actually load. The user loses faith that the version reported by the CLI matches reality. Updates become a thing to dread.
serves: always-available
invariants: []
---

# Job Spec: update once and trust the whole stack is running it

## The job

The user runs one update command to pick up a bug fix, close a security
advisory, or get a new feature. The job is for the next agent reply to be
backed by the new version of *everything*, without the user having to know
which processes survive a restart, which dependencies are pinned where, or
which service quietly held a stale handle. The mental model is:
**switchroom is a release, not a moving target.** A version pins a tested
matrix of every moving piece, brought up in lockstep; no piece moves on its
own. The same contract covers restarts: a restarted unit comes back as a
fresh process with current settings, and knowing what was happening before
(recent messages, the current goal, today's context), not as an amnesiac
who needs re-briefing. That continuity is a property of the switchroom
layer, not a side effect of any underlying session happening to survive.

## Good / bad

**Good looks like**

- The update finishes; the user sends a message; the next reply is backed
  by the new code with no manual restart, reinstall, or "have you tried
  restarting?" exchange.
- The version the CLI reports matches what's actually loaded into every
  running process, and a health sweep confirms it with a green check.
- Re-running update any number of times lands in the same valid state: no
  accumulating side effects, no "now you have to do Y to fix it."
- After a restart, the agent's first reply shows it knows where the thread
  was, referencing the last message, the current task, today's context,
  without being prompted.
- After a restart, every declared MCP server is actually loaded; a
  newly-added tool works on the first try.
- A claimed version corresponds to a known-good combination of
  dependencies, brought to that combination atomically.
- Drift between declared and installed versions is surfaced loudly before
  it causes a confusing bug.

> [!CAUTION]
> A restart that "succeeds" (the container reports running) while the process
> inside never exited leaves the user talking to last week's agent. The
> version the CLI reports must be provably the version loaded into every
> running process.

**Bad looks like: never ship this**

- The CLI reports a new version but the agent behaves like the old one:
  the reported version has decoupled from what's running.
- A restart "succeeds" (the container reports running) but the process
  inside never exited; old settings persist until a manual bounce.
- Update overwrites a runtime version by silently pulling whatever shipped
  today, untested against the rest of the stack.
- The user has to keep a mental model of which dependency moves through
  which channel.
- A second update or restart exposes new failure modes: proof the first
  run left an in-between state.
- After a restart the agent comes back with no awareness of the thread, and
  the user has to re-explain.
- Declared MCP servers silently fail to start and the agent doesn't know
  its own toolbox is incomplete.

## Prove it

Named by job × surface, pointing at real scenarios.

- **Restart comes back fresh, not a zombie** —
  `tests/agent-restart-dirty-check.test.ts`,
  `tests/lifecycle-restart-reason.test.ts`. *Watch:* a restart yields a
  fresh process with current settings and a recorded reason. *Invariant:* a
  restart never leaves the old process alive behind a "running" report.
- **Context survives the restart (DM)** —
  `jtbd-memory-survives-restart-dm`, `tests/handoff-briefing.test.ts`.
  *Watch:* the agent's first reply after restart knows where the thread
  was. *Invariant:* continuity is a switchroom-layer property (memory +
  briefing + replay), not dependent on the underlying session surviving.
- **In-flight turn resumes across a restart (DM)** —
  `jtbd-interrupted-turn-resumes-dm`,
  `jtbd-message-during-restart-dm`. *Watch:* a turn interrupted by a
  restart resumes; a message sent during boot is still answered.
  *Invariant:* an update/restart never drops an in-flight turn or inbound.
- **Self-heals when a recreated dependency returns** —
  `tests/gateway-supervisor-backoff.test.ts`. *Watch:* a service whose
  dependency was recreated by an update backs off and reconnects, never
  giving up forever. *Invariant:* update-driven recreation self-heals, not
  a dead fleet awaiting a human.
- **Declared/installed version drift is flagged** —
  `tests/cli.doctor.memory.test.ts`, `tests/manifest.test.ts`. *Watch:* the
  health sweep detects a piece that doesn't match the declared matrix.
  *Invariant:* drift between declared and installed is surfaced, never
  silently tolerated.
- **Boot loads the declared toolbox** — `tests/boot-self-test.test.ts`,
  `tests/scaffold.mcp-json-user-declared.test.ts`. *Watch:* a fresh boot
  brings up every declared MCP server. *Invariant:* a restart never comes
  back with a silently-incomplete toolbox.

**Fuzz corpus:** vary which pieces changed (CLI × image × broker × kernel ×
MCP set × settings) × restart trigger (update × host reboot × manual ×
health bounce) × repeat-count (idempotency over N runs) × restart-mid-turn.
The invariants must hold across the corpus: lockstep version, fresh
process, intact context, no dropped turn.

## Verdict

- **Done when:** after one update or any restart, every running piece is at
  the declared version and the agent comes back fresh-but-not-amnesiac,
  proven by the scenarios above, with drift surfaced loudly and idempotent
  across repeated runs.

## Production-readiness

- *Atomicity:* an update brings the whole declared matrix to its tested
  combination in lockstep, or stops cleanly with "nothing was applied",
  never half-applied.
- *Idempotency:* repeated update/restart runs converge to the same valid
  state with no accumulating side effects.
- *Integrity:* the version the CLI reports is provably the version loaded
  into every running process; drift is detected, not assumed-away.

## Related

- [get from zero to a working fleet](get-from-zero-to-a-working-fleet.md) — the same readiness gate ("ready" means can-answer) that update relies on.
- [keep my subscription honest](keep-my-subscription-honest.md) — why every restarted process comes back on the unmodified interactive CLI.
