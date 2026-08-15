# Worktree GC — reclaiming stale dev worktrees

Coding agents create per-task git worktrees (`~/code/switchroom-<slug>`) and
should remove them when the PR merges. In practice that step gets skipped, and
over months the dev host accreted ~300 leftover directories / ~20 GB (cleaned
2026-06-23). `switchroom worktree gc` is the durable backstop.

## What it does

Two failure classes, handled safely:

- **Orphaned worktree dirs** — the directory's `.git` *file* points at a
  `<repo>/.git/worktrees/<name>` admin dir that was already pruned, so git can
  no longer operate in it. GC attributes each orphan by its **own** gitdir
  pointer (so it works across multiple checkouts of the same repo) and only
  acts when the pointer targets a **validated switchroom repo**. Orphans are
  **moved** to `~/.switchroom/worktree-gc-trash/<date>/` — never deleted
  outright, because uncommitted work in an orphan can't be verified via git.

- **Registered-but-unremoved worktrees** — still in `git worktree list` with a
  merged PR. GC removes one **only** when `gh` reports its PR `MERGED` *and* the
  tree is effectively clean (a modified `src/build-info.ts` and untracked
  `*.tgz` artifacts are tolerated; anything else, including a staged-but-
  uncommitted new file, protects the worktree). `CLOSED` (abandoned) PRs are
  **not** eligible. With no `gh` available it removes nothing (a squash-merged
  branch is never an ancestor of `main`, so there is no safe local fallback).

Always protected: the main checkout, bare repos, registry-claimed worktrees
(`~/.switchroom/worktrees/`), per-agent and Claude Code isolation worktrees
(`*/work/*`, `.claude/worktrees/*`, `agent/*`/`task/*` branches), and any
`/tmp`, `/host`, `/state` (container-internal) paths.

## Cross-uid trees and unreadable dirs

Per-agent task trees under `~/.switchroom/agents/*/home/work/` are owned by each
agent's own uid, not the operator's. A plain `git -C <dir> …` refuses those with
`fatal: detected dubious ownership`, so GC runs every probe with a **scoped**
`-c safe.directory=<dir>` (never `safe.directory=*`) plus
`-c core.fsmonitor=false -c core.hooksPath=/dev/null` — an ownership bypass
without those two would let an agent-writable `.git/config` execute arbitrary
code as whoever runs GC. The three flags are inseparable; see `gitArgs()` in
`src/worktree/gc.ts`.

A git probe that **fails** is not a "no". Such dirs are reported separately:

```
Unreadable dirs — git probe failed, kept (N):
```

and are always kept — an unreadable or broken repo can never be classified as
clean, so it can never be reaped. Only dirs whose probe *succeeded* and answered
"not a switchroom repo" fall into the bland `Ignored non-switchroom dirs: N`
count. If that count is implausibly large and the unreadable count is zero,
you are probably looking at a real classification result; if the unreadable
count is large, fix the ownership/permissions before trusting the plan.

## Usage

```bash
switchroom worktree gc                 # dry-run against ~/code (default)
switchroom worktree gc --yes           # act: quarantine orphans + remove merged
switchroom worktree gc --root ~/code --root /other/parent   # extra scan roots
switchroom worktree gc --json          # machine-readable plan (auditable)

# Recover space later (separate, explicit step):
switchroom worktree gc --purge-trash             # dry-run: what would be deleted
switchroom worktree gc --purge-trash --older-than 14 --yes   # hard-delete ≥14d old
```

Quarantine reclaims space only after `--purge-trash`; until then a quarantined
worktree can be moved back out of the trash dir.

## Weekly cron (safety net)

Run GC weekly so forgotten worktrees self-clean, and purge quarantined dirs
once they've aged out. `HOME` must be set so `gh` finds its token.

Find the `switchroom` binary first (`command -v switchroom`) — on this host it
resolves under `~/.bun/bin` or `~/.nvm/.../bin`, **not** `/usr/local/bin` — and
put that dir on the cron `PATH` (cron has a minimal default PATH).

```cron
# crontab -e  for the operator user (HOME + PATH set so `switchroom` and `gh`
# resolve — substitute your own operator home / bin dir for /home/op below)
HOME=/home/op
PATH=/usr/bin:/bin:/home/op/.bun/bin
# Sun 04:00 — quarantine merged/orphaned worktrees
0 4 * * 0   switchroom worktree gc --yes >> /var/log/switchroom/worktree-gc.log 2>&1
# Sun 04:10 — purge anything quarantined ≥14 days ago
10 4 * * 0  switchroom worktree gc --purge-trash --older-than 14 --yes >> /var/log/switchroom/worktree-gc.log 2>&1
```

A `gh` API error mid-run is treated as "unknown ⇒ keep", so a transient
network/auth failure never deletes a worktree; the `--json` output records the
signal used per worktree for audit.
