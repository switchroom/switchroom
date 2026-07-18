---
artifact: agent-home lifecycle — durable-vs-ephemeral split + deterministic scratch reaper
serves: give-each-agent-its-own-workspace
advances-outcome: always-available
relates: reference/rfcs/deploy-reliability.md
status: Draft
---

# Agent-home lifecycle — split durable identity from disposable scratch, then reap the scratch

Read this before touching the compose generator's agent-service mounts
(`src/agents/compose.ts:emitAgentService`), the per-agent worktree
provisioner (`src/repos/agent-worktree.ts`), or the worktree GC / reaper
(`src/worktree/`).

This is the standing design record for a **structural** fix: an agent's
durable identity and its disposable scratch currently live in the **same**
persistent bind-mounted tree, and **nothing reaps the scratch**. The result
is unbounded growth of regenerable junk on the durable disk.

## The failure (observed in production, 2026-07)

The fleet's agent homes at `~/.switchroom/agents/<name>/` had grown to ~91 GB
of millions of tiny files, on a slow SMR disk, with **no garbage
collection**. That made the whole fleet slow and made the disk migration
(see MEMORY: *Free disk: relocate to bulkdata*) painful. Concretely:

- **One busy agent (klanker) held ~50 stale task worktrees** under its home
  (`work/<slug>` and `home/work/<slug>` — e.g. `release-v0.18.22`,
  `fix-3019`, `review-3022`, `switchroom-2996-p5`). Each is a **full
  switchroom checkout + `node_modules`** for a PR that has long since merged
  or closed.
- **6+ `tmp/switchroom-apply-home-*` directories**, each containing a
  throwaway `vault-grants.db` — an apply-path cleanup leak (see §3).

None of this is identity. All of it regenerates from git + `bun install`.
Yet it accumulates on the same tree that holds the few megabytes that
genuinely cannot be recreated.

## Root cause — durable and ephemeral share one bind mount

The compose generator binds the **entire** agent home as one durable mount,
and points the container's `HOME` **inside** it:

- `src/agents/compose.ts:2456` —
  `${homePrefix}/.switchroom/agents/${a.name}:/state/agent` (the whole tree,
  read-write, persistent across recreate).
- `src/agents/compose.ts:2468` — the same host directory is dual-mounted at
  its host path too (so scaffolded absolute paths resolve inside the
  container).
- `src/agents/compose.ts:2034` — `HOME: "/state/agent/home"`. Because `HOME`
  is a subdirectory of the durable mount, **everything HOME-rooted is
  durable**: `~/.cache`, `~/.npm`, `~/.local` (pip `--user`),
  `~/.npm-global` (`NPM_CONFIG_PREFIX`, `compose.ts:2039`), shell history,
  and — critically — `~/work` (Claude Code `isolation: worktree` checkouts).

The per-agent task worktrees land in the same tree by construction:

- `src/repos/agent-worktree.ts:51` —
  `agentWorktreePath = join(agentDir, "work", slug)`. `agentDir` is
  `~/.switchroom/agents/<name>`, so every provisioned worktree (full
  checkout + its own `node_modules`) is inside `/state/agent`, the durable
  mount. `ensureAgentWorktree` (`agent-worktree.ts:150`) is the only creator;
  `removeAgentWorktree` (`agent-worktree.ts:256`) is called **only** on
  `switchroom agent remove` (agent teardown) — never for a stale task
  worktree whose PR merged.

### What is actually durable (must survive — a few MB)

- `telegram/registry.db`, `telegram/history.db` (turn history / registry).
- `workspace/` (the agent's persona).
- `memory/` (per-agent memory bank material).
- `.claude/` session state and credentials, `.vault-token`, `schedule.d/`,
  small HOME dotfile configs (`.gitconfig`, `~/.config/gh`, `~/.ssh` — the
  deliberate reason `HOME` was made persistent, `compose.ts:2028-2033`).

### What is ephemeral (regenerable — the 91 GB)

- `work/<slug>` and `home/work/<slug>` task worktrees (checkout +
  `node_modules`).
- `~/.cache`, `~/.npm`, `~/.npm-global`, `~/.local`, build caches.
- `tmp/switchroom-*-home-*` leaked test temp homes.

The durable set is small and precious; the ephemeral set is large and
regenerable. Today they share one mount, one disk, and one (absent)
lifecycle.

### Why nothing reaps it

Two mechanisms exist in `src/worktree/`, and **neither covers per-agent home
worktrees**:

1. **`switchroom worktree reap`** (`src/worktree/reaper.ts`) governs only
   registry-**claimed** worktrees. `planReaper` iterates `listRecords()`
   (`reaper.ts:219`) — the in-container claim pool. A raw
   `git worktree add` under `agents/<name>/work` is never in that registry,
   so the reaper never sees it.
2. **`switchroom worktree gc`** (`src/worktree/gc.ts`) scans dev worktrees
   under `~/code` (`defaultRoots()`, `gc.ts:533`) and removes only on a
   positive GitHub **MERGED** signal + clean tree. It **explicitly
   skip-protects** per-agent worktrees: `looksLikeAgentWorktree`
   (`gc.ts:160`) returns true for any path matching `/work/` (and
   `agent/`|`task/` branches), and `classifyRegistered` (`gc.ts:146`) maps
   that to `skip-protected`. So `agents/<name>/work/<slug>` is **deliberately
   excluded today** — the reaper was expected to own it, but the reaper only
   owns the claim pool. The gap is real and total.

Neither reaper runs on a schedule: both are CLI verbs
(`src/cli/worktree.ts`), invoked by hand. Agents demonstrably do not clean
up after themselves (klanker's 50 stale trees are the proof), so a fix that
depends on the agent choosing to tidy is not a fix.

## Proposal

Four parts. §1 is the structural primary fix; §2 is the deterministic safety
net; §3 stops one specific leak at its source; §4 closes the GC coverage gap.

### 1. Durable / ephemeral split (primary fix)

Keep the durable identity where it is, and **relocate the heavy regenerable
scratch onto a separate, disposable mount** whose loss costs zero identity.

**Mount.** In `emitAgentService`, alongside the existing durable mount
(`compose.ts:2456`), emit a second per-agent bind:

```
- ${scratchPrefix}/${a.name}:/scratch
```

`scratchPrefix` defaults to `${homePrefix}/.switchroom/scratch` and is
operator-overridable to a disposable disk. On this host that should be the
1.7 TB `bulkdata` mount (see MEMORY: *Fleet host docker+disk topology* —
`~/.switchroom` is on the slow SMR root; `bulkdata` is the fast, large,
`nofail` volume). Pre-create `${scratchPrefix}/${a.name}` owned by the agent
uid at generation time, exactly as the existing `schedule.d` /
`blocked-approvals` pre-creates do (`compose.ts:2596`, and per CLAUDE.md's
root-context-editing rule and `src/agents/agent-owned-tree.ts` ownership
sweep — a root-owned scratch dir would storm the operator with approval
cards, cf. #3168).

**Redirect the heavy caches into `/scratch`** via env, mirroring the existing
`NPM_CONFIG_PREFIX` / `PIP_*` pattern (`compose.ts:2039-2057`):

- `SWITCHROOM_AGENT_SCRATCH=/scratch` (new; consumed by the worktree
  provisioner below).
- `XDG_CACHE_HOME=/scratch/cache`, `npm_config_cache=/scratch/npm-cache`.
- `TMPDIR=/scratch/tmp` — this also moves any future temp leak (including the
  §3 one) onto disposable storage instead of the durable identity tree, and
  honours CLAUDE.md's "exec-capable `TMPDIR`" requirement without pointing it
  at the durable home.
- `PYTHONUSERBASE=/scratch/pylocal` so `pip --user` lands in scratch.

Deliberately **not** moved: the small HOME configs (`.gitconfig`,
`~/.config/gh`, `~/.ssh`, shell history). Those were the whole reason `HOME`
was made persistent (`compose.ts:2028-2033`); they are tiny and are part of
identity. The split is not "HOME is ephemeral" — it is "the heavy,
regenerable, HOME-rooted caches and checkouts move to `/scratch`."

**Relocate task worktrees.** `agent-worktree.ts:agentWorktreePath`
(`agent-worktree.ts:51`) changes its base from `join(agentDir, "work", slug)`
to a scratch root when `SWITCHROOM_AGENT_SCRATCH` is set:
`join(scratchRoot, "work", slug)`. Only the working tree + `node_modules`
move; the bare clone / object store (`src/repos/bare-clone.ts`) and the
per-agent branch stored in it are untouched, so branch state and the
never-reset-dirty semantics (`agent-worktree.ts:200`) are preserved. This is
a **forward-only** change: existing in-place trees under
`agents/<name>/work` keep working until reaped by §4.

**Blast-radius property.** After the split, `/state/agent` (durable) holds
only the few-MB identity set and stays small. `/scratch` can be capped,
evicted, or in the worst case entirely lost (disk-full, manual wipe, agent
recreate) **without touching `registry.db`, `history.db`, `memory/`, or
`workspace/`**. "Wipe freely" means *relative to identity* — in-flight
**uncommitted or unpushed** work inside a scratch worktree is still protected
by the guard in §2. Losing scratch costs at most some clean, idle,
regenerable checkouts.

### 2. Deterministic scratch reaper (safety net)

A **model-free, deterministic** reaper — never a self-cleanup prompt. This is
the claude-native invariant (a reaper that reasoned with a model would be a
new model callsite) *and* the dev-protocol rule "deterministic mechanisms
over model-dependent behaviour." All inputs are git state, mtime, `du`, and
the GitHub PR signal `gh` already provides.

Implement it as an **extension of `switchroom worktree gc`** (§4 wires the
roots) plus a periodic invocation, reusing the primitives that already exist:

- **Reap merged/closed worktrees.** `gc.ts:defaultPrSignal` (`gc.ts:222`)
  already returns `merged`/`closed`/`open`/`none`. For per-agent home
  worktrees, `merged` **or** `closed` is reap-eligible (an abandoned PR is a
  strong signal for a *task* tree; the current dev-worktree policy keeps
  CLOSED, `gc.ts:150` — the home-worktree policy is more aggressive because
  these are disposable task trees, not the operator's dev checkouts). Always
  gated by the clean + idle guards below.
- **Uncommitted-work guard (mandatory).** Reuse the exact check the reaper
  already uses: `git status --porcelain` non-empty ⇒ keep, and **any git
  error fails toward preservation** (`reaper.ts:175-188`; the equivalent
  clean predicate is `gc.ts:isEffectivelyClean`, `gc.ts:112`). Never a
  warning-that-proceeds — a hard skip, per the F1/H3 data-loss lesson
  (`reaper.ts:11-23`).
- **Unpushed-work guard (new — closes a real gap).** The existing guards
  catch *uncommitted* work but **not committed-but-unpushed** work. A tree
  can be `git status`-clean yet hold commits that exist nowhere else. The
  reaper must additionally require the branch to be fully pushed:
  `git -C <wt> log --oneline @{upstream}..HEAD` empty **and** an upstream
  exists; **no upstream ⇒ treat as unpushed ⇒ keep**. This is the same
  fail-toward-preservation posture as the uncommitted guard.
- **Idle guard.** Only reap a worktree whose newest tracked mtime is older
  than `N` days (default 14), and whose path is provably free — reuse
  `probePathInUse` (`reaper.ts:133`), which distinguishes "probe ran, path
  free" from "no `fuser`/`lsof` ⇒ unavailable ⇒ treat as live and keep."
- **Drop stale `node_modules`.** A cheaper sweep than removing a whole tree:
  delete `node_modules` (and `XDG_CACHE_HOME` subtrees) under `/scratch`
  whose mtime is older than `N` days when the owning worktree is idle. The
  checkout and branch survive; `bun install` regenerates on next use.
- **Per-agent size budget, oldest-first eviction.** Compute `du` per scratch
  root; when over `SWITCHROOM_AGENT_SCRATCH_BUDGET` (default e.g. 5 GB),
  evict oldest **idle + clean + pushed** worktrees (and stale `node_modules`)
  oldest-first until under budget, never crossing the guards above.
- **When the guards block progress, surface — never force.** If everything
  over budget is dirty/unpushed/in-use, the reaper does **not** force-remove;
  it records the skip visibly (the `ReapResult.skipped` pattern,
  `reaper.ts:67-77`, and the quarantine-not-`rm` posture of gc,
  `gc.ts:17-28`) so the consequence is operator-visible rather than silent
  accumulation. This mirrors the fleet's "hold + surface, never silently
  destroy" discipline (MEMORY: *Undeliverable approval: hold + surface*).

**Where it runs.** Host-side, as a singleton pass over all agents (the same
side `gc` already runs on for `~/code`), invoked periodically. Preferred
trigger: a fleet-managed schedule via the existing scheduler
(`src/agent-scheduler/` → the host singleton), not N in-container cron loops.
The pass is idempotent and safe to run at any cadence (all guards apply on
every run, dry-run included, via a single `plan*` predicate — the
`planReaper`/`planGc` pattern that keeps dry-run and real runs from diverging,
`reaper.ts:206`, `gc.ts:263`).

### 3. Fix the apply-home tmp leak

**Root cause.** `src/cli/apply.test.ts:64` does
`mkdtemp(join(tmpdir(), "switchroom-apply-home-"))` and sets it as `HOME`;
the `afterEach` (`apply.test.ts:67-73`) restores the previous `HOME` but
**never removes the sandbox directory**. The same pattern leaks
`switchroom-dryrun-home-*` (`apply.test.ts:699`). During the test, `runApply`
pre-creates the grants DB directory and runs
`migrateLegacyGrantsDbLocation` (`src/cli/apply.ts:1059-1061`), which is why
each leaked sandbox contains a throwaway `vault-grants.db`. klanker runs the
full suite (`npm test`) continuously, so these accumulate on its home — the
6+ dirs observed.

**Fix.**
1. Track and remove the sandbox in `afterEach` —
   `rmSync(_homeSandbox, { recursive: true, force: true })` — the exact
   pattern already used elsewhere in the same file (`apply.test.ts:541`,
   `:575`, `:593`). Apply to both the apply and dry-run blocks. This kills the
   leak **at the source, regardless of `TMPDIR`**.
2. Belt-and-braces from §1: with `TMPDIR=/scratch/tmp`, any residual
   temp-home leak lands on disposable scratch, and the §2 sweep of
   `tmp/switchroom-*-home-*` older than a few hours cleans it.

(Confirmed: `switchroom-apply-home` appears **only** in `apply.test.ts`, not
in any production apply path — this is a test-hygiene leak amplified by the
continuous test runner, not a bug in `runApply` itself.)

### 4. Extend `switchroom worktree gc` to per-agent home worktrees

Today gc's `defaultRoots()` is `~/code` only (`gc.ts:533`) and it
skip-protects anything matching `/work/` (`gc.ts:146,160`). Extend it:

- Add `~/.switchroom/agents/*/work` and `~/.switchroom/scratch/*/work` to the
  scanned roots.
- Carve the home-worktree roots out of the blanket `looksLikeAgentWorktree`
  skip so they are actually classified — but keep the **registry-claimed**
  exclusion (`gc.ts:358`, via `listRecords()`) so a live claim-pool worktree
  is never GC'd out from under the reaper, and keep every clean/PR/idle guard
  from §2. Claude Code `.claude/worktrees/` isolation trees stay protected
  (`gc.ts:162`) — those are harness-owned and may be live.

This unifies the two mechanisms: the claim-pool reaper keeps its
heartbeat-based liveness model for pool worktrees; gc becomes the
day-scale, PR-signal owner for the per-agent home/scratch worktrees it
currently ignores.

## Design-contract check

**Vision outcome:** primarily **always-available** — 91 GB of regenerable
junk on a slow SMR disk degraded the whole fleet and blocked migration;
bounding it keeps the fleet responsive and the box operable. Also serves the
**standing-team** outcome via the job below.

**Job spec:** `reference/jobs/give-each-agent-its-own-workspace.md`. Its
*Prove it* section already demands "Orphan cleanup / reaping — abandoned
trees are reaped, not accumulated … trees are part of the lifecycle, not
leaked forever," and its *Production-readiness* says "working trees share the
object store; per-agent full clones are not used." Today the product fails
both for per-agent home worktrees. This RFC delivers them. Its `> [!CAUTION]`
("Switchroom never resets a dirty tree on the agent's behalf") is why §2's
uncommitted **and** unpushed guards are mandatory and hard-skip, never
warn-and-proceed.

**Three principle checks:**

- *Docs test ("if they need the docs, we've failed").* The user never runs a
  git or worktree command and never learns the scratch path — it is plumbing,
  injected via env, and reaped automatically. Passes.
- *Defaults test ("batteries included").* Scratch is capped and reaped by
  default with safe defaults (14-day idle, size budget), no operator
  assembly. Passes.
- *Consistency test ("one mind built this").* Reuses the existing reaper
  primitives — `probePathInUse`, the porcelain clean check, the plan/dry-run
  split, quarantine-not-`rm`, the pre-create-owned-by-uid convention — rather
  than inventing a parallel cleanup path. Passes.

**Invariants (none crossed):**

- **claude-native** — the reaper is deterministic and model-free; no new
  model or `claude -p` callsite.
- **chat-is-the-single-source-of-truth** — scratch is regenerable, never a
  source of truth; the durable identity (history, memory, persona) is
  untouched and, if anything, better protected by the blast-radius split.
- **single-tenant / on-leash / no-self-escalation** — unaffected; this is
  storage lifecycle, no new reach.

## Migration & rollout

- **One-time reap of existing bloated homes.** Run the §4-extended
  `switchroom worktree gc` host-side, **dry-run first**, over the new roots.
  Merged/closed + clean + pushed + idle worktrees are removed (branches
  pruned via the existing `gc.ts:447` path); everything else is surfaced,
  not touched. Orphans quarantine to `~/.switchroom/worktree-gc-trash`
  (`gc.ts:249`) — recoverable until `gc --purge-trash`.
- **Don't break running agents.** The `/scratch` mount is **additive**; the
  durable `/state/agent` mount is unchanged, so a rolled-but-not-recreated
  agent keeps working. New worktrees/caches redirect to `/scratch` only after
  a recreate that picks up the new env + mount (`agent restart
  --force-recreate`; note MEMORY: *agent restart hot-reload skips image
  deploy* — assert the recreate actually happened). Existing in-place trees
  survive until reaped.
- **Placement.** Point `scratchPrefix` at `bulkdata` so scratch growth lands
  on the fast, large disk and off the SMR root — coordinate with the
  in-flight disk relocation (MEMORY: *Free disk: relocate to bulkdata*).
- **The uncommitted + unpushed guard is the safety contract** for every path
  here (one-time reap, periodic reap, size eviction). No path force-removes a
  dirty or unpushed tree; "can't tell" always fails toward preservation.

## Staged delivery

Focused, single-concern PRs, each independently shippable:

1. **§3 test-leak fix** — smallest, immediate, stops the bleed. No design
   surface.
2. **§4 gc coverage** — extend roots + guard carve-out + the new unpushed
   guard; pure-function decisions unit-tested per gc's existing style.
3. **§1 scratch mount + worktree relocation** — compose/scaffold/env +
   `agentWorktreePath` base change; snapshot-tested via
   `tests/docker/compose-generator.test.ts`.
4. **§2 periodic reaper wiring + size budget** — schedule the pass; the
   decision logic already lands in PR 2.

## Open questions for review

1. **Scratch worktree durability vs. the workspace job.** The job requires
   trees "stable across restart with in-flight work preserved." Moving trees
   onto a disposable mount is safe for *identity*, and the guards protect
   *dirty/unpushed* work — but is a separate mount the right home for a tree
   the job calls "stable," or should stable-across-restart worktrees stay on
   durable storage and only their `node_modules`/caches move to scratch?
   (The latter is more conservative and may be the better default.)
2. **Unpushed-work detection robustness.** `@{upstream}`/`@{push}` semantics
   across detached HEADs, deleted upstreams, and agent branches that were
   never pushed — is "no upstream ⇒ keep" too conservative (never reaps a
   never-pushed abandoned tree) or correctly safe?
3. **Backward-compat for the 91 GB already on disk.** The one-time reap is
   guard-gated, so genuinely-abandoned-but-dirty trees will *not* be removed
   and will keep occupying space until a human clears them. Is surfacing-only
   acceptable, or does the migration need an operator-driven escape hatch for
   known-dead dirty trees?
