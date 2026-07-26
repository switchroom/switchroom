# Merge queue — how CI reports on `gh-readonly-queue/...` refs

Ruleset **16470166** (`main branch protection`) enables a GitHub merge
queue with `merge_method: SQUASH`, `grouping_strategy: ALLGREEN`,
`max_entries_to_build: 5` and `check_response_timeout_minutes: 60`. Its
required status checks are exactly:

| context | workflow | job |
|---|---|---|
| `lint` | `ci-lint.yml` | `lint` |
| `vitest` | `ci-tests-core.yml` | `vitest` |
| `bun-test` | `ci-tests-plugin.yml` | `bun-test` |
| `python-ok` | `ci-tests-python.yml` | `python-ok` |
| `uat-gate` | `ci-uat.yml` | `uat-gate` |
| `e2e-ok` | `docker-e2e.yml` | `e2e-ok` |
| `images-ok` | `docker-images.yml` | `images-ok` |

When a PR is enqueued, GitHub pushes a temporary
`refs/heads/gh-readonly-queue/main/pr-<n>-<sha>` branch and emits a
**`merge_group`** event. It then waits for those seven contexts to report
**on that ref**. A workflow that only triggers on `pull_request` + `push`
never runs there, so the contexts are never produced and the entry sits in
`AWAITING_CHECKS` until the 60-minute timeout **ejects** it.

Every workflow producing a required context therefore carries a
`merge_group:` trigger. `tests/ci-merge-queue-triggers.test.ts` enforces
this and the invariants below — none of which are observable on a PR.

## The three rules

### 1. A required check must never come back `skipped`

A skipped required check is **not** success to the merge queue (same
hard-block behaviour as classic branch protection — #1343, #2237). Every
one of the seven is an `if: always()` sentinel for that reason, so the
context is always *produced*; the risk is the sentinel becoming a rubber
stamp that reports success having run nothing.

So on `merge_group` the real work jobs are force-run rather than
path-gated. **There is no path filtering on a queue ref**, deliberately:

- A queue ref has no PR base. The only defensible base is
  `github.event.merge_group.base_sha`, which needs a deepened fetch and
  gives `dorny/paths-filter` a new way to *fail* — and a failed `changes`
  job hard-fails the sentinel by design, recreating the exact outage this
  file exists to prevent.
- With `ALLGREEN` + `max_entries_to_merge: 5`, one queue ref can carry
  several PRs. "Changed paths" is a fuzzier question for a batch than for
  a PR.
- The repo's existing policy for `push: main` is already "always run,
  don't gamble on main". A queue ref **is** candidate main.

Mechanically: the `changes` job still runs (so it reports `success`, which
the sentinels require) but its checkout + filter steps are `if:`-skipped,
and each work job's gate gained `|| github.event_name == 'merge_group'`.

Two deliberate exceptions, neither of which lowers the bar:

- **`ci-uat.yml`'s `uat-gate-run`** — already skipped on every PR and main
  push (`UAT_GATE_ENABLED` has been `false` since 2026-07-04), so the
  queue gets the identical `uat-gate` verdict a PR gets. Running it would
  burn live subscription quota on the single `uat-host` self-hosted runner
  per queue entry, and a busy/unregistered runner would stall the entry
  until the 60-min timeout ejected it.
- **`docker-images.yml`'s `build-hindsight` / `build-voice`** — the 6.4GB
  hindsight pull and the CUDA voice build are the heaviest in the repo.
  The hindsight image's behavioural gate (`hindsight-probe` in
  `docker-e2e.yml`) *does* run on `merge_group`, and both images are still
  built and published by the push to main immediately after the merge.

### 2. A `merge_group` run must never be cancelled

`cancel-in-progress` is disabled for `merge_group` in all seven
workflows. Two reasons:

- A cancelled required context is not success — the queue ejects the entry.
- Cancelling a workflow whose sentinel is `if: always()` is the **#3614**
  orphan-wedge shape: the sentinel can survive the cancel stuck in
  `queued`, never reaching a terminal state, pinning the concurrency group
  and starving the ref. On a queue ref that would burn the whole 60-minute
  window with no self-service recovery.

The group **key** needed no change: every one of the seven already keys on
`github.ref`, which on a `merge_group` run is the queue's own
`refs/heads/gh-readonly-queue/...` branch — never the PR's
`refs/pull/<n>/merge` and never `refs/heads/main`. The queue's checks
therefore cannot collide with, or be cancelled by, the PR's own run.

### 3. A `merge_group` run must never publish

`docker-images.yml` spelled "is this a publishing event?" as
`github.event_name != 'pull_request'`, which is **true** on `merge_group`.
Left alone, a queue run would have logged in to GHCR, pushed images,
written registry build cache, and moved `:latest` / `:sha-<short>` from a
ref that had not been merged.

`merge_group` is therefore a **validation** event here, exactly like
`pull_request`: build only, `push: false`, no `cache-to`, no GHCR login,
amd64 only. Publication stays on the real push to `main`. The
`merge-base` / `merge-dependents` manifest jobs are excluded outright.

Image tags also can't reuse the PR shape: `github.event.pull_request.number`
is **empty** on `merge_group`, so `${IMAGE}:pr-${{ ... }}` would render
the invalid reference `${IMAGE}:pr-` and fail the build — the same class
of bug as the #2816 non-main-dispatch follow-up. Queue builds tag
`${IMAGE}:mq-<sha7>` instead.

## Things that are NOT `merge_group`-triggered, on purpose

- **`ci-infra-watchdog.yml`** is the only `workflow_run`-triggered
  workflow in the repo. It produces no required context, and it is gated
  on `workflow_run.event == 'push'` on `main` — it alerts on *post-merge*
  red. A queue-ref failure is pre-merge and is reported by the queue
  itself. **No required check is `workflow_run`-downstream**: each of the
  seven is produced directly by a job in its own workflow on the
  triggering event.
- `ci-evals.yml`, `ci-full.yml`, `ci-tests-race-long.yml`,
  `ci-claude-latest-canary.yml`, `npm-publish.yml`, `promote.yml` produce
  no required context.

## Diagnosing a stuck queue

```bash
# Is anything listening for merge_group at all?
gh run list --event merge_group --limit 10

# Queue state for a PR
gh api graphql -f query='
  { repository(owner:"switchroom", name:"switchroom") {
      pullRequest(number: NNNN) {
        isInMergeQueue
        mergeQueueEntry { state position enqueuedAt }
      } } }'
```

`state: AWAITING_CHECKS` with **zero** `merge_group` runs ever recorded is
the signature of this bug: GitHub is dispatching the event and nothing is
listening.
