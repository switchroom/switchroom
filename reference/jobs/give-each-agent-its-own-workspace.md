---
job: give each agent its own working copy of the code, without making the user manage it
outcome: Multiple specialists work on the same repo on the same machine without stomping each other. Each agent has a stable, isolated working tree it owns. Switchroom creates and tears down those workspaces as part of the agent's lifecycle. The user never thinks about it.
stakes: A fleet that shares one working tree isn't a fleet — it's a flatshare. One agent runs an install, another's typecheck breaks. One checks out a feature branch, another inherits it mid-turn. Modified files leak between turns of different agents. The "consistent lifecycle" promise fails the first time two agents work in parallel.
serves: standing-team
invariants: []
---

# Job Spec: give each agent its own working copy of the code

## The job

Switchroom's whole point is multiple specialists running side by side on one
machine. They share an OS, a vault, a network — but they must not share a
working tree on a repo they both care about. The moment two agents touch the
same checkout, the fleet stops behaving like a fleet: one pulls and rebases
the other's edits away, one switches branches under the other's running
sub-agent, an install invalidates the other's build mid-flight, and
uncommitted work from one session looks like the other's untracked junk
after a restart. The job is to give each agent a stable working tree it
owns, provisioned and torn down as part of its lifecycle, so the user never
chooses, names, or manages it — and never debugs a "two agents stomped the
tree" incident, because the product doesn't allow it.

## Good / bad

**Good looks like**

- Adding an agent that works on a repo automatically gives it its own
  working tree. The user never runs a git command, picks a path, or names a
  branch.
- Two agents build the same repo at the same time; both succeed, neither's
  output clobbers the other's.
- Each agent opens its own parallel pull request on the same repo with zero
  coordination.
- After a reboot, each agent returns to the tree it left, with in-flight
  uncommitted work preserved, not stashed-and-lost.
- A dirty tree at session start is left alone and surfaced, never reset on
  the agent's behalf.
- Sub-agent work nests off the parent's tree, the same conceptual operation
  as a main agent — one scaffold, not two UXes.
- Prompts and skills refer to a repo by name, never a hardcoded path, so an
  agent works the same on any host.

**Bad looks like — never ship this**

- A shared canonical checkout with locks or branch-naming conventions; two
  agents from one checkout is the exact failure this job exists to fix.
- A full clone per agent — redundant gigabytes and N× the fetch cost for
  isolation a working tree already gives more cheaply.
- A pool of scratch trees handed to whoever asks first; the agent's tree
  must be stable across sessions so in-flight state survives restart.
- Inferring an agent's repos from filesystem scans or history instead of its
  declared manifest — surprise clones.
- Forcing the agent to learn the tree's path; the path is plumbing, injected
  for it.
- Silently discarding an agent's uncommitted work; never reset a dirty tree
  on its behalf.
- A separate "main agent" vs "sub-agent" workspace UX; it's the same
  operation, one scaffold.

## Prove it

- **Per-agent tree provisioned by lifecycle** —
  `tests/scaffold.repo-provisioning.test.ts`. *Watch:* declaring a repo in
  an agent's manifest provisions its working tree on reconcile, with no user
  command. *Invariant:* trees are provisioned only for declared repos — no
  surprise clones.
- **Isolated tree per agent, registered** — `tests/worktree.registry.test.ts`,
  `tests/worktree.schema.test.ts`, `tests/worktree.claim-integration.test.ts`.
  *Watch:* each agent owns a distinct, recorded tree; two agents never share
  one. *Invariant:* one working tree per agent × repo; isolation is by
  construction.
- **Dirty-tree policy: leave alone, warn** — `tests/workspace.git.test.ts`.
  *Watch:* an agent's uncommitted work at session start is preserved, not
  reset; the fast-forward is skipped. *Invariant:* switchroom never destroys
  an agent's uncommitted work.
- **Stable across restart** — `tests/workspace.stable.test.ts`,
  `tests/agent-restart-dirty-check.test.ts`. *Watch:* after a restart the
  agent finds its tree on the same branch with its work intact.
  *Invariant:* the tree is stable across sessions, not pooled or recreated.
- **Orphan cleanup / reaping** — `tests/worktree.reaper.test.ts`. *Watch:*
  abandoned trees are reaped, not accumulated. *Invariant:* trees are part
  of the lifecycle, not leaked forever.

**Fuzz corpus:** vary number of agents × repos per agent × concurrent
builds × dirty-vs-clean tree at start × reboot mid-work × sub-agent nesting
depth; isolation, stability, and the never-reset-dirty rule hold across all.

## Verdict

- **Done when:** multiple agents work the same repo in parallel without
  stomping each other, each tree is stable across restart with uncommitted
  work preserved, and the user never runs a git or worktree command —
  proven by the scenarios above.

## Production-readiness

- *Storage:* working trees share the object store; per-agent full clones are
  not used.
- *Durability:* a reboot or kill mid-work leaves each agent's tree intact on
  its branch; dirty trees are never reset.
