# Contributing to Switchroom

Switchroom is MIT-licensed and welcomes contributions. This guide covers the
branch-and-PR flow, local dev loop, and what we look for in PRs.

## Repo layout

- **`switchroom/switchroom`** — the one canonical public repo. Source of truth
  for releases. All `npm publish` output comes from here. Tagged versions
  (`v0.X.Y`) live here. You branch off `main`, push your branch directly to
  this repo, and open PRs against its `main` — there is no separate fork.

Switchroom uses a canonical-only branch-and-PR workflow: clone the repo, push
a feature branch, open a PR against `main`.

## Getting started

1. **Clone** `switchroom/switchroom` locally:
   ```
   git clone https://github.com/switchroom/switchroom.git
   cd switchroom
   ```
2. **Install deps** and build:
   ```
   bun install
   bun run build
   ```
3. **Run the tests**:
   ```
   bun run test
   ```

## The dev loop

There are three distinct workflows. Know which one you're in:

### 1. Code-change dev loop (most common)

Editing source, iterating, eating your own dogfood.

```
# edit files
bun run build                  # regenerates dist/cli/switchroom.js (~1s)
switchroom agent restart all   # reconciles + restarts running agents
```

Why the restart? Agents load code at process start and hold it in memory.
A rebuild updates the CLI and the bundled plugin, but running agents
still have the old code. `switchroom agent restart` picks up the latest
build (and also runs reconcile first, so any scaffold changes go live).

If you're using the bun-linked global install (`~/.bun/bin/switchroom`
symlinked to the workspace `dist/`), the CLI is always fresh after
`bun run build` — no `npm i -g` needed.

### 2. Release to npm (canonical maintainers only)

Releases are **not** cut by hand. Do not bump `package.json` in a commit and
do not run `npm publish` yourself — the version source of truth is the git
tag (`scripts/build.mjs:resolveVersion()`), the committed `package.json`
version is a stale placeholder by design, and the pack-time bump + publish
happen in CI.

Follow the **`switchroom-release`** skill (`skills/switchroom-release/SKILL.md`)
for the full ordered, gated checklist. In short: a CHANGELOG-only
`chore: release vX.Y.Z` PR is merged to `main`, then a `vX.Y.Z` tag is pushed
on the pinned merge SHA. The tag push fires `.github/workflows/release.yml`,
which orchestrates everything — builds the static binaries, waits for the
`docker-images` build, then `workflow_call`s `npm-publish.yml` and un-drafts
the GitHub Release. `npm-publish.yml` has no tag trigger and is the only leg
that publishes to npm. Never run `npm publish` by hand from a worktree.

#### Rolling a release back — on-disk state the newer build already wrote

Rolling back the code does not roll back the JSON state files a running fleet
has already written. Before downgrading a fleet, check whether the version you
are leaving bumped an on-disk envelope, because a reader that cannot make sense
of a file **loses whatever that file was remembering**.

The pair that bites is the Telegram gateway's pin state, under
`~/.switchroom/agents/<name>/telegram/`:

- `status-pins.json` — the only record of which messages the gateway pinned.
  Lose it and every pin the newer build took becomes a permanent orphan that
  boot cleanup can never see again (#3957).
- `stale-pin-sweep.json` — the durable sweep obligation ledger. Same hazard.

Rules:

- **Envelope bumps stay additive.** Every field added after `v: 1` is optional,
  so a build that does not know the version can still validate rows
  structurally — and both readers are deliberately version-TOLERANT: an unknown
  `v` is read row by row, never discarded. A change that ever needs to be
  non-additive must change the **filename**, not just `v`.
- **One known-lossy hop exists and cannot be fixed retroactively:**
  **v0.19.31+ → v0.19.30 or older.** `v: 4` was added by #3953 (shipped in
  v0.19.31) and readers up to v0.19.30 only know v1–v3, so they fail open to
  `[]` and drop every pin row. Version tolerance landed after v0.19.32, so it
  protects the NEXT bump, not that one. If you must make that hop, drain the
  pins first — stop the fleet on the newer build, let boot cleanup run, confirm
  the file reads `{"v":4,"pins":[]}` — or expect to clear a handful of stale
  pins by hand afterwards.

### 3. Local deploy (optional)

If you maintain your own fleet of switchroom-managed agents on a personal
server, the dev loop above is also your deploy path. Pull, build, restart —
your agents are on the latest code.

## Submitting a PR

1. Branch off `main`:
   ```
   git checkout main && git pull
   git checkout -b feature/my-feature
   ```
2. Keep PRs focused. One concern per PR. If you find yourself writing
   "and also" in the PR description, split it.
3. Add tests for new behavior. Bug fixes should include a regression test
   that would have caught the bug.
   - **Stage a changelog note.** A PR that changes shippable code (`src`,
     `telegram-plugin`, `bin`, `docker`, `profiles`, `skills`, the vendored
     hindsight tree, or CI workflows) must add a NEW fragment file under
     `changelog.d/` in the same PR — run `bun run changelog:generate`, or write
     `changelog.d/<pr>-<slug>.<type>.md` by hand (see `changelog.d/README.md`).
     `npm run lint` (via `scripts/check-changelog-entry.mjs`) fails otherwise.
     Per-PR fragment files never conflict with another in-flight PR; a
     hand-written entry under `## Unreleased` in `CHANGELOG.md` still counts,
     but it conflicts with every other open PR — prefer the fragment. At
     release time the fragments are assembled into the `## vX.Y.Z` section
     (`bun run changelog:cut`). For a docs/chore/test-only PR that ships
     nothing user-visible, opt out with a `no-changelog` label on the PR or a
     `[skip changelog]` token on its own line in the PR body or a commit message.
4. Run `bun run lint` (tsc noEmit) and `bun run test` before pushing.
5. Push the branch to `origin` and open a PR against `switchroom/switchroom:main`:
   ```
   git push -u origin feature/my-feature
   gh pr create --repo switchroom/switchroom --base main \
     --head feature/my-feature
   ```
   Or use the GitHub UI.
6. PR title: conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`,
   `refactor:`, `test:`) + short imperative description.
7. PR body: what changed, why, and how to test it. A short test-plan
   checklist is appreciated.
8. **Non-trivial PRs cite the job spec they satisfy.** Cite the job spec
   from `reference/jobs/` in the PR description — the outcome-focused spec
   the change satisfies (see `CLAUDE.md`).
9. **Liveness-surface PRs declare their guarantee delta.** Any PR touching
   `feedHeartbeatTick`, `feed-open-gate.ts`, `silence-poke.ts`,
   `turn-liveness-floor.ts`, or the card-edit path must state, in the PR
   body, what the framework still guarantees to deliver WITHOUT the model
   after the change — added or removed. See
   `reference/rfcs/deterministic-turn-liveness.md` Phase 5: a legitimate
   anti-nag change (#2667) muted a guarantee as a side effect precisely
   because no one had to state the delta at review time.

## What we look for

- **Focused scope.** No surprise refactors bundled with a bug fix.
- **Tests.** New code and bug fixes should have coverage.
- **Clean commits.** Squash-merge is the default; within a PR, tidy
  commits are nice but not required — one good commit beats many bad ones.
- **No secrets.** The repo has secret detection (`secret-detect/`). Don't
  commit real tokens even in tests — if you need a fixture, construct it
  at runtime via string concatenation so the source file doesn't contain
  a contiguous token pattern. See
  [`telegram-plugin/tests/secret-detect-secretlint.test.ts`](telegram-plugin/tests/secret-detect-secretlint.test.ts)
  for the pattern.

## Profiles

Community agent profiles are welcome. Add them under `profiles/<name>/`:

- `CLAUDE.md.hbs` — agent behavior template
- `SOUL.md.hbs` — agent persona template
- Optional `skills/` for domain-specific skill bundles

Agents inherit a profile via `extends: <name>` in their `switchroom.yaml`
entry. See [`docs/configuration.md`](docs/configuration.md) for the
profile/agent cascade semantics.

## Code style

- TypeScript (ESM), Bun runtime
- Zod for schema validation at boundaries
- Prefer clear naming over comments
- Avoid premature abstraction; three similar lines beats a helper used once
- Match surrounding code — consistency over novelty

## Issues

Each issue should be a self-contained unit of work. If you want to
contribute, pick an unassigned issue and comment that you're on it. For
larger work or design changes, open a discussion first so we can align
on approach before you invest time.

## License

By contributing you agree that your contributions will be licensed under
the MIT License. See [`LICENSE`](LICENSE).
