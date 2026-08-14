---
name: dev-protocol
description: >
  Use when starting substantive development work — a code change, refactor,
  bug fix, infra change, or multi-step debugging task in any repo. Load BEFORE
  writing code: it is the fleet development protocol (orient/ground, clarify
  vs proceed, design-align on larger tasks, the branch→test→review→CI
  pipeline, communication rules). Also use when deciding whether a task needs
  a design report first, when dispatching an adversarial review of a diff, or
  when writing a re-review verdict. Do NOT use for: quick lookups, answering
  questions about code without changing it, or pure conversation.
---

# Development Protocol — the playbook

The always-loaded CLAUDE.md "Development Protocol" section carries the
judgement criteria. This skill carries the parts that are *this fleet's
specific opinion* — the ones you would get wrong by defaulting to generic
good practice, because our answer differs from the obvious one.

## 0. The design contract binds first (repos that declare one)

Switchroom declares its design contract in `reference/` (`reference/README.md`
is the map; the repo CLAUDE.md "Design contract" section binds it to every
PR). When the repo you are changing carries one, the whole protocol below
runs *inside* that contract:

- **Before non-trivial work, place the change in the contract:** which of the
  four outcomes it advances, and which job spec it satisfies —
  `reference/product-spec.md` owns the job index; survey specs cheaply with
  `head -7 reference/jobs/*.md`. A change that maps to no outcome and no job
  is a scoping question, not a coding task.
- **The ship gate is the verdict rule, not just CI green:** a change ships
  only when it (a) advances one of the four outcomes, (b) satisfies its job
  spec — proven by that job's outcome UAT, (c) passes all three principle
  checks in `reference/principles.md` (docs / defaults / consistency; a "no"
  is a redesign, not a ship-and-patch), and (d) crosses no invariant in
  `reference/invariants.md`. Cite the job spec in the PR body.
- **Design lives in `reference/`, not `docs/`.** A design decision worth
  recording is an RFC or design record in `reference/rfcs/` (`serves:` a job
  or `backs:` an invariant), never a new doc under `docs/`.

This does not add ceremony to small changes: §1's fast path stands, and on a
single-concern change the verdict check is a one-line sanity pass, not a
report.

## 1. Is this a "larger" task? (decides whether you design-align first)

Treat it as larger — design report before implementing — when ANY of these hold:

- It changes a public interface, schema, config shape, or on-disk format.
- It cuts across 3+ modules or touches a load-bearing invariant.
- Two or more genuinely different approaches exist and the choice is
  expensive to reverse.
- The task description is a goal ("make X reliable") rather than a change
  ("add flag Y").
- It will land as more than one PR.

Small, single-concern, obvious-approach changes skip straight to the pipeline.
Design-aligning a one-liner is its own failure mode.

## 2. Design report + red-team (larger tasks only)

The report states what exists today **with citations**, what will change, the
chosen approach, the alternatives you rejected and why, and the PR staging
plan. In a contract-carrying repo (§0) it opens with the verdict-rule
mapping: the outcome advanced, the job spec satisfied, and any principle
check or invariant the design brushes against. Get alignment before
implementing.

Then red-team your own plan item by item. Each item gets a verdict —
`SOUND`, `RISK`, or `WRONG` — backed by evidence you can point at (a file you
read, a test you ran, documented behaviour), not intuition. Fix every `WRONG`
and address every `RISK` before starting. A red-team that returns all-`SOUND`
on a non-trivial plan is a red-team you didn't actually do.

## 3. Ask one question, as a decision with a default

If you're genuinely blocked after inferring from code and history, don't send
a questionnaire. State what you found, the 2–3 viable options, which you'd
pick and why, and ask for confirmation:

> "The config loader supports both YAML and JSON overlays; the task says
> 'config file' without specifying. I'd extend the YAML path since all
> existing overlays are YAML (`src/config/merge.ts:88`) — confirm, or should
> JSON be covered too?"

Clarify during *planning*. Once the plan is agreed, execute autonomously:
make the reasonable call on small ambiguities, record the assumption in your
report, keep moving. Mid-execution questions are reserved for discoveries
that invalidate the plan.

## 4. Adversarial review — bounded on purpose

Dispatch the review to a **fresh** pass or sub-agent; the coder cannot review
its own work in-context. Structure it:

- **Input:** the full diff, the task statement, and the design report if one exists.
- **Charge:** *find reasons this change is wrong* — correctness, missed edge
  cases, untested behaviour, inconsistency with surrounding code, docs drift,
  security or data-loss risk.
- **Output:** a findings list, each with a severity, the evidence (`file:line`),
  and a concrete fix.

**The severity gate — this is the fleet-specific part.** The old rule was
"fix ALL findings including lows, then re-review". That is a loop generator by
construction: an adversarial reviewer always surfaces lows (that is its job),
fixing lows produces a new diff, and a new diff earned another re-review. It
produced PRs going four rounds where the last round's only finding was an
inaccurate doc comment. So:

- **Blockers and majors block the merge.** Fix them.
- **Lows do NOT block.** File a low as a follow-up issue rather than fixing it
  now. Filing is mandatory — an unfiled low is a dropped bug, and there is no
  human team to catch it later.
- **Fix what blocks, then merge on CI green.**
- **Do not count review rounds, and do not run a mandatory re-review pass.**
  Verifying your own fix is part of making it, not a separate step. Counting
  rounds was itself a loop driver: it made the review process the subject of
  the work instead of the change.

If a finding is genuinely invalid, rebut it with evidence in writing; silence
is not a rebuttal.

## 5. Non-obvious pipeline rules

- **CI is the full-suite authority.** Local scoped tests are a fast filter,
  never the merge evidence. Never claim done off a local run alone.
- **`main` is behind a merge queue: `gh pr merge` ENQUEUES, it does not
  merge.** The command exits 0 and the PR stays `OPEN`. The queue then re-runs
  all seven required contexts on its own `gh-readonly-queue/main/pr-<n>-<sha>`
  ref before landing anything, so "green on the PR" is necessary but not
  sufficient. Never report a PR merged off that exit code — poll until its
  state is `MERGED` and the commit is an ancestor of `origin/main`. Two flags
  to know: `--delete-branch` is **rejected outright** while the queue is on
  (delete the branch after it lands), and `--subject` is ignored, since the
  queue composes the merge commit from the PR title plus `(#<pr>)` — so the PR
  title is the commit title, write it accordingly. An entry stuck in
  `AWAITING_CHECKS` means a required workflow is not listening for
  `merge_group`; `.github/MERGE-QUEUE.md` owns that failure mode and the
  invariants that prevent it.
- **Stage the changelog note author-side, before `gh pr create`.** A PR that
  changes shippable code must add a NEW `changelog.d/` fragment file (#4469's
  `check-changelog-entry.mjs`, part of `npm run lint`, enforces it). Don't
  hand-edit `CHANGELOG.md`: run `bun run changelog:generate` in the repo — it
  derives a per-PR fragment (`changelog.d/<pr>-<slug>.<type>.md`) from your
  conventional-commit title (idempotently — a second run is a no-op) and
  respects the escape hatches. Then commit the fragment so it lands in your
  own push. Fragment files are per-PR, so they never conflict with another
  in-flight PR — editing the shared `## Unreleased` section does, which is
  exactly the conflict class fragments replace (see `changelog.d/README.md`).
  It runs AUTHOR-side, not in CI, because a CI commit-back with the default
  `GITHUB_TOKEN` cannot re-trigger the required checks and would wedge the PR
  (`.github/MERGE-QUEUE.md` § "Author-side changelog generation"). Opt a
  docs/chore/test PR out with the `no-changelog` label or a `[skip changelog]`
  token on its own line.
- **A test that wouldn't fail on the bug it guards is not a test.** Assert the
  observable outcome, not that the code path executed.
- **Prefer a deterministic mechanism over prompt discipline.** If a check, a
  hook, a schema, or a lint gate can enforce the guarantee, write that instead
  of a convention — conventions demonstrably fail here.
- **Never go dark, and never foreground-watch over 30 seconds.** Builds, CI
  waits, and deploys run in the background with a notification. Batch related
  findings into one substantive update rather than five fragments. Cap
  parallel sub-agents at 15.
