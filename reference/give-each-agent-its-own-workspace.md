---
job: give each agent its own working copy of the code, without making the user manage it
outcome: Multiple specialists work on the same repo on the same machine without stomping each other. Each agent has a stable, isolated working tree it owns. Switchroom creates and tears down those workspaces as part of the agent's lifecycle. The user never thinks about it.
stakes: A fleet that shares one working tree isn't a fleet — it's a flatshare. One agent runs `bun install`, another's typecheck breaks. One checks out a feature branch, another inherits it mid-turn. Modified files leak between turns of different agents. The "consistent lifecycle" promise of the product fails the first time two agents work in parallel.
---

# The job

Switchroom's whole point is multiple specialists running side by side on
one machine. They share an OS, share a vault, share a network — but they
should not share a working tree on a repo they both care about. The
moment two main-agents touch the same `git checkout`, the fleet stops
behaving like a fleet:

- Agent A pulls main; agent B's edits get rebased without their knowing.
- Agent A starts a long sub-agent on branch X; agent B switches to branch
  Y and the sub-agent's worktree is built on a moved HEAD.
- `bun install` from one agent invalidates `node_modules` for another
  agent mid-build.
- Uncommitted changes from one agent's session look like the other
  agent's untracked work after a restart.

Sub-agents already get their own worktree per task — that's been the
pattern since the worker dispatch story shipped. The fleet promise asks
the same of main agents. An agent's coding work belongs in an agent-owned
working tree; the user never has to choose, name, or manage it.

## Signs it's working

- Adding a switchroom agent that works on a repo automatically gives that
  agent its own worktree. The user doesn't run `git worktree add`. They
  don't pick a path. They don't pick a branch.
- Two agents run `bun run build` in the same repo at the same time. Both
  succeed. Neither's `dist/` clobbers the other's.
- Agent A finishes a task on its branch, opens a PR. Agent B opens a
  parallel PR on the same repo without coordinating with A.
- After a host reboot, each agent comes back to the worktree it left.
  Uncommitted in-flight work is preserved, not stashed-and-lost.
- Removing an agent removes its worktrees. The repo's `.git/worktrees/`
  doesn't accumulate orphans.
- A sub-agent dispatched from inside an agent's working tree creates its
  own nested worktree off the parent's HEAD, exactly as it does today.
  The pattern stacks.
- The agent's prompt and skills can refer to the repo by name
  (`SWITCHROOM_REPO_SWITCHROOM`), not by hardcoded path. Different agents
  on different hosts work the same way.

## Anti-patterns: don't build this

- A "shared canonical clone" with manual coordination, locks, or
  branch-naming conventions. Two agents working from the same checkout
  is the failure mode this whole job exists to fix.
- A separate full clone per agent. Worktrees share `.git/objects`; full
  clones don't. Five agents × a 200MB repo as full clones is a gigabyte
  of redundant storage and five times the network on `git fetch`. The
  isolation a worktree gives is the same; the cost is much lower.
- A pool of "scratch" worktrees handed to whichever agent asks first.
  The agent's worktree should be stable across sessions so the agent's
  in-flight state survives restart. Pools defeat that.
- Inferring which repos an agent works on from filesystem scans or
  history. The agent's `switchroom.yaml` declares its repos; switchroom
  provisions only those. Surprises mean accidental clones.
- Forcing the agent to learn the worktree path. The path is plumbing.
  Switchroom injects it via env (`SWITCHROOM_REPO_<NAME>`) and may
  optionally chdir the session into the right tree.
- A worktree refresh policy that silently discards the agent's
  uncommitted work. If the worktree is dirty at session start, leave it
  alone and surface that fact. Never `git reset --hard` an agent's tree
  on its behalf.
- Sharing `node_modules` across worktrees with symlinks or hard links.
  Bun and npm both depend on the lockfile-to-tree relationship being
  one-to-one; sharing produces silent install drift. Pay the disk cost.
- A separate "main agent" UX vs "sub-agent" UX for worktrees. Sub-agents
  branch off their parent's HEAD; main agents do the same against
  `upstream/main`. The same conceptual operation. One scaffold.

## Decisions

These are the choices switchroom makes on the user's behalf, so the user
doesn't have to:

1. **Worktrees, not full clones.** Cheap, fast, share `.git/objects`,
   match the sub-agent pattern that already works.
2. **One worktree per agent × repo.** Stable path
   (`<agent_dir>/work/<repo_slug>/`, where `<agent_dir>` is the agent's
   switchroom directory and `<repo_slug>` is the kebab-case repo name).
   The bare/canonical clone lives once per host at
   `~/.switchroom/repos/<repo_slug>.git` (shared across agents);
   per-agent worktrees are created off it. Worktrees are provisioned
   lazily — on the first `agent restart`/`reconcile` that runs after the
   repo appears in the agent's manifest, not on every session start.
   Removed when the agent is removed.
3. **Per-agent long-lived branch.** `agent/<agent-name>/main`, where
   `<agent-name>` is the agent's id from `switchroom.yaml` (the same id
   used in directory names and systemd units, e.g. `clerk`, `klanker`).
   Fast-forwarded to `upstream/main` on session start when the worktree
   is clean. Task work happens on transient branches off that branch.
4. **Repos declared in `switchroom.yaml`.** An agent's manifest lists
   the repos it operates on. Worktrees are provisioned only for those.
   No surprise clones.
5. **Discovery via env.** `SWITCHROOM_REPO_<NAME_UPPER>=<absolute path>`
   in the agent's environment. The agent's prompt, skills, and scaffold
   reference repos by env, not by hardcoded path.
6. **Dirty-tree policy: leave alone, warn.** If the worktree has
   uncommitted changes at session start, the ff-to-main step is skipped.
   The session resumes on whatever branch the worktree was on. The boot
   card surfaces "<repo>: dirty since <ts>" as a one-line warning.
7. **Removal is symmetric.** `switchroom agent remove <name>` calls
   `git worktree remove` for each of the agent's worktrees, then prunes
   the per-agent branches. The host's `.git/worktrees/` stays clean.
8. **Sub-agents nest off the parent worktree.** Existing pattern. A
   worker dispatched by an agent on
   `<agent_dir>/work/switchroom/` creates its task worktree off
   that path's HEAD, not off the canonical clone.
9. **`node_modules` is per-worktree.** Bun's content-addressed store
   makes the disk cost tolerable. Build artifacts are also per-worktree.
   Don't try to share.
10. **Lifecycle is part of `agent restart`.** Worktree provisioning,
    ff-when-clean, and stale-branch cleanup happen as part of the
    `restart = reconcile + restart` contract — same as systemd unit
    rendering. No new manual command.

## What this enables

- Multiple main agents make parallel PRs on the same repo on the same
  host with zero coordination.
- An agent's session can be killed and resumed and find its worktree
  exactly where it left it, including uncommitted work.
- Sub-agent workers stack naturally — each task gets a worktree off the
  agent's worktree off the canonical clone — three layers, all isolated.
- The user scales the fleet by adding agents. They never debug a
  "two agents stomped the working tree" incident, because the product
  doesn't allow it.

## UAT prompts

Use these to evaluate whether an implementation truly delivers the job:

- "Add a second agent that works on the same repo as an existing agent.
  Did you have to do anything beyond editing `switchroom.yaml`?"
- "Have two agents both run a long task on the same repo at the same
  time. Did either notice the other? Did either's tree end up in an
  unexpected state?"
- "Reboot the host while one agent has uncommitted work in its
  worktree. After reboot, is the work still there, on the same branch?"
- "Remove an agent that owns worktrees on three different repos. Did
  any orphan branches or directories survive?"
- "Read your agent's SOUL.md and skills. Do any of them hardcode an
  absolute path to a repo? They shouldn't — they should use the env."

## See also

- [`run-a-fleet-of-specialists.md`](run-a-fleet-of-specialists.md) — the
  consistent-lifecycle promise this job operationalises.
- [`extend-without-forking.md`](extend-without-forking.md) — the
  scaffold-not-code-change principle this job inherits.
- [`survive-reboots-and-real-life.md`](survive-reboots-and-real-life.md)
  — the recovery story the dirty-tree policy serves.
- [`docs/sub-agents.md`](../docs/sub-agents.md) — the precedent: sub-agents
  already get their own worktree per task. This job extends the same
  pattern to main agents.
