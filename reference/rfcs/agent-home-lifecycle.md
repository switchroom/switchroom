---
artifact: agent-home lifecycle — disposable caches split from durable identity + deterministic task-tree reaper
serves: give-each-agent-its-own-workspace
advances-outcome: always-available
relates: reference/rfcs/deploy-reliability.md
status: Draft
---

# Agent-home lifecycle — split disposable caches from durable identity, then reap the task trees

Read this before touching the compose generator's agent-service mounts
(`src/agents/compose.ts:emitAgentService`), the per-agent worktree
provisioner (`src/repos/agent-worktree.ts`), or the worktree GC / reaper
(`src/worktree/`).

This is the standing design record for a **structural** fix: an agent's
regenerable scratch (caches, `node_modules`, and harness-created task
worktrees) grows without bound on the **same durable, bind-mounted tree** that
holds its identity, because **nothing reaps it**.

## The failure (observed in production, 2026-07)

The fleet's agent homes at `~/.switchroom/agents/<name>/` had grown to ~91 GB
of millions of tiny files, on a slow SMR disk, with **no garbage
collection**. That made the whole fleet slow and made the disk migration
(see MEMORY: *Free disk: relocate to bulkdata*) painful. Concretely:

- **One busy agent (klanker) held ~50 stale task worktrees** with names like
  `fix-3019`, `release-v0.18.22`, `review-3022`, `switchroom-2996-p5` — each a
  **full switchroom checkout + `node_modules`** for a PR that has long since
  merged or closed.
- **6+ `tmp/switchroom-apply-home-*` directories**, each containing a
  throwaway `vault-grants.db` — an apply-path cleanup leak (see §3).

None of this is identity. All of it regenerates from git + `bun install`.
Yet it accumulates on the same tree that holds the few megabytes that
genuinely cannot be recreated.

## Root cause — where the bloat actually comes from

Getting the attribution right matters, because it changes what §1 and §4 must
target. There are **three** kinds of worktree on an agent host, and only one
is the culprit:

1. **The stable per-repo tree** — `ensureAgentWorktree`
   (`src/repos/agent-worktree.ts:150`), called once per declared `repos:`
   slug from `reconcileAgent` (`src/agents/scaffold.ts` — the
   `for (const [slug, entry] of Object.entries(agentConfig.repos))` loop
   passes the **repo-map key as the slug**). It creates **one** tree per repo
   at `<agentDir>/work/<slug>` on the fixed branch `agent/<name>/main`
   (`agent-worktree.ts:43`), **reused across every task**, fast-forwarded when
   clean, left alone when dirty. This is bounded (one per declared repo) and
   is **not** the bloat. The `fix-3019` / `release-v0.18.22` names are not repo
   slugs.
2. **The claim pool** — `switchroom worktree claim` lands trees under
   `~/.switchroom/worktree-checkouts` (`src/worktree/claim.ts:66`,
   `worktreesBaseDir()`), registered in the registry and **already covered**
   by the heartbeat reaper (`src/worktree/reaper.ts`). Not the bloat either.
3. **Harness / agent-created task trees under `$HOME/work`** — the container's
   `HOME` is `/state/agent/home` (`src/agents/compose.ts:2034`), so a Claude
   Code `isolation: worktree` checkout or a raw `git worktree add ~/work/<x>`
   an agent runs for a one-off task lands at
   `~/.switchroom/agents/<name>/home/work/<slug>` on the host. These are
   **per-task**, **unregistered**, **never torn down**, and named after the
   task (`fix-3019`, `review-3022`, …). **This is the 91 GB.**

Because `HOME` is a subdirectory of the durable mount
(`compose.ts:2456` binds `${homePrefix}/.switchroom/agents/${a.name}` →
`/state/agent`, and `:2468` dual-mounts it at its host path), everything
HOME-rooted is durable: `home/work/<slug>` task trees, `~/.cache`, `~/.npm`,
`~/.local` (pip `--user`), `~/.npm-global` (`NPM_CONFIG_PREFIX`,
`compose.ts:2039`), and bun's install cache.

### What is durable (must survive — a few MB)

- `telegram/registry.db`, `telegram/history.db` (turn history / registry).
- `workspace/` (persona), `memory/` (memory-bank material).
- `.claude/` session + credentials, `.vault-token`, `schedule.d/`.
- The **stable per-repo tree** `work/<slug>` and its in-flight branch state —
  durable *by design* (see §1's vision grounding).
- Small HOME configs: `.gitconfig`, `~/.config/gh`, `~/.ssh`, shell history
  (the deliberate reason `HOME` was made persistent, `compose.ts:2028-2033`).

### What is ephemeral (regenerable — the 91 GB)

- `home/work/<slug>` per-task worktrees (checkout + `node_modules`).
- `~/.cache`, `~/.npm`, `~/.npm-global`, `~/.local`, bun install cache.
- `tmp/switchroom-*-home-*` leaked test temp homes.

### Why nothing reaps it

Two mechanisms exist in `src/worktree/`, and **neither covers
`home/work/<slug>`**:

1. **`switchroom worktree reap`** (`src/worktree/reaper.ts`) governs only
   registry-**claimed** worktrees — `planReaper` iterates `listRecords()`
   (`reaper.ts:219`). A raw `git worktree add` under `home/work` is never in
   that registry.
2. **`switchroom worktree gc`** (`src/worktree/gc.ts`) scans dev worktrees
   under `~/code` (`defaultRoots()`, `gc.ts:533`) and **skip-protects**
   anything matching `(^|/)work/` — `looksLikeAgentWorktree` (`gc.ts:160`)
   returns true, and `classifyRegistered` (`gc.ts:146`) maps that to
   `skip-protected`. `home/work/<slug>` matches that pattern, so it is
   **deliberately excluded today**.

Neither runs on a schedule (both are CLI verbs, `src/cli/worktree.ts`).
Agents demonstrably do not clean up after themselves (klanker's 50 trees are
the proof), so a fix that depends on the agent choosing to tidy is not a fix.

## Proposal

Four parts. §1 relocates only the regenerable **caches** onto disposable
scratch (worktrees stay durable — see the vision grounding). §2 is the
deterministic reaper that bounds the task trees. §3 stops one leak at source.
§4 closes the GC coverage gap and adds the operator escape hatch.

### 1. Relocate caches (not worktrees) to a disposable scratch mount

**Design decision, grounded in the vision.** An earlier draft proposed moving
the agent's worktrees onto a disposable mount. That is **wrong** and this RFC
rejects it. The job spec
`reference/jobs/give-each-agent-its-own-workspace.md` requires, under
*Production-readiness → Durability*, that "a reboot or kill mid-work leaves
each agent's tree **intact on its branch**; dirty trees are never reset," and
its *bad-list* forbids "a pool of scratch trees … the agent's tree must be
**stable across sessions** so in-flight state survives restart." That
durability-across-restart promise **is** the **always-available** vision
outcome ("Always available … done properly — there when you want it"). A
worktree on a wipeable mount breaks it by construction. **Therefore worktrees
stay on durable storage; only the regenerable caches move to scratch, and the
reaper (§2) — not a mount — is what bounds the task trees.**

**Mount.** In `emitAgentService`, alongside the existing durable mount
(`compose.ts:2456`), emit a second per-agent bind:

```
- ${scratchPrefix}/${a.name}:/scratch
```

`scratchPrefix` defaults to `${homePrefix}/.switchroom/scratch` and is
operator-overridable to a disposable disk. On this host that should be the
1.7 TB `bulkdata` mount (MEMORY: *Fleet host docker+disk topology* —
`~/.switchroom` is on the slow SMR root; `bulkdata` is the fast, large,
`nofail` volume). Pre-create `${scratchPrefix}/${a.name}` **owned by the agent
uid** at generation time, exactly as the existing `schedule.d` /
`blocked-approvals` pre-creates do (`compose.ts:2596`; per CLAUDE.md's
root-context rule + the `src/agents/agent-owned-tree.ts` ownership sweep — a
root-owned scratch dir would storm the operator with approval cards, cf.
#3168).

**Redirect the heavy caches into `/scratch`** via env, mirroring the existing
`NPM_CONFIG_PREFIX` / `PIP_*` pattern (`compose.ts:2039-2057`):

- `SWITCHROOM_AGENT_SCRATCH=/scratch` (new; consumed by §2/§4).
- `XDG_CACHE_HOME=/scratch/cache`, `npm_config_cache=/scratch/npm-cache`.
- **`BUN_INSTALL_CACHE_DIR=/scratch/bun-cache`** — the repo builds with
  **bun** (`bun.lock`, `bun install`), and bun ignores the npm/XDG cache vars,
  so its global install cache must be redirected explicitly or it keeps
  growing under `~/.bun` on the durable tree.
- `TMPDIR=/scratch/tmp` — also moves any future temp leak (including §3's)
  onto disposable storage, and honours CLAUDE.md's "exec-capable `TMPDIR`"
  requirement without pointing it at the durable home.
- `PYTHONUSERBASE=/scratch/pylocal` so `pip --user` lands in scratch.

**What these env redirects do and do not move.** They relocate the *shared*
caches (bun/npm/pip download caches, build/XDG caches, tmp). They do **not**
move a worktree's per-project `node_modules`: bun materialises `node_modules`
**inside** the project directory and has no per-project store-redirect knob
(unlike pnpm), so a task tree's `node_modules` stays in-tree on durable
storage. Bounding that per-tree `node_modules` is the reaper's job (§2's
stale-`node_modules` sweep), not a mount redirect. This reconciles with the
"worktrees stay durable" decision above: the *tree* is durable and stable; its
*regenerable `node_modules`* is reaped in place when stale.

**Blast-radius win.** After the split, the shared caches — the bulk of the
byte growth *outside* the task trees — live on a disposable, capped mount that
can be wiped without touching `registry.db`, `history.db`, `memory/`,
`workspace/`, or any worktree.

### 2. Deterministic task-tree reaper (the primary reclaim mechanism)

A **model-free, deterministic** reaper — never a self-cleanup prompt. This
satisfies the **claude-native** invariant (a reaper that reasoned with a model
would be a new model callsite) and the dev-protocol rule "deterministic
mechanisms over model-dependent behaviour." All inputs are git state, mtime,
`du`, and the GitHub PR signal `gh` already provides.

Implement it as an **extension of `switchroom worktree gc`** (§4 wires the
roots) plus a periodic invocation, reusing existing primitives:

- **Clean predicate: use `isEffectivelyClean` (`gc.ts:112`), not the reaper's
  `hasUncommittedChanges` (`reaper.ts:175`).** They are **not** equivalent:
  `hasUncommittedChanges` treats *any* `git status --porcelain` output as
  dirty, while `isEffectivelyClean` tolerates a regenerated `src/build-info.ts`
  and untracked `*.tgz` pack artifacts. A switchroom task tree is **built**
  (`bun run build` rewrites `build-info.ts`; release trees leave `*.tgz`), so
  `hasUncommittedChanges` would pin virtually every idle tree as "dirty"
  forever — build noise must not veto a reap. Use `isEffectivelyClean` and say
  so.
- **Uncommitted-work guard (mandatory).** Non-empty *effective* porcelain ⇒
  keep, as a **hard skip** (never warn-and-proceed — the F1/H3 data-loss
  lesson, `reaper.ts:11-23`). Any git error fails toward preservation.
- **Unpushed-work guard.** The clean check catches *uncommitted* work but not
  committed-but-unpushed work. Additionally require the branch fully pushed:
  `git -C <wt> log --oneline @{upstream}..HEAD` empty **and** an upstream
  exists; **no upstream / detached HEAD ⇒ treat as unpushed ⇒ keep**. Same
  fail-toward-preservation posture.
- **Merged/closed PR signal.** `gc.ts:defaultPrSignal` (`gc.ts:222`) already
  returns `merged`/`closed`/`open`/`none`. For `home/work` task trees,
  `merged` **or** `closed` is reap-eligible (an abandoned PR is a strong
  signal for a disposable *task* tree; the dev-worktree policy keeps CLOSED,
  `gc.ts:150`, but these are not the operator's dev checkouts). Always gated by
  the clean + pushed + idle guards.
- **Idle guard.** Only reap a tree whose newest tracked mtime is older than
  `N` days (default 14) and whose path is provably free — reuse
  `probePathInUse` (`reaper.ts:133`), which distinguishes "probe ran, free"
  from "no `fuser`/`lsof` ⇒ unavailable ⇒ treat as live and keep."
- **Drop stale `node_modules` in place.** Cheaper than removing a tree: delete
  `node_modules` under a `home/work` tree whose mtime is older than `N` days
  when the tree is idle. The checkout and branch survive; `bun install`
  regenerates on next use. (This is the mechanism that bounds the per-tree
  `node_modules` §1 leaves in place.)
- **Per-agent size budget, oldest-first eviction.** Compute `du` per agent
  home; when over `SWITCHROOM_AGENT_SCRATCH_BUDGET` (default e.g. 5 GB), evict
  oldest **idle + clean + pushed** task trees (and stale `node_modules`)
  oldest-first until under budget, never crossing the guards.
- **When the guards block progress, surface — then let the operator decide
  (§4's escape hatch).** If everything over budget is dirty/unpushed/in-use,
  the reaper does **not** force-remove; it records the skip visibly (the
  `ReapResult.skipped` pattern, `reaper.ts:67-77`) so the consequence is
  operator-visible, and the operator drives the reversible escape hatch below.

Determinism keeps this within claude-native and mirrors the fleet's "hold +
surface, never silently destroy" discipline (MEMORY: *Undeliverable approval:
hold + surface*).

### 3. Fix the apply-home tmp leak

**Root cause.** `src/cli/apply.test.ts:64` does
`mkdtemp(join(tmpdir(), "switchroom-apply-home-"))` and sets it as `HOME`; the
`afterEach` (`apply.test.ts:67-73`) restores the previous `HOME` but **never
removes the sandbox directory**. The same pattern leaks
`switchroom-dryrun-home-*` (`apply.test.ts:699`). During the test `runApply`
pre-creates the grants DB directory and runs `migrateLegacyGrantsDbLocation`
(`src/cli/apply.ts:1059-1061`), which is why each leaked sandbox contains a
throwaway `vault-grants.db`. klanker runs the full suite (`npm test`)
continuously, so these accumulate — the 6+ dirs observed.

**Fix.**
1. Track and remove the sandbox in `afterEach` —
   `rmSync(_homeSandbox, { recursive: true, force: true })` — the exact
   pattern already used elsewhere in the same file (`apply.test.ts:541`,
   `:575`, `:593`). Apply to both the apply and dry-run blocks. Kills the leak
   **at source, regardless of `TMPDIR`**.
2. Belt-and-braces from §1: with `TMPDIR=/scratch/tmp`, any residual temp-home
   leak lands on disposable scratch, and the §2 sweep of
   `tmp/switchroom-*-home-*` older than a few hours cleans it.

(Confirmed: `switchroom-apply-home` appears **only** in `apply.test.ts`, not
in any production apply path — a test-hygiene leak amplified by the continuous
test runner, not a bug in `runApply`. Ship this PR first.)

### 4. Extend `switchroom worktree gc` to cover `home/work` task trees

Today gc's `defaultRoots()` is `~/code` only (`gc.ts:533`) and it
skip-protects `(^|/)work/` (`gc.ts:160`). Extend it:

- **Add the per-agent task-tree roots** to the scan:
  `~/.switchroom/agents/<name>/home/work` for every agent (and, for
  legacy/back-compat, `~/.switchroom/agents/<name>/work` — though that is the
  bounded stable per-repo tree and normally stays). Note `planGc` reads the
  **immediate subdirs of each *literal* root** (`gc.ts:263-343`, the
  `for (const root of roots)` → `readDir(root)` loop), so `agents/*/home/work`
  is a **glob that must be expanded to concrete per-agent paths** before it
  reaches `planGc` — enumerate `~/.switchroom/agents/*` and append
  `/home/work` to each. A bare glob string would be read as a literal
  directory name and silently match nothing.
- **Carve `home/work` out of the blanket skip.** `looksLikeAgentWorktree`
  (`gc.ts:160`) matches `(^|/)work/`, which catches `home/work/<slug>` — so
  the carve-out must **explicitly** exempt the task-tree roots from that skip
  (e.g. a "this root is a reap-eligible task-tree root" flag threaded into
  `classifyRegistered`, `gc.ts:145`), while still:
  - keeping the **registry-claimed** exclusion (`gc.ts:358`, via
    `listRecords()`) so a live claim-pool tree is never GC'd from under the
    reaper;
  - keeping **`.claude/worktrees/`** protected while live/in-use (`gc.ts:162`)
    — the idle + `probePathInUse` guard from §2 governs when a paused Claude
    isolation tree becomes eligible;
  - protecting the **stable per-repo tree** on branch `agent/<name>/main`
    (`agent-worktree.ts:43`) — it is durable identity, not a disposable task
    tree;
  - applying every clean (`isEffectivelyClean`) + pushed + PR + idle guard
    from §2.

**Operator escape hatch (resolves the "abandoned-but-dirty" reclaim gap),
grounded in the vision.** The guard-gated reaper fails toward preservation on
dirty / detached / never-pushed trees, so it provably will **not** reclaim
those — they would accumulate forever waiting on a human `rm`. That is
unacceptable for the existing 91 GB. The **on-the-leash** vision outcome ("You
hold the leash — controlled, purposeful") says the **operator** makes that
call, purposefully and reversibly. Resolution: surfaced skips become an
operator-triggered **quarantine-to-trash** action — reuse gc's existing
**quarantine-not-`rm`** move (`gc.ts:249` / `applyGc`'s `move`,
`gc.ts:415-440`, → `~/.switchroom/worktree-gc-trash`, recoverable until
`gc --purge-trash`, `gc.ts:517`). The operator runs one command to move all
surfaced dead-but-dirty task trees to trash; nothing is destroyed until they
later purge. This is reversible operator control, not silent deletion and not
indefinite waiting.

## Design-contract check

**Vision outcome:** primarily **always-available** — 91 GB of regenerable junk
on a slow SMR disk degraded the whole fleet and blocked migration; bounding it
keeps the fleet responsive and the box operable. The decision to keep
worktrees durable (§1) is *driven by* always-available (restart durability).
Also serves **standing-team** via the job below, and **on-the-leash** via the
operator escape hatch (§4).

**Job spec:** `reference/jobs/give-each-agent-its-own-workspace.md`. Its
*Prove it* section already demands "Orphan cleanup / reaping — abandoned trees
are reaped, not accumulated … trees are part of the lifecycle, not leaked
forever," and its *Production-readiness → Durability* clause ("a reboot or kill
mid-work leaves each agent's tree intact on its branch; dirty trees are never
reset") is exactly what forces §1 to keep worktrees durable and §2's
uncommitted **and** unpushed guards to hard-skip, never warn-and-proceed. Its
`> [!CAUTION]` ("Switchroom never resets a dirty tree on the agent's behalf")
is why the escape hatch quarantines (reversible) rather than deletes.

**Three principle checks:**

- *Docs test ("if they need the docs, we've failed").* The user never runs a
  git or worktree command and never learns the scratch path — caches are
  redirected via env, task trees are reaped automatically, the escape hatch is
  one operator command. Passes.
- *Defaults test ("batteries included").* Caches are capped and task trees
  reaped by default with safe defaults (14-day idle, size budget), no operator
  assembly. Passes.
- *Consistency test ("one mind built this").* Reuses the existing reaper/gc
  primitives — `isEffectivelyClean`, `probePathInUse`, the plan/dry-run split,
  quarantine-not-`rm`, the pre-create-owned-by-uid convention — rather than a
  parallel cleanup path. Passes.

**Invariants (none crossed):**

- **claude-native** — the reaper is deterministic and model-free; no new model
  or `claude -p` callsite.
- **chat-is-the-single-source-of-truth** — caches/task trees are regenerable,
  never a source of truth; durable identity (history, memory, persona, stable
  repo tree) is untouched.
- **on-leash / single-tenant / no-self-escalation** — the escape hatch is
  operator-driven and reversible; no new agent reach.

## Migration & rollout

- **One-time reclaim of the existing 91 GB.** Run the §4-extended
  `switchroom worktree gc` host-side, **dry-run first**, over the per-agent
  `home/work` roots. Merged/closed + clean + pushed + idle trees are removed
  (branches pruned via `gc.ts:447`); dead-but-dirty/detached trees are
  **surfaced**, then reclaimed via the **operator escape hatch**
  (quarantine-to-trash, `gc.ts:249`) — reversible until `gc --purge-trash`.
- **Don't break running agents.** The `/scratch` mount and cache-redirect env
  are **additive**; the durable `/state/agent` mount and every worktree are
  unchanged, so a rolled-but-not-recreated agent keeps working. Caches
  redirect to `/scratch` only after a recreate that picks up the new env +
  mount (`agent restart --force-recreate`; MEMORY: *agent restart hot-reload
  skips image deploy* — assert the recreate actually happened).
- **Placement.** Point `scratchPrefix` at `bulkdata` so cache growth lands on
  the fast, large disk and off the SMR root — coordinate with the in-flight
  disk relocation (MEMORY: *Free disk: relocate to bulkdata*).
- **The uncommitted + unpushed guard is the safety contract** for every
  automatic path; the escape hatch is the only path that touches a dirty tree,
  and it quarantines rather than deletes.

## Staged delivery

Focused, single-concern PRs, each independently shippable:

1. **§3 test-leak fix** — smallest, immediate, stops the bleed. No design
   surface. **Ship first.**
2. **§4 gc coverage** — expand roots to per-agent `home/work` (with glob
   expansion), the `home/work` carve-out, the `isEffectivelyClean` + unpushed
   guards, and the operator quarantine escape hatch; pure-function decisions
   unit-tested per gc's existing style.
3. **§1 scratch mount + cache redirects** (bun/npm/pip/XDG/tmp) —
   compose/scaffold/env; snapshot-tested via
   `tests/docker/compose-generator.test.ts`. Worktrees are **not** relocated.
4. **§2 periodic reaper wiring + size budget** — schedule the pass; the
   decision logic already lands in PR 2.

## Open questions for review

1. **Unpushed-work detection robustness.** `@{upstream}`/`@{push}` semantics
   across detached HEADs, deleted upstreams, and never-pushed task branches —
   the RFC picks "no upstream / detached ⇒ keep" (safe), which never
   *auto*-reaps a never-pushed abandoned tree. The operator escape hatch is
   the intended reclaim path for those; confirm that division is right.
2. **Idle threshold + size budget defaults** (14 days / 5 GB) — want a
   reviewer sanity-check against klanker's real churn (it is the dedicated
   test runner and legitimately holds more active trees than a conversational
   agent; the per-profile resource split at `compose.ts:137` suggests the
   budget may want to be profile-scoped).
3. **`.claude/worktrees/` eligibility.** Treating Claude isolation trees as
   reap-eligible once idle + free (rather than always-protected) is a behaviour
   change for the harness's own worktrees — confirm the idle + `probePathInUse`
   guard is sufficient protection for a paused-but-not-dead session.
